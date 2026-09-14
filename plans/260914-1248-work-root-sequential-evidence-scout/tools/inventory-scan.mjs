#!/usr/bin/env node
// Durable sequential filesystem inventory scanner for the work-root evidence scout.
//
// Design invariants (see reports/policy-ledger.jsonl):
//   - append-only durable state; every directory completion has a receipt
//   - entry batch is written and renamed into place BEFORE its completion receipt,
//     so a replay after interruption overwrites the same batch instead of duplicating entries
//   - frontier is derived from discovered-minus-completed, so a lost in-memory queue
//     can never lose discovered work
//   - no network I/O, no source mutation, no archive extraction, no content read
//   - exact path identity: no case folding, no normalization, no trimming

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MODES = new Set(['run', 'probe', 'aggregate', 'archive']);

function parseArgs(argv) {
  const out = { mode: 'run', config: null, out: null, root: null, maxDirs: null, maxDepth: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--mode') out.mode = next();
    else if (a === '--config') out.config = next();
    else if (a === '--out') out.out = next();
    else if (a === '--root') out.root = next();
    else if (a === '--max-dirs') out.maxDirs = Number(next());
    else if (a === '--max-depth') out.maxDepth = Number(next());
    else if (a === '--quiet') out.quiet = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!MODES.has(out.mode)) throw new Error(`unknown mode: ${out.mode}`);
  return out;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config ?? path.join(SCRIPT_DIR, 'scan-config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const runId = config.runId;
const policyVersion = config.policyVersion;
const maxDepth = args.maxDepth ?? config.scanSemantics.maxDepth;
const followLinks = config.scanSemantics.followLinks === true;

const outDir = path.resolve(args.out ?? path.join(PLAN_DIR, config.outputDir));
const stateDir = path.join(outDir, 'scan-state');
const batchDir = path.join(outDir, 'scan-batches');
const archiveDir = path.join(outDir, 'scan-archive');

const P = {
  inventory: path.join(outDir, 'inventory.jsonl'),
  frontier: path.join(outDir, 'frontier.json'),
  errors: path.join(outDir, 'errors.jsonl'),
  archiveMembers: path.join(outDir, 'archive-members.jsonl'),
  summary: path.join(outDir, 'inventory-summary.json'),
  discovered: path.join(stateDir, 'discovered.jsonl'),
  dirs: path.join(stateDir, 'dirs.jsonl'),
  roots: path.join(stateDir, 'roots.json'),
  progress: path.join(stateDir, 'progress.json'),
};

function ensureDirs() {
  for (const d of [outDir, stateDir, batchDir, archiveDir]) fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------- path helpers

function sysPath(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  if (p.length < 240) return p;
  if (p.startsWith('\\\\')) return `\\\\?\\UNC\\${p.slice(2)}`;
  return `\\\\?\\${p}`;
}

function nowIso() {
  return new Date().toISOString();
}

function idOf(rootId, relPath) {
  return crypto.createHash('sha1').update(`${rootId}\u0000${relPath}`, 'utf8').digest('hex').slice(0, 20);
}

// ---------------------------------------------------------------- policy engine

function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const policyDb = (config.policies ?? []).map((p) => ({
  ...p,
  basenameRes: (p.basenamePatterns ?? []).map(globToRe),
  segmentRes: (p.segmentPatterns ?? []).map(globToRe),
  skillNameRes: (p.skillNamePatterns ?? []).map(globToRe),
  pathPrefixes: (p.pathPrefixes ?? []).map((s) => s.toLowerCase()),
  exactPaths: new Set((p.exactPaths ?? []).map((s) => s.toLowerCase())),
  roots: p.roots ? new Set(p.roots) : null,
})).sort((a, b) => b.precedence - a.precedence);

const GENERATED = policyDb.find((p) => p.id === 'GENERATED_BY_THIS_RUN');

function policyFor({ rootId, relPath, name, skillRelativeName }) {
  const rel = relPath === '.' ? '' : relPath;
  const relLower = rel.toLowerCase();
  const segments = relLower.split(/[\\/]/).filter(Boolean);
  for (const p of policyDb) {
    if (p.roots && !p.roots.has(rootId)) continue;
    if (p.pathPrefixes.length || p.exactPaths.size) {
      if (p.exactPaths.has(relLower)) return p;
      for (const pre of p.pathPrefixes) {
        if (relLower === pre || relLower.startsWith(`${pre}\\`) || relLower.startsWith(`${pre}/`)) return p;
      }
      if (!p.basenameRes.length && !p.segmentRes.length && !p.skillNameRes.length) continue;
    }
    for (const re of p.basenameRes) if (re.test(name)) return p;
    for (const re of p.segmentRes) if (segments.some((s) => re.test(s))) return p;
    if (p.skillNameRes.length && skillRelativeName) {
      for (const re of p.skillNameRes) if (re.test(skillRelativeName)) return p;
    }
  }
  return null;
}

const POLICY_DEFAULT = { id: 'ALLOWED', precedence: 0 };

function skillRelativeNameFor(root, absPath) {
  if (root.kind !== 'skill-root') return null;
  const rel = path.relative(root.absPath, absPath);
  if (!rel) return null;
  const first = rel.split(/[\\/]/).filter(Boolean)[0];
  return first ?? null;
}

// ---------------------------------------------------------------- durable state

class AppendLog {
  constructor(file) {
    this.file = file;
  }
  append(lines) {
    if (!persistMode || !lines.length) return;
    fs.appendFileSync(this.file, `${lines.join('\n')}\n`, 'utf8');
  }
}

const discoveredLog = new AppendLog(P.discovered);
const receiptLog = new AppendLog(P.dirs);
const errorLog = new AppendLog(P.errors);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn trailing line is expected after a hard kill; it is not an entry
    }
  }
  return out;
}

