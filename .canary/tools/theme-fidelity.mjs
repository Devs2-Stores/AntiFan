/**
 * Haravan customize-theme fidelity harness: capture one side at a time, then
 * adjudicate a reference against a subject.
 *
 *   node .canary/tools/theme-fidelity.mjs capture --role <reference|subject> --label <label> \
 *        --inventory <inventory.json> --out <dir> [--viewports 1440x900,1024x900,390x844] \
 *        [--allow-theme 1001512581]
 *   node .canary/tools/theme-fidelity.mjs compare --reference <dir> --subject <dir> --out <dir>
 *   node .canary/tools/theme-fidelity.mjs --help
 *
 * Exit codes: 0 success, 2 usage refusal, 3 a surface/pair was not measurable,
 * 4 provenance or safety refusal. See USAGE below, which is the authoritative
 * statement of both the codes and the safety rule.
 *
 * ── Why the comparison replays the captured documents ─────────────────────────
 * Reference and subject are the SAME storefront URL at two moments: the reference
 * is pinned before `hrv theme dev` writes the local source onto the theme copy,
 * the subject is captured afterwards. Re-navigating that URL at compare time
 * would load the post-write page into BOTH tabs and measure nothing, so `compare`
 * replays the sanitized DOM dump each side persisted instead: each dump is served
 * over loopback by the harness's own hardened static server (serve-static.mjs)
 * and the two replay tabs are compared with the authoritative comparator — the
 * same capability, the same strict parameters and the same terminal mapping
 * `viewport-run.mjs` uses.
 *
 * A dump served from loopback would resolve relative asset URLs against the
 * loopback server, so every replay copy gets the captured URL as its `<base>`
 * (inserted, or the document's own base href resolved against it). That injection
 * is recorded per side in the verdict; the pinned DOM digest is always computed
 * over the unmodified dump.
 *
 * Replay boundary, stated so a verdict is never read as more than it is: the
 * replayed document is the sanitized dump, and its external stylesheets, scripts
 * and images are fetched from the captured origin at compare time — not from bytes
 * this harness persisted. Markup, inline styles, class and attribute changes are
 * therefore compared exactly, while an asset file swapped under an unchanged URL
 * cannot be seen by the replay at all. That substitution is caught whenever it
 * changes the layout: the compare-time tab identity (docHeight, sections,
 * widgetNodes, device) is gated against the pinned capture identity and the verdict
 * is withheld as INCONCLUSIVE on any disagreement.
 *
 * ── Safety rule ──────────────────────────────────────────────────────────────
 * Before any navigation, every URL is parsed. A URL carrying a `themeid` query
 * parameter may only name -1 (live production, read-only) or a theme in
 * --allow-theme (default 1001512581, the authorised copy). Any other value is
 * refused with exit 4, naming the URL and the value. A URL without `themeid` is
 * allowed and recorded as carrying none. Nothing in this tool writes to a theme.
 *
 * ── Strict compare ───────────────────────────────────────────────────────────
 * useDefaultWidgetMasks:false, allowHeightDrift:false, no user masks, tolerance 2,
 * fullPage:true, normalizeScroll:true — unchanged. A verdict is withheld
 * (INCONCLUSIVE, never PASS) when a side's compare-time identity disagrees with
 * its pin, or when the two sides declare different `data-device` layout classes;
 * every superseded number stays in the document next to the mechanism that
 * withheld it.
 *
 * ── Import discipline ────────────────────────────────────────────────────────
 * lib-rpc.mjs resolves (and refuses on) the canary session at import time, so it
 * and canary-settle.mjs are imported dynamically inside the mode runners: `--help`
 * and every usage refusal must work without a session and without a connection.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256File } from '../../scripts/lib/atomic-record.mjs';
import { loadInstanceIdentity } from '../../scripts/lib/evidence-provenance.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DUMP_REF_TOOL = '.canary/tools/dump-ref.mjs';
/** The mint the campaign renews with, and the session file it rewrites. */
export const SESSION_TOOL = '.canary/tools/canary-session.mjs';
export const SESSION_FILE = '.canary/state/canary-session.json';
export const SERVE_STATIC_TOOL = '.canary/tools/serve-static.mjs';

/** Exit status contract. Nothing else may be returned from main(). */
export const EXIT = { OK: 0, USAGE: 2, NOT_MEASURABLE: 3, REFUSAL: 4 };

/** The authorised theme copy, plus -1 (live production, read-only). */
export const DEFAULT_ALLOWED_THEMES = ['1001512581'];
const PRODUCTION_THEME = '-1';
export const DEFAULT_VIEWPORTS = '1440x900,1024x900,390x844';

/** The identity fields a pinned side must reproduce at compare time. */
export const IDENTITY_FIELDS = ['device', 'ua', 'innerWidth', 'innerHeight', 'dpr', 'docHeight', 'sections', 'widgetNodes'];
/**
 * Document height is measured, not declared: a faithful replay can still differ by
 * a pixel from font/hinting rounding, which is the same bound the reference-dump
 * identity gate in viewport-run.mjs uses. Every other identity field is exact.
 */
export const DOC_HEIGHT_TOLERANCE_PX = 2;

/** Strict comparator parameters. Same values as viewport-run.mjs, never relaxed. */
export const STRICT_COMPARE_PARAMS = Object.freeze({
  fullPage: true,
  tolerance: 2,
  normalizeScroll: true,
  allowHeightDrift: false,
  useDefaultWidgetMasks: false,
  userMasks: [],
});

const TRACKED = [
  'body', 'header.site-header', 'main', '.site-footer', 'section',
  '.product-list__item', '.slide', '.news-item',
];

const CAPTURE_TIMEOUT_MS = Number(process.env.CANARY_STANDALONE_TIMEOUT_MS || 120_000);
const COMPARE_TIMEOUT_MS = Number(process.env.CANARY_COMPARE_TIMEOUT_MS || 240_000);
const DUMP_TIMEOUT_MS = Number(process.env.CANARY_DUMP_TIMEOUT_MS || 300_000);
const LEASE_TOKEN = process.env.CANARY_LEASE_TOKEN || null;
const REPLAY_PORTS = {
  reference: Number(process.env.THEME_FIDELITY_REFERENCE_PORT || 7861),
  subject: Number(process.env.THEME_FIDELITY_SUBJECT_PORT || 7862),
};

/**
 * The layout class the storefront writes at load time, in the exact shape
 * viewport-run.mjs measures it with (kept as a copy rather than imported: that
 * file is a script, and importing it would execute a whole runner).
 */
export const TAB_IDENTITY_EXPR = `(() => {
  const body = document.body;
  const widgetSel = '[class*="slick"],[class*="slide"],[class*="swiper"],[class*="track"],[class*="carousel"],[class*="banner"]';
  return {
    href: location.href,
    device: body ? body.getAttribute('data-device') : null,
    ua: navigator.userAgent,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    docHeight: document.documentElement.scrollHeight,
    bodyClass: body ? String(body.className).slice(0, 160) : null,
    sections: document.querySelectorAll('section').length,
    widgetNodes: document.querySelectorAll(widgetSel).length,
    images: document.images.length,
    completeImages: Array.from(document.images).filter((i) => i.complete && i.naturalWidth > 0).length,
  };
})()`;

/**
 * Image hydration, verbatim from viewport-run.mjs: lazy images are promoted and
 * every incomplete image is awaited (bounded, so a dead image cannot strand the
 * capture), then the document is returned to the top.
 */
export const IMAGE_HYDRATION_EXPR = `(async () => {
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    try { img.loading = 'eager'; } catch {}
  });
  // The storefront's own loader parks a base64 placeholder in the src attribute and keeps the
  // real source in data-src, so a guard that only fills an empty src never fires and the page
  // keeps swapping sources after hydration has run — measured as the image-set hash and the
  // document geometry moving between passes of an unchanged page. Applying the loader's own
  // contract materialises the image the page intends to show: a declared source or srcset
  // replaces the placeholder, the declared sizes replaces auto, and the loader's class is
  // dropped so it cannot re-decide later. Nothing is hidden, both sides are treated alike, and
  // the loader writing the same values is a no-op.
  document.querySelectorAll('img[data-src], img[data-srcset], img[data-lazy], img[data-original], img[data-echo]').forEach(img => {
    const declaredSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original') || img.getAttribute('data-echo');
    const declaredSet = img.getAttribute('data-srcset');
    const declaredSizes = img.getAttribute('data-sizes');
    try {
      if (declaredSrc && img.getAttribute('src') !== declaredSrc) img.setAttribute('src', declaredSrc);
      if (declaredSet && img.getAttribute('srcset') !== declaredSet) img.setAttribute('srcset', declaredSet);
      if (declaredSizes && declaredSizes !== 'auto' && img.getAttribute('sizes') !== declaredSizes) img.setAttribute('sizes', declaredSizes);
      if (img.classList) img.classList.remove('lazyload', 'lazyloading');
    } catch {}
  });
  await Promise.all(
    Array.from(document.images)
      .filter(i => !i.complete)
      .map(i => new Promise(resolve => {
        i.addEventListener('load', resolve, { once: true });
        i.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 6000);
      }))
  );
  window.scrollTo(0, 0);
  return true;
})()`;

export const USAGE = `theme-fidelity — capture/compare harness for the Haravan customize workflow

usage:
  node .canary/tools/theme-fidelity.mjs capture --role <reference|subject> --label <label>
      --inventory <inventory.json> --out <dir> [--viewports 1440x900,1024x900,390x844]
      [--allow-theme 1001512581]
  node .canary/tools/theme-fidelity.mjs compare --reference <dir> --subject <dir> --out <dir>
  node .canary/tools/theme-fidelity.mjs --help

capture
  Opens one tab per surface x viewport, sets the viewport, navigates, hydrates images,
  releases the settle blockers, captures a full-page PNG and a sanitized DOM dump, then
  reads the tab identity and the measured geometry. Persists one evidence document per
  surface x viewport plus an index, and closes every tab it opened.

compare
  Pairs the reference and subject artifacts by surface and viewport, replays each side's
  captured DOM through the harness static server, and runs the strict visual comparison.
  Persists one verdict document per pair plus an index, and prints one line per pair.

exit codes:
  0  every requested surface/pair produced an evidence or verdict document
  2  usage refusal: bad or missing arguments, unreadable inventory, unreadable side index,
     sides that do not carry the same surface x viewport set
  3  a surface or pair was not measurable: no evidence or no verdict for that pair
  4  provenance or safety refusal: unresolvable provenance, an artifact whose digest does
     not match its pin, or a URL whose themeid is not authorised

safety rule:
  Before any navigation, every URL is parsed. A URL carrying a \`themeid\` query parameter
  may only name -1 (live production, read-only) or a theme listed in --allow-theme
  (default ${DEFAULT_ALLOWED_THEMES.join(', ')} — the authorised theme copy). Any other value is
  refused with exit 4, naming the URL and the value. A URL without \`themeid\` is allowed
  and recorded as carrying none. This tool never writes to a theme.

strict compare (never relaxed):
  useDefaultWidgetMasks=false, allowHeightDrift=false, tolerance=2, fullPage=true,
  normalizeScroll=true, zero user masks. A verdict is withheld as INCONCLUSIVE — never
  PASS — when a side's compare-time identity disagrees with its pin, or when the two
  sides declare different data-device layout classes.`;

