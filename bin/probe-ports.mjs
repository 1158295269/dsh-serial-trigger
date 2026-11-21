/**
 * Listen on every serial port for a few seconds and report what is talking.
 *
 *   node bin/probe-ports.mjs [baud] [seconds]
 *
 * Use this right after flashing the test firmware: whichever port prints
 * READY / HB lines is the one to hand to hw-check.
 */
import { createSerialBackend } from '../src/serial-backend.mjs';

const baud = Number(process.argv[2] || 115200);
const seconds = Number(process.argv[3] || 3);
const backend = createSerialBackend();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ports = await backend.list();
console.log('ports:', ports.map((p) => p.path).join(', '), '| baud', baud);

for (const p of ports) {
  const seen = [];
  let handle = null;
  try {
    handle = await backend.open({ path: p.path, baudRate: baud, onData: (c) => seen.push(Buffer.from(c)) });
  } catch (err) {
    console.log(p.path.padEnd(8), 'open failed:', err.code || err.message);
    continue;
  }
  await sleep(seconds * 1000);
  await handle.close();
  const bytes = Buffer.concat(seen);
  const text = bytes.subarray(0, 160).toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  console.log(p.path.padEnd(8), String(bytes.length).padStart(6), 'bytes', JSON.stringify(text));
}
