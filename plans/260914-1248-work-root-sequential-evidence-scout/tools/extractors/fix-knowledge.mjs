// v4 intelligence extractor: anti-patterns, workarounds, fix-patterns.
// Sources: plan/skill markdown sections (same SECTION_RE + title-classifier
// approach as deep-analyze-unit.mjs) and git fix-commits for repo units.
// Evidence-anchored only — every row cites file#anchor or git:sha; a unit
// with no supporting content yields empty ledgers, which is a correct result.
//
// Contract: export function extract(ctx) -> { claims, ledgers }.
//   ctx = { unitId, unit, files, platform, claims, decisions, ev, gitEv,
//           cid, did, depId, unitAbs, REGISTER }
//   ledgers keys are reports-level JSONL filenames; every row carries unitId
//   so the orchestrator can rewrite this unit's slice idempotently.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MAX_BYTES = 256 * 1024;   // per-file read cap
const MAX_FILES = 60;           // markdown files per unit
const MAX_COMMITS = 500;        // git log cap (matches orchestrator)
const MAX_ROWS = 150;           // per ledger per unit
const BODY_SLICE = 4000;        // section body window for field parsing

// Section split + title classifiers (approach reused from deep-analyze-unit).
// Precedence fix-doc > anti-pattern > workaround > risk keeps each section in
// exactly one ledger; workaround/gotcha titles are NOT anti-patterns.
const SECTION_RE = /^#{1,4}\s+(.+)$/gm;
const FIXDOC_SECTION = /fix.?pattern|before.{0,3}after|trước.{0,5}sau|bugfix|root cause|sửa lỗi|regression fix/i;
const ANTIPATTERN_SECTION = /anti.?pattern|không được|never\b|don'?t\b|do not|tránh|pitfall|bad practice|cấm|sai lầm|must not/i;
const WORKAROUND_SECTION = /workaround|work around|gotcha|khắc phục|bypass|tạm thời|temporary|xử lý tạm/i;
const RISK_SECTION = /risk|rủi ro|limitation|hạn chế|blocker|caveat|failure mode|known issue/i;

const FIX_RE = /^(fix|bugfix|hotfix|revert)(\(|:|\b)/i;
const SKIP_PATH = /node_modules|[\\/]\.git[\\/]/i;

const clean = (s) => (s ?? '').replace(/\*\*/g, '').replace(/#+\s*$/, '').replace(/\s+/g, ' ').trim();

// List items: "- x", "* x", "1. x". Bounded length keeps noise out.
function bulletsOf(body, cap = 8) {
  const out = [];
  for (const m of body.matchAll(/^\s*(?:[-*]|\d+[.)])\s+(.{8,400})$/gm)) {
    out.push(m[1].trim());
    if (out.length >= cap) break;
  }
  return out;
}

// First prose line after the heading — workaround/fix sections often carry
// the real content as a paragraph, not bullets.
function proseOf(body) {
  const line = body.split(/\r?\n/).slice(1)
    .map((l) => l.trim())
    .find((l) => l.length > 20 && !l.startsWith('#') && !/^[-*]/.test(l) && !/^\d+[.)]/.test(l) && !l.startsWith('```') && !l.startsWith('|'));
  return line ? clean(line).slice(0, 400) : null;
}

