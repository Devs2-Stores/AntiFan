/**
 * Compiled-bundle freshness for the Electron main entry.
 *
 * `main.cjs` used to launch whatever `.compiled/src/main/index.js` happened to
 * exist, so a stale bundle started old code silently. This module answers the
 * only question the launcher needs: is the bundle missing, stale, or fresh
 * relative to the TypeScript inputs it was built from?
 *
 * Kept free of Electron so the decision is testable (see test/unit/launch-guard.test.mjs).
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
// Sibling extensions that legitimately explain a compiled `.js`: tsc emit plus the `.js`/`.cjs`/
// `.mjs` files `scripts/copy-static.mjs` copies in. Same rule as scripts/prune-orphan-emit.mjs,
// so the launcher and the build can never disagree about what counts as an orphan.
const EMIT_SIBLING_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
// Static assets `scripts/copy-static.mjs` ships from `src/renderer/**` into `.compiled/**`. They
// are build inputs but are NOT TypeScript, so a walk that only collects SOURCE_EXTENSIONS lets an
// edit to `src/renderer/standalone.js` pass as "fresh" — the exact "silently running old code"
// defect this module exists to prevent. They are compared against their mirrored copy instead,
// because the runtime loads that copy, not the source (#staleMirroredAssets).
const MIRRORED_ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.jpg', '.png', '.svg']);
// Derived file: `copy-static.mjs` regenerates it from `.compiled/src/shared/terminal-write-dispatcher.js`
// and writes BOTH the source-tree and the .compiled copy in the same run, so it can never be
// meaningfully "stale" — and counting it as an input would report every completed compile as an
// unfinished build, because it is written AFTER tsc has already written the build info.
const GENERATED_ASSET_BASENAMES = new Set(['terminal-write-dispatcher.js']);

function readMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True for a path INSIDE a packaged `app.asar` archive.
 *
 * Every entry in an asar archive reports a synthetic mtime, not the file's own. Measured on the
 * packaged `AntiFan-Browser-Desktop-win32-x64/resources/app.asar` under Electron 43 via
 * `ELECTRON_RUN_AS_NODE`: `.compiled/src/main/index.js`, `tsconfig.json` and the `.asar` file
 * itself all returned the identical `mtimeMs`, and that value moved between process runs even
 * though the archive on disk is dated 2026-09-05 — i.e. it does not describe the entry's age and
 * must never be ordered against the emit. Doing so is what would make a packaged app report
 * itself corrupt and refuse to start. `.asar.unpacked` is a real directory on disk with real
 * mtimes, hence the requirement for a separator right after `.asar`.
 */
function isAsarPath(filePath) {
  return typeof filePath === 'string' && /\.asar[\\/]/i.test(filePath);
}

/** Newest mtime among the source files reachable from one input path (file or directory). */
function newestSourceMtimeMs(inputPath) {
  const stat = (() => {
    try {
      return fs.statSync(inputPath);
    } catch {
      return null;
    }
  })();
  if (!stat) return null;
  if (stat.isFile()) {
    // Explicitly named inputs always count (tsconfig.json, package.json); the source-extension
    // filter only decides which files discovered while walking a directory are inputs.
    return stat.mtimeMs;
  }
  if (!stat.isDirectory()) return null;

  let newest = null;
  let entries;
  try {
    entries = fs.readdirSync(inputPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const child = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childNewest = newestSourceMtimeMs(child);
      if (childNewest !== null && (newest === null || childNewest > newest)) newest = childNewest;
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const childMtime = readMtimeMs(child);
    if (childMtime !== null && (newest === null || childMtime > newest)) newest = childMtime;
  }
  return newest;
}
/** Newest mtime among emitted artifacts under a compiled directory. */
function newestEmitMtimeMs(compiledDir) {
  let newest = null;
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.js' || ext === '.cjs' || ext === '.mjs' || ext === '.tsbuildinfo') {
          const m = readMtimeMs(full);
          if (m !== null && (newest === null || m > newest)) newest = m;
        }
      }
    }
  }
  walk(compiledDir);
  return newest;
}

