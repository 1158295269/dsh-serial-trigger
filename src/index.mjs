/**
 * DSH bundle entry.
 *
 * Wires Store (files + index) -> Hub (pub/sub) -> Service (ports, captures) ->
 * tools + panel API. Nothing here may throw at load time: a broken plugin must
 * not take the profile down.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { ioPath } from './paths.mjs';
import { Hub } from './hub.mjs';
import { Store } from './store.mjs';
import { SerialService } from './service.mjs';
import { createTools } from './tools.mjs';
import { createApi, dispatch } from './api.mjs';
import { rememberCall, forgetCallsOfSession } from './identity.mjs';

export const name = 'serial-trigger';
export const inject = ['tools'];

const applied = new WeakSet();
// cordis treats the value returned by apply() as an effect, so apply must return
// nothing. Tests read the live mount through this accessor instead.
let lastMount = null;
export function currentMount() { return lastMount; }

export async function apply(ctx, settings = {}) {
  if (ctx && typeof ctx === 'object' && applied.has(ctx)) return;
  if (ctx && typeof ctx === 'object') applied.add(ctx);
  try {
    lastMount = await mount(ctx, settings || {});
    return undefined;
  } catch (error) {
    console.warn('serial-trigger: mount failed; the plugin stays dormant', error);
  }
}

async function mount(ctx, settings) {
  const dataRoot = settings.dataRoot || join(homedir(), '.dsh', 'serial-trigger', 'data');
  const store = await Store.open({ root: dataRoot });
  await store.recover();
  const hub = new Hub({ ringBytes: settings.ringBytes || 8 << 20 });
  // Rules belong to the workspace, not to the plugin or the capture tree:
  // they encode this project's protocol knowledge and should travel with its git repo.
  const workspaceRoot = settings.workspaceRoot || process.cwd();
  const rulesRoot = settings.rulesRoot || join(workspaceRoot, '.serial', 'rules');
  const service = new SerialService({ hub, store, rulesRoot });
  if (settings.mockPorts) for (const p of settings.mockPorts) service.registerMockPort(p);

  for (const tool of createTools(service)) {
    if (typeof ctx.effect === 'function') {
      // ctx.effect requires the callback to return a disposer (or nothing).
      // tools.register does not always do that, so normalise it.
      ctx.effect(() => {
        const stop = ctx.tools.register(tool);
        return typeof stop === 'function' ? stop : () => {};
      }, 'serial-trigger: ' + tool.name);
    } else {
      ctx.tools.register(tool);
    }
  }

  mountRoutes(ctx, service, settings);
  mountLifecycle(ctx, service, settings);
  return { hub, store, service, dataRoot };
}

/** Panel API <-> node http. Kept dumb on purpose: dispatch() holds the logic. */
/**
 * Lifecycle: a port must never outlive the thing that opened it.
 *
 *  - session archived / disposed -> close every port owned by that session or
 *    by agents that belong to it
 *  - plugin unload / host shutdown -> close everything, flushing captures
 */
/**
 * Deleting the recordings a conversation produced. Runs only for an archived
 * session; every delete is bounded so one stuck file cannot block teardown.
 */
async function purgeSessionCaptures(service, sessionId) {
  let rows = [];
  try { rows = service.store.listCapturesOfSession(sessionId); } catch { rows = []; }
  const removed = [];
  for (const row of rows) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000));
    const attempt = service.deleteCapture(row.id).then(() => 'ok').catch((err) => (err && err.code) || 'error');
    const outcome = await Promise.race([attempt, timeout]);
    if (outcome === 'ok') removed.push(row.id);
    else console.warn('serial-trigger: held back capture of an archived conversation', row.id, outcome);
  }
  forgetCallsOfSession(sessionId);
  return removed;
}

/** How often the host's archive list is re-read. Cheap: one tiny JSON file. */
const DEFAULT_ARCHIVE_POLL_MS = 2000;

