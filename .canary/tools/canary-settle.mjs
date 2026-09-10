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
 * - SETTLE_DOM_EXPR (MutationObserver childList churn — recorded evidence, never a gate input)
 * - SETTLE_VISUAL_EXPR (bounding rect signature stable across consecutive samples)
 * - SETTLE_STATE_EXPR (rendered-content fingerprint: image set with identity and rect,
 *   counts, document height, visible text — a swap with equal geometry moves it)
 * - METRICS_EXPR (structural geometry, sectionCount, productCardCount, typography, assets)
 *
 * The gate is `composeSettleVerdict`: mediaFrozen && fontsSettled && imagesSettled
 * && visualStable && renderStateStable. `domQuiet` is reported but does not decide,
 * and a page that cannot be frozen is refused as DYNAMIC_CONTENT_UNCONTROLLED
 * rather than admitted on a rectangle-only comparison.
 */
import { call, evalOn } from './lib-rpc.mjs';
import {
  SETTLE_COMPONENTS,
  SETTLE_REFUSAL_CODES,
  composeSettleVerdict,
  settleFingerprintHash,
  decideSettle,
  describeSettlePass,
} from '../../scripts/lib/settle-contract.mjs';

export { SETTLE_COMPONENTS, SETTLE_REFUSAL_CODES, composeSettleVerdict, settleFingerprintHash, decideSettle, describeSettlePass };

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
  const sleep = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
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
  const sleep = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
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
  const sleep = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
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

/**
 * Content fingerprint — the gate that can see a swap.
 *
 * `SETTLE_VISUAL_EXPR` compares element rectangles, `requireDoubleSettledMetrics`
 * used to compare only counts, and the rasterization gate compares capture
 * heights: equal-geometry image, text or carousel swaps pass all three. This
 * samples what is actually rendered — the image set with its identity and its
 * rendered rect, the structural counts and the visible text — and reports
 * `renderStateStable` only when two consecutive samples are equal.
 */
