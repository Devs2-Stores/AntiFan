import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ArtifactRef, CapabilityError, assertNoReparseTraversal, assertWorkspaceContained, validateControlPlaneId } from '../../shared/control-plane-contracts';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class WorkspaceFilePort {
  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  read(root: string, relativePath: string, maxBytes = this.maxBytes): { path: string; content: string; truncated: boolean } {
    const target = this.resolve(root, relativePath);
    if (!fs.existsSync(target)) {
      return { path: target, content: '', truncated: false };
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) {
      return { path: target, content: '', truncated: false };
    }
    const data = fs.readFileSync(target);
    const truncated = data.byteLength > maxBytes;
    return { path: target, content: data.subarray(0, maxBytes).toString('utf8'), truncated };
  }

  async write(root: string, relativePath: string, content: string | Buffer): Promise<{ path: string; byteLength: number; sha256: string }> {
    const target = this.resolve(root, relativePath);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (data.byteLength > this.maxBytes) throw new CapabilityError('ARTIFACT_TOO_LARGE', `File exceeds ${this.maxBytes} byte limit`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await this.writeAtomicWithRetry(target, data);
    return { path: target, byteLength: data.byteLength, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }

  private async writeAtomicWithRetry(target: string, data: Buffer, maxRetries = 5): Promise<void> {
    const delays = [10, 25, 50, 100, 200];
    const temp = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(temp, data);

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          fs.renameSync(temp, target);
          return;
        } catch (err: unknown) {
          let errCode = '';
          if (err && typeof err === 'object' && 'code' in err) {
            const codeVal = err.code;
            if (typeof codeVal === 'string') errCode = codeVal;
          }
          const isLockError = errCode === 'EBUSY' || errCode === 'EPERM' || errCode === 'EACCES';
          if (!isLockError) {
            // Non-lock error (e.g. ENOSPC, EIO): rethrow immediately without retrying or masking
            throw err;
          }
          if (attempt === maxRetries) {
            throw new CapabilityError(
              'FILE_LOCK_TIMEOUT',
              `Failed to write file ${target} after ${attempt} retries due to lock contention: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          const jitter = Math.floor(Math.random() * 10);
          const delayMs = (delays[attempt] || 200) + jitter;
          await sleep(delayMs);
        }
      }
    } finally {
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {}
    }
  }

  stageAttachment(root: string, sourcePath: string, runId: string, attemptId: string, projectId: string, workspaceId: string, maxBytes = 8 * 1024 * 1024): ArtifactRef {
    const validRunId = validateControlPlaneId(runId, 'run');
    const validAttemptId = validateControlPlaneId(attemptId, 'attempt');
    const validProjectId = validateControlPlaneId(projectId, 'project');
    const validWorkspaceId = validateControlPlaneId(workspaceId, 'workspace');

    const source = this.resolve(root, sourcePath);
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new CapabilityError('INVALID_ARGUMENT', 'Attachment must be a regular file');
    if (stat.size > maxBytes) throw new CapabilityError('ARTIFACT_TOO_LARGE', `Attachment exceeds ${maxBytes} byte limit`);
    const data = fs.readFileSync(source);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const artifactDir = path.join(root, '.antifan', 'artifacts', validRunId);
    const artifactPath = path.join(artifactDir, `${sha256}-${path.basename(source)}`);
    assertWorkspaceContained(root, artifactPath);
    assertNoReparseTraversal(root, artifactDir);
    fs.mkdirSync(artifactDir, { recursive: true });
    assertNoReparseTraversal(root, artifactPath);
    try {
      fs.writeFileSync(artifactPath, data, { flag: 'wx' });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'EEXIST') {
        const existingStat = fs.lstatSync(artifactPath);
        if (!existingStat.isFile()) {
          throw new CapabilityError('INVALID_ARGUMENT', `Existing attachment path '${artifactPath}' is not a regular file`);
        }
        const existingBytes = fs.readFileSync(artifactPath);
        const existingSha256 = crypto.createHash('sha256').update(existingBytes).digest('hex');
        if (existingSha256 !== sha256) {
          throw new CapabilityError('INVALID_ARGUMENT', `Existing artifact hash '${existingSha256}' does not match expected sha256 '${sha256}'`);
        }
      } else {
        throw err;
      }
    }
    return { id: `artifact-${crypto.randomUUID()}`, runId: validRunId, attemptId: validAttemptId, projectId: validProjectId, workspaceId: validWorkspaceId, kind: 'attachment', path: artifactPath, byteLength: data.byteLength, sha256, mime: mimeFor(source), truncated: false, redacted: false, createdAt: Date.now() };
  }

  private resolve(root: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) throw new CapabilityError('INVALID_ARGUMENT', 'A relative workspace path is required');
    const target = path.resolve(root, relativePath);
    assertNoReparseTraversal(root, target);
    return assertWorkspaceContained(root, target);
  }
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.html' ? 'text/html' : ext === '.md' ? 'text/markdown' : 'text/plain';
}
