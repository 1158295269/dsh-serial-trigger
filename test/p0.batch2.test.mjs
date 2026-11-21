import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Hub, TOPIC } from '../src/hub.mjs';
import { Store, digestOf } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createTools } from '../src/tools.mjs';
import { KIND } from '../src/codec.mjs';
import { tmpRoot } from './helpers.mjs';

// ---------- hub ----------
test('H05 closing a subscription wakes a pending next()', async () => {
  const hub = new Hub();
  const sub = hub.subscribe(TOPIC.STREAM, { filter: { portId: 1 } });
  const pending = sub.next();
  sub.close();
  assert.equal(await pending, null);
});

test('H06 a cursor beyond head is clamped, not crashed', async () => {
  const root = await tmpRoot('h6-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  const { portId } = await service.open({ port: 'MOCK:6', baudRate: 115200, project: 'P', conversation: 'c' });
  service.feed(portId, Buffer.from('a\n'));
  const res = await service.tail({ portId, cursor: 999999, maxLines: 10 });
  assert.equal(res.lines.length, 0);
  assert.ok(res.cursor <= res.head);
  await service.close(portId);
  await service.dispose();
});

test('H07 filters select by port, direction and kind', async () => {
  const hub = new Hub();
  const rxOnly = hub.subscribe(TOPIC.STREAM, { filter: { portId: 2, dir: 0 } });
  const other = hub.subscribe(TOPIC.STREAM, { filter: { portId: 3 } });
  hub.publishData(2, { dir: 0, bytes: Buffer.from('rx'), tMonoUs: 1, tWallMs: 1 });
  hub.publishData(2, { dir: 1, bytes: Buffer.from('tx'), tMonoUs: 2, tWallMs: 2 });
  hub.publishData(3, { dir: 0, bytes: Buffer.from('x'), tMonoUs: 3, tWallMs: 3 });
  assert.equal(Buffer.from((await rxOnly.next(50)).bytes).toString(), 'rx');
  assert.equal(await rxOnly.next(30), null);
  assert.equal(Buffer.from((await other.next(50)).bytes).toString(), 'x');
  rxOnly.close(); other.close();
});

test('H08 gap accounting matches the bytes actually dropped', async () => {
  const hub = new Hub();
  const sub = hub.subscribe(TOPIC.STREAM, { filter: { portId: 4 }, queueBytes: 30 });
  for (let i = 0; i < 6; i++) hub.publishData(4, { dir: 0, bytes: Buffer.alloc(10, i), tMonoUs: i, tWallMs: i });

  // capacity 30 with 10-byte batches keeps the newest three; the gap rides on the
  // first surviving batch and totals the three batches that were evicted.
  const delivered = [];
  for (;;) {
    const msg = await sub.next(20);
    if (!msg) break;
    delivered.push(msg);
  }
  assert.equal(delivered.length, 3, 'bounded queue keeps only what fits');
  const gaps = delivered.reduce((sum, m) => sum + (m.gapBytes || 0), 0);
  assert.equal(gaps, 30, 'three 10-byte batches were dropped');
  assert.ok(delivered[0].flags & 2, 'gap flag on the first surviving batch');
  sub.close();
});

// ---------- store ----------
test('S02 traversal names cannot escape the data root', async () => {
  const root = await tmpRoot('s2-');
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: '../../etc', conversation: '../../evil', port: 'COM1', baud: 115200 });
  assert.ok(resolve(cap.path).startsWith(resolve(root)), 'path must stay under root: ' + cap.path);
  const name = cap.path.slice(root.length);
  assert.ok(!name.includes('..\\') && !name.includes('../'), 'no traversal segment: ' + name);
  await cap.writer.close();
});

test('S03 two captures in the same second get distinct files', async () => {
  const root = await tmpRoot('s3-');
  const store = await Store.open({ root });
  const a = await store.openCapture({ project: 'P', conversation: 'same', port: 'COM1', baud: 115200 });
  const b = await store.openCapture({ project: 'P', conversation: 'same', port: 'COM1', baud: 115200 });
  assert.notEqual(a.path, b.path);
  assert.ok(/-\d+\.slog$/.test(b.path), 'second file is suffixed: ' + b.path);
  await a.writer.close();
  await b.writer.close();
});

