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
    await mount(ctx, settings || {});
  } catch (error) {
    console.warn('serial-trigger: mount failed; the plugin stays dormant', error);
  }
}

async function mount(ctx, settings) {
  const dataRoot = settings.dataRoot || join(homedir(), '.dsh', 'serial-trigger', 'data');
  const store = await Store.open({ root: dataRoot });
  await store.recover();
  const hub = new Hub({ ringBytes: settings.ringBytes || 8 << 20 });
  const service = new SerialService({ hub, store });
  if (settings.mockPorts) for (const p of settings.mockPorts) service.registerMockPort(p);

  for (const tool of createTools(service)) {
    if (typeof ctx.effect === 'function') ctx.effect(() => ctx.tools.register(tool), 'serial-trigger: ' + tool.name);
    else ctx.tools.register(tool);
  }

  mountRoutes(ctx, service, settings);
  return { hub, store, service, dataRoot };
}

/** Panel API <-> node http. Kept dumb on purpose: dispatch() holds the logic. */
function mountRoutes(ctx, service, settings) {
  const routes = createApi(service, settings || {});
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