/**
 * Where the host keeps "which conversations the user archived".
 *
 * Archiving is a workspace-storage edit, not a session teardown: DSH 0.2.2 only
 * appends the id to `<DSH_HOME>/storages/workspace.json` ->
 * `global.archivedSessionIds` and touches nothing else. The session is not
 * disposed, so `session/disposed` never fires for an archive and the recording
 * stayed behind. Watching that list is the only observable signal the host
 * offers a plugin (SPEC 11.2).
 */
export function archivedSessionsFile(settings = {}) {
  const home = settings.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'storages', 'workspace.json');
}

/** The archived ids, or null when the file cannot be read/parsed right now. */
async function readArchivedSessionIds(file) {
  try {
    const doc = JSON.parse(await readFile(ioPath(file), 'utf8'));
    const list = doc && doc.global && doc.global.archivedSessionIds;
    if (!Array.isArray(list)) return [];
    return list.map((value) => String(value)).filter(Boolean);
  } catch {
    // Missing or half-written file: keep the previous snapshot and retry. A
    // parse failure must never be read as "nothing is archived".
    return null;
  }
}

/**
 * Every recording one archived conversation produced, gone. Ports are released
 * first so an in-flight capture is flushed (and no longer refuses deletion).
 */
async function purgeConversation(service, sessionId) {
  if (!sessionId) return [];
  await service.stopRunsOwnedBy([sessionId], 'session-archived').catch(() => {});
  await service.closeOwnedBy([sessionId], 'session-archived').catch(() => {});
  return purgeSessionCaptures(service, sessionId);
}

/**
 * Follow the host's archive list. The first read is a reconcile pass (a
 * conversation archived while the host was down still loses its recordings);
 * later reads only act on ids that just appeared.
 */
function watchArchivedSessions(service, settings, isShuttingDown) {
  const file = archivedSessionsFile(settings);
  const configured = Number(settings.archivePollMs);
  const pollMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ARCHIVE_POLL_MS;
  let known = null;
  let busy = false;
  let timer = null;

  const tick = async () => {
    if (busy || isShuttingDown()) return;
    busy = true;
    try {
      const ids = await readArchivedSessionIds(file);
      if (!ids) return;
      const fresh = known === null ? ids : ids.filter((id) => !known.has(id));
      known = new Set(ids);
      for (const id of fresh) {
        if (isShuttingDown()) return;
        const removed = await purgeConversation(service, id);
        if (removed.length > 0) {
          console.warn('serial-trigger: removed ' + removed.length + ' recording(s) of an archived conversation', id);
        }
      }
    } catch (err) {
      console.warn('serial-trigger: cannot reconcile archived conversations', err);
    } finally {
      busy = false;
    }
  };

  tick().catch(() => {});
  try {
    timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  } catch {
    timer = null;
  }
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

function mountLifecycle(ctx, service, settings = {}) {
  // Archiving a conversation removes the recordings it produced; app shutdown
  // must never do that, so a teardown flag keeps the purge off.
  let shuttingDown = false;
  // Archiving never disposes the session, so the host's archive list is the
  // real (and only) delete trigger; session/disposed only releases ports.
  let stopArchiveWatch = null;
  try {
    stopArchiveWatch = watchArchivedSessions(service, settings, () => shuttingDown);
  } catch (err) {
    console.warn('serial-trigger: cannot watch archived conversations; recordings may survive archiving', err);
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('session/event', (session, event) => {
        const sessionId = session && (session.id || (session.header && session.header.id));
        if (!sessionId || !event) return;
        const data = event.data || {};
        if (event.type === 'tool/call' && data.callId) rememberCall(data.callId, sessionId);
        else if (event.type === 'tool/ptc-dispatch') {
          if (data.callId) rememberCall(data.callId, sessionId);
          if (data.subCallId) rememberCall(data.subCallId, sessionId);
        }
      }, { global: true });
    } catch (err) {
      console.warn('serial-trigger: cannot subscribe to session/event; tool calls keep an unknown owner', err);
    }
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('session/disposed', (session) => {
        const ids = new Set();
        if (session && session.id) ids.add(String(session.id));
        for (const key of ['agent', 'agentId']) {
          const value = session && session[key];
          if (value && value.id) ids.add(String(value.id));
          else if (typeof value === 'string') ids.add(value);
        }
        if (session && Array.isArray(session.agents)) {
          for (const a of session.agents) {
            if (a && a.id) ids.add(String(a.id));
          }
        }
        service.stopRunsOwnedBy([...ids], 'session-disposed').catch(() => {});
        const sessionId = session && session.id ? String(session.id) : '';
        if (sessionId) ids.add(sessionId);
        // Closing a conversation (or a sub-agent's session finishing) releases
        // its ports and flushes their captures — it does NOT delete recordings.
        // Only archiving deletes (SPEC 11.2): a disposed session must keep its
        // evidence, otherwise delegated work would erase the parent's captures.
        service.closeOwnedBy([...ids], 'session-disposed')
          .catch((err) => {
            console.warn('serial-trigger: releasing ports for a disposed session failed', err);
          });
        if (sessionId) forgetCallsOfSession(sessionId);
      }, { global: true });
    } catch (err) {
      console.warn('serial-trigger: cannot subscribe to session/disposed; ports may outlive sessions', err);
    }
  }

  // Shutdown path: close and flush. Errors are swallowed on purpose; a failed
  // close during teardown must not block the host from exiting.
  //
  // NOTE: ctx.effect() expects the callback to return a disposer; returning a
  // factory that yields one trips cordis' "Invalid effect" check. The dispose
  // event is the supported teardown hook.
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        shuttingDown = true;
        if (stopArchiveWatch) stopArchiveWatch();
        service.dispose().catch(() => {});
      });
    } catch (err) {
      console.warn('serial-trigger: cannot register the dispose hook', err);
    }
  }
}

