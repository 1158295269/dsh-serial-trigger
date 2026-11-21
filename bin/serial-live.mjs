/**
 * Live open/close check against a real serial port.
 *
 *   node bin/serial-live.mjs COM1 [baud]
 *
 * Verifies: driver opens, state transitions closed->open->draining->closed,
 * capture file exists and the index row is written. Then it tries a bogus port
 * to prove the error mapping.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { SerialError } from '../src/errors.mjs';

const portName = process.argv[2] || 'COM1';
const baudRate = Number(process.argv[3] || 115200);
const root = await mkdtemp(join(tmpdir(), 'live-'));
const store = await Store.open({ root });
const service = new SerialService({ store });
const out = { port: portName, baudRate, steps: [] };

try {
  const available = await service.discoverPorts();
  out.steps.push({ step: 'discover', ports: available.map((p) => p.port) });

  const opened = await service.open({ port: portName, baudRate, project: 'live', conversation: 'open-close' });
  out.steps.push({ step: 'open', portId: opened.portId, captureId: opened.captureId, kind: opened.kind });

  await new Promise((r) => setTimeout(r, 300));
  out.steps.push({ step: 'status', status: service.status(opened.portId) });

  // while it is open, a second open of the same port must fail with E_PORT_BUSY
  // (from our own bookkeeping) or the driver's access-denied mapping
  try {
    await service.open({ port: portName, baudRate, project: 'live', conversation: 'double' });
    out.steps.push({ step: 'double-open', result: 'UNEXPECTEDLY OPENED' });
  } catch (err) {
    out.steps.push({ step: 'double-open', code: err.code, retryable: err.retryable });
  }

  const closed = await service.close(opened.portId);
  const info = await stat(closed.path);
  out.steps.push({ step: 'close', bytes: closed.bytesRx, fileBytes: info.size, path: closed.path });

  const rows = store.listCaptures({ project: 'live' });
  out.steps.push({ step: 'index', rows: rows.length, clean: rows[0] && rows[0].clean_close });
} catch (err) {
  out.error = { code: err.code || 'E_UNKNOWN', message: err.message, hint: err.hint };
}

// error mapping check
try {
  await service.open({ port: 'COM99', baudRate: 9600, project: 'live', conversation: 'bogus' });
  out.bogus = { unexpected: 'opened COM99' };
} catch (err) {
  out.bogus = { code: err.code, retryable: err.retryable, message: err.message };
}

console.log(JSON.stringify(out, null, 2));
await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true });
