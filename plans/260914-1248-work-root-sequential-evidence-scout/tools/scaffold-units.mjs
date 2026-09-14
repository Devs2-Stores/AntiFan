#!/usr/bin/env node
// Phase 3 expansion: scaffold one child plan per PENDING unit under
// work-units/, write per-unit file inventory (files.jsonl), phase files sized
// by text-eligible coverage, and update queue.json childPlanPath.
// Deterministic; no semantic claims. Run-owned output only.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const WU = path.join(PLAN_DIR, 'work-units');
const INV = path.join(REPORTS, 'inventory.jsonl');
const QUEUE = path.join(REPORTS, 'queue.json');
const REGISTER = path.join(REPORTS, 'project-register.json');

const TEXT_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.jsonc', '.json5', '.md', '.txt', '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.liquid', '.bwt', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.ini', '.cfg', '.conf', '.log', '.csv', '.tsv', '.snap', '.ejs', '.hbs', '.pug', '.njk', '.twig', '.mustache', '.handlebars', '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc', '.nvmrc', '.dockerignore', '.plist', '.swift', '.kt', '.dart', '.lua', '.svg', '.map', '.po', '.pot', '.xliff', '.xlf', '.arb', '.j2', '.jinja', '.jinja2', '.tf', '.tfvars', '.hcl', '.properties', '.manifest', '.strings', '.srt', '.vtt', '.nfo', '.service', '.desktop', '.url', '.sample', '.artifact', '.lock', '.d.ts']);
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt']);
const BATCH = 150; // text files per content phase
const MAX_PHASES = 25;

function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  const out = [];
  const fd = fs.openSync(f, 'r');
  const CHUNK = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let carry = '';
  const push = (line) => {
    if (!line) return;
    try { out.push(JSON.parse(line)); } catch { }
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

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const unitById = new Map(register.units.map((u) => [u.unitId, u]));
const pending = queue.units.filter((u) => u.state === 'PENDING');

// index inventory entries by unit via ancestor walk
const unitRoots = register.units.filter((u) => !u.relPath.startsWith('<')).map((u) => ({ u, prefix: `${u.rootId}${u.relPath}\\` }));
unitRoots.sort((a, b) => b.prefix.length - a.prefix.length);
const unitByPath = new Map(register.units.map((u) => [`${u.rootId}${u.relPath}`, u]));
const looseByRoot = new Map(register.units.filter((u) => u.relPath === '<root-loose>').map((u) => [u.rootId, u]));

const ownerOf = (e) => {
  let cur = e.relPath;
  while (true) {
    const u = unitByPath.get(`${e.rootId}${cur}`);
    if (u) return u;
    const i = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
    if (i < 0) break;
    cur = cur.slice(0, i);
  }
  const looseUnit = looseByRoot.get(e.rootId);
  if (looseUnit && e.depth === 1) return looseUnit;
  return null;
};

// stream inventory once, bucket eligible entries per unit
const perUnit = new Map(); // unitId -> {files:[], textFiles:0, mediaFiles:0, binaryFiles:0, dirs:0, bytes:0}
const bump = (u, e) => {
  if (!perUnit.has(u.unitId)) perUnit.set(u.unitId, { files: [], textFiles: 0, mediaFiles: 0, binaryFiles: 0, dirs: 0, bytes: 0 });
  const b = perUnit.get(u.unitId);
  if (e.type === 'directory') { b.dirs += 1; return; }
  if (e.type !== 'file') return;
  b.files.push({ entryId: e.entryId, relPath: e.relPath, path: e.path, size: e.size, mtime: e.mtime });
  if (e.size) b.bytes += e.size;
  const m = e.name.toLowerCase().match(/\.[^.\\/]+$/);
  const ext = m ? m[0] : '';
  if (TEXT_EXT.has(ext)) b.textFiles += 1;
  else if (MEDIA_EXT.has(ext)) b.mediaFiles += 1;
  else b.binaryFiles += 1;
};

{
  const fd = fs.openSync(INV, 'r');
  const CHUNK = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let carry = '';
  let n;
  const handle = (line) => {
    if (!line) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.relPath === '.' || e.contentPolicy !== 'ALLOWED') return;
    const u = ownerOf(e);
    if (!u) return;
    bump(u, e);
  };
  while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
    carry += buf.toString('utf8', 0, n);
    let i;
    while ((i = carry.indexOf('\n')) >= 0) { handle(carry.slice(0, i).replace(/\r$/, '')); carry = carry.slice(i + 1); }
  }
  if (carry) handle(carry.replace(/\r$/, ''));
  fs.closeSync(fd);
}

fs.mkdirSync(WU, { recursive: true });
const slugify = (s) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'unit';

