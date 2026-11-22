/**
 * Serial service: owns ports, captures and the tail cursor.
 *
 * A port has exactly one capture writer (one .slog) and one subscriber that
 * pumps batches from the hub into it. Readers (tail / tools / future panel)
 * consume the same hub stream, so what is recorded and what is shown cannot
 * diverge.
 */
import { Hub, TOPIC } from './hub.mjs';
import { LineAssembler } from './lines.mjs';
import { KIND } from './codec.mjs';
import { join, resolve, sep } from 'node:path';

import { SerialError } from './errors.mjs';
import { createSerialBackend } from './serial-backend.mjs';
import { ScanRunner, normalizeMark, DEFAULT_TIMEOUT_MS } from './rules.mjs';
import { Machine, simulate } from './fsm.mjs';
export { SerialError };

let nextPortId = 1;

/** Human-readable owner for error messages. */
export function describeOwner(owner) {
  if (!owner) return 'another caller';
  if (owner.kind === 'session') return 'session ' + owner.id;
  if (owner.kind === 'agent') return 'agent ' + owner.id;
  return String(owner.kind || 'another caller');
}

export class SerialService {
  constructor(opts) {
    this.hub = opts.hub || new Hub(opts.hubOptions || {});
    this.store = opts.store;
    this.backend = opts.backend || createSerialBackend();
    // portId -> who took it over; a replaced port must not silently keep working
    this.replaced = new Map();
    this.fsmRuns = new Map();
    this.fsmSeq = 0;
    // Runtime-tunable settings; cordis config seeds them, serial_config updates them.
    this.settings = {
      idleLeaseMs: opts.idleLeaseMs ?? 30 * 60 * 1000,
      defaultLineEnding: opts.defaultLineEnding || 'any',
      scanRoots: opts.scanRoots || [opts.workspaceRoot || process.cwd()],
      ...(opts.settings || {}),
    };
    this.onSettingsChange = typeof opts.onSettingsChange === 'function' ? opts.onSettingsChange : null;
    this._leaseTimer = null;
    if (this.settings.idleLeaseMs > 0) {
      this._leaseTimer = setInterval(() => { this.reapIdle().catch(() => {}); }, 60000);
      if (typeof this._leaseTimer.unref === 'function') this._leaseTimer.unref();
    }
    // Scan scripts live in the workspace; the plugin keeps no registry.
    this.scanRunner = opts.runner || new ScanRunner({
      nodePath: opts.nodePath,
      roots: opts.scanRoots || [opts.workspaceRoot || process.cwd()],
    });
    this.config = opts.config || {};
    this.ports = new Map();      // portId -> record
    this.byName = new Map();     // name -> portId
    this.cursors = new Map();    // portId -> { seq, assembler, lines }
    this.mockPorts = new Set();
  }

  listPorts() {
    const out = [];
    for (const [id, rec] of this.ports) {
      out.push({ portId: id, port: rec.name, baudRate: rec.baud, state: rec.state, captureId: rec.captureId, path: rec.path, bytesRx: rec.bytesRx, bytesTx: rec.bytesTx, owner: rec.owner, idleForMs: Date.now() - (rec.lastActivity || rec.started || Date.now()) });
    }
    for (const name of this.mockPorts) {
      if (!this.byName.has(name)) out.push({ portId: null, port: name, state: 'available', mock: true });
    }
    return out;
  }

