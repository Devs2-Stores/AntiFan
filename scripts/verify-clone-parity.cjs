/**
 * Clone Parity Gate — full-page visual compare of the live reference against the
 * localized clone, per route and per surface, using AntiFan's canonical
 * `computePixelDiff` (the same metric `anti.visual.compare` reports).
 *
 * Runs its own hidden Electron window (its own partition, no user tab touched):
 *   1. emulate the surface (device metrics + UA + client hint), navigate, settle,
 *      freeze motion, normalize horizontal carousels;
 *   2. capture the full page through CDP (`captureBeyondViewport`);
 *   3. repeat against the clone origin with identical settings;
 *   4. diff with tolerance X% and optional geometry masks for regions that cannot
 *      exist offline (third-party embeds, chat widgets).
 *
 * Usage:
 *   node scripts/run-electron.cjs scripts/verify-clone-parity.cjs \
 *     --live https://example.com --clone http://127.0.0.1:3311 \
 *     --routes /,/menu --surfaces desktop,mobile --tolerance 2 \
 *     --out plans/reports/clone-parity.json [--save-images] [--limit 2]
 */
'use strict';

const { app, BrowserWindow, session, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const LIVE_ORIGIN = arg('--live', 'https://comnieuthienly.com').replace(/\/$/, '');
const CLONE_ORIGIN = arg('--clone', 'http://127.0.0.1:3311').replace(/\/$/, '');
const TOLERANCE = Number(arg('--tolerance', '2'));
const ROUTES = arg('--routes', '/').split(',').map((r) => r.trim()).filter(Boolean);
const SURFACES = arg('--surfaces', 'desktop,mobile').split(',').map((s) => s.trim());
const LIMIT = Number(arg('--limit', '0'));
const SAVE_IMAGES = has('--save-images');
const CASE_TIMEOUT_MS = Number(arg('--case-timeout', '180000'));

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_FILE = path.resolve(arg('--out', path.join('plans', 'reports', `clone-parity-${STAMP}.json`)));
const IMAGE_DIR = path.join(path.dirname(OUT_FILE), `clone-parity-${STAMP}`);

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';

const DEVICES = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false, ua: DESKTOP_UA },
  tablet: { width: 1024, height: 768, dpr: 1, mobile: false, ua: DESKTOP_UA },
  mobile: { width: 390, height: 844, dpr: 1, mobile: true, ua: MOBILE_UA },
};

// Regions that cannot be reproduced in an offline package: third-party embeds and
// live chat/cookie injection. Geometry (page coordinates) is collected from BOTH
// sides and the union is excluded from the diff denominator.
const MASK_SELECTORS = [
  'iframe[src^="http"]',
  'iframe[src^="//"]',
  'iframe[src*="googletagmanager"]',
  '[class*="zalo" i]',
  '[id*="zalo" i]',
  '[class*="tawk"]',
  '[class*="subiz"]',
  '[class*="crisp"]',
  '[class*="intercom"]',
  '.fb_iframe_widget',
  '[class*="goog-te"]',
  '#goog-gt-tt',
];

// Vendor trackers, ad beacons and live-chat loaders. None of them render page
// content, none of them exist in an offline package, and any of them can hold the
// load event open indefinitely.
const TRACKER_HOSTS = [
  'connect.facebook.net',
  'facebook.com',
  'facebook.net',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'doubleclick.net',
  'googleadservices.com',
  'hotjar.com',
  'hotjar.io',
  'clarity.ms',
  'criteo.com',
  'criteo.net',
  'tiktok.com',
  'analytics.tiktok.com',
  'zalo.me',
  'zalo.com.vn',
  'tawk.to',
  'subiz.com',
  'subiz.vn',
  'crisp.chat',
  'intercom.io',
  'intercomcdn.com',
  'livechatinc.com',
  'smartsupp.com',
  'chatlio.com',
];

const safeHost = (url) => {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
};

// Requests refused by the tracker gate during the current capture.
let blockedRequests = [];

