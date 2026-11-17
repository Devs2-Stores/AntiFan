import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { forbiddenInTree, isPackaged, packagerIgnore, PRIVATE_ROOTS, privateRootsLeaking } from '../../scripts/lib/package-allowlist.mjs';
import { checkPackageTree } from '../../scripts/check-package-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('runtime files ship', () => {
  for (const p of ['', '/package.json', '/main.cjs', '/scripts/launch-guard.cjs', '/.compiled', '/.compiled/.tsbuildinfo', '/.compiled/src', '/.compiled/src/main/index.js', '/packages/super-core/dist/index.js', '/node_modules/ws/index.js', '/assets/icon.png', '/extension/manifest.json']) {
    assert.equal(isPackaged(p), true, p);
  }
});

test('private roots and stray files never ship', () => {
  for (const name of PRIVATE_ROOTS) {
    assert.equal(isPackaged(`/${name}`), false, name);
    assert.equal(isPackaged(`/${name}/x.db`), false, name);
  }
  for (const p of ['/.compiled/test/a.js', '/.compiled/scripts/a.js', '/.tmp-af-hub-audit/x', '/.goal-test-a/x', '/loop-results.tsv', '/src/main/index.ts', '/docs/a.html', '/node_modules/node-pty/prebuilds/darwin-arm64/pty.node', '/scripts/x.d.ts']) {
    assert.equal(packagerIgnore(p), true, p);
  }
});

test('guard: every private root that exists on this repo is excluded', () => {
  assert.deepEqual(privateRootsLeaking((n) => fs.existsSync(path.join(ROOT, n))), []);
  assert.deepEqual(privateRootsLeaking(() => true), []);
});

test('forbiddenInTree flags private data but not node_modules words', () => {
  assert.deepEqual(forbiddenInTree(['/main.cjs', '/node_modules/tokenizer/token-list.json', '/.compiled/src/main/secret-store.js']), []);
  assert.deepEqual(forbiddenInTree(['/data/fake.db', '/.super-core/x', '/exports/session.har', '/a/auth-token.json']).length, 4);
});

test('checkPackageTree fails on a seeded fake.db and on growth, passes clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgtree-'));
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'x'.repeat(1000));
  const baselinePath = path.join(dir, 'baseline.json');
  const clean = checkPackageTree({ appDir: dir, baselinePath, listPackage: () => ['/main.cjs', '/package.json'] });
  assert.equal(clean.ok, true);
  const dirty = checkPackageTree({ appDir: dir, baselinePath, listPackage: () => ['/main.cjs', '/fake.db'] });
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.bad, ['/fake.db']);
  fs.writeFileSync(baselinePath, JSON.stringify({ asarBytes: 100 }));
  assert.equal(checkPackageTree({ appDir: dir, baselinePath, listPackage: () => [] }).grew, true);
});

test('checkPackageTree creates a missing baseline and says so instead of passing vacuously', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgtree-base-'));
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'x'.repeat(500));
  const baselinePath = path.join(dir, 'baseline.json');
  const first = checkPackageTree({ appDir: dir, baselinePath, listPackage: () => ['/main.cjs'] });
  assert.equal(first.baselineCreated, true);
  assert.equal(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).asarBytes, 500);
  assert.equal(checkPackageTree({ appDir: dir, baselinePath, listPackage: () => ['/main.cjs'] }).baselineCreated, false);
});
