#!/usr/bin/env node
/**
 * scripts/purge-register-fixture-residue.mjs
 *
 * Purges test fixture residue from the AntiFan issue register.
 * Corresponds to Plan Item D-03 / isTestFixtureResidue in src/main/session/issue-register.ts.
 *
 * Usage:
 *   node scripts/purge-register-fixture-residue.mjs [path-to-issue-register.jsonl]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// Target file path resolution
let registerPath = process.argv[2];
if (!registerPath) {
  if (process.env.ANTIFAN_ISSUE_REGISTER_DIR) {
    registerPath = path.join(process.env.ANTIFAN_ISSUE_REGISTER_DIR, 'issue-register.jsonl');
  } else if (process.env.ANTIFAN_DATA_ROOT) {
    registerPath = path.join(process.env.ANTIFAN_DATA_ROOT, 'issues', 'issue-register.jsonl');
  } else {
    // Default live AntiFan data root location
    registerPath = path.resolve('E:/Work/.antifan-data/issues/issue-register.jsonl');
    if (!fs.existsSync(registerPath)) {
      // Fallback relative to current dir
      registerPath = path.resolve('.antifan-data/issues/issue-register.jsonl');
    }
  }
}

if (!fs.existsSync(registerPath)) {
  console.log(`[purge-register] No issue register found at ${registerPath}. Nothing to purge.`);
  process.exit(0);
}

// Literal markers from src/main/session/issue-register.ts:isTestFixtureResidue
const FIXTURE_TAB_ID = /\btab-(?:non-existent-999|unknown-999|closed-default|ws-2|ws-created-888|new-123|other-workspace|other-project|created-456|admin-dashboard|live|\d+)\b/;

function classifyFixtureResidue(issue) {
  // 1. Legacy cursor modal overlay fixture (browser-tab-identity-and-issue-register.test.ts)
  if (issue.toolName === 'anti.agent.cursor.type'
    && issue.errorMessage === 'Element obscured by modal overlay'
    && issue.errorCode === undefined) {
    return 'cursor_modal_overlay';
  }
  // 2. Synthetic test.* capability tools (control-plane and harness tests)
  if (typeof issue.toolName === 'string' && issue.toolName.startsWith('test.')) {
    return 'test_tool_prefix';
  }
  // 3. Fixture tab IDs in error message
  if (typeof issue.errorMessage === 'string' && FIXTURE_TAB_ID.test(issue.errorMessage)) {
    return 'fixture_tab_id';
  }
  // 4. In-tab GViz protocol CSP_ERROR fixture (browser-tab-identity-and-issue-register.test.ts)
  if (issue.toolName === 'anti.browser.evaluate'
    && (issue.workaroundApplied === 'Fetched via in-tab GViz protocol' || issue.errorMessage === 'Trusted Type violation on docs.google.com')) {
    return 'csp_gviz_fixture';
  }
  // 5. Explicit fixture residue notes or test human exemption notes (semantic-evidence-and-guardrails.test.ts)
  if (typeof issue.notes === 'string' && (issue.notes.includes('unit-test fixture residue') || issue.notes.includes('[HUMAN_EXEMPTION]'))) {
    return 'notes_exemption_or_residue';
  }
  // 6. Benchmark anti-hallucination Scenario 2: MENU_INOPERATIVE (benchmark-anti-hallucination.test.ts)
  if (issue.toolName === 'theme.qa' && issue.errorCode === 'MENU_INOPERATIVE' && issue.errorMessage === 'Mobile drawer menu fails to open on tap') {
    return 'benchmark_menu_inoperative';
  }
  // 7. Benchmark anti-hallucination Scenario 3: STYLE_MISMATCH (benchmark-anti-hallucination.test.ts)
  if (issue.toolName === 'theme.qa' && issue.errorCode === 'STYLE_MISMATCH' && issue.errorMessage === 'Cart modal styling mismatch') {
    return 'benchmark_style_mismatch';
  }
  // 8. Semantic evidence guardrails: LAYOUT_MISMATCH hero section (semantic-evidence-and-guardrails.test.ts)
  if (issue.toolName === 'theme.qa' && issue.errorCode === 'LAYOUT_MISMATCH' && issue.errorMessage === 'Layout parity discrepancy in hero section') {
    return 'semantic_layout_mismatch';
  }
  return null;
}

const rawContent = fs.readFileSync(registerPath, 'utf8');
const lines = rawContent.split(/\r?\n/).filter(Boolean);

console.log(`[purge-register] Inspecting ${registerPath}`);
console.log(`[purge-register] Total rows: ${lines.length}`);

const beforeCountsByCode = {};
const signatureCounts = {};
const keptIssues = [];
let removedCount = 0;

for (const line of lines) {
  let issue;
  try {
    issue = JSON.parse(line);
  } catch (err) {
    console.warn(`[purge-register] Skipping malformed line: ${line}`);
    continue;
  }

  const code = issue.errorCode || 'NONE';
  beforeCountsByCode[code] = (beforeCountsByCode[code] || 0) + 1;

  const signature = classifyFixtureResidue(issue);
  if (signature) {
    removedCount++;
    signatureCounts[signature] = (signatureCounts[signature] || 0) + 1;
  } else {
    keptIssues.push(issue);
  }
}

if (removedCount === 0) {
  console.log('[purge-register] No fixture residue rows found. Register is already clean (idempotent no-op).');
  process.exit(0);
}

// 1. Create backup
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${registerPath}.pre-purge-${timestamp}.bak`;
fs.copyFileSync(registerPath, backupPath);
console.log(`[purge-register] Backup created: ${backupPath}`);

// 2. Write kept issues atomically
const tempPath = `${registerPath}.tmp-${process.pid}-${Date.now()}`;
const newContent = keptIssues.map((i) => JSON.stringify(i)).join('\n') + (keptIssues.length > 0 ? '\n' : '');
fs.writeFileSync(tempPath, newContent, 'utf8');
fs.renameSync(tempPath, registerPath);

// 3. Compute after counts
const afterCountsByCode = {};
for (const issue of keptIssues) {
  const code = issue.errorCode || 'NONE';
  afterCountsByCode[code] = (afterCountsByCode[code] || 0) + 1;
}

console.log('\n[purge-register] --- PURGE SUMMARY ---');
console.log(`Initial rows: ${lines.length}`);
console.log(`Removed residue rows: ${removedCount}`);
console.log(`Retained real rows: ${keptIssues.length}`);

console.log('\n[purge-register] Removed breakdown by fixture signature:');
for (const [sig, count] of Object.entries(signatureCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${sig}: ${count}`);
}

console.log('\n[purge-register] Counts by errorCode (before -> after):');
const allCodes = new Set([...Object.keys(beforeCountsByCode), ...Object.keys(afterCountsByCode)]);
for (const code of Array.from(allCodes).sort()) {
  const before = beforeCountsByCode[code] || 0;
  const after = afterCountsByCode[code] || 0;
  const diff = after - before;
  console.log(`  ${code.padEnd(38)}: ${String(before).padStart(3)} -> ${String(after).padStart(3)} (${diff === 0 ? 'unchanged' : diff})`);
}
