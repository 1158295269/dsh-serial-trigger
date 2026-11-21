import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'busy-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, service };
}

test('B1 a second open without takeover is refused', async (t) => {
  const { service } = await harness(t);

  const first = await service.open({ port: 'COM8', owner: { kind: 'session', id: 's1' } });
  await assert.rejects(
    () => service.open({ port: 'COM8', owner: { kind: 'agent', id: 'a1' } }),
    (err) => err.code === 'E_PORT_BUSY',
  );
  assert.equal(service.status(first.portId).state, 'open');

  const second = await service.open({ port: 'COM8', owner: { kind: 'agent', id: 'a1' }, takeover: true });
  assert.equal(service.status(second.portId).state, 'open');
  assert.equal(service.status(first.portId).state, 'closed');
});

test('B2 autoTakeover takes over and flushes the previous capture', async (t) => {
  const { service } = await harness(t);

  const panel = await service.open({ port: 'COM8', owner: { kind: 'session', id: 'panel-1' } });
  service.feed(panel.portId, Buffer.from('before takeover\n'));
  await service.flush(panel.portId);

  const agent = await service.open({ port: 'COM8', owner: { kind: 'agent', id: 'a1' }, autoTakeover: true });
  assert.equal(service.status(panel.portId).state, 'closed');
  assert.equal(service.status(agent.portId).state, 'open');

  const caps = await service.captures({ limit: 10 });
  const old = caps.find((c) => c.id === panel.captureId);
  assert.ok(old, 'the taken-over capture is indexed');
  assert.ok(old.ended_ms, 'the old capture was closed, not abandoned');
  assert.ok(old.bytes_rx > 0, 'bytes written before the takeover reached the file');

  // the new owner can write; the old handle cannot
  await assert.rejects(
    () => service.send(panel.portId, Buffer.from('x')),
    (err) => err.code === 'E_PORT_NOT_OPEN',
  );
  const sent = await service.send(agent.portId, Buffer.from('after\n'), { owner: { kind: 'agent', id: 'a1' } });
  assert.equal(sent.bytes, 6);
});

test('B3 a takeover stops the state machine bound to that port', async (t) => {
  const { service } = await harness(t);
  const scenario = { name: 'watch', initial: 'a', states: { a: { on: {} } } };

  const panel = await service.open({ port: 'COM8', owner: { kind: 'session', id: 'panel-1' } });
  const run = await service.fsmStart({ scenario, portId: panel.portId, owner: { kind: 'session', id: 'panel-1' } });

  await service.open({ port: 'COM8', owner: { kind: 'agent', id: 'a1' }, autoTakeover: true });
  assert.throws(() => service.fsmStatus(run.runId), (err) => err.code === 'E_NO_SUCH_RUN');
});

test('B4 the model path carries its own identity', async (t) => {
  const { service } = await harness(t);
  const { createTools } = await import('../src/tools.mjs');
  const byName = Object.fromEntries(createTools(service).map((x) => [x.name, x]));

  const exec = { agent: 'agent-7' };
  const opened = await byName.serial_open.execute({ port: 'MOCK:R4' }, exec);
  assert.equal(opened.ok, true);
  const listed = service.listPorts().find((p) => p.portId === opened.data.portId);
  assert.deepEqual(listed.owner, { kind: 'agent', id: 'agent-7' });

  const foreign = await byName.serial_send.execute({ portId: opened.data.portId, text: 'x' }, { agent: 'agent-8' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'E_NOT_OWNER');

  // closing another agent's capture is the same kind of trespass
  const foreignClose = await byName.serial_close.execute({ portId: opened.data.portId }, { agent: 'agent-8' });
  assert.equal(foreignClose.ok, false);
  assert.equal(foreignClose.error.code, 'E_NOT_OWNER');
  const ownClose = await byName.serial_close.execute({ portId: opened.data.portId }, exec);
  assert.equal(ownClose.ok, true);
});
