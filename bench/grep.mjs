/**
 * Standalone grep timing: node bench/grep.mjs <MB>
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { KIND } from '../src/codec.mjs';

const MB = Number(process.argv[2] || 100);
const root = await mkdtemp(join(tmpdir(), 'grep-'));
const store = await Store.open({ root });
const cap = await store.openCapture({ project: 'bench', conversation: 'grep', port: 'COM1', baud: 3000000 });
const chunk = Buffer.alloc(64 * 1024, 0x41);
chunk[chunk.length - 1] = 10;
chunk.write('needle-here', 0);
const n = Math.round((MB * 1024 * 1024) / chunk.length);
for (let i = 0; i < n; i++) cap.writer.append({ kind: KIND.RX, bytes: chunk, tMonoUs: i, tWallMs: Date.now() });
await store.closeCapture(cap.captureId);
const { size } = await stat(cap.path);

const t0 = Date.now();
const hits = await store.grep(cap.captureId, 'needle-here', { maxHits: 5 });
const ms = Date.now() - t0;
console.log(JSON.stringify({ fileMB: +(size / 1048576).toFixed(1), hits: hits.length, ms, mbPerSec: +((size / 1048576) / (ms / 1000)).toFixed(1) }));
store.db.close();
await rm(root, { recursive: true, force: true });
