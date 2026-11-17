#!/usr/bin/env node
// check-package-tree.mjs - fail when a packaged AntiFan build carries private data or grew unexpectedly.
//   node scripts/check-package-tree.mjs [--dir <packaged app dir>] [--update-baseline]
// Reads resources/app.asar (list only, never extracts) and walks resources/app.asar.unpacked.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forbiddenInTree } from './lib/package-allowlist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE = path.join(HERE, 'package-tree-baseline.json');
const GROWTH = 1.1;
export const DEFAULT_APP_DIR = path.join(ROOT, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'artifacts', 'AntiFan-Browser-Desktop-win32-x64');

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${base}/${e.name}`;
    out.push(rel);
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
  }
  return out;
}

/**
 * @returns {{ok:boolean, bad:string[], asarBytes:number, entries:number, baselineBytes:number|null, grew:boolean, baselineCreated:boolean}}
 */
export function checkPackageTree({ appDir = DEFAULT_APP_DIR, baselinePath = BASELINE, updateBaseline = false, listPackage } = {}) {
  const resources = path.join(appDir, 'resources');
  const asarFile = path.join(resources, 'app.asar');
  if (!fs.existsSync(asarFile)) throw new Error(`no app.asar at ${asarFile}`);
  const list = listPackage ?? createRequire(import.meta.url)('@electron/asar').listPackage;
  const entries = list(asarFile, { isPack: false });
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const all = [...entries, ...(fs.existsSync(unpacked) ? walk(unpacked) : [])];
  const bad = forbiddenInTree(all);
  const asarBytes = fs.statSync(asarFile).size;
  let baselineBytes = null;
  try {
    baselineBytes = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).asarBytes;
  } catch {}
  // A missing/unreadable baseline cannot judge growth: create it and say so, never pass silently.
  const baselineCreated = baselineBytes === null;
  if (updateBaseline || baselineCreated) {
    fs.writeFileSync(baselinePath, JSON.stringify({ asarBytes, recordedAt: new Date().toISOString() }, null, 2));
    baselineBytes = baselineBytes ?? asarBytes;
  }
  const grew = asarBytes > baselineBytes * GROWTH;
  return { ok: bad.length === 0 && !grew, bad, asarBytes, entries: all.length, baselineBytes, grew, baselineCreated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const dir = a.includes('--dir') ? a[a.indexOf('--dir') + 1] : DEFAULT_APP_DIR;
  try {
    const r = checkPackageTree({ appDir: dir, updateBaseline: a.includes('--update-baseline') });
    console.log(`[package-tree] ${r.entries} entries, app.asar ${r.asarBytes} bytes (baseline ${r.baselineBytes})`);
    for (const b of r.bad) console.error(`[package-tree] FORBIDDEN: ${b}`);
    if (r.baselineCreated) console.warn(`[package-tree] WARNING: no baseline existed; recorded this build (${r.asarBytes} bytes) as the baseline in ${BASELINE}. The growth guard has nothing to compare against until the next build.`);
    if (r.grew) console.error(`[package-tree] app.asar grew more than ${Math.round((GROWTH - 1) * 100)}% over baseline; review then rerun with --update-baseline`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`[package-tree] ${e.message}`);
    process.exit(1);
  }
}
