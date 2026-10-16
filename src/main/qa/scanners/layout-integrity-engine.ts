export interface LayoutIntegrityFinding {
  kind: 'overlap' | 'clipping' | 'occlusion' | 'offscreen' | 'zero-size' | 'sticky-obstruction' | 'layout-shift' | 'spacing';
  ruleId?: string; // present on 'spacing' findings: which clearance rule fired
  severity: 'critical' | 'warning';
  selector: string; // best-effort CSS path, capped 200 chars
  relatedSelector?: string; // optional peer selector for sibling-gap findings
  actualPx?: number; // optional measured distance/width in CSS px
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
  spacingMeasured?: number; // text runs and controls the edge-clearance rules actually evaluated
  spacingFlagged?: number; // edge-clearance findings before the per-kind cap
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

export interface LayoutIntegrityScanOptions {
  /** Omit the layout-shift witness (a scan taken after an emulated resize). */
  skipLayoutShift?: boolean;
}

// In-page scan, synchronous. String.raw keeps every character as written: the script must
// never contain a backtick or a dollar-brace. '__VIEWPORT_NAME__' and '__SKIP_LAYOUT_SHIFT__' are
// substituted per call.
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
  // Responsive sweeps read geometry at every width; resizing leaves layout-shift entries of its own
  // in the buffer, so the witness only runs on the one scan taken at the page's own width.
  const SKIP_LAYOUT_SHIFT = '__SKIP_LAYOUT_SHIFT__' === 'true';
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
      const capKey = f.ruleId ? f.kind + ':' + f.ruleId : f.kind;
      warningCount[capKey] = (warningCount[capKey] || 0) + 1;
      if (warningCount[capKey] > WARNING_CAP_PER_KIND) return;
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
  // sr-only / visually-hidden / 1px-clip patterns (screen-reader accessibility elements)
  const isSrOnly = memo(false, (el) => {
    if (!el || el === doc || el === body) return false;
    if (el.closest && el.closest('.sr-only, .visually-hidden, .screen-reader-text, .visuallyhidden, [class*="sr-only"], [class*="visually-hidden"]')) return true;
    const s = cs(el);
    const w = parseFloat(s.width);
    const h = parseFloat(s.height);
    if (w > 0 && w <= 1 && h > 0 && h <= 1 && (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden')) {
      return true;
    }
    return isSrOnly(parentOf(el));
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
  const GEOM_KEYFRAME = /^(transform|translate|rotate|scale|offset|left|right|top|bottom|inset|width|height|margin|padding|opacity|clip|visibility)/i;
  const animatesGeometry = (a) => {
    try {
      if (!a.effect || typeof a.effect.getKeyframes !== 'function') return true;
      const kfs = a.effect.getKeyframes();
      for (let k = 0; k < kfs.length; k++) {
        const keys = Object.keys(kfs[k]);
        for (let j = 0; j < keys.length; j++) {
          if (GEOM_KEYFRAME.test(keys[j])) return true;
        }
      }
      return false;
    } catch (e) {
      return true;
    }
  };
  const animTargets = new Set();
  try {
    const anims = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
    for (let i = 0; i < anims.length; i++) {
      const a = anims[i];
      if (a.playState === 'running' && a.effect && a.effect.target && animatesGeometry(a)) animTargets.add(a.effect.target);
    }
  } catch (e) {}
  const animating = memo(false, (el) => ((el !== body && el !== doc) && animTargets.has(el)) || animating(parentOf(el)));
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
  // The painted extent of a single-line text field's value: the browser draws it inside the
  // field's own box, centred in the content box, so no text node or line rect describes it.
  const TEXT_FIELD = /^(text|email|search|tel|url|number)$/;
  let measureCtx = null;
  const fieldValueRect = (field) => {
    if (field.tagName !== 'INPUT' || !TEXT_FIELD.test(field.type) || !field.value || !field.value.trim() || !inked(field)) return null;
    const s = cs(field);
    const fr = field.getBoundingClientRect();
    const left = fr.left + field.clientLeft + (parseFloat(s.paddingLeft) || 0);
    const right = fr.left + field.clientLeft + field.clientWidth - (parseFloat(s.paddingRight) || 0);
    if (right - left < 1) return null;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return null;
    measureCtx.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    const w = Math.min(right - left, measureCtx.measureText(field.value).width);
    const start = s.textAlign === 'right' || s.textAlign === 'end' ? right - w : s.textAlign === 'center' ? left + (right - left - w) / 2 : left;
    const contentTop = fr.top + field.clientTop + (parseFloat(s.paddingTop) || 0);
    const contentH = field.clientHeight - (parseFloat(s.paddingTop) || 0) - (parseFloat(s.paddingBottom) || 0);
    const lineH = Math.min((parseFloat(s.fontSize) || 16) * 1.2, contentH > 0 ? contentH : field.clientHeight);
    const top = (contentH > 0 ? contentTop + contentH / 2 : fr.top + field.clientTop + field.clientHeight / 2) - lineH / 2;
    return { left: start, right: start + w, top: top, bottom: top + lineH };
  };
  const isScrollAxis = (v) => v === 'auto' || v === 'scroll';
  const isHiddenAxis = (v) => v === 'hidden' || v === 'clip';
  const movingBetween = (from, upto) => {
    for (let e = from; e && e !== upto && e !== body && e !== doc; e = e.parentElement) {
      const s = cs(e);
      const infAnim = Boolean(s.animationName && s.animationName !== 'none' && s.animationPlayState !== 'paused' && String(s.animationIterationCount).indexOf('infinite') !== -1);
      if (infAnim || animTargets.has(e) || e.matches(CAROUSEL_SLIDE) || e.tagName === 'MARQUEE') return true;
      if (hasRealTransform(s) && transitionsBetween(e, e.parentElement, /^(all|transform|translate|left|right|top|bottom|inset|margin|opacity|visibility)$/i)) return true;
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
  // A title box (a heading, or a box inside one) capped to a fixed height and repeated across the
  // page is the product-grid title clamp: the whole lines it drops below its own edge are cut on
  // purpose. A one-off title (the product page's own name) cut the same way loses words the reader
  // has nowhere else to read. A container that cuts a title inside it is not a title box, and a
  // line sliced mid-way is reported separately.
  const TITLE_BOX = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const repeatMemo = new Map();
  const isRepeated = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    const sel = el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
    let n = repeatMemo.get(sel);
    if (n === undefined) {
      try { n = Array.prototype.filter.call(document.querySelectorAll(sel), painted).length; } catch (e) { n = 0; }
      repeatMemo.set(sel, n);
    }
    return n >= 2;
  };
  const isTitleBox = (a) => Boolean(a.closest && a.closest(TITLE_BOX)) && isRepeated(a);
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
  const isDisclosure = (el) => {
    if (el.hasAttribute('aria-expanded')) return true;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
    return label.length <= 40 && DISCLOSURE_TEXT.test(label);
  };
  let controlledIds = null;
  const hasDisclosureControl = memo(false, (a) => {
    if (a.id) {
      if (!controlledIds) {
        controlledIds = new Set();
        const owners = document.querySelectorAll('[aria-controls]');
        for (let i = 0; i < owners.length; i++) owners[i].getAttribute('aria-controls').split(/ +/).forEach((id) => controlledIds.add(id));
      }
      if (controlledIds.has(a.id)) return true;
    }
    const ownInner = a.querySelectorAll(ACTIONABLE);
    for (let i = 0; i < ownInner.length && i < 8; i++) if (isDisclosure(ownInner[i])) return true;
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
  const collapsedByDesign = memo(false, (a) => a.scrollHeight > a.clientHeight + 1 && hasDisclosureControl(a));
  const isCollapsedCurtain = (owner, textOrControlEl) => {
    if (!owner || !textOrControlEl || owner === body || owner === doc) return false;
    for (let p = owner.parentElement; p && p !== body && p !== doc; p = p.parentElement) {
      const ps = cs(p);
      const isReadMoreBox = collapsedByDesign(p) || (isHiddenAxis(ps.overflowY) && ps.maxHeight && ps.maxHeight !== 'none' && hasDisclosureControl(p));
      if (isReadMoreBox && p.contains(textOrControlEl)) {
        for (let cur = owner; cur && cur !== p; cur = cur.parentElement) {
          const pos = cs(cur).position;
          if (pos === 'absolute' || pos === 'sticky') return true;
        }
      }
    }
    return false;
  };

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
      if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]') || isSrOnly(el)) continue;
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
        // A control pushed past the trailing edge of a clipping box it still spans vertically, so
        // that less than half of it is left in view, is misplaced. Cut vertically it is a collapsed
        // panel or menu, inside a sideways scroller it is reachable, an ellipsis cuts it on purpose,
        // and a moving, sliding-in or absolutely parked subtree (carousel, hover reveal, dropdown) is
        // hidden by design: none of those is reported.
        const clips = boxClips(el);
        for (let k = 0; k < clips.length; k++) {
          const a = clips[k];
          const s = cs(a);
          if (isScrollAxis(s.overflowX)) break;
          const b = clipBox(a);
          if (s.overflowY !== 'visible' && span(r.top, r.bottom, b.top, b.bottom) < (r.bottom - r.top) * 0.5) break;
          if (s.overflowX === 'visible' || r.right <= b.right || b.right - Math.max(r.left, b.left) >= (r.right - r.left) * 0.5) continue;
          let parked = movingBetween(el, a) || transitionsBetween(el, a, SLIDE_IN) || intendedTruncation(el, a);
          for (let e = parentOf(el); e && e !== a && !parked; e = parentOf(e)) parked = cs(e).position === 'absolute';
          if (!parked) {
            const shown = Math.max(0, b.right - Math.max(r.left, b.left));
            push({ kind: 'offscreen', severity: 'critical', selector: getSelector(el), details: 'Actionable control is pushed past the right edge of ' + getSelector(a) + ', which clips it (' + Math.round(shown) + ' of ' + Math.round(r.width) + 'px in view, x: ' + Math.round(r.left) + ', y: ' + Math.round(r.top) + ')', rect: toRect(r) });
          }
          break;
        }
        // A control clipped away by an ancestor is hidden, not covered: it cannot stack or be occluded.
        const cvis = clippedRect(el, r);
        if (cvis && !isSrOnly(el)) controls.push({ el: el, rect: r, vis: cvis, layer: layerOf(el) });
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
      if (!painted(p) || !inked(p) || clipPathed(p) || isSrOnly(p)) continue;
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
    detectorFailed('text-runs', err);
  }

  mark('runs');
  // ---- 3a. edge clearance (warning only) ------------------------------------------------------
  // Text and controls pressed against the edge that bounds them: the viewport, an open dialog, or
  // the padding box of a clipping ancestor. Left and right edges only: the page is read at scroll
  // offset 0, so a vertical gap to the viewport says nothing, and a clamped title or a one-line pill
  // fills its box top to bottom by design. Text is measured on the edge its alignment starts from
  // (centred and justified lines are not) against the viewport, an open dialog or a clipping box.
  // Controls are measured against the viewport and an open dialog only: a link that fills the
  // clipping box around it (a clamped title, a chip row) is that box sizing to its link. A gap of 0
  // against a clipping box is the box being as wide as its own text, and a control flush with its
  // bound is a full-bleed bar, so both start counting at half a pixel. Findings are warnings: the
  // thresholds are not calibrated against enough storefronts to fail a verdict.
  try {
    const DIALOG = 'dialog, [role="dialog"], [aria-modal="true"]';
    const CLOSE_LABEL = /^(x|\u00d7|\u2715|\u2716|close|dismiss|đóng|thoát|bỏ qua)$/i;
    const CLOSE_CLASS = /(^|[\s_-])close($|[\s_-])/i;
    const T_TEXT = vw <= 480 ? 3 : 2;
    const T_CONTROL = 3;
    const viewportRight = Math.min(vw, doc.clientWidth);
    const edgeMemo = new Map();
    // The box that bounds el along x: the nearest clipping ancestor, the dialog when it is nearer,
    // else the viewport. null when that ancestor scrolls sideways (its edge moves with the scroll).
    const edgeBoxOf = (el, ownClip) => {
      let hit = edgeMemo.get(el);
      if (hit !== undefined) return hit;
      let clip = null;
      const clips = ownClip ? contentClips(el) : boxClips(el);
      for (let k = 0; k < clips.length; k++) {
        const a = clips[k];
        if (a === body || a === doc || cs(a).overflowX === 'visible') continue;
        clip = a;
        break;
      }
      const dlg = el.closest(DIALOG);
      if (dlg && (!clip || clip.contains(dlg))) {
        const b = clipBox(dlg);
        hit = { left: b.left, right: b.right, kind: 'dialog', by: dlg };
      } else if (clip) {
        if (clip.scrollWidth > clip.clientWidth + 1 && isScrollAxis(cs(clip).overflowX)) {
          hit = null;
        } else {
          const b = clipBox(clip);
          hit = { left: b.left, right: b.right, kind: 'box', by: clip };
        }
      } else {
        hit = { left: 0, right: viewportRight, kind: 'viewport', by: null };
      }
      edgeMemo.set(el, hit);
      return hit;
    };
    const closeControl = (el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      return CLOSE_LABEL.test(label) || el.matches('[data-dismiss], [data-bs-dismiss]') || CLOSE_CLASS.test(typeof el.className === 'string' ? el.className : '');
    };
    let measured = 0;
    let flagged = 0;
    const flagEdge = (el, ruleId, subject, side, gap, min, box, r) => {
      flagged++;
      push({
        kind: 'spacing',
        severity: 'warning',
        ruleId: ruleId,
        selector: getSelector(el),
        details: subject + ' sits ' + (Math.round(gap * 10) / 10) + 'px from the ' + side + ' edge of ' + (box.kind === 'viewport' ? 'the viewport' : getSelector(box.by)) + ' (' + ruleId + ', minimum ' + min + 'px)',
        rect: toRect(r)
      });
    };
    const flaggedOwners = new Set();
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const p = run.p;
      if (flaggedOwners.has(p)) continue;
      const r = run.r;
      if (r.right <= 0 || r.left >= vw) continue;
      const ps = cs(p);
      const rtl = ps.direction === 'rtl';
      let side = null;
      if (ps.textAlign === 'left') side = 'left';
      else if (ps.textAlign === 'right') side = 'right';
      else if (ps.textAlign === 'start') side = rtl ? 'right' : 'left';
      else if (ps.textAlign === 'end') side = rtl ? 'left' : 'right';
      if (!side) continue;
      if (unsettled(p) || movingBetween(p, null) || p.closest(CAROUSEL_SLIDE) || alphaOf(p) < 0.3) continue;
      const box = edgeBoxOf(p, true);
      if (!box) continue;
      measured++;
      const gap = side === 'left' ? r.left - box.left : box.right - r.right;
      if (gap < (box.kind === 'box' ? 0.5 : 0) || gap >= T_TEXT) continue;
      flaggedOwners.add(p);
      flagEdge(p, 'edge-text', 'Text "' + snippet(run.n.nodeValue) + '"', side, gap, T_TEXT, box, r);
    }
    for (let i = 0; i < controls.length; i++) {
      const c = controls[i];
      const el = c.el;
      const r = c.rect;
      if (r.right <= 0 || r.left >= vw) continue;
      if (unsettled(el) || movingBetween(el, null) || el.closest(CAROUSEL_SLIDE) || alphaOf(el) < 0.3 || closeControl(el)) continue;
      const box = edgeBoxOf(el, false);
      if (!box || box.kind === 'box') continue;
      measured++;
      const gapLeft = r.left - box.left;
      const gapRight = box.right - r.right;
      const tightLeft = gapLeft >= 0.5 && gapLeft < T_CONTROL;
      const tightRight = gapRight >= 0.5 && gapRight < T_CONTROL;
      if (!tightLeft && !tightRight) continue;
      const side = tightLeft && (!tightRight || gapLeft <= gapRight) ? 'left' : 'right';
      flagEdge(el, 'edge-control', 'Control "' + snippet(el.getAttribute('aria-label') || el.textContent || el.tagName.toLowerCase()) + '"', side, side === 'left' ? gapLeft : gapRight, T_CONTROL, box, r);
    }
    // ---- 3b. sibling-gap & wrap-quality (warning only, ruleId-isolated) -------------------------
    const firstTextRect = (el, pickBottom) => {
      let best = null;
      for (let rIdx = 0; rIdx < runs.length; rIdx++) {
        const rn = runs[rIdx];
        if (!el.contains(rn.p)) continue;
        if (!best || (pickBottom ? rn.r.bottom > best.bottom : rn.r.top < best.top)) best = rn.r;
      }
      return best;
    };
    const META_HEADING_HINT = /title|name|heading|meta|sku|code|brand|vendor|price|status|stock|rating|review|badge|tag/i;
    const seenGapPairs = new Set();
    for (let i = 0; i < elementLimit; i++) {
      const parent = allElements[i];
      if (parent.children.length < 2 || parent.closest('svg, head, nav, table, ul, ol, dl') || parent.closest(CAROUSEL_SLIDE)) continue;
      const ps = cs(parent);
      if (ps.display === 'none' || ps.display === 'contents' || !painted(parent)) continue;
      const ch = parent.children;
      for (let a = 0; a < ch.length - 1; a++) {
        const elA = ch[a];
        const elB = ch[a + 1];
        const sA = cs(elA);
        const sB = cs(elB);
        if ((sA.position !== 'static' && sA.position !== 'relative') || (sB.position !== 'static' && sB.position !== 'relative')) continue;
        if (!painted(elA) || !painted(elB) || isSrOnly(elA) || isSrOnly(elB)) continue;
        const rA = elA.getBoundingClientRect();
        const rB = elB.getBoundingClientRect();
        if (rA.width < 16 || rA.height < 10 || rB.width < 16 || rB.height < 10) continue;
        if (rA.bottom <= 0 || rB.top >= vh || rA.right <= 0 || rB.left >= vw) continue;
        const xOverlap = span(rA.left, rA.right, rB.left, rB.right);
        if (xOverlap < Math.min(rA.width, rB.width) * 0.5) continue;
        const isHeadingPair = Boolean(elA.matches(TITLE_BOX) || elB.matches(TITLE_BOX) || elA.querySelector(TITLE_BOX) || elB.querySelector(TITLE_BOX));
        const hintStr = String(elA.className || '') + ' ' + String(elB.className || '');
        if (!isHeadingPair && !META_HEADING_HINT.test(hintStr)) continue;
        const padBetween = (parseFloat(sA.paddingBottom) || 0) + (parseFloat(sB.paddingTop) || 0);
        const borderBetween = (parseFloat(sA.borderBottomWidth) || 0) + (parseFloat(sB.borderTopWidth) || 0);
        if (padBetween >= 2 || borderBetween >= 1) continue;
        if (alphaOfColor(sA.backgroundColor) >= 0.1 || alphaOfColor(sB.backgroundColor) >= 0.1) continue;
        const boxGapY = rB.top - rA.bottom;
        if (boxGapY < -2 || boxGapY > 2) continue;
        const tA = firstTextRect(elA, true);
        const tB = firstTextRect(elB, false);
        if (!tA || !tB) continue;
        const inkGapY = tB.top - tA.bottom;
        measured++;
        if (inkGapY >= -6 && inkGapY < 2) {
          const selA = getSelector(elA);
          const selB = getSelector(elB);
          const key = selA + '|' + selB;
          if (!seenGapPairs.has(key)) {
            seenGapPairs.add(key);
            flagged++;
            const gapVal = Math.max(0, Math.round(boxGapY * 10) / 10);
            push({
              kind: 'spacing',
              ruleId: 'sibling-gap',
              severity: 'warning',
              selector: selB,
              relatedSelector: selA,
              actualPx: gapVal,
              details: 'Sibling blocks ' + selA + ' and ' + selB + ' have ' + gapVal + 'px vertical box gap (' + Math.round(inkGapY * 10) / 10 + 'px glyph clearance)',
              rect: toRect(rB),
            });
          }
        }
      }
    }
    const runsByOwner = new Map();
    for (let i = 0; i < runs.length; i++) {
      const rn = runs[i];
      let arr = runsByOwner.get(rn.p);
      if (!arr) { arr = []; runsByOwner.set(rn.p, arr); }
      arr.push(rn);
    }
    runsByOwner.forEach((ownerRuns, owner) => {
      if (owner.closest('svg, head, code, pre') || isSrOnly(owner) || unsettled(owner)) return;
      const os = cs(owner);
      if (os.whiteSpace === 'nowrap' || os.whiteSpace === 'pre' || intendedTruncation(owner, owner.parentElement)) return;
      const text = (owner.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 36 || ownerRuns.length < 2) return;
      const or = owner.getBoundingClientRect();
      if (or.bottom <= 0 || or.top >= vh || or.right <= 0 || or.left >= vw) return;
      const fs = parseFloat(os.fontSize) || 14;
      const parent = owner.parentElement;
      const pDisp = parent ? cs(parent).display : '';
      const inFlexOrGrid = pDisp.indexOf('flex') !== -1 || pDisp.indexOf('grid') !== -1 || os.display === 'inline-block' || os.display === 'inline-flex';
      if (!inFlexOrGrid) return;
      measured++;
      const narrowSqueeze = ownerRuns.length >= 3 && or.width > 0 && or.width < fs * 3.4;
      const lastR = ownerRuns[ownerRuns.length - 1].r;
      const firstR = ownerRuns[0].r;
      const lastWords = snippet(ownerRuns[ownerRuns.length - 1].n.nodeValue);
      const pWidth = parent ? parent.clientWidth : 0;
      const orphanInRow = ownerRuns.length >= 2 && text.length <= 26 && pWidth > or.width * 1.8 && or.width < fs * 5.2 && (lastR.right - lastR.left) < (firstR.right - firstR.left) * 0.38 && (lastR.right - lastR.left) < fs * 2.2;
      if (narrowSqueeze || orphanInRow) {
        flagged++;
        const wPx = Math.round(or.width);
        push({
          kind: 'spacing',
          ruleId: 'wrap-quality',
          severity: 'warning',
          selector: getSelector(owner),
          actualPx: wPx,
          details: 'Text "' + snippet(text) + '" in ' + getSelector(owner) + ' wraps into ' + ownerRuns.length + ' cramped lines inside ' + wPx + 'px width (tail: "' + lastWords + '")',
          rect: toRect(or),
        });
      }
    });
    stats.spacingMeasured = measured;
    stats.spacingFlagged = flagged;
  } catch (err) {
    detectorFailed('spacing', err);
  }
  mark('spacing');
  // ---- 3. clipped text (line box sliced or cut by a clipping ancestor) -----------------------
  const clippedOwners = new Set();
  // owner element -> { visible: bool, below: clip that pushed a whole line past its bottom edge,
  // belowRun: first such line, belowLines: how many }
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
          if (hy && r.top >= b.bottom - r.height * 0.15 - 1 && !movingBetween(p, a) && !in3d(p) && !intendedTruncation(p, a) && !collapsedByDesign(a) && !isTitleBox(a)) run.below = a;
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
      const fate = ownerFate.get(p) || { visible: false, below: null, belowRun: null, belowLines: 0 };
      ownerFate.set(p, fate);
      if (hidden) {
        if (run.below && (!fate.below || fate.below === run.below)) {
          fate.below = run.below;
          if (!fate.belowRun) fate.belowRun = run;
          fate.belowLines++;
        }
        continue;
      }
      fate.visible = true;
      run.vis = vis;
      if (defect && !clippedOwners.has(p) && !isSrOnly(p)) {
        clippedOwners.add(p);
        push({ kind: 'clipping', severity: 'critical', selector: getSelector(p), details: 'Text "' + snippet(run.n.nodeValue) + '" ' + defect.detail + (defect.by ? ' by ' + getSelector(defect.by) : ''), rect: toRect(r) });
      }
    } catch (err) {
      detectorFailed('clipping', err);
      break;
    }
  }
  // Text pushed below the bottom edge of a fixed-size box that still shows other text: the box is
  // too short for its content, whether it hides whole elements or the last lines of one it shows
  // (a collapsed box shows nothing and is skipped).
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
      if (!fate.below || clippedOwners.has(p) || isSrOnly(p)) return;
      if (!shows(fate.below)) return;
      const n = (reportedBoxes.get(fate.below) || 0) + 1;
      reportedBoxes.set(fate.below, n);
      if (n > 1) return;
      clippedOwners.add(p);
      const lost = fate.visible
        ? 'loses ' + fate.belowLines + ' line' + (fate.belowLines > 1 ? 's' : '') + ' below the bottom edge of ' + getSelector(fate.below)
        : 'is entirely hidden below the bottom edge of ' + getSelector(fate.below);
      push({ kind: 'clipping', severity: 'critical', selector: getSelector(p), details: 'Text "' + snippet(fate.belowRun.n.nodeValue) + '" ' + lost + ', which is too short for its content', rect: toRect(fate.belowRun.r) });
    });
    // Whether the element's strip beyond clipping box b holds text or content. A box that only
    // bleeds padding or empty area there (a grid row with negative gutters) hides nothing.
    const clipsContent = (el, b) => {
      const beyond = (r, min) => r.right - b.right >= min || b.left - r.left >= min;
      for (let t = 0; t < runs.length; t++) {
        if (el.contains(runs[t].p) && beyond(runs[t].r, 2)) return true;
      }
      const content = el.querySelectorAll('img, picture, video, canvas, svg, iframe, input, button, select, textarea');
      for (let m = 0; m < content.length && m < 200; m++) {
        const node = content[m];
        if (node.parentElement && node.parentElement.closest('svg')) continue;
        const nr = node.getBoundingClientRect();
        if (nr.width >= 4 && nr.height >= 4 && painted(node) && beyond(nr, 4)) return true;
      }
      return false;
    };
    const checkInnerClippedInOverflowAncestor = () => {
      const CAROUSEL_OR_SLIDER_RE = /swiper|carousel|slider|splide|flickity|glide|owl|marquee|ticker/i;
      for (let i = 0; i < elementLimit; i++) {
        const el = allElements[i];
        if (!el || el === doc || el === body || el.closest('svg, head, script, style, noscript, template') || el.closest(PLATFORM_PREVIEW_CHROME)) continue;
        if (clippedOwners.has(el) || isSrOnly(el) || unsettled(el) || !painted(el)) continue;
        if (el.closest(CAROUSEL_SLIDE) || CAROUSEL_OR_SLIDER_RE.test(String(el.className || ''))) continue;
        const s = cs(el);
        if (s.position === 'absolute' || s.position === 'fixed' || s.display === 'inline' || s.display === 'contents') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const clips = boxClips(el);
        for (let k = 0; k < clips.length; k++) {
          const a = clips[k];
          const as = cs(a);
          const ancOvX = as.overflowX;
          if (isScrollAxis(ancOvX)) break;
          if (ancOvX !== 'hidden' && ancOvX !== 'clip') continue;
          if (CAROUSEL_OR_SLIDER_RE.test(String(a.className || '')) || collapsedByDesign(a)) break;
          const b = clipBox(a);
          if (as.overflowY !== 'visible' && span(r.top, r.bottom, b.top, b.bottom) < Math.min(r.height, b.bottom - b.top) * 0.5) break;
          const overRight = r.right - b.right;
          const overLeft = b.left - r.left;
          const overPx = Math.max(overRight, overLeft);
          if (overPx < 4) continue;
          if (movingBetween(el, a) || transitionsBetween(el, a, SLIDE_IN) || intendedTruncation(el, a)) break;
          let absBetween = false;
          for (let p = parentOf(el); p && p !== a; p = parentOf(p)) {
            const pos = cs(p).position;
            if (pos === 'absolute' || pos === 'fixed') { absBetween = true; break; }
          }
          if (absBetween) break;
          let childAlsoOverflows = false;
          for (let c = 0; c < el.children.length; c++) {
            const ch = el.children[c];
            if (!painted(ch)) continue;
            const cr = ch.getBoundingClientRect();
            if (cr.width >= 8 && cr.height >= 8 && (cr.right - b.right >= 4 || b.left - cr.left >= 4)) {
              childAlsoOverflows = true;
              break;
            }
          }
          if (childAlsoOverflows) break;
          if (!clipsContent(el, b)) continue;
          let alreadyCovered = false;
          clippedOwners.forEach((owner) => {
            if (el.contains(owner) || owner.contains(el)) alreadyCovered = true;
          });
          if (alreadyCovered) break;
          clippedOwners.add(el);
          push({
            kind: 'clipping',
            severity: 'critical',
            selector: getSelector(el),
            details: 'Element ' + getSelector(el) + ' overflows and is clipped horizontally by ' + getSelector(a) + ' (' + Math.round(overPx) + 'px clipped)',
            rect: toRect(r)
          });
          break;
        }
      }
    };
    checkInnerClippedInOverflowAncestor();
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
    // A text field's value is text the reader needs too: a label or caption laid on it hides what
    // the field holds.
    for (let i = 0; i < controls.length; i++) {
      const c = controls[i];
      if (!c.vis || unsettled(c.el)) continue;
      const v = fieldValueRect(c.el);
      if (!v) continue;
      const vis = { left: Math.max(v.left, c.vis.left), top: Math.max(v.top, c.vis.top), right: Math.min(v.right, c.vis.right), bottom: Math.min(v.bottom, c.vis.bottom) };
      if (vis.right - vis.left < 2 || vis.bottom - vis.top < 4) continue;
      live.push({ n: { nodeValue: c.el.value }, p: c.el, vis: vis, layer: layerOf(c.el) });
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
        if (imagePending(a.p, b.p) || isSrOnly(a.p) || isSrOnly(b.p) || isCollapsedCurtain(a.p, b.p) || isCollapsedCurtain(b.p, a.p)) continue;
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
  // product image link, badge button on a card) is a designed overlay, unless it lies on the
  // text a field shows (a submit button over the typed address). Boxes that cross each other's
  // edges are stacked controls whatever their positioning.
  const coversValue = (cr, field) => {
    const v = fieldValueRect(field);
    return Boolean(v) && span(cr.left, cr.right, v.left, v.right) >= 8 && span(cr.top, cr.bottom, v.top, v.bottom) >= 8;
  };
  const overlaysInside = (control, other, cr, or) => isAbsoluteOverlayOver(control, other) && span(cr.left, cr.right, or.left, or.right) * span(cr.top, cr.bottom, or.top, or.bottom) >= 0.9 * cr.width * cr.height && !coversValue(cr, other);
  try {
    const flowControls = controls.filter((c) => !c.layer && !unsettled(c.el) && !isSrOnly(c.el));
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
        if (overlaysInside(A.el, B.el, A.rect, B.rect) || overlaysInside(B.el, A.el, B.rect, A.rect) || isCollapsedCurtain(A.el, B.el) || isCollapsedCurtain(B.el, A.el)) continue;
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
        if (hasRealTransform(s) || !painted(k) || isSrOnly(k)) continue;
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
    const stride = Math.max(1, Math.floor(vh * 0.8));
    if (scroller) {
      for (let y = stride; y < maxScroll + stride; y += stride) steps.push(Math.min(y, maxScroll));
    }
    if (steps.length > SWEEP_CAP) {
      stats.truncated = true;
      stats.truncatedReasons.push('sweep steps ' + steps.length + ' > ' + SWEEP_CAP);
      steps.length = SWEEP_CAP;
    }
    const done = new Set();
    const reportedOwners = new Set();
    // target index -> foreign fixed/sticky layer that last deferred it
    const deferLayer = new Map();
    const CLOSE_TEXT = /^(đóng|close|×|✕|✖|x|tắt|bỏ qua|để sau|skip|no thanks|không, cảm ơn)$/i;
    // A gate the shopper answers to get in (age check, consent wall): the answer is the way out.
    // Short answers must be the whole name; "Có hàng" is a filter option, not an answer.
    const GATE_TEXT = /^(ok|yes|có|i agree|i accept)$|^(xác nhận|đồng ý|chấp nhận|tiếp tục|vào trang|vào cửa hàng|vào website|accept|agree|confirm|continue|enter)(?=$|[\s!.,:])|(đủ|trên)\s*(18|21)\s*tuổi|(^|\s)(18|21)\s*\+|\b(over|above)\s+(18|21)\b|\bof\s+(legal\s+)?age\b/i;
    const dismissible = (layer) => {
      // A toggle that controls the layer is a way out only while the shopper can reach it.
      const toggles = layer.id ? document.querySelectorAll('[aria-controls~="' + CSS.escape(layer.id) + '"]') : [];
      for (let i = 0; i < toggles.length; i++) {
        const tr = toggles[i].getBoundingClientRect();
        const cx = (tr.left + tr.right) / 2;
        const cy = (tr.top + tr.bottom) / 2;
        if (tr.width < 1 || tr.height < 1 || cx < 0 || cx >= vw || cy < 0 || cy >= vh) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (hit && (hit === toggles[i] || toggles[i].contains(hit))) return true;
      }
      const inner = layer.querySelectorAll(ACTIONABLE);
      for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        const name = (c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || '').trim();
        if (CLOSE_TEXT.test(name) || GATE_TEXT.test(name) || /close|dismiss/i.test(String(c.className) + ' ' + c.id)) return true;
      }
      return false;
    };
    // A fixed layer painted over text in another fixed layer: the two never move against each
    // other, so what the upper one hides there stays hidden at every scroll offset (a chat bubble
    // on the label of a bottom checkout bar). Four pixels of the glyph line is the floor
    // text-over-text uses. A layer spanning the viewport is a modal or drawer opened over
    // everything on purpose, and one still animating has not reached its place yet.
    const fixedBoxes = [];
    const fixedOk = new Map();
    const addFixed = (el, r) => {
      const f = fixedLayerOf(el);
      if (!f) return;
      let ok = fixedOk.get(f);
      if (ok === undefined) {
        const fr = f.getBoundingClientRect();
        ok = !unsettled(f) && !(fr.right - fr.left >= vw * 0.9 && fr.bottom - fr.top >= vh * 0.9);
        fixedOk.set(f, ok);
        if (ok) fixedBoxes.push({ layer: f, r: fr });
      }
      if (ok && r) fixedBoxes.push({ layer: f, r: r });
    };
    for (let i = 0; i < runs.length; i++) if (runs[i].vis) addFixed(runs[i].p, runs[i].vis);
    for (let i = 0; i < controls.length; i++) addFixed(controls[i].el, controls[i].vis);
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) addFixed(frames[i], frames[i].getBoundingClientRect());
    const DIALOG_SEL = 'dialog, [role="dialog"], [aria-modal="true"]';
    const SLIDE_ITEM = '.swiper-slide, .slick-slide, .splide__slide, .glide__slide, .owl-item, [aria-roledescription="slide"]';
    const nested = (a, b) => a === b || a.contains(b) || b.contains(a);
    for (let i = 0; i < runs.length && fixedBoxes.length > 1; i++) {
      const run = runs[i];
      const A = run.vis ? fixedLayerOf(run.p) : null;
      if (!A || unsettled(run.p) || reportedOwners.has(run.p)) continue;
      const cy = (run.vis.top + run.vis.bottom) / 2;
      if (cy < 0 || cy >= vh) continue;
      const runDlg = run.p.closest(DIALOG_SEL);
      for (let b = 0; b < fixedBoxes.length; b++) {
        const fb = fixedBoxes[b];
        if (nested(fb.layer, A) || cy < fb.r.top || cy >= fb.r.bottom) continue;
        const lo = Math.max(run.vis.left, fb.r.left, 0);
        const hi = Math.min(run.vis.right, fb.r.right, vw);
        if (hi - lo < 4) continue;
        const step = Math.max(1, (hi - lo) / 64);
        let px = 0;
        let by = null;
        for (let x = lo + step / 2; x < hi; x += step) {
          const stack = document.elementsFromPoint(x, cy);
          for (let k = 0; k < stack.length; k++) {
            const e = stack[k];
            if (e === doc || e === body || nested(e, run.p)) break;
            if (e.closest(PLATFORM_PREVIEW_CHROME)) continue;
            const eDlg = e.closest(DIALOG_SEL);
            if (eDlg && eDlg !== runDlg) continue;
            const eLayer = fixedLayerOf(e);
            if (!eLayer || nested(eLayer, A) || !fixedOk.get(eLayer) || !isOpaque(e)) continue;
            px += step;
            by = by || e;
            break;
          }
        }
        if (px < 4) continue;
        reportedOwners.add(run.p);
        push({ kind: 'occlusion', severity: 'critical', selector: getSelector(run.p), details: 'Text "' + snippet(run.n.nodeValue) + '" in fixed ' + getSelector(A) + ' is covered by fixed ' + getSelector(by) + ' (' + Math.round(px) + 'px of the line)', rect: toRect(run.vis) });
        break;
      }
    }
    for (let i = 0; i < controls.length && fixedBoxes.length > 1; i++) {
      const c = controls[i];
      const A = c.vis ? fixedLayerOf(c.el) : null;
      if (!A || unsettled(c.el) || reportedOwners.has(c.el)) continue;
      const cx = (c.vis.left + c.vis.right) / 2;
      const cy = (c.vis.top + c.vis.bottom) / 2;
      if (cx < 0 || cx >= vw || cy < 0 || cy >= vh) continue;
      const cDlg = c.el.closest(DIALOG_SEL);
      for (let b = 0; b < fixedBoxes.length; b++) {
        const fb = fixedBoxes[b];
        if (nested(fb.layer, A)) continue;
        const ix = span(c.vis.left, c.vis.right, fb.r.left, fb.r.right);
        const iy = span(c.vis.top, c.vis.bottom, fb.r.top, fb.r.bottom);
        if (ix < 4 || iy < 4) continue;
        const sampleX = Math.max(0, Math.min(vw - 1, (Math.max(c.vis.left, fb.r.left) + Math.min(c.vis.right, fb.r.right)) / 2));
        const sampleY = Math.max(0, Math.min(vh - 1, (Math.max(c.vis.top, fb.r.top) + Math.min(c.vis.bottom, fb.r.bottom)) / 2));
        const stack = document.elementsFromPoint(sampleX, sampleY);
        let by = null;
        for (let k = 0; k < stack.length; k++) {
          const e = stack[k];
          if (e === doc || e === body || nested(e, c.el)) break;
          if (e.closest(PLATFORM_PREVIEW_CHROME)) continue;
          const eDlg = e.closest(DIALOG_SEL);
          if (eDlg && eDlg !== cDlg) continue;
          const eLayer = fixedLayerOf(e);
          if (!eLayer || nested(eLayer, A) || !fixedOk.get(eLayer) || !isOpaque(e)) continue;
          by = e;
          break;
        }
        if (!by) continue;
        const cArea = (c.vis.right - c.vis.left) * (c.vis.bottom - c.vis.top);
        const fbArea = (fb.r.right - fb.r.left) * (fb.r.bottom - fb.r.top);
        const minArea = Math.max(1, Math.min(cArea, fbArea));
        if ((ix * iy) / minArea < 0.25 && (sampleX !== cx || sampleY !== cy)) continue;
        reportedOwners.add(c.el);
        push({ kind: 'occlusion', severity: 'critical', selector: getSelector(c.el), details: 'Control ' + getSelector(c.el) + ' in fixed ' + getSelector(A) + ' is covered by fixed ' + getSelector(by), rect: toRect(c.vis) });
        break;
      }
    }
    const checkFixedStickyLayerCollisions = (scrollTag) => {
      const layers = [];
      const seenLayers = new Set();
      for (let i = 0; i < elementLimit; i++) {
        const el = allElements[i];
        const pos = cs(el).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const l = layerOf(el);
        if (!l || seenLayers.has(l) || unsettled(l) || isSrOnly(l) || !painted(l) || alphaOf(l) < 0.5) continue;
        if (l.closest(PLATFORM_PREVIEW_CHROME) || l.closest(DIALOG_SEL)) continue;
        const lr = l.getBoundingClientRect();
        if (lr.width < 16 || lr.height < 16 || lr.bottom <= 0 || lr.top >= vh || lr.right <= 0 || lr.left >= vw) continue;
        if (lr.width >= vw * 0.9 && lr.height >= vh * 0.9) continue;
        seenLayers.add(l);
        layers.push({ layer: l, r: lr });
      }
      for (let a = 0; a < layers.length; a++) {
        for (let b = a + 1; b < layers.length; b++) {
          const LA = layers[a];
          const LB = layers[b];
          if (nested(LA.layer, LB.layer)) continue;
          const ix = span(LA.r.left, LA.r.right, LB.r.left, LB.r.right);
          const iy = span(LA.r.top, LA.r.bottom, LB.r.top, LB.r.bottom);
          if (ix < 8 || iy < 8) continue;
          const areaA = LA.r.width * LA.r.height;
          const areaB = LB.r.width * LB.r.height;
          const minArea = Math.max(1, Math.min(areaA, areaB));
          if ((ix * iy) / minArea < 0.25) continue;
          const smaller = areaA <= areaB ? LA : LB;
          const larger = areaA <= areaB ? LB : LA;
          if (reportedOwners.has(smaller.layer)) continue;
          const sx = Math.max(0, Math.min(vw - 1, (Math.max(LA.r.left, LB.r.left) + Math.min(LA.r.right, LB.r.right)) / 2));
          const sy = Math.max(0, Math.min(vh - 1, (Math.max(LA.r.top, LB.r.top) + Math.min(LA.r.bottom, LB.r.bottom)) / 2));
          const stack = document.elementsFromPoint(sx, sy);
          let hitsFixed = false;
          for (let k = 0; k < stack.length; k++) {
            const e = stack[k];
            if (e === doc || e === body) break;
            if (nested(e, LA.layer) || nested(e, LB.layer)) { hitsFixed = true; break; }
          }
          if (!hitsFixed) continue;
          reportedOwners.add(smaller.layer);
          push({
            kind: 'occlusion',
            severity: 'critical',
            selector: getSelector(smaller.layer),
            details: 'Fixed/sticky ' + getSelector(smaller.layer) + ' collides with fixed/sticky ' + getSelector(larger.layer) + ' (' + Math.round(ix) + 'x' + Math.round(iy) + 'px overlap' + (scrollTag ? ' ' + scrollTag : '') + ')',
            rect: toRect(smaller.r)
          });
        }
      }
    };
    checkFixedStickyLayerCollisions('');
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
        if (bottom <= 0 || top >= vh) continue;
        if (top < 0 || bottom > vh) {
          if (bottom - top <= vh - stride) continue;
          const visNow = Math.min(bottom, vh) - Math.max(top, 0);
          if (visNow < 16 && bottom - top >= 16) continue;
          if (s + 1 < steps.length) {
            const nextGot = steps[s + 1];
            const visNext = Math.min(tg.vis.bottom - nextGot, vh) - Math.max(tg.vis.top - nextGot, 0);
            if (visNext > visNow) continue;
          }
        }
        const cy = (Math.max(top, 0) + Math.min(bottom, vh)) / 2;
        if (cy < 0 || cy >= vh) continue;
        const tgDlg = tg.owner.closest(DIALOG_SEL);
        const tgSlide = tg.owner.closest(SLIDE_ITEM);
        // One paint-order probe: 'covered' (opaque same-layer box, or an opaque top bar at load /
        // bottom bar at the end of the page), 'deferred' (only a foreign fixed/sticky layer is in
        // the way - retry at another offset), or 'clear'.
        const sample = (cx, y) => {
          // Fast path: the topmost hit is the owner (or its own subtree/ancestor) - nothing paints over it.
          const hit = document.elementFromPoint(cx, y);
          if (!hit || hit === doc || hit === body || hit === tg.owner || tg.owner.contains(hit) || hit.contains(tg.owner)) return { state: 'clear' };
          const stack = document.elementsFromPoint(cx, y);
          let deferredBy = null;
          for (let k = 0; k < stack.length; k++) {
            const e = stack[k];
            if (e === tg.owner || tg.owner.contains(e) || e.contains(tg.owner)) break;
            if (e === doc || e === body) break;
            if (e.closest(PLATFORM_PREVIEW_CHROME)) continue;
            const eDlg = e.closest(DIALOG_SEL);
            if (eDlg && eDlg !== tgDlg) continue;
            const eSlide = e.closest(SLIDE_ITEM);
            if (tgSlide && eSlide && tgSlide !== eSlide) continue;
            if (isCollapsedCurtain(e, tg.owner)) continue;
            const eLayer = layerOf(e);
            if (eLayer && eLayer !== tg.layer) {
              if (s === 0 && !tg.fixed && topLayer(eLayer) && isOpaque(e)) return { state: 'covered', by: e, sticky: 'at page load' };
              if (atEnd && !tg.fixed && bottomLayer(eLayer) && isOpaque(e)) return { state: 'covered', by: e, sticky: 'at the end of the page' };
              deferredBy = deferredBy || eLayer;
              continue;
            }
            if (isOpaque(e)) return { state: 'covered', by: e, sticky: null };
          }
          return deferredBy ? { state: 'deferred', layer: deferredBy } : { state: 'clear' };
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
        if (first.state === 'deferred') { deferLayer.set(t, first.layer); continue; }
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
    // A fixed layer spanning the viewport with its own opaque surface hides the page at every
    // scroll offset: what lies under it was deferred at each step and never came clear. A modal or
    // drawer opened on purpose offers a way out (a close control inside it, or a toggle that
    // controls it) or dims the page through a translucent backdrop; one with neither traps the
    // shopper.
    const trapped = new Map();
    deferLayer.forEach((layer, t) => {
      if (done.has(t)) return;
      const list = trapped.get(layer) || [];
      list.push(targets[t]);
      trapped.set(layer, list);
    });
    trapped.forEach((list, layer) => {
      if (list.length < 2 || unsettled(layer)) return;
      if (layer.closest(PLATFORM_PREVIEW_CHROME) || layer.closest('dialog, [role="dialog"], [aria-modal="true"]')) return;
      const lr = layer.getBoundingClientRect();
      if (lr.right - lr.left < vw * 0.9 || lr.bottom - lr.top < vh * 0.9) return;
      const ls = cs(layer);
      if (alphaOfColor(ls.backgroundColor) < 0.95 && (!ls.backgroundImage || ls.backgroundImage === 'none')) return;
      if (dismissible(layer)) return;
      push({ kind: 'occlusion', severity: 'critical', selector: getSelector(layer), details: 'Fixed ' + getSelector(layer) + ' spans the viewport and hides the page at every scroll offset with no close control (' + list.length + ' texts/controls never come clear, e.g. ' + list[0].label + ')', rect: toRect(lr) });
    });
    const checkScrolledStateHeaderAndSticky = () => {
      const toggledScrolledHeaders = [];
      // Parts of a header that scroll, animate or overlay by design: content past the viewport
      // there is reachable (a nav scroller), moving (a marquee) or parked off screen (a drawer).
      const MOVING_RE = /swiper|carousel|slider|splide|flickity|glide|owl|marquee|ticker/i;
      const outsideHeaderBar = (d, hdr) => {
        for (let p = d; p && p !== hdr; p = parentOf(p)) {
          const ps = cs(p);
          if (p !== d && (ps.position === 'absolute' || ps.position === 'fixed')) return true;
          if (isScrollAxis(ps.overflowX) || MOVING_RE.test(String(p.className || ''))) return true;
        }
        return false;
      };
      // Visible part of el's box inside every clipping ancestor up to the root, read fresh: the
      // memoized boxClips chain describes the page at rest, before the header changed state.
      const liveClippedRect = (el, r) => {
        const v = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        for (let p = parentOf(el); p && p !== body && p !== doc; p = parentOf(p)) {
          const ps = getComputedStyle(p);
          if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
          const pr = p.getBoundingClientRect();
          const left = pr.left + p.clientLeft;
          const top = pr.top + p.clientTop;
          if (ps.overflowX !== 'visible') { v.left = Math.max(v.left, left); v.right = Math.min(v.right, left + p.clientWidth); }
          if (ps.overflowY !== 'visible') { v.top = Math.max(v.top, top); v.bottom = Math.min(v.bottom, top + p.clientHeight); }
          if (v.right - v.left < 1 || v.bottom - v.top < 1) return null;
        }
        return v;
      };
      const ownsText = (el) => {
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) return true;
        }
        return false;
      };
      // Header parts as they read at rest (top of the page): what the scrolled state changes is
      // measured against this, never against the design itself.
      const restParts = new Map();
      const readHeaderParts = (hdr) => {
        const parts = [];
        const nodes = hdr.querySelectorAll('*');
        for (let n = 0; n < nodes.length; n++) {
          const el = nodes[n];
          if (!painted(el) || isSrOnly(el) || el.closest('[aria-hidden="true"], [hidden]') || outsideHeaderBar(el, hdr)) continue;
          const control = el.matches(ACTIONABLE);
          const text = ownsText(el);
          if (!control && !text) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const vis = liveClippedRect(el, r);
          parts.push({ el, r, control, text, shown: vis ? vis.bottom - vis.top : 0 });
        }
        return parts;
      };
      const overlapShare = (a, b) => {
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        return smaller > 0 ? (span(a.left, a.right, b.left, b.right) * span(a.top, a.bottom, b.top, b.bottom)) / smaller : 0;
      };
      try {
        const targetScrollY = maxScroll > 0 ? Math.min(600, maxScroll) : 0;
        const headerCandidates = document.querySelectorAll('header, .header, .site-header, [class*="header"]');
        scrollToY(0);
        styleMemo.clear();
        boxMemo.clear();
        for (let hIdx = 0; hIdx < headerCandidates.length; hIdx++) {
          const hdr = headerCandidates[hIdx];
          const hp = cs(hdr).position;
          if ((hp === 'fixed' || hp === 'sticky') && painted(hdr)) {
            readHeaderParts(hdr).forEach((part) => { if (!restParts.has(part.el)) restParts.set(part.el, part); });
          }
        }
        if (targetScrollY > 0) scrollToY(targetScrollY);
        for (let hIdx = 0; hIdx < headerCandidates.length; hIdx++) {
          const hdr = headerCandidates[hIdx];
          const hp = cs(hdr).position;
          if ((hp === 'fixed' || hp === 'sticky') && hdr.classList && !hdr.classList.contains('is-scrolled')) {
            hdr.classList.add('is-scrolled');
            toggledScrolledHeaders.push(hdr);
          }
        }
        styleMemo.clear();
        boxMemo.clear();
        checkFixedStickyLayerCollisions('at scrollY=600');
        for (let hIdx = 0; hIdx < headerCandidates.length; hIdx++) {
          const hdr = headerCandidates[hIdx];
          const hp = cs(hdr).position;
          if (hp !== 'fixed' && hp !== 'sticky') continue;
          if (!painted(hdr)) continue;
          const descendants = hdr.querySelectorAll('*');
          for (let dIdx = 0; dIdx < descendants.length; dIdx++) {
            const d = descendants[dIdx];
            if (!painted(d) || isSrOnly(d) || reportedOwners.has(d) || clippedOwners.has(d)) continue;
            const ds = cs(d);
            if (ds.position === 'absolute' || ds.position === 'fixed' || ds.display === 'inline' || ds.display === 'contents') continue;
            const dr = d.getBoundingClientRect();
            if (dr.width < 8 || dr.height < 8 || dr.right <= vw + 2) continue;
            if (d.closest('[aria-hidden="true"], [hidden]') || outsideHeaderBar(d, hdr)) continue;
            // Measure what is painted: a part a clipping ancestor already hides is a clipping
            // finding, not content pushed past the viewport.
            const visible = liveClippedRect(d, dr);
            if (!visible || visible.right <= vw + 2) continue;
            let childOverflows = false;
            for (let c = 0; c < d.children.length; c++) {
              const ch = d.children[c];
              if (painted(ch) && ch.getBoundingClientRect().right > vw + 2) { childOverflows = true; break; }
            }
            if (childOverflows) continue;
            reportedOwners.add(d);
            push({
              kind: 'offscreen',
              severity: 'critical',
              selector: getSelector(d),
              details: 'Element ' + getSelector(d) + ' in scrolled header ' + getSelector(hdr) + ' overflows viewport width at scrollY=600 (right: ' + Math.round(visible.right) + 'px > ' + vw + 'px)',
              rect: toRect(dr)
            });
          }
        }
        const reportedPairs = new Set();
        for (let hIdx = 0; hIdx < headerCandidates.length; hIdx++) {
          const hdr = headerCandidates[hIdx];
          const hp = cs(hdr).position;
          if ((hp !== 'fixed' && hp !== 'sticky') || !painted(hdr)) continue;
          const parts = readHeaderParts(hdr);
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const rest = restParts.get(part.el);
            // Text the shrunken header now cuts part-way; hidden whole is a header collapsing by design.
            if (part.text && rest && !clippedOwners.has(part.el) && part.shown > 0) {
              const wasWhole = rest.shown >= rest.r.height - 1;
              if (wasWhole && part.shown < part.r.height * 0.75 && part.r.height - part.shown >= 4) {
                clippedOwners.add(part.el);
                push({ kind: 'clipping', severity: 'critical', selector: getSelector(part.el), details: 'Text in scrolled header ' + getSelector(hdr) + ' is cut at scrollY=600: ' + Math.round(part.shown) + ' of ' + Math.round(part.r.height) + 'px still shows', rect: toRect(part.r) });
              }
            }
            if (!part.control) continue;
            for (let j = i + 1; j < parts.length; j++) {
              const other = parts[j];
              if (!other.control || part.el.contains(other.el) || other.el.contains(part.el)) continue;
              const now = overlapShare(part.r, other.r);
              const restA = restParts.get(part.el);
              const restB = restParts.get(other.el);
              // Only controls the scrolled state slid onto each other: a pair that already
              // overlapped at rest is a designed overlay or a defect the rest-state pass owns.
              if (now < 0.3 || !restA || !restB || overlapShare(restA.r, restB.r) >= 0.1) continue;
              const pairKey = getSelector(part.el) + '|' + getSelector(other.el);
              if (reportedPairs.has(pairKey)) continue;
              reportedPairs.add(pairKey);
              push({ kind: 'occlusion', severity: 'critical', selector: getSelector(other.el), relatedSelector: getSelector(part.el), details: 'Controls ' + getSelector(part.el) + ' and ' + getSelector(other.el) + ' overlap ' + Math.round(now * 100) + '% in scrolled header ' + getSelector(hdr) + ' at scrollY=600 (apart at the top of the page)', rect: toRect(other.r) });
            }
          }
        }
      } catch (err) {
        detectorFailed('offscreen', err);
      } finally {
        for (let hIdx = 0; hIdx < toggledScrolledHeaders.length; hIdx++) {
          toggledScrolledHeaders[hIdx].classList.remove('is-scrolled');
        }
      }
    };
    checkScrolledStateHeaderAndSticky();
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
    if (!SKIP_LAYOUT_SHIFT && typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver(() => {});
      observer.observe({ type: 'layout-shift', buffered: true });
      const records = observer.takeRecords();
      observer.disconnect();
      // hadRecentInput also marks shifts that follow a viewport resize (mobile device emulation sets
      // one at load), so the flag excuses a shift only once the page has recorded a discrete input
      // (click, tap, key) at or before the input the entry names.
      let firstInputAt = -Infinity;
      try {
        const inputs = new PerformanceObserver(() => {});
        inputs.observe({ type: 'first-input', buffered: true });
        const first = inputs.takeRecords();
        inputs.disconnect();
        firstInputAt = first.length ? first[0].startTime : Infinity;
      } catch (e) {}
      for (let i = 0; i < records.length; i++) {
        const entry = records[i];
        if (!entry || typeof entry.value !== 'number') continue;
        if (entry.hadRecentInput && !(typeof entry.lastInputTime === 'number' && entry.lastInputTime + 50 < firstInputAt)) continue;
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
    if (!SKIP_LAYOUT_SHIFT) stats.cls = Math.round(clsScore * 1000) / 1000;
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
   * 2a. edge clearance: text and controls pressed against the viewport, an open dialog or a
   *     clipping box (spacing, warning)
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
   *
   * `options.skipLayoutShift` drops detector 8: a scan taken after an emulated resize would sum the
   * resize's own layout-shift entries into a false CLS.
   */
  public static getBrowserScanScript(viewportName: string = 'active', options: LayoutIntegrityScanOptions = {}): string {
    return LAYOUT_INTEGRITY_SCAN
      .replace("'__VIEWPORT_NAME__'", () => JSON.stringify(viewportName))
      .replace("'__SKIP_LAYOUT_SHIFT__'", () => JSON.stringify(options.skipLayoutShift === true ? 'true' : 'false'));
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
