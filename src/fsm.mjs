/**
 * State machine middleware (v0.3, first cut).
 *
 * A scenario is plain JSON in the workspace. The machine only decides
 * transitions; the runtime does the I/O. Two rules shape the format:
 *
 *  - a live run is bound to one port, one run per port
 *  - a "send" must declare what the device is expected to answer and which
 *    state that answer moves us into, so nothing is ever fired blind
 */
import { SerialError } from './errors.mjs';

const MAX_TRACE = 500;
const MATCH_EVENT = /^event:([A-Za-z0-9_.-]+)$/;
const MATCH_LINE = /^line:\/(.*)\/$/;

function bad(message, hint, fix) {
  return new SerialError('E_BAD_SCENARIO', message, { hint, fix: fix || ['fix the scenario file', 'serial_fsm_start again'] });
}

function compileMatcher(key) {
  if (!key || typeof key !== 'string') throw bad('transition key must be a string');
  const ev = MATCH_EVENT.exec(key);
  if (ev) return { kind: 'event', name: ev[1] };
  const ln = MATCH_LINE.exec(key);
  if (ln) {
    try {
      return { kind: 'line', re: new RegExp(ln[1]) };
    } catch (err) {
      throw bad('bad regex in ' + key + ': ' + err.message, 'The line matcher is /regex/ syntax.');
    }
  }
  throw bad('unknown matcher "' + key + '"', 'Use "event:<name>" or "line:/regex/".');
}

export function validateScenario(def) {
  if (!def || typeof def !== 'object') throw bad('scenario must be an object');
  if (typeof def.initial !== 'string') throw bad('scenario.initial is required');
  if (!def.states || typeof def.states !== 'object' || Object.keys(def.states).length === 0) throw bad('scenario.states is required');
  const names = Object.keys(def.states);
  if (!names.includes(def.initial)) throw bad('initial state "' + def.initial + '" does not exist');

  for (const name of names) {
    const state = def.states[name] || {};
    const on = state.on || {};
    for (const [key, raw] of Object.entries(on)) {
      const match = compileMatcher(key);
      const action = raw || {};
      if (action.goto && !names.includes(action.goto)) throw bad('state "' + name + '" -> unknown goto "' + action.goto + '"');
      if (action.else && !names.includes(action.else)) throw bad('state "' + name + '" -> unknown else "' + action.else + '"');
      if (action.send !== undefined) {
        // The rule from the user: a send is only allowed when the expected next
        // state is known, otherwise the machine would be firing blind.
        if (typeof action.send !== 'string' || !action.send) throw bad('send in "' + name + '" must be a non-empty string');
        if (!action.expect) throw bad('transition "' + key + '" in "' + name + '" sends data but declares no expect', 'A send must state what the device answers and which state that implies.');
        compileMatcher(action.expect);
        if (!Number.isFinite(Number(action.waitMs)) || Number(action.waitMs) <= 0) throw bad('transition "' + key + '" in "' + name + '" must declare waitMs');
        if (!action.goto) throw bad('transition "' + key + '" in "' + name + '" must declare the state reached after the expected answer');
        // 超时策略是场景自己决定的，不写死：可以只打标、跳恢复态、重发若干次，或直接停机。
        if (action.onTimeout !== undefined) {
          const t = action.onTimeout || {};
          if (typeof t !== 'object') throw bad('transition "' + key + '" in "' + name + '" onTimeout must be an object');
          if (t.goto !== undefined && !names.includes(t.goto)) throw bad('transition "' + key + '" in "' + name + '" onTimeout.goto "' + t.goto + '" is not a state');
          if (t.retry !== undefined && (!Number.isInteger(Number(t.retry)) || Number(t.retry) < 0 || Number(t.retry) > 10)) throw bad('transition "' + key + '" in "' + name + '" onTimeout.retry must be an integer 0..10');
          if (t.retryDelayMs !== undefined && (!Number.isFinite(Number(t.retryDelayMs)) || Number(t.retryDelayMs) < 0)) throw bad('transition "' + key + '" in "' + name + '" onTimeout.retryDelayMs must be >= 0');
          if (t.severity !== undefined && !['info', 'warn', 'error'].includes(t.severity)) throw bad('transition "' + key + '" in "' + name + '" onTimeout.severity must be info|warn|error');
          if (t.stop !== undefined && typeof t.stop !== 'boolean') throw bad('transition "' + key + '" in "' + name + '" onTimeout.stop must be a boolean');
        }
      }
      if (match.kind === 'line' && match.re) { /* compiled above */ }
    }
    if (state.after !== undefined) {
      const after = state.after || {};
      if (!Number.isFinite(Number(after.ms)) || Number(after.ms) <= 0) throw bad('state "' + name + '" after.ms must be a positive number');
      if (!after.goto || !names.includes(after.goto)) throw bad('state "' + name + '" after.goto must reference a state');
    }
  }
  return def;
}

