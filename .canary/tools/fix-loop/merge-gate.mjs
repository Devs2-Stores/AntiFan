/**
 * merge-gate.mjs — Merge Gate CLI & Engine for AntiFan B-Lite v2
 *
 * Provides CLI subcommands: stage | audit | merge | restore.
 * Enforces isolation-at-merge:
 * 1. Refuses on drift (stage-time manifest ≠ merge-time base) before write.
 * 2. Refuses on audit failure (scope, diffBudget, maxScopeExpansion, tool surface, self-verification).
 * 3. Backs up pre-merge content of files to overwrite.
 * 4. Applies only the audited subset (touchedPaths).
 * 5. Re-hashes post-merge state, asserting base ⊕ staged diff equality, restoring on mismatch.
 * 6. Mints atomic merge receipt.
 *
 * Exit codes:
 *   0  OK
 *  10  REFUSED_TOUCHED_PATH
 *  11  REFUSED_DIFF_BUDGET
 *  12  REFUSED_SCOPE_EXPANSION
 *  13  REFUSED_DRIFT
 *  14  REFUSED_TOOL_SURFACE
 *  15  REFUSED_SELF_VERIFICATION
 *  16  REFUSED_SCOPE
 *   1  ERROR / Exception
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DECISIONS,
  normalizePath,
  normalizeManifestMap,
  computeManifestDiff,
  measureChangedBytes,
  runAllAudits,
  auditDrift,
} from './audits.mjs';
import {
  stageWorkspace,
  mintManifest,
  sha256,
  resolveSafePath,
} from './stage-workspace.mjs';
import { restoreWorkspace } from './restore.mjs';

export const EXIT_CODES = Object.freeze({
  OK: 0,
  REFUSED_TOUCHED_PATH: 10,
  REFUSED_DIFF_BUDGET: 11,
  REFUSED_SCOPE_EXPANSION: 12,
  REFUSED_DRIFT: 13,
  REFUSED_TOOL_SURFACE: 14,
  REFUSED_SELF_VERIFICATION: 15,
  REFUSED_SCOPE: 16,
  ERROR: 1,
});

/**
 * Maps decision string to process exit code.
 * @param {string} decision
 * @returns {number}
 */
export function decisionToExitCode(decision) {
  if (decision in EXIT_CODES) {
    return EXIT_CODES[decision];
  }
  return EXIT_CODES.ERROR;
}

/**
 * Loads a JSON file safely or returns null.
 * @param {string} filePath
 * @returns {any}
 */
function loadJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Subcommand: audit
 * Evaluates staged workspace against base manifest and request.
 */
export function auditStagedWorkspace({
  stagingDir,
  targetDir = null,
  request = {},
  fixerResult = {},
}) {
  const absStaging = path.resolve(stagingDir);
  const baseManifestPath = path.join(absStaging, 'base-manifest.json');
  const stagedRoot = path.join(absStaging, 'staged');

  if (!fs.existsSync(baseManifestPath)) {
    throw new Error(`Base manifest not found: ${baseManifestPath}`);
  }
  if (!fs.existsSync(stagedRoot)) {
    throw new Error(`Staged root not found: ${stagedRoot}`);
  }

  const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
  const postManifest = mintManifest(stagedRoot);

  let currentBaseManifest = null;
  if (targetDir && fs.existsSync(targetDir)) {
    currentBaseManifest = mintManifest(targetDir);
  }

  // Both versions of every staged file are on disk (the staged copy, and the pre-merge
  // content the stage step stored), so the diff budget can count the bytes actually
  // changed instead of inferring them from the size delta. A file that cannot be read as
  // text (or that is binary) leaves the callback with nothing to measure: it returns
  // null and the manifest delta is used, which is also all a manifest-only caller knows.
  const readText = (filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  };
  const changedBytesFor = (p, baseEntry, postEntry) => {
    const baseText = readText(path.join(absStaging, 'stored-content', p));
    const postText = readText(path.join(stagedRoot, p));
    if (baseText === null || postText === null) return null;
    if (baseText.includes('\u0000') || postText.includes('\u0000')) return null;
    const bytes = measureChangedBytes(baseText, postText, baseEntry?.size ?? 0, postEntry?.size ?? 0);
    return Number.isFinite(bytes) ? bytes : null;
  };

  const auditResult = runAllAudits({
    baseManifest,
    postManifest,
    request,
    currentBaseManifest,
    fixerResult,
    changedBytesFor,
  });

  return auditResult;
}

/**
 * Subcommand: merge
 * Audits, verifies drift, applies touched subset, re-hashes, mints receipt.
 */
