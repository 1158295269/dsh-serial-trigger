# The `串口` panel

The panel is a conversation-view tab (next to `对话` and `轨迹`, labelled `串口`).
It talks to the same service as the tools, so what the model records and what the
panel shows cannot diverge. The UI language is Chinese; the labels below are quoted
as they appear.

## Terminal (`终端`)

- Live tail of the current port with auto-scroll; the stream is the same lossless
  byte stream that is being recorded.
- **RX / TX / 全部** filter chips.
- **Search** over the visible lines with match navigation.
- **Line-ending policy**: `any` / `crlf` / `lf` — changes only how the UI splits
  lines, never what is recorded.
- **Send box**: text or hex, with an appended ending (`none / CR / LF / CRLF`).
- **Takeover banner**: when the model (or another session) owns the port, the panel
  shows the holder and keeps working read-only.

## Stats (`统计`)

Throughput, received/sent byte counters, line count, capture metadata (port, baud,
start time, file path), and the current capture id.

## History

Past captures of the current workspace: filter by project/time/keyword, open the
decoded view, inspect marks and byte ranges, and export to text/hex/csv.

Replay (feeding a recorded file into a mock port at a chosen speed) exists on the
plugin's HTTP API for tooling, but is not a panel button — the model's tool surface
does not expose it either.

## Marks

Scan results attached to a capture. Each mark carries a byte reference
(`dir, offset, length`) plus severity/label/code/hypothesis; clicking a mark jumps
to the referenced bytes in the decoded view.

## Permissions

| Action | Rule |
|---|---|
| view, tail, marks, captures, bytes | visible to everyone |
| open a busy port | `E_PORT_BUSY` (the panel can take over explicitly) |
| send / close | owner only; the panel cannot bypass the single-writer rule |
| after a takeover | the old page learns `E_PORT_REPLACED` and offers to reopen |