export const SETTLE_STATE_EXPR = `(async () => {
  const sleep = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
  const t0 = performance.now();
  const hash32 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
  const sample = () => {
    const imgs = Array.from(document.images);
    const parts = imgs.map(i => {
      const r = i.getBoundingClientRect();
      return (i.currentSrc || i.src || '').slice(0, 200) + '|' + i.naturalWidth + 'x' + i.naturalHeight + '|' +
        Math.round(r.x) + ',' + Math.round(r.y + window.scrollY) + ',' + Math.round(r.width) + ',' + Math.round(r.height) + '|' + (i.complete ? 'c' : 'p');
    });
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      sectionCount: ${SECTION_COUNT_EXPR},
      productCardCount: document.querySelectorAll('${CARD_SELECTOR}').length,
      docHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      scrollWidth: document.documentElement.scrollWidth,
      imageCount: imgs.length,
      pendingImages: imgs.filter(i => !i.complete).length,
      brokenImages: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
      imageSetHash: hash32(parts.join('\\n')),
      imageSetSize: parts.length,
      textHash: hash32(text),
      textLength: text.length,
    };
  };
  let prev = null, equalPairs = 0, samples = 0;
  const seen = [];
  while (equalPairs < 2 && performance.now() - t0 < 12000) {
    const cur = sample();
    samples++;
    if (prev && JSON.stringify(cur) === JSON.stringify(prev)) equalPairs++; else equalPairs = 0;
    if (seen.length < 3) seen.push(cur);
    prev = cur;
    if (equalPairs < 2) await sleep(400);
  }
  return { renderStateStable: equalPairs >= 2, samples, durationMs: Math.round(performance.now() - t0), fingerprint: prev, first: seen[0] || null };
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

/**
 * One owner for the settle contract: see `scripts/lib/settle-contract.mjs`.
 *
 * `settleAndMeasure` and `requireDoubleSettledMetrics` used to compute `settled`
 * from different sets of components, so a page could report `settled: true` and
 * `timedOut: false` while the gate that throws disagreed. Both now use the
 * imported composite: dynamics frozen, fonts, images, geometry and the content
 * fingerprint. `domQuiet` is deliberately absent — it is recorded evidence, not a
 * gate input, because raw churn cannot distinguish a cosmetic re-parenting
 * document from a swapped one; the fingerprint can.
 */

export async function settleAndMeasure(tabId, name) {
  const net = await call('browser.wait', { tabId, condition: 'network_idle', idleWindowMs: 600, timeoutMs: 12000 }).catch(e => ({ error: String(e.message || e) }));
  const dom = await call('browser.wait', { tabId, condition: 'dom_stable', timeoutMs: 12000 }).catch(e => ({ error: String(e.message || e) }));

  // Dynamic progressive scroll pass to trigger lazy observers and content expansion
  await evalOn(tabId, `(async () => {
    const s = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
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
    // normalizeSliders pins slider tracks to their first slide and stops their
    // transitions. Without it an autoplaying hero rotates content behind an
    // equal-geometry comparison, which is how a 4107px-different page passed a
    // rectangle-only settle: measured image-set hash drift between two passes
    // with identical counts, geometry and text. Both sides of a comparison are
    // frozen the same way, so the pinned slide is the same state on both.
    freeze = await call('anti.media.freeze', { tabId, freeze: true, normalizeSliders: true }, 15000);
  } catch (e) {
    freeze = { error: String(e.message || e).slice(0, 300) };
  }
  const freezeOk = Boolean(freeze && !freeze.error && freeze.frozen === true);

  // The freeze replaces requestAnimationFrame with a live setTimeout shim, so
  // script-driven widgets keep animating. Measured on the live storefront: the
  // brand marquee (`logo-hang/baner-thuong-hieu`) kept translating with zero DOM
  // churn after the freeze, moving the image set between two otherwise identical
  // passes — and stopped completely once rAF stopped invoking callbacks. Both
  // sides of a comparison are stopped the same way, so the state stays symmetric.
  const rafStop = await evalOn(tabId, `(() => {
    window.requestAnimationFrame = () => 0;
    try { window.cancelAnimationFrame = () => {}; } catch {}
    return true;
  })()`, 8000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const rafStopped = rafStop === true;
  if (rafStopped) await new Promise((r) => setTimeout(r, 700));

  // The measured driver of the brand carousel: a page timer rewrites the track
  // transform about once a second, so an inline `!important` pin does not hold —
  // the next timer tick overwrites it and the track advances ~1 slide per second.
  // Neutering the page's timers stops it outright (measured: three 700ms windows
  // identical afterwards, versus a slide step before), and the original functions
  // stay reachable as `__antifanRealSetTimeout` so the probes can still sleep.
  const timers = await evalOn(tabId, `(() => {
    if (!window.__antifanRealSetTimeout) window.__antifanRealSetTimeout = window.setTimeout;
    if (!window.__antifanRealSetInterval) window.__antifanRealSetInterval = window.setInterval;
    if (!window.__antifanRealClearTimeout) window.__antifanRealClearTimeout = window.clearTimeout;
    if (!window.__antifanRealClearInterval) window.__antifanRealClearInterval = window.clearInterval;
    // The freeze schedules its own auto-unfreeze 60s out with the timer that was
    // real at freeze time, so neutering the global would leave that unfreeze armed
    // and it would restore motion mid-campaign — on the reference only, if the
    // clone is captured before its own timer fires.
    try {
      if (window.__antifanFreezeTimer) { window.__antifanRealClearTimeout(window.__antifanFreezeTimer); delete window.__antifanFreezeTimer; }
    } catch {}
    window.setTimeout = () => 0;
    window.setInterval = () => 0;
    try { window.clearTimeout = () => {}; window.clearInterval = () => {}; } catch {}
    let paused = 0;
    try { for (const a of document.getAnimations()) { try { a.pause(); paused++; } catch {} } } catch {}
    return { paused, unfreezeTimerCleared: !window.__antifanFreezeTimer };
  })()`, 10000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const timersStopped = Boolean(timers && !timers.error);
  if (timersStopped) await new Promise((r) => setTimeout(r, 700));

  // Whatever still moves gets a sticky pin. Measured, in order: the freeze alone
  // left the brand carousel advancing (~1 slide/second, identical counts and
  // geometry, drifting image set); stopping rAF did not hold it; stopping the
  // page's timers and pausing its animations did not hold it either, because the
  // driver rewrites the track's inline transform after the pin lands. So the pin
  // is re-applied by a MutationObserver on every style/child mutation, which runs
  // as a microtask rather than a page timer, and only touches nodes that were
  // observed moving plus the track containers those movers sit in. Both sides of
  // a comparison get the identical guard, so the pinned state stays symmetric.
  const pinned = await evalOn(tabId, `(async () => {
    const sleep = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
    const TRACKS = '.s-content, .swiper-wrapper, .slick-track, .owl-stage, .flickity-slider, [data-slider-track], .carousel-inner, [class*="marquee"], [class*="slick-track"]';
    const MOTION_PROPS = ['transform', 'transition', 'animation'];
    const LAYOUT_PROPS = ['transform', 'transition', 'animation', 'left', 'margin-left'];
    const PIN_VALUE = { transform: 'matrix(1, 0, 0, 1, 0, 0)', transition: 'none', animation: 'none', left: '0px', 'margin-left': '0px' };
    const label = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
    // Every pin is snapshotted and reversible: this markup is what the reference
    // dump and therefore the clone bundle are built from, so a pin that leaks into
    // the artifact would override the clone's own CSS with an !important snapshot.
    // The registry is page-level, not per-pass. Each guard pass installs its own
    // closure and overwrites __antifanGuardRestore, so a per-pass Map loses every
    // earlier pass's snapshot, and the next pass re-snapshots already-pinned nodes at
    // their pinned values — making those pins irreversible. Measured: after the
    // reference had settled through more passes than the clone, the release reported
    // {restored: 2, pinsLeft: 177} against the clone's {restored: 7, pinsLeft: 0},
    // and that asymmetry is what a kept-pin compare turned into a 7.35% mismatch.
    const snapshots = (window.__antifanGuardSnapshots = window.__antifanGuardSnapshots || new Map());
    const pin = (el, withLayout) => {
      try {
        let snap = snapshots.get(el);
        if (!snap) { snap = Object.create(null); snapshots.set(el, snap); el.setAttribute('data-antifan-pinned', withLayout ? 'layout' : 'motion'); }
        for (const prop of (withLayout ? LAYOUT_PROPS : MOTION_PROPS)) {
          if (!(prop in snap)) snap[prop] = { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) };
          el.style.setProperty(prop, PIN_VALUE[prop], 'important');
        }
        if (withLayout && typeof el.scrollLeft === 'number' && el.scrollLeft !== 0) el.scrollLeft = 0;
      } catch {}
    };
    const pauseAnimations = () => { try { for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {} };
    window.__antifanGuardRestore = () => {
      let restored = 0;
      for (const [el, snap] of snapshots) {
        for (const prop of Object.keys(snap)) {
          try {
            if (snap[prop].value) el.style.setProperty(prop, snap[prop].value, snap[prop].priority);
            else el.style.removeProperty(prop);
          } catch {}
        }
        try { el.removeAttribute('data-antifan-pinned'); } catch {}
        restored++;
      }
      snapshots.clear();
      try { delete window.__antifanGuardSnapshots; } catch {}
      try { if (window.__antifanGuardObserver) { window.__antifanGuardObserver.disconnect(); delete window.__antifanGuardObserver; } } catch {}
      return { restored, markedLeft: document.querySelectorAll('[data-antifan-pinned]').length };
    };
    const candidates = Array.from(document.querySelectorAll('img, [class*="marquee"], [class*="slide"], [class*="swiper"], [class*="slick"], [class*="track"], [class*="carousel"], [class*="baner"], [class*="banner"]'));
    const snap = () => candidates.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    // Rects for every candidate and its ancestry, so the element that actually
    // translates is identified regardless of whether it moves via transform, left,
    // margin-left or a scroll offset.
    const chainRects = () => {
      const map = new Map();
      for (const c of candidates) {
        let n = c;
        for (let up = 0; up < 6 && n && n !== document.documentElement; up++, n = n.parentElement) {
          const r = n.getBoundingClientRect();
          map.set(n, { x: r.x, y: r.y });
        }
      }
      return map;
    };
    // The marquee advances in discrete ~545px steps on a multi-second cadence, so a
    // single sub-second window can see nothing move at all; sample until something
    // moves, up to ~5s, and pin every node that was ever observed moving.
    const movers = [];
    const guardNodes = new Set();
    let prevRects = chainRects();
    let beforeGuard = snap();
    for (let round = 0; round < 7; round++) {
      await sleep(800);
      const curRects = chainRects();
      for (const [el, cur] of curRects) {
        const prior = prevRects.get(el);
        if (!prior || guardNodes.has(el)) continue;
        const dx = cur.x - prior.x, dy = cur.y - prior.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        guardNodes.add(el);
        movers.push({ tag: el.tagName.toLowerCase(), cls: label(el), dx: Math.round(dx), dy: Math.round(dy) });
      }
      prevRects = curRects;
      if (movers.length) { beforeGuard = snap(); break; }
    }
    for (const el of document.querySelectorAll(TRACKS)) guardNodes.add(el);
    if (window.__antifanGuardObserver) { try { window.__antifanGuardObserver.disconnect(); } catch {} }
    const guard = { nodes: guardNodes.size, movers: movers.slice(0, 15), pinnedSet: Array.from(guardNodes).map(label).slice(0, 30) };
    if (!guardNodes.size) { pauseAnimations(); return guard; }
    const layoutNodes = new Set(Array.from(document.querySelectorAll(TRACKS)));
    const applyAll = () => {
      for (const el of Array.from(guardNodes)) {
        if (!el.isConnected) { guardNodes.delete(el); snapshots.delete(el); continue; }
        // Spacing pins (left/margin-left/scrollLeft) stay on track containers only:
        // forcing them onto arbitrary items could flatten a real margin difference
        // between reference and clone instead of freezing motion.
        pin(el, layoutNodes.has(el));
      }
      pauseAnimations();
    };
    const onMutation = (records) => {
      let touched = false;
      for (const r of records) {
        const t = r.target;
        if (!t) continue;
        if (guardNodes.has(t)) { touched = true; break; }
        if (t.closest) { const anc = t.closest(TRACKS); if (anc) { guardNodes.add(anc); layoutNodes.add(anc); touched = true; break; } }
      }
      if (!touched) return;
      applyAll();
    };
    const observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true, attributeFilter: ['style', 'class'] });
    window.__antifanGuardObserver = observer;
    applyAll();
    await sleep(1200);
    const settledAfter = snap();
    let stillMoving = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (Math.abs(settledAfter[i].x - beforeGuard[i].x) > 0.5 || Math.abs(settledAfter[i].y - beforeGuard[i].y) > 0.5) stillMoving++;
    }
    guard.stillMovingAfterGuard = stillMoving;
    return guard;
  })()`, 40000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  if (pinned && !pinned.error) await new Promise((r) => setTimeout(r, 500));

  let images = { fontsSettled: false, imagesSettled: false, pendingImages: 0 };
  for (let pass = 0; pass < 3; pass++) {
    images = await evalOn(tabId, SETTLE_IMAGES_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
    if (images.imagesSettled === true) break;
    if (pass < 2) await new Promise(r => setTimeout(r, 1000));
  }
  const domQuiet = await evalOn(tabId, SETTLE_DOM_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  images = await evalOn(tabId, SETTLE_IMAGES_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const visual = await evalOn(tabId, SETTLE_VISUAL_EXPR, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const state = await evalOn(tabId, SETTLE_STATE_EXPR, 20000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  const verdict = composeSettleVerdict({ freezeOk, images, visual, state });
  const settle = {
    freeze,
    // The composite is spread, so `settled` here is the same value the gate
    // recomputes: one definition, no second predicate.
    ...verdict,
    fingerprint: settleFingerprintHash(state),
    fingerprintFields: state && !state.error ? state.fingerprint || null : null,
    // Raw churn stays evidence: it is recorded, never a gate input.
    domQuiet: domQuiet.domSettled === true,
    rafStopped,
    rafStopError: rafStopped ? null : (rafStop && rafStop.error) || 'rAF override not applied',
    timersStopped,
    timersStopError: timersStopped ? null : (timers && timers.error) || 'page timers not stopped',
    animationsPaused: timersStopped ? timers.paused ?? 0 : null,
    unfreezeTimerCleared: timersStopped ? timers.unfreezeTimerCleared === true : null,
    pinnedMovers: pinned && !pinned.error ? pinned : { error: (pinned && pinned.error) || 'pin step not run' },
    domQuietDetail: domQuiet && !domQuiet.error ? { domSettled: domQuiet.domSettled === true, structuralMutations: domQuiet.structuralMutations ?? null } : { error: domQuiet.error || 'no sample' },
    structuralMutations: domQuiet.structuralMutations ?? null,
    timedOut: !verdict.settled,
    imageCount: visual.imageCount ?? images.imageCount ?? null,
    pendingImages: visual.pendingImages ?? images.pendingImages ?? null,
    brokenImages: visual.brokenImages ?? [],
    settlementDuration: (images.durationMs || 0) + (domQuiet.durationMs || 0) + (visual.durationMs || 0) + (state.durationMs || 0),
    readyState: visual.readyState ?? null,
    fontsStatus: visual.fontsStatus ?? null,
    phases: { images, domQuiet, visual, state },
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
 * Samples the page's own widget state over a window and reports whether anything moved.
 *
 * Used on both sides of the compare and twice per side: once right after the timer
 * sweep, to prove the page was inert when the compare started, and once after the
 * compare, to prove it stayed inert while the transaction rasterized. The raster runs
 * for far longer than any practical pre-compare window, so a rotation that re-arms
 * after the sweep — a site that drives its slider from `requestAnimationFrame`, or a
 * `setTimeout` chain re-scheduled by a later event — would otherwise be published as a
 * page verdict. The sample covers the elements that carry slider state, not the whole
 * document, so ordinary lazy-loading and font swaps do not read as motion.
 */
export async function sampleWidgetMotion(tabId, windowMs = 2500) {
  return evalOn(tabId, `(async () => {
    const sleep = (ms) => new Promise(r => (window.__antifanRealSetTimeout || setTimeout)(r, ms));
    const widgets = document.querySelectorAll('[class*="slick"], [class*="slide"], [class*="swiper"], [class*="track"], [class*="carousel"], [class*="banner"]');
    const sample = () => {
      let h = 0x811c9dc5;
      const push = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
      push(String(document.documentElement.scrollHeight));
      for (const el of widgets) {
        const cs = getComputedStyle(el);
        push(el.className + '|' + el.getAttribute('style') + '|' + cs.transform + '|' + cs.opacity + '|' + (el.getAttribute('data-slick-index') || ''));
      }
      return h.toString(16).padStart(8, '0');
    };
    const sampleBefore = sample();
    await sleep(${Math.max(0, Math.floor(windowMs))});
    const sampleAfter = sample();
    return { widgetsSampled: widgets.length, windowMs: ${Math.max(0, Math.floor(windowMs))}, sampleBefore, sampleAfter, stable: sampleBefore === sampleAfter };
  })()`, windowMs + 20_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 200), stable: null }));
}

/**
 * Put both sides into the same deterministic widget state, then undo every
 * settle-time override, before the authoritative compare.
 *
 * Order matters. The app's normalization awaits a page-side `setTimeout` per scroll
 * step, so the neutered timer globals must be restored or the transaction dies on
 * its own bound and both published PNGs come back 0 bytes (`CAPTURE_INVALID`). But
 * restoring them also lets the live page's autoplay resume, and a slider that
 * advances while the transaction rasterizes is what moved the reference hero
 * mid-compare (measured: 63.8% of the hero band changed while the clone's identical
 * hero stayed byte-stable, reporting a page mismatch that swung between 0.04% and
 * 3.11% on unchanged code). Pausing through the site's own API first — `slickPause`
 * clears the slider's autoplay interval rather than out-styling it — makes the
 * frozen phase survive the release wherever the site exposes the plugin, and both
 * sides receive the identical call. Where it does not (this storefront: no jQuery
 * global), the timer sweep below covers the same ground without the plugin.
 *
 * The harness's own observation-based pins are then released with the rest: they
 * mark only the nodes *observed* moving inside each tab's own settle window, so the
 * two sides end up pinned differently (measured: 63 pins on the reference against 83
 * on the clone), and keeping them freezes each side in a different state, which
 * manufactured a 7.35% mismatch at a viewport that had passed at 1.87%. Keeping the
 * app's freeze instead of releasing it was also tried and dropped: its one leg never
 * completed a compare (RPC timeout), so it is not a verified path.
 *
 * The API pause alone is not sufficient on this storefront, so the release is followed
 * by a symmetric sweep of the page's real timer ids plus a stability sample. Measured
 * without it: 1024 reported a 3.29% mismatch whose top band y199-580 held 254,975 of
 * 313,157 differing pixels — the rotating hero — while `{slickPaused: 0}` on both sides
 * showed the API pause had reached nothing.
 *
 * The reference dump the clone bundle is built from still uses
 * `releaseSettleOverrides` directly: it needs a clean document, not a comparable pair.
 */
export async function releaseCompareBlockers(tabId, label = 'compare-release') {
  const record = { label, at: new Date().toISOString() };
  // Deterministic widget state first, through the site's own API: `slickPause`
  // clears the slider's autoplay interval, so restoring the timers below cannot
  // make it resume — unlike a style pin, which the next tick overwrites, and unlike
  // the harness's observation-based pins, which freeze each side differently. Both
  // sides get the identical call, so the compared state stays symmetric.
  record.widgets = await evalOn(tabId, `(() => {
    const jq = window.jQuery || window.$;
    let slickPaused = 0;
    let swiperPaused = 0;
    try {
      if (jq && jq.fn && jq.fn.slick) {
        document.querySelectorAll('.slick-initialized').forEach((el) => {
          try { jq(el).slick('slickPause'); jq(el).slick('slickGoTo', 0, true); slickPaused++; } catch {}
        });
      }
    } catch {}
    try {
      document.querySelectorAll('[class*="swiper"]').forEach((el) => {
        const s = el.swiper;
        if (!s || !s.autoplay || typeof s.autoplay.stop !== 'function') return;
        try { s.autoplay.stop(); if (typeof s.slideTo === 'function') s.slideTo(0, 0); swiperPaused++; } catch {}
      });
    } catch {}
    return { slickPaused, swiperPaused };
  })()`, 20_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 200) }));
  record.release = await releaseSettleOverrides(tabId, `${label}-full`);
  record.freezeReleased = Boolean(record.release.unfreeze && !record.release.unfreezeError);
  // The release restores the timer globals, which lets a rotation that is driven by
  // the page's own interval resume: neutering `setInterval` never stopped an interval
  // that was created with the real one before the settle began, and the API pause
  // above cannot reach a site that exposes no jQuery global at all (measured on this
  // storefront: `{slickPaused: 0, swiperPaused: 0}` on both sides at 1440 and 1024,
  // against zero `jQuery` references in the dump). So clear the real timer ids the
  // page already holds — clearing an id that is not a timer is a no-op — and then
  // *prove* the page is inert by sampling its own widget state over a window longer
  // than the rotation cadence. Both sides run the identical routine, so the compared
  // state stays symmetric, and it runs before the compare injects its normalization,
  // whose own timers are scheduled afterwards and therefore survive.
  record.timerSweep = await evalOn(tabId, `(() => {
    const clearIntervalReal = window.__antifanRealClearInterval || window.clearInterval;
    const clearTimeoutReal = window.__antifanRealClearTimeout || window.clearTimeout;
    const MAX_TIMER_ID = 200000;
    for (let id = 1; id <= MAX_TIMER_ID; id++) { try { clearIntervalReal(id); } catch {} }
    for (let id = 1; id <= MAX_TIMER_ID; id++) { try { clearTimeoutReal(id); } catch {} }
    return { clearedIntervalIdsTo: MAX_TIMER_ID, clearedTimeoutIdsTo: MAX_TIMER_ID };
  })()`, 25_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 200) }));
  // The sweep proves itself: an inert page cannot change its own widget hash.
  record.timerSweepMotion = await sampleWidgetMotion(tabId, 2500);
  return record;
}

/**
 * Read the phase of every carousel on a page: which slide each library currently
 * shows, and how many tracks it has.
 *
 * Pinning that phase was tried and reverted. Forcing the track transform and the
 * active classes moved the compared state, but the two sides do not agree on whether a
 * carousel is even initialized (the reference runs the site's own script; a static clone
 * may not), so the identical manipulation landed differently on each side: p3/p4/p5 went
 * from 0.07-0.08% to 4.59-5.62%, and p2's 390 document grew by a third. That is a mask in
 * disguise, which this campaign forbids. So the phase is measured instead and a carriage
 * of two different slides is refused: a static artifact cannot reproduce a rotating
 * widget's phase, and a pixel number taken across two phases measures the rotation.
 */
export async function readWidgetPhase(tabId) {
  return await evalOn(tabId, `(() => {
    const slickCurrent = [];
    document.querySelectorAll('[data-slick-index]').forEach((slide) => {
      if (!slide.classList.contains('slick-current') && !slide.classList.contains('slick-active')) return;
      slickCurrent.push(Number(slide.getAttribute('data-slick-index')));
    });
    const tracks = document.querySelectorAll('.slick-track');
    let swiperIndex = null;
    const active = document.querySelector('.swiper-slide-active');
    if (active && active.parentElement) swiperIndex = Array.from(active.parentElement.children).indexOf(active);
    return { slickCurrent, slickTracks: tracks.length, swiperIndex };
  })()`, 20_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 200) }));
}

