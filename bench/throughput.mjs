import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { SlogWriter, SlogReader, KIND } from '../src/codec.mjs';

const TOTAL_MB = Number(process.argv[2] || 200);
const RECORD = 16 * 1024;
const count = Math.max(1, Math.round((TOTAL_MB * 1024 * 1024) / RECORD));

function mb(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }
function rss() { return (process.memoryUsage().rss / (1024 * 1024)).toFixed(0); }

const dir = await mkdtemp(join(tmpdir(), 'slog-bench-'));
const path = join(dir, 'bench.slog');
const payloads = [];
for (let i = 0; i < count; i++) payloads.push(randomBytes(RECORD));
const expected = createHash('sha256');
for (const p of payloads) expected.update(p);
const expectedHash = expected.digest('hex');

console.log('records=' + count + ' payload=' + mb(count * RECORD) + 'MB rss0=' + rss() + 'MB');

const w = await SlogWriter.create(path, { port: 'COM3', baud: 3000000, createdAt: Date.now() });
let t0 = process.hrtime.bigint();
for (let i = 0; i < count; i++) {
  w.append({ kind: i % 3 === 0 ? KIND.TX : KIND.RX, bytes: payloads[i], tMonoUs: i * 8000, tWallMs: Date.now() });
}
await w.close();
let ms = Number(process.hrtime.bigint() - t0) / 1e6;
const size = (await stat(path)).size;
console.log('WRITE  ' + mb(size) + 'MB in ' + ms.toFixed(0) + 'ms  => ' + (size / 1048576 / (ms / 1000)).toFixed(1) + ' MB/s  rss=' + rss() + 'MB');

const r = await SlogReader.open(path);
const got = createHash('sha256');
let records = 0;
t0 = process.hrtime.bigint();
const sum = await r.scan(function (rec) { got.update(rec.bytes); records++; });
ms = Number(process.hrtime.bigint() - t0) / 1e6;
const hashOk = got.digest('hex') === expectedHash;
console.log('READ   ' + mb(size) + 'MB in ' + ms.toFixed(0) + 'ms  => ' + (size / 1048576 / (ms / 1000)).toFixed(1) + ' MB/s  records=' + records);
console.log('VERIFY hash=' + (hashOk ? 'OK' : 'MISMATCH') + ' truncated=' + sum.truncated + ' rx=' + mb(sum.rxBytes) + 'MB tx=' + mb(sum.txBytes) + 'MB');
console.log('rssFinal=' + rss() + 'MB');

await rm(dir, { recursive: true, force: true });
process.exit(hashOk && records === count ? 0 : 1);
