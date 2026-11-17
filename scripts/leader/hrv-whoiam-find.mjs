#!/usr/bin/env node
// hrv-whoiam-find.mjs - ask the installed Haravan CLI which orgs this machine is logged in to, and print ONLY the one
// you asked about, as ONE JSON line. Read-only: runs the CLI's `whoiam` (a listing command) as a child process and
// never changes a binding, a login or a token. Nothing is written to disk.
//
//   node E:/Work/apps/AntiFan/scripts/leader/hrv-whoiam-find.mjs <orgId|name>
//
// Why: `whoiam` prints ~57 orgs plus ~45 warning lines (5.7 s) on this machine and the hooks refuse redirecting it to a
// file, so a worker could not grep the table. The table has fixed-width columns `orgId  user  orgName`; they are cut at
// the column starts of the header line (the user and org names contain spaces). Output: {found:boolean, orgId, name?}
// where name is the orgName column only (the user column is a person's name and is never printed or matched). A name
// that matches several orgs adds `matches:[{orgId,name}]` up to 5 and picks none. {error} when the CLI cannot be run
// (exit 1). Exit 0 = answered (found or not), 1 = could not ask, 2 = usage. Env HRV_BIN overrides the executable (tests).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const emit = (obj, code) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  return code;
};
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** [{orgId, name}] from the fixed-width `orgId user orgName` table; a line with no header seen falls back to "<id> <rest>". */
export function parseWhoiam(raw) {
  const orgs = [];
  let cut = null;
  for (const line of String(raw).replace(ANSI, "").split(/\r?\n/)) {
    if (/^\s*orgId\s+user\s+orgName\b/.test(line)) {
      cut = { user: line.indexOf("user"), org: line.indexOf("orgName") };
      continue;
    }
    if (cut) {
      const id = line.slice(0, cut.user).trim();
      if (/^\d{6,}$/.test(id)) orgs.push({ orgId: id, name: line.slice(cut.org).trim() });
      continue;
    }
    const m = /^\s*(\d{6,})\s+(.*)$/.exec(line);
    if (m) orgs.push({ orgId: m[1], name: m[2].trim() });
  }
  return orgs;
}

export function find(orgs, query) {
  const q = String(query).trim();
  if (/^\d+$/.test(q)) {
    const hit = orgs.find((o) => o.orgId === q);
    return hit ? { found: true, orgId: hit.orgId, ...(hit.name ? { name: hit.name } : {}) } : { found: false, orgId: q };
  }
  const lq = q.toLowerCase();
  const hits = orgs.filter((o) => o.name.toLowerCase().includes(lq));
  if (hits.length === 1) return { found: true, orgId: hits[0].orgId, name: hits[0].name };
  if (hits.length > 1) return { found: false, orgId: null, matches: hits.slice(0, 5) };
  return { found: false, orgId: null };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const query = argv[0];
  if (!query) return emit({ error: "usage: hrv-whoiam-find.mjs <orgId|name>" }, 2);
  const bin = env.HRV_BIN || "hrv";
  const childEnv = { ...env, NO_COLOR: "1" };
  delete childEnv.FORCE_COLOR;
  const viaShell = process.platform === "win32" && (!env.HRV_BIN || /\.(cmd|bat)$/i.test(bin));
  const opts = { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: childEnv };
  const r = viaShell ? spawnSync(`"${bin}" whoiam`, { ...opts, shell: true }) : spawnSync(bin, ["whoiam"], opts);
  if (r.error) return emit({ error: `cannot run ${path.basename(bin)}: ${String(r.error.code ?? r.error.message).slice(0, 120)}` }, 1);
  const orgs = parseWhoiam(r.stdout ?? "");
  if (r.status !== 0 && !orgs.length) {
    const first = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(ANSI, "").trim().split(/\r?\n/).find(Boolean);
    return emit({ error: `whoiam exited ${r.status}: ${first?.slice(0, 160) ?? "no output"}` }, 1);
  }
  return emit(find(orgs, query), 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
