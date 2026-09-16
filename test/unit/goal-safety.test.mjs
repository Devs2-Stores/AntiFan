import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDrift } from '../../scripts/goal/drift.mjs';
import { createHealthMonitor } from '../../scripts/goal/health.mjs';
import { pruneRunArtifacts } from '../../scripts/goal/prune.mjs';
import { THRESHOLDS, checkDiskHeadroom } from '../../scripts/goal/thresholds.mjs';
import { acquireRunnerMutex, releaseRunnerMutex, isHeartbeatStale, writeHeartbeat } from '../../scripts/goal/watchdog.mjs';
import { writeRecordAtomic, readRecord } from '../../scripts/lib/atomic-record.mjs';
import { checkpointPath, emptyCheckpoint, writeCheckpoint, readCheckpoint } from '../../scripts/goal/checkpoint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Test dirs live on the repo drive, not os.tmpdir(): the disk-headroom probe is
// real, and C: sits under the free-fraction floor (the plan's own preflight
// measured 92% used). A tmpdir on C: would make every gate abort for the wrong
// reason.
function makeDir(prefix) {
  return fs.mkdtempSync(path.join(REPO, `.goal-test-${prefix}-`));
}

describe('criteria-drift detector', () => {
  it('flags a removed assertion', () => {
    const before = ['- assert coverage >= 80', '- must verify receipts', '- expect zero timeouts'].join('\n');
    const after = ['- assert coverage >= 80', '- expect zero timeouts'].join('\n');
    const r = detectDrift(before, after);
    assert.strictEqual(r.drift, true);
    assert.match(r.detail, /must verify receipts/);
  });

  it('flags a loosened lower bound', () => {
    const r = detectDrift('- coverage must be >= 80 percent', '- coverage must be >= 50 percent');
    assert.strictEqual(r.drift, true);
    assert.match(r.detail, /lower bound weakened/);
  });

  it('flags a loosened upper bound', () => {
    const r = detectDrift('- heap <= 4096 MB', '- heap <= 8192 MB');
    assert.strictEqual(r.drift, true);
    assert.match(r.detail, /upper bound weakened/);
  });

  it('flags a bound removed while its subject survives', () => {
    const r = detectDrift('- RSS drift must stay <= 512 MB/h', '- RSS drift must stay within limits');
    assert.strictEqual(r.drift, true);
  });

  it('flags a changed exact bound', () => {
    const r = detectDrift('- retries = 3', '- retries = 5');
    assert.strictEqual(r.drift, true);
  });

  it('flags structured criteria weakening by id', () => {
    const before = [{ id: 'c1', op: '>=', value: 80 }, { id: 'c2', text: 'must verify' }];
    const after = [{ id: 'c1', op: '>=', value: 60 }, { id: 'c2', text: 'must verify' }];
    const r = detectDrift(before, after);
    assert.strictEqual(r.drift, true);
  });

  it('does not flag strengthening or pure additions', () => {
    const before = '- coverage >= 80\n- heap <= 4096';
    const after = '- coverage >= 90\n- heap <= 4096\n- new assertion must hold';
    const r = detectDrift(before, after);
    assert.strictEqual(r.drift, false);
    assert.strictEqual(r.detail, null);
  });

  it('does not flag an identical snapshot', () => {
    const text = '- assert coverage >= 80\n- must verify receipts';
    assert.strictEqual(detectDrift(text, text).drift, false);
  });
});

