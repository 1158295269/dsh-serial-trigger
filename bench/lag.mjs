/**
 * Measure how long each heavy operation blocks the event loop.
 *
 *   node bench/lag.mjs [megabytes]
 *
 * The host is a single-threaded Node process: anything that does not yield
 * freezes every other conversation. This prints the worst stall per operation.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlogWriter } from '../src/codec.mjs';
import { Store } from '../src/store.mjs';

const MB = Number(process.argv[2] || 50);
const dir = await mkdtemp(join(tmpdir(), 'lag-'));
const store = await Store.open({ root: dir });

// build a capture of roughly MB megabytes
const cap = await store.openCapture({ project: 'lag', conversation: 'bench', port: 'COM1', baud: 115200 });
const line = 'i2c timeout addr=0x48 state=0x03 retry=2\r\n';
const chunk = Buffer.from(line.repeat(200));
const target = MB * 1024 * 1024;
let written = 0;
let t = Date.now();
while (written < target) {
  cap.writer.append({ kind: 0, bytes: chunk, tMonoUs: written * 10, tWallMs: Date.now() });
  written += chunk.length;
}
await store.closeCapture(cap.captureId);
console.log('capture:', (written / 1048576).toFixed(1), 'MB, built in', Date.now() - t, 'ms');

async function measure(label, fn) {
  const samples = [];
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    samples.push(now - last - 10);
    last = now;
  }, 10);
  last = performance.now();
  const started = Date.now();
  const result = await fn();
  const took = Date.now() - started;
  clearInterval(tick);
  const max = Math.max(0, ...samples);
  const blocked = samples.filter((x) => x > 100).length;
  console.log(label.padEnd(22), String(took).padStart(6) + ' ms', '| max stall', max.toFixed(0).padStart(6) + ' ms', '| stalls >100ms:', blocked, typeof result === 'number' ? '| n=' + result : '');
}

await measure('grep', async () => (await store.grep(cap.captureId, 'timeout', { maxHits: 50 })).length);
await measure('readCaptureLines 20k', async () => (await store.readCaptureLines(cap.captureId, { maxLines: 20000 })).lines.length);
await measure('export text', async () => { const r = await store.exportCapture(cap.captureId, { format: 'text', timestamps: true, out: join(dir, 'out.txt') }); return r.lines; });
await measure('scanCapture (feed)', async () => { let n = 0; await store.scanCapture(cap.captureId, (rec) => { n++; }); return n; });

store.db.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});
