# Tool reference

`dsh-serial-trigger` v0.3.12 exposes 18 model-facing tools. A call never throws; it returns one envelope:

```json
{ "ok": true, "data": { } }
```

A failure carries `{ "ok": false, "error": { code, message, hint, fix[], retryable } }`. Everything below describes the contents of `data`. Parameter schemas are closed (`additionalProperties: false`), so unknown keys are rejected. Live tools take a `portId` (one writer per port), capture tools a `captureId` (a `.slog` file), FSM tools a `runId`. Codes are explained in [troubleshooting.md](troubleshooting.md).

## Ports and the live stream
### serial_ports

List ports this plugin instance knows: every port it has opened, including entries it already closed, plus configured mock ports. No parameters. Returns `{ ports: [...] }`; each entry is `{ portId, port, baudRate, state, captureId, path, bytesRx, bytesTx, owner: { kind, id }, idleForMs }` for opened devices, `{ portId: null, port, friendlyName, baudRate: null, state: "available", captureId: null, bytesRx: 0, bytesTx: 0 }` for an unopened mock or enumerated-but-not-opened port, or the same open-entry shape for mock ports held open.
`state` is `open` / `draining` / `closed` / `error`; closed entries stay listed, so filter on `state === "open"`. A physical device never opened by this instance is not enumerated; call `serial_open` with its name or use the panel port picker. `idleForMs` measures time since the last tail/send, not since the last received byte.

Errors: `E_INTERNAL`.
### serial_open

Open a serial or `MOCK:` port and start a lossless capture. A tool open always takes over an existing open: the old capture is closed cleanly, the old holder's `portId` answers `E_PORT_REPLACED` on close, and its `serial_tail` keeps working read-only.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `port` | string | yes | - | `COM3`, `/dev/ttyUSB0` or `MOCK:name` (no driver needed) |
| `baudRate` | number | no | `115200` | |
| `project` | string | no | `"default"` | capture folder under `dataRoot`; sanitized for the filesystem |
| `conversation` | string | no | `"session"` | indexed; searchable through `serial_captures.keyword` |
| `sessionId` | string | no | `""` | traceability only; the calling session identity wins when the host supplies one |

Returns `{ portId, captureId, path, kind }`; `kind` is `serial` or `mock`. File layout: `<dataRoot>/<project>/<port>-<YYYYMMDD-HHMMSS>.slog`; `captureId` is the filename stem, and Windows reserved device names get a leading underscore (`COM8` becomes `_COM8-...`). The record is owned by the calling conversation. There is no auto-reconnect: a dropped device is opened again with a new `captureId`.

Errors: `E_INVALID_ARGS`, `E_PORT_BUSY` (the OS handle is held by another program), `E_PERMISSION`, `E_PORT_NOT_FOUND`, `E_OPEN_FAILED`, `E_OPEN_TIMEOUT`, `E_SERIAL_UNAVAILABLE`.
### serial_close

Close the port, flush the recording to disk and report totals. Also stops any live FSM bound to the port.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `portId` | number | yes | - | from `serial_open` / `serial_ports` |

Returns `{ portId, captureId, path, bytesRx, bytesTx, lines }`, or `{ portId, already: true }` for an already closed/draining port. Big recordings can take seconds to flush; on a tool timeout check `serial_ports` before retrying. Only the owner may close and this tool has no `force`: to end someone else's capture, `serial_open` the port (takeover) instead.

Errors: `E_NOT_OWNER`, `E_PORT_NOT_FOUND`, `E_PORT_REPLACED`.
### serial_tail

Incremental read of the live stream: new lines after a byte cursor plus the next cursor.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `portId` | number | yes | - | |
| `cursor` | number | no | latest window | byte cursor from the previous call; omit to read the newest lines of the ring window |
| `maxLines` | number | no | `200` | maximum lines returned |
| `timeoutMs` | number | no | `0` | `> 0`: long-poll until a line arrives or the timeout expires |
| `lineEnding` | string | no | `"any"` | `any` (CR, LF, CRLF), `crlf` or `lf` |

