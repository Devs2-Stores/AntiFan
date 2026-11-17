#!/usr/bin/env node
// Summarise `wrangler tail --format json` output: events by outcome, HTTP status, route and org, plus exceptions and error logs.
// Replaces the hand-written parse-and-count scripts of eight sessions.
//
//   node scripts/leader/cf-tail-count.mjs --file tail.jsonl [--org ORGID] [--top 10]
//   node scripts/leader/cf-tail-count.mjs --worker NAME [--minutes 2] [--org ORGID] [--cwd DIR]   (runs wrangler tail, then summarises)
//   ... | node scripts/leader/cf-tail-count.mjs --stdin
//
// Prints one JSON object. Read-only: it never writes a file and never calls a Cloudflare API except through `wrangler tail`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORG_QUERY = /[?&](?:orgid|orgId|org_id|shop_id)=(\d+)/;
const ORG_LOG = /["']?(?:orgid|orgId|org_id)["']?\s*[:=]\s*["']?(\d+)/;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const top = (map, n) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));

function logText(ev) {
  return (ev.logs ?? []).map((l) => (Array.isArray(l.message) ? l.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ") : String(l.message ?? ""))).join("\n");
}

function orgOf(ev) {
  const url = ev.event?.request?.url ?? "";
  return ORG_QUERY.exec(url)?.[1] ?? ORG_LOG.exec(logText(ev))?.[1] ?? null;
}

function routeOf(ev) {
  const req = ev.event?.request;
  if (!req?.url) return null;
  try {
    return `${req.method ?? "GET"} ${new URL(req.url).pathname}`;
  } catch {
    return `${req.method ?? "GET"} ${String(req.url).split("?")[0]}`;
  }
}

/** lines: iterable of text lines (one JSON event each; other lines are counted as skipped). */
export function summarizeTail(lines, { org = null, top: n = 10 } = {}) {
  const outcome = new Map();
  const status = new Map();
  const route = new Map();
  const byOrg = new Map();
  const errors = new Map();
  let events = 0;
  let skipped = 0;
  let exceptions = 0;
  let matched = 0;
  let first = null;
  let last = null;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (ev === null || typeof ev !== "object") {
      skipped++;
      continue;
    }
    events++;
    const o = orgOf(ev);
    if (o) bump(byOrg, o);
    if (org && o !== String(org)) continue;
    matched++;
    if (typeof ev.eventTimestamp === "number") {
      first = first === null ? ev.eventTimestamp : Math.min(first, ev.eventTimestamp);
      last = last === null ? ev.eventTimestamp : Math.max(last, ev.eventTimestamp);
    }
    bump(outcome, ev.outcome ?? "unknown");
    const st = ev.event?.response?.status;
    if (st !== undefined) bump(status, String(st));
    const r = routeOf(ev);
    if (r) bump(route, r);
    for (const ex of ev.exceptions ?? []) {
      exceptions++;
      bump(errors, `exception: ${String(ex.name ?? "Error")}: ${String(ex.message ?? "").slice(0, 160)}`);
    }
    for (const l of ev.logs ?? []) {
      if (l.level === "error") bump(errors, `log: ${(Array.isArray(l.message) ? l.message.join(" ") : String(l.message ?? "")).slice(0, 160)}`);
    }
  }
  return {
    events,
    matched,
    skipped,
    exceptions,
    window: first === null ? null : { from: new Date(first).toISOString(), to: new Date(last).toISOString() },
    outcome: Object.fromEntries(outcome),
    status: Object.fromEntries(status),
    topRoutes: top(route, n),
    topOrgs: top(byOrg, n),
    topErrors: top(errors, n),
  };
}

function parseArgs(argv) {
  const o = { top: 10, minutes: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--file") o.file = val();
    else if (a === "--stdin") o.stdin = true;
    else if (a === "--worker") o.worker = val();
    else if (a === "--minutes") o.minutes = Number(val());
    else if (a === "--org") o.org = val();
    else if (a === "--top") o.top = Number(val());
    else if (a === "--cwd") o.cwd = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(o.top) || o.top < 1) throw new Error("--top must be a positive number");
  if (!Number.isFinite(o.minutes) || o.minutes <= 0 || o.minutes > 30) throw new Error("--minutes must be 0-30");
  if ([o.file, o.stdin, o.worker].filter(Boolean).length !== 1) throw new Error("give exactly one of --file, --stdin, --worker");
  return o;
}

function tailWorker(worker, minutes, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "tail", worker, "--format", "json"], { cwd, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill(), minutes * 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      if (!out.trim() && err.trim()) reject(new Error(`wrangler tail produced no events: ${err.trim().slice(0, 300)}`));
      else resolve(out);
    });
  });
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`cf-tail-count: ${e.message}\n`);
    return 2;
  }
  let text;
  try {
    if (o.file) text = fs.readFileSync(path.resolve(o.file), "utf8");
    else if (o.stdin) text = fs.readFileSync(0, "utf8");
    else text = await tailWorker(o.worker, o.minutes, o.cwd ? path.resolve(o.cwd) : process.cwd());
  } catch (e) {
    process.stderr.write(`cf-tail-count: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(summarizeTail(text.split(/\r?\n/), { org: o.org, top: o.top }))}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
