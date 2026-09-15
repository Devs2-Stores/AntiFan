#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Bottleneck Closure Checker
 *
 * The repo's recurring failure mode is not that findings are wrong; it is that a
 * finding has no truth value attached to it. Prose reports state a defect, a later
 * fix silently repairs it, and nothing ever re-evaluates the prose — so the same
 * union of items is re-derived every audit round and dead items keep circulating.
 *
 * This checks a tracked registry (`plans/bottlenecks.json`) against HEAD. Every row
 * carries a predicate that returns `true` when the defect is PRESENT right now.
 *
 * Verdicts:
 *   open    + present      OK            still broken, correctly recorded
 *   open    + absent       ERROR (1)     FIXED_UNRECORDED — the fix landed; record it
 *   closed  + absent       OK            closure is machine-proven
 *   closed  + present      ERROR (1)     REOPENED — the registry is lying
 *   refuted + absent       OK            the refutation still holds
 *   refuted + present      ERROR (1)     REFUTED_BUT_PRESENT
 *   manual  (any status)   WARNING       STALE when older than the newest plan.md
 *
 * A `manual` row is a nudge, not a contradiction, so it warns instead of failing.
 * A row that claims `closed` while its predicate still fires is a contradiction, so
 * it fails. Rows with no usable predicate are an error by design: an uncheckable
 * claim is exactly the thing this exists to eliminate.
 *
 * Usage: `node scripts/check-bottlenecks.mjs [--json] [--quiet]`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'plans', 'bottlenecks.json');
const JSON_OUT = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');

const errors = [];
const warnings = [];
const results = [];

function fail(row, code, detail) {
  errors.push({ id: row ? row.id : '(registry)', code, detail });
}

function warn(row, code, detail) {
  warnings.push({ id: row ? row.id : '(registry)', code, detail });
}