export function mergeStagedWorkspace({
  stagingDir,
  targetDir,
  request = {},
  attemptId = null,
  fixerResult = {},
}) {
  const absStaging = path.resolve(stagingDir);
  const absTarget = path.resolve(targetDir);

  // Confinement & safety assertions
  if (absStaging.toLowerCase().includes('.antifan-data') || absTarget.toLowerCase().includes('.antifan-data')) {
    const err = new Error(`Refusing merge: path contains forbidden '.antifan-data'`);
    err.code = DECISIONS.REFUSED_TOUCHED_PATH;
    throw err;
  }

  const baseManifestPath = path.join(absStaging, 'base-manifest.json');
  const stageMetaPath = path.join(absStaging, 'stage-meta.json');
  const stagedRoot = path.join(absStaging, 'staged');
  const storedContentDir = path.join(absStaging, 'stored-content');

  if (!fs.existsSync(baseManifestPath)) throw new Error(`Missing base manifest: ${baseManifestPath}`);
  if (!fs.existsSync(stagedRoot)) throw new Error(`Missing staged root: ${stagedRoot}`);
  if (!fs.existsSync(absTarget)) throw new Error(`Target directory does not exist: ${absTarget}`);

  const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
  const stageMeta = loadJsonFile(stageMetaPath) || {};

  const effectiveAttemptId = attemptId || stageMeta.runId || `attempt-${Date.now()}`;
  const surfaceId = stageMeta.surfaceId || request.surfaceId || 'default';

  // Merge request overrides from stage-meta if not provided in request
  const mergedRequest = {
    ...request,
    allowedFiles: request.allowedFiles || stageMeta.allowedFiles || [],
    // No `forbiddenPaths` default here: `...request` carries a declared list, and an
    // omission must fall through to the audit's default set rather than being filled
    // with an empty array that would read as "nothing is forbidden".
    diffBudget: request.diffBudget || {},
    maxScopeExpansion: request.maxScopeExpansion ?? 0,
    requestedTargets: request.requestedTargets || [],
  };

  // ── Step 1: Drift Pre-Check ────────────────────────────────────────────────
  const currentBaseManifest = mintManifest(absTarget);
  const driftAudit = auditDrift(baseManifest, currentBaseManifest);

  if (driftAudit.decision !== DECISIONS.OK) {
    const refusalReceipt = {
      attemptId: effectiveAttemptId,
      runId: stageMeta.runId,
      surfaceId,
      stagedRoot,
      resolvedTargetRoot: absTarget,
      decision: DECISIONS.REFUSED_DRIFT,
      offendingPaths: driftAudit.offendingPaths,
      reason: driftAudit.reason,
      mintedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(absStaging, 'receipt.json'),
      JSON.stringify(refusalReceipt, null, 2) + '\n',
      'utf8'
    );
    return {
      decision: DECISIONS.REFUSED_DRIFT,
      ok: false,
      offendingPaths: driftAudit.offendingPaths,
      reason: driftAudit.reason,
      receipt: refusalReceipt,
    };
  }

  // ── Step 2: Staged Audit ───────────────────────────────────────────────────
  const postManifest = mintManifest(stagedRoot);
  const auditResult = runAllAudits({
    baseManifest,
    postManifest,
    request: mergedRequest,
    currentBaseManifest,
    fixerResult,
  });

  if (!auditResult.ok) {
    const refusalReceipt = {
      attemptId: effectiveAttemptId,
      runId: stageMeta.runId,
      surfaceId,
      stagedRoot,
      resolvedTargetRoot: absTarget,
      decision: auditResult.decision,
      offendingPaths: auditResult.offendingPaths,
      touchedPaths: auditResult.touchedPaths,
      budgets: auditResult.budgets,
      expandedPaths: auditResult.expandedPaths,
      notes: auditResult.notes,
      mintedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(absStaging, 'receipt.json'),
      JSON.stringify(refusalReceipt, null, 2) + '\n',
      'utf8'
    );
    return {
      decision: auditResult.decision,
      ok: false,
      offendingPaths: auditResult.offendingPaths,
      reason: auditResult.notes,
      receipt: refusalReceipt,
    };
  }

  const { touchedPaths } = auditResult;
  fs.mkdirSync(storedContentDir, { recursive: true });

  // ── Step 3: Store Pre-Merge Content ────────────────────────────────────────
  for (const relPath of touchedPaths) {
    const norm = normalizePath(relPath);
    const { resolvedPath: targetFile } = resolveSafePath(norm, absTarget);
    const storedFile = path.join(storedContentDir, norm);

    if (fs.existsSync(targetFile)) {
      fs.mkdirSync(path.dirname(storedFile), { recursive: true });
      fs.copyFileSync(targetFile, storedFile);
    }
  }

  // ── Step 4: Apply Only Audited Subset ──────────────────────────────────────
  const appliedPaths = [];
  const deletedPaths = [];

  for (const relPath of touchedPaths) {
    const norm = normalizePath(relPath);
    const { resolvedPath: stagedFile } = resolveSafePath(norm, stagedRoot);
    const { resolvedPath: targetFile } = resolveSafePath(norm, absTarget);

    if (fs.existsSync(stagedFile)) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(stagedFile, targetFile);
      appliedPaths.push(norm);
    } else {
      if (fs.existsSync(targetFile)) {
        fs.unlinkSync(targetFile);
        deletedPaths.push(norm);
      }
    }
  }
  // ── TEST-ONLY FAULT INJECTION SEAM ─────────────────────────────────────────
  // This seam exists ONLY for fault-injection testing of the post-merge re-hash
  // refusal path (Phase 4 chain gate 7). It is strictly gated by the environment
  // variable ANTIFAN_TEST_FAULT_INJECT_POST_MERGE. When the variable is unset or
  // empty, this block is completely inert and does not alter any non-test behavior.
  if (process.env.ANTIFAN_TEST_FAULT_INJECT_POST_MERGE) {
    const faultTarget = process.env.ANTIFAN_TEST_FAULT_INJECT_POST_MERGE;
    const relToCorrupt = faultTarget !== '1' && faultTarget !== 'true'
      ? faultTarget
      : (touchedPaths[0] || null);
    if (relToCorrupt) {
      const { resolvedPath: corruptFilePath } = resolveSafePath(normalizePath(relToCorrupt), absTarget);
      if (fs.existsSync(corruptFilePath)) {
        fs.appendFileSync(corruptFilePath, '\n/* FAULT_INJECTION_POST_MERGE_CORRUPTION */\n');
      } else {
        fs.writeFileSync(corruptFilePath, '/* FAULT_INJECTION_POST_MERGE_CORRUPTION */\n');
      }
    }
  }

  // ── Step 5: Post-Merge Re-Hash & Assertion (base ⊕ staged diff) ─────────────
  const postMergeTargetManifest = mintManifest(absTarget);
  const stagedMap = normalizeManifestMap(postManifest);
  const targetMap = normalizeManifestMap(postMergeTargetManifest);

  const verificationMismatches = [];
  const verifiedPaths = [];

  for (const relPath of touchedPaths) {
    const norm = normalizePath(relPath);
    const stagedEntry = stagedMap[norm];
    const targetEntry = targetMap[norm];

    if (stagedEntry) {
      if (!targetEntry || targetEntry.sha256 !== stagedEntry.sha256) {
        verificationMismatches.push({
          path: norm,
          expectedSha256: stagedEntry.sha256,
          actualSha256: targetEntry?.sha256 || 'MISSING',
        });
      } else {
        verifiedPaths.push(norm);
      }
    } else {
      if (targetEntry) {
        verificationMismatches.push({
          path: norm,
          expectedSha256: 'DELETED',
          actualSha256: targetEntry.sha256,
        });
      } else {
        verifiedPaths.push(norm);
      }
    }
  }

  if (verificationMismatches.length > 0) {
    // Post-merge mismatch! Restore path-scoped immediately and refuse with REFUSED_DRIFT
    const restoreResult = restoreWorkspace({
      stagingDir: absStaging,
      targetDir: absTarget,
      touchedPaths,
      baseManifest,
    });

    const failureReceipt = {
      attemptId: effectiveAttemptId,
      runId: stageMeta.runId,
      surfaceId,
      stagedRoot,
      resolvedTargetRoot: absTarget,
      decision: DECISIONS.REFUSED_DRIFT,
      postMergeVerification: {
        verified: false,
        mismatches: verificationMismatches,
      },
      restored: restoreResult.ok,
      reason: `Post-merge hash assertion failed; workspace restored to base state: ${verificationMismatches.map((m) => m.path).join(', ')}`,
      mintedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(absStaging, 'receipt.json'),
      JSON.stringify(failureReceipt, null, 2) + '\n',
      'utf8'
    );

    return {
      decision: DECISIONS.REFUSED_DRIFT,
      ok: false,
      offendingPaths: verificationMismatches.map((m) => m.path),
      reason: failureReceipt.reason,
      receipt: failureReceipt,
    };
  }

  // ── Step 6: Mint Success Receipt ───────────────────────────────────────────
  const successReceipt = {
    attemptId: effectiveAttemptId,
    runId: stageMeta.runId,
    surfaceId,
    stagedRoot,
    resolvedTargetRoot: absTarget,
    touchedPaths,
    appliedPaths,
    deletedPaths,
    budgets: auditResult.budgets,
    expandedPaths: auditResult.expandedPaths,
    postMergeVerification: {
      verified: true,
      verifiedPaths,
    },
    decision: DECISIONS.OK,
    mintedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(absStaging, 'receipt.json'),
    JSON.stringify(successReceipt, null, 2) + '\n',
    'utf8'
  );

  return {
    decision: DECISIONS.OK,
    ok: true,
    touchedPaths,
    budgets: auditResult.budgets,
    receipt: successReceipt,
  };
}

