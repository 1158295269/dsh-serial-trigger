/**
 * Hardware acceptance run against the test firmware.
 *
 *   node bin/hw-check.mjs --port COM8 [--baud 115200] [--burst 500]
 *
 * Two things this script must get right on its own side:
 *  - the stream carries both directions, so protocol assertions look at rx only
 *  - collect() stops as soon as it matches, otherwise "latency" measures the
 *    polling window instead of the round trip
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const PORT = args.port || 'COM8';
const BAUD = Number(args.baud || 115200);
const BURST = Number(args.burst || 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log((status === 'pass' ? 'PASS  ' : status === 'skip' ? 'SKIP  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

const root = await mkdtemp(join(tmpdir(), 'hw-'));
const store = await Store.open({ root });
const service = new SerialService({ store });

let cursor = 0;
const opened = await service.open({ port: PORT, baudRate: BAUD, project: 'hw', conversation: 'acceptance' });
console.log('opened ' + PORT + ' @ ' + BAUD + '  capture ' + opened.captureId + '\n');

async function collect(ms, matcher, opts = {}) {
  const stopOnMatch = opts.stopOnMatch === true;
  const pollMs = opts.pollMs || 60;
  const deadline = Date.now() + ms;
  const out = [];
  while (Date.now() < deadline) {
    const res = await service.tail({ portId: opened.portId, cursor, maxLines: 5000, lineEnding: 'lf' });
    cursor = res.cursor;
    for (const line of res.lines) {
      if (line.dir !== 'rx') continue; // our own writes are mirrored into the stream
      if (matcher && !matcher(line.text)) continue;
      out.push(line.text);
    }
    if (stopOnMatch && out.length) return out;
    await sleep(pollMs);
  }
  return out;
}

// 1 + 2: banner and heartbeats
const warm = await collect(2500);
const banner = warm.find((t) => t.startsWith('READY'));
const hb = warm.filter((t) => /^HB\s+\d+/.test(t));
record('READY banner', banner ? 'pass' : 'skip', banner || 'board booted before attach');

const hb2 = await collect(3000, (t) => /^HB\s+\d+/.test(t));
const seqs = hb.concat(hb2).map((t) => Number(t.split(/\s+/)[1]));
let contiguous = seqs.length > 1;
for (let i = 1; i < seqs.length; i += 1) if (seqs[i] !== seqs[i - 1] + 1) contiguous = false;
record('HB flowing', seqs.length >= 4 ? 'pass' : 'fail', seqs.length + ' beats');
record('HB contiguous', contiguous ? 'pass' : 'fail', seqs.slice(0, 8).join(','));

// 3: PING / PONG with real round-trip timing
const latencies = [];
for (let i = 0; i < 5; i += 1) {
  const t0 = Date.now();
  await service.send(opened.portId, Buffer.from('PING\r\n'));
  const got = await collect(1500, (t) => t.startsWith('PONG'), { stopOnMatch: true, pollMs: 10 });
  if (got.length) latencies.push(Date.now() - t0);
}
record('PONG x5', latencies.length === 5 ? 'pass' : 'fail',
  latencies.length ? 'avg ' + Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) + 'ms [' + latencies.join(',') + ']' : 'no reply');

// 4: junk must not poison the line buffer (the regression this firmware had)
await service.send(opened.portId, Buffer.from('GARBAGE\r\n'));
const echoed = await collect(1200, (t) => t.startsWith('ECHO'), { stopOnMatch: true });
record('ECHO junk', echoed.length ? 'pass' : 'fail', echoed[0] || 'no echo');
await service.send(opened.portId, Buffer.from('PING\r\n'));
const afterJunk = await collect(1500, (t) => t.startsWith('PONG'), { stopOnMatch: true, pollMs: 10 });
record('PING after junk', afterJunk.length ? 'pass' : 'fail', afterJunk[0] || 'no reply');

// 5: burst
await service.send(opened.portId, Buffer.from('BURST ' + BURST + '\r\n'));
const bursts = await collect(8000, (t) => /^B\s*\d+\b/.test(t));
const idx = bursts.map((t) => Number((t.match(/^B\s*(\d+)/) || [])[1]));
let ordered = idx.length > 1;
for (let i = 1; i < idx.length; i += 1) if (idx[i] !== idx[i - 1] + 1) ordered = false;
record('BURST lines', idx.length === BURST ? 'pass' : 'fail', idx.length + '/' + BURST);
record('BURST ordered', ordered ? 'pass' : 'fail', idx.length ? idx[0] + '..' + idx[idx.length - 1] : 'n/a');

// 6: capture integrity
const closed = await service.close(opened.portId);
const info = await stat(closed.path);
record('capture written', info.size > 64 ? 'pass' : 'fail', info.size + ' bytes');

// the file itself must contain the burst, not just the right byte count
const stored = await store.grep(closed.captureId, '^B\\d+ ', { maxHits: 10000 });
record('capture contains burst', stored.length === BURST ? 'pass' : 'fail', stored.length + '/' + BURST + ' lines in .slog');
record('bytes accounted', closed.bytesRx > 0 ? 'pass' : 'fail', closed.bytesRx + ' rx / ' + closed.bytesTx + ' tx');

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
console.log('\nsummary: ' + pass + ' passed, ' + (results.length - pass - fail) + ' skipped, ' + fail + ' failed');

await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
