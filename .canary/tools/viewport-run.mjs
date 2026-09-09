/**
 * Real-canary viewport runner: reference vs independent clone at one viewport.
 *
 *   node .canary/tools/viewport-run.mjs <label> <width> <height> <refTabId> <cloneTabId> [runDir] [minSections] [minCards]
 *
 * Evidence model (never merged):
 *   - INDEPENDENT lineage  : anti.screenshot.full_page per tab -> raw PNG + receipt + SHA256.
 *                            Continuity evidence only; NEVER an authoritative pixel input.
 *   - AUTHORITATIVE lineage: one atomic anti.visual.compare pair captured under a single pair
 *                            lock. The only pixel inputs the verdict may use.
 *   - STRUCTURAL           : unmasked geometry/cardinality probes on both sides.
 *   - SELF-DRIFT           : optional reference-vs-reference pair (CANARY_SELF_DRIFT=1),
 *                            diagnostic only; never subtracted from the candidate mismatch.
 *
 * Strict fidelity parameters are mandatory here: allowHeightDrift:false,
 * useDefaultWidgetMasks:false, no user masks.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { call, evalOn, bootstrap } from './lib-rpc.mjs';

const [, , label, widthArg, heightArg, refTabId, cloneTabId, runDirArg, minSectionsArg, minCardsArg] = process.argv;
if (!label || !widthArg || !heightArg || !refTabId || !cloneTabId) {
  console.error('usage: viewport-run.mjs <label> <width> <height> <refTabId> <cloneTabId> [runDir] [minSections] [minCards]');
  process.exit(2);
}
const width = Number(widthArg);
const height = Number(heightArg);
// Readiness floors are derived from the captured reference artifact (never invented
// per-run): the reference must still expose at least this structure before any
// pixel verdict is meaningful.
const minSections = Number(minSectionsArg || 1);
const minCards = Number(minCardsArg || 1);
const runDir = path.resolve(runDirArg || '.canary/run1');
const evDir = path.join(runDir, 'evidence');
fs.mkdirSync(evDir, { recursive: true });

const COMPARE_TIMEOUT_MS = Number(process.env.CANARY_COMPARE_TIMEOUT_MS || 240000);
const STANDALONE_TIMEOUT_MS = Number(process.env.CANARY_STANDALONE_TIMEOUT_MS || 120000);
const SKIP_COMPARE = process.env.CANARY_SKIP_COMPARE === '1';
const SELF_DRIFT = process.env.CANARY_SELF_DRIFT === '1';
// Exclusive evidence-run lease minted by canary-run.mjs (artifact.preflight).
// Every staging capability must present it while the lease is held, otherwise
// the runtime rejects the stage with TRANSACTION_CONFLICT.
const LEASE_TOKEN = process.env.CANARY_LEASE_TOKEN || null;
const LEASE_PARAM = LEASE_TOKEN ? { leaseToken: LEASE_TOKEN } : {};

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** In-page settle probe: real font/image/DOM/visual-stability evidence. */
/**
 * Settle is composed of separately bounded probes because the browser evaluate
 * bridge rejects any single evaluation that runs longer than 15s. A rotating
 * carousel mutates attribute styles forever, so DOM quiet counts structural
 * (childList) churn only, and visual stability is judged on geometry.
 */
const SETTLE_IMAGES_EXPR = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  let fontsSettled = false;
  try { await Promise.race([document.fonts.ready, sleep(2500)]); fontsSettled = document.fonts.status === 'loaded'; } catch {}
  // The image set is re-read every sample: a late hydration that mounts more
  // images must not be mistaken for a settled page.
  const deadline = performance.now() + 9000;
  let lastCount = -1, stableSamples = 0;
  for (;;) {
    const list = Array.from(document.images);
    const pending = list.filter(i => !i.complete);
    if (list.length === lastCount && pending.length === 0) {
      stableSamples++;
      if (stableSamples >= 4) return { fontsSettled, imagesSettled: true, imageCount: list.length, pendingImages: 0, durationMs: Math.round(performance.now() - t0) };
    } else stableSamples = 0;
    lastCount = list.length;
    if (performance.now() > deadline) return { fontsSettled, imagesSettled: pending.length === 0, imageCount: list.length, pendingImages: pending.length, durationMs: Math.round(performance.now() - t0) };
    await sleep(100);
  }
})()`;

const SETTLE_DOM_EXPR = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  let structural = 0;
  const mo = new MutationObserver(list => { for (const m of list) if (m.type === 'childList') structural += m.addedNodes.length + m.removedNodes.length; });
  mo.observe(document.documentElement, { subtree: true, childList: true });
  let quietFor = 0;
  while (quietFor < 1500 && performance.now() - t0 < 9000) { const before = structural; await sleep(100); if (structural === before) quietFor += 100; else quietFor = 0; }
  mo.disconnect();
  return { domSettled: quietFor >= 1500, structuralMutations: structural, durationMs: Math.round(performance.now() - t0) };
})()`;

