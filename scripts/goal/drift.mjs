/**
 * Criteria-drift detector.
 *
 * A run that loosens its own acceptance criteria mid-flight produces PASS verdicts
 * that mean nothing — and the loosening is indistinguishable from success unless a
 * diff is checked. `detectDrift(before, after)` compares a baseline snapshot of
 * acceptance criteria / assertions against a later one and reports any weakening:
 *
 *  - an assertion line or criterion that existed before and is gone now;
 *  - a numeric bound that moved in the loosening direction (`>=`/`at least`/`min`
 *    dropped, `<=`/`at most`/`max` raised, `=` changed, direction flipped);
 *  - a bound that was removed while its subject line survived.
 *
 * Strengthening and pure additions are not drift. The result is an abort trigger:
 * `{ drift: bool, detail, findings }` feeds the health gate, which stops the run —
 * it is never a reason to retry.
 *
 * Inputs may be a text snapshot (markdown checklist, assertion list — one criterion
 * per line) or an array of criteria objects `{ id, text }` / `{ id, op, value }`.
 */

const ASSERTION_WORD = /\b(assert|expect|must|shall|requires?|verify|verifies|verified)\b/i;

const BOUND_RE =
  /(>=|<=|>|<|=|≥|≤|at\s+least|at\s+most|min(?:imum)?|max(?:imum)?|no\s+more\s+than|no\s+fewer\s+than|under|over)\s*[:~]?\s*(\d+(?:\.\d+)?)/gi;

/** 'lower': bigger value is stricter. 'upper': smaller value is stricter. 'exact': any change is drift. */
function boundDirection(op) {
  const o = op.toLowerCase().replace(/\s+/g, ' ');
  if (o === '>' || o === '>=' || o === '≥' || o === 'at least' || o === 'min' || o === 'minimum' || o === 'no fewer than' || o === 'over') {
    return 'lower';
  }
  if (o === '<' || o === '<=' || o === '≤' || o === 'at most' || o === 'max' || o === 'maximum' || o === 'no more than' || o === 'under') {
    return 'upper';
  }
  return 'exact';
}

function extractBounds(text) {
  const bounds = [];
  for (const m of String(text).matchAll(BOUND_RE)) {
    bounds.push({ dir: boundDirection(m[1]), op: m[1].toLowerCase().replace(/\s+/g, ' '), value: Number(m[2]) });
  }
  return bounds;
}

/** The line with its bounds blanked out — the identity a bound hangs on. */
function subjectOf(text) {
  return String(text).replace(BOUND_RE, '§').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isAssertionLine(text) {
  return ASSERTION_WORD.test(text) || extractBounds(text).length > 0;
}

/**
 * Normalize any accepted snapshot shape into entries:
 * `{ key, text, hasAssertion, bounds }`. `key` is how a criterion is matched
 * across snapshots: an explicit `id` when given, else its bound-stripped subject.
 */
function normalizeSnapshot(input) {
  if (input == null) return [];
  const items = typeof input === 'string' ? input.split(/\r?\n/) : Array.isArray(input) ? input : [input];
  const entries = [];
  const seen = new Map();
  for (const item of items) {
    let key = null;
    let text = '';
    let bounds = null;
    if (item && typeof item === 'object') {
      text = String(item.text ?? item.criterion ?? '');
      if (item.op != null && item.value != null) {
        bounds = [{ dir: boundDirection(String(item.op)), op: String(item.op).toLowerCase(), value: Number(item.value) }];
        if (!text) text = `${item.op} ${item.value}`;
      }
      if (item.id != null) key = `id:${item.id}`;
    } else {
      text = String(item);
    }
    if (!text.trim()) continue;
    if (!key) key = `subj:${subjectOf(text)}`;
    // Duplicate subjects are distinct criteria; disambiguate by occurrence.
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    entries.push({
      key: n ? `${key}#${n}` : key,
      text,
      hasAssertion: isAssertionLine(text),
      bounds: bounds ?? extractBounds(text),
    });
  }
  return entries;
}

function compareBounds(beforeEntry, afterEntry, findings) {
  const b = beforeEntry.bounds;
  const a = afterEntry.bounds;
  if (a.length < b.length) {
    findings.push(`bound removed from "${beforeEntry.text.trim()}" (${b.length} bound(s) became ${a.length})`);
    return;
  }
  for (let i = 0; i < b.length; i++) {
    const bb = b[i];
    const aa = a[i];
    if (bb.dir !== aa.dir) {
      findings.push(`bound direction changed in "${beforeEntry.text.trim()}" (${bb.op} became ${aa.op})`);
      continue;
    }
    if (bb.dir === 'lower' && aa.value < bb.value) {
      findings.push(`lower bound weakened in "${beforeEntry.text.trim()}" (${bb.op} ${bb.value} became ${aa.op} ${aa.value})`);
    } else if (bb.dir === 'upper' && aa.value > bb.value) {
      findings.push(`upper bound weakened in "${beforeEntry.text.trim()}" (${bb.op} ${bb.value} became ${aa.op} ${aa.value})`);
    } else if (bb.dir === 'exact' && aa.value !== bb.value) {
      findings.push(`exact bound changed in "${beforeEntry.text.trim()}" (= ${bb.value} became = ${aa.value})`);
    }
  }
}

/**
 * Compare a baseline snapshot against a later one.
 * Returns `{ drift: bool, detail: string|null, findings: string[] }`.
 */
export function detectDrift(before, after) {
  const b = normalizeSnapshot(before);
  const a = normalizeSnapshot(after);
  const afterByKey = new Map(a.map((e) => [e.key, e]));
  const findings = [];

  for (const entry of b) {
    const later = afterByKey.get(entry.key);
    if (!later) {
      if (entry.hasAssertion) {
        findings.push(`assertion removed: "${entry.text.trim()}"`);
      }
      continue;
    }
    if (entry.hasAssertion && !later.hasAssertion) {
      findings.push(`assertion weakened to non-assertion: "${entry.text.trim()}" became "${later.text.trim()}"`);
      continue;
    }
    compareBounds(entry, later, findings);
  }

  const beforeAssertions = b.filter((e) => e.hasAssertion).length;
  const afterAssertions = a.filter((e) => e.hasAssertion).length;
  if (afterAssertions < beforeAssertions && !findings.some((f) => f.startsWith('assertion removed'))) {
    findings.push(`assertion count dropped from ${beforeAssertions} to ${afterAssertions}`);
  }

  return {
    drift: findings.length > 0,
    detail: findings.length ? findings.join('; ') : null,
    findings,
  };
}
