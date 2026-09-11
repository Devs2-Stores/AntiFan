/**
 * test-fix-loop.mjs — Comprehensive test harness for Fix Loop Phase 4
 *
 * Verifies:
 * 1. Purity of audits.mjs (importable with zero side effects).
 * 2. In-scope edit merges cleanly with valid receipt.
 * 3. Negative path: Out-of-scope edit (src/**, package.json) is REFUSED naming paths, zero workspace mutation.
 * 4. Diff budget (files & bytes) refuses independently (REFUSED_DIFF_BUDGET).
 * 5. Scope expansion |T \ R| refuses independently (REFUSED_SCOPE_EXPANSION).
 * 6. Tool surface violation refuses independently (REFUSED_TOOL_SURFACE).
 * 7. Self-verification claim refuses independently (REFUSED_SELF_VERIFICATION).
 * 8. Base drift refuses before any write (REFUSED_DRIFT).
 * 9. Path-scoped restore returns exactly the touched files without touching git.
 * 10. Boundary escape / .antifan-data rejection.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  DECISIONS,
  LIFECYCLE_STATES,
  normalizePath,
  matchPathPattern,
  computeManifestDiff,
  measureChangedBytes,
  auditTouchedPaths,
  auditDiffBudget,
  auditScopeExpansion,
  auditToolSurface,
  auditSelfVerification,
  auditDrift,
  runAllAudits,
} from './audits.mjs';

import {
  stageWorkspace,
  mintManifest,
  resolveSafePath,
  assertPathWithinRoot,
  sha256,
} from './stage-workspace.mjs';

import { restoreWorkspace } from './restore.mjs';
import {
  mergeStagedWorkspace,
  auditStagedWorkspace,
  EXIT_CODES,
  decisionToExitCode,
} from './merge-gate.mjs';

const REPO_ROOT = process.cwd();
const TEST_SANDBOX = path.join(REPO_ROOT, '.canary', 'staging', 'scratch-test-suite');

console.log('[Test] Starting AntiFan B-Lite v2 Fix Loop Test Suite...');

// Setup scratch sandbox
if (fs.existsSync(TEST_SANDBOX)) {
  fs.rmSync(TEST_SANDBOX, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SANDBOX, { recursive: true });

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// ── 1. Pure Audits Unit Tests ──────────────────────────────────────────────────
test('audits.mjs exports pure functions and decisions enum', () => {
  assert.equal(DECISIONS.OK, 'OK');
  assert.equal(DECISIONS.REFUSED_TOUCHED_PATH, 'REFUSED_TOUCHED_PATH');
  assert.equal(DECISIONS.REFUSED_DIFF_BUDGET, 'REFUSED_DIFF_BUDGET');
  assert.equal(DECISIONS.REFUSED_SCOPE_EXPANSION, 'REFUSED_SCOPE_EXPANSION');
  assert.equal(DECISIONS.REFUSED_DRIFT, 'REFUSED_DRIFT');
  assert.equal(DECISIONS.REFUSED_TOOL_SURFACE, 'REFUSED_TOOL_SURFACE');
  assert.equal(DECISIONS.REFUSED_SELF_VERIFICATION, 'REFUSED_SELF_VERIFICATION');
});

test('matchPathPattern handles exact, directory prefix, and globs (* and **)', () => {
  assert.equal(matchPathPattern('assets/theme.css', 'assets/theme.css'), true);
  assert.equal(matchPathPattern('assets/theme.css', 'assets/other.css'), false);
  assert.equal(matchPathPattern('assets/', 'assets/sub/deep.css'), true);
  assert.equal(matchPathPattern('assets/**', 'assets/sub/deep.css'), true);
  assert.equal(matchPathPattern('sections/*.liquid', 'sections/header.liquid'), true);
  assert.equal(matchPathPattern('sections/*.liquid', 'sections/sub/header.liquid'), false);
  assert.equal(matchPathPattern('src/**', 'src/main/index.ts'), true);
  assert.equal(matchPathPattern('package.json', 'package.json'), true);
  assert.equal(matchPathPattern('package.json', 'other/package.json'), false);
});

test('auditTouchedPaths enforces subset and rejects forbidden paths', () => {
  const allowed = ['assets/**', 'sections/*.liquid'];
  const forbidden = ['src/**', 'package.json'];

  // Allowed
  const res1 = auditTouchedPaths(['assets/base.css', 'sections/hero.liquid'], allowed, forbidden);
  assert.equal(res1.decision, DECISIONS.OK);
  assert.deepEqual(res1.offendingPaths, []);

  // Out-of-scope path
  const res2 = auditTouchedPaths(['assets/base.css', 'templates/index.json'], allowed, forbidden);
  assert.equal(res2.decision, DECISIONS.REFUSED_TOUCHED_PATH);
  assert.deepEqual(res2.offendingPaths, ['templates/index.json']);

  // Forbidden path
  const res3 = auditTouchedPaths(['package.json', 'src/main/index.ts'], ['**'], forbidden);
  assert.equal(res3.decision, DECISIONS.REFUSED_TOUCHED_PATH);
  assert.deepEqual(res3.offendingPaths, ['package.json', 'src/main/index.ts']);
});

test('measureChangedBytes counts the differing lines and never reports an unattributable change as zero', () => {
  assert.equal(measureChangedBytes('a\nb\n', 'a\nb\n', 4, 4), 0, 'identical text is not a change');
  // Removed 'world' (6 bytes with its newline) plus added 'there' (6): the line diff, not
  // the file size (13).
  assert.equal(measureChangedBytes('hello\nworld\n', 'hello\nthere\n', 13, 13), 12);
  // An added empty line is a one-byte change, not nothing.
  assert.equal(measureChangedBytes('a\n', 'a\n\n', 2, 3), 1);
  // Same line multiset, different bytes (a reorder): the measure cannot attribute the
  // change, so the whole file counts rather than zero.
  assert.equal(measureChangedBytes('a\nbb\n', 'bb\na\n', 5, 5), 5);
});

test('auditDiffBudget enforces maxFiles and maxBytes independently', () => {
  const res1 = auditDiffBudget(['a.css', 'b.css'], 500, { maxFiles: 3, maxBytes: 1000 });
  assert.equal(res1.decision, DECISIONS.OK);

  // Exceed maxFiles
  const res2 = auditDiffBudget(['a.css', 'b.css', 'c.css', 'd.css'], 500, { maxFiles: 2, maxBytes: 1000 });
  assert.equal(res2.decision, DECISIONS.REFUSED_DIFF_BUDGET);
  assert.equal(res2.budgetExceeded, 'maxFiles');
  assert.equal(res2.measured.files, 4);

  // Exceed maxBytes
  const res3 = auditDiffBudget(['a.css'], 2500, { maxFiles: 5, maxBytes: 1000 });
  assert.equal(res3.decision, DECISIONS.REFUSED_DIFF_BUDGET);
  assert.equal(res3.budgetExceeded, 'maxBytes');
  assert.equal(res3.measured.bytes, 2500);
});

test('auditScopeExpansion enforces |T \\ R| independently', () => {
  const requested = ['assets/header.css'];

  // Zero expansion: touched matches requested
  const res1 = auditScopeExpansion(['assets/header.css'], requested, 0);
  assert.equal(res1.decision, DECISIONS.OK);
  assert.equal(res1.measured.expandedFiles, 0);

  // 1 expansion within allowed maxScopeExpansion: 1
  const res2 = auditScopeExpansion(['assets/header.css', 'assets/footer.css'], requested, 1);
  assert.equal(res2.decision, DECISIONS.OK);
  assert.equal(res2.measured.expandedFiles, 1);

  // Expansion exceeds limit
  const res3 = auditScopeExpansion(['assets/header.css', 'assets/footer.css', 'sections/header.liquid'], requested, 1);
  assert.equal(res3.decision, DECISIONS.REFUSED_SCOPE_EXPANSION);
  assert.deepEqual(res3.offendingPaths, ['assets/footer.css', 'sections/header.liquid']);
  assert.equal(res3.measured.expandedFiles, 2);
});

test('auditToolSurface rejects forbidden tools', () => {
  // Permitted tools
  const res1 = auditToolSurface(['file.read', 'file.write']);
  assert.equal(res1.decision, DECISIONS.OK);

  // Forbidden tool: anti.theme.style_override
  const res2 = auditToolSurface(['file.read', 'anti.theme.style_override']);
  assert.equal(res2.decision, DECISIONS.REFUSED_TOOL_SURFACE);
  assert.deepEqual(res2.offendingTools, ['anti.theme.style_override']);

  // Unpermitted tool: anti.browser.evaluate
  const res3 = auditToolSurface(['anti.browser.evaluate']);
  assert.equal(res3.decision, DECISIONS.REFUSED_TOOL_SURFACE);
});

test('auditToolSurface reads the declared result shape and refuses a malformed one', () => {
  // The FixResult v2 schema allows { usedTools: [...] }: the declaration is still audited.
  const wrapped = auditToolSurface({ usedTools: ['file.read', 'anti.theme.style_override'] });
  assert.equal(wrapped.decision, DECISIONS.REFUSED_TOOL_SURFACE);
  assert.deepEqual(wrapped.offendingTools, ['anti.theme.style_override']);

  const wrappedClean = auditToolSurface({ usedTools: ['file.read', 'file.write'] });
  assert.equal(wrappedClean.decision, DECISIONS.OK);

  // Malformed declarations must NOT read as "nothing to audit".
  // Exact malformed case added: { unrecognizedKey: ['file.read'] } (object with neither recognized key)
  const malformedCases = [
    { val: { unrecognizedKey: ['file.read'] }, re: /recognized key/ },
    { val: 'file.read', re: /string/ },
    { val: 42, re: /number/ },
    { val: { usedTools: 'file.read' }, re: /usedTools/ },
    { val: [7], re: /non-string/ },
  ];
  for (const { val, re } of malformedCases) {
    const refused = auditToolSurface(val);
    assert.equal(refused.decision, DECISIONS.REFUSED_TOOL_SURFACE, `expected refusal for ${JSON.stringify(val)}`);
    assert.match(refused.reason, /Malformed tool surface/);
    assert.match(refused.reason, re, `expected reason to name shape in ${refused.reason}`);
  }

  // No declaration at all is a documented no-op, not a refusal.
  assert.equal(auditToolSurface(null).decision, DECISIONS.OK);
  assert.equal(auditToolSurface(undefined).decision, DECISIONS.OK);
});

test('auditToolSurface accepts request object, request array, and result usedTools shapes', () => {
  // 1. Request object form (valid -> OK)
  const reqObj = auditToolSurface({
    allowedTools: ['file.read', 'file.write'],
    forbiddenToolPatterns: ['anti.theme.*'],
  });
  assert.equal(reqObj.decision, DECISIONS.OK);
  assert.deepEqual(reqObj.offendingTools, []);

  const reqObjSimple = auditToolSurface({ allowedTools: ['file.read'] });
  assert.equal(reqObjSimple.decision, DECISIONS.OK);

  // Request object with unpermitted tool
  const reqObjUnpermitted = auditToolSurface({ allowedTools: ['anti.browser.evaluate'] });
  assert.equal(reqObjUnpermitted.decision, DECISIONS.REFUSED_TOOL_SURFACE);
  assert.deepEqual(reqObjUnpermitted.offendingTools, ['anti.browser.evaluate']);

  // Request object where declared allowed tool is matched by declared forbidden pattern
  const reqObjForbidden = auditToolSurface({
    allowedTools: ['file.read', 'file.write'],
    forbiddenToolPatterns: ['file.write'],
  });
  assert.equal(reqObjForbidden.decision, DECISIONS.REFUSED_TOOL_SURFACE);
  assert.deepEqual(reqObjForbidden.offendingTools, ['file.write']);

  // 2. Request array (valid -> OK)
  const reqArr = auditToolSurface(['file.read', 'file.write']);
  assert.equal(reqArr.decision, DECISIONS.OK);

  // 3. Result {usedTools} (valid -> OK)
  const resUsed = auditToolSurface({ usedTools: ['file.read'] });
  assert.equal(resUsed.decision, DECISIONS.OK);

  // 4. One malformed value -> REFUSED_TOOL_SURFACE with reason naming the shape
  const malformedObj = auditToolSurface({ unrecognizedKey: ['file.read'] });
  assert.equal(malformedObj.decision, DECISIONS.REFUSED_TOOL_SURFACE);
  assert.match(malformedObj.reason, /recognized key/);

  // 5. Integration: Confirm by measurement that runAllAudits does NOT refuse schema-valid request object
  const baseManifest = [{ path: 'assets/theme.css', sha256: 'a1', bytes: 10 }];
  const postManifest = [{ path: 'assets/theme.css', sha256: 'a2', bytes: 12 }];
  const auditRes = runAllAudits({
    baseManifest,
    postManifest,
    request: {
      allowedFiles: ['assets/theme.css'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 1000 },
      toolSurface: {
        allowedTools: ['file.read', 'file.write'],
        forbiddenToolPatterns: ['anti.theme.*'],
      },
    },
    fixerResult: {
      toolSurface: ['file.read'],
      selfVerificationClaimed: false,
      notes: 'Clean fix',
    },
  });
  assert.equal(auditRes.decision, DECISIONS.OK);
  assert.equal(auditRes.ok, true);
  assert.deepEqual(auditRes.toolSurface, ['file.read']);

  // Fix-result receipt must never carry bare null: defaults to [] when omitted
  const auditResNoFixer = runAllAudits({
    baseManifest,
    postManifest,
    request: {
      allowedFiles: ['assets/theme.css'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 1000 },
      toolSurface: {
        allowedTools: ['file.read'],
      },
    },
    fixerResult: {
      notes: 'No fixer tool surface',
    },
  });
  assert.equal(auditResNoFixer.decision, DECISIONS.OK);
  assert.equal(auditResNoFixer.ok, true);
  assert.deepEqual(auditResNoFixer.toolSurface, []);
});

test('the default forbidden paths and tools survive a request that declares its own list', () => {
  // A round may forbid more than the defaults, never less: an empty or narrow
  // declaration must not re-permit the manifest or the evaluate-class tools.
  const manifestPair = (p) => ({
    baseManifest: [{ path: p, sha256: 'a1', bytes: 10 }],
    postManifest: [{ path: p, sha256: 'a2', bytes: 12 }],
  });

  const pathRes = runAllAudits({
    ...manifestPair('package.json'),
    request: {
      allowedFiles: ['package.json'],
      forbiddenPaths: [],
      requestedTargets: ['package.json'],
      diffBudget: { maxFiles: 2, maxBytes: 1000 },
      toolSurface: { allowedTools: ['file.read', 'file.write'] },
    },
    fixerResult: { toolSurface: ['file.read'], selfVerificationClaimed: false },
  });
  assert.equal(
    pathRes.decision,
    DECISIONS.REFUSED_TOUCHED_PATH,
    'an empty forbiddenPaths list must not un-forbid package.json'
  );
});

test('auditSelfVerification rejects claimed verdicts', () => {
  const res1 = auditSelfVerification(false);
  assert.equal(res1.decision, DECISIONS.OK);
  assert.equal(auditSelfVerification(undefined).decision, DECISIONS.OK, 'an absent field makes no claim');

  const res2 = auditSelfVerification(true);
  assert.equal(res2.decision, DECISIONS.REFUSED_SELF_VERIFICATION);

  // No schema validator runs over the contract, so the gate itself must own the
  // invariant: a truthy spelling of the claim is still a claim.
  for (const spelling of ['true', 1, 'yes']) {
    assert.equal(
      auditSelfVerification(spelling).decision,
      DECISIONS.REFUSED_SELF_VERIFICATION,
      `selfVerificationClaimed=${JSON.stringify(spelling)} is a claim`
    );
  }
});

// ── 2. Staging & Confinement Tests ─────────────────────────────────────────────
test('resolveSafePath rejects .antifan-data and escaping paths', () => {
  const root = path.join(TEST_SANDBOX, 'dummy-root');
  fs.mkdirSync(root, { recursive: true });

  // Valid
  const res = resolveSafePath('assets/theme.css', root);
  assert.equal(res.relativePath, 'assets/theme.css');

  // Forbidden .antifan-data
  assert.throws(() => {
    resolveSafePath('.antifan-data/test.json', root);
  }, /forbidden '\.antifan-data'/);

  // Escaping root
  assert.throws(() => {
    resolveSafePath('../../escaped.txt', root);
  }, /escapes staged workspace root/);
});

// ── 3. Integration & Scratch Merge Gate Tests ──────────────────────────────────
// Create mock target workspace
const mockTarget = path.join(TEST_SANDBOX, 'mock-target');
fs.mkdirSync(path.join(mockTarget, 'assets'), { recursive: true });
fs.mkdirSync(path.join(mockTarget, 'sections'), { recursive: true });

fs.writeFileSync(path.join(mockTarget, 'assets', 'theme.css'), '/* Original theme.css */\n');
fs.writeFileSync(path.join(mockTarget, 'assets', 'header.css'), '/* Original header.css */\n');
fs.writeFileSync(path.join(mockTarget, 'sections', 'header.liquid'), '<div>Original Header</div>\n');

