/**
 * Rule engine (v0.2).
 *
 * Rules are agent-authored JavaScript. They never touch the capture format:
 * the host decodes the .slog and feeds timestamped byte records, and the rule
 * answers with byte-range marks. Execution happens in a child process with the
 * permission model on, because node:vm alone is not a security boundary.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SerialError } from './errors.mjs';

export const DEFAULT_TIMEOUT_MS = 20000;
const MAX_MARKS = 5000;

const FLAGS = [
  '--permission',              // no filesystem grants at all
  '--experimental-vm-modules', // real ESM parsing inside the sandbox
  '--max-old-space-size=512',
  '--no-warnings',
];

/**
 * Child bootstrap. Reads JSONL from stdin, evaluates the rule module inside a
 * vm context that exposes nothing but Buffer and a silent console, then emits
 * marks as JSONL on stdout.
 */
const BOOTSTRAP = String.raw`
const vm = require('node:vm');
const readline = require('node:readline');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const fail = (message) => { out({ type: 'error', message: String(message) }); process.exit(2); };

const sandboxConsole = { log() {}, error() {}, warn() {}, info() {} };
const context = vm.createContext({ Buffer, console: sandboxConsole });

let scanner = null;
const queue = [];
let draining = false;

async function handle(msg) {
  if (msg.type === 'rule') {
    const mod = new vm.SourceTextModule(msg.source, { context, identifier: 'rule.mjs' });
    await mod.link(() => { throw new Error('rules may not import modules'); });
    await mod.evaluate();
    const factory = mod.namespace.createScanner;
    if (typeof factory !== 'function') throw new Error('rule must export createScanner(ctx)');
    scanner = factory(msg.ctx || {});
    if (!scanner || typeof scanner.record !== 'function') throw new Error('createScanner must return { record }');
    return;
  }
  if (msg.type === 'record') {
    const data = Buffer.from(msg.rec.data, 'base64');
    const marks = scanner.record({ t: msg.rec.t, monoUs: msg.rec.monoUs, dir: msg.rec.dir, offset: msg.rec.offset, data });
    if (marks) for (const mark of marks) out({ type: 'mark', mark });
    return;
  }
  if (msg.type === 'end') {
    if (scanner && typeof scanner.finish === 'function') {
      const marks = scanner.finish();
      if (marks) for (const mark of marks) out({ type: 'mark', mark });
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
  } finally { draining = false; }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  queue.push(msg);
  pump();
});
`;

export class RuleEngine {
  constructor({ rulesRoot, nodePath } = {}) {
    this.rulesRoot = rulesRoot;
    this.nodePath = nodePath || process.execPath;
  }

