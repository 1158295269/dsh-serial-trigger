# Troubleshooting

Every tool failure returns `{ "ok": false, "error": { code, message, hint, fix[], retryable } }`; a call never throws. Read `hint` and `fix` first, then use this table. Per-tool shapes are in [tools.md](tools.md).

## Error codes

| Code | When it happens | What to do |
|---|---|---|
| `E_INVALID_ARGS` | A parameter is missing or malformed: neither `text` nor `hex` (or both), odd hex digits, `length` > 8192, bad `format`, scan script not `.mjs`/`.js`/`.cjs` or larger than 1 MB, missing id/name. | Fix the argument and retry; schemas are closed (no extra keys). |
| `E_INTERNAL` | Unexpected exception, including plain errors the service wraps: invalid grep regex, unknown text encoding, corrupt `.slog` (message names `E_BAD_MAGIC`/`E_SHORT_HEADER`/`E_RECORD_TOO_LARGE`), invalid JSON in a scenario file. | Retry once. If the message names a file, inspect/rebuild it (files are the source of truth, the index is disposable); report a repeat. |
| `E_PORT_NOT_FOUND` | Unknown `portId`; a live-FSM start on a port that is not open; `serial_open` name does not exist or the device was unplugged. | `serial_ports`, check the cable and exact name, then `serial_open`. |
| `E_PORT_NOT_OPEN` | Send on a port that is `closed`, `draining` or in `error`. | Open it again; a dropped device needs a fresh `serial_open` (no auto-reconnect). |
| `E_PORT_BUSY` | The OS handle is held by another program (SSCOM, a vendor tool, a stale process). Tool opens do not produce this for competing conversations. | Close that program or pick another port; retryable. |
| `E_NOT_OWNER` | Close, send or live-FSM start on a port owned by another conversation. | Read-only via `serial_tail`; to write, take over with `serial_open` (the old capture closes cleanly). |
| `E_PORT_REPLACED` | Close on a `portId` that a takeover already closed. | Use the current `portId` from `serial_ports`; re-open if you still need the device. |
| `E_PERMISSION` | The driver refused access (Windows access-denied variant that is not a busy port). | Replug the device or try another USB port. |
| `E_OPEN_FAILED` | The driver rejected the connection for any other reason. | `serial_ports`, replug, retry. |
| `E_OPEN_TIMEOUT` | Opening did not settle within 4 s. | Replug the device and retry. |
| `E_SERIAL_UNAVAILABLE` | The `serialport` native binding is missing. | Install the plugin dependency, or use a `MOCK:` port for logic tests. |
| `E_NO_SUCH_CAPTURE` | Unknown, deleted or mistyped `captureId`. | `serial_captures({keyword})` first; ids are `.slog` filename stems. |
| `E_CAPTURE_BUSY` | Deleting a capture that is still recording (panel/archive paths). | `serial_close` the port first, then delete. |
| `E_CAPTURE_IO` | Export or delete hit a filesystem error: read-only folder, disconnected drive, file locked by another program. | Choose another `out` path, close the locking program, retry. |
| `E_NO_SUCH_PLAN` | An internal cleanup plan id is unknown or expired (`applyCleanup`; not reachable from the tool surface). | Produce a fresh plan with `serial_cleanup`; plans are short-lived. |
| `E_READ_ONLY` | `serial_cleanup` was passed a `planId`. | The tool only reports; deletion is a human/archival decision. |
| `E_SCRIPT_OUTSIDE_WORKSPACE` | The scan script resolves outside `scanRoots`/`workspaceRoot`. | Move it under the absolute root named in the message; relative paths resolve against the host process cwd. |
| `E_NO_SUCH_SCRIPT` | The scan script path is missing or is a directory. | Write the file first and pass a file path. |
| `E_SCAN_FAILED` | The script threw, failed to load (syntax error, no `createScanner`, or no `record` on its result), or exited before the capture was fully fed. | Read the sandbox message, fix the script, re-run. |
| `E_SCAN_TIMEOUT` | The scan exceeded `timeoutMs` (default 20000). | Raise `timeoutMs` or fix an unbounded loop; retryable. |
| `E_SCAN_CANCELLED` | The tool call was aborted. | Nothing was written; re-run if still needed. |
| `E_BAD_SCENARIO` | Scenario validation failed: missing `initial`/`states`, unknown `goto`, `send` without `expect`/`waitMs`/`goto`, bad `onTimeout`/`after`, wrong extension or > 256 KB file. | Fix the scenario per the message; validate with `serial_fsm_simulate` first. |
| `E_NO_SUCH_SCENARIO` | The scenario file does not exist. | Check the path, or pass the scenario as an inline object (no file checks). |
| `E_SCENARIO_OUTSIDE_WORKSPACE` | The scenario file is outside the workspace roots. | Move it under the root named in the message, or inline it. |
| `E_FSM_BUSY` | The port already runs a live machine. | `serial_fsm_stop` the existing `runId` first (one machine per port). |
| `E_NO_SUCH_RUN` | The `runId` expired or was stopped: port closed/taken over, session ended, already stopped. | `serial_fsm_start` again; a `runId` is never reusable. |

