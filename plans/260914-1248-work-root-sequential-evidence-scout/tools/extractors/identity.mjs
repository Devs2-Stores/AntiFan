// identity.mjs — v4 intelligence extractor: principles, hidden requirements,
// practice-parity (declared-vs-observed drift). Evidence-anchored only: a row
// is emitted only when a real markdown section/bullet in the unit's file
// inventory supports it. No evidence -> empty ledgers (a correct result).
//
// Contract (see tools/deep-analyze-unit.mjs):
//   extract(ctx) -> { claims: [], ledgers: { '<file>.jsonl': [rows] } }
//   ctx = { unitId, unit, files, platform, claims, decisions,
//           ev, gitEv, cid, did, depId, unitAbs, REGISTER }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 256 * 1024;
const MAX_FILES = 100;
const MAX_ROWS_PER_LEDGER = 60;
const SECTION_RE = /^#{1,4}\s+(.+)$/gm;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.{8,400})$/gm;

// Section-title classifiers. Kept deliberately specific: a heading that merely
// contains "rules" or "requirements" is not identity-layer signal.
const PRINCIPLE_TITLE =
  /principle|invariant|philosophy|constitution|nguyên tắc|bất biến|(?:^|\b)(?:always|never)(?:\s+(?:do|don't|dont|must|rule|rules|ever|break|compromise)|\s*[:—–-]|\s*$)/i;
const HIDDEN_TITLE =
  /client (?:request|ask|brief)|implicit (?:requirement|expectation|need|assumption)|hidden (?:requirement|expectation|need)|unstated|unspoken|expectation|kỳ vọng|yêu cầu ngầm|ngầm|khách hàng (?:yêu cầu|muốn|mong)/i;
const PARITY_TITLE =
  /declared\s+vs\.?\s+|vs\.?\s+(?:observed|actual|reality)|docs?\s+vs\.?\s+code|say\s+vs\.?\s+do|we say|in practice|in reality|reality check|drift|mismatch|parity|stated\s+vs\.?\s+actual|theory\s+vs\.?\s+practice|gap between|trên giấy|lý thuyết\s+vs\.?\s+thực tế|thực tế (?:là|thì|ra sao|khác)/i;

// Bullet-level contrast detector: catches "we say X but do Y" notes anywhere,
// even under a generic heading.
const CONTRAST_BULLET =
  /we say|docs? (?:say|claim)|declared|on paper|in practice|in reality|actually (?:we|the|code|it)|but (?:we |the |code |it )?(?:do|does|did|implement|ship|use)|thực tế (?:là|thì)|trên giấy/i;

const EXPLICIT_MARK = /explicit|stated|client (?:said|asked|request)|yêu cầu rõ|nêu rõ|đề cập/i;
const INFERRED_MARK = /implicit|inferred|hidden|unstated|expect|assum|suy ra|ngầm|mong đợi|kỳ vọng/i;

const LIKELIHOOD = [
  ['certain', /certain|definitely|must|required|always|chắc chắn|bắt buộc|đảm bảo/i],
  ['candidate', /candidate|maybe|possibly|might|unclear|guess|speculat|có thể|không rõ/i],
  ['likely', /likely|probably|expect|should|thường|khả năng/i],
];

const SAY_BUT_DO = /(?:we|docs?|documentation|spec)\s+say\s+(.+?)\s+but\s+(.+)$/i;
const REQ_LABEL = /^(?:\*\*)?(?:explicit|implicit|inferred|hidden|stated|unstated)(?:\s+requirement)?(?:\*\*)?\s*[:—–-]\s*/i;
const OBSERVED_LEAD = /^(?:we|they|the code|code|it|the theme|theme)\s+/i;
const DECLARED_LABEL = /^(?:\*\*)?(declared|docs?|documentation|spec|stated|we say|claimed|on paper|lý thuyết|cam kết)(?:\*\*)?\s*[:—–-]\s*(.+)$/i;
const OBSERVED_LABEL = /^(?:\*\*)?(observed|actual(?:ly)?|reality|in practice|code|practice|thực tế|thực hành)(?:\*\*)?\s*[:—–-]\s*(.+)$/i;
const GAP_LABEL = /^(?:\*\*)?(gap|impact|consequence|drift|so what|hệ quả|khoảng cách)(?:\*\*)?\s*[:—–-]\s*(.+)$/i;

function clean(s) {
  return (s ?? '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(REQ_LABEL, '')
    .trim()
    .slice(0, 300);
}

function bulletsOf(body) {
  const out = [];
  for (const m of body.matchAll(BULLET_RE)) {
    const b = clean(m[1]);
    if (b.length >= 8) out.push(b);
  }
  return [...new Set(out)];
}

// Fallback for bullet-less sections: first substantive paragraph line.
function paragraphOf(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^[-*+>|]/.test(t) || /^\d+[.)]/.test(t)) continue;
    const c = clean(t);
    if (c.length >= 20) return c;
  }
  return null;
}

