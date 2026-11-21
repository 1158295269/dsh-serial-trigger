/**
 * In-process pub/sub broker for serial byte streams.
 *
 * Topics are plain strings; the broker owns no I/O. A port is registered with a
 * ring buffer so a late or slow subscriber can catch up by cursor (a byte seq)
 * instead of only seeing "everything after now".
 *
 * Delivery contract:
 *  - per port, strictly ordered by seq
 *  - at-most-once: a subscriber that falls behind drops its oldest queued batch
 *    and is told how many bytes it lost (gap), it never blocks the producer
 *  - the producer is never awaited by a subscriber
 */
export const TOPIC = Object.freeze({
  STREAM: 'serial.stream',
  STATUS: 'serial.status',
  TRIGGER: 'serial.trigger',
  CAPTURE: 'serial.capture',
});

class Ring {
  constructor(capacityBytes) {
    this.capacity = capacityBytes;
    this.batches = [];
    this.bytes = 0;
    this.headSeq = 0;   // next seq to assign
  }

  push(batch) {
    this.batches.push(batch);
    this.bytes += batch.bytes.length;
    while (this.bytes > this.capacity && this.batches.length > 1) {
      const drop = this.batches.shift();
      this.bytes -= drop.bytes.length;
    }
  }

  readFrom(seq) {
    const out = [];
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const b = this.batches[i];
      if (b.seq + b.bytes.length <= seq) break; // entirely before the cursor
      out.push(b);
    }
    out.reverse();
    // A byte cursor may land inside a batch: hand back the tail from there.
    if (out.length > 0 && out[0].seq < seq) {
      const off = seq - out[0].seq;
      out[0] = { ...out[0], bytes: out[0].bytes.subarray(off), seq };
    }
    return out;
  }
}

export class Subscription {
  constructor(hub, topic, opts) {
    this.hub = hub;
    this.topic = topic;
    this.filter = opts.filter || {};
    this.framing = opts.framing || 'burst';
    this.queueBytes = opts.queueBytes || 1 << 20;
    this.queue = [];
    this.queued = 0;
    this.dropped = 0;
    this.closed = false;
    this._waiters = [];
  }

  matches(msg) {
    const f = this.filter;
    if (f.portId !== undefined && msg.portId !== undefined && msg.portId !== f.portId) return false;
    if (f.dir !== undefined && msg.dir !== undefined && msg.dir !== f.dir) return false;
    if (f.kind !== undefined && msg.kind !== undefined && msg.kind !== f.kind) return false;
    return true;
  }

  _push(msg) {
    if (this.closed) return;
    const size = msg.bytes ? msg.bytes.length : 64;
    if (this.queued + size > this.queueBytes) {
      while (this.queued + size > this.queueBytes && this.queue.length > 0) {
        const old = this.queue.shift();
        this.queued -= old.bytes ? old.bytes.length : 64;
        this.dropped += old.bytes ? old.bytes.length : 0;
      }
      msg = { ...msg, gapBytes: (msg.gapBytes || 0) + this.dropped, flags: (msg.flags || 0) | 2 };
      this.dropped = 0;
    }
    this.queue.push(msg);
    this.queued += size;
    const w = this._waiters.shift();
    if (w) w(this.queue.shift());
  }

  /**
   * Returns the next message. With no argument it waits indefinitely (no timer,
   * so an idle port never keeps the event loop alive); pass a finite timeout to
   * poll instead.
   */
  async next(timeoutMs = Infinity) {
    if (this.closed) return null;
    if (this.queue.length > 0) {
      const msg = this.queue.shift();
      this.queued -= msg.bytes ? msg.bytes.length : 64;
      return msg;
    }
    if (timeoutMs === 0) return null;
    if (!Number.isFinite(timeoutMs)) {
      return await new Promise((resolve) => { this._waiters.push(resolve); });
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (msg) => { clearTimeout(timer); resolve(msg); };
      this._waiters.push(waiter);
    });
  }

  close() {
    this.closed = true;
    for (const w of this._waiters.splice(0)) w(null);
    this.hub._forget(this);
  }
}

export class Hub {
  constructor(opts = {}) {
    this.ringBytes = opts.ringBytes || 8 << 20;
    this.ports = new Map();
    this.subs = new Map(); // topic -> Set<Subscription>
    this.taps = new Map(); // portId -> (batch) => void, called inline, never queued
  }

  registerPort(portId) {
    if (!this.ports.has(portId)) this.ports.set(portId, new Ring(this.ringBytes));
    return this.ports.get(portId);
  }

  /** Publish a data batch; seq is assigned by the hub so it is always gapless. */
  publishData(portId, { dir, bytes, tMonoUs, tWallMs, flags = 0 }) {
    const ring = this.registerPort(portId);
    const batch = { portId, seq: ring.headSeq, dir, bytes, tMonoUs, tWallMs, flags };
    ring.headSeq += bytes.length;
    ring.push(batch);
    // Taps run inline: a recorder must never see the gap a bounded queue would create.
    const tap = this.taps.get(portId);
    if (tap) tap(batch);
    this._fanout(TOPIC.STREAM, batch);
    return batch;
  }

  publishStatus(portId, from, to, reason) {
    this._fanout(TOPIC.STATUS, { portId, from, to, reason, tWallMs: Date.now() });
  }

  publishTrigger(portId, ruleId, fromSeq, toSeq, hits) {
    this._fanout(TOPIC.TRIGGER, { portId, ruleId, fromSeq, toSeq, hits, tWallMs: Date.now() });
  }

  publishCapture(capture) {
    this._fanout(TOPIC.CAPTURE, capture);
  }

  subscribe(topic, opts = {}) {
    const sub = new Subscription(this, topic, opts);
    if (!this.subs.has(topic)) this.subs.set(topic, new Set());
    this.subs.get(topic).add(sub);
    if (topts_catchup(opts)) {
      const ring = this.ports.get(opts.filter && opts.filter.portId);
      if (ring && typeof opts.cursor === 'number') {
        for (const b of ring.readFrom(opts.cursor)) sub._push(b);
      }
    }
    return sub;
  }

  /** Catch-up from the ring, used by tail/replay when a cursor is behind head. */
  backlog(portId, cursor, maxBytes = 1 << 20) {
    const ring = this.ports.get(portId);
    if (!ring) return [];
    const out = [];
    let total = 0;
    for (const b of ring.readFrom(cursor)) {
      out.push(b);
      total += b.bytes.length;
      if (total >= maxBytes) break;
    }
    return out;
  }

  setTap(portId, fn) {
    this.taps.set(portId, fn);
  }

  clearTap(portId) {
    this.taps.delete(portId);
  }

  head(portId) {
    const ring = this.ports.get(portId);
    return ring ? ring.headSeq : 0;
  }

  _fanout(topic, msg) {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const sub of set) {
      if (sub.matches(msg)) sub._push(msg);
    }
  }

  _forget(sub) {
    const set = this.subs.get(sub.topic);
    if (set) set.delete(sub);
  }
}

function topts_catchup(opts) {
  return !!(opts && typeof opts.cursor === 'number' && opts.filter && typeof opts.filter.portId === 'number');
}