// ---------------------------------------------------------------- archive readers

function readZipMembers(absPath, limits) {
  const members = [];
  const notes = [];
  let fd = null;
  try {
    fd = fs.openSync(sysPath(absPath), 'r');
    const size = fs.fstatSync(fd).size;
    if (size > limits.maxArchiveBytes) {
      return { members, notes, blocked: { code: 'BLOCKED_RESOURCE_LIMIT', detail: `container ${size} bytes exceeds limit ${limits.maxArchiveBytes}` } };
    }
    const tailLen = Math.min(size, 65557 + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return { members, notes, blocked: { code: 'UNPARSEABLE_ARCHIVE', detail: 'no end-of-central-directory record' } };
    let entryCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
      let loc = -1;
      for (let i = tail.length - 22; i >= 0; i -= 1) {
        if (i + 20 <= tail.length && tail.readUInt32LE(i) === 0x07064b50) {
          loc = i;
          break;
        }
      }
      if (loc >= 0) {
        const z64Off = Number(tail.readBigUInt64LE(loc + 8));
        const buf = Buffer.alloc(56);
        fs.readSync(fd, buf, 0, 56, z64Off);
        if (buf.readUInt32LE(0) === 0x06064b50) {
          entryCount = Number(buf.readBigUInt64LE(32));
          cdSize = Number(buf.readBigUInt64LE(40));
          cdOffset = Number(buf.readBigUInt64LE(48));
        }
      }
    }
    if (entryCount > limits.maxArchiveMembers) {
      return { members, notes, blocked: { code: 'BLOCKED_RESOURCE_LIMIT', detail: `${entryCount} members exceeds limit ${limits.maxArchiveMembers}` } };
    }
    if (cdSize > limits.maxCentralDirectoryBytes) {
      return { members, notes, blocked: { code: 'BLOCKED_RESOURCE_LIMIT', detail: `central directory ${cdSize} bytes exceeds limit ${limits.maxCentralDirectoryBytes}` } };
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    let off = 0;
    while (off + 46 <= cd.length) {
      if (cd.readUInt32LE(off) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const crc = cd.readUInt32LE(off + 16);
      let compSize = cd.readUInt32LE(off + 20);
      let uncompSize = cd.readUInt32LE(off + 24);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const extAttr = cd.readUInt32LE(off + 38);
      const localOff = cd.readUInt32LE(off + 42);
      const nameBuf = cd.subarray(off + 46, off + 46 + nameLen);
      const utf8 = (flags & 0x800) !== 0;
      const memberPath = utf8 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
        const extra = cd.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
        let e = 0;
        while (e + 4 <= extra.length) {
          const hid = extra.readUInt16LE(e);
          const hsz = extra.readUInt16LE(e + 2);
          if (hid === 0x0001) {
            let f = e + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(f)); f += 8; }
            if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(f)); f += 8; }
            break;
          }
          e += 4 + hsz;
        }
      }
      const isDir = memberPath.endsWith('/') || (extAttr & 0x10) !== 0;
      members.push({
        memberId: idOf('zip-member', `${absPath}\u0000${memberPath}`),
        memberPath,
        isDir,
        method,
        crc32: crc.toString(16).padStart(8, '0'),
        compressedBytes: compSize,
        uncompressedBytes: uncompSize,
        encrypted: (flags & 0x1) !== 0,
        localHeaderOffset: localOff,
      });
      off += 46 + nameLen + extraLen + commentLen;
      if (members.length >= limits.maxArchiveMembers) {
        notes.push({ code: 'MEMBER_LIMIT_REACHED', detail: `stopped at ${limits.maxArchiveMembers} members` });
        break;
      }
    }
  } catch (e) {
    return { members, notes, blocked: { code: e.code ?? 'ARCHIVE_READ_ERROR', detail: e.message } };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return { members, notes, blocked: null };
}

