# Configuration and data

## Settings

Settings are supplied by the DSH profile (`cordis.patch.yml`) and merged into the
bundle row with id `serial-trigger`:

```yaml
- id: serial-trigger
  config:
    dataRoot: 'D:/serial-logs'
    replayRoots: ['D:/device-logs']
    archivePollMs: 2000
```

| Key | Default | Meaning |
|---|---|---|
| `dataRoot` | `~/.dsh/serial-trigger/data` | Recording root: `.slog` files and `index.db` |
| `replayRoots` | `[]` | Folders whose files may be replayed into a mock port (panel/API, read-only whitelist) |
| `ringBytes` | `8 << 20` | In-memory byte ring backing `serial_tail` and live subscribers |
| `archivePollMs` | `2000` | Poll interval for the host's archived-session list (see below) |
| `workspaceRoot` | host process cwd | Fallback allow-list root for scan scripts and FSM scenarios |
| `scanRoots` | `[workspaceRoot]` | Explicit allow-list; when set, it wins over `workspaceRoot` |
| `rulesRoot` | `<workspaceRoot>/.serial/rules` | Conventional location for rule scripts (the plugin never enforces it) |
| `dshHome` | `$DSH_HOME` | Where the desktop app keeps `storages/workspace.json` |

Unknown keys are ignored. Changing settings requires a DSH restart (the plugin is
mounted from the profile at startup).

## Data layout

```
<dataRoot>/
├─ index.db                          # SQLite: one row per capture
└─ <project>/
   ├─ <port>-<YYYYMMDD-HHMMSS>.slog  # one capture per (project, port, session)
   ├─ <same>.marks/                  # created by scans: one .jsonl per rule label
   └─ <same>-<format>.<ext>          # exports (text/hex/csv)
```

- `captureId` is the file basename, e.g. `_COM8-20261123-095407`.
- A leading underscore appears when the port name collides with a Windows reserved
  device name (`COM1`…`COM9`, `LPT1`, `CON`…), so `COM8` becomes `_COM8`.
- Port names are sanitised for the filesystem (`/dev/ttyUSB0` → `ttyUSB0`).
- A second capture on the same port in the same second gets a `-2` suffix.
- `.slog` is append-only: 64-byte header (magic `DSHSLOG1`, port, baud, created-at)
  followed by records `{payloadLen, tMonoUs, tWallMs, kind, flags, bytes}`.
  A crash leaves a partial trailing record; recovery truncates it and marks the
  row `truncated=1`.
- `index.db` stores project/conversation/session, timing, byte counts, line count,
  digest (first/last 20 lines + error histogram) for cheap keyword lookup. Deleting
  `index.db` is safe: the catalog is rebuilt from the tree on the next start.

## Workspace roots

Scan scripts and FSM scenario files must live under an allow-listed root:

1. `scanRoots` when configured, else
2. `workspaceRoot`, else
3. the host process's current working directory (in the desktop app that is the
   profile directory, e.g. `~\.dsh\profiles\desktop`).

A relative script path resolves against that same root, **not** against the agent's
conversation directory. If you are unsure, call `serial_scan` with a path that does
not exist: the error message contains the resolved absolute path.

## Ownership

- A port has exactly one writer. The writer is identified by `{kind:'session'|'agent', id}`.
- The panel and the model share the port: whoever opens it owns it; the other side
  can `serial_tail` read-only.
- Tool `serial_open` takes over an owned port: the previous capture is closed
  cleanly (flushed, indexed) and its holder gets `E_PORT_REPLACED` on next use.
- `serial_close` / `serial_send` by a non-owner return `E_NOT_OWNER`; the library
  path supports `force:true` (not exposed to the model).

## Recording ownership and deletion

- `origin=agent` for captures opened through tools, `origin=human` for captures
  opened in the panel.
- **The model cannot delete recordings.** `serial_cleanup` only returns a retention
  plan; passing a plan id fails with `E_READ_ONLY`.
- Deleting recordings is a human action:
  - archiving a conversation deletes all recordings attributed to it (the plugin
    watches `<dshHome>/storages/workspace.json` → `global.archivedSessionIds`
    on mount and every `archivePollMs`);
  - closing a conversation, finishing a sub-agent session, or quitting the app
    **does not** delete recordings;
  - human-origin recordings are never auto-deleted.
- A single file delete has a 5 s timeout; a stuck file is kept and logged.

## Replay (HTTP API only)

Files under `replayRoots` can be fed into a mock port at a chosen speed through the
plugin's HTTP API (`POST /serial/replay`), which is useful for UI/tooling work without
hardware. It is **not** a panel button and **not** a model tool; recordings are the
model's source of truth.