  /** Real ports from the driver, merged with whatever this service holds open. */
  async discoverPorts() {
    let real = [];
    try {
      real = await this.backend.list();
    } catch {
      real = [];
    }
    const openByPath = new Map();
    for (const [, rec] of this.ports) if (rec.state !== 'closed') openByPath.set(String(rec.name).toLowerCase(), rec);

    const out = real.map((p) => {
      const open = openByPath.get(String(p.path).toLowerCase());
      return {
        portId: open ? open.id : null,
        port: p.path,
        friendlyName: p.friendlyName,
        baudRate: open ? open.baud : null,
        state: open ? open.state : 'available',
        captureId: open ? open.captureId : null,
        bytesRx: open ? open.bytesRx : 0,
        bytesTx: open ? open.bytesTx : 0,
        owner: open ? open.owner : null,
        idleForMs: open ? Date.now() - (open.lastActivity || open.started || Date.now()) : 0,
      };
    });
    // Anything we hold open but the driver did not enumerate (mock ports, or a
    // device that vanished) still has to show up.
    const listed = new Set(out.map((p) => String(p.port).toLowerCase()));
    for (const [, rec] of this.ports) {
      if (rec.state === 'closed') continue;
      const key = String(rec.name).toLowerCase();
      if (listed.has(key)) continue;
      listed.add(key);
      out.push({
        portId: rec.id, port: rec.name, friendlyName: rec.kind === 'mock' ? '模拟端口' : '',
        baudRate: rec.baud, state: rec.state, captureId: rec.captureId,
        bytesRx: rec.bytesRx, bytesTx: rec.bytesTx,
        owner: rec.owner, idleForMs: Date.now() - (rec.lastActivity || rec.started || Date.now()),
      });
    }

    for (const name of this.mockPorts) {
      if (listed.has(String(name).toLowerCase())) continue;
      out.push({ portId: null, port: name, friendlyName: '模拟端口', baudRate: null, state: 'available', captureId: null, bytesRx: 0, bytesTx: 0 });
    }
    return out;
  }

  registerMockPort(name) {
    this.mockPorts.add(name);
    return name;
  }

  async open(opts) {
    const { port, baudRate = 115200, project = 'default', conversation = 'session', sessionId = '' } = opts;
    const owner = opts.owner || { kind: 'agent', id: 'unknown' };
    // The model path always takes over (SPEC 23.5): a port is a single-writer
    // resource, and the previous holder must finish its capture cleanly instead
    // of blocking the caller with E_PORT_BUSY.
    const canTakeOver = opts.takeover === true || opts.autoTakeover === true;
    const norm = String(port).toLowerCase();
    let existing = this.byName.get(port);
    if (existing === undefined) {
      // byName may be keyed differently from the caller's spelling, so fall back
      // to a case-insensitive scan; otherwise a second open silently steals the
      // device handle from the first owner.
      for (const [id, r] of this.ports) {
        if (r.state === 'open' && String(r.name).toLowerCase() === norm) { existing = id; break; }
      }
    }
    const held = existing === undefined ? null : this.ports.get(existing);
    if (held && held.state === 'open') {
      if (!canTakeOver) {
        throw new SerialError('E_PORT_BUSY', port + ' is already open by ' + describeOwner(held.owner), {
          hint: 'Another session or agent is using it. Read-only access works through serial_tail on portId ' + existing + '; to seize it, pass takeover:true (their capture is closed cleanly first).',
          fix: ['serial_tail({portId:' + existing + '}) to read only', 'serial_open({port, takeover:true}) to take over'],
          retryable: false,
        });
      }
      await this.close(existing, { force: true, reason: 'takeover' });
      this.replaced.set(existing, { by: owner, at: Date.now(), port });
    }

    const cap = opts.record === false
      ? { captureId: null, path: null, writer: null }
      : await this.store.openCapture({ project, conversation, sessionId, port, baud: baudRate });
    const portId = nextPortId++;
    const rec = {
      id: portId, name: port, baud: baudRate, state: 'open',
      captureId: cap.captureId, path: cap.path, writer: cap.writer,
      bytesRx: 0, bytesTx: 0, lines: 0, started: Date.now(),
      owner, lastActivity: Date.now(),
    };
    this.ports.set(portId, rec);
    this.byName.set(port, portId);
    this.hub.registerPort(portId);
    // One assembler per framing policy: switching modes must not re-use a buffer
    // that was built under different break rules.
    this.cursors.set(portId, { seq: 0, assemblers: new Map(), lines: [] });
    // Lossless recording: the tap writes inline, so a burst can never drop bytes.
    this.hub.setTap(portId, (batch) => this._record(rec, batch));

    const isMock = opts.transport === 'mock' || /^MOCK:/i.test(String(port));
    rec.kind = isMock ? 'mock' : 'serial';
    if (!isMock) {
      try {
        rec.transport = await this.backend.open({
          path: port,
          baudRate,
          friendlyName: opts.friendlyName,
          onData: (chunk) => this.hub.publishData(portId, {
            dir: 0,
            bytes: chunk,
            tMonoUs: Math.round(performance.now() * 1000),
            tWallMs: Date.now(),
          }),
          onError: (err) => {
            rec.state = 'error';
            this.hub.publishStatus(portId, 'open', 'error', String(err && err.message));
          },
        });
      } catch (err) {
        rec.state = 'error';
        this.hub.clearTap(portId);
        if (rec.writer) await this.store.closeCapture(rec.captureId, { cleanClose: false }).catch(() => {});
        throw err;
      }
    }

    this.hub.publishStatus(portId, 'closed', 'open', 'user');
    return { portId, captureId: cap.captureId, path: cap.path, kind: rec.kind };
  }

