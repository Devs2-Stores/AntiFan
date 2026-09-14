#!/usr/bin/env node
// Fixture smoke test for inventory-scan.mjs (phase-01-start.md step 6 gate).
// Builds an isolated fixture tree under reports/fixtures/, exercises the
// scanner's interruption/resume, error, reparse-point, long-path, policy and
// archive paths, and writes reports/fixture-smoke-report.json.
// Run-owned only: never touches corpus.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const SCANNER = path.join(SCRIPT_DIR, 'inventory-scan.mjs');
const FIX = path.join(PLAN_DIR, 'reports', 'fixtures');
const TREE = path.join(FIX, 'tree');
const OUT = path.join(FIX, 'out');
const REPORT = path.join(PLAN_DIR, 'reports', 'fixture-smoke-report.json');

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail ?? null });

fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(TREE, { recursive: true });

// ---- build fixture tree ---------------------------------------------------
const w = (rel, content = 'x') => {
  const p = path.join(TREE, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

w('normal/dir1/file-a.txt', 'alpha');
w('normal/dir1/file-b.js', 'const b=1;');
w('normal/dir1/sub/deep-file.md', '# deep');
w('.hidden/hidden-file.txt', 'hidden');
w('unicode/tiếng-việt-文件-🙂.txt', 'unicode');
w('restricted/.env', 'SECRET=should-not-be-read');
w('dep/node_modules/pkg/index.js', 'module.exports=1;');
w('dep/node_modules/pkg/package.json', '{"name":"pkg"}');
w('gen-output/generated-inner.txt', 'generated');

// long path > 260 chars
{
  let seg = 'longpath';
  const part = 'a'.repeat(40);
  while (path.join(TREE, seg).length < 300) seg = path.join(seg, part);
  w(path.join(seg, 'deep.txt'), 'long');
}

// minimal stored (no compression) ZIP writer
function makeZip(file, members) {
  const local = [];
  const central = [];
  let off = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, 'utf8');
    const data = Buffer.from(m.data ?? '', 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 10); lh.writeUInt32LE(0, 14); // crc 0 ok for listing
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(0, 12); ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, name]));
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...local, cd, eocd]));
}
makeZip(path.join(TREE, 'archive', 'sample.zip'), [
  { name: 'inside/one.txt', data: 'one' },
  { name: 'inside/two.txt', data: 'two' },
  { name: 'dir/' },
]);

// reparse points: junction cycle, external junction, dangling junction
const junc = (name, target) => {
  try { fs.symlinkSync(target, path.join(TREE, name), 'junction'); return true; }
  catch (e) { return e; }
};
const juncResults = {
  cycle: junc('cycle', TREE),
  external: junc('external', 'C:\\Windows'),
  dangling: junc('dangling', path.join(FIX, 'no-such-target')),
};

// ---- fixture config -------------------------------------------------------
const fixtureConfig = {
  policyVersion: '1.0.0-fixture',
  runId: 'fixture-smoke',
  outputDir: OUT,
  scanSemantics: {
    enumeration: 'fixture', hidden: true, gitignoreRespected: false,
    followLinks: false, maxDepth: 128, maxArchiveMembers: 50000,
    maxArchiveBytes: 268435456, identity: 'exact', sizeSemantics: 'logical',
    contentHash: null,
  },
  roots: [
    { rootId: 'fixture-tree', path: TREE, kind: 'corpus', readOnly: true, supplemental: false, provenance: 'fixture' },
    { rootId: 'missing-root', path: path.join(FIX, 'does-not-exist'), kind: 'corpus', readOnly: true, supplemental: true, provenance: 'fixture' },
  ],
  policies: [
    { id: 'GENERATED_BY_THIS_RUN', precedence: 100, pathPrefixes: ['gen-output'], exactPaths: [] },
    { id: 'RESTRICTED_METADATA_ONLY', precedence: 80, basenamePatterns: ['.env', '.env.*'] },
    { id: 'EXCLUDED_CONTENT_DEPENDENCY', precedence: 60, segmentPatterns: ['node_modules'] },
  ],
  archiveExtensions: ['.zip'],
  boundaryRoots: ['C:\\Windows'],
};
const cfgPath = path.join(FIX, 'fixture-config.json');
fs.writeFileSync(cfgPath, JSON.stringify(fixtureConfig, null, 2));

// ---- run scanner ----------------------------------------------------------
const run = (extra) => {
  const out = execFileSync(process.execPath, [SCANNER, '--config', cfgPath, '--out', OUT, '--quiet', ...extra], { encoding: 'utf8' });
  return JSON.parse(out);
};

const readJsonl = (f) => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