/**
 * Undo every settle-time mutation before anything is read off the DOM.
 *
 * The reference dump is what the clone bundle is built from, so the pins the
 * settle applies must not survive into it: a computed-style snapshot carrying
 * `!important` would override the clone's own CSS and freeze its sliders for good.
 * This reverses both layers — the app's freeze (its own slider snapshots and rAF
 * shim) and this harness's guard/timer overrides — and reports what it found left
 * over, so a leak is visible in the page record instead of inferred from a diff.
 */
export async function releaseSettleOverrides(tabId, label = 'release') {
  const record = { label, at: new Date().toISOString() };
  // Page-side first: the app's unfreeze path can itself evaluate page script, and a
  // neutered timer global would strand any of its awaited steps.
  record.dom = await evalOn(tabId, `(() => {
    const restore = typeof window.__antifanGuardRestore === 'function' ? window.__antifanGuardRestore() : { restored: 0, markedLeft: document.querySelectorAll('[data-antifan-pinned]').length, absent: true };
    let timersRestored = false;
    try {
      if (window.__antifanRealSetTimeout) { window.setTimeout = window.__antifanRealSetTimeout; delete window.__antifanRealSetTimeout; }
      if (window.__antifanRealSetInterval) { window.setInterval = window.__antifanRealSetInterval; delete window.__antifanRealSetInterval; }
      if (window.__antifanRealClearTimeout) { window.clearTimeout = window.__antifanRealClearTimeout; delete window.__antifanRealClearTimeout; }
      if (window.__antifanRealClearInterval) { window.clearInterval = window.__antifanRealClearInterval; delete window.__antifanRealClearInterval; }
      if (window.__antifanOriginalRAF) { window.requestAnimationFrame = window.__antifanOriginalRAF; }
      timersRestored = !window.__antifanRealSetTimeout;
    } catch {}
    return {
      restored: restore.restored,
      markedLeft: document.querySelectorAll('[data-antifan-pinned]').length,
      timersRestored,
      inlineImportant: Array.from(document.querySelectorAll('[style]')).filter((n) => /!important/.test(n.getAttribute('style') || '')).length,
      guardAbsent: Boolean(restore.absent),
      timers: typeof window.setTimeout === 'function' && String(window.setTimeout).length > 0,
    };
  })()`, 20_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 200) }));
  try {
    record.unfreeze = await call('anti.media.freeze', { tabId, freeze: false }, 30_000);
  } catch (e) {
    record.unfreezeError = String(e && e.message ? e.message : e).slice(0, 200);
  }
  return record;
}