function readTarMembers(absPath, limits) {
  const members = [];
  const notes = [];
  try {
    const size = fs.statSync(sysPath(absPath)).size;
    if (size > limits.maxArchiveBytes) {
      return { members, notes, blocked: { code: 'BLOCKED_RESOURCE_LIMIT', detail: `container ${size} bytes exceeds limit` } };
    }
    let buf = fs.readFileSync(sysPath(absPath));
    if (absPath.endsWith('.gz') || absPath.endsWith('.tgz')) {
      buf = zlib.gunzipSync(buf, { maxOutputLength: limits.maxArchiveBytes });
    }
    let off = 0;
    let pendingLongName = null;
    while (off + 512 <= buf.length) {
      const header = buf.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
      const sizeOct = sizeField ? parseInt(sizeField, 8) : 0;
      const typeflag = String.fromCharCode(header[156]);
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
      const linkName = header.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
      const dataStart = off + 512;
      let name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      if (typeflag === 'L') {
        pendingLongName = buf.subarray(dataStart, dataStart + (Number.isFinite(sizeOct) ? sizeOct : 0)).toString('utf8').replace(/\0.*$/, '');
        off = dataStart + Math.ceil((Number.isFinite(sizeOct) ? sizeOct : 0) / 512) * 512;
        continue;
      }
      pendingLongName = null;
      members.push({
        memberId: idOf('tar-member', `${absPath}\u0000${name}`),
        memberPath: name,
        isDir: typeflag === '5' || name.endsWith('/'),
        typeflag,
        linkTarget: typeflag === '1' || typeflag === '2' ? linkName : null,
        compressedBytes: null,
        uncompressedBytes: Number.isFinite(sizeOct) ? sizeOct : null,
        encrypted: false,
      });
      if (members.length >= limits.maxArchiveMembers) {
        notes.push({ code: 'MEMBER_LIMIT_REACHED', detail: `stopped at ${limits.maxArchiveMembers} members` });
        break;
      }
      off = dataStart + Math.ceil((Number.isFinite(sizeOct) ? sizeOct : 0) / 512) * 512;
    }
  } catch (e) {
    return { members, notes, blocked: { code: e.code ?? 'ARCHIVE_READ_ERROR', detail: e.message } };
  }
  return { members, notes, blocked: null };
}

// ---------------------------------------------------------------- roots

function rootsFor(only) {
  const list = config.roots.filter((r) => !only || r.rootId === only);
  return list.map((r) => ({ ...r, absPath: path.resolve(r.path) }));
}
let activeRoots = [];

// ---------------------------------------------------------------- scanner core

const counters = {
  dirsCompleted: 0,
  dirsError: 0,
  dirsBlockedDepth: 0,
  dirsSkippedGenerated: 0,
  entries: 0,
  bytes: 0,
  links: 0,
  linkBoundary: 0,
  linkCanonical: 0,
  errors: 0,
  resumedSkippedDirs: 0,
  startAt: Date.now(),
};
let stopping = false;
let sinceCheckpoint = 0;

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

let persistMode = true;

function errorEvent({ rootId, absPath, relPath, parentId, phase, err }) {
  counters.errors += 1;
  if (!persistMode) return;
  errorLog.append([JSON.stringify({
    runId,
    eventId: idOf('err', `${rootId}\u0000${relPath}\u0000${counters.errors}\u0000${Date.now()}`),
    rootId,
    path: absPath,
    relPath,
    parentId: parentId ?? null,
    phase,
    code: err?.code ?? 'UNKNOWN',
    message: err?.message ?? String(err),
    observedAt: nowIso(),
    disposition: 'ERROR_RETAINED_UNRESOLVED',
  })]);
}

function writeBatch(dirId, lines) {
  if (!persistMode) return;
  const dest = path.join(batchDir, `${dirId}.jsonl`);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  try {
    fs.renameSync(tmp, dest);
  } catch {
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  }
}