/**
 * Resolve the compiled mirror of a source root, e.g. `src` -> `.compiled/src`.
 *
 * `tsconfig.json` sets `rootDir: "."` and `outDir: ".compiled"`, so the mapping is structural:
 * `src/main/index.ts` emits `.compiled/src/main/index.js` — the same derivation
 * scripts/check-emit-integrity.mjs:20-23 uses. Returns null when either side is missing (a
 * packaged layout, or a bundle living outside `.compiled` such as an asar archive interior).
 */
function compiledMirrors(input) {
  const bundlePath = input && input.bundlePath;
  if (typeof bundlePath !== 'string' || isAsarPath(bundlePath)) return null;
  const marker = path.sep + '.compiled' + path.sep;
  const idx = bundlePath.lastIndexOf(marker);
  if (idx === -1) return null;
  const compiledRoot = bundlePath.slice(0, idx) + path.sep + '.compiled';
  for (const sourceRoot of input.sourceRoots ?? []) {
    if (isAsarPath(sourceRoot) || !isDirectory(sourceRoot)) continue;
    const compiledMirrorDir = path.join(compiledRoot, path.basename(sourceRoot));
    if (!isDirectory(compiledMirrorDir)) continue;
    return { sourceMirrorDir: sourceRoot, compiledMirrorDir };
  }
  return null;
}

/**
 * Emit whose source no longer exists.
 *
 * No mtime comparison can see a DELETION: `tsc` never removes output for a source that is gone
 * (see scripts/prune-orphan-emit.mjs:5-9), so a deleted module keeps loading forever while every
 * timestamp in the tree still says "fresh". Structure is the only reliable evidence, so an emit
 * is judged only when it is provably tsc output:
 *   - a sibling `<name>.js.map` exists (`sourceMap: true`, tsconfig.json:13). `copy-static.mjs`
 *     copies and generates `.js` files with no map, so those are never judged.
 *   - no source sibling exists among EMIT_SIBLING_EXTENSIONS in the mirrored source directory.
 * The repair is already automatic: this verdict makes `main.cjs` run `npm run compile`, whose
 * first steps include `check-emit-integrity.mjs` and `prune-orphan-emit.mjs`.
 *
 * @returns {string[]} up to `limit` orphan emit paths, relative to the compiled mirror.
 */
