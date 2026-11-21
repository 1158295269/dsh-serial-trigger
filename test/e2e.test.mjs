import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { createTools } from '../src/tools.mjs';
import { replayCapture } from '../src/replay.mjs';

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'e2e-'));
  const store = await Store.open({ root });
  const service = new SerialService({ store });
  service.registerMockPort('MOCK:CM4');
  const tools = createTools(service);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, service, tools, byName };
}

test('e2e: agent opens a port, tails twice, sends, closes, then finds the file again', async (t) => {
  const { byName, service } = await boot();
  t.after(() => service.dispose());

  const ports = await byName.serial_ports.execute({});
  assert.equal(ports.ok, true);
  assert.ok(ports.data.ports.some((p) => p.port === 'MOCK:CM4'));

  const opened = await byName.serial_open.execute({ port: 'MOCK:CM4', baudRate: 115200, project: 'C028_FW', conversation: '调 I2C', sessionId: 's-1' });
  assert.equal(opened.ok, true);
  const portId = opened.data.portId;
  const captureId = opened.data.captureId;
  assert.ok(captureId.endsWith('.slog') === false);

  // device speaks: 40 lines, one of them a timeout
  for (let i = 0; i < 20; i++) service.feed(portId, Buffer.from('boot step ' + i + '\n'));
  service.feed(portId, Buffer.from('i2c timeout on addr 0x48\n'));
  for (let i = 0; i < 19; i++) service.feed(portId, Buffer.from('after ' + i + '\n'));
  await new Promise((r) => setTimeout(r, 60));

  const t1 = await byName.serial_tail.execute({ portId, maxLines: 20 });
  assert.equal(t1.ok, true);
  assert.equal(t1.data.lines.length, 20);
  assert.equal(t1.data.lines[0].text, 'boot step 0');

  const t2 = await byName.serial_tail.execute({ portId, cursor: t1.data.cursor, maxLines: 100 });
  assert.equal(t2.ok, true);
  assert.ok(t2.data.lines.length >= 20);
  assert.ok(t2.data.lines.some((l) => l.text.includes('i2c timeout')));

  const t3 = await byName.serial_tail.execute({ portId, cursor: t2.data.cursor });
  assert.equal(t3.data.lines.length, 0);

  const sent = await byName.serial_send.execute({ portId, text: 'AT+RESET', append: 'crlf' });
  assert.equal(sent.ok, true);
  assert.equal(sent.data.bytes, 10);
  const t4 = await byName.serial_tail.execute({ portId, cursor: t2.data.cursor });
  assert.ok(t4.data.lines.some((l) => l.dir === 'tx' && l.text.includes('AT+RESET')));

  const closed = await byName.serial_close.execute({ portId });
  assert.equal(closed.ok, true);
  assert.ok(closed.data.lines >= 41);

  const caps = await byName.serial_captures.execute({ keyword: 'timeout' });
  assert.equal(caps.ok, true);
  assert.equal(caps.data.captures.length, 1);
  const row = caps.data.captures[0];
  assert.equal(row.project, 'C028_FW');
  assert.ok(row.digest.includes('timeout'));

  const hits = await byName.serial_grep.execute({ captureId: row.id, pattern: 'timeout' });
  assert.equal(hits.ok, true);
  assert.equal(hits.data.count, 1);
  assert.equal(hits.data.hits[0].line, 21);

  const exp = await byName.serial_export.execute({ captureId: row.id, format: 'text', timestamps: true });
  assert.equal(exp.ok, true);
  const body = await readFile(exp.data.path, 'utf8');
  assert.ok(/\[\d\d:\d\d:\d\d\.\d\d\d\] boot step 0/.test(body));
  assert.ok(body.includes('i2c timeout on addr 0x48'));
});

test('e2e: errors are structured and actionable', async (t) => {
  const { byName, service } = await boot();
  t.after(() => service.dispose());
  const missing = await byName.serial_tail.execute({ portId: 999 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_PORT_NOT_FOUND');
  assert.ok(missing.error.hint.length > 10);

  // Model opens take over by default (SPEC 23.5): the second call succeeds and
  // the first holder is closed cleanly instead of failing with E_PORT_BUSY.
  const opened = await byName.serial_open.execute({ port: 'MOCK:CM4' });
  const again = await byName.serial_open.execute({ port: 'MOCK:CM4' });
  assert.equal(again.ok, true);
  assert.notEqual(again.data.portId, opened.data.portId);
  assert.equal(service.status(opened.data.portId).state, 'closed');

  const badExport = await byName.serial_export.execute({ captureId: 'nope' });
  assert.equal(badExport.ok, false);
  assert.equal(badExport.error.code, 'E_NO_SUCH_CAPTURE');
  assert.ok(badExport.error.hint.includes('serial_captures'));

  await byName.serial_close.execute({ portId: again.data.portId });
  await service.close(again.data.portId).catch(() => {});
});

test('replay: a recorded capture feeds a mock port at speed', async (t) => {
  const { store, service, byName } = await boot();
  const opened = await byName.serial_open.execute({ port: 'MOCK:CM4', baudRate: 921600, project: 'P', conversation: 'src' });
  for (let i = 0; i < 5; i++) service.feed(opened.data.portId, Buffer.from('frame ' + i + '\n'));
  await new Promise((r) => setTimeout(r, 50));
  const closed = await byName.serial_close.execute({ portId: opened.data.portId });

  const { service: s2 } = await boot();
  t.after(() => s2.dispose());
  const res = await replayCapture({ service: s2, path: closed.data.path, speed: 50, portName: 'MOCK:REPLAY' });
  assert.equal(res.records, 5);
  const tail = await s2.tail({ portId: res.portId, maxLines: 10 });
  assert.deepEqual(tail.lines.map((l) => l.text), ['frame 0', 'frame 1', 'frame 2', 'frame 3', 'frame 4']);
});