function scanDir(dir) {
  const abs = dir.absPath;
  const observedAt = nowIso();
  let dirents;
  try {
    dirents = fs.readdirSync(sysPath(abs), { withFileTypes: true });
  } catch (e) {
    errorEvent({ rootId: dir.rootId, absPath: abs, relPath: dir.relPath, parentId: dir.parentId, phase: 'readdir', err: e });
    counters.dirsError += 1;
    receiptLog.append([JSON.stringify({
      runId, rootId: dir.rootId, dirId: dir.dirId, relPath: dir.relPath, absPath: abs,
      state: 'ERROR', entryCount: 0, unknownDescendantCount: null, error: { code: e.code ?? 'UNKNOWN', message: e.message },
      startedAt: observedAt, completedAt: nowIso(),
    })]);
    return;
  }

  const lines = [];
  const childDirs = [];
  for (const d of dirents) {
    const childAbs = path.join(abs, d.name);
    const childRel = path.join(dir.relPath, d.name);
    let st = null;
    let statErr = null;
    try {
      st = fs.lstatSync(sysPath(childAbs));
    } catch (e) {
      statErr = e;
    }
    const statFailed = statErr !== null;
    const isLink = st ? st.isSymbolicLink() : d.isSymbolicLink();
    const isDir = st ? st.isDirectory() : (!isLink && d.isDirectory());
    const isFile = st ? st.isFile() : (!isLink && d.isFile());
    let type = 'other';
    if (isLink) type = 'reparse-point';
    else if (isDir) type = 'directory';
    else if (isFile) type = 'file';

    let linkTarget = null;
    let linkCanonicalRel = null;
    let linkBoundary = null;
    if (isLink) {
      counters.links += 1;
      try {
        linkTarget = fs.readlinkSync(sysPath(childAbs));
        const resolved = path.resolve(path.dirname(childAbs), linkTarget);
        const relToRoot = path.relative(dir.rootAbsPath, resolved);
        const insideRoot = !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot);
        if (insideRoot) {
          try {
            const real = fs.realpathSync(sysPath(resolved));
            const realRel = path.relative(dir.rootAbsPath, real);
            const realInside = !realRel.startsWith('..') && !path.isAbsolute(realRel);
            if (realInside) {
              linkCanonicalRel = realRel === '' ? '.' : realRel;
              counters.linkCanonical += 1;
            } else {
              linkBoundary = 'CANONICAL_TARGET_OUTSIDE_ROOT';
              counters.linkBoundary += 1;
            }
          } catch {
            linkBoundary = 'INTERNAL_TARGET_UNRESOLVED';
            counters.linkBoundary += 1;
          }
        } else {
          linkBoundary = 'TARGET_OUTSIDE_ROOT';
          counters.linkBoundary += 1;
        }
      } catch (e) {
        linkBoundary = 'LINK_TARGET_UNREADABLE';
        counters.linkBoundary += 1;
        errorEvent({ rootId: dir.rootId, absPath: childAbs, relPath: childRel, parentId: dir.dirId, phase: 'readlink', err: e });
      }
    }

    const own = policyFor({ rootId: dir.rootId, relPath: childRel, name: d.name, skillRelativeName: skillRelativeNameFor(dir.root, childAbs) });
    const ownPolicy = own ?? POLICY_DEFAULT;
    const effective = ownPolicy.precedence >= dir.contentPolicyPrecedence ? ownPolicy : { id: dir.contentPolicy, precedence: dir.contentPolicyPrecedence };
    const inheritedFrom = effective.id === ownPolicy.id ? null : dir.contentPolicyRef;

    const generated = effective.id === 'GENERATED_BY_THIS_RUN';
    const depth = dir.depth + 1;
    let depthBlocked = false;
    if (depth > maxDepth) depthBlocked = true;

    const record = {
      runId,
      entryId: idOf(dir.rootId, childRel),
      parentId: dir.dirId,
      rootId: dir.rootId,
      path: childAbs,
      relPath: childRel,
      name: d.name,
      type,
      size: isFile && st ? st.size : null,
      mtime: st ? st.mtime.toISOString() : null,
      ctime: st ? st.ctime.toISOString() : null,
      depth,
      observedAt,
      disposition: statFailed ? 'STAT_ERROR_RETAINED' : 'INVENTORIED',
      contentPolicy: effective.id,
      policyRef: ownPolicy.id === 'ALLOWED' ? (inheritedFrom ?? 'DEFAULT') : ownPolicy.id,
      inheritedFrom,
      error: statFailed ? { code: statErr.code ?? 'UNKNOWN', message: statErr.message } : null,
      contentHash: null,
      physicalIdAvailable: Boolean(st && (st.ino !== 0 || st.dev !== 0)),
      ino: st && st.ino !== 0 ? String(st.ino) : null,
      dev: st && st.dev !== 0 ? String(st.dev) : null,
      linkTarget,
      linkCanonicalRel,
      linkBoundary,
    };

    if (statFailed) {
      errorEvent({ rootId: dir.rootId, absPath: childAbs, relPath: childRel, parentId: dir.dirId, phase: 'lstat', err: statErr });
    }

    lines.push(JSON.stringify(record));
    counters.entries += 1;
    if (record.size) counters.bytes += record.size;

    if (isDir && !isLink && !generated) {
      if (depthBlocked) {
        depthBlocked = true;
        counters.dirsBlockedDepth += 1;
        receiptLog.append([JSON.stringify({
          runId, rootId: dir.rootId, dirId: idOf(dir.rootId, childRel), relPath: childRel, absPath: childAbs,
          state: 'BLOCKED_RESOURCE_LIMIT', entryCount: 0, unknownDescendantCount: null,
          error: { code: 'MAX_DEPTH_REACHED', message: `depth ${depth} exceeds maxDepth ${maxDepth}` },
          startedAt: observedAt, completedAt: nowIso(),
        })]);
        errorLog.append([JSON.stringify({
          runId,
          eventId: idOf('err', `${dir.rootId}\u0000${childRel}\u0000depth`),
          rootId: dir.rootId, path: childAbs, relPath: childRel, parentId: dir.dirId,
          phase: 'depth-gate', code: 'BLOCKED_RESOURCE_LIMIT',
          message: `not enumerated: depth ${depth} > maxDepth ${maxDepth}`,
          observedAt: nowIso(), disposition: 'ERROR_RETAINED_UNRESOLVED',
        })]);
      } else {
        childDirs.push({
          rootId: dir.rootId,
          dirId: idOf(dir.rootId, childRel),
          relPath: childRel,
          absPath: childAbs,
          parentId: dir.dirId,
          depth,
          root: dir.root,
          rootAbsPath: dir.rootAbsPath,
          contentPolicy: effective.id,
          contentPolicyPrecedence: effective.precedence,
          contentPolicyRef: effective.id,
        });
      }
    } else if (isDir && !isLink && generated) {
      counters.dirsSkippedGenerated += 1;
    }
  }

  writeBatch(dir.dirId, lines);

  if (childDirs.length) {
    discoveredLog.append(childDirs.map((c) => JSON.stringify({
      runId, rootId: c.rootId, dirId: c.dirId, relPath: c.relPath, absPath: c.absPath,
      parentId: c.parentId, depth: c.depth,
      contentPolicy: c.contentPolicy, contentPolicyPrecedence: c.contentPolicyPrecedence,
      discoveredAt: nowIso(),
    })));
  }

  receiptLog.append([JSON.stringify({
    runId, rootId: dir.rootId, dirId: dir.dirId, relPath: dir.relPath, absPath: abs,
    state: 'COMPLETE', entryCount: lines.length, unknownDescendantCount: 0,
    error: null, startedAt: observedAt, completedAt: nowIso(),
  })]);
  counters.dirsCompleted += 1;

  return childDirs;
}

