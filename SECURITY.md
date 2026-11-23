# Security policy

## Supported versions

Only the latest `0.3.x` release is supported with security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability. Report it
privately to the maintainer (or through the repository's security advisory flow if
one is enabled) and include: the version, a description, and a minimal reproduction.
You will get an acknowledgement and a coordinated fix window.

## Threat model and trust boundaries

This plugin runs inside the DSH host process and controls serial ports. What it does
and does not protect against:

**In scope**

- The plugin performs no network access and collects no telemetry. Recordings and the
  index stay under `dataRoot` on the local machine.
- The plugin ships no install-time lifecycle scripts (`preinstall`/`install`/`postinstall`/
  `prepare`/`prepack`); the published tarball carries only the files listed in
  `package.json#files`.
- It has a single runtime dependency (`serialport`).
- Scan scripts and FSM scenarios are executed as *your* code: the sandbox blocks
  imports, exposes only `Buffer` and a no-op console, runs in a child process with a
  read-only file permission model, and enforces a timeout and cancellability. **The
  sandbox is a blast-radius reducer, not a security boundary** — treat scripts from
  untrusted sources as untrusted code and review them before running.
- The model-facing surface cannot delete recordings; deletion is a human action
  (archiving a conversation).

**Out of scope**

- A compromised DSH host or a compromised OS account.
- Devices that misbehave electrically (the plugin only reports what the OS driver
  delivers).
- Information recorded from a device: logs may contain sensitive data and are stored
  as plain files under `dataRoot` — protect that directory with OS permissions.
- Files chosen for replay via `replayRoots`: the whitelist limits which folders may
  be read, but the files themselves are trusted content.

## Hardening checklist for operators

- Keep `dataRoot` on a local disk with OS-level access control for recordings that may
  contain secrets.
- Review scan scripts like any other executable code (they live in your repo).
- Treat `replayRoots` as a read allow-list: add only folders you own.
