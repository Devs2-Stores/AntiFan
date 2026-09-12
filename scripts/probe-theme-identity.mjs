#!/usr/bin/env node
/**
 * Inspect storefront preview query behavior without certifying theme identity.
 * Each request is cookie-less. HTML can vary within one theme, and different
 * themes can produce identical HTML. These observations are diagnostic only.
 * Authoritative capture requires independent store/theme and browser receipts.
 *
 * Usage:
 *   node scripts/probe-theme-identity.mjs <storeUrl> <themeId> [protectedThemeId]
 * Example:
 *   node scripts/probe-theme-identity.mjs https://phukienmaymoc.com 1001514194 1001510509
 *
 * Exit codes: 0 HTTP diagnostics completed; 1 request failure; 2 invalid arguments.
 */
import { createHash } from 'node:crypto';

const [, , storeArg, targetArg, protectedArg] = process.argv;
if (!storeArg || !targetArg) {
  console.error('usage: node scripts/probe-theme-identity.mjs <storeUrl> <themeId> [protectedThemeId]');
  process.exit(2);
}
const store = storeArg.replace(/\/+$/, '');
const targetId = String(targetArg).trim();
const protectedId = protectedArg ? String(protectedArg).trim() : null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function probe(label, url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const txt = buf.toString('utf8');
    const title = (txt.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    return {
      label,
      url,
      status: res.status,
      finalUrl: res.url,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      title: title ? title.trim().slice(0, 90) : null,
      scripts: (txt.match(/<script/gi) || []).length,
      links: (txt.match(/<link/gi) || []).length,
      divs: (txt.match(/<div/gi) || []).length,
      hstatic: (txt.match(/hstatic\.net/g) || []).length,
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie().map((c) => c.split('=')[0]) : [],
    };
  } catch (e) {
    return { label, url, error: `${e.name}: ${e.message}` };
  }
}

const bare = await probe('bare', `${store}/`);
const viaHaravanParam = await probe('themeid', `${store}/?themeid=${targetId}`);
const viaShopifyParam = await probe('preview_theme_id', `${store}/?preview_theme_id=${targetId}`);
const viaProtected = protectedId ? await probe('protected', `${store}/?themeid=${protectedId}`) : null;

const table = [bare, viaHaravanParam, viaShopifyParam, ...(viaProtected ? [viaProtected] : [])];
for (const r of table) {
  console.log(
    `${r.label.padEnd(18)} status=${r.status ?? 'ERROR'} ${String(r.bytes ?? r.error).padStart(9)}B  sha=${String(r.sha256 ?? '-').padEnd(17)}` +
      ` scripts=${r.scripts ?? '-'} links=${r.links ?? '-'} divs=${r.divs ?? '-'} hstatic=${r.hstatic ?? '-'}` +
      ` cookies=${(r.setCookie || []).join(',')}`
  );
}

const successful = (r) => Boolean(r && !r.error && r.status >= 200 && r.status < 300 && r.sha256);
const complete = table.every(successful);
const sameDocument = (left, right) =>
  successful(left) && successful(right) ? left.sha256 === right.sha256 : null;

console.log('\n--- diagnostic observations (not theme identity) ---');
console.log(`preview_theme_id response equals bare response: ${sameDocument(viaShopifyParam, bare)}`);
console.log(`themeid response equals bare response: ${sameDocument(viaHaravanParam, bare)}`);
if (viaProtected) {
  console.log(`target response equals protected response: ${sameDocument(viaHaravanParam, viaProtected)}`);
}
console.log(`\nDIAGNOSTIC_${complete ? 'COMPLETE' : 'INCOMPLETE'}: target ${targetId} on ${store}`);
console.log('IDENTITY_UNVERIFIED: response hashes and cookie names do not attest the rendered theme.');
process.exitCode = complete ? 0 : 1;
