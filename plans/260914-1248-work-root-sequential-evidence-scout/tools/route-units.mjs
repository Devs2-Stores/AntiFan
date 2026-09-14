#!/usr/bin/env node
// Phase 3 routing: inventory.jsonl -> project-register.json, queue.json,
// skills-register.json. Deterministic, evidence-anchored; no semantic claims.
// Unit detection uses structural markers only (manifests, VCS dirs, theme
// layouts, SKILL.md); names never imply project identity (phase-03 risk note).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const INV = path.join(REPORTS, 'inventory.jsonl');
const SUMMARY = path.join(REPORTS, 'inventory-summary.json');

// Streaming JSONL reader: ledgers can exceed the max string length.
function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  const out = [];
  const fd = fs.openSync(f, 'r');
  const CHUNK = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let carry = '';
  const push = (line) => {
    if (!line) return;
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  };
  let n;
  while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
    carry += buf.toString('utf8', 0, n);
    let i;
    while ((i = carry.indexOf('\n')) >= 0) { push(carry.slice(0, i).replace(/\r$/, '')); carry = carry.slice(i + 1); }
  }
  if (carry) push(carry.replace(/\r$/, ''));
  fs.closeSync(fd);
  return out;
}

const entries = readJsonl(INV);
const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
if (!entries.length) { console.error('inventory.jsonl empty — run aggregate first'); process.exit(1); }

const uid = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- markers
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'cargo.toml', 'composer.json', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'mix.exs', 'pubspec.yaml', 'deno.json', 'deno.jsonc', 'bunfig.toml', 'setup.py', 'setup.cfg', 'requirements.txt']);
const DOTFILES = new Set(['.git', '.svn', '.hg']);
const THEME_MARKERS = new Set(['settings_schema.json', 'theme.liquid', 'settings.html']);
const SKILL_MARKER = 'skill.md';

// index entries by PARENT directory for marker/children lookup
const byDir = new Map();
const parentOf = (e) => {
  const rel = e.relPath;
  const i = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'));
  return `${e.rootId}${i < 0 ? '.' : rel.slice(0, i)}`;
};
for (const e of entries) {
  const k = parentOf(e);
  if (!byDir.has(k)) byDir.set(k, []);
  byDir.get(k).push(e);
}
const childrenOf = (rootId, relPath) => byDir.get(`${rootId}${relPath}`) ?? [];
const dirs = entries.filter((e) => e.type === 'directory');

// ---------------------------------------------------------------- unit detection
const units = [];
const unitByPath = new Map();

function addUnit({ rootId, relPath, kind, markers, parentId, disposition, note }) {
  const key = `${rootId}${relPath}`;
  if (unitByPath.has(key)) {
    const u = unitByPath.get(key);
    u.markers = [...new Set([...u.markers, ...markers])];
    if (disposition && u.disposition === 'ELIGIBLE') u.disposition = disposition;
    if (note && !u.note) u.note = note;
    return u;
  }
  const u = {
    unitId: `u-${uid(`${rootId}:${relPath}`)}`,
    rootId, relPath, kind,
    markers: [...new Set(markers)],
    parentId: parentId ?? null,
    disposition: disposition ?? 'ELIGIBLE',
    note: note ?? null,
    entryCount: 0, eligibleCount: 0, excludedCount: 0, restrictedCount: 0, generatedCount: 0,
    bytes: 0,
  };
  units.push(u);
  unitByPath.set(key, u);
  return u;
}

// 1. work-root depth-1 directories are candidate units
for (const e of entries.filter((x) => x.rootId === 'work-root' && x.depth === 1 && x.type === 'directory')) {
  addUnit({ rootId: 'work-root', relPath: e.relPath, kind: 'top-level', markers: ['top-level-dir'] });
}


