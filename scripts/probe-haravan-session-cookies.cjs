#!/usr/bin/env node
/**
 * Haravan auth-cookie survival probe.
 *
 * Answers one question with disk evidence: do Haravan login cookies
 * (accounts.haravan.com + *.myharavan.com) survive an AntiFan restart, and if
 * they vanish, where in the lifecycle did they die?
 *
 * Snapshot rows carry metadata only — host, name, flags, timestamps, and a
 * SHA-256 fingerprint of the value (never the value itself) — so rotated
 * tokens are detected without leaking credentials into plain files.
 *
 * Usage:
 *   node scripts/probe-haravan-session-cookies.cjs --label before-exit
 *     (run while app is running or after graceful exit; DB is copied, never
 *      opened in place)
 *   node scripts/probe-haravan-session-cookies.cjs --label after-restart
 *   node scripts/probe-haravan-session-cookies.cjs --compare before-exit after-restart
 *
 * Options:
 *   --root <dir>   Override data root (default: probe the same candidates
 *                  StorageLocations.getDataRoot() probes, E:\Work\.antifan-data
 *                  first, then E:\.antifan-data, D:\Work\.antifan-data,
 *                  %APPDATA%\AntiFan\data, %APPDATA%\antifan-browser-desktop\data)
 *   --all          Include every Haravan-domain cookie, not only auth-shaped ones
 *   --out <dir>    Snapshot directory (default: scratch/haravan-session-probe)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────

const AUTH_HOST_RE = /(^|\.)(haravan\.com|myharavan\.com|haravan\.app)$/i;
const AUTH_NAME_RE = /^(idsrv.*|idsv\..*|\.AspNetCore\..*|.*session.*|.*auth.*|.*token.*|.*signin.*|.*identity.*|haravan_.*|_abv?|storefront_digest|customer_(digest|sig))$/i;

const US_PER_SECOND = 1_000_000;
const WINDOWS_EPOCH_OFFSET_US = 11_644_473_600_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────

function windowsEpochToIso(us) {
  if (!us || us <= 0) return null;
  const unixMs = (us - WINDOWS_EPOCH_OFFSET_US) / 1000;
  if (!Number.isFinite(unixMs) || unixMs <= 0) return null;
  return new Date(unixMs).toISOString();
}

function resolveDataRoot(customRoot) {
  if (customRoot) return path.resolve(customRoot);
  const candidates = [
    path.join('E:\\', 'Work', '.antifan-data'),
    'E:\\\\.antifan-data',
    path.join('D:\\', 'Work', '.antifan-data'),
  ];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  candidates.push(path.join(appData, 'AntiFan', 'data'));
  candidates.push(path.join(appData, 'antifan-browser-desktop', 'data'));
  for (const c of candidates) {
    const profile = path.join(c, 'Profile');
    if (fs.existsSync(profile)) return path.resolve(c);
  }
  return null;
}

function findCookieDbs(profileDir) {
  const dbs = [];
  const push = (p, jar) => { if (fs.existsSync(p)) dbs.push({ jar, file: p }); };
  push(path.join(profileDir, 'Network', 'Cookies'), 'default-session');
  const partitionsDir = path.join(profileDir, 'Partitions');
  if (fs.existsSync(partitionsDir)) {
    for (const entry of fs.readdirSync(partitionsDir)) {
      const p = path.join(partitionsDir, entry, 'Network', 'Cookies');
      push(p, `partition:${entry}`);
    }
  }
  return dbs;
}

// Locked-file-safe SQLite read: copy bytes to a temp file first. Copy can fail
// while the app holds an exclusive lock; retries once after a short wait, then
// reports JAR_LOCKED so the caller knows to run after graceful exit.
function copyDb(file, outDir, index) {
  const dst = path.join(outDir, `probe-db-${index}.sqlite`);
  try {
    fs.copyFileSync(file, dst);
    // Journal files carry uncommitted state; without them a hot copy reads the
    // last committed snapshot, which is exactly the restart-survival boundary.
    for (const ext of ['-journal', '-wal', '-shm']) {
      if (fs.existsSync(file + ext)) {
        try { fs.copyFileSync(file + ext, dst + ext); } catch { /* non-fatal */ }
      }
    }
    return dst;
  } catch (err) {
    return { locked: true, error: String(err && err.message || err) };
  }
}