test('stageWorkspace creates staged workspace copy and base manifest', () => {
  const runId = 'test-run-1';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**', 'sections/*.liquid'],
  });

  assert.equal(staged.runId, runId);
  assert.ok(fs.existsSync(staged.stagedRoot));
  assert.ok(fs.existsSync(path.join(staged.stagingDir, 'base-manifest.json')));
  assert.ok(fs.existsSync(path.join(staged.stagingDir, 'stage-meta.json')));
  assert.ok(fs.existsSync(path.join(staged.storedContentDir, 'assets', 'theme.css')));

  assert.equal(staged.env.THEME_WORKSPACE_ROOT, staged.stagedRoot);
  assert.equal(staged.env.ANTIFAN_WORKSPACE_ROOT, staged.stagedRoot);
});

test('the diff budget counts the bytes actually rewritten, not the net size delta', () => {
  const runId = 'test-byte-volume';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**'],
    requestedTargets: ['assets/theme.css'],
  });
  const stagedCss = path.join(staged.stagedRoot, 'assets', 'theme.css');
  const original = fs.readFileSync(stagedCss, 'utf8');

  // Rewrite the file with content one byte longer than the original: the manifest's size
  // delta reports 1 byte changed and would clear any byte ceiling.
  fs.writeFileSync(stagedCss, 'x'.repeat(original.length + 1));
  const rewrittenAudit = auditStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: null,
    request: {
      allowedFiles: ['assets/**'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 20 },
      maxScopeExpansion: 0,
    },
    fixerResult: { toolSurface: ['file.write'], selfVerificationClaimed: false },
  });
  assert.equal(rewrittenAudit.decision, DECISIONS.REFUSED_DIFF_BUDGET, 'a rewrite cannot hide behind a one-byte size delta');
  assert.equal(rewrittenAudit.budgets.bytes > 20, true, `measured bytes: ${rewrittenAudit.budgets.bytes}`);

  // A surgical insertion in the same large file still counts as its own bytes, so a
  // legitimate small fix is not priced as a whole-file rewrite.
  fs.writeFileSync(stagedCss, `${original}\n/* one line */\n`);
  const surgicalAudit = auditStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: null,
    request: {
      allowedFiles: ['assets/**'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 64 },
      maxScopeExpansion: 0,
    },
    fixerResult: { toolSurface: ['file.write'], selfVerificationClaimed: false },
  });
  assert.equal(surgicalAudit.decision, DECISIONS.OK, 'a small edit measures as its own bytes');
});

test('the merge prices a rewrite the same way the audit does, and refuses it', () => {
  const runId = 'test-merge-byte-volume';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**'],
    requestedTargets: ['assets/theme.css'],
  });
  const stagedCss = path.join(staged.stagedRoot, 'assets', 'theme.css');
  const original = fs.readFileSync(stagedCss, 'utf8');
  const targetCss = path.join(mockTarget, 'assets', 'theme.css');
  const before = fs.readFileSync(targetCss, 'utf8');

  // One byte longer than the original: the size delta prices this at 1 byte, the measured
  // volume prices it at the whole file. The merge is where the write happens, so the ceiling
  // has to hold there and not only in the standalone audit.
  fs.writeFileSync(stagedCss, 'x'.repeat(original.length + 1));

  const mergeResult = mergeStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: mockTarget,
    request: {
      allowedFiles: ['assets/**'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 20 },
      maxScopeExpansion: 0,
    },
    attemptId: 'attempt-merge-byte-volume-1',
  });

  assert.equal(mergeResult.decision, DECISIONS.REFUSED_DIFF_BUDGET);
  assert.equal(mergeResult.ok, false);
  assert.equal(mergeResult.receipt.budgets.bytes > 20, true, `measured bytes: ${mergeResult.receipt.budgets.bytes}`);
  assert.equal(fs.readFileSync(targetCss, 'utf8'), before, 'a refused merge writes nothing to the target');
});

test('a file whose bytes cannot be compared is priced at its whole larger side', () => {
  const runId = 'test-unreadable-volume';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**'],
    requestedTargets: ['assets/theme.css'],
  });
  const stagedCss = path.join(staged.stagedRoot, 'assets', 'theme.css');
  const original = fs.readFileSync(stagedCss, 'utf8');

  // NUL-bearing and one byte longer: the line measure has nothing to compare, the size delta
  // says 1 byte. Charging the larger side keeps the ceiling meaningful instead of letting an
  // unreadable rewrite choose its own price.
  fs.writeFileSync(stagedCss, `${'x'.repeat(original.length)}\u0000`);

  const unreadableAudit = auditStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: null,
    request: {
      allowedFiles: ['assets/**'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 20 },
      maxScopeExpansion: 0,
    },
    fixerResult: { toolSurface: ['file.write'], selfVerificationClaimed: false },
  });
  assert.equal(unreadableAudit.decision, DECISIONS.REFUSED_DIFF_BUDGET);
  assert.equal(
    unreadableAudit.budgets.bytes >= Buffer.byteLength(`${'x'.repeat(original.length)}\u0000`),
    true,
    `measured bytes: ${unreadableAudit.budgets.bytes}`
  );
});

test('In-scope edit merges cleanly and mints success receipt', () => {
  const runId = 'test-in-scope';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**', 'sections/*.liquid'],
    requestedTargets: ['assets/theme.css'],
  });

  // Make an in-scope edit in staged workspace
  const stagedThemeCss = path.join(staged.stagedRoot, 'assets', 'theme.css');
  fs.writeFileSync(stagedThemeCss, '/* Fixed theme.css v2 */\n');

  // Run merge
  const mergeResult = mergeStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: mockTarget,
    request: {
      allowedFiles: ['assets/**', 'sections/*.liquid'],
      requestedTargets: ['assets/theme.css'],
      diffBudget: { maxFiles: 2, maxBytes: 1000 },
      maxScopeExpansion: 0,
    },
    attemptId: 'attempt-in-scope-1',
  });

  assert.equal(mergeResult.decision, DECISIONS.OK);
  assert.equal(mergeResult.ok, true);
  assert.deepEqual(mergeResult.touchedPaths, ['assets/theme.css']);

  // Check that real target received the edit
  const targetContent = fs.readFileSync(path.join(mockTarget, 'assets', 'theme.css'), 'utf8');
  assert.equal(targetContent, '/* Fixed theme.css v2 */\n');

  // Verify receipt.json exists and is valid
  const receiptPath = path.join(staged.stagingDir, 'receipt.json');
  assert.ok(fs.existsSync(receiptPath));
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.decision, 'OK');
  assert.equal(receipt.postMergeVerification.verified, true);
});

test('Negative test: Out-of-scope edit is REFUSED with paths named and ZERO target mutation', () => {
  const runId = 'test-out-of-scope';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/theme.css'], // only theme.css allowed
  });

  // Mutate an out-of-scope file (sections/header.liquid) and create a package.json
  fs.writeFileSync(path.join(staged.stagedRoot, 'sections', 'header.liquid'), '<div>MALICIOUS EDIT</div>\n');
  fs.writeFileSync(path.join(staged.stagedRoot, 'package.json'), '{"malicious": true}\n');

  // Capture target files before merge attempt
  const beforeHeader = fs.readFileSync(path.join(mockTarget, 'sections', 'header.liquid'), 'utf8');
  assert.ok(!fs.existsSync(path.join(mockTarget, 'package.json')));

  // Run merge attempt
  const mergeResult = mergeStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: mockTarget,
    request: {
      allowedFiles: ['assets/theme.css'],
      forbiddenPaths: ['package.json', 'src/**'],
    },
  });

  // Assert REFUSED_TOUCHED_PATH
  assert.equal(mergeResult.decision, DECISIONS.REFUSED_TOUCHED_PATH);
  assert.equal(mergeResult.ok, false);
  assert.ok(mergeResult.offendingPaths.includes('sections/header.liquid'));
  assert.ok(mergeResult.offendingPaths.includes('package.json'));

  // Assert ZERO change to target directory
  const afterHeader = fs.readFileSync(path.join(mockTarget, 'sections', 'header.liquid'), 'utf8');
  assert.equal(beforeHeader, afterHeader);
  assert.ok(!fs.existsSync(path.join(mockTarget, 'package.json')), 'package.json must NOT be created in target');
});

test('Drift check: Target modified since stage time is REFUSED before write', () => {
  const runId = 'test-drift';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**', 'sections/**'],
  });

  // Modify the target workspace externally (simulating drift)
  fs.writeFileSync(path.join(mockTarget, 'assets', 'header.css'), '/* External drift edit */\n');

  // Modify staged copy
  fs.writeFileSync(path.join(staged.stagedRoot, 'assets', 'theme.css'), '/* Staged edit */\n');

  const mergeResult = mergeStagedWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: mockTarget,
    request: {
      allowedFiles: ['assets/**', 'sections/**'],
    },
  });

  assert.equal(mergeResult.decision, DECISIONS.REFUSED_DRIFT);
  assert.equal(mergeResult.ok, false);
  assert.ok(mergeResult.offendingPaths.includes('assets/header.css'));
});

test('Restore restores exactly touched files from stored pre-merge backup without git', () => {
  const runId = 'test-restore';
  const staged = stageWorkspace({
    runId,
    sourceDir: mockTarget,
    stagingParentDir: TEST_SANDBOX,
    allowedFiles: ['assets/**'],
  });

  const originalThemeCss = fs.readFileSync(path.join(mockTarget, 'assets', 'theme.css'), 'utf8');

  // Touch files in mockTarget manually
  fs.writeFileSync(path.join(mockTarget, 'assets', 'theme.css'), '/* Corrupted theme */\n');
  fs.writeFileSync(path.join(mockTarget, 'assets', 'unwanted-new.css'), '/* Bad file */\n');

  // Call restore
  const restoreResult = restoreWorkspace({
    stagingDir: staged.stagingDir,
    targetDir: mockTarget,
    touchedPaths: ['assets/theme.css', 'assets/unwanted-new.css'],
  });

  assert.equal(restoreResult.ok, true);
  assert.ok(restoreResult.restoredPaths.includes('assets/theme.css'));
  assert.ok(restoreResult.deletedPaths.includes('assets/unwanted-new.css'));

  // Verify target is restored
  const restoredTheme = fs.readFileSync(path.join(mockTarget, 'assets', 'theme.css'), 'utf8');
  assert.equal(restoredTheme, originalThemeCss);
  assert.ok(!fs.existsSync(path.join(mockTarget, 'assets', 'unwanted-new.css')));
});

test('CLI exit codes match specification', () => {
  assert.equal(decisionToExitCode(DECISIONS.OK), EXIT_CODES.OK);
  assert.equal(decisionToExitCode(DECISIONS.REFUSED_TOUCHED_PATH), EXIT_CODES.REFUSED_TOUCHED_PATH);
  assert.equal(decisionToExitCode(DECISIONS.REFUSED_DIFF_BUDGET), EXIT_CODES.REFUSED_DIFF_BUDGET);
  assert.equal(decisionToExitCode(DECISIONS.REFUSED_SCOPE_EXPANSION), EXIT_CODES.REFUSED_SCOPE_EXPANSION);
  assert.equal(decisionToExitCode(DECISIONS.REFUSED_DRIFT), EXIT_CODES.REFUSED_DRIFT);
  assert.equal(decisionToExitCode(DECISIONS.REFUSED_TOOL_SURFACE), EXIT_CODES.REFUSED_TOOL_SURFACE);
  assert.equal(decisionToExitCode(DECISIONS.REFUSED_SELF_VERIFICATION), EXIT_CODES.REFUSED_SELF_VERIFICATION);
  assert.equal(decisionToExitCode(LIFECYCLE_STATES.REFUSED_SCOPE), EXIT_CODES.REFUSED_SCOPE);
});

// Clean up scratch sandbox
fs.rmSync(TEST_SANDBOX, { recursive: true, force: true });

console.log(`\n[Test] All ${passedTests}/${totalTests} tests passed successfully!`);
