/**
 * DSH bundle entry.
 *
 * Wires Store (files + index) -> Hub (pub/sub) -> Service (ports, captures) ->
 * tools + panel API. Nothing here may throw at load time: a broken plugin must
 * not take the profile down.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Hub } from './hub.mjs';
import { Store } from './store.mjs';
import { SerialService } from './service.mjs';
import { createTools } from './tools.mjs';
import { createApi, dispatch } from './api.mjs';

export const name = 'serial-trigger';
export const inject = ['tools'];

const applied = new WeakSet();

export async function apply(ctx, settings = {}) {
  if (ctx && typeof ctx === 'object' && applied.has(ctx)) return;
  if (ctx && typeof ctx === 'object') applied.add(ctx);
  try {
    return await mount(ctx, settings || {});
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
    if (typeof ctx.effect === 'function') ctx.effect(() => ctx.tools.register(tool), 'serial-trigger: ' + tool.name);
    else ctx.tools.register(tool);
  }

  mountRoutes(ctx, service, settings);
  mountLifecycle(ctx, service);
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
function mountLifecycle(ctx, service) {
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
        service.closeOwnedBy([...ids], 'session-disposed').catch((err) => {
          console.warn('serial-trigger: releasing ports for a disposed session failed', err);
        });
      }, { global: true });
    } catch (err) {
      console.warn('serial-trigger: cannot subscribe to session/disposed; ports may outlive sessions', err);
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      // Shutdown path: close and flush. Errors are swallowed on purpose; a failed
      // close during teardown must not block the host from exiting.
      service.dispose().catch(() => {});
    }, 'serial-trigger: dispose ports on unload');
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