/**
 * Require two consecutive passes that satisfy the composite and describe the
 * same rendered content. Throws if settling fails, naming every predicate
 * component and its value per pass — a counts-only history cannot tell which
 * predicate failed, which is why a failed page used to persist `"stages": {}`.
 */
export async function requireDoubleSettledMetrics(tabId, label, maxAttempts = 3) {
  const passes = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cur = await settleAndMeasure(tabId, `${label}-pass${attempt}`);
    const s = cur.settle || {};
    const m = cur.metrics || {};
    passes.push({
      components: {
        mediaFrozen: s.mediaFrozen === true,
        fontsSettled: s.fontsSettled === true,
        imagesSettled: s.imagesSettled === true,
        visualStable: s.visualStable === true,
        renderStateStable: s.renderStateStable === true,
      },
      settled: s.settled === true,
      refusal: s.refusal || null,
      fingerprint: s.fingerprint || null,
      structuralMutations: s.structuralMutations ?? null,
      counts: { sections: m.sectionCount, cards: m.productCardCount, docHeight: m.docHeight, images: m.imageCount },
      metrics: m,
      settle: s,
    });
    const decision = decideSettle(passes);
    if (decision.settled) {
      cur.settle.passes = passes.map((p, i) => ({ pass: i + 1, ...p.components, settled: p.settled, fingerprint: p.fingerprint, counts: p.counts }));
      return cur;
    }
    // A page that cannot be frozen is refused as such on the first pass: waiting
    // for a second pass cannot make an uncontrolled widget controllable.
    if (decision.refusal) {
      const err = new Error(`Target tab ${tabId} refused at ${label}: ${decision.refusal.code} — ${decision.refusal.reason} (passes: ${passes.map((p, i) => describeSettlePass(i + 1, p)).join(' ')})`);
      err.code = decision.refusal.code;
      err.passes = passes.map((p, i) => ({ pass: i + 1, ...p.components, settled: p.settled, fingerprint: p.fingerprint, counts: p.counts }));
      throw err;
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000));
  }
  const decision = decideSettle(passes);
  const err = new Error(`Target tab ${tabId} failed to achieve two consecutive matching settled passes at ${label}: ${decision.reason}${decision.failed.length ? ` (unsatisfied: ${decision.failed.join(',')})` : ''} (passes: ${passes.map((p, i) => describeSettlePass(i + 1, p)).join(' ')})`);
  err.code = decision.reason;
  err.passes = passes.map((p, i) => ({ pass: i + 1, ...p.components, settled: p.settled, fingerprint: p.fingerprint, counts: p.counts }));
  throw err;
}
