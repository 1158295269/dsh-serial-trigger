/**
 * Sandbox child: reads JSONL commands on stdin, runs the agent's scan script
 * inside a vm context, and streams marks back on stdout.
 *
 * Started with --permission --allow-fs-read=<this file> only, so it can load
 * itself and nothing else. The script source arrives over stdin.
 */
const vm = require('node:vm');
const readline = require('node:readline');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const fail = (message) => { out({ type: 'error', message: String(message) }); process.exit(2); };

const context = vm.createContext({
  Buffer,
  console: { log() {}, error() {}, warn() {}, info() {} },
});

let scanner = null;
const queue = [];
let draining = false;

async function handle(msg) {
  if (msg.type === 'script') {
    const mod = new vm.SourceTextModule(msg.source, { context, identifier: 'scan.mjs' });
    await mod.link(() => { throw new Error('scan scripts may not import modules'); });
    await mod.evaluate();
    const factory = mod.namespace.createScanner;
    if (typeof factory !== 'function') throw new Error('script must export createScanner(ctx)');
    scanner = factory(msg.ctx || {});
    if (!scanner || typeof scanner.record !== 'function') throw new Error('createScanner must return { record }');
    return;
  }
  if (msg.type === 'record') {
    const data = Buffer.from(msg.rec.data, 'base64');
    const marks = scanner.record({
      t: msg.rec.t, monoUs: msg.rec.monoUs, dir: msg.rec.dir, offset: msg.rec.offset, data,
    });
    // A scanner may return one mark or an array; iterating a plain object used
    // to throw "marks is not iterable" and fail the whole scan.
    if (marks) for (const mark of Array.isArray(marks) ? marks : [marks]) out({ type: 'mark', mark });
    return;
  }
  if (msg.type === 'end') {
    if (scanner && typeof scanner.finish === 'function') {
      const marks = scanner.finish();
      if (marks) for (const mark of Array.isArray(marks) ? marks : [marks]) out({ type: 'mark', mark });
    }
    out({ type: 'done' });
    process.exit(0);
  }
}

async function pump() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const msg = queue.shift();
      try { await handle(msg); } catch (err) { fail(err && err.message ? err.message : err); }
    }
  } finally {
    draining = false;
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  queue.push(msg);
  pump();
});
