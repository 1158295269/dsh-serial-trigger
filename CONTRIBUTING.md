# Contributing

Thanks for considering a contribution. This project values **evidence over taste**:
tests, hardware gates and real recordings settle arguments.

## Setup

1. Node.js ≥ 24, pnpm.
2. Install dependencies: `pnpm install`.
3. Link the working copy into a DSH profile to exercise it in the app:

   ```bash
   cd "$DSH_HOME/profiles/desktop"
   pnpm add link:/path/to/dsh-serial-trigger
   ```

   Restart DSH. The bundle patch mounts the plugin; the panel registers automatically.
4. Hardware (optional but encouraged): a USB-UART board that emits `HB <seq> <us>`
   lines and echoes what it receives. `bin/shell-check.mjs COM8` and
   `bin/rules-check.mjs COM8` are written for that firmware; `bin/fsm-check.mjs` is
   the FSM equivalent.

## Issues and pull requests

- Bug reports use the issue form: include the plugin/DSH versions, the error
  envelope and the `captureId` — never paste credentials or proprietary device logs.
- Pull requests use the template checklist; one logical change per PR.
- Security issues go through [SECURITY.md](SECURITY.md), not a public issue.
## Gates before a PR

```bash
npm test                       # 170 unit tests, must be green
node --test --test-force-exit test/tool-output.test.mjs   # tool boundary fast check
node bin/shell-check.mjs COM8  # hardware: byte transparency, handles, index
node bin/rules-check.mjs COM8  # hardware: scan/marks/bytes/sandbox guards
node --check client/client.js  # panel bundle syntax
```

The unit suite never opens a physical port: takeover/port-busy cases run on mock
ports. Hardware checks are the `bin/*-check.mjs` scripts, not `npm test`.

## Conventions

- **Language**: code, identifiers and comments in English; documentation may be
  Chinese; commit messages in Chinese or English are both accepted.
- **Commits**: conventional prefixes (`feat`, `fix`, `docs`, `test`, `refactor`,
  `perf`, `chore`), one logical change per commit, no rewriting merged history.
- **No new runtime dependencies without a discussion.** Current runtime deps: one
  (`serialport`). Everything else is Node built-ins.
- **No install-time lifecycle scripts** — scanners and the market flag them.
- **Keep the tool envelope lossless JSON**: no `undefined` fields, no `NaN`, no
  `Buffer`/class instances in a tool result.
- **Keep the invariants** in [docs/architecture.md](docs/architecture.md#invariants):
  one writer, lossless tap, reference-only marks, no model-initiated deletion.

## Review checklist

- [ ] Tests added/updated for the new behavior (both success and error envelope).
- [ ] Tool results remain lossless JSON (`tool-output.test.mjs` pattern).
- [ ] Ports are closed and machines stopped in `after` hooks; no leaked handles.
- [ ] Archival/dispose semantics unchanged (only archiving deletes recordings).
- [ ] Documentation updated: README, `docs/`, and `SKILL.md` if the model-facing
      contract changed.
- [ ] Hardware gates run if the change touches the serial path, tail or close.
- [ ] `npm pack --dry-run` still ships only the intended files.

## Scope

- **In scope**: reliability of capture/tail/scan/FSM, panel usability, error clarity,
  performance, tests, docs, host compatibility.
- **Out of scope by design**: a generic trigger engine, an in-plugin rule registry, an
  automatic wake-up of the model on a fault state (an optional future extension), a
  runtime settings editor.

## Security

See [SECURITY.md](SECURITY.md). Never commit real device logs or credentials; the test
suite uses temp directories and mock ports.
