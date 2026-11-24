#!/usr/bin/env node
// otp-fetch.mjs - read the newest Haravan OTP from the otp-inbox Worker into the Windows clipboard, never onto a screen.
//
// A worker that has to sign in (`hrv login --no-open`) runs this instead of reading the mail itself: the Worker (fed by a Zoho
// webhook for services@f1genz.com) keeps the code for at most 120 s and hands it over exactly once. The code goes straight into
// the clipboard through the stdin of `clip` (never a command line, so no process list or log can hold it) and the worker pastes
// it with Ctrl+V. stdout is ONE json line {found, len, ageSec}; the code, the read key and the mail are never printed.
//
//   node otp-fetch.mjs --now                                                print {now: <epochMs>}: the t0 to take RIGHT BEFORE clicking the "send / resend OTP" button
//   node otp-fetch.mjs --since <t0> [--wait <seconds, default 120>]        wait for a code newer than t0, copy it
//   node otp-fetch.mjs --clear                                              overwrite the clipboard with an empty string
//   node otp-fetch.mjs --lock --job <name> | --renew --job <name> | --unlock --job <name>   machine-wide login lock (one Haravan login at a time, 20 min expiry, --renew restarts it)
//
// The Worker's answer carries `serverNow`; when it does, t0 (a local clock) is converted to the Worker's clock before the next poll and
// stdout reports `skewSec` (server minus local), so a fast or slow local clock cannot make a valid code look old.
//
// Config (contract 24/11/2026): env ANTIFAN_SECRET_OTP_INBOX_URL / ANTIFAN_SECRET_OTP_INBOX_KEY, else the same KEY=VALUE lines in
// %USERPROFILE%/.antifan/otp-inbox.env (outside every repo). Env wins over the file. The URL must be https (the read key travels in a
// Bearer header); only a loopback host may use http (tests).
// Exit: 0 found / cleared / lock taken / renewed / released | 1 no code within --wait | 2 usage (--job missing) or config (not configured: report to the Leader) | 3 the Worker refused (401/HTTP error), the clipboard failed or the lock file failed | 4 login lock held by another job (or, when reading, not held by this --job).
// Reading a code needs `--job <name>` and the login lock held by that job (take it with --lock first): the clipboard and the mailbox are shared, so a job that does not hold the lock may not use them.
//
// Test seams: OTP_FETCH_ENV_FILE (config file path), OTP_FETCH_POLL_MS (poll interval, default 5000), OTP_FETCH_CLIPBOARD_FILE
// (write the code into this file instead of the clipboard), OTP_FETCH_LOCK_FILE (lock file path).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const URL_KEY = "ANTIFAN_SECRET_OTP_INBOX_URL";
const KEY_KEY = "ANTIFAN_SECRET_OTP_INBOX_KEY";
const DEFAULT_WAIT_S = 120;
const DEFAULT_POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
const LOCK_TTL_MS = 20 * 60 * 1000;
const DEFAULT_LOCK_FILE = "E:/Work/scratch/leader/.hrv-login.lock";

/** KEY=VALUE lines; `#` comments and blank lines skipped; one pair of surrounding quotes stripped. */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** {url, key} from the environment, then the config file; missing parts are listed in `missing` (names only, never values). */
export function readConfig(env = process.env) {
  const file = env.OTP_FETCH_ENV_FILE || path.join(env.USERPROFILE || os.homedir(), ".antifan", "otp-inbox.env");
  let fromFile = {};
  try {
    fromFile = parseEnvText(fs.readFileSync(file, "utf8"));
  } catch {}
  const url = (env[URL_KEY] || fromFile[URL_KEY] || "").trim().replace(/\/+$/, "");
  const key = (env[KEY_KEY] || fromFile[KEY_KEY] || "").trim();
  const missing = [url ? null : URL_KEY, key ? null : KEY_KEY].filter(Boolean);
  return { url, key, missing, insecure: url !== "" && !isSecureUrl(url) };
}

