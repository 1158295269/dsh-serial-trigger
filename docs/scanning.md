# Scan scripts and marks

A scan script is ordinary ESM in **your** repository. The plugin never stores,
registers or edits scripts: it reads a path, runs the file against a capture's byte
stream in a sandbox, and collects marks (byte references only).

## Where the script lives

Under a configured workspace root (see [configuration.md](configuration.md#workspace-roots)),
with extension `.mjs`, `.js` or `.cjs`. A relative path is resolved against the
workspace root — not the agent's cwd. If unsure, call `serial_scan` with a
non-existent path: the error message contains the resolved absolute path.

## Contract

```js
export function createScanner(ctx) {
  // ctx = { captureId, script } (absolute script path)
  return {
    record({ t, monoUs, dir, offset, data }) {
      // dir: 'rx' | 'tx'; offset: byte offset within that direction;
      // data: Buffer; t: wall-clock ms; monoUs: monotonic µs
      // return: one mark object | mark[] | null/undefined
      return { anchor: { dir: 'rx', offset, length: data.length }, t,
               kind: 'state', severity: 'info', label: 'saw ' + data.length + ' bytes' };
    },
    finish() {
      // optional; called after the last record; same return contract
      return null;
    },
  };
}
```

- The module **must export** `createScanner` (a missing `export` is a common
  `E_SCAN_FAILED`).
- The script is evaluated as an ES module; `import` is forbidden (`link()` throws).
  Inside the sandbox only `Buffer` and a no-op `console` exist — no timers, no
  filesystem, no network.
- Throw from `record`/`finish` and the whole scan fails with `E_SCAN_FAILED` and the
  thrown message.
- Return a single mark or an array; `null`/`undefined` means "nothing here".

## Mark fields

| Field | Required | Notes |
|---|---|---|
| `anchor` | **yes** | `{ dir: 'rx'|'tx', offset: integer ≥ 0, length?: integer }`; `length` defaults to 0 and is clamped to 1 MiB |
| `t` | recommended | Wall-clock ms. Pass `rec.t`; without it, the mark's time-window expansion yields nothing |
| `label` | recommended | Human label, ≤ 300 chars (alias: `title`) |
| `kind` | no | `'fault' | 'state' | 'note'` (default `'fault'`) |
| `severity` | no | `'error' | 'warn' | 'info'` (default `'warn'`) |
| `code` | no | `{ file, symbol }` — a guessed source location |
| `hypothesis` | no | ≤ 600 chars |
| `next` | no | Array (≤ 8) of `{ label, expect? }` — suggested next checks |
| `extra` | no | Any JSON value |
| `id` | no | Stable id; auto-derived from label/dir/offset so re-scans stay idempotent |

Marks without a valid `anchor.offset` are dropped during normalisation.

## Running and reading

```js
serial_scan({ captureId, script: 'hb-scan.mjs', label?, timeoutMs? })
// → { captureId, label, script, scannedBytes, marks: <count>, truncated, file }

serial_marks({ captureId, rule?, severity?, beforeMs?: 300, afterMs?: 1000 })
// → { captureId, count, sources, marks: [{ id, rule, anchor, t, kind, severity,
//      label, code?, hypothesis?, next?, window: { dir, offset, length } }] }

serial_bytes({ captureId, dir, offset, length ≤ 8192, format?: 'hex'|'text'|'base64' })
// → { dir, offset, length, truncated, body }
```

- `marks` in the scan result is a **count**; call `serial_marks` for the content.
- `window` expands each mark by `beforeMs`/`afterMs` of recording time; use it to
  pull context around a zero-length anchor.
- `serial_bytes` returns at most 8 KiB per call; `offset` is echoed as requested,
  `length` is the actual byte count, `truncated=true` means the file ended early.
  `hex` is the source of truth, `text`/base64 are conveniences.
- Marks are stored next to the capture: `<capture>.marks/<label>.jsonl`, one file
  per label, with a meta line recording the script path and scan time.
- Re-running the same script on the same capture is idempotent (stable ids); the
  plugin never re-runs a scan on its own — re-scan when the script changes.

## Limits and errors

| Limit | Value |
|---|---|
| Default timeout | 20 000 ms (`timeoutMs` can raise/lower it) |
| Marks per scan | 5 000 (then `truncated: true`) |
| Cancellation | the scan stops feeding and returns `E_SCAN_CANCELLED` |
| Script outside workspace | `E_SCRIPT_OUTSIDE_WORKSPACE` |
| Missing script file | `E_NO_SUCH_SCRIPT` |
| Script throws / bad contract | `E_SCAN_FAILED` |
| Timeout | `E_SCAN_TIMEOUT` |

## Notes from the field

- The capture starts at `serial_open`, so the **first line may be a partial line**;
  tolerate or drop it instead of treating it as a protocol error.
- Offsets are per direction (`rx` and `tx` each start at 0).
- The script sees RX/TX payload records only — not marks, gaps or status records.
- Keep memory bounded: stream from `record()` and emit marks as you go; a 100 MB
  capture is scanned in one pass.
- A device can stall the host (e.g. a 4.5 s wall-clock gap) while the device's own
  microsecond counter keeps advancing; comparing wall time with the device counter
  distinguishes "device silent" from "capture stalled".

## Example: heartbeat gaps

```js
export function createScanner() {
  let buf = Buffer.alloc(0);
  let start = 0;
  let prevSeq = null;
  let prevT = null;
  const marks = [];

  return {
    record({ t, dir, offset, data }) {
      if (dir !== 'rx') return null;
      if (!buf.length) start = offset;
      buf = Buffer.concat([buf, data]);
      const out = [];
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) break;
        const text = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
        const m = /^HB (\d+) (\d+)$/.exec(text);
        if (m) {
          const seq = Number(m[1]);
          if (prevSeq !== null && seq !== prevSeq + 1) {
            out.push({ anchor: { dir: 'rx', offset: start, length: nl + 1 }, t,
                       kind: 'fault', severity: 'error',
                       label: 'sequence gap ' + prevSeq + ' -> ' + seq,
                       code: { file: 'firmware', symbol: 'hb_tick' } });
          }
          prevSeq = seq;
        }
        buf = buf.subarray(nl + 1);
        start += nl + 1;
      }
      return out;
    },
    finish() {
      return { anchor: { dir: 'rx', offset: 0, length: 0 }, t: 0,
               kind: 'note', severity: 'info', label: 'scanned, last seq ' + prevSeq };
    },
  };
}
```
