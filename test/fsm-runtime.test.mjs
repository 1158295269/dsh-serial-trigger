import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
