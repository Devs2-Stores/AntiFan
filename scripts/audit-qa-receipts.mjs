#!/usr/bin/env node
/**
 * Read-only audit of `theme.qa_validate` receipts.
 *
 * A baseline-basis CERTIFIED receipt is only trustworthy when each of the three viewport
 * comparisons it rests on was read from the host's compare ledger. Receipts written before the
 * ledger existed record no `baselineProvenance`, so nothing proves their numbers were measured.
 * This script lists them; it never writes, moves or deletes a receipt.
 *
 * Usage:
 *   node scripts/audit-qa-receipts.mjs <workspaceRoot|receiptsDir> [...more] [--json]
 *
 * Every argument is either a workspace root (its `.antifan/qa-receipts` is scanned), a
 * `qa-receipts` directory itself, or a parent whose direct children are workspace roots.
 * Exit code: 0 when no receipt is flagged, 1 when at least one is, 2 on usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWPORTS = ['desktop', 'tablet', 'mobile'];

function parseArgs(argv) {
  const roots = [];
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    else roots.push(arg);
  }
  if (roots.length === 0) return { error: 'at least one workspace root or qa-receipts directory is required' };
  return { roots, json };
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The qa-receipts directories an argument stands for. */
export function receiptDirsFor(arg) {
  const resolved = path.resolve(arg);
  if (path.basename(resolved) === 'qa-receipts' && isDirectory(resolved)) return [resolved];
  const own = path.join(resolved, '.antifan', 'qa-receipts');
  if (isDirectory(own)) return [own];
  const dirs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(resolved, entry.name, '.antifan', 'qa-receipts');
    if (isDirectory(child)) dirs.push(child);
  }
  return dirs;
}

/**
 * Classifies one parsed receipt. Returns null when nothing needs attention, otherwise
 * `{ code, detail }`:
 *   NO_PROVENANCE      CERTIFIED on a baseline basis with no `baselineProvenance` record.
 *   CALLER_ASSERTED    CERTIFIED on a baseline basis, at least one viewport not from a compare receipt.
 *   BASIS_UNRECORDED   CERTIFIED with no `certificationBasis`, so the basis cannot be told.
 */
export function classifyReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (receipt.certification !== 'CERTIFIED') return null;
  const basis = receipt.certificationBasis;
  if (basis === 'greenfield') return null;
  if (basis !== 'baseline') {
    return { code: 'BASIS_UNRECORDED', detail: 'CERTIFIED receipt does not record certificationBasis; its baseline numbers cannot be traced' };
  }
  const provenance = receipt.baselineProvenance;
  if (!provenance || typeof provenance !== 'object') {
    return { code: 'NO_PROVENANCE', detail: 'baseline-basis CERTIFIED receipt records no baselineProvenance (written before compare receipts existed)' };
  }
  const notBacked = VIEWPORTS.filter((name) => provenance[name] !== 'compare-receipt');
  if (notBacked.length > 0) {
    return { code: 'CALLER_ASSERTED', detail: `baseline numbers at ${notBacked.join(', ')} were not read from a compare receipt` };
  }
  return null;
}

export function auditDirectory(dir) {
  const flagged = [];
  let scanned = 0;
  let unreadable = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { dir, scanned, unreadable, flagged };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      unreadable += 1;
      continue;
    }
    scanned += 1;
    const finding = classifyReceipt(receipt);
    if (!finding) continue;
    flagged.push({
      file,
      code: finding.code,
      detail: finding.detail,
      runId: typeof receipt.runId === 'string' ? receipt.runId : null,
      url: typeof receipt.url === 'string' ? receipt.url : typeof receipt.observedUrl === 'string' ? receipt.observedUrl : null,
      timestamp: typeof receipt.timestamp === 'string' ? receipt.timestamp : fs.statSync(file).mtime.toISOString(),
    });
  }
  return { dir, scanned, unreadable, flagged };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`audit-qa-receipts: ${parsed.error}\n`);
    process.exit(2);
  }
  const dirs = [...new Set(parsed.roots.flatMap(receiptDirsFor))];
  if (dirs.length === 0) {
    process.stderr.write('audit-qa-receipts: no .antifan/qa-receipts directory found under the given paths\n');
    process.exit(2);
  }
  const results = dirs.map(auditDirectory);
  const flagged = results.flatMap((r) => r.flagged);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ directories: results, flaggedTotal: flagged.length }, null, 2)}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`${r.dir}: ${r.scanned} receipt(s) read, ${r.unreadable} unreadable, ${r.flagged.length} flagged\n`);
      for (const f of r.flagged) process.stdout.write(`  ${f.code}  ${path.basename(f.file)}  ${f.timestamp}  ${f.detail}\n`);
    }
    const gateClosed = flagged.filter((f) => f.code !== 'BASIS_UNRECORDED').length;
    process.stdout.write(`${flagged.length} CERTIFIED receipt(s) flagged; ${gateClosed} of them rest on baseline numbers with no compare-receipt provenance and no longer open the QA gate.\n`);
  }
  process.exit(flagged.length > 0 ? 1 : 0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
