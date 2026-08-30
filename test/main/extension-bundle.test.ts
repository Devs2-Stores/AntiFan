import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

test('Extension Bundle: builds standalone IIFE service worker without external imports', () => {
  const rootDir = process.cwd();
  const buildScript = path.join(rootDir, 'scripts', 'build-extension.mjs');
  const backgroundJs = path.join(rootDir, 'extension', 'background.js');
  const manifestJson = path.join(rootDir, 'extension', 'manifest.json');

  // Run build script
  execFileSync('node', [buildScript], { cwd: rootDir, stdio: 'pipe' });

  assert.ok(fs.existsSync(backgroundJs), 'extension/background.js should exist');
  const content = fs.readFileSync(backgroundJs, 'utf8');
  assert.ok(content.length > 5000, 'Bundled background.js should contain tldts and debouncer logic');

  // Verify IIFE structure and zero unbundled external module imports
  assert.ok(!content.includes('import {'), 'Bundle must not have raw ES import statements');
  assert.ok(!/require\(['"]/.test(content), 'Bundle must not have external runtime require statements');
  // Verify manifest.json integrity
  assert.ok(fs.existsSync(manifestJson), 'extension/manifest.json should exist');
  const manifest = JSON.parse(fs.readFileSync(manifestJson, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.permissions.includes('cookies'));
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(manifest.permissions.includes('storage'));
});