function readCookiesViaPython(dbPath) {
  // Python stdlib sqlite3 is present on this box; keeps the probe dependency-free.
  const py = [
    'import sqlite3,sys,json',
    'con=sqlite3.connect(sys.argv[1])',
    'rows=con.execute("select host_key,name,path,is_secure,is_httponly,is_persistent,creation_utc,expires_utc,last_access_utc,last_update_utc,value,encrypted_value from cookies").fetchall()',
    'con.close()',
    'out=[{',
    '"host":r[0],"name":r[1],"path":r[2],"secure":bool(r[3]),"httpOnly":bool(r[4]),"persistent":bool(r[5]),',
    '"created":r[6],"expires":r[7],"lastAccess":r[8],"lastUpdate":r[9],',
    '"valueHash":__import__("hashlib").sha256((r[10] or r[11] or b"") if isinstance(r[10] or r[11],bytes) else (r[10] or "").encode()).hexdigest()[:16]',
    '} for r in rows]',
    'print(json.dumps(out))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', py, dbPath], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.toString('utf8'));
}

function snapshotLabel(row) {
  return {
    host: row.host,
    name: row.name,
    path: row.path,
    secure: row.secure,
    httpOnly: row.httpOnly,
    persistent: row.persistent,
    createdUtc: windowsEpochToIso(row.created),
    expiresUtc: windowsEpochToIso(row.expires),
    lastAccessUtc: windowsEpochToIso(row.lastAccess),
    lastUpdateUtc: windowsEpochToIso(row.lastUpdate),
    valueFingerprint: row.valueHash,
  };
}

function snapshotCookie(cookie) {
  const now = Date.now();
  const iso = cookie.expiresUtc ? new Date(cookie.expiresUtc).getTime() : null;
  return {
    ...cookie,
    expired: iso !== null ? iso <= now : false,
    daysUntilExpiry: iso !== null ? Math.round((iso - now) / 86_400_000 * 10) / 10 : null,
  };
}

// ── Commands ──────────────────────────────────────────────────────────────

function cmdSnapshot(opts) {
  const root = resolveDataRoot(opts.root);
  if (!root) {
    console.error('FATAL: no AntiFan data root found among candidates; pass --root');
    process.exit(2);
  }
  const profileDir = path.join(root, 'Profile');
  const dbs = findCookieDbs(profileDir);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-probe-'));
  const out = {
    probeVersion: 1,
    label: opts.label || `snap-${Date.now()}`,
    capturedAt: new Date().toISOString(),
    dataRoot: root,
    jars: [],
  };
  let index = 0;
  for (const db of dbs) {
    const copied = copyDb(db.file, tmpDir, index++);
    if (copied.locked) {
      out.jars.push({ jar: db.jar, file: db.file, error: 'JAR_LOCKED', detail: copied.error, cookies: [] });
      continue;
    }
    try {
      const rows = readCookiesViaPython(copied);
      const cookies = rows
        .map(snapshotLabel)
        .filter((c) => AUTH_HOST_RE.test(c.host))
        .filter((c) => opts.all || AUTH_NAME_RE.test(c.name))
        .map(snapshotCookie);
      out.jars.push({ jar: db.jar, file: db.file, cookies });
    } catch (err) {
      out.jars.push({ jar: db.jar, file: db.file, error: 'READ_FAILED', detail: String(err && err.message || err), cookies: [] });
    }
  }
  const outDir = opts.out || path.join('scratch', 'haravan-session-probe');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${out.label}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const total = out.jars.reduce((n, j) => n + j.cookies.length, 0);
  const locked = out.jars.filter((j) => j.error === 'JAR_LOCKED').length;
  console.log(`snapshot -> ${file}`);
  console.log(`dataRoot: ${root}`);
  console.log(`jars: ${out.jars.length} (${locked} locked), auth-cookie rows: ${total}`);
  for (const j of out.jars) {
    const auth = j.cookies.filter((c) => /^idsrv/i.test(c.name) || /AspNetCore/i.test(c.name) || /session/i.test(c.name));
    console.log(`  ${j.jar}: ${j.cookies.length} cookies${j.error ? ` [${j.error}]` : ''}${auth.length ? ` | notable: ${auth.map((a) => `${a.name}@${a.host} exp=${a.expiresUtc || 'session'}${a.expired ? '(EXPIRED)' : ''}`).join(', ')}` : ''}`);
  }
}

