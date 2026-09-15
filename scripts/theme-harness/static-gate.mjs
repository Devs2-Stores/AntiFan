/**
 * L0 — offline source gate.
 *
 * Wraps the two existing zero-browser gates against the theme tree:
 *   node scripts/theme-checks.mjs --theme <dir> --platform haravan --out <report>
 *   node scripts/lint-haravan-theme.mjs --theme <dir>
 *
 * Exit-code contract (from the scripts themselves):
 *   theme-checks: 0 clean, 2 usage/unreadable dir, 3 at least one refusal.
 *   lint-haravan-theme: 0 clean, 1 violations, 2 unreadable dir.
 *
 * The verdict is OFFLINE_STATIC: it proves declarations, settings bindings,
 * asset references and Haravan Liquid contracts — never rendering.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readRecord } from '../lib/atomic-record.mjs';
import { LAYERS, blockedVerdict, makeVerdict } from './verdict.mjs';

const TIER = 'OFFLINE_STATIC';

const LIMITS = Object.freeze([
  'no Liquid engine runs on this machine: template rendering, DotLiquid semantics and runtime data are unproven',
  'proves declarations/bindings/assets/Haravan contracts only; a clean L0 says nothing about what the storefront serves',
]);

function runScript(repoRoot, scriptRel, args) {
  const scriptPath = path.join(repoRoot, scriptRel);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    script: scriptRel,
    args,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error && result.error.code === 'ETIMEDOUT' ? true : false,
    error: result.error ? String(result.error.message || result.error) : null,
    stdoutTail: (result.stdout || '').trim().split('\n').slice(-15),
    stderrTail: (result.stderr || '').trim().split('\n').slice(-15),
  };
}

function summarizeThemeChecksReport(reportPath) {
  const report = readRecord(reportPath);
  if (!report) return { reportWritten: false };
  return {
    reportWritten: true,
    ok: report.ok === true,
    refusalChecks: Array.isArray(report.refusals) ? report.refusals.map((r) => r.check) : [],
    schemaFailures: report.schemas?.failures?.length ?? null,
    settingsFailures: report.settingsBinding?.failures?.length ?? null,
    assetsMissing: report.assets?.counts?.localMissing ?? null,
    haravanContractFailures: report.haravanContracts?.failures?.length ?? null,
  };
}

/**
 * Run the offline gate.
 * @param {{ repoRoot: string, themeDir: string, evidenceDir: string }} input
 * @returns layer verdict (tier OFFLINE_STATIC)
 */
export function runStaticGate({ repoRoot, themeDir, evidenceDir }) {
  const resolvedTheme = path.resolve(repoRoot, themeDir);
  if (!fs.existsSync(resolvedTheme) || !fs.statSync(resolvedTheme).isDirectory()) {
    return blockedVerdict(LAYERS.L0, TIER, [`theme-dir-missing: ${themeDir} is not a readable directory`], { limits: [...LIMITS] });
  }

  const reportPath = path.join(evidenceDir, 'l0-theme-checks-report.json');
  const themeChecks = runScript(repoRoot, 'scripts/theme-checks.mjs', [
    '--theme', resolvedTheme,
    '--platform', 'haravan',
    '--out', reportPath,
  ]);
  const lint = runScript(repoRoot, 'scripts/lint-haravan-theme.mjs', [
    '--theme', resolvedTheme,
  ]);

  const checks = {
    'theme-checks': {
      exitCode: themeChecks.exitCode,
      ...summarizeThemeChecksReport(reportPath),
      stderrTail: themeChecks.stderrTail,
    },
    'lint-haravan-theme': {
      exitCode: lint.exitCode,
      violations: lint.stderrTail.filter((l) => /:\d+ HARAVAN_/.test(l)).length || null,
      stderrTail: lint.stderrTail,
    },
  };

  const spawned = [themeChecks, lint];
  if (spawned.some((r) => r.exitCode === null || r.timedOut || r.error)) {
    return makeVerdict({
      layer: LAYERS.L0,
      tier: TIER,
      verdict: 'INCONCLUSIVE',
      checks,
      limits: [...LIMITS],
      evidence: { reportPath },
      notes: ['a gate script failed to run to completion (spawn error, signal, or timeout)'],
    });
  }

  const refused = themeChecks.exitCode === 3;
  const lintFailed = lint.exitCode === 1;
  const usageError = themeChecks.exitCode === 2 || lint.exitCode === 2;

  let verdict = 'PASS';
  const notes = [];
  if (usageError) {
    verdict = 'INCONCLUSIVE';
    notes.push('a gate script exited 2 (usage/unreadable input) — the theme was not fully checked');
  } else if (refused || lintFailed) {
    verdict = 'FAIL';
    if (refused) notes.push('theme-checks refused the tree (exit 3)');
    if (lintFailed) notes.push('lint-haravan-theme reported violations (exit 1)');
  }

  return makeVerdict({
    layer: LAYERS.L0,
    tier: TIER,
    verdict,
    checks,
    limits: [...LIMITS],
    evidence: { reportPath },
    notes,
  });
}
