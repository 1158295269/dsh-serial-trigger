import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const PORT = process.argv[2] || 'COM8';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  ' + d : '')); };

const SCENARIO = {
  name: 'hw-smoke',
  initial: 'idle',
  states: {
    idle: { on: { 'line:/^HB /': { goto: 'beating', mark: '心跳开始' } } },
    beating: {
      on: {
        'event:probe': { send: 'PING\r\n', expect: 'line:/ECHO PING/', waitMs: 2000, goto: 'probed', else: 'probe_failed', mark: '回显确认' },
      },
      after: { ms: 6000, goto: 'idle', mark: '心跳停' },
    },
    probed: { on: {} },
    probe_failed: { on: {} },
  },
};

const root = await mkdtemp(join(tmpdir(), 'fsmhw-'));
const store = await Store.open({ root });
const service = new SerialService({ store, scanRoots: [root] });
const owner = { kind: 'agent', id: 'hw' };

const opened = await service.open({ port: PORT, baudRate: 115200, owner, project: 'fsm', conversation: 'live' });
const start = await service.fsmStart({ scenario: SCENARIO, portId: opened.portId, owner });
rec('machine started', start.status.state === 'idle', 'runId=' + start.runId);

const beat = await service.fsmWait(start.runId, { timeoutMs: 6000 });
rec('heartbeat moves idle -> beating', beat.status.state === 'beating', JSON.stringify(beat.status.trace.slice(-1)));

const fired = await service.fsmEvent(start.runId, 'probe');
const after = await service.fsmWait(start.runId, { timeoutMs: 4000 });
rec('send waits for the echoed line', after.status.state === 'probed', 'state=' + after.status.state);

const stopped = await service.fsmStop(start.runId);
rec('stop flushes marks', stopped.persisted >= 0, 'marks=' + stopped.marks);

const closed = await service.close(opened.portId);
const sim = await service.fsmSimulate(closed.captureId, { scenario: { name: 'sim', initial: 'a', states: { a: { on: { 'line:/^HB /': { goto: 'b', mark: 'x' } } }, b: { on: {} } } } });
rec('simulate replays the recording', sim.state === 'b', 'trace=' + sim.trace.length + ' marks=' + sim.marks.length);

const ok = results.filter(Boolean).length;
console.log('\nsummary: ' + ok + '/' + results.length);
await service.dispose();
store.db.close();
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(ok === results.length ? 0 : 1);
