import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

interface TerminalManagerInternals {
  sessions: Map<string, unknown>;
  sessionGenerations: Map<string, number>;
  subscribers: Map<string, unknown>;
  dirtySessionIds: Set<string>;
  emitTimeMs: Map<string, Map<number, number>>;
  persistedFragments: Map<string, unknown>;
  isDisposed: boolean;
}

describe('P1-8: Resource Stability & Eviction Bounds', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-resource-stability-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('ArtifactStore Resource Stability & Eviction Bounds', () => {
    it('enforces single-artifact ceiling (maxArtifactBytes) via truncation by default', () => {
      const maxArtifactBytes = 512;
      const store = new ArtifactStore({
        root: path.join(tempDir, 'artifacts-single-cap'),
        maxArtifactBytes,
      });

      const oversizedData = Buffer.alloc(2048, 0x41); // 2 KB of 'A's
      const ref = store.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: oversizedData,
        runId: 'run-trunc-test',
        attemptId: 'att-1',
        projectId: 'project-test',
        workspaceId: 'workspace-test',
        overflowMode: 'truncate',
      });

      assert.strictEqual(ref.byteLength, maxArtifactBytes, 'Payload must be capped to maxArtifactBytes');
      assert.strictEqual(ref.truncated, true, 'Truncated flag must be true');

      const stat = fs.statSync(ref.path);
      assert.strictEqual(stat.size, maxArtifactBytes, 'On-disk file size must not exceed maxArtifactBytes');

      const stats = store.getStats();
      assert.strictEqual(stats.storedBytes, maxArtifactBytes, 'Store stats must reflect capped byte count');
    });

    it('enforces single-artifact ceiling (maxArtifactBytes) via reject mode without writing bytes', () => {
      const maxArtifactBytes = 512;
      const store = new ArtifactStore({
        root: path.join(tempDir, 'artifacts-reject-cap'),
        maxArtifactBytes,
      });

      const oversizedData = Buffer.alloc(2048, 0x42);
      assert.throws(
        () =>
          store.stage({
            kind: 'screenshot',
            mime: 'image/png',
            data: oversizedData,
            runId: 'run-reject-test',
            attemptId: 'att-1',
            projectId: 'project-test',
            workspaceId: 'workspace-test',
            overflowMode: 'reject',
          }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE'
      );

      const stats = store.getStats();
      assert.strictEqual(stats.artifactCount, 0, 'No artifact must be indexed on reject');
      assert.strictEqual(stats.storedBytes, 0, 'Zero bytes stored on reject');
    });

    it('enforces run-level budget ceiling (maxRunBytes) and rejects staging when budget is exceeded', () => {
      const maxRunBytes = 3000;
      const maxArtifactBytes = 2000;
      const store = new ArtifactStore({
        root: path.join(tempDir, 'artifacts-run-cap'),
        maxRunBytes,
        maxArtifactBytes,
      });

      const runId = 'run-budget-1';
      // Artifact 1: 1500 bytes -> committed: 1500
      const ref1 = store.stage({
        kind: 'dom',
        mime: 'text/html',
        data: Buffer.alloc(1500, 0x61),
        runId,
        attemptId: 'att-1',
        projectId: 'project-test',
        workspaceId: 'workspace-test',
      });
      assert.strictEqual(ref1.byteLength, 1500);

      // Artifact 2: 1000 bytes -> committed: 2500 <= 3000
      const ref2 = store.stage({
        kind: 'dom',
        mime: 'text/html',
        data: Buffer.alloc(1000, 0x62),
        runId,
        attemptId: 'att-1',
        projectId: 'project-test',
        workspaceId: 'workspace-test',
      });
      assert.strictEqual(ref2.byteLength, 1000);

      // Artifact 3: 1000 bytes -> 2500 + 1000 = 3500 > 3000 -> must fail closed
      assert.throws(
        () =>
          store.stage({
            kind: 'dom',
            mime: 'text/html',
            data: Buffer.alloc(1000, 0x63),
            runId,
            attemptId: 'att-1',
            projectId: 'project-test',
            workspaceId: 'workspace-test',
          }),
        (err: unknown) =>
          err instanceof CapabilityError &&
          err.code === 'ARTIFACT_TOO_LARGE' &&
          err.message.includes('Run artifact budget exceeded')
      );

      // Verify disk usage for the run stayed capped at 2500 bytes (<= 3000)
      const runDir = path.join(tempDir, 'artifacts-run-cap', runId);
      const files = fs.readdirSync(runDir).filter((f) => f.endsWith('.artifact'));
      let diskTotal = 0;
      for (const file of files) {
        diskTotal += fs.statSync(path.join(runDir, file)).size;
      }
      assert.strictEqual(diskTotal, 2500, 'On-disk run bytes must not exceed budget');

      // Preflight confirms the shortfall
      const preflightDenied = store.preflight({ runId, artifactBytes: 600 });
      assert.strictEqual(preflightDenied.granted, false);
      assert.strictEqual(preflightDenied.reason, 'RUN_BUDGET_EXCEEDED');

      const preflightGranted = store.preflight({ runId, artifactBytes: 400 });
      assert.strictEqual(preflightGranted.granted, true);
      assert.ok(preflightGranted.leaseToken);
      store.releaseLease(runId, preflightGranted.leaseToken);
    });

    it('enforces store-wide retention budget (sweepRetention) and reconciles in-memory tracking', () => {
      const storeRoot = path.join(tempDir, 'artifacts-sweep-budget');
      const store = new ArtifactStore({ root: storeRoot });

      // Stage 5 artifacts in separate runs, 1000 bytes each (total 5000 bytes)
      const refs: Array<{ id: string; path: string; runId: string }> = [];
      for (let i = 1; i <= 5; i++) {
        const isPermanent = i === 1; // First artifact is permanent evidence
        const ref = store.stage({
          kind: isPermanent ? 'report' : 'screenshot',
          mime: isPermanent ? 'application/json' : 'image/png',
          data: Buffer.alloc(1000, i),
          runId: `run-sweep-${i}`,
          attemptId: 'att-1',
          projectId: 'project-test',
          workspaceId: 'workspace-test',
          retentionPolicy: isPermanent ? 'permanent' : undefined,
        });
        refs.push({ id: ref.id, path: ref.path, runId: ref.runId });
      }

      // Age files deterministically via fs.utimesSync from oldest (i=1) to newest (i=5).
      // Note: fs.utimesSync sets explicit timestamps instead of wall-clock sleep to maintain
      // deterministic LRU ordering without stalling the test suite.
      const now = Date.now();
      for (let i = 0; i < refs.length; i++) {
        const mtimeSec = (now - (10 - i) * 60 * 1000) / 1000;
        fs.utimesSync(refs[i]!.path, mtimeSec, mtimeSec);
      }

      // Sweep with budget of 2500 bytes, minProtectAgeMs: 0
      const sweepResult = store.sweepRetention({
        maxBytes: 2500,
        minProtectAgeMs: 0,
      });

      assert.ok(sweepResult.deletedFiles >= 2, `Expected at least 2 deletions, got ${sweepResult.deletedFiles}`);
      assert.ok(sweepResult.remainingBytes <= 2500, `Remaining bytes ${sweepResult.remainingBytes} must be <= 2500`);

      // Permanent artifact (i=1) must survive even though it was the oldest
      assert.strictEqual(fs.existsSync(refs[0]!.path), true, 'Permanent artifact must survive budget sweep');
      assert.ok(store.get(refs[0]!.id), 'Permanent artifact must remain in store index');

      // The next oldest non-permanent artifacts (i=2, i=3) must have been evicted
      assert.strictEqual(fs.existsSync(refs[1]!.path), false, 'Oldest non-permanent artifact must be unlinked');
      assert.strictEqual(store.get(refs[1]!.id), undefined, 'Evicted artifact must be purged from store index');

      // Reconciled store stats must accurately match remaining on-disk files
      const stats = store.getStats();
      assert.strictEqual(stats.artifactCount, sweepResult.scannedFiles - sweepResult.deletedFiles);
      assert.strictEqual(stats.storedBytes, sweepResult.remainingBytes);
      assert.ok(stats.storedBytes <= 2500, 'Reconciled storedBytes must stay under maxBytes cap');
    });

    it('enforces age-based retention and purges stale artifacts deterministically', () => {
      const storeRoot = path.join(tempDir, 'artifacts-sweep-age');
      const store = new ArtifactStore({ root: storeRoot });

      // Stale artifact: backdated to 48 hours ago
      // Note: fs.utimesSync deterministically simulates 48-hour age without wall-clock sleep.
      const staleRef = store.stage({
        kind: 'dom',
        mime: 'text/html',
        data: '<div>stale content</div>',
        runId: 'run-stale',
        attemptId: 'att-1',
        projectId: 'project-test',
        workspaceId: 'workspace-test',
      });
      const twoDaysAgoSec = (Date.now() - 48 * 3600 * 1000) / 1000;
      fs.utimesSync(staleRef.path, twoDaysAgoSec, twoDaysAgoSec);

      // Fresh artifact: created now
      const freshRef = store.stage({
        kind: 'dom',
        mime: 'text/html',
        data: '<div>fresh content</div>',
        runId: 'run-fresh',
        attemptId: 'att-1',
        projectId: 'project-test',
        workspaceId: 'workspace-test',
      });

      const sweepResult = store.sweepRetention({
        maxAgeMs: 24 * 3600 * 1000,
        minProtectAgeMs: 0,
      });

      assert.strictEqual(sweepResult.deletedFiles, 1, 'Exactly one stale file must be deleted');
      assert.strictEqual(fs.existsSync(staleRef.path), false, 'Stale file must be unlinked');
      assert.strictEqual(fs.existsSync(freshRef.path), true, 'Fresh file must be preserved');
      assert.strictEqual(store.get(staleRef.id), undefined, 'Stale artifact must be purged from store index');
      assert.ok(store.get(freshRef.id), 'Fresh artifact must remain indexed');
    });
  });

  describe('TerminalManager Resource Stability & Session Lifecycle', () => {
    let tm: TerminalManager;
    let originalConfigDir: string | undefined;

    beforeEach(() => {
      originalConfigDir = process.env.ANTIFAN_CONFIG_DIR;
      process.env.ANTIFAN_CONFIG_DIR = tempDir;
      tm = TerminalManager.getInstance();
    });

    afterEach(async () => {
      try {
        await tm.dispose();
      } catch {}
      if (originalConfigDir !== undefined) {
        process.env.ANTIFAN_CONFIG_DIR = originalConfigDir;
      } else {
        delete process.env.ANTIFAN_CONFIG_DIR;
      }
    });

    it('creates and destroys sessions sequentially with zero process or handle leaks', async () => {
      const N = 3;
      const initialStats = tm.getStats();
      assert.strictEqual(initialStats.sessionCount, 0);
      assert.strictEqual(initialStats.runningPtyCount, 0);

      for (let i = 0; i < N; i++) {
        const sessionId = tm.createSession(tempDir);
        assert.ok(sessionId.startsWith('terminal-'), `Valid session ID expected: ${sessionId}`);

        const runningStats = tm.getStats();
        assert.strictEqual(runningStats.sessionCount, 1, 'Exactly one active session expected');
        assert.strictEqual(runningStats.runningPtyCount, 1, 'Exactly one running PTY expected');

        const closed = await tm.closeSession(sessionId);
        assert.strictEqual(closed, true, 'closeSession must return true');

        const postCloseStats = tm.getStats();
        assert.strictEqual(postCloseStats.sessionCount, 0, 'sessionCount must return to 0');
        assert.strictEqual(postCloseStats.runningPtyCount, 0, 'runningPtyCount must return to 0');
        assert.strictEqual(postCloseStats.dataSubscriptionCount, 0, 'dataSubscriptionCount must be 0');
        assert.strictEqual(postCloseStats.exitSubscriptionCount, 0, 'exitSubscriptionCount must be 0');
      }

      // Assert all internal maps are clean
      const internals = tm as unknown as TerminalManagerInternals;
      assert.strictEqual(internals.sessions.size, 0, 'sessions map must be empty');
      assert.strictEqual(internals.sessionGenerations.size, 0, 'sessionGenerations must not leak closed sessions');
      assert.strictEqual(internals.subscribers.size, 0, 'subscribers map must not leak closed sessions');
      assert.strictEqual(internals.dirtySessionIds.size, 0, 'dirtySessionIds must be empty');
      assert.strictEqual(internals.emitTimeMs.size, 0, 'emitTimeMs must be empty');

      const diag = tm.getDiagnostics();
      assert.strictEqual(diag.sessionCount, 0);
      assert.strictEqual(diag.sessions.length, 0);
    });

    it('cleans up both parent and split sessions on parent closeSession without leaks', async () => {
      const parentId = tm.createSession(tempDir);
      const splitId = tm.createSplitSession(parentId, tempDir);
      assert.ok(splitId.startsWith('split-'));

      const midStats = tm.getStats();
      assert.strictEqual(midStats.sessionCount, 2, 'Parent + split must equal 2 sessions');
      assert.strictEqual(midStats.runningPtyCount, 2, 'Both PTYs must be running');

      const closed = await tm.closeSession(parentId);
      assert.strictEqual(closed, true);

      const finalStats = tm.getStats();
      assert.strictEqual(finalStats.sessionCount, 0, 'Both parent and split must be closed');
      assert.strictEqual(finalStats.runningPtyCount, 0, 'Both PTYs must be terminated');

      const internals = tm as unknown as TerminalManagerInternals;
      assert.strictEqual(internals.sessions.size, 0);
      assert.strictEqual(internals.sessionGenerations.has(parentId), false);
      assert.strictEqual(internals.sessionGenerations.has(splitId), false);
    });

    it('reclaims PTY resources during session sleep and rematerializes cleanly on wake', async () => {
      const sessionId = tm.createSession(tempDir);
      assert.strictEqual(tm.getStats().runningPtyCount, 1);

      // Sleep session: PTY process and subscriptions are torn down
      const slept = tm.sleepSession(sessionId);
      assert.strictEqual(slept, true, 'sleepSession must succeed');

      const sleepingStats = tm.getStats();
      assert.strictEqual(sleepingStats.sessionCount, 1, 'Session record remains in map');
      assert.strictEqual(sleepingStats.runningPtyCount, 0, 'Sleeping PTY must release OS handle');

      // Wake session: fresh PTY is spawned
      const woken = tm.wakeSession(sessionId);
      assert.strictEqual(woken, true, 'wakeSession must succeed');

      const wokenStats = tm.getStats();
      assert.strictEqual(wokenStats.sessionCount, 1);
      assert.strictEqual(wokenStats.runningPtyCount, 1, 'Woken session must have running PTY');

      await tm.closeSession(sessionId);
      assert.strictEqual(tm.getStats().sessionCount, 0);
      assert.strictEqual(tm.getStats().runningPtyCount, 0);
    });

    it('dispose() terminates all active sessions, clears internal maps, and resets singleton', async () => {
      const s1 = tm.createSession(tempDir);
      const s2 = tm.createSession(tempDir);
      assert.strictEqual(tm.getStats().sessionCount, 2);

      await tm.dispose();

      const internals = tm as unknown as TerminalManagerInternals;
      assert.strictEqual(internals.isDisposed, true, 'Manager must be marked disposed');
      assert.strictEqual(internals.sessions.size, 0, 'sessions map must be cleared');
      assert.strictEqual(internals.sessionGenerations.size, 0, 'sessionGenerations must be cleared');
      assert.strictEqual(internals.persistedFragments.size, 0, 'persistedFragments must be cleared');
      assert.strictEqual(internals.subscribers.size, 0, 'subscribers must be cleared');
      assert.strictEqual(internals.dirtySessionIds.size, 0, 'dirtySessionIds must be cleared');

      // Verify calling getInstance() creates a brand new, non-disposed canonical instance
      const freshTm = TerminalManager.getInstance();
      assert.notStrictEqual(freshTm, tm, 'getInstance() must return a fresh instance after dispose');
      const freshInternals = freshTm as unknown as TerminalManagerInternals;
      assert.strictEqual(freshInternals.isDisposed, false, 'Fresh instance must not be disposed');
      await freshTm.dispose();
    });
  });
});
