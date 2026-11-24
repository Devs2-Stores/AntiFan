#!/usr/bin/env node
// shop-folder-index.mjs - which folders on this machine belong to a shop, in well under 5 s and without a recursive grep.
//
//   node E:/Work/apps/AntiFan/scripts/leader/shop-folder-index.mjs <shop name or domain> [--scratch]
//
// Why: a worker spent 94 s on `rg -il <shop>` over E:/Work/{customizes,themes,tools,scratch}; scratch is huge. This reads
// only directory listings and the small binding files:
//   customizes   first-level folders of E:/Work/customizes whose name OR whose .haravan-cli_local.json shop_domain matches
//   themes       folders one and two levels under E:/Work/themes whose name matches (same binding rule)
//   pagespeed    entries of E:/Work/tools/Pagespeed named optimize*_* that contain the shop key
//   scratch      ONLY with --scratch: first-level job folders of E:/Work/scratch/leader whose name matches
// Each folder row: {folder, path, binding?} where binding = the org_id / theme_id / shop_domain present in the file.
// The key is the shop label: "atoha.myharavan.com", "https://www.atoha.com/" and "Atoha" all search "atoha" (letters and
// digits only, case-insensitive). Prints ONE JSON line, never writes. Env WORK_ROOT overrides E:/Work (tests).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export function shopKey(input) {
  let s = String(input).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (/\.[a-z]{2,}$/i.test(s) && s.includes(".")) {
    const labels = s.split(".").filter((l) => l && l.toLowerCase() !== "www");
    s = labels[0] ?? s;
  }
  return norm(s);
}

const dirs = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

const binding = (folder) => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(folder, ".haravan-cli_local.json"), "utf8"));
    const out = {};
    for (const k of ["org_id", "theme_id", "theme_name", "shop_domain"]) if (j?.[k] !== undefined && j[k] !== null && j[k] !== "") out[k] = String(j[k]);
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
};

function rows(parent, names, key) {
  const out = [];
  for (const name of names) {
    const folder = path.join(parent, name);
    const b = binding(folder);
    const hit = norm(name).includes(key) || (b?.shop_domain && norm(b.shop_domain).includes(key));
    if (hit) out.push({ folder: name, path: folder.replace(/\\/g, "/"), ...(b ? { binding: b } : {}) });
  }
  return out;
}

/**
 * Folders bound to the same Haravan org as a folder that already matched, even when their name does not carry the shop
 * (a second theme of the same shop in its own folder): one shop can have several folders, each bound to a different
 * theme, and a caller that sees only the one named after the shop tells a worker to create a folder that exists.
 */
function withSameOrg(parent, hits) {
  const orgs = new Set(hits.map((h) => h.binding?.org_id).filter(Boolean));
  if (!orgs.size) return hits;
  const seen = new Set(hits.map((h) => h.folder));
  const extra = [];
  for (const name of dirs(parent)) {
    if (seen.has(name)) continue;
    const folder = path.join(parent, name);
    const b = binding(folder);
    if (b?.org_id && orgs.has(b.org_id)) extra.push({ folder: name, path: folder.replace(/\\/g, "/"), binding: b, via: "org_id" });
  }
  return [...hits, ...extra];
}

export function index(query, { scratch = false, root = process.env.WORK_ROOT || "E:/Work" } = {}) {
  const t0 = Date.now();
  const key = shopKey(query);
  if (!key) return { error: "empty shop key" };
  const customizes = path.join(root, "customizes");
  const themesRoot = path.join(root, "themes");
  const themes = [];
  for (const g of dirs(themesRoot)) {
    themes.push(...rows(themesRoot, [g], key));
    const gp = path.join(themesRoot, g);
    for (const r of rows(gp, dirs(gp), key)) themes.push({ ...r, folder: `${g}/${r.folder}` });
  }
  const pageSpeedDir = path.join(root, "tools", "Pagespeed");
  let pagespeed = [];
  try {
    pagespeed = fs
      .readdirSync(pageSpeedDir)
      .filter((n) => /^optimize.*_/i.test(n) && norm(n).includes(key))
      .map((n) => ({ folder: n, path: path.join(pageSpeedDir, n).replace(/\\/g, "/") }));
  } catch {
    pagespeed = [];
  }
  const customizeRows = rows(customizes, dirs(customizes), key);
  const out = { query: String(query), key, customizes: withSameOrg(customizes, customizeRows), themes, pagespeed };
  if (scratch) {
    const leader = path.join(root, "scratch", "leader");
    out.scratch = dirs(leader).filter((n) => norm(n).includes(key)).map((n) => ({ folder: n, path: path.join(leader, n).replace(/\\/g, "/") }));
  }
  out.elapsedMs = Date.now() - t0;
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const scratch = argv.includes("--scratch");
  const query = argv.filter((a) => a !== "--scratch")[0];
  if (!query) {
    process.stdout.write(`${JSON.stringify({ error: "usage: shop-folder-index.mjs <shop name or domain> [--scratch]" })}\n`);
    return 2;
  }
  const res = index(query, { scratch });
  process.stdout.write(`${JSON.stringify(res)}\n`);
  return res.error ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
