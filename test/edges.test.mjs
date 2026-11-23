import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SerialError } from '../src/errors.mjs';
import { ioPath } from '../src/paths.mjs';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createTools } from '../src/tools.mjs';
import { replayCapture } from '../src/replay.mjs';
import { tmpRoot } from './helpers.mjs';

// errors: default fields
test('E-01 SerialError defaults are stable', () => {
  const e = new SerialError('E_X', 'boom');
  assert.equal(e.code, 'E_X');
  assert.equal(e.message, 'boom');
  assert.equal(e.hint, '');
  assert.deepEqual(e.fix, []);
  assert.equal(e.retryable, false);
  assert.equal(e.name, 'SerialError');
});

// paths: the long-path prefix is a Windows-only concern; elsewhere ioPath is a passthrough
test('E-02 ioPath handles UNC, already-prefixed and relative inputs', () => {
  if (process.platform !== 'win32') {
    assert.equal(ioPath('relative.txt'), 'relative.txt', 'non-Windows passes paths through');
    assert.equal(ioPath(''), '');
    return;
  }
  const unc = '\\\\server\\share\\' + 'x'.repeat(300);
  assert.ok(ioPath(unc).startsWith('\\\\?\\UNC\\'));
  assert.equal(ioPath('\\\\?\\C:\\already\\long'), '\\\\?\\C:\\already\\long');
  assert.equal(ioPath('relative.txt'), resolve('relative.txt'));
  assert.equal(ioPath(''), '');
});

// replay: real-time pacing honours maxRecords
test('E-03 replay at speed 1 with maxRecords stops early', async (t) => {
  const rootA = await tmpRoot('e3a-');
  const storeA = await Store.open({ root: rootA });
  const svcA = new SerialService({ store: storeA });
  t.after(() => svcA.dispose());
  const opened = await svcA.open({ port: 'MOCK:SRC', baudRate: 115200, project: 'P', conversation: 'src' });
  for (let i = 0; i < 6; i++) svcA.feed(opened.portId, Buffer.from('line ' + i + '\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await svcA.close(opened.portId);

  const storeB = await Store.open({ root: await tmpRoot('e3b-') });
  const svcB = new SerialService({ store: storeB });
  t.after(() => svcB.dispose());
  const res = await replayCapture({ service: svcB, path: closed.path, speed: 1, maxRecords: 3, portName: 'MOCK:R1' });
  assert.equal(res.records, 3);
  const tail = await svcB.tail({ portId: res.portId, maxLines: 10 });
  assert.deepEqual(tail.lines.map((l) => l.text), ['line 0', 'line 1', 'line 2']);
});

// store: a corrupt project marker falls back to the hashed folder
test('E-04 corrupt .project.json does not crash project resolution', async () => {
  const root = await tmpRoot('e4-');
  const store = await Store.open({ root });
  const first = await store.projectDir('D:/a/firmware', 'firmware');
  await mkdir(first, { recursive: true });
  await writeFile(join(first, '.project.json'), '{not json', 'utf8');

  const second = await store.projectDir('D:/b/firmware', 'firmware');
  assert.notEqual(second, first);
  assert.ok(/-[0-9a-f]{4}$/.test(second), second);
});

// tools: a plain Error from the service becomes an E_INTERNAL envelope with hints
test('E-05 unexpected service errors still produce an actionable envelope', async (t) => {
  const store = await Store.open({ root: await tmpRoot('e5-') });
  const service = new SerialService({ store });
  t.after(() => service.dispose());
  service.captures = () => { throw new Error('kaboom'); };
  const byName = Object.fromEntries(createTools(service).map((x) => [x.name, x]));
  const res = await byName.serial_captures.execute({});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_INTERNAL');
  assert.ok(res.error.hint.includes('Retrying'));
  assert.equal(res.error.retryable, true);
});

// tools: export surfaces E_CAPTURE_IO through the tool layer too
test('E-06 export failure keeps its code through the tool envelope', async (t) => {
  const root = await tmpRoot('e6-');
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(() => service.dispose());
  const byName = Object.fromEntries(createTools(service).map((x) => [x.name, x]));
  const opened = await byName.serial_open.execute({ port: 'MOCK:E6', project: 'P', conversation: 'c' });
  service.feed(opened.data.portId, Buffer.from('x\n'));
  const closed = await byName.serial_close.execute({ portId: opened.data.portId });

  const res = await byName.serial_export.execute({ captureId: closed.data.captureId, out: join(root, 'missing-dir', 'x.txt') });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_CAPTURE_IO');
  assert.ok(Array.isArray(res.error.fix) && res.error.fix.length > 0);
});
