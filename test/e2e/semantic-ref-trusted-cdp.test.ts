import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
        reject(new Error('Live Electron Chromium E2E execution timed out after 60s'));
      }, 60_000);
    });

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      proc.on('error', (err) => {
        if (killTimer) clearTimeout(killTimer);
        reject(err);
      });
      proc.on('exit', (code) => {
        if (killTimer) clearTimeout(killTimer);
        resolve(code);
      });
    });

    let exitCode: number | null;
    try {
      exitCode = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    }
    if (exitCode !== 0) {
      console.error('STDOUT:\n', stdout);
      console.error('STDERR:\n', stderr);
    }

    assert.equal(exitCode, 0, `Live Electron test must exit with 0; stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.ok(stdout.includes('[OK] Tier 1 Synthetic Path with genuine React 18 verified.'), 'Tier 1 React 18 must pass in live Chromium');
    assert.ok(stdout.includes('[OK] Tier 1 Synthetic Path with genuine React 19 verified.'), 'Tier 1 React 19 must pass in live Chromium');
    assert.ok(stdout.includes('[OK] Tier 1 real executor bounded actionability latency verified'), 'Tier 1 real executor synthetic input must be verified with bounded actionability latency and 20/20 correct state updates');
    assert.ok(stdout.includes('[OK] Tier 2 Hardware CDP Trusted Path verified.'), 'Tier 2 CDP trusted path must pass in live Chromium');
    assert.ok(stdout.includes('[OK] Shadow DOM Interaction verified.'), 'Shadow DOM interaction must pass in live Chromium');
    assert.ok(stdout.includes('[OK] ContentEditable Text Insertion verified.'), 'ContentEditable must pass in live Chromium');
    assert.ok(stdout.includes('ALL MILESTONES (React 18, React 19, CDP Trusted, Shadow DOM, ContentEditable) PASSED WITH ZERO ERRORS.'));
  });

  it('terminates hanging run-electron.cjs wrapper and its entire spawned child process tree without orphans', async () => {
    const rootDir = process.cwd();
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tree-kill-test-'));
    const tmpPidFile = path.join(tmpDir, 'child-pid.txt');
    const fixturePath = path.join(tmpDir, 'fixture.js');

    let proc: ChildProcess | undefined;

    try {
      fs.writeFileSync(
        fixturePath,
        `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(tmpPidFile)}, String(process.pid), 'utf8');\nsetInterval(() => {}, 10000);\n`,
        'utf8'
      );

      proc = spawn(process.execPath, [runnerScript, fixturePath], {
        cwd: rootDir,
        stdio: 'ignore',
      });

      let childPid: number | null = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (fs.existsSync(tmpPidFile)) {
          try {
            const raw = fs.readFileSync(tmpPidFile, 'utf8').trim();
            if (raw.length > 0) {
              childPid = parseInt(raw, 10);
              break;
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(childPid !== null && !isNaN(childPid), 'Child process must record its PID in temp file');

      let killTimer: NodeJS.Timeout | undefined;
      const timeoutTimer = setTimeout(() => {
        try { proc?.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => { try { proc?.kill('SIGKILL'); } catch {} }, 1000);
      }, 2000);

      // Send SIGTERM to wrapper
      proc.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        proc?.on('exit', () => {
          clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
          resolve();
        });
      });

      await new Promise((r) => setTimeout(r, 200));

      let childStillAlive = true;
      try {
        process.kill(childPid, 0);
      } catch (e) {
        childStillAlive = false;
      }

      assert.strictEqual(childStillAlive, false, `Spawned child process (${childPid}) must be terminated by wrapper killChildTree`);
    } finally {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch {}
        if (process.platform === 'win32' && proc.pid) {
          try {
            require('node:child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {}
        }
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