describe('health abort gate', () => {
  it('aborts with CONSECUTIVE_VERIFY_FAILURES after the threshold of FAILs', () => {
    const dir = makeDir('antifan-health-');
    try {
      const h = createHealthMonitor({ dir });
      h.recordVerify('FAIL');
      h.recordVerify('FAIL');
      assert.strictEqual(h.checkHealth().abort, false);
      h.recordVerify('FAIL');
      const r = h.checkHealth();
      assert.strictEqual(r.abort, true);
      assert.strictEqual(r.reason, 'CONSECUTIVE_VERIFY_FAILURES');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the failure streak on PASS and ignores NOT_IMPLEMENTED/BLOCKED', () => {
    const dir = makeDir('antifan-health-');
    try {
      const h = createHealthMonitor({ dir });
      h.recordVerify('FAIL');
      h.recordVerify('FAIL');
      h.recordVerify('PASS');
      h.recordVerify('NOT_IMPLEMENTED');
      h.recordVerify('BLOCKED');
      h.recordVerify('FAIL');
      h.recordVerify('FAIL');
      assert.strictEqual(h.checkHealth().abort, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts with HEAP_CEILING when heapUsed exceeds the bound', () => {
    const dir = makeDir('antifan-health-');
    try {
      const h = createHealthMonitor({
        dir,
        memoryUsage: () => ({ rss: 512 * 1024 * 1024, heapUsed: (THRESHOLDS.heapCeilingMb + 1) * 1024 * 1024 }),
      });
      const r = h.checkHealth();
      assert.strictEqual(r.abort, true);
      assert.strictEqual(r.reason, 'HEAP_CEILING');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts with RSS_DRIFT when growth per hour exceeds the bound past the window', () => {
    const dir = makeDir('antifan-health-');
    try {
      let t = 0;
      let rss = 1024 * 1024 * 1024;
      const h = createHealthMonitor({
        dir,
        now: () => t,
        memoryUsage: () => ({ rss, heapUsed: 256 * 1024 * 1024 }),
        rateWindowMs: 60_000,
      });
      h.checkHealth(); // baseline sample at t=0
      t = 3_600_000; // one hour later
      rss += (THRESHOLDS.rssDriftMbPerHour + 64) * 1024 * 1024;
      const r = h.checkHealth();
      assert.strictEqual(r.abort, true);
      assert.strictEqual(r.reason, 'RSS_DRIFT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not trip RSS_DRIFT inside the observation window', () => {
    const dir = makeDir('antifan-health-');
    try {
      let t = 0;
      const h = createHealthMonitor({
        dir,
        now: () => t,
        memoryUsage: () => ({ rss: 4 * 1024 * 1024 * 1024, heapUsed: 256 * 1024 * 1024 }),
        rateWindowMs: 60_000,
      });
      h.checkHealth();
      t = 30_000; // 30s — inside the window, so the rate is not judged yet
      assert.strictEqual(h.checkHealth().abort, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts with the disk-headroom reason when free space is under the floor', () => {
    const dir = makeDir('antifan-health-');
    try {
      const h = createHealthMonitor({
        dir,
        statfs: () => ({ freeBytes: THRESHOLDS.diskHeadroomMinBytes - 1, totalBytes: 500 * 1024 ** 3 }),
      });
      const r = h.checkHealth();
      assert.strictEqual(r.abort, true);
      assert.strictEqual(r.reason, 'DISK_HEADROOM_BYTES');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts with CRITERIA_DRIFT when the caller reports drift', () => {
    const dir = makeDir('antifan-health-');
    try {
      const h = createHealthMonitor({ dir });
      const r = h.checkHealth({ drift: { drift: true, detail: 'assertion removed: "x"' } });
      assert.strictEqual(r.abort, true);
      assert.strictEqual(r.reason, 'CRITERIA_DRIFT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes on a healthy sample', () => {
    const dir = makeDir('antifan-health-');
    try {
      const h = createHealthMonitor({ dir });
      const r = h.checkHealth();
      assert.strictEqual(r.abort, false);
      assert.strictEqual(r.reason, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('disk headroom bound', () => {
  it('fails the fraction floor even when bytes pass', () => {
    const r = checkDiskHeadroom({
      freeBytes: THRESHOLDS.diskHeadroomMinBytes + 1,
      totalBytes: (THRESHOLDS.diskHeadroomMinBytes + 1) * 20, // ~5% free
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'DISK_HEADROOM_FRACTION');
  });
});

describe('single-runner mutex', () => {
  it('refuses a second acquisition while this process holds the lock', () => {
    const dir = makeDir('antifan-mutex-');
    try {
      const first = acquireRunnerMutex(dir);
      assert.strictEqual(first.acquired, true);
      const second = acquireRunnerMutex(dir);
      assert.strictEqual(second.acquired, false);
      assert.strictEqual(second.holderPid, process.pid);
      releaseRunnerMutex(dir);
      const third = acquireRunnerMutex(dir);
      assert.strictEqual(third.acquired, true);
      releaseRunnerMutex(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims the lock when the recorded holder is dead', () => {
    const dir = makeDir('antifan-mutex-');
    try {
      // PID 2^22-1 is beyond any plausible live pid on this host.
      writeRecordAtomic(path.join(dir, 'goal-runner.lock'), { pid: 4194303, at: new Date().toISOString() });
      const r = acquireRunnerMutex(dir);
      assert.strictEqual(r.acquired, true);
      releaseRunnerMutex(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('watchdog staleness', () => {
  it('reports a backdated heartbeat as stale and a fresh one as live', () => {
    const dir = makeDir('antifan-hb-');
    try {
      writeHeartbeat(dir, {});
      assert.strictEqual(isHeartbeatStale(dir), false);
      const hbPath = path.join(dir, 'goal-heartbeat.json');
      const hb = readRecord(hbPath);
      hb.atMs = Date.now() - THRESHOLDS.heartbeatStaleMs - 1000;
      writeRecordAtomic(hbPath, hb);
      assert.strictEqual(isHeartbeatStale(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkpoint bounds freeze', () => {
  it('refuses to resume a checkpoint written under different bounds', () => {
    const dir = makeDir('antifan-cp-');
    try {
      const cp = emptyCheckpoint({ runId: 'r1', gitSha: 'abc' });
      writeCheckpoint(dir, cp);
      const tampered = readRecord(checkpointPath(dir));
      tampered.thresholdDigest = 'deadbeef';
      writeRecordAtomic(checkpointPath(dir), tampered);
      assert.throws(() => readCheckpoint(dir), /different bounds/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('artifact pruning', () => {
  it('keeps FAIL paths whole and reduces PASS paths to a summary, measured in bytes', () => {
    const dir = makeDir('antifan-prune-');
    try {
      const passDir = path.join(dir, 'p1', 'ok-unit');
      const failDir = path.join(dir, 'p1', 'bad-unit');
      fs.mkdirSync(passDir, { recursive: true });
      fs.mkdirSync(failDir, { recursive: true });
      fs.writeFileSync(path.join(passDir, 'full-page.png'), Buffer.alloc(64 * 1024, 1));
      fs.writeFileSync(path.join(passDir, 'dom.html'), Buffer.alloc(32 * 1024, 2));
      fs.writeFileSync(path.join(failDir, 'full-page.png'), Buffer.alloc(64 * 1024, 3));

      const report = pruneRunArtifacts([
        { dir: passDir, verdict: 'PASS', summary: { verdict: 'PASS', itemId: 'ok-unit' } },
        { dir: failDir, verdict: 'FAIL', summary: { verdict: 'FAIL', itemId: 'bad-unit' } },
      ]);

      assert.ok(report.freedBytes >= 64 * 1024, `expected >=64K freed, got ${report.freedBytes}`);
      assert.deepStrictEqual(fs.readdirSync(passDir), ['summary.json']);
      assert.ok(fs.existsSync(path.join(failDir, 'full-page.png')), 'FAIL path must keep its evidence');
      const summary = readRecord(path.join(passDir, 'summary.json'));
      assert.strictEqual(summary.verdict, 'PASS');
      assert.strictEqual(summary.itemId, 'ok-unit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The concurrent-access contract for the Core DB (WAL journal + busy_timeout) is owned
// by the code that opens the store, and asserted there in
// packages/super-core/src/core.test.ts. A second copy of the pragmas in the runner was
// dead and could drift from the owner, so it is gone.
