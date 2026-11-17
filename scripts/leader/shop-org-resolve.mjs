#!/usr/bin/env node
// shop-org-resolve.mjs - map a Haravan shop domain to what can be read from its PUBLIC storefront, read-only.
//
//   node E:/Work/apps/AntiFan/scripts/leader/shop-org-resolve.mjs <domain> [--admin-orgid <id>] [--admin-url <url>]
//
// One GET of https://<domain>/ (redirects followed: a custom domain such as atoha.myharavan.com lands on www.atoha.com).
// Prints ONE JSON line {domainFinal, shopId, liveThemeId, liveThemeRole, myharavanDomain?, orgIdFromAdminRedirect?}:
//   shopId        header X-ShopId. It equalled the org_id of the folder binding for atoha (1000273687, 13/11/2026) but that
//                 is NOT proven for every shop: never type it as the org of a login line, confirm it first
//   liveTheme*    `Haravan.theme = {id, role}` of the page, i.e. the theme the public sees (role "main" = live)
//   shop          `Haravan.shop = '<x>.myharavan.com'`
//   orgIdFromAdminRedirect  only from what you pass: --admin-orgid <id>, or the orgid= query of --admin-url <url> (the
//                 accounts.haravan.com / Admin redirect you saw in the login tab). The public pages never carry the org
//                 id and /admin answers 200 with a JS shell (checked 13/11/2026), so it is NOT derived from X-ShopId:
//                 a shop id is not guaranteed to be an org id.
// No token, no cookie, no write, no hrv CLI. Exit 0 read, 1 request failed (see error), 2 usage.
// Env SHOP_ORG_FETCH_TIMEOUT_MS overrides the 15 s timeout.

import path from "node:path";
import { pathToFileURL } from "node:url";

const emit = (obj, code) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  return code;
};

export function parseStorefront(html, headers, finalUrl) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? null;
  const shopId = get("x-shopid");
  const theme = /Haravan\.theme\s*=\s*(\{[^;\n]*?\})\s*;?/.exec(html);
  let t = null;
  if (theme) {
    try {
      t = JSON.parse(theme[1]);
    } catch {
      t = null;
    }
  }
  const shop = /Haravan\.shop\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1] ?? null;
  const out = {
    domainFinal: new URL(finalUrl).host,
    shopId: shopId && /^\d+$/.test(shopId) ? shopId : null,
    liveThemeId: t && Number.isFinite(Number(t.id)) ? String(t.id) : null,
    liveThemeRole: t && typeof t.role === "string" ? t.role : null,
  };
  if (shop) out.myharavanDomain = shop;
  return out;
}

export async function main(argv = process.argv.slice(2), fetchImpl = fetch, env = process.env) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--admin-orgid" || argv[i] === "--admin-url") flags[argv[i].slice(2)] = argv[++i];
    else args.push(argv[i]);
  }
  const domain = (args[0] ?? "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) return emit({ error: "usage: shop-org-resolve.mjs <domain> [--admin-orgid <id>] [--admin-url <url>]" }, 2);
  let orgId = null;
  if (flags["admin-orgid"] !== undefined) orgId = /^\d+$/.test(flags["admin-orgid"]) ? flags["admin-orgid"] : null;
  else if (flags["admin-url"] !== undefined) {
    try {
      const v = new URL(flags["admin-url"]).searchParams.get("orgid");
      orgId = v && /^\d+$/.test(v) ? v : null;
    } catch {
      orgId = null;
    }
  }
  try {
    const res = await fetchImpl(`https://${domain}/`, { redirect: "follow", signal: AbortSignal.timeout(Number(env.SHOP_ORG_FETCH_TIMEOUT_MS) || 15000) });
    const html = await res.text();
    const out = parseStorefront(html, res.headers, res.url || `https://${domain}/`);
    if (orgId) out.orgIdFromAdminRedirect = orgId;
    return emit(out, res.ok ? 0 : 1);
  } catch (e) {
    return emit({ error: `GET https://${domain}/ failed: ${String(e?.message ?? e).slice(0, 200)}` }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
