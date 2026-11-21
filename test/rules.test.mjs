import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const HB_RULE = String.raw`
export function createScanner(ctx) {
  let buf = Buffer.alloc(0)
  let bufStart = 0
  return {
    record(rec) {
      if (rec.dir !== 'rx') return []
      if (buf.length === 0) bufStart = rec.offset
      buf = Buffer.concat([buf, rec.data])
      const marks = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) break
        const text = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '')
        const m = /^HB\s+(\d+)/.exec(text)
        if (m) {
          marks.push({
            anchor: { dir: 'rx', offset: bufStart, length: nl + 1 },
            t: rec.t, kind: 'state', severity: 'info', label: 'HB ' + m[1],
          })
        }
        buf = buf.subarray(nl + 1)
        bufStart += nl + 1
      }
      return marks
    },
    finish() { return [] },
  }
}
`;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'rules-t-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store, rulesRoot: join(root, 'rules') });
  const opened = await service.open({ port: 'MOCK:RT', baudRate: 115200, project: 'p', conversation: 'c' });
  service.feed(opened.portId, Buffer.from('HB 1 100\r\nHB 2 200\r\nnope\r\nHB 3 300\r\n'));
  await new Promise((r) => setTimeout(r, 40));
  const closed = await service.close(opened.portId);
  return { root, store, service, captureId: closed.captureId, cleanup: async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); } };
}

test('R1 install + list a rule', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const added = await h.service.rulesAdd({ name: 'hb', source: HB_RULE, meta: { description: 'heartbeats' } });
  assert.ok(added.path.endsWith('rule.mjs'));
  const list = await h.service.rulesList();
  assert.deepEqual(list.rules.map((r) => r.name), ['hb']);
  assert.equal(list.rules[0].description, 'heartbeats');
});

test('R2 rescan produces marks with byte references and no text', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.rulesAdd({ name: 'hb', source: HB_RULE });
  const applied = await h.service.rulesApply(h.captureId, {});
  assert.equal(applied.results[0].marks, 3);

  const marks = await h.service.marks(h.captureId, {});
  assert.equal(marks.count, 3);
  for (const m of marks.marks) {
    assert.ok(typeof m.anchor.offset === 'number');
    assert.ok(m.anchor.length > 0);
    assert.equal(m.rule, 'hb');
    assert.ok(!('text' in m), 'marks must not embed decoded text');
    assert.ok(m.window && m.window.length >= m.anchor.length);
  }
});

test('R3 bytes can be pulled back by reference', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.rulesAdd({ name: 'hb', source: HB_RULE });
  await h.service.rulesApply(h.captureId, {});
  const marks = await h.service.marks(h.captureId, {});
  const first = marks.marks[0];
  const text = await h.service.bytes(h.captureId, { dir: 'rx', offset: first.anchor.offset, length: first.anchor.length, format: 'text' });
  assert.match(text.body, /^HB \d+ \d+\r\n$/);
  const hex = await h.service.bytes(h.captureId, { dir: 'rx', offset: first.anchor.offset, length: 4, format: 'hex' });
  assert.match(hex.body, /^[0-9a-f]{8}  48 42 20/);
});

test('R4 a bad rule name is rejected', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await assert.rejects(
    () => h.service.rulesAdd({ name: '../escape', source: HB_RULE }),
    (err) => err.code === 'E_INVALID_ARGS',
  );
});

test('R5 a throwing rule is reported, not fatal', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.rulesAdd({ name: 'boom', source: 'export function createScanner(){ return { record(){ throw new Error("boom") } } }' });
  const res = await h.service.rulesApply(h.captureId, { rules: ['boom'] });
  assert.equal(res.results[0].marks, 0);
  assert.equal(res.results[0].error.code, 'E_RULE_FAILED');
  assert.match(res.results[0].error.message, /boom/);
});

test('R6 rescanning is idempotent', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.rulesAdd({ name: 'hb', source: HB_RULE });
  await h.service.rulesApply(h.captureId, {});
  const first = (await h.service.marks(h.captureId, {})).marks.map((m) => m.id);
  await h.service.rulesApply(h.captureId, {});
  const second = (await h.service.marks(h.captureId, {})).marks.map((m) => m.id);
  assert.deepEqual(second, first);
  const files = await readdir(join(h.store.marksDir(h.captureId)));
  assert.deepEqual(files.filter((f) => f.endsWith('.jsonl')), ['hb.jsonl']);
});
