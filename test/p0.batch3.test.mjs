import { basename } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LineAssembler } from '../src/lines.mjs';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { tmpRoot, readLines } from './helpers.mjs';

const b = (s) => Buffer.from(s, 'utf8');

// ---------- lines ----------
test('L03 a lone CR is data, not a line break (lf mode)', () => {
  const la = new LineAssembler({ lineEnding: 'lf' });
  const out = la.feed({ bytes: b('50%\r60%\r70%\n'), seq: 0, tWallMs: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '50%\r60%\r70%');
  assert.equal(out[0].partial, false);
});

test('L03b a trailing CR with no LF survives the flush (lf mode)', () => {
  const la = new LineAssembler({ lineEnding: 'lf' });
  assert.equal(la.feed({ bytes: b('abc\r'), seq: 0, tWallMs: 1 }).length, 0);
  const tail = la.flush(2);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].text, 'abc\r');
  assert.equal(tail[0].partial, true);
});

test('L04 CRLF split across two batches joins into one break', () => {
  const la = new LineAssembler();
  const a = la.feed({ bytes: b('line one\r'), seq: 0, tWallMs: 1 });
  assert.equal(a.length, 0);
  const c = la.feed({ bytes: b('\nline two\n'), seq: 10, tWallMs: 2 });
  assert.deepEqual(c.map((l) => l.text), ['line one', 'line two']);
});

test('L05 an overlong line is emitted as a partial instead of growing forever', () => {
  const la = new LineAssembler({ maxLine: 16 });
  const out = la.feed({ bytes: b('x'.repeat(40)), seq: 0, tWallMs: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].partial, true);
  assert.equal(out[0].text.length, 40);
  assert.equal(la.carry.length, 0);

  const more = la.feed({ bytes: b('y'.repeat(5) + '\n'), seq: 40, tWallMs: 2 });
  assert.deepEqual(more.map((l) => l.text), ['yyyyy']);
});

// ---------- store filters ----------
test('S05 since / until / limit / project filters', async () => {
  const root = await tmpRoot('s5-');
  const store = await Store.open({ root });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const cap = await store.openCapture({ project: i === 2 ? 'OTHER' : 'MAIN', conversation: 'c' + i, port: 'COM1', baud: 115200 });
    cap.writer.append({ kind: 0, bytes: Buffer.from('x\n'), tMonoUs: 1, tWallMs: Date.now() });
    await store.closeCapture(cap.captureId);
    ids.push(cap.captureId);
  }
  // pin the timestamps so the assertions are deterministic
  const base = 1_700_000_000_000;
  ids.forEach((id, i) => store.db.prepare('UPDATE captures SET started_ms = ? WHERE id = ?').run(base + i * 1000, id));

  assert.equal(store.listCaptures({}).length, 3);
  assert.equal(store.listCaptures({ project: 'MAIN' }).length, 2);
  assert.equal(store.listCaptures({ since: base + 1500 }).length, 1);
  assert.equal(store.listCaptures({ until: base + 1500 }).length, 2);
  assert.equal(store.listCaptures({ since: base + 500, until: base + 1500 }).length, 1);
  assert.equal(store.listCaptures({ limit: 1 }).length, 1);
});

// ---------- paths ----------
test('X01 Chinese path end to end: record, tail, index, grep, export', async (t) => {
  const base = await tmpRoot('中文-');
  const root = join(base, '串口 日志', '工程 A');
  await mkdir(root, { recursive: true });

  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(() => service.dispose());

  const opened = await service.open({ port: 'MOCK:COM7', baudRate: 115200, project: '手表 固件', conversation: '调试 I2C 断连' });
  service.feed(opened.portId, Buffer.from('开机完成\nI2C 超时 地址 0x48\n'));
  await new Promise((r) => setTimeout(r, 40));

  const tail = await service.tail({ portId: opened.portId, maxLines: 10 });
  assert.deepEqual(tail.lines.map((l) => l.text), ['开机完成', 'I2C 超时 地址 0x48']);

  const closed = await service.close(opened.portId);
  assert.match(basename(closed.path), /^_?MOCK-COM7-|^COM7-/, closed.path);

  const rows = store.listCaptures({ project: '手表 固件' });
  assert.equal(rows.length, 1);

  const hits = await store.grep(rows[0].id, '超时');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);

  const exp = await store.exportCapture(rows[0].id, { format: 'text', timestamps: true });
  const body = await readLines(rows[0].path);
  assert.equal(body.lines.length, 2);
});

test('X02 a path longer than MAX_PATH still records and reads back', async (t) => {
  const base = await tmpRoot('long-');
  const deep = join(base, 'd'.repeat(40), 'e'.repeat(40), 'f'.repeat(40), 'g'.repeat(40), 'h'.repeat(40), 'i'.repeat(40));
  assert.ok(deep.length > 260, 'test path is ' + deep.length + ' chars');

  const store = await Store.open({ root: deep });
  const service = new SerialService({ store });
  t.after(() => service.dispose());

  const opened = await service.open({ port: 'MOCK:COM9', baudRate: 921600, project: 'P', conversation: 'c' });
  service.feed(opened.portId, Buffer.from('deep path works\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await service.close(opened.portId);

  const size = (await stat(closed.path)).size;
  assert.ok(size > 64, 'file exists at ' + closed.path);
  const back = await readLines(closed.path);
  assert.deepEqual(back.lines.map((l) => l.text), ['deep path works']);
});
