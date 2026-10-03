#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Renderer Asset Completeness Gate
 *
 * `scripts/package-windows.mjs` drops `/src` from packaged builds, so every
 * renderer asset the app consumes must reach `.compiled` — either via the tsc
 * emit set (`src` sources -> `.compiled/src` outputs) or via the explicit copy
 * lanes in `scripts/copy-static.mjs`. A missing asset ships a broken renderer
 * with a green build; this gate fails the compile instead.
 *
 * Consumed asset closure (derived, not hard-coded):
 *   - string literals passed to `resolveRendererAsset('…')` and the renderer literals inside
 *     `resolveStandaloneRendererPage`, all of which land under `src/renderer/`;
 *   - string literals passed to `resolvePreloadAsset('…')`, which land under `src/preload/`;
 *   - `<script src>` / `<link href>` references inside each shipped HTML file
 *     (`standalone.html`, `toolbar.html`, `frame-backdrop.html`),
 *     plus `.js`/`.css` literals inside their inline scripts — external URLs,
 *     non-file refs and `node_modules/` paths are skipped.
 *
 * Produced set (compiled-root-relative posix paths):
 *   - tsc emit: every `src/**.ts` maps to `src/**.js` under the compiled root;
 *   - the copy lanes in `scripts/copy-static.mjs` (`filesToCopy`, the `jsFiles`
 *     post-process loop and the shared-module `file:` specs target
 *     `src/renderer/`, `scriptsToCopy` targets `scripts/`).
 *
 * Any consumed asset that is not produced, or that is produced but absent on
 * disk, fails the gate with exit code 1 and names the offenders.
 *
 * Honors `ANTIFAN_COMPILED_ROOT` like `copy-static.mjs` so isolated build trees
 * (`tsc --outDir <dir>` + copy-static) are validated the same way.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED_ROOT = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const SRC_ROOT = path.join(ROOT, 'src');
const RENDERER_SRC_DIR = path.join(SRC_ROOT, 'renderer');
const COPY_STATIC = path.join(ROOT, 'scripts', 'copy-static.mjs');

/** Relativize with posix separators so path math is stable on Windows. */
function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/** Every `src/**.ts` file produces `src/**.js` under the compiled root. */
function collectTsEmit(produced, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsEmit(produced, abs);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const rel = toPosix(path.relative(ROOT, abs)).replace(/\.ts$/, '.js');
      produced.add(rel);
    }
  }
}

/**
 * Parse the copy lanes out of `scripts/copy-static.mjs` instead of duplicating
 * the lists: `filesToCopy` -> `src/renderer/`, `jsFiles` (the exports-fallback
 * post-process loop) -> `src/renderer/`, shared-module `file:` specs ->
 * `src/renderer/`, `scriptsToCopy` -> `scripts/`.
 */
function collectCopyLanes(produced) {
  const raw = fs.readFileSync(COPY_STATIC, 'utf8');
  const lanes = [
    { re: /filesToCopy\s*=\s*\[([\s\S]*?)\]/, dir: 'src/renderer' },
    { re: /jsFiles\s*=\s*\[([\s\S]*?)\]/, dir: 'src/renderer' },
    { re: /file:\s*'([^']+\.js)'/g, dir: 'src/renderer' },
    { re: /scriptsToCopy\s*=\s*\[([\s\S]*?)\]/, dir: 'scripts' },
  ];
  for (const lane of lanes) {
    if (lane.re.global) {
      for (const m of raw.matchAll(lane.re)) produced.add(`${lane.dir}/${m[1]}`);
      continue;
    }
    const m = raw.match(lane.re);
    if (!m) continue;
    for (const lit of m[1].matchAll(/'([^']+)'/g)) produced.add(`${lane.dir}/${lit[1]}`);
  }
}

