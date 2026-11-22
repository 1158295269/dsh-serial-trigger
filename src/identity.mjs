/**
 * callId -> session identity.
 *
 * Tool calls made through the PTC runtime arrive without any agent/session in
 * their exec context, so the plugin cannot tell which conversation opened a
 * port. The host does emit `session/event` for every appended event, including
 * `tool/call` and `tool/ptc-dispatch`; remembering those call ids is enough to
 * map a nested binding call back to its conversation.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const calls = new Map();

export function rememberCall(callId, sessionId) {
  if (!callId || !sessionId) return;
  calls.set(String(callId), { sessionId: String(sessionId), at: Date.now() });
  if (calls.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, value] of calls) {
    if (now - value.at > TTL_MS || calls.size > MAX_ENTRIES) calls.delete(key);
    if (calls.size <= MAX_ENTRIES) break;
  }
}

/** The session that issued this tool call, or null when the host never told us. */
export function sessionOfCall(callId) {
  if (!callId) return null;
  const key = String(callId);
  const direct = calls.get(key);
  if (direct && Date.now() - direct.at <= TTL_MS) return direct.sessionId;
  // Nested PTC bindings append suffixes such as ":ptc:1" to the outer call id.
  const cut = key.indexOf(':');
  if (cut > 0) {
    const outer = calls.get(key.slice(0, cut));
    if (outer && Date.now() - outer.at <= TTL_MS) return outer.sessionId;
  }
  return null;
}

export function forgetCallsOfSession(sessionId) {
  if (!sessionId) return;
  for (const [key, value] of calls) if (value.sessionId === String(sessionId)) calls.delete(key);
}

/** Test hook: drop everything. */
export function resetCalls() { calls.clear(); }
