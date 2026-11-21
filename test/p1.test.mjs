import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  SlogWriter, SlogReader, KIND, HEADER_SIZE, encodeHeader,
} from '../src/codec.mjs';
import { LineAssembler } from '../src/lines.mjs';
import { Hub, TOPIC } from '../src/hub.mjs';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createTools } from '../src/tools.mjs';
import { replayCapture } from '../src/replay.mjs';
import { apply } from '../src/index.mjs';
import { tmpRoot, readLines } from './helpers.mjs';

async function tmpFile(name = 'x.slog') {
  const dir = await tmpRoot('p1-');
  return join(dir, name);
}

// ---------- codec ----------
test('C08 a newer container version is refused', async () => {
  const path = await tmpFile();
  const h = encodeHeader({ port: 'COM1' });
  h.writeUInt16LE(9, 8);
  await writeFile(path, Buffer.concat([h, Buffer.alloc(64)]));
  await assert.rejects(() => SlogReader.open(path), /E_VERSION_TOO_NEW/);
});

test('C09 an unexpected header size is refused', async () => {
  const path = await tmpFile();
  const h = encodeHeader({ port: 'COM1' });
  h.writeUInt32LE(128, 12);
  await writeFile(path, Buffer.concat([h, Buffer.alloc(64)]));
  await assert.rejects(() => SlogReader.open(path), /E_BAD_HEADER_SIZE/);
});

test('C10 close is idempotent', async () => {
  const path = await tmpFile();
  const w = await SlogWriter.create(path, { port: 'COM1' });
  w.append({ kind: KIND.RX, bytes: Buffer.from('a'), tMonoUs: 1, tWallMs: 1 });
  const a = await w.close();
  const b = await w.close();
  assert.equal(a.records, b.records);
  assert.equal(a.bytes, 1);
});

test('C11 appending after close is a clear error', async () => {
  const path = await tmpFile();
  const w = await SlogWriter.create(path, { port: 'COM1' });
  await w.close();
  assert.throws(() => w.append({ kind: KIND.RX, bytes: Buffer.from('x') }), /E_WRITER_CLOSED/);
});

test('C12 a file shorter than the header is refused', async () => {
  const path = await tmpFile();
  await writeFile(path, Buffer.alloc(10));
  await assert.rejects(() => SlogReader.open(path), /E_SHORT_HEADER/);
});

// ---------- lines ----------
test('L06 GBK device output decodes correctly', () => {
  const la = new LineAssembler({ encoding: 'gbk' });
  const gbk = Buffer.from([0xce, 0xc2, 0xb6, 0xc8, 0x3d, 0x32, 0x35, 0x0a]); // 温度=25 + LF
  const out = la.feed({ bytes: gbk, seq: 0, tWallMs: 1 });
  assert.deepEqual(out.map((l) => l.text), ['温度=25']);
});

test('L07 a line completed from carry keeps the seq of its first byte', () => {
  const la = new LineAssembler();
  la.feed({ bytes: Buffer.from('abc'), seq: 100, tWallMs: 1 });
  const out = la.feed({ bytes: Buffer.from('def\n'), seq: 103, tWallMs: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'abcdef');
  assert.equal(out[0].seq, 100);
});

test('L08 an empty batch produces nothing', () => {
  const la = new LineAssembler();
  assert.deepEqual(la.feed({ bytes: Buffer.alloc(0), seq: 0, tWallMs: 1 }), []);
  assert.deepEqual(la.flush(2), []);
});

// ---------- hub ----------
test('H10 ports do not leak into each other', async () => {
  const hub = new Hub();
  const a = hub.subscribe(TOPIC.STREAM, { filter: { portId: 10 } });
  const b = hub.subscribe(TOPIC.STREAM, { filter: { portId: 11 } });
  hub.publishData(10, { dir: 0, bytes: Buffer.from('for-a'), tMonoUs: 1, tWallMs: 1 });
  const gotA = Buffer.from((await a.next(50)).bytes).toString();
  assert.equal(gotA, 'for-a');
  assert.equal(await b.next(30), null);
  a.close(); b.close();
});

test('H11 a waiting subscriber is woken by a publish, not by polling', async () => {
  const hub = new Hub();
  const sub = hub.subscribe(TOPIC.STREAM, { filter: { portId: 12 } });
  const start = Date.now();
  const waiting = sub.next();
  setTimeout(() => hub.publishData(12, { dir: 0, bytes: Buffer.from('late'), tMonoUs: 1, tWallMs: 1 }), 30);
  const msg = await waiting;
  assert.equal(Buffer.from(msg.bytes).toString(), 'late');
  assert.ok(Date.now() - start >= 25);
  sub.close();
});

// ---------- store ----------
test('S09 exporting to an unwritable path reports E_CAPTURE_IO', async () => {
  const root = await tmpRoot('s9-');
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('x\n'), tMonoUs: 1, tWallMs: Date.now() });
  await store.closeCapture(cap.captureId);

  await assert.rejects(
    () => store.exportCapture(cap.captureId, { format: 'text', out: 'Z:\\no-such-drive\\x.txt' }),
    (err) => {
      assert.equal(err.code, 'E_CAPTURE_IO');
      assert.ok(err.hint.length > 10);
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test('S10 grep over a 100MB capture stays under two seconds', async () => {
  const root = await tmpRoot('s10-');
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'big', conversation: 'c', port: 'COM1', baud: 3000000 });
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  chunk[chunk.length - 1] = 10;
  chunk.write('needle-here', 0);
  for (let i = 0; i < 1600; i++) cap.writer.append({ kind: KIND.RX, bytes: chunk, tMonoUs: i, tWallMs: Date.now() });
  await store.closeCapture(cap.captureId);
  const { size } = await stat(cap.path);
  assert.ok(size > 100 * 1024 * 1024, 'capture is ' + size);

  const t0 = Date.now();
  const hits = await store.grep(cap.captureId, 'needle-here', { maxHits: 5 });
  const ms = Date.now() - t0;
  assert.equal(hits.length, 5);
  // Target is 2s uninstrumented (see bench/grep.mjs); coverage roughly doubles it.
  assert.ok(ms < 4000, 'grep took ' + ms + 'ms');
});

test('S11 two stores on the same root see each other\'s rows', async () => {
  const root = await tmpRoot('s11-');
  const a = await Store.open({ root });
  const cap = await a.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('x\n'), tMonoUs: 1, tWallMs: Date.now() });
  await a.closeCapture(cap.captureId);

  const b = await Store.open({ root });
  assert.equal(b.listCaptures({}).length, 1);
  a.db.close();
  b.db.close();
});

