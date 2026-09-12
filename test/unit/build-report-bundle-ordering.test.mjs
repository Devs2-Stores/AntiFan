/**
 * Regression: a run directory that carries both a desktop bundle and a mobile
 * bundle must produce the same report regardless of evidence file ordering.
 *
 * The defect this guards: every document's asset references were verified against
 * one run-level bundle directory, so the desktop telemetry document was checked
 * against `clone/mobile/assets` and generation aborted fail-closed on
 * `bien-ap-giga.png`, which the mobile bundle legitimately never references.
 * A second defect picked the primary telemetry by directory order, so the report
 * described the mobile bundle while the 1440 and 1024 viewports were served from
 * the desktop bundle.
 *
 * The fixture reuses the real persisted run3 evidence (JSON copies with names that
 * force each ordering); the documents reference their bundles by absolute path, so
 * the bundles themselves are not copied. Run with:
 *   node --test test/unit/build-report-bundle-ordering.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessCanaryReplay } from '../fixtures/canary-run/replay-precondition.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUN_DIR = path.join(REPO_ROOT, '.canary', 'run3');
const EVIDENCE_DIR = path.join(RUN_DIR, 'evidence');
const DESKTOP_BUNDLE = path.join(RUN_DIR, 'clone', 'index.html');
const DESKTOP_ASSET_COUNT = 118;

/**
 * The replay copies `.canary/run3/evidence` and expects generation to resolve the artifact
 * bytes and clone entries those documents name. Those bytes live in a rotating machine-local
 * store, so a machine that no longer holds them reports the absent prerequisite instead of a
 * report defect. `t.skip` keeps the gap visible in the run summary; it is never a pass.
 */
function canReplay(t) {
  const assessment = assessCanaryReplay({ evidenceDir: EVIDENCE_DIR });
  if (assessment.available) return true;
  t.skip(assessment.reason);
  return false;
}

function buildRunDir(name, naming) {
  const dir = path.join(REPO_ROOT, '.canary', 'state', name);
  const evidence = path.join(dir, 'evidence');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(evidence, { recursive: true });
  for (const file of fs.readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json'))) {
    const target = naming(file);
    if (!target) continue;
    fs.copyFileSync(path.join(EVIDENCE_DIR, file), path.join(evidence, target));
  }
  return dir;
}

function runReport(runDir) {
  const out = path.join(runDir, 'REPORT.md');
  const proc = spawnSync(process.execPath, ['scripts/lib/build-report.mjs', runDir, '--out', out], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: proc.status, stderr: proc.stderr, stdout: proc.stdout, report: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
}

function assertCoherent(result) {
  assert.equal(result.status, 0, `generation must succeed, got status ${result.status}\n${result.stderr}`);
  const bundle = result.report.match(/Clone bundle:\s+(\S+)/)?.[1] || null;
  assert.equal(
    path.resolve(REPO_ROOT, bundle || ''),
    DESKTOP_BUNDLE,
    'the report must describe the bundle its majority viewports were served from, not the mobile bundle',
  );
  const assets = result.report.match(/^assets\s+(\d+) files/m)?.[1];
  assert.equal(Number(assets), DESKTOP_ASSET_COUNT, 'asset totals must come from the desktop telemetry document');
  assert.equal((result.report.match(/FINAL VERDICT:/g) || []).length, 1, 'exactly one final verdict');
  assert.match(result.report, /FINAL VERDICT: (PASS|FAIL|INCONCLUSIVE)/);
}

test('desktop telemetry verifies against the desktop bundle when the mobile bundle sorts first', (t) => {
  if (!canReplay(t)) return;
  // Mobile documents sort before every desktop document.
  const dir = buildRunDir('report-ordering-mobile-first', (file) => {
    if (file === 'build-telemetry-mobile.json') return 'a-build-telemetry-mobile.json';
    if (file === 'run3-390.json') return 'b-run3-390.json';
    if (file === 'build-telemetry.json') return 'z-build-telemetry.json';
    return `m-${file}`;
  });
  try {
    assertCoherent(runReport(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop telemetry verifies against the desktop bundle when the desktop bundle sorts first', (t) => {
  if (!canReplay(t)) return;
  const dir = buildRunDir('report-ordering-desktop-first', (file) => {
    if (file === 'build-telemetry.json') return 'a-build-telemetry.json';
    if (file === 'run3-390.json') return 'z-run3-390.json';
    if (file === 'build-telemetry-mobile.json') return 'b-build-telemetry-mobile.json';
    return `m-${file}`;
  });
  try {
    assertCoherent(runReport(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
