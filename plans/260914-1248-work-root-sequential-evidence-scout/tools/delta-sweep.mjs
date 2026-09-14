#!/usr/bin/env node
// Phase 6 delta sweep: re-enumerate every inventoried directory and re-stat
// every entry; diff against inventory.jsonl. Writes reports/delta-sweep.json.
// Detects added/changed/deleted entries; unchanged = same name+type+size+mtime.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const INV = path.join(REPORTS, 'inventory.jsonl');

function sysPath(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  if (p.length < 240) return p;
  if (p.startsWith('\\\\')) return `\\\\?\\UNC\\${p.slice(2)}`;
  return `\\\\?\\${p}`;
}

// load inventory grouped by parent dir
const byParent = new Map(); // dirAbsPath -> Map(name -> entry)
const entries = [];
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
    entries.push(e);
    const parent = path.dirname(e.path);
    if (!byParent.has(parent)) byParent.set(parent, new Map());
    byParent.get(parent).set(e.name, e);
  };
  while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
    carry += buf.toString('utf8', 0, n);
    let i;
    while ((i = carry.indexOf('\n')) >= 0) { handle(carry.slice(0, i).replace(/\r$/, '')); carry = carry.slice(i + 1); }
  }
  if (carry) handle(carry.replace(/\r$/, ''));
  fs.closeSync(fd);
}

const added = [];
const changed = [];
const deleted = [];
let unchanged = 0;
let readdirErrors = 0;
let statErrors = 0;
let dirsChecked = 0;

for (const [dirAbs, known] of byParent) {
  dirsChecked += 1;
  let dirents;
  try {
    dirents = fs.readdirSync(sysPath(dirAbs), { withFileTypes: true });
  } catch (e) {
    readdirErrors += 1;
    // whole dir unreadable now: all known children are unverifiable
    for (const e of known.values()) deleted.push({ path: e.path, reason: `parent readdir ${e.code ?? e.message}` });
    continue;
  }
  const seen = new Set();
  for (const d of dirents) {
    seen.add(d.name);
    const prev = known.get(d.name);
    if (!prev) {
      added.push({ path: path.join(dirAbs, d.name), type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other' });
      continue;
    }
    // re-stat
    try {
      const st = fs.lstatSync(sysPath(prev.path));
      const sameSize = prev.size === null || prev.size === st.size;
      const sameMtime = prev.mtime === null || prev.mtime === st.mtime.toISOString();
      const sameType = (prev.type === 'directory') === st.isDirectory() || (prev.type === 'file') === st.isFile();
      if (sameSize && sameMtime && sameType) unchanged += 1;
      else changed.push({ path: prev.path, was: { size: prev.size, mtime: prev.mtime, type: prev.type }, now: { size: st.size, mtime: st.mtime.toISOString(), isDir: st.isDirectory() } });
    } catch (e) {
      statErrors += 1;
      deleted.push({ path: prev.path, reason: `lstat ${e.code ?? e.message}` });
    }
  }
  for (const [name, e] of known) {
    if (!seen.has(name)) deleted.push({ path: e.path, reason: 'absent on re-enumeration' });
  }
}

const report = {
  runId: 'wrses-20260914T135118Z',
  generatedAt: new Date().toISOString(),
  inventoried: entries.length,
  dirsChecked,
  unchanged,
  added: added.length,
  changed: changed.length,
  deleted: deleted.length,
  readdirErrors,
  statErrors,
  addedSample: added.slice(0, 200000),
  changedSample: changed.slice(0, 200000),
  deletedSample: deleted.slice(0, 200000),
  samplesTruncated: added.length > 200000 || changed.length > 200000 || deleted.length > 200000,
  note: 'delta vs inventory cut; active filesystem is not an atomic snapshot',
};
fs.writeFileSync(path.join(REPORTS, 'delta-sweep.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ inventoried: entries.length, unchanged, added: added.length, changed: changed.length, deleted: deleted.length, readdirErrors, statErrors }));