const bound = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TIMEOUT(${ms}ms)${label ? `: ${label}` : ''}`)), ms);
    }),
  ]);
};

// Every CDP command is bounded, not only the capture. A capture that expires
// leaves its command queued, so the *next* unbounded command on that webContents
// never answers and the whole run stalls with no output — measured: a 90s mobile
// capture timeout turned the following `Page.getLayoutMetrics` into a 20 minute
// hang. A per-call bound turns that into a case error the runner can recover from.
const CDP_TIMEOUT_MS = Number(arg('--cdp-timeout', '60000'));
const CAPTURE_TIMEOUT_MS = Number(arg('--capture-timeout', '180000'));
const cdp = (wc, method, params, label) =>
  bound(wc.debugger.sendCommand(method, params), CDP_TIMEOUT_MS, label || method);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const createParityWindow = () =>
  new BrowserWindow({
    width: 520,
    height: 400,
    x: 8,
    y: 8,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      partition: 'parity-verify',
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

// A case that failed may have left a queued CDP command behind; a fresh window
// (new webContents, new debugger session) is the only reliable way to get an
// unpoisoned transport, and it also releases the failed page's memory before the
// next surface is emulated.
const resetParityWindow = async () => {
  try { if (window_.webContents.debugger.isAttached()) window_.webContents.debugger.detach(); } catch (e) {}
  try { window_.destroy(); } catch (e) {}
  preparedDevice = null;
  await sleep(400);
  window_ = createParityWindow();
  if (!has('--hidden')) {
    window_.showInactive();
    await sleep(400);
  }
};

// In-page settle: identical procedure on both origins. Returns the measured
// document box plus the mask geometry.
const SETTLE_SCRIPT = (maskSelectors) => `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const idle = (ms) => new Promise((r) => setTimeout(r, ms));

  try { await Promise.race([document.fonts.ready, idle(6000)]); } catch (e) {}

  const images = Array.from(document.images || []);
  for (const img of images) {
    try {
      img.loading = 'eager';
      img.decoding = 'sync';
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (lazy && (!img.src || img.src === location.href || img.src.startsWith('about:'))) img.src = lazy;
    } catch (e) {}
  }
  await Promise.race([
    Promise.all(images.map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()))),
    idle(8000),
  ]);

  // Staircase walk to trigger every IntersectionObserver, then return to the top.
  const stepHeight = 300;
  let walked = 0;
  for (let pass = 0; pass < 2; pass++) {
    walked = 0;
    let guard = 0;
    while (walked < document.documentElement.scrollHeight && guard < 400) {
      window.scrollTo(0, walked);
      await raf();
      await idle(90);
      walked += stepHeight;
      guard++;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await idle(300);
  }
  window.scrollTo(0, 0);
  await raf();
  await idle(400);

  // Height stability: three identical samples.
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 24 && stable < 3; i++) {
    const h = document.documentElement.scrollHeight;
    stable = h === last ? stable + 1 : 0;
    last = h;
    await idle(250);
  }

  // A page that auto-opens an overlay (store picker, promo, cookie wall) on load is
  // not comparable with a snapshot whose own script left it closed: one side is
  // captured behind a dimming layer with its content covered, the other is not.
  // Apply the same deterministic dismissal to both surfaces — Escape, then the
  // dialog's own close control, then hiding whatever is still open — and report
  // every action so the run states what it normalized instead of silently masking it.
  const overlays = [];
  const keptChrome = [];
  const viewportArea = () => window.innerWidth * window.innerHeight;
  const isVisibleNode = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.05) return false;
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height >= viewportArea() * 0.01;
  };
  const describeOverlay = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      label: el.tagName.toLowerCase() + '.' + (String(el.className || '').trim().slice(0, 60) || '(no-class)'),
      position: style.position,
      zIndex: style.zIndex,
      background: style.backgroundColor,
      areaPercent: Number(((rect.width * rect.height) / viewportArea() * 100).toFixed(2)),
    };
  };
  // What is treated as an overlay: a dialog by role or by name. Geometry alone must
  // never decide, because a sticky header is fixed, layered and large too -- hiding
  // one would quietly remove identical chrome from both sides and inflate the score.
  const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popup"], [class*="dialog"], [class*="drawer"], [class*="promo"], [class*="voucher"], [class*="coupon"], [class*="toast"]';
  const dialogCandidates = () => Array.from(document.querySelectorAll(DIALOG_SELECTOR)).filter(isVisibleNode);
  // The dimming layer that belongs to an open dialog. Only collected once a dialog
  // is present, so a page's own dark scrim is never mistaken for a modal backdrop.
  const backdropCandidates = () => Array.from(document.querySelectorAll('body *')).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    const zIndex = Number.parseInt(style.zIndex, 10);
    if (!Number.isFinite(zIndex) || zIndex < 40) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < viewportArea() * 0.4) return false;
    const match = /rgba?\(([^)]+)\)/.exec(style.backgroundColor);
    if (!match) return false;
    const parts = match[1].split(',').map((v) => parseFloat(v));
    const alpha = parts.length > 3 ? parts[3] : 1;
    if (!(alpha >= 0.15)) return false;
    const luminance = (parts[0] * 0.299 + parts[1] * 0.587 + parts[2] * 0.114) / 255;
    return luminance < 0.6;
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const dialogs = dialogCandidates();
    if (!dialogs.length) break;
    for (const el of dialogs) overlays.push({ step: attempt === 0 ? 'open-on-load' : 'still-open', ...describeOverlay(el) });
    for (const target of [document, window, document.body]) {
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      } catch (e) {}
    }
    await idle(250);
    for (const el of dialogCandidates()) {
      const close = el.querySelector('[aria-label*="close" i], .close, [class*="close"], [class*="dismiss"], button');
      if (close && typeof close.click === 'function') {
        try { close.click(); } catch (e) {}
        await idle(200);
      }
    }
    const backdrops = backdropCandidates();
    for (const el of dialogCandidates()) {
      overlays.push({ step: 'hidden', ...describeOverlay(el) });
      el.style.setProperty('display', 'none', 'important');
      // A dialog is normally carried by a full-viewport fixed layer. Hiding the dialog alone
      // would leave that layer dimming the page on one side only, which is a difference the
      // capture would then blame on the output.
      let ancestor = el.parentElement;
      let hops = 0;
      while (ancestor && ancestor !== document.documentElement && hops < 5) {
        const ancestorStyle = window.getComputedStyle(ancestor);
        if (ancestorStyle.position === 'fixed') {
          const ancestorRect = ancestor.getBoundingClientRect();
          if (ancestorRect.width >= window.innerWidth * 0.9 && ancestorRect.height >= window.innerHeight * 0.9) {
            overlays.push({ step: 'hidden-wrapper', ...describeOverlay(ancestor) });
            ancestor.style.setProperty('display', 'none', 'important');
          }
          break;
        }
        ancestor = ancestor.parentElement;
        hops++;
      }
    }
    for (const el of backdrops) {
      overlays.push({ step: 'hidden-backdrop', ...describeOverlay(el) });
      el.style.setProperty('display', 'none', 'important');
    }
    await idle(250);
    if (dialogCandidates().length === 0) break;
  }
  // Positioned, layered chrome that stays in the comparison. Reported so a run that
  // passes with a sticky header or a floating action button still says so.
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const style = window.getComputedStyle(el);
    if (style.position !== 'fixed') continue;
    const zIndex = Number.parseInt(style.zIndex, 10);
    if (!Number.isFinite(zIndex) || zIndex < 40) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < viewportArea() * 0.03) continue;
    keptChrome.push({ label: el.tagName.toLowerCase() + '.' + (String(el.className || '').trim().slice(0, 50) || '(no-class)'), zIndex, areaPercent: Number(((rect.width * rect.height) / viewportArea() * 100).toFixed(2)) });
  }
  for (const el of Array.from(document.querySelectorAll('body, html'))) {
    try { el.style.removeProperty('overflow'); el.style.removeProperty('position'); } catch (e) {}
  }
  await raf();

  // Freeze motion and normalize carousels so both surfaces are captured in the
  // same state (marquees, autoplay sliders, animated reveals, video frames).
  // The scrollbar gutter is reserved rather than removed: a classic scrollbar takes
  // 15px out of the layout, so hiding it would widen the layout of whichever surface
  // scrolled and shift every row. A stable scrollbar gutter keeps the same 15px
  // reserve on both surfaces whether or not one of them scrolls, which is also the
  // layout a slider library measures when the page loads with a scrollbar present.
  const freeze = document.createElement('style');
  freeze.id = 'antifan-parity-freeze';
  freeze.textContent = '*{animation-play-state:paused !important;transition:none !important;caret-color:transparent !important}' +
    'html{scroll-behavior:auto !important;scrollbar-gutter:stable !important}' +
    '.swiper-wrapper,.swiper-slide{transform:none !important;opacity:1 !important;visibility:visible !important}';
  document.head.appendChild(freeze);
  for (const v of Array.from(document.querySelectorAll('video, audio'))) {
    try { v.pause(); v.currentTime = 0; } catch (e) {}
  }
  // Stop library autoplay, then restore the authored slide order. Steering a looped
  // Swiper with slideToLoop()/setTranslate() is not neutral: from Swiper 9 the library
  // keeps the loop consistent by moving real slide nodes inside the track, so the call
  // itself reorders the DOM. Measured on the reference: after the freeze the first slide
  // rendered at x=0, and immediately after slideToLoop(0, 0) it rendered one track width
  // away -- the live and the clone then sit one slide apart and the compare reports a
  // content swap neither surface has. The library's own data-swiper-slide-index records
  // the authored index, so it restores the order a static snapshot can hold.
  for (const root of Array.from(document.querySelectorAll('.swiper'))) {
    try {
      const swiper = root.swiper;
      if (swiper && swiper.autoplay && typeof swiper.autoplay.stop === 'function') swiper.autoplay.stop();
    } catch (e) {}
  }
  let slideOrdersCanonicalized = 0;
  // The generator strips geometry and transforms from the class tokens of the same
  // slider contract, so the harness identifies library tracks by that contract too.
  // Token match without a regex literal: this whole block is a template literal, where a
  // \s inside a pattern literal collapses to s (measured: /\s+/ shipped as /s+/, so no
  // class token ever matched, this pass and the transform pass below were silent no-ops,
  // and carouselsNormalized stayed 0 on a surface whose slider was demonstrably moved).
  const SLIDER_TRACK_TOKENS = ['swiper-wrapper', 'slick-track', 'splide__list', 's-content'];
  const isLibraryTrack = (el) => {
    const padded = ' ' + String(el.className || '').trim() + ' ';
    return SLIDER_TRACK_TOKENS.some((token) => padded.includes(' ' + token + ' '));
  };
  for (const track of Array.from(document.querySelectorAll('body *'))) {
    if (!isLibraryTrack(track)) continue;
    const children = Array.from(track.children).filter((child) => child.nodeType === 1);
    if (children.length < 2) continue;
    const indexed = children.map((child, position) => ({
      child,
      position,
      index: Number.parseInt(child.getAttribute('data-swiper-slide-index'), 10),
    }));
    if (indexed.some((entry) => !Number.isFinite(entry.index))) continue;
    const sorted = indexed.slice().sort((a, b) => (a.index - b.index) || (a.position - b.position));
    if (sorted.every((entry, position) => entry.child === children[position])) continue;
    for (const entry of sorted) track.appendChild(entry.child);
    slideOrdersCanonicalized++;
  }
  // Destroying the instance after the reorder keeps the canonical state: the library's
  // observer reacts to childList changes, and a live instance would move the slides back
  // to its own loop position. Both surfaces are destroyed identically, and destroy keeps
  // inline geometry (deleteInstance, keepStyles), so nothing about the layout is masked.
  for (const root of Array.from(document.querySelectorAll('.swiper'))) {
    try {
      const swiper = root.swiper;
      if (swiper && typeof swiper.destroy === 'function') swiper.destroy(true, false);
    } catch (e) {}
  }
  for (const el of Array.from(document.querySelectorAll('.swiper-slide'))) {
    el.classList.remove('swiper-slide-active', 'swiper-slide-next', 'swiper-slide-prev', 'swiper-slide-visible', 'swiper-slide-fully-visible');
  }
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const style = window.getComputedStyle(el);
    if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 8) {
      try { el.scrollLeft = 0; } catch (e) {}
    }
  }
  // An autoplaying carousel is a moving target: two captures of the same output can
  // land on different slides, which reads as a content difference that is not there.
  // Canonicalize every carousel to its first slide on both surfaces. The DOM is not
  // touched -- only the displayed state -- so the compared content is real.
  let carouselsNormalized = 0;
  let slideStatesNeutralized = 0;
  const clipsHorizontally = (el) => {
    const style = window.getComputedStyle(el);
    return /hidden|auto|scroll/.test(style.overflowX) && el.clientWidth > 0;
  };
  // The generator strips geometry and transforms from the class tokens of the same
  // slider contract, so the harness identifies library tracks by that contract too.
  // A width-ratio guess cannot see a coverflow slider whose slides are narrower than
  // the viewport, and would then compare one surface at rest with the other mid-rotation.
  const transformedTracks = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const style = window.getComputedStyle(el);
    const settledTransform = !style.transform || style.transform === 'none' || style.transform === 'matrix(1, 0, 0, 1, 0, 0)';
    if (settledTransform && !isLibraryTrack(el)) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    let viewport = clipsHorizontally(parent) ? parent : (parent.parentElement && clipsHorizontally(parent.parentElement) ? parent.parentElement : null);
    // A coverflow track is laid out inside a root that does not clip (overflow: visible)
    // -- Swiper's 3d effect positions the slides itself -- so an ancestor-only viewport
    // test skips every such slider and the compare then measures one surface at rest and
    // the other mid-rotation. The library contract is what identifies the track, so it
    // supplies its own viewport when no ancestor clips.
    if (!viewport && isLibraryTrack(el)) viewport = parent;
    if (!viewport) continue;
    const children = Array.from(el.children);
    if (children.length < 1) continue;
    if (children.length < 2 && !isLibraryTrack(el)) continue;
    if (!isLibraryTrack(el)) {
      let childrenWidth = 0;
      for (const child of children) childrenWidth += child.getBoundingClientRect().width;
      if (childrenWidth < viewport.clientWidth * 1.4) continue;
    }
    transformedTracks.push(el);
  }
  for (const track of transformedTracks) {
    track.style.setProperty('transform', 'none', 'important');
    carouselsNormalized++;
  }
  // Which slide a library shows and how far it pushed that slide forward are one
  // runtime state: both are recomputed on every autoplay tick and on resize, and an
  // offline bundle with no library runtime can only render the resting layout. Clear
  // that state on both surfaces so the compare measures layout and content, not the
  // moment each side happened to be sampled. The fade-stack pass below re-applies
  // its own opacity/visibility afterwards, so fading carousels keep their state.
  for (const track of transformedTracks) {
    for (const slide of Array.from(track.children)) {
      if (slide.nodeType !== 1) continue;
      if (slide.style.transform) {
        slide.style.setProperty('transform', 'none', 'important');
        slideStatesNeutralized++;
      }
      if (slide.style.opacity) {
        slide.style.setProperty('opacity', '1', 'important');
        slideStatesNeutralized++;
      }
      if (slide.style.visibility) {
        slide.style.removeProperty('visibility');
        slideStatesNeutralized++;
      }
    }
  }
  const fadeSlides = [];
  for (const parent of Array.from(document.querySelectorAll('body *'))) {
    if (!clipsHorizontally(parent)) continue;
    const absolute = Array.from(parent.children).filter((child) => window.getComputedStyle(child).position === 'absolute');
    if (absolute.length < 2) continue;
    const first = absolute[0].getBoundingClientRect();
    const stacked = absolute.every((child) => {
      const rect = child.getBoundingClientRect();
      return Math.abs(rect.width - first.width) < 4 && Math.abs(rect.height - first.height) < 4 &&
        Math.abs(rect.top - first.top) < 4 && Math.abs(rect.left - first.left) < 4;
    });
    if (!stacked || first.width < 40 || first.height < 40) continue;
    fadeSlides.push(absolute);
  }
  for (const slides of fadeSlides) {
    for (let i = 0; i < slides.length; i++) {
      slides[i].style.setProperty('opacity', i === 0 ? '1' : '0', 'important');
      if (i > 0) slides[i].style.setProperty('visibility', 'hidden', 'important');
    }
    carouselsNormalized++;
  }
  await raf();
  await idle(500);

  // Slider geometry probe: the library-written inline geometry against what the
  // stylesheet actually resolves to, per track. Diagnostics only -- the harness
  // never rewrites geometry, because a clone that loses a library's slide widths
  // is a real layout defect, not a capture artefact to be masked away.
  const sliderProbe = [];
  const probeTargets = Array.from(document.querySelectorAll('body *')).filter((el) => {
    if (/swiper-wrapper|slick-track|s-wrap|s-content/.test(String(el.className || ''))) return true;
    if (el.children.length < 2) return false;
    const style = window.getComputedStyle(el);
    return /(auto|scroll|hidden)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 4;
  });
  for (const track of probeTargets.slice(0, 24)) {
    const style = window.getComputedStyle(track);
    const root = track.parentElement;
    sliderProbe.push({
      cls: String(track.className || '').slice(0, 90),
      rootCls: root ? String(root.className || '').slice(0, 90) : null,
      rootWidth: root ? Math.round(root.getBoundingClientRect().width) : null,
      trackWidth: Math.round(track.getBoundingClientRect().width),
      clientWidth: track.clientWidth,
      scrollWidth: track.scrollWidth,
      display: style.display,
      flexWrap: style.flexWrap,
      gap: style.gap,
      overflowX: style.overflowX,
      transform: style.transform,
      inlineTransform: track.style.transform || null,
      inlineWidth: track.style.width || null,
      slideCount: track.children.length,
      slides: Array.from(track.children).slice(0, 3).map((child) => {
        const childStyle = window.getComputedStyle(child);
        return {
          cls: String(child.className || '').slice(0, 70),
          inlineWidth: child.style.width || null,
          inlineMarginRight: child.style.marginRight || null,
          inlineTransform: child.style.transform || null,
          inlineOpacity: child.style.opacity || null,
          rectWidth: Math.round(child.getBoundingClientRect().width),
          computedWidth: childStyle.width,
          flexBasis: childStyle.flexBasis,
          opacity: childStyle.opacity,
        };
      }),
    });
  }

  const masks = [];
  for (const selector of ${JSON.stringify(maskSelectors)}) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { continue; }
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      masks.push({
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        selector,
      });
    }
  }

  return {
    url: location.href,
    deviceAttr: document.body ? document.body.getAttribute('data-device') : null,
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
    brokenImages: images.filter((img) => img.complete && img.naturalWidth === 0).length,
    totalImages: images.length,
    scrollWidth: document.documentElement.scrollWidth,
    masks,
    overlays,
    keptChrome,
    carouselsNormalized,
    slideStatesNeutralized,
    slideOrdersCanonicalized,
    sliderProbe,
  };
})()`;

const unionMasks = (left, right) => {
  const all = [...left, ...right].filter((box) => box.width >= 2 && box.height >= 2);
  const merged = [];
  for (const box of all) {
    const hit = merged.find(
      (m) => box.x < m.x + m.width && box.x + box.width > m.x && box.y < m.y + m.height && box.y + box.height > m.y
    );
    if (hit) {
      const x = Math.min(hit.x, box.x);
      const y = Math.min(hit.y, box.y);
      hit.width = Math.max(hit.x + hit.width, box.x + box.width) - x;
      hit.height = Math.max(hit.y + hit.height, box.y + box.height) - y;
      hit.x = x;
      hit.y = y;
    } else {
      merged.push({ x: box.x, y: box.y, width: box.width, height: box.height });
    }
  }
  return merged;
};

const maskArea = (boxes, width, height) => {
  if (!boxes.length) return 0;
  // Overlap-free union area on a coarse grid (deterministic, enough for reporting).
  const cols = Math.ceil(width / 16);
  const rows = Math.ceil(height / 16);
  const grid = new Uint8Array(cols * rows);
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x / 16));
    const x1 = Math.min(cols - 1, Math.floor((box.x + box.width) / 16));
    const y0 = Math.max(0, Math.floor(box.y / 16));
    const y1 = Math.min(rows - 1, Math.floor((box.y + box.height) / 16));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * cols + x] = 1;
  }
  let cells = 0;
  for (let i = 0; i < grid.length; i++) cells += grid[i];
  return cells * 256;
};

let window_ = null;
let preparedDevice = null;

const emulateSurface = async (device) => {
  const config = DEVICES[device];
  if (!config) throw new Error(`Unknown surface: ${device}`);
  const wc = window_.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  // A device-metrics override needs a committed renderer; applying it before any
  // document exists kills the Chromium process.
  await bound(wc.loadURL('about:blank'), CDP_TIMEOUT_MS, 'about:blank');
  await cdp(wc, 'Emulation.setDeviceMetricsOverride', {
    width: config.width,
    height: config.height,
    deviceScaleFactor: config.dpr,
    mobile: config.mobile,
  });
  await cdp(wc, 'Emulation.setUserAgentOverride', { userAgent: config.ua });
  if (config.mobile) {
    await cdp(wc, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await cdp(wc, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  session.fromPartition('parity-verify').setUserAgent(config.ua);
  preparedDevice = device;
};

const captureSurface = async (url, device) => {
  if (preparedDevice !== device) await emulateSurface(device);
  const wc = window_.webContents;
  const failures = [];
  wc.once('did-fail-load', (_e, code, desc) => failures.push(`${code} ${desc}`));
  const loadStarted = Date.now();
  try {
    await bound(wc.loadURL(url), 150000, `load ${url}`);
  } catch (firstError) {
    // The live origin is remote: one transient stall must not void a case.
    try { wc.stop(); } catch {}
    await sleep(1000);
    await bound(wc.loadURL(url), 150000, `load retry ${url}`);
  }
  const loadMs = Date.now() - loadStarted;
  await sleep(700);
  const settleStarted = Date.now();
  const settled = await bound(wc.executeJavaScript(SETTLE_SCRIPT(MASK_SELECTORS), true), 180000, `settle ${url}`);
  const settleMs = Date.now() - settleStarted;
  const metrics = await cdp(wc, 'Page.getLayoutMetrics', {}, `metrics ${url}`);
  const box = metrics.cssContentSize || metrics.contentSize;
  // Clip at the emulated viewport width, never at the document's content width:
  // both surfaces must rasterize onto the same grid or every row scores as a diff.
  const width = DEVICES[device].width;
  const height = Math.max(1, Math.ceil(box.height));
  const captureStarted = Date.now();
  const shot = await bound(
    wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      optimizeForSpeed: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }),
    CAPTURE_TIMEOUT_MS,
    `capture ${url}`
  );
  const captureMs = Date.now() - captureStarted;
  return {
    png: Buffer.from(shot.data, 'base64'),
    width,
    height,
    settled,
    loadFailures: failures,
    loadMs,
    settleMs,
    captureMs,
  };
};

// A capped list of 32px tiles cannot say *where* a failing diff lives: the cap
// fills with the topmost tiles, so a page that differs in its header and in one
// section below looks identical to one that differs everywhere. Slicing both
// captures into bands and re-running the canonical metric on each slice localizes
// the failure with the same per-pixel rule (antialias and edge filters included)
// instead of an approximation.
const bandDiagnostics = (computeDiff, livePng, clonePng, masks, bandHeight = 600) => {
  const liveImage = nativeImage.createFromBuffer(livePng);
  const cloneImage = nativeImage.createFromBuffer(clonePng);
  const liveSize = liveImage.getSize();
  const cloneSize = cloneImage.getSize();
  const width = Math.min(liveSize.width, cloneSize.width);
  const totalHeight = Math.min(liveSize.height, cloneSize.height);
  const bands = [];
  for (let y = 0; y < totalHeight; y += bandHeight) {
    const height = Math.min(bandHeight, totalHeight - y);
    const rect = { x: 0, y, width, height };
    const bandLive = liveImage.crop(rect).toPNG();
    const bandClone = cloneImage.crop(rect).toPNG();
    const bandMasks = masks
      .filter((m) => m.y < y + height && m.y + m.height > y)
      .map((m) => ({ ...m, y: m.y - y }));
    const bandDiff = computeDiff(bandLive, bandClone, 100, bandMasks);
    bands.push({
      y,
      height,
      diffPixels: bandDiff.diffPixels,
      mismatchPercent: Number(bandDiff.mismatchPercentage.toFixed(2)),
    });
  }
  return bands;
};

const slug = (route) => (route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '-'));

app.commandLine.appendSwitch('no-sandbox');
// A blocked case recovers by destroying its poisoned window before creating a fresh one.
// Electron's default `window-all-closed` handler quits the app across that 400ms gap, so
// one bad case used to end the whole matrix with the remaining cases never executed.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { computePixelDiff } = require('../.compiled/src/main/tools/browser-control-port');
  const partitionSession = session.fromPartition('parity-verify');
  partitionSession.setUserAgent(DESKTOP_UA);
  partitionSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['sec-ch-ua-mobile'] = preparedDevice === 'mobile' ? '?1' : '?0';
    callback({ requestHeaders: headers });
  });
  // Third-party trackers and chat widgets are deliberately absent from the offline
  // package (they cannot run offline and the package strips them), so letting them
  // run on the reference side would measure a state the clone is not allowed to
  // have. Worse, a hanging beacon keeps the load event pending, so `loadURL` never
  // resolves and the case is lost to a timeout that has nothing to do with the
  // clone. They are refused on both origins, and every refusal is reported.
  partitionSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const host = safeHost(details.url);
    if (!host || !TRACKER_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
      callback({ cancel: false });
      return;
    }
    blockedRequests.push(details.url.slice(0, 160));
    callback({ cancel: true });
  });

  const hidden = has('--hidden');
  window_ = createParityWindow();
  // A `captureBeyondViewport` capture needs a surface the compositor actually
  // rasterizes. A window that was never presented (or a view that is not attached
  // to one) produces no frames, and the CDP call hangs until its bound expires —
  // measured: detached view times out, presented view captures in ~130ms.
  // `showInactive` presents without stealing focus from the user's window.
  if (!hidden) {
    window_.showInactive();
    await sleep(600);
  }

  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    liveOrigin: LIVE_ORIGIN,
    cloneOrigin: CLONE_ORIGIN,
    tolerancePercent: TOLERANCE,
    devices: {},
    cases: [],
    verdict: 'INCONCLUSIVE',
  };

  // The report is rewritten after every case: a long matrix must leave readable
  // progress behind even if the run is interrupted or the host kills it.
  const writeReport = () => {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  };

  const cases = [];
  for (const route of ROUTES) for (const surface of SURFACES) cases.push({ route, surface });
  const selected = LIMIT > 0 ? cases.slice(0, LIMIT) : cases;

  const runCase = async (route, surface, row) => {
    const liveUrl = `${LIVE_ORIGIN}${route === '/' ? '/' : route}`;
    const cloneUrl = `${CLONE_ORIGIN}${route === '/' ? '/' : route}`;
    row.liveUrl = liveUrl;
    row.cloneUrl = cloneUrl;
    blockedRequests = [];
    const live = await captureSurface(liveUrl, surface);
    row.blockedRequestsLive = blockedRequests.slice(0, 12);
    blockedRequests = [];
    const clone = await captureSurface(cloneUrl, surface);
    row.blockedRequestsClone = blockedRequests.slice(0, 12);
    const masks = unionMasks(live.settled.masks, clone.settled.masks);
    const diff = computePixelDiff(live.png, clone.png, TOLERANCE, masks);
    const maskedArea = maskArea(masks, Math.min(live.width, clone.width), Math.min(live.height, clone.height));
    const unionArea = live.width * live.height + clone.width * clone.height - Math.min(live.width, clone.width) * Math.min(live.height, clone.height);
    Object.assign(row, {
      live: { width: live.width, height: live.height, device: live.settled.deviceAttr, brokenImages: live.settled.brokenImages, images: live.settled.totalImages, clientWidth: live.settled.clientWidth, scrollWidth: live.settled.scrollWidth, horizontalOverflow: live.settled.scrollWidth > live.settled.clientWidth, overlays: live.settled.overlays, keptChrome: live.settled.keptChrome, carouselsNormalized: live.settled.carouselsNormalized, slideStatesNeutralized: live.settled.slideStatesNeutralized, slideOrdersCanonicalized: live.settled.slideOrdersCanonicalized },
      clone: { width: clone.width, height: clone.height, device: clone.settled.deviceAttr, brokenImages: clone.settled.brokenImages, images: clone.settled.totalImages, clientWidth: clone.settled.clientWidth, scrollWidth: clone.settled.scrollWidth, horizontalOverflow: clone.settled.scrollWidth > clone.settled.clientWidth, overlays: clone.settled.overlays, keptChrome: clone.settled.keptChrome, carouselsNormalized: clone.settled.carouselsNormalized, slideStatesNeutralized: clone.settled.slideStatesNeutralized, slideOrdersCanonicalized: clone.settled.slideOrdersCanonicalized, loadFailures: clone.loadFailures },
      heightDeltaPercent: Number((((clone.height - live.height) / Math.max(1, live.height)) * 100).toFixed(2)),
      dimensionsMatch: diff.dimensionsMatch,
      mismatchPercent: Number(diff.mismatchPercentage.toFixed(3)),
      diffPixels: diff.diffPixels,
      totalPixels: diff.totalPixels,
      maskedAreaPercent: Number(((maskedArea / Math.max(1, unionArea)) * 100).toFixed(3)),
      maskBoxes: masks.length,
      diffRegions: diff.diffBoundingBoxes.slice(0, 6),
      verdict: diff.mismatchPercentage < TOLERANCE ? 'PASS' : 'FAIL',
      livePng: live.png,
      clonePng: clone.png,
    });
    if (has('--probe-sliders')) {
      row.sliderProbe = {
        live: live.settled.sliderProbe,
        clone: clone.settled.sliderProbe,
      };
      row.verdict = 'PROBE';
    }
    if (row.verdict === 'FAIL') {
      row.diffBands = bandDiagnostics(computePixelDiff, live.png, clone.png, masks)
        .filter((band) => band.diffPixels > 0)
        .sort((a, b) => b.diffPixels - a.diffPixels);
    }
    return row;
  };

  for (const { route, surface } of selected) {
    const label = `${surface} ${route}`;
    const started = Date.now();
    const row = { route, surface };
    try {
      await bound(runCase(route, surface, row), CASE_TIMEOUT_MS, `case ${label}`);
      const livePng = row.livePng;
      const clonePng = row.clonePng;
      delete row.livePng;
      delete row.clonePng;
      row.elapsedMs = Date.now() - started;
      if (SAVE_IMAGES || row.verdict === 'FAIL') {
        fs.mkdirSync(IMAGE_DIR, { recursive: true });
        fs.writeFileSync(path.join(IMAGE_DIR, `${slug(route)}-${surface}-live.png`), livePng);
        fs.writeFileSync(path.join(IMAGE_DIR, `${slug(route)}-${surface}-clone.png`), clonePng);
      }
      console.log(
        `[parity] ${label.padEnd(28)} ${row.verdict} mismatch=${row.mismatchPercent}% ` +
          `live=${row.live.width}x${row.live.height} clone=${row.clone.width}x${row.clone.height} ` +
          `hDelta=${row.heightDeltaPercent}% masked=${row.maskedAreaPercent}% (${row.elapsedMs}ms)` +
          ` carouselState=live:${row.live.carouselsNormalized}/${row.live.slideStatesNeutralized}/${row.live.slideOrdersCanonicalized} clone:${row.clone.carouselsNormalized}/${row.clone.slideStatesNeutralized}/${row.clone.slideOrdersCanonicalized}`
      );
      if (has('--probe-sliders') && row.sliderProbe) {
        for (const side of ['live', 'clone']) {
          console.log(`[probe] ${label} ${side}: ${row.sliderProbe[side].length} track(s)`);
          row.sliderProbe[side].forEach((track, index) => {
            console.log(`[probe]   ${side}[${index}] ${JSON.stringify(track)}`);
          });
        }
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      row.verdict = message.includes('TIMEOUT') ? 'BLOCKED' : 'ERROR';
      row.error = message;
      row.elapsedMs = Date.now() - started;
      console.error(`[parity] ${label.padEnd(28)} ${row.verdict} ${message} (${row.elapsedMs}ms)`);
      // Recover the transport for the next case instead of inheriting a stuck queue.
      try { await resetParityWindow(); } catch (resetError) {
        console.error(`[parity] window reset failed: ${resetError && resetError.message}`);
      }
    }
    report.cases.push(row);
    writeReport();
  }

  const executed = report.cases.filter((c) => c.verdict === 'PASS' || c.verdict === 'FAIL');
  const passed = executed.filter((c) => c.verdict === 'PASS');
  report.executed = executed.length;
  report.passed = passed.length;
  report.blocked = report.cases.filter((c) => c.verdict === 'BLOCKED').length;
  report.errored = report.cases.filter((c) => c.verdict === 'ERROR').length;
  report.worstMismatchPercent = executed.length ? Math.max(...executed.map((c) => c.mismatchPercent)) : null;
  report.verdict = executed.length > 0 && report.blocked === 0 && report.errored === 0 && passed.length === executed.length
    ? 'VERIFIED'
    : executed.length === 0
      ? 'BLOCKED'
      : 'HARD_FAILED';
  report.finishedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n[parity] verdict=${report.verdict} passed=${report.passed}/${report.executed} blocked=${report.blocked} worst=${report.worstMismatchPercent}%`);
  console.log(`[parity] report: ${OUT_FILE}`);
  process.exitCode = report.verdict === 'VERIFIED' || has('--probe-sliders') ? 0 : 1;
  window_.destroy();
  app.quit();
}).catch((error) => {
  console.error('[parity] fatal', error);
  process.exitCode = 2;
  app.quit();
});
