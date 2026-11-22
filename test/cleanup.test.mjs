import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createTools } from '../src/tools.mjs';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'clean-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); });
  const byName = Object.fromEntries(createTools(service).map((x) => [x.name, x]));
  return { root, store, service, byName };
}

async function makeCapture(service, port, text, origin = 'agent') {
  const owner = origin === 'agent' ? { kind: 'agent', id: 'a1' } : { kind: 'session', id: 'panel-s' };
  const opened = await service.open({ port, project: 'clean', conversation: 'c', owner, origin });
  service.feed(opened.portId, Buffer.from(text));
  await new Promise((r) => setTimeout(r, 30));
  return await service.close(opened.portId);
}

test('CL1 the tool reports a retention plan and deletes nothing', async (t) => {
  const h = await harness(t);
  const a = await makeCapture(h.service, 'MOCK:C1', 'one\n');
  const b = await makeCapture(h.service, 'MOCK:C2', 'two\n');
  const plan = await h.byName.serial_cleanup.execute({ keepLast: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.data.count, 1);
  assert.ok(plan.data.planId, 'a plan id is returned for inspection');
  assert.ok((await stat(a.path)).size > 0);
  assert.ok((await stat(b.path)).size > 0);
  assert.equal(h.store.listCaptures({}).length, 2);
});

test('CL2 the tool refuses to delete anything, even with a plan id', async (t) => {
  const h = await harness(t);
  await makeCapture(h.service, 'MOCK:C1', 'one\n');
  const plan = await h.byName.serial_cleanup.execute({});
  const res = await h.byName.serial_cleanup.execute({ planId: plan.data.planId });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_READ_ONLY');
  assert.equal(h.store.listCaptures({}).length, 1);
});

test('CL3 human recordings are outside the agent retention scope', async (t) => {
  const h = await harness(t);
  const mine = await makeCapture(h.service, 'MOCK:A1', 'agent\n');
  const human = await makeCapture(h.service, 'MOCK:H1', 'human\n', 'human');

  const plan = await h.byName.serial_cleanup.execute({ olderThanDays: 0, keepLast: 0 });
  assert.equal(plan.data.scope, 'agent');
  assert.equal(plan.data.count, 1);
  assert.equal(plan.data.skippedHuman, 1);
  assert.equal(plan.data.items[0].captureId, mine.captureId);
  assert.ok((await stat(human.path)).size > 0);
});

test('CL4 includeHuman is an explicit inspection switch', async (t) => {
  const h = await harness(t);
  await makeCapture(h.service, 'MOCK:A2', 'agent\n');
  await makeCapture(h.service, 'MOCK:H2', 'human\n', 'human');
  const plan = await h.byName.serial_cleanup.execute({ includeHuman: true });
  assert.equal(plan.data.scope, 'all');
  assert.equal(plan.data.count, 2);
});

test('CL5 the internal cleanup path still works (used by retention policy)', async (t) => {
  const h = await harness(t);
  const a = await makeCapture(h.service, 'MOCK:C1', 'one\n');
  const b = await makeCapture(h.service, 'MOCK:C2', 'two\n');
  const plan = await h.service.cleanup({ keepLast: 1 });
  const applied = await h.store.applyCleanup(plan.planId);
  assert.equal(applied.removed, 1);
  assert.equal(h.store.listCaptures({}).length, 1);
  // keepLast keeps the newest, so the older capture is the one that goes
  await assert.rejects(() => stat(a.path), /ENOENT/);
  assert.ok((await stat(b.path)).size > 0);
});

test('CL6 a stale plan id is refused with an actionable error', async (t) => {
  const h = await harness(t);
  await assert.rejects(
    () => h.store.applyCleanup('clean-nope'),
    (err) => err.code === 'E_NO_SUCH_PLAN' && err.fix.length > 0,
  );
});