// ── CLI Driver ─────────────────────────────────────────────────────────────────
function parseCliArgs(argv) {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const options = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    }
  }

  return { subcommand, options };
}

export function runCli(argv = process.argv.slice(2)) {
  const { subcommand, options } = parseCliArgs(argv);

  if (!subcommand || ['-h', '--help', 'help'].includes(subcommand)) {
    console.log(`
merge-gate.mjs — AntiFan B-Lite v2 Isolation & Merge Gate CLI

Subcommands:
  stage     Stage live workspace into .canary/staging/<runId>/
            Options: --source <dir>, --run-id <id>, --staging-dir <dir>, --allowed <p1,p2>

  audit     Audit staged changes against base manifest & request
            Options: --staging-dir <dir>, --target <dir>, --request <file.json>

  merge     Audit and apply staged changes to target directory
            Options: --staging-dir <dir>, --target-dir <dir>, --request <file.json>, --attempt-id <id>

  restore   Path-scoped rollback of loop-written files from pre-merge backup
            Options: --staging-dir <dir>, --target-dir <dir>, --paths <p1,p2>

Exit Codes:
   0  OK
  10  REFUSED_TOUCHED_PATH
  11  REFUSED_DIFF_BUDGET
  12  REFUSED_SCOPE_EXPANSION
  13  REFUSED_DRIFT
  14  REFUSED_TOOL_SURFACE
  15  REFUSED_SELF_VERIFICATION
  16  REFUSED_SCOPE
   1  ERROR / Exception
`);
    return process.exit(0);
  }

  try {
    switch (subcommand) {
      case 'stage': {
        const allowed = options.allowed ? options.allowed.split(',').map((s) => s.trim()) : [];
        const res = stageWorkspace({
          runId: options.runId,
          sourceDir: options.source || options.sourceDir || process.cwd(),
          stagingParentDir: options.stagingDir || path.join(process.cwd(), '.canary', 'staging'),
          allowedFiles: allowed,
          surfaceId: options.surface || 'default',
        });
        console.log(JSON.stringify(res, null, 2));
        process.exit(EXIT_CODES.OK);
        break;
      }

      case 'audit': {
        if (!options.stagingDir) {
          console.error('Error: --staging-dir is required for audit');
          process.exit(EXIT_CODES.ERROR);
        }
        const req = options.request ? loadJsonFile(options.request) || {} : {};
        const fixerRes = options.fixerResult ? loadJsonFile(options.fixerResult) || {} : {};
        const res = auditStagedWorkspace({
          stagingDir: options.stagingDir,
          targetDir: options.target || options.targetDir,
          request: req,
          fixerResult: fixerRes,
        });
        console.log(JSON.stringify(res, null, 2));
        process.exit(decisionToExitCode(res.decision));
        break;
      }

      case 'merge': {
        if (!options.stagingDir || !options.targetDir) {
          console.error('Error: --staging-dir and --target-dir are required for merge');
          process.exit(EXIT_CODES.ERROR);
        }
        const req = options.request ? loadJsonFile(options.request) || {} : {};
        const fixerRes = options.fixerResult ? loadJsonFile(options.fixerResult) || {} : {};
        const res = mergeStagedWorkspace({
          stagingDir: options.stagingDir,
          targetDir: options.targetDir,
          request: req,
          attemptId: options.attemptId,
          fixerResult: fixerRes,
        });
        console.log(JSON.stringify(res, null, 2));
        process.exit(decisionToExitCode(res.decision));
        break;
      }

      case 'restore': {
        if (!options.stagingDir || !options.targetDir) {
          console.error('Error: --staging-dir and --target-dir are required for restore');
          process.exit(EXIT_CODES.ERROR);
        }
        const paths = options.paths ? options.paths.split(',').map((s) => s.trim()) : null;
        const res = restoreWorkspace({
          stagingDir: options.stagingDir,
          targetDir: options.targetDir,
          touchedPaths: paths,
        });
        console.log(JSON.stringify(res, null, 2));
        process.exit(res.ok ? EXIT_CODES.OK : EXIT_CODES.ERROR);
        break;
      }

      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        process.exit(EXIT_CODES.ERROR);
    }
  } catch (err) {
    const code = err.code && err.code in EXIT_CODES ? EXIT_CODES[err.code] : EXIT_CODES.ERROR;
    console.error(`[merge-gate] Failed (${err.code || 'ERROR'}):`, err.message);
    if (err.offendingPath) {
      console.error(`  Offending path: ${err.offendingPath}`);
    }
    process.exit(code);
  }
}

// Invoke CLI if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  runCli();
}
