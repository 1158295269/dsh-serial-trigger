# FSM scenarios

The state machine is the real-time layer: it owns the port while a run is active and
performs every send/expect/timeout step itself. The model only writes the scenario,
starts it, injects events and reads the trace.

## Where a scenario lives

- Inline object: `serial_fsm_start({ portId, scenario: { ... } })`.
- A file: `{ path: 'handshake.fsm.json' }` — must be `.json`, ≤ 256 KB, and under a
  configured workspace root (see [configuration.md](configuration.md#workspace-roots)).
  A relative path resolves against the workspace root, not the agent's cwd.

## Grammar

```json
{
  "name": "handshake",
  "initial": "idle",
  "states": {
    "idle": {
      "on": {
        "event:start": {
          "send": "PING\n",
          "expect": "line:/PING/",
          "waitMs": 800,
          "goto": "linked",
          "onTimeout": { "retry": 2, "retryDelayMs": 100, "goto": "recovering",
                         "mark": "no echo", "severity": "warn" }
        },
        "line:/^READY/": { "goto": "ready" }
      },
      "after": { "ms": 5000, "goto": "recovering", "mark": "no output", "severity": "warn" }
    },
    "ready": { "on": {} },
    "linked": { "on": {} },
    "recovering": { "on": {} }
  }
}
```

### Top level

| Field | Required | Meaning |
|---|---|---|
| `name` | no | Display name; defaults to `scenario` |
| `initial` | **yes** | Starting state; must exist in `states` |
| `states` | **yes** | Map of state name → state definition (non-empty) |

### A state

| Field | Meaning |
|---|---|
| `on` | Map of matcher key → transition action |
| `after` | `{ ms: >0, goto, mark?, severity? }` — fires when the state has been entered for `ms` without a transition |

A state with no `on` and no `after` is a terminal state.

### Matcher keys (`on`)

Exactly two forms:

| Key | Fires when |
|---|---|
| `event:<name>` | `serial_fsm_event({ runId, name })` injects that event while in this state (name: `[A-Za-z0-9_.-]+`) |
| `line:/<regex>/` | a decoded line from the port matches the JavaScript regex |

- `line:/.../` fires on **every** matching line, so a self-loop transition keeps
  firing for each HB line; do not attach a `send` to a repeating line matcher.
- Multiple line matchers are tried in object insertion order; the first hit wins.
- Matching happens on lines assembled with the `any` line-ending policy.

### Transition actions

| Field | Meaning |
|---|---|
| `send` | Bytes to write (string; append `\n` / `\r\n` yourself). Requires `expect`, `waitMs` and `goto` |
| `expect` | Matcher for the answer (same two forms; in practice only `line:/…/` — an `event:` expectation never fires) |
| `waitMs` | How long to wait for the answer after sending (> 0) |
| `goto` | State to enter when the expectation matches |
| `else` | Fallback state when the expectation times out (used when `onTimeout.goto` is absent) |
| `mark` | Optional label to log when the transition fires |
| `severity` | Severity for that mark: `info` (default) | `warn` | `error` |
| `extra` | Any JSON value carried into the mark's `extra` |
| `onTimeout` | Timeout policy, see below |

A non-send transition only needs `goto` (plus optional `mark`).

### `onTimeout`

| Field | Range | Meaning |
|---|---|---|
| `retry` | integer 0–10 | Resend the same payload this many times before giving up |
| `retryDelayMs` | ≥ 0 | Extra delay added to each retry deadline |
| `goto` | existing state | Where to go after giving up |
| `mark` | string | Mark label; default is `等待确认超时（<state>）` |
| `severity` | `info|warn|error` | Default: `warn` when a custom `mark` is given, otherwise `error` |
| `stop` | boolean | Stop the machine instead of continuing |

After the retries are exhausted the machine always records a mark, then applies
`stop` → `goto` → `else` in that order (first one set wins).

## Offline proof: `serial_fsm_simulate`

```js
serial_fsm_simulate({ captureId: 'COM8-…', scenario, tailMs: 10000 })
// → { state, trace, marks, sends }
```

- The clock is anchored at the **first recorded line**; timers are advanced between
  lines, and after the last line the clock keeps moving for `tailMs` so state-level
  `after` timers (including chained ones) can fire.
- No port is touched, no byte is sent: `sends` lists what *would* have been sent.
- **Events cannot be injected while simulating** — only `line:/…/` transitions and
  timers are exercised. Prove `event:` transitions live.
- Marks appear in the result but are not persisted.

## Live run

```js
const { runId, status } = serial_fsm_start({ portId, scenario })   // one machine per port
serial_fsm_event({ runId, name: 'start' })                          // inject event
serial_fsm_wait({ runId, timeoutMs: 5000 })                         // long-poll
serial_fsm_status({ runId })
serial_fsm_stop({ runId })                                          // → { stopped, persisted, trace }
```

- `start` requires the port to be open and owned by the caller (`E_NOT_OWNER`,
  `E_FSM_BUSY`).
- `status` is `{ name, state, enteredAt, waitingFor, stopped, events, lines, trace }`;
  `events`/`lines` are the matchers available **in the current state**.
- `serial_fsm_event` executes the transition action synchronously: the returned
  status may already reflect the send/expect outcome, and the next `fsm_wait` can
  return the same state. Use the returned `status.trace`, not "a wait returned" as
  proof of a new transition.
- `fsm_wait` only observes transitions that happen **after** it is registered; a
  transition completing before that is visible in `status.trace`.
- `stop` writes accumulated marks into the capture (`<capture>.marks/fsm-<scenario>.jsonl`,
  anchor `rx@0+0`) and reports `persisted` = number of marks written.
- The machine stops automatically when its port is closed, taken over, or the owning
  session ends; the `runId` then fails with `E_NO_SUCH_RUN`.

## Patterns

- **Handshake** — one `send` + `expect` + `goto`, with `onTimeout` retry → recovery
  state.
- **Heartbeat watchdog** — `line:/^HB /` self-loop into the current state, plus
  `after: { ms: 1500, goto: 'silent' }` to detect silence. Remember that re-entering
  the state resets `after`, so keep the loop on the same state or on a dedicated
  "beating" state.
- **Quiet timeout** — put `after` on a state with no self-loop; otherwise the timer
  keeps resetting.
- **Recovery** — `onTimeout: { retry: 2, retryDelayMs: 100, goto: 'recovering' }`,
  then a recovery state that retries the handshake on `event:retry`.

## Validation

`E_BAD_SCENARIO` is returned for structural mistakes, with an actionable message:

- unknown `goto`/`else`/`after.goto`/`onTimeout.goto` target;
- `initial` missing or not a state;
- a `send` without `expect`, `waitMs` or `goto`;
- an unparsable `line:/…/` regex;
- `retry` outside 0–10, negative `retryDelayMs`, bad severity;
- scenario file missing / outside the workspace / not `.json` / > 256 KB.