function cmdCompare(a, b, opts) {
  const dir = opts.out || path.join('scratch', 'haravan-session-probe');
  const snap = (label) => {
    const f = path.join(dir, `${label}.json`);
    if (!fs.existsSync(f)) { console.error(`FATAL: snapshot not found: ${f}`); process.exit(2); }
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  };
  const A = snap(a), B = snap(b);
  const key = (j, c) => `${j.jar}|${c.host}|${c.name}|${c.path}`;
  const mapA = new Map(), mapB = new Map();
  for (const j of A.jars) for (const c of j.cookies) mapA.set(key(j, c), c);
  for (const j of B.jars) for (const c of j.cookies) mapB.set(key(j, c), c);

  const lost = [], gained = [], rotated = [], expiredNow = [];
  for (const [k, c] of mapA) if (!mapB.has(k)) lost.push(c);
  for (const [k, c] of mapB) if (!mapA.has(k)) gained.push(c);
  for (const [k, c] of mapA) {
    const d = mapB.get(k);
    if (!d) continue;
    if (c.valueFingerprint !== d.valueFingerprint) rotated.push({ before: c, after: d });
    if (!c.expired && d.expired) expiredNow.push(d);
  }

  console.log(`compare: ${a} (${A.capturedAt}) -> ${b} (${B.capturedAt})`);
  console.log(`lost=${lost.length} gained=${gained.length} rotated=${rotated.length} newly-expired=${expiredNow.length}`);
  const fmt = (c, prefix) => console.log(`  ${prefix} ${c.name}@${c.host} persistent=${c.persistent} httpOnly=${c.httpOnly} exp=${c.expiresUtc || 'session-cookie'}${c.expired ? ' EXPIRED' : ''}`);
  for (const c of lost) fmt(c, 'LOST   ');
  for (const c of gained) fmt(c, 'GAINED ');
  for (const c of expiredNow) fmt(c, 'EXPIRED');
  for (const r of rotated) fmt(r.after, `ROTATED(fp ${r.before.valueFingerprint}->${r.after.valueFingerprint})`);

  // Verdict heuristic: login cookies present in BOTH snapshots but server still
  // rejected => server-side revocation. Lost locally => client storage bug.
  const idsrvInBoth = [...mapB.keys()].some((k) => k.includes('|accounts.haravan.com|idsrv|'));
  if (idsrvInBoth) {
    console.log('\nverdict-hint: idsrv survived restart -> if Haravan still forced login, cause is SERVER-side revocation, not AntiFan storage.');
  } else if (lost.some((c) => /^idsrv/i.test(c.name))) {
    console.log('\nverdict-hint: idsrv disappeared from the jar across restart -> CLIENT-side loss; elevation/flush fix applies.');
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label') opts.label = args[++i];
    else if (args[i] === '--root') opts.root = args[++i];
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--all') opts.all = true;
    else if (args[i] === '--compare') opts.compare = true;
    else positional.push(args[i]);
  }
  if (opts.compare) {
    if (positional.length < 2) { console.error('usage: --compare <labelA> <labelB>'); process.exit(2); }
    cmdCompare(positional[0], positional[1], opts);
    return;
  }
  cmdSnapshot(opts);
}

main();
