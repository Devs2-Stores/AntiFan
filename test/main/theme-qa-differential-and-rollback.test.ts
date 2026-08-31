import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createWorkspaceSnapshotManifest,
  rollbackWorkspaceToManifest,
  type WorkspaceSnapshotManifest,
} from '../../src/main/qa/workspace-snapshot-rollback';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('Theme QA Manifest Snapshot & Differential Rollback', () => {
  let tempDir: string;
  let workspaceRoot: string;
  const testRunId = 'run-test-101';

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'antifan-qa-rollback-test-'));
    workspaceRoot = path.join(tempDir, 'theme-repo');
    await fs.promises.mkdir(workspaceRoot, { recursive: true });

    // Setup mock theme files
    await fs.promises.mkdir(path.join(workspaceRoot, 'layout'), { recursive: true });
    await fs.promises.mkdir(path.join(workspaceRoot, 'snippets'), { recursive: true });
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'layout', 'theme.liquid'),
      '<!DOCTYPE html><html><head></head><body>Initial Theme</body></html>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'snippets', 'header.liquid'),
      '<header class="site-header">Header Content</header>',
      'utf8'
    );
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates an accurate snapshot manifest excluding .git, node_modules, and .antifan', async () => {
    // Add ignored dirs
    await fs.promises.mkdir(path.join(workspaceRoot, '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
    await fs.promises.mkdir(path.join(workspaceRoot, 'node_modules', 'dummy'), { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, 'node_modules', 'dummy', 'index.js'), 'module.exports={}', 'utf8');

    const manifest = await createWorkspaceSnapshotManifest(workspaceRoot, testRunId);
    assert.equal(manifest.workspaceRoot, path.resolve(workspaceRoot));
    assert.equal(manifest.manifestVersion, '1.0');
    assert.equal(manifest.runId, testRunId);

    const relPaths = Object.keys(manifest.files).sort();
    assert.deepEqual(relPaths, ['layout/theme.liquid', 'snippets/header.liquid']);

    for (const [relPath, entry] of Object.entries(manifest.files)) {
      assert.equal(entry.relativePath, relPath);
      assert.equal(entry.sha256.length, 64);
      assert.ok(entry.byteLength > 0);
      assert.ok(fs.existsSync(path.join(manifest.backupDir, 'data', entry.sha256)));
    }
  });

  it('successfully rolls back modified files and deletes newly created orphan files', async () => {
    const manifest = await createWorkspaceSnapshotManifest(workspaceRoot, testRunId);

    // 1. Modify existing file
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'layout', 'theme.liquid'),
      '<!DOCTYPE html><html><body>BROKEN REGRESSION CODE</body></html>',
      'utf8'
    );

    // 2. Create newly created orphan file (e.g. AI-generated bad file)
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'snippets', 'bad-orphan.liquid'),
      '<div>Orphan syntax error</div>',
      'utf8'
    );

    assert.ok(fs.existsSync(path.join(workspaceRoot, 'snippets', 'bad-orphan.liquid')));

    // Execute rollback
    const rollbackResult = await rollbackWorkspaceToManifest(workspaceRoot, manifest);
    assert.equal(rollbackResult.success, true);
    assert.equal(rollbackResult.restoredFiles.length, 1);
    assert.equal(rollbackResult.restoredFiles[0], 'layout/theme.liquid');
    assert.equal(rollbackResult.deletedOrphanFiles.length, 1);
    assert.equal(rollbackResult.deletedOrphanFiles[0], 'snippets/bad-orphan.liquid');

    // Verify content restored
    const restoredContent = await fs.promises.readFile(path.join(workspaceRoot, 'layout', 'theme.liquid'), 'utf8');
    assert.equal(restoredContent, '<!DOCTYPE html><html><head></head><body>Initial Theme</body></html>');

    // Verify orphan file deleted
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'snippets', 'bad-orphan.liquid')), false);
  });

  it('rejects rollback if workspaceRoot does not match manifest (WORKSPACE_MISMATCH)', async () => {
    const manifest = await createWorkspaceSnapshotManifest(workspaceRoot, testRunId);
    const alienWorkspace = path.join(tempDir, 'alien-workspace');
    await fs.promises.mkdir(alienWorkspace, { recursive: true });

    await assert.rejects(
      async () => {
        await rollbackWorkspaceToManifest(alienWorkspace, manifest);
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'WORKSPACE_MISMATCH');
        return true;
      }
    );
  });

  it('rejects rollback if manifest backup fingerprint was tampered with (FINGERPRINT_MISMATCH)', async () => {
    const manifest = await createWorkspaceSnapshotManifest(workspaceRoot, testRunId);

    // Modify a file in workspace so rollback is needed
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'layout', 'theme.liquid'),
      '<div>Modified</div>',
      'utf8'
    );

    // Tamper with backup file content
    const entry = manifest.files['layout/theme.liquid']!;
    const backupFilePath = path.join(manifest.backupDir, 'data', entry.sha256);
    await fs.promises.writeFile(backupFilePath, 'Tampered corrupted bytes', 'utf8');

    await assert.rejects(
      async () => {
        await rollbackWorkspaceToManifest(workspaceRoot, manifest);
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'FINGERPRINT_MISMATCH');
        return true;
      }
    );
  });

  it('rejects illegal relative path in manifest entries', async () => {
    const manifest = await createWorkspaceSnapshotManifest(workspaceRoot, testRunId);
    // Maliciously inject a traversal relPath
    manifest.files['../outside.txt'] = {
      relativePath: '../outside.txt',
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      byteLength: 10,
    };

    await assert.rejects(
      async () => {
        await rollbackWorkspaceToManifest(workspaceRoot, manifest);
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'INVALID_ARGUMENT');
        return true;
      }
    );
  });
});
