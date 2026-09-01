import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

describe('Live Chromium E2E: MCP Industrial Overhaul & Storefront Benchmark', () => {
  it('executes live Electron instance with real Chromium rendering, MCP stdio proxy, and CDP hardware input', async () => {
    const rootDir = process.cwd();
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const smokeScript = path.join(rootDir, 'scripts', 'smoke-mcp-industrial-e2e.cjs');

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
    assert.ok(stdout.includes('[OK] Milestone 1: Live Chromium Viewport Screenshot Capture verified'), 'Milestone 1 must pass');
    assert.ok(stdout.includes('[OK] Milestone 2: CDP Native Input') && stdout.includes('isTrusted === true'), 'Milestone 2 must pass');
    assert.ok(stdout.includes('[OK] Milestone 3: 20-Call Storefront Latency'), 'Milestone 3 must pass');
    assert.ok(stdout.includes('[OK] Milestone 4: 50-Cycle Rapid Dispatch Stability verified'), 'Milestone 4 must pass');
    assert.ok(stdout.includes('ALL LIVE CHROMIUM MCP INDUSTRIAL OVERHAUL MILESTONES PASSED SUCCESSFULLY.'));
  });
});
