/**
 * AntiFan Browser Desktop — Visual Quality Scanner
 *
 * Deterministic, in-page measurements for defects the layout-integrity engine does not grade:
 *  - contrast-low:            text whose WCAG 2.x contrast against its effective background is
 *                             under AA (4.5:1, or 3:1 for large text). Text painted over images,
 *                             video, canvas or gradients is counted as indeterminate, never as a
 *                             violation, because its real backdrop is not a single colour.
 *  - tap-target-small/tiny:   on mobile widths (<= 767px), controls under 44x44 CSS px
 *                             (recommended) or under 24x24 (WCAG 2.2 SC 2.5.8 minimum). Inline
 *                             links inside running text are exempt, as WCAG exempts them.
 *  - floating-widget-overlap: small fixed-position widgets (chat bubbles, bells, back-to-top)
 *                             that paint over in-flow text or controls at the top of the page or
 *                             at the end of the page, the two rest positions a visitor lands on.
 *  - invisible-click-blocker: the same geometry, but the fixed layer paints nothing where it
 *                             sits on top (transparent wrapper box): the content looks clickable
 *                             yet the click lands on the invisible layer.
 *  - font-below-min:          rendered text under thresholds.minTextPx.
 *  - control-height-band:     on mobile widths, a control whose hit height sits between
 *                             thresholds.minTapHitPx and thresholds.minControlPx; on every width,
 *                             same-role siblings in one parent with different heights.
 *  - wrapped-label:           a button/tab label that breaks onto more than one line.
 *  - icon-stroke-mismatch:    outline icons whose rendered stroke differs from the page's modal
 *                             stroke width.
 *  - overlay-fit:             an open fixed dialog/popup panel that extends past the viewport.
 * The five rules above read ONLY from `options.thresholds`; without it they are not run and are
 * reported in stats.unmeasuredRules. A control whose ::before/::after pseudo-element enlarges its
 * hit area is graded on that hit area (WCAG 2.5.8 spacing exception).
 *
 * Visually hidden text (sr-only clip patterns) and boxes parked off-canvas (closed drawers,
 * skip links above the document) are not graded: no visitor sees or taps them.
 *
 * Every rule reports `warning`. Whether a warning may fail a run is a policy decision owned by
 * the QA workflow profile, not by this scanner. The scan scrolls to measure the page end and
 * restores the original scroll position before returning.
 */

export const VISUAL_QUALITY_RULE_IDS = [
  'contrast-low',
  'tap-target-small',
  'tap-target-tiny',
  'floating-widget-overlap',
  'invisible-click-blocker',
  'font-below-min',
  'control-height-band',
  'wrapped-label',
  'icon-stroke-mismatch',
  'overlay-fit',
] as const;

export type VisualQualityRuleId = (typeof VISUAL_QUALITY_RULE_IDS)[number];

export interface VisualQualityThresholds {
  minTextPx: number;
  minControlPx: number;
  minTapHitPx: number;
  tapSpacingCirclePx: number;
}

export interface VisualQualityFinding {
  ruleId: VisualQualityRuleId;
  severity: 'warning';
  selector: string;
  details: string;
  rect?: { x: number; y: number; w: number; h: number };
  measured?: Record<string, unknown>;
  /** Elements collapsed into this finding because they share selector and measurements. */
  occurrences?: number;
}

export interface VisualQualityStats {
  textElementsChecked: number;
  contrastIndeterminate: number;
  controlsChecked: number;
  floatingWidgets: number;
  scrollPositions: number;
  durationMs: number;
  truncated: boolean;
  truncatedReasons: string[];
  /** Rule ids evaluated in this scan. */
  measuredRules: string[];
  /** Rule ids that were not evaluated (missing thresholds, desktop width, skipped pass). */
  unmeasuredRules: string[];
}

export interface VisualQualityScanResult {
  measured: boolean;
  viewport: { width: number; height: number };
  mobile: boolean;
  findings: VisualQualityFinding[];
  stats: VisualQualityStats;
  error?: string;
}

export interface VisualQualityScanOptions {
  /** Force mobile tap-target rules on/off; defaults to viewport width <= 767px. */
  mobile?: boolean;
  /** Check floating widgets only where the page is scrolled now (keeps the scan scroll-free). */
  skipPageEnd?: boolean;
  /** Skip the floating-widget pass entirely (scoped callers that only read contrast/tap rules). */
  skipFloating?: boolean;
  /** Restrict contrast and tap-target checks to this subtree. */
  scopeSelector?: string;
  /** Registry thresholds; the rules that read them only run when this is supplied. */
  thresholds?: VisualQualityThresholds;
}

