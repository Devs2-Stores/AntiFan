#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Emit Integrity Guard
 *
 * `incremental: true` makes `tsc` trust its build info: if the build info says the
 * program is up to date, tsc skips emit entirely. That is correct only while the
 * output tree still matches the build info. If emit is lost behind tsc's back — a
 * partial `.compiled` deletion, a `git clean` of build output, an interrupted
 * build, a crashed watcher — tsc will happily report success and emit nothing.
 *
 * The failure is silent and severe: `main.cjs` guards with `existsSync` and
 * `scripts/run-electron.cjs` only compiles when the bundle is missing, so a missing
 * entry module means the app launches against an incomplete program or not at all.
 *
 * This runs BEFORE `tsc` in the compile chain. It verifies that every source file
 * the TypeScript program would emit has a corresponding emit file. When any is
 * missing the build info is discarded, which forces tsc into a full rebuild instead
 * of a trusted no-op.
 *
 * Derivation is structural, not heuristic: `rootDir: "."`, `outDir: ".compiled"`,
 * so `src/main/index.ts` emits `.compiled/src/main/index.js`. Declaration files
 * emit nothing.
 *
 * Always exits 0 — the guard repairs the cause, it does not fail the build.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, '.compiled');
const SOURCE_DIRS = ['src', 'scripts', 'test'];
const BUILD_INFO = path.join(OUT_ROOT, '.tsbuildinfo');

/** All files currently present under `.compiled`, as `.compiled`-relative posix paths. */
function collectEmit(index, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectEmit(index, full);
      continue;
    }
    index.add(path.relative(OUT_ROOT, full).replace(/\\/g, '/'));
  }
}

/** Source files that must produce emit, as `.compiled`-relative posix `.js` paths. */
function collectExpected(expected, dir, relDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectExpected(expected, full, `${relDir}/${entry.name}`);
      continue;
    }
    if (entry.name.endsWith('.d.ts')) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    const stem = entry.name.replace(/\.tsx?$/, '');
    expected.push(`${relDir}/${stem}.js`);
  }
}

const emitIndex = new Set();
collectEmit(emitIndex, OUT_ROOT);

const expected = [];
for (const dir of SOURCE_DIRS) collectExpected(expected, path.join(ROOT, dir), dir);

const missing = expected.filter((rel) => !emitIndex.has(rel));

if (missing.length === 0) {
  console.log(`[emit-integrity] all ${expected.length} expected emit file(s) present.`);
  process.exit(0);
}

if (fs.existsSync(BUILD_INFO)) {
  fs.rmSync(BUILD_INFO, { force: true });
  console.log(`[emit-integrity] ${missing.length} of ${expected.length} emit file(s) missing — discarded build info to force a full rebuild.`);
  for (const rel of missing.slice(0, 20)) console.log(`[emit-integrity]   - .compiled/${rel}`);
  if (missing.length > 20) console.log(`[emit-integrity]   … and ${missing.length - 20} more`);
} else {
  console.log(`[emit-integrity] ${missing.length} emit file(s) missing and no build info present — cold rebuild expected.`);
}
process.exit(0);
