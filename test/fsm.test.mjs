import test from 'node:test';
import assert from 'node:assert/strict';
import { Machine, simulate, validateScenario } from '../src/fsm.mjs';

const SCENARIO = {
  name: 'ble',
  initial: 'idle',
  states: {
    idle: {
      on: {
        'event:adv_start': {
          send: 'AT+ADV=1\r\n',
          expect: 'line:/BLE:ADVERTISING/',
          waitMs: 2000,
          goto: 'ready',
          else: 'failed',
          mark: '广播已开启',
        },
      },
    },
    ready: {
      on: { 'line:/BLE:CONNECTED/': { goto: 'connected', mark: '连接建立' } },
      after: { ms: 5000, goto: 'idle', mark: '无人连接，回到空闲' },
    },
    connected: { on: {} },
    failed: { on: {} },
  },
};

test('F1 a line matcher moves state', () => {
  const m = new Machine(SCENARIO);
  m.event('adv_start', 1000);
  assert.equal(m.state, 'idle');
  const t = m.feedLine('BLE:ADVERTISING', 1100);
  assert.equal(m.state, 'ready');
  assert.equal(t.length, 1);
});

test('F2 a send is queued with the expected answer', () => {
  const m = new Machine(SCENARIO);
  m.event('adv_start', 1000);
  const actions = m.drainActions();
  assert.equal(actions[0].type, 'send');
  assert.equal(actions[0].text, 'AT+ADV=1\r\n');
  assert.ok(m.status().waitingFor, 'the machine waits for confirmation');
});

test('F3 a missing answer falls into else with an error mark', () => {
  const m = new Machine(SCENARIO);
  m.event('adv_start', 1000);
  m.drainActions();
  const t = m.tick(3500);
  assert.equal(m.state, 'failed');
  assert.equal(t[0].via, 'expect-timeout');
  const marks = m.drainActions().filter((a) => a.type === 'mark');
  assert.equal(marks.at(-1).severity, 'error');
});

test('F4 an after timer fires while idle', () => {
  const m = new Machine(SCENARIO);
  m.state = 'ready';
  m._armAfter(1000);
  m.tick(7000);
  assert.equal(m.state, 'idle');
});

test('F5 a send without expect is rejected', () => {
  assert.throws(() => validateScenario({
    initial: 'a',
    states: { a: { on: { 'event:x': { send: 'PING', goto: 'b' } }, }, b: { on: {} } },
  }), /expect/);
});

test('F6 an unknown target state is rejected', () => {
  assert.throws(() => validateScenario({
    initial: 'a',
    states: { a: { on: { 'line:/x/': { goto: 'nope' } } } },
  }), /unknown goto/);
});

test('F7 simulate walks a recording without touching a port', () => {
  const lines = [
    { t: 1000, text: 'BOOT' },
    { t: 1500, text: 'BLE:ADVERTISING' },
    { t: 2000, text: 'BLE:CONNECTED' },
  ];
  const m = new Machine(SCENARIO);
  const out = simulate(SCENARIO, lines, { tailMs: 10000 });
  assert.ok(out.trace.length >= 0);
  assert.equal(out.state, 'idle', 'after the 5s timer nobody connected, so it returns to idle');
});
