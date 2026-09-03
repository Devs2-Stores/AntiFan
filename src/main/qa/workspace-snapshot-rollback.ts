import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoReparseTraversal, assertWorkspaceContained, CapabilityError } from '../../shared/control-plane-contracts';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.antifan', '.compiled', 'dist', 'build', 'specs']);

export interface FileSnapshotEntry {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface WorkspaceSnapshotManifest {
  manifestVersion: '1.0';
  runId: string;
  workspaceRoot: string;
  createdAt: number;
  files: Record<string, FileSnapshotEntry>;
  backupDir: string;
}

export interface WorkspaceRollbackResult {
  restoredFiles: string[];
  deletedOrphanFiles: string[];
  unmodifiedFilesCount: number;
  success: boolean;
}

function sanitizeRunId(runId: string): string {
  if (!runId || typeof runId !== 'string') {
    throw new CapabilityError('INVALID_ARGUMENT', 'Valid runId is required for snapshot');
  }
  const clean = runId.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clean)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Invalid runId format: "${runId}"`);
  }
  return clean;
}

/**
 * Recursively scans directory and collects all regular file paths relative to root.
 * Fails closed on any reparse point / symlink / out-of-bounds path.
 */
function scanWorkspaceFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    assertNoReparseTraversal(root, fullPath);
    assertWorkspaceContained(root, fullPath);

    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new CapabilityError('INVALID_ARGUMENT', `Symbolic links are forbidden in workspace snapshot: ${fullPath}`);
    }

    if (stat.isDirectory()) {
      results.push(...scanWorkspaceFiles(fullPath, root));
    } else if (stat.isFile()) {
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      results.push(relPath);
    }
  }
  return results;
}

async function writeAtomicWithRetry(target: string, data: Buffer, maxRetries = 5): Promise<void> {
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

/**
 * Creates an immutable snapshot manifest and file backups for Round 0 workspace state.
 */
export async function createWorkspaceSnapshotManifest(
  workspaceRoot: string,
  runId: string
): Promise<WorkspaceSnapshotManifest> {
  const cleanRunId = sanitizeRunId(runId);
  const normalizedRoot = path.resolve(workspaceRoot);
  assertNoReparseTraversal(normalizedRoot, normalizedRoot);

  const backupDir = path.join(normalizedRoot, '.antifan', 'snapshots', `r0-${cleanRunId}`);
  assertWorkspaceContained(normalizedRoot, backupDir);
  const dataDir = path.join(backupDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const relativeFiles = scanWorkspaceFiles(normalizedRoot, normalizedRoot);
  const filesRecord: Record<string, FileSnapshotEntry> = {};

  for (const relPath of relativeFiles) {
    const fullPath = path.resolve(normalizedRoot, relPath);
    assertNoReparseTraversal(normalizedRoot, fullPath);
    assertWorkspaceContained(normalizedRoot, fullPath);

    const content = fs.readFileSync(fullPath);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const backupFile = path.join(dataDir, sha256);

    if (!fs.existsSync(backupFile)) {
      await writeAtomicWithRetry(backupFile, content);
    }

    filesRecord[relPath] = {
      relativePath: relPath,
      sha256,
      byteLength: content.byteLength,
    };
  }

  const manifest: WorkspaceSnapshotManifest = {
    manifestVersion: '1.0',
    runId: cleanRunId,
    workspaceRoot: normalizedRoot,
    createdAt: Date.now(),
    files: filesRecord,
    backupDir,
  };

  const manifestFile = path.join(backupDir, 'manifest.json');
  await writeAtomicWithRetry(manifestFile, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  return manifest;
}

/**
 * Atomically rolls back workspace state to matching R0 snapshot manifest.
 * - Validates manifest structure, hashes, and size invariants.
 * - Restores any modified or deleted baseline files via atomic write.
 * - Deletes newly created orphan files.
 * - Fails closed on any mismatch or I/O failure.
 */
export async function rollbackWorkspaceToManifest(
  workspaceRoot: string,
  manifest: WorkspaceSnapshotManifest
): Promise<WorkspaceRollbackResult> {
  if (!manifest || typeof manifest !== 'object' || manifest.manifestVersion !== '1.0') {
    throw new CapabilityError('INVALID_ARGUMENT', 'Invalid or unsupported snapshot manifest format');
  }

  const cleanRunId = sanitizeRunId(manifest.runId);
  const normalizedRoot = path.resolve(workspaceRoot);
  assertNoReparseTraversal(normalizedRoot, normalizedRoot);

  if (manifest.workspaceRoot !== normalizedRoot) {
    throw new CapabilityError(
      'WORKSPACE_MISMATCH',
      `Manifest workspace root "${manifest.workspaceRoot}" does not match target root "${normalizedRoot}"`
    );
  }

  // Derive authoritative backup directory strictly from workspaceRoot and cleanRunId
  const authoritativeBackupDir = path.join(normalizedRoot, '.antifan', 'snapshots', `r0-${cleanRunId}`);
  assertWorkspaceContained(normalizedRoot, authoritativeBackupDir);
  const dataDir = path.join(authoritativeBackupDir, 'data');

  if (!fs.existsSync(dataDir)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Snapshot data directory missing at ${dataDir}`);
  }

  const restoredFiles: string[] = [];
  const deletedOrphanFiles: string[] = [];
  let unmodifiedFilesCount = 0;

  // 1. Restore modified or missing baseline files
  for (const [relPath, entry] of Object.entries(manifest.files)) {
    if (!entry || typeof entry !== 'object' || relPath !== entry.relativePath) {
      throw new CapabilityError('INVALID_ARGUMENT', `Manifest entry key "${relPath}" does not match relativePath`);
    }
    if (path.isAbsolute(relPath) || relPath.includes('..')) {
      throw new CapabilityError('INVALID_ARGUMENT', `Illegal relative path in manifest: ${relPath}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256) || typeof entry.byteLength !== 'number' || entry.byteLength < 0) {
      throw new CapabilityError('INVALID_ARGUMENT', `Malformed hash or size in manifest entry: ${relPath}`);
    }

    const fullPath = path.resolve(normalizedRoot, relPath);
    assertNoReparseTraversal(normalizedRoot, fullPath);
    assertWorkspaceContained(normalizedRoot, fullPath);

    let needsRestore = true;
    if (fs.existsSync(fullPath)) {
      const currentContent = fs.readFileSync(fullPath);
      const currentSha256 = crypto.createHash('sha256').update(currentContent).digest('hex');
      if (currentSha256 === entry.sha256 && currentContent.byteLength === entry.byteLength) {
        needsRestore = false;
        unmodifiedFilesCount++;
      }
    }

    if (needsRestore) {
      const backupFile = path.join(dataDir, entry.sha256);
      if (!fs.existsSync(backupFile)) {
        throw new CapabilityError('INVALID_ARGUMENT', `Backup file missing for ${relPath} (sha: ${entry.sha256})`);
      }
      const backupContent = fs.readFileSync(backupFile);
      const backupActualSha256 = crypto.createHash('sha256').update(backupContent).digest('hex');
      if (backupActualSha256 !== entry.sha256 || backupContent.byteLength !== entry.byteLength) {
        throw new CapabilityError(
          'FINGERPRINT_MISMATCH',
          `Backup content digest mismatch for ${relPath}: expected ${entry.sha256}, got ${backupActualSha256}`
        );
      }

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      await writeAtomicWithRetry(fullPath, backupContent);
      restoredFiles.push(relPath);
    }
  }

  // 2. Delete newly created orphan files absent from the manifest
  const currentFiles = scanWorkspaceFiles(normalizedRoot, normalizedRoot);
  for (const curRelPath of currentFiles) {
    if (!(curRelPath in manifest.files)) {
      const fullPath = path.resolve(normalizedRoot, curRelPath);
      assertNoReparseTraversal(normalizedRoot, fullPath);
      assertWorkspaceContained(normalizedRoot, fullPath);
      try {
        fs.unlinkSync(fullPath);
        deletedOrphanFiles.push(curRelPath);
      } catch (err) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          `Failed to delete orphan file ${curRelPath} during rollback: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return {
    restoredFiles,
    deletedOrphanFiles,
    unmodifiedFilesCount,
    success: true,
  };
}
