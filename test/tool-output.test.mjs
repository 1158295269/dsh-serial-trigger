/**
 * Tool-result boundary regression tests.
 *
 * The host validates every tool result as **lossless JSON** before it reaches
 * the model: own properties holding `undefined`, non-finite numbers, -0, sparse
 * arrays, cycles, class instances and Buffers are all rejected with
 * "returned invalid output: value is not lossless JSON". A tool that returns
 * such a value looks like a broken plugin from the model's side, so the
 * boundary is tested here explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createTools } from '../src/tools.mjs';

/** Mirror of the host's lossless-JSON rule (dsh-session/json). */
function assertLosslessJson(value, label = 'value') {
  const seen = new Set();
  const walk = (v, path) => {
    if (v === null) return;
    const t = typeof v;
    if (t === 'boolean' || t === 'string') return;
    if (t === 'number') {
      assert.ok(Number.isFinite(v), path + ': non-finite number ' + v);
      assert.ok(!Object.is(v, -0), path + ': negative zero');
      return;
    }
    assert.equal(t, 'object', path + ': ' + t + ' is not JSON');
    assert.ok(!seen.has(v), path + ': cycle');
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        assert.ok(Object.prototype.hasOwnProperty.call(v, i), path + '[' + i + ']: sparse array');
        walk(v[i], path + '[' + i + ']');
      }
      seen.delete(v);
      return;
    }
    const proto = Object.getPrototypeOf(v);
    assert.ok(proto === null || (proto.constructor && proto.constructor.name === 'Object'),
      path + ': exotic object (' + (proto && proto.constructor && proto.constructor.name) + ')');
    for (const key of Reflect.ownKeys(v)) {
      assert.equal(typeof key, 'string', path + ': symbol key');
      assert.ok(Object.prototype.propertyIsEnumerable.call(v, key), path + ' key ' + String(key) + ': not enumerable');
      walk(v[key], path + '.' + String(key));
    }
    seen.delete(v);
  };
  walk(value, label);
}

async function harness(t, prefix = 'out-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); });
  const byName = Object.fromEntries(createTools(service).map((x) => [x.name, x]));
  return { root, store, service, byName };
}

async function makeCapture(service, port, lines) {
  const opened = await service.open({ port, project: 'out', owner: { kind: 'agent', id: 'a1' }, origin: 'agent' });
  for (const line of lines) service.feed(opened.portId, Buffer.from(line + '\n'));
  await new Promise((r) => setTimeout(r, 30));
  return await service.close(opened.portId);
}

test('O1 grep hits are lossless JSON and carry a byte seq', async (t) => {
  const h = await harness(t);
  const closed = await makeCapture(h.service, 'MOCK:G1', ['HB 1 10', 'HB 2 20', 'READY']);
  const res = await h.byName.serial_grep.execute({ captureId: closed.captureId, pattern: 'HB' }, {});
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assertLosslessJson(res.data, 'grep.data');
  assert.equal(res.data.hits.length, 2);
  assert.equal(res.data.count, 2);
  for (const [i, hit] of res.data.hits.entries()) {
    // Regression: seq used to be undefined because the reader has no batch seq.
    assert.equal(typeof hit.seq, 'number', 'hit.seq must be a number');
    assert.ok(Number.isFinite(hit.seq) && hit.seq >= 0);
    assert.equal(hit.line, i + 1);
    assert.equal(hit.dir, 'rx');
    assert.equal(typeof hit.text, 'string');
  }
  assert.deepEqual(res.data.hits[1].before, [{ line: 1, text: 'HB 1 10' }]);
});

test('O2 decode-lines view is lossless JSON and seq is a byte offset', async (t) => {
  const h = await harness(t);
  const closed = await makeCapture(h.service, 'MOCK:G2', ['AB', 'CD']);
  const view = await h.service.captureLines(closed.captureId);
  assertLosslessJson(view, 'captureLines');
  assert.equal(view.lines.length, 2);
  assert.equal(view.lines[0].seq, 0);
  assert.equal(view.lines[1].seq, 3, 'seq counts bytes including the newline');
});

test('O3 fsm simulate with marks is lossless JSON and omits absent fields', async (t) => {
  const h = await harness(t);
  const closed = await makeCapture(h.service, 'MOCK:G3', ['HB 1 10', 'HB 2 20']);
  const scenario = { initial: 'idle', states: { idle: { on: { 'line:/HB/': { goto: 'idle', mark: 'saw HB' } } } } };
  const res = await h.byName.serial_fsm_simulate.execute({ captureId: closed.captureId, scenario }, {});
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assertLosslessJson(res.data, 'simulate.data');
  assert.ok(res.data.marks.length >= 1);
  assert.equal(res.data.marks[0].label, 'saw HB');
  assert.ok(!Object.prototype.hasOwnProperty.call(res.data.marks[0], 'extra'), 'no undefined extra property');
});

