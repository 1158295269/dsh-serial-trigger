import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  SlogWriter, SlogReader, KIND, HEADER_SIZE, RECORD_HEADER_SIZE, encodeHeader, decodeHeader, clipUtf8,
} from '../src/codec.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function tmpFile(name = 'a.slog') {
  const dir = await mkdtemp(join(tmpdir(), 'c-'));
  return join(dir, name);
}

// C02
test('C02 header port name clips on a UTF-8 character boundary', async () => {
  const cn = '串口COM3-测试用端口名字很长';
  const buf = encodeHeader({ port: cn, baud: 115200 });
  const h = decodeHeader(buf);
  assert.ok(!h.port.includes('\ufffd'), 'decoded port must not contain U+FFFD: ' + JSON.stringify(h.port));
  assert.ok(cn.startsWith(h.port), 'clipped name must be a prefix of the original');
  assert.ok(Buffer.byteLength(h.port, 'utf8') <= 24);
  // pure ASCII still clips exactly
  assert.equal(decodeHeader(encodeHeader({ port: 'A'.repeat(40) })).port, 'A'.repeat(24));
  // a 4-byte emoji at the boundary is dropped whole
  assert.equal(clipUtf8('a😀', 2).toString('utf8'), 'a');
});

// C03
test('C03 zero-length payload records survive a roundtrip', async () => {
  const path = await tmpFile('zero.slog');
  const w = await SlogWriter.create(path, { port: 'COM1', baud: 115200 });
  w.append({ kind: KIND.MARK, bytes: Buffer.alloc(0), tMonoUs: 1, tWallMs: 10 });
  w.append({ kind: KIND.RX, bytes: Buffer.from('x'), tMonoUs: 2, tWallMs: 11 });
  w.append({ kind: KIND.MARK, bytes: Buffer.alloc(0), tMonoUs: 3, tWallMs: 12 });
  await w.close();

  const r = await SlogReader.open(path);
  const sizes = [];
  const sum = await r.scan((rec) => sizes.push(rec.bytes.length));
  assert.deepEqual(sizes, [0, 1, 0]);
  assert.equal(sum.records, 3);
  assert.equal(sum.kinds[KIND.MARK], 2);
  assert.equal(sum.truncated, false);
});

// C04
test('C04 a record larger than the write buffer keeps every byte', async () => {
  const path = await tmpFile('big.slog');
  const big = randomBytes(2 * 1024 * 1024 + 13);
  const w = await SlogWriter.create(path, { port: 'COM2', baud: 3000000 });
  w.append({ kind: KIND.RX, bytes: big, tMonoUs: 1, tWallMs: 10 });
  w.append({ kind: KIND.RX, bytes: Buffer.from('small'), tMonoUs: 2, tWallMs: 11 });
  await w.close();

  const r = await SlogReader.open(path);
  const got = [];
  await r.scan((rec) => got.push(rec.bytes));
  assert.equal(got.length, 2);
  assert.equal(got[0].length, big.length);
  assert.equal(sha(got[0]), sha(big));
  assert.equal(got[1].toString(), 'small');
});

// C05
test('C05 records straddling the 8MB read chunk boundary stay intact', async () => {
  const path = await tmpFile('chunk.slog');
  const payload = randomBytes(16 * 1024);
  const count = 600; // ~9.4MB total, crosses the 8MB chunk exactly once
  const w = await SlogWriter.create(path, { port: 'COM3', baud: 921600 });
  for (let i = 0; i < count; i++) w.append({ kind: i % 2 ? KIND.RX : KIND.TX, bytes: payload, tMonoUs: i, tWallMs: i });
  await w.close();

  const r = await SlogReader.open(path);
  const h = createHash('sha256');
  let n = 0;
  const sum = await r.scan((rec) => { h.update(rec.bytes); n++; });
  const expected = createHash('sha256');
  for (let i = 0; i < count; i++) expected.update(payload);
  assert.equal(n, count);
  assert.equal(h.digest('hex'), expected.digest('hex'));
  assert.equal(sum.rxBytes + sum.txBytes, count * payload.length);
});

// C06
test('C06 a corrupted payload length is rejected without buffering toward it', async () => {
  const path = await tmpFile('corrupt.slog');
  const header = encodeHeader({ port: 'COM4', baud: 115200 });
  const bogus = Buffer.alloc(RECORD_HEADER_SIZE + 32, 0);
  bogus.writeUInt32LE(0xfffffff0, 0); // claims ~4GB
  bogus.writeBigUInt64LE(1n, 4);
  bogus.writeBigUInt64LE(1n, 12);
  await writeFile(path, Buffer.concat([header, bogus]));

  const r = await SlogReader.open(path);
  await assert.rejects(() => r.scan(), /E_RECORD_TOO_LARGE/);
});

// C07
test('C07 truncating at any offset recovers the complete-record prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trunc-'));
  const path = join(dir, 't.slog');
  const recs = [];
  const w = await SlogWriter.create(path, { port: 'COM5', baud: 115200 });
  for (let i = 0; i < 20; i++) {
    const b = Buffer.from('record-' + String(i).padStart(2, '0')); // fixed width: the test does offset math
    recs.push(b);
    w.append({ kind: KIND.RX, bytes: b, tMonoUs: i, tWallMs: i });
  }
  await w.close();
  const full = await readFile(path);
  const recSize = RECORD_HEADER_SIZE + recs[0].length;

  const offsets = [HEADER_SIZE, HEADER_SIZE + 1, HEADER_SIZE + recSize - 1];
  for (let i = 0; i < 20; i++) {
    offsets.push(HEADER_SIZE + i * recSize + Math.floor(recSize / 2));
    offsets.push(HEADER_SIZE + (i + 1) * recSize);
  }
  const partial = join(dir, 'p.slog');
  for (const off of offsets) {
    if (off > full.length) continue;
    await writeFile(partial, full.subarray(0, off));
    const r = await SlogReader.open(partial);
    const tail = [];
    const sum = await r.scan((rec) => tail.push(rec.bytes.toString()));
    const complete = Math.max(0, Math.floor((off - HEADER_SIZE) / recSize));
    assert.equal(tail.length, complete, 'offset ' + off);
    assert.deepEqual(tail, recs.slice(0, complete).map((b) => b.toString()));
    const exact = (off - HEADER_SIZE) % recSize === 0;
    assert.equal(sum.truncated, !exact, 'truncated flag at offset ' + off);
  }
});
