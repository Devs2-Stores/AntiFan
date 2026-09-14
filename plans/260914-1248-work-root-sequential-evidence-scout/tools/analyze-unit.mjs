#!/usr/bin/env node
// Phase 4 unit analyzer: for one unit, read every eligible text file
// (bounded), hash revision, extract anchored mechanical observations, and
// write reports/units/<unitId>/{content-ledger.jsonl,claims.jsonl,dossier.md}.
// Mechanical extraction only — no semantic inference beyond file content.
// Usage: node analyze-unit.mjs <unitId> [--max-bytes N]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const REGISTER = JSON.parse(fs.readFileSync(path.join(REPORTS, 'project-register.json'), 'utf8'));
const QUEUE = JSON.parse(fs.readFileSync(path.join(REPORTS, 'queue.json'), 'utf8'));

const unitId = process.argv[2];
const maxBytesIdx = process.argv.indexOf('--max-bytes');
const MAX_BYTES = maxBytesIdx > 0 ? Number(process.argv[maxBytesIdx + 1]) : 512 * 1024;
if (!unitId) { console.error('usage: analyze-unit.mjs <unitId>'); process.exit(1); }
const unit = REGISTER.units.find((u) => u.unitId === unitId);
const qu = QUEUE.units.find((u) => u.unitId === unitId);
if (!unit || !qu) { console.error(`unknown unit ${unitId}`); process.exit(1); }

const unitDir = path.join(PLAN_DIR, qu.fileInventory ? path.dirname(qu.fileInventory) : '');
const filesPath = path.join(unitDir, 'files.jsonl');
const outDir = path.join(REPORTS, 'units', unitId);
fs.mkdirSync(outDir, { recursive: true });

const files = fs.existsSync(filesPath)
  ? fs.readFileSync(filesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];

const TEXT_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.jsonc', '.json5', '.md', '.txt', '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.liquid', '.bwt', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.ini', '.cfg', '.conf', '.log', '.csv', '.tsv', '.snap', '.ejs', '.hbs', '.pug', '.njk', '.twig', '.mustache', '.handlebars', '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc', '.nvmrc', '.dockerignore', '.plist', '.swift', '.kt', '.dart', '.lua', '.svg', '.map', '.po', '.pot', '.xliff', '.xlf', '.arb', '.j2', '.jinja', '.jinja2', '.tf', '.tfvars', '.hcl', '.properties', '.manifest', '.strings', '.srt', '.vtt', '.nfo', '.service', '.desktop', '.url', '.sample', '.artifact', '.lock', '.d.ts']);
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt']);
const extOf = (n) => { const m = n.toLowerCase().match(/\.[^.\\/]+$/); return m ? m[0] : ''; };

const ledger = [];
const claims = [];
const claim = (statement, kind, evidenceRefs, extra = {}) => claims.push({
  claimId: `c-${crypto.createHash('sha1').update(`${unitId}${statement}${evidenceRefs[0]?.entryId ?? ''}`).digest('hex').slice(0, 12)}`,
  unitId, statement, kind, evidenceRefs,
  counterEvidence: [], context: { platform: null, version: null },
  extractorVersion: 'analyze-unit/1.0', status: 'OBSERVED', ...extra,
});
const ev = (f, anchor) => ({ entryId: f.entryId, revision: f.sha256 ?? null, path: f.relPath, anchor });

let readErrors = 0;
let analyzed = 0;
let noClaim = 0;
let pending = 0;
let blocked = 0;
const dirSet = new Set();
const topDirs = new Map();
const manifests = [];
const readmes = [];
const testFiles = [];
const configs = [];