  /** Inline tap: hub batch -> capture file. Never queued, so it cannot drop. */
  _record(rec, batch) {
    if (!rec.writer) return;
    try {
      rec.writer.append({
        kind: batch.dir === 1 ? KIND.TX : KIND.RX,
        bytes: batch.bytes,
        tMonoUs: batch.tMonoUs,
        tWallMs: batch.tWallMs,
        flags: batch.flags || 0,
      });
      if (batch.dir === 1) rec.bytesTx += batch.bytes.length;
      else rec.bytesRx += batch.bytes.length;
    } catch (err) {
      rec.state = 'error';
      this.hub.publishStatus(rec.id, 'open', 'error', String(err && err.message));
    }
  }

  async close(portId, opts = {}) {
    const rec = this.ports.get(portId);
    const replaced = this.replaced.get(portId);
    if (replaced && opts.reason !== 'takeover') {
      throw new SerialError('E_PORT_REPLACED', 'portId ' + portId + ' was taken over by ' + describeOwner(replaced.by), {
        hint: 'Another caller seized this port (' + replaced.port + '). Your capture was closed cleanly; re-open the port if you still need it.',
        fix: ['serial_ports() to see the new owner', 'serial_open({port:' + replaced.port + '}) to start over'],
        retryable: false,
      });
    }
    if (rec && opts.owner && rec.owner && rec.owner.id !== opts.owner.id && !opts.force) {
      throw new SerialError('E_NOT_OWNER', 'portId ' + portId + ' belongs to ' + describeOwner(rec.owner), {
        hint: 'Only the owner may close it. Read-only access stays available through serial_tail; pass force:true to close anyway.',
        fix: ['serial_tail({portId:' + portId + '}) to read only', 'serial_close({portId, force:true}) to override'],
        retryable: false,
      });
    }
    if (!rec) throw new SerialError('E_PORT_NOT_FOUND', 'no such portId ' + portId, { hint: 'The portId is unknown or already closed. serial_ports() lists what is open right now.', fix: ['serial_ports()', 'serial_open({port})'] });
    if (rec.state === 'closed' || rec.state === 'draining') return { portId, already: true };
    rec.state = 'draining';
    this.hub.publishStatus(portId, 'open', 'draining', 'user');
    // A machine bound to this port would keep polling a dead ring and could
    // still write with force:true, so it must end with the port it drives.
    await this._stopRunsForPort(portId, 'port-closed');
    this.hub.clearTap(portId);
    if (rec.transport) {
      await rec.transport.close().catch(() => {});
      rec.transport = null;
    }
    const cur = this.cursors.get(portId);
    if (cur) {
      for (const a of cur.assemblers.values()) {
        for (const line of a.flush(Date.now())) cur.lines.push(line);
      }
    }
    const closed = rec.writer
      ? await this.store.closeCapture(rec.captureId, { txBytes: rec.bytesTx, cleanClose: true })
      : { digest: { lines: 0 } };
    rec.state = 'closed';
    this.hub.publishStatus(portId, 'draining', 'closed', 'user');
    this.hub.publishCapture({ portId, captureId: rec.captureId, path: rec.path, event: 'closed', bytes: rec.bytesRx + rec.bytesTx });
    return {
      portId,
      captureId: rec.captureId,
      path: rec.path,
      bytesRx: rec.bytesRx,
      bytesTx: rec.bytesTx,
      lines: closed.digest.lines,
    };
  }

  /**
   * Replay a text log into a mock port. Used to exercise the panel without
   * hardware; the API layer restricts which directories may be read.
   */
  async replayFile(portId, filePath, opts = {}) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(filePath);
    const chunk = Math.max(64, opts.chunk || 1024);
    const delay = Math.max(0, opts.delayMs ?? 0);
    for (let i = 0; i < buf.length; i += chunk) {
      this.feed(portId, buf.subarray(i, i + chunk));
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    return { bytes: buf.length, chunks: Math.ceil(buf.length / chunk) };
  }

