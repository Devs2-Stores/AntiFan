/**
 * Canonical Settle and Measure Module for ANTiFan Visual Fidelity Canary
 *
 * Implements the proven settle contract:
 * - Network idle wait (idleWindowMs: 600, timeoutMs: 12000)
 * - DOM stable wait (timeoutMs: 12000)
 * - Lazy image promotion (loading="lazy" -> eager)
 * - Dynamic scroll walk to trigger IntersectionObservers and dynamic section mounts
 * - Pending image decode pass
 * - anti.media.freeze (animations, videos, sliders paused)
 * - SETTLE_IMAGES_EXPR (fontsSettled, imagesSettled, pendingImages == 0)
 * - SETTLE_DOM_EXPR (MutationObserver childList quiet for >= 1500ms)
 * - SETTLE_VISUAL_EXPR (bounding rect signature stable across consecutive samples)
 * - METRICS_EXPR (structural geometry, sectionCount, productCardCount, typography, assets)
 */
import { call, evalOn } from './lib-rpc.mjs';

/**
 * Storefront card elements. Hoplongtech renders product cards as
 * `.product-list__item` and category cards as `.thumbnail`. A floor derived from
 * product classes alone is vacuous whenever the live homepage serves category
 * cards, which silently disables the readiness gate.
 */
export const CARD_SELECTOR = '.product-list__item, .product-item, .product-card, .col-item, .thumbnail';

/**
 * Canonical section count. Structural sections are not always `<section>`: the
 * live storefront uses `<main>`, `<header>` and `<footer>` for some blocks, so a
 * bare `<section>` count under-reports and a floor derived from it cannot detect
 * a partially mounted reference.
 */
export const SECTION_SELECTOR = 'section, header, footer, main, article, .site-header, .site-footer';
export const SECTION_COUNT_EXPR = `Math.max(document.querySelectorAll('${SECTION_SELECTOR}').length, document.querySelectorAll('section').length)`;

export const SETTLE_IMAGES_EXPR = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  let fontsSettled = false;
  try { await Promise.race([document.fonts.ready, sleep(2500)]); fontsSettled = document.fonts.status === 'loaded'; } catch {}
  const deadline = performance.now() + 9000;
  document.querySelectorAll('img[loading="lazy"]').forEach(i => { try { i.loading = 'eager'; } catch {} });
  let lastCount = -1, stableSamples = 0;
  for (;;) {
    const list = Array.from(document.images);
    list.forEach(i => { if (i.loading === 'lazy') try { i.loading = 'eager'; } catch {} });
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

export const SETTLE_DOM_EXPR = `(async () => {
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

export const SETTLE_VISUAL_EXPR = `(async () => {
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

export const METRICS_EXPR = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: px(r.x), y: px(r.y + window.scrollY), w: px(r.width), h: px(r.height) }; };
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).join('.');
  const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const sections = Array.from(document.querySelectorAll('${SECTION_SELECTOR}')).map(el => ({ tag: el.tagName.toLowerCase(), cls: cls(el), rect: rectOf(el) }));
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
    hasMenuMobile: Boolean(document.querySelector('.menu-mobile, [class*="menu-mobile"]')),
    hasBottomNav: Boolean(document.querySelector('.bottom-navigation, [class*="bottom-navigation"]')),
    bodyChildren: Array.from(document.body.children).map(n => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + cls(n) : '')),
    headerRect: rectOf(document.querySelector('header.site-header') || document.querySelector('header')),
    navRect: rectOf(document.querySelector('nav') || document.querySelector('header nav')),
    heroRect: rectOf(document.querySelector('.slide, .slideshow, .banner, .swiper, [class*="hero"]')),
    footerRect: rectOf(document.querySelector('.site-footer') || document.querySelector('footer')),
    mainRect: rectOf(document.querySelector('main')),
    sections,
    sectionCount: ${SECTION_COUNT_EXPR},
    productCardCount: document.querySelectorAll('${CARD_SELECTOR}').length,
    productCardsBySection: Array.from(document.querySelectorAll('section')).map(s => ({ cls: cls(s), cards: s.querySelectorAll('${CARD_SELECTOR}').length })),
    productListGrids: gridInfo('.product-list, .product-list__grid, [class*="product-list"]'),
    grids: gridInfo('[class*="grid"], .row'),
    cardRects: cardRects('${CARD_SELECTOR}').slice(0, 40),
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

