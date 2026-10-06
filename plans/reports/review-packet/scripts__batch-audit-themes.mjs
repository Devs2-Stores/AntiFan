#!/usr/bin/env node
/**
 * scripts/batch-audit-themes.mjs
 *
 * Batch runner for theme.settings_check across custom theme workspaces.
 * Discovers eligible workspaces under E:/Work/customizes/ (or ANTIFAN_CUSTOMIZES_DIR),
 * executes theme-checks.mjs per theme writing per-theme JSON under plans/reports/theme-batch-audit/,
 * captures exit codes (0 = clean, 3 = findings, 2 = crash), and persists aggregated manifest.
 *
 * Usage:
 *   node scripts/batch-audit-themes.mjs
 *   node scripts/batch-audit-themes.mjs --approve <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CUSTOMIZES_DIR = 'E:/Work/customizes';
const CUSTOMIZES_DIR = path.resolve(process.env.ANTIFAN_CUSTOMIZES_DIR || DEFAULT_CUSTOMIZES_DIR);
const REPORTS_DIR = path.join(REPO_ROOT, 'plans', 'reports', 'theme-batch-audit');
const MANIFEST_PATH = path.join(REPO_ROOT, 'plans', 'reports', 'theme-batch-audit.json');

const EXPECTED_COUNT = parseInt(process.env.BATCH_AUDIT_EXPECTED_COUNT || '39', 10);

async function handleApprove(targetDir) {
  if (!targetDir) {
    console.error('[batch-audit] USAGE (exit 2): --approve <dir> requires a workspace directory path');
    process.exit(2);
  }
  const resolvedDir = path.resolve(targetDir);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    console.error(`[batch-audit] DIRECTORY_NOT_FOUND (exit 2): ${resolvedDir} is not a valid directory`);
    process.exit(2);
  }

  const themeName = path.basename(resolvedDir);
  const reportFile = path.join(REPORTS_DIR, `${themeName}.json`);
  const reviewFile = path.join(REPORTS_DIR, `${themeName}-review.md`);

  if (!fs.existsSync(reviewFile)) {
    console.error(`[batch-audit] APPROVE_REFUSED: review artifact '${path.relative(REPO_ROOT, reviewFile)}' does not exist.`);
    console.error(`  A human review artifact listing EVERY finding with explicit disposition is mandatory.`);
    process.exit(1);
  }

  if (!fs.existsSync(reportFile)) {
    console.error(`[batch-audit] APPROVE_REFUSED: audit report '${path.relative(REPO_ROOT, reportFile)}' does not exist. Run batch audit first.`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (err) {
    console.error(`[batch-audit] APPROVE_REFUSED: failed to parse report '${reportFile}': ${err.message}`);
    process.exit(1);
  }

  const reviewContent = fs.readFileSync(reviewFile, 'utf8');

  // Verify that EVERY failure in report is explicitly cited and has a valid disposition
  const allFailures = [];
  if (Array.isArray(report.refusals)) {
    for (const r of report.refusals) {
      if (Array.isArray(r.failures)) {
        allFailures.push(...r.failures);
      }
    }
  }

  const uncertifiedFindings = [];
  for (const failure of allFailures) {
    const rule = failure.rule || '';
    const id = failure.id || '';
    const file = failure.file || '';

    // Check if review artifact mentions this rule/id/file
    const mentionsRule = rule ? reviewContent.includes(rule) : true;
    const mentionsId = id ? reviewContent.includes(id) : true;
    const mentionsFile = file ? reviewContent.includes(file) : true;

    if (!mentionsRule || (!mentionsId && !mentionsFile)) {
      uncertifiedFindings.push({ failure, reason: 'missing from review artifact' });
      continue;
    }
  }

  // Check for uncertified/pending markers in the review document
  if (/disposition:\s*(pending|unreviewed|todo)/i.test(reviewContent)) {
    console.error(`[batch-audit] APPROVE_REFUSED: review artifact contains pending/unreviewed dispositions.`);
    process.exit(1);
  }

  if (uncertifiedFindings.length > 0) {
    console.error(`[batch-audit] APPROVE_REFUSED: ${uncertifiedFindings.length} findings are not certified in '${themeName}-review.md':`);
    for (const u of uncertifiedFindings.slice(0, 5)) {
      console.error(`  - [${u.failure.rule}] ${u.failure.file || u.failure.id}: ${u.reason}`);
    }
    process.exit(1);
  }

  // Successful verification: write { reviewed: true } into <dir>/.antifan/settings-baseline.json
  const antifanDir = path.join(resolvedDir, '.antifan');
  fs.mkdirSync(antifanDir, { recursive: true });
  const baselineFile = path.join(antifanDir, 'settings-baseline.json');
  let baseline = {};
  if (fs.existsSync(baselineFile)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    } catch {}
  }

  baseline.reviewed = true;
  baseline.reviewedAt = new Date().toISOString();
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2), 'utf8');

  console.log(`[batch-audit] APPROVED: successfully marked reviewed: true in ${path.relative(REPO_ROOT, baselineFile)}`);
  process.exit(0);
}

function runBatchAudit() {
  if (!fs.existsSync(CUSTOMIZES_DIR) || !fs.statSync(CUSTOMIZES_DIR).isDirectory()) {
    console.error(`[batch-audit] CUSTOMIZES_DIR_UNREADABLE (exit 2): ${CUSTOMIZES_DIR} is not a directory`);
    process.exit(2);
  }

  const entries = fs.readdirSync(CUSTOMIZES_DIR, { withFileTypes: true });
  const eligibleWorkspaces = entries
    .filter((ent) => {
      if (!ent.isDirectory()) return false;
      const full = path.join(CUSTOMIZES_DIR, ent.name);
      const hasSettingsHtml = fs.existsSync(path.join(full, 'config', 'settings.html'));
      const hasCliLocal = fs.existsSync(path.join(full, '.haravan-cli_local.json'));
      return hasSettingsHtml || hasCliLocal;
    })
    .map((ent) => ({
      name: ent.name,
      path: path.join(CUSTOMIZES_DIR, ent.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log(`[batch-audit] Discovered ${eligibleWorkspaces.length} eligible workspaces under ${CUSTOMIZES_DIR}`);
  const themeChecksScript = path.join(REPO_ROOT, 'scripts', 'theme-checks.mjs');

  const results = [];
  let crashCount = 0;
  let cleanCount = 0;
  let findingsCount = 0;
  const useCached = process.argv.includes('--cached');

  for (let idx = 0; idx < eligibleWorkspaces.length; idx++) {
    const ws = eligibleWorkspaces[idx];
    const outFile = path.join(REPORTS_DIR, `${ws.name}.json`);
    process.stdout.write(`[batch-audit] [${String(idx + 1).padStart(2)}/${eligibleWorkspaces.length}] Scanning ${ws.name.padEnd(24)} `);

    let exitCode = 3;
    let stdout = '';
    let stderr = '';

    if (useCached && fs.existsSync(outFile)) {
      let cachedReport;
      try {
        cachedReport = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        exitCode = cachedReport.ok ? 0 : 3;
      } catch {}
    } else {
      const spawnRes = spawnSync(
        process.execPath,
        [themeChecksScript, '--theme', ws.path, '--platform', 'haravan', '--out', outFile],
        {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          timeout: 60000,
        }
      );
      exitCode = spawnRes.status ?? (spawnRes.signal ? 128 : 1);
      stdout = spawnRes.stdout;
      stderr = spawnRes.stderr;
    }
    let statusLabel = 'UNKNOWN';
    if (exitCode === 0) {
      cleanCount++;
      statusLabel = 'CLEAN (exit 0)';
    } else if (exitCode === 3) {
      findingsCount++;
      statusLabel = 'FINDINGS (exit 3)';
    } else {
      crashCount++;
      statusLabel = `CRASH (exit ${exitCode})`;
    }

    let report = null;
    if (fs.existsSync(outFile)) {
      try {
        report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch {}
    }

    const uploadReads =
      report?.haravanContracts?.failures?.filter((f) => f.rule === 'HARAVAN_SETTINGS_UPLOAD_READ').length ?? 0;
    const duplicateNames =
      report?.haravanContracts?.failures?.filter((f) => f.rule === 'HARAVAN_SETTINGS_DUPLICATE_NAME').length ?? 0;
    const undeclared = report?.settingsBinding?.undeclared?.length ?? 0;
    const dead = report?.settingsBinding?.dead?.length ?? 0;

    console.log(`${statusLabel} [uploadRead=${uploadReads}, dupName=${duplicateNames}, undeclared=${undeclared}, dead=${dead}]`);

    results.push({
      name: ws.name,
      workspacePath: ws.path,
      exitCode,
      reportFile: path.relative(REPO_ROOT, outFile),
      stdout,
      stderr,
      summary: {
        ok: report?.ok ?? (exitCode === 0),
        refusalsCount: report?.refusals?.length ?? 0,
        uploadReadsCount: uploadReads,
        duplicateNamesCount: duplicateNames,
        undeclaredCount: undeclared,
        deadCount: dead,
      },
    });
  }

  const manifest = {
    scannedAt: new Date().toISOString(),
    customizesDir: CUSTOMIZES_DIR,
    expectedCount: EXPECTED_COUNT,
    discoveredCount: eligibleWorkspaces.length,
    stats: {
      clean: cleanCount,
      withFindings: findingsCount,
      crashes: crashCount,
    },
    workspaces: results,
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[batch-audit] Manifest written -> ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
  console.log(
    `[batch-audit] Summary: ${eligibleWorkspaces.length} workspaces scanned (clean: ${cleanCount}, findings: ${findingsCount}, crashes: ${crashCount})`
  );

  if (crashCount > 0) {
    console.error(`BATCH_AUDIT_FAIL: ${crashCount} workspace(s) suffered fatal crashes (exit 2).`);
    process.exit(2);
  }

  if (eligibleWorkspaces.length !== EXPECTED_COUNT) {
    const delta = eligibleWorkspaces.length - EXPECTED_COUNT;
    const deltaStr = delta > 0 ? `+${delta} extra` : `${delta} shortfall`;
    console.error(
      `BATCH_AUDIT_COUNT_MISMATCH: expected ${EXPECTED_COUNT} eligible workspaces, found ${eligibleWorkspaces.length} (${deltaStr}), ${crashCount} crashes.`
    );
    console.error(`Discovered workspaces (${eligibleWorkspaces.length}): ${eligibleWorkspaces.map((w) => w.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`BATCH_AUDIT_PASS: ${EXPECTED_COUNT}/${EXPECTED_COUNT} workspaces scanned, 0 crashes`);
  process.exit(0);
}

const args = process.argv.slice(2);
const approveIdx = args.indexOf('--approve');
if (approveIdx !== -1) {
  handleApprove(args[approveIdx + 1]);
} else {
  runBatchAudit();
}