function mountRoutes(ctx, service, settings) {
  const routes = createApi(service, settings || {});
  // DSH's webserver keys routes by path only, so two methods on one path means
  // the second registration is rejected. Catch it here with a useful message.
  const byPath = new Map();
  for (const key of Object.keys(routes)) {
    const [method, path] = key.split(' ');
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(method);
  }
  for (const [path, methods] of byPath) {
    if (methods.length > 1) console.warn('serial-trigger: ' + path + ' is registered for ' + methods.join(' and ') + '; the webserver keys by path, so all but one will fail. Split the paths.');
  }
  const attach = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return;
    for (const key of Object.keys(routes)) {
      const [method, path] = key.split(' ');
      try {
        webServer.register({
          kind: 'exact',
          path,
          handler: (request, response) => handle(routes, method, path, request, response, settings),
        });
      } catch (error) {
        console.warn('serial-trigger: cannot register ' + key, error);
      }
    }
  };

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (inner) => attach(inner && inner.webServer));
    } catch {
      /* host without a web server: tools still work */
    }
  } else if (typeof ctx.get === 'function') {
    attach(ctx.get('webServer'));
  } else if (ctx.webServer) {
    attach(ctx.webServer);
  }
}

async function handle(routes, method, path, request, response, settings) {
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if ((request.method || 'GET').toUpperCase() !== method) return send(405, { ok: false, error: { code: 'E_METHOD', message: 'use ' + method } });

  let body = {};
  if (method === 'POST') {
    body = await readJson(request).catch(() => null);
    if (body === null) return send(400, { ok: false, error: { code: 'E_INVALID_JSON', message: 'body must be JSON' } });
  }
  const url = new URL(request.url || path, 'http://127.0.0.1');
  const query = Object.fromEntries(url.searchParams.entries());
  const result = await dispatch(routes, { method, path, query, body });
  return send(result.status, result.body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1 << 20) reject(new Error('too large'));
    });
    request.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    request.on('error', reject);
  });
}
