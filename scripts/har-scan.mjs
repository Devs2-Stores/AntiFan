#!/usr/bin/env node
// har-scan.mjs - offline HAR + bundle-origin discovery for SPA reverse engineering. Zero dependencies.
//   node scripts/har-scan.mjs --har file.har [--bundle dir]
// Never fetches anything. Credential values (cookie, authorization, *token*, csrf headers; token/key/sig/auth query
// keys) are printed only as sha256:<8 hex>; request/response bodies are never printed, only their size and, for JSON,
// top-level key names (depth 2).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-[\w-]*token[\w-]*|x-csrf[\w-]*|x-api-key)$/i;
const SECRET_QUERY = /^(token|key|sig|signature|auth|access_token|apikey|api_key|session)$/i;
const digest = (v) => `sha256:${crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8)}`;

/** Group key: digits, UUIDs and 24-hex ids become :id. */
export function pathTemplate(pathname) {
  return pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{24}$/i.test(seg) ? ':id' : seg))
    .join('/');
}

function jsonKeys(text, depth = 2) {
  try {
    const walk = (v, d) => {
      if (Array.isArray(v)) return v.length ? walk(v[0], d) : [];
      if (v && typeof v === 'object') return Object.keys(v).flatMap((k) => (d > 1 ? [k, ...walk(v[k], d - 1).map((s) => `${k}.${s}`)] : [k]));
      return [];
    };
    return walk(JSON.parse(text), depth).slice(0, 40);
  } catch {
    return null;
  }
}

/** @returns {{origins: Map<string, object>, entries: number}} */
export function scanHar(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('not a HAR 1.2 file: log.entries missing');
  const groups = new Map();
  for (const e of entries) {
    let url;
    try {
      url = new URL(e.request?.url);
    } catch {
      continue;
    }
    const key = `${e.request.method} ${url.origin}${pathTemplate(url.pathname)}`;
    const g = groups.get(key) ?? { origin: url.origin, method: e.request.method, template: pathTemplate(url.pathname), count: 0, statuses: {}, types: new Set(), queryKeys: new Set(), secretHeaders: {}, bodyKeys: new Set(), responseBytes: 0 };
    g.count += 1;
    g.statuses[e.response?.status ?? 0] = (g.statuses[e.response?.status ?? 0] ?? 0) + 1;
    if (e.response?.content?.mimeType) g.types.add(String(e.response.content.mimeType).split(';')[0]);
    for (const [k, v] of url.searchParams) g.queryKeys.add(SECRET_QUERY.test(k) ? `${k}=${digest(v)}` : k);
    for (const h of [...(e.request.headers ?? []), ...(e.response?.headers ?? [])]) {
      if (SECRET_HEADER.test(h.name)) g.secretHeaders[h.name.toLowerCase()] = digest(h.value);
    }
    const post = e.request.postData?.text;
    if (post) for (const k of jsonKeys(post) ?? []) g.bodyKeys.add(k);
    g.responseBytes += Number(e.response?.content?.size ?? 0) || 0;
    groups.set(key, g);
  }
  const origins = new Map();
  for (const g of groups.values()) {
    const o = origins.get(g.origin) ?? { requests: 0, endpoints: [] };
    o.requests += g.count;
    o.endpoints.push({ ...g, types: [...g.types], queryKeys: [...g.queryKeys], bodyKeys: [...g.bodyKeys] });
    origins.set(g.origin, o);
  }
  return { origins, entries: entries.length };
}

/** Origins and API-looking paths declared in *.js under dir. */
export function scanBundle(dir) {
  const origins = new Set();
  const paths = new Set();
  const visit = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules') visit(full);
      } else if (/\.(m?js|cjs)$/i.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/https?:\/\/[^"'`\s\\)<>]+/g)) {
          try {
            origins.add(new URL(m[0]).origin);
          } catch {}
        }
        for (const m of text.matchAll(/["'`](\/(?:api|graphql|v\d+)[^"'`\s]*)["'`]/g)) paths.add(m[1]);
      }
    }
  };
  visit(dir);
  return { origins, paths };
}

export function report({ har, bundleDir }) {
  const { origins, entries } = scanHar(har);
  const lines = [`entries: ${entries}`];
  for (const [origin, o] of origins) {
    lines.push(`origin ${origin} requests=${o.requests}`);
    for (const e of o.endpoints) {
      lines.push(`  ${e.method} ${e.template} x${e.count} status=${JSON.stringify(e.statuses)} types=${e.types.join(',')} query=${e.queryKeys.join(',')} body=${e.bodyKeys.join(',')} bytes=${e.responseBytes}`);
      for (const [h, d] of Object.entries(e.secretHeaders)) lines.push(`    header ${h}: ${d}`);
    }
  }
  let observed = origins.size;
  let declared = origins.size;
  if (bundleDir) {
    const b = scanBundle(bundleDir);
    const unobserved = [...b.origins].filter((o) => !origins.has(o));
    declared = new Set([...origins.keys(), ...b.origins]).size;
    observed = declared - unobserved.length;
    for (const o of unobserved) lines.push(`unobserved ${o}`);
    for (const p of [...b.paths].slice(0, 50)) lines.push(`bundle-path ${p}`);
  }
  lines.push(`coverage: observed ${observed} of ${declared} bundle-declared origins`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const harFile = get('--har');
  if (!harFile) {
    console.error('usage: har-scan.mjs --har file.har [--bundle dir]');
    process.exit(2);
  }
  try {
    console.log(report({ har: JSON.parse(fs.readFileSync(harFile, 'utf8')), bundleDir: get('--bundle') }));
  } catch (e) {
    console.error(`har-scan: ${e.message}`);
    process.exit(1);
  }
}