export class Machine {
  constructor(def, opts = {}) {
    this.def = validateScenario(def);
    this.mode = opts.simulated ? 'simulated' : 'executed';
    this.name = def.name || 'scenario';
    this.state = def.initial;
    this.enteredAt = 0;
    this.pending = null;      // { match, deadline, goto, elseTo, sendText, waitMs, attempt, maxAttempts, onTimeout }
    this.stopped = false;
    this.trace = [];
    this.actions = [];        // side effects the runtime must perform
    this._armAfter(0);
  }

  _stateDef() { return this.def.states[this.state] || {}; }

  _armAfter(now) {
    const after = this._stateDef().after;
    this.deadline = after ? now + Number(after.ms) : 0;
  }

  _enter(to, now, via, note) {
    const from = this.state;
    this.state = to;
    this.enteredAt = now;
    this.pending = null;
    this._armAfter(now);
    const effects = this._send ? [{ type: 'send', text: this._send, status: this.mode }] : [];
    this._send = null;
    const entry = { at: now, from, to, via, note: note || '', effects };
    this.trace.push(entry);
    if (this.trace.length > MAX_TRACE) this.trace.shift();
    return entry;
  }

  _fire(action, now, via) {
    const out = [];
    if (action.mark) {
      this.actions.push({ type: 'mark', label: action.mark, severity: action.severity || 'info', at: now, extra: action.extra });
    }
    if (action.send) {
      this.actions.push({ type: 'send', text: action.send, at: now });
      this._send = action.send;
      const m = action.expect ? compileMatcher(action.expect) : null;
      const onTimeout = action.onTimeout || null;
      const retries = onTimeout && Number.isInteger(Number(onTimeout.retry)) ? Number(onTimeout.retry) : 0;
      this.pending = {
        match: m,
        deadline: now + Number(action.waitMs || 2000),
        goto: action.goto,
        elseTo: action.else || null,
        note: action.mark || '',
        sendText: action.send,
        waitMs: Number(action.waitMs || 2000),
        attempt: 0,
        maxAttempts: retries,
        onTimeout,
      };
      return out;
    }
    if (action.goto) out.push(this._enter(action.goto, now, via, action.mark));
    return out;
  }

  /** Feed one decoded line. Returns the transitions it caused. */
  feedLine(text, now = Date.now()) {
    const out = [];
    if (this.pending) {
      const hit = this.pending.match && this.pending.match.kind === 'line' && this.pending.match.re.test(text);
      if (hit) {
        const { goto, note } = this.pending;
        out.push(this._enter(goto, now, 'expect', note));
        return out;
      }
    }
    const on = this._stateDef().on || {};
    for (const [key, action] of Object.entries(on)) {
      const m = compileMatcher(key);
      if (m.kind !== 'line' || !m.re.test(text)) continue;
      out.push(...this._fire(action, now, 'line:' + key));
      break;
    }
    return out;
  }

