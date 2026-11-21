import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SlogReader, KIND } from '../src/codec.mjs';
import { LineAssembler } from '../src/lines.mjs';

export async function tmpRoot(prefix = 'sst-') {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/** Decode a .slog into lines, with the wall clock of the batch each line came from. */
export async function readLines(path) {
  const reader = await SlogReader.open(path);
  const la = new LineAssembler();
  const out = [];
  const summary = await reader.scan((rec) => {
    if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return;
    for (const line of la.feed(rec)) out.push({ text: line.text, dir: rec.kind === KIND.TX ? 'tx' : 'rx', tWallMs: line.tWallMs });
  });
  out.push(...la.flush(Date.now()).map((line) => ({ text: line.text, dir: 'rx', tWallMs: line.tWallMs })));
  return { lines: out, summary };
}

/** Inject N text lines into an open port, one batch per line unless batched=true. */
export function feedLines(service, portId, lines, { batched = false, dir = 0 } = {}) {
  if (batched) {
    service.feed(portId, Buffer.from(lines.join('\n') + '\n'), dir);
    return;
  }
  for (const line of lines) service.feed(portId, Buffer.from(line + '\n'), dir);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until predicate() is true, polling until timeout. */
export async function waitFor(predicate, timeoutMs = 2000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}
