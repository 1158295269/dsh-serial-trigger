# Documentation

Reference pages for **dsh-serial-trigger**. These pages are for humans; the compact
manual the model loads is [../SKILL.md](../SKILL.md).

| Page | What it covers |
|---|---|
| [tools.md](tools.md) | All 18 model-facing tools: parameters, return shapes, errors |
| [fsm.md](fsm.md) | FSM scenario grammar, timeout policy, simulate vs live, patterns |
| [scanning.md](scanning.md) | Scan-script contract, marks, sandbox limits |
| [configuration.md](configuration.md) | Settings, data layout, ownership, archival semantics |
| [panel.md](panel.md) | The `串口` conversation panel |
| [architecture.md](architecture.md) | Internals: codec, store, hub, service, client |
| [troubleshooting.md](troubleshooting.md) | Error codes and FAQ |

Conventions used here:

- Tool results always use the envelope `{ok:true, data}` / `{ok:false, error}`.
  Return shapes below are the contents of `data`.
- `portId` is a live handle; `captureId` is a recording's stable id (also its
  file basename).
- "Workspace root" means the scan/scenario allow-list (`scanRoots`), not the
  agent's cwd. See [configuration.md](configuration.md#workspace-roots).
