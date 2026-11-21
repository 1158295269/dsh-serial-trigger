import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

test('B1 a second open without takeover is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'busy-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  t.after(async () => { await service.dispose(); store.db.close(); await rm(root, { recursive: true, force: true }); });

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