  /** Mock adapter: inject bytes as if they came from the wire. */
  feed(portId, chunk, dir = 0) {
    const target = this.ports.get(portId);
    if (!target || target.state !== 'open') {
      throw new SerialError('E_PORT_NOT_OPEN', 'cannot feed portId ' + portId + ' (' + (target ? target.state : 'unknown') + ')', {
        hint: 'Bytes can only be injected into a port opened by serial_open; otherwise they would vanish into an unwatched ring.',
        fix: ['serial_open({port})', 'serial_ports()'],
      });
    }
    return this.hub.publishData(portId, {
      dir,
      bytes: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      tMonoUs: Math.round(performance.now() * 1000),
      tWallMs: Date.now(),
    });
  }

  async send(portId, payload, opts = {}) {
    const rec = this.ports.get(portId);
    if (!rec) throw new SerialError('E_PORT_NOT_FOUND', 'no such portId ' + portId, { hint: 'The portId is unknown or the port was closed. Call serial_ports() to see open ports, or serial_open() to start a new one.', fix: ['serial_ports()', 'serial_open({port})'] });
    if (rec.state !== 'open') throw new SerialError('E_PORT_NOT_OPEN', 'port ' + rec.name + ' is ' + rec.state, { hint: 'The port is ' + rec.state + '; reopen it before sending.', fix: ['serial_open({port})'], retryable: true });
    if (opts.owner && rec.owner && rec.owner.id !== opts.owner.id && !opts.force) {
      throw new SerialError('E_NOT_OWNER', 'portId ' + portId + ' belongs to ' + describeOwner(rec.owner), {
        hint: 'Reads are open to everyone; writing requires ownership. Pass force:true if you mean to write anyway.',
        fix: ['serial_tail({portId:' + portId + '}) to watch', 'serial_send({portId, text, force:true}) to override'],
        retryable: false,
      });
    }
    rec.lastActivity = Date.now();
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    if (rec.transport) await rec.transport.write(bytes);
    this.hub.publishData(portId, { dir: 1, bytes, tMonoUs: Math.round(performance.now() * 1000), tWallMs: Date.now() });
    return { portId, bytes: bytes.length };
  }