export async function settleAndMeasure(tabId, name) {
  const net = await call('browser.wait', { tabId, condition: 'network_idle', idleWindowMs: 600, timeoutMs: 12000 }).catch(e => ({ error: String(e.message || e) }));
  const dom = await call('browser.wait', { tabId, condition: 'dom_stable', timeoutMs: 12000 }).catch(e => ({ error: String(e.message || e) }));

  // Dynamic progressive scroll pass to trigger lazy observers and content expansion
  await evalOn(tabId, `(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelectorAll('img[loading="lazy"]').forEach(i => { try { i.loading = 'eager'; } catch {} });
    let lastH = 0;
    for (let pass = 0; pass < 6; pass++) {
      const H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = Math.max(0, lastH - 400); y <= H; y += 400) { window.scrollTo(0, y); await s(50); }
      window.scrollTo(0, H); await s(200);
      const newH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      if (newH === H && pass >= 1) break;
      lastH = H;
    }
    try {
      const pending = Array.from(document.images).filter(i => i.src && !i.complete);
      const decodes = pending.slice(0, 60).map(i => i.decode ? i.decode().catch(() => {}) : Promise.resolve());
      await Promise.race([Promise.allSettled(decodes), s(6000)]);
    } catch {}
    window.scrollTo(0, 0); await s(100);
    return true;
  })()`, 25000).catch(() => null);

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
  images = await evalOn(tabId, SETTLE_IMAGES_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
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
 * Hydrate a tab into the state the comparator will actually rasterize.
 *
 * The storefront mounts its remaining sections when the document is rasterized
 * beyond the viewport: measured 5 sections / 33 cards / 4107px after the settle
 * walk alone and after a 90s quiescence window with no capture, versus 11-15
 * sections / 83 cards / 5422-5467px immediately after one canonical full-page
 * capture, flat for the following minutes. Any measurement, readiness gate or
 * artifact dump that runs before this call therefore describes a page the
 * comparator never sees, which is exactly how a 4107px reference got compared
 * against a clone built from its own pre-mount DOM.
 *
 * Runs the capture, then requires the two-consecutive-matching-pass settle
 * contract so the returned metrics are the post-mount state.
 */
export async function hydrateToCapturedState(tabId, label, params = {}, captureTimeoutMs = 240_000, maxAttempts = 3) {
  const capture = await call('anti.screenshot.full_page', { tabId, ...params }, captureTimeoutMs);
  const settled = await requireDoubleSettledMetrics(tabId, label, maxAttempts);
  return { capture, settled };
}

/**
 * Require two consecutive settled metric passes with matching section and card counts.
 * Throws if settling fails or counts do not stabilize.
 */
export async function requireDoubleSettledMetrics(tabId, label, maxAttempts = 3) {
  let prev = null;
  // The observed sequence is kept so a failure states what moved between passes
  // instead of only the last sample: "sections=15, cards=83" alone cannot tell an
  // oscillating page from one that crossed the floor on its second pass.
  const history = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cur = await settleAndMeasure(tabId, `${label}-pass${attempt}`);
    const s = cur.settle || {};
    const m = cur.metrics || {};
    const settled = s.mediaFrozen === true && s.fontsSettled === true && s.imagesSettled === true && s.domSettled === true && s.visualStable === true;
    history.push(`#${attempt}{sections=${m.sectionCount},cards=${m.productCardCount},docHeight=${m.docHeight},settled=${settled}}`);

    if (settled && prev && prev.settled) {
      if (cur.metrics.sectionCount === prev.metrics.sectionCount &&
          cur.metrics.productCardCount === prev.metrics.productCardCount) {
        return cur;
      }
    }
    prev = { settled, metrics: m };
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Target tab ${tabId} failed to achieve two consecutive matching settled passes at ${label} (passes: ${history.join(' ')})`);
}
