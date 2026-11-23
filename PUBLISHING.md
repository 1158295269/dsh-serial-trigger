# Publishing

This is the maintainer's release checklist. The market indexes npm packages that
carry the `dsh-plugin` keyword, so **npm is the source of truth**.

## 1. Prepare

```bash
# 1.1 everything green
npm test
node bin/shell-check.mjs COM8       # optional, hardware
node bin/rules-check.mjs COM8       # optional, hardware

# 1.2 publish-readiness check (dsh-publisher-radar)
#     run radar_checkup on the plugin folder, expect verdict: pass
```

- Bump `version` in `package.json` (semver; docs-only changes still get a new version
  if they are released).
- Add a section to `CHANGELOG.md`.
- Confirm `files` still ships exactly: `src`, `client`, `cordis.patch.yml`,
  `SKILL.md`, `README.md`, `README.zh-CN.md`, `LICENSE`, `docs`, release docs.
- `npm pack --dry-run` and read the file list; nothing from `test/`, `bench/`, `bin/`,
  `node_modules/` may appear.

## 2. Tag

```bash
git add -A && git commit -m "chore(构建): 发布 vX.Y.Z"
git tag -a vX.Y.Z -m "dsh-serial-trigger vX.Y.Z"
```

Keep the tag on the exact commit that produced the tarball.

## 3. Publish

```bash
npm login                 # once per machine
npm publish               # runs prepublishOnly (unit tests) first
```

- Scoped packages need `publishConfig.access`; this package is unscoped and public.
- If `prepublishOnly` fails, nothing is uploaded.
- Verify afterwards: `npm view dsh-serial-trigger version` and install into a clean
  profile to confirm the mount and the panel.

## 4. Archive

Create a source archive for the tag (this repo keeps release artifacts outside the
working tree):

```bash
git archive --format=zip --prefix=dsh-serial-trigger-X.Y.Z/ vX.Y.Z -o release/dsh-serial-trigger-X.Y.Z.zip
npm pack --pack-destination release
```

## 5. Post-release

- Update the marketplace listing if the description/screenshots changed.
- Keep `CHANGELOG.md` and the version in sync; never move a published tag.
