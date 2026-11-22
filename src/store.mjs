/**
 * Capture store: one .slog per (conversation, port, baud) session, plus a SQLite
 * index so "which file was that?" is one query instead of a directory walk.
 *
 * Layout:
 *   <root>/index.db
 *   <root>/<project>/<conversation>-<port>-<baud>-<YYYYMMDD-HHMMSS>.slog
 *
 * The index is disposable: if it is deleted, recover() rebuilds rows by walking
 * the tree. Files are the source of truth.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, stat, unlink, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { SlogWriter, SlogReader, KIND } from './codec.mjs';
import { LineAssembler } from './lines.mjs';
import { SerialError } from './errors.mjs';
import { ioPath } from './paths.mjs';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeName(raw, maxWidth = 32) {
  let s = String(raw ?? '').trim().replace(ILLEGAL, '-').replace(/\s+/g, ' ');
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = 'untitled';
  if (RESERVED.test(s)) s = '_' + s;
  // truncate by display width: CJK counts as 2 columns
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    if (w + cw > maxWidth) break;
    w += cw;
    out += ch;
  }
  return out || 'untitled';
}

export function stampFilename(now = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return (
    now.getFullYear() +
    p(now.getMonth() + 1) +
    p(now.getDate()) +
    '-' +
    p(now.getHours()) +
    p(now.getMinutes()) +
    p(now.getSeconds())
  );
}

export function projectKey(workspacePath, workspaceName) {
  const slug = sanitizeName(workspaceName || 'project', 40);
  if (!workspacePath) return slug;
  return slug;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS captures (',
  '  id TEXT PRIMARY KEY, project TEXT NOT NULL, conversation TEXT, session_id TEXT,',
  '  path TEXT NOT NULL, port TEXT, baud INTEGER,',
  '  started_ms INTEGER, ended_ms INTEGER,',
  '  bytes_rx INTEGER, bytes_tx INTEGER, lines INTEGER, triggers INTEGER,',
  '  clean_close INTEGER, truncated INTEGER, missing INTEGER DEFAULT 0,',
  '  digest TEXT, tags TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS ix_project_time ON captures(project, started_ms);',
].join('\n');

export class Store {
  constructor(opts) {
    this.root = opts.root;
    this.dbPath = opts.dbPath || join(opts.root, 'index.db');
    this.db = null;
    this.writers = new Map();
    this.cleanupPlans = new Map();
  }

  static async open(opts) {
    const store = new Store(opts);
    await mkdir(ioPath(store.root), { recursive: true });
    store.db = new DatabaseSync(ioPath(store.dbPath));
    store.db.exec(SCHEMA);
    return store;
  }

  /** Project folder for a workspace; adds a 4-char hash only when a name collides. */
  async projectDir(workspacePath, workspaceName) {
    const base = projectKey(workspacePath, workspaceName);
    const root = this.root;
    const direct = join(root, base);
    if (!existsSync(direct)) return direct;
    const marker = join(direct, '.project.json');
    if (existsSync(marker)) {
      try {
        const meta = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(marker, 'utf8')));
        if (!workspacePath || meta.path === workspacePath) return direct;
      } catch {
        /* fall through to hashed dir */
      }
    } else {
      return direct;
    }
    const hash = createHash('sha1').update(String(workspacePath)).digest('hex').slice(0, 4);
    const hashed = join(root, base + '-' + hash);
    await mkdir(hashed, { recursive: true });
    return hashed;
  }

  async openCapture(opts) {
    const { conversation, sessionId = '', port, baud } = opts;
    // A project name arrives from a tool argument: never let it walk out of the root.
    const project = sanitizeName(opts.project || 'default', 40);
    const dir = join(this.root, project);
    await mkdir(ioPath(dir), { recursive: true });

    // Naming rule: <port>-<timestamp>. Conversations are not part of the name: the
    // host does not expose a stable title, and copying files is the agreed isolation.
    const base = [sanitizeName(port, 16), stampFilename()].join('-');
    // Two captures in the same minute, or the same port name under two projects,
    // would otherwise share a filename-and-id. Uniqueness has to hold for both the
    // file on disk and the index row, so check each candidate against both.
    let path = join(dir, base + '.slog');
    let id = base;
    for (let i = 2; existsSync(path) || this.db.prepare('SELECT 1 FROM captures WHERE id = ?').get(id); i += 1) {
      id = base + '-' + i;
      path = join(dir, id + '.slog');
    }

    const now = Date.now();
    const writer = await SlogWriter.create(path, { port, baud, createdAt: now });
    this.writers.set(id, { writer, path, project, conversation, sessionId, port, baud, started: now });
    this.db
      .prepare(
        'INSERT OR REPLACE INTO captures (id, project, conversation, session_id, path, port, baud, started_ms, clean_close, missing) VALUES (?,?,?,?,?,?,?,?,?,0)'
      )
      .run(id, project, conversation || '', sessionId, path, port || '', baud || 0, now, 0);

    return { captureId: id, path, writer };
  }

  /** Close a capture: flush, compute digest, update the index row. */
  async closeCapture(captureId, extra = {}) {
    const entry = this.writers.get(captureId);
    if (!entry) {
      const row = this.db.prepare('SELECT path, ended_ms, digest FROM captures WHERE id = ?').get(captureId);
      if (row && row.ended_ms) {
        return { captureId, path: row.path, already: true, digest: JSON.parse(row.digest || '{}'), stats: {} };
      }
      throw new SerialError('E_NO_SUCH_CAPTURE', 'no open capture with id ' + captureId, {
        hint: 'It was never opened, or it was already closed and has no index row. serial_captures() lists what exists.',
        fix: ['serial_captures()'],
      });
    }
    const stats = await entry.writer.close();
    this.writers.delete(captureId);
    const digest = await digestOf(entry.path);
    const ended = Date.now();
    this.db
      .prepare(
        'UPDATE captures SET ended_ms=?, bytes_rx=?, bytes_tx=?, lines=?, triggers=?, clean_close=?, truncated=?, digest=? WHERE id=?'
      )
      .run(
        ended,
        stats.bytes,
        extra.txBytes ?? 0,
        digest.lines,
        digest.errorsTotal,
        extra.cleanClose === false ? 0 : 1,
        digest.truncated ? 1 : 0,
        JSON.stringify(digest.summary),
        captureId
      );
    return { captureId, path: entry.path, digest, stats };
  }

  listCaptures(opts = {}) {
    const where = [];
    const args = [];
    if (opts.project) { where.push('project = ?'); args.push(opts.project); }
    if (opts.since) { where.push('started_ms >= ?'); args.push(opts.since); }
    if (opts.until) { where.push('started_ms <= ?'); args.push(opts.until); }
    if (opts.keyword) { where.push('(digest LIKE ? OR conversation LIKE ? OR port LIKE ?)'); const k = '%' + opts.keyword + '%'; args.push(k, k, k); }
    if (!opts.includeMissing) where.push('missing = 0');
    const sql =
      'SELECT id, project, conversation, port, baud, path, started_ms, ended_ms, bytes_rx, lines, truncated, missing, digest FROM captures' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY started_ms DESC LIMIT ' + (opts.limit || 20);
    return this.db.prepare(sql).all(...args);
  }

  /** Line-level search inside one capture. Returns hits with wall time and line no. */
  async grep(captureId, pattern, opts = {}) {
    const row = this.db.prepare('SELECT path FROM captures WHERE id = ?').get(captureId);
    if (!row) throw new SerialError('E_NO_SUCH_CAPTURE', 'no capture with id ' + captureId, { hint: 'Call serial_captures() first; the id must come from that list.', fix: ['serial_captures({keyword})'] });
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, opts.flags || 'i');
    const reader = await SlogReader.open(row.path);
    const la = new LineAssembler({ encoding: opts.encoding || 'utf-8' });
    const hits = [];
    const context = opts.context ?? 2;
    const ring = [];
    let lineNo = 0;
    const max = opts.maxHits || 50;
    await reader.scan((rec) => {
      if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return;
      for (const line of la.feed(rec)) {
        lineNo++;
        if (re.test(line.text)) {
          hits.push({
            line: lineNo, seq: line.seq, tWallMs: line.tWallMs, dir: rec.kind === KIND.RX ? 'rx' : 'tx',
            text: line.text.slice(0, 400),
            before: (context > 0 ? ring.slice(-context) : []).map((r) => ({ line: r.line, text: r.text.slice(0, 200) })),
          });
        }
        ring.push({ line: lineNo, text: line.text });
        if (ring.length > 32) ring.shift();
        if (hits.length >= max) return false;   // enough: stop reading
      }
      return undefined;
    });
    return hits;
  }

  /** Export a capture. Formats: text | hex | csv | jsonl. Streams to disk, never buffers the file. */
  async exportCapture(captureId, opts = {}) {
    const row = this.db.prepare('SELECT path FROM captures WHERE id = ?').get(captureId);
    if (!row) throw new SerialError('E_NO_SUCH_CAPTURE', 'no capture with id ' + captureId, { hint: 'Call serial_captures() first.', fix: ['serial_captures({keyword})'] });
    const format = ['text', 'hex', 'csv', 'jsonl'].includes(opts.format) ? opts.format : 'text';
    const timestamps = opts.timestamps !== false;
    const encoding = opts.encoding || 'utf-8';
    const ext = format === 'csv' ? '.csv' : format === 'jsonl' ? '.jsonl' : '.txt';
    const outPath = opts.out || row.path.replace(/\.slog$/, '') + (format === 'text' ? '' : '-' + format) + ext;

    const reader = await SlogReader.open(row.path);
    const la = new LineAssembler({ encoding, lineEnding: 'any' });
    const decoder = new TextDecoder(encoding, { fatal: false });
    const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 23);
    const csvCell = (v) => '"' + String(v).replace(/"/g, '""') + '"';

    const stream = createWriteStream(ioPath(outPath), { encoding: 'utf8' });
    // A write stream reports open/write failures asynchronously: race every write
    // against the error event so a bad path cannot look like a success.
    const failed = new Promise((_, reject) => stream.on('error', reject));
    failed.catch(() => {});
    let bytes = 0;
    let lines = 0;
    const emit = (text) => {
      bytes += Buffer.byteLength(text, 'utf8');
      lines += 1;
      const written = new Promise((resolve) => {
        if (stream.write(text)) return resolve();
        stream.once('drain', resolve);
      });
      return Promise.race([written, failed]);
    };
    const fail = (err) => {
      try { stream.destroy(); } catch { /* gone */ }
      if (err instanceof SerialError) return err;
      return new SerialError('E_CAPTURE_IO', 'cannot write export to ' + outPath + ': ' + (err && err.message), {
        hint: 'The target folder is read-only, on a disconnected drive, or blocked by another process.',
        fix: ['choose another out path', 'check folder permissions', 'retry'],
        retryable: true,
      });
    };

    try {
      if (format === 'csv') await emit('time_iso,mono_us,dir,kind,text,hex\n');

      await reader.scan(async (rec) => {
        if (format === 'hex') {
          const b = rec.bytes;
          for (let i = 0; i < b.length; i += 16) {
            const slice = b.subarray(i, i + 16);
            const hex = [...slice].map((x) => x.toString(16).padStart(2, '0')).join(' ');
            const ascii = [...slice].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
            await emit((rec.offset + i).toString(16).padStart(8, '0') + '  ' + hex.padEnd(47) + '  |' + ascii + '|\n');
          }
          return undefined;
        }

        const dir = rec.kind === KIND.RX ? 'rx' : rec.kind === KIND.TX ? 'tx' : 'ev';
        const text = format === 'text' ? null : decoder.decode(rec.bytes);

        if (format === 'jsonl') {
          await emit(JSON.stringify({
            t: new Date(rec.tWallMs).toISOString(), mono_us: rec.tMonoUs, dir, kind: rec.kind,
            hex: Buffer.from(rec.bytes).toString('hex'), text,
          }) + '\n');
          return undefined;
        }

        if (format === 'csv') {
          await emit([new Date(rec.tWallMs).toISOString(), rec.tMonoUs, dir, rec.kind, csvCell(text.replace(/\r?\n/g, '\\n')), Buffer.from(rec.bytes).toString('hex')].join(',') + '\n');
          return undefined;
        }

        if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return undefined;
        let n = 0;
        for (const line of la.feed(rec)) {
          const prefix = timestamps ? '[' + hhmmss(line.tWallMs) + '] ' : '';
          await emit(prefix + (rec.kind === KIND.TX ? '>> ' : '') + line.text + '\n');
          n += 1;
          if ((n & 1023) === 0) await new Promise((r) => setImmediate(r));
        }
        return undefined;
      });

      await Promise.race([new Promise((resolve) => stream.end(resolve)), failed]);
    } catch (err) {
      throw fail(err);
    }

    return { path: outPath, format, bytes, lines };
  }

  /**
   * Two-phase cleanup (SPEC §11): a dry run produces a plan, applying it deletes
   * exactly those captures. Deleting is irreversible, so the plan is explicit.
   */
  async planCleanup({ olderThanDays = 0, keepLast = 0, project } = {}) {
    const rows = this.listCaptures({ project, limit: 100000 });
    // listCaptures returns SQL columns (started_ms / bytes_rx). Reading camelCase
    // here used to make olderThanDays match every row — a plan that deletes
    // everything instead of only the old captures.
    const startedOf = (row) => Number(row.started_ms ?? row.startedMs ?? 0);
    const bytesOf = (row) => Number(row.bytes_rx ?? row.bytes ?? 0);
    const cutoff = Number(olderThanDays) > 0 ? Date.now() - Number(olderThanDays) * 86400000 : 0;
    const victims = rows
      .sort((a, b) => startedOf(b) - startedOf(a))
      .filter((row, index) => index >= Number(keepLast || 0))
      .filter((row) => !cutoff || startedOf(row) < cutoff);
    const planId = 'clean-' + createHash('sha1').update(victims.map((v) => v.id).join('|') + Date.now()).digest('hex').slice(0, 10);
    this.cleanupPlans.set(planId, { ids: victims.map((v) => v.id), at: Date.now() });
    return {
      planId,
      dryRun: true,
      count: victims.length,
      bytes: victims.reduce((n, v) => n + bytesOf(v), 0),
      items: victims.slice(0, 50).map((v) => ({ captureId: v.id, project: v.project, bytes: bytesOf(v), startedMs: startedOf(v) })),
      truncated: victims.length > 50,
    };
  }

  async applyCleanup(planId) {
    const plan = this.cleanupPlans.get(planId);
    if (!plan) throw new SerialError('E_NO_SUCH_PLAN', 'no cleanup plan ' + planId, {
      hint: 'Plans are short-lived. Run serial_cleanup({dryRun:true}) again to get a fresh one.',
      fix: ['serial_cleanup({dryRun:true})'],
    });
    const removed = [];
    const failed = [];
    for (const id of plan.ids) {
      try {
        const dir = this.marksDir(id);
        await this.deleteCapture(id);
        await rm(ioPath(dir), { recursive: true, force: true }).catch(() => {});
        removed.push(id);
      } catch (err) {
        failed.push({ captureId: id, error: err.code || err.message });
      }
    }
    this.cleanupPlans.delete(planId);
    return { planId, removed: removed.length, failed, freedIds: removed.slice(0, 50) };
  }

  /** Absolute path of a capture file. */
  capturePath(captureId) {
    const row = this.db.prepare('SELECT path FROM captures WHERE id = ?').get(captureId);
    if (!row) throw new SerialError('E_NO_SUCH_CAPTURE', 'no capture with id ' + captureId, {
      hint: 'Call serial_captures() to list what exists.',
      fix: ['serial_captures()'],
    });
    return row.path;
  }

  /** Walk a capture and yield data records with per-direction byte offsets. */
  async scanCapture(captureId, onRecord, opts = {}) {
    const path = this.capturePath(captureId);
    const wantDirs = opts.dirs || ['rx', 'tx'];
    let offsetRx = 0;
    let offsetTx = 0;
    const reader = await SlogReader.open(path);
    await reader.scan((rec) => {
      if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return undefined;
      const dir = rec.kind === KIND.TX ? 'tx' : 'rx';
      if (!wantDirs.includes(dir)) return undefined;
      const offset = dir === 'rx' ? offsetRx : offsetTx;
      if (dir === 'rx') offsetRx += rec.bytes.length; else offsetTx += rec.bytes.length;
      return onRecord({
        dir, offset, t: rec.tWallMs, monoUs: rec.tMonoUs, data: Buffer.from(rec.bytes), length: rec.bytes.length,
      });
    });
    return { rx: offsetRx, tx: offsetTx };
  }

  /** Pull an exact byte range back out of a capture by reference. */
  async readCaptureBytes(captureId, { dir = 'rx', offset = 0, length = 256 } = {}) {
    const want = Math.max(1, Math.min(Number(length) || 1, 1 << 20));
    const start = Math.max(0, Number(offset) || 0);
    const parts = [];
    let have = 0;
    let actualStart = null;
    await this.scanCapture(captureId, (rec) => {
      if (have >= want) return false;
      const end = rec.offset + rec.length;
      if (end <= start) return undefined;
      if (actualStart === null) actualStart = rec.offset;
      const from = Math.max(0, start - rec.offset);
      const slice = rec.data.subarray(from, from + (want - have));
      parts.push(slice);
      have += slice.length;
      return have >= want ? false : undefined;
    }, { dirs: [dir] });
    return { dir, offset: actualStart === null ? start : actualStart, length: have, data: Buffer.concat(parts), truncated: have >= want };
  }

  /** Coarse (time, offset) timeline used to turn a time window into a byte window. */
  async captureTimeline(captureId) {
    const out = [];
    await this.scanCapture(captureId, (rec) => {
      out.push({ dir: rec.dir, offset: rec.offset, length: rec.length, t: rec.t });
    });
    return out;
  }

  /** Marks live beside the capture, one file per scan. */
  marksDir(captureId) {
    return this.capturePath(captureId).replace(/\.slog$/, '') + '.marks';
  }

  async writeMarks(captureId, label, marks, meta = {}) {
    const dir = this.marksDir(captureId);
    await mkdir(ioPath(dir), { recursive: true });
    const file = join(dir, label + '.jsonl');
    const lines = [JSON.stringify({ type: 'meta', label, ...meta })];
    for (const m of marks) lines.push(JSON.stringify(m));
    const tmp = file + '.tmp';
    await writeFile(ioPath(tmp), lines.join('\n') + '\n', 'utf8');
    await rename(ioPath(tmp), ioPath(file));
    return { file, count: marks.length };
  }

  async readMarks(captureId, { rule, severity } = {}) {
    const dir = this.marksDir(captureId);
    let files = [];
    try { files = await readdir(ioPath(dir)); } catch { return { marks: [], sources: [] }; }
    const marks = [];
    const metas = [];
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const ruleName = name.replace(/\.jsonl$/, '');
      if (rule && ruleName !== rule) continue;
      const body = await readFile(ioPath(join(dir, name)), 'utf8');
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'meta') { metas.push(parsed); continue; }
          if (severity && parsed.severity !== severity) continue;
          marks.push(parsed);
        } catch { /* skip corrupt line */ }
      }
    }
    marks.sort((a, b) => (a.t || 0) - (b.t || 0) || (a.anchor?.offset || 0) - (b.anchor?.offset || 0));
    return { marks, sources: metas };
  }

  /** Decode a capture into lines for read-only viewing. Capped to keep memory sane. */
  async readCaptureLines(captureId, opts = {}) {
    const row = this.db.prepare('SELECT id, path, project, conversation, port, baud, ended_ms, bytes_rx, lines FROM captures WHERE id = ?').get(captureId);
    if (!row) throw new SerialError('E_NO_SUCH_CAPTURE', 'no capture with id ' + captureId, {
      hint: 'Call serial_captures() to list what exists.',
      fix: ['serial_captures()'],
    });
    const maxLines = Math.min(opts.maxLines || 20000, 200000);
    const reader = await SlogReader.open(row.path);
    const la = new LineAssembler({ lineEnding: opts.lineEnding || 'any' });
    const lines = [];
    let truncatedByCap = false;
    let seen = 0;
    await reader.scan(async (rec) => {
      if (lines.length >= maxLines) { truncatedByCap = true; return false; }
      if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return undefined;
      for (const line of la.feed(rec)) {
        if (lines.length >= maxLines) { truncatedByCap = true; break; }
        lines.push({ t: line.tWallMs, seq: line.seq, text: line.text, dir: rec.kind === KIND.TX ? 'tx' : 'rx' });
      }
      // Yield per record: a single 4 KB record holds ~200 lines, so a line-based
      // counter would never fire before the whole cap was reached.
      seen += 1;
      if ((seen & 7) === 0) await new Promise((r) => setImmediate(r));
      return undefined;
    });
    for (const line of la.flush(Date.now())) {
      if (lines.length < maxLines) lines.push({ t: line.tWallMs, seq: line.seq, text: line.text, dir: 'rx' });
    }
    return {
      id: row.id, project: row.project, conversation: row.conversation, port: row.port, baud: row.baud,
      endedMs: row.ended_ms, bytes: row.bytes_rx, path: row.path,
      lines, total: row.lines || lines.length, truncatedByCap,
    };
  }

  /** Remove a capture: file first, then the index row. Idempotent for missing files. */
  async deleteCapture(captureId) {
    const row = this.db.prepare('SELECT path FROM captures WHERE id = ?').get(captureId);
    if (!row) throw new SerialError('E_NO_SUCH_CAPTURE', 'no capture with id ' + captureId, { hint: 'It may already be deleted.', fix: ['serial_captures()'] });
    const { unlink } = await import('node:fs/promises');
    let removed = false;
    try {
      await unlink(ioPath(row.path));
      removed = true;
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        throw new SerialError('E_CAPTURE_IO', 'cannot delete ' + row.path + ': ' + err.message, {
          hint: 'The file may be open in another program.', fix: ['close the program', 'retry'], retryable: true,
        });
      }
    }
    this.db.prepare('DELETE FROM captures WHERE id = ?').run(captureId);
    return { captureId, removed, path: row.path };
  }

  /**
   * D02: a deleted index.db (or a tree copied from another machine) used to make
   * every capture invisible while the files were still there.
   */
  async rebuildIndex() {
    const out = { scanned: 0, inserted: 0 };
    const dir = await import('node:fs/promises');
    let entries = [];
    try {
      entries = await dir.readdir(ioPath(this.root), { recursive: true, withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.slog')) continue;
      out.scanned++;
      const file = join(e.parentPath || e.path || this.root, e.name);
      const id = e.name.replace(/\.slog$/, '');
      const known = this.db.prepare('SELECT id FROM captures WHERE id = ?').get(id);
      if (known) continue;
      try {
        const reader = await SlogReader.open(file);
        const st = await dir.stat(ioPath(file));
        const digest = await digestOf(file);
        this.db
          .prepare(
            'INSERT OR REPLACE INTO captures (id, project, conversation, session_id, path, port, baud, started_ms, ended_ms, bytes_rx, bytes_tx, lines, clean_close, truncated, missing, digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)'
          )
          .run(id, basename(dirname(file)), '', '', file, reader.header.port, reader.header.baud || 0, reader.header.createdAt || st.mtimeMs, st.mtimeMs, 0, 0, digest.lines, 1, 0, JSON.stringify(digest.summary));
        out.inserted++;
      } catch {
        /* unreadable file: leave it out */
      }
    }
    return out;
  }

  /** Rebuild/fix rows: recompute digests, flag deleted files. */
  async recover() {
    const rebuilt = await this.rebuildIndex();
    const rows = this.db.prepare('SELECT id, path, ended_ms FROM captures').all();
    let fixed = 0;
    for (const row of rows) {
      if (!existsSync(row.path)) {
        this.db.prepare('UPDATE captures SET missing = 1 WHERE id = ?').run(row.id);
        fixed++;
        continue;
      }
      if (!row.ended_ms) {
        const digest = await digestOf(row.path);
        this.db.prepare('UPDATE captures SET ended_ms = ?, digest = ?, lines = ? WHERE id = ?').run(
          (await stat(row.path)).mtimeMs,
          JSON.stringify(digest.summary),
          digest.lines,
          row.id
        );
        fixed++;
      }
    }
    return { rows: rows.length, fixed, rebuilt };
  }
}

/** Digest: first/last lines, error histogram, counts. Cheap reverse-lookup bait. */
export async function digestOf(path) {
  const reader = await SlogReader.open(path);
  const la = new LineAssembler();
  const first = [];
  const tail = [];
  const errors = {};
  let lines = 0;
  await reader.scan((rec) => {
    if (rec.kind !== KIND.RX && rec.kind !== KIND.TX) return;
    for (const line of la.feed(rec)) {
      lines++;
      const text = line.text;
      if (first.length < 20) first.push(text.slice(0, 160));
      tail.push(text.slice(0, 160));
      if (tail.length > 20) tail.shift();
      const m = /\b(error|err|fail|failed|timeout|assert|reset|panic|watchdog)\b/i.exec(text);
      if (m) {
        const k = m[1].toLowerCase();
        errors[k] = (errors[k] || 0) + 1;
      }
    }
  });
  return {
    lines,
    truncated: reader.truncated,
    errorsTotal: Object.values(errors).reduce((a, b) => a + b, 0),
    summary: { first, last: tail, errors },
  };
}