const SETTLE_VISUAL_EXPR = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  document.querySelectorAll('svg').forEach((s) => {
    try { if (typeof s.pauseAnimations === 'function') s.pauseAnimations(); } catch {}
  });
  const sig = () => Array.from(document.querySelectorAll('body *:not(svg *)')).slice(0, 4000)
    .filter(e => !e.closest('svg'))
    .map(e => { const r = e.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height); }).join('|');
  let stablePairs = 0;
  let prev = sig();
  while (stablePairs < 2 && performance.now() - t0 < 9000) { await sleep(400); const cur = sig(); if (cur === prev) stablePairs++; else stablePairs = 0; prev = cur; }
  return {
    visualStable: stablePairs >= 2,
    durationMs: Math.round(performance.now() - t0),
    imageCount: document.images.length,
    pendingImages: Array.from(document.images).filter(i => !i.complete).length,
    brokenImages: Array.from(document.images).filter(i => i.complete && i.naturalWidth === 0).map(i => (i.currentSrc || i.src || '').slice(0, 200)),
    readyState: document.readyState,
    fontsStatus: document.fonts.status,
  };
})()`;

/** Structural geometry + cardinality + typography + asset render evidence. */
const METRICS_EXPR = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: px(r.x), y: px(r.y + window.scrollY), w: px(r.width), h: px(r.height) }; };
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).join('.');
  const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const sections = Array.from(document.querySelectorAll('section, header.site-header, footer, .site-footer')).map(el => ({ tag: el.tagName.toLowerCase(), cls: cls(el), rect: rectOf(el) }));
  const gridInfo = (sel) => Array.from(document.querySelectorAll(sel)).map(el => {
    const cs = getComputedStyle(el);
    const kids = Array.from(el.children).filter(k => k.getBoundingClientRect().height > 0);
    const cols = new Set(kids.map(k => Math.round(k.getBoundingClientRect().x)));
    const rows = new Set(kids.map(k => Math.round(k.getBoundingClientRect().y)));
    return { cls: cls(el), rect: rectOf(el), display: cs.display, gridTemplateColumns: cs.gridTemplateColumns, flexWrap: cs.flexWrap, childCount: kids.length, columns: cols.size, rows: rows.size, gap: cs.gap };
  });
  const cardRects = (sel) => Array.from(document.querySelectorAll(sel)).map(el => rectOf(el));
  const imgs = Array.from(document.images).map(i => { const r = i.getBoundingClientRect(); return { src: (i.currentSrc || i.src || '').slice(0, 160), natural: [i.naturalWidth, i.naturalHeight], rendered: [px(r.width), px(r.height)], objectFit: getComputedStyle(i).objectFit, complete: i.complete, ok: i.complete && i.naturalWidth > 0, y: px(r.y + window.scrollY) }; });
  const fonts = {};
  for (const sel of ['body', 'h1', 'h2', 'h3', '.product-list__item', 'a']) { const el = document.querySelector(sel); if (el) { const cs = getComputedStyle(el); fonts[sel] = { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, letterSpacing: cs.letterSpacing }; } }
  return {
    url: location.href,
    docHeight: docH,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyChildren: Array.from(document.body.children).map(n => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + cls(n) : '')),
    headerRect: rectOf(document.querySelector('header.site-header') || document.querySelector('header')),
    navRect: rectOf(document.querySelector('nav') || document.querySelector('header nav')),
    heroRect: rectOf(document.querySelector('.slide, .slideshow, .banner, .swiper, [class*="hero"]')),
    footerRect: rectOf(document.querySelector('.site-footer') || document.querySelector('footer')),
    mainRect: rectOf(document.querySelector('main')),
    sections,
    sectionCount: document.querySelectorAll('section').length,
    productCardCount: document.querySelectorAll('.product-list__item, .product-item, .product-card').length,
    productCardsBySection: Array.from(document.querySelectorAll('section')).map(s => ({ cls: cls(s), cards: s.querySelectorAll('.product-list__item, .product-item, .product-card').length })),
    productListGrids: gridInfo('.product-list, .product-list__grid, [class*="product-list"]'),
    grids: gridInfo('[class*="grid"], .row'),
    cardRects: cardRects('.product-list__item').slice(0, 40),
    articleCardCount: document.querySelectorAll('.news-item, .article-item, .blog-item, [class*="news"] article').length,
    navItemCount: document.querySelectorAll('header.site-header nav a, header.site-header .menu a, header.site-header li a').length,
    linkCount: document.querySelectorAll('a').length,
    buttonRects: Array.from(document.querySelectorAll('button, .btn, [class*="button"]')).slice(0, 30).map(rectOf),
    images: imgs,
    imageCount: imgs.length,
    brokenImages: imgs.filter(i => !i.ok).map(i => i.src),
    fonts,
    textNodes: document.body.innerText.split('\\n').filter(t => t.trim()).length,
  };
})()`;

