#!/usr/bin/env node
// Phase 5 correlation: dossiers + claims + content ledgers -> lineage.jsonl,
// conflicts.jsonl, domain-register.json, corpus-findings.md.
// Evidence rules: hash equality proves same bytes only; name collision is a
// candidate; git/copy evidence upgrades lineage. No majority-vote truth.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const UNITS_DIR = path.join(REPORTS, 'units');
const REGISTER = JSON.parse(fs.readFileSync(path.join(REPORTS, 'project-register.json'), 'utf8'));
const QUEUE = JSON.parse(fs.readFileSync(path.join(REPORTS, 'queue.json'), 'utf8'));
const SKILLS = JSON.parse(fs.readFileSync(path.join(REPORTS, 'skills-register.json'), 'utf8'));

const readJsonl = (f) => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const unitById = new Map(REGISTER.units.map((u) => [u.unitId, u]));
const doneUnits = QUEUE.units.filter((u) => u.state === 'DONE');

// ---- load per-unit data ---------------------------------------------------
const unitData = new Map();
for (const qu of doneUnits) {
  const d = path.join(UNITS_DIR, qu.unitId);
  unitData.set(qu.unitId, {
    unit: unitById.get(qu.unitId),
    claims: readJsonl(path.join(d, 'claims.jsonl')),
    ledger: readJsonl(path.join(d, 'content-ledger.jsonl')),
    dossier: fs.existsSync(path.join(d, 'dossier.md')) ? fs.readFileSync(path.join(d, 'dossier.md'), 'utf8') : '',
  });
}

// ---- platform classification ----------------------------------------------
// Evidence-based: .bwt => sapo; settings.html => haravan-legacy;
// settings_schema.json + .liquid => haravan-f1genz-or-shopify (disambiguate by
// path/name markers); else generic/unknown.
const classify = (unitId) => {
  const d = unitData.get(unitId);
  if (!d) return { platform: 'unknown', evidence: 'no data' };
  const files = d.ledger.map((l) => l.relPath.toLowerCase());
  const has = (pred) => files.some(pred);
  const name = (d.unit?.relPath ?? '').toLowerCase();
  if (has((f) => f.endsWith('.bwt'))) return { platform: 'sapo', evidence: '.bwt templates present' };
  if (has((f) => f.endsWith('settings.html'))) return { platform: 'haravan', evidence: 'settings.html present (legacy Haravan settings)' };
  if (has((f) => f.endsWith('settings_schema.json')) && has((f) => f.endsWith('.liquid'))) {
    if (/haravan|f1genz|customizes/.test(name)) return { platform: 'haravan', evidence: 'settings_schema.json + .liquid under haravan/f1genz/customizes path' };
    if (/shopify/.test(name)) return { platform: 'shopify', evidence: 'settings_schema.json + .liquid under shopify path' };
    return { platform: 'unknown', evidence: 'settings_schema.json + .liquid but no platform marker in path' };
  }
  if (has((f) => f.endsWith('package.json'))) return { platform: 'generic-js', evidence: 'package.json present' };
  if (has((f) => f.endsWith('skill.md'))) return { platform: 'skill-package', evidence: 'SKILL.md present' };
  return { platform: 'unknown', evidence: 'no platform markers' };
};

// ---- lineage candidates ----------------------------------------------------
const lineage = [];
const lid = () => `ln-${crypto.createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 10)}`;

// (a) same package.json name across units
const pkgNames = new Map();
for (const [uid, d] of unitData) {
  for (const c of d.claims.filter((x) => x.kind === 'MANIFEST')) {
    const m = c.statement.match(/name=([^\s]+)/);
    if (m && m[1] !== '(none)') {
      if (!pkgNames.has(m[1])) pkgNames.set(m[1], []);
      pkgNames.get(m[1]).push({ unitId: uid, path: c.evidenceRefs[0]?.path });
    }
  }
}
for (const [name, hits] of pkgNames) {
  if (hits.length > 1) lineage.push({ id: lid(), kind: 'same-package-name', name, units: hits, evidence: 'package.json name equality', strength: 'candidate', note: 'same name does not prove shared ancestry' });
}