// ── Typed refusals ────────────────────────────────────────────────────────────

export class Refusal extends Error {
  constructor({ code, message, exitCode, detail = null }) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

/** Build (do not throw) a typed refusal, so a pure function can hand one back. */
export function refuse(code, exitCode, message, detail = null) {
  return new Refusal({ code, message, exitCode, detail });
}

/** A surface that produced no evidence: the run is not a verdict, it is exit 3. */
export class NotMeasurable extends Error {
  constructor(code, reason, detail = null) {
    super(reason);
    this.name = 'NotMeasurable';
    this.code = code;
    this.detail = detail;
  }
}

const isRefusal = (e) => e instanceof Refusal;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/**
 * The evidence-run lease, when this run was mounted inside a campaign that holds
 * one: every staging capability must present it or the runtime rejects the stage.
 */
const leaseParams = () => (LEASE_TOKEN ? { leaseToken: LEASE_TOKEN } : {});

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function slugify(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'surface';
}

/** Number when the parameter is integral, otherwise the value verbatim. */
export function themeIdFromParameter(raw) {
  const text = String(raw).trim();
  return /^-?\d+$/.test(text) ? Number(text) : text;
}

const THEME_ASSET_ID = /cdn\.hstatic\.net\/themes\/(\d+)\/(\d+)\//g;

/**
 * The theme a document was actually served by, read from the asset URLs inside it.
 *
 * `?themeid=` is not proof: measured on this store, an unknown id answers 200 while
 * serving the live theme, with the requested parameter still in the address bar. A
 * capture labelled "the copy" would then describe production, and every comparison built
 * on it would be against the wrong page. The asset origin carries the identity the URL
 * does not, so when a positive copy id was requested and the document resolves its assets
 * from a different theme, that is a refusal rather than a measurement. The live preview
 * (`-1`) is deliberately not asserted: it has no fixed id to compare against, and its own
 * id is what a copy capture must not serve.
 */
export function checkServedTheme(html, requestedThemeId) {
  const text = typeof html === 'string' ? html : '';
  const served = new Map();
  for (const match of text.matchAll(THEME_ASSET_ID)) {
    const org = match[1];
    const themeId = Number(match[2]);
    served.set(`${org}/${themeId}`, { org, themeId, occurrences: (served.get(`${org}/${themeId}`)?.occurrences ?? 0) + 1 });
  }
  const ids = [...served.values()].sort((a, b) => b.occurrences - a.occurrences);
  if (typeof requestedThemeId !== 'number' || requestedThemeId < 0 || ids.length === 0) return { ids, refusal: null };
  // The dominant id is the theme the document is built from; a handful of urls to another
  // theme is a finding about the theme's own markup, not a substituted page, so it is kept
  // in `ids` and reported instead of refusing the capture.
  const dominant = ids[0];
  if (dominant.themeId === requestedThemeId) return { ids, refusal: null };
  return {
    ids,
    refusal: refuse(
      'SERVED_THEME_MISMATCH',
      EXIT.REFUSAL,
      `the capture requested theme ${requestedThemeId} but the document resolves most of its assets from theme ${dominant.themeId} (org ${dominant.org}, ${dominant.occurrences} urls; all: ${ids.map((i) => `${i.themeId}x${i.occurrences}`).join(' ')}) — ?themeid= is not proof of what was served`,
      { requestedThemeId, served: ids },
    ),
  };
}

/**
 * Parse the CLI. Unknown or duplicated flags, missing values and missing required
 * arguments are usage refusals (exit 2) that name the offending flag.
 */
export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!mode) throw refuse('MODE_MISSING', EXIT.USAGE, 'no mode given; expected `capture`, `compare` or `--help`');
  if (mode === '--help' || mode === '-h' || mode === 'help') return { mode: 'help', options: {} };
  if (mode !== 'capture' && mode !== 'compare') {
    throw refuse('MODE_UNKNOWN', EXIT.USAGE, `unknown mode \`${mode}\`; expected \`capture\`, \`compare\` or \`--help\``, { mode });
  }
  const flags = new Map();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw refuse('ARG_UNEXPECTED', EXIT.USAGE, `unexpected positional argument \`${token}\``, { mode, argument: token });
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value = eq === -1 ? rest[++i] : token.slice(eq + 1);
    if (value === undefined || value === '') {
      throw refuse('ARG_VALUE_MISSING', EXIT.USAGE, `--${name} requires a value`, { mode, flag: name });
    }
    if (flags.has(name)) throw refuse('ARG_DUPLICATE', EXIT.USAGE, `--${name} was given more than once`, { mode, flag: name });
    flags.set(name, value);
  }
  const known = mode === 'capture'
    ? new Set(['role', 'label', 'inventory', 'out', 'viewports', 'allow-theme'])
    : new Set(['reference', 'subject', 'out']);
  for (const name of flags.keys()) {
    if (!known.has(name)) throw refuse('ARG_UNKNOWN', EXIT.USAGE, `--${name} is not a ${mode} option`, { mode, flag: name, known: Array.from(known) });
  }
  const require = (name) => {
    const value = flags.get(name);
    if (value === undefined) throw refuse('ARG_REQUIRED_MISSING', EXIT.USAGE, `${mode} requires --${name}`, { mode, flag: name });
    return value;
  };
  if (mode === 'capture') {
    const role = require('role');
    if (role !== 'reference' && role !== 'subject') {
      throw refuse('ROLE_INVALID', EXIT.USAGE, `--role must be \`reference\` or \`subject\`, not \`${role}\``, { role });
    }
    return {
      mode,
      options: {
        role,
        label: require('label'),
        inventory: require('inventory'),
        out: require('out'),
        viewports: flags.get('viewports') ?? DEFAULT_VIEWPORTS,
        allowThemes: (flags.get('allow-theme') ?? DEFAULT_ALLOWED_THEMES.join(',')).split(',').map(trimmed).filter(Boolean),
      },
    };
  }
  return {
    mode,
    options: { reference: require('reference'), subject: require('subject'), out: require('out') },
  };
}

/** `1440x900,1024x900,390x844` -> tiers with the mobile flag and the harness dpr of 1. */
export function parseViewportSpec(spec) {
  const tokens = String(spec).split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) throw refuse('VIEWPORT_SPEC_INVALID', EXIT.USAGE, '--viewports is empty', { spec });
  const seen = new Set();
  const viewports = [];
  for (const token of tokens) {
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (!match) throw refuse('VIEWPORT_SPEC_INVALID', EXIT.USAGE, `viewport \`${token}\` is not <width>x<height>`, { spec, token });
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0) || !(height > 0)) throw refuse('VIEWPORT_SPEC_INVALID', EXIT.USAGE, `viewport \`${token}\` must be positive`, { spec, token });
    const label = `${width}x${height}`;
    if (seen.has(label)) throw refuse('VIEWPORT_SPEC_DUPLICATE', EXIT.USAGE, `viewport ${label} was requested twice`, { spec, token });
    seen.add(label);
    viewports.push({ label, width, height, mobile: width < 768, dpr: 1 });
  }
  return viewports;
}

/**
 * Validate the inventory. `surfaces` is required and must be a non-empty array of
 * entries carrying a name and an absolute http(s) URL; `views`, when present, must
 * do the same (a view is a view-gated surface and is captured like one). Every
 * refusal names the missing file or the exact field path.
 */
export function validateInventory(raw, { file = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw refuse('INVENTORY_UNREADABLE', EXIT.USAGE, `inventory ${file ?? '<memory>'} is not a JSON object`, { file });
  }
  const store = trimmed(raw.store);
  if (!store) throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} is missing the required field \`store\``, { file, field: 'store' });
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
    throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} is missing a non-empty \`surfaces\` array`, { file, field: 'surfaces' });
  }
  if (raw.views !== undefined && !Array.isArray(raw.views)) {
    throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} declares \`views\` that is not an array`, { file, field: 'views' });
  }
  const targets = [];
  const names = new Map();
  const slugs = new Map();
  const push = (entry, fieldPath, kind) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} ${fieldPath} is not an object`, { file, field: fieldPath });
    }
    const name = trimmed(entry.name);
    if (!name) throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} is missing \`${fieldPath}.name\``, { file, field: `${fieldPath}.name` });
    const key = name.toLowerCase();
    if (names.has(key)) throw refuse('INVENTORY_NAME_COLLISION', EXIT.USAGE, `inventory ${file ?? '<memory>'} names \`${name}\` twice (${names.get(key)} and ${fieldPath})`, { file, name, first: names.get(key), second: fieldPath });
    names.set(key, fieldPath);
    const url = trimmed(entry.url);
    if (!url) throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} is missing \`${fieldPath}.url\``, { file, field: `${fieldPath}.url` });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw refuse('INVENTORY_URL_INVALID', EXIT.USAGE, `inventory ${file ?? '<memory>'} ${fieldPath}.url is not an absolute URL: ${url}`, { file, field: `${fieldPath}.url`, url });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw refuse('INVENTORY_URL_INVALID', EXIT.USAGE, `inventory ${file ?? '<memory>'} ${fieldPath}.url is not http(s): ${url}`, { file, field: `${fieldPath}.url`, url });
    }
    const template = trimmed(entry.template);
    if (kind === 'view' && !template) {
      throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file ?? '<memory>'} is missing \`${fieldPath}.template\``, { file, field: `${fieldPath}.template` });
    }
    const slug = slugify(name);
    if (slugs.has(slug)) throw refuse('INVENTORY_NAME_COLLISION', EXIT.USAGE, `inventory ${file ?? '<memory>'} names \`${name}\` collide on artifact name \`${slug}\` (${slugs.get(slug)})`, { file, name, slug, first: slugs.get(slug), second: fieldPath });
    slugs.set(slug, fieldPath);
    targets.push({ name, kind, url, slug, source: trimmed(entry.source), notes: trimmed(entry.notes), template, fieldPath });
  };
  raw.surfaces.forEach((entry, i) => push(entry, `surfaces[${i}]`, 'surface'));
  (raw.views ?? []).forEach((entry, i) => push(entry, `views[${i}]`, 'view'));
  return { store, targets, livePreviewBase: raw.livePreviewBase ?? null, copyPreviewBase: raw.copyPreviewBase ?? null };
}

/**
 * Safety gate. Every URL is parsed before any navigation: a `themeid` parameter may
 * only name -1 or an allowed theme, and a URL without one is allowed and recorded as
 * carrying none. Returns every gate (so the evidence names what each URL declared)
 * and every refusal (so the caller can name the offending URL and value).
 */
