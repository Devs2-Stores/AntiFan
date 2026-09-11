/**
 * stage-workspace.mjs — Workspace staging and confinement for AntiFan B-Lite v2
 *
 * Copies the live working tree target into an isolated staging area (.canary/staging/<runId>/),
 * mints a base manifest with sorted file hashes, stores pre-merge content for every file,
 * pins the effective workspace root (THEME_WORKSPACE_ROOT / ANTIFAN_WORKSPACE_ROOT),
 * and enforces strict path confinement preventing escape or access to .antifan-data.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizePath, DECISIONS } from './audits.mjs';

export const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.antifan-data',
  'node_modules',
  '.canary',
]);

/**
 * Computes sha256 of a Buffer or string.
 * @param {Buffer | string} input
 * @returns {string}
 */
export function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Safely resolves git HEAD commit hash.
 * @param {string} [cwd]
 * @returns {string}
 */
export function getGitHead(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return 'UNKNOWN_HEAD';
  }
}

/**
 * Resolves and validates a candidate path against a designated root directory.
 * INVARIANTS:
 * 1. Rejects any candidate containing '.antifan-data' (case-insensitive).
 * 2. Rejects any path that escapes rootDir (directory traversal).
 *
 * @param {string} candidatePath
 * @param {string} rootDir
 * @returns {{ resolvedPath: string, relativePath: string }}
 * @throws {Error & { code: string }}
 */
export function resolveSafePath(candidatePath, rootDir) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    const err = new Error('Empty or invalid candidate path');
    err.code = DECISIONS.REFUSED_TOUCHED_PATH;
    throw err;
  }

  const raw = candidatePath.replace(/\\/g, '/');

  // Reject .antifan-data
  if (raw.toLowerCase().includes('.antifan-data')) {
    const err = new Error(`Access refused: candidate path contains forbidden '.antifan-data': ${candidatePath}`);
    err.code = DECISIONS.REFUSED_TOUCHED_PATH;
    err.offendingPath = candidatePath;
    throw err;
  }

  const absRoot = path.resolve(rootDir);
  const resolved = path.resolve(absRoot, candidatePath);

  // Check boundary escape
  const rel = path.relative(absRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error(`Access refused: path escapes staged workspace root: ${candidatePath}`);
    err.code = DECISIONS.REFUSED_TOUCHED_PATH;
    err.offendingPath = candidatePath;
    throw err;
  }

  // Double-check resolved path does not contain .antifan-data
  if (resolved.toLowerCase().includes('.antifan-data')) {
    const err = new Error(`Access refused: resolved path contains forbidden '.antifan-data': ${resolved}`);
    err.code = DECISIONS.REFUSED_TOUCHED_PATH;
    err.offendingPath = candidatePath;
    throw err;
  }

  return {
    resolvedPath: resolved,
    relativePath: normalizePath(rel),
  };
}

/**
 * Asserts that a target path is strictly within rootDir.
 * @param {string} targetPath
 * @param {string} rootDir
 * @returns {string} normalized relative path
 */
export function assertPathWithinRoot(targetPath, rootDir) {
  const { relativePath } = resolveSafePath(targetPath, rootDir);
  return relativePath;
}

/**
 * Recursively scans a directory and mints a sorted manifest (path -> { sha256, size }).
 *
 * @param {string} dirPath
 * @param {object} [options]
 * @param {Set<string>} [options.excludeDirs]
 * @param {string} [options.baseDir]
 * @returns {{
 *   manifestHash: string,
 *   files: Record<string, { sha256: string, size: number }>,
 *   fileList: Array<{ path: string, sha256: string, size: number }>,
 *   totalFiles: number,
 *   totalBytes: number
 * }}
 */
export function mintManifest(dirPath, options = {}) {
  const baseDir = path.resolve(options.baseDir || dirPath);
  const excludeDirs = options.excludeDirs || EXCLUDED_DIR_NAMES;
  const fileList = [];
  const files = {};
  let totalBytes = 0;

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const ent of entries) {
      const fullPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        if (excludeDirs.has(ent.name) || ent.name.startsWith('.tmp-')) {
          continue;
        }
        walk(fullPath);
      } else if (ent.isFile()) {
        const rel = normalizePath(path.relative(baseDir, fullPath));
        if (!rel) continue;

        const buf = fs.readFileSync(fullPath);
        const hash = sha256(buf);
        const size = buf.length;

        files[rel] = { sha256: hash, size };
        fileList.push({ path: rel, sha256: hash, size });
        totalBytes += size;
      }
    }
  }

  walk(baseDir);

  fileList.sort((a, b) => a.path.localeCompare(b.path));

  // Deterministic tree hash
  const manifestHash = sha256(
    fileList.map((f) => `${f.path}\u0000${f.size}\u0000${f.sha256}`).join('\n')
  );

  return {
    manifestHash,
    files,
    fileList,
    totalFiles: fileList.length,
    totalBytes,
  };
}