```json
{ "portId": 2, "cursor": 1742,
  "lines": [ { "t": 1763861325123, "seq": 0, "text": "READY", "dir": "rx", "partial": false } ],
  "pending": { "text": "HB 1 ", "seq": 1742, "partial": true }, "droppedBytes": 0,
  "head": 1742, "state": "open", "bytesRx": 1742, "bytesTx": 0, "startedAt": 1763861325000 }
```

`cursor` is a byte sequence, not a line number; pass it back unchanged. Omitted cursor means "what just happened": at most the last 262144 bytes, keeping the newest `maxLines`; pass `cursor: 0` to replay from the oldest byte still in the 8 MiB ring. `pending` is an unterminated fragment, not loss; a fragment longer than 8192 characters is emitted as a `partial` line. Each `lineEnding` keeps its own assembler, so switching modes mid-stream discards the previous mode's carry. `droppedBytes` is always 0 here; a cursor far behind `head` means the ring may have overwritten bytes - read history from the capture.

Errors: `E_PORT_NOT_FOUND`.
### serial_send

Write bytes to the port. TX is recorded in the capture and appears in `serial_tail` with `dir: "tx"`.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `portId` | number | yes | - | must be open and owned by the caller |
| `text` | string | one of two | - | encoded as UTF-8 |
| `hex` | string | one of two | - | even number of hex digits, whitespace allowed (`1b 5b 41`) |
| `append` | string | no | `"none"` | `none` / `cr` / `lf` / `crlf` |

Returns `{ portId, bytes }`, where `bytes` is the payload length after the line ending. `text` and `hex` are mutually exclusive. Most devices treat input as a line only with a terminator (`append: "lf"` or `"crlf"`). Reads are open to everyone, writes are owner-only; take over with `serial_open` to write.

Errors: `E_INVALID_ARGS`, `E_PORT_NOT_FOUND`, `E_PORT_NOT_OPEN`, `E_NOT_OWNER`, `E_INTERNAL` (driver write failure).

## Capture history
### serial_captures

Find past recordings. This is the recovery call after a context reset.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `project` | string | no | all | matches the sanitized project folder exactly |
| `since` | number | no | - | start time, epoch ms, inclusive |
| `until` | number | no | - | end time, epoch ms, inclusive |
| `keyword` | string | no | - | substring over digest, conversation and port |
| `limit` | number | no | `20` | newest first |

```json
{ "captures": [ { "id": "COM8-20261123-102500", "project": "default", "conversation": "session", "session_id": "s-1",
  "port": "COM8", "baud": 115200, "path": "...", "started_ms": 1763861325000, "ended_ms": 1763861400000,
  "bytes_rx": 1742, "bytes_tx": 12, "lines": 42, "truncated": 0, "missing": 0, "origin": "agent",
  "digest": "{\"first\":[...],\"last\":[...],\"errors\":{...}}" } ] }
```

The row exists from `serial_open` onwards; while recording, `ended_ms` is null and the counters are 0 until close. `digest` is a JSON string computed at close (first/last lines, error-keyword histogram). `missing: 1` marks an index row whose file disappeared; those rows are hidden by default. `origin` is `agent` for tool opens and `human` for panel opens.

Errors: `E_INTERNAL`.
### serial_grep

Regex search inside one recording, with line numbers, direction, wall time and context.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `captureId` | string | yes | - | |
| `pattern` | string | yes | - | JavaScript regex, compiled case-insensitive |
| `context` | number | no | `2` | leading context lines per hit |
| `maxHits` | number | no | `50` | stop reading after this many hits |

Returns `{ captureId, count, hits }`; each hit is `{ line, seq, tWallMs, dir, text, before: [{ line, text }] }`. `line` counts assembled lines in recorded (RX/TX interleaved) order, `seq` is the direction's byte offset, `text` is clipped to 400 characters, context lines to 200. Only flushed bytes are searched: an open capture may miss up to the last 1 MiB of its write buffer, so `serial_close` first (or use `serial_tail` for the live edge). 0 hits is a valid result.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_CAPTURE`, `E_INTERNAL` (invalid regex).
### serial_export

