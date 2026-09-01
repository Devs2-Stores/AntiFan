import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactRetentionCleaner } from '../../src/main/tools/artifact-retention-cleaner';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { SessionResumeController } from '../../src/main/agent/session-resume-controller';

describe('ArtifactRetentionCleaner & SessionResumeController (Phase 3)', () => {
  it('cleans up stale .artifact files older than maxAgeMs while protecting files younger than minProtectAgeMs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-retention-test-'));
    const run1Dir = path.join(tempDir, 'run-1');
    fs.mkdirSync(run1Dir, { recursive: true });

    const now = Date.now();
    const staleFile = path.join(run1Dir, 'stale.artifact');
    const recentFile = path.join(run1Dir, 'recent.artifact');

    fs.writeFileSync(staleFile, 'stale data', 'utf8');
    fs.writeFileSync(recentFile, 'recent data', 'utf8');

    // Set stale file mtime to 30 hours ago (30 * 3600 * 1000)
    const thirtyHoursAgo = (now - 30 * 3600 * 1000) / 1000;
    fs.utimesSync(staleFile, thirtyHoursAgo, thirtyHoursAgo);

    // Set recent file mtime to 10 minutes ago
    const tenMinsAgo = (now - 10 * 60 * 1000) / 1000;
    fs.utimesSync(recentFile, tenMinsAgo, tenMinsAgo);

    const result = ArtifactRetentionCleaner.sweep(tempDir, {
      maxAgeMs: 24 * 3600 * 1000,
      minProtectAgeMs: 3600 * 1000,
    });

    assert.strictEqual(result.scannedFiles, 2);
    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(fs.existsSync(staleFile), false, 'Stale file must be unlinked');
    assert.strictEqual(fs.existsSync(recentFile), true, 'Recent file must be preserved');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('enforces total directory budget by deleting oldest files first (LRU) when over maxBytes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-budget-test-'));
    const runDir = path.join(tempDir, 'run-2');
    fs.mkdirSync(runDir, { recursive: true });

    const now = Date.now();
    const file1 = path.join(runDir, 'old.artifact'); // 100 KB, 3 hours ago
    const file2 = path.join(runDir, 'medium.artifact'); // 100 KB, 2 hours ago
    const file3 = path.join(runDir, 'new.artifact'); // 100 KB, 5 mins ago

    const buf100KB = Buffer.alloc(100 * 1024, 'a');
    fs.writeFileSync(file1, buf100KB);
    fs.writeFileSync(file2, buf100KB);
    fs.writeFileSync(file3, buf100KB);

    const threeHoursAgo = (now - 3 * 3600 * 1000) / 1000;
    const twoHoursAgo = (now - 2 * 3600 * 1000) / 1000;
    const fiveMinsAgo = (now - 5 * 60 * 1000) / 1000;

    fs.utimesSync(file1, threeHoursAgo, threeHoursAgo);
    fs.utimesSync(file2, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(file3, fiveMinsAgo, fiveMinsAgo);

    // Budget: 250 KB (total is 300 KB). Deleting 1 file (file1) brings total to 200 KB <= 250 KB
    const result = ArtifactRetentionCleaner.sweep(tempDir, {
      maxBytes: 250 * 1024,
      maxAgeMs: 48 * 3600 * 1000,
      minProtectAgeMs: 3600 * 1000,
    });

    assert.strictEqual(result.deletedFiles, 1, 'Should delete 1 oldest file (file1) to bring total to 200KB (file3 protected)');
    assert.strictEqual(fs.existsSync(file1), false, 'Oldest file1 must be unlinked');
    assert.strictEqual(fs.existsSync(file2), true, 'File2 should survive');
    assert.strictEqual(fs.existsSync(file3), true, 'Protected file3 must survive');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('integrates ArtifactStore.sweepRetention with storage lifecycle', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-store-sweep-test-'));
    const store = new ArtifactStore({ root: tempDir });

    const ref = store.stage({
      kind: 'dom',
      mime: 'text/html',
      data: '<html><body>Hello</body></html>',
      runId: 'run-test-1',
      attemptId: 'att-1',
      projectId: 'project-test',
      workspaceId: 'workspace-test',
    });

    assert.ok(fs.existsSync(ref.path));
    const sweepRes = store.sweepRetention();
    assert.strictEqual(sweepRes.scannedFiles, 1);
    assert.strictEqual(sweepRes.deletedFiles, 0, 'Freshly staged artifact must not be deleted');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists, reads, lists, and checks liveness in SessionResumeController', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-session-test-'));
    const controller = new SessionResumeController(tempDir);

    const manifest = {
      sessionId: 'sess-1234',
      name: 'Agent Terminal',
      cwd: 'E:/Work/theme',
      capsuleId: 'default',
      lastPid: process.pid, // current running process PID -> isAlive should be true
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
    };

    // 1. Save
    controller.saveManifest(manifest);

    // 2. Load & verify PID liveness
    const loaded = controller.loadManifest('sess-1234');
    assert.ok(loaded);
    assert.strictEqual(loaded.sessionId, 'sess-1234');
    assert.strictEqual(loaded.isAlive, true);

    // 3. List
    const all = controller.listManifests();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0]?.sessionId, 'sess-1234');

    // 4. Delete
    controller.deleteManifest('sess-1234');
    assert.strictEqual(controller.loadManifest('sess-1234'), null);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