// (b) same skill name across roots / locations
const skillNames = new Map();
for (const s of SKILLS.skills) {
  if (!skillNames.has(s.name)) skillNames.set(s.name, []);
  skillNames.get(s.name).push({ skillId: s.skillId, rootId: s.rootId, location: s.location, disposition: s.akDisposition });
}
for (const [name, hits] of skillNames) {
  if (hits.length > 1) lineage.push({ id: lid(), kind: 'same-skill-name', name, locations: hits, evidence: 'skill directory name equality across roots', strength: 'candidate' });
}

// (c) backup/copy dir-name patterns (X vs X_backup, X vs X/live, scratch copies)
const dirNames = new Map();
for (const u of REGISTER.units) {
  const base = u.relPath.split(/[\\/]/).pop().toLowerCase().replace(/[_-](backup|live|old|copy|final|new|v\d+)$/i, '');
  if (!dirNames.has(base)) dirNames.set(base, []);
  dirNames.get(base).push(u.relPath);
}
for (const [base, paths] of dirNames) {
  const uniq = [...new Set(paths)];
  if (uniq.length > 1 && base.length > 2) lineage.push({ id: lid(), kind: 'name-variant', base, paths: uniq, evidence: 'directory name variants (backup/live/copy suffix)', strength: 'candidate' });
}

// (d) identical file content across units (sha256 equality)
const hashMap = new Map();
for (const [uid, d] of unitData) {
  for (const l of d.ledger) {
    if (!l.sha256) continue;
    if (!hashMap.has(l.sha256)) hashMap.set(l.sha256, []);
    hashMap.get(l.sha256).push({ unitId: uid, relPath: l.relPath });
  }
}
let sameBytes = 0;
for (const [sha, hits] of hashMap) {
  const units = [...new Set(hits.map((h) => h.unitId))];
  if (units.length > 1) {
    sameBytes += 1;
    if (sameBytes <= 2000) lineage.push({ id: lid(), kind: 'same-bytes', sha256: sha.slice(0, 16), units, files: hits.length, evidence: 'sha256 equality proves identical bytes only', strength: 'same-bytes' });
  }
}

// ---- conflicts -------------------------------------------------------------
const conflicts = [];
// same-name skills with different dispositions or different file sets
for (const [name, hits] of skillNames) {
  if (hits.length < 2) continue;
  const disp = new Set(hits.map((h) => h.disposition));
  if (disp.size > 1) conflicts.push({ id: `cf-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 10)}`, kind: 'skill-disposition-conflict', subject: name, positions: hits, state: 'UNRESOLVED', note: 'same skill name has different AK dispositions across roots' });
}
// same package name, different versions
for (const [name, hits] of pkgNames) {
  if (hits.length < 2) continue;
  const versions = new Map();
  for (const h of hits) {
    const d = unitData.get(h.unitId);
    const vc = d?.claims.find((c) => c.kind === 'MANIFEST' && c.evidenceRefs[0]?.path === h.path);
    const v = vc?.statement.match(/version=([^\s]+)/)?.[1];
    if (v) { if (!versions.has(v)) versions.set(v, []); versions.get(v).push(h); }
  }
  if (versions.size > 1) conflicts.push({ id: `cf-${crypto.createHash('sha1').update(name + 'v').digest('hex').slice(0, 10)}`, kind: 'version-divergence', subject: name, positions: [...versions.entries()].map(([v, hs]) => ({ version: v, units: hs.map((h) => h.unitId) })), state: 'UNRESOLVED', note: 'same package name at different versions; not a vote' });
}