Render a recording to a readable file; the source `.slog` is never modified.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `captureId` | string | yes | - | |
| `format` | string | no | `"text"` | `text` / `hex` / `csv` |
| `timestamps` | boolean | no | `true` | prefix text lines with `[HH:MM:SS.mmm]` |
| `encoding` | string | no | `"utf-8"` | `utf-8` / `gbk` / `latin1` |
| `out` | string | no | next to source | `<stem>.txt`, `<stem>-hex.txt` or `<stem>-csv.csv` |

Returns `{ path, format, bytes, lines }`. Text prefixes TX lines with `>> `; the CSV header is `time_iso,mono_us,dir,kind,text,hex`; `hex` is a 16-byte-per-row dump. Only flushed bytes are exported.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_CAPTURE`, `E_CAPTURE_IO`.

## Fault points
### serial_scan

Run a workspace scan script over one recording and store its fault points.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `captureId` | string | yes | - | |
| `script` | string | yes | - | `.mjs`/`.js`/`.cjs` file inside the workspace root |
| `label` | string | no | script basename | mark file name; matched by `serial_marks.rule` |
| `timeoutMs` | number | no | `20000` | wall-clock budget for the whole scan |

Returns `{ captureId, label, script, scannedBytes, marks, truncated, file }`; `marks` is a count and `scannedBytes` is the byte volume fed to the script. The script is an ES module exporting `createScanner(ctx)` that returns `{ record(rec), finish?() }`: `record` gets `{ t, monoUs, dir, offset, data }` (`data` is a `Buffer`) and returns a mark, an array of marks, or nothing; `finish()` may add summary marks. Sandbox: no imports, no filesystem, only `Buffer` and no-op `console`; 20 s default timeout; 5000 marks cap (`truncated: true`); killable when the call is cancelled. Scripts must resolve under `scanRoots` (default: the plugin's workspace root, not necessarily the conversation folder); relative paths resolve against the host process cwd. Re-scanning the same capture with the same script is idempotent: mark ids derive from label, direction, offset and text.

Errors: `E_INVALID_ARGS`, `E_SCRIPT_OUTSIDE_WORKSPACE`, `E_NO_SUCH_SCRIPT`, `E_NO_SUCH_CAPTURE`, `E_SCAN_FAILED`, `E_SCAN_TIMEOUT`, `E_SCAN_CANCELLED`.
### serial_marks

Read stored fault points. Marks are byte references, never text.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `captureId` | string | yes | - | |
| `rule` | string | no | all | mark file name, e.g. `hb-scan` or `fsm-<scenario>` |
| `severity` | string | no | all | `error` / `warn` / `info` |
| `beforeMs` | number | no | `300` | expand the window this far before `t` |
| `afterMs` | number | no | `1000` | expand the window this far after `t` |

```json
{ "captureId": "COM8-20261123-102500", "count": 1,
  "sources": [ { "type": "meta", "label": "hb-scan", "script": "...", "scannedAt": 1763861400000 } ],
  "marks": [ { "id": "mk-1a2b3c4d5e", "rule": "hb-scan",
    "anchor": { "dir": "rx", "offset": 164, "length": 8 }, "t": 1763861325123, "kind": "fault",
    "severity": "warn", "label": "no HB for 2s", "code": { "file": "fw.c", "symbol": "hb" },
    "hypothesis": "...", "next": [ { "label": "check power", "expect": "HB" } ],
    "window": { "dir": "rx", "offset": 120, "length": 96 } } ] }
```

Mark fields: `anchor {dir (rx/tx), offset, length}` (offset required, length 0 = a point), `label` (300 chars), `kind` (`fault`/`state`/`note`), `severity` (`error`/`warn`/`info`), `t`, optional `code {file, symbol}`, `hypothesis`, `next [{label, expect?}]`, `extra`. Malformed marks are dropped by the scanner. `window` is added on read: the anchor widened over every record of the same direction inside `[t - beforeMs, t + afterMs]`, so `serial_bytes` with `window.offset`/`window.length` returns context.

Errors: `E_NO_SUCH_CAPTURE`.
### serial_bytes

Materialize the raw bytes behind a reference.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `captureId` | string | yes | - | |
| `dir` | string | no | `"rx"` | `rx` or `tx` |
| `offset` | number | yes | - | direction byte offset (same space as `tail.seq`) |
| `length` | number | yes | - | 1..8192; call again for the next range |
| `format` | string | no | `"hex"` | `hex` / `text` / `base64` |
| `encoding` | string | no | `"utf-8"` | used by `text` only |

Returns `{ dir, offset, length, format, truncated, body }`. `offset` echoes the requested start, `length` is the number of bytes actually read, `truncated: true` means the file ended before the range was filled. `hex` (truth) is a 16-byte-per-row dump addressed by absolute offset; `text` is a convenience decode.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_CAPTURE`, `E_INTERNAL` (unknown encoding).

