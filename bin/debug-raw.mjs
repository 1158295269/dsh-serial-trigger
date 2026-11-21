import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SerialService } from '../src/service.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = await Store.open({ root: await mkdtemp(join(tmpdir(), 'dbg-')) });
const service = new SerialService({ store });
const { portId } = await service.open({ port: 'COM8', baudRate: 115200, project: 'dbg', conversation: 'raw' });

let cursor = 0;
async function drain(label, ms) {
  const deadline = Date.now() + ms;
  const lines = [];
  while (Date.now() < deadline) {
    const res = await service.tail({ portId, cursor, maxLines: 500, lineEnding: 'lf' });
    cursor = res.cursor;
    for (const l of res.lines) lines.push(l.text);
    await sleep(60);
  }
  console.log('--- ' + label + ' (' + lines.length + ' lines) ---');
  for (const l of lines.slice(0, 12)) console.log('   ' + JSON.stringify(l));
  return lines;
}

await drain('idle 800ms', 800);
await service.send(portId, Buffer.from('PING\r\n'));
await drain('after PING', 900);
await service.send(portId, Buffer.from('BURST 10\r\n'));
await drain('after BURST 10', 2500);
await service.send(portId, Buffer.from('BURST\r\n'));
await drain('after bare BURST', 1500);

await service.close(portId);
await service.dispose();
store.db.close();
await rm(join(tmpdir(), ''), { recursive: false, force: true }).catch(() => {});
