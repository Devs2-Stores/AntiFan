#!/usr/bin/env node
// hrv-token-probe.mjs - say WHY `hrv theme info` fails in a theme folder, without changing anything.
//
//   node E:/Work/apps/AntiFan/scripts/leader/hrv-token-probe.mjs      (cwd = the project folder)
//
// `hrv theme info` swallows its error ("Không lấy được thông tin theme.") and `hrv refresh-all` rotates the token of
// every org on the machine, so neither tells a worker the cause. This asks the installed Haravan CLI's own API helper
// for the bound theme (GET /web/themes/<id>.json, the same call `hrv theme info` makes for this org only) and prints
// ONE JSON line: {ok, themeId, orgId, role?, error?}. The error is the helper's message, cut to 300 characters with
// long opaque strings masked; nothing else of the response is printed.
// Exit: 0 the theme was read, 1 the read failed (see error), 2 no binding or no CLI helper.
// Env HRV_CLI_HELPER overrides the helper path (tests).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const emit = (obj, code) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  return code;
};
const mask = (s) => String(s).replace(/[A-Za-z0-9_\-.]{32,}/g, "[masked]").slice(0, 300);

export async function main(cwd = process.cwd(), env = process.env) {
  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(path.join(cwd, ".haravan-cli_local.json"), "utf8"));
  } catch (e) {
    return emit({ ok: false, error: `no readable .haravan-cli_local.json in ${cwd}: ${e.code ?? e.message}` }, 2);
  }
  const themeId = String(binding?.theme_id ?? "");
  const orgId = String(binding?.org_id ?? "");
  if (!/^\d+$/.test(themeId)) return emit({ ok: false, orgId, error: "binding has no numeric theme_id" }, 2);
  const helper = env.HRV_CLI_HELPER || path.join(env.APPDATA ?? "", "npm", "node_modules", "@local", "haravan-theme-ops-cli", "dist", "helper", "haravan_api.js");
  let api;
  try {
    api = (await import(pathToFileURL(helper).href)).default;
    if (typeof api?.get !== "function") throw new Error("helper has no default export with get()");
  } catch (e) {
    return emit({ ok: false, themeId, orgId, error: `cannot load the Haravan CLI helper (${helper}): ${mask(e.message)}` }, 2);
  }
  try {
    const res = await api.get(`/web/themes/${themeId}.json`);
    const role = res?.theme?.role ?? res?.data?.theme?.role ?? null;
    return emit({ ok: true, themeId, orgId, ...(typeof role === "string" ? { role } : {}) }, 0);
  } catch (e) {
    return emit({ ok: false, themeId, orgId, error: mask(e?.message ?? e) }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
