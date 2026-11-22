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

async function makeCapture(service, port, text) {
  const opened = await service.open({ port, baudRate: 115200, project: 'clean', conversation: 'c' });
  service.feed(opened.portId, Buffer.from(text));
  await new Promise((r) => setTimeout(r, 30));
  return await service.close(opened.portId);
}

test('CL1 dry run lists victims and deletes nothing', async (t) => {
  const h = await harness(t);
  const a = await makeCapture(h.service, 'MOCK:C1', 'one\n');
  const b = await makeCapture(h.service, 'MOCK:C2', 'two\n');
  const plan = await h.byName.serial_cleanup.execute({ keepLast: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.data.count, 1);
  assert.ok(plan.data.bytes > 0);
  assert.ok(plan.data.planId);
  assert.equal((await stat(a.path)).size > 0, true);
  assert.equal((await stat(b.path)).size > 0, true);
  assert.equal(h.store.listCaptures({}).length, 2);
});

test('CL2 applying a plan deletes the files and the index rows', async (t) => {
  const h = await harness(t);
  const a = await makeCapture(h.service, 'MOCK:C1', 'one\n');
  const b = await makeCapture(h.service, 'MOCK:C2', 'two\n');
  const plan = await h.byName.serial_cleanup.execute({ keepLast: 1 });
  const applied = await h.byName.serial_cleanup.execute({ planId: plan.data.planId });
  assert.equal(applied.ok, true);
  assert.equal(applied.data.removed, 1);
  assert.equal(h.store.listCaptures({}).length, 1);
  const gone = plan.data.items[0].captureId === a.captureId ? a : b;
  const kept = gone === a ? b : a;
  await assert.rejects(() => stat(gone.path), /ENOENT/);
  assert.ok((await stat(kept.path)).size > 0);
});

test('CL3 a stale plan id is refused with an actionable error', async (t) => {
  const h = await harness(t);
  const res = await h.byName.serial_cleanup.execute({ planId: 'clean-nope' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_NO_SUCH_PLAN');
  assert.ok(res.error.fix.length > 0);
});

test('CL4 deleting without a plan is refused', async (t) => {
  const h = await harness(t);
  const res = await h.byName.serial_cleanup.execute({ dryRun: false, olderThanDays: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_INVALID_ARGS');
});

test('CL5 human recordings are never planned for deletion', async (t) => {
  const h = await harness(t);
  const mine = await makeCapture(h.service, 'MOCK:A1', 'agent\n');
  // a recording the user started from the panel: owner kind 'session'
  const human = await h.service.open({ port: 'MOCK:H1', project: 'clean', conversation: 'panel', owner: { kind: 'session', id: 'panel-s' } });
  h.service.feed(human.portId, Buffer.from('human\n'));
  await new Promise((r) => setTimeout(r, 30));
  const humanClosed = await h.service.close(human.portId);

  const plan = await h.byName.serial_cleanup.execute({ olderThanDays: 0, keepLast: 0 });
  assert.equal(plan.ok, true);
  assert.equal(plan.data.scope, 'agent');
  assert.equal(plan.data.count, 1);
  assert.equal(plan.data.skippedHuman, 1);
  assert.equal(plan.data.items[0].captureId, mine.captureId);

  const applied = await h.byName.serial_cleanup.execute({ planId: plan.data.planId });
  assert.equal(applied.data.removed, 1);
  assert.ok((await stat(humanClosed.path)).size > 0, 'the human recording must survive');
  assert.equal(h.store.listCaptures({}).length, 1);
});

test('CL6 includeHuman is an explicit opt-in', async (t) => {
  const h = await harness(t);
  await makeCapture(h.service, 'MOCK:A2', 'agent\\n');
  const human = await h.service.open({ port: 'MOCK:H2', project: 'clean', conversation: 'panel', owner: { kind: 'session', id: 'panel-s' } });
  h.service.feed(human.portId, Buffer.from('human\\n'));
  await new Promise((r) => setTimeout(r, 30));
  await h.service.close(human.portId);

  const plan = await h.byName.serial_cleanup.execute({ includeHuman: true });
  assert.equal(plan.data.scope, 'all');
  assert.equal(plan.data.count, 2);
  const applied = await h.byName.serial_cleanup.execute({ planId: plan.data.planId });
  assert.equal(applied.data.removed, 2);
  assert.equal(h.store.listCaptures({}).length, 0);
});