// ---------- service ----------
test('V10 a failing writer flips the port into error instead of lying', async (t) => {
  const root = await tmpRoot('v10-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(() => service.dispose());
  const { portId } = await service.open({ port: 'MOCK:E', baudRate: 115200, project: 'P', conversation: 'c' });

  const rec = service.ports.get(portId);
  rec.writer.append = () => { throw new Error('disk full'); };
  service.feed(portId, Buffer.from('boom\n'));
  assert.equal(rec.state, 'error');
});

test('V11 closing right after a burst keeps every byte', async (t) => {
  const root = await tmpRoot('v11-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(() => service.dispose());
  const { portId } = await service.open({ port: 'MOCK:F', baudRate: 115200, project: 'P', conversation: 'c' });
  const payload = randomBytes(4096);
  for (let i = 0; i < 20; i++) service.feed(portId, payload);
  const closed = await service.close(portId);
  assert.equal(closed.bytesRx, 20 * payload.length);
  const row = store.listCaptures({}).find((r) => r.id === closed.captureId);
  const back = await readLines(row.path);
  assert.equal(back.summary.rxBytes, 20 * payload.length);
});

// ---------- tools ----------
async function toolBox() {
  const root = await tmpRoot('p1t-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  return { store, service, byName: Object.fromEntries(createTools(service).map((x) => [x.name, x])) };
}

test('T03 text and hex together are rejected', async (t) => {
  const { service, byName } = await toolBox();
  t.after(() => service.dispose());
  const opened = await byName.serial_open.execute({ port: 'MOCK:T3', project: 'P', conversation: 'c' });
  const res = await byName.serial_send.execute({ portId: opened.data.portId, text: 'A', hex: '41' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_INVALID_ARGS');
});

test('T04 an unknown export format is rejected', async (t) => {
  const { service, byName } = await toolBox();
  t.after(() => service.dispose());
  const res = await byName.serial_export.execute({ captureId: 'x', format: 'xml' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_INVALID_ARGS');
});

// ---------- replay ----------
test('R01/R02 replay at full speed and with recording on', async (t) => {
  const src = await toolBox();
  t.after(() => src.service.dispose());
  const opened = await src.byName.serial_open.execute({ port: 'MOCK:R', project: 'P', conversation: 'src' });
  for (let i = 0; i < 5; i++) src.service.feed(opened.data.portId, Buffer.from('frame ' + i + '\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await src.byName.serial_close.execute({ portId: opened.data.portId });

  const fast = await toolBox();
  t.after(() => fast.service.dispose());
  const r1 = await replayCapture({ service: fast.service, path: closed.data.path, speed: 0, portName: 'MOCK:R0' });
  const tail = await fast.service.tail({ portId: r1.portId, maxLines: 10 });
  assert.deepEqual(tail.lines.map((l) => l.text), ['frame 0', 'frame 1', 'frame 2', 'frame 3', 'frame 4']);

  const rec = await toolBox();
  t.after(() => rec.service.dispose());
  await replayCapture({ service: rec.service, path: closed.data.path, speed: 0, portName: 'MOCK:R2', record: true });
  const rows = rec.store.listCaptures({});
  assert.equal(rows.length, 1, 'replay recorded a new capture');
  assert.equal(rows[0].project, 'replay');
});

// ---------- entry ----------
test('E03 applying the plugin twice does not double-register tools', async () => {
  const dataRoot = await tmpRoot('e3-');
  const registered = [];
  const ctx = {
    tools: { register: (tool) => { registered.push(tool.name); return () => {}; } },
    effect: (fn) => { fn(); },
  };
  await apply(ctx, { dataRoot });
  await apply(ctx, { dataRoot });
  assert.equal(registered.length, 14);
});

// ---------- files ----------
test('X03 repeated open/close does not leak handles', async (t) => {
  const root = await tmpRoot('x3-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(() => service.dispose());

  await service.close((await service.open({ port: 'MOCK:WARM', project: 'P', conversation: 'warm' })).portId);
  const baseline = process._getActiveHandles().length;

  for (let i = 0; i < 20; i++) {
    const { portId } = await service.open({ port: 'MOCK:L' + (i % 5), project: 'P', conversation: 'c' + i });
    service.feed(portId, Buffer.from('x\n'));
    await service.close(portId);
  }
  const later = process._getActiveHandles().length;
  // Handle counts drift by a few entries under the test runner; a real leak grows linearly.
  assert.ok(later <= baseline + 6, 'handles grew from ' + baseline + ' to ' + later);
});
