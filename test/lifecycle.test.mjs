import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, currentMount } from '../src/index.mjs';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

function fakeCtx() {
  const listeners = new Map();
  const effects = [];
  return {
    tools: { register: () => () => {} },
    on(event, handler) { listeners.set(event, handler); return () => {}; },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') effects.push(stop); return () => {}; },
    emit(event, ...args) { const h = listeners.get(event); return h ? h(...args) : undefined; },
    listeners,
    effects,
  };
}

test('L1 a disposed session releases only its own ports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life-'));
  const ctx = fakeCtx();
  await apply(ctx, { dataRoot: join(root, 'data') });
  const mounted = currentMount();
  t.after(async () => { await mounted.service.dispose(); });

  const a = await mounted.service.open({ port: 'MOCK:A', owner: { kind: 'session', id: 's1' } });
  const b = await mounted.service.open({ port: 'MOCK:B', owner: { kind: 'session', id: 's2' } });

  ctx.emit('session/disposed', { id: 's1' });
  await waitFor(() => mounted.service.status(a.portId).state === 'closed');

  assert.equal(mounted.service.status(a.portId).state, 'closed');
  assert.equal(mounted.service.status(b.portId).state, 'open');
});

test('L2 disposing the plugin closes every open port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life2-'));
  const ctx = fakeCtx();
  await apply(ctx, { dataRoot: join(root, 'data') });
  const mounted = currentMount();
  const a = await mounted.service.open({ port: 'MOCK:C', owner: { kind: 'agent', id: 'x' } });
  assert.equal(mounted.service.status(a.portId).state, 'open');

  // teardown is wired through the dispose event
  const dispose = ctx.listeners.get('dispose');
  assert.equal(typeof dispose, 'function');
  dispose();
  await waitFor(() => mounted.service.status(a.portId).state === 'closed');

  assert.equal(mounted.service.status(a.portId).state, 'closed');
});

test('L3 closeOwnedBy ignores ports owned by others', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life3-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); });

  const p1 = await service.open({ port: 'MOCK:1', owner: { kind: 'session', id: 's9' } });
  const p2 = await service.open({ port: 'MOCK:2', owner: { kind: 'session', id: 's8' } });

  const closed = await service.closeOwnedBy(['s9']);
  assert.deepEqual(closed, [p1.portId]);
  assert.equal(service.status(p2.portId).state, 'open');
});

test('L4 a tool call borrows the session from the host event', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life4-'));
  const ctx = fakeCtx();
  await apply(ctx, { dataRoot: join(root, 'data') });
  const mounted = currentMount();
  t.after(async () => { await mounted.service.dispose(); });

  // The host appends tool/call before the tool runs; the plugin remembers it.
  ctx.emit('session/event', { id: 's-arch' }, { type: 'tool/call', data: { callId: 'call_arch' } });
  const { createTools } = await import('../src/tools.mjs');
  const byName = Object.fromEntries(createTools(mounted.service).map((x) => [x.name, x]));
  const opened = await byName.serial_open.execute({ port: 'MOCK:ARCH1', project: 'p' }, { callId: 'call_arch:ptc:1' });
  assert.equal(opened.ok, true);
  const row = mounted.service.store.listCaptures({}).find((c) => c.id === opened.data.captureId);
  assert.equal(row.session_id, 's-arch');
  await byName.serial_close.execute({ portId: opened.data.portId }, { callId: 'call_arch:ptc:2' });
});

/** The host writes archived ids here; archiving does not dispose the session. */
async function writeArchiveList(home, ids) {
  await mkdir(join(home, 'storages'), { recursive: true });
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: ids },
  }), 'utf8');
}