## State machine
`serial_fsm_*` share one scenario format: plain JSON, inline or as a workspace file.

```json
{
  "name": "handshake",
  "initial": "idle",
  "states": {
    "idle": { "on": {
      "event:start": { "send": "PING\n", "expect": "line:/PING/", "waitMs": 800, "goto": "linked",
        "onTimeout": { "retry": 2, "retryDelayMs": 100, "goto": "recovering", "mark": "no echo", "severity": "warn" } },
      "line:/^READY/": { "goto": "ready" } },
      "after": { "ms": 5000, "goto": "recovering", "mark": "no output", "severity": "warn" } },
    "ready": { "on": {} }, "linked": { "on": {} }, "recovering": { "on": {} }
  }
}
```

- `initial` and a non-empty `states` are required; `initial` must name a state. `name` defaults to `"scenario"` and names the persisted mark file.
- Transition keys are matchers: `event:<name>` (`[A-Za-z0-9_.-]+`) or `line:/regex/`.
- An action is a plain `{ "goto": "state" }`, or a send: `send` (non-empty) + `expect` (matcher) + `waitMs` (greater than 0) + `goto`. Optional `else` (timeout target), `mark`, `severity`, `extra`.
- `onTimeout`: `retry` 0..10, `retryDelayMs` 0 or more, `goto`, `mark`, `severity` (`info`/`warn`/`error`), `stop` (boolean). Without `onTimeout` an unanswered expectation emits the default error mark, then follows `else` if the transition declared one (otherwise it stays in place).
- State-level `after` is `{ "ms": <positive>, "goto": "state", "mark"?, "severity"? }`; re-entering a state restarts its timer (a self-loop cancels a quiet timeout).
- Every `goto`/`else`/`onTimeout.goto`/`after.goto` must name a declared state and `expect` must compile, or validation fails with `E_BAD_SCENARIO`.
- A scenario file must be `.json`, at most 256 KB, under the workspace roots; an inline object bypasses path checks.
### serial_fsm_start

Start a live machine on an open port.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `portId` | number | yes | - | must be open and owned by the caller |
| `scenario` | object | yes | - | inline scenario, or `{ "path": "...fsm.json" }` |

```json
{ "runId": "fsm-1", "mode": "live", "portId": 2,
  "status": { "name": "handshake", "state": "idle", "enteredAt": 1763861325000, "waitingFor":
    { "deadline": 1763861325800, "goto": "linked", "attempt": 0, "retries": 2 },
    "stopped": false, "events": ["start"], "lines": ["line:/^READY/"],
    "trace": [ { "at": 1763861325000, "from": "idle", "to": "idle", "via": "event:start",
      "note": "", "effects": [ { "type": "send", "text": "PING\n", "status": "executed" } ] } ] } }
```

Status shape, shared by all FSM tools: `{ name, state, enteredAt, waitingFor, stopped, events, lines, trace }`; `waitingFor` is null or `{ deadline, goto, attempt, retries }`; `events`/`lines` list what the current state accepts; `trace` holds the last 20 transitions (`at, from, to, via, note`, plus `effects` for sends). One live machine per port (`E_FSM_BUSY`). It starts at the current stream head, so bytes received before `start` are not replayed; it feeds decoded lines (`any` ending) and ticks timers every ~250 ms. It stops automatically when the port is closed, taken over, or the owning session ends - the `runId` then answers `E_NO_SUCH_RUN`.

Errors: `E_INVALID_ARGS`, `E_BAD_SCENARIO`, `E_SCENARIO_OUTSIDE_WORKSPACE`, `E_NO_SUCH_SCENARIO`, `E_PORT_NOT_FOUND`, `E_NOT_OWNER`, `E_FSM_BUSY`.
### serial_fsm_simulate

