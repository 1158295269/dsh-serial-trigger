/**
 * .slog container - append-only binary log for one serial capture.
 *
 * Layout (little-endian):
 *   Header 64B : magic[8] ver:u16 flags:u16 headerSize:u32 createdAt:u64
 *                port[24] baud:u32 reserved[12]
 *   Record     : payloadLen:u32 tMonoUs:u64 tWallMs:u64
 *                kind:u8 flags:u8 reserved:u16 payload[payloadLen]
 *
 * Design notes:
 *  - Bytes are the truth; nothing is decoded here.
 *  - tMonoUs is file-relative monotonic microseconds - use it for ordering.
 *  - tWallMs is wall clock, display only (NTP jumps are expected).
 *  - Recovery: the scan stops at the first incomplete record and reports the tail.
 */
import { open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { ioPath } from './paths.mjs';

export const MAGIC = 'DSHSLOG1';
export const VERSION = 1;
export const HEADER_SIZE = 64;
export const RECORD_HEADER_SIZE = 24;
export const PORT_FIELD_SIZE = 24;

export const KIND = Object.freeze({ RX: 0, TX: 1, MARK: 2, GAP: 3, TRIGGER: 4, STATUS: 5 });
export const FLAG = Object.freeze({ PARTIAL: 1, GAP_BEFORE: 2, TRIGGER_MARK: 4 });

const WRITE_BUFFER = 1 << 20; // 1 MiB flush threshold
const READ_CHUNK = 8 << 20;
const MAX_RECORD_BYTES = 64 << 20; // a single record can never legitimately exceed this

/** Truncate a string to at most maxBytes of UTF-8 without splitting a character. */
export function clipUtf8(str, maxBytes) {
  const b = Buffer.from(String(str), 'utf8');
  if (b.length <= maxBytes) return b;
  let end = maxBytes;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end -= 1; // walk back over continuation bytes
  return b.subarray(0, end);
}

export function encodeHeader(meta = {}) {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt16LE(VERSION, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt32LE(HEADER_SIZE, 12);
  buf.writeBigUInt64LE(BigInt(meta.createdAt ?? Date.now()), 16);
  const port = clipUtf8(String(meta.port ?? ''), PORT_FIELD_SIZE);
  port.copy(buf, 24);
  buf.writeUInt32LE(meta.baud ?? 0, 48);
  return buf;
}

export function decodeHeader(buf) {
  const magic = buf.toString('latin1', 0, 8);
  if (magic !== MAGIC) throw new Error('E_BAD_MAGIC: ' + JSON.stringify(magic));
  const version = buf.readUInt16LE(8);
  if (version > VERSION) throw new Error('E_VERSION_TOO_NEW: file v' + version + ', reader v' + VERSION);
  const headerSize = buf.readUInt32LE(12);
  if (headerSize !== HEADER_SIZE) throw new Error('E_BAD_HEADER_SIZE: ' + headerSize + ' != ' + HEADER_SIZE);
  let port = buf.toString('utf8', 24, 24 + PORT_FIELD_SIZE);
  const nul = port.indexOf('\u0000');
  if (nul >= 0) port = port.slice(0, nul);
  return {
    version,
    flags: buf.readUInt16LE(10),
    headerSize: buf.readUInt32LE(12),
    createdAt: Number(buf.readBigUInt64LE(16)),
    port,
    baud: buf.readUInt32LE(48),
  };
}

export class SlogWriter {
  constructor(fh, meta) {
    this.fh = fh;
    this.meta = meta;
    this.bytes = 0;
    this.records = 0;
    this.lastT = 0;
    this._buf = Buffer.allocUnsafe(WRITE_BUFFER);
    this._used = 0;
    this._pending = Promise.resolve();
    this._closed = false;
  }

  static async create(path, meta = {}) {
    const fh = await open(ioPath(path), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o644);
    const header = encodeHeader(meta);
    // No explicit position: append-style write advances the handle offset, so the
    // first flushed record lands at 64 instead of overwriting the header.
    await fh.write(header);
    return new SlogWriter(fh, { ...meta, createdAt: meta.createdAt ?? Date.now() });
  }

  append(rec) {
    if (this._closed) throw new Error('E_WRITER_CLOSED');
    const payload = rec.bytes ?? Buffer.alloc(0);
    const need = RECORD_HEADER_SIZE + payload.length;
    if (need > this._buf.length) {
      this._flushSync();
      return this._appendBig(rec, payload);
    }
    if (this._used + need > this._buf.length) this._flushSync();

    const buf = this._buf;
    const o = this._used;
    buf.writeUInt32LE(payload.length, o);
    buf.writeBigUInt64LE(BigInt(Math.round(rec.tMonoUs ?? 0)), o + 4);
    buf.writeBigUInt64LE(BigInt(Math.round(rec.tWallMs ?? Date.now())), o + 12);
    buf.writeUInt8(rec.kind ?? KIND.RX, o + 20);
    buf.writeUInt8(rec.flags ?? 0, o + 21);
    buf.writeUInt16LE(0, o + 22);
    payload.copy(buf, o + RECORD_HEADER_SIZE);

    this._used = o + need;
    this.bytes += payload.length;
    this.records += 1;
    this.lastT = rec.tMonoUs ?? 0;
    if (this._used >= WRITE_BUFFER) this._flushSync();
    return this;
  }

  _appendBig(rec, payload) {
    const buf = Buffer.allocUnsafe(RECORD_HEADER_SIZE + payload.length);
    buf.writeUInt32LE(payload.length, 0);
    buf.writeBigUInt64LE(BigInt(Math.round(rec.tMonoUs ?? 0)), 4);
    buf.writeBigUInt64LE(BigInt(Math.round(rec.tWallMs ?? Date.now())), 12);
    buf.writeUInt8(rec.kind ?? KIND.RX, 20);
    buf.writeUInt8(rec.flags ?? 0, 21);
    buf.writeUInt16LE(0, 22);
    payload.copy(buf, RECORD_HEADER_SIZE);
    const chunk = buf;
    this._pending = this._pending.then(() => this.fh.write(chunk));
    this.bytes += payload.length;
    this.records += 1;
    this.lastT = rec.tMonoUs ?? 0;
    return this;
  }

  _flushSync() {
    if (this._used === 0) return;
    const chunk = Buffer.from(this._buf.subarray(0, this._used));
    this._used = 0;
    this._pending = this._pending.then(() => this.fh.write(chunk));
  }

  async flush() {
    this._flushSync();
    await this._pending;
  }

  async close() {
    if (!this._closed) {
      await this.flush();
      this._closed = true;
      await this.fh.close();
    }
    return this.stats();
  }

  stats() {
    return {
      records: this.records,
      bytes: this.bytes,
      lastT: this.lastT,
      createdAt: this.meta.createdAt ?? null,
      port: this.meta.port ?? '',
      baud: this.meta.baud ?? 0,
    };
  }
}

export class SlogReader {
  constructor(fh, header, size) {
    this.fh = fh;
    this.header = header;
    this.size = size;
  }

  static async open(path) {
    const fh = await open(ioPath(path), 'r');
    const head = Buffer.alloc(HEADER_SIZE);
    const res = await fh.read(head, 0, HEADER_SIZE, 0);
    if (res.bytesRead < HEADER_SIZE) {
      await fh.close();
      throw new Error('E_SHORT_HEADER: file smaller than 64 bytes');
    }
    const header = decodeHeader(head);
    const st = await fh.stat();
    return new SlogReader(fh, header, st.size);
  }

  async scan(onRecord) {
    const out = {
      header: this.header,
      records: 0,
      rxBytes: 0,
      txBytes: 0,
      otherBytes: 0,
      firstT: null,
      lastT: 0,
      lastWall: 0,
      kinds: new Array(8).fill(0),
      truncated: false,
      droppedBytes: 0,
      endOffset: HEADER_SIZE,
    };

    let pos = HEADER_SIZE;
    let carry = Buffer.alloc(0);

    while (true) {
      if (carry.length >= RECORD_HEADER_SIZE) {
        const len = carry.readUInt32LE(0);
        if (len > MAX_RECORD_BYTES) throw new Error('E_RECORD_TOO_LARGE: ' + len + ' > ' + MAX_RECORD_BYTES);
        const total = RECORD_HEADER_SIZE + len;
        if (carry.length >= total) {
          const rec = {
            kind: carry.readUInt8(20),
            flags: carry.readUInt8(21),
            tMonoUs: Number(carry.readBigUInt64LE(4)),
            tWallMs: Number(carry.readBigUInt64LE(12)),
            bytes: carry.subarray(RECORD_HEADER_SIZE, total),
            offset: out.endOffset,
          };
          out.records += 1;
          out.kinds[rec.kind] = (out.kinds[rec.kind] ?? 0) + 1;
          if (rec.kind === KIND.RX) out.rxBytes += len;
          else if (rec.kind === KIND.TX) out.txBytes += len;
          else out.otherBytes += len;
          if (out.firstT === null) out.firstT = rec.tMonoUs;
          out.lastT = rec.tMonoUs;
          out.lastWall = rec.tWallMs;
          out.endOffset += total;
          if (onRecord) {
          // Awaited so consumers keep their own backpressure, and a false return
          // lets a scan stop early (grep once it has enough hits).
          const stop = await onRecord(rec);
          if (stop === false) break;
          if ((out.records & 127) === 0) await new Promise((r) => setImmediate(r));
        }
          carry = carry.subarray(total);
          continue;
        }
      }

      if (pos >= this.size) {
        if (carry.length > 0) {
          out.truncated = true;
          out.droppedBytes = carry.length;
        }
        break;
      }

      const want = Math.min(READ_CHUNK, this.size - pos);
      const chunk = Buffer.allocUnsafe(want);
      const res = await this.fh.read(chunk, 0, want, pos);
      if (res.bytesRead <= 0) break;
      pos += res.bytesRead;
      const piece = chunk.subarray(0, res.bytesRead);
      carry = carry.length ? Buffer.concat([carry, piece]) : piece;
      if (carry.length > (64 << 20)) throw new Error('E_RECORD_TOO_LARGE: ' + carry.readUInt32LE(0));
    }

    await this.fh.close();
    return out;
  }
}
