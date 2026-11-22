import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const SCRIPT = String.raw`
export function createScanner() {
  let buf = Buffer.alloc(0)
  let start = 0
  return {
    record(rec) {
      if (rec.dir !== 'rx') return []
      if (buf.length === 0) start = rec.offset
      buf = Buffer.concat([buf, rec.data])
      const marks = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) break
        const text = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '')
        const m = /^HB\s+(\d+)/.exec(text)
        if (m) {
          marks.push({
            anchor: { dir: 'rx', offset: start, length: nl + 1 },
            t: rec.t, kind: 'state', severity: 'info', label: 'HB ' + m[1],
          })
        }
        buf = buf.subarray(nl + 1)
        start += nl + 1
      }
      return marks
    },
    finish() { return [] },
  }
}
`;

const SCRIPT_ONE = String.raw`
export function createScanner() {
  return {
    record(rec) {
      if (rec.dir !== 'rx') return null
      return { anchor: { dir: 'rx', offset: rec.offset, length: 2 }, t: rec.t, kind: 'note', severity: 'info', label: 'one-rx' }
    },
    finish() {
      return { anchor: { dir: 'rx', offset: 0, length: 1 }, t: 0, kind: 'note', severity: 'info', label: 'finish-one' }
    },
  }
}
`;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'scan-t-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store, scanRoots: [root] });
  const opened = await service.open({ port: 'MOCK:SC', baudRate: 115200, project: 'p', conversation: 'c' });
  service.feed(opened.portId, Buffer.from('HB 1 100\r\nHB 2 200\r\nnope\r\nHB 3 300\r\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await service.close(opened.portId);
  const script = join(root, 'hb.mjs');
  await writeFile(script, SCRIPT, 'utf8');
  return {
    root, service, script,
    captureId: closed.captureId,
    cleanup: async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('S1 a script file scans a capture and leaves marks', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const res = await h.service.scan(h.captureId, { script: h.script });
  assert.equal(res.marks, 3);
  assert.equal(res.label, 'hb');
  const found = await h.service.marks(h.captureId, {});
  assert.equal(found.count, 3);
  assert.equal(found.sources[0].label, 'hb');
  assert.equal(found.sources[0].script, h.script);
  for (const m of found.marks) {
    assert.ok(!('text' in m));
    assert.ok(typeof m.anchor.offset === 'number');
    assert.ok(m.window);
  }
});

test('S2 bytes can be pulled back by reference', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.scan(h.captureId, { script: h.script });
  const found = await h.service.marks(h.captureId, {});
  const first = found.marks[0];
  const text = await h.service.bytes(h.captureId, { dir: 'rx', offset: first.anchor.offset, length: first.anchor.length, format: 'text' });
  assert.match(text.body, /^HB \d+ \d+\r\n$/);
});

test('S3 a script outside the workspace is refused', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const outside = join(tmpdir(), 'outside-' + Date.now() + '.mjs');
  await writeFile(outside, SCRIPT, 'utf8');
  await assert.rejects(
    () => h.service.scan(h.captureId, { script: outside }),
    (err) => err.code === 'E_SCRIPT_OUTSIDE_WORKSPACE',
  );
  await rm(outside, { force: true });
});

test('S4 a missing script is reported', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await assert.rejects(
    () => h.service.scan(h.captureId, { script: join(h.root, 'nope.mjs') }),
    (err) => err.code === 'E_NO_SUCH_SCRIPT',
  );
});

test('S5 a throwing script fails the call, not the plugin', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const bad = join(h.root, 'boom.mjs');
  await writeFile(bad, 'export function createScanner(){ return { record(){ throw new Error("boom") } } }', 'utf8');
  await assert.rejects(
    () => h.service.scan(h.captureId, { script: bad }),
    (err) => err.code === 'E_SCAN_FAILED' && /boom/.test(err.message),
  );
});

test('S6 rescanning the same script is idempotent', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.scan(h.captureId, { script: h.script });
  const first = (await h.service.marks(h.captureId, {})).marks.map((m) => m.id);
  await h.service.scan(h.captureId, { script: h.script });
  const second = (await h.service.marks(h.captureId, {})).marks.map((m) => m.id);
  assert.deepEqual(second, first);
  const files = await readdir(join(h.service.store.marksDir(h.captureId)));
  assert.deepEqual(files.filter((f) => f.endsWith('.jsonl')), ['hb.jsonl']);
});

test('S7 a runaway script is killed', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const loop = join(h.root, 'loop.mjs');
  await writeFile(loop, 'export function createScanner(){ return { record(){ for(;;){} } } }', 'utf8');
  await assert.rejects(
    () => h.service.scan(h.captureId, { script: loop, timeoutMs: 1200 }),
    (err) => err.code === 'E_SCAN_TIMEOUT',
  );
});

test('S8 an aborted scan stops feeding and reports E_SCAN_CANCELLED', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const loop = join(h.root, 'loop-abort.mjs');
  await writeFile(loop, 'export function createScanner(){ return { record(){ for(;;){} } } }', 'utf8');
  const ac = new AbortController();
  const started = Date.now();
  const pending = h.service.scan(h.captureId, { script: loop, timeoutMs: 30000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(pending, (err) => err.code === 'E_SCAN_CANCELLED');
  assert.ok(Date.now() - started < 5000, 'abort must not wait for the 30s timeout');
});

// A scanner is free to return one mark object instead of an array; the sandbox
// used to iterate it and fail with "marks is not iterable".
test('S9 a scanner may return a single mark object', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const script = join(h.root, 'one.mjs');
  await writeFile(script, SCRIPT_ONE, 'utf8');
  const res = await h.service.scan(h.captureId, { script });
  assert.ok(res.marks >= 2, 'one mark per rx record plus the finish mark');
  const found = await h.service.marks(h.captureId, {});
  assert.ok(found.marks.some((m) => m.label === 'one-rx'));
  assert.ok(found.marks.some((m) => m.label === 'finish-one'));
});
