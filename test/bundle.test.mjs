import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('B1 package.json declares a bundle patch and a web client', () => {
  assert.ok(pkg.dsh, 'dsh field missing');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.exports['.'], 'main export missing');
  assert.ok(pkg.exports['./client'], 'client export missing');
});

test('B2 the patch inserts the host entry by relative path', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: serial-trigger/);
  assert.match(patch, /name: '\.\/src\/index\.mjs'/);
});

test('B3 the client bundle registers the expected module id', async () => {
  const src = await readFile(join(root, 'client', 'client.js'), 'utf8');
  assert.match(src, /__ModuleLoader__\.load\(/);
  assert.match(src, /id: 'dsh-serial-trigger'/);
  assert.match(src, /sidebar\.panellist/);
  assert.match(src, /exports\.apply = apply/);
});

test('B4 the entry exports name/inject/apply', async () => {
  const mod = await import(pathToFileURL(join(root, 'src', 'index.mjs')).href);
  assert.equal(mod.name, 'serial-trigger');
  assert.deepEqual(mod.inject, ['tools']);
  assert.equal(typeof mod.apply, 'function');
});


test('B5 the client never double-prefixes API paths', async () => {
  const src = await readFile(join(root, 'client', 'client.js'), 'utf8');
  const bad = [...src.matchAll(/api\('[A-Z]+',\s*'\/serial\//g)].map((m) => m[0]);
  assert.equal(bad.length, 0, 'found ' + bad.length + ' call(s) that would become /serial/serial/...');
});
