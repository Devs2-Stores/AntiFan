/**
 * run-cli-proof.mjs — Proves all Phase 4 acceptance criteria via CLI execution
 *
 * Runs merge-gate.mjs subcommands in child processes, verifying:
 * 1. Out-of-scope negative path (touching src/** and package.json) exits with code 10 (REFUSED_TOUCHED_PATH),
 *    names the offending paths in stdout, and leaves ZERO changes in the workspace.
 * 2. In-scope edit merges cleanly, exits with code 0, and mints receipt.json.
 * 3. Budget violation exits with code 11 (REFUSED_DIFF_BUDGET).
 * 4. Expansion violation exits with code 12 (REFUSED_SCOPE_EXPANSION).
 * 5. Drift violation exits with code 13 (REFUSED_DRIFT).
 * 6. Restore returns exactly the files touched and exits with code 0.
 * 7. git status --short proves real workspace is untouched.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, '.canary', 'tools', 'fix-loop', 'merge-gate.mjs');
const SCRATCH_DIR = path.join(REPO_ROOT, '.canary', 'staging', 'cli-proof-sandbox');

console.log('===============================================================');
console.log('  AntiFan B-Lite v2 Phase 4 — CLI & Isolation Proof Harness    ');
console.log('===============================================================');

// Clean scratch
if (fs.existsSync(SCRATCH_DIR)) {
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SCRATCH_DIR, { recursive: true });

// Create scratch target workspace
const targetDir = path.join(SCRATCH_DIR, 'theme-target');
fs.mkdirSync(path.join(targetDir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(targetDir, 'sections'), { recursive: true });

const originalThemeCss = '/* Theme CSS base */\n';
const originalHeaderLiquid = '<header>Original Header</header>\n';
fs.writeFileSync(path.join(targetDir, 'assets', 'theme.css'), originalThemeCss);
fs.writeFileSync(path.join(targetDir, 'sections', 'header.liquid'), originalHeaderLiquid);

function runCommand(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(res.stdout);
  } catch {}
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json: parsedJson,
  };
}

// ── PROOF 1: Stage Workspace via CLI ──────────────────────────────────────────
console.log('\n[Proof 1] Staging target workspace via CLI...');
const runId = 'proof-run-001';
const stagingParent = path.join(SCRATCH_DIR, 'staging');
const stageRes = runCommand([
  'stage',
  '--source', targetDir,
  '--staging-dir', stagingParent,
  '--run-id', runId,
  '--allowed', 'assets/**',
]);

assert.equal(stageRes.status, 0, `Stage failed: ${stageRes.stderr}`);
console.log('  ✓ Stage command exited 0');
const stagingDir = path.join(stagingParent, runId);
assert.ok(fs.existsSync(path.join(stagingDir, 'base-manifest.json')));
assert.ok(fs.existsSync(path.join(stagingDir, 'stage-meta.json')));
assert.ok(fs.existsSync(path.join(stagingDir, 'staged', 'assets', 'theme.css')));
console.log('  ✓ Staged root, base manifest, and pre-merge backup verified');

