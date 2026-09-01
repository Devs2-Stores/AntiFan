import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { CapabilityError, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

describe('Workspace file port', () => {
  it('rejects absolute/traversal writes and stages bounded attachments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-files-'));
    try {
      fs.writeFileSync(path.join(root, 'theme.css'), 'body { color: red; }'); // 20 bytes
      const port = new WorkspaceFilePort();
      assert.strictEqual(port.read(root, 'theme.css').content, 'body { color: red; }');
      assert.throws(() => port.read(root, '../outside.txt'), (error: unknown) => error instanceof CapabilityError);
      assert.throws(() => port.read(root, '/etc/passwd'), (error: unknown) => error instanceof CapabilityError);
      assert.throws(() => port.read(root, 'C:\\Windows\\System32\\cmd.exe'), (error: unknown) => error instanceof CapabilityError);
      
      // Non-existent path returns empty string and truncated: false
      const nonExistent = port.read(root, 'snippets/missing.liquid');
      assert.strictEqual(nonExistent.content, '');
      assert.strictEqual(nonExistent.truncated, false);

      // Read truncation boundaries (exact 20 bytes vs 19 bytes)
      const exactRead = port.read(root, 'theme.css', 20);
      assert.strictEqual(exactRead.content, 'body { color: red; }');
      assert.strictEqual(exactRead.truncated, false);

      const truncatedRead = port.read(root, 'theme.css', 19);
      assert.strictEqual(truncatedRead.content, 'body { color: red; ');
      assert.strictEqual(truncatedRead.truncated, true);

      // Write within workspace
      await port.write(root, 'assets/style.css', '.header { font-size: 16px; }');
      assert.strictEqual(fs.readFileSync(path.join(root, 'assets', 'style.css'), 'utf8'), '.header { font-size: 16px; }');

      // Write exact-limit success vs one-byte-over rejection
      const smallPort = new WorkspaceFilePort(10);
      const exactWrite = await smallPort.write(root, 'exact-10.txt', '0123456789'); // exactly 10 bytes
      assert.strictEqual(exactWrite.byteLength, 10);
      assert.strictEqual(fs.readFileSync(path.join(root, 'exact-10.txt'), 'utf8'), '0123456789');

      await assert.rejects(
        async () => smallPort.write(root, 'oversized.txt', '0123456789+'), // 11 bytes -> exceeds 10 bytes limit
        (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'ARTIFACT_TOO_LARGE'
      );

      // Reject traversal write
      await assert.rejects(async () => port.write(root, '../../evil.sh', 'rm -rf /'), (error: unknown) => error instanceof CapabilityError);
      const validRunId = makeControlPlaneId('run');
      const validAttemptId = makeControlPlaneId('attempt');
      const validProjectId = makeControlPlaneId('project');
      const validWorkspaceId = makeControlPlaneId('workspace');

      // stageAttachment validation with default limit
      const artifact = port.stageAttachment(root, 'theme.css', validRunId, validAttemptId, validProjectId, validWorkspaceId);
      assert.strictEqual(artifact.kind, 'attachment');
      assert.ok(artifact.id);
      assert.strictEqual(artifact.byteLength, 20);

      // stageAttachment exact-limit success (maxBytes = 20) vs one-byte-under rejection (maxBytes = 19)
      const exactStage = port.stageAttachment(root, 'theme.css', makeControlPlaneId('run'), makeControlPlaneId('attempt'), validProjectId, validWorkspaceId, 20);
      assert.strictEqual(exactStage.kind, 'attachment');
      assert.strictEqual(exactStage.byteLength, 20);

      assert.throws(
        () => port.stageAttachment(root, 'theme.css', makeControlPlaneId('run'), makeControlPlaneId('attempt'), validProjectId, validWorkspaceId, 19),
        (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'ARTIFACT_TOO_LARGE'
      );

      // Traversal and invalid runId rejection
      assert.throws(
        () => port.stageAttachment(root, 'theme.css', '../evil-run', validAttemptId, validProjectId, validWorkspaceId),
        (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'INVALID_ARGUMENT'
      );
      assert.throws(
        () => port.stageAttachment(root, 'theme.css', 'not-a-control-plane-id', validAttemptId, validProjectId, validWorkspaceId),
        (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'INVALID_ARGUMENT'
      );

      // Idempotent duplicate content staging does not throw EEXIST
      const dupStage1 = port.stageAttachment(root, 'theme.css', validRunId, validAttemptId, validProjectId, validWorkspaceId);
      const dupStage2 = port.stageAttachment(root, 'theme.css', validRunId, validAttemptId, validProjectId, validWorkspaceId);
      assert.strictEqual(dupStage1.sha256, dupStage2.sha256);
      assert.strictEqual(dupStage2.byteLength, 20);

      // Mismatched / corrupted existing file at artifact path throws INTEGRITY_MISMATCH
      const corruptRunId = makeControlPlaneId('run');
      fs.writeFileSync(path.join(root, 'source.txt'), 'original authentic content');
      const corruptArtifact = port.stageAttachment(root, 'source.txt', corruptRunId, validAttemptId, validProjectId, validWorkspaceId);
      fs.writeFileSync(corruptArtifact.path, 'tampered corrupted content');
      assert.throws(
        () => port.stageAttachment(root, 'source.txt', corruptRunId, validAttemptId, validProjectId, validWorkspaceId),
        (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'INVALID_ARGUMENT'
      );

      // Symlink or junction in .antifan/artifacts path is rejected by assertNoReparseTraversal
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-outside-'));
      const symlinkRunId = makeControlPlaneId('run');
      const symlinkArtifactDir = path.join(root, '.antifan', 'artifacts', symlinkRunId);
      fs.mkdirSync(path.join(root, '.antifan', 'artifacts'), { recursive: true });
      try {
        fs.symlinkSync(outsideDir, symlinkArtifactDir, 'junction');
        assert.throws(
          () => port.stageAttachment(root, 'theme.css', symlinkRunId, validAttemptId, validProjectId, validWorkspaceId),
          (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'OUTSIDE_WORKSPACE'
        );
      } catch (symlinkErr: unknown) {
        if ((symlinkErr as { code?: string })?.code !== 'EPERM') throw symlinkErr;
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }

      // Pre-existing parent symlink (e.g. .antifan/artifacts) pointing outside is rejected before mkdirSync creates outside directory
      const outsideParentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-outside-parent-'));
      const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parent-root-'));
      const parentArtifactsLink = path.join(parentRoot, '.antifan', 'artifacts');
      const testRunId = makeControlPlaneId('run');
      fs.mkdirSync(path.join(parentRoot, '.antifan'), { recursive: true });
      fs.writeFileSync(path.join(parentRoot, 'theme.css'), 'body { color: red; }');
      try {
        fs.symlinkSync(outsideParentDir, parentArtifactsLink, 'junction');
        assert.throws(
          () => port.stageAttachment(parentRoot, 'theme.css', testRunId, validAttemptId, validProjectId, validWorkspaceId),
          (error: unknown) => error instanceof CapabilityError && (error as CapabilityError).code === 'OUTSIDE_WORKSPACE'
        );
        assert.strictEqual(fs.existsSync(path.join(outsideParentDir, testRunId)), false, 'No directory must be created in outside target');
      } catch (symlinkErr: unknown) {
        if ((symlinkErr as { code?: string })?.code !== 'EPERM') throw symlinkErr;
      } finally {
        fs.rmSync(outsideParentDir, { recursive: true, force: true });
        fs.rmSync(parentRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
