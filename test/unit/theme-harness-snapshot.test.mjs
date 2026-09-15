// The L1 snapshot gate must prove the file belongs to THIS run.
//
// The path is not run-scoped, and a failed or interrupted export leaves the
// previous run's file untouched. Treating existence as success made a stale
// snapshot from an earlier run get reported — with a fresh `capturedAt` and the
// bound theme id — as this run's revision-bound capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectSnapshot } from '../../scripts/theme-harness/live-published.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'th-snapshot-'));
  const repoRoot = path.join(root, 'repo');
  const themeDir = path.join(root, 'theme');
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(path.join(repoRoot, 'live-snapshots'), { recursive: true });
  fs.mkdirSync(themeDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  return { repoRoot, themeDir, evidenceDir, relativePath: 'live-snapshots/home.html' };
}

test('a snapshot written by this run is captured', () => {
  const f = fixture();
  const notBefore = Date.now();
  fs.writeFileSync(path.join(f.repoRoot, f.relativePath), '<html>fresh</html>', 'utf8');
  const result = collectSnapshot({ ...f, slug: 'home', notBefore });
  assert.equal(result.captured, true);
  assert.equal(fs.readFileSync(result.stagedPath, 'utf8'), '<html>fresh</html>');
});

test('a snapshot left by an earlier run is refused, not reported as this run', () => {
  const f = fixture();
  const target = path.join(f.repoRoot, f.relativePath);
  fs.writeFileSync(target, '<html>stale</html>', 'utf8');
  // An export that fails or never runs leaves the old file in place.
  const earlier = new Date(Date.now() - 60_000);
  fs.utimesSync(target, earlier, earlier);

  const result = collectSnapshot({ ...f, slug: 'home', notBefore: Date.now() });

  assert.equal(result.captured, false);
  assert.equal(result.stale.length, 1, 'the stale candidate is reported, not silently ignored');
  assert.match(result.stale[0].candidate, /home\.html$/);
  assert.equal(fs.existsSync(path.join(f.evidenceDir, 'snapshots', 'home.html')), false, 'nothing was staged');
});

test('a missing snapshot is reported as not captured', () => {
  const f = fixture();
  const result = collectSnapshot({ ...f, slug: 'home', notBefore: Date.now() });
  assert.equal(result.captured, false);
  assert.equal(result.sha256, undefined);
  assert.ok(result.searched.length > 0, 'the searched candidates are recorded');
});
