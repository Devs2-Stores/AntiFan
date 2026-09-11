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

/**
 * @param {{ bundlePath: string, sourceRoots?: string[], configFiles?: string[] }} input
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

  let newestInputMs = null;
  for (const inputPath of [...(input.sourceRoots ?? []), ...(input.configFiles ?? [])]) {
    const candidate = newestSourceMtimeMs(inputPath);
    if (candidate !== null && (newestInputMs === null || candidate > newestInputMs)) newestInputMs = candidate;
  }
  // No reachable inputs means a packaged layout (sources are not shipped): nothing to compare.
  if (newestInputMs === null) {
    return { state: 'fresh', bundleMtimeMs, newestInputMs: null, reason: 'no source inputs present to compare against' };
  }
  if (newestInputMs > bundleMtimeMs) {
    return { state: 'stale', bundleMtimeMs, newestInputMs, reason: 'source inputs are newer than the compiled bundle' };
  }
  return { state: 'fresh', bundleMtimeMs, newestInputMs, reason: 'compiled bundle is current' };
}

module.exports = { inspectCompiledBundle, newestSourceMtimeMs, readMtimeMs };
