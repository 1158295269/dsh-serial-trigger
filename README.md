# dsh-serial-trigger

[![CI](https://github.com/1158295269/dsh-serial-trigger/actions/workflows/ci.yml/badge.svg)](https://github.com/1158295269/dsh-serial-trigger/actions/workflows/ci.yml) · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [Docs](docs/README.md) · MIT

A DSH (DeepSeek Harness) plugin for real serial work: **lossless capture**, incremental tail, byte-level reverse lookup, workspace scan scripts that emit byte-referenced marks, and a **live FSM middleware** — so the model plans while the script keeps millisecond timing. 18 model-facing tools, a per-conversation panel, MIT licensed.

## Why

A model turn takes seconds; a UART timing window is often a few dozen milliseconds. Asking the model to read the port byte by byte is both slow and unreproducible. This plugin splits the job three ways:

| Layer | Owner | Responsibility |
|---|---|---|
| Real time | **FSM** (JSON scenario in your workspace) | send / expect / retry / fall back on timeout |
| Judgement | **Scan scripts** (ESM in your workspace, re-runnable) | find fault points in a recording, emit byte references |
| Planning | **The model** | open ports, gather evidence, inject events, read conclusions |

Every byte is written to a `.slog` container and indexed in SQLite, so a `captureId` can be re-examined as often as needed — after a context reset, next week, or on a colleague's machine.

## Features

- **Ports & capture** — `serial_ports / open / tail / send / close`. One writer per port; tool opens take over cleanly, the panel follows read-only.
- **Reverse lookup** — `serial_captures / grep / export`. Find a past session by project, time or keyword; export to text / hex / csv without touching the source.
- **Fault points** — `serial_scan / marks / bytes`. Scripts live in *your* repo (`createScanner(ctx)`); marks are `{dir, offset, length}` references only. Sandboxed: no imports, 20 s default timeout, cancellable, 5 000 marks max.
- **Live FSM** — `serial_fsm_simulate / start / event / wait / status / stop`. `line:/regex/` and `event:<name>` transitions, `send` must declare `expect + waitMs + goto` (never fire blind), `onTimeout` (retry / goto / mark / severity / stop), state-level `after` timers, one machine per port, offline `simulate` against a recording before touching hardware.
- **Panel** — a `串口` (Serial) tab inside the conversation: live terminal, RX/TX filter, search, line-ending switch, send box, statistics, history, marks, takeover state.
- **Ownership & cleanup** — recordings are tagged `origin=agent|human`; the model **cannot delete** recordings (`serial_cleanup` is read-only); only archiving a conversation removes its recordings.

## Panel

The panel is registered as a conversation-view tab (`串口`) beside `对话` and `轨迹`:

- **终端 (Terminal)** — live tail with auto-scroll, RX/TX/all filter, text search with match navigation, line-ending policy (`any / crlf / lf`), send box (text or hex), and a takeover banner when another holder owns the port.
- **统计 (Stats)** — throughput, byte counts, line count, capture metadata.
- **History** — list past captures of the workspace, open the decoded view, read marks, export.
- **Marks** — scan results with byte refs; click through to the exact bytes.

## Install

Requirements: DSH desktop (tested on `0.2.1-rc.2`), Node.js ≥ 24, and an OS driver for your USB-serial adapter.

1. Install into a DSH profile. Until the first npm release, install straight from
   GitHub (the package has no build step):

   ```bash
   cd "$DSH_HOME/profiles/desktop"      # the profile that should load it
   pnpm add github:1158295269/dsh-serial-trigger
   # later, once published:
   # pnpm add dsh-serial-trigger
   # or, while developing:
   # pnpm add link:/path/to/dsh-serial-trigger
   ```

2. Restart DSH. The package declares `dsh.bundle.patch`, so the host mounts `serial-trigger` from the package and registers the browser panel automatically (`dsh.client`).

3. Optional: override settings in the profile's `cordis.patch.yml` — the row merges into the bundle row with the same id:

   ```yaml
   - id: serial-trigger
     config:
       dataRoot: 'D:/serial-logs'
       replayRoots:
         - 'D:/device-logs'
   ```

4. Verify: open a conversation in DSH and look for the `串口` tab, or ask the agent to run `serial_ports`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `dataRoot` | `~/.dsh/serial-trigger/data` | Recording root (`.slog` files + `index.db`) |
| `replayRoots` | `[]` | Folders whose files may be replayed into a mock port |
| `ringBytes` | `8 MiB` | In-memory byte ring used by `tail` and live subscribers |
| `archivePollMs` | `2000` | How often the archived-session list is polled (archive deletes its recordings) |
| `workspaceRoot` | host process cwd | Fallback root for scan scripts and FSM scenarios |
| `scanRoots` | `[workspaceRoot]` | Explicit allow-list for scan scripts / scenarios |
| `rulesRoot` | `<workspaceRoot>/.serial/rules` | Conventional location for rule scripts |
| `dshHome` | `$DSH_HOME` | Where the desktop app keeps the archived-session list |

## Quick start

Tool results always use one envelope: success `{ok:true, data:{…}}`, failure `{ok:false, error:{code, message, hint, fix[], retryable}}`.

```js
serial_ports                                            // → ports[]
serial_open({ port: 'COM8', project: 'bringup' })       // → { portId, captureId, path }
serial_tail({ portId, timeoutMs: 3000 })                // → { lines[], cursor }
serial_send({ portId, text: 'PING', append: 'lf' })
serial_close({ portId })                                // → { path, bytesRx, bytesTx, lines }
```

Then find it again:

```js
serial_captures({ project: 'bringup', keyword: 'timeout' })
serial_grep({ captureId, pattern: 'ASSERT', context: 3 })
serial_export({ captureId, format: 'text' })
```

## Live FSM in one glance

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
      "after": { "ms": 5000, "goto": "recovering", "mark": "no output" }
    },
    "ready": { "on": {} },
    "linked": { "on": {} },
    "recovering": { "on": {} }
  }
}
```

`serial_fsm_simulate` proves the scenario against a recording (no port, no sends), `serial_fsm_start` runs it live, `serial_fsm_event` injects an event, `serial_fsm_wait` long-polls the next transition, `serial_fsm_stop` persists the marks. Full grammar: [docs/fsm.md](docs/fsm.md).

## Scan scripts in one glance

```js
// hb-scan.mjs — must live under the plugin's workspace root (see docs)
export function createScanner(ctx) {
  let prevSeq = null;
  return {
    record({ t, dir, offset, data }) {
      if (dir !== 'rx') return null;
      const text = data.toString('latin1');
      // ... parse lines, return one mark or an array of marks
      return { anchor: { dir: 'rx', offset, length: data.length }, t, kind: 'state',
               severity: 'info', label: 'HB ' + text.length + ' bytes' };
    },
    finish() { return null; },
  };
}
```

`serial_scan({ captureId, script }) → serial_marks({ captureId }) → serial_bytes({ captureId, dir, offset, length })`. Marks never carry text — only references. Full contract: [docs/scanning.md](docs/scanning.md).

## Data, ownership & privacy

- Recordings stay on the local machine under `dataRoot`; nothing is uploaded.
- One writer per port. A tool `serial_open` takes the port over cleanly; a non-owner can only read via `serial_tail` (writes/close return `E_NOT_OWNER`).
- The model cannot delete recordings. Only a human archiving a conversation deletes that conversation's recordings; recordings opened by a human in the panel are never auto-deleted.
- Scan scripts and FSM scenarios are ordinary files in your workspace, versioned by your git. The sandbox prevents imports and restricts file reads, but treat them as your own code.

## Compatibility

- DSH desktop: tested on `0.2.1-rc.2` (`engines.dsh`).
- Node.js: ≥ 24.
- OS: Windows 10/11 verified against real hardware; `serialport` 13 also supports macOS/Linux (not exercised by this repo's tests). Mock ports (`MOCK:<name>`) need no hardware.

## Development

```bash
npm test                              # 170 unit tests (~30 s)
node bin/shell-check.mjs COM8         # real-device gate: byte transparency, handles, index (7 checks)
node bin/rules-check.mjs COM8         # scan / marks / byte refs / sandbox guards (12 checks)
node bench/lag.mjs 50                 # throughput / latency benchmark
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the review checklist.

## Documentation

- [docs/README.md](docs/README.md) — index of the reference pages
- [docs/tools.md](docs/tools.md) — all 18 tools, parameters, returns, errors
- [docs/fsm.md](docs/fsm.md) — FSM scenario grammar and patterns
- [docs/scanning.md](docs/scanning.md) — scan-script contract, marks, sandbox
- [docs/configuration.md](docs/configuration.md) — settings, data layout, archival semantics
- [docs/panel.md](docs/panel.md) — the panel in daily use
- [docs/architecture.md](docs/architecture.md) — internals for contributors
- [docs/troubleshooting.md](docs/troubleshooting.md) — error codes and FAQ
- [SKILL.md](SKILL.md) — the compact, agent-facing manual the model loads

## Roadmap & limits

- No generic trigger engine and no automatic wake-up of the model on a fault state (*optional* future extension, not implemented).
- No automatic reconnect on a dropped device: re-open the port.
- Runtime settings changes require a DSH restart (config comes from the profile).

## License

[MIT](LICENSE) © 2026 luochaozheng