/** Collect every consumed `src/`-relative asset path. */
function collectConsumed() {
  const consumed = new Map(); // srcRel -> first evidence
  const add = (srcRel, evidence) => {
    if (!consumed.has(srcRel)) consumed.set(srcRel, evidence);
  };
  const htmlFiles = new Set();
  const srcFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) srcFiles.push(abs);
    }
  };
  walk(SRC_ROOT);

  for (const file of srcFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const ev = toPosix(path.relative(ROOT, file));
    // Direct resolvers.
    for (const re of [
      /resolveRendererAsset\(\s*'([^']+)'/g,
      /resolvePreloadAsset\(\s*'([^']+)'/g,
      /\brendererFile\(\s*'([^']+)'/g,
      /\bpreloadFile\(\s*'([^']+)'/g,
    ]) {
      const dir = re.source.includes('reload') || re.source.includes('Preload') || re.source.includes('preload')
        ? 'src/preload'
        : 'src/renderer';
      for (const m of text.matchAll(re)) add(`${dir}/${m[1]}`, `${ev}: ${m[0]}`);
    }
    // `resolveStandaloneRendererPage` (and equivalents such as index.ts's
    // standaloneRendererPagePath) join literals instead of taking an argument:
    // catch every `path.join(... 'renderer'|'preload', 'file.ext')` so the page
    // literal is captured wherever the renderer dir is named.
    for (const m of text.matchAll(/path\.join\([^)]*?('(?:renderer|preload)')[^)]*?'([\w.-]+\.(?:js|css|html))'/g)) {
      const dir = m[1] === "'preload'" ? 'src/preload' : 'src/renderer';
      add(`${dir}/${m[2]}`, `${ev}: path.join segment '${m[2]}'`);
    }
  }

  // Every consumed HTML asset is a shipped document; every produced `.html`
  // under src/renderer is also shipped even if nothing references it yet.
  for (const rel of consumed.keys()) {
    if (rel.endsWith('.html')) htmlFiles.add(path.basename(rel));
  }

  // HTML transitively consumes its script/link references.
  const isExternal = (ref) =>
    /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/') || ref.startsWith('#') || ref.startsWith('//');
  const scanHtml = (abs) => {
    const text = fs.readFileSync(abs, 'utf8');
    const ev = toPosix(path.relative(ROOT, abs));
    const addRef = (ref) => {
      if (!ref || isExternal(ref)) return;
      const resolved = path.resolve(path.dirname(abs), ref);
      const relSrc = path.relative(SRC_ROOT, resolved);
      // Refs that escape src/ (node_modules/, ../cwd/src/…) are not produced by
      // the compile chain and are not gated here.
      if (relSrc.startsWith('..')) return;
      add(`src/${toPosix(relSrc)}`, `${ev}: ref '${ref}'`);
    };
    for (const m of text.matchAll(/<script[^>]*\ssrc=['"]([^'"]+)['"]/g)) addRef(m[1]);
    for (const m of text.matchAll(/<link[^>]*\shref=['"]([^'"]+)['"]/g)) addRef(m[1]);
    // Inline scripts load dynamic lists (standalone.html's document.write loop)
    // — pick up bare `.js`/`.css` literals that are not node_modules paths.
    for (const m of text.matchAll(/'([^']*\.(?:js|css))'/g)) {
      const lit = m[1];
      if (lit.includes('/') || lit.includes(' ')) continue;
      addRef(lit);
    }
    for (const rel of consumed.keys()) {
      if (rel.endsWith('.html')) htmlFiles.add(path.basename(rel));
    }
  };
  let before = -1;
  while (htmlFiles.size !== before) {
    before = htmlFiles.size;
    for (const name of [...htmlFiles]) {
      const abs = path.join(RENDERER_SRC_DIR, name);
      if (fs.existsSync(abs)) scanHtml(abs);
    }
  }

  return { consumed, htmlFiles };
}

const produced = new Set();
collectTsEmit(produced, SRC_ROOT);
collectCopyLanes(produced);

const { consumed, htmlFiles } = collectConsumed();
const notProduced = [];
const missing = [];
for (const [rel, evidence] of [...consumed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!produced.has(rel)) {
    notProduced.push(`  ${rel}  (consumed via ${evidence})`);
  } else if (!fs.existsSync(path.join(COMPILED_ROOT, rel))) {
    missing.push(`  ${COMPILED_ROOT.replace(/\\/g, '/')}/${rel}  (consumed via ${evidence})`);
  }
}

if (notProduced.length === 0 && missing.length === 0) {
  console.log(
    `[renderer-assets] OK: ${consumed.size} consumed asset(s) across ${htmlFiles.size} shipped html file(s); ` +
      `all produced and present under ${COMPILED_ROOT}.`
  );
  process.exit(0);
}
console.error('[renderer-assets] FAIL: consumed renderer assets are not covered by the compile chain.');
if (notProduced.length) {
  console.error('  Not produced by tsc emit or any copy-static lane:');
  console.error(notProduced.join('\n'));
}
if (missing.length) {
  console.error('  Produced but missing on disk:');
  console.error(missing.join('\n'));
}
process.exit(1);
