# Changelog

All notable changes to **dsh-serial-trigger** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release is a
git tag `vX.Y.Z` on `main`; the sections below are headed with the tag, dated by the
tag's commit, and ordered newest first. Entries are curated from the commit history and
cover changes users can observe in the plugin, its model-facing tools, the web panel, the
documentation and the npm packaging. Internal refactors and test-only changes are omitted.
The top section (`0.3.12`) is the current unreleased development version — documentation
and release preparation, not tagged yet. Untagged intermediate versions are folded into the
next tagged release, and the affected section notes it.

## 0.3.12 - 2026-11-23 (unreleased)

### Added

- GitHub release scaffolding: a CI workflow (Ubuntu + Windows, Node 24: install,
  unit tests, panel syntax, `npm pack` shape), issue forms, a pull-request template,
  `.gitattributes` line-ending policy and `.editorconfig`.
- `CHANGELOG.md` — the full release history from v0.1.0 onwards, in Keep a Changelog
  format, so upgrade notes live in one place.
- `docs/` — a human documentation set indexed by `docs/README.md`, with a tool reference
  and guides for FSM scenarios, scan scripts, configuration, the serial panel and the
  internals.
- Community and release documents: `CONTRIBUTING.md`, `PUBLISHING.md` and `SECURITY.md`
  for contributors, maintainers and vulnerability reports.

### Changed

- Repository metadata now points at the public GitHub repository (`repository`,
  `homepage`, `bugs`), and both READMEs carry the CI badge and a GitHub-install
  path for the pre-npm period.
- npm packaging prepared for the release: the `files` list now ships `docs/`,
  `CHANGELOG.md`, `README.zh-CN.md` and the community documents, and the package declares
  a `dsh` engine floor next to `node >= 24`.

### Documentation

- README rewritten as the English-first landing page: links to the Simplified Chinese
  translation (`README.zh-CN.md`), the changelog, `docs/` and the MIT license, plus
  refreshed requirements, install and troubleshooting notes.

## v0.3.11 - 2026-11-23

### Added

- MIT `LICENSE` and public-release packaging: the package is no longer `private`,
  metadata (`license`, `author`, `keywords`, `publishConfig.access: public`) is in
  place, the `files` list covers exactly the publishable assets, and `prepublishOnly`
  runs the test suite.
- Public `README.md` covering install, configuration, capabilities, development and
  boundaries, as the repository entry point.

### Changed

- Development-only material — SPEC, TESTPLAN, HANDOFF, AUTOMATION, GIT, the mockups and
  `probe.mjs` — was moved out of the repository (git history is kept).

### Fixed

- `serial_bytes` returns byte-range offsets exactly as requested instead of re-aligning
  them; recording statistics now store `bytes_rx` and `bytes_tx` separately, so
  per-direction byte counts are real.
- `src/index.mjs` now forwards `workspaceRoot` / `scanRoots` to `SerialService`,
  fixing the broken configuration chain for scan-script and FSM workspace roots.

### Documentation

- `SKILL.md` finalized for v0.3.11: byte-offset semantics, per-direction statistics,
  `mark.t` and event synchronization.

## v0.3.10 - 2026-11-23

### Fixed

- `serial_tail` called without a cursor now returns the latest lines instead of an empty
  result.
- Live FSM `enteredAt` is set correctly on state entry, so the state timing reported by
  `serial_fsm_status` is accurate.

### Documentation

- `SKILL.md` aligned with v0.3.10: the `{ok, data}` result envelope, tail semantics,
  live-run warm-up and acceptance criteria, with wording polished after acceptance.

## v0.3.9 - 2026-11-23

_Covers the untagged 0.3.6, 0.3.7 and 0.3.8 increments, released together as v0.3.9._

### Fixed

- Tool results now carry all serializable fields, and closing a session no longer deletes
  that session's recordings.
- `serial_bytes` `truncated` now means "reached end of file", replacing the previous
  ambiguous meaning.
- Scan scripts accept a single mark, and `serial_fsm_simulate` clock handling and
  `tailMs` are corrected.
- Scenario files load reliably, and chained timers run correctly in `serial_fsm_simulate`.

