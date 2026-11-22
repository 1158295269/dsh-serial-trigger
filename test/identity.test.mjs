import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberCall, sessionOfCall, forgetCallsOfSession, resetCalls } from '../src/identity.mjs';

test('I1 a remembered call maps back to its session', () => {
  resetCalls();
  rememberCall('call_1', 'session-a');
  assert.equal(sessionOfCall('call_1'), 'session-a');
  assert.equal(sessionOfCall('call_other'), null);
});

test('I2 nested PTC calls resolve through their outer call id', () => {
  resetCalls();
  rememberCall('call_2', 'session-b');
  assert.equal(sessionOfCall('call_2:ptc:1'), 'session-b');
  assert.equal(sessionOfCall('call_2:ptc:7'), 'session-b');
});

test('I3 forgetting a session clears only its calls', () => {
  resetCalls();
  rememberCall('call_3', 'session-c');
  rememberCall('call_4', 'session-d');
  forgetCallsOfSession('session-c');
  assert.equal(sessionOfCall('call_3'), null);
  assert.equal(sessionOfCall('call_4'), 'session-d');
  resetCalls();
});