const TRACKED = [
  'body', 'header.site-header', 'main', '.site-footer', 'section',
  '.product-list__item', '.slide', '.news-item',
];

async function settleAndMeasure(tabId, name) {
  const net = await call('browser.wait', { tabId, condition: 'network_idle', idleWindowMs: 600, timeoutMs: 12000 }).catch(e => ({ error: String(e.message || e) }));
  const dom = await call('browser.wait', { tabId, condition: 'dom_stable', timeoutMs: 12000 }).catch(e => ({ error: String(e.message || e) }));
  // Capture normalization applied symmetrically to both sides: Chromium defers
  // loading="lazy" images in background tabs, so promote them to eager and walk
  // the document. This changes only WHEN the same assets load, never layout.
  await evalOn(tabId, `(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
    const H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    for (let y = 0; y <= H; y += 800) { window.scrollTo(0, y); await s(40); }
    window.scrollTo(0, H); await s(100);
    try {
      const pending = Array.from(document.images).filter(i => i.src && !i.complete);
      const decodes = pending.slice(0, 50).map(i => i.decode ? i.decode().catch(() => {}) : Promise.resolve());
      await Promise.race([Promise.allSettled(decodes), s(2500)]);
    } catch {}
    window.scrollTo(0, 0); await s(100);
    return true;
  })()`, 12000).catch(() => null);
  let freeze = null;
  try {
    freeze = await call('anti.media.freeze', { tabId, freeze: true, normalizeSliders: false }, 15000);
  } catch (e) {
    freeze = { error: String(e.message || e).slice(0, 300) };
  }
  const freezeOk = Boolean(freeze && !freeze.error && freeze.frozen === true);
  let images = { fontsSettled: false, imagesSettled: false, pendingImages: 0 };
  for (let pass = 0; pass < 3; pass++) {
    images = await evalOn(tabId, SETTLE_IMAGES_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
    if (images.imagesSettled === true) break;
    if (pass < 2) await new Promise(r => setTimeout(r, 1000));
  }
  const domQuiet = await evalOn(tabId, SETTLE_DOM_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const visual = await evalOn(tabId, SETTLE_VISUAL_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const settled = freezeOk && images.imagesSettled === true && domQuiet.domSettled === true && visual.visualStable === true;
  const settle = {
    freeze,
    mediaFrozen: freezeOk,
    fontsSettled: images.fontsSettled === true,
    imagesSettled: images.imagesSettled === true,
    domSettled: domQuiet.domSettled === true,
    visualStable: visual.visualStable === true,
    timedOut: !settled,
    imageCount: visual.imageCount ?? images.imageCount ?? null,
    pendingImages: visual.pendingImages ?? images.pendingImages ?? null,
    brokenImages: visual.brokenImages ?? [],
    structuralMutations: domQuiet.structuralMutations ?? null,
    settlementDuration: (images.durationMs || 0) + (domQuiet.durationMs || 0) + (visual.durationMs || 0),
    readyState: visual.readyState ?? null,
    fontsStatus: visual.fontsStatus ?? null,
    phases: { images, domQuiet, visual },
  };
  const metrics = await evalOn(tabId, METRICS_EXPR, 60000);
  return { name, networkIdle: net, domStable: dom, settle, metrics };
}

/**
 * Fail closed: a pixel verdict is only meaningful when both sides reached a real
 * settled state and the reference still exposes the structure it was captured with.
 */
function evaluateReadiness(stage, role) {
  const s = stage.settle || {};
  const m = stage.metrics || {};
  const reasons = [];
  if (s.fontsSettled !== true) reasons.push('fontsSettled=false');
  if (s.imagesSettled !== true) reasons.push(`imagesSettled=false(pending=${s.pendingImages ?? '?'})`);
  if (s.domSettled !== true) reasons.push('domSettled=false');
  if (s.visualStable !== true) reasons.push('visualStable=false');
  if (s.mediaFrozen !== true) reasons.push(`mediaFrozen=${s.mediaFrozen}`);
  if ((s.pendingImages || 0) > 0) reasons.push(`pendingImages=${s.pendingImages}`);
  if (role === 'reference') {
    if ((m.sectionCount || 0) < minSections) reasons.push(`sectionCount=${m.sectionCount}<${minSections}`);
    if ((m.productCardCount || 0) < minCards) reasons.push(`productCardCount=${m.productCardCount}<${minCards}`);
  }
  return { ok: reasons.length === 0, reasons };
}

const evidence = {
  label,
  viewport: { width, height },
  startedAt: new Date().toISOString(),
  evidenceModel: {
    independent: 'anti.screenshot.full_page per tab — continuity evidence only, never an authoritative pixel input',
    authoritative: 'single atomic anti.visual.compare pair under one pair lock — the only authoritative pixel inputs',
    strictParams: { allowHeightDrift: false, useDefaultWidgetMasks: false, userMasks: [] },
  },
  stages: {},
};
const persist = () => fs.writeFileSync(path.join(evDir, `${label}.json`), JSON.stringify(evidence, null, 2));

/** Reference-vs-clone structural deltas (§11). Cardinality and geometry only. */
function buildStructuralComparison(ref, clone) {
  const delta = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.round((b - a) * 100) / 100 : null;
  const box = (a, b) => (a && b) ? { dh: delta(a.h, b.h), dy: delta(a.y, b.y), dw: delta(a.w, b.w) } : null;
  const key = (s) => ((s.cls || '').split('.').filter(Boolean)[0]) || s.tag;
  const consumed = new Set();
  const sections = ref.sections.map((rs) => {
    const idx = clone.sections.findIndex((cs, i) => !consumed.has(i) && key(cs) === key(rs));
    if (idx === -1) return { cls: key(rs), reference: { y: Math.round(rs.rect.y), h: Math.round(rs.rect.h) }, clone: null, dh: null };
    consumed.add(idx);
    const cs = clone.sections[idx];
    return { cls: key(rs), reference: { y: Math.round(rs.rect.y), h: Math.round(rs.rect.h) }, clone: { y: Math.round(cs.rect.y), h: Math.round(cs.rect.h) }, dh: Math.round(cs.rect.h - rs.rect.h) };
  });
  return {
    docHeight: { reference: ref.docHeight, clone: clone.docHeight, delta: delta(ref.docHeight, clone.docHeight), ratio: ref.docHeight ? Math.round((clone.docHeight / ref.docHeight) * 1000) / 1000 : null },
    overflowX: { reference: ref.overflowX, clone: clone.overflowX },
    sectionCount: { reference: ref.sectionCount, clone: clone.sectionCount, delta: delta(ref.sectionCount, clone.sectionCount) },
    productCardCount: { reference: ref.productCardCount, clone: clone.productCardCount, delta: delta(ref.productCardCount, clone.productCardCount) },
    articleCardCount: { reference: ref.articleCardCount, clone: clone.articleCardCount, delta: delta(ref.articleCardCount, clone.articleCardCount) },
    navItemCount: { reference: ref.navItemCount, clone: clone.navItemCount, delta: delta(ref.navItemCount, clone.navItemCount) },
    linkCount: { reference: ref.linkCount, clone: clone.linkCount, delta: delta(ref.linkCount, clone.linkCount) },
    imageCount: { reference: ref.imageCount, clone: clone.imageCount, delta: delta(ref.imageCount, clone.imageCount) },
    brokenImages: { reference: ref.brokenImages.length, clone: clone.brokenImages.length },
    header: box(ref.headerRect, clone.headerRect),
    main: box(ref.mainRect, clone.mainRect),
    footer: box(ref.footerRect, clone.footerRect),
    sections
  };
}

/** Fetch an immutable artifact over the bridge HTTP endpoint in bounded chunks and persist it locally. */
async function fetchArtifact(artifactId, outFile) {
  const boot = bootstrap;
  const CHUNK = 1024 * 1024;
  const chunks = [];
  let offset = 0;
  for (;;) {
    const { buffer, hasMore } = await new Promise((resolve, reject) => {
      const p = `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${CHUNK}`;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: boot.port,
          path: p,
          headers: {
            'x-antifan-attachment-secret': boot.secret,
            'Authorization': `Bearer ${boot.secret}`,
          },
        },
        (r) => {
          const parts = [];
          r.on('data', (d) => parts.push(d));
          r.on('end', () =>
            r.statusCode === 200
              ? resolve({ buffer: Buffer.concat(parts), hasMore: r.headers['x-artifact-has-more'] === 'true' })
              : reject(new Error(`artifact fetch status ${r.statusCode}`))
          );
        }
      );
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('ARTIFACT_STREAM_TIMEOUT')));
      req.end();
    });
    chunks.push(buffer);
    offset += buffer.length;
    if (!hasMore || buffer.length === 0) break;
  }
  const buf = Buffer.concat(chunks);
  const isPng = buf.length >= 8 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  const hasIend = buf.length >= 8 && buf.subarray(-8, -4).toString('latin1') === 'IEND';
  if (!isPng || !hasIend) {
    throw new Error(`artifact ${artifactId} is not a complete PNG (isPng=${isPng} hasIend=${hasIend} bytes=${buf.length})`);
  }
  fs.writeFileSync(outFile, buf);
  return { bytes: buf.length, sha256: sha256(buf) };
}

