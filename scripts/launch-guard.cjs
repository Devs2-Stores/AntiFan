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

function readMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
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

  if (resolvedBuildInfo) {
    const buildInfoMtime = readMtimeMs(resolvedBuildInfo);
    if (buildInfoMtime !== null && buildInfoMtime > anchorMtimeMs) {
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
  for (const inputPath of [...(input.sourceRoots ?? []), ...(input.configFiles ?? [])]) {
    const candidate = newestSourceMtimeMs(inputPath);
    if (candidate !== null && (newestInputMs === null || candidate > newestInputMs)) newestInputMs = candidate;
  }
  // No reachable inputs means a packaged layout (sources are not shipped): nothing to compare.
  if (newestInputMs === null) {
    return { state: 'fresh', bundleMtimeMs: anchorMtimeMs, newestInputMs: null, reason: 'no source inputs present to compare against' };
  }
  if (newestInputMs > anchorMtimeMs) {
    return { state: 'stale', bundleMtimeMs: anchorMtimeMs, newestInputMs, reason: 'source inputs are newer than the compiled bundle' };
  }
  return { state: 'fresh', bundleMtimeMs: anchorMtimeMs, newestInputMs, reason: 'compiled bundle is current' };
}

module.exports = { inspectCompiledBundle, newestSourceMtimeMs, newestEmitMtimeMs, readMtimeMs };