// ---- domain register -------------------------------------------------------
const domains = new Map();
const addDomain = (dom, unitId, evidence) => {
  if (!domains.has(dom)) domains.set(dom, { domain: dom, units: [], evidence: new Set() });
  const d = domains.get(dom);
  d.units.push(unitId);
  d.evidence.add(evidence);
};
for (const [uid, d] of unitData) {
  const cls = classify(uid);
  addDomain(cls.platform === 'unknown' ? 'unknown' : cls.platform, uid, cls.evidence);
  const u = d.unit;
  if (u?.kind === 'skill') addDomain('skill-package', uid, 'kind=skill');
  if (u?.kind === 'theme') addDomain('liquid-theme', uid, 'theme-project markers');
  if (d.claims.some((c) => c.kind === 'SKILL')) addDomain('skill-package', uid, 'SKILL.md claim');
  if (d.claims.some((c) => c.kind === 'THEME')) addDomain('liquid-theme', uid, 'liquid schema/form claims');
}
const domainRegister = {
  generatedAt: new Date().toISOString(),
  domains: [...domains.values()].map((d) => ({ domain: d.domain, unitCount: d.units.length, units: d.units, evidence: [...d.evidence] })),
  note: 'domains derived from observed evidence only; no seed taxonomy forced',
};

// ---- write -----------------------------------------------------------------
fs.writeFileSync(path.join(REPORTS, 'lineage.jsonl'), lineage.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(REPORTS, 'conflicts.jsonl'), conflicts.map((c) => JSON.stringify(c)).join('\n') + (conflicts.length ? '\n' : ''));
fs.writeFileSync(path.join(REPORTS, 'domain-register.json'), JSON.stringify(domainRegister, null, 2));

const findings = `# Corpus Findings (mechanical pass)

Generated ${new Date().toISOString()} from ${doneUnits.length} analyzed units.

## Scale
- Units analyzed: ${doneUnits.length} / ${QUEUE.units.length} routed
- Claims extracted: ${[...unitData.values()].reduce((a, d) => a + d.claims.length, 0)}
- Lineage candidates: ${lineage.length} (same-bytes clusters: ${sameBytes})
- Conflicts: ${conflicts.length} (all UNRESOLVED — no majority vote)

## Domains observed
${domainRegister.domains.map((d) => `- ${d.domain}: ${d.unitCount} units (${d.evidence.join('; ')})`).join('\n')}

## Lineage highlights
- Theme families: customizes/* (${REGISTER.units.filter((u) => u.relPath.startsWith('customizes') && u.kind === 'theme').length} theme projects), themes/f1genz/Haravan/* (${REGISTER.units.filter((u) => u.relPath.includes('f1genz') && u.kind === 'theme').length}), themes/devs2/* (${REGISTER.units.filter((u) => u.relPath.includes('devs2') && u.kind === 'theme').length})
- Skill mirrors: ${SKILLS.skills.filter((s) => s.akDisposition === 'EXCLUDED_AK_SKILL').length} AK-excluded, ${SKILLS.skills.filter((s) => s.akDisposition === 'ELIGIBLE').length} eligible
- Backup copies: ${lineage.filter((l) => l.kind === 'name-variant').length} name-variant clusters

## Limitations
- Mechanical extraction only; semantic depth per unit is bounded.
- Binary/media files are metadata-only; no content interpretation.
- Conflicts are recorded, not resolved; no claim promoted to active rule.
- Hash equality proves same bytes, not authorship or success.
`;
fs.writeFileSync(path.join(REPORTS, 'corpus-findings.md'), findings);

console.log(JSON.stringify({
  unitsAnalyzed: doneUnits.length,
  claims: [...unitData.values()].reduce((a, d) => a + d.claims.length, 0),
  lineage: lineage.length,
  sameBytesClusters: sameBytes,
  conflicts: conflicts.length,
  domains: domainRegister.domains.map((d) => `${d.domain}:${d.unitCount}`),
}, null, 2));