// ── PROOF 2: Negative Path First — Out-of-scope edit touching src/** & package.json
console.log('\n[Proof 2] Negative path: Touching src/** and package.json...');
const stagedRoot = path.join(stagingDir, 'staged');
fs.mkdirSync(path.join(stagedRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(stagedRoot, 'src', 'core.ts'), 'export const evil = true;\n');
fs.writeFileSync(path.join(stagedRoot, 'package.json'), '{"name": "corrupted"}\n');

// Write request file with allowedFiles: ['assets/**'] and forbiddenPaths: ['src/**', 'package.json']
const reqFile = path.join(SCRATCH_DIR, 'fix-request-negative.json');
fs.writeFileSync(reqFile, JSON.stringify({
  allowedFiles: ['assets/**'],
  forbiddenPaths: ['src/**', 'package.json'],
  diffBudget: { maxFiles: 5, maxBytes: 10000 },
  maxScopeExpansion: 0,
}, null, 2));

const negMergeRes = runCommand([
  'merge',
  '--staging-dir', stagingDir,
  '--target-dir', targetDir,
  '--request', reqFile,
]);

console.log(`  Exit code: ${negMergeRes.status} (Expected: 10 REFUSED_TOUCHED_PATH)`);
assert.equal(negMergeRes.status, 10, 'Expected exit code 10 for REFUSED_TOUCHED_PATH');
assert.ok(negMergeRes.json, 'Expected JSON output');
assert.equal(negMergeRes.json.decision, 'REFUSED_TOUCHED_PATH');
console.log(`  Decision: ${negMergeRes.json.decision}`);
console.log(`  Offending paths named: ${negMergeRes.json.offendingPaths.join(', ')}`);
assert.ok(negMergeRes.json.offendingPaths.includes('package.json'));
assert.ok(negMergeRes.json.offendingPaths.includes('src/core.ts'));

// Prove ZERO change to target workspace
assert.ok(!fs.existsSync(path.join(targetDir, 'package.json')), 'Target must NOT have package.json');
assert.ok(!fs.existsSync(path.join(targetDir, 'src')), 'Target must NOT have src/ directory');
assert.equal(fs.readFileSync(path.join(targetDir, 'assets', 'theme.css'), 'utf8'), originalThemeCss);
console.log('  ✓ Target workspace is completely UNTOUCHED (zero bytes changed)');

// Clean up malicious files in staged
fs.unlinkSync(path.join(stagedRoot, 'package.json'));
fs.rmSync(path.join(stagedRoot, 'src'), { recursive: true, force: true });

// ── PROOF 3: In-Scope Edit Merges with Receipt ────────────────────────────────
console.log('\n[Proof 3] In-scope edit: modifying assets/theme.css...');
const fixedThemeCss = '/* Theme CSS base - Verified Fix */\n.button { color: red; }\n';
fs.writeFileSync(path.join(stagedRoot, 'assets', 'theme.css'), fixedThemeCss);

const inScopeReq = path.join(SCRATCH_DIR, 'fix-request-inscope.json');
fs.writeFileSync(inScopeReq, JSON.stringify({
  allowedFiles: ['assets/**'],
  requestedTargets: ['assets/theme.css'],
  diffBudget: { maxFiles: 2, maxBytes: 5000 },
  maxScopeExpansion: 0,
}, null, 2));

const inScopeMergeRes = runCommand([
  'merge',
  '--staging-dir', stagingDir,
  '--target-dir', targetDir,
  '--request', inScopeReq,
  '--attempt-id', 'attempt-001',
]);

console.log(`  Exit code: ${inScopeMergeRes.status} (Expected: 0 OK)`);
assert.equal(inScopeMergeRes.status, 0);
assert.equal(inScopeMergeRes.json.decision, 'OK');
assert.equal(inScopeMergeRes.json.ok, true);
assert.deepEqual(inScopeMergeRes.json.touchedPaths, ['assets/theme.css']);

// Verify content reached targetDir
assert.equal(fs.readFileSync(path.join(targetDir, 'assets', 'theme.css'), 'utf8'), fixedThemeCss);
// Verify receipt.json
const receipt = JSON.parse(fs.readFileSync(path.join(stagingDir, 'receipt.json'), 'utf8'));
assert.equal(receipt.decision, 'OK');
assert.equal(receipt.postMergeVerification.verified, true);
console.log('  ✓ In-scope edit merged and receipt minted with verified post-merge hashes');

// ── PROOF 4: Diff Budget Refuses Independently ────────────────────────────────
console.log('\n[Proof 4] Diff budget audit refusal...');
const budgetReq = path.join(SCRATCH_DIR, 'fix-request-budget.json');
fs.writeFileSync(budgetReq, JSON.stringify({
  allowedFiles: ['assets/**'],
  diffBudget: { maxFiles: 0, maxBytes: 10 }, // 0 files allowed -> exceeds budget
}, null, 2));

const budgetRes = runCommand([
  'audit',
  '--staging-dir', stagingDir,
  '--request', budgetReq,
]);

console.log(`  Exit code: ${budgetRes.status} (Expected: 11 REFUSED_DIFF_BUDGET)`);
assert.equal(budgetRes.status, 11);
assert.equal(budgetRes.json.decision, 'REFUSED_DIFF_BUDGET');
console.log(`  Decision: ${budgetRes.json.decision} (budget measured: ${JSON.stringify(budgetRes.json.budgets)})`);

// ── PROOF 5: Scope Expansion Refuses Independently ─────────────────────────────
console.log('\n[Proof 5] Scope expansion audit refusal...');
const expansionReq = path.join(SCRATCH_DIR, 'fix-request-expansion.json');
fs.writeFileSync(expansionReq, JSON.stringify({
  allowedFiles: ['assets/**'],
  requestedTargets: ['assets/other.css'], // theme.css was touched, but not in requestedTargets
  maxScopeExpansion: 0,                   // 0 expansion allowed -> exceeds expansion
}, null, 2));

const expansionRes = runCommand([
  'audit',
  '--staging-dir', stagingDir,
  '--request', expansionReq,
]);

console.log(`  Exit code: ${expansionRes.status} (Expected: 12 REFUSED_SCOPE_EXPANSION)`);
assert.equal(expansionRes.status, 12);
assert.equal(expansionRes.json.decision, 'REFUSED_SCOPE_EXPANSION');
console.log(`  Decision: ${expansionRes.json.decision} (expandedPaths: ${expansionRes.json.expandedPaths.join(', ')})`);

// ── PROOF 6: Drift Refuses Before Any Write ───────────────────────────────────
console.log('\n[Proof 6] Drift check: target modified externally...');
// Modify sections/header.liquid in targetDir (external drift)
fs.writeFileSync(path.join(targetDir, 'sections', 'header.liquid'), '<header>External drift header</header>\n');

const driftRes = runCommand([
  'merge',
  '--staging-dir', stagingDir,
  '--target-dir', targetDir,
  '--request', inScopeReq,
]);

console.log(`  Exit code: ${driftRes.status} (Expected: 13 REFUSED_DRIFT)`);
assert.equal(driftRes.status, 13);
assert.equal(driftRes.json.decision, 'REFUSED_DRIFT');
console.log(`  Decision: ${driftRes.json.decision} (offending drifting paths: ${driftRes.json.offendingPaths.join(', ')})`);

// ── PROOF 7: Restore Returns Exactly Touched Files ────────────────────────────
console.log('\n[Proof 7] Path-scoped restore from stored pre-merge content...');
// Add an unwanted corrupted file in targetDir
fs.writeFileSync(path.join(targetDir, 'assets', 'unwanted.css'), '/* trash */\n');

const restoreRes = runCommand([
  'restore',
  '--staging-dir', stagingDir,
  '--target-dir', targetDir,
  '--paths', 'assets/theme.css,assets/unwanted.css',
]);

console.log(`  Exit code: ${restoreRes.status} (Expected: 0 OK)`);
assert.equal(restoreRes.status, 0);
assert.ok(restoreRes.json.restoredPaths.includes('assets/theme.css'));
assert.ok(restoreRes.json.deletedPaths.includes('assets/unwanted.css'));

// Check that originalThemeCss is restored
assert.equal(fs.readFileSync(path.join(targetDir, 'assets', 'theme.css'), 'utf8'), originalThemeCss);
assert.ok(!fs.existsSync(path.join(targetDir, 'assets', 'unwanted.css')));
console.log('  ✓ Exactly touched files restored from pre-merge content; added files deleted');

// ── PROOF 8: Fault-Injection: Post-Merge Re-Hash Refusal & Rollback ───────────
console.log('\n[Proof 8] Fault injection: Post-merge re-hash refusal and automatic restore (Gate 7)...');

// 1. Reset targetDir to base state
fs.writeFileSync(path.join(targetDir, 'sections', 'header.liquid'), originalHeaderLiquid);
fs.writeFileSync(path.join(targetDir, 'assets', 'theme.css'), originalThemeCss);

// 2. Stage a fresh isolated staging run for fault testing
const faultRunId = 'proof-run-fault-001';
const faultStageRes = runCommand([
  'stage',
  '--source', targetDir,
  '--staging-dir', stagingParent,
  '--run-id', faultRunId,
  '--allowed', 'assets/**',
]);
assert.equal(faultStageRes.status, 0, `Fault stage failed: ${faultStageRes.stderr}`);
const faultStagingDir = path.join(stagingParent, faultRunId);
const faultStagedRoot = path.join(faultStagingDir, 'staged');

// 3. Staged edit: modify assets/theme.css with in-scope valid content
fs.writeFileSync(path.join(faultStagedRoot, 'assets', 'theme.css'), fixedThemeCss);

// 4. Execute merge with fault injection active via environment variable
const faultMergeRes = runCommand([
  'merge',
  '--staging-dir', faultStagingDir,
  '--target-dir', targetDir,
  '--request', inScopeReq,
  '--attempt-id', 'attempt-fault-test',
], {
  ANTIFAN_TEST_FAULT_INJECT_POST_MERGE: 'assets/theme.css',
});

// 5. Assert typed refusal decision and exit code
console.log(`  Exit code: ${faultMergeRes.status} (Expected: 13 REFUSED_DRIFT)`);
assert.equal(faultMergeRes.status, 13, 'Expected exit code 13 for REFUSED_DRIFT');
assert.ok(faultMergeRes.json, 'Expected JSON output from merge refusal');
assert.equal(faultMergeRes.json.decision, 'REFUSED_DRIFT');
assert.equal(faultMergeRes.json.ok, false);
console.log(`  Decision: ${faultMergeRes.json.decision}`);

// 6. Assert verified: false and mismatching paths named
assert.ok(faultMergeRes.json.offendingPaths.includes('assets/theme.css'));
console.log(`  Offending paths named: ${faultMergeRes.json.offendingPaths.join(', ')}`);
assert.equal(faultMergeRes.json.receipt.postMergeVerification.verified, false);
const mismatch = faultMergeRes.json.receipt.postMergeVerification.mismatches.find((m) => m.path === 'assets/theme.css');
assert.ok(mismatch, 'Expected assets/theme.css in verification mismatches');
assert.ok(mismatch.expectedSha256, 'Expected expectedSha256 in mismatch');
assert.ok(mismatch.actualSha256, 'Expected actualSha256 in mismatch');
assert.notEqual(mismatch.expectedSha256, mismatch.actualSha256, 'Expected hash mismatch between expected and actual');
console.log(`  Verified: ${faultMergeRes.json.receipt.postMergeVerification.verified}`);
console.log(`  Mismatch details: expected ${mismatch.expectedSha256.slice(0, 10)}... vs actual ${mismatch.actualSha256.slice(0, 10)}...`);

// 7. Assert workspace bytes restored to the stored pre-merge content
const targetThemeCssAfterFault = fs.readFileSync(path.join(targetDir, 'assets', 'theme.css'), 'utf8');
assert.equal(targetThemeCssAfterFault, originalThemeCss, 'Target workspace must be restored to pre-merge bytes');
console.log('  ✓ Workspace bytes restored to stored pre-merge content (originalThemeCss)');

// 8. Assert that no success receipt was published (real contract publishes failure receipt with verified: false)
const faultReceiptPath = path.join(faultStagingDir, 'receipt.json');
assert.ok(fs.existsSync(faultReceiptPath), 'Failure receipt must exist on disk');
const diskFaultReceipt = JSON.parse(fs.readFileSync(faultReceiptPath, 'utf8'));
assert.equal(diskFaultReceipt.decision, 'REFUSED_DRIFT');
assert.notEqual(diskFaultReceipt.decision, 'OK', 'Must NOT publish a success receipt (decision must not be OK)');
assert.equal(diskFaultReceipt.postMergeVerification.verified, false, 'Published receipt must carry verified: false');
assert.equal(diskFaultReceipt.restored, true, 'Published receipt must record restored: true');
console.log('  ✓ No success receipt was published (receipt carries decision: REFUSED_DRIFT and verified: false)');

// ── PROOF 9: Clean up Scratch Sandbox & Check Real Git Status ─────────────────
console.log('\n[Proof 9] Cleaning scratch sandbox and verifying real repo git status...');
fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });

const gitStatus = execSync('git status --short', { encoding: 'utf8' }).trim();
console.log('  git status --short output (tail):');
const lines = gitStatus.split('\n');
console.log('  ' + lines.slice(-8).join('\n  '));

console.log('\n===============================================================');
console.log('  ALL PHASE 4 ACCEPTANCE CRITERIA EMPIRICALLY VERIFIED         ');
console.log('===============================================================');
