#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Orphan Emit Pruner
 *
 * `tsc` never removes output for source files that no longer exist. With a shared
 * `.compiled` tree that every launcher requires by path, an orphan `.js` is
 * indistinguishable from a live module: `main.cjs` and `scripts/run-electron.cjs`
 * both guard with `existsSync` only, never mtime. So a deleted source leaves a
 * module that keeps loading forever.
 *
 * This prunes emit whose source is gone. It is safe by construction, not by
 * heuristics:
 *
 *   - Only `.compiled/{src,test,scripts}` is walked. Root-level emit such as
 *     `.compiled/.tsbuildinfo` is untouched.
 *   - `.compiled/src/renderer/**` is SKIPPED. `scripts/copy-static.mjs` owns that
 *     directory: it copies `exports-shim.js` / `standalone.js` there from
 *     `src/renderer/`, generates `terminal-write-dispatcher.js` from the compiled
 *     shared module, and prepends a `var exports = exports || {};` shim to
 *     `toolbar.js` / `frame-backdrop.js` in place. Those are not tsc emit and must
 *     never be judged by source-sibling rules.
 *   - `.js` / `.js.map` / `.d.ts` / `.d.ts.map` are kept when any of
 *     `<name>.ts|.tsx|.js|.mjs|.cjs` exists in the mirrored source directory.
 *     That is how the copies made by `copy-static.mjs` into `.compiled/scripts/`
 *     survive.
 *
 * The source tree is indexed once into an in-memory set per directory, so a file
 * check is a hash lookup rather than five `existsSync` syscalls. On Windows with a
 * real-time scanner that is the difference between ~900ms and ~60ms per build.
 *
 * Always exits 0: a prune failure must never fail a build.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, '.compiled');
const OUT_DIRS = ['src', 'test', 'scripts'];
const RENDERER_OUT = path.join(OUT_ROOT, 'src', 'renderer');
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const EMIT_SUFFIXES = ['.d.ts.map', '.d.ts', '.js.map', '.js'];

/** Recursively index a source tree as `relativeDir -> Set(entryName)`. */
function indexSourceTree(absDir, relDir, index) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set();
  const dirs = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
      continue;
    }
    names.add(entry.name);
  }
  index.set(relDir, names);
  for (const name of dirs) {
    indexSourceTree(path.join(absDir, name), path.join(relDir, name), index);
  }
}

/** Strip a trailing `.d.ts.map` / `.d.ts` / `.js.map` / `.js` to recover the source stem. */
function emitStem(name) {
  for (const suffix of EMIT_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return null;
}

function sourceExists(index, relDir, stem) {
  const names = index.get(relDir);
  if (names === undefined) return false;
  for (const ext of SOURCE_EXTS) {
    if (names.has(stem + ext)) return true;
  }
  return false;
}

function walk(outDir, relDir, index, removed, keptCount) {
  let entries;
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const outPath = path.join(outDir, entry.name);
    const childRel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      // copy-static owns the compiled renderer directory outright; never prune into it.
      if (outPath === RENDERER_OUT) continue;
      walk(outPath, childRel, index, removed, keptCount);
      continue;
    }
    const stem = emitStem(entry.name);
    if (stem === null) continue;
    if (sourceExists(index, relDir, stem)) {
      keptCount.n += 1;
    } else {
      removed.push(path.relative(ROOT, outPath));
    }
  }
}

const index = new Map();
for (const dir of OUT_DIRS) {
  indexSourceTree(path.join(ROOT, dir), dir, index);
}

const removed = [];
const keptCount = { n: 0 };
for (const dir of OUT_DIRS) {
  walk(path.join(OUT_ROOT, dir), dir, index, removed, keptCount);
}

let deleted = 0;
for (const rel of removed) {
  try {
    fs.rmSync(path.join(ROOT, rel), { force: true });
    deleted += 1;
  } catch {
    /* a locked emit file is retried on the next build */
  }
}

if (deleted > 0) {
  console.log(`[prune-orphans] removed ${deleted} orphaned emit file(s):`);
  for (const rel of removed) console.log(`[prune-orphans]   - ${rel}`);
} else {
  console.log(`[prune-orphans] no orphaned emit (${keptCount.n} live file(s) kept).`);
}
process.exit(0);
