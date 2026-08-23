import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ArtifactRef, CapabilityError, assertNoReparseTraversal, assertWorkspaceContained } from '../../shared/control-plane-contracts';

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

  write(root: string, relativePath: string, content: string | Buffer): { path: string; byteLength: number; sha256: string } {
    const target = this.resolve(root, relativePath);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (data.byteLength > this.maxBytes) throw new CapabilityError('ARTIFACT_TOO_LARGE', `File exceeds ${this.maxBytes} byte limit`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, target);
    return { path: target, byteLength: data.byteLength, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }

  stageAttachment(root: string, sourcePath: string, runId: string, attemptId: string, maxBytes = 8 * 1024 * 1024): ArtifactRef {
    const source = this.resolve(root, sourcePath);
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new CapabilityError('INVALID_ARGUMENT', 'Attachment must be a regular file');
    if (stat.size > maxBytes) throw new CapabilityError('ARTIFACT_TOO_LARGE', `Attachment exceeds ${maxBytes} byte limit`);
    const data = fs.readFileSync(source);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const artifactPath = path.join(root, '.antifan', 'artifacts', runId, `${sha256}-${path.basename(source)}`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, data, { flag: 'wx' });
    return { id: `artifact-${crypto.randomUUID()}`, runId, attemptId, kind: 'attachment', path: artifactPath, byteLength: data.byteLength, sha256, mime: mimeFor(source), truncated: false, redacted: false, createdAt: Date.now() };
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