function deriveFrontier() {
  const discovered = readJsonl(P.discovered);
  const receipts = readJsonl(P.dirs);
  const completed = new Set(receipts.map((r) => r.dirId));
  const seen = new Set();
  const pending = [];
  for (const d of discovered) {
    if (seen.has(d.dirId)) continue;
    seen.add(d.dirId);
    if (completed.has(d.dirId)) continue;
    pending.push(d);
  }
  return { discovered: seen.size, receipts, completed, pending };
}

function writeProgress(extra = {}) {
  const elapsedMs = Date.now() - counters.startAt;
  const payload = {
    runId,
    state: stopping ? 'STOPPING' : 'RUNNING',
    updatedAt: nowIso(),
    counters: { ...counters, elapsedMs },
    entriesPerSecond: elapsedMs > 0 ? Number((counters.entries / (elapsedMs / 1000)).toFixed(1)) : 0,
    ...extra,
  };
  fs.writeFileSync(P.progress, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function writeFrontier(final = false) {
  const d = deriveFrontier();
  const sample = d.pending.slice(0, 1000).map((p) => ({ rootId: p.rootId, relPath: p.relPath, depth: p.depth, dirId: p.dirId }));
  const payload = {
    runId,
    generatedAt: nowIso(),
    final,
    roots: activeRoots.map((r) => ({ rootId: r.rootId, path: r.absPath })),
    discoveredDirs: d.discovered,
    completedDirs: d.completed.size,
    pendingCount: d.pending.length,
    pendingSampleLimit: 1000,
    pending: sample,
    pendingTruncated: d.pending.length > sample.length,
    state: d.pending.length === 0 ? 'EMPTY' : 'NON_EMPTY',
    note: d.pending.length === 0
      ? 'frontier reconciled empty for the roots that were actually scanned'
      : 'frontier non-empty: discovery is incomplete and must not be reported as full discovery PASS',
  };
  fs.writeFileSync(P.frontier, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function runScan({ persist }) {
  persistMode = persist;
  if (persist) ensureDirs();
  const state = persist ? deriveFrontier() : { completed: new Set(), pending: [] };

  const rootRecords = [];
  for (const r of activeRoots) {
    const rootRel = '.';
    const rootId = idOf(r.rootId, rootRel);
    let st = null;
    let err = null;
    try {
      st = fs.lstatSync(sysPath(r.absPath));
    } catch (e) {
      err = e;
    }
    rootRecords.push({
      rootId: r.rootId, path: r.absPath, absPath: r.absPath, relPath: rootRel, dirId: rootId,
      parentId: null, depth: 0, root: r, rootAbsPath: r.absPath,
      contentPolicy: 'ALLOWED', contentPolicyPrecedence: 0, contentPolicyRef: 'DEFAULT',
      present: st !== null, kind: st && st.isDirectory() ? 'directory' : (st ? 'not-a-directory' : 'missing'),
      error: err ? { code: err.code ?? 'UNKNOWN', message: err.message } : null,
    });
  }

  if (persist) {
    fs.writeFileSync(P.roots, `${JSON.stringify({
      runId, recordedAt: nowIso(),
      roots: rootRecords.map((r) => ({
        rootId: r.rootId, path: r.path, kind: r.root.kind, supplemental: r.root.supplemental === true,
        provenance: r.root.provenance, present: r.present, entryKind: r.kind, error: r.error,
      })),
    }, null, 2)}\n`, 'utf8');
  }

  for (const rr of rootRecords) {
    if (!rr.present || rr.kind !== 'directory') {
      const err = rr.error ?? { code: 'NOT_A_DIRECTORY', message: `root is ${rr.kind}` };
      errorEvent({ rootId: rr.rootId, absPath: rr.path, relPath: '.', parentId: null, phase: 'root', err });
      receiptLog.append([JSON.stringify({
        runId, rootId: rr.rootId, dirId: rr.dirId, relPath: '.', absPath: rr.path,
        state: 'ERROR', entryCount: 0, unknownDescendantCount: null,
        error: { code: err.code, message: err.message }, startedAt: nowIso(), completedAt: nowIso(),
      })]);
      counters.dirsError += 1;
    }
  }

  const rootById = new Map(activeRoots.map((r) => [r.rootId, r]));
  const done = new Set(state.completed);
  const stack = [];
  // Seed from the persisted frontier first: discovered-but-unreceipted dirs from
  // earlier interrupted runs must be re-queued or resume can never finish.
  // Push in reverse discovery order so the earliest-discovered dir pops first.
  for (let i = state.pending.length - 1; i >= 0; i -= 1) {
    const p = state.pending[i];
    const root = rootById.get(p.rootId);
    if (!root) {
      errorEvent({ rootId: p.rootId, absPath: p.absPath, relPath: p.relPath, parentId: p.parentId, phase: 'resume', err: { code: 'UNKNOWN_ROOT_IN_FRONTIER', message: 'frontier dir belongs to a root not active in this run' } });
      continue;
    }
    stack.push({
      rootId: p.rootId, dirId: p.dirId, relPath: p.relPath, absPath: p.absPath,
      parentId: p.parentId, depth: p.depth, root, rootAbsPath: root.absPath,
      contentPolicy: p.contentPolicy, contentPolicyPrecedence: p.contentPolicyPrecedence,
      contentPolicyRef: p.contentPolicy,
    });
  }
  for (const rr of rootRecords) {
    if (!rr.present || rr.kind !== 'directory') continue;
    if (done.has(rr.dirId)) {
      counters.resumedSkippedDirs += 1;
      continue;
    }
    stack.push(rr);
  }
  let attempted = 0;


  while (stack.length) {
    if (stopping) break;
    if (args.maxDirs !== null && attempted >= args.maxDirs) break;
    const dir = stack.pop();
    attempted += 1;
    if (persist && done.has(dir.dirId)) {
      counters.resumedSkippedDirs += 1;
      continue;
    }
    const children = scanDir(dir);
    done.add(dir.dirId);
    if (children) {
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
    sinceCheckpoint += 1;
    if (persist && sinceCheckpoint >= 100) {
      sinceCheckpoint = 0;
      writeProgress();
    }
    if (!args.quiet && persist && counters.dirsCompleted % 5000 === 0 && counters.dirsCompleted > 0) {
      const p = writeProgress();
      process.stdout.write(
        `[scan] dirs=${p.counters.dirsCompleted} entries=${p.counters.entries} errors=${p.counters.errors} pending=${stack.length} elapsed=${(p.counters.elapsedMs / 1000).toFixed(0)}s\n`,
      );
    }
  }

  const frontier = persist ? writeFrontier(stack.length === 0) : null;
  const progress = persist
    ? writeProgress({ remainingInMemoryStack: stack.length, interrupted: stopping, maxDirsReached: args.maxDirs !== null && attempted >= args.maxDirs })
    : { counters: { ...counters, elapsedMs: Date.now() - counters.startAt }, remainingInMemoryStack: stack.length, interrupted: stopping, maxDirsReached: args.maxDirs !== null && attempted >= args.maxDirs };
  return { progress, frontier, attempted };
}

// ---------------------------------------------------------------- aggregate

function aggregate() {
  ensureDirs();
  const files = fs.readdirSync(batchDir).filter((f) => f.endsWith('.jsonl')).sort();
  const out = fs.openSync(P.inventory, 'w');
  const byRoot = new Map();
  const byPolicy = new Map();
  const byType = new Map();
  const byDisposition = new Map();
  const dirStates = new Map();
  let entries = 0;
  let bytes = 0;
  let rootEntries = 0;
  const lineBuf = [];
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const f of files) {
    const raw = fs.readFileSync(path.join(batchDir, f), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      lineBuf.push(line);
      entries += 1;
      if (typeof rec.size === 'number') bytes += rec.size;
      bump(byRoot, rec.rootId);
      bump(byPolicy, rec.contentPolicy);
      bump(byType, rec.type);
      bump(byDisposition, rec.disposition);
      if (rec.relPath === '.') rootEntries += 1;
      if (lineBuf.length >= 2000) {
        fs.writeSync(out, `${lineBuf.join('\n')}\n`);
        lineBuf.length = 0;
      }
    }
  }
  if (lineBuf.length) fs.writeSync(out, `${lineBuf.join('\n')}\n`);
  const inventoryBytes = fs.fstatSync(out).size;
  fs.closeSync(out);

  for (const r of readJsonl(P.dirs)) {
    const prev = dirStates.get(r.dirId);
    if (!prev || r.state === 'COMPLETE') dirStates.set(r.dirId, r);
  }
  const stateCounts = new Map();
  let unknownDescendants = 0;
  for (const r of dirStates.values()) {
    bump(stateCounts, r.state);
    if (r.state !== 'COMPLETE') unknownDescendants += 1;
  }

  const errors = readJsonl(P.errors);
  const errByCode = new Map();
  for (const e of errors) bump(errByCode, e.code);

  const unresolvedRoots = readJson(P.roots)?.roots?.filter((r) => !r.present) ?? [];
  const frontier = writeFrontier(false);
  const archiveMembers = fs.existsSync(P.archiveMembers) ? countLines(P.archiveMembers) : 0;

  const summary = {
    runId,
    policyVersion,
    generatedAt: nowIso(),
    aggregateFrom: { batchFiles: files.length, directoryReceipts: dirStates.size },
    physical: {
      entries,
      files: byType.get('file') ?? 0,
      directories: byType.get('directory') ?? 0,
      reparsePoints: byType.get('reparse-point') ?? 0,
      other: byType.get('other') ?? 0,
      logicalBytes: bytes,
      rootDirectoryEntriesIncluded: rootEntries,
      denominatorDefinition: 'every entry observed in a scanned directory, including dependency trees, derived build output and generated-by-this-run paths',
      sizeSemantics: 'logical bytes from lstat; disk allocation not claimed',
    },
    virtual: {
      archiveMembers,
      denominatorDefinition: 'members enumerated inside archive containers; counted separately from physical paths',
    },
    byRoot: Object.fromEntries([...byRoot.entries()].sort()),
    byContentPolicy: Object.fromEntries([...byPolicy.entries()].sort()),
    byDisposition: Object.fromEntries([...byDisposition.entries()].sort()),
    directoryReceipts: Object.fromEntries([...stateCounts.entries()].sort()),
    directoriesWithoutCompleteReceipt: unknownDescendants,
    unknownRegionsDefinition: 'directories whose receipt state is not COMPLETE (ERROR or BLOCKED_RESOURCE_LIMIT); descendant count is not estimated',
    errors: { total: errors.length, byCode: Object.fromEntries([...errByCode.entries()].sort()) },
    missingRoots: unresolvedRoots,
    frontier: {
      state: frontier.state,
      discoveredDirs: frontier.discoveredDirs,
      completedDirs: frontier.completedDirs,
      pendingCount: frontier.pendingCount,
    },
    coverageClaim: frontier.state === 'EMPTY' && unknownDescendants === 0 && unresolvedRoots.length === 0
      ? 'SCOPE_SCANNED_WITHOUT_RESIDUAL_FRONTIER'
      : 'INCOMPLETE_RESIDUAL_OR_UNKNOWN_REGIONS_PRESENT',
    artifactBytes: { inventory: inventoryBytes },
  };
  fs.writeFileSync(P.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

// ---------------------------------------------------------------- archive mode

function enumerateArchives() {
  ensureDirs();
  if (!fs.existsSync(P.inventory)) throw new Error('inventory.jsonl not found; run aggregate first');
  const limits = {
    maxArchiveMembers: config.scanSemantics.maxArchiveMembers,
    maxArchiveBytes: config.scanSemantics.maxArchiveBytes,
    maxCentralDirectoryBytes: 67108864,
  };
  const exts = config.archiveExtensions;
  const out = fs.openSync(P.archiveMembers, 'w');
  let containers = 0;
  let membersTotal = 0;
  const blocked = [];
  const byExt = new Map();
  const buf = [];
  // Stream inventory.jsonl: the ledger can exceed the max string length.
  const ifd = fs.openSync(P.inventory, 'r');
  const CHUNK = 8 * 1024 * 1024;
  const chunkBuf = Buffer.alloc(CHUNK);
  let carry = '';
  const processLine = (line) => {
    if (!line) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec.type !== 'file') return;
    if (rec.contentPolicy === 'GENERATED_BY_THIS_RUN' || rec.contentPolicy === 'RESTRICTED_METADATA_ONLY') return;
    const lower = rec.name.toLowerCase();
    const ext = exts.find((e) => lower.endsWith(e));
    if (!ext) return;
    if (rec.size !== null && rec.size > limits.maxArchiveBytes) {
      blocked.push({ container: rec.path, code: 'BLOCKED_RESOURCE_LIMIT', detail: `container ${rec.size} bytes exceeds limit ${limits.maxArchiveBytes}` });
      return;
    }
    containers += 1;
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    let result;
    if (['.zip', '.jar', '.vsix', '.nupkg', '.whl', '.epub'].includes(ext)) result = readZipMembers(rec.path, limits);
    else result = readTarMembers(rec.path, limits);
    if (result.blocked) blocked.push({ container: rec.path, ...result.blocked });
    for (const m of result.members) {
      membersTotal += 1;
      buf.push(JSON.stringify({
        runId,
        containerEntryId: rec.entryId,
        containerPath: rec.path,
        containerPolicy: rec.contentPolicy,
        containerBytes: rec.size,
        archiveFormat: ext,
        observedAt: nowIso(),
        ...m,
        disposition: m.encrypted ? 'ENCRYPTED_MEMBER_METADATA_ONLY' : 'MEMBER_INVENTORIED',
      }));
      if (buf.length >= 2000) {
        fs.writeSync(out, `${buf.join('\n')}\n`);
        buf.length = 0;
      }
    }
    for (const n of result.notes) blocked.push({ container: rec.path, ...n });
  };
  let nread;
  while ((nread = fs.readSync(ifd, chunkBuf, 0, CHUNK, null)) > 0) {
    carry += chunkBuf.toString('utf8', 0, nread);
    let idx;
    while ((idx = carry.indexOf('\n')) >= 0) {
      processLine(carry.slice(0, idx).replace(/\r$/, ''));
      carry = carry.slice(idx + 1);
    }
  }
  if (carry) processLine(carry.replace(/\r$/, ''));
  fs.closeSync(ifd);
  if (buf.length) fs.writeSync(out, `${buf.join('\n')}\n`);
  fs.closeSync(out);
  return {
    runId,
    generatedAt: nowIso(),
    containers,
    containersByExtension: Object.fromEntries([...byExt.entries()].sort()),
    members: membersTotal,
    blockers: blocked,
    note: 'members are enumerated read-only; no extraction, execution, decryption or network hydration was performed',
  };
}

// ---------------------------------------------------------------- main

function main() {
  if (args.mode === 'aggregate') {
    const s = aggregate();
    process.stdout.write(`${JSON.stringify({
      mode: 'aggregate',
      entries: s.physical.entries,
      logicalBytes: s.physical.logicalBytes,
      directories: s.physical.directories,
      files: s.physical.files,
      reparsePoints: s.physical.reparsePoints,
      archiveMembers: s.virtual.archiveMembers,
      errors: s.errors.total,
      directoriesWithoutCompleteReceipt: s.directoriesWithoutCompleteReceipt,
      frontier: s.frontier,
      coverageClaim: s.coverageClaim,
    }, null, 2)}\n`);
    return;
  }
  if (args.mode === 'archive') {
    const r = enumerateArchives();
    fs.writeFileSync(path.join(outDir, 'archive-summary.json'), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }

  activeRoots = rootsFor(args.root);
  if (!activeRoots.length) throw new Error(`no roots matched --root ${args.root}`);

  if (args.mode === 'probe') {
    counters.startAt = Date.now();
    const res = runScan({ persist: false });
    process.stdout.write(`${JSON.stringify({
      mode: 'probe',
      roots: activeRoots.map((r) => r.rootId),
      counters: res.progress.counters,
      remainingInMemoryStack: res.progress.remainingInMemoryStack,
      note: 'probe mode writes no persistent state; its counts are not a coverage claim',
    }, null, 2)}\n`);
    return;
  }

  const onSignal = (sig) => {
    if (stopping) {
      writeProgress({ forcedExit: true });
      process.exit(130);
    }
    stopping = true;
    process.stdout.write(`[scan] received ${sig}; finishing current directory then checkpointing\n`);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const res = runScan({ persist: true });
  process.stdout.write(`${JSON.stringify({
    mode: 'run',
    runId,
    roots: activeRoots.map((r) => r.rootId),
    counters: res.progress.counters,
    remainingInMemoryStack: res.progress.remainingInMemoryStack,
    interrupted: res.progress.interrupted,
    maxDirsReached: res.progress.maxDirsReached,
    frontier: res.frontier,
  }, null, 2)}\n`);
}

main();