  event(name, now = Date.now()) {
    const on = this._stateDef().on || {};
    for (const [key, action] of Object.entries(on)) {
      const m = compileMatcher(key);
      if (m.kind !== 'event' || m.name !== name) continue;
      return this._fire(action, now, 'event:' + name);
    }
    return [];
  }

  /** Timers: pending expectation first, then the state's own after. */
  tick(now = Date.now()) {
    const out = [];
    if (this.pending && now >= this.pending.deadline) {
      const p = this.pending;
      const cfg = p.onTimeout || {};
      // Flexible timeout: resend first when the scenario asked for retries, then
      // fall back to whatever the scenario declared (mark / goto / stop).
      if (p.attempt < p.maxAttempts) {
        p.attempt += 1;
        p.deadline = now + p.waitMs + Number(cfg.retryDelayMs || 0);
        this.actions.push({ type: 'send', text: p.sendText, at: now });
        this.trace.push({ at: now, from: this.state, to: this.state, via: 'retry', note: '重发 ' + p.attempt + '/' + p.maxAttempts });
        return out;
      }
      this.pending = null;
      const label = cfg.mark || ('等待确认超时（' + this.state + '）');
      const severity = cfg.severity || (cfg.mark ? 'warn' : 'error');
      this.actions.push({ type: 'mark', label, severity, at: now });
      if (cfg.stop === true) {
        this.stopped = true;
        this.actions.push({ type: 'stop', at: now, reason: label });
        this.trace.push({ at: now, from: this.state, to: this.state, via: 'expect-timeout', note: 'stop: ' + label });
        return out;
      }
      const target = cfg.goto || p.elseTo;
      if (target) out.push(this._enter(target, now, 'expect-timeout', label));
      return out;
    }
    const after = this._stateDef().after;
    if (after && this.deadline && now >= this.deadline) {
      if (after.mark) this.actions.push({ type: 'mark', label: after.mark, severity: after.severity || 'info', at: now });
      out.push(this._enter(after.goto, now, 'after', after.mark || ''));
    }
    return out;
  }

  /** Drain side effects queued by transitions. */
  drainActions() {
    const out = this.actions;
    this.actions = [];
    return out;
  }

  status() {
    const on = this._stateDef().on || {};
    return {
      name: this.name,
      state: this.state,
      enteredAt: this.enteredAt,
      waitingFor: this.pending
        ? { deadline: this.pending.deadline, goto: this.pending.goto, attempt: this.pending.attempt, retries: this.pending.maxAttempts }
        : null,
      stopped: this.stopped,
      events: Object.keys(on).filter((k) => k.startsWith('event:')).map((k) => k.slice(6)),
      lines: Object.keys(on).filter((k) => k.startsWith('line:')),
      trace: this.trace.slice(-20),
    };
  }
}

/**
 * Offline run: feed recorded lines in time order and tick timers between them.
 * No I/O, no port — this is how a scenario is proven before touching hardware.
 */
export function simulate(def, lines, opts = {}) {
  const machine = new Machine(def, { simulated: true });
  const marks = [];
  const sends = [];
  const startAt = lines.length ? lines[0].t || 0 : Date.now();
  for (const line of lines) {
    const now = line.t || startAt;
    for (const t of machine.tick(now)) { /* trace already recorded */ }
    for (const action of machine.drainActions()) {
      if (action.type === 'send') sends.push({ at: now, text: action.text });
      if (action.type === 'mark') marks.push({ at: now, label: action.label, severity: action.severity, extra: action.extra });
    }
    machine.feedLine(line.text, now);
    for (const action of machine.drainActions()) {
      if (action.type === 'send') sends.push({ at: now, text: action.text });
      if (action.type === 'mark') marks.push({ at: now, label: action.label, severity: action.severity, extra: action.extra });
    }
  }
  const endAt = startAt + Math.max(0, Number(opts.tailMs) || 0);
  machine.tick(endAt);
  for (const action of machine.drainActions()) {
    if (action.type === 'mark') marks.push({ at: endAt, label: action.label, severity: action.severity });
  }
  return { state: machine.state, trace: machine.trace, marks, sends };
}
