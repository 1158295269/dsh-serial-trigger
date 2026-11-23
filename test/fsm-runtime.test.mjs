import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const SCENARIO = {
  name: 'hb-watch',
  initial: 'idle',
  states: {
    idle: { on: { 'line:/^HB /': { goto: 'beating', mark: '心跳开始' } } },
    beating: { on: { 'line:/^HB /': { goto: 'beating' } } },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'fsmrt-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store, scanRoots: [root] });
  const opened = await service.open({ port: 'MOCK:LM', owner: { kind: 'agent', id: 'a1' } });
  return {
    root, service, portId: opened.portId,
    cleanup: async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('R1 simulate runs a scenario against a recording', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.service.feed(h.portId, Buffer.from('BOOT\nHB 1 100\n'));
  await sleep(40);
  const closed = await h.service.close(h.portId);
  const out = await h.service.fsmSimulate(closed.captureId, { scenario: SCENARIO });
  assert.equal(out.state, 'beating');
  assert.ok(out.marks.some((m) => m.label === '心跳开始'));
});

test('R2 a live run follows the port and reports transitions', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const started = await h.service.fsmStart({ scenario: SCENARIO, portId: h.portId, owner: { kind: 'agent', id: 'a1' } });
  assert.equal(started.status.state, 'idle');
  h.service.feed(h.portId, Buffer.from('HB 10 100\n'));
  const waited = await h.service.fsmWait(started.runId, { timeoutMs: 2000 });
  assert.equal(waited.status.state, 'beating');
});

test('R3 one machine per port', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.service.fsmStart({ scenario: SCENARIO, portId: h.portId, owner: { kind: 'agent', id: 'a1' } });
  await assert.rejects(
    () => h.service.fsmStart({ scenario: SCENARIO, portId: h.portId, owner: { kind: 'agent', id: 'a1' } }),
    (err) => err.code === 'E_FSM_BUSY',
  );
});

test('R4 disposing a session stops its machines', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  // the run must belong to the port owner, so reuse the opener's identity
  const started = await h.service.fsmStart({ scenario: SCENARIO, portId: h.portId, owner: { kind: 'agent', id: 'a1' } });
  const stopped = await h.service.stopRunsOwnedBy(['a1']);
  assert.deepEqual(stopped, [started.runId]);
  assert.throws(() => h.service.fsmStatus(started.runId), (err) => err.code === 'E_NO_SUCH_RUN');
});

test('R5 starting on a port owned by someone else is refused', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await assert.rejects(
    () => h.service.fsmStart({ scenario: SCENARIO, portId: h.portId, owner: { kind: 'agent', id: 'intruder' } }),
    (err) => err.code === 'E_NOT_OWNER',
  );
});


test('R6 a scenario outside the workspace is refused', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const outside = join(tmpdir(), 'outside-' + Date.now() + '.json');
  await writeFile(outside, JSON.stringify(SCENARIO), 'utf8');
  t.after(() => rm(outside, { force: true }));
  await assert.rejects(
    () => h.service.fsmStart({ scenario: outside, portId: h.portId, owner: { kind: 'agent', id: 'a1' } }),
    (err) => err.code === 'E_SCENARIO_OUTSIDE_WORKSPACE',
  );
});

test('R7 trace entries say whether a send was simulated or executed', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const def = {
    name: 'send-check', initial: 'a',
    states: { a: { on: { 'event:go': { send: 'X\n', expect: 'line:/OK/', waitMs: 500, goto: 'b' } } }, b: { on: {} } },
  };
  const started = await h.service.fsmStart({ scenario: def, portId: h.portId, owner: { kind: 'agent', id: 'a1' } });
  await h.service.fsmEvent(started.runId, 'go');
  h.service.feed(h.portId, Buffer.from('OK\n'));
  await sleep(120);
  const st = h.service.fsmStatus(started.runId);
  const entry = st.status.trace.find((x) => x.effects && x.effects.length);
  assert.equal(entry.effects[0].status, 'executed');

  const closed = await h.service.close(h.portId);
  const sim = await h.service.fsmSimulate(closed.captureId, { scenario: def });
  const fake = sim.trace.find((x) => x.effects && x.effects.length);
  if (fake) assert.equal(fake.effects[0].status, 'simulated');
});

// Regression: loadScenario() read fs/promises without importing it, so a
// {path} scenario failed with "stat is not defined" (E_INTERNAL).
test('R8 a scenario file inside the workspace loads and runs', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const file = join(h.root, 'watch.fsm.json');
  await writeFile(file, JSON.stringify(SCENARIO), 'utf8');
  h.service.feed(h.portId, Buffer.from('HB 1 100\n'));
  await sleep(40);
  const started = await h.service.fsmStart({ scenario: file, portId: h.portId, owner: { kind: 'agent', id: 'a1' } });
  assert.equal(started.status.name, 'hb-watch');
  await h.service.fsmStop(started.runId);
  const closed = await h.service.close(h.portId);
  const sim = await h.service.fsmSimulate(closed.captureId, { scenario: file });
  assert.equal(sim.state, 'beating');
});

// status.enteredAt used to be 0 for live machines (the Machine clock default).
test('R9 a live machine reports a real enteredAt', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const before = Date.now();
  const started = await h.service.fsmStart({ scenario: SCENARIO, portId: h.portId, owner: { kind: 'agent', id: 'a1' } });
  assert.ok(started.status.enteredAt >= before, 'enteredAt must be a wall-clock start time');
  assert.ok(Math.abs(started.status.enteredAt - Date.now()) < 5000);
  await h.service.fsmStop(started.runId);
});
