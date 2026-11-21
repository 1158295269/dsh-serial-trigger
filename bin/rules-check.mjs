/**
 * End-to-end check for the v0.2 rule pipeline.
 *
 *   node bin/rules-check.mjs COM8
 *
 * Records a few seconds from a real port, installs two rules, rescans the
 * capture, then pulls bytes back by reference. Also proves the two failure
 * paths: syntax errors and runaway rules.
 */
import { mkdtemp, rm } from 'node:fs/promises';
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

const root = await mkdtemp(join(tmpdir(), 'rules-'));
const store = await Store.open({ root });
const service = new SerialService({ store, rulesRoot: join(root, 'rules') });

// ---- record a capture from the real port ----
const opened = await service.open({ port: PORT, baudRate: BAUD, project: 'rules', conversation: 'scan' });
await sleep(3000);
const closed = await service.close(opened.portId);
record('capture recorded', closed.bytesRx > 0, closed.bytesRx + ' rx bytes');

const HB_RULE = String.raw`
export function createScanner(ctx) {
  let buf = Buffer.alloc(0)
  let bufStart = 0
  return {
    record(rec) {
      if (rec.dir !== 'rx') return []
      if (buf.length === 0) bufStart = rec.offset
      buf = Buffer.concat([buf, rec.data])
      const marks = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) break
        const text = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '')
        const m = /^HB\s+(\d+)\s+(\d+)$/.exec(text)
        if (m && Number(m[1]) % 2 === 0) {
          marks.push({
            anchor: { dir: 'rx', offset: bufStart, length: nl + 1 },
            t: rec.t, kind: 'state', severity: 'info',
            label: 'HB seq=' + m[1],
            code: { file: 'C:/proj/fw/src/heartbeat.c', symbol: 'hb_tick' },
          })
        }
        buf = buf.subarray(nl + 1)
        bufStart += nl + 1
      }
      return marks
    },
    finish() { return [] },
  }
}
`;

const GAP_RULE = String.raw`
export function createScanner() {
  let buf = Buffer.alloc(0)
  let bufStart = 0
  let last = null
  return {
    record(rec) {
      if (rec.dir !== 'rx') return []
      if (buf.length === 0) bufStart = rec.offset
      buf = Buffer.concat([buf, rec.data])
      const marks = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) break
        const text = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '')
        const m = /^HB\s+(\d+)\s+/.exec(text)
        if (m) {
          const seq = Number(m[1])
          if (last !== null && seq !== last + 1) {
            marks.push({
              anchor: { dir: 'rx', offset: bufStart, length: nl + 1 },
              t: rec.t, kind: 'fault', severity: 'error',
              label: 'HB 断号 ' + last + ' -> ' + seq,
              hypothesis: '心跳丢失，设备可能卡住',
              next: [{ label: '若断号后仍有输出 → 只是调度延迟' }],
            })
          }
          last = seq
        }
        buf = buf.subarray(nl + 1)
        bufStart += nl + 1
      }
      return marks
    },
    finish() { return [] },
  }
}
`;

await service.rulesAdd({ name: 'hb-milestone', source: HB_RULE, meta: { description: '每 10 个心跳打一个点' } });
await service.rulesAdd({ name: 'hb-gap', source: GAP_RULE, meta: { description: '心跳断号' } });
const list = await service.rulesList();
record('rules installed', list.rules.length === 2, list.rules.map((r) => r.name).join(','));

const applied = await service.rulesApply(closed.captureId, {});
record('rescan ran', applied.results.length === 2, JSON.stringify(applied.results.map((r) => r.rule + ':' + r.marks)));
record('milestone marks', (applied.results.find((r) => r.rule === 'hb-milestone') || {}).marks > 0, 'marks=' + (applied.results.find((r) => r.rule === 'hb-milestone') || {}).marks);

const marks = await service.marks(closed.captureId, {});
record('marks readable', marks.count > 0, 'count=' + marks.count);
const first = marks.marks[0];
record('mark carries byte ref', !!first && !!first.anchor && typeof first.anchor.offset === 'number', first ? first.anchor.dir + '@' + first.anchor.offset + '+' + first.anchor.length : 'none');
record('mark has no line field', !first || !('line' in (first.code || {})), JSON.stringify(first && first.code));
record('window present', !!first && !!first.window && first.window.length > 0, first ? first.window.offset + '+' + first.window.length : 'none');

if (!first) { console.log('no marks: skipping byte checks'); process.exit(1); }
const bytes = await service.bytes(closed.captureId, { dir: first.anchor.dir, offset: first.anchor.offset, length: first.anchor.length, format: 'text' });
record('bytes by reference', /HB\s+\d+/.test(bytes.body), JSON.stringify(bytes.body.slice(0, 40)));
const hex = await service.bytes(closed.captureId, { dir: first.anchor.dir, offset: first.anchor.offset, length: 16, format: 'hex' });
record('hex view works', /^[0-9a-f]{8}  /.test(hex.body), hex.body.split('\n')[0]);


// ---- failure paths ----
let syntaxErr = null;
try {
  await service.rulesAdd({ name: 'broken', source: 'export function createScanner( {' });
  await service.rulesApply(closed.captureId, { rules: ['broken'] });
} catch (e) { syntaxErr = e; }
const syntaxResult = syntaxErr ? null : (await service.rulesApply(closed.captureId, { rules: ['broken'] })).results[0];
record('syntax error is reported', !!(syntaxErr || (syntaxResult && syntaxResult.error)), String((syntaxErr && syntaxErr.code) || (syntaxResult && syntaxResult.error && syntaxResult.error.code)));

await service.rulesAdd({ name: 'runaway', source: 'export function createScanner(){ return { record(){ for(;;){} } } }' });
const timeoutResult = (await service.rulesApply(closed.captureId, { rules: ['runaway'], timeoutMs: 1200 })).results[0];
record('runaway rule is killed', !!timeoutResult.error && timeoutResult.error.code === 'E_RULE_TIMEOUT', JSON.stringify(timeoutResult.error && timeoutResult.error.code));

const pass = results.filter((r) => r.ok).length;
console.log('\nsummary: ' + pass + '/' + results.length + ' passed');

await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(pass === results.length ? 0 : 1);
