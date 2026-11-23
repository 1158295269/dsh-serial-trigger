# Publishing

This is the maintainer's release checklist. The market indexes npm packages that
carry the `dsh-plugin` keyword, so **npm is the source of truth**.

## 0. GitHub first (recommended before npm)

1. Create an **empty** public repository `<owner>/dsh-serial-trigger` (no README,
   license or .gitignore — the working copy already has them).
2. Point the working copy at it and push the branch and tags:

   ```bash
   git remote add origin https://github.com/<owner>/dsh-serial-trigger.git
   git push -u origin main
   git push origin --tags
   ```

   The first HTTPS push opens Git Credential Manager for a browser sign-in; later
   pushes reuse the stored credential. SSH also works.
3. Fill the package metadata once the URL exists: `repository`, `homepage`, `bugs`
   in `package.json`, and add the CI badge to `README.md`.
4. Set repository topics for discoverability: `dsh-plugin`, `dsh`,
   `deepseek-harness`, `serial`, `serialport`, `uart`, `plugin`.
5. CI (`.github/workflows/ci.yml`) runs on every push/PR: Ubuntu + Windows, Node 24,
   `pnpm install --frozen-lockfile`, unit tests, panel syntax, `npm pack` shape.
6. Optional: create a GitHub Release from tag `vX.Y.Z` and attach the archives from
   the release folder (`git archive` zip + `npm pack` tarball).

Only after the repository is public and CI is green, continue with npm.

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
