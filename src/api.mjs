/**
 * HTTP surface for the panel.
 *
 * Deliberately plain: a dispatcher over (method, path) returning { status, body }
 * so the whole API can be tested without opening a socket. The server adapter in
 * index.mjs only translates node req/res to this shape.
 *
 * The panel polls /serial/tail with a cursor instead of holding an SSE socket:
 * serial data is small and cursor polling is trivial to resume after a reload.
 */
import { SerialError } from './errors.mjs';

const ok = (body) => ({ status: 200, body });
const bad = (code, message, hint, extra = {}) => ({
  status: 400,
  body: { ok: false, error: { code, message, hint, ...extra } },
});

export function createApi(service, settings = {}) {
  const routes = {
    'GET /serial/fsm': async (ctx) => {
      const portId = Number((/portId=(\d+)/.exec((ctx && ctx.url) || '') || [])[1]) || null;
      return ok({ runs: service.fsmList(portId) });
    },
    'POST /serial/fsm/event': async (ctx) => {
      const body = (ctx && ctx.body) || {};
      return ok(await service.fsmEvent(String(body.runId), String(body.name)));
    },
    'POST /serial/fsm/stop': async (ctx) => {
      const body = (ctx && ctx.body) || {};
      return ok(await service.fsmStop(String(body.runId)));
    },
    'GET /serial/state': async () => {
      const ports = typeof service.discoverPorts === 'function' ? await service.discoverPorts() : service.listPorts();
      const captures = await service.captures({ limit: 20 });
      return ok({
        ok: true,
        ports,
        captures: captures.map((c) => ({
          id: c.id, project: c.project, conversation: c.conversation, port: c.port, path: c.path,
          startedMs: c.started_ms, endedMs: c.ended_ms, bytes: c.bytes_rx, lines: c.lines,
        })),
      });
    },

    'GET /serial/tail': async (ctx) => {
      const portId = Number(ctx.query.portId);
      if (!Number.isFinite(portId)) return bad('E_INVALID_ARGS', 'portId must be a number', 'Pass the portId returned by /serial/state.');
      const res = await service.tail({
        portId,
        cursor: ctx.query.cursor === undefined ? undefined : Number(ctx.query.cursor),
        maxLines: ctx.query.maxLines === undefined ? 300 : Number(ctx.query.maxLines),
        lineEnding: ctx.query.lineEnding,
        timeoutMs: 0,
      });
      return ok({ ok: true, ...res });
    },

    'POST /serial/send': async (ctx) => {
      const body = ctx.body || {};
      const portId = Number(body.portId);
      if (!Number.isFinite(portId)) return bad('E_INVALID_ARGS', 'portId is required', 'Open a port first.');
      if (!body.text && !body.hex) return bad('E_INVALID_ARGS', 'text or hex is required', 'Send either text or a hex byte string.');
      let payload;
      if (body.hex) {
        const clean = String(body.hex).replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) return bad('E_INVALID_ARGS', 'hex must be even hex digits', 'Example: 1B 5B 41');
        payload = Buffer.from(clean, 'hex');
      } else {
        payload = Buffer.from(String(body.text), 'utf8');
      }
      const eol = { cr: '\r', lf: '\n', crlf: '\r\n' }[body.append];
      if (eol) payload = Buffer.concat([payload, Buffer.from(eol, 'utf8')]);
      const res = await service.send(portId, payload, {
        owner: body.sessionId ? { kind: 'session', id: String(body.sessionId) } : undefined,
        force: body.force === true,
      });
      return ok({ ok: true, ...res });
    },

    'POST /serial/open': async (ctx) => {
      const body = ctx.body || {};
      if (!body.port) return bad('E_INVALID_ARGS', 'port is required', 'Pick a port from /serial/state.');
      const res = await service.open({
        port: body.port, baudRate: Number(body.baudRate) || 115200,
        project: body.project || 'default', conversation: body.conversation || 'session', sessionId: body.sessionId || '',
        takeover: body.takeover === true,
        owner: body.sessionId ? { kind: 'session', id: String(body.sessionId) } : { kind: 'session', id: 'panel' },
      });
      return ok({ ok: true, ...res });
    },

    'POST /serial/close': async (ctx) => {
      const portId = Number((ctx.body || {}).portId);
      if (!Number.isFinite(portId)) return bad('E_INVALID_ARGS', 'portId is required', 'Pass the portId from /serial/state.');
      const res = await service.close(portId, {
        owner: (ctx.body || {}).sessionId ? { kind: 'session', id: String(ctx.body.sessionId) } : undefined,
        force: (ctx.body || {}).force === true,
      });
      return ok({ ok: true, ...res });
    },

    'POST /serial/replay': async (ctx) => {
      const body = ctx.body || {};
      const portId = Number(body.portId);
      if (!Number.isFinite(portId)) return bad('E_INVALID_ARGS', 'portId is required', 'Open a mock port first.');
      if (!body.path) return bad('E_INVALID_ARGS', 'path is required', 'Pass a .log file to replay.');
      const roots = Array.isArray(settings.replayRoots) ? settings.replayRoots : [];
      const target = String(body.path).replace(/\\/g, '/');
      const allowed = roots.some((r) => target.toLowerCase().startsWith(String(r).replace(/\\/g, '/').toLowerCase()));
      if (!allowed) {
        return bad('E_FORBIDDEN', 'path is outside the configured replay roots', 'Only directories listed in the plugin setting replayRoots may be replayed: ' + (roots.join(', ') || '(none)'));
      }
      const res = await service.replayFile(portId, body.path, { chunk: body.chunk, delayMs: body.delayMs });
      return ok({ ok: true, ...res });
    },

    'POST /serial/scan': async (ctx) => {
      const body = ctx.body || {};
      if (!body.captureId) return bad('E_INVALID_ARGS', 'captureId is required', 'Pick a capture from the sidebar.');
      if (!body.script) return bad('E_INVALID_ARGS', 'script is required', 'Pass the path of a scan script.');
      return ok(await service.scan(body.captureId, body));
    },

    'GET /serial/marks': async (ctx) => {
      if (!ctx.query.captureId) return bad('E_INVALID_ARGS', 'captureId is required', 'Pick a capture from the sidebar.');
      const res = await service.marks(ctx.query.captureId, {
        rule: ctx.query.rule,
        severity: ctx.query.severity,
        beforeMs: Number(ctx.query.beforeMs) || undefined,
        afterMs: Number(ctx.query.afterMs) || undefined,
      });
      return ok(res);
    },

    'GET /serial/bytes': async (ctx) => {
      if (!ctx.query.captureId) return bad('E_INVALID_ARGS', 'captureId is required', 'Pick a capture from the sidebar.');
      const res = await service.bytes(ctx.query.captureId, {
        dir: ctx.query.dir || 'rx',
        offset: Number(ctx.query.offset) || 0,
        length: Number(ctx.query.length) || 256,
        format: ctx.query.format || 'hex',
      });
      return ok(res);
    },
    'GET /serial/capture': async (ctx) => {
      if (!ctx.query.id) return bad('E_INVALID_ARGS', 'id is required', 'Pick a capture from the sidebar.');
      const res = await service.captureLines(ctx.query.id, { maxLines: Number(ctx.query.maxLines) || 20000 });
      return ok({ ok: true, ...res });
    },

    'POST /serial/delete': async (ctx) => {
      const id = (ctx.body || {}).captureId;
      if (!id) return bad('E_INVALID_ARGS', 'captureId is required', 'Pick a capture from the sidebar.');
      return ok({ ok: true, ...(await service.deleteCapture(id)) });
    },

    'POST /serial/export': async (ctx) => {
      const body = ctx.body || {};
      if (!body.captureId) return bad('E_INVALID_ARGS', 'captureId is required', 'Pick one from /serial/state.');
      const res = await service.exportCapture(body.captureId, {
        format: body.format || 'text',
        timestamps: body.timestamps !== false,
        encoding: body.encoding,
        out: body.out,
      });
      return ok({ ok: true, ...res });
    },
  };

  return routes;
}

/** Route a request to a handler; unknown paths get 404, thrown SerialError gets 400. */
export async function dispatch(routes, request) {
  const key = (request.method || 'GET').toUpperCase() + ' ' + (request.path || '');
  const handler = routes[key];
  if (!handler) return { status: 404, body: { ok: false, error: { code: 'E_NOT_FOUND', message: 'no route ' + key } } };
  try {
    return await handler({ query: request.query || {}, body: request.body || {} });
  } catch (err) {
    if (err instanceof SerialError) {
      return { status: 400, body: { ok: false, error: { code: err.code, message: err.message, hint: err.hint, fix: err.fix, retryable: err.retryable } } };
    }
    return { status: 500, body: { ok: false, error: { code: 'E_INTERNAL', message: String(err && err.message) } } };
  }
}