// 1. interrupted run: --max-dirs 3
const r1 = run(['--mode', 'run', '--max-dirs', '3']);
check('interrupt: maxDirsReached flag', r1.maxDirsReached === true, `attempted dirs bounded; frontier state=${r1.frontier?.state}`);
check('interrupt: residual frontier non-empty', r1.frontier?.state === 'NON_EMPTY', `pending=${r1.frontier?.pendingCount}`);

// 2. resume to completion
const r2 = run(['--mode', 'run']);
check('resume: completes with empty frontier', r2.frontier?.state === 'EMPTY', `pending=${r2.frontier?.pendingCount}`);
check('resume: skipped already-completed dirs', r2.counters.resumedSkippedDirs > 0, `resumedSkippedDirs=${r2.counters.resumedSkippedDirs}`);

// 3. aggregate + idempotent entries
const agg = run(['--mode', 'aggregate']);
const inv = readJsonl(path.join(OUT, 'inventory.jsonl'));
const ids = new Set(inv.map((e) => e.entryId));
check('idempotency: no duplicate entryId after resume', ids.size === inv.length, `${inv.length} entries, ${ids.size} unique`);

const byPath = new Map(inv.map((e) => [e.relPath, e]));
const find = (suffix) => inv.filter((e) => e.relPath.endsWith(suffix) || e.relPath === suffix);

// 4. reparse points
const cycle = find('cycle')[0];
check('reparse: cycle junction recorded not traversed', cycle?.type === 'reparse-point' && !inv.some((e) => e.relPath.includes('cycle\\') || e.relPath.includes('cycle/')),
  cycle ? `linkCanonicalRel=${cycle.linkCanonicalRel} boundary=${cycle.linkBoundary}` : 'cycle entry missing');
const ext = find('external')[0];
check('reparse: external junction boundary', ext?.type === 'reparse-point' && (ext.linkBoundary === 'TARGET_OUTSIDE_ROOT' || ext.linkBoundary === 'CANONICAL_TARGET_OUTSIDE_ROOT'), ext ? `boundary=${ext.linkBoundary}` : 'external entry missing');
const dang = find('dangling')[0];
check('reparse: dangling junction boundary', dang?.type === 'reparse-point' && dang.linkBoundary !== null, dang ? `boundary=${dang.linkBoundary}` : 'dangling entry missing');

// 5. missing root error
const errs = readJsonl(path.join(OUT, 'errors.jsonl'));
check('error: missing root produces error event', errs.some((e) => e.rootId === 'missing-root' && e.phase === 'root'), `${errs.length} error events`);

// 6. long path + unicode + hidden
check('longpath: >240-char path inventoried', inv.some((e) => e.path.length > 240 && e.type === 'file'), `max path len=${Math.max(...inv.map((e) => e.path.length))}`);
check('unicode: unicode filename inventoried', find('tiếng-việt-文件-🙂.txt').length === 1);
check('hidden: hidden dir/file inventoried', find('hidden-file.txt').length === 1);

// 7. policies
check('policy: .env restricted metadata only', find('.env')[0]?.contentPolicy === 'RESTRICTED_METADATA_ONLY', find('.env')[0]?.contentPolicy);
check('policy: node_modules content excluded but inventoried', find('index.js')[0]?.contentPolicy === 'EXCLUDED_CONTENT_DEPENDENCY', find('index.js')[0]?.contentPolicy);
const genInner = inv.filter((e) => e.relPath.startsWith('gen-output'));
check('policy: generated dir recorded but not traversed', genInner.length === 1 && genInner[0].relPath === 'gen-output', `${genInner.length} entries under gen-output`);

// 8. archive members
const ar = run(['--mode', 'archive']);
check('archive: zip members enumerated separately', ar.members === 3, `members=${ar.members} containers=${ar.containers}`);

// 9. receipts
const receipts = readJsonl(path.join(OUT, 'scan-state', 'dirs.jsonl'));
check('receipts: every scanned dir has a receipt', receipts.length > 0 && agg.directoriesWithoutCompleteReceipt <= 1, `receipts=${receipts.length} incomplete=${agg.directoriesWithoutCompleteReceipt} (missing-root ERROR expected)`);

const passed = checks.filter((c) => c.pass).length;
const report = {
  runId: 'fixture-smoke',
  generatedAt: new Date().toISOString(),
  fixtureRoot: TREE,
  junctionSetup: Object.fromEntries(Object.entries(juncResults).map(([k, v]) => [k, v === true ? 'created' : `failed: ${v.message}`])),
  checks,
  result: passed === checks.length ? 'PASS' : 'FAIL',
  passed, total: checks.length,
  note: 'fixture-only evidence; proves scanner mechanics, not corpus coverage',
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ result: report.result, passed, total: checks.length, junctionSetup: report.junctionSetup }, null, 2)}\n`);
for (const c of checks.filter((c) => !c.pass)) process.stdout.write(`FAIL ${c.name}: ${c.detail}\n`);
process.exit(report.result === 'PASS' ? 0 : 1);
