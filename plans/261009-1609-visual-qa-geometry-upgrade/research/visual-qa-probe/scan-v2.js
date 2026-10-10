// Reference prototype for LayoutIntegrityEngine v2 (in-page scan, synchronous).
// Port rules: this file avoids backticks and dollar-brace so it can be pasted verbatim into a
// String.raw template in the engine (backslashes stay as written; no doubling needed).
(() => {
  const VIEWPORT_NAME = '__VIEWPORT_NAME__';
  const doc = document.documentElement;
  const body = document.body;
  const vw = window.innerWidth || (doc ? doc.clientWidth : 0);
  const vh = window.innerHeight || (doc ? doc.clientHeight : 0);
  const viewport = { name: VIEWPORT_NAME, width: vw, height: vh };
  if (!doc || !body || !Number.isFinite(doc.clientWidth) || doc.clientWidth <= 0) {
    return {
      measured: false,
      unmeasuredReason: 'the scanned tab has no laid-out CSS viewport (documentElement.clientWidth=' + (doc ? doc.clientWidth : 'null') + ', window.innerWidth=' + window.innerWidth + '); layout integrity was not measured',
      viewport: viewport,
      findings: []
    };
  }
  const t0 = performance.now();

  const ELEMENT_CAP = 15000;
  const RUN_CAP = 12000;
  const SWEEP_CAP = 60;
  const WARNING_CAP_PER_KIND = 10;
  const ACTIONABLE = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, [data-action]';
  const CAROUSEL_SLIDE = '.swiper-slide, .swiper-wrapper, .slick-slide, .slick-track, .splide__slide, .flickity-slider, .glide__slide, .owl-item, [aria-roledescription="slide"], [aria-roledescription="carousel"]';
  const PLATFORM_PREVIEW_CHROME = '#haravan-notification, #preview-bar-iframe';
  const IDENTITY = 'matrix(1, 0, 0, 1, 0, 0)';

  const stats = { elements: 0, textRuns: 0, controls: 0, sweepSteps: 0, truncated: false, truncatedReasons: [], durationMs: 0 };
  stats.phaseMs = {};
  let tMark = t0;
  const mark = (k) => { const n = performance.now(); stats.phaseMs[k] = Math.round(n - tMark); tMark = n; };
  const findings = [];
  const warningCount = {};

  const capDetails = (str) => (typeof str !== 'string' ? '' : (str.length > 240 ? str.slice(0, 237) + '...' : str));
  const snippet = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 37) + '...' : t;
  };
  const getSelector = (el) => {
    if (!el || el.nodeType !== 1) return 'document';
    try {
      const parts = [];
      let curr = el;
      while (curr && curr.nodeType === 1 && parts.length < 4 && curr !== doc && curr !== body) {
        let part = curr.tagName.toLowerCase();
        if (curr.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(curr.id)) {
          parts.unshift(part + '#' + curr.id);
          break;
        }
        if (curr.className && typeof curr.className === 'string') {
          const cls = curr.className.trim().split(/\s+/).find((c) => c && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c));
          if (cls) part += '.' + cls;
        }
        parts.unshift(part);
        curr = curr.parentElement;
      }
      if (parts.length === 0 && curr) parts.push(curr.tagName.toLowerCase());
      const sel = parts.join(' > ');
      return sel.length > 200 ? sel.slice(0, 200) : sel;
    } catch (e) {
      return (el.tagName ? el.tagName.toLowerCase() : 'element').slice(0, 200);
    }
  };
  const toRect = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) });
  const push = (f) => {
    if (f.severity === 'warning') {
      warningCount[f.kind] = (warningCount[f.kind] || 0) + 1;
      if (warningCount[f.kind] > WARNING_CAP_PER_KIND) return;
    }
    f.details = capDetails(f.details);
    findings.push(f);
  };
  const detectorFailed = (kind, err) => push({ kind: kind, severity: 'warning', selector: 'document', details: 'Detector ' + kind + ' threw: ' + (err && err.message ? err.message : String(err)) });

  // ---- memoized style / ancestry helpers -------------------------------------------------
  const styleMemo = new Map();
  const cs = (el) => {
    let s = styleMemo.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleMemo.set(el, s);
    }
    return s;
  };
  // Per-element memo over the ancestor chain; 'empty' is returned above <body>.
  const memo = (empty, fn) => {
    const m = new Map();
    return (el) => {
      if (!el || el.nodeType !== 1 || el === doc) return empty;
      if (m.has(el)) return m.get(el);
      const v = fn(el);
      m.set(el, v);
      return v;
    };
  };
  const parentOf = (el) => (el.parentElement && el.parentElement !== doc ? el.parentElement : null);

  const painted = memo(false, (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true));
  const alphaOfColor = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return c === 'transparent' ? 0 : 1;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return parts.length < 4 ? 1 : parts[3];
  };
  // Glyphs actually receive ink (transparent fill without background-clip:text paints nothing).
  const inked = (el) => {
    const s = cs(el);
    if (alphaOfColor(s.webkitTextFillColor || s.color) > 0.05) return true;
    for (let e = el; e && e !== doc; e = e.parentElement) {
      if (cs(e).webkitBackgroundClip === 'text' || cs(e).backgroundClip === 'text') return true;
    }
    return false;
  };
  // clip / clip-path cut paint in ways line rects do not describe (sr-only, reveal masks).
  const clipPathed = memo(false, (el) => {
    const s = cs(el);
    if ((s.clipPath && s.clipPath !== 'none') || (s.clip && s.clip !== 'auto')) return true;
    return clipPathed(parentOf(el));
  });

  const hasRealTransform = (s) => s.transform !== 'none' && s.transform !== IDENTITY;
  const isRotatedOr3d = (s) => {
    const t = s.transform;
    if (t && t.indexOf('matrix3d') === 0) return true;
    if (t && t.indexOf('matrix(') === 0) {
      const p = t.slice(7, -1).split(',').map(Number);
      if (Math.abs(p[1]) > 0.001 || Math.abs(p[2]) > 0.001) return true;
    }
    return s.backfaceVisibility === 'hidden' || s.transformStyle === 'preserve-3d';
  };
  const isMovingStyle = (s) => hasRealTransform(s) || (s.animationName && s.animationName !== 'none' && String(s.animationIterationCount).indexOf('infinite') !== -1);
  const establishesContainingBlock = (s) => s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain || '') || /transform|filter/.test(s.willChange || '');

  // Nearest fixed/sticky ancestor-or-self (a "layer" floats over flow content by design).
  const layerOf = memo(null, (el) => {
    const p = cs(el).position;
    if (p === 'fixed' || p === 'sticky') return el;
    return layerOf(parentOf(el));
  });
  const fixedLayerOf = memo(null, (el) => (cs(el).position === 'fixed' ? el : fixedLayerOf(parentOf(el))));
  // Rotated, skewed, 3D or backface-hidden content: line rects are bounding boxes, not glyph boxes.
  const in3d = memo(false, (el) => isRotatedOr3d(cs(el)) || in3d(parentOf(el)));
  // Subtrees with a running animation or transition (crossfading slides, pulsing badges) are
  // caught mid-motion: their geometry and opacity describe a frame, not the settled layout.
  const animTargets = new Set();
  try {
    const anims = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
    for (let i = 0; i < anims.length; i++) {
      const a = anims[i];
      if (a.playState === 'running' && a.effect && a.effect.target) animTargets.add(a.effect.target);
    }
  } catch (e) {}
  const animating = memo(false, (el) => animTargets.has(el) || animating(parentOf(el)));
  const unsettled = (el) => in3d(el) || animating(el);
  const alphaOf = memo(1, (el) => {
    const o = parseFloat(cs(el).opacity);
    return (Number.isFinite(o) ? o : 1) * alphaOf(parentOf(el));
  });

  // Ancestors whose overflow clips the border box of el (containing-block aware).
  const boxClips = memo([], (el) => {
    const pos = cs(el).position;
    let a = parentOf(el);
    if (pos === 'fixed') {
      while (a && !establishesContainingBlock(cs(a))) a = parentOf(a);
    } else if (pos === 'absolute') {
      while (a && cs(a).position === 'static' && !establishesContainingBlock(cs(a))) a = parentOf(a);
    }
    return a ? contentClips(a) : [];
  });
  // Clips applied to the in-flow content (text, static children) of el.
  const contentClips = memo([], (el) => {
    const s = cs(el);
    const own = s.overflowX !== 'visible' || s.overflowY !== 'visible' ? [el] : [];
    return own.concat(boxClips(el));
  });

  const paddingBox = (a) => {
    const r = a.getBoundingClientRect();
    const left = r.left + a.clientLeft;
    const top = r.top + a.clientTop;
    return { left: left, top: top, right: left + a.clientWidth, bottom: top + a.clientHeight };
  };
  const boxMemo = new Map();
  const clipBox = (a) => {
    let b = boxMemo.get(a);
    if (!b) {
      b = paddingBox(a);
      boxMemo.set(a, b);
    }
    return b;
  };
  const span = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const isScrollAxis = (v) => v === 'auto' || v === 'scroll';
  const isHiddenAxis = (v) => v === 'hidden' || v === 'clip';
  const movingBetween = (from, upto) => {
    for (let e = from; e && e !== upto && e !== doc; e = e.parentElement) {
      if (isMovingStyle(cs(e)) || animTargets.has(e) || e.matches(CAROUSEL_SLIDE) || e.tagName === 'MARQUEE') return true;
    }
    return false;
  };
  const intendedTruncation = (from, upto) => {
    for (let e = from; e && e !== doc; e = e.parentElement) {
      const s = cs(e);
      if (s.textOverflow === 'ellipsis') return true;
      if (s.webkitLineClamp && s.webkitLineClamp !== 'none') return true;
      if (e === upto) break;
    }
    return false;
  };
  const isOpaque = (el) => {
    if (alphaOf(el) < 0.5) return false;
    if (el instanceof SVGElement) return true;
    if (/^(IMG|VIDEO|CANVAS|IFRAME|PICTURE|EMBED|OBJECT)$/.test(el.tagName)) return true;
    const s = cs(el);
    if (s.backgroundImage && s.backgroundImage !== 'none') return true;
    return alphaOfColor(s.backgroundColor) >= 0.5;
  };
  // A height-capped box followed by a disclosure control ("Xem thêm", aria-expanded, or an
  // aria-controls owner) clips its content on purpose: the cut line is a collapsed read-more.
  const DISCLOSURE_TEXT = /(xem|đọc) (thêm|tiếp|tất cả)|mở rộng|hiển thị thêm|read more|show more|see more|view more|expand/i;
  const isDisclosure = (el) => el.hasAttribute('aria-expanded') || (el.textContent.length <= 40 && DISCLOSURE_TEXT.test(el.textContent));
  let controlledIds = null;
  const collapsedByDesign = memo(false, (a) => {
    if (a.scrollHeight <= a.clientHeight + 1) return false;
    if (a.id) {
      if (!controlledIds) {
        controlledIds = new Set();
        const owners = document.querySelectorAll('[aria-controls]');
        for (let i = 0; i < owners.length; i++) owners[i].getAttribute('aria-controls').split(/ +/).forEach((id) => controlledIds.add(id));
      }
      if (controlledIds.has(a.id)) return true;
    }
    let up = a;
    for (let d = 0; d < 2 && up && up !== body; d++, up = up.parentElement) {
      let sib = up.nextElementSibling;
      for (let n = 0; sib && n < 3; n++, sib = sib.nextElementSibling) {
        if (sib.matches(ACTIONABLE) && isDisclosure(sib)) return true;
        const inner = sib.querySelectorAll(ACTIONABLE);
        for (let i = 0; i < inner.length && i < 5; i++) if (isDisclosure(inner[i])) return true;
      }
    }
    return false;
  });

  // ---- page scroller ----------------------------------------------------------------------
  const startX = window.scrollX;
  const startY = window.scrollY;
  const bodyStyle = cs(body);
  let scroller = null;
  if (doc.scrollHeight > doc.clientHeight + 1) scroller = 'window';
  else if (body.scrollHeight > body.clientHeight + 1 && isScrollAxis(bodyStyle.overflowY)) scroller = 'body';
  const bodyStartTop = body.scrollTop;
  const scrollToY = (y) => {
    if (scroller === 'body') body.scrollTo({ top: y, left: 0, behavior: 'instant' });
    else window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    return scroller === 'body' ? body.scrollTop : window.scrollY;
  };
  const pageHeight = scroller === 'body' ? body.scrollHeight : Math.max(doc.scrollHeight, body.scrollHeight);
  const docHScrollable = doc.scrollWidth > doc.clientWidth + 1;
  // Visible part of an element's border box after every clipping ancestor (null: clipped away).
  const clippedRect = (el, r) => {
    const v = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    const clips = boxClips(el);
    for (let k = 0; k < clips.length; k++) {
      const a = clips[k];
      const s = cs(a);
      const b = clipBox(a);
      if (s.overflowX !== 'visible') { v.left = Math.max(v.left, b.left); v.right = Math.min(v.right, b.right); }
      if (s.overflowY !== 'visible' && !(scroller === 'body' && a === body)) { v.top = Math.max(v.top, b.top); v.bottom = Math.min(v.bottom, b.bottom); }
      if (v.right - v.left < 1 || v.bottom - v.top < 1) return null;
    }
    return v;
  };
  boxMemo.clear();
  scrollToY(0);

  const allElements = document.getElementsByTagName('*');
  stats.elements = allElements.length;
  if (stats.elements > ELEMENT_CAP) {
    stats.truncated = true;
    stats.truncatedReasons.push('elements ' + stats.elements + ' > ' + ELEMENT_CAP);
  }
  const elementLimit = Math.min(allElements.length, ELEMENT_CAP);

  // ---- 1. controls: zero-size (warning) and offscreen (critical) -------------------------
  const controls = [];
  try {
    const nodes = document.querySelectorAll(ACTIONABLE);
    for (let i = 0; i < nodes.length && i < ELEMENT_CAP; i++) {
      const el = nodes[i];
      if (el.closest('svg') || el.closest(PLATFORM_PREVIEW_CHROME)) continue;
      if (!painted(el)) continue;
      if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        if (el.getClientRects().length === 0) continue;
        push({ kind: 'zero-size', severity: 'warning', selector: getSelector(el), details: 'Rendered actionable control has zero size (' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px)', rect: toRect(r) });
        continue;
      }
      const outside = r.right <= 0 || r.left >= vw || r.bottom <= 0;
      if (outside) {
        let parked = Boolean(layerOf(el)) || movingBetween(el, null);
        if (!parked) {
          const clips = boxClips(el);
          for (let k = 0; k < clips.length && !parked; k++) {
            const s = cs(clips[k]);
            if (isScrollAxis(s.overflowX) || isScrollAxis(s.overflowY)) parked = true;
          }
        }
        if (!parked) {
          for (let e = el; e && e !== body && !parked; e = e.parentElement) {
            if (cs(e).position === 'absolute') {
              const er = e.getBoundingClientRect();
              if (er.right <= 0 || er.left >= vw || er.bottom <= 0) parked = true;
            }
          }
        }
        if (!parked) {
          push({ kind: 'offscreen', severity: 'critical', selector: getSelector(el), details: 'Actionable control is laid out outside the viewport and cannot be reached (x: ' + Math.round(r.left) + ', y: ' + Math.round(r.top) + ')', rect: toRect(r) });
        }
        continue;
      }
      if (r.width >= 8 && r.height >= 8) {
        // A control clipped away by an ancestor is hidden, not covered: it cannot stack or be occluded.
        const cvis = clippedRect(el, r);
        if (cvis) controls.push({ el: el, rect: r, vis: cvis, layer: layerOf(el) });
      }
    }
    stats.controls = controls.length;
  } catch (err) {
    detectorFailed('offscreen', err);
  }

  mark('setup+controls');
  // ---- 2. text runs ---------------------------------------------------------------------------
  const runs = [];
  try {
    const range = document.createRange();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      const p = n.parentElement;
      if (!p || p.closest('script, style, noscript, template, svg, select, option, textarea')) continue;
      if (p.closest(PLATFORM_PREVIEW_CHROME)) continue;
      if (!painted(p) || !inked(p) || clipPathed(p)) continue;
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width < 1 || r.height < 1) continue;
        if (runs.length >= RUN_CAP) break;
        runs.push({ n: n, p: p, r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } });
      }
      if (runs.length >= RUN_CAP) {
        stats.truncated = true;
        stats.truncatedReasons.push('text runs > ' + RUN_CAP);
        break;
      }
    }
    stats.textRuns = runs.length;
  } catch (err) {
    detectorFailed('clipping', err);
  }

  mark('runs');
  // ---- 3. clipped text (line box sliced or cut by a clipping ancestor) -----------------------
  const clippedOwners = new Set();
  // owner element -> { visible: bool, below: clip that pushed a whole line past its bottom edge }
  const ownerFate = new Map();
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    try {
      const r = run.r;
      const p = run.p;
      const fixedLayer = fixedLayerOf(p);
      let vis = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      let hidden = false;
      let defect = null;
      let inXScroller = false;
      const clips = contentClips(p);
      for (let k = 0; k < clips.length; k++) {
        const a = clips[k];
        const s = cs(a);
        const b = clipBox(a);
        const pageAxisY = scroller === 'body' && a === body;
        const hx = isHiddenAxis(s.overflowX);
        const hy = isHiddenAxis(s.overflowY) && !pageAxisY;
        const sx = isScrollAxis(s.overflowX);
        const sy = isScrollAxis(s.overflowY) && !pageAxisY;
        const visW = span(r.left, r.right, b.left, b.right);
        const visH = span(r.top, r.bottom, b.top, b.bottom);
        if ((hy || sy) && visH <= r.height * 0.15) {
          if (hy && r.top >= b.bottom - r.height * 0.15 - 1 && !movingBetween(p, a) && !in3d(p) && !intendedTruncation(p, a) && !collapsedByDesign(a) && a !== p) run.below = a;
          hidden = true;
          break;
        }
        if ((hx || sx) && visW < 1) { hidden = true; break; }
        if (hx || sx) { vis.left = Math.max(vis.left, b.left); vis.right = Math.min(vis.right, b.right); }
        if (hy || sy) { vis.top = Math.max(vis.top, b.top); vis.bottom = Math.min(vis.bottom, b.bottom); }
        if (!defect && hy && visH < r.height * 0.85 && !movingBetween(p, a) && !in3d(p) && !collapsedByDesign(a)) {
          defect = { by: a, detail: 'line sliced vertically: ' + Math.round(visH) + '/' + Math.round(r.height) + 'px visible' };
        }
        if (!defect && hx && r.width - visW >= 4 && !intendedTruncation(p, a) && !movingBetween(p, a) && !in3d(p)) {
          defect = { by: a, detail: 'line cut horizontally: ' + Math.round(visW) + '/' + Math.round(r.width) + 'px visible' };
        }
        if (sx || sy) {
          // Content of a horizontal scroller legitimately runs past the viewport edge.
          if (sx) inXScroller = true;
          break;
        }
      }
      if (!hidden) {
        const visW = span(r.left, r.right, 0, vw);
        if (visW < 1) hidden = true;
        else {
          if (!defect && !docHScrollable && !fixedLayer && !inXScroller && r.width - visW >= 4 && !intendedTruncation(p, null) && !movingBetween(p, null) && !in3d(p)) {
            defect = { by: null, detail: 'line cut by the viewport edge: ' + Math.round(visW) + '/' + Math.round(r.width) + 'px visible' };
          }
          vis.left = Math.max(vis.left, 0);
          vis.right = Math.min(vis.right, vw);
        }
        if (fixedLayer) {
          vis.top = Math.max(vis.top, 0);
          vis.bottom = Math.min(vis.bottom, vh);
          if (vis.bottom - vis.top < 1) hidden = true;
        }
      }
      const fate = ownerFate.get(p) || { visible: false, below: null, run: run };
      ownerFate.set(p, fate);
      if (hidden) {
        if (run.below && !fate.below) fate.below = run.below;
        continue;
      }
      fate.visible = true;
      run.vis = vis;
      if (defect && !clippedOwners.has(p)) {
        clippedOwners.add(p);
        push({ kind: 'clipping', severity: 'critical', selector: getSelector(p), details: 'Text "' + snippet(run.n.nodeValue) + '" ' + defect.detail + (defect.by ? ' by ' + getSelector(defect.by) : ''), rect: toRect(r) });
      }
    } catch (err) {
      detectorFailed('clipping', err);
      break;
    }
  }
  // Whole text elements pushed below the bottom edge of a fixed-size box that still shows other
  // text: the box is too short for its content (a collapsed box shows nothing and is skipped).
  try {
    const boxShowsText = new Map();
    const shows = (box) => {
      if (boxShowsText.has(box)) return boxShowsText.get(box);
      let v = false;
      const bb = clipBox(box);
      if (bb.bottom - bb.top >= 8) {
        for (let i = 0; i < runs.length && !v; i++) if (runs[i].vis && box.contains(runs[i].p)) v = true;
      }
      boxShowsText.set(box, v);
      return v;
    };
    const reportedBoxes = new Map();
    ownerFate.forEach((fate, p) => {
      if (fate.visible || !fate.below || clippedOwners.has(p)) return;
      if (!shows(fate.below)) return;
      const n = (reportedBoxes.get(fate.below) || 0) + 1;
      reportedBoxes.set(fate.below, n);
      if (n > 1) return;
      clippedOwners.add(p);
      push({ kind: 'clipping', severity: 'critical', selector: getSelector(p), details: 'Text "' + snippet(fate.run.n.nodeValue) + '" is entirely hidden below the bottom edge of ' + getSelector(fate.below) + ', which is too short for its content', rect: toRect(fate.run.r) });
    });
  } catch (err) {
    detectorFailed('clipping', err);
  }

  mark('clipping');
  // ---- 4. text painted over text -------------------------------------------------------------
  try {
    const live = [];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run.vis) continue;
      const w = run.vis.right - run.vis.left;
      const h = run.vis.bottom - run.vis.top;
      if (w < 2 || h < 4 || h < run.r.height * 0.5) continue;
      if (unsettled(run.p)) continue;
      run.layer = layerOf(run.p);
      live.push(run);
    }
    live.sort((a, b) => a.vis.top - b.vis.top);
    const reported = new Set();
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        if (b.vis.top >= a.vis.bottom) break;
        if (a.n === b.n || a.layer !== b.layer) continue;
        const ix = span(a.vis.left, a.vis.right, b.vis.left, b.vis.right);
        if (ix < 4) continue;
        const iy = span(a.vis.top, a.vis.bottom, b.vis.top, b.vis.bottom);
        const minH = Math.min(a.vis.bottom - a.vis.top, b.vis.bottom - b.vis.top);
        if (iy < minH * 0.5) continue;
        const pairKey = getSelector(a.p) + '|' + getSelector(b.p);
        if (reported.has(b.p) || reported.has(pairKey)) continue;
        reported.add(pairKey);
        reported.add(b.p);
        push({ kind: 'overlap', severity: 'critical', selector: getSelector(b.p), details: 'Text "' + snippet(b.n.nodeValue) + '" is painted over text "' + snippet(a.n.nodeValue) + '" in ' + getSelector(a.p) + ' (' + Math.round(ix) + 'x' + Math.round(iy) + 'px)', rect: toRect({ left: Math.max(a.vis.left, b.vis.left), top: Math.max(a.vis.top, b.vis.top), right: Math.min(a.vis.right, b.vis.right), bottom: Math.min(a.vis.bottom, b.vis.bottom) }) });
      }
    }
  } catch (err) {
    detectorFailed('overlap', err);
  }

  mark('textOverText');
  // ---- 5. actionable controls stacked on each other ----------------------------------------
  const isAbsoluteOverlayOver = (control, other) => {
    for (let curr = control; curr && !curr.contains(other); curr = curr.parentElement) {
      const p = cs(curr).position;
      if (p === 'absolute' || p === 'fixed') return true;
    }
    return false;
  };
  try {
    const flowControls = controls.filter((c) => !c.layer && !unsettled(c.el));
    flowControls.sort((a, b) => a.rect.top - b.rect.top);
    const fragments = (el) => {
      const d = cs(el).display;
      if (d === 'inline') {
        const out = [];
        const rs = el.getClientRects();
        for (let i = 0; i < rs.length; i++) if (rs[i].width >= 1 && rs[i].height >= 1) out.push(rs[i]);
        return out;
      }
      return [el.getBoundingClientRect()];
    };
    for (let i = 0; i < flowControls.length; i++) {
      const A = flowControls[i];
      for (let j = i + 1; j < flowControls.length; j++) {
        const B = flowControls[j];
        if (B.rect.top >= A.rect.bottom) break;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        if (isAbsoluteOverlayOver(A.el, B.el) || isAbsoluteOverlayOver(B.el, A.el)) continue;
        const fa = fragments(A.el);
        const fb = fragments(B.el);
        let best = 0;
        let bestRect = null;
        for (let x = 0; x < fa.length; x++) {
          for (let y = 0; y < fb.length; y++) {
            const ix = span(fa[x].left, fa[x].right, fb[y].left, fb[y].right);
            const iy = span(fa[x].top, fa[x].bottom, fb[y].top, fb[y].bottom);
            if (ix < 8 || iy < 8) continue;
            const ratio = (ix * iy) / Math.min(fa[x].width * fa[x].height, fb[y].width * fb[y].height);
            if (ratio > best) { best = ratio; bestRect = { left: Math.max(fa[x].left, fb[y].left), top: Math.max(fa[x].top, fb[y].top), right: Math.min(fa[x].right, fb[y].right), bottom: Math.min(fa[x].bottom, fb[y].bottom) }; }
          }
        }
        if (best >= 0.5) {
          push({ kind: 'overlap', severity: 'critical', selector: getSelector(B.el), details: 'Actionable controls stacked: ' + getSelector(B.el) + ' covers ' + Math.round(best * 100) + '% of ' + getSelector(A.el), rect: toRect(bestRect) });
        }
      }
    }
  } catch (err) {
    detectorFailed('overlap', err);
  }

  mark('controlStack');
  // ---- 6. in-flow sibling boxes overlapping (ambiguous: warning only) -------------------------
  try {
    for (let i = 0; i < elementLimit; i++) {
      const parent = allElements[i];
      if (parent.children.length < 2 || parent.closest('svg, head')) continue;
      const pd = cs(parent).display;
      if (pd === 'grid' || pd === 'inline-grid' || pd === 'none' || pd === 'contents') continue;
      if (!painted(parent)) continue;
      const kids = [];
      for (let c = 0; c < parent.children.length; c++) {
        const k = parent.children[c];
        const s = cs(k);
        if (s.position !== 'static' && s.position !== 'relative') continue;
        if (s.float !== 'none' || s.display === 'inline' || s.display === 'contents' || s.display === 'none' || s.display.indexOf('table') === 0) continue;
        if (hasRealTransform(s) || !painted(k)) continue;
        const r = k.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        kids.push({ k: k, r: r });
      }
      for (let a = 0; a < kids.length; a++) {
        for (let b = a + 1; b < kids.length; b++) {
          const ix = span(kids[a].r.left, kids[a].r.right, kids[b].r.left, kids[b].r.right);
          const iy = span(kids[a].r.top, kids[a].r.bottom, kids[b].r.top, kids[b].r.bottom);
          if (ix > 4 && iy > 4) {
            push({ kind: 'overlap', severity: 'warning', selector: getSelector(kids[b].k), details: 'In-flow sibling boxes overlap ' + Math.round(ix) + 'x' + Math.round(iy) + 'px: ' + getSelector(kids[a].k) + ' and ' + getSelector(kids[b].k), rect: toRect({ left: Math.max(kids[a].r.left, kids[b].r.left), top: Math.max(kids[a].r.top, kids[b].r.top), right: Math.min(kids[a].r.right, kids[b].r.right), bottom: Math.min(kids[a].r.bottom, kids[b].r.bottom) }) });
          }
        }
      }
    }
  } catch (err) {
    detectorFailed('overlap', err);
  }

  mark('siblingBoxes');
  // ---- 7. covered text / covered controls, swept over the full page ---------------------------
  try {
    const targets = [];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run.vis || unsettled(run.p)) continue;
      if (cs(run.p).pointerEvents === 'none') continue;
      const w = run.vis.right - run.vis.left;
      const h = run.vis.bottom - run.vis.top;
      if (w < 4 || h < 4) continue;
      targets.push({ owner: run.p, label: 'Text "' + snippet(run.n.nodeValue) + '"', vis: run.vis, fixed: Boolean(fixedLayerOf(run.p) || layerOf(run.p)), layer: layerOf(run.p) });
    }
    for (let i = 0; i < controls.length; i++) {
      const c = controls[i];
      if (unsettled(c.el) || cs(c.el).pointerEvents === 'none') continue;
      targets.push({ owner: c.el, label: 'Control ' + getSelector(c.el), vis: { left: Math.max(0, c.vis.left), right: Math.min(vw, c.vis.right), top: c.vis.top, bottom: c.vis.bottom }, fixed: Boolean(c.layer), layer: c.layer, control: true });
    }
    const layerInfo = new Map();
    const topLayer = (layer) => {
      let v = layerInfo.get(layer);
      if (v === undefined) {
        const r = layer.getBoundingClientRect();
        v = r.top < vh * 0.25 && r.bottom > 0 && (r.bottom - r.top) <= vh * 0.4 && (r.right - r.left) >= vw * 0.5;
        layerInfo.set(layer, v);
      }
      return v;
    };
    const steps = [0];
    const maxScroll = Math.max(0, pageHeight - vh);
    if (scroller) {
      const stride = Math.max(1, Math.floor(vh * 0.8));
      for (let y = stride; y < maxScroll + stride; y += stride) steps.push(Math.min(y, maxScroll));
    }
    if (steps.length > SWEEP_CAP) {
      stats.truncated = true;
      stats.truncatedReasons.push('sweep steps ' + steps.length + ' > ' + SWEEP_CAP);
      steps.length = SWEEP_CAP;
    }
    const done = new Set();
    const reportedOwners = new Set();
    for (let s = 0; s < steps.length; s++) {
      const want = steps[s];
      const got = s === 0 ? 0 : scrollToY(want);
      if (Math.abs(got - want) > 2) {
        stats.truncated = true;
        stats.truncatedReasons.push('page did not scroll to ' + want + ' (at ' + got + ')');
        break;
      }
      stats.sweepSteps++;
      for (let t = 0; t < targets.length; t++) {
        if (done.has(t)) continue;
        const tg = targets[t];
        if (tg.fixed && s > 0) { done.add(t); continue; }
        const top = tg.fixed ? tg.vis.top : tg.vis.top - got;
        const bottom = tg.fixed ? tg.vis.bottom : tg.vis.bottom - got;
        if (top < 0 || bottom > vh) {
          if (bottom - top <= vh) continue;
        }
        const cy = (Math.max(top, 0) + Math.min(bottom, vh)) / 2;
        if (cy < 0 || cy >= vh) continue;
        const inSlide = Boolean(tg.owner.closest(CAROUSEL_SLIDE));
        // One paint-order probe: 'covered' (opaque same-layer box, or opaque top bar at load),
        // 'deferred' (only a foreign fixed/sticky layer is in the way - retry at another offset), or 'clear'.
        const sample = (cx) => {
          // Fast path: the topmost hit is the owner (or its own subtree/ancestor) - nothing paints over it.
          const hit = document.elementFromPoint(cx, cy);
          if (!hit || hit === doc || hit === body || hit === tg.owner || tg.owner.contains(hit) || hit.contains(tg.owner)) return { state: 'clear' };
          const stack = document.elementsFromPoint(cx, cy);
          let deferredHere = false;
          for (let k = 0; k < stack.length; k++) {
            const e = stack[k];
            if (e === tg.owner || tg.owner.contains(e) || e.contains(tg.owner)) break;
            if (e === doc || e === body) break;
            if (e.closest(PLATFORM_PREVIEW_CHROME) || e.closest('dialog, [role="dialog"], [aria-modal="true"]')) continue;
            if (inSlide && e.closest(CAROUSEL_SLIDE)) continue;
            const eLayer = layerOf(e);
            if (eLayer && eLayer !== tg.layer) {
              if (s === 0 && !tg.fixed && topLayer(eLayer) && isOpaque(e)) return { state: 'covered', by: e, sticky: true };
              deferredHere = true;
              continue;
            }
            if (isOpaque(e)) return { state: 'covered', by: e, sticky: false };
          }
          return { state: deferredHere ? 'deferred' : 'clear' };
        };
        const xAt = (f) => Math.min(vw - 1, Math.max(0, tg.vis.left + (tg.vis.right - tg.vis.left) * f));
        const first = sample(xAt(0.5));
        if (first.state === 'clear') { done.add(t); continue; }
        if (first.state === 'deferred') continue;
        let covered = 1;
        const second = sample(xAt(0.2));
        if (second.state === 'covered') covered++;
        else if (sample(xAt(0.8)).state === 'covered') covered++;
        if (covered < 2) {
          if (second.state !== 'deferred') done.add(t);
          continue;
        }
        done.add(t);
        if (!reportedOwners.has(tg.owner)) {
          reportedOwners.add(tg.owner);
          const kind = first.sticky ? 'sticky-obstruction' : 'occlusion';
          push({ kind: kind, severity: 'critical', selector: getSelector(tg.owner), details: tg.label + ' is covered by ' + getSelector(first.by) + (first.sticky ? ' (fixed/sticky bar at page load)' : '') + ' at page y=' + Math.round(cy + (tg.fixed ? 0 : got)), rect: toRect({ left: tg.vis.left, top: tg.vis.top, right: tg.vis.right, bottom: tg.vis.bottom }) });
        }
      }
    }
  } catch (err) {
    detectorFailed('occlusion', err);
  } finally {
    if (scroller === 'body') body.scrollTo({ top: bodyStartTop, left: 0, behavior: 'instant' });
    window.scrollTo({ top: startY, left: startX, behavior: 'instant' });
  }

  mark('coverSweep');
  // ---- 8. layout-shift witness (buffered entries, read synchronously) ---------------------------
  try {
    let clsScore = 0;
    if (typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver(() => {});
      observer.observe({ type: 'layout-shift', buffered: true });
      const records = observer.takeRecords();
      observer.disconnect();
      for (let i = 0; i < records.length; i++) {
        const entry = records[i];
        if (entry && !entry.hadRecentInput && typeof entry.value === 'number') clsScore += entry.value;
      }
    }
    stats.cls = Math.round(clsScore * 1000) / 1000;
    if (clsScore > 0.1) {
      push({ kind: 'layout-shift', severity: 'warning', selector: 'document', details: 'Cumulative layout shift score ' + clsScore.toFixed(3) + ' exceeds 0.1', rect: { x: 0, y: 0, w: Math.round(vw), h: Math.round(vh) } });
    }
  } catch (err) {
    detectorFailed('layout-shift', err);
  }

  let out = findings;
  if (out.length > 50) {
    out = out.filter((f) => f.severity === 'critical').concat(out.filter((f) => f.severity !== 'critical')).slice(0, 50);
  }
  stats.durationMs = Math.round(performance.now() - t0);
  return { measured: true, viewport: viewport, findings: out, stats: stats };
})()