/** https, or http on a loopback host (the test Worker). Anything else would send the Bearer key in clear. */
export function isSecureUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Put `text` on the clipboard through stdin (an empty string clears it). Returns true on success. */
export function setClipboard(text, env = process.env) {
  if (env.OTP_FETCH_CLIPBOARD_FILE) {
    fs.writeFileSync(env.OTP_FETCH_CLIPBOARD_FILE, text);
    return true;
  }
  const r = spawnSync("clip", { input: text, windowsHide: true, encoding: "utf8", shell: false });
  return !r.error && r.status === 0;
}

/**
 * One GET /otp. Resolves {kind: "found"|"none"|"unauthorized"|"http"|"network"|"bad"|"burned", serverNow?, skewMs?, ...}; never throws,
 * never carries the key. `skewMs` (Worker clock minus local clock, round trip halved) is present when the Worker sent `serverNow`.
 */
async function readOnce(cfg, since) {
  let res;
  const sentAt = Date.now();
  try {
    res = await fetch(`${cfg.url}/otp?since=${encodeURIComponent(String(Math.round(since)))}`, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { kind: "network" };
  }
  if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
  if (res.status !== 200) return { kind: "http", status: res.status };
  let body;
  try {
    body = await res.json();
  } catch {
    return { kind: "bad" };
  }
  const receivedLocal = Date.now();
  const serverNow = Number.isFinite(body?.serverNow) ? Number(body.serverNow) : null;
  const skewMs = serverNow === null ? undefined : serverNow - (sentAt + receivedLocal) / 2;
  if (!body || body.found !== true) return { kind: "none", skewMs };
  const otp = typeof body.otp === "string" ? body.otp : "";
  if (!/^[A-Za-z0-9]{4,12}$/.test(otp)) return { kind: "burned" }; // found:true but unusable: the Worker already deleted the code
  const receivedAt = Number.isFinite(body.receivedAt) ? Number(body.receivedAt) : null;
  return { kind: "found", otp, receivedAt, skewMs };
}

function parseArgs(argv) {
  const flags = { since: null, wait: DEFAULT_WAIT_S, clear: false, now: false, lock: false, unlock: false, renew: false, job: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--clear") flags.clear = true;
    else if (a === "--now") flags.now = true;
    else if (a === "--lock") flags.lock = true;
    else if (a === "--unlock") flags.unlock = true;
    else if (a === "--renew") flags.renew = true;
    else if (a === "--job") {
      const v = argv[++i];
      if (v === undefined || !/^[\w.-]{1,80}$/.test(v)) return { error: "--job needs the job name (letters, digits, . _ -)" };
      flags.job = v;
    } else if (a === "--since" || a === "--wait") {
      const v = argv[++i];
      if (v === undefined || !/^\d+(\.\d+)?$/.test(v)) return { error: `${a} needs a non-negative number` };
      flags[a.slice(2)] = Number(v);
    } else return { error: `unknown argument ${a.startsWith("-") ? a : "(positional)"}` };
  }
  return { flags };
}

const readLock = (file) => {
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8"));
    return { job: String(h.job ?? "unknown"), pid: Number(h.pid) || null, at: Number(h.at) || 0 };
  } catch {
    return null;
  }
};
const holderView = (h, now) => ({ job: h.job, pid: h.pid, ageSec: Math.max(0, Math.round((now - h.at) / 1000)) });
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` while holding `<file>.guard`, the mutex around every judge-then-replace/delete of the lock (a guard left by a crashed process is
 * dropped after 10 s). Without it, a taker that judged the old lock dead could unlink the live lock a faster taker had just put in its place.
 * Throws (code EBUSY) when the guard stays busy for 2 s.
 */
function withGuard(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const guard = `${file}.guard`;
  const giveUpAt = Date.now() + 2000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(guard, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EACCES") throw e; // EPERM/EACCES: Windows while the other taker's guard is being deleted
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > 10_000) fs.unlinkSync(guard);
      } catch {}
      if (Date.now() > giveUpAt) throw Object.assign(new Error("lock guard busy"), { code: "EBUSY" });
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(guard);
    } catch {}
  }
}

const heldBy = (holder, now) => ({ code: 4, out: { locked: true, ...(holder ? { holder: holderView(holder, now) } : {}) } });

/**
 * The machine-wide Haravan login lock (one login at a time: the clipboard, the services@ mailbox and the accounts.haravan.com session
 * are shared). Created atomically WITH its content (written to a temp file, then hard-linked into place: the link fails when the lock
 * exists, and nobody ever sees a half-written lock); a lock older than 20 minutes is dead and is replaced; the same job may take it again.
 * Replacing a lock that exists happens under the guard mutex, so the check and the delete cannot straddle another taker's replacement.
 * @returns {{code: number, out: object}}
 */
export function takeLock(file, job, now = Date.now()) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ job, pid: process.pid, at: now }));
    const acquired = { code: 0, out: { acquired: true, job, expiresInSec: LOCK_TTL_MS / 1000 } };
    try {
      fs.linkSync(tmp, file);
      return acquired;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    return withGuard(file, () => {
      const holder = readLock(file);
      if (holder && now - holder.at <= LOCK_TTL_MS && holder.job !== job) {
        const r = heldBy(holder, now);
        return { code: r.code, out: { acquired: false, ...r.out } };
      }
      // Expired, unreadable or our own earlier lock, judged under the guard: replace it.
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      try {
        fs.linkSync(tmp, file);
        return acquired;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // A taker found the file missing and created a lock in the gap: that lock is live.
        const r = heldBy(readLock(file), now);
        return { code: r.code, out: { acquired: false, ...r.out } };
      }
    });
  } catch (e) {
    return { code: 3, out: { acquired: false, error: `lock file: ${e.code ?? "error"}` } };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** Restart the 20 minute clock of the lock `job` holds (even one that just expired, while nobody has taken it). Another job's lock, or none: exit 4. */
export function renewLock(file, job, now = Date.now()) {
  const tmp = `${file}.${process.pid}.renew.tmp`;
  try {
    return withGuard(file, () => {
      const holder = readLock(file);
      if (!holder || holder.job !== job) {
        const r = heldBy(holder, now);
        return { code: r.code, out: { renewed: false, held: false, ...r.out } };
      }
      fs.writeFileSync(tmp, JSON.stringify({ job, pid: process.pid, at: now }));
      fs.renameSync(tmp, file);
      return { code: 0, out: { renewed: true, job, expiresInSec: LOCK_TTL_MS / 1000 } };
    });
  } catch (e) {
    return { code: 3, out: { renewed: false, error: `lock file: ${e.code ?? "error"}` } };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** Whether `job` holds a live lock: {ok:true}, or {ok:false, out} with the exit-4 answer for a reader that does not. */
export function checkLockHeld(file, job, now = Date.now()) {
  const holder = readLock(file);
  if (holder && holder.job === job && now - holder.at <= LOCK_TTL_MS) return { ok: true };
  const expiredOwn = holder && holder.job === job;
  const hint = expiredOwn ? "your login lock expired: run --renew --job <name> (or --lock) first" : "this job does not hold the login lock: run --lock --job <name> first";
  return { ok: false, out: { found: false, error: hint, ...(holder && !expiredOwn ? { locked: true, holder: holderView(holder, now) } : { locked: false }) } };
}

/** Release the lock when `job` holds it (or nobody does). Another job's live lock is left alone. */
export function releaseLock(file, job, now = Date.now()) {
  try {
    return withGuard(file, () => {
      const holder = readLock(file);
      if (!holder) {
        try {
          fs.unlinkSync(file); // an unreadable lock file is garbage
        } catch {}
        return { code: 0, out: { released: true, held: false } };
      }
      if (holder.job !== job && now - holder.at <= LOCK_TTL_MS) return { code: 4, out: { released: false, locked: true, holder: holderView(holder, now) } };
      try {
        fs.unlinkSync(file);
      } catch {}
      return { code: 0, out: { released: true, held: true } };
    });
  } catch (e) {
    return { code: 3, out: { released: false, error: `lock file: ${e.code ?? "error"}` } };
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    emit({ found: false, error: parsed.error });
    return 2;
  }
  const { flags } = parsed;
  if (flags.now) {
    emit({ now: Date.now() });
    return 0;
  }
  const lockFile = env.OTP_FETCH_LOCK_FILE || DEFAULT_LOCK_FILE;
  const lockOps = [flags.lock, flags.unlock, flags.renew].filter(Boolean).length;
  if (lockOps > 1) {
    emit({ error: "--lock, --renew and --unlock are three commands: run one" });
    return 2;
  }
  if (!flags.clear && flags.job === null) {
    // A lock command or a read names the job that owns the login (two unnamed jobs would share one lock).
    emit({ error: "--job <name> is required: your job id (the name of your job directory); it names the login lock owner" });
    return 2;
  }
  if (lockOps === 1) {
    const r = flags.lock ? takeLock(lockFile, flags.job) : flags.renew ? renewLock(lockFile, flags.job) : releaseLock(lockFile, flags.job);
    emit(r.out);
    return r.code;
  }
  if (flags.clear) {
    const ok = setClipboard("", env);
    emit({ cleared: ok });
    return ok ? 0 : 3;
  }
  const held = checkLockHeld(lockFile, flags.job);
  if (!held.ok) {
    emit(held.out);
    return 4;
  }
  const cfg = readConfig(env);
  if (cfg.missing.length) {
    emit({ found: false, error: `otp-inbox is not set up on this machine (missing: ${cfg.missing.join(", ")}). Do not search for it: tell the Leader (report STATUS: NEEDS_INPUT and quote this line).` });
    return 2;
  }
  if (cfg.insecure) {
    emit({ found: false, error: `${URL_KEY} must be an https URL (the read key is sent in a Bearer header); only a loopback host may use http` });
    return 2;
  }
  const started = Date.now();
  const since = flags.since ?? started;
  let sinceSent = since; // the t0 in the Worker's clock once the Worker has told us its time
  let skewMs = null;
  const skewField = () => (skewMs === null ? {} : { skewSec: Math.round(skewMs / 1000) });
  const pollMs = Math.max(1, Number(env.OTP_FETCH_POLL_MS) || DEFAULT_POLL_MS);
  const deadline = started + flags.wait * 1000;
  let last = { kind: "none" };
  let fastRepoll = true;
  for (;;) {
    const usedSince = sinceSent;
    last = await readOnce(cfg, usedSince);
    if (last.skewMs !== undefined) {
      skewMs = last.skewMs;
      sinceSent = since + skewMs;
    }
    if (last.kind === "found") {
      // A code the Worker already deleted but that predates t0 in the Worker's clock (local clock slow): not ours, keep waiting for the real one.
      if (skewMs !== null && last.receivedAt !== null && last.receivedAt <= sinceSent) {
        last = { kind: "none" };
      } else {
        if (!setClipboard(last.otp, env)) {
          emit({ found: true, copied: false, len: last.otp.length, error: "clipboard write failed" });
          return 3;
        }
        const nowServer = Date.now() + (skewMs ?? 0);
        emit({ found: true, len: last.otp.length, ageSec: last.receivedAt == null ? null : Math.max(0, Math.round((nowServer - last.receivedAt) / 1000)), ...skewField() });
        return 0;
      }
    }
    if (last.kind === "burned") {
      emit({ found: false, error: "worker returned an unusable code and deleted it: resend the OTP, then run this again" });
      return 3;
    }
    if (last.kind === "unauthorized") {
      emit({ found: false, error: "unauthorized (401): the read key is wrong or revoked" });
      return 3;
    }
    if (Date.now() + pollMs > deadline) break;
    // The answer revealed a Worker clock that moves t0 by more than a second: ask again at once with the corrected t0 (a stale t0 hides a valid code).
    if (fastRepoll && Math.abs(sinceSent - usedSince) > 1000) fastRepoll = false;
    else await sleep(pollMs);
  }
  const error = last.kind === "none" ? undefined : last.kind === "http" ? `worker answered HTTP ${last.status}` : last.kind === "bad" ? "worker answered an unreadable body" : "worker unreachable";
  emit({ found: false, waitedSec: Math.round((Date.now() - started) / 1000), ...skewField(), ...(error ? { error } : {}) });
  return last.kind === "http" ? 3 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // exitCode, not process.exit(): exiting while undici is still closing a socket aborts node on Windows (UV_HANDLE_CLOSING).
  main().then((code) => {
    process.exitCode = code;
  });
}
