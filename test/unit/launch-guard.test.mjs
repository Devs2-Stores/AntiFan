import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inspectCompiledBundle } = require('../../scripts/launch-guard.cjs');

const longAgoMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const recentMs = Date.UTC(2026, 0, 2, 0, 0, 0);

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-launch-guard-'));
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const bundlePath = path.join(root, '.compiled', 'src', 'main', 'index.js');
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  return { root, srcDir, bundlePath };
}

function setMtime(filePath, whenMs) {
  fs.utimesSync(filePath, new Date(whenMs), new Date(whenMs));
}

describe('launch guard compiled-bundle freshness', () => {
  it('reports a missing bundle so the launcher builds instead of failing to resolve the module', () => {
    const { root, srcDir, bundlePath } = makeWorkspace();
    try {
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;', 'utf8');
      const result = inspectCompiledBundle({ bundlePath, sourceRoots: [srcDir] });
      assert.strictEqual(result.state, 'missing');
      assert.strictEqual(result.bundleMtimeMs, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a stale bundle when a source file is newer than the compiled entry', () => {
    const { root, srcDir, bundlePath } = makeWorkspace();
    try {
      fs.writeFileSync(bundlePath, '// compiled', 'utf8');
      setMtime(bundlePath, longAgoMs);
      const sourceFile = path.join(srcDir, 'nested', 'index.ts');
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(sourceFile, 'export const x = 2;', 'utf8');
      setMtime(sourceFile, recentMs);

      const result = inspectCompiledBundle({ bundlePath, sourceRoots: [srcDir] });
      assert.strictEqual(result.state, 'stale');
      assert.strictEqual(result.newestInputMs, recentMs);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a stale bundle when the tsconfig is newer than the compiled entry', () => {
    const { root, srcDir, bundlePath } = makeWorkspace();
    try {
      fs.writeFileSync(bundlePath, '// compiled', 'utf8');
      setMtime(bundlePath, longAgoMs);
      const sourceFile = path.join(srcDir, 'index.ts');
      fs.writeFileSync(sourceFile, 'export const x = 3;', 'utf8');
      setMtime(sourceFile, longAgoMs);
      const tsconfigPath = path.join(root, 'tsconfig.json');
      fs.writeFileSync(tsconfigPath, '{}', 'utf8');
      setMtime(tsconfigPath, recentMs);

      const result = inspectCompiledBundle({ bundlePath, sourceRoots: [srcDir], configFiles: [tsconfigPath] });
      assert.strictEqual(result.state, 'stale');
      assert.strictEqual(result.newestInputMs, recentMs);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports fresh when only non-source files are newer, and when no sources ship at all', () => {
    const { root, srcDir, bundlePath } = makeWorkspace();
    try {
      fs.writeFileSync(bundlePath, '// compiled', 'utf8');
      setMtime(bundlePath, recentMs);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 4;', 'utf8');
      setMtime(path.join(srcDir, 'index.ts'), longAgoMs);
      const imagePath = path.join(srcDir, 'assets', 'logo.png');
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, 'not-a-source', 'utf8');
      setMtime(imagePath, recentMs);

      const current = inspectCompiledBundle({ bundlePath, sourceRoots: [srcDir] });
      assert.strictEqual(current.state, 'fresh', 'a newer non-source asset must not force a rebuild');

      const packaged = inspectCompiledBundle({ bundlePath, sourceRoots: [path.join(root, 'absent-src')] });
      assert.strictEqual(packaged.state, 'fresh', 'a packaged layout without sources must not report staleness');
      assert.strictEqual(packaged.newestInputMs, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