function likelihoodOf(text, fallback = 'likely') {
  for (const [level, re] of LIKELIHOOD) if (re.test(text)) return level;
  return fallback;
}

export function extract(ctx) {
  const { unitId, unit, files, platform, ev, cid } = ctx;
  const claims = [];
  const principles = [];
  const hiddenReqs = [];
  const parity = [];
  const seen = new Set();
  const now = new Date().toISOString();
  const id = (prefix, key) => `${prefix}-${crypto.createHash('sha1').update(`${unitId}${key}`).digest('hex').slice(0, 12)}`;

  const claim = (statement, kind, evidenceRefs, extra = {}) => claims.push({
    claimId: cid(statement + (evidenceRefs[0]?.anchor ?? '')),
    unitId, statement, kind, evidenceRefs,
    counterEvidence: [], context: { platform: platform ?? null, version: null },
    extractorVersion: 'extract/identity', status: 'OBSERVED', ...extra,
  });

  const mdFiles = (files ?? [])
    .filter((f) => /\.(md|txt|markdown)$/i.test(f.path ?? ''))
    .sort((a, b) => String(a.relPath).localeCompare(String(b.relPath)))
    .slice(0, MAX_FILES);

  for (const f of mdFiles) {
    let raw;
    try { raw = fs.readFileSync(f.path, 'utf8').slice(0, MAX_BYTES); } catch { continue; }

    const sections = [];
    let m;
    SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(raw))) sections.push({ title: m[1].trim(), at: m.index });
    if (!sections.length) continue;

    for (let i = 0; i < sections.length; i += 1) {
      const s = sections[i];
      const body = raw.slice(s.at, sections[i + 1]?.at ?? raw.length).slice(0, 4000);
      const bullets = bulletsOf(body);
      const anchor = `section:${s.title}`;

      // ---------- principles ----------
      if (PRINCIPLE_TITLE.test(s.title) && principles.length < MAX_ROWS_PER_LEDGER) {
        const items = bullets.length ? bullets : [paragraphOf(body)].filter(Boolean);
        for (const st of items.slice(0, 8)) {
          const key = `prin|${f.relPath}|${s.title}|${st}`;
          const principleId = id('prin', key);
          if (seen.has(principleId)) continue;
          seen.add(principleId);
          const evRef = ev(f, anchor);
          principles.push({
            principleId, unitId,
            statement: st,
            source: f.relPath ?? null,
            derivedFrom: s.title.slice(0, 150),
            status: 'OBSERVED',
            createdAt: now,
          });
          claim(`principle: ${st.slice(0, 150)}`, 'PRINCIPLE', [evRef], {
            confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
          });
        }
        continue;
      }

      // ---------- hidden requirements ----------
      if (HIDDEN_TITLE.test(s.title) && hiddenReqs.length < MAX_ROWS_PER_LEDGER) {
        const items = bullets.length ? bullets : [paragraphOf(body)].filter(Boolean);
        const explicit = items.filter((b) => EXPLICIT_MARK.test(b));
        const inferred = items.filter((b) => !EXPLICIT_MARK.test(b) && INFERRED_MARK.test(b));
        const unmarked = items.filter((b) => !EXPLICIT_MARK.test(b) && !INFERRED_MARK.test(b));
        const titleLikelihood = likelihoodOf(s.title, 'likely');
        const evJson = JSON.stringify({ path: f.relPath ?? null, anchor });
        const pushReq = (explicitReq, inferredReq, likelihood, keyBit) => {
          const reqId = id('req', `req|${f.relPath}|${s.title}|${keyBit}`);
          if (seen.has(reqId)) return;
          seen.add(reqId);
          hiddenReqs.push({
            reqId, unitId,
            task: unit?.relPath ?? null,
            explicitReq, inferredReq, likelihood,
            evidence: evJson,
            createdAt: now,
          });
          claim(`hidden requirement (${likelihood}): ${(inferredReq ?? explicitReq ?? '').slice(0, 140)}`, 'HIDDEN_REQUIREMENT', [ev(f, anchor)], {
            confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
          });
        };
        if (explicit.length && (inferred.length || unmarked.length)) {
          // Doc distinguishes stated vs implied: pair them positionally.
          const pool = [...inferred, ...unmarked];
          const n = Math.max(explicit.length, pool.length);
          for (let k = 0; k < n; k += 1) {
            const inf = pool[k] ?? null;
            pushReq(explicit[k] ?? null, inf, inf ? likelihoodOf(inf, titleLikelihood) : 'certain', `pair${k}`);
          }
        } else {
          for (const b of items.slice(0, 8)) {
            const isExplicit = EXPLICIT_MARK.test(b);
            pushReq(isExplicit ? b : null, isExplicit ? null : b,
              isExplicit ? 'certain' : likelihoodOf(b, titleLikelihood), b.slice(0, 80));
          }
        }
        continue;
      }

      // ---------- practice parity ----------
      const contrastBullets = bullets.filter((b) => CONTRAST_BULLET.test(b));
      const isParitySection = PARITY_TITLE.test(s.title);
      if ((isParitySection || contrastBullets.length) && parity.length < MAX_ROWS_PER_LEDGER) {
        const evJson = JSON.stringify({ path: f.relPath ?? null, anchor });
        const declaredB = bullets.map((b) => b.match(DECLARED_LABEL)).find(Boolean);
        const observedB = bullets.map((b) => b.match(OBSERVED_LABEL)).find(Boolean);
        const gapB = bullets.map((b) => b.match(GAP_LABEL)).find(Boolean);

        if (declaredB && observedB) {
          const declared = clean(declaredB[2]);
          const observed = clean(observedB[2]);
          const key = `pp|${f.relPath}|${s.title}|${declared}|${observed}`;
          const parityId = id('pp', key);
          if (!seen.has(parityId)) {
            seen.add(parityId);
            parity.push({
              parityId, unitId,
              practice: s.title.slice(0, 150),
              declared, observed,
              gap: gapB ? clean(gapB[2]) : 'declared differs from observed',
              evidence: evJson,
              createdAt: now,
            });
            claim(`practice parity gap: ${s.title.slice(0, 120)}`, 'PRACTICE_PARITY', [ev(f, anchor)], {
              confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
            });
          }
        }

        const pool = isParitySection && !contrastBullets.length ? bullets : contrastBullets;
        for (const b of pool.slice(0, 6)) {
          if (declaredB && b === declaredB[0]) continue;
          let declared = null;
          let observed = b;
          const sm = b.match(SAY_BUT_DO);
          if (sm) { declared = clean(sm[1]); observed = clean(sm[2].replace(OBSERVED_LEAD, '')); }
          const key = `pp|${f.relPath}|${s.title}|${b.slice(0, 80)}`;
          const parityId = id('pp', key);
          if (seen.has(parityId)) continue;
          seen.add(parityId);
          parity.push({
            parityId, unitId,
            practice: s.title.slice(0, 150),
            declared,
            observed,
            gap: declared ? 'declared differs from observed' : (b.match(GAP_LABEL) ? clean(b.match(GAP_LABEL)[2]) : null),
            evidence: evJson,
            createdAt: now,
          });
          claim(`practice parity: ${b.slice(0, 140)}`, 'PRACTICE_PARITY', [ev(f, anchor)], {
            confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
          });
        }
      }
    }
  }

  return {
    claims,
    ledgers: {
      'principles.jsonl': principles,
      'hidden-requirements.jsonl': hiddenReqs,
      'practice-parity.jsonl': parity,
    },
  };
}