/**
 * Stages a copy of the target subtree into .canary/staging/<runId>/
 * from the live working tree, mints a base manifest, stores pre-merge content,
 * and records stage metadata.
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {string} [params.sourceDir]
 * @param {string} [params.stagingParentDir]
 * @param {string[]} [params.allowedFiles]
 * @param {string} [params.surfaceId]
 * @returns {{
 *   runId: string,
 *   sourceRoot: string,
 *   stagedRoot: string,
 *   stagingDir: string,
 *   storedContentDir: string,
 *   baseManifestHash: string,
 *   gitHead: string,
 *   manifest: any,
 *   env: { THEME_WORKSPACE_ROOT: string, ANTIFAN_WORKSPACE_ROOT: string },
 *   stagedAt: string
 * }}
 */
export function stageWorkspace({
  runId,
  sourceDir = process.cwd(),
  stagingParentDir = path.join(process.cwd(), '.canary', 'staging'),
  allowedFiles = [],
  surfaceId = 'default',
}) {
  if (!runId) {
    runId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }

  const resolvedSource = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Source directory does not exist: ${resolvedSource}`);
  }

  if (resolvedSource.toLowerCase().includes('.antifan-data')) {
    const err = new Error(`Refusing to stage from forbidden directory containing '.antifan-data': ${resolvedSource}`);
    err.code = DECISIONS.REFUSED_TOUCHED_PATH;
    throw err;
  }

  const stagingDir = path.resolve(stagingParentDir, runId);
  const stagedRoot = path.join(stagingDir, 'staged');
  const storedContentDir = path.join(stagingDir, 'stored-content');

  // Prepare clean staging directories
  fs.mkdirSync(stagedRoot, { recursive: true });
  fs.mkdirSync(storedContentDir, { recursive: true });

  // Copy live working tree target into stagedRoot and storedContentDir
  function copyRecursive(src, dstStaged, dstStored) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const ent of entries) {
      if (EXCLUDED_DIR_NAMES.has(ent.name) || ent.name.startsWith('.tmp-')) {
        continue;
      }
      const srcPath = path.join(src, ent.name);
      const stagedPath = path.join(dstStaged, ent.name);
      const storedPath = path.join(dstStored, ent.name);

      if (ent.isDirectory()) {
        fs.mkdirSync(stagedPath, { recursive: true });
        fs.mkdirSync(storedPath, { recursive: true });
        copyRecursive(srcPath, stagedPath, storedPath);
      } else if (ent.isFile()) {
        fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.copyFileSync(srcPath, stagedPath);
        fs.copyFileSync(srcPath, storedPath);
      }
    }
  }

  copyRecursive(resolvedSource, stagedRoot, storedContentDir);

  // Mint base manifest from staged copy
  const manifest = mintManifest(stagedRoot);
  const gitHead = getGitHead(resolvedSource);
  const stagedAt = new Date().toISOString();

  // Write base-manifest.json
  const manifestPayload = {
    runId,
    surfaceId,
    sourceRoot: resolvedSource,
    stagedRoot,
    gitHead,
    manifestHash: manifest.manifestHash,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
    stagedAt,
    files: manifest.files,
    fileList: manifest.fileList,
  };
  fs.writeFileSync(
    path.join(stagingDir, 'base-manifest.json'),
    JSON.stringify(manifestPayload, null, 2) + '\n',
    'utf8'
  );

  // Environment variables pinning the fixer session's workspace root
  const envVars = {
    THEME_WORKSPACE_ROOT: stagedRoot,
    ANTIFAN_WORKSPACE_ROOT: stagedRoot,
  };

  // Write stage-meta.json
  const metaPayload = {
    runId,
    surfaceId,
    sourceRoot: resolvedSource,
    stagedRoot,
    stagingDir,
    storedContentDir,
    gitHead,
    baseManifestHash: manifest.manifestHash,
    allowedFiles,
    env: envVars,
    stagedAt,
  };
  fs.writeFileSync(
    path.join(stagingDir, 'stage-meta.json'),
    JSON.stringify(metaPayload, null, 2) + '\n',
    'utf8'
  );

  return {
    runId,
    sourceRoot: resolvedSource,
    stagedRoot,
    stagingDir,
    storedContentDir,
    baseManifestHash: manifest.manifestHash,
    gitHead,
    manifest,
    env: envVars,
    stagedAt,
  };
}

// CLI runner if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  let runId = null;
  let sourceDir = process.cwd();
  let stagingParent = path.join(process.cwd(), '.canary', 'staging');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runId' || args[i] === '--run-id') runId = args[++i];
    else if (args[i] === '--source' || args[i] === '--sourceDir') sourceDir = args[++i];
    else if (args[i] === '--stagingDir' || args[i] === '--staging-dir') stagingParent = args[++i];
  }

  try {
    const staged = stageWorkspace({ runId, sourceDir, stagingParentDir: stagingParent });
    console.log(JSON.stringify(staged, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[stage-workspace] Failed:`, err);
    process.exit(1);
  }
}