// Labeled line: "- **Before:** x" / "Before: x" / "why — x". The required
// colon/dash after the label prevents matching prose ("before doing X").
function labeled(body, labels) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\**\\s*(?:${labels})\\s*\\**\\s*[:\\u2013\\u2014-]\\s*(.{5,400})`, 'im');
  const m = body.match(re);
  return m ? clean(m[1]) : null;
}

export function extract(ctx) {
  const { unitId, unit, platform = null, unitAbs } = ctx;
  const files = ctx.files ?? [];
  const claims = [];
  const antiPatterns = [];
  const workarounds = [];
  const fixPatterns = [];
  const seen = new Set();

  // Deterministic ids: sha1(unitId + key), prefixed to match record* methods.
  const lid = (p, s) => `${p}-${crypto.createHash('sha1').update(`${unitId}${s}`).digest('hex').slice(0, 12)}`;
  const ev = ctx.ev ?? ((f, anchor) => ({ entryId: f?.entryId ?? null, revision: f?.sha256 ?? null, path: f?.relPath ?? null, anchor }));
  const gitEv = ctx.gitEv ?? ((sha, subject) => ({ entryId: null, revision: sha, path: null, anchor: `git:${sha.slice(0, 10)} ${subject.slice(0, 60)}` }));
  const cid = ctx.cid ?? ((s) => lid('c', s));
  const now = () => new Date().toISOString();
  const toIso = (v) => {
    const t = v ? new Date(v) : null;
    return t && !Number.isNaN(t.getTime()) ? t.toISOString() : now();
  };
  // Ledger evidence is a TEXT column — serialize the ref readably.
  const evStr = (ref) => (ref?.path ? `${ref.path}#${ref.anchor}` : ref?.anchor ?? null);

  const claim = (statement, kind, refs, extra = {}) => claims.push({
    claimId: cid(statement + (refs[0]?.anchor ?? '')),
    unitId, statement, kind, evidenceRefs: refs,
    counterEvidence: [], context: { platform, version: null },
    extractorVersion: 'extract/fix-knowledge', status: 'OBSERVED', ...extra,
  });

  // ---------- markdown sections (plans, docs, reports, skills) ----------
  const mdFiles = files.filter((f) => /\.md$/i.test(f.path ?? '') && !SKIP_PATH.test(f.relPath ?? f.path ?? ''));

  for (const f of mdFiles.slice(0, MAX_FILES)) {
    let raw;
    try { raw = fs.readFileSync(f.path, 'utf8').slice(0, MAX_BYTES); } catch { continue; }
    const sections = [...raw.matchAll(SECTION_RE)].map((m) => ({ title: clean(m[1]), at: m.index }));
    for (let i = 0; i < sections.length; i += 1) {
      const s = sections[i];
      if (!s.title) continue;
      const body = raw.slice(s.at, sections[i + 1]?.at ?? raw.length).slice(0, BODY_SLICE);
      const bl = bulletsOf(body);
      if (!bl.length && !proseOf(body)) continue;   // heading-only: no knowledge
      const ref = ev(f, `section:${s.title.slice(0, 120)}`);
      const evidence = evStr(ref);
      const key = `${f.relPath}:${s.title}`;
      const createdAt = toIso(f.mtime);

      if (FIXDOC_SECTION.test(s.title)) {
        if (fixPatterns.length >= MAX_ROWS || seen.has(`fix${key}`)) continue;
        seen.add(`fix${key}`);
        let before = labeled(body, 'before|trước|old|was|previously');
        let after = labeled(body, 'after|sau|now|new');
        // "X -> Y" bullets carry before/after inline.
        const arrow = bl.map((b) => b.match(/^(.{5,160}?)\s*(?:→|->|=>)\s*(.{5,160})$/)).find(Boolean);
        if (!before && arrow) before = clean(arrow[1]);
        if (!after && arrow) after = clean(arrow[2]);
        const why = labeled(body, 'why|root cause|because|reason|lý do|vì');
        const lessonBullet = bl.find((b) => /lesson|always|never|nên|rule|must/i.test(b));
        fixPatterns.push({
          fixId: lid('fix', key), unitId,
          before, after, why, evidence,
          lesson: clean(lessonBullet ?? s.title).slice(0, 300),
          createdAt,
        });
        claim(`fix pattern: ${s.title.slice(0, 150)}`, 'FIX_PATTERN', [ref], {
          confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
        });
      } else if (ANTIPATTERN_SECTION.test(s.title)) {
        if (antiPatterns.length >= MAX_ROWS || seen.has(`ap${key}`)) continue;
        seen.add(`ap${key}`);
        const donts = bl.filter((b) => /never|don'?t|do not|không|tránh|avoid|cấm|must not|sai/i.test(b));
        const symptoms = bl.filter((b) => /symptom|leads? to|results? in|causes?|gây|break|bug|error|fail|dấu hiệu|khiến|mất/i.test(b));
        const repl = bl.find((b) => /instead|use |prefer|thay|nên|correct|đúng|→|replace/i.test(b));
        antiPatterns.push({
          patternId: lid('ap', key), unitId,
          name: s.title.slice(0, 150),
          // Section is titled as an anti-pattern: its bullets ARE the
          // not-to-do even without an explicit "don't" marker.
          whatNotToDo: clean(donts.length ? donts.join('; ') : (bl[0] ?? proseOf(body) ?? '')).slice(0, 400) || null,
          symptoms: symptoms.length ? clean(symptoms.join('; ')).slice(0, 400) : null,
          evidence,
          affectedPlatform: platform,
          replacement: repl ? clean(repl).slice(0, 300) : null,
          status: 'OBSERVED',
          createdAt,
        });
        claim(`anti-pattern: ${s.title.slice(0, 150)}`, 'ANTIPATTERN', [ref], {
          confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
        });
      } else if (WORKAROUND_SECTION.test(s.title)) {
        if (workarounds.length >= MAX_ROWS || seen.has(`wa${key}`)) continue;
        seen.add(`wa${key}`);
        const cond = bl.find((b) => /^(when|if|condition|khi|điều kiện|trường hợp|only when)\b/i.test(b));
        const solBullet = bl.find((b) => /solution|workaround|fix|use |instead|cách|giải pháp|xử lý|→|patch|override|set /i.test(b));
        const reason = bl.find((b) => /because|reason|why|lý do|vì|since|do /i.test(b));
        const ver = body.slice(0, 600).match(/\bv(?:ersion)?\s*[: ]?\s*(\d+(?:\.\d+)+)\b/i);
        workarounds.push({
          workaroundId: lid('wa', key), unitId,
          problem: s.title.slice(0, 200),
          condition: cond ? clean(cond).slice(0, 300) : null,
          solution: clean(labeled(body, 'solution|workaround|fix|giải pháp|cách|xử lý') ?? solBullet ?? proseOf(body) ?? '').slice(0, 400) || null,
          reason: reason ? clean(reason).slice(0, 300) : null,
          platform, version: ver ? ver[1] : null,
          evidence, stillValid: 1,
          createdAt,
        });
        claim(`workaround: ${s.title.slice(0, 150)}`, 'WORKAROUND', [ref], {
          confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
        });
      } else if (RISK_SECTION.test(s.title)) {
        // Risk/limitation sections document failure modes -> anti-pattern
        // symptoms. A mitigation bullet doubles as a workaround row.
        if (antiPatterns.length < MAX_ROWS && !seen.has(`ap${key}`) && bl.length) {
          seen.add(`ap${key}`);
          antiPatterns.push({
            patternId: lid('ap', key), unitId,
            name: s.title.slice(0, 150),
            whatNotToDo: null,
            symptoms: clean(bl.join('; ')).slice(0, 400) || null,
            evidence,
            affectedPlatform: platform,
            replacement: null,
            status: 'OBSERVED',
            createdAt,
          });
          claim(`documented risk/limitation: ${s.title.slice(0, 150)}`, 'ANTIPATTERN', [ref], {
            confidence: 'observed', sourceKind: 'doc-section', subject: s.title.slice(0, 120),
          });
        }
        const mitigation = bl.find((b) => /mitigat|workaround|instead|giảm|xử lý|avoid by|prevent/i.test(b));
        if (mitigation && workarounds.length < MAX_ROWS && !seen.has(`wa${key}`)) {
          seen.add(`wa${key}`);
          workarounds.push({
            workaroundId: lid('wa', key), unitId,
            problem: s.title.slice(0, 200),
            condition: null,
            solution: clean(mitigation).slice(0, 400),
            reason: null,
            platform, version: null,
            evidence, stillValid: 1,
            createdAt,
          });
        }
      }
    }
  }

  // ---------- git fix-commits (repo units only) ----------
  if (unit?.kind === 'repo' && unitAbs && fs.existsSync(path.join(unitAbs, '.git'))) {
    try {
      const log = execFileSync('git', ['-C', unitAbs, 'log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%ad%x1f%s%x1f%b%x1e', '--date=iso'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      for (const rec of log.split('\x1e')) {
        if (fixPatterns.length >= MAX_ROWS * 2) break;
        const [sha, date, subject, body = ''] = rec.split('\x1f');
        const subj = (subject ?? '').trim();
        if (!sha?.trim() || !FIX_RE.test(subj)) continue;
        const bod = body.trim();
        const lesson = clean(subj.replace(/^(fix|bugfix|hotfix|revert)(\([^)]*\))?\s*:?\s*/i, '')) || subj;
        fixPatterns.push({
          fixId: lid('fix', `git:${sha.trim()}`), unitId,
          before: labeled(bod, 'before|was|previously'),
          after: labeled(bod, 'after|now'),
          why: labeled(bod, 'why|root cause|because|reason|caused by'),
          evidence: `git:${sha.trim()} ${subj.slice(0, 60)}`,
          lesson: lesson.slice(0, 300),
          createdAt: toIso(date?.trim()),
        });
        claim(`fix pattern: ${subj.slice(0, 150)}`, 'FIX_PATTERN', [gitEv(sha.trim(), subj)], {
          confidence: 'observed', sourceKind: 'git-commit', subject: subj.slice(0, 120), validFrom: toIso(date?.trim()),
        });
      }
    } catch { /* git unavailable/failed — doc-derived rows still stand */ }
  }

  return {
    claims,
    ledgers: {
      'anti-patterns.jsonl': antiPatterns,
      'workarounds.jsonl': workarounds,
      'fix-patterns.jsonl': fixPatterns,
    },
  };
}
