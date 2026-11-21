/**
 * Line assembly over a byte stream.
 *
 * A serial port has no message boundaries, so "lines" are a policy, not a fact.
 * Three policies are supported and they are NOT cosmetic — they change which
 * bytes a line contains:
 *
 *   any   (default)  \r, \n and \r\n all terminate a line
 *   crlf             only the pair \r\n terminates; a lone \r or \n is data
 *                    (use when the payload itself may contain 0x0A)
 *   lf               only \n terminates; a lone \r is data (classic Unix log)
 *
 * The decoder is incremental: a multi-byte UTF-8 character split across two
 * batches must survive intact. A trailing \r is held back one batch because it
 * may turn out to be the first half of \r\n.
 *
 * Hot path is indexOf plus one slice per line. The per-character loop this
 * replaced cost ~5s per 20MB of binary log, which showed up as a slow close.
 */
export class LineAssembler {
  constructor(opts = {}) {
    this.encoding = opts.encoding || 'utf-8';
    this.decoder = new TextDecoder(this.encoding, { fatal: false });
    this.maxLine = opts.maxLine || 8192;
    this.lineEnding = ['any', 'crlf', 'lf'].includes(opts.lineEnding) ? opts.lineEnding : 'any';
    this.carry = '';
    this.carrySeq = -1;
    this.carryT = 0;
  }

  /**
   * @param {{bytes: Uint8Array, seq: number, tWallMs: number}} batch
   * @returns {Array<{text:string, seq:number, tWallMs:number, partial:boolean}>}
   */
  feed(batch) {
    const out = [];
    const text = this.decoder.decode(batch.bytes, { stream: true });
    const combined = this.carry + text;
    const carryLen = this.carry.length;
    let pos = 0;

    for (;;) {
      const brk = this._findBreak(combined, pos);
      if (!brk) break;
      const startIdx = pos;
      let body = combined.slice(startIdx, brk.index);
      // lf mode: a \r immediately before \n is part of the terminator, not data
      if (this.lineEnding === 'lf' && brk.ch === '\n' && body.endsWith('\r')) body = body.slice(0, -1);

      const seq = startIdx < carryLen
        ? (this.carrySeq >= 0 ? this.carrySeq : batch.seq)
        : batch.seq + byteLengthApprox(text.slice(0, startIdx - carryLen));
      out.push({ text: body, seq, tWallMs: batch.tWallMs, partial: false });
      pos = brk.index + brk.len;
    }

    const rest = combined.slice(pos);
    if (rest.length > 0) {
      this.carry = rest;
      if (pos >= carryLen) {
        this.carrySeq = batch.seq + byteLengthApprox(text.slice(0, pos - carryLen));
        this.carryT = batch.tWallMs;
      }
      if (this.carry.length > this.maxLine) {
        out.push({ text: this.carry, seq: this.carrySeq < 0 ? 0 : this.carrySeq, tWallMs: this.carryT, partial: true });
        this.carry = '';
        this.carrySeq = -1;
      }
    } else {
      this.carry = '';
      this.carrySeq = -1;
    }
    return out;
  }

  _findBreak(s, from) {
    if (this.lineEnding === 'lf') {
      const i = s.indexOf('\n', from);
      return i === -1 ? null : { index: i, len: 1, ch: '\n' };
    }

    if (this.lineEnding === 'crlf') {
      // hold a trailing \r: the next batch may start with \n
      const limit = s.endsWith('\r') ? s.length - 1 : s.length;
      if (limit <= from) return null;
      const i = s.slice(0, limit).indexOf('\r\n', from);
      return i === -1 ? null : { index: i, len: 2, ch: '\n' };
    }

    // any
    for (let i = from; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10) return { index: i, len: 1, ch: '\n' };
      if (c === 13) {
        if (i + 1 >= s.length) return null; // may be half of \r\n
        if (s.charCodeAt(i + 1) === 10) return { index: i, len: 2, ch: '\r' };
        return { index: i, len: 1, ch: '\r' };
      }
    }
    return null;
  }

  /** Flush whatever is buffered as a partial line (idle timeout / port close). */
  flush(tWallMs) {
    if (this.carry.length === 0) return [];
    const rec = {
      text: this.carry,
      seq: this.carrySeq < 0 ? 0 : this.carrySeq,
      tWallMs: tWallMs || this.carryT,
      partial: true,
    };
    this.carry = '';
    this.carrySeq = -1;
    return [rec];
  }
}

// UTF-8 byte length of a decoded chunk (needed because seq counts bytes, not chars).
function byteLengthApprox(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
