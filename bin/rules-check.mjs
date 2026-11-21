/**
 * End-to-end check for the scan pipeline.
 *
 *   node bin/rules-check.mjs COM8
 *
 * Records a few seconds from a real port, writes a scan script into a temp
 * workspace, scans the capture, then pulls bytes back by reference. Also proves
 * the guards: a script outside the workspace, a missing file, and a runaway loop.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const PORT = process.argv[2] || 'COM8';
const BAUD = Number(process.argv[3] || 115200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
};

const root = await mkdtemp(join(tmpdir(), 'scan-'));
const workspace = join(root, 'ws');
const store = await Store.open({ root: join(root, 'data') });
const service = new SerialService({ store, scanRoots: [workspace] });
await import('node:fs/promises').then((m) => m.mkdir(join(workspace, 'scripts'), { recursive: true }));

const opened = await service.open({ port: PORT, baudRate: BAUD, project: 'scan', conversation: 'e2e' });
await sleep(3000);
const closed = await service.close(opened.portId);
record('capture recorded', closed.bytesRx > 0, closed.bytesRx + ' rx bytes');

const SCRIPT = String.raw`
export function createScanner() {
  let buf = Buffer.alloc(0)
  let start = 0
  return {
    record(rec) {
      if (rec.dir !== 'rx') return []
      if (buf.length === 0) start = rec.offset
      buf = Buffer.concat([buf, rec.data])
      const marks = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) break
        const text = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '')
        const m = /^HB\s+(\d+)\s+(\d+)$/.exec(text)
        if (m && Number(m[1]) % 2 === 0) {
          marks.push({
            anchor: { dir: 'rx', offset: start, length: nl + 1 },
            t: rec.t, kind: 'state', severity: 'info',
            label: 'HB ' + m[1],
            code: { file: 'C:/proj/fw/src/heartbeat.c', symbol: 'hb_tick' },
          })
        }
        buf = buf.subarray(nl + 1)
        start += nl + 1
      }
      return marks
    },
    finish() { return [] },
  }
}
`;

const scriptPath = join(workspace, 'scripts', 'hb.mjs');
await writeFile(scriptPath, SCRIPT, 'utf8');

const scanned = await service.scan(closed.captureId, { script: scriptPath });
record('scan ran', scanned.marks > 0, 'marks=' + scanned.marks + ' bytes=' + scanned.scannedBytes);
record('script stays in workspace', scanned.script === scriptPath, scanned.script);

const found = await service.marks(closed.captureId, {});
record('marks readable', found.count > 0, 'count=' + found.count);
const first = found.marks[0];
record('mark carries byte ref', !!first && typeof first.anchor.offset === 'number', first ? first.anchor.dir + '@' + first.anchor.offset + '+' + first.anchor.length : 'none');
record('mark has no text', !!first && !('text' in first), Object.keys(first || {}).join(','));
record('window present', !!first && !!first.window && first.window.length > 0, first ? first.window.offset + '+' + first.window.length : 'none');
record('source recorded for re-run', (found.sources[0] || {}).script === scriptPath, (found.sources[0] || {}).script);

const bytes = await service.bytes(closed.captureId, { dir: first.anchor.dir, offset: first.anchor.offset, length: first.anchor.length, format: 'text' });
record('bytes by reference', /HB\s+\d+/.test(bytes.body), JSON.stringify(bytes.body.slice(0, 30)));

const outside = join(root, 'outside.mjs');
await writeFile(outside, SCRIPT, 'utf8');
let outsideErr = null;
try { await service.scan(closed.captureId, { script: outside }); } catch (e) { outsideErr = e; }
record('outside script refused', !!outsideErr && outsideErr.code === 'E_SCRIPT_OUTSIDE_WORKSPACE', outsideErr && outsideErr.code);

let missingErr = null;
try { await service.scan(closed.captureId, { script: join(workspace, 'nope.mjs') }); } catch (e) { missingErr = e; }
record('missing script reported', !!missingErr && missingErr.code === 'E_NO_SUCH_SCRIPT', missingErr && missingErr.code);

const loopPath = join(workspace, 'scripts', 'loop.mjs');
await writeFile(loopPath, 'export function createScanner(){ return { record(){ for(;;){} } } }', 'utf8');
let timeoutErr = null;
try { await service.scan(closed.captureId, { script: loopPath, timeoutMs: 1200 }); } catch (e) { timeoutErr = e; }
record('runaway script killed', !!timeoutErr && timeoutErr.code === 'E_SCAN_TIMEOUT', timeoutErr && timeoutErr.code);

const pass = results.filter((r) => r.ok).length;
console.log('\nsummary: ' + pass + '/' + results.length + ' passed');

await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(pass === results.length ? 0 : 1);