### Documentation

- `SKILL.md` rewritten as the model-facing usage manual (v0.3.5 baseline) and aligned
  through 0.3.8 — ESM exports, scenario files, chained timers, persisted semantics — then
  registered as a DSH skill.
- Blind-run acceptance protocol added after four verification rounds; the v0.3 feature
  freeze is recorded and v0.4 is re-scoped to FSM fault-state wake-up.

## v0.3.5 - 2026-11-22

### Fixed

- Recording ownership is passed in explicitly instead of being inferred from the port
  owner, fixing captures attributed to the wrong origin.
- Archival follows the host's archive list, and recordings belonging to an archived
  conversation are actually deleted.

### Documentation

- v0.3.5 hand-off and real-device smoke results recorded; the v0.4 trigger-orchestration
  decision checklist added.

## v0.3.4 - 2026-11-22

### Added

- Archiving a conversation now triggers cleanup of its recordings, and tool calls are
  attributed to their conversation through `callId`, so the right recording set is
  matched.

### Changed

- `serial_cleanup` is read-only: the model can inspect a cleanup plan but can no longer
  delete recordings.

## v0.3.3 - 2026-11-22

### Added

- Configurable FSM timeout policy: a transition may declare `onTimeout` with `retry`,
  `retryDelayMs`, `goto`, `mark`, `severity` and `stop`; retries resend the
  request before falling back, and live runs no longer swallow timeout resends or stops.

### Changed

- Cleanup is recording-origin aware: captures opened by a tool are `agent`, captures
  opened from the panel are `human`; `serial_cleanup` removes only agent recordings by
  default, reports how many human recordings it skipped, and `includeHuman` is the
  explicit override. Older indexes are migrated so existing captures count as `human`.

## v0.3.2 - 2026-11-22

### Added

- `serial_cleanup` tool: dry run by default, returning the planned count, bytes and the
  first 50 candidates; deletion is only allowed by passing the `planId` from a plan.
- Scans can be cancelled when the tool call is aborted, and tool identity accepts the
  host's Agent object as well as an id string, keeping ownership checks working.

### Fixed

- Selecting a port in the panel clears a stale "taken over" marker.

## v0.3.1 - 2026-11-22

### Added

- FSM query and event-injection HTTP routes, plus a state-machine card in the panel showing
  status, event buttons and a stop action.

### Changed

- Single-writer ownership: opening a port from a model tool takes it over automatically,
  tool calls carry the caller identity, and the panel is read-only while another holder owns
  the port and follows a takeover.
- FSM scenarios are restricted to the workspace, and traces label transitions as
  `simulated` or `executed`.

### Fixed

- Repeated opens of the same port are refused, and closing a port validates the holder.

## v0.3.0 - 2026-11-21

### Added

- Fault points: a rule engine scans a recording on demand and stores marks as byte
  references, and the panel lists fault points with a rescan entry.
- Port ownership and takeover: ports have owners, their lifetime follows the owning session
  or host, and the port list exposes the owner.
- The serial panel became a conversation-scoped view: it no longer takes the main slot,
  fits its container height and hides the conversation input while open.
- First version of the live FSM middleware with JSON scenarios and send/expect transitions.

### Changed

- Scan rules were replaced by workspace ESM scan scripts read by path; a rescan reuses the
  script recorded in the mark.

### Fixed

- Large-file scans no longer block the host, and the port list returns `owner` so the
  "occupied" badge is accurate.

## v0.1.0 - 2026-11-21

### Added

- Initial release of the DSH serial plugin: lossless `.slog` capture with a SQLite index,
  a pub/sub byte stream, and the `serial_ports / open / close / tail / send` tools.
- Reverse lookup and export: `serial_captures`, `serial_grep` and `serial_export` find
  past sessions by project, time or keyword and export them without touching the source.
- Web panel with a virtualised live terminal in text or HEX, statistics, search,
  line-ending switch and a send box.
- Line-mode decoding (`any / crlf / lf`) and a `cordis.patch.yml` bundle patch, so the
  plugin mounts in a DSH profile with no build step.