export function evaluateUrlSafety(targets, allowedThemes = DEFAULT_ALLOWED_THEMES) {
  const allowed = new Set([PRODUCTION_THEME, ...allowedThemes.map((t) => String(t).trim()).filter(Boolean)]);
  const gates = [];
  const refusals = [];
  for (const target of targets) {
    let parsed;
    try {
      parsed = new URL(target.url);
    } catch {
      const refusal = { code: 'URL_UNPARSABLE', surface: target.name, url: target.url, value: null, reason: 'not an absolute URL' };
      gates.push({ surface: target.name, url: target.url, themeId: null, parameter: null, values: [], allowed: false, reason: refusal.reason });
      refusals.push(refusal);
      continue;
    }
    const values = [];
    for (const [key, value] of parsed.searchParams) {
      if (key.toLowerCase() === 'themeid') values.push(value);
    }
    if (!values.length) {
      gates.push({ surface: target.name, url: target.url, themeId: null, parameter: null, values: [], allowed: true, reason: 'no themeid query parameter' });
      continue;
    }
    const offending = values.filter((value) => !allowed.has(String(value).trim()));
    const gate = {
      surface: target.name,
      url: target.url,
      themeId: themeIdFromParameter(values[0]),
      parameter: values[0],
      values,
      allowed: offending.length === 0,
      reason: offending.length
        ? `themeid=${offending[0]} is neither ${PRODUCTION_THEME} nor an allowed theme (${Array.from(allowed).join(', ')})`
        : `themeid=${values[0]} is ${PRODUCTION_THEME} or an allowed theme`,
    };
    gates.push(gate);
    if (offending.length) {
      refusals.push({ code: 'THEME_ID_NOT_ALLOWED', surface: target.name, url: target.url, value: offending[0], values, allowedThemes: Array.from(allowed) });
    }
  }
  return { allowedThemes: Array.from(allowed), gates, refusals };
}

/** A pinned identity is usable only when the tab reported a real viewport. */
export function isMeasurableIdentity(identity) {
  return Boolean(identity) && typeof identity === 'object'
    && Number.isFinite(identity.innerWidth) && identity.innerWidth > 0
    && Number.isFinite(identity.innerHeight) && identity.innerHeight > 0;
}

/**
 * Compare a pinned identity against a compare-time measurement over the identity
 * field set. Document height is allowed the measured-rounding tolerance; every
 * other field is exact. An unreadable side is never treated as agreeing.
 */
export function compareIdentityFields(pinned, measured, tolerancePx = DOC_HEIGHT_TOLERANCE_PX) {
  const differences = [];
  if (!isMeasurableIdentity(measured)) {
    return {
      agree: false,
      unmeasurable: 'measured',
      tolerancePx,
      differences: [{ field: '*', pinned: null, measured: null, reason: 'the compare-time measurement reported no viewport' }],
    };
  }
  if (!isMeasurableIdentity(pinned)) {
    return {
      agree: false,
      unmeasurable: 'pinned',
      tolerancePx,
      differences: [{ field: '*', pinned: null, measured: null, reason: 'the pinned identity reported no viewport' }],
    };
  }
  for (const field of IDENTITY_FIELDS) {
    const a = pinned[field] === undefined ? null : pinned[field];
    const b = measured[field] === undefined ? null : measured[field];
    if (field === 'docHeight') {
      if (typeof a !== 'number' || typeof b !== 'number') {
        if (a !== b) differences.push({ field, pinned: a, measured: b, driftPx: null });
        continue;
      }
      const driftPx = Math.round(Math.abs(b - a) * 100) / 100;
      if (driftPx > tolerancePx) differences.push({ field, pinned: a, measured: b, driftPx });
      continue;
    }
    if (a !== b) differences.push({ field, pinned: a, measured: b, driftPx: null });
  }
  return { agree: differences.length === 0, unmeasurable: null, tolerancePx, differences };
}

/** The pair key an evidence document and a verdict document share. */
export function pairKey(surface, viewport) {
  return `${surface}__${viewport}`;
}

/**
 * Pair two sides' artifact entries by surface x viewport. The caller refuses when
 * anything is unpaired, so both directions are reported by name.
 */
export function pairArtifacts(referenceEntries, subjectEntries) {
  const byKey = (entries) => {
    const map = new Map();
    for (const entry of entries ?? []) {
      if (!entry || !entry.surface || !entry.viewport) continue;
      map.set(pairKey(entry.surface, entry.viewport), entry);
    }
    return map;
  };
  const reference = byKey(referenceEntries);
  const subject = byKey(subjectEntries);
  const pairs = [];
  const referenceOnly = [];
  const subjectOnly = [];
  for (const [key, entry] of reference) {
    if (subject.has(key)) pairs.push({ key, surface: entry.surface, viewport: entry.viewport, reference: entry, subject: subject.get(key) });
    else referenceOnly.push(key);
  }
  for (const key of subject.keys()) {
    if (!reference.has(key)) subjectOnly.push(key);
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { pairs, referenceOnly: referenceOnly.sort(), subjectOnly: subjectOnly.sort() };
}

/**
 * The comparator's terminal mapping, exactly as viewport-run.mjs derives it: a
 * dimension mismatch is a FAIL, a match is a PASS, and anything else falls through
 * to the tool's own verdict — with an unmapped tool verdict (STRUCTURAL_TRUNCATION_
 * DETECTED and friends) withheld as INCONCLUSIVE rather than promoted.
 */
export function mapVisualVerdict(cr) {
  const toolVerdict = cr?.verdict ?? null;
  const toolStatus = cr?.status ?? null;
  const dimensionsMatch = cr?.dimensionsMatch ?? null;
  const raw = dimensionsMatch === true
    ? (cr.match === true ? 'PASS' : 'FAIL')
    : (toolVerdict || (toolStatus === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : null));
  const known = raw === 'PASS' || raw === 'FAIL' || raw === 'INCONCLUSIVE';
  return {
    verdict: known ? raw : 'INCONCLUSIVE',
    raw,
    unmapped: known || raw === null ? null : raw,
    toolVerdict,
    toolStatus,
    dimensionsMatch,
    match: cr?.match ?? null,
    mismatchPercentage: cr?.mismatchPercentage ?? null,
  };
}

/** One line per pair: surface, viewport, verdict, percentage, both heights. */
export function formatPairLine(record) {
  const pct = typeof record.mismatchPercentage === 'number' ? `${record.mismatchPercentage}%` : 'n/a';
  const px = (v) => (typeof v === 'number' ? `${v}px` : 'n/a');
  return `surface=${record.surface} viewport=${record.viewport} verdict=${record.verdict} mismatch=${pct} referenceHeight=${px(record.referenceHeight)} subjectHeight=${px(record.subjectHeight)}`;
}

/** Geometry projection: the measurable fields, without the bulk image/card arrays. */
export function projectGeometry(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const pick = (key) => (metrics[key] === undefined ? null : metrics[key]);
  return {
    url: pick('url'),
    docHeight: pick('docHeight'),
    clientWidth: pick('clientWidth'),
    scrollWidth: pick('scrollWidth'),
    overflowX: pick('overflowX'),
    sectionCount: pick('sectionCount'),
    productCardCount: pick('productCardCount'),
    articleCardCount: pick('articleCardCount'),
    navItemCount: pick('navItemCount'),
    linkCount: pick('linkCount'),
    imageCount: pick('imageCount'),
    brokenImageCount: Array.isArray(metrics.brokenImages) ? metrics.brokenImages.length : null,
    textNodes: pick('textNodes'),
    hasMenuMobile: pick('hasMenuMobile'),
    hasBottomNav: pick('hasBottomNav'),
    headerRect: pick('headerRect'),
    navRect: pick('navRect'),
    heroRect: pick('heroRect'),
    mainRect: pick('mainRect'),
    footerRect: pick('footerRect'),
    sections: Array.isArray(metrics.sections) ? metrics.sections.map((s) => ({ tag: s.tag, cls: s.cls, rect: s.rect })) : null,
    fonts: metrics.fonts ?? null,
  };
}

/**
 * Resolve the run's provenance from the bootstrap. A document that cannot name the
 * instance it was produced by is refused, never filled with a placeholder.
 */
export function resolveRunProvenance(bootstrap, instance, { label = null, role = null } = {}) {
  const missing = ['attachmentId', 'runId', 'tabId', 'port'].filter((key) => {
    const value = bootstrap?.[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length) {
    throw refuse('PROVENANCE_UNRESOLVED', EXIT.REFUSAL, `the canary bootstrap does not declare ${missing.join(', ')}, so the run cannot be named`, { missing, sessionFile: '.canary/state/canary-session.json' });
  }
  if (!instance || !instance.attachmentId) {
    throw refuse('PROVENANCE_UNRESOLVED', EXIT.REFUSAL, 'the instance identity is absent from .canary/state/canary-session.json, so the run cannot be named', { field: 'instance' });
  }
  return {
    attachmentId: bootstrap.attachmentId,
    runId: bootstrap.runId,
    primaryTabId: bootstrap.tabId ?? null,
    bridgePort: bootstrap.port ?? null,
    authorityRevision: bootstrap.authorityRevision ?? null,
    mintedAt: bootstrap.mintedAt ?? null,
    attemptId: bootstrap.attemptId ?? null,
    instancePid: instance.pid ?? null,
    instanceStartedAt: instance.startedAt ?? null,
    instanceRunId: instance.runId ?? null,
    instanceAttemptId: instance.attemptId ?? null,
    label,
    role,
  };
}

/**
 * Insert (or repair) the `<base>` a replay copy needs. A dump served from loopback
 * would otherwise resolve relative asset URLs against the loopback server. A base
 * the document already declares is resolved against the captured URL, not dropped:
 * a second base tag would be ignored and the first would keep pointing at loopback.
 */
export function injectBaseHref(html, capturedUrl) {
  const tag = `<base href="${String(capturedUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  const existing = /<base\b[^>]*>/i.exec(html);
  if (existing) {
    const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(existing[0]);
    const declared = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '') : '';
    let resolved;
    try {
      resolved = new URL(declared || '.', capturedUrl).toString();
    } catch {
      resolved = String(capturedUrl);
    }
    const replacement = existing[0].replace(/href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `href="${resolved.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
    return { html: `${html.slice(0, existing.index)}${replacement}${html.slice(existing.index + existing[0].length)}`, mode: 'repaired', baseHref: resolved };
  }
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return { html: `${html.slice(0, at)}${tag}${html.slice(at)}`, mode: 'inserted', baseHref: capturedUrl };
  }
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return { html: `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`, mode: 'inserted-head', baseHref: capturedUrl };
  }
  return { html: `${tag}${html}`, mode: 'prepended', baseHref: capturedUrl };
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

function readJsonFile(file, code, exitCode, what) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw refuse(code, exitCode, `${what} ${resolved} does not exist`, { file: resolved });
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (e) {
    throw refuse(code, exitCode, `${what} ${resolved} is unreadable: ${String(e && e.message).slice(0, 200)}`, { file: resolved });
  }
  try {
    return { value: JSON.parse(raw), file: resolved, sha256: sha256(raw) };
  } catch (e) {
    throw refuse(code, exitCode, `${what} ${resolved} is not valid JSON: ${String(e && e.message).slice(0, 200)}`, { file: resolved });
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
  return path.resolve(file);
}

// ── Child processes ───────────────────────────────────────────────────────────

function runChild(command, args, { timeoutMs = DUMP_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, elapsedMs: Date.now() - started });
    };
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ code: null, spawnError: String(e && e.message) }));
    child.on('close', (code) => finish({ code, timedOut: false }));
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      let settled = false;
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (ok, reason) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        if (ok) resolve();
        else if (Date.now() >= deadline) reject(new Error(reason));
        else setTimeout(attempt, 250);
      };
      socket.setTimeout(1200);
      socket.on('connect', () => done(true));
      socket.on('error', (e) => done(false, `port ${port} never accepted a connection: ${e && e.message}`));
      socket.on('timeout', () => done(false, `port ${port} timed out`));
    };
    attempt();
  });
}