Prove a scenario offline against a recording. No port is touched, no bytes are sent.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `captureId` | string | yes | - | |
| `scenario` | object | yes | - | same format as `serial_fsm_start` |
| `tailMs` | number | no | `0` | advance the clock this far past the last recorded line |

Returns `{ captureId, mode: "simulate", state, trace, marks, sends }`; `marks` are `{ at, label, severity, extra? }` and `sends` are `{ at, text }`. The clock is anchored at the first recorded line; `tailMs` extends past the last line and chained `after` timers fire inside that window (up to 1000 timer steps). `sends` records what would have been sent - nothing is written to the port or capture. Event injection does not exist offline, so `event:` transitions cannot be exercised. Reads at most 200000 lines from the flushed `.slog`.

Errors: `E_INVALID_ARGS`, `E_BAD_SCENARIO`, `E_SCENARIO_OUTSIDE_WORKSPACE`, `E_NO_SUCH_SCENARIO`, `E_NO_SUCH_CAPTURE`.
### serial_fsm_event

Inject `event:<name>` into the running machine.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `runId` | string | yes | - | |
| `name` | string | yes | - | event name without the `event:` prefix |

Returns `{ runId, status, marks }`. If the current state registers no such event, the call succeeds and nothing transitions - check `status.events` first. Actions execute synchronously, so the returned status may already include the send and the expectation step; `marks` are the in-memory marks of this run.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_RUN`.
### serial_fsm_wait

Long-poll for the machine's next status notification.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `runId` | string | yes | - | |
| `timeoutMs` | number | no | `5000` | clamped to at least 50 |

Returns `{ runId, status, marks }`. The call always waits (up to `timeoutMs`) for the next runtime notification - a transition, a timeout retry/mark, or the periodic timer drain. Compare `status.state` and `status.trace` with your previous snapshot; an unchanged status means nothing happened. Transitions that happened before the call are not replayed - read `status.trace` instead.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_RUN`.
### serial_fsm_status

Snapshot one run.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `runId` | string | yes | - | |

Returns `{ runId, portId, alive, marks, status }`. `marks` are this run's in-memory marks (persisted only by `serial_fsm_stop`). A run is removed on stop, so a retrievable run is alive.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_RUN`.
### serial_fsm_stop

Stop the machine and persist its marks into the recording's `.marks` folder.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `runId` | string | yes | - | |

Returns `{ runId, stopped: true, persisted, trace }`. `persisted` is the number of marks written to `<capture>.marks/fsm-<scenario>.jsonl` (anchor `{dir: "rx", offset: 0, length: 0}`, kind `state`, severity from the mark (`info` when unset)). `trace` is the full machine trace (up to 500 entries). The run is gone afterwards; closing the port stops the run too, but then the `runId` is already expired.

Errors: `E_INVALID_ARGS`, `E_NO_SUCH_RUN`.

## Retention
### serial_cleanup

Read-only retention report: what a cleanup policy would delete. It never deletes anything.

| Param | Type | Req | Default | Notes |
|---|---|---|---|---|
| `dryRun` | boolean | no | `true` | accepted for compatibility; the tool is always read-only |
| `olderThanDays` | number | no | `0` | `0` = no age limit |
| `keepLast` | number | no | `0` | keep the newest N captures, consider the rest |
| `project` | string | no | all | restrict to one project folder |
| `includeHuman` | boolean | no | `false` | `false` = only agent captures are in scope |

Returns `{ planId, dryRun: true, count, skippedHuman, scope, bytes, items, truncated }`; each item is `{ captureId, project, bytes, startedMs }`. Victims are origin-`agent` captures (with `includeHuman: true`: `scope: "all"`) sorted newest first: the newest `keepLast` are spared, then only captures older than `olderThanDays` remain. `bytes` sums received bytes; `items` lists the first 50; `truncated` says there are more. `skippedHuman` counts human-origin captures left out. The `planId` is informational - passing it back is refused with `E_READ_ONLY`; deletion is a human/archival decision.

Errors: `E_READ_ONLY`, `E_INTERNAL`.