// 2. marker-driven units anywhere under work-root (nested repos/packages/themes).
// Only ALLOWED dirs can host a unit: dependency/derived/restricted subtrees are
// content-excluded, so their internal manifests/skills are not separate units.
// Theme detection happens at the PROJECT ROOT: a dir whose children include a
// config dir containing settings_schema.json/settings.html plus at least one
// of templates/layout/snippets/locales/assets is a Liquid theme project.
const THEME_DIRS = new Set(['templates', 'layout', 'snippets', 'locales', 'sections']);
const isThemeProject = (d) => {
  const kids = childrenOf(d.rootId, d.relPath);
  const dirKids = new Set(kids.filter((k) => k.type === 'directory').map((k) => k.name.toLowerCase()));
  if (!dirKids.has('config')) return false;
  if (![...THEME_DIRS].some((t) => dirKids.has(t))) return false;
  const cfgKids = childrenOf(d.rootId, `${d.relPath}\\config`);
  return cfgKids.some((k) => k.name.toLowerCase() === 'settings_schema.json' || k.name.toLowerCase() === 'settings.html');
};
for (const d of dirs.filter((x) => x.rootId === 'work-root' && x.depth >= 1 && x.contentPolicy === 'ALLOWED')) {
  const kids = childrenOf(d.rootId, d.relPath);
  const names = new Set(kids.map((k) => k.name.toLowerCase()));
  const markers = [];
  if ([...DOTFILES].some((v) => names.has(v))) markers.push('vcs');
  const manifestHits = [...MANIFESTS].filter((m) => names.has(m));
  if (manifestHits.length) markers.push(`manifest:${manifestHits.join(',')}`);
  if (isThemeProject(d)) markers.push('theme-project');
  if (names.has(SKILL_MARKER)) markers.push('skill');
  if (!markers.length) continue;
  let anc = null;
  let cur = path.posix.dirname(d.relPath.replace(/\\/g, '/'));
  while (cur && cur !== '.') {
    const k = `${d.rootId}${cur}`;
    if (unitByPath.has(k)) { anc = unitByPath.get(k); break; }
    cur = path.posix.dirname(cur);
  }
  const kind = markers.includes('vcs') ? 'repo' : markers.includes('theme-project') ? 'theme' : manifestHits.length ? 'package' : 'skill';
  addUnit({ rootId: d.rootId, relPath: d.relPath, kind, markers, parentId: anc?.unitId ?? null });
}

// 3. loose files at work-root depth 1 -> loose unit
const loose = entries.filter((e) => e.rootId === 'work-root' && e.depth === 1 && e.type !== 'directory');
if (loose.length) {
  addUnit({ rootId: 'work-root', relPath: '<root-loose>', kind: 'loose-files', markers: ['root-level-files'], note: `${loose.length} loose root entries` });
}

// 2b. In-root skill roots: any <dir>/.agents/skills or <dir>/.claude/skills is an
// installer/mirror root; its children follow the same provenance rule as the
// supplemental roots (name under installer root => EXCLUDED_AK_SKILL).
const agentsNames = new Set(
  entries.filter((x) => x.rootId === 'skills-agents' && x.depth === 1 && x.type === 'directory').map((x) => x.name.toLowerCase()),
);
const inRootSkillRoots = dirs.filter((d) => d.rootId === 'work-root' && /[\\/](\.agents|\.claude)[\\/]skills$/i.test(d.relPath));
for (const sr of inRootSkillRoots) {
  for (const e of childrenOf(sr.rootId, sr.relPath).filter((k) => k.type === 'directory')) {
    const disposition = agentsNames.has(e.name.toLowerCase()) ? 'EXCLUDED_AK_SKILL' : 'ELIGIBLE';
    addUnit({
      rootId: 'work-root', relPath: e.relPath, kind: 'skill',
      markers: ['in-root-skill-root-child'],
      disposition,
      note: disposition === 'EXCLUDED_AK_SKILL' ? 'same-named package under installer root' : 'user-owned skill under in-root skill root',
    });
  }
}


// 4. skill roots: each depth-1 dir is a skill unit.
// Provenance rule (phase-01-start.md:57-58): AgentKit installer provenance, not
// name prefix, decides AK. C:\Users\Admin\.agents\skills is the installer root
// (runtime catalog evidence) so every child there is EXCLUDED_AK_SKILL.
// A .claude/skills child whose name exists under the installer root is the
// same package — mirror or modified copy; phase-01:58 keeps modified copies
// excluded. Verified live: sapo-theme-*/references under .claude are partial
// copies of same-named installer packages. Only names absent from the
// installer root are user-owned (ELIGIBLE).