// Closing a conversation (including a sub-agent's session finishing) releases its
// ports but must keep the captures: only archiving deletes (SPEC 11.2). A
// sub-agent's dispose used to erase the parent's evidence.
test('L5 a disposed session releases its ports but keeps their recordings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life5-'));
  const ctx = fakeCtx();
  await apply(ctx, { dataRoot: join(root, 'data') });
  const mounted = currentMount();
  t.after(async () => { await mounted.service.dispose(); });

  ctx.emit('session/event', { id: 's-gone' }, { type: 'tool/call', data: { callId: 'call_gone' } });
  const { createTools } = await import('../src/tools.mjs');
  const byName = Object.fromEntries(createTools(mounted.service).map((x) => [x.name, x]));
  const opened = await byName.serial_open.execute({ port: 'MOCK:ARCH2', project: 'p' }, { callId: 'call_gone:ptc:1' });
  mounted.service.feed(opened.data.portId, Buffer.from('bye\n'));
  const path = opened.data.path;

  ctx.emit('session/disposed', { id: 's-gone' });

  // The port is closed and flushed by the dispose path...
  assert.equal(await waitFor(() => mounted.service.status(opened.data.portId).state === 'closed', 4000), true);
  // ...but the capture (and its index row) survive.
  assert.equal(existsSync(path), true, 'disposing a session must not delete its recordings');
  assert.equal(mounted.service.store.listCapturesOfSession('s-gone').length, 1, 'the index row must survive');
});

// The host never emits session/disposed for an archive: it only appends the id
// to its workspace storage. The plugin has to notice that by itself.
test('L6 a conversation archived in the host UI loses its recordings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life6-'));
  const home = join(root, 'home');
  const ctx = fakeCtx();
  await apply(ctx, { dataRoot: join(root, 'data'), dshHome: home, archivePollMs: 20 });
  const mounted = currentMount();
  t.after(async () => { ctx.emit('dispose'); await mounted.service.dispose(); });

  ctx.emit('session/event', { id: 's-ui' }, { type: 'tool/call', data: { callId: 'call_ui' } });
  const { createTools } = await import('../src/tools.mjs');
  const byName = Object.fromEntries(createTools(mounted.service).map((x) => [x.name, x]));
  const opened = await byName.serial_open.execute({ port: 'MOCK:ARCH3', project: 'p' }, { callId: 'call_ui:ptc:1' });
  await byName.serial_close.execute({ portId: opened.data.portId }, { callId: 'call_ui:ptc:2' });
  const path = opened.data.path;
  assert.equal(existsSync(path), true);

  // Exactly what the desktop app does when the user archives the conversation.
  await writeArchiveList(home, ['s-ui']);

  assert.equal(
    await waitFor(
      () => !existsSync(path) && mounted.service.store.listCapturesOfSession('s-ui').length === 0,
      4000,
    ),
    true,
    'the archived recording and its index row must be gone',
  );
});

test('L7 a conversation archived while the plugin was down is reconciled on mount', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life7-'));
  const home = join(root, 'home');
  const settings = { dataRoot: join(root, 'data'), dshHome: home, archivePollMs: 20 };

  const first = fakeCtx();
  await apply(first, settings);
  const mounted = currentMount();
  first.emit('session/event', { id: 's-old' }, { type: 'tool/call', data: { callId: 'call_old' } });
  const { createTools } = await import('../src/tools.mjs');
  const byName = Object.fromEntries(createTools(mounted.service).map((x) => [x.name, x]));
  const opened = await byName.serial_open.execute({ port: 'MOCK:ARCH4', project: 'p' }, { callId: 'call_old:ptc:1' });
  await byName.serial_close.execute({ portId: opened.data.portId }, { callId: 'call_old:ptc:2' });
  const path = opened.data.path;
  first.emit('dispose');
  await mounted.service.dispose();

  // Archived while the host was not running.
  await writeArchiveList(home, ['s-old']);

  const second = fakeCtx();
  await apply(second, settings);
  const remounted = currentMount();
  t.after(async () => { second.emit('dispose'); await remounted.service.dispose(); });
  assert.equal(await waitFor(() => !existsSync(path), 4000), true, 'the reconcile pass must delete stale recordings');
  assert.equal(remounted.service.store.listCapturesOfSession('s-old').length, 0);
});
