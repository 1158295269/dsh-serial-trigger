import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeCtx() {
  const listeners = new Map();
  const effects = [];
  return {
    tools: { register: () => () => {} },
    on(event, handler) { listeners.set(event, handler); return () => {}; },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') effects.push(stop); return () => {}; },
    emit(event, payload) { const h = listeners.get(event); return h ? h(payload) : undefined; },
    listeners,
    effects,
  };
}

test('L1 a disposed session releases only its own ports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life-'));
  const ctx = fakeCtx();
  const mounted = await apply(ctx, { dataRoot: join(root, 'data') });
  t.after(async () => { await mounted.service.dispose(); });

  const a = await mounted.service.open({ port: 'MOCK:A', owner: { kind: 'session', id: 's1' } });
  const b = await mounted.service.open({ port: 'MOCK:B', owner: { kind: 'session', id: 's2' } });

  ctx.emit('session/disposed', { id: 's1' });
  await tick();

  assert.equal(mounted.service.status(a.portId).state, 'closed');
  assert.equal(mounted.service.status(b.portId).state, 'open');
});

test('L2 disposing the plugin closes every open port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'life2-'));
  const ctx = fakeCtx();
  const mounted = await apply(ctx, { dataRoot: join(root, 'data') });
  const a = await mounted.service.open({ port: 'MOCK:C', owner: { kind: 'agent', id: 'x' } });
  assert.equal(mounted.service.status(a.portId).state, 'open');

  // the last registered effect is the shutdown hook
  const stop = ctx.effects[ctx.effects.length - 1];
  assert.equal(typeof stop, 'function');
  stop();
  await tick(120);

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
