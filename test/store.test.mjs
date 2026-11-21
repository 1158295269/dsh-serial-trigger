import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sanitizeName, digestOf } from '../src/store.mjs';
import { KIND } from '../src/codec.mjs';

async function tmpRoot() {
  return await mkdtemp(join(tmpdir(), 'store-'));
}

test('sanitizeName: windows rules and CJK width', () => {
  assert.equal(sanitizeName('a/b:c*?'), 'a-b-c--');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('trailing...'), 'trailing');
  assert.equal(sanitizeName('   '), 'untitled');
  const long = sanitizeName('分析一下 C028 固件里 BLE 断连后重启的问题', 32);
  let width = 0;
  for (const ch of long) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  assert.ok(width <= 32, 'width ' + width);
});

test('open -> write -> close -> index row with digest', async () => {
  const root = await tmpRoot();
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'C028_FW', conversation: '调 I2C', sessionId: 's1', port: 'COM3', baud: 921600 });

  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('boot ok\n'), tMonoUs: 1000, tWallMs: 1795000000000 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('i2c timeout on addr 0x48\nerror code 5\n'), tMonoUs: 2000, tWallMs: 1795000000100 });
  cap.writer.append({ kind: KIND.TX, bytes: Buffer.from('AT+RESET\n'), tMonoUs: 3000, tWallMs: 1795000000200 });

  const closed = await store.closeCapture(cap.captureId, { txBytes: 9 });
  assert.equal(closed.digest.lines, 4);
  assert.equal(closed.digest.summary.errors.timeout, 1);
  assert.ok(closed.digest.summary.first[0].startsWith('boot ok'));

  const rows = store.listCaptures({ project: 'C028_FW' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].port, 'COM3');
  assert.equal(rows[0].lines, 4);
  assert.equal(rows[0].missing, 0);
  assert.ok(rows[0].path.endsWith('.slog'));

  const byKeyword = store.listCaptures({ keyword: 'timeout' });
  assert.equal(byKeyword.length, 1);
  const none = store.listCaptures({ keyword: 'spi' });
  assert.equal(none.length, 0);
});

test('grep returns line numbers, direction and timestamps', async () => {
  const root = await tmpRoot();
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('a\nb\ni2c TIMEOUT here\nc\n'), tMonoUs: 10, tWallMs: 1795000000000 });
  await store.closeCapture(cap.captureId);

  const hits = await store.grep(cap.captureId, 'timeout');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].dir, 'rx');
  assert.deepEqual(hits[0].before.map((x) => x.text), ['a', 'b']);
});

test('export text writes timestamps and tx marker, source untouched', async () => {
  const root = await tmpRoot();
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('rx line\n'), tMonoUs: 1, tWallMs: Date.UTC(2026, 10, 20, 12, 0, 0) });
  cap.writer.append({ kind: KIND.TX, bytes: Buffer.from('tx line\n'), tMonoUs: 2, tWallMs: Date.UTC(2026, 10, 20, 12, 0, 1) });
  await store.closeCapture(cap.captureId);

  const out = await store.exportCapture(cap.captureId, { format: 'text', timestamps: true });
  const body = await readFile(out.path, 'utf8');
  assert.ok(body.includes('[12:00:00.000] rx line'));
  assert.ok(body.includes('[12:00:01.000] >> tx line'));

  const before = await readFile(out.path.replace(/\.txt$/, '.slog'));
  assert.ok(before.length > 64, 'slog still has content');

  const hex = await store.exportCapture(cap.captureId, { format: 'hex', out: out.path.replace(/\.txt$/, '.hex') });
  const hexBody = await readFile(hex.path, 'utf8');
  assert.ok(/^00000040\s+72 78/m.test(hexBody), 'hex dump starts at header end');
});

test('project collision gets a hash suffix, same path reuses the folder', async () => {
  const root = await tmpRoot();
  const store = await Store.open({ root });
  const a = await store.projectDir('D:/work/a/firmware', 'firmware');
  await (await import('node:fs/promises')).mkdir(a, { recursive: true });
  await writeFile(join(a, '.project.json'), JSON.stringify({ path: 'D:/work/a/firmware' }), 'utf8');

  const aAgain = await store.projectDir('D:/work/a/firmware', 'firmware');
  assert.equal(aAgain, a);

  const b = await store.projectDir('D:/work/b/firmware', 'firmware');
  assert.notEqual(b, a);
  assert.ok(/-[0-9a-f]{4}$/.test(b), 'expected hash suffix, got ' + b);
});

test('recover flags deleted files and backfills digests', async () => {
  const root = await tmpRoot();
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  cap.writer.append({ kind: KIND.RX, bytes: Buffer.from('hello\n'), tMonoUs: 1, tWallMs: Date.now() });
  await cap.writer.flush();
  // simulate a crash: no closeCapture, so ended_ms stays null
  const { unlink } = await import('node:fs/promises');
  const second = await store.openCapture({ project: 'P', conversation: 'gone', port: 'COM2', baud: 115200 });
  await second.writer.close();
  await unlink(second.path);

  const res = await store.recover();
  assert.ok(res.fixed >= 1);
  const row = store.listCaptures({ includeMissing: true }).find((r) => r.id === second.captureId);
  assert.equal(row.missing, 1);
});

test('digestOf counts error kinds across a bigger file', async () => {
  const root = await tmpRoot();
  const store = await Store.open({ root });
  const cap = await store.openCapture({ project: 'P', conversation: 'c', port: 'COM1', baud: 115200 });
  for (let i = 0; i < 100; i++) {
    const line = i % 3 === 0 ? 'ERROR boot fail ' + i : 'ok ' + i;
    cap.writer.append({ kind: KIND.RX, bytes: Buffer.from(line + '\n'), tMonoUs: i, tWallMs: Date.now() });
  }
  await store.closeCapture(cap.captureId);
  const d = await digestOf(cap.path);
  assert.equal(d.lines, 100);
  assert.ok(d.summary.errors.error >= 30);
});
