import test from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../src/fsm.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const scenario = (onTimeout) => ({
  name: 'to',
  initial: 'idle',
  states: {
    idle: {
      on: {
        'event:go': { send: 'PING\n', expect: 'line:/PONG/', waitMs: 100, goto: 'done', ...(onTimeout ? { onTimeout } : {}) },
      },
    },
    done: { on: {} },
    recover: { on: {} },
  },
});

const sends = (list) => list.filter((a) => a.type === 'send').map((a) => a.text);

test('F1 retry resends the same payload before falling back', () => {
  const m = new Machine(scenario({ retry: 1, mark: '无回执' }), { simulated: true });
  m.event('go', 1000);
  assert.deepEqual(sends(m.drainActions()), ['PING\n']);

  m.tick(1200);                       // first wait expired -> one resend
  assert.deepEqual(sends(m.drainActions()), ['PING\n']);
  assert.ok(m.trace.some((t) => t.via === 'retry'));
  assert.equal(m.pending.attempt, 1);

  for (const t of m.feedLine('PONG', 1250)) { /* trace recorded */ }
  assert.equal(m.state, 'done');
  assert.deepEqual(m.drainActions(), []);
});

test('F2 a timeout can jump to a recovery state with a custom mark', () => {
  const m = new Machine(scenario({ goto: 'recover', mark: '设备没回 PONG', severity: 'warn' }), { simulated: true });
  m.event('go', 1000);
  m.drainActions();
  m.tick(1200);
  assert.equal(m.state, 'recover');
  const marks = m.drainActions().filter((a) => a.type === 'mark');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].label, '设备没回 PONG');
  assert.equal(marks[0].severity, 'warn');
});

test('F3 onTimeout.stop ends the machine instead of waiting forever', () => {
  const m = new Machine(scenario({ stop: true, mark: '彻底没响应' }), { simulated: true });
  m.event('go', 1000);
  m.drainActions();
  m.tick(1200);
  assert.equal(m.stopped, true);
  const actions = m.drainActions();
  assert.ok(actions.some((a) => a.type === 'stop'));
  assert.equal(m.status().stopped, true);
});

test('F4 without onTimeout the old behaviour is unchanged', () => {
  const m = new Machine(scenario(null), { simulated: true });
  m.event('go', 1000);
  m.drainActions();
  m.tick(1200);
  const marks = m.drainActions().filter((a) => a.type === 'mark');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].severity, 'error');
});

test('F5 a live machine stops when its timeout policy says stop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fsmto-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store, scanRoots: [root] });
  t.after(async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await service.open({ port: 'MOCK:TO', owner: { kind: 'agent', id: 'a1' } });
  const def = {
    name: 'stop-on-silence', initial: 'idle',
    states: {
      idle: { on: { 'event:go': { send: 'PING\n', expect: 'line:/PONG/', waitMs: 80, goto: 'done', onTimeout: { stop: true, mark: '无回执，停机' } } } },
      done: { on: {} },
    },
  };
  const run = await service.fsmStart({ scenario: def, portId: opened.portId, owner: { kind: 'agent', id: 'a1' } });
  await service.fsmEvent(run.runId, 'go');
  const deadline = Date.now() + 3000;
  let gone = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    try { service.fsmStatus(run.runId); } catch (e) { if (e.code === 'E_NO_SUCH_RUN') { gone = true; break; } }
  }
  assert.equal(gone, true, 'the run should have stopped itself');
  await service.close(opened.portId);
});
