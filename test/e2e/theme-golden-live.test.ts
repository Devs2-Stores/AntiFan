import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function checksumObject(value: Record<string, unknown>, checksumField: string): string {
  const copy = { ...value };
  delete copy[checksumField];
  return sha256(JSON.stringify(copy));
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { proc.kill('SIGKILL'); } catch {}
}

describe('Live Chromium E2E: Theme Golden Product Card and Drawer', () => {
  it('proves both real Chromium slices and persists a bounded teardown-complete report', async () => {
    const rootDir = process.cwd();
    const orchestratorScript = path.join(rootDir, 'scripts', 'run-theme-golden-live-proof.cjs');
    const proofPath = path.join(rootDir, 'plans', '260905-0012-core-pre-freeze-hardening-and-live-proof', 'reports', 'live-theme-proof.json');
    try { fs.unlinkSync(proofPath); } catch {}

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(process.execPath, [orchestratorScript], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr?.on('data', (data) => { stderr += data.toString('utf8'); });

    // Real OS-child watchdog: fake timers cannot terminate a hung Electron process tree.
    let timeoutTimer: NodeJS.Timeout | undefined;
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('exit', (code) => resolve(code));
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        killProcessTree(proc);
        reject(new Error('Live theme proof timed out after 180 seconds'));
      }, 180_000);
    });

    let exitCode: number | null;
    try {
      exitCode = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutTimer);
      killProcessTree(proc);
    }

    assert.equal(exitCode, 0, `Live theme proof must exit cleanly; stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /\[OK\] Product Card: real PNG, CDP provenance, source candidacy, file\.write SHA, reload generation, five widths, VERIFIED receipt\./);
    assert.match(stdout, /\[OK\] Drawer: mobile viewport, trusted CDP click, sparse attributed delta, visible state, five widths, VERIFIED receipt\./);
    assert.match(stdout, /\[OK\] Negative canaries: no-op claim REJECTED, ambiguous source REJECTED, pruned authority denied\./);
    assert.match(stdout, /\[OK\] Persisted bounded live proof:/);
    assert.match(stdout, /LIVE THEME GOLDEN PRODUCT CARD AND DRAWER SLICES PASSED\./);

    const report = JSON.parse(fs.readFileSync(proofPath, 'utf8')) as Record<string, any>;
    assert.equal(report.type, 'antifan-live-theme-proof');
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.proofChecksum, checksumObject(report, 'proofChecksum'));
    assert.deepEqual(report.productCard.responsiveWidths, [320, 375, 768, 1024, 1440]);
    assert.equal(report.productCard.sourceCandidate, 'snippets/card-product.liquid');
    assert.equal(report.productCard.matchedCssDefinitionOfDone, 'STRONG PASS');
    assert.equal(report.productCard.verificationVerdict, 'VERIFIED');
    assert.deepEqual(report.drawer.responsiveWidths, [320, 375, 768, 1024, 1440]);
    assert.equal(report.drawer.mutationRevisionAdvanced, true);
    assert.equal(report.drawer.trustedClick, true);
    assert.equal(report.drawer.interactionVerdict, 'DRAWER_EXPANDED');
    assert.equal(report.drawer.verificationVerdict, 'VERIFIED');
    assert.equal(report.negativeCanaries.noOpVerdict, 'REJECTED');
    assert.equal(report.negativeCanaries.ambiguousSourceVerdict, 'REJECTED');
    assert.equal(report.negativeCanaries.staleAuthorityDenied, true);
    assert.equal(report.teardown.processBoundTempCleanup, 'completed');
    assert.equal(report.teardown.passed, true);
    assert.ok(Object.values(report.teardown.resourceOwners).every((value) => value === 0));
    assert.equal('screenshot' in report.productCard, false);
    assert.equal('sourceBody' in report.productCard, false);
    assert.equal('secret' in report, false);
  });
});
