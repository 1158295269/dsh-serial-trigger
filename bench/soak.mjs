/**
 * Soak: push a serial stream at a fixed rate through hub -> recorder and report
 * whether a single byte was lost, plus memory drift.
 *
 *   node bench/soak.mjs <MB/s> <seconds>
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const rateMB = Number(process.argv[2] || 5);
const seconds = Number(process.argv[3] || 20);
const BATCH = 16 * 1024;
const batchIntervalMs = (BATCH / (rateMB * 1024 * 1024)) * 1000;

const root = await mkdtemp(join(tmpdir(), 'soak-'));
const store = await Store.open({ root });
const service = new SerialService({ store });
const { portId } = await service.open({ port: 'MOCK:SOAK', baudRate: 3000000, project: 'soak', conversation: 'soak' });

const payload = Buffer.alloc(BATCH, 0x41);
payload[payload.length - 1] = 10; // one newline per batch keeps the line path hot

const t0 = Date.now();
let sent = 0;
const rss0 = process.memoryUsage().rss;
let peak = rss0;

// Windows timer granularity is ~15ms, so a 3ms interval silently runs at 1MB/s.
// Catch up to the target count on every tick instead of trusting the interval.
let sentBatches = 0;
const timer = setInterval(() => {
  const target = Math.floor(((Date.now() - t0) / 1000) * rateMB * 1048576 / BATCH);
  while (sentBatches < target) {
    service.feed(portId, payload);
    sentBatches++;
    sent += payload.length;
  }
  const rss = process.memoryUsage().rss;
  if (rss > peak) peak = rss;
  if (Date.now() - t0 >= seconds * 1000) {
    clearInterval(timer);
    finish();
  }
}, 8);

async function finish() {
  const elapsed = (Date.now() - t0) / 1000;
  const rec = service.ports.get(portId);
  const received = rec.bytesRx;
  const closed = await service.close(portId);
  const { size } = await stat(closed.path);
  const rows = store.listCaptures({ project: 'soak' });
  const overhead = 64 + Math.round(sent / BATCH) * 24;

  console.log(JSON.stringify({
    targetMBps: rateMB,
    seconds: Number(elapsed.toFixed(1)),
    sentMB: +(sent / 1048576).toFixed(1),
    receivedMB: +(received / 1048576).toFixed(1),
    lostBytes: rec.bytesRx === sent ? 0 : sent - rec.bytesRx,
    fileMB: +(size / 1048576).toFixed(1),
    fileMatchesExpected: size === sent + overhead,
    lines: closed.lines,
    rssStartMB: Math.round(rss0 / 1048576),
    rssPeakMB: Math.round(peak / 1048576),
    rssEndMB: Math.round(process.memoryUsage().rss / 1048576),
    indexedRows: rows.length,
  }, null, 2));

  await service.dispose();
  store.db.close();
  await rm(root, { recursive: true, force: true });
  process.exit(rec.bytesRx === sent ? 0 : 1);
}