test('S06 deleting index.db rebuilds the catalog from the tree', async () => {
  const root = await tmpRoot('s6-');
  let store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'C028_FW', conversation: 'i2c', port: 'COM3', baud: 921600 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('boot ok\nerror timeout\n'), tMonoUs: 1, tWallMs: Date.now() });
  await store.closeCapture(cap.captureId);
  assert.equal(store.listCaptures({}).length, 1);

  store.db.close();
  await rm(join(root, 'index.db'), { force: true });

  store = await Store.open({ root });
  assert.equal(store.listCaptures({}).length, 0, 'fresh index is empty');
  const res = await store.recover();
  const rows = store.listCaptures({});
  assert.equal(rows.length, 1, 'file was re-indexed');
  assert.equal(rows[0].id, cap.captureId);
  assert.equal(rows[0].project, 'C028_FW');
  assert.ok(res.rebuilt.inserted >= 1);
});

test('S07 closing a capture twice is idempotent', async () => {
  const root = await tmpRoot('s7-');
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('x\n'), tMonoUs: 1, tWallMs: Date.now() });
  const first = await store.closeCapture(cap.captureId);
  const second = await store.closeCapture(cap.captureId);
  assert.equal(second.already, true);
  assert.equal(second.path, first.path);
});

test('S08 binary garbage does not break digest or grep', async () => {
  const root = await tmpRoot('s8-');
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'bin', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: randomBytes(4096), tMonoUs: 1, tWallMs: Date.now() });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('\nlow battery error 0x2f\n'), tMonoUs: 2, tWallMs: Date.now() });
  await store.closeCapture(cap.captureId);

  const d = await digestOf(cap.path);
  assert.ok(d.lines >= 1);
  assert.ok(d.summary.errors.error >= 1);
  const hits = await store.grep(cap.captureId, 'battery');
  assert.equal(hits.length, 1);
});

// ---------- tools ----------
async function toolBox() {
  const root = await tmpRoot('t-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  return { root, store, service, byName: Object.fromEntries(createTools(service).map((x) => [x.name, x])) };
}

test('T01 every tool rejects missing arguments with E_INVALID_ARGS', async (t) => {
  const { service, byName } = await toolBox();
  t.after(() => service.dispose());
  const cases = [
    ['serial_open', {}],
    ['serial_close', {}],
    ['serial_tail', {}],
    ['serial_send', { portId: 1 }],
    ['serial_grep', { captureId: 'x' }],
    ['serial_export', {}],
  ];
  for (const [name, args] of cases) {
    const res = await byName[name].execute(args);
    assert.equal(res.ok, false, name);
    assert.equal(res.error.code, 'E_INVALID_ARGS', name + ' -> ' + res.error.code);
  }
});

test('T02 hex input is validated, never silently truncated', async (t) => {
  const { service, byName } = await toolBox();
  t.after(() => service.dispose());
  const opened = await byName.serial_open.execute({ port: 'MOCK:H', project: 'P', conversation: 'c' });
  const portId = opened.data.portId;

  const bad = await byName.serial_send.execute({ portId, hex: 'zz' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_INVALID_ARGS');

  const odd = await byName.serial_send.execute({ portId, hex: 'abc' });
  assert.equal(odd.ok, false);
  assert.equal(odd.error.code, 'E_INVALID_ARGS');

  const good = await byName.serial_send.execute({ portId, hex: '1b 5b 41' });
  assert.equal(good.ok, true);
  assert.equal(good.data.bytes, 3);
});

test('T05 error envelope always carries code/message/hint/fix/retryable', async () => {
  const { service, byName } = await toolBox();
  const res = await byName.serial_tail.execute({ portId: 777 });
  assert.equal(res.ok, false);
  for (const key of ['code', 'message', 'hint', 'fix', 'retryable']) {
    assert.ok(key in res.error, 'missing ' + key);
  }
  assert.ok(Array.isArray(res.error.fix));
  assert.equal(typeof res.error.retryable, 'boolean');
  await service.dispose();
});
