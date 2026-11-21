import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { SerialError } from '../src/errors.mjs';
import { tmpRoot, readLines, feedLines, waitFor, sleep } from './helpers.mjs';

async function boot() {
  const root = await tmpRoot('svc-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  return { root, store, service };
}

const open = (service, extra = {}) => service.open({ port: 'MOCK:T', baudRate: 115200, project: 'P', conversation: 'c', ...extra });

// V03
test('V03 send after close is rejected with an actionable error', async (t) => {
  const { service } = await boot();
  t.after(() => service.dispose());
  const { portId } = await open(service);
  await service.close(portId);
  await assert.rejects(() => service.send(portId, Buffer.from('x')), (err) => {
    assert.ok(err instanceof SerialError);
    assert.equal(err.code, 'E_PORT_NOT_OPEN');
    assert.ok(err.hint.includes('reopen'));
    return true;
  });
});

// V04
test('V04 feeding an unopened port is rejected instead of vanishing into a ring', async (t) => {
  const { service } = await boot();
  t.after(() => service.dispose());
  assert.throws(() => service.feed(4242, Buffer.from('x')), (err) => {
    assert.equal(err.code, 'E_PORT_NOT_OPEN');
    return true;
  });
});

// V05
test('V05 two ports record independently', async (t) => {
  const { service, store } = await boot();
  t.after(() => service.dispose());
  const a = await open(service, { port: 'MOCK:A', conversation: 'a' });
  const b = await open(service, { port: 'MOCK:B', conversation: 'b' });

  feedLines(service, a.portId, ['a1', 'a2']);
  feedLines(service, b.portId, ['b1']);
  await sleep(50);

  const ta = await service.tail({ portId: a.portId, maxLines: 10 });
  const tb = await service.tail({ portId: b.portId, maxLines: 10 });
  assert.deepEqual(ta.lines.map((l) => l.text), ['a1', 'a2']);
  assert.deepEqual(tb.lines.map((l) => l.text), ['b1']);

  const ca = await service.close(a.portId);
  const cb = await service.close(b.portId);
  assert.notEqual(ca.path, cb.path);
  assert.equal(store.listCaptures({ project: 'P' }).length, 2);
  assert.equal((await readLines(ca.path)).lines.map((l) => l.text).join(','), 'a1,a2');
});

// V06
test('V06 tail honours maxLines exactly at the boundary', async (t) => {
  const { service } = await boot();
  t.after(() => service.dispose());
  const { portId } = await open(service);
  feedLines(service, portId, Array.from({ length: 10 }, (_, i) => 'l' + i));
  await sleep(40);

  const first = await service.tail({ portId, maxLines: 5 });
  assert.equal(first.lines.length, 5);
  assert.deepEqual(first.lines.map((l) => l.text), ['l0', 'l1', 'l2', 'l3', 'l4']);

  const second = await service.tail({ portId, cursor: first.cursor, maxLines: 5 });
  assert.equal(second.lines.length, 5);
  assert.deepEqual(second.lines.map((l) => l.text), ['l5', 'l6', 'l7', 'l8', 'l9']);

  const third = await service.tail({ portId, cursor: second.cursor, maxLines: 5 });
  assert.equal(third.lines.length, 0);
});

// V07
test('V07 repeated tails during a live stream never duplicate or lose lines', async (t) => {
  const { service } = await boot();
  t.after(() => service.dispose());
  const { portId } = await open(service);
  const seen = [];
  let cursor;

  for (let round = 0; round < 6; round++) {
    feedLines(service, portId, Array.from({ length: 3 }, (_, i) => 'r' + round + '-' + i));
    await sleep(20);
    const res = await service.tail({ portId, cursor, maxLines: 100 });
    cursor = res.cursor;
    seen.push(...res.lines.map((l) => l.text));
  }

  const expected = [];
  for (let r = 0; r < 6; r++) for (let i = 0; i < 3; i++) expected.push('r' + r + '-' + i);
  assert.deepEqual(seen, expected);
});

// V08
test('V08 dispose without close still persists the capture', async (t) => {
  const { service, store } = await boot();
  const { portId, captureId } = await open(service);
  feedLines(service, portId, ['survive', 'me']);
  await sleep(40);
  await service.dispose();

  const row = store.listCaptures({ includeMissing: true }).find((r) => r.id === captureId);
  assert.ok(row, 'index row exists');
  assert.ok(row.ended_ms, 'ended_ms was backfilled on dispose');
  const back = await readLines(row.path);
  assert.deepEqual(back.lines.map((l) => l.text), ['survive', 'me']);
});

// V09
test('V09 a 20MB burst is recorded byte for byte', async (t) => {
  const { service, store } = await boot();
  t.after(() => service.dispose());
  const { portId, captureId } = await open(service, { port: 'MOCK:BURST' });

  const batch = randomBytes(16 * 1024);
  const batches = 1280; // 20MB
  const started = Date.now();
  for (let i = 0; i < batches; i++) service.feed(portId, batch);
  const closed = await service.close(portId);
  const ms = Date.now() - started;

  assert.equal(closed.bytesRx, batches * batch.length, 'all bytes reached the recorder');
  assert.ok(ms < 15000, 'took ' + ms + 'ms');

  const row = store.listCaptures({}).find((r) => r.id === captureId);
  const { size } = await import('node:fs/promises').then((m) => m.stat(row.path));
  const overhead = 64 + batches * 24;
  assert.equal(size, batches * batch.length + overhead);
});
