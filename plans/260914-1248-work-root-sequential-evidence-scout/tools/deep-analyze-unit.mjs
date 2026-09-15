#!/usr/bin/env node
// Deep analyzer: mines git history, plans/reports, skills, and platform markers
// into deep-claims.jsonl per unit + decisions.jsonl/dependencies.jsonl at
// reports level. Complements analyze-unit.mjs (mechanical) — does not replace it.
// Usage: node deep-analyze-unit.mjs <unitId> [--max-commits N] [--max-bytes N]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const REGISTER = JSON.parse(fs.readFileSync(path.join(REPORTS, 'project-register.json'), 'utf8'));
const QUEUE = JSON.parse(fs.readFileSync(path.join(REPORTS, 'queue.json'), 'utf8'));

const unitId = process.argv[2];
const maxCommitsIdx = process.argv.indexOf('--max-commits');
const MAX_COMMITS = maxCommitsIdx > 0 ? Number(process.argv[maxCommitsIdx + 1]) : 500;
const maxBytesIdx = process.argv.indexOf('--max-bytes');
const MAX_BYTES = maxBytesIdx > 0 ? Number(process.argv[maxBytesIdx + 1]) : 256 * 1024;
if (!unitId) { console.error('usage: deep-analyze-unit.mjs <unitId>'); process.exit(1); }
const unit = REGISTER.units.find((u) => u.unitId === unitId);
const qu = QUEUE.units.find((u) => u.unitId === unitId);
if (!unit || !qu) { console.error(`unknown unit ${unitId}`); process.exit(1); }

const unitDir = path.join(PLAN_DIR, qu.fileInventory ? path.dirname(qu.fileInventory) : '');
const filesPath = path.join(unitDir, 'files.jsonl');
const outDir = path.join(REPORTS, 'units', unitId);
fs.mkdirSync(outDir, { recursive: true });