log(`set viewport ${width}x${height} on both tabs (reload both sides)`);
// A tab that has never been foregrounded reports innerHeight=0 and lays out
// against a zero-height viewport; a reload in the background re-enters that
// degenerate state. Establish each side's viewport and hydrate it while it is
// foreground, then move on to the other side (a foregrounded tab keeps its real
// layout once backgrounded).
await call('browser.switch-tab', { tabId: refTabId }, 30_000).catch((e) => log(`reference activate warning: ${e.message}`));
await call('browser.set-viewport', { tabId: refTabId, width, height, mobile: false, deviceScaleFactor: 1, reload: true });
// Explicit reload so neither side reuses DOM state mutated by the preceding viewport.
await call('browser.reload', { tabId: refTabId }).catch((e) => log(`reference reload error: ${e.message}`));
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 400));
  try {
    const r = await evalOn(refTabId, '({ rs: document.readyState, h: document.documentElement.scrollHeight })', 5000);
    if (r && r.rs === 'complete') break;
  } catch {}
}
await evalOn(refTabId, `(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  for (let pass = 0; pass < 2; pass++) {
    const H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    for (let y = 0; y <= H; y += 600) { window.scrollTo(0, y); await s(60); }
    window.scrollTo(0, H);
    await s(300);
  }
  window.scrollTo(0, 0);
  await s(200);
  return true;
})()`, 12000).catch(() => null);

