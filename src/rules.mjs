/**
 * Scan runner (v0.2).
 *
 * A scan script lives in the workspace, not inside the plugin: the agent writes
 * it with ordinary file tools, the user reviews it, git versions it. The plugin
 * only reads the file, runs it against a capture's byte stream, and collects
 * marks. No registry, no lifecycle, no naming rules.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SerialError } from './errors.mjs';

export const DEFAULT_TIMEOUT_MS = 20000;
const MAX_MARKS = 5000;
const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-child.cjs');
const SCRIPT_EXT = new Set(['.mjs', '.js', '.cjs']);

export class ScanRunner {
  constructor({ nodePath, roots } = {}) {
    this.nodePath = nodePath || process.execPath;
    // A scan script is agent-written: keep it inside the workspace unless the
    // caller explicitly widened the roots in settings.
    this.roots = (roots && roots.length ? roots : [process.cwd()]).map((r) => resolve(r));
  }

  /** Read and validate a script path. Returns { path, source, label }. */
  async load(scriptPath) {
    if (!scriptPath) {
      throw new SerialError('E_INVALID_ARGS', 'script path is required', {
        hint: 'Pass the path of a scan script (.mjs) that lives in the workspace.',
        fix: ['write the script first, then serial_scan({captureId, script})'],
      });
    }
    const full = resolve(String(scriptPath));
    if (!SCRIPT_EXT.has(extname(full).toLowerCase())) {
      throw new SerialError('E_INVALID_ARGS', 'scan script must be .mjs or .js: ' + full, {
        hint: 'Scan scripts are plain ES modules exporting createScanner(ctx).',
        fix: ['rename the file to .mjs'],
      });
    }
    const inside = this.roots.some((root) => full === root || full.startsWith(root.endsWith(sep) ? root : root + sep));
    if (!inside) {
      throw new SerialError('E_SCRIPT_OUTSIDE_WORKSPACE', 'scan script is outside the workspace: ' + full, {
        hint: 'Scripts are agent-written code; they must live under the workspace root (' + this.roots.join(', ') + ').',
        fix: ['move the script into the workspace', 'or add its folder to settings.scanRoots'],
      });
    }
    let info;
    try {
      info = await stat(full);
    } catch {
      throw new SerialError('E_NO_SUCH_SCRIPT', 'no scan script at ' + full, {
        hint: 'Write the script first with the normal file tools.',
        fix: ['create the file', 'retry serial_scan'],
      });
    }
    if (!info.isFile()) {
      throw new SerialError('E_NO_SUCH_SCRIPT', 'not a file: ' + full, { hint: 'Pass a file path, not a directory.', fix: ['fix the path'] });
    }
    if (info.size > 1 << 20) {
      throw new SerialError('E_INVALID_ARGS', 'scan script is larger than 1 MB', { hint: 'A scan script should be a few hundred lines at most.', fix: ['split the logic'] });
    }
    const source = await readFile(full, 'utf8');
    return { path: full, source, label: basename(full, extname(full)) };
  }

  /** Start a run: push records, then finish() to get the marks. */
  async start({ source, ctx = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
    const child = spawn(this.nodePath, [
      '--permission',
      '--allow-fs-read=' + CHILD,
      '--experimental-vm-modules',
      '--max-old-space-size=512',
      '--no-warnings',
      CHILD,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const marks = [];
    let stderr = '';
    let failure = '';
    let timedOut = false;
    let overLimit = false;
    let buffer = '';

    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1000, timeoutMs));
    let aborted = false;
    const onAbort = () => { aborted = true; child.kill(); };
    if (signal) {
      if (signal.aborted) { aborted = true; child.kill(); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finished = new Promise((res, rej) => {
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'mark') {
            if (marks.length >= MAX_MARKS) { overLimit = true; continue; }
            marks.push(msg.mark);
          } else if (msg.type === 'error') {
            failure = msg.message;
          }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (aborted) {
          return rej(new SerialError('E_SCAN_CANCELLED', 'scan cancelled by the caller', {
            hint: 'The tool call was aborted; nothing was written.',
            fix: ['serial_scan again if you still need it'],
            retryable: true,
          }));
        }
        if (timedOut) {
          return rej(new SerialError('E_SCAN_TIMEOUT', 'scan exceeded ' + timeoutMs + 'ms and was killed', {
            hint: 'The script is stuck in a loop or scanning a huge buffer. Raise timeoutMs or fix the loop.',
            fix: ['retry with a larger timeoutMs', 'inspect the script for an unbounded loop'],
            retryable: true,
          }));
        }
        if (code !== 0) {
          return rej(new SerialError('E_SCAN_FAILED', 'scan script failed: ' + (failure || stderr.trim().slice(0, 400) || 'exit ' + code), {
            hint: 'The script threw or is invalid. The message above is the sandbox stderr.',
            fix: ['fix the script', 'retry serial_scan'],
          }));
        }
        res({ marks, truncated: overLimit, timeoutMs });
      });
      child.on('error', (err) => { clearTimeout(timer); rej(err); });
    });

    const write = (obj) => new Promise((res, rej) => {
      const line = JSON.stringify(obj) + '\n';
      if (child.stdin.write(line)) return res();
      child.stdin.once('drain', res);
      child.stdin.once('error', rej);
    });

    await write({ type: 'script', source, ctx });
    if (failure) throw new SerialError('E_SCAN_FAILED', 'scan script failed to load: ' + failure, { hint: 'Check the module syntax and that it exports createScanner.', fix: ['fix the script'] });

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

/** Stable id so re-scanning with the same script is idempotent. */
export function markId(label, dir, offset, text) {
  return 'mk-' + createHash('sha1').update(String(label) + '|' + dir + '|' + offset + '|' + String(text || '').slice(0, 32)).digest('hex').slice(0, 10);
}

/** Fill defaults and reject marks that would break the reference-only contract. */
export function normalizeMark(raw, label) {
  if (!raw || typeof raw !== 'object') return null;
  const anchor = raw.anchor || {};
  const dir = anchor.dir === 'tx' ? 'tx' : 'rx';
  const offset = Number(anchor.offset);
  const length = Number(anchor.length);
  if (!Number.isFinite(offset) || offset < 0) return null;
  const text = String(raw.label || raw.title || '').slice(0, 300) || '(no label)';
  return {
    id: raw.id || markId(label, dir, offset, text),
    rule: label,
    anchor: { dir, offset, length: Number.isFinite(length) && length > 0 ? Math.min(length, 1 << 20) : 0 },
    t: Number.isFinite(Number(raw.t)) ? Number(raw.t) : 0,
    kind: ['fault', 'state', 'note'].includes(raw.kind) ? raw.kind : 'fault',
    severity: ['error', 'warn', 'info'].includes(raw.severity) ? raw.severity : 'warn',
    label: text,
    code: raw.code && typeof raw.code === 'object'
      ? { file: String(raw.code.file || ''), symbol: String(raw.code.symbol || '') }
      : undefined,
    hypothesis: raw.hypothesis ? String(raw.hypothesis).slice(0, 600) : undefined,
    next: Array.isArray(raw.next) ? raw.next.slice(0, 8).map((n) => ({ label: String((n && n.label) || '').slice(0, 200), expect: n && n.expect ? String(n.expect).slice(0, 200) : undefined })) : undefined,
    extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : undefined,
  };
}
