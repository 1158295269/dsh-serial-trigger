import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, inject } from '../src/index.mjs';

test('bundle entry registers every tool on a cordis-like ctx', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'plugin-'));
  const registered = [];
  const ctx = {
    tools: { register: (tool) => { registered.push(tool.name); return () => {}; } },
    effect: (fn) => { fn(); },
  };
  await apply(ctx, { dataRoot });
  assert.equal(name, 'serial-trigger');
  assert.deepEqual(inject, ['tools']);
  assert.deepEqual(registered.sort(), [
    'serial_bytes', 'serial_captures', 'serial_cleanup', 'serial_close', 'serial_export', 'serial_fsm_event',
    'serial_fsm_simulate', 'serial_fsm_start', 'serial_fsm_status', 'serial_fsm_stop',
    'serial_fsm_wait', 'serial_grep', 'serial_marks', 'serial_open', 'serial_ports',
    'serial_scan', 'serial_send', 'serial_tail',
  ]);
});

test('entry survives a bad dataRoot instead of throwing', async () => {
  const ctx = { tools: { register: () => () => {} }, effect: (fn) => fn() };
  const orig = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  await apply(ctx, { dataRoot: 'Z:\\nope\\__x__\\\u0000bad' });
  console.warn = orig;
  assert.ok(warned >= 1, 'expected a warning instead of a throw');
});