Panel HTTP routes (`/serial/*`) have three extra codes that never appear in tool results: `E_NOT_FOUND` (404), `E_METHOD` (405), `E_INVALID_JSON` (400).

## FAQ

### The port is "busy" - who is holding it?

Three separate cases. Another conversation: a tool `serial_open` always takes over silently; the old holder can still `serial_tail` read-only and its close returns `E_PORT_REPLACED`. Another program: the only source of `E_PORT_BUSY` - close that program. The panel's read-only badge means this conversation does not own the port; reads work, writes/close/FSM need ownership (take over with `serial_open`).

### serial_tail returns nothing, or replays old lines

Without a cursor it returns the newest `maxLines` of the last 262144 bytes; `cursor: 0` starts at the oldest byte still in the 8 MiB ring. Anything older is gone from the ring - use `serial_grep` on the capture. `pending` is an unfinished line, not loss. `timeoutMs > 0` long-polls and returns as soon as data arrives. Keep the returned `cursor` across calls and context compaction; it is a byte count, not a line number.

### serial_grep finds nothing in a capture that is still open

The writer buffers up to 1 MiB before flushing, so disk readers (`grep`, `scan`, `export`, `marks`) only see flushed bytes. `serial_close` first, or watch the live edge with `serial_tail`. Zero hits is a valid answer, not an error. After a context reset, recover the id with `serial_captures` rather than guessing.

### Where must scan scripts live, and what can they do?

Under a configured scan root - by default the plugin's `workspaceRoot`, which is the host process cwd (on DSH desktop usually `<user>/.dsh/profiles/desktop`), not the conversation folder; relative paths resolve against that cwd, and the resolved absolute path is printed in the error message. Sandbox: no imports, no filesystem, only `Buffer` and a no-op `console`; 20 s default timeout; 5000 marks cap; cancelled with the tool call.

### Why does my scenario fail validation?

`initial` and a non-empty `states` are required and `initial` must name a state; every `goto`/`else`/`onTimeout.goto`/`after.goto` must reference a declared state; a `send` requires `expect` + `waitMs > 0` + `goto`; `after.ms` must be positive; `onTimeout.retry` is 0..10; matcher keys are exactly `event:<name>` or `line:/regex/`. File scenarios must be `.json`, at most 256 KB, under the workspace roots; inline objects skip path checks but not validation.

### When should I use serial_fsm_simulate instead of live?

Simulate first: it never opens a port, never sends, cannot inject `event:` transitions, anchors its clock at the first recorded line and only advances `tailMs` past the last one - ideal for proving expectations, retries and `after` chains against a real capture. Live adds wall-clock timing, real sends and event injection, but needs port ownership, one machine per port, and its `runId` dies with the port or session.

### Who owns a recording, and who can delete it?

`origin` is fixed at open: `agent` for tool opens, `human` for panel opens. `serial_cleanup` is read-only; by default it plans only agent captures (`skippedHuman` counts the rest), `includeHuman: true` widens the report, and nothing is ever deleted from the tool surface (`E_READ_ONLY` if you pass a `planId`). Closing a session or shutting down the host only stops FSM runs and closes/flushes ports. Recordings live under `<dataRoot>/<project>/`; `captureId` is the filename stem (Windows reserved names get a leading `_`, e.g. `COM8` -> `_COM8-...`).

### What exactly does archiving a conversation delete?

The plugin watches `<DSH_HOME>/storages/workspace.json` -> `global.archivedSessionIds` (2 s default; the first read reconciles archives made while the host was down). For each newly archived session it stops that session's FSM runs, closes the ports it owns, then deletes every capture whose index row carries that `session_id` (each delete bounded at 5 s). `origin` is not consulted on this path, so a panel-opened recording of that conversation goes too. Archiving is the only automatic deletion; a disposed session keeps its evidence.