  ruleDir(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(name || ''))) {
      throw new SerialError('E_INVALID_ARGS', 'rule name must match [a-z0-9._-], got ' + JSON.stringify(name), {
        hint: 'Use a short ascii name such as frame-length-mismatch.',
        fix: ['retry with a valid name'],
      });
    }
    return join(this.rulesRoot, name);
  }

  async install({ name, source, meta = {} }) {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new SerialError('E_INVALID_ARGS', 'rule source is empty', { hint: 'Pass the JavaScript module as source.', fix: ['serial_rules_add({name, source})'] });
    }
    const dir = this.ruleDir(name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'rule.mjs');
    await writeFile(file, source, 'utf8');
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ name, ...meta, updatedAt: Date.now() }, null, 2), 'utf8');
    return { name, path: file };
  }

  async list() {
    let names = [];
    try { names = await readdir(this.rulesRoot); } catch { names = []; }
    const out = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(await readFile(join(this.rulesRoot, name, 'meta.json'), 'utf8'));
        out.push({ name, ...meta, path: join(this.rulesRoot, name, 'rule.mjs') });
      } catch { /* not a rule directory */ }
    }
    return out;
  }

  async read(name) {
    const file = join(this.ruleDir(name), 'rule.mjs');
    try {
      return await readFile(file, 'utf8');
    } catch {
      throw new SerialError('E_NO_SUCH_RULE', 'no rule named ' + name, { hint: 'Call serial_rules_list() to see installed rules.', fix: ['serial_rules_list()'] });
    }
  }

  async remove(name) {
    await rm(this.ruleDir(name), { recursive: true, force: true });
    return { name, removed: true };
  }

  /**
   * Start a run. push() feeds one record, finish() closes stdin and resolves
   * with the collected marks.
   */
  async start({ source, ctx = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const child = spawn(this.nodePath, [...FLAGS, '-e', BOOTSTRAP], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const marks = [];
    let stderr = '';
    let parseError = '';
    let timedOut = false;
    let overLimit = false;
    let buffer = '';

    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1000, timeoutMs));

    const finished = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { parseError = line.slice(0, 200); continue; }
          if (msg.type === 'mark') {
            if (marks.length >= MAX_MARKS) { overLimit = true; continue; }
            marks.push(msg.mark);
          } else if (msg.type === 'error') {
            parseError = msg.message;
          }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return reject(new SerialError('E_RULE_TIMEOUT', 'rule exceeded ' + timeoutMs + 'ms and was killed', {
            hint: 'The rule is stuck in a loop or scanning a huge buffer. Raise timeoutMs or fix the loop.',
            fix: ['retry with a larger timeoutMs', 'inspect the rule for an unbounded loop'],
            retryable: true,
          }));
        }
        if (code !== 0) {
          return reject(new SerialError('E_RULE_FAILED', 'rule exited with code ' + code + ': ' + (parseError || stderr.trim().slice(0, 400) || 'no output'), {
            hint: 'The rule threw or is invalid. The message above is the child stderr.',
            fix: ['fix the rule source', 'serial_rules_add again', 'retry'],
          }));
        }
        resolve({ marks, truncated: overLimit, timeoutMs });
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    const write = (obj) => new Promise((resolve, reject) => {
      const line = JSON.stringify(obj) + '\n';
      if (child.stdin.write(line)) return resolve();
      child.stdin.once('drain', resolve);
      child.stdin.once('error', reject);
    });

    await write({ type: 'rule', source, ctx });
    if (parseError) throw new SerialError('E_RULE_FAILED', 'rule failed to load: ' + parseError, { hint: 'Check the module syntax and that it exports createScanner.', fix: ['fix the rule source'] });

    return {
      async push(rec) {
        await write({ type: 'record', rec: { t: rec.t, monoUs: rec.monoUs, dir: rec.dir, offset: rec.offset, data: Buffer.from(rec.data).toString('base64') } });
      },
      async finish() {
        await write({ type: 'end' });
        child.stdin.end();
        return finished;
      },
      kill() { try { child.kill(); } catch { /* already gone */ } },
    };
  }
}

/** Stable id so re-running a rule is idempotent. */
export function markId(rule, dir, offset, label) {
  return 'mk-' + createHash('sha1').update(String(rule) + '|' + dir + '|' + offset + '|' + String(label || '').slice(0, 32)).digest('hex').slice(0, 10);
}

/** Fill defaults and reject marks that would break the read-only contract. */
export function normalizeMark(raw, rule) {
  if (!raw || typeof raw !== 'object') return null;
  const anchor = raw.anchor || {};
  const dir = anchor.dir === 'tx' ? 'tx' : 'rx';
  const offset = Number(anchor.offset);
  const length = Number(anchor.length);
  if (!Number.isFinite(offset) || offset < 0) return null;
  const label = String(raw.label || raw.title || '').slice(0, 300) || '(no label)';
  return {
    id: raw.id || markId(rule, dir, offset, label),
    rule,
    anchor: { dir, offset, length: Number.isFinite(length) && length > 0 ? Math.min(length, 1 << 20) : 0 },
    t: Number.isFinite(Number(raw.t)) ? Number(raw.t) : 0,
    kind: ['fault', 'state', 'note'].includes(raw.kind) ? raw.kind : 'fault',
    severity: ['error', 'warn', 'info'].includes(raw.severity) ? raw.severity : 'warn',
    label,
    code: raw.code && typeof raw.code === 'object'
      ? { file: String(raw.code.file || ''), symbol: String(raw.code.symbol || '') }
      : undefined,
    hypothesis: raw.hypothesis ? String(raw.hypothesis).slice(0, 600) : undefined,
    next: Array.isArray(raw.next) ? raw.next.slice(0, 8).map((n) => ({ label: String((n && n.label) || '').slice(0, 200), expect: n && n.expect ? String(n.expect).slice(0, 200) : undefined })) : undefined,
    extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : undefined,
  };
}
