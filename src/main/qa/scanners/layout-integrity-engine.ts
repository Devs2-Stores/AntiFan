export interface LayoutIntegrityFinding {
  kind: 'overlap' | 'clipping' | 'occlusion' | 'offscreen' | 'zero-size' | 'sticky-obstruction' | 'layout-shift';
  severity: 'critical' | 'warning';
  selector: string; // best-effort CSS path, capped 200 chars
  details: string; // human sentence, capped 240 chars
  rect?: { x: number; y: number; w: number; h: number };
}

export interface LayoutIntegrityStats {
  elements: number;
  textRuns: number;
  controls: number;
  sweepSteps: number;
  truncated: boolean;
  truncatedReasons: string[];
  failedDetectors: string[];
  durationMs: number;
  cls?: number;
  phaseMs?: Record<string, number>;
}

export interface LayoutIntegrityResult {
  measured: boolean;
  unmeasuredReason?: string; // REQUIRED when measured === false (same marker contract as overflow engine)
  viewport: {
    name?: string;
    width: number;
    height: number;
  };
  findings: LayoutIntegrityFinding[];
  stats?: LayoutIntegrityStats; // absent when measured === false
}

// In-page scan, synchronous. String.raw keeps every character as written: the script must
// never contain a backtick or a dollar-brace. '__VIEWPORT_NAME__' is substituted per call.
const LAYOUT_INTEGRITY_SCAN = String.raw`(() => {
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

  const stats = { elements: 0, textRuns: 0, controls: 0, sweepSteps: 0, truncated: false, truncatedReasons: [], failedDetectors: [], durationMs: 0 };
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
  const detectorFailed = (kind, err) => {
    stats.failedDetectors.push(kind);
    push({ kind: kind, severity: 'warning', selector: 'document', details: 'Detector ' + kind + ' threw: ' + (err && err.message ? err.message : String(err)) });
  };

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
  // Images that have not loaded yet (still fetching, or a lazy source not swapped in) and render
  // collapsed: they have no size yet, so whatever is laid out from them moves when they arrive.
  // A broken image (its src failed) is not pending: shoppers see that layout as it is.
  const LAZY_SOURCE = /^data-(lazy-?)?(src|srcset|original)$/;
  const pendingImages = [];
  try {
    const imgs = document.images;
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.complete && img.naturalWidth > 0) continue;
      if (img.getClientRects().length === 0) continue;
      let lazy = false;
      for (let k = 0; k < img.attributes.length && !lazy; k++) lazy = LAZY_SOURCE.test(img.attributes[k].name) && img.attributes[k].value.trim() !== '';
      if (img.complete && !lazy && img.getAttribute('src')) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) pendingImages.push(img);
    }
  } catch (e) {}
  // a's place relative to b waits on a pending image in a's own branch (below the nearest
  // ancestor shared with b), inside a or laid out before it.
  const waitsOnImage = (a, b) => {
    let branch = a;
    while (branch.parentElement && !branch.parentElement.contains(b)) branch = branch.parentElement;
    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i];
      if (branch.contains(img) && (a.contains(img) || (img.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING))) return true;
    }
    return false;
  };
  const imagePending = (a, b) => pendingImages.length > 0 && (waitsOnImage(a, b) || waitsOnImage(b, a));
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
  // A subtree that transitions one of the matched properties (re over transition-property) is
  // shown, hidden or slid in by script or hover: its state at this synchronous read is not settled.
  const transitionsBetween = (from, upto, re) => {
    for (let e = from; e && e !== upto && e !== body && e !== doc; e = parentOf(e)) {
      const s = cs(e);
      const props = String(s.transitionProperty || '').split(',');
      const durs = String(s.transitionDuration || '').split(',');
      for (let i = 0; i < props.length; i++) {
        if (re.test(props[i].trim()) && parseFloat(durs[i % durs.length]) > 0) return true;
      }
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
  const bodyStartLeft = body.scrollLeft;
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
  const SLIDE_IN = /^(all|left|right|inset|transform|translate|margin-left|margin-right|opacity|visibility)$/;
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
        // A link whose only content is an image still loading gets its size when it arrives.
        if (pendingImages.some((img) => el.contains(img))) continue;
        push({ kind: 'zero-size', severity: 'warning', selector: getSelector(el), details: 'Rendered actionable control has zero size (' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px)', rect: toRect(r) });
        continue;
      }
      const outsideX = r.right <= 0 || r.left >= vw;
      const outsideY = r.bottom <= 0;
      if (outsideX || outsideY) {
        let parked = Boolean(layerOf(el)) || movingBetween(el, null);
        if (!parked) {
          // Scrolling brings the control in only on an axis it is outside on: a horizontal strip
          // for a control past the side edge, a scrolled list for one above the top. A lone
          // 'overflow-x: hidden' computes overflow-y to 'auto', so one axis says nothing of the other.
          let reachX = !outsideX;
          let reachY = !outsideY;
          const clips = boxClips(el);
          for (let k = 0; k < clips.length; k++) {
            const s = cs(clips[k]);
            if (isScrollAxis(s.overflowX)) reachX = true;
            if (isScrollAxis(s.overflowY)) reachY = true;
          }
          parked = reachX && reachY;
        }
        if (!parked) {
          // An absolutely positioned ancestor parked outside the viewport (dropdown, off-canvas
          // panel) hides the control by design. The control's own absolute offset parks it only
          // past the leading edges (the 'left: -9999px' skip-link idiom): pushed past the right
          // edge it is misplaced, not parked.
          for (let e = el; e && e !== body && !parked; e = e.parentElement) {
            if (cs(e).position === 'absolute') {
              const er = e.getBoundingClientRect();
              if (er.right <= 0 || er.bottom <= 0 || (e !== el && er.left >= vw)) parked = true;
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
        if (cvis) {
          controls.push({ el: el, rect: r, vis: cvis, layer: layerOf(el) });
          continue;
        }
        // Clipped away past the trailing edge of a box it still spans vertically, the control is
        // pushed out of view (misplaced). Cut vertically it is a collapsed panel or menu, inside a
        // sideways scroller it is reachable, and a moving, sliding-in or absolutely parked subtree
        // (carousel, hover reveal, dropdown) is hidden by design: none of those is reported.
        const clips = boxClips(el);
        for (let k = 0; k < clips.length; k++) {
          const a = clips[k];
          const s = cs(a);
          if (isScrollAxis(s.overflowX)) break;
          const b = clipBox(a);
          if (s.overflowY !== 'visible' && span(r.top, r.bottom, b.top, b.bottom) < (r.bottom - r.top) * 0.5) break;
          if (s.overflowX === 'visible' || r.left < b.right) continue;
          let parked = movingBetween(el, a) || transitionsBetween(el, a, SLIDE_IN);
          for (let e = parentOf(el); e && e !== a && !parked; e = parentOf(e)) parked = cs(e).position === 'absolute';
          if (!parked) {
            push({ kind: 'offscreen', severity: 'critical', selector: getSelector(el), details: 'Actionable control is pushed past the right edge of ' + getSelector(a) + ', which clips it out of view (x: ' + Math.round(r.left) + ', y: ' + Math.round(r.top) + ')', rect: toRect(r) });
          }
          break;
        }
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
        if (imagePending(a.p, b.p)) continue;
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
  // An absolutely positioned control laid inside another control's box (wishlist heart on a
  // product image link, badge button on a card) is a designed overlay. Boxes that cross each
  // other's edges are stacked controls whatever their positioning.
  const overlaysInside = (control, other, cr, or) => isAbsoluteOverlayOver(control, other) && span(cr.left, cr.right, or.left, or.right) * span(cr.top, cr.bottom, or.top, or.bottom) >= 0.9 * cr.width * cr.height;
  try {
    const flowControls = controls.filter((c) => !c.layer && !unsettled(c.el));
    flowControls.sort((a, b) => a.rect.top - b.rect.top);
    // Each control's boxes cut to the part that survives its clipping ancestors: a link clipped
    // away at the bottom of a collapsed block cannot be tapped there, so it stacks on nothing.
    const fragments = (c) => {
      const v = c.vis;
      const raw = cs(c.el).display === 'inline' ? c.el.getClientRects() : [c.rect];
      const out = [];
      for (let i = 0; i < raw.length; i++) {
        const left = Math.max(raw[i].left, v.left);
        const right = Math.min(raw[i].right, v.right);
        const top = Math.max(raw[i].top, v.top);
        const bottom = Math.min(raw[i].bottom, v.bottom);
        if (right - left >= 1 && bottom - top >= 1) out.push({ left: left, right: right, top: top, bottom: bottom, width: right - left, height: bottom - top });
      }
      return out;
    };
    for (let i = 0; i < flowControls.length; i++) {
      const A = flowControls[i];
      for (let j = i + 1; j < flowControls.length; j++) {
        const B = flowControls[j];
        if (B.rect.top >= A.rect.bottom) break;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        if (overlaysInside(A.el, B.el, A.rect, B.rect) || overlaysInside(B.el, A.el, B.rect, A.rect)) continue;
        // A carousel's own navigation over its slides is not a stacked pair.
        if (Boolean(A.el.closest(CAROUSEL_SLIDE)) !== Boolean(B.el.closest(CAROUSEL_SLIDE))) continue;
        const fa = fragments(A);
        const fb = fragments(B);
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
        // A quarter of a control lying under another is enough for taps on it to land on the wrong one.
        if (best >= 0.25 && !imagePending(A.el, B.el)) {
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
    // Mirror of topLayer, read at the last scroll offset: a bar anchored to the bottom edge.
    // A bar that transitions its visibility, opacity or position is a show/hide-on-scroll bar:
    // the theme's scroll handler runs after this synchronous read, so its settled state at the
    // end of the page is unknown here and it is never reported from this reading.
    const SHOW_HIDE = /^(all|opacity|visibility|transform|translate|top|bottom|inset|margin-bottom|display)$/;
    const bottomInfo = new Map();
    const bottomLayer = (layer) => {
      let v = bottomInfo.get(layer);
      if (v === undefined) {
        const r = layer.getBoundingClientRect();
        v = r.bottom > vh * 0.75 && r.top < vh && (r.bottom - r.top) <= vh * 0.4 && (r.right - r.left) >= vw * 0.5 && !transitionsBetween(layer, null, SHOW_HIDE);
        bottomInfo.set(layer, v);
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
      // At the end of the page content sits as high as it ever gets, so whatever a bottom bar
      // covers here it covers at every offset (the mirror of a top bar at page load).
      const atEnd = s === steps.length - 1 && (!scroller || Math.abs(got - maxScroll) <= 2);
      if (Math.abs(got - want) > 2) {
        stats.truncated = true;
        stats.truncatedReasons.push('page did not scroll to ' + want + ' (at ' + got + ')');
        break;
      }
      stats.sweepSteps++;
      // Bars that can hide a band of a line here: an opaque top bar at page load, a bottom bar at
      // the end of the page. A third of a line or control under one is unreadable or untappable
      // even while its centre is clear.
      const edgeBars = [];
      if (s === 0 || atEnd) {
        const edgeYs = [];
        if (s === 0) edgeYs.push(1, vh * 0.1, vh * 0.2);
        if (atEnd) edgeYs.push(vh - 1, vh * 0.9, vh * 0.8);
        for (let a = 0; a < edgeYs.length; a++) {
          for (let b = 1; b <= 3; b++) {
            const stack = document.elementsFromPoint((vw * b) / 4, edgeYs[a]);
            for (let k = 0; k < stack.length; k++) {
              const layer = layerOf(stack[k]);
              if (!layer || edgeBars.some((e) => e.layer === layer)) continue;
              if ((s === 0 && topLayer(layer)) || (atEnd && bottomLayer(layer))) edgeBars.push({ layer: layer, r: layer.getBoundingClientRect() });
            }
          }
        }
      }
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
        // One paint-order probe: 'covered' (opaque same-layer box, or an opaque top bar at load /
        // bottom bar at the end of the page), 'deferred' (only a foreign fixed/sticky layer is in
        // the way - retry at another offset), or 'clear'.
        const sample = (cx, y) => {
          // Fast path: the topmost hit is the owner (or its own subtree/ancestor) - nothing paints over it.
          const hit = document.elementFromPoint(cx, y);
          if (!hit || hit === doc || hit === body || hit === tg.owner || tg.owner.contains(hit) || hit.contains(tg.owner)) return { state: 'clear' };
          const stack = document.elementsFromPoint(cx, y);
          let deferredHere = false;
          for (let k = 0; k < stack.length; k++) {
            const e = stack[k];
            if (e === tg.owner || tg.owner.contains(e) || e.contains(tg.owner)) break;
            if (e === doc || e === body) break;
            if (e.closest(PLATFORM_PREVIEW_CHROME) || e.closest('dialog, [role="dialog"], [aria-modal="true"]')) continue;
            if (inSlide && e.closest(CAROUSEL_SLIDE)) continue;
            const eLayer = layerOf(e);
            if (eLayer && eLayer !== tg.layer) {
              if (s === 0 && !tg.fixed && topLayer(eLayer) && isOpaque(e)) return { state: 'covered', by: e, sticky: 'at page load' };
              if (atEnd && !tg.fixed && bottomLayer(eLayer) && isOpaque(e)) return { state: 'covered', by: e, sticky: 'at the end of the page' };
              deferredHere = true;
              continue;
            }
            if (isOpaque(e)) return { state: 'covered', by: e, sticky: null };
          }
          return { state: deferredHere ? 'deferred' : 'clear' };
        };
        const xAt = (f) => Math.min(vw - 1, Math.max(0, tg.vis.left + (tg.vis.right - tg.vis.left) * f));
        const ys = [cy];
        for (let b = 0; b < edgeBars.length && !tg.fixed; b++) {
          const bar = edgeBars[b].r;
          const lo = Math.max(top, bar.top);
          const hi = Math.min(bottom, bar.bottom);
          if (hi - lo >= (bottom - top) / 3 && span(tg.vis.left, tg.vis.right, bar.left, bar.right) > 0 && (cy < lo || cy >= hi)) ys.push((lo + hi) / 2);
        }
        let first = { state: 'clear' };
        let at = cy;
        for (let k = 0; k < ys.length; k++) {
          const probe = sample(xAt(0.5), ys[k]);
          if (probe.state === 'covered') { first = probe; at = ys[k]; break; }
          if (probe.state === 'deferred') first = probe;
        }
        if (first.state === 'clear') { done.add(t); continue; }
        if (first.state === 'deferred') continue;
        let covered = 1;
        const second = sample(xAt(0.2), at);
        if (second.state === 'covered') covered++;
        else if (sample(xAt(0.8), at).state === 'covered') covered++;
        if (covered < 2) {
          if (second.state !== 'deferred') done.add(t);
          continue;
        }
        done.add(t);
        if (!first.sticky && imagePending(tg.owner, first.by)) continue;
        if (!reportedOwners.has(tg.owner)) {
          reportedOwners.add(tg.owner);
          const kind = first.sticky ? 'sticky-obstruction' : 'occlusion';
          push({ kind: kind, severity: 'critical', selector: getSelector(tg.owner), details: tg.label + ' is covered by ' + getSelector(first.by) + (first.sticky ? ' (fixed/sticky bar ' + first.sticky + ')' : '') + ' at page y=' + Math.round(at + (tg.fixed ? 0 : got)), rect: toRect({ left: tg.vis.left, top: tg.vis.top, right: tg.vis.right, bottom: tg.vis.bottom }) });
        }
      }
    }
  } catch (err) {
    detectorFailed('occlusion', err);
  } finally {
    if (scroller === 'body') body.scrollTo({ top: bodyStartTop, left: bodyStartLeft, behavior: 'instant' });
    window.scrollTo({ top: startY, left: startX, behavior: 'instant' });
  }

  mark('coverSweep');
  // ---- 8. layout-shift witness (buffered entries, read synchronously) ---------------------------
  try {
    let clsScore = 0;
    // One shift that carries visible content a quarter of the viewport or more is a jump the reader
    // sees, even on a tall viewport where the score stays small. A shift animated by a transition
    // arrives as one small entry per frame, so the jump is each source's net travel across a burst
    // (entries under a second apart), from its first previous box to its latest current box.
    let maxJump = 0;
    const travel = new Map();
    if (typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver(() => {});
      observer.observe({ type: 'layout-shift', buffered: true });
      const records = observer.takeRecords();
      observer.disconnect();
      for (let i = 0; i < records.length; i++) {
        const entry = records[i];
        if (!entry || entry.hadRecentInput || typeof entry.value !== 'number') continue;
        clsScore += entry.value;
        const sources = entry.sources || [];
        for (let k = 0; k < sources.length; k++) {
          const a = sources[k].previousRect;
          const b = sources[k].currentRect;
          if (!a || !b || a.width * a.height <= 0 || b.width * b.height <= 0) continue;
          const node = sources[k].node;
          let leg = node ? travel.get(node) : undefined;
          if (leg && entry.startTime - leg.last <= 1000) {
            leg.last = entry.startTime;
          } else {
            leg = { from: a, last: entry.startTime };
            if (node) travel.set(node, leg);
          }
          maxJump = Math.max(maxJump, Math.abs(b.top - leg.from.top), Math.abs(b.left - leg.from.left));
        }
      }
    }
    stats.cls = Math.round(clsScore * 1000) / 1000;
    if (clsScore > 0.1) {
      push({ kind: 'layout-shift', severity: 'warning', selector: 'document', details: 'Cumulative layout shift score ' + clsScore.toFixed(3) + ' exceeds 0.1', rect: { x: 0, y: 0, w: Math.round(vw), h: Math.round(vh) } });
    } else if (maxJump >= vh * 0.25) {
      push({ kind: 'layout-shift', severity: 'warning', selector: 'document', details: 'Visible content jumped ' + Math.round(maxJump) + 'px in one burst of layout shifts (score ' + clsScore.toFixed(3) + ')', rect: { x: 0, y: 0, w: Math.round(vw), h: Math.round(vh) } });
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
})()`;

