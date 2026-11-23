## What

<!-- One paragraph: what changes and why. -->

## Checklist

- [ ] Tests added/updated (success **and** error envelope).
- [ ] Tool results remain lossless JSON (no `undefined`/`NaN`/`Buffer`).
- [ ] Ports closed and FSM runs stopped in test teardown; no leaked handles.
- [ ] Archival/dispose semantics unchanged (only archiving deletes recordings).
- [ ] Docs updated: `README`, `docs/`, and `SKILL.md` when the model-facing contract changed.
- [ ] Hardware gates run if the serial path changed (`node bin/shell-check.mjs COM8`, `node bin/rules-check.mjs COM8`).
- [ ] `npm pack --dry-run` still ships only intended files.

## Test evidence

<!-- Commands run and their summary lines. -->