log('settling + measuring reference');
evidence.stages.reference = await settleAndMeasure(refTabId, 'reference');
const refReadiness = evaluateReadiness(evidence.stages.reference, 'reference');
evidence.readiness = { reference: refReadiness };
log(`reference docHeight=${evidence.stages.reference.metrics.docHeight} sections=${evidence.stages.reference.metrics.sectionCount} cards=${evidence.stages.reference.metrics.productCardCount} ready=${refReadiness.ok}`);
if (!refReadiness.ok) {
  evidence.status = 'REFERENCE_NOT_READY';
  persist();
  log(`ABORT: reference not ready [${refReadiness.reasons.join('; ')}] — no pixel verdict produced`);
  process.exit(3);
}

await call('browser.switch-tab', { tabId: cloneTabId }, 30_000).catch((e) => log(`clone activate warning: ${e.message}`));
await call('browser.set-viewport', { tabId: cloneTabId, width, height, mobile: false, deviceScaleFactor: 1, reload: true });
await call('browser.reload', { tabId: cloneTabId }).catch((e) => log(`clone reload error: ${e.message}`));
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 400));
  try {
    const r = await evalOn(cloneTabId, '({ rs: document.readyState, h: document.documentElement.scrollHeight })', 5000);
    if (r && r.rs === 'complete') break;
  } catch {}
}