function staleOrphanEmit(compiledMirrorDir, sourceMirrorDir, limit = 5) {
  const orphans = [];
  const walk = (outDir, relDir) => {
    if (orphans.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(outDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (orphans.length >= limit) return;
      const outPath = path.join(outDir, entry.name);
      if (entry.isDirectory()) {
        walk(outPath, path.join(relDir, entry.name));
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.js') continue;
      // Only tsc emit is judged, and only tsc writes a source map next to its output.
      if (readMtimeMs(`${outPath}.map`) === null) continue;
      const stem = entry.name.slice(0, -'.js'.length);
      let sibling = false;
      try {
        const names = new Set(fs.readdirSync(path.join(sourceMirrorDir, relDir)));
        sibling = EMIT_SIBLING_EXTENSIONS.some((ext) => names.has(stem + ext));
      } catch {
        sibling = false;
      }
      if (!sibling) orphans.push(relDir ? path.join(relDir, entry.name) : entry.name);
    }
  };
  walk(compiledMirrorDir, '');
  return orphans;
}

/**
 * Static assets whose compiled copy is older than the source it was copied from.
 *
 * The runtime loads the `.compiled` copy (`copy-static.mjs`), so an edit to `src/renderer/*.js`
 * changes nothing until the build re-copies it — and because `.js` is not a TypeScript extension,
 * the timestamp comparison above cannot see it. Measured on this repo: `.compiled/src/renderer/
 * standalone.js` (146 KB, edited by hand) is exactly such a file.
 *
 * A MISSING mirror is not judged: an asset the build deliberately does not ship must not pin the
 * guard at "stale" forever. Only an existing copy that is behind its source is reported, which is
 * also why a rebuild always clears the condition.
 *
 * @returns {string[]} up to `limit` stale asset paths, relative to the source mirror.
 */
function staleMirroredAssets(sourceMirrorDir, compiledMirrorDir, limit = 5) {
  const stale = [];
  const walk = (sourceDir, relDir) => {
    if (stale.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stale.length >= limit) return;
      const sourcePath = path.join(sourceDir, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath, path.join(relDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MIRRORED_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (GENERATED_ASSET_BASENAMES.has(entry.name)) continue;
      const sourceMtimeMs = readMtimeMs(sourcePath);
      // `readMtimeMs` is null for an asset that was never copied: not this guard's business.
      const mirrorMtimeMs = readMtimeMs(path.join(compiledMirrorDir, relDir, entry.name));
      if (sourceMtimeMs === null || mirrorMtimeMs === null) continue;
      // Strictly `>` here, unlike the source/build comparison: the copy is written in the same
      // pass as the build, so on a coarse-timestamp volume an "equal means stale" rule could
      // re-flag the fresh copy on every launch. Detecting an edit inside a single tick is not
      // possible either way.
      if (sourceMtimeMs > mirrorMtimeMs) {
        stale.push(relDir ? path.join(relDir, entry.name) : entry.name);
      }
    }
  };
  walk(sourceMirrorDir, '');
  return stale;
}

/**
 * @param {{ bundlePath: string, buildInfoPath?: string, sourceRoots?: string[], configFiles?: string[] }} input
 * @returns {{ state: 'missing'|'stale'|'fresh', bundleMtimeMs: number|null, newestInputMs: number|null, reason: string }}
 */
function inspectCompiledBundle(input) {
  const bundlePath = input && input.bundlePath;
  if (!bundlePath || typeof bundlePath !== 'string') {
    throw new TypeError('inspectCompiledBundle requires a bundlePath string');
  }
  const bundleMtimeMs = readMtimeMs(bundlePath);
  if (bundleMtimeMs === null) {
    return { state: 'missing', bundleMtimeMs: null, newestInputMs: null, reason: 'compiled bundle is absent' };
  }
  // A present-but-empty entry module is what an interrupted emit leaves behind: tsc truncates the
  // file before writing it, so a launch that races the writer can observe zero bytes. `require()`
  // on it succeeds and registers nothing at all, which is a silent no-op start rather than a
  // crash — not "fresh" by any reading.
  if (readSizeBytes(bundlePath) === 0) {
    return { state: 'stale', bundleMtimeMs, newestInputMs: null, reason: 'compiled bundle is present but empty (interrupted emit)' };
  }

  // Anchor comparison on the latest compilation artifact (e.g. .tsbuildinfo or newest emit)
  // so an incremental compile that does not rewrite bundlePath is not treated as stale.
  let anchorMtimeMs = bundleMtimeMs;
  let resolvedBuildInfo = input && input.buildInfoPath;
  if (!resolvedBuildInfo) {
    // Attempt auto-discovery of .tsbuildinfo if bundlePath is inside .compiled
    const compiledMarker = path.sep + '.compiled' + path.sep;
    const idx = bundlePath.lastIndexOf(compiledMarker);
    if (idx !== -1) {
      const candidate = path.join(bundlePath.slice(0, idx), '.compiled', '.tsbuildinfo');
      if (fs.existsSync(candidate)) {
        resolvedBuildInfo = candidate;
      }
    }
  }
  // Inside a packaged archive every path reports a synthetic mtime that does not describe the
  // entry, so it cannot be ordered against the emit (see #isAsarPath): treat it as no build info
  // rather than trusting it.
  if (isAsarPath(resolvedBuildInfo)) resolvedBuildInfo = null;

  if (resolvedBuildInfo) {
    const buildInfoMtime = readMtimeMs(resolvedBuildInfo);
    // A zero-byte build info describes no build. Trusting its timestamp would let a corrupt file
    // written now mask a bundle built before the last source edit, so it must not raise the anchor.
    const buildInfoUsable = buildInfoMtime !== null && readSizeBytes(resolvedBuildInfo) > 0;
    if (buildInfoUsable && buildInfoMtime > anchorMtimeMs) {
      anchorMtimeMs = buildInfoMtime;
    }
  } else {
    // If no buildInfo artifact, check if there is a newer emit under .compiled
    const compiledMarker = path.sep + '.compiled' + path.sep;
    const idx = bundlePath.lastIndexOf(compiledMarker);
    if (idx !== -1) {
      const compiledDir = path.join(bundlePath.slice(0, idx), '.compiled');
      const newestEmit = newestEmitMtimeMs(compiledDir);
      if (newestEmit !== null && newestEmit > anchorMtimeMs) {
        anchorMtimeMs = newestEmit;
      }
    }
  }

  let newestInputMs = null;
  // `tsconfig.json` only describes how a SOURCE TREE compiles. A packaged layout ships neither
  // `src` nor any other source root, so a lone tsconfig copied into the bundle is not evidence
  // that the emit is behind — and treating it as such makes a packaged app declare itself corrupt
  // and refuse to start (main.cjs's packaged branch). Config files are therefore only inputs when
  // a source root is actually present.
  const sourceRootsPresent = (input.sourceRoots ?? []).some((root) => !isAsarPath(root) && isDirectory(root));
  const inputPaths = sourceRootsPresent
    ? [...(input.sourceRoots ?? []), ...(input.configFiles ?? [])]
    : [...(input.sourceRoots ?? [])];
  for (const inputPath of inputPaths) {
    // An input inside an asar has a synthetic timestamp: it is not an input we can date.
    if (isAsarPath(inputPath)) continue;
    const candidate = newestSourceMtimeMs(inputPath);
    if (candidate !== null && (newestInputMs === null || candidate > newestInputMs)) newestInputMs = candidate;
  }
  // No reachable inputs means a packaged layout (sources are not shipped): nothing to compare.
  if (newestInputMs === null) {
    return { state: 'fresh', bundleMtimeMs: anchorMtimeMs, newestInputMs: null, reason: 'no source inputs present to compare against' };
  }
  // `>=`, not `>`: on a volume with coarse timestamps (FAT 2 s, exFAT 10 ms) an edit and the
  // compile that follows it can land in the same tick, and "input mtime == anchor mtime" cannot
  // prove the emit is newer than the input. NTFS resolves to 100 ns, so this branch is only
  // reachable where timestamps genuinely are coarse — and the cost there is one extra incremental
  // compile, never a wrong launch. Asar inputs are skipped above precisely so this rule cannot
  // fire on a packaged archive, where every path would otherwise tie with the anchor.
  if (newestInputMs >= anchorMtimeMs) {
    return {
      state: 'stale',
      bundleMtimeMs: anchorMtimeMs,
      newestInputMs,
      reason: newestInputMs === anchorMtimeMs
        ? 'a source input shares the compiled bundle\'s exact timestamp, so the emit cannot be proven newer'
        : 'source inputs are newer than the compiled bundle',
    };
  }

  const mirrors = compiledMirrors(input);
  if (mirrors) {
    // Structure, not timestamps: a deleted source leaves its emit behind and every mtime stays
    // "fresh" (see #staleOrphanEmit).
    const orphanEmit = staleOrphanEmit(mirrors.compiledMirrorDir, mirrors.sourceMirrorDir);
    if (orphanEmit.length > 0) {
      return {
        state: 'stale',
        bundleMtimeMs: anchorMtimeMs,
        newestInputMs,
        reason: `compiled bundle still contains emit for source files that no longer exist (${orphanEmit.join(', ')})`,
        orphanEmit,
      };
    }
    // Assets the build copies: the runtime loads the copy, so the copy is what has to be current.
    const staleAssets = staleMirroredAssets(mirrors.sourceMirrorDir, mirrors.compiledMirrorDir);
    if (staleAssets.length > 0) {
      return {
        state: 'stale',
        bundleMtimeMs: anchorMtimeMs,
        newestInputMs,
        reason: `compiled copies of build assets are older than their sources (${staleAssets.join(', ')})`,
        staleMirroredAssets: staleAssets,
      };
    }
  }
  return { state: 'fresh', bundleMtimeMs: anchorMtimeMs, newestInputMs, reason: 'compiled bundle is current' };
}

module.exports = { inspectCompiledBundle, newestSourceMtimeMs, newestEmitMtimeMs, readMtimeMs };