const results = [];
for (const qu of pending) {
  const u = unitById.get(qu.unitId);
  if (!u) { results.push({ unitId: qu.unitId, error: 'unit missing from register' }); continue; }
  const bucket = perUnit.get(u.unitId) ?? { files: [], textFiles: 0, mediaFiles: 0, binaryFiles: 0, dirs: 0, bytes: 0 };
  const slug = `${u.unitId}-${slugify(u.relPath)}`;
  const unitDir = path.join(WU, slug);
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'files.jsonl'), bucket.files.map((f) => JSON.stringify(f)).join('\n') + (bucket.files.length ? '\n' : ''));

  // scaffold plan via ak CLI
  let planDir = null;
  try {
    const out = execFileSync('ak', ['plan', 'create', slug, '--basedir', WU, '--json', '--no-interactive'], { encoding: 'utf8', cwd: PLAN_DIR });
    planDir = JSON.parse(out).data.dir;
  } catch (e) {
    results.push({ unitId: u.unitId, error: `ak plan create failed: ${e.message.slice(0, 200)}` });
    continue;
  }

  // phase sizing by text-file coverage
  const nContent = Math.max(1, Math.min(MAX_PHASES, Math.ceil(bucket.textFiles / BATCH)));
  const phases = [];
  phases.push({
    n: 1, slug: 'intake', title: 'Intake and inventory verification',
    body: `Verify unit root exists, re-stat eligible files, confirm inventory counts (files=${bucket.files.length}, text=${bucket.textFiles}, media=${bucket.mediaFiles}, binary=${bucket.binaryFiles}, dirs=${bucket.dirs}, bytes=${bucket.bytes}). Record revision baseline (size+mtime) for every file before content reads.`,
  });
  for (let i = 0; i < nContent; i += 1) {
    const lo = Math.floor((i * bucket.textFiles) / nContent);
    const hi = Math.floor(((i + 1) * bucket.textFiles) / nContent);
    phases.push({
      n: i + 2, slug: `content-${String(i + 1).padStart(2, '0')}`, title: `Content batch ${i + 1}/${nContent}`,
      body: `Read text-eligible files [${lo}..${hi}) of ${bucket.textFiles} from files.jsonl (sorted order). Record covered ranges in content-ledger.jsonl; extract anchored observations to claims.jsonl. Binary/media files get metadata disposition, not content claims.`,
    });
  }
  phases.push({
    n: nContent + 2, slug: 'dossier', title: 'Dossier and unit gate',
    body: `Write dossier.md: purpose, architecture, platform contract, requirements, decisions (explicit/inferred), implementation, verification evidence, quality, unknowns. Every claim anchored to entryId+revision+line/region. Gate: all eligible files have disposition ANALYZED_WITH_CLAIMS | ANALYZED_NO_CLAIM | PENDING | BLOCKED with reason.`,
  });

  // write plan.md
  const planMd = `---
title: "Unit ${u.relPath}"
description: "Child analysis unit ${u.unitId} (${u.kind}) under work-root-sequential-evidence-scout"
status: pending
priority: P1
effort: ""
tags: []
created: 2026-09-14
---

# Unit ${u.relPath}

Parent plan: [work-root-sequential-evidence-scout](../../plan.md). Unit ${u.unitId}, kind=${u.kind}, root=${u.rootId}, disposition=${u.disposition}.
Markers: ${u.markers.join(', ')}. Parent unit: ${u.parentId ?? 'none'}.

## Scope
Eligible files: ${bucket.files.length} (text=${bucket.textFiles}, media=${bucket.mediaFiles}, binary=${bucket.binaryFiles}); dirs=${bucket.dirs}; bytes=${bucket.bytes}.
File inventory: [files.jsonl](./files.jsonl). Content ledger: reports/units/${u.unitId}/content-ledger.jsonl. Claims: reports/units/${u.unitId}/claims.jsonl. Dossier: reports/units/${u.unitId}/dossier.md.

## Phases

| # | Phase | Status |
|---|-------|--------|
${phases.map((p) => `| ${p.n} | [${p.title}](./phase-${String(p.n).padStart(2, '0')}-${p.slug}.md) | Pending |`).join('\n')}

## Success Criteria
- [ ] Every eligible file has exactly one latest disposition with evidence.
- [ ] Dossier written; all claims anchored; unknowns explicit.
`;
  fs.writeFileSync(path.join(planDir, 'plan.md'), planMd);
  // remove CLI starter phase, write real phases
  const starter = path.join(planDir, 'phase-01-start.md');
  if (fs.existsSync(starter)) fs.rmSync(starter);
  for (const p of phases) {
    const fm = `---\nphase: ${p.n}\ntitle: "${p.title}"\nstatus: pending\npriority: P1\neffort: ""\ndependencies: [${p.n === 1 ? '' : p.n - 1}]\n---\n\n# Phase ${p.n}: ${p.title}\n\n${p.body}\n\n## Success Criteria\n- [ ] Phase output recorded under reports/units/${u.unitId}/ with evidence anchors.\n`;
    fs.writeFileSync(path.join(planDir, `phase-${String(p.n).padStart(2, '0')}-${p.slug}.md`), fm);
  }
  qu.childPlanPath = path.relative(PLAN_DIR, planDir);
  qu.fileInventory = path.relative(PLAN_DIR, path.join(unitDir, 'files.jsonl'));
  results.push({ unitId: u.unitId, planDir: qu.childPlanPath, phases: phases.length, files: bucket.files.length, textFiles: bucket.textFiles });
}

fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
console.log(JSON.stringify({
  scaffolded: results.filter((r) => !r.error).length,
  errors: results.filter((r) => r.error),
  totalPhases: results.reduce((a, r) => a + (r.phases ?? 0), 0),
}, null, 2));