log('settling + measuring clone');
evidence.stages.clone = await settleAndMeasure(cloneTabId, 'clone');
const cloneReadiness = evaluateReadiness(evidence.stages.clone, 'clone');
evidence.readiness.clone = cloneReadiness;
log(`clone docHeight=${evidence.stages.clone.metrics.docHeight} sections=${evidence.stages.clone.metrics.sectionCount} cards=${evidence.stages.clone.metrics.productCardCount} ready=${cloneReadiness.ok}`);
if (!cloneReadiness.ok) {
  evidence.status = 'CLONE_NOT_READY';
  persist();
  log(`ABORT: clone not ready [${cloneReadiness.reasons.join('; ')}] — no pixel verdict produced`);
  process.exit(3);
}

evidence.structural = buildStructuralComparison(evidence.stages.reference.metrics, evidence.stages.clone.metrics);
persist();

// ── INDEPENDENT lineage: standalone canonical full-page capture per tab ────────
// Continuity evidence only. Never promoted to an authoritative compare input.
log('standalone full-page captures (independent lineage)');
evidence.standalone = {};
for (const [role, tabId] of [['reference', refTabId], ['clone', cloneTabId]]) {
  try {
    const res = await call('anti.screenshot.full_page', { tabId, ...LEASE_PARAM }, STANDALONE_TIMEOUT_MS);
    const artifactId = res?.artifactRef?.id || res?.artifactId || res?.artifactRef;
    const receipt = res?.receipt || res?.captureReceipt || null;
    const entry = {
      tabId,
      status: 'CAPTURED',
      artifactId,
      receipt,
      sha256: res?.sha256 ?? null,
      byteLength: res?.byteLength ?? null,
      authoritative: false,
      label: 'independent continuity evidence — NOT an authoritative pixel input',
    };
    if (artifactId) {
      try {
        const file = path.join(evDir, `${label}-standalone-${role}.png`);
        const saved = await fetchArtifact(artifactId, file);
        entry.file = path.basename(file);
        entry.fetchedBytes = saved.bytes;
        entry.fetchedSha256 = saved.sha256;
        entry.byteForByte = entry.sha256 ? saved.sha256 === entry.sha256 : null;
        if (entry.sha256 && saved.sha256 !== entry.sha256) {
          entry.status = 'CORRUPT_SHA';
          throw new Error(`standalone SHA mismatch: declared ${entry.sha256} vs fetched ${saved.sha256}`);
        }
        if (entry.byteLength && saved.bytes !== entry.byteLength) {
          entry.status = 'TRUNCATED_BYTES';
          throw new Error(`standalone byte mismatch: declared ${entry.byteLength} vs fetched ${saved.bytes}`);
        }
      } catch (e) {
        entry.fetchError = String(e.message || e).slice(0, 300);
      }
    }
    evidence.standalone[role] = entry;
    log(`  ${role} standalone ${entry.status} mode=${receipt?.captureMode ?? '?'} raster=${receipt?.rasterSize ? `${receipt.rasterSize.width}x${receipt.rasterSize.height}` : '?'} bytes=${entry.byteLength ?? '?'}`);
  } catch (e) {
    evidence.standalone[role] = { tabId, status: 'STANDALONE_CAPTURE_ERROR', error: String(e.message || e).slice(0, 500), authoritative: false };
    log(`  ${role} standalone FAILED: ${e.message}`);
  }
  persist();
}