test('O4 fsm live status/wait/event/stop are lossless JSON', async (t) => {
  const h = await harness(t);
  // No explicit owner / no exec on the tool calls: both sides resolve to the
  // agent identity the tool layer falls back to (owner match is required for a
  // live machine because it writes to the port).
  const opened = await h.service.open({ port: 'MOCK:G4', project: 'out', owner: { kind: 'agent', id: 'unknown' }, origin: 'agent' });
  const scenario = {
    initial: 'boot',
    states: {
      boot: { on: { 'line:/READY/': { goto: 'ready' }, 'event:start': { goto: 'boot' } } },
      ready: { on: { 'event:back': { goto: 'boot' } } },
    },
  };
  const started = await h.byName.serial_fsm_start.execute({ portId: opened.portId, scenario }, {});
  assert.equal(started.ok, true, JSON.stringify(started.error));
  assertLosslessJson(started.data, 'fsm_start.data');
  const runId = started.data.runId;
  h.service.feed(opened.portId, Buffer.from('READY\n'));
  const waited = await h.byName.serial_fsm_wait.execute({ runId, timeoutMs: 1500 }, {});
  assert.equal(waited.ok, true, JSON.stringify(waited.error));
  assertLosslessJson(waited.data, 'fsm_wait.data');
  assert.equal(waited.data.status.state, 'ready');
  const status = await h.byName.serial_fsm_status.execute({ runId }, {});
  assert.equal(status.ok, true);
  assertLosslessJson(status.data, 'fsm_status.data');
  const eventRes = await h.byName.serial_fsm_event.execute({ runId, name: 'back' }, {});
  assert.equal(eventRes.ok, true);
  assertLosslessJson(eventRes.data, 'fsm_event.data');
  const stopped = await h.byName.serial_fsm_stop.execute({ runId }, {});
  assert.equal(stopped.ok, true);
  assertLosslessJson(stopped.data, 'fsm_stop.data');
});

test('O5 marks and bytes results are lossless JSON', async (t) => {
  const h = await harness(t);
  const closed = await makeCapture(h.service, 'MOCK:G5', ['HB 1 10', 'HB 2 20']);
  await h.store.writeMarks(closed.captureId, 'unit', [{
    anchor: { dir: 'rx', offset: 0, length: 8 }, t: 1000, kind: 'fault', severity: 'warn', label: 'gap',
    code: { file: 'fw.c', symbol: 'hb' }, hypothesis: 'missed tick', next: [{ label: 'check power', expect: 'HB' }],
  }], { script: 'unit.mjs', scannedAt: Date.now() });
  const marks = await h.byName.serial_marks.execute({ captureId: closed.captureId }, {});
  assert.equal(marks.ok, true, JSON.stringify(marks.error));
  assertLosslessJson(marks.data, 'marks.data');
  assert.equal(marks.data.count, 1);
  assert.ok(marks.data.marks[0].window);
  const bytes = await h.byName.serial_bytes.execute({ captureId: closed.captureId, dir: 'rx', offset: 0, length: 16, format: 'hex' }, {});
  assert.equal(bytes.ok, true);
  assertLosslessJson(bytes.data, 'bytes.data');
  assert.match(bytes.data.body, /48 42 20/);
  assert.equal(bytes.data.truncated, false, 'a full-length read is not truncated');
  // Range crosses the end of the capture: fewer bytes than requested.
  const short = await h.byName.serial_bytes.execute({ captureId: closed.captureId, dir: 'rx', offset: 12, length: 16, format: 'text' }, {});
  assert.equal(short.ok, true);
  assert.equal(short.data.truncated, true);
  assert.ok(short.data.length < 16);
});

// A defaulted tail (no cursor) used to stop after maxLines at the OLDEST lines
// of the ring window, which made agents think the device had gone quiet.
test('O6 tail without a cursor returns the newest lines of the window', async (t) => {
  const h = await harness(t);
  const opened = await h.service.open({ port: 'MOCK:G6', project: 'out', owner: { kind: 'agent', id: 'unknown' }, origin: 'agent' });
  for (let i = 0; i < 30; i += 1) h.service.feed(opened.portId, Buffer.from('L' + i + '\n'));
  await new Promise((r) => setTimeout(r, 30));

  const fresh = await h.byName.serial_tail.execute({ portId: opened.portId, maxLines: 5 }, {});
  assert.equal(fresh.ok, true, JSON.stringify(fresh.error));
  assert.deepEqual(fresh.data.lines.map((l) => l.text), ['L25', 'L26', 'L27', 'L28', 'L29']);

  const fromStart = await h.byName.serial_tail.execute({ portId: opened.portId, cursor: 0, maxLines: 5 }, {});
  assert.equal(fromStart.ok, true);
  assert.deepEqual(fromStart.data.lines.map((l) => l.text), ['L0', 'L1', 'L2', 'L3', 'L4']);
});