function readText(relPath) {
  try {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
}

function readJson(relPath) {
  const text = readText(relPath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveJsonPath(value, dotted) {
  let cursor = value;
  for (const key of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Newest mtime across every `plans/**\/plan.md` — the forcing function for manual rows. */
function newestPlanMtime() {
  const plansDir = path.join(ROOT, 'plans');
  let newest = 0;
  let newestPath = '';
  const stack = [plansDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name !== 'plan.md') continue;
      const stat = fs.statSync(full);
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
        newestPath = path.relative(ROOT, full);
      }
    }
  }
  return { mtime: newest, path: newestPath };
}

const packageJson = readJson('package.json') || {};
const scriptFor = (name) => (packageJson.scripts ? packageJson.scripts[name] : undefined);

/**
 * Evaluate one row's predicate.
 * @returns {{present: boolean, detail: string}|{present: null, detail: string}}
 */
function evaluate(row) {
  const predicate = row.predicate;
  if (!predicate || typeof predicate !== 'object' || typeof predicate.kind !== 'string') {
    return { present: null, detail: 'no predicate declared' };
  }
  const result = evaluateRaw(predicate);
  // `negate` lets a row state a defect as the ABSENCE of a marker (e.g. "tsconfig does
  // not enable incremental") without a second predicate kind per check.
  if (predicate.negate === true && result.present !== null) {
    return { present: !result.present, detail: `negated: ${result.detail}` };
  }
  return result;
}

function evaluateLeaf(predicate) {
  const result = evaluateRaw(predicate);
  if (predicate.negate === true && result.present !== null) {
    return { present: !result.present, detail: `negated: ${result.detail}` };
  }
  return result;
}

function evaluateRaw(predicate) {
  switch (predicate.kind) {
    case 'any-of': {
      const subs = Array.isArray(predicate.predicates) ? predicate.predicates : [];
      if (subs.length === 0) return { present: null, detail: 'any-of with no predicates' };
      const parts = subs.map(evaluateLeaf);
      if (parts.some((p) => p.present === null)) return { present: null, detail: parts.map((p) => p.detail).join(' | ') };
      const fired = parts.filter((p) => p.present === true);
      return { present: fired.length > 0, detail: fired.length > 0 ? fired.map((p) => p.detail).join(' | ') : parts.map((p) => p.detail).join(' | ') };
    }

    case 'all-of': {
      const subs = Array.isArray(predicate.predicates) ? predicate.predicates : [];
      if (subs.length === 0) return { present: null, detail: 'all-of with no predicates' };
      const parts = subs.map(evaluateLeaf);
      if (parts.some((p) => p.present === null)) return { present: null, detail: parts.map((p) => p.detail).join(' | ') };
      return { present: parts.every((p) => p.present === true), detail: parts.map((p) => p.detail).join(' | ') };
    }

    case 'campaign-verdict-ledger': {
      // The defect this checks: the published verdict artifact is not a
      // revision-bound adjudication — an INCONCLUSIVE or empty tally, a missing
      // exit/finishedAt, an adjudicated case with no route identity, or a case
      // that could not even capture. Any of those means the ledger still cannot
      // prove rendered fidelity, so the row stays open until a live re-run
      // publishes a complete, bound artifact.
      const file = predicate.file || '.canary/15-pages/_verdicts.json';
      const index = readJson(file);
      if (index === null) return { present: true, detail: `${file} missing or unparseable` };
      const cases = Array.isArray(index.cases) ? index.cases : [];
      const problems = [];
      if (index.executiveVerdict === 'INCONCLUSIVE' || index.executiveVerdict === undefined || index.executiveVerdict === null) problems.push(`executiveVerdict=${JSON.stringify(index.executiveVerdict)}`);
      if (cases.length === 0) problems.push('cases empty');
      if (index.finishedAt === null || index.finishedAt === undefined) problems.push('finishedAt null');
      if (index.exit === null || index.exit === undefined) problems.push('exit null');
      if (index.runComplete === false) problems.push('runComplete false');
      const adjudicated = cases.filter((c) => c && (c.verdict === 'PASS' || c.verdict === 'FAIL'));
      if (adjudicated.length === 0) problems.push('no adjudicated case');
      const unbound = adjudicated.filter((c) => !c.routeIdentity);
      if (unbound.length > 0) problems.push(`${unbound.length} adjudicated case(s) without routeIdentity`);
      const captureInvalid = cases.filter((c) => c && c.causeCode === 'CAPTURE_INVALID');
      if (captureInvalid.length > 0) problems.push(`${captureInvalid.length} case(s) CAPTURE_INVALID`);
      return {
        present: problems.length > 0,
        detail: problems.length > 0 ? `${file}: ${problems.join('; ')}` : `${file}: revision-bound ledger (${adjudicated.length} adjudicated of ${cases.length})`,
      };
    }

    case 'manual':
      return { present: null, detail: `last verified ${predicate.lastVerifiedAt || '(never)'} by ${predicate.lastVerifiedBy || '(unknown)'}` };

    case 'file-regex': {
      const text = readText(predicate.file);
      if (text === null) return { present: null, detail: `evidence file missing: ${predicate.file}` };
      const re = new RegExp(predicate.pattern, predicate.flags || '');
      return { present: re.test(text), detail: `${predicate.file} ~ /${predicate.pattern}/` };
    }

    case 'file-absent-regex': {
      const text = readText(predicate.file);
      if (text === null) return { present: null, detail: `evidence file missing: ${predicate.file}` };
      const re = new RegExp(predicate.pattern, predicate.flags || '');
      return { present: !re.test(text), detail: `${predicate.file} !~ /${predicate.pattern}/` };
    }

    case 'json-path-equals': {
      const value = resolveJsonPath(readJson(predicate.file), predicate.path);
      return { present: value === predicate.equals, detail: `${predicate.file}:${predicate.path} === ${JSON.stringify(predicate.equals)} (actual ${JSON.stringify(value)})` };
    }

    case 'json-path-missing': {
      const value = resolveJsonPath(readJson(predicate.file), predicate.path);
      return { present: value === undefined, detail: `${predicate.file}:${predicate.path} absent (actual ${JSON.stringify(value)})` };
    }

    case 'script-exists': {
      const value = scriptFor(predicate.script);
      return { present: value !== undefined, detail: `package.json scripts["${predicate.script}"]=${JSON.stringify(value)}` };
    }

    case 'script-matches': {
      const value = scriptFor(predicate.script);
      if (typeof value !== 'string') return { present: false, detail: `package.json scripts["${predicate.script}"] is absent` };
      const re = new RegExp(predicate.pattern, predicate.flags || '');
      return { present: re.test(value), detail: `package.json scripts["${predicate.script}"] ~ /${predicate.pattern}/` };
    }

    default:
      return { present: null, detail: `unknown predicate kind: ${predicate.kind}` };
  }
}

function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`[bottlenecks] registry not found: ${path.relative(ROOT, REGISTRY_PATH)}`);
    process.exit(1);
  }
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    console.error(`[bottlenecks] registry is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  const rows = Array.isArray(registry.rows) ? registry.rows : [];
  if (rows.length === 0) {
    console.error('[bottlenecks] registry has no rows');
    process.exit(1);
  }

  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || row.id.trim() === '') {
      fail(row, 'BAD_ROW', 'row is missing a string id');
      continue;
    }
    if (seen.has(row.id)) {
      fail(row, 'DUPLICATE_ID', `id "${row.id}" appears more than once`);
      continue;
    }
    seen.add(row.id);

    const status = row.status;
    if (!['open', 'closed', 'refuted'].includes(status)) {
      fail(row, 'BAD_STATUS', `status must be open|closed|refuted, got ${JSON.stringify(status)}`);
      continue;
    }

    const { present, detail } = evaluate(row);
    let verdict;
    if (present === null) {
      if (row.predicate && row.predicate.kind === 'manual') {
        verdict = 'MANUAL';
        const newest = newestPlanMtime();
        const verifiedAt = Date.parse(row.predicate.lastVerifiedAt || '');
        if (!Number.isFinite(verifiedAt)) {
          warn(row, 'MANUAL_NEVER_VERIFIED', `${detail}; no parseable lastVerifiedAt`);
        } else if (status !== 'refuted' && newest.mtime > 0 && verifiedAt < newest.mtime) {
          warn(row, 'STALE', `${detail}; a newer plan landed (${newest.path} @ ${new Date(newest.mtime).toISOString()})`);
        }
      } else {
        fail(row, 'NO_PREDICATE', detail);
        continue;
      }
    } else if (status === 'open') {
      verdict = present ? 'OPEN' : 'FIXED_UNRECORDED';
      if (!present) fail(row, 'FIXED_UNRECORDED', `${detail} — defect is absent at HEAD; flip status to "closed"`);
    } else if (status === 'closed') {
      verdict = present ? 'REOPENED' : 'CLOSED';
      if (present) fail(row, 'REOPENED', `${detail} — registry claims closed but the predicate still fires`);
    } else {
      verdict = present ? 'REFUTED_BUT_PRESENT' : 'REFUTED_OK';
      if (present) fail(row, 'REFUTED_BUT_PRESENT', `${detail} — registry claims refuted but the predicate fires`);
    }

    results.push({ id: row.id, group: row.group || '', title: row.title || '', status, verdict, detail });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ errors, warnings, results }, null, 2));
    process.exit(errors.length > 0 ? 1 : 0);
  }

  const byVerdict = new Map();
  for (const result of results) byVerdict.set(result.verdict, (byVerdict.get(result.verdict) || 0) + 1);

  if (!QUIET) {
    for (const result of results) {
      const flag = result.verdict === 'CLOSED' || result.verdict === 'OPEN' || result.verdict === 'REFUTED_OK' || result.verdict === 'MANUAL' ? ' ' : '!';
      console.log(`${flag} [${result.verdict}] ${result.id} — ${result.title}`);
    }
    console.log('');
  }

  console.log(`[bottlenecks] ${results.length} row(s): ${[...byVerdict.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const entry of warnings) console.log(`[bottlenecks] warn ${entry.code} ${entry.id}: ${entry.detail}`);
  for (const entry of errors) console.error(`[bottlenecks] ERROR ${entry.code} ${entry.id}: ${entry.detail}`);

  if (errors.length > 0) {
    console.error(`[bottlenecks] FAILED with ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log('[bottlenecks] OK — every declared status matches HEAD.');
}

main();