// ── AUTHORITATIVE lineage: one atomic compare pair ────────────────────────────
log(`full-page visual compare (authoritative)${SKIP_COMPARE ? ' (skipped by CANARY_SKIP_COMPARE)' : ''}`);
let compare = null;
if (SKIP_COMPARE) {
  evidence.stages.compare = { status: 'SKIPPED' };
  evidence.visual = { status: 'SKIPPED' };
} else try {
  compare = await call('anti.visual.compare', {
    tabId: refTabId,
    comparisonTabId: cloneTabId,
    fullPage: true,
    tolerance: 2,
    normalizeScroll: true,
    allowHeightDrift: false,
    useDefaultWidgetMasks: false,
    trackedSelectors: TRACKED,
    ...LEASE_PARAM,
  }, COMPARE_TIMEOUT_MS);
  evidence.stages.compare = compare.result || compare;
  log(`mismatch=${compare.result?.mismatchPercentage}% dimsMatch=${compare.result?.dimensionsMatch}`);
} catch (e) {
  evidence.stages.compare = { status: 'COMPARE_ERROR', error: String(e.message || e).slice(0, 500), elapsedMs: Date.now() - T0 };
  log(`full-page compare FAILED: ${e.message}`);
}
const cr = compare?.result || compare || {};
const derivedVerdict = cr.dimensionsMatch === true
  ? (cr.match === true ? 'PASS' : 'FAIL')
  : (cr.verdict || (cr.status === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : null));
evidence.visual = {
  match: cr.match ?? null,
  mismatchPercentage: cr.mismatchPercentage ?? null,
  verdict: derivedVerdict,
  toolVerdict: cr.verdict ?? null,
  toolStatus: cr.status ?? null,
  reason: cr.reason ?? null,
  dimensionsMatch: cr.dimensionsMatch ?? null,
  diffPixels: cr.diffPixels ?? null,
  totalPixels: cr.totalPixels ?? null,
  diffBoundingBox: cr.diffBoundingBox ?? null,
  mask: cr.maskResolution ?? cr.maskAudit ?? null,
  layout: cr.dimensions?.layout ?? null,
  coherence: cr.coherence ?? null,
  captureReceipts: cr.captureReceipts ?? null,
  normalization: cr.normalization ?? null,
};
log(`visual mismatch=${evidence.visual.mismatchPercentage}% verdict=${evidence.visual.verdict} mask=${JSON.stringify(evidence.visual.mask)?.slice(0, 160)}`);
persist();

// Persist the authoritative pair (the ONLY pixel inputs the verdict may use).
evidence.authoritativePair = {};
const cur = cr.currentScreenshot;
const base = cr.baselineScreenshot;
const artifactId = (a) => (typeof a === 'string' ? a : a?.artifactId || a?.id || a?.artifactRef);
for (const [key, art] of [['reference', cur], ['clone', base]]) {
  const id = artifactId(art);
  if (!id) { evidence.authoritativePair[key] = { status: 'NO_ARTIFACT', raw: JSON.stringify(art ?? null).slice(0, 200) }; continue; }
  try {
    const file = path.join(evDir, `${label}-${key}.png`);
    const saved = await fetchArtifact(id, file);
    let stat = null;
    try { stat = await call('artifact.stat', { artifactId: id }, 10000); } catch {}
    const declaredSha = (typeof art === 'object' && typeof art?.sha256 === 'string') ? art.sha256 : (stat?.sha256 || null);
    const declaredBytes = (typeof art === 'object' && typeof art?.byteLength === 'number') ? art.byteLength : (stat?.byteLength || null);
    if (!declaredSha || typeof declaredSha !== 'string') {
      throw new Error(`missing declared SHA for artifact ${id}`);
    }
    if (!declaredBytes || typeof declaredBytes !== 'number' || declaredBytes <= 0) {
      throw new Error(`missing declared byte length for artifact ${id}`);
    }
    if (saved.sha256 !== declaredSha) {
      throw new Error(`authoritative SHA mismatch: declared ${declaredSha} vs fetched ${saved.sha256}`);
    }
    if (saved.bytes !== declaredBytes) {
      throw new Error(`authoritative byte mismatch: declared ${declaredBytes} vs fetched ${saved.bytes}`);
    }
    const byteForByte = Boolean(saved.bytes === declaredBytes && saved.sha256 === declaredSha);
    if (!byteForByte) {
      throw new Error(`authoritative byte-for-byte mismatch for ${id}`);
    }
    evidence.authoritativePair[key] = {
      status: 'PERSISTED',
      artifactId: id,
      file: path.basename(file),
      bytes: saved.bytes,
      sha256: saved.sha256,
      authoritative: true,
      declaredBytes,
      declaredSha,
      byteForByte,
    };
    log(`  saved authoritative ${key} ${saved.bytes} bytes sha256=${saved.sha256.slice(0, 16)}… byteForByte=${evidence.authoritativePair[key].byteForByte}`);
  } catch (e) {
    evidence.authoritativePair[key] = { status: 'FETCH_ERROR', artifactId: id, error: String(e.message || e).slice(0, 300), authoritative: true };
    log(`  authoritative ${key} fetch FAILED: ${e.message}`);
  }
}
persist();