  /** Incremental read: returns lines after the cursor, plus the next cursor. */
  async tail(opts) {
    const { portId, maxLines = 200, timeoutMs = 0 } = opts;
    const rec = this.ports.get(portId);
    if (rec) rec.lastActivity = Date.now();
    if (!rec) throw new SerialError('E_PORT_NOT_FOUND', 'no such portId ' + portId, { hint: 'The portId is unknown or already closed. serial_ports() lists what is open right now.', fix: ['serial_ports()', 'serial_open({port})'] });
    const cur = this.cursors.get(portId);
    const mode = ['any', 'crlf', 'lf'].includes(opts.lineEnding) ? opts.lineEnding : 'any';
    let assembler = cur.assemblers.get(mode);
    if (!assembler) {
      assembler = new LineAssembler({ lineEnding: mode });
      cur.assemblers.set(mode, assembler);
    }
    let cursor = opts.cursor;
    // No cursor means "show me what just happened", not "start from now":
    // default to the tail of the ring buffer so a fresh tail call is useful.
    if (cursor === undefined || cursor === null) cursor = Math.max(0, this.hub.head(portId) - (opts.backlogBytes ?? 262144));
    if (cursor > this.hub.head(portId)) cursor = this.hub.head(portId);

    const lines = [];
    let consumed = cursor;
    const take = () => {
      const batches = this.hub.backlog(portId, consumed, 4 << 20);
      for (const batch of batches) {
        for (const line of assembler.feed(batch)) {
          lines.push({ t: line.tWallMs, seq: line.seq, text: line.text, dir: batch.dir === 1 ? 'tx' : 'rx', partial: line.partial });
          if (lines.length >= maxLines) {
            consumed = batch.seq + batch.bytes.length;
            return true;
          }
        }
        consumed = batch.seq + batch.bytes.length;
      }
      return false;
    };

    let full = take();
    if (!full && lines.length === 0 && timeoutMs > 0) {
      const sub = this.hub.subscribe(TOPIC.STREAM, { filter: { portId }, cursor: consumed, queueBytes: 4 << 20 });
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline && lines.length === 0) {
          const msg = await sub.next(Math.max(5, deadline - Date.now()));
          if (!msg) break;
          for (const line of assembler.feed(msg)) {
            lines.push({ t: line.tWallMs, seq: line.seq, text: line.text, dir: msg.dir === 1 ? 'tx' : 'rx', partial: line.partial });
            if (lines.length >= maxLines) break;
          }
          consumed = msg.seq + msg.bytes.length;
        }
      } finally {
        sub.close();
      }
    }

    const partial = assembler.carry.length > 0
      ? { text: assembler.carry, seq: assembler.carrySeq, partial: true }
      : null;

    return {
      portId,
      cursor: consumed,
      lines,
      // Unterminated bytes are returned separately so the panel can render them as a
      // dimmed last line that updates in place instead of duplicating rows.
      pending: partial,
      droppedBytes: 0,
      head: this.hub.head(portId),
      state: rec.state,
      bytesRx: rec.bytesRx,
      bytesTx: rec.bytesTx,
      startedAt: rec.started,
    };
  }

  /** History view: a capture read back from disk, no port involved. */
  async captureLines(captureId, opts) {
    return this.store.readCaptureLines(captureId, opts);
  }

  /** Delete a capture, refusing while it is the one being recorded. */
  async deleteCapture(captureId) {
    for (const [, rec] of this.ports) {
      if (rec.state !== 'closed' && rec.captureId === captureId) {
        throw new SerialError('E_CAPTURE_BUSY', 'capture ' + captureId + ' is being recorded right now', {
          hint: 'Close the port first, then delete the file.',
          fix: ['serial_close({portId:' + rec.id + '})', 'retry the delete'],
        });
      }
    }
    return this.store.deleteCapture(captureId);
  }

  // ------------------------------------------------------------- scans

  /**
   * Run one scan script over one capture. The caller passes a path: the script
   * belongs to the workspace, so it can be reviewed, diffed and re-run without
   * the plugin owning a registry.
   */
  async scan(captureId, { script, label, timeoutMs, signal } = {}) {
    const loaded = await this.scanRunner.load(script);
    const name = label ? String(label) : loaded.label;
    const run = await this.scanRunner.start({
      source: loaded.source,
      ctx: { captureId, script: loaded.path },
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS,
      signal,
    });
    let scanned = 0;
    try {
      await this.store.scanCapture(captureId, async (rec) => {
        // Stop feeding as soon as the caller aborts, instead of walking the rest
        // of the capture into a dead pipe.
        if (signal && signal.aborted) {
          throw new SerialError('E_SCAN_CANCELLED', 'scan cancelled by the caller', {
            hint: 'The tool call was aborted; nothing was written.',
            fix: ['serial_scan again if you still need it'],
            retryable: true,
          });
        }
        scanned += rec.length;
        await run.push(rec);
      });
      const { marks, truncated } = await run.finish();
      const normalized = marks.map((m) => normalizeMark(m, name)).filter(Boolean);
      const written = await this.store.writeMarks(captureId, name, normalized, {
        script: loaded.path,
        scannedAt: Date.now(),
        timeoutMs: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
      });
      return {
        captureId, label: name, script: loaded.path, scannedBytes: scanned,
        marks: normalized.length, truncated, file: written.file,
      };
    } catch (err) {
      run.kill();
      throw err;
    }
  }

  /** Marks plus a byte-range window per mark: references only, never text. */
  async marks(captureId, { rule, severity, beforeMs = 300, afterMs = 1000 } = {}) {
    const { marks, sources } = await this.store.readMarks(captureId, { rule, severity });
    const timeline = marks.length ? await this.store.captureTimeline(captureId) : [];
    const enriched = marks.map((mark) => {
      const dir = mark.anchor?.dir || 'rx';
      const lo = (mark.t || 0) - Math.max(0, beforeMs);
      const hi = (mark.t || 0) + Math.max(0, afterMs);
      let start = mark.anchor?.offset ?? 0;
      let end = start + (mark.anchor?.length || 0);
      for (const rec of timeline) {
        if (rec.dir !== dir) continue;
        if (rec.t >= lo && rec.t <= hi) {
          start = Math.min(start, rec.offset);
          end = Math.max(end, rec.offset + rec.length);
        }
      }
      return { ...mark, window: { dir, offset: start, length: Math.max(0, end - start) } };
    });
    return { captureId, count: enriched.length, sources, marks: enriched };
  }

  /** Materialise bytes addressed by a mark. Text is a convenience, hex is truth. */
  async bytes(captureId, { dir, offset, length, format = 'hex', encoding = 'utf-8' } = {}) {
    const range = await this.store.readCaptureBytes(captureId, { dir, offset, length });
    const data = range.data;
    let body;
    if (format === 'base64') body = data.toString('base64');
    else if (format === 'text') body = new TextDecoder(encoding, { fatal: false }).decode(data);
    else {
      const lines = [];
      for (let i = 0; i < data.length; i += 16) {
        const slice = data.subarray(i, i + 16);
        const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push((range.offset + i).toString(16).padStart(8, '0') + '  ' + hex.padEnd(47) + '  |' + ascii + '|');
      }
      body = lines.join('\n');
    }
    return { dir: range.dir, offset: range.offset, length: range.length, format, truncated: range.truncated, body };
  }

  async captures(opts = {}) {
    return this.store.listCaptures(opts);
  }

  async grep(captureId, pattern, opts) {
    return this.store.grep(captureId, pattern, opts);
  }

  async exportCapture(captureId, opts) {
    return this.store.exportCapture(captureId, opts);
  }

  /**
   * Release every port owned by one of these identities. Used when a session is
   * archived or disposed: its ports must not outlive it.
   */
  async closeOwnedBy(ownerIds, reason = 'owner-gone') {
    const wanted = new Set((ownerIds || []).filter(Boolean).map(String));
    if (wanted.size === 0) return [];
    const closed = [];
    for (const [id, rec] of [...this.ports]) {
      if (rec.state !== 'open') continue;
      const owner = rec.owner;
      if (!owner || !wanted.has(String(owner.id))) continue;
      await this.close(id, { force: true, reason }).then(() => closed.push(id)).catch(() => {});
    }
    return closed;
  }

  /** Read or update the runtime settings that serial_config exposes. */
  config({ set } = {}) {
    if (set && typeof set === 'object') {
      if ('idleLeaseMs' in set) {
        this.settings.idleLeaseMs = Math.max(0, Number(set.idleLeaseMs) || 0);
        if (this._leaseTimer) { clearInterval(this._leaseTimer); this._leaseTimer = null; }
        if (this.settings.idleLeaseMs > 0) {
          this._leaseTimer = setInterval(() => { this.reapIdle().catch(() => {}); }, 60000);
          if (typeof this._leaseTimer.unref === 'function') this._leaseTimer.unref();
        }
      }
      if ('defaultLineEnding' in set && ['any', 'crlf', 'lf'].includes(set.defaultLineEnding)) {
        this.settings.defaultLineEnding = set.defaultLineEnding;
      }
      if ('scanRoots' in set) {
        const roots = Array.isArray(set.scanRoots) ? set.scanRoots.filter(Boolean) : [];
        if (roots.length) {
          this.settings.scanRoots = roots.map(String);
          this.scanRunner.roots = this.settings.scanRoots.map((r) => resolve(r));
        }
      }
    }
    if (this.onSettingsChange) {
      try { this.onSettingsChange({ ...this.settings }); } catch { /* persistence is best-effort */ }
    }
    return { ...this.settings, portsOpen: [...this.ports.values()].filter((r) => r.state === 'open').length };
  }

  /** Close ports nobody has touched for longer than the lease. */
  async reapIdle() {
    const lease = Number(this.settings.idleLeaseMs) || 0;
    if (lease <= 0) return [];
    const closed = [];
    const now = Date.now();
    for (const [id, rec] of [...this.ports]) {
      if (rec.state !== 'open') continue;
      if (now - (rec.lastActivity || rec.started || now) < lease) continue;
      await this.close(id, { force: true, reason: 'idle' }).then(() => closed.push(id)).catch(() => {});
    }
    return closed;
  }

  async cleanup(opts = {}) {
    if (opts.planId) return this.store.applyCleanup(opts.planId);
    return this.store.planCleanup(opts);
  }

  // --------------------------------------------------------------- state machine

  /** Load a scenario from an object or a workspace file, with the same guard as scan scripts. */
  async loadScenario(scenario) {
    if (scenario && typeof scenario === 'object') return scenario;
    if (typeof scenario !== 'string' || !scenario.trim()) {
      throw new SerialError('E_BAD_SCENARIO', 'scenario must be an object or a path', { hint: 'Pass {path} or inline the JSON.' });
    }
    const abs = resolve(scenario);
    const roots = (this.settings.scanRoots || [process.cwd()]).map((r) => resolve(r));
    const inside = roots.some((r) => abs.toLowerCase() === r.toLowerCase() || abs.toLowerCase().startsWith(r.toLowerCase() + sep));
    if (!inside) {
      throw new SerialError('E_SCENARIO_OUTSIDE_WORKSPACE', 'scenario is outside the workspace: ' + abs, {
        hint: 'Scenarios must live under a configured workspace root.',
        fix: ['move the scenario into the workspace', 'serial_config({set:{scanRoots:[...]}})'],
      });
    }
    if (!abs.toLowerCase().endsWith('.json')) {
      throw new SerialError('E_BAD_SCENARIO', 'scenario must be a .json file', { fix: ['rename the file to *.fsm.json'] });
    }
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new SerialError('E_NO_SUCH_SCENARIO', 'no such scenario: ' + abs, { fix: ['check the path'] });
    }
    if (st.size > 256 * 1024) {
      throw new SerialError('E_BAD_SCENARIO', 'scenario is larger than 256KB', { fix: ['split the scenario'] });
    }
    return JSON.parse(await readFile(abs, 'utf8'));
  }

  /** Offline: prove a scenario against a recording before touching hardware. */
  async fsmSimulate(captureId, { scenario, tailMs } = {}) {
    const def = await this.loadScenario(scenario);
    const { lines } = await this.store.readCaptureLines(captureId, { maxLines: 200000 });
    const out = simulate(def, lines, { tailMs });
    return { captureId, mode: 'simulate', ...out };
  }

  /** Live: bind a machine to one port. One run per port, owner must hold the port. */
  async fsmStart({ scenario, portId, owner, timeoutMs } = {}) {
    const def = await this.loadScenario(scenario);
    const id = Number(portId);
    const rec = this.ports.get(id);
    if (!rec || rec.state !== 'open') {
      throw new SerialError('E_PORT_NOT_FOUND', 'portId ' + portId + ' is not open', { hint: 'Open the port first.', fix: ['serial_open({port})'] });
    }
    if (owner && rec.owner && rec.owner.id !== owner.id) {
      throw new SerialError('E_NOT_OWNER', 'portId ' + id + ' belongs to ' + describeOwner(rec.owner), {
        hint: 'Starting a live machine writes to the port, so it requires ownership.',
        fix: ['serial_open({port, takeover:true})'],
      });
    }
    for (const [, run] of this.fsmRuns) {
      if (run.portId === id && run.alive) {
        throw new SerialError('E_FSM_BUSY', 'portId ' + id + ' already runs ' + run.id, {
          hint: 'One machine per port: two machines would fight over the same bytes.',
          fix: ['serial_fsm_stop({runId:"' + run.id + '"})'],
        });
      }
    }
    const runId = 'fsm-' + (++this.fsmSeq);
    const machine = new Machine(def);
    const run = { id: runId, machine, portId: id, owner: owner || null, alive: true, marks: [], startedAt: Date.now(), scenario: machine.name };
    this.fsmRuns.set(runId, run);
    const sub = this.hub.subscribe(TOPIC.STREAM, { filter: { portId: id }, cursor: this.hub.head(id) });
    run.sub = sub;
    const assembler = new LineAssembler({ lineEnding: 'any' });
    (async () => {
      try {
        while (run.alive) {
          const msg = await sub.next(250);
          if (!msg) { this._fsmTick(run); continue; }
          for (const line of assembler.feed(msg)) {
            run.machine.feedLine(line.text, Date.now());
            await this._fsmApply(run);
          }
        }
      } catch { /* subscription closed */ }
    })();
    return { runId, mode: 'live', portId: id, status: machine.status() };
  }

  async _fsmApply(run) {
    for (const action of run.machine.drainActions()) {
      if (action.type === 'send') {
        await this.send(run.portId, Buffer.from(action.text, 'utf8'), { owner: run.owner, force: true }).catch(() => {});
      } else if (action.type === 'mark') {
        run.marks.push({ at: action.at, label: action.label, severity: action.severity });
      }
    }
    this._fsmNotify(run);
  }

  _fsmTick(run) {
    const t = run.machine.tick(Date.now());
    if (t.length) this._fsmApply(run);
  }

  _fsmNotify(run) {
    for (const w of run.waiters || []) w(run.machine.status());
    run.waiters = [];
  }

  async fsmEvent(runId, name) {
    const run = this._run(runId);
    run.machine.event(String(name), Date.now());
    await this._fsmApply(run);
    return { runId, status: run.machine.status(), marks: run.marks };
  }

  fsmList(portId) {
    const out = [];
    for (const [id, run] of this.fsmRuns) {
      if (portId && run.portId !== Number(portId)) continue;
      out.push({ runId: id, portId: run.portId, alive: run.alive, scenario: run.scenario, status: run.machine.status(), marks: run.marks.length });
    }
    return out;
  }

  fsmStatus(runId) {
    const run = this._run(runId);
    return { runId, portId: run.portId, alive: run.alive, marks: run.marks, status: run.machine.status() };
  }

  /** Long-poll: resolve on the next transition or on timeout. */
  async fsmWait(runId, { timeoutMs = 5000 } = {}) {
    const run = this._run(runId);
    const before = run.machine.trace.length;
    if (run.machine.trace.length > before) return { runId, status: run.machine.status(), marks: run.marks };
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ runId, status: run.machine.status(), marks: run.marks });
      };
      run.waiters = run.waiters || [];
      run.waiters.push(finish);
      setTimeout(finish, Math.max(50, timeoutMs));
    });
  }

  async fsmStop(runId, opts = {}) {
    const run = this._run(runId);
    run.alive = false;
    try { run.sub.close(); } catch { /* gone */ }
    this.fsmRuns.delete(runId);
    let marked = 0;
    if (run.marks.length) {
      const rec = this.ports.get(run.portId);
      if (rec && rec.captureId) {
        await this.store.writeMarks(rec.captureId, 'fsm-' + run.scenario, run.marks.map((m) => ({
          anchor: { dir: 'rx', offset: 0, length: 0 }, t: m.at, kind: 'state', severity: m.severity || 'info', label: m.label,
        })), { scenario: run.scenario, at: Date.now() }).catch(() => {});
        marked = run.marks.length;
      }
    }
    return { runId, stopped: true, persisted: opts.persistMarks !== false ? marked : 0, trace: run.machine.trace };
  }

  _run(runId) {
    const run = this.fsmRuns.get(runId);
    if (!run) throw new SerialError('E_NO_SUCH_RUN', 'no such run ' + runId, { hint: 'Machines are stopped when their session ends.', fix: ['serial_fsm_start'] });
    return run;
  }

  /** Stop every live machine bound to one port (the port is closing). */
  async _stopRunsForPort(portId, reason = 'port-closed') {
    for (const [id, run] of [...this.fsmRuns]) {
      if (run.portId !== portId) continue;
      await this.fsmStop(id).catch(() => {});
    }
  }

  /** Stop runs owned by identities that just went away. */
  async stopRunsOwnedBy(ids, reason = 'owner-gone') {
    const wanted = new Set((ids || []).filter(Boolean).map(String));
    const stopped = [];
    for (const [id, run] of [...this.fsmRuns]) {
      if (!run.owner || !wanted.has(String(run.owner.id))) continue;
      await this.fsmStop(id).catch(() => {});
      stopped.push(id);
    }
    return stopped;
  }

  /** Close every open port and drop cursors. Idempotent. */
  async dispose() {
    if (this._leaseTimer) { clearInterval(this._leaseTimer); this._leaseTimer = null; }
    for (const [id, rec] of [...this.ports]) {
      if (rec.state === 'open' || rec.state === 'draining') await this.close(id).catch(() => {});
      this.hub.clearTap(id);
    }
    this.cursors.clear();
  }

  /** Wait until everything fed so far is on disk (bounds memory during fast replay). */
  async flush(portId) {
    const rec = this.ports.get(portId);
    if (rec && rec.writer) await rec.writer.flush();
  }

  status(portId) {
    const rec = this.ports.get(portId);
    if (!rec) return null;
    return { portId, port: rec.name, state: rec.state, bytesRx: rec.bytesRx, bytesTx: rec.bytesTx, captureId: rec.captureId, path: rec.path };
  }
}