export class LayoutIntegrityEngine {
  /**
   * Standard device presets for multi-breakpoint testing
   */
  public static readonly BREAKPOINTS = [
    { name: 'mobile' as const, width: 393, height: 852, label: 'iPhone 16 (Mobile)' },
    { name: 'tablet' as const, width: 820, height: 1180, label: 'iPad Air (Tablet)' },
    { name: 'desktop' as const, width: 1440, height: 900, label: 'Standard Laptop (Desktop)' },
  ];

  /**
   * Browser injection script that checks visual layout integrity once, synchronously, on the
   * active viewport. Detectors, in script order:
   * 1. controls: zero-size (warning) and offscreen (critical)
   * 2. text runs (collected once and shared by the text detectors)
   * 3. clipped text: a line box sliced or cut by a clipping ancestor
   * 4. text painted over text
   * 5. actionable controls stacked on each other
   * 6. in-flow sibling boxes overlapping (warning only)
   * 7. covered text / covered controls, swept over the full page (occlusion, sticky-obstruction)
   * 8. layout-shift witness (buffered entries, read synchronously; warning)
   *
   * A truncated scan (element, text-run or sweep cap reached, or a page that would not scroll)
   * is reported in `stats.truncated` / `stats.truncatedReasons`; a detector that throws is
   * listed in `stats.failedDetectors`.
   */
  public static getBrowserScanScript(viewportName: string = 'active'): string {
    return LAYOUT_INTEGRITY_SCAN.replace("'__VIEWPORT_NAME__'", () => JSON.stringify(viewportName));
  }

  /**
   * Marker reader for every consumer of the payload. Only an explicit
   * `measured: false` declares the surface unmeasurable, so a payload that
   * predates the marker is never mistaken for an unmeasured one.
   */
  public static readUnmeasuredReason(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return undefined;
    }
    const obj = payload as Record<string, unknown>;
    if (obj.measured !== false) {
      return undefined;
    }
    return typeof obj.unmeasuredReason === 'string' && obj.unmeasuredReason.trim().length > 0
      ? obj.unmeasuredReason
      : 'the scanned tab reported no measurable CSS viewport';
  }
}
