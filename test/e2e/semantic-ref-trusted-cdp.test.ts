import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

describe('Live Chromium E2E: Semantic Ref Dual-Tier & Trusted CDP Interaction', () => {
  it('executes live Electron Chromium instance and proves Tier 1 (isTrusted === false) and Tier 2 CDP (isTrusted === true)', async () => {
    const rootDir = process.cwd();
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const smokeScript = path.join(rootDir, 'scripts', 'smoke-trusted-cdp.cjs');

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const proc = spawn(process.execPath, [runnerScript, smokeScript], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on('exit', (code) => resolve(code));
    });

    if (exitCode !== 0) {
      console.error('STDOUT:\n', stdout);
      console.error('STDERR:\n', stderr);
    }

    assert.equal(exitCode, 0, `Live Electron test must exit with 0; stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.ok(stdout.includes('[OK] Tier 1 Synthetic Path with genuine React 18 verified.'), 'Tier 1 React 18 must pass in live Chromium');
    assert.ok(stdout.includes('[OK] Tier 1 Synthetic Path with genuine React 19 verified.'), 'Tier 1 React 19 must pass in live Chromium');
    assert.ok(stdout.includes('[OK] Tier 1 real executor sub-5ms average latency verified'), 'Tier 1 real executor synthetic input must be verified with sub-5ms average latency and 20/20 correct state updates');
    assert.ok(stdout.includes('[OK] Tier 2 Hardware CDP Trusted Path verified.'), 'Tier 2 CDP trusted path must pass in live Chromium');
    assert.ok(stdout.includes('[OK] Shadow DOM Interaction verified.'), 'Shadow DOM interaction must pass in live Chromium');
    assert.ok(stdout.includes('[OK] ContentEditable Text Insertion verified.'), 'ContentEditable must pass in live Chromium');
    assert.ok(stdout.includes('ALL MILESTONES (React 18, React 19, CDP Trusted, Shadow DOM, ContentEditable) PASSED WITH ZERO ERRORS.'));
  });
});
