#!/usr/bin/env node
// otp-fetch.mjs - read the newest Haravan OTP from the otp-inbox Worker into the Windows clipboard, never onto a screen.
//
// A worker that has to sign in (`hrv login --no-open`) runs this instead of reading the mail itself: the Worker (fed by a Zoho
// webhook for services@f1genz.com) keeps the code for at most 120 s and hands it over exactly once. The code goes straight into
// the clipboard through the stdin of `clip` (never a command line, so no process list or log can hold it) and the worker pastes
// it with Ctrl+V. stdout is ONE json line {found, len, ageSec}; the code, the read key and the mail are never printed.
//
//   node otp-fetch.mjs --since <epochMs> [--wait <seconds, default 120>]   wait for a code newer than `since`, copy it
//   node otp-fetch.mjs --clear                                              overwrite the clipboard with an empty string
//
// Config (contract 24/11/2026): env ANTIFAN_SECRET_OTP_INBOX_URL / ANTIFAN_SECRET_OTP_INBOX_KEY, else the same KEY=VALUE lines in
// %USERPROFILE%/.antifan/otp-inbox.env (outside every repo). Env wins over the file.
// Exit: 0 found (or clipboard cleared) | 1 no code within --wait | 2 usage or config | 3 the Worker refused (401/HTTP error) or the clipboard failed.
//
// Test seams: OTP_FETCH_ENV_FILE (config file path), OTP_FETCH_POLL_MS (poll interval, default 5000), OTP_FETCH_CLIPBOARD_FILE
// (write the code into this file instead of the clipboard).

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
  return { url, key, missing };
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

/** One GET /otp. Resolves {kind: "found"|"none"|"unauthorized"|"http"|"network"|"bad", ...}; never throws, never carries the key. */
async function readOnce(cfg, since) {
  let res;
  try {
    res = await fetch(`${cfg.url}/otp?since=${encodeURIComponent(String(since))}`, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
  if (!body || body.found !== true) return { kind: "none" };
  const otp = typeof body.otp === "string" ? body.otp : "";
  if (!/^[A-Za-z0-9]{4,12}$/.test(otp)) return { kind: "bad" };
  const receivedAt = Number.isFinite(body.receivedAt) ? Number(body.receivedAt) : null;
  return { kind: "found", otp, receivedAt };
}

function parseArgs(argv) {
  const flags = { since: null, wait: DEFAULT_WAIT_S, clear: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--clear") flags.clear = true;
    else if (a === "--since" || a === "--wait") {
      const v = argv[++i];
      if (v === undefined || !/^\d+(\.\d+)?$/.test(v)) return { error: `${a} needs a non-negative number` };
      flags[a.slice(2)] = Number(v);
    } else return { error: `unknown argument ${a.startsWith("-") ? a : "(positional)"}` };
  }
  return { flags };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    emit({ found: false, error: parsed.error });
    return 2;
  }
  const { flags } = parsed;
  if (flags.clear) {
    const ok = setClipboard("", env);
    emit({ cleared: ok });
    return ok ? 0 : 3;
  }
  const cfg = readConfig(env);
  if (cfg.missing.length) {
    emit({ found: false, error: `config missing: ${cfg.missing.join(", ")}` });
    return 2;
  }
  const started = Date.now();
  const since = flags.since ?? started;
  const pollMs = Math.max(1, Number(env.OTP_FETCH_POLL_MS) || DEFAULT_POLL_MS);
  const deadline = started + flags.wait * 1000;
  let last = { kind: "none" };
  for (;;) {
    last = await readOnce(cfg, since);
    if (last.kind === "found") {
      if (!setClipboard(last.otp, env)) {
        emit({ found: true, copied: false, len: last.otp.length, error: "clipboard write failed" });
        return 3;
      }
      emit({ found: true, len: last.otp.length, ageSec: last.receivedAt == null ? null : Math.max(0, Math.round((Date.now() - last.receivedAt) / 1000)) });
      return 0;
    }
    if (last.kind === "unauthorized") {
      emit({ found: false, error: "unauthorized (401): the read key is wrong or revoked" });
      return 3;
    }
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  const error = last.kind === "none" ? undefined : last.kind === "http" ? `worker answered HTTP ${last.status}` : last.kind === "bad" ? "worker answered an unreadable body" : "worker unreachable";
  emit({ found: false, waitedSec: Math.round((Date.now() - started) / 1000), ...(error ? { error } : {}) });
  return last.kind === "http" ? 3 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // exitCode, not process.exit(): exiting while undici is still closing a socket aborts node on Windows (UV_HANDLE_CLOSING).
  main().then((code) => {
    process.exitCode = code;
  });
}
