/**
 * Shell acceptance: does OUR serial pipeline preserve bytes?
 *
 * Deliberately says nothing about what the device is saying. The firmware only
 * has to keep emitting bytes; every assertion below is about the plugin:
 *
 *   A. the recorder is a tap, not a subscriber - bytes are written even when
 *      nobody is reading the stream
 *   B. the bytes on disk are byte-identical to the bytes on the wire (sha256)
 *   C. the cursor never rewinds and the seq never has a hole
 *   D. a write actually reaches the device (seen by searching the echo)
 *   E. open/close cycles do not leak handles or leave half-written captures
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';
import { SlogReader, KIND } from '../src/codec.mjs';

const PORT = process.argv[2] || 'COM8';
const BAUD = Number(process.argv[3] || 115200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, status, detail) {
  results.push({ name, status });
  console.log((status === 'pass' ? 'PASS  ' : status === 'skip' ? 'SKIP  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

const root = await mkdtemp(join(tmpdir(), 'shell-'));
const store = await Store.open({ root });
const service = new SerialService({ store });
const hash = (chunks) => { const h = createHash('sha256'); for (const c of chunks) h.update(c); return h.digest('hex').slice(0, 16); };

async function fileRxBytes(path) {
  const reader = await SlogReader.open(path);
  const parts = [];
  const sum = await reader.scan((rec) => { if (rec.kind === KIND.RX) parts.push(Buffer.from(rec.bytes)); });
  return { parts, bytes: parts.reduce((n, p) => n + p.length, 0), truncated: sum.truncated };
}

// ---- A: recorder works with zero subscribers ----
const a = await service.open({ port: PORT, baudRate: BAUD, project: 'shell', conversation: 'taps' });
await sleep(3000);                       // nobody calls tail on purpose
const aClosed = await service.close(a.portId);
const aFile = await fileRxBytes(aClosed.path);
record('A recorder is subscriber-independent', aFile.bytes > 0 ? 'pass' : 'fail', aFile.bytes + ' rx bytes with no reader');

// ---- B + C: stream bytes vs file bytes, seq continuity ----
const b = await service.open({ port: PORT, baudRate: BAUD, project: 'shell', conversation: 'fidelity' });
await sleep(3000);
const batches = service.hub.backlog(b.portId, 0, 8 << 20);
let hole = 0;
let expected = batches.length ? batches[0].seq : 0;
for (const batch of batches) {
  if (batch.seq !== expected) hole += 1;
  expected = batch.seq + batch.bytes.length;
}
const streamRx = batches.filter((x) => x.dir === 0).map((x) => x.bytes);
const bClosed = await service.close(b.portId);
const bFile = await fileRxBytes(bClosed.path);

const sameBytes = Buffer.concat(streamRx).length === bFile.bytes && hash(streamRx) === hash(bFile.parts);
record('B stream == file (sha256)', sameBytes ? 'pass' : 'fail', hash(streamRx) + ' vs ' + hash(bFile.parts) + ' / ' + Buffer.concat(streamRx).length + 'B');
record('C seq has no holes', hole === 0 ? 'pass' : 'fail', hole + ' hole(s) in ' + batches.length + ' batches');
record('C capture not truncated', bFile.truncated ? 'fail' : 'pass', String(bFile.truncated));

// ---- D: a write reaches the wire ----
const d = await service.open({ port: PORT, baudRate: BAUD, project: 'shell', conversation: 'tx' });
const marker = 'SHELLTX' + Date.now().toString(36);
await service.send(d.portId, Buffer.from(marker + '\r\n'));
await sleep(1200);
const seen = service.hub.backlog(d.portId, 0, 8 << 20).filter((x) => x.dir === 0).map((x) => Buffer.from(x.bytes).toString('latin1')).join('');
const dClosed = await service.close(d.portId);
record('D write reaches the device', seen.includes(marker) ? 'pass' : 'fail', seen.includes(marker) ? 'echoed ' + marker : 'marker never came back');

// ---- E: open/close cycles ----
const baseline = process._getActiveHandles().length;
for (let i = 0; i < 8; i += 1) {
  const c = await service.open({ port: PORT, baudRate: BAUD, project: 'shell', conversation: 'cycle' + i });
  await sleep(120);
  await service.close(c.portId);
}
const after = process._getActiveHandles().length;
record('E handle count stable', after <= baseline + 4 ? 'pass' : 'fail', baseline + ' -> ' + after);
const rows = store.listCaptures({ project: 'shell' });
record('E every capture indexed', rows.length === 8 + 3 ? 'pass' : 'fail', rows.length + ' rows');

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
console.log('\nsummary: ' + pass + ' passed, ' + (results.length - pass - fail) + ' skipped, ' + fail + ' failed');

await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