// ── SELF-DRIFT (diagnostic only; never subtracted from the candidate) ─────────
if (SELF_DRIFT) {
  log('reference self-drift pair (diagnostic only)');
  try {
    const drift = await call('anti.visual.compare', {
      tabId: refTabId,
      comparisonTabId: refTabId,
      fullPage: true,
      tolerance: 2,
      normalizeScroll: true,
      allowHeightDrift: false,
      useDefaultWidgetMasks: false,
      trackedSelectors: TRACKED,
      ...LEASE_PARAM,
    }, COMPARE_TIMEOUT_MS);
    const dr = drift?.result || drift;
    evidence.selfDrift = {
      status: 'MEASURED',
      mismatchPercentage: dr?.mismatchPercentage ?? null,
      dimensionsMatch: dr?.dimensionsMatch ?? null,
      maskedAreaRatio: dr?.maskResolution?.maskedAreaRatio ?? null,
      note: 'diagnostic only — never subtracted from the candidate mismatch',
    };
    log(`  self-drift mismatch=${dr?.mismatchPercentage}%`);
  } catch (e) {
    evidence.selfDrift = { status: 'SELF_DRIFT_ERROR', error: String(e.message || e).slice(0, 400) };
    log(`  self-drift FAILED: ${e.message}`);
  }
  persist();
}

// Sectional diagnostics via clipRect (same rect on both tabs = like-for-like regions).
const refMetrics = evidence.stages.reference.metrics;
const cloneMetrics = evidence.stages.clone.metrics;
const bands = [];
const push = (name, rect) => { if (rect && rect.h > 8 && rect.w > 8) bands.push({ name, rect }); };
push('header', refMetrics.headerRect);
push('hero', refMetrics.heroRect);
for (const s of refMetrics.sections) push(`section:${s.cls || s.tag}`, s.rect);
push('footer', refMetrics.footerRect);
const seen = new Set();
evidence.stages.sections = [];
if (SKIP_COMPARE || evidence.stages.compare?.status === 'COMPARE_ERROR') {
  log(`skipping sectional compares (${SKIP_COMPARE ? 'CANARY_SKIP_COMPARE' : 'full-page compare failed'})`);
  persist();
} else
for (const band of bands) {
  const key = `${band.name}@${band.rect.y}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const rect = { x: 0, y: Math.round(band.rect.y), width: Math.round(refMetrics.clientWidth), height: Math.min(Math.round(band.rect.h), 2000) };
  const cloneHas = cloneMetrics.docHeight >= rect.y + 20;
  if (!cloneHas) {
    evidence.stages.sections.push({ name: band.name, rect, status: 'REGION_ABSENT_IN_CLONE', cloneDocHeight: cloneMetrics.docHeight });
    continue;
  }
  try {
    const r = await call('anti.visual.compare', {
      tabId: refTabId, comparisonTabId: cloneTabId, fullPage: true, tolerance: 2,
      normalizeScroll: true, allowHeightDrift: false, useDefaultWidgetMasks: false, clipRect: rect,
      ...LEASE_PARAM,
    }, Math.min(COMPARE_TIMEOUT_MS, 120000));
    const res = r.result || r;
    evidence.stages.sections.push({ name: band.name, rect, mismatchPercentage: res.mismatchPercentage, dimensionsMatch: res.dimensionsMatch, diffPixels: res.diffPixels, totalPixels: res.totalPixels, maskRatio: res.maskResolution?.maskedAreaRatio });
    log(`  section ${band.name} @y=${rect.y} h=${rect.height}: ${res.mismatchPercentage}%`);
  } catch (e) {
    evidence.stages.sections.push({ name: band.name, rect, status: 'COMPARE_ERROR', error: String(e.message || e).slice(0, 300) });
    log(`  section ${band.name}: ERROR ${e.message}`);
  }
  persist();
}

evidence.finishedAt = new Date().toISOString();
const outFile = path.join(evDir, `${label}.json`);
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
log(`wrote ${outFile}`);
