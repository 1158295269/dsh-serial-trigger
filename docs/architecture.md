# Architecture

The plugin is a DSH (cordis) plugin plus a browser panel. It has no build step: the
browser bundle is committed and loaded through the host's module loader.

## Module map

| File | Responsibility |
|---|---|
| `src/index.mjs` | Cordis mount: settings, store, hub, service, tools, panel HTTP routes, lifecycle hooks |
| `src/api.mjs` | HTTP routes consumed by the panel (`/serial/*`) |
| `src/codec.mjs` | `.slog` container: header, record framing, append-only writer, tolerant reader |
| `src/store.mjs` | SQLite index (`captures`), capture files, marks, cleanup plans, catalog rebuild/recover |
| `src/hub.mjs` | Pub/sub topics over a byte ring: `serial.stream`, `serial.status`, `serial.capture` (plus reserved topics) |
| `src/lines.mjs` | Line assembly policies: `any`, `crlf`, `lf`; incremental UTF-8 decoder |
| `src/service.mjs` | Ports, tail cursors, send, close, capture reads, marks, bytes, cleanup, FSM runs |
| `src/fsm.mjs` | Scenario validation, `Machine`, offline `simulate` |
| `src/rules.mjs` + `src/sandbox-child.cjs` | Scan runner: script loading, sandbox child, mark normalisation |
| `src/identity.mjs` | `callId` → session mapping so tool calls carry an owner |
| `src/serial-backend.mjs` | `serialport` wrapper, error mapping, mock ports |
| `src/replay.mjs` | Replay a recording into a mock port (HTTP API only) |
| `src/paths.mjs` | `ioPath` long-path/CJK-safe file IO |
| `src/tools.mjs` | The 18 model-facing tools and their envelopes |
| `client/client.js` | Browser panel (module-loader bundle) |
| `bin/` | Hardware gates (`shell-check`, `rules-check`, `fsm-check`) and developer probes |
| `bench/` | Throughput, latency, RSS, soak benchmarks |

## Data flow

```
device ──onData──▶ serial-backend ──publishData──▶ hub ──┬── tap ──▶ store Writer ──▶ .slog
                                                         ├── tail cursor / panel stream
                                                         └── FSM subscriber ──▶ Machine
close ──▶ writer.close ──▶ digest ──▶ index.db row
```

The tap runs inline in the publish path (not as a subscriber), so a burst can never
be dropped because a reader was slow. Readers get their own ring cursors; a slow
reader is told about the gap instead of silently losing bytes.

## Invariants

1. **One writer per port.** Ownership is `{kind:'session'|'agent', id}`; takeover is
   explicit and flushes the previous capture.
2. **The recording is the same bytes the reader sees.** `bin/shell-check.mjs` verifies
   stream sha256 against the file (byte transparency), handle stability and index rows.
3. **Marks are references, never text.** `serial_marks` returns `dir/offset/length`;
   `serial_bytes` materialises them.
4. **The model cannot delete recordings.** `serial_cleanup` is read-only; only
   archiving a conversation deletes its recordings.
5. **Tool results are lossless JSON.** The host rejects `undefined`, non-finite
   numbers, Buffers, class instances, sparse arrays and cycles. `test/tool-output.test.mjs`
   guards this boundary — it has caught real bugs (missing `seq`, `extra: undefined`).
6. **No hidden state in tools.** Every tool maps to a service method that is covered
   by `test/*.test.mjs`; `node --test` is the gate.

## Lifecycle

- Mount: `store.open()` + `recover()` (rebuild/flag from the tree), archive watcher
  (mount reconcile + poll of `storages/workspace.json`), tool registration, HTTP routes.
- `session/disposed`: close the session's ports and machines; **do not** delete
  recordings (a sub-agent finishing is also a dispose).
- `archive`: delete the archived conversation's recordings (the only automatic
  deletion).
- Plugin `dispose`: stop the watcher, close all ports, flush captures.

## Extending it

- **A new tool**: add it in `src/tools.mjs` (parameters + execute + envelope), the
  behavior in `src/service.mjs`/`src/store.mjs`, and a test that asserts both the
  success and error envelopes are lossless JSON.
- **A new panel view**: `client/client.js` mounts into a conversation tab; keep the
  API calls flowing through `src/api.mjs` so panel and tools share one service.
- **A new record kind**: define it in `src/codec.mjs`, make `scanCapture` ignore it
  unless needed, and add a codec roundtrip test.
- **A new setting**: read it in `src/index.mjs`, thread it into the service, document
  it in [configuration.md](configuration.md), and keep the default safe.

## Tests

| Area | Files |
|---|---|
| Container / recovery | `codec*.test.mjs` |
| Store / index / export | `store.test.mjs`, `p0.batch2.test.mjs`, `p1.test.mjs` |
| Hub / backpressure | `hub.test.mjs` |
| Line policies | `line-modes.test.mjs`, `edges.test.mjs` |
| Service / ports / tail | `service.p0.test.mjs`, `port-busy.test.mjs`, `e2e.test.mjs` |
| Scan scripts / sandbox | `scan.test.mjs` |
| FSM | `fsm.test.mjs`, `fsm-runtime.test.mjs`, `fsm-timeout.test.mjs` |
| Lifecycle / archive | `lifecycle.test.mjs`, `cleanup.test.mjs`, `identity.test.mjs` |
| Tool boundary | `tool-output.test.mjs`, `api.test.mjs`, `bundle.test.mjs`, `entry.test.mjs` |
| Hardware | `bin/shell-check.mjs`, `bin/rules-check.mjs` (COM port required) |