export const VISUAL_QUALITY_LIMITS = Object.freeze({
  maxTextElements: 2500,
  maxControls: 1500,
  maxFindingsPerRule: 40,
  minContrastNormal: 4.5,
  minContrastLarge: 3,
  tapRecommendedPx: 44,
  tapMinimumPx: 24,
  mobileMaxWidth: 767,
  floatingMaxViewportShare: 0.15,
  floatingMaxWidthShare: 0.7,
  overlapMinPx: 4,
  iconMaxPx: 64,
  iconMinPx: 8,
  iconStrokeTolerancePx: 0.3,
  heightMismatchTolerancePx: 1,
  viewportFitTolerancePx: 1,
});

const THRESHOLD_KEYS = ['minTextPx', 'minControlPx', 'minTapHitPx', 'tapSpacingCirclePx'] as const;

function normalizeThresholds(value: VisualQualityThresholds | undefined): VisualQualityThresholds | null {
  if (value === undefined) return null;
  const out = {} as Record<string, number>;
  for (const key of THRESHOLD_KEYS) {
    const v = (value as unknown as Record<string, unknown> | null)?.[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error('visual-quality thresholds.' + key + ' must be a positive number (got ' + JSON.stringify(v) + ')');
    }
    out[key] = v;
  }
  return out as unknown as VisualQualityThresholds;
}