const files = fs.existsSync(filesPath)
  ? fs.readFileSync(filesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const WORK_ROOT = 'E:/Work';
const unitAbs = path.join(WORK_ROOT, unit.relPath);
const claims = [];
const decisions = [];
const dependencies = [];

const cid = (s) => `c-${crypto.createHash('sha1').update(`${unitId}${s}`).digest('hex').slice(0, 12)}`;
const did = (s) => `d-${crypto.createHash('sha1').update(`${unitId}${s}`).digest('hex').slice(0, 12)}`;
const depId = (s) => `dep-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)}`;

const claim = (statement, kind, evidenceRefs, extra = {}) => claims.push({
  claimId: cid(statement + (evidenceRefs[0]?.anchor ?? '')),
  unitId, statement, kind, evidenceRefs,
  counterEvidence: [], context: { platform: null, version: null },
  extractorVersion: 'deep-analyze/1.0', status: 'OBSERVED', ...extra,
});
const ev = (f, anchor) => ({ entryId: f?.entryId ?? null, revision: f?.sha256 ?? null, path: f?.relPath ?? null, anchor });
const gitEv = (sha, subject) => ({ entryId: null, revision: sha, path: null, anchor: `git:${sha.slice(0, 10)} ${subject.slice(0, 60)}` });

// ---------- platform inference ----------
const PLATFORM_RULES = [
  { platform: 'haravan', test: (rel, raw, lname) =>
      lname === 'settings.html' ||
      /haravan/i.test(rel) || (raw && /haravan|hstatic/i.test(raw.slice(0, 4000))) },
  { platform: 'sapo', test: (rel, raw, lname) =>
      /\.bwt$/i.test(lname) || /sapo|bizweb/i.test(rel) || (raw && /\bsapo\b|bizweb/i.test(raw.slice(0, 4000))) },
  { platform: 'shopify', test: (rel, raw, lname) =>
      /shopify/i.test(rel) || (raw && /@shopify|shopify\.(com|dev)|myshopify/i.test(raw.slice(0, 4000))) },
  { platform: 'generic-liquid', test: (rel, raw, lname) => /\.liquid$/i.test(lname) },
];

function inferPlatform() {
  const scores = {};
  for (const f of files) {
    const lname = path.basename(f.path).toLowerCase();
    const rel = f.relPath ?? '';
    let raw = null;
    const ext = (lname.match(/\.[^.]+$/) ?? [''])[0];
    if (['.json', '.md', '.liquid', '.bwt', '.html', '.js', '.ts', '.toml', '.yml'].includes(ext)) {
      try { raw = fs.readFileSync(f.path, 'utf8').slice(0, 8000); } catch {}
    }
    for (const r of PLATFORM_RULES) {
      if (r.test(rel, raw, lname)) { scores[r.platform] = (scores[r.platform] ?? 0) + 1; }
    }
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted;
}

const platformScores = inferPlatform();
// A tie (or no signal) is 'unknown', not a guess — a mis-inferred platform hides
// the unit's claims from other-platform queries, which is worse than no tag.
const platform =
  platformScores.length && platformScores[0][1] > (platformScores[1]?.[1] ?? 0)
    ? platformScores[0][0]
    : null;
if (platform) {
  const dist = platformScores.map(([p, n]) => `${p}:${n}`).join(', ');
  claim(`platform markers observed: ${dist}`, 'PLATFORM', [{ entryId: null, revision: null, path: null, anchor: 'inference:file-markers' }], {
    context: { platform, version: null }, confidence: 'inferred', sourceKind: 'platform-inference',
  });
}

// ---------- git history mining (repo units only) ----------
let gitStats = { commits: 0, fixes: 0, features: 0, decisions: 0 };
if (unit.kind === 'repo' && fs.existsSync(path.join(unitAbs, '.git'))) {
  try {
    const log = execFileSync('git', ['-C', unitAbs, 'log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%ad%x1f%s%x1f%b%x1e', '--date=iso'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const commits = log.split('\x1e').filter(Boolean).map((rec) => {
      const [sha, date, subject, body] = rec.split('\x1f');
      return { sha: sha?.trim(), date: date?.trim(), subject: subject?.trim() ?? '', body: body?.trim() ?? '' };
    }).filter((c) => c.sha);
    gitStats.commits = commits.length;

    const FIX_RE = /^(fix|bugfix|hotfix|revert)(\(|:|\b)/i;
    const FEAT_RE = /^(feat|feature|add)(\(|:|\b)/i;
    const DECIDE_RE = /\b(because|instead of|rather than|chose|decided|trade.?off|why:|rationale)\b/i;
    const BREAKING_RE = /breaking|BREAKING CHANGE/i;

    for (const c of commits) {
      const text = `${c.subject} ${c.body}`;
      if (FIX_RE.test(c.subject)) {
        gitStats.fixes += 1;
        claim(`fix: ${c.subject.slice(0, 200)}`, 'BUGFIX', [gitEv(c.sha, c.subject)], {
          context: { platform, version: null }, confidence: 'observed', sourceKind: 'git-commit',
          subject: c.subject.slice(0, 120), validFrom: c.date,
        });
      } else if (FEAT_RE.test(c.subject)) {
        gitStats.features += 1;
        claim(`feature: ${c.subject.slice(0, 200)}`, 'FEATURE', [gitEv(c.sha, c.subject)], {
          context: { platform, version: null }, confidence: 'observed', sourceKind: 'git-commit',
          subject: c.subject.slice(0, 120), validFrom: c.date,
        });
      }
      if (DECIDE_RE.test(text) || BREAKING_RE.test(text)) {
        gitStats.decisions += 1;
        decisions.push({
          decisionId: did(c.sha), unitId,
          statement: c.subject.slice(0, 300),
          context: BREAKING_RE.test(text) ? 'breaking-change' : 'commit-rationale',
          alternatives: null, chosen: c.subject.slice(0, 200),
          evidence: [{ type: 'git-commit', sha: c.sha, date: c.date }],
          createdAt: c.date ?? new Date().toISOString(),
        });
      }
    }
    if (commits.length) {
      claim(`git history: ${commits.length} commits analyzed, ${gitStats.fixes} fixes, ${gitStats.features} features, ${gitStats.decisions} decision-marked`, 'HISTORY', [gitEv(commits[0].sha, 'git log summary')], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'git-log',
      });
    }
  } catch (e) {
    claim(`git history unavailable: ${String(e.message ?? e).slice(0, 120)}`, 'HISTORY', [{ entryId: null, revision: null, path: null, anchor: 'git-error' }], {
      status: 'UNRESOLVED', confidence: 'observed', sourceKind: 'git-log',
    });
  }
}

// ---------- plan / report / docs mining ----------
const PLAN_RE = /(^|[\\/])(plans?|docs?|reports?)[\\/]/i;
const planFiles = files.filter((f) => PLAN_RE.test(f.relPath ?? '') && /\.(md|txt)$/i.test(f.path));
let planStats = { files: 0, decisions: 0, risks: 0, outcomes: 0 };

const SECTION_RE = /^#{1,4}\s+(.+)$/gm;
const DECISION_SECTION = /decision|quyết định|approach|chosen|rationale|trade.?off|vì sao|lý do/i;
const RISK_SECTION = /risk|rủi ro|limitation|hạn chế|unknown|blocker|caveat/i;
const OUTCOME_SECTION = /outcome|result|kết quả|acceptance|nghiệm thu|verdict|status:.*done|completed/i;
const ANTIPATTERN_SECTION = /anti.?pattern|workaround|không được|never do|don\'t|tránh|pitfall|gotcha/i;
// Parse a decision section body into structured fields. Returns only fields
// with real content — absent fields stay null, never fabricated.
function parseDecisionBody(body) {
  const bullets = [...body.matchAll(/^\s*[-*]\s+(.{10,400})$/gm)].map((b) => b[1].trim());
  const pick = (re) => (bullets.find((b) => re.test(b)) ?? null);
  const strip = (s) => (s ? s.replace(/^[-*\s]+/, '').replace(/^\*\*(.+?)\*\*:?\s*/, '$1: ').slice(0, 300) : null);
  const problem = strip(pick(/problem|issue|vấn đề|context|bối cảnh|goal|mục tiêu/i) ?? bullets[0] ?? null);
  const alternatives = bullets.filter((b) => /option|alternative|approach|candidate|considered|phương án|cách/i.test(b)).map(strip).slice(0, 5);
  const chosen = strip(pick(/chose|chosen|selected|decided|pick|winner|→|=>|chọn|quyết định/i));
  const tradeoffs = strip(pick(/trade.?off|downside|cost|risk|but|however|con|nhược điểm|đánh đổi/i));
  const outcome = strip(pick(/outcome|result|kết quả|success|fail|verdict|pass|shipped|merged/i));
  const confidence = chosen || outcome ? 'observed' : 'inferred';
  return { problem, alternatives: alternatives.length ? alternatives : null, chosen, tradeoffs, outcome, confidence };
}


for (const f of planFiles.slice(0, 60)) {
  let raw;
  try { raw = fs.readFileSync(f.path, 'utf8').slice(0, MAX_BYTES); } catch { continue; }
  planStats.files += 1;
  const sections = [];
  let m;
  while ((m = SECTION_RE.exec(raw))) sections.push({ title: m[1].trim(), at: m.index });
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    const body = raw.slice(s.at, sections[i + 1]?.at ?? raw.length).slice(0, 2000);
    if (DECISION_SECTION.test(s.title)) {
      planStats.decisions += 1;
      const parsed = parseDecisionBody(body);
      decisions.push({
        decisionId: did(`${f.relPath}:${s.title}`), unitId,
        statement: `${s.title}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`,
        context: 'plan-doc',
        alternatives: parsed.alternatives ? JSON.stringify(parsed.alternatives) : null,
        chosen: parsed.chosen ?? s.title,
        problem: parsed.problem, tradeoffs: parsed.tradeoffs,
        outcome: parsed.outcome, confidence: parsed.confidence,
        evidence: [{ type: 'file', path: f.relPath, anchor: s.title }],
        createdAt: new Date().toISOString(),
      });
      claim(`decision recorded: ${s.title.slice(0, 150)}`, 'DECISION', [ev(f, `section:${s.title}`)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'plan-doc', subject: s.title.slice(0, 120),
      });
    } else if (RISK_SECTION.test(s.title)) {
      planStats.risks += 1;
      claim(`risk/limitation: ${s.title.slice(0, 150)}`, 'RISK', [ev(f, `section:${s.title}`)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'plan-doc', subject: s.title.slice(0, 120),
      });
    } else if (OUTCOME_SECTION.test(s.title)) {
      planStats.outcomes += 1;
      claim(`outcome/result: ${s.title.slice(0, 150)}`, 'OUTCOME', [ev(f, `section:${s.title}`)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'plan-doc', subject: s.title.slice(0, 120),
      });
    } else if (ANTIPATTERN_SECTION.test(s.title)) {
      claim(`anti-pattern/workaround: ${s.title.slice(0, 150)}`, 'ANTIPATTERN', [ev(f, `section:${s.title}`)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'plan-doc', subject: s.title.slice(0, 120),
      });
    }
  }
}

// ---------- skill analysis (eligible skills) ----------
// Mine every markdown file in the skill unit (SKILL.md + references/*.md):
// frontmatter identity claims, then section-level knowledge claims. Skill
// bodies are the densest domain knowledge in the corpus — rules, pitfalls,
// platform quirks — so bullets inside knowledge sections become claims too.
const RULE_SECTION = /rule|quy tắc|requirement|must|never|always|bắt buộc|constraint|invariant|checklist|pattern|convention|workflow|step|procedure|guide|hướng dẫn/i;
const skillMdFiles = files.filter((f) => /\.md$/i.test(f.path));
for (const f of skillMdFiles) {
  let raw;
  try { raw = fs.readFileSync(f.path, 'utf8').slice(0, MAX_BYTES); } catch { continue; }
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fmText = fm?.[1] ?? '';
  const get = (k) => (fmText.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) ?? [])[1]?.trim();
  const name = get('name'); const desc = get('description'); const when = get('when_to_use');
  if (/skill\.md$/i.test(f.path) && (name || desc)) {
    claim(`skill ${name ?? path.basename(path.dirname(f.path))}: ${desc?.slice(0, 200) ?? 'no description'}`, 'SKILL', [ev(f, 'frontmatter')], {
      context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md',
      subject: name ?? null,
    });
  }
  if (/skill\.md$/i.test(f.path) && when) {
    claim(`skill trigger: ${when.slice(0, 200)}`, 'SKILL', [ev(f, 'when_to_use')], {
      context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md', subject: name ?? null,
    });
  }
  // Section-level mining: same taxonomy as plan docs, plus RULE sections.
  const sections = [];
  let m;
  const SRE = new RegExp(SECTION_RE.source, 'gm');
  while ((m = SRE.exec(raw))) sections.push({ title: m[1].trim(), at: m.index });
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    const body = raw.slice(s.at, sections[i + 1]?.at ?? raw.length).slice(0, 4000);
    const anchor = `section:${s.title.slice(0, 80)}`;
    if (ANTIPATTERN_SECTION.test(s.title)) {
      claim(`anti-pattern/pitfall: ${s.title.slice(0, 150)}`, 'ANTIPATTERN', [ev(f, anchor)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md', subject: s.title.slice(0, 120),
      });
    } else if (RISK_SECTION.test(s.title)) {
      claim(`risk/limitation: ${s.title.slice(0, 150)}`, 'RISK', [ev(f, anchor)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md', subject: s.title.slice(0, 120),
      });
    } else if (DECISION_SECTION.test(s.title)) {
      claim(`decision recorded: ${s.title.slice(0, 150)}`, 'DECISION', [ev(f, anchor)], {
        context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md', subject: s.title.slice(0, 120),
      });
    } else if (RULE_SECTION.test(s.title)) {
      // Bullet-level rules: each imperative bullet is a discrete knowledge claim.
      const bullets = [...body.matchAll(/^\s*[-*]\s+(.{20,300})$/gm)].map((b) => b[1].trim()).slice(0, 12);
      for (const b of bullets) {
        claim(`${s.title.slice(0, 80)}: ${b}`, 'RULE', [ev(f, anchor)], {
          context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md', subject: s.title.slice(0, 120),
        });
      }
      if (!bullets.length) {
        claim(`rule section: ${s.title.slice(0, 150)}`, 'RULE', [ev(f, anchor)], {
          context: { platform, version: null }, confidence: 'observed', sourceKind: 'skill-md', subject: s.title.slice(0, 120),
        });
      }
    }
  }
}

// ---------- commercial / client signals ----------
const COMMERCIAL_RE = /quote|báo giá|estimate|scope|client request|khách hàng|revision|feedback|acceptance criteria/i;
const commercialFiles = files.filter((f) => COMMERCIAL_RE.test(f.relPath ?? '') || COMMERCIAL_RE.test(path.basename(f.path)));
if (commercialFiles.length) {
  claim(`${commercialFiles.length} commercial/client-related file(s) observed`, 'COMMERCIAL', commercialFiles.slice(0, 5).map((f) => ev(f, 'filename')), {
    context: { platform, version: null }, confidence: 'inferred', sourceKind: 'filename-signal',
  });
}

// ---------- dependency edges (package.json deps → other units) ----------
const pkgFiles = files.filter((f) => path.basename(f.path).toLowerCase() === 'package.json');
const unitNames = new Map(REGISTER.units.map((u) => [u.relPath, u.unitId]));
for (const f of pkgFiles) {
  let raw;
  try { raw = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
  let pkg;
  try { pkg = JSON.parse(raw); } catch { continue; }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const depName of Object.keys(deps)) {
    // match dep name to another unit by package name or path segment
    for (const [relPath, uid] of unitNames) {
      if (uid === unitId) continue;
      const base = relPath.split(/[\\/]/).pop()?.toLowerCase();
      if (base && (depName.toLowerCase() === base || depName.toLowerCase().endsWith('/' + base))) {
        dependencies.push({
          id: depId(`${unitId}->${uid}:${depName}`),
          fromUnitId: unitId, toUnitId: uid, kind: 'npm-dependency',
          evidence: [{ type: 'package.json', path: f.relPath, dep: depName }],
        });
      }
    }
  }
}

// ---------- v4 intelligence extractors (tools/extractors/*.mjs) ----------
// Each module exports extract(ctx) -> { claims: [], ledgers: { 'file.jsonl': [rows] } }.
// A missing or throwing extractor degrades to empty output — it must not kill
// the unit's other evidence.
const EXTRACTOR_DIR = path.join(SCRIPT_DIR, 'extractors');
const extractorLedgers = {};
if (fs.existsSync(EXTRACTOR_DIR)) {
  const ctx = { unitId, unit, files, platform, claims, decisions, ev, gitEv, cid, did, depId, unitAbs, REGISTER };
  for (const mod of fs.readdirSync(EXTRACTOR_DIR).filter((f) => f.endsWith('.mjs'))) {
    try {
      const { extract } = await import(pathToFileURL(path.join(EXTRACTOR_DIR, mod)).href);
      const out = extract(ctx) ?? {};
      for (const c of out.claims ?? []) claims.push(c);
      for (const [file, rows] of Object.entries(out.ledgers ?? {})) {
        extractorLedgers[file] = (extractorLedgers[file] ?? []).concat(rows ?? []);
      }
    } catch (e) {
      claim(`extractor ${mod} failed: ${String(e.message ?? e).slice(0, 120)}`, 'EXTRACTION_ERROR', [{ entryId: null, revision: null, path: null, anchor: `extractor:${mod}` }], {
        status: 'UNRESOLVED', confidence: 'observed', sourceKind: 'extractor',
      });
    }
  }
}

// ---------- write ----------
// Rewrite this unit's slice instead of blind-append: re-running a unit must not
// duplicate rows or leave stale entries for renamed/removed sections.
const rewriteLedger = (file, rows, key) => {
  const p = path.join(REPORTS, file);
  const existing = fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const kept = existing.filter((r) => r[key] !== unitId && r.fromUnitId !== unitId);
  fs.writeFileSync(p, kept.concat(rows).map((r) => JSON.stringify(r)).join('\n') + (kept.length + rows.length ? '\n' : ''));
};
rewriteLedger('decisions.jsonl', decisions, 'unitId');
rewriteLedger('dependencies.jsonl', dependencies, 'fromUnitId');
for (const [file, rows] of Object.entries(extractorLedgers)) rewriteLedger(file, rows, 'unitId');
// Per-unit claims: rewrite this unit's deep-claims.jsonl wholesale so re-runs
// stay idempotent (claimIds are deterministic hashes of unitId+statement).
fs.writeFileSync(path.join(outDir, 'deep-claims.jsonl'), claims.map((c) => JSON.stringify(c)).join('\n') + (claims.length ? '\n' : ''));

console.log(JSON.stringify({ unitId, relPath: unit.relPath, platform, gitStats, planStats, claims: claims.length, decisions: decisions.length, dependencies: dependencies.length }));
