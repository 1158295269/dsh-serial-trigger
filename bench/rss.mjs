/**
 * Does closing a big capture leave memory behind?
 * Run with: node --expose-gc bench/rss.mjs <MB>
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const MB = Number(process.argv[2] || 100);
const root = await mkdtemp(join(tmpdir(), 'rss-'));
const store = await Store.open({ root });
const service = new SerialService({ store });
const { portId } = await service.open({ port: 'MOCK:RSS', baudRate: 3000000, project: 'rss', conversation: 'rss' });

const mb = (n) => Math.round(n / 1048576);
const rssNow = () => process.memoryUsage().rss;
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };

const batch = Buffer.alloc(16 * 1024, 0x42);
batch[batch.length - 1] = 10;
const batches = Math.round((MB * 1024 * 1024) / batch.length);
const paced = process.argv[3] === 'paced';

gc();
const before = rssNow();
let sinceFlush = 0;
for (let i = 0; i < batches; i++) {
  service.feed(portId, batch);
  sinceFlush += batch.length;
  if (paced && sinceFlush >= 8 * 1024 * 1024) {
    await service.flush(portId);
    sinceFlush = 0;
  }
}
const fed = rssNow();
const closed = await service.close(portId);
const afterClose = rssNow();
gc();
const afterGc = rssNow();
gc();
const afterGc2 = rssNow();
const { size } = await stat(closed.path);
const row = store.listCaptures({}).find((r) => r.id === closed.captureId);

console.log(JSON.stringify({
  captureMB: MB,
  fileMB: +(size / 1048576).toFixed(1),
  lines: row && row.lines,
  rssMB: { before: mb(before), afterFeed: mb(fed), afterClose: mb(afterClose), afterGc: mb(afterGc), afterGc2: mb(afterGc2) },
  retainedAfterGcMB: mb(afterGc2 - before),
}, null, 2));

await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true });