export class VisualQualityScanner {
  public static getBrowserScanScript(options: VisualQualityScanOptions = {}): string {
    const opts = JSON.stringify({
      mobile: typeof options.mobile === 'boolean' ? options.mobile : null,
      skipPageEnd: options.skipPageEnd === true,
      skipFloating: options.skipFloating === true,
      scopeSelector: typeof options.scopeSelector === 'string' && options.scopeSelector.trim() ? options.scopeSelector.trim() : null,
      thresholds: normalizeThresholds(options.thresholds),
    });
    const limits = JSON.stringify(VISUAL_QUALITY_LIMITS);
    const allRules = JSON.stringify(VISUAL_QUALITY_RULE_IDS);
    return `(() => {
  const OPTS = ${opts};
  const L = ${limits};
  const ALL_RULES = ${allRules};
  const started = Date.now();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mobile = OPTS.mobile === null ? vw <= L.mobileMaxWidth : OPTS.mobile;
  const findings = [];
  const counts = {};
  const truncatedReasons = [];
  const stats = { textElementsChecked: 0, contrastIndeterminate: 0, controlsChecked: 0, floatingWidgets: 0, scrollPositions: 0 };
  const TH = OPTS.thresholds;
  const measuredRules = ['contrast-low'];
  function markMeasured(id) { if (!measuredRules.includes(id)) measuredRules.push(id); }
  if (TH) ['font-below-min', 'control-height-band', 'wrapped-label', 'icon-stroke-mismatch', 'overlay-fit'].forEach(markMeasured);
  function rulesReport() {
    return { measuredRules: measuredRules.slice(), unmeasuredRules: ALL_RULES.filter((id) => !measuredRules.includes(id)) };
  }
  const PREVIEW_CHROME = '#preview-bar-iframe, [id*="preview-bar"], .preview-bar, ul.preview-cta, #haravan-notification, .hrv-admin-bar, #admin-bar-iframe, #PBarNextFrameWrapper, [data-antifan-override]';

  function isPreviewChrome(el) {
    try { return !!(el && el.closest && el.closest(PREVIEW_CHROME)); } catch (e) { return false; }
  }
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    let sel = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\\s+/).filter((c) => c && !c.includes(':')).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
    }
    return sel;
  }
  function rectOf(r) {
    return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }
  // Findings with the same rule, selector and measurement collapse into one row with a count,
  // so twenty identical wishlist buttons read as one defect instead of twenty.
  const merged = new Map();
  function push(f, mergeKey) {
    if (mergeKey && merged.has(mergeKey)) { merged.get(mergeKey).occurrences += 1; return; }
    counts[f.ruleId] = (counts[f.ruleId] || 0) + 1;
    if (counts[f.ruleId] > L.maxFindingsPerRule) {
      const reason = f.ruleId + ' capped at ' + L.maxFindingsPerRule;
      if (!truncatedReasons.includes(reason)) truncatedReasons.push(reason);
      return;
    }
    f.occurrences = 1;
    findings.push(f);
    if (mergeKey) merged.set(mergeKey, f);
  }
  function rendered(el, r) {
    if (!r || r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0;
  }
  function ancestorOpacity(el) {
    let op = 1;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const v = parseFloat(getComputedStyle(cur).opacity);
      if (!isNaN(v)) op *= v;
    }
    return op;
  }
  function hiddenFromAt(el) {
    try { return !!el.closest('[aria-hidden="true"], [inert]'); } catch (e) { return false; }
  }
  // sr-only / visually-hidden patterns: 1px boxes, clip rect(0..1px), clip-path inset(50%+).
  function visuallyHidden(el, r) {
    if (r.width <= 1 || r.height <= 1) return true;
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++, cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      const clip = cs.clip || '';
      if (/^rect\\(/.test(clip)) {
        const nums = (clip.match(/-?[0-9.]+/g) || []).map(Number);
        if (nums.length === 4 && Math.abs(nums[2] - nums[0]) <= 1 && Math.abs(nums[1] - nums[3]) <= 1) return true;
      }
      const cp = cs.clipPath || '';
      const inset = cp.match(/^inset\\(\\s*([0-9.]+)%/);
      if (inset && parseFloat(inset[1]) >= 50) return true;
      const cr = cur.getBoundingClientRect();
      if ((cr.width <= 1 || cr.height <= 1) && cs.overflow !== 'visible') return true;
    }
    return false;
  }
  // Closed drawers slid out of view and skip links parked above the document.
  function offCanvas(r) {
    return r.right <= 0 || r.left >= vw || r.bottom + window.scrollY <= 0;
  }
  // Does the topmost element at a point paint anything between itself and the widget root?
  function paintsAt(hit, widget) {
    for (let cur = hit; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const tag = cur.tagName;
      if (tag === 'IMG' || tag === 'SVG' || tag === 'svg' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IFRAME' || tag === 'PICTURE') return true;
      const cs = getComputedStyle(cur);
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.02) return true;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      if (cs.boxShadow && cs.boxShadow !== 'none') return true;
      if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) {
        const bc = parseColor(cs.borderTopColor);
        if (bc && bc.a > 0.02) return true;
      }
      for (const n of cur.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      if (cur === widget) break;
    }
    return false;
  }

  // ---- colour maths (sRGB, WCAG 2.x) ----
  function parseColor(str) {
    if (!str || typeof str !== 'string') return null;
    const s = str.trim();
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m = s.match(/^color\\(\\s*srgb\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)(?:\\s*\\/\\s*([0-9.]+%?))?\\s*\\)$/i);
    if (m) return { r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255, a: m[4] === undefined ? 1 : alphaOf(m[4]) };
    m = s.match(/^rgba?\\(\\s*([0-9.]+)[,\\s]+([0-9.]+)[,\\s]+([0-9.]+)(?:[,\\/\\s]+([0-9.]+%?))?\\s*\\)$/i);
    if (m) return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: m[4] === undefined ? 1 : alphaOf(m[4]) };
    return null;
  }
  function alphaOf(v) { return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v); }
  function blend(fg, bg) {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return { r: 255, g: 255, b: 255, a: 1 };
    return { r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a, g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a, b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a, a: a };
  }
  function lum(c) {
    const ch = [c.r, c.g, c.b].map((v) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function ratio(a, b) {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function hex(c) {
    const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }
  // Effective backdrop from the ancestor chain. Returns null when a background image,
  // gradient or media element makes the backdrop something other than one colour.
  function backdropOf(el) {
    const layers = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 0.999) break;
      }
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) acc = blend(layers[i], acc);
    return acc;
  }
  // Media and image-backed boxes that a text box can sit on without being their descendant
  // (absolutely positioned hero copy over an <img>, a caption over a <video>).
  const mediaRects = [];
  try {
    const media = document.querySelectorAll('img, picture, video, canvas, svg image, iframe');
    for (const m of media) {
      const r = m.getBoundingClientRect();
      if (r.width * r.height >= 400) mediaRects.push({ el: m, left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY });
    }
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      const bi = getComputedStyle(el).backgroundImage;
      if (bi && bi !== 'none') {
        const r = el.getBoundingClientRect();
        if (r.width * r.height >= 400) mediaRects.push({ el: el, left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY });
      }
    }
  } catch (e) {}
  function overMedia(el, r) {
    const cx = r.left + r.width / 2 + window.scrollX;
    const cy = r.top + r.height / 2 + window.scrollY;
    for (const m of mediaRects) {
      if (m.el === el || el.contains(m.el)) continue;
      // Covers both positioned copy over a sibling <img> and text inside an image-backed box.
      if (cx >= m.left && cx <= m.right && cy >= m.top && cy <= m.bottom) return true;
    }
    return false;
  }

  const scope = (() => {
    if (!OPTS.scopeSelector) return document.body || document.documentElement;
    try { return document.querySelector(OPTS.scopeSelector) || null; } catch (e) { return null; }
  })();
  if (!scope) {
    return { measured: false, viewport: { width: vw, height: vh }, mobile: mobile, findings: [], stats: Object.assign(stats, { durationMs: Date.now() - started, truncated: false, truncatedReasons: [] }, rulesReport()), error: 'SCOPE_NOT_FOUND' };
  }

  // ---- contrast ----
  const seenText = new Set();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let textNode;
  while ((textNode = walker.nextNode())) {
    const el = textNode.parentElement;
    if (!el || seenText.has(el)) continue;
    seenText.add(el);
    if (seenText.size > L.maxTextElements) { truncatedReasons.push('contrast scan capped at ' + L.maxTextElements + ' text elements'); break; }
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'OPTION') continue;
    if (isPreviewChrome(el) || hiddenFromAt(el)) continue;
    if (el.closest('button[disabled], input[disabled], [aria-disabled="true"], fieldset[disabled]')) continue;
    const r = el.getBoundingClientRect();
    if (!rendered(el, r) || visuallyHidden(el, r) || offCanvas(r)) continue;
    const op = ancestorOpacity(el);
    if (op < 0.05) continue;
    stats.textElementsChecked++;
    const cs = getComputedStyle(el);
    if (TH) {
      const fontPx = parseFloat(cs.fontSize);
      if (fontPx < TH.minTextPx) {
        const fsel = selectorOf(el);
        const fontRounded = Math.round(fontPx * 100) / 100;
        push({
          ruleId: 'font-below-min',
          severity: 'warning',
          selector: fsel,
          details: 'Text "' + textNode.nodeValue.trim().slice(0, 48) + '" in ' + fsel + ' is ' + fontRounded + 'px, below the ' + TH.minTextPx + 'px minimum',
          rect: rectOf(r),
          measured: { fontSizePx: fontRounded, minimumPx: TH.minTextPx },
        }, 'font|' + fsel + '|' + fontRounded);
      }
    }
    // The painted glyph colour: -webkit-text-fill-color wins over color (it computes to
    // currentcolor when unset).
    const fg = parseColor(cs.webkitTextFillColor || cs.color);
    if (!fg) continue;
    const backdrop = backdropOf(el);
    // A transparent fill is gradient/image text (background-clip: text): the glyphs show the
    // background, which a flat-colour ratio cannot grade.
    if (!backdrop || overMedia(el, r) || fg.a < 0.05) { stats.contrastIndeterminate++; continue; }
    const effFg = blend({ r: fg.r, g: fg.g, b: fg.b, a: fg.a * op }, backdrop);
    const cr = ratio(effFg, backdrop);
    const fs = parseFloat(cs.fontSize) || 16;
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const need = large ? L.minContrastLarge : L.minContrastNormal;
    if (cr + 1e-9 < need) {
      const sel = selectorOf(el);
      const rounded = Math.round(cr * 100) / 100;
      push({
        ruleId: 'contrast-low',
        severity: 'warning',
        selector: sel,
        details: 'Text "' + textNode.nodeValue.trim().slice(0, 48) + '" in ' + sel + ' has contrast ' + rounded + ':1 (needs ' + need + ':1 for ' + Math.round(fs) + 'px/' + fw + ')',
        rect: rectOf(r),
        measured: { ratio: rounded, required: need, foreground: hex(effFg), background: hex(backdrop), fontSizePx: Math.round(fs * 10) / 10, fontWeight: fw, large: large },
      }, 'contrast|' + sel + '|' + hex(effFg) + '|' + hex(backdrop) + '|' + need);
    }
  }

  // ---- controls: tap targets (mobile widths) and registry control rules ----
  function unionRect(rects) {
    let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
    for (const q of rects) { left = Math.min(left, q.left); top = Math.min(top, q.top); right = Math.max(right, q.right); bottom = Math.max(bottom, q.bottom); }
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }
  function containingBlockOrigin(el, pseudoCs) {
    if (pseudoCs.position === 'fixed') return { left: 0, top: 0 };
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (getComputedStyle(node).position !== 'static') {
        const nr = node.getBoundingClientRect();
        return { left: nr.left + node.clientLeft, top: nr.top + node.clientTop };
      }
    }
    const root = document.documentElement.getBoundingClientRect();
    return { left: root.left, top: root.top };
  }
  // Absolutely positioned ::before/::after boxes are part of the control's hit area: a click on
  // them lands on the control.
  function pseudoRects(el) {
    const out = [];
    for (const name of ['::before', '::after']) {
      const pcs = getComputedStyle(el, name);
      if (!pcs.content || pcs.content === 'none' || pcs.content === 'normal' || pcs.display === 'none') continue;
      if (pcs.position !== 'absolute' && pcs.position !== 'fixed') continue;
      const pw = parseFloat(pcs.width); const ph = parseFloat(pcs.height);
      const pl = parseFloat(pcs.left); const pt = parseFloat(pcs.top);
      if (!(pw > 0) || !(ph > 0) || !isFinite(pl) || !isFinite(pt)) continue;
      const origin = containingBlockOrigin(el, pcs);
      const left = origin.left + pl + (parseFloat(pcs.marginLeft) || 0);
      const top = origin.top + pt + (parseFloat(pcs.marginTop) || 0);
      out.push({ left: left, top: top, right: left + pw, bottom: top + ph, width: pw, height: ph });
    }
    return out;
  }
  function rectsOverlap(a, b) { return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; }
  function circleHitsRect(cx, cy, radius, q) {
    const dx = Math.max(q.left - cx, 0, cx - q.right);
    const dy = Math.max(q.top - cy, 0, cy - q.bottom);
    return dx * dx + dy * dy < radius * radius;
  }
  const CONTROL = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"]';
  const items = [];
  if (mobile || TH) {
    const controls = scope.querySelectorAll(CONTROL);
    for (let i = 0; i < controls.length; i++) {
      if (i >= L.maxControls) { truncatedReasons.push('tap-target scan capped at ' + L.maxControls + ' controls'); break; }
      const el = controls[i];
      if (isPreviewChrome(el) || hiddenFromAt(el)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const r = el.getBoundingClientRect();
      if (!rendered(el, r) || ancestorOpacity(el) < 0.05 || visuallyHidden(el, r) || offCanvas(r)) continue;
      // A radio/checkbox visually replaced by its label is sized by the label.
      if ((el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels.length) continue;
      const cs = getComputedStyle(el);
      // WCAG 2.5.8 inline exception: a link inside a sentence is constrained by line height.
      if (el.tagName === 'A' && cs.display === 'inline') {
        const block = el.parentElement;
        const ownText = (el.textContent || '').trim().length;
        const blockText = block ? (block.textContent || '').trim().length : 0;
        if (blockText > ownText + 10) continue;
      }
      stats.controlsChecked++;
      const extra = pseudoRects(el);
      items.push({ el: el, box: r, hit: extra.length ? unionRect([r].concat(extra)) : r, extended: extra.length > 0 });
    }
  }
  const radius = L.tapMinimumPx / 2;
  // WCAG 2.5.8 spacing exception for a pseudo-element hit area: the minimum-size circle centred
  // on the target may not meet another target's hit area or circle.
  const crowdedBy = (t) => {
    const cx = (t.hit.left + t.hit.right) / 2;
    const cy = (t.hit.top + t.hit.bottom) / 2;
    for (const o of items) {
      if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) continue;
      if (rectsOverlap(t.hit, o.hit) || circleHitsRect(cx, cy, radius, o.hit)) return o;
      if (Math.min(o.hit.width, o.hit.height) < L.tapRecommendedPx) {
        const dist = Math.hypot((o.hit.left + o.hit.right) / 2 - cx, (o.hit.top + o.hit.bottom) / 2 - cy);
        if (dist < L.tapMinimumPx) return o;
      }
    }
    return null;
  };
  if (mobile) {
    markMeasured('tap-target-small');
    markMeasured('tap-target-tiny');
    for (const it of items) {
      const g = it.hit;
      const w = Math.round(g.width * 10) / 10;
      const h = Math.round(g.height * 10) / 10;
      const minSide = Math.min(w, h);
      if (minSide >= L.tapRecommendedPx) continue;
      const tiny = minSide < L.tapMinimumPx;
      let crowdedNote = '';
      if (it.extended && !tiny) {
        const other = crowdedBy(it);
        if (!other) continue;
        crowdedNote = '; its ' + L.tapMinimumPx + 'px spacing circle meets ' + selectorOf(other.el);
      }
      const sel = selectorOf(it.el);
      push({
        ruleId: tiny ? 'tap-target-tiny' : 'tap-target-small',
        severity: 'warning',
        selector: sel,
        details: (tiny ? 'Tap target below the WCAG 2.2 24px minimum: ' : 'Tap target below the 44px recommended size: ') + sel + ' is ' + w + 'x' + h + 'px' + (it.extended ? ' (including its pseudo-element hit area)' : '') + crowdedNote,
        rect: rectOf(g),
        measured: { width: w, height: h, minimumPx: tiny ? L.tapMinimumPx : L.tapRecommendedPx, pseudoHitArea: it.extended },
      }, 'tap|' + sel + '|' + Math.round(w) + 'x' + Math.round(h));
    }
  }

  if (TH) {
    // ---- control-height-band ----
    if (mobile) {
      for (const it of items) {
        const h = it.hit.height;
        if (h >= TH.minTapHitPx && h < TH.minControlPx && !(it.extended && !crowdedBy(it))) {
          const sel = selectorOf(it.el);
          const hr = Math.round(h * 10) / 10;
          push({
            ruleId: 'control-height-band',
            severity: 'warning',
            selector: sel,
            details: 'Control ' + sel + ' hit height ' + hr + 'px is under the ' + TH.minControlPx + 'px control height at ' + vw + 'px viewport',
            rect: rectOf(it.hit),
            measured: { heightPx: hr, minimumPx: TH.minControlPx, floorPx: TH.minTapHitPx },
          }, 'band|' + sel + '|' + Math.round(h));
        }
      }
    }
    const groups = new Map();
    for (const it of items) {
      const tag = it.el.tagName;
      const role = it.el.getAttribute('role');
      const buttonLike = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || role === 'button' || role === 'tab' || (tag === 'A' && getComputedStyle(it.el).display !== 'inline');
      const first = (typeof it.el.className === 'string' ? it.el.className : '').split(/\\s+/).filter(Boolean)[0];
      if (!buttonLike || !first || !it.el.parentElement) continue;
      const key = it.el.parentElement;
      const perParent = groups.get(key) || new Map();
      const gkey = tag + '.' + first;
      const list = perParent.get(gkey) || [];
      list.push(it);
      perParent.set(gkey, list);
      groups.set(key, perParent);
    }
    groups.forEach((perParent) => perParent.forEach((list) => {
      if (list.length < 2) return;
      const tallest = Math.max.apply(null, list.map((x) => x.box.height));
      for (const x of list) {
        if (tallest - x.box.height > L.heightMismatchTolerancePx) {
          const sel = selectorOf(x.el);
          const own = Math.round(x.box.height * 10) / 10;
          const peer = Math.round(tallest * 10) / 10;
          push({
            ruleId: 'control-height-band',
            severity: 'warning',
            selector: sel,
            details: 'Control ' + sel + ' is ' + own + 'px tall but a same-role sibling is ' + peer + 'px',
            rect: rectOf(x.box),
            measured: { heightPx: own, siblingHeightPx: peer },
          }, 'band-sibling|' + sel + '|' + Math.round(x.box.height) + '|' + Math.round(tallest));
        }
      }
    }));

    // ---- wrapped-label ----
    const LABEL = 'button, [role="button"], [role="tab"], a[class*="btn"], a[class*="button"], a[class*="tab"]';
    const labels = scope.querySelectorAll(LABEL);
    const labelRange = document.createRange();
    for (let i = 0; i < labels.length && i < L.maxControls; i++) {
      const el = labels[i];
      if (isPreviewChrome(el) || hiddenFromAt(el)) continue;
      const r = el.getBoundingClientRect();
      if (!rendered(el, r) || visuallyHidden(el, r) || offCanvas(r)) continue;
      const ws = getComputedStyle(el).whiteSpace;
      if (ws === 'nowrap' || ws === 'pre') continue;
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let worst = 1;
      let node;
      while ((node = tw.nextNode())) {
        if (!/\\S/.test(node.nodeValue)) continue;
        labelRange.selectNodeContents(node);
        const tops = [];
        for (const q of labelRange.getClientRects()) {
          if (q.height <= 0 || q.width <= 0) continue;
          if (!tops.some((t) => Math.abs(t - q.top) < q.height / 2)) tops.push(q.top);
        }
        worst = Math.max(worst, tops.length);
      }
      if (worst > 1) {
        const sel = selectorOf(el);
        const label = (el.textContent || '').trim().slice(0, 40);
        push({
          ruleId: 'wrapped-label',
          severity: 'warning',
          selector: sel,
          details: 'Label "' + label + '" of ' + sel + ' wraps onto ' + worst + ' lines',
          rect: rectOf(r),
          measured: { lines: worst, widthPx: Math.round(r.width) },
        }, 'wrap|' + sel + '|' + worst);
      }
    }

    // ---- icon-stroke-mismatch ----
    const icons = [];
    const svgs = scope.querySelectorAll('svg');
    for (let i = 0; i < svgs.length && i < L.maxControls; i++) {
      const svg = svgs[i];
      if (isPreviewChrome(svg)) continue;
      const sr = svg.getBoundingClientRect();
      if (!rendered(svg, sr)) continue;
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (!vb || !vb.width || sr.width > L.iconMaxPx || sr.width < L.iconMinPx) continue;
      let strokeWidth = null;
      const shapes = svg.querySelectorAll('path, circle, line, polyline, polygon, rect, ellipse');
      for (const shape of shapes) {
        const scs = getComputedStyle(shape);
        if (scs.stroke === 'none' || scs.stroke === 'transparent') continue;
        const fillColor = parseColor(scs.fill);
        if (scs.fill !== 'none' && (!fillColor || fillColor.a > 0.02)) continue;
        const sw = parseFloat(scs.strokeWidth);
        if (!(sw > 0)) continue;
        strokeWidth = sw;
        break;
      }
      if (strokeWidth === null) continue;
      icons.push({ el: svg, rect: sr, rendered: strokeWidth * (sr.width / vb.width) });
    }
    if (icons.length >= 2) {
      const tally = new Map();
      for (const ic of icons) {
        const k = Math.round(ic.rendered * 4) / 4;
        tally.set(k, (tally.get(k) || 0) + 1);
      }
      let modal = null;
      tally.forEach((count, k) => { if (modal === null || count > tally.get(modal)) modal = k; });
      for (const ic of icons) {
        if (Math.abs(ic.rendered - modal) > L.iconStrokeTolerancePx) {
          const sel = selectorOf(ic.el.closest('a, button') || ic.el);
          const own = Math.round(ic.rendered * 100) / 100;
          push({
            ruleId: 'icon-stroke-mismatch',
            severity: 'warning',
            selector: sel,
            details: 'Outline icon in ' + sel + ' renders a ' + own + 'px stroke; the page icon stroke is ' + modal + 'px',
            rect: rectOf(ic.rect),
            measured: { renderedStrokePx: own, modalStrokePx: modal },
          }, 'icon|' + sel + '|' + own);
        }
      }
    }

    // ---- overlay-fit: an open fixed panel must fit the viewport ----
    const POPUP_NAME = /modal|popup|popnoti|dialog|lightbox|newsletter|toast|snackbar|cookie|consent/i;
    const panels = [];
    const everything = scope.getElementsByTagName('*');
    for (let i = 0; i < everything.length && i < 8000; i++) {
      const el = everything[i];
      if (getComputedStyle(el).position !== 'fixed' || isPreviewChrome(el)) continue;
      const role = el.getAttribute('role');
      const named = POPUP_NAME.test(el.tagName + ' ' + (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : ''));
      const semantic = role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true' || (el.tagName === 'DIALOG' && el.open);
      if (!semantic && !named) continue;
      const pr = el.getBoundingClientRect();
      if (!rendered(el, pr) || pr.right <= 0 || pr.bottom <= 0 || pr.left >= vw || pr.top >= vh) continue;
      if (!(el.textContent || '').trim() && !el.querySelector('img, svg, button, a, input, select, textarea')) continue;
      panels.push({ el: el, rect: pr });
    }
    for (const p of panels) {
      if (panels.some((o) => o !== p && o.el.contains(p.el))) continue;
      const pr = p.rect;
      const tol = L.viewportFitTolerancePx;
      if (pr.top < -tol || pr.left < -tol || pr.bottom > vh + tol || pr.right > vw + tol) {
        const sel = selectorOf(p.el);
        push({
          ruleId: 'overlay-fit',
          severity: 'warning',
          selector: sel,
          details: 'Open panel ' + sel + ' is ' + Math.round(pr.width) + 'x' + Math.round(pr.height) + 'px at (' + Math.round(pr.left) + ', ' + Math.round(pr.top) + ') and extends past the ' + vw + 'x' + vh + ' viewport',
          rect: rectOf(pr),
          measured: { width: Math.round(pr.width), height: Math.round(pr.height), left: Math.round(pr.left), top: Math.round(pr.top), viewportWidth: vw, viewportHeight: vh },
        }, 'fit|' + sel + '|' + Math.round(pr.height));
      }
    }
  }

  // ---- floating widgets over content ----
  function floatingWidgets() {
    const out = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      if (isPreviewChrome(el) || hiddenFromAt(el)) continue;
      if (el.matches('dialog, [role="dialog"], [aria-modal="true"]')) continue;
      // Only the outermost fixed box counts; its fixed descendants move with it.
      let nested = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).position === 'fixed') { nested = true; break; }
      }
      if (nested) continue;
      const r = el.getBoundingClientRect();
      if (!rendered(el, r) || ancestorOpacity(el) < 0.05 || cs.pointerEvents === 'none') continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
      const share = (r.width * r.height) / (vw * vh);
      if (share > L.floatingMaxViewportShare || r.width > vw * L.floatingMaxWidthShare) continue;
      out.push(el);
    }
    return out;
  }
  function contentUnder(widget, wr) {
    const hits = [];
    const CANDIDATES = 'a[href], button, [role="button"], input, select, textarea, h1, h2, h3, h4, h5, h6, p, li, span, label, strong, em, b';
    let nodes = [];
    try { nodes = document.querySelectorAll(CANDIDATES); } catch (e) {}
    for (let i = 0; i < nodes.length && i < 6000; i++) {
      const el = nodes[i];
      if (widget.contains(el) || el.contains(widget) || isPreviewChrome(el) || hiddenFromAt(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= wr.left || r.left >= wr.right || r.bottom <= wr.top || r.top >= wr.bottom) continue;
      const ix = Math.min(r.right, wr.right) - Math.max(r.left, wr.left);
      const iy = Math.min(r.bottom, wr.bottom) - Math.max(r.top, wr.top);
      if (ix < L.overlapMinPx || iy < L.overlapMinPx) continue;
      if (!rendered(el, r)) continue;
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      const isControl = el.matches('a[href], button, [role="button"], input, select, textarea');
      if (!isControl && !text) continue;
      // Only keep the deepest covered element so a covered word is not also reported for its ancestors.
      if (hits.some((h) => el.contains(h.el))) continue;
      for (let k = hits.length - 1; k >= 0; k--) if (hits[k].el.contains(el)) hits.splice(k, 1);
      const cx = Math.max(wr.left, r.left) + ix / 2;
      const cy = Math.max(wr.top, r.top) + iy / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || !widget.contains(top)) continue;
      hits.push({ el: el, rect: r, text: text, isControl: isControl, ix: ix, iy: iy, paints: paintsAt(top, widget) });
    }
    return hits;
  }
  const startX = window.scrollX;
  const startY = window.scrollY;
  const html = document.documentElement;
  const priorBehavior = html.style.scrollBehavior;
  try {
    html.style.scrollBehavior = 'auto';
    const maxY = Math.max(0, (document.scrollingElement || html).scrollHeight - vh);
    const positions = OPTS.skipFloating ? [] : OPTS.skipPageEnd ? [startY] : maxY < 8 ? [0] : [0, maxY];
    if (positions.length) { markMeasured('floating-widget-overlap'); markMeasured('invisible-click-blocker'); }
    const whereOf = (y) => (y === 0 ? 'page top' : y >= maxY ? 'page end' : 'scroll position ' + Math.round(y));
    const positionOf = (y) => (y === 0 ? 'top' : y >= maxY ? 'end' : 'current');
    for (const y of positions) {
      if (window.scrollY !== y) window.scrollTo(startX, y);
      stats.scrollPositions++;
      const widgets = floatingWidgets();
      stats.floatingWidgets = Math.max(stats.floatingWidgets, widgets.length);
      for (const widget of widgets) {
        const wr = widget.getBoundingClientRect();
        const wsel = selectorOf(widget);
        for (const hit of contentUnder(widget, wr)) {
          const csel = selectorOf(hit.el);
          const where = whereOf(y);
          const covered = (hit.isControl ? 'control ' : 'text ') + csel + (hit.text ? ' "' + hit.text.slice(0, 40) + '"' : '');
          const size = ' (' + Math.round(hit.ix) + 'x' + Math.round(hit.iy) + 'px)';
          push({
            ruleId: hit.paints ? 'floating-widget-overlap' : 'invisible-click-blocker',
            severity: 'warning',
            selector: wsel,
            details: hit.paints
              ? 'Floating widget ' + wsel + ' covers ' + covered + ' at ' + where + size
              : 'Transparent fixed layer ' + wsel + ' sits on top of ' + covered + ' at ' + where + size + ': the content is visible but clicks land on the invisible layer',
            rect: rectOf(wr),
            measured: { coveredSelector: csel, coveredText: hit.text.slice(0, 80), coveredIsControl: hit.isControl, overlapPx: { x: Math.round(hit.ix), y: Math.round(hit.iy) }, scrollPosition: positionOf(y), widgetPaintsAtPoint: hit.paints },
          }, 'float|' + wsel + '|' + csel + '|' + positionOf(y));
        }
      }
    }
  } finally {
    if (window.scrollX !== startX || window.scrollY !== startY) window.scrollTo(startX, startY);
    html.style.scrollBehavior = priorBehavior;
  }

  return {
    measured: true,
    viewport: { width: vw, height: vh },
    mobile: mobile,
    findings: findings,
    stats: Object.assign(stats, { durationMs: Date.now() - started, truncated: truncatedReasons.length > 0, truncatedReasons: truncatedReasons }, rulesReport()),
  };
})()`;
  }

  /** Shape guard for a value returned by the in-page script. */
  public static normalize(raw: unknown): VisualQualityScanResult {
    const empty: VisualQualityScanResult = {
      measured: false,
      viewport: { width: 0, height: 0 },
      mobile: false,
      findings: [],
      stats: { textElementsChecked: 0, contrastIndeterminate: 0, controlsChecked: 0, floatingWidgets: 0, scrollPositions: 0, durationMs: 0, truncated: false, truncatedReasons: [], measuredRules: [], unmeasuredRules: [] },
    };
    if (!raw || typeof raw !== 'object') return { ...empty, error: 'SCAN_RETURNED_NO_OBJECT' };
    const r = raw as Partial<VisualQualityScanResult>;
    if (r.measured !== true || !Array.isArray(r.findings) || !r.stats) {
      return { ...empty, ...(typeof r.error === 'string' ? { error: r.error } : { error: 'SCAN_SHAPE_INVALID' }) };
    }
    const stats = r.stats as VisualQualityStats;
    return { ...(r as VisualQualityScanResult), stats: { ...stats, measuredRules: stats.measuredRules ?? [], unmeasuredRules: stats.unmeasuredRules ?? [] } };
  }
}
