/**
 * restore.mjs — Path-scoped restore for AntiFan B-Lite v2 Fix Loop
 *
 * Restores only files touched by the fix loop from stored pre-merge content.
 * INVARIANT: Never touches VCS / git state. No git checkout, no git clean, no git reset.
 * Operates purely on the filesystem via stored pre-merge byte copies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizePath, normalizeManifestMap } from './audits.mjs';
import { sha256, resolveSafePath } from './stage-workspace.mjs';

/**
 * Performs path-scoped restore of specified paths from stored-content backup.
 *
 * @param {object} params
 * @param {string} params.stagingDir - Path to .canary/staging/<runId>/
 * @param {string} params.targetDir - Path to real workspace target subtree
 * @param {string[]} [params.touchedPaths] - Paths to restore (if omitted, reads from receipt or diff)
 * @param {any} [params.baseManifest] - Base manifest to verify against
 * @returns {{
 *   ok: boolean,
 *   targetDir: string,
 *   restoredPaths: string[],
 *   deletedPaths: string[],
 *   verifiedPaths: string[],
 *   restoredAt: string,
 *   errors?: string[]
 * }}
 */
export function restoreWorkspace({
  stagingDir,
  targetDir,
  touchedPaths,
  baseManifest = null,
}) {
  const absStaging = path.resolve(stagingDir);
  const absTarget = path.resolve(targetDir);

  if (!fs.existsSync(absStaging)) {
    throw new Error(`Staging directory does not exist: ${absStaging}`);
  }
  if (!fs.existsSync(absTarget)) {
    throw new Error(`Target directory does not exist: ${absTarget}`);
  }

  // Safety: neither path may contain .antifan-data
  if (absStaging.toLowerCase().includes('.antifan-data') || absTarget.toLowerCase().includes('.antifan-data')) {
    throw new Error(`Refusing restore: path contains forbidden '.antifan-data'`);
  }

  const storedContentDir = path.join(absStaging, 'stored-content');
  if (!fs.existsSync(storedContentDir)) {
    throw new Error(`Stored pre-merge content directory not found: ${storedContentDir}`);
  }

  // Load base manifest if not provided
  if (!baseManifest) {
    const baseManifestFile = path.join(absStaging, 'base-manifest.json');
    if (fs.existsSync(baseManifestFile)) {
      try {
        baseManifest = JSON.parse(fs.readFileSync(baseManifestFile, 'utf8'));
      } catch {
        baseManifest = null;
      }
    }
  }
  const baseMap = normalizeManifestMap(baseManifest);

  // If touchedPaths not specified, check receipt.json or audit
  let pathsToRestore = touchedPaths;
  if (!Array.isArray(pathsToRestore) || pathsToRestore.length === 0) {
    const receiptFile = path.join(absStaging, 'receipt.json');
    if (fs.existsSync(receiptFile)) {
      try {
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        if (Array.isArray(receipt.touchedPaths)) {
          pathsToRestore = receipt.touchedPaths;
        }
      } catch {}
    }
  }

  // If still empty, restore all files recorded in storedContentDir
  if (!Array.isArray(pathsToRestore) || pathsToRestore.length === 0) {
    pathsToRestore = Object.keys(baseMap);
  }

  const restoredPaths = [];
  const deletedPaths = [];
  const verifiedPaths = [];
  const errors = [];

  for (const rawPath of pathsToRestore) {
    const norm = normalizePath(rawPath);
    if (!norm) continue;

    // Confinement assertion
    const { resolvedPath: targetFilePath } = resolveSafePath(norm, absTarget);
    const storedFilePath = path.join(storedContentDir, norm);

    if (fs.existsSync(storedFilePath)) {
      // File existed before merge: restore from stored-content
      try {
        fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
        fs.copyFileSync(storedFilePath, targetFilePath);
        restoredPaths.push(norm);

        // Verification check
        const restoredBuf = fs.readFileSync(targetFilePath);
        const restoredHash = sha256(restoredBuf);
        const expected = baseMap[norm]?.sha256;

        if (expected && restoredHash !== expected) {
          errors.push(`Hash mismatch after restore on ${norm}: expected ${expected}, got ${restoredHash}`);
        } else {
          verifiedPaths.push(norm);
        }
      } catch (err) {
        errors.push(`Failed to restore ${norm}: ${err.message}`);
      }
    } else {
      // File was newly created by loop: remove it from target
      if (fs.existsSync(targetFilePath)) {
        try {
          fs.unlinkSync(targetFilePath);
          deletedPaths.push(norm);
          verifiedPaths.push(norm);

          // Clean empty parent directory if empty
          let parent = path.dirname(targetFilePath);
          while (parent !== absTarget && fs.existsSync(parent)) {
            const children = fs.readdirSync(parent);
            if (children.length === 0) {
              fs.rmdirSync(parent);
              parent = path.dirname(parent);
            } else {
              break;
            }
          }
        } catch (err) {
          errors.push(`Failed to delete added file ${norm}: ${err.message}`);
        }
      }
    }
  }

  const restoredAt = new Date().toISOString();
  const ok = errors.length === 0;

  const receipt = {
    ok,
    targetDir: absTarget,
    restoredPaths,
    deletedPaths,
    verifiedPaths,
    restoredAt,
    ...(errors.length > 0 ? { errors } : {}),
  };

  // Write restore receipt into staging dir
  fs.writeFileSync(
    path.join(absStaging, 'restore-receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    'utf8'
  );

  return receipt;
}

// CLI runner
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  let stagingDir = null;
  let targetDir = null;
  let paths = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stagingDir' || args[i] === '--staging-dir') stagingDir = args[++i];
    else if (args[i] === '--targetDir' || args[i] === '--target-dir') targetDir = args[++i];
    else if (args[i] === '--paths') paths = args[++i]?.split(',').map((s) => s.trim());
  }

  if (!stagingDir || !targetDir) {
    console.error('Usage: node restore.mjs --staging-dir <dir> --target-dir <dir> [--paths p1,p2]');
    process.exit(1);
  }

  try {
    const result = restoreWorkspace({ stagingDir, targetDir, touchedPaths: paths });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(`[restore] Failed:`, err);
    process.exit(1);
  }
}