/** Kill a child started for this run. Never touches a process this tool did not spawn. */
function stopChild(child, label) {
  const record = { label, pid: child?.pid ?? null, stopped: false, forced: false };
  if (!child || child.exitCode !== null || child.killed) {
    record.stopped = child?.killed === true || child?.exitCode !== null;
    return record;
  }
  try { child.kill('SIGTERM'); record.stopped = true; } catch {}
  if (!record.stopped) {
    try { child.kill('SIGKILL'); record.stopped = true; record.forced = true; } catch {}
  }
  return record;
}

async function startStaticServer(side, root, port) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw refuse('REPLAY_ROOT_MISSING', EXIT.USAGE, `the ${side} side has no DOM dump directory at ${resolvedRoot}`, { side, root: resolvedRoot });
  }
  const child = spawn(process.execPath, [SERVE_STATIC_TOOL, resolvedRoot, String(port)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let exited = null;
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => { exited = code; });
  const ready = `[static] ready http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (output.includes(ready)) break;
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!output.includes(ready)) {
    stopChild(child, `${side}-static-server`);
    throw refuse('REPLAY_SERVER_FAILED', EXIT.NOT_MEASURABLE, `the ${side} replay server on port ${port} never reported ready (${output.trim().slice(0, 300) || 'no output'})`, { side, port, root: resolvedRoot, output: output.slice(0, 800) });
  }
  await waitForPort(port, 10_000);
  return { side, port, root: resolvedRoot, child, output: output.trim() };
}

// ── Bridge helpers ────────────────────────────────────────────────────────────

/** Fetch an immutable PNG artifact over the bridge HTTP endpoint in bounded chunks. */
async function fetchArtifact(bootstrap, artifactId, outFile) {
  const CHUNK = 1024 * 1024;
  const chunks = [];
  let offset = 0;
  for (;;) {
    const { buffer, hasMore } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: bootstrap.port,
          path: `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${CHUNK}`,
          headers: {
            'x-antifan-attachment-secret': bootstrap.secret,
            Authorization: `Bearer ${bootstrap.secret}`,
          },
        },
        (res) => {
          const parts = [];
          res.on('data', (d) => parts.push(d));
          res.on('end', () => (
            res.statusCode === 200
              ? resolve({ buffer: Buffer.concat(parts), hasMore: res.headers['x-artifact-has-more'] === 'true' })
              : reject(new Error(`artifact fetch status ${res.statusCode}`))
          ));
        }
      );
      req.on('error', reject);
      req.setTimeout(60_000, () => req.destroy(new Error('ARTIFACT_STREAM_TIMEOUT')));
      req.end();
    });
    chunks.push(buffer);
    offset += buffer.length;
    if (!hasMore || buffer.length === 0) break;
  }
  const buf = Buffer.concat(chunks);
  const integrity = {
    isPng: buf.length >= 8 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a',
    hasIend: buf.length >= 8 && buf.subarray(-8, -4).toString('latin1') === 'IEND',
    bytes: buf.length,
  };
  if (!integrity.isPng || !integrity.hasIend) {
    throw new NotMeasurable('PNG_INCOMPLETE', `artifact ${artifactId} is not a complete PNG (isPng=${integrity.isPng} hasIend=${integrity.hasIend} bytes=${buf.length})`, integrity);
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), buf);
  return { integrity, sha256: sha256(buf), bytes: buf.length };
}

async function waitForReadyState(call, evalOn, tabId, attempts = 40) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const probe = await evalOn(tabId, '({ rs: document.readyState, h: document.documentElement.scrollHeight })', 5000);
      last = probe ?? null;
      if (probe && probe.rs === 'complete') return { ok: true, probe, attempts: i + 1 };
    } catch (e) {
      last = { error: String(e && e.message).slice(0, 200) };
    }
  }
  return { ok: false, probe: last, attempts };
}

const log = (...args) => console.log('[theme-fidelity]', ...args);

// ── capture ───────────────────────────────────────────────────────────────────

async function runCapture(options) {
  const viewports = parseViewportSpec(options.viewports);
  const loaded = readJsonFile(options.inventory, 'INVENTORY_UNREADABLE', EXIT.USAGE, 'inventory');
  const inventory = validateInventory(loaded.value, { file: loaded.file });
  const safety = evaluateUrlSafety(inventory.targets, options.allowThemes);
  if (safety.refusals.length) {
    const unparsable = safety.refusals.filter((r) => r.code === 'URL_UNPARSABLE');
    if (unparsable.length) {
      throw refuse('INVENTORY_URL_INVALID', EXIT.USAGE, `inventory ${loaded.file} carries an unparsable URL: ${unparsable[0].url}`, { refusals: unparsable });
    }
    throw refuse('THEME_ID_NOT_ALLOWED', EXIT.REFUSAL, safety.refusals
      .map((r) => `${r.url} carries themeid=${r.value}`).join('; '), { refusals: safety.refusals, allowedThemes: safety.allowedThemes });
  }

  const outDir = path.resolve(options.out);
  const domDir = path.join(outDir, 'dom');
  fs.mkdirSync(domDir, { recursive: true });
  const startedAt = nowIso();

  const rpc = await import('./lib-rpc.mjs');
  const settle = await import('./canary-settle.mjs');
  const run = resolveRunProvenance(rpc.bootstrap, loadInstanceIdentity(), { label: options.label, role: options.role });
  const childBootstrapEnv = process.env.ANTIFAN_MCP_BOOTSTRAP_FILE ? { ANTIFAN_MCP_BOOTSTRAP_FILE: process.env.ANTIFAN_MCP_BOOTSTRAP_FILE } : {};
  const gateBySurface = new Map(safety.gates.map((gate) => [gate.surface, gate]));

  log(`capture role=${options.role} label=${options.label} store=${inventory.store} targets=${inventory.targets.length} viewports=${viewports.map((v) => v.label).join(',')} attachment=${run.attachmentId} run=${run.runId}`);

  const entries = [];
  let refusal = null;
  let mintTabId = rpc.bootstrap.tabId ?? null;
  try {
    for (const target of inventory.targets) {
      for (const viewport of viewports) {
        const slug = `${target.slug}__${viewport.label}`;
        mintTabId = await renewSession(rpc, mintTabId);
        const doc = {
          kind: 'theme-fidelity-capture',
          mode: 'capture',
          status: 'NOT_MEASURABLE',
          role: options.role,
          label: options.label,
          store: inventory.store,
          surface: { name: target.name, kind: target.kind, url: target.url, source: target.source, notes: target.notes, template: target.template },
          url: target.url,
          viewport,
          safety: gateBySurface.get(target.name) ?? null,
          release: null,
          tab: null,
          failure: null,
          provenance: null,
          startedAt: nowIso(),
          finishedAt: null,
        };
        let tabId = null;
        let pendingRefusal = null;
        try {
          const created = await rpc.call('anti.browser.tabs.create', { url: target.url, activate: true }, 60_000);
          tabId = created?.tabId || created?.result?.tabId || null;
          if (!tabId) throw new NotMeasurable('TAB_CREATE_FAILED', `anti.browser.tabs.create returned no tabId for ${target.url}`);
          doc.tab = { tabId, openedAt: nowIso(), closed: null, closeError: null };
          await rpc.call('browser.switch-tab', { tabId }, 30_000).catch((e) => log(`  switch-tab warning: ${String(e && e.message).slice(0, 160)}`));
          const sized = await setViewportAndConfirm(rpc, tabId, viewport);
          if (!sized.ok) throw new NotMeasurable('VIEWPORT_NOT_APPLIED', sized.reason, sized.detail);
          const ready = await waitForReadyState(rpc.call, rpc.evalOn, tabId);
          if (!ready.ok) throw new NotMeasurable('READY_STATE_TIMEOUT', `document.readyState never reached complete on ${tabId}`, ready.probe);
          await rpc.evalOn(tabId, IMAGE_HYDRATION_EXPR, 15_000).catch(() => null);
          doc.release = await settle.releaseCompareBlockers(tabId, `${options.label}:${slug}`);

          const capture = await rpc.call('anti.screenshot.full_page', { tabId, ...leaseParams() }, CAPTURE_TIMEOUT_MS);
          const artifactId = capture?.artifactRef?.id || capture?.artifactId || capture?.artifactRef;
          if (!artifactId) throw new NotMeasurable('CAPTURE_NO_ARTIFACT', 'anti.screenshot.full_page returned no artifact reference');
          const pngFile = path.join(outDir, `${slug}.png`);
          const saved = await fetchArtifact(rpc.bootstrap, artifactId, pngFile);
          const png = {
            file: path.basename(pngFile),
            artifactRef: typeof artifactId === 'string' ? artifactId : JSON.stringify(artifactId),
            sha256: saved.sha256,
            bytes: saved.bytes,
            integrity: saved.integrity,
            declaredByteLength: capture?.byteLength ?? capture?.bytes ?? null,
            receipt: capture?.receipt ?? capture?.captureReceipt ?? null,
          };

          const domPath = path.join(domDir, `${slug}.html`);
          const dump = await runChild(process.execPath, [DUMP_REF_TOOL, tabId, domPath, 'sanitize'], { timeoutMs: DUMP_TIMEOUT_MS, env: childBootstrapEnv });
          if (dump.code !== 0) {
            throw new NotMeasurable('DOM_DUMP_FAILED', `dump-ref exited ${dump.code ?? 'null'}${dump.timedOut ? ' (timeout)' : ''}: ${dump.stderr.trim().slice(0, 300)}`, { stdout: dump.stdout.slice(0, 400), stderr: dump.stderr.slice(0, 400) });
          }
          let dumpPayload;
          try {
            dumpPayload = JSON.parse(dump.stdout);
          } catch (e) {
            throw new NotMeasurable('DOM_DUMP_UNREADABLE', `dump-ref did not report a JSON payload: ${String(e && e.message).slice(0, 200)}`, { stdout: dump.stdout.slice(0, 400) });
          }
          const domBytes = fs.readFileSync(domPath);
          const dom = {
            file: path.relative(outDir, domPath).split(path.sep).join('/'),
            sha256: sha256(domBytes),
            bytes: domBytes.length,
            observedUrl: dumpPayload.url ?? null,
            clientWidth: dumpPayload.clientWidth ?? null,
            docHeight: dumpPayload.docHeight ?? null,
            sectionCount: dumpPayload.sectionCount ?? null,
            cardCount: dumpPayload.cardCount ?? null,
            productItems: dumpPayload.productItems ?? null,
            images: dumpPayload.images ?? null,
            sanitized: dumpPayload.sanitized === true,
            removedCount: Array.isArray(dumpPayload.removed) ? dumpPayload.removed.length : null,
            declaredSha256: dumpPayload.sha256 ?? null,
          };
          if (dom.declaredSha256 && dom.declaredSha256 !== dom.sha256) {
            throw new NotMeasurable('DOM_DIGEST_MISMATCH', `dump-ref declared sha256 ${dom.declaredSha256} but the persisted file hashes to ${dom.sha256}`);
          }
          // The URL parameter is what was asked for; the assets inside the document are what
          // was served. A silent substitution is refused before anything is compared.
          const requestedThemeId = URL.canParse(target.url) ? themeIdFromParameter(new URL(target.url).searchParams.get('themeid') ?? '') : null;
          const servedTheme = checkServedTheme(domBytes.toString('utf8'), requestedThemeId);
          dom.servedThemeIds = servedTheme.ids;
          if (servedTheme.refusal) throw servedTheme.refusal;
          const themeIdMismatch = checkObservedUrl(target, dom.observedUrl);
          if (themeIdMismatch) throw themeIdMismatch;

          const tabIdentity = await rpc.evalOn(tabId, TAB_IDENTITY_EXPR, 15_000);
          if (!isMeasurableIdentity(tabIdentity)) {
            throw new NotMeasurable('IDENTITY_UNREADABLE', 'the tab reported no measurable viewport', { tabIdentity: tabIdentity ?? null });
          }
          const metrics = await rpc.evalOn(tabId, settle.METRICS_EXPR, 60_000);
          const geometry = projectGeometry(metrics);
          if (!geometry) {
            throw new NotMeasurable('GEOMETRY_UNREADABLE', 'the tab reported no measurable geometry', { metrics: metrics ?? null });
          }

          doc.status = 'CAPTURED';
          doc.provenance = {
            role: options.role,
            label: options.label,
            store: inventory.store,
            surface: target.name,
            surfaceKind: target.kind,
            viewport: viewport.label,
            url: target.url,
            themeId: gateBySurface.get(target.name)?.themeId ?? null,
            themeIdParameter: gateBySurface.get(target.name)?.parameter ?? null,
            png: { file: png.file, sha256: png.sha256, bytes: png.bytes, artifactRef: png.artifactRef },
            dom: { file: dom.file, sha256: dom.sha256, bytes: dom.bytes, observedUrl: dom.observedUrl },
            domDigest: dom.sha256,
            geometry,
            geometrySha256: geometry ? sha256(JSON.stringify(geometry)) : null,
            tabIdentity,
            instance: { attachmentId: run.attachmentId, bridgePort: run.bridgePort, pid: run.instancePid, primaryTabId: run.primaryTabId, startedAt: run.instanceStartedAt, runId: run.instanceRunId, attemptId: run.instanceAttemptId },
            run: { runId: run.runId, attachmentId: run.attachmentId, authorityRevision: run.authorityRevision, mintedAt: run.mintedAt, label: options.label, role: options.role },
            capturedAt: nowIso(),
          };
          doc.png = png;
          doc.dom = dom;
          doc.geometry = geometry;
          doc.tabIdentity = tabIdentity;
          log(`  ${slug} CAPTURED docHeight=${geometry?.docHeight ?? '?'} sections=${geometry?.sectionCount ?? '?'} device=${tabIdentity.device ?? 'null'} png=${png.bytes}B dom=${dom.bytes}B`);
        } catch (e) {
          // A defect in this harness is not an unmeasurable page: it must abort the run
          // instead of being published as a measurement refusal.
          if (e instanceof TypeError || e instanceof ReferenceError) throw e;
          if (isRefusal(e)) pendingRefusal = e;
          if (tabId) {
            const observed = await rpc.evalOn(tabId, TAB_IDENTITY_EXPR, 15_000).catch(() => null);
            doc.tabIdentityObserved = observed ?? null;
          }
          doc.failure = { code: (pendingRefusal?.code) || e?.code || 'CAPTURE_FAILED', reason: String((e && e.message) || e).slice(0, 600), detail: e?.detail ?? null };
          log(`  ${slug} ${pendingRefusal ? 'REFUSED' : 'NOT_MEASURABLE'}: ${doc.failure.code} — ${doc.failure.reason}`);
        } finally {
          if (tabId && doc.tab) doc.tab.closeError = await closeTab(rpc.call, tabId, doc.tab);
        }
        doc.finishedAt = nowIso();
        const file = writeJson(path.join(outDir, `${slug}.json`), doc);
        entries.push({
          surface: target.name,
          kind: target.kind,
          viewport: viewport.label,
          status: doc.status,
          file: path.basename(file),
          failure: doc.failure,
          png: doc.provenance?.png ?? doc.png ?? null,
          dom: doc.provenance?.dom ?? doc.dom ?? null,
        });
        // The document and its index entry are written first, so a refusal leaves the
        // record of what was measured behind instead of only a stack trace.
        if (pendingRefusal) throw pendingRefusal;
      }
    }
  } catch (e) {
    // Every exit path — refusal, unhandled bridge error or harness defect — leaves the
    // index of what was already measured behind instead of only a stack trace.
    refusal = isRefusal(e)
      ? { code: e.code, exitCode: e.exitCode, message: e.message, detail: e.detail }
      : { code: 'CAPTURE_FAILED', exitCode: EXIT.NOT_MEASURABLE, message: String((e && e.message) || e).slice(0, 600), detail: null };
    if (!isRefusal(e)) console.error(`[theme-fidelity] capture failed: ${(e && e.stack) || e}`);
  }

  // The session the run ends with is rotated away too, so the capture stage leaves the
  // instance's tab plane exactly as it found it.
  if (mintTabId) await closeTab(rpc.call, mintTabId, null);

  const notMeasurable = entries.filter((e) => e.status !== 'CAPTURED');
  const index = {
    kind: 'theme-fidelity-capture-index',
    mode: 'capture',
    status: refusal ? 'REFUSED' : (notMeasurable.length ? 'INCOMPLETE' : 'COMPLETE'),
    role: options.role,
    label: options.label,
    store: inventory.store,
    inventory: { file: loaded.file, sha256: loaded.sha256, surfaces: inventory.targets.filter((t) => t.kind === 'surface').length, views: inventory.targets.filter((t) => t.kind === 'view').length, livePreviewBase: inventory.livePreviewBase, copyPreviewBase: inventory.copyPreviewBase },
    viewports,
    safety: { allowedThemes: safety.allowedThemes, gates: safety.gates },
    targets: entries,
    totals: { requested: inventory.targets.length * viewports.length, documents: entries.length, captured: entries.length - notMeasurable.length, notMeasurable: notMeasurable.length },
    refusal,
    instance: { attachmentId: run.attachmentId, bridgePort: run.bridgePort, pid: run.instancePid, primaryTabId: run.primaryTabId, startedAt: run.instanceStartedAt, runId: run.instanceRunId, attemptId: run.instanceAttemptId },
    run: { runId: run.runId, attachmentId: run.attachmentId, authorityRevision: run.authorityRevision, mintedAt: run.mintedAt, label: options.label, role: options.role },
    startedAt,
    finishedAt: nowIso(),
  };
  writeJson(path.join(outDir, 'index.json'), index);
  log(`capture ${index.status}: ${index.totals.captured}/${index.totals.requested} captured${refusal ? ` (refused ${refusal.code})` : ''} -> ${path.join(outDir, 'index.json')}`);
  // A refusal stops the run after every already-written document is indexed, so the
  // record of what was measured survives the refusal itself.
  if (refusal) throw refuse(refusal.code, refusal.exitCode, refusal.message, refusal.detail);
  return notMeasurable.length ? EXIT.NOT_MEASURABLE : EXIT.OK;
}

/** A redirect that leaves the requested theme is a provenance failure, not a measurement. */
function checkObservedUrl(target, observedUrl) {
  if (!observedUrl) return null;
  let requested;
  let observed;
  try {
    requested = new URL(target.url);
    observed = new URL(observedUrl);
  } catch {
    return null;
  }
  if (requested.host !== observed.host) {
    return refuse('URL_HOST_MISMATCH', EXIT.REFUSAL, `${target.name} was requested at ${requested.host} but the tab reports ${observed.host}`, { target: target.name, requested: target.url, observed: observedUrl });
  }
  const requestedTheme = requested.searchParams.get('themeid');
  const observedTheme = observed.searchParams.get('themeid');
  if (requestedTheme !== observedTheme) {
    return refuse('URL_THEME_MISMATCH', EXIT.REFUSAL, `${target.name} was requested with themeid=${requestedTheme ?? '<none>'} but the tab reports themeid=${observedTheme ?? '<none>'}`, { target: target.name, requested: target.url, observed: observedUrl });
  }
  return null;
}

async function closeTab(call, tabId, tabRecord) {
  const closed = await call('anti.browser.tabs.close', { tabId }, 10_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 200) }));
  const error = closed && closed.error ? closed.error : null;
  if (tabRecord) {
    tabRecord.closed = !error;
    tabRecord.closedAt = nowIso();
  }
  return error;
}

/** The requested viewport, confirmed by what the tab measures once it has settled. */
const VIEWPORT_CONFIRM_TIMEOUT_MS = 90_000;
const VIEWPORT_CONFIRM_INTERVAL_MS = 1_000;
const VIEWPORT_CONFIRM_TOLERANCE_PX = 1;

/**
 * Apply a viewport and report what the tab actually measures.
 *
 * The host returns false when its own reload wait window elapses, not when the resize
 * failed: on a heavy mobile page the reload is still in flight, and re-issuing the resize
 * would race an operation that is already running. Polling the tab the host already asked
 * for is the only safe way to tell those apart, and it is also what decides the outcome —
 * the measurement, not the call's own report.
 */
async function setViewportAndConfirm(rpc, tabId, viewport) {
  const requested = { width: viewport.width, height: viewport.height, mobile: viewport.mobile, deviceScaleFactor: viewport.dpr, reload: true };
  let reportedError = null;
  let reported = null;
  try {
    reported = await rpc.call('browser.set-viewport', { tabId, ...requested }, 120_000);
  } catch (e) {
    reportedError = String((e && e.message) || e).slice(0, 200);
  }
  const deadline = Date.now() + VIEWPORT_CONFIRM_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await rpc.evalOn(tabId, '({ w: window.innerWidth, h: window.innerHeight, rs: document.readyState })', 15_000).catch(() => null);
    if (probe) last = probe;
    if (probe && probe.rs === 'complete' && Math.abs((probe.w ?? 0) - viewport.width) <= VIEWPORT_CONFIRM_TOLERANCE_PX) {
      return { ok: true, observed: probe, reportedError, reportedSuccess: reported?.success ?? null };
    }
    await new Promise((resolve) => setTimeout(resolve, VIEWPORT_CONFIRM_INTERVAL_MS));
  }
  return {
    ok: false,
    reason: reportedError ? `browser.set-viewport failed and the tab never measured the request: ${reportedError}` : 'the tab never measured the requested viewport',
    detail: { requested, last, reportedError, reportedSuccess: reported?.success ?? null },
  };
}

// ── compare ───────────────────────────────────────────────────────────────────

/**
 * The session a re-mint supersedes. Read before the mint overwrites the session file,
 * because after the re-mint the superseded run/attempt/attachment are unrecoverable.
 */
function readSupersededSession(file = SESSION_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { runId, attemptId, attachmentId, secret } = parsed;
    if (!runId || !attachmentId || !secret) return null;
    return { runId, attemptId: attemptId ?? null, attachmentId, secret };
  } catch {
    return null;
  }
}

/**
 * Rotate the session between targets, closing the old mint tab first.
 *
 * A session's attachment is bound to the tab it was minted with, and the bridge counts a
 * session's tab bindings for its whole life rather than its live set, so captures stop
 * being adoptable long before any tab is left open: measured on a freshly restarted
 * instance, the third target of the first role was refused `POLICY_DENIED (session tab
 * quota reached)` while nothing was still running. Re-minting is the remedy the 15-page
 * campaign already uses, one page at a time. The mint tab is closed while its own session
 * still owns it — a later session cannot close it, and leaving it open would trade a quota
 * refusal for an orphan tab in the instance.
 *
 * Re-minting alone is not enough: the bindings of a superseded session are returned only
 * by ending it, and the pool those bindings come from is never swept. A run that only
 * re-mints therefore spends the pool as it goes and every later pair is refused
 * `SESSION_RENEWAL_FAILED` by the mint itself. The release runs before the mint, because
 * the mint needs a binding of its own. The bridge accepts `antifan.cli.endSession` only
 * from a socket already bound to that same attachment, which is this one, so the release
 * is strictly self-scoped and cannot reach a session this run does not own.
 */
async function renewSession(rpc, previousMintTabId, record = null) {
  if (previousMintTabId) await closeTab(rpc.call, previousMintTabId, null);
  const superseded = readSupersededSession();
  const minted = await runChild(process.execPath, [SESSION_TOOL, String(rpc.bootstrap.port), SESSION_FILE], {
    timeoutMs: 120_000,
    env: process.env.ANTIFAN_MCP_BOOTSTRAP_FILE ? { ANTIFAN_MCP_BOOTSTRAP_FILE: process.env.ANTIFAN_MCP_BOOTSTRAP_FILE } : {},
  });
  if (minted.code !== 0) {
    throw new NotMeasurable('SESSION_RENEWAL_FAILED', `canary-session.mjs exited ${minted.code ?? 'null'}${minted.timedOut ? ' (timeout)' : ''}: ${minted.stderr.trim().slice(0, 300)}`);
  }
  // The release runs after the mint, never before it. The bridge tears a session down
  // asynchronously, and a mint issued while that teardown is still in flight has its
  // lifecycle socket reset (`read ECONNRESET`); measured with a probe, the same mint
  // succeeds once the teardown has settled. It is sent over the socket bound to the old
  // attachment — the bootstrap in memory, before `reloadBootstrap` adopts the file the mint
  // just rewrote — because that is the only socket the bridge accepts `endSession` from.
  if (superseded) {
    const release = await rpc.rpcCall('antifan.cli.endSession', superseded, 8_000)
      .then(() => ({ released: true }))
      .catch((e) => ({ released: false, error: String((e && e.message) || e).slice(0, 200) }));
    // The session secret authorises the release and is never recorded: the verdict names
    // the session it ended, not the credential it used.
    if (record) record.sessionRelease = { runId: superseded.runId, attemptId: superseded.attemptId, attachmentId: superseded.attachmentId, ...release };
  }
  rpc.reloadBootstrap();
  return rpc.bootstrap.tabId ?? null;
}

function readCaptureIndex(dir, side) {
  const resolved = path.resolve(dir);
  const loaded = readJsonFile(path.join(resolved, 'index.json'), 'SIDE_INDEX_MISSING', EXIT.USAGE, `${side} side index`);
  const index = loaded.value;
  if (!index || typeof index !== 'object' || index.kind !== 'theme-fidelity-capture-index' || !Array.isArray(index.targets)) {
    throw refuse('SIDE_INDEX_UNREADABLE', EXIT.USAGE, `${side} side index ${loaded.file} is not a theme-fidelity capture index`, { side, file: loaded.file, kind: index?.kind ?? null });
  }
  return { dir: resolved, file: loaded.file, sha256: loaded.sha256, index };
}

function readSideEvidence(sideDir, entry, side) {
  const file = path.resolve(sideDir, entry.file);
  if (!fs.existsSync(file)) {
    throw refuse('ARTIFACT_UNREADABLE', EXIT.USAGE, `${side} evidence ${file} named by the index does not exist`, { side, file, surface: entry.surface, viewport: entry.viewport });
  }
  const loaded = readJsonFile(file, 'ARTIFACT_UNREADABLE', EXIT.USAGE, `${side} evidence for ${entry.surface}@${entry.viewport}`);
  const doc = loaded.value;
  if (!doc || typeof doc !== 'object' || doc.kind !== 'theme-fidelity-capture') {
    throw refuse('ARTIFACT_UNREADABLE', EXIT.USAGE, `${side} evidence ${file} is not a theme-fidelity capture document`, { side, file, kind: doc?.kind ?? null });
  }
  return { doc, file, sha256: loaded.sha256 };
}

/** Every field a verdict must be able to name, per side. Missing ones refuse. */
function assertSideProvenance(side, doc, file) {
  const p = doc.provenance;
  const missing = [];
  if (doc.status !== 'CAPTURED') missing.push(`status=${doc.status}`);
  if (!p || typeof p !== 'object') missing.push('provenance');
  else {
    if (!trimmed(p.url)) missing.push('provenance.url');
    // The theme id must be *recorded*, including the recorded absence a URL without
    // a themeid parameter legitimately has: resolved-to-nothing is a refusal, a
    // recorded "carries none" is provenance.
    if (!Object.prototype.hasOwnProperty.call(p, 'themeId') || !Object.prototype.hasOwnProperty.call(p, 'themeIdParameter')) missing.push('provenance.themeId');
    if (!trimmed(p.store)) missing.push('provenance.store');
    if (!trimmed(p.surface)) missing.push('provenance.surface');
    if (!trimmed(p.viewport)) missing.push('provenance.viewport');
    if (!p.png || !trimmed(p.png.sha256) || !Number.isFinite(p.png.bytes)) missing.push('provenance.png');
    if (!p.dom || !trimmed(p.dom.sha256)) missing.push('provenance.dom');
    if (!trimmed(p.domDigest)) missing.push('provenance.domDigest');
    if (!p.geometry) missing.push('provenance.geometry');
    if (!p.tabIdentity) missing.push('provenance.tabIdentity');
    if (!p.instance) missing.push('provenance.instance');
    if (!p.run) missing.push('provenance.run');
    if (!trimmed(p.capturedAt)) missing.push('provenance.capturedAt');
  }
  if (missing.length) {
    throw refuse('PROVENANCE_UNRESOLVED', EXIT.REFUSAL, `${side} evidence ${file} cannot be judged: ${missing.join(', ')}`, { side, file, missing, surface: doc.surface?.name ?? null, viewport: doc.viewport?.label ?? null });
  }
  return p;
}

/** The pinned artifact must still be the artifact that was pinned. */
function verifyArtifact(side, sideDir, provenance, kind) {
  const rel = kind === 'png' ? provenance.png.file : provenance.dom.file;
  if (!trimmed(rel)) {
    throw refuse('PROVENANCE_UNRESOLVED', EXIT.REFUSAL, `${side} ${kind} has no recorded file name`, { side, kind });
  }
  const file = path.resolve(sideDir, rel);
  if (!fs.existsSync(file)) {
    throw refuse('ARTIFACT_MISSING', EXIT.REFUSAL, `${side} ${kind} artifact ${file} is absent, so the pin cannot be verified`, { side, kind, file });
  }
  const observed = sha256File(file);
  const expected = kind === 'png' ? provenance.png.sha256 : provenance.dom.sha256;
  if (observed !== expected) {
    throw refuse('ARTIFACT_DIGEST_MISMATCH', EXIT.REFUSAL, `${side} ${kind} artifact ${file} hashes to ${observed}, not the pinned ${expected}`, { side, kind, file, expected, observed });
  }
  const bytes = fs.statSync(file).size;
  if (kind === 'png' && Number.isFinite(provenance.png.bytes) && provenance.png.bytes !== bytes) {
    throw refuse('ARTIFACT_DIGEST_MISMATCH', EXIT.REFUSAL, `${side} png artifact ${file} is ${bytes} bytes, not the pinned ${provenance.png.bytes}`, { side, kind, file, expected: provenance.png.bytes, observed: bytes });
  }
  return { file, bytes, sha256: observed };
}

async function runCompare(options) {
  const outDir = path.resolve(options.out);
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = nowIso();
  const results = [];
  const servers = {};
  let reference = null;
  let subject = null;
  let run = null;
  let refusal = null;
  try {
    reference = readCaptureIndex(options.reference, 'reference');
    subject = readCaptureIndex(options.subject, 'subject');
    if (trimmed(reference.index.store) !== trimmed(subject.index.store)) {
      throw refuse('SIDE_STORE_MISMATCH', EXIT.REFUSAL, `the sides measure different stores: reference=${reference.index.store ?? '<none>'} subject=${subject.index.store ?? '<none>'}`, { reference: reference.index.store ?? null, subject: subject.index.store ?? null });
    }
    const { pairs, referenceOnly, subjectOnly } = pairArtifacts(reference.index.targets, subject.index.targets);
    if (referenceOnly.length || subjectOnly.length) {
      const describe = (keys) => keys.map((k) => k.replace('__', '@')).join(', ');
      const parts = [];
      if (referenceOnly.length) parts.push(`only in reference: ${describe(referenceOnly)}`);
      if (subjectOnly.length) parts.push(`only in subject: ${describe(subjectOnly)}`);
      if (!pairs.length) parts.push('no pairs at all');
      throw refuse('PAIR_SET_MISMATCH', EXIT.USAGE, `the sides do not carry the same surface x viewport set (${parts.join('; ')})`, { referenceOnly, subjectOnly, pairs: pairs.length });
    }
    if (!pairs.length) throw refuse('PAIR_SET_EMPTY', EXIT.USAGE, 'the sides carry no surface x viewport pairs to compare', { reference: reference.file, subject: subject.file });

    // Both sides are read, named and safety-gated before a single tab exists: a case
    // whose provenance cannot be resolved is refused, never filled with a placeholder.
    const unsafe = [];
    for (const pair of pairs) {
      for (const side of ['reference', 'subject']) {
        const loaded = readSideEvidence(side === 'reference' ? reference.dir : subject.dir, pair[side], side);
        const provenance = assertSideProvenance(side, loaded.doc, loaded.file);
        pair[`${side}Doc`] = loaded.doc;
        pair[`${side}File`] = loaded.file;
        pair[`${side}Provenance`] = provenance;
        const themeId = provenance.themeId;
        if (themeId !== null && themeId !== undefined && !DEFAULT_ALLOWED_THEMES.includes(String(themeId)) && String(themeId) !== PRODUCTION_THEME) {
          unsafe.push({ side, surface: pair.surface, viewport: pair.viewport, url: provenance.url, themeId, file: loaded.file });
        }
      }
    }
    if (unsafe.length) {
      const first = unsafe[0];
      throw refuse('THEME_ID_NOT_ALLOWED', EXIT.REFUSAL, `${first.side} evidence ${first.file} names ${first.url} with themeid=${first.themeId}, which is neither ${PRODUCTION_THEME} nor an allowed theme (${DEFAULT_ALLOWED_THEMES.join(', ')})`, { unsafe, allowedThemes: DEFAULT_ALLOWED_THEMES });
    }

    const rpc = await import('./lib-rpc.mjs');
    const settle = await import('./canary-settle.mjs');
    run = resolveRunProvenance(rpc.bootstrap, loadInstanceIdentity());
    log(`compare reference=${reference.dir} subject=${subject.dir} pairs=${pairs.length} run=${run.runId} attachment=${run.attachmentId}`);

    // The replay copies are written under --out, so the servers are rooted there:
    // serving the captured dumps in place would put the injected <base> copy outside
    // the server root, where the hardened static server refuses it by realpath.
    const replayRoots = { reference: path.join(outDir, 'replay', 'reference'), subject: path.join(outDir, 'replay', 'subject') };
    for (const side of ['reference', 'subject']) fs.mkdirSync(replayRoots[side], { recursive: true });
    servers.reference = await startStaticServer('reference', replayRoots.reference, REPLAY_PORTS.reference);
    servers.subject = await startStaticServer('subject', replayRoots.subject, REPLAY_PORTS.subject);
    log(`replay servers ready: reference :${servers.reference.port} subject :${servers.subject.port}`);

    for (const pair of pairs) {
      const verdict = await comparePair({ pair, reference, subject, servers, rpc, settle, run, outDir, compareParams: STRICT_COMPARE_PARAMS });
      results.push(verdict.summary);
      console.log(formatPairLine(verdict.summary));
      writeJson(path.join(outDir, `${slugify(pair.surface)}__${pair.viewport}.json`), verdict.doc);
    }
  } catch (e) {
    refusal = isRefusal(e)
      ? { code: e.code, exitCode: e.exitCode, message: e.message, detail: e.detail }
      : { code: 'COMPARE_FAILED', exitCode: EXIT.NOT_MEASURABLE, message: String((e && e.message) || e).slice(0, 600), detail: null };
    if (!isRefusal(e)) console.error(`[theme-fidelity] compare failed: ${(e && e.stack) || e}`);
  } finally {
    for (const side of ['reference', 'subject']) {
      if (servers[side]) servers[side].stopped = stopChild(servers[side].child, `${side}-static-server`);
    }
  }

  const totals = {
    pairs: results.length,
    pass: results.filter((r) => r.verdict === 'PASS').length,
    fail: results.filter((r) => r.verdict === 'FAIL').length,
    inconclusive: results.filter((r) => r.verdict === 'INCONCLUSIVE').length,
    notMeasurable: results.filter((r) => r.status !== 'PASS' && r.status !== 'FAIL' && r.status !== 'INCONCLUSIVE').length,
  };
  const index = {
    kind: 'theme-fidelity-verdict-index',
    mode: 'compare',
    status: refusal ? 'REFUSED' : (totals.notMeasurable ? 'INCOMPLETE' : 'COMPLETE'),
    store: reference?.index?.store ?? null,
    reference: reference ? { dir: reference.dir, index: reference.file, indexSha256: reference.sha256, role: reference.index.role ?? null, label: reference.index.label ?? null } : { dir: path.resolve(options.reference), index: null, indexSha256: null, role: null, label: null },
    subject: subject ? { dir: subject.dir, index: subject.file, indexSha256: subject.sha256, role: subject.index.role ?? null, label: subject.index.label ?? null } : { dir: path.resolve(options.subject), index: null, indexSha256: null, role: null, label: null },
    strictParams: { ...STRICT_COMPARE_PARAMS, trackedSelectors: TRACKED },
    pairs: results,
    totals,
    refusal,
    replayServers: {
      reference: servers.reference ? { port: servers.reference.port, root: servers.reference.root, stopped: servers.reference.stopped } : null,
      subject: servers.subject ? { port: servers.subject.port, root: servers.subject.root, stopped: servers.subject.stopped } : null,
    },
    instance: run ? { attachmentId: run.attachmentId, bridgePort: run.bridgePort, pid: run.instancePid, primaryTabId: run.primaryTabId, startedAt: run.instanceStartedAt, runId: run.instanceRunId, attemptId: run.instanceAttemptId } : null,
    run: run ? { runId: run.runId, attachmentId: run.attachmentId, authorityRevision: run.authorityRevision, mintedAt: run.mintedAt } : null,
    startedAt,
    finishedAt: nowIso(),
  };
  writeJson(path.join(outDir, 'index.json'), index);
  log(`compare ${index.status}: pairs=${totals.pairs} pass=${totals.pass} fail=${totals.fail} inconclusive=${totals.inconclusive} notMeasurable=${totals.notMeasurable}${refusal ? ` (refused ${refusal.code})` : ''} -> ${path.join(outDir, 'index.json')}`);
  if (refusal) return refusal.exitCode;
  return totals.notMeasurable ? EXIT.NOT_MEASURABLE : EXIT.OK;
}

async function comparePair({ pair, reference, subject, servers, rpc, settle, run, outDir, compareParams }) {
  const referenceProvenance = pair.referenceProvenance;
  const subjectProvenance = pair.subjectProvenance;
  const viewport = {
    label: pair.referenceDoc.viewport?.label ?? pair.viewport,
    width: pair.referenceDoc.viewport?.width ?? null,
    height: pair.referenceDoc.viewport?.height ?? null,
    mobile: pair.referenceDoc.viewport?.mobile ?? null,
    dpr: pair.referenceDoc.viewport?.dpr ?? 1,
  };
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw refuse('PROVENANCE_UNRESOLVED', EXIT.REFUSAL, `reference evidence for ${pair.surface}@${pair.viewport} carries no measurable viewport`, { surface: pair.surface, viewport: pair.viewport });
  }
  // The pinned artifacts are re-verified before anything is replayed.
  const referencePng = verifyArtifact('reference', reference.dir, referenceProvenance, 'png');
  const subjectPng = verifyArtifact('subject', subject.dir, subjectProvenance, 'png');
  const referenceDom = verifyArtifact('reference', reference.dir, referenceProvenance, 'dom');
  const subjectDom = verifyArtifact('subject', subject.dir, subjectProvenance, 'dom');

  const doc = {
    kind: 'theme-fidelity-verdict',
    mode: 'compare',
    status: null,
    verdict: null,
    mechanism: null,
    reason: null,
    store: reference.index.store ?? null,
    surface: { name: pair.surface, kind: pair.referenceDoc.surface?.kind ?? null },
    viewport,
    strictParams: { ...compareParams, trackedSelectors: TRACKED },
    provenance: { reference: referenceProvenance, subject: subjectProvenance },
    artifacts: {
      reference: { png: referencePng, dom: referenceDom },
      subject: { png: subjectPng, dom: subjectDom },
    },
    replay: { reference: null, subject: null },
    identity: null,
    measurement: { reference: null, subject: null },
    compare: null,
    instance: { attachmentId: run.attachmentId, bridgePort: run.bridgePort, pid: run.instancePid, primaryTabId: run.primaryTabId, startedAt: run.instanceStartedAt, runId: run.instanceRunId, attemptId: run.instanceAttemptId },
    run: { runId: run.runId, attachmentId: run.attachmentId, authorityRevision: run.authorityRevision, mintedAt: run.mintedAt },
    tabs: { reference: null, subject: null },
    startedAt: nowIso(),
    finishedAt: null,
    printLine: null,
  };

  const replayFile = (side, provenance, domArtifact, server) => {
    const injected = injectBaseHref(fs.readFileSync(domArtifact.file, 'utf8'), provenance.url);
    const dir = path.join(outDir, 'replay', side);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slugify(pair.surface)}__${pair.viewport}.html`);
    fs.writeFileSync(file, injected.html);
    return {
      side,
      source: { file: domArtifact.file, sha256: domArtifact.sha256, bytes: domArtifact.bytes },
      file,
      url: `http://127.0.0.1:${server.port}/${path.basename(file)}`,
      baseHref: injected.baseHref,
      baseMode: injected.mode,
      sha256: sha256(injected.html),
      bytes: Buffer.byteLength(injected.html),
    };
  };
  doc.replay.reference = replayFile('reference', referenceProvenance, referenceDom, servers.reference);
  doc.replay.subject = replayFile('subject', subjectProvenance, subjectDom, servers.subject);

  let referenceTabId = null;
  let subjectTabId = null;
  try {
    // Two tabs per pair against a session pool of ten bindings, and the pool is never
    // swept, so each pair is opened on a freshly minted session: the superseded session is
    // ended first, which is what returns its bindings, and the mint tab it replaces is
    // closed while its own session still owns it.
    await renewSession(rpc, rpc.bootstrap.tabId ?? null, doc);
    const materialize = async (side, url, tabRecord) => {
      const created = await rpc.call('anti.browser.tabs.create', { url, activate: true }, 60_000);
      const tabId = created?.tabId || created?.result?.tabId || null;
      if (!tabId) throw new NotMeasurable('TAB_CREATE_FAILED', `anti.browser.tabs.create returned no tabId for ${url}`);
      tabRecord.tabId = tabId;
      tabRecord.openedAt = nowIso();
      await rpc.call('browser.switch-tab', { tabId }, 30_000).catch((e) => log(`  ${side} switch-tab warning: ${String(e && e.message).slice(0, 160)}`));
      const sized = await setViewportAndConfirm(rpc, tabId, { ...viewport, width: viewport.width, height: viewport.height, mobile: Boolean(viewport.mobile), dpr: viewport.dpr ?? 1 });
      if (!sized.ok) throw new NotMeasurable('VIEWPORT_NOT_APPLIED', sized.reason, sized.detail);
      const ready = await waitForReadyState(rpc.call, rpc.evalOn, tabId);
      if (!ready.ok) throw new NotMeasurable('READY_STATE_TIMEOUT', `${side} replay never reached readyState complete`, ready.probe);
      await rpc.evalOn(tabId, IMAGE_HYDRATION_EXPR, 15_000).catch(() => null);
      const hydrated = await settle.hydrateToCapturedState(tabId, `${side}:${pair.surface}@${pair.viewport}`, leaseParams(), COMPARE_TIMEOUT_MS);
      tabRecord.hydration = { captureBytes: hydrated.capture?.byteLength ?? hydrated.capture?.bytes ?? null, docHeight: hydrated.settled?.metrics?.docHeight ?? null };
      return { tabId, hydrated };
    };

    doc.tabs.reference = {};
    const ref = await materialize('reference', doc.replay.reference.url, doc.tabs.reference);
    referenceTabId = ref.tabId;
    doc.tabs.subject = {};
    const sub = await materialize('subject', doc.replay.subject.url, doc.tabs.subject);
    subjectTabId = sub.tabId;

    const released = {};
    for (const [side, tabId] of [['reference', referenceTabId], ['subject', subjectTabId]]) {
      released[side] = await settle.releaseCompareBlockers(tabId, `compare:${pair.surface}@${pair.viewport}:${side}`);
    }
    doc.release = {
      reference: { widgets: released.reference?.widgets ?? null, freezeReleased: released.reference?.freezeReleased ?? null, timerSweep: released.reference?.timerSweep ?? null, motion: released.reference?.timerSweepMotion ?? null },
      subject: { widgets: released.subject?.widgets ?? null, freezeReleased: released.subject?.freezeReleased ?? null, timerSweep: released.subject?.timerSweep ?? null, motion: released.subject?.timerSweepMotion ?? null },
    };

    const measured = {};
    for (const [side, tabId] of [['reference', referenceTabId], ['subject', subjectTabId]]) {
      const identity = await rpc.evalOn(tabId, TAB_IDENTITY_EXPR, 15_000);
      measured[side] = { tabIdentity: identity ?? null, geometry: null, docHeight: null };
      if (!isMeasurableIdentity(identity)) {
        throw new NotMeasurable('IDENTITY_UNREADABLE', `the ${side} replay tab reported no measurable viewport`, { side, identity: identity ?? null });
      }
    }
    measured.reference.geometry = projectGeometry(ref.hydrated.settled?.metrics ?? null);
    measured.subject.geometry = projectGeometry(sub.hydrated.settled?.metrics ?? null);
    measured.reference.docHeight = typeof measured.reference.tabIdentity.docHeight === 'number' ? measured.reference.tabIdentity.docHeight : measured.reference.geometry?.docHeight ?? null;
    measured.subject.docHeight = typeof measured.subject.tabIdentity.docHeight === 'number' ? measured.subject.tabIdentity.docHeight : measured.subject.geometry?.docHeight ?? null;
    doc.measurement = measured;

    const identity = {
      fields: IDENTITY_FIELDS,
      tolerancePx: DOC_HEIGHT_TOLERANCE_PX,
      reference: { pinned: referenceProvenance.tabIdentity, measured: measured.reference.tabIdentity, ...compareIdentityFields(referenceProvenance.tabIdentity, measured.reference.tabIdentity) },
      subject: { pinned: subjectProvenance.tabIdentity, measured: measured.subject.tabIdentity, ...compareIdentityFields(subjectProvenance.tabIdentity, measured.subject.tabIdentity) },
      deviceClass: {
        reference: measured.reference.tabIdentity.device ?? null,
        subject: measured.subject.tabIdentity.device ?? null,
        pinnedReference: referenceProvenance.tabIdentity.device ?? null,
        pinnedSubject: subjectProvenance.tabIdentity.device ?? null,
        agree: (measured.reference.tabIdentity.device ?? null) === (measured.subject.tabIdentity.device ?? null),
      },
    };
    doc.identity = identity;

    // Withhold before spending a compare when the two sides are different layouts:
    // comparing a mobile-layout page against a web-layout one is not a fidelity
    // measurement, which is what viewport-run.mjs's DEVICE_CLASS_ASYMMETRY refuses.
    const drifted = ['reference', 'subject'].filter((side) => identity[side].agree !== true);
    const deviceAsymmetry = identity.deviceClass.agree !== true;
    if (drifted.length || deviceAsymmetry) {
      const mechanisms = [];
      for (const side of drifted) mechanisms.push(`${side.toUpperCase()}_IDENTITY_DRIFT`);
      if (deviceAsymmetry) mechanisms.push('DEVICE_CLASS_ASYMMETRY');
      doc.status = 'INCONCLUSIVE';
      doc.verdict = 'INCONCLUSIVE';
      doc.mechanism = mechanisms.join('+');
      doc.reason = [
        ...drifted.map((side) => `${side} identity drifted from its pin: ${identity[side].differences.map((d) => `${d.field} ${d.pinned} -> ${d.measured}`).join(', ')}`),
        deviceAsymmetry ? `the sides declare different data-device layout classes (reference=${identity.deviceClass.reference}, subject=${identity.deviceClass.subject})` : null,
      ].filter(Boolean).join('; ');
    } else {
      let compare = null;
      let compareError = null;
      try {
        compare = await rpc.call('anti.visual.compare', {
          tabId: referenceTabId,
          comparisonTabId: subjectTabId,
          fullPage: compareParams.fullPage,
          tolerance: compareParams.tolerance,
          normalizeScroll: compareParams.normalizeScroll,
          allowHeightDrift: compareParams.allowHeightDrift,
          useDefaultWidgetMasks: compareParams.useDefaultWidgetMasks,
          trackedSelectors: TRACKED,
          ...leaseParams(),
        }, COMPARE_TIMEOUT_MS);
      } catch (e) {
        compareError = String((e && e.message) || e).slice(0, 600);
      }
      const cr = compare?.result || compare || {};
      const mapped = mapVisualVerdict(cr);
      doc.compare = {
        params: { ...compareParams, trackedSelectors: TRACKED },
        status: compareError ? 'COMPARE_ERROR' : 'COMPLETED',
        error: compareError,
        verdict: cr.verdict ?? null,
        toolStatus: cr.status ?? null,
        match: cr.match ?? null,
        mismatchPercentage: cr.mismatchPercentage ?? null,
        dimensionsMatch: cr.dimensionsMatch ?? null,
        diffPixels: cr.diffPixels ?? null,
        totalPixels: cr.totalPixels ?? null,
        diffBoundingBox: cr.diffBoundingBox ?? null,
        mask: cr.maskResolution ?? cr.maskAudit ?? null,
        layout: cr.dimensions?.layout ?? null,
        dimensions: cr.dimensions ?? null,
        coherence: cr.coherence ?? null,
        captureReceipts: cr.captureReceipts ?? null,
        reason: cr.reason ?? null,
        elapsedMs: compare?.elapsedMs ?? null,
      };
      if (compareError) {
        doc.status = 'COMPARE_ERROR';
        doc.verdict = 'INCONCLUSIVE';
        doc.mechanism = 'COMPARE_ERROR';
        doc.reason = compareError;
      } else {
        doc.status = mapped.verdict;
        doc.verdict = mapped.verdict;
        doc.mechanism = mapped.unmapped ? mapped.unmapped : mapped.verdict === 'PASS' ? 'MATCH' : mapped.verdict === 'FAIL' ? 'STRUCTURAL_PARITY_MISMATCH' : 'TOOL_INCONCLUSIVE';
        doc.reason = mapped.unmapped ? `the comparator returned ${mapped.unmapped}, which is not a fidelity verdict and is withheld` : doc.compare.reason;
      }
      // Re-read the same identity after the transaction rasterized both pages: a
      // page that moved mid-compare cannot be judged, and the numbers stay here.
      const postCompare = {};
      for (const [side, tabId] of [['reference', referenceTabId], ['subject', subjectTabId]]) {
        const identityAfter = await rpc.evalOn(tabId, TAB_IDENTITY_EXPR, 15_000).catch(() => null);
        postCompare[side] = identityAfter ?? null;
      }
      doc.postCompareIdentity = postCompare;
      if (doc.verdict !== 'INCONCLUSIVE') {
        const moved = ['reference', 'subject'].filter((side) => !isMeasurableIdentity(postCompare[side])
          || postCompare[side].docHeight !== measured[side].tabIdentity.docHeight);
        if (moved.length) {
          doc.status = 'INCONCLUSIVE';
          doc.verdict = 'INCONCLUSIVE';
          doc.mechanism = `${moved.map((s) => s.toUpperCase()).join('+')}_POST_COMPARE_MOTION`;
          doc.reason = `side(s) ${moved.join(', ')} measured a different document height after the compare rasterized them (${moved.map((s) => `${s}: ${measured[s].tabIdentity.docHeight} -> ${postCompare[s]?.docHeight ?? 'unreadable'}`).join('; ')})`;
        }
      }
    }
  } catch (e) {
    if (isRefusal(e)) throw e;
    doc.status = 'NOT_MEASURABLE';
    doc.verdict = 'INCONCLUSIVE';
    doc.mechanism = e?.code || 'REPLAY_NOT_MEASURABLE';
    doc.reason = String((e && e.message) || e).slice(0, 600);
    // The per-pass components are the only evidence that names which predicate
    // disagreed; the 600-char reason truncates them, so persist them verbatim.
    doc.settlePasses = Array.isArray(e?.passes) ? e.passes : null;
  } finally {
    const closed = {};
    for (const [side, tabId] of [['reference', referenceTabId], ['subject', subjectTabId]]) {
      if (!tabId) continue;
      const record = doc.tabs?.[side] ?? (doc.tabs[side] = {});
      record.closeError = await closeTab(rpc.call, tabId, record);
      closed[side] = record.closed === true;
    }
    doc.tabsClosed = closed;
    doc.finishedAt = nowIso();
  }

  const summary = {
    surface: pair.surface,
    viewport: pair.viewport,
    status: doc.status,
    verdict: doc.verdict,
    mechanism: doc.mechanism,
    file: `${slugify(pair.surface)}__${pair.viewport}.json`,
    mismatchPercentage: doc.compare?.mismatchPercentage ?? null,
    referenceHeight: doc.measurement?.reference?.docHeight ?? referenceProvenance.geometry?.docHeight ?? null,
    subjectHeight: doc.measurement?.subject?.docHeight ?? subjectProvenance.geometry?.docHeight ?? null,
    referencePngSha256: referenceProvenance.png.sha256,
    subjectPngSha256: subjectProvenance.png.sha256,
  };
  doc.printLine = formatPairLine(summary);
  return { doc, summary };
}

// ── entry point ───────────────────────────────────────────────────────────────

function reportRefusal(e) {
  const refusal = isRefusal(e) ? e : refuse('UNEXPECTED', EXIT.NOT_MEASURABLE, String((e && e.message) || e));
  console.error(`[theme-fidelity] REFUSED ${refusal.code} (exit ${refusal.exitCode}): ${refusal.message}`);
  if (refusal.detail) console.error(`[theme-fidelity] detail: ${JSON.stringify(refusal.detail).slice(0, 1200)}`);
  return refusal.exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return reportRefusal(e);
  }
  if (parsed.mode === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  try {
    return parsed.mode === 'capture' ? await runCapture(parsed.options) : await runCompare(parsed.options);
  } catch (e) {
    if (isRefusal(e)) return reportRefusal(e);
    console.error(`[theme-fidelity] FAILED: ${(e && e.stack) || e}`);
    return EXIT.NOT_MEASURABLE;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(await main());