for (const rootId of ['skills-claude', 'skills-agents']) {
  for (const e of entries.filter((x) => x.rootId === rootId && x.depth === 1 && x.type === 'directory')) {
    let disposition;
    let note = null;
    if (rootId === 'skills-agents') {
      disposition = 'EXCLUDED_AK_SKILL';
      note = 'AgentKit installer root: every child has installer provenance';
    } else if (agentsNames.has(e.name.toLowerCase())) {
      disposition = 'EXCLUDED_AK_SKILL';
      note = 'same-named package under installer root (mirror or modified copy)';
    } else {
      disposition = 'ELIGIBLE';
    }
    addUnit({
      rootId, relPath: e.relPath, kind: 'skill',
      markers: ['skill-root-child'],
      disposition,
      note,
    });
  }
  const skillLoose = entries.filter((e) => e.rootId === rootId && e.depth === 1 && e.type !== 'directory');
  if (skillLoose.length) addUnit({ rootId, relPath: '<root-loose>', kind: 'loose-files', markers: ['root-level-files'], note: `${skillLoose.length} loose entries` });
}
// ---------------------------------------------------------------- ownership
// Deepest unit root wins: walk the entry's ancestor chain, first unit hit owns.
const routed = new Map();
const unrouted = [];
const looseByRoot = new Map();
for (const u of units) if (u.relPath === '<root-loose>') looseByRoot.set(u.rootId, u);
for (const e of entries) {
  if (e.relPath === '.') continue;
  let owner = null;
  let cur = e.relPath;
  while (true) {
    const u = unitByPath.get(`${e.rootId}${cur}`);
    if (u) { owner = u; break; }
    const i = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
    if (i < 0) break;
    cur = cur.slice(0, i);
  }
  if (!owner) {
    const looseUnit = looseByRoot.get(e.rootId);
    if (looseUnit && e.depth === 1) owner = looseUnit;
  }
  if (!owner) { unrouted.push({ entryId: e.entryId, rootId: e.rootId, relPath: e.relPath, type: e.type }); continue; }
  routed.set(e.entryId, owner.unitId);
  owner.entryCount += 1;
  if (e.size) owner.bytes += e.size;
  const pol = e.contentPolicy;
  if (pol === 'GENERATED_BY_THIS_RUN') owner.generatedCount += 1;
  else if (pol === 'RESTRICTED_METADATA_ONLY') owner.restrictedCount += 1;
  else if (pol === 'EXCLUDED_CONTENT_DEPENDENCY' || pol === 'DERIVED_BUILD_OUTPUT' || pol === 'EXCLUDED_AK_SKILL' || pol === 'EXCLUDED_AK_SKILL_CANDIDATE') owner.excludedCount += 1;
  else owner.eligibleCount += 1;
}
const skills = [];
for (const u of units.filter((x) => x.kind === 'skill' || x.rootId.startsWith('skills-'))) {
  const kids = childrenOf(u.rootId, u.relPath);
  const hasSkillMd = kids.some((k) => k.name.toLowerCase() === SKILL_MARKER);
  skills.push({
    skillId: `sk-${uid(`${u.rootId}:${u.relPath}`)}`,
    name: u.relPath.split(/[\\/]/).pop(),
    namespace: u.relPath.split(/[\\/]/).pop(),
    rootId: u.rootId,
    location: u.relPath,
    unitId: u.unitId,
    hasSkillMd,
    originEvidence: u.disposition === 'EXCLUDED_AK_SKILL' ? 'agentkit-installer-root' : u.disposition === 'UNRESOLVED_SKILL_ORIGIN' ? 'name-prefix-only' : 'non-ak-name',
    akDisposition: u.disposition,
    analysisState: u.disposition === 'EXCLUDED_AK_SKILL' ? 'EXCLUDED' : 'PENDING',
  });
}

// ---------------------------------------------------------------- queue
const queueUnits = units.map((u, i) => ({
  unitId: u.unitId,
  order: i + 1,
  rootId: u.rootId,
  relPath: u.relPath,
  kind: u.kind,
  disposition: u.disposition,
  state: u.disposition === 'EXCLUDED_AK_SKILL' ? 'EXCLUDED' : 'PENDING',
  dependsOn: u.parentId ? [u.parentId] : [],
  childPlanPath: null,
  pendingArtifacts: u.eligibleCount,
  unresolved: u.disposition === 'UNRESOLVED_SKILL_ORIGIN' ? ['UNRESOLVED_SKILL_ORIGIN'] : [],
  counts: { entries: u.entryCount, eligible: u.eligibleCount, excluded: u.excludedCount, restricted: u.restrictedCount, generated: u.generatedCount, bytes: u.bytes },
}));

// ---------------------------------------------------------------- write
const register = {
  runId: summary.runId,
  generatedAt: new Date().toISOString(),
  source: 'reports/inventory.jsonl',
  inventoryEntries: entries.length,
  units: units.map((u) => ({ ...u, markers: u.markers })),
  unroutedCount: unrouted.length,
  unrouted: unrouted.slice(0, 5000),
  unroutedTruncated: unrouted.length > 5000,
  note: 'unit detection is structural-marker based; semantic identity resolved in child analysis',
};
fs.writeFileSync(path.join(REPORTS, 'project-register.json'), JSON.stringify(register, null, 2));
fs.writeFileSync(path.join(REPORTS, 'queue.json'), JSON.stringify({ runId: summary.runId, generatedAt: new Date().toISOString(), units: queueUnits }, null, 2));
fs.writeFileSync(path.join(REPORTS, 'skills-register.json'), JSON.stringify({ runId: summary.runId, generatedAt: new Date().toISOString(), skills }, null, 2));

console.log(JSON.stringify({
  units: units.length,
  skills: skills.length,
  skillsExcluded: skills.filter((s) => s.akDisposition === 'EXCLUDED_AK_SKILL').length,
  skillsUnresolved: skills.filter((s) => s.akDisposition === 'UNRESOLVED_SKILL_ORIGIN').length,
  skillsEligible: skills.filter((s) => s.akDisposition === 'ELIGIBLE').length,
  unrouted: unrouted.length,
  eligibleEntries: units.reduce((a, u) => a + u.eligibleCount, 0),
}, null, 2));