for (const f of files) {
  const rel = f.relPath;
  const parts = rel.split(/[\\/]/);
  for (let i = 1; i < parts.length; i += 1) dirSet.add(parts.slice(0, i).join('\\'));
  if (parts.length >= 2) topDirs.set(parts[1], (topDirs.get(parts[1]) ?? 0) + 1);
  const ext = extOf(f.path);
  const base = { entryId: f.entryId, relPath: rel, path: f.path, size: f.size, mtime: f.mtime, observedAt: new Date().toISOString() };

  if (!TEXT_EXT.has(ext)) {
    const kind = MEDIA_EXT.has(ext) ? 'media' : 'binary';
    ledger.push({ ...base, disposition: 'ANALYZED_NO_CLAIM', coverage: 'metadata-only', reason: `${kind} file: metadata recorded, content interpretation limited`, bytesRead: 0, linesRead: 0 });
    noClaim += 1;
    continue;
  }

  let raw;
  try {
    const fd = fs.openSync(f.path, 'r');
    const len = Math.min(f.size ?? MAX_BYTES, MAX_BYTES);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    raw = buf.subarray(0, n).toString('utf8');
  } catch (e) {
    ledger.push({ ...base, disposition: 'BLOCKED', coverage: 'none', reason: `read error ${e.code ?? e.message}`, bytesRead: 0, linesRead: 0 });
    blocked += 1;
    continue;
  }
  const sha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  f.sha256 = sha;
  const lines = raw.split(/\r?\n/);
  const truncated = (f.size ?? 0) > MAX_BYTES;
  ledger.push({
    ...base, disposition: 'ANALYZED_WITH_CLAIMS', coverage: truncated ? `bytes 0..${MAX_BYTES} of ${f.size}` : 'full',
    sha256: sha, bytesRead: raw.length, linesRead: lines.length,
    pendingRanges: truncated ? [{ from: MAX_BYTES, to: f.size }] : [],
  });
  analyzed += 1;

  const lname = path.basename(f.path).toLowerCase();
  if (lname === 'package.json') {
    try {
      const pkg = JSON.parse(raw);
      manifests.push({ relPath: rel, name: pkg.name, version: pkg.version, description: pkg.description ?? null, scripts: Object.keys(pkg.scripts ?? {}), deps: Object.keys(pkg.dependencies ?? {}).length, devDeps: Object.keys(pkg.devDependencies ?? {}).length, main: pkg.main ?? null, bin: pkg.bin ?? null, type: pkg.type ?? null });
      claim(`package.json declares name=${pkg.name ?? '(none)'} version=${pkg.version ?? '(none)'}`, 'MANIFEST', [ev(f, 'root fields')]);
      if (pkg.description) claim(`package description: ${pkg.description}`, 'PURPOSE', [ev(f, 'description')]);
      if (pkg.scripts && Object.keys(pkg.scripts).length) claim(`scripts: ${Object.keys(pkg.scripts).join(', ')}`, 'TOOLING', [ev(f, 'scripts')]);
      const depNames = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      if (depNames.length) claim(`dependencies: ${depNames.slice(0, 40).join(', ')}${depNames.length > 40 ? ` (+${depNames.length - 40} more)` : ''}`, 'DEPENDENCY', [ev(f, 'dependencies')]);
    } catch { claim('package.json present but unparseable', 'MANIFEST', [ev(f, 'parse error')], { status: 'UNRESOLVED' }); }
  } else if (/^readme(\.\w+)?$/i.test(lname)) {
    const heading = lines.find((l) => l.trim().startsWith('#'));
    const firstPara = lines.find((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('![') && !l.trim().startsWith('[!'));
    readmes.push({ relPath: rel, heading: heading?.replace(/^#+\s*/, '').trim() ?? null, firstLine: firstPara?.trim().slice(0, 300) ?? null });
    if (heading) claim(`README heading: ${heading.replace(/^#+\s*/, '').trim()}`, 'PURPOSE', [ev(f, `line ${lines.indexOf(heading) + 1}`)]);
    if (firstPara) claim(`README intro: ${firstPara.trim().slice(0, 300)}`, 'PURPOSE', [ev(f, `line ${lines.indexOf(firstPara) + 1}`)]);
  } else if (/^(settings_schema|settings_data|theme|layout|templates?|sections?|snippets?|locales?)/i.test(rel) || ext === '.liquid' || ext === '.bwt') {
    if (ext === '.liquid' || ext === '.bwt') {
      const schemaMatch = raw.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
      const sectionName = schemaMatch ? (() => { try { return JSON.parse(schemaMatch[1]).name; } catch { return null; } })() : null;
      if (sectionName) claim(`Liquid section declares name="${sectionName}"`, 'THEME', [ev(f, 'schema block')]);
      const formTags = (raw.match(/\{%-?\s*form\s/g) ?? []).length;
      if (formTags) claim(`contains ${formTags} Liquid form tag(s)`, 'THEME', [ev(f, 'form tags')]);
    }
    if (lname === 'settings_schema.json' || lname === 'settings.html') configs.push({ relPath: rel, kind: 'theme-settings' });
  } else if (/skill\.md$/i.test(lname)) {
    const heading = lines.find((l) => l.trim().startsWith('#'));
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let fmName = null; let fmDesc = null;
    if (fm) { fmName = (fm[1].match(/^name:\s*(.+)$/m) ?? [])[1]?.trim(); fmDesc = (fm[1].match(/^description:\s*(.+)$/m) ?? [])[1]?.trim(); }
    if (fmName) claim(`SKILL.md frontmatter name=${fmName}`, 'SKILL', [ev(f, 'frontmatter')]);
    if (fmDesc) claim(`SKILL.md description: ${fmDesc.slice(0, 300)}`, 'SKILL', [ev(f, 'frontmatter')]);
    if (heading) claim(`SKILL.md heading: ${heading.replace(/^#+\s*/, '').trim()}`, 'SKILL', [ev(f, `line ${lines.indexOf(heading) + 1}`)]);
  }
  if (/\.(test|spec)\.[jt]sx?$|test_|_test\.|\.test\.mjs$|\.test\.cjs$/i.test(lname) || /(^|[\\/])(tests?|__tests__|spec)[\\/]/i.test(rel)) testFiles.push(rel);
  if (/^(tsconfig|jsconfig|webpack\.config|vite\.config|rollup\.config|esbuild\.config|\.babelrc|babel\.config|eslint|\.eslintrc|prettier|\.prettierrc|tailwind\.config|next\.config|nuxt\.config|angular\.json|nest-cli|dockerfile|docker-compose|\.github[\\/]workflows)/i.test(lname) || /^\.github[\\/]workflows[\\/]/i.test(rel)) configs.push({ relPath: rel, kind: 'build/ci' });
}

// dossier
const dirTree = [...topDirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([d, n]) => `  ${d}/ (${n} files)`).join('\n');
const dossier = `# Dossier: ${unit.relPath}

Unit ${unit.unitId} | kind=${unit.kind} | root=${unit.rootId} | markers=${unit.markers.join(', ')}
Generated by analyze-unit/1.0 (mechanical extraction). Semantic depth limited; see Unknowns.

## Coverage
- Eligible files: ${files.length} | analyzed-with-claims: ${analyzed} | metadata-only (binary/media): ${noClaim} | blocked: ${blocked} | pending: ${pending}
- Read errors: ${readErrors}

## Purpose
${manifests[0]?.description ? `From package.json: ${manifests[0].description}` : readmes[0]?.firstLine ? `From README: ${readmes[0].firstLine}` : 'NOT_RECORDED — no manifest description or README intro observed.'}
${readmes[0]?.heading ? `README heading: ${readmes[0].heading}` : ''}

## Architecture (observed structure)
${dirTree || '  (flat)'}
${manifests.length ? `Manifests: ${manifests.map((m) => m.relPath).join(', ')}` : 'No package manifest observed.'}

## Platform / toolchain
${manifests[0] ? `package.json: type=${manifests[0].type ?? 'commonjs(default)'}, main=${manifests[0].main ?? 'none'}, deps=${manifests[0].deps}, devDeps=${manifests[0].devDeps}` : 'No manifest; platform undetermined from metadata.'}
${configs.length ? `Config/build files: ${configs.slice(0, 20).map((c) => c.relPath).join(', ')}${configs.length > 20 ? ` (+${configs.length - 20})` : ''}` : ''}

## Verification evidence
${testFiles.length ? `${testFiles.length} test/spec files observed (e.g. ${testFiles.slice(0, 5).join(', ')}). Test source presence is not a runtime PASS.` : 'No test files observed — verification NOT_OBSERVED.'}
${manifests[0]?.scripts?.length ? `Scripts: ${manifests[0].scripts.join(', ')}` : ''}

## Requirements / dependencies
${manifests[0] ? 'See claims.jsonl DEPENDENCY entries.' : 'NOT_RECORDED.'}

## Decisions
Explicit rationale NOT_RECORDED unless present in docs above; inferred structure recorded as observations only.

## Unknowns / limitations
- Binary and media files recorded as metadata only; no content interpretation.
- Files >${MAX_BYTES} bytes have pending ranges in content-ledger.jsonl.
- Semantic analysis limited to mechanical extraction; deep review requires reading key files.
- Git history not analyzed in this pass (history frontier recorded separately).
`;
fs.writeFileSync(path.join(outDir, 'dossier.md'), dossier);
fs.writeFileSync(path.join(outDir, 'content-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'claims.jsonl'), claims.map((c) => JSON.stringify(c)).join('\n') + (claims.length ? '\n' : ''));

console.log(JSON.stringify({ unitId, relPath: unit.relPath, files: files.length, analyzed, noClaim, blocked, claims: claims.length, testFiles: testFiles.length, manifests: manifests.length }));
