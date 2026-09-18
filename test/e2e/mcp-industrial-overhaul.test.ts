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

    // Real wall-clock watchdog: it bounds a hung Electron child, which fake timers cannot kill.
    // On Windows, taskkill /T /F reaps the entire process tree; on POSIX, SIGTERM then SIGKILL.
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        if (process.platform === 'win32') {
          if (proc.pid) {
            try {
              const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
              });
              killer.unref();
              killer.on('error', () => {});
            } catch {}
          }
        } else {
          try { proc.kill('SIGTERM'); } catch {}
          killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
        }
        console.error('STDOUT (on timeout):\n', stdout);
        console.error('STDERR (on timeout):\n', stderr);
        reject(new Error('Live Electron industrial overhaul E2E timed out after 90s'));
      }, 90_000);
    });

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(killTimer);
        resolve(code);
      });
    });

    let exitCode: number | null;
    try {
      exitCode = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
    }

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
