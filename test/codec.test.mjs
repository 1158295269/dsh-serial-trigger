import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  SlogWriter, SlogReader, KIND, FLAG, HEADER_SIZE, decodeHeader, encodeHeader,
} from '../src/codec.mjs';

async function tmpFile(name) {
  const dir = await mkdtemp(join(tmpdir(), 'slog-'));
  return join(dir, name || 'a.slog');
}

test('roundtrip: header and records keep bytes and timing', async () => {
  const path = await tmpFile();
  const w = await SlogWriter.create(path, { port: 'COM3', baud: 921600, createdAt: 1795000000000 });
  w.append({ kind: KIND.RX, bytes: Buffer.from('hello '), tMonoUs: 100, tWallMs: 1795000000100 });
  w.append({ kind: KIND.RX, bytes: Buffer.from('world\n'), tMonoUs: 200, tWallMs: 1795000000200, flags: FLAG.PARTIAL });
  w.append({ kind: KIND.MARK, bytes: Buffer.from('user note'), tMonoUs: 300, tWallMs: 1795000000300 });
  const st = await w.close();
  assert.equal(st.records, 3);
  assert.equal(st.bytes, 6 + 6 + 9);

  const r = await SlogReader.open(path);
  assert.equal(r.header.port, 'COM3');
  assert.equal(r.header.baud, 921600);
  assert.equal(r.header.createdAt, 1795000000000);

  const seen = [];
  const sum = await r.scan(function (rec) { seen.push(rec); });
  assert.equal(sum.records, 3);
  assert.equal(sum.rxBytes, 12);
  assert.equal(sum.truncated, false);
  assert.equal(seen[0].bytes.toString(), 'hello ');
  assert.equal(seen[1].bytes.toString(), 'world\n');
  assert.equal(seen[1].flags & FLAG.PARTIAL, FLAG.PARTIAL);
  assert.equal(seen[2].tMonoUs, 300);
  assert.equal(sum.kinds[KIND.MARK], 1);
});

test('byte fidelity over 512 random records', async () => {
  const path = await tmpFile('big.slog');
  const w = await SlogWriter.create(path, { port: 'ttyUSB0', baud: 3000000 });
  const chunks = [];
  for (let i = 0; i < 512; i++) {
    const b = randomBytes(4096 + (i % 17));
    chunks.push(b);
    w.append({ kind: i % 2 ? KIND.RX : KIND.TX, bytes: b, tMonoUs: i * 1000, tWallMs: 1795000000000 + i });
  }
  await w.close();

  const all = Buffer.concat(chunks);
  const r = await SlogReader.open(path);
  const collected = [];
  const sum = await r.scan(function (rec) {
    if (rec.kind === KIND.RX || rec.kind === KIND.TX) collected.push(rec.bytes);
  });
  const back = Buffer.concat(collected);
  assert.equal(back.length, all.length);
  assert.equal(Buffer.compare(back, all), 0);
  assert.equal(sum.rxBytes + sum.txBytes, all.length);
});

test('recovery: trailing partial record detected, complete records survive', async () => {
  const path = await tmpFile('crash.slog');
  const w = await SlogWriter.create(path, { port: 'COM1', baud: 115200 });
  for (let i = 0; i < 10; i++) {
    w.append({ kind: KIND.RX, bytes: Buffer.from('line ' + i + '\n'), tMonoUs: i * 100, tWallMs: 1795000000000 + i });
  }
  await w.close();

  const before = (await stat(path)).size;
  await truncate(path, before - 7);

  const r = await SlogReader.open(path);
  const sum = await r.scan();
  assert.equal(sum.truncated, true);
  assert.ok(sum.droppedBytes > 0);
  assert.equal(sum.records, 9);
  assert.equal(sum.rxBytes, 9 * 7);
});

test('long port name is clipped into the 24 byte field', async () => {
  const buf = encodeHeader({ port: 'a-very-long-port-name-that-overflows', baud: 9600 });
  const h = decodeHeader(buf);
  assert.ok(h.port.length <= 24);
  assert.equal(h.baud, 9600);
});

test('bad magic is rejected', async () => {
  const buf = Buffer.alloc(HEADER_SIZE, 0x41);
  assert.throws(function () { decodeHeader(buf); }, /E_BAD_MAGIC/);
});

test('empty capture scans clean', async () => {
  const path = await tmpFile('empty.slog');
  const w = await SlogWriter.create(path, { port: 'COM9', baud: 115200 });
  await w.close();
  const sum = await SlogReader.open(path).then(function (r) { return r.scan(); });
  assert.equal(sum.records, 0);
  assert.equal(sum.truncated, false);
  assert.equal(sum.endOffset, HEADER_SIZE);
});
