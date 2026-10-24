/**
 * AntiFan Browser Desktop — Visual Quality Scanner
 *
 * Deterministic, in-page measurements for defects the layout-integrity engine does not grade:
 *  - contrast-low:            text whose WCAG 2.x contrast against its effective background is
 *                             under AA (4.5:1, or 3:1 for large text). Text painted over images,
 *                             video, canvas or gradients is counted as indeterminate, never as a
 *                             violation, because its real backdrop is not a single colour.
 *  - tap-target-tiny:         on mobile widths (<= 767px), controls whose hit area (pseudo-element
 *                             included) is under 24x24 CSS px (WCAG 2.2 SC 2.5.8). Inline links
 *                             inside running text are exempt, as WCAG exempts them.
 *  - floating-widget-overlap: small fixed-position widgets (chat bubbles, bells, back-to-top)
 *                             that paint over in-flow text or controls at the top of the page or
 *                             at the end of the page, the two rest positions a visitor lands on.
 *  - invisible-click-blocker: the same geometry, but the fixed layer paints nothing where it
 *                             sits on top (transparent wrapper box): the content looks clickable
 *                             yet the click lands on the invisible layer.
 *  - font-below-min:          rendered text under thresholds.minTextPx.
 *  - control-height-band:     same-role siblings in one parent with different heights.
 *  - wrapped-label:           a button/tab label that breaks onto more than one line.
 *  - icon-stroke-mismatch:    outline icons whose rendered stroke differs from the page's modal
 *                             stroke width.
 *  - overlay-fit:             an open fixed dialog/popup panel that extends past the viewport.
 *  - title-scale:             at <= 768px, h1-h4 outside thresholds.titleScale for their level; without
 *                             that range, same-level headings of different sections differing by more
 *                             than 2px.
 *  - input-height-band:       inputs/selects of one form differing in height by more than
 *                             thresholds.inputHeightBandPx (default 4).
 * The registry rules above read ONLY from `options.thresholds`; without it they are not run and are
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

import { PLATFORM_PREVIEW_CHROME } from '../platform-preview-chrome';

export const VISUAL_QUALITY_RULE_IDS = [
  'contrast-low',
  'tap-target-tiny',
  'floating-widget-overlap',
  'invisible-click-blocker',
  'font-below-min',
  'control-height-band',
  'wrapped-label',
  'icon-stroke-mismatch',
  'overlay-fit',
  'title-scale',
  'input-height-band',
] as const;

export type VisualQualityRuleId = (typeof VISUAL_QUALITY_RULE_IDS)[number];

export interface VisualQualityThresholds {
  minTextPx: number;
  minTapHitPx: number;
  /** Allowed rendered font-size range [min, max] in px per heading level at <= 768px. */
  titleScale?: Record<'h1' | 'h2' | 'h3' | 'h4', [number, number]>;
  /** Largest allowed height difference in px between the inputs of one form (default 4). */
  inputHeightBandPx?: number;
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
  /** Timer-driven popups (toasts, pop-sale cards) that were hidden when the scan started. */
  timedWidgets?: { latent: number; appeared: number; waitedMs: number; selectors: string[] };
}

export interface VisualQualityScanResult {
  measured: boolean;
  /** Set when the touch-width rules were read from a responsive-sweep width because the tab itself is wider than 767px. */
  mobileSweepWidth?: number;
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
  /**
   * How long the floating pass waits for a hidden timer-driven popup (toast, pop-sale card) to
   * show before grading it; 0 disables. Pages without such a popup never wait.
   */
  timedWidgetWaitMs?: number;
}

export const VISUAL_QUALITY_DEFAULT_TIMED_WIDGET_WAIT_MS = 9000;

/** Eval deadline for a scan built with these options: the base budget plus the popup wait. */
export function visualQualityEvalTimeoutMs(options: VisualQualityScanOptions = {}): number {
  return 20_000 + timedWidgetWaitOf(options);
}

function timedWidgetWaitOf(options: VisualQualityScanOptions): number {
  if (options.skipFloating === true || options.skipPageEnd === true) return 0;
  const v = options.timedWidgetWaitMs;
  if (v === undefined) return VISUAL_QUALITY_DEFAULT_TIMED_WIDGET_WAIT_MS;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > VISUAL_QUALITY_DEFAULT_TIMED_WIDGET_WAIT_MS) {
    throw new Error(`visual-quality timedWidgetWaitMs must be 0..${VISUAL_QUALITY_DEFAULT_TIMED_WIDGET_WAIT_MS} ms, the eval budget leaves no room for more (got ${JSON.stringify(v)})`);
  }
  return Math.round(v);
}

export const VISUAL_QUALITY_LIMITS = Object.freeze({
  maxTextElements: 2500,
  maxControls: 1500,
  maxFindingsPerRule: 40,
  minContrastNormal: 4.5,
  minContrastLarge: 3,
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

const THRESHOLD_KEYS = ['minTextPx', 'minTapHitPx'] as const;

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
  const optionalScale = (value as unknown as Record<string, unknown> | null)?.titleScale;
  if (optionalScale !== undefined) {
    const scale = optionalScale as Record<string, unknown> | null;
    const normalized: Record<string, [number, number]> = {};
    for (const level of ['h1', 'h2', 'h3', 'h4']) {
      const range = scale ? scale[level] : undefined;
      if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) || (range[0] as number) > (range[1] as number)) {
        throw new Error('visual-quality thresholds.titleScale.' + level + ' must be [min, max] positive numbers (got ' + JSON.stringify(range) + ')');
      }
      normalized[level] = [range[0] as number, range[1] as number];
    }
    out.titleScale = normalized as unknown as number;
  }
  const band = (value as unknown as Record<string, unknown> | null)?.inputHeightBandPx;
  if (band !== undefined) {
    if (typeof band !== 'number' || !Number.isFinite(band) || band <= 0) {
      throw new Error('visual-quality thresholds.inputHeightBandPx must be a positive number (got ' + JSON.stringify(band) + ')');
    }
    out.inputHeightBandPx = band;
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
      timedWidgetWaitMs: timedWidgetWaitOf(options),
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
  if (TH) ['font-below-min', 'control-height-band', 'wrapped-label', 'icon-stroke-mismatch', 'overlay-fit', 'title-scale', 'input-height-band'].forEach(markMeasured);
  function rulesReport() {
    return { measuredRules: measuredRules.slice(), unmeasuredRules: ALL_RULES.filter((id) => !measuredRules.includes(id)) };
  }
  const PREVIEW_CHROME = ${JSON.stringify(`${PLATFORM_PREVIEW_CHROME}, [data-antifan-override]`)};

  function isPreviewChrome(el) {
    try { return !!(el && el.closest && el.closest(PREVIEW_CHROME)); } catch (e) { return false; }
  }
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.getAttribute('id')) return '#' + el.getAttribute('id');
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
  function fading(el) {
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (!(parseFloat(getComputedStyle(cur).opacity) < 1) || typeof cur.getAnimations !== 'function') continue;
      if (cur.getAnimations().some((a) => a.playState === 'running' && touchesOpacity(a))) return true;
    }
    return false;
  }
  function touchesOpacity(a) {
    if (typeof a.transitionProperty === 'string') return a.transitionProperty === 'opacity' || a.transitionProperty === 'all';
    try { return !!(a.effect && a.effect.getKeyframes().some((k) => 'opacity' in k)); } catch (e) { return false; }
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
    if (!backdrop || overMedia(el, r) || fg.a < 0.05 || (op < 1 && fading(el))) { stats.contrastIndeterminate++; continue; }
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
  if (mobile) {
    markMeasured('tap-target-tiny');
    for (const it of items) {
      const g = it.hit;
      const w = Math.round(g.width * 10) / 10;
      const h = Math.round(g.height * 10) / 10;
      if (Math.min(w, h) >= L.tapMinimumPx) continue;
      const sel = selectorOf(it.el);
      push({
        ruleId: 'tap-target-tiny',
        severity: 'warning',
        selector: sel,
        details: 'Tap target below the WCAG 2.2 24px minimum: ' + sel + ' is ' + w + 'x' + h + 'px' + (it.extended ? ' (including its pseudo-element hit area)' : ''),
        rect: rectOf(g),
        measured: { width: w, height: h, minimumPx: L.tapMinimumPx, pseudoHitArea: it.extended },
      }, 'tap|' + sel + '|' + Math.round(w) + 'x' + Math.round(h));
    }
  }

  if (TH) {
    // ---- control-height-band ----
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
      const named = POPUP_NAME.test(el.tagName + ' ' + (el.getAttribute('id') || '') + ' ' + (typeof el.className === 'string' ? el.className : ''));
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

    // ---- title-scale: heading sizes at touch widths ----
    if (vw <= 768) {
      const headingRows = [];
      for (const h of scope.querySelectorAll('h1, h2, h3, h4')) {
        if (isPreviewChrome(h) || hiddenFromAt(h)) continue;
        const hr = h.getBoundingClientRect();
        if (!rendered(h, hr) || visuallyHidden(h, hr) || offCanvas(hr) || !(h.textContent || '').trim()) continue;
        const landmark = h.closest('footer, header, [role="contentinfo"], [role="banner"]');
        const chrome = !!landmark && (landmark.matches('[role="contentinfo"], [role="banner"]') || !landmark.parentElement || !landmark.parentElement.closest('article, aside, main, nav, section, [role="main"]'));
        const px = parseFloat(getComputedStyle(h).fontSize);
        if (!(px > 0)) continue;
        const section = h.closest('section, [data-section-type], [id^="shopify-section"], [id^="section-"], .section');
        headingRows.push({ el: h, level: h.tagName.toLowerCase(), px: px, rect: hr, section: section, chrome: chrome });
      }
      if (TH.titleScale) {
        for (const row of headingRows) {
          const range = TH.titleScale[row.level];
          if (!range || (row.px >= range[0] - 0.01 && row.px <= range[1] + 0.01)) continue;
          const hsel = selectorOf(row.el);
          const own = Math.round(row.px * 10) / 10;
          push({
            ruleId: 'title-scale',
            severity: 'warning',
            selector: hsel,
            details: row.level.toUpperCase() + ' ' + hsel + ' is ' + own + 'px, outside the ' + range[0] + '-' + range[1] + 'px title scale at ' + vw + 'px viewport',
            rect: rectOf(row.rect),
            measured: { level: row.level, fontSizePx: own, minPx: range[0], maxPx: range[1] },
          }, 'title|' + hsel + '|' + own);
        }
      } else {
        for (const level of ['h1', 'h2', 'h3', 'h4']) {
          const rows = headingRows.filter((r) => r.level === level && !r.chrome);
          const bySection = new Map();
          for (const r of rows) if (!bySection.has(r.section)) bySection.set(r.section, r);
          if (bySection.size < 2) continue;
          const sizes = Array.from(bySection.values()).map((r) => r.px);
          if (Math.max.apply(null, sizes) - Math.min.apply(null, sizes) <= 2) continue;
          const tally = new Map();
          for (const s of sizes) { const k = Math.round(s * 2) / 2; tally.set(k, (tally.get(k) || 0) + 1); }
          let modal = null;
          tally.forEach((count, k) => { if (modal === null || count > tally.get(modal) || (count === tally.get(modal) && k > modal)) modal = k; });
          for (const r of bySection.values()) {
            if (Math.abs(r.px - modal) <= 2) continue;
            const hsel = selectorOf(r.el);
            const own = Math.round(r.px * 10) / 10;
            push({
              ruleId: 'title-scale',
              severity: 'warning',
              selector: hsel,
              details: level.toUpperCase() + ' ' + hsel + ' is ' + own + 'px while the same-level headings of other sections use ' + modal + 'px',
              rect: rectOf(r.rect),
              measured: { level: level, fontSizePx: own, modalPx: modal },
            }, 'title|' + hsel + '|' + own);
          }
        }
      }
    }

    // ---- input-height-band: fields of one form share one height ----
    const bandPx = TH.inputHeightBandPx || 4;
    const FIELD = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="file"]):not([type="range"]):not([type="color"]), select';
    for (const form of scope.querySelectorAll('form')) {
      if (isPreviewChrome(form)) continue;
      const fields = [];
      for (const f of form.querySelectorAll(FIELD)) {
        if (hiddenFromAt(f) || f.disabled) continue;
        const fr = f.getBoundingClientRect();
        if (!rendered(f, fr) || visuallyHidden(f, fr) || offCanvas(fr)) continue;
        fields.push({ el: f, rect: fr });
      }
      if (fields.length < 2) continue;
      const tallest = Math.max.apply(null, fields.map((f) => f.rect.height));
      for (const f of fields) {
        if (tallest - f.rect.height <= bandPx) continue;
        const fsel = selectorOf(f.el);
        const own = Math.round(f.rect.height * 10) / 10;
        push({
          ruleId: 'input-height-band',
          severity: 'warning',
          selector: fsel,
          details: 'Field ' + fsel + ' is ' + own + 'px tall but another field of the same form is ' + Math.round(tallest * 10) / 10 + 'px (allowed difference ' + bandPx + 'px)',
          rect: rectOf(f.rect),
          measured: { heightPx: own, tallestPx: Math.round(tallest * 10) / 10, bandPx: bandPx },
        }, 'input-band|' + fsel + '|' + Math.round(f.rect.height) + '|' + Math.round(tallest));
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
  const maxY = Math.max(0, (document.scrollingElement || html).scrollHeight - vh);
  const positions = OPTS.skipFloating ? [] : OPTS.skipPageEnd ? [startY] : maxY < 8 ? [0] : [0, maxY];
  if (positions.length) { markMeasured('floating-widget-overlap'); markMeasured('invisible-click-blocker'); }
  // A toast or notification card that is fixed but not painted yet is waiting for its timer (or
  // for a scroll that arms it); grading the page now would read it as absent. Modals, newsletter
  // popups and cookie sheets are dismissable overlays with their own probes and are not waited for.
  const TIMED_NAME = /pop-?sale|pop-?noti|toast|snackbar|notif/i;
  const latentTimedWidgets = () => {
    const out = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || isPreviewChrome(el)) continue;
      if (el.matches('dialog, [role="dialog"], [aria-modal="true"]')) continue;
      const role = el.getAttribute('role') || '';
      const name = el.tagName + ' ' + (el.getAttribute('id') || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
      if (!TIMED_NAME.test(name) && !/^(status|alert|log)$/.test(role)) continue;
      let nested = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).position === 'fixed') { nested = true; break; }
      }
      if (nested || !(el.textContent || '').trim() && !el.querySelector('img, a, button')) continue;
      const box = el.getBoundingClientRect();
      if (box.width * box.height > 0 && (box.width * box.height > vw * vh * L.floatingMaxViewportShare || box.width > vw * L.floatingMaxWidthShare)) continue;
      if (!paintedNow(el)) out.push(el);
    }
    return out;
  };
  const paintedNow = (el) => {
    const r = el.getBoundingClientRect();
    return rendered(el, r) && ancestorOpacity(el) >= 0.05 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  };
  const latent = positions.length > 1 && OPTS.timedWidgetWaitMs > 0 ? latentTimedWidgets() : [];
  if (latent.length) stats.timedWidgets = { latent: latent.length, appeared: 0, waitedMs: 0, selectors: latent.slice(0, 5).map(selectorOf) };
  const whereOf = (y) => (y === 0 ? 'page top' : y >= maxY ? 'page end' : 'scroll position ' + Math.round(y));
  const positionOf = (y) => (y === 0 ? 'top' : y >= maxY ? 'end' : 'current');
  const scanFloatingAt = (y) => {
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
  };
  const restoreScroll = () => {
    if (window.scrollX !== startX || window.scrollY !== startY) window.scrollTo(startX, startY);
    html.style.scrollBehavior = priorBehavior;
  };
  const result = () => ({
    measured: true,
    viewport: { width: vw, height: vh },
    mobile: mobile,
    findings: findings,
    stats: Object.assign(stats, { durationMs: Date.now() - started, truncated: truncatedReasons.length > 0, truncatedReasons: truncatedReasons }, rulesReport()),
  });
  if (!latent.length && !positions.some((y) => y !== window.scrollY)) {
    for (const y of positions) scanFloatingAt(y);
    return result();
  }
  // A scroll reaches the page's IntersectionObserver and scroll handlers only on the following
  // frames, so a widget the page hides when the footer comes into view is still painted in the
  // task that scrolled. Two frames let it react; then any finite transition or animation on a
  // fixed layer (a toast sliding out, or in) runs to its end state before the widget is graded.
  // Both waits are bounded because background tabs throttle frames and timers.
  const frame = () => {
    const wait = Promise.withResolvers();
    requestAnimationFrame(() => wait.resolve());
    return wait.promise;
  };
  const delay = (ms) => {
    const wait = Promise.withResolvers();
    setTimeout(wait.resolve, ms);
    return wait.promise;
  };
  const inFixedLayer = (node) => {
    for (let cur = node; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (getComputedStyle(cur).position === 'fixed') return true;
    }
    return false;
  };
  const fixedLayerMotion = () => {
    if (typeof document.getAnimations !== 'function') return [];
    return document.getAnimations().filter((a) => {
      if (a.playState !== 'running' || !a.effect || !a.effect.target) return false;
      const end = a.effect.getComputedTiming().endTime;
      return Number.isFinite(end) && inFixedLayer(a.effect.target);
    });
  };
  const settle = async () => {
    await Promise.race([frame().then(frame), delay(250)]);
    const motion = fixedLayerMotion();
    if (motion.length) await Promise.race([Promise.all(motion.map((a) => a.finished.catch(() => undefined))), delay(1000)]);
  };
  const awaitTimedWidget = async () => {
    // The first stop (one viewport down) arms popups that wait for a first scroll and stays clear
    // of the footer, which several themes use as the signal to put the popup away. A theme that
    // also keeps the popup hidden while it would cover content may never show it at one stop, so
    // the wait moves through a few stops before concluding the popup did not appear.
    const stops = [Math.min(maxY, vh), Math.round(maxY * 0.4), Math.round(maxY * 0.65), 0].filter((y, i, all) => all.indexOf(y) === i);
    const dwellMs = Math.max(1500, Math.floor(OPTS.timedWidgetWaitMs / stops.length));
    const t0 = Date.now();
    let at = -1;
    let shownAt = null;
    while (Date.now() - t0 < OPTS.timedWidgetWaitMs) {
      const next = Math.min(stops.length - 1, Math.floor((Date.now() - t0) / dwellMs));
      if (next !== at) {
        at = next;
        if (window.scrollY !== stops[at]) window.scrollTo(startX, stops[at]);
      }
      if (latent.some(paintedNow)) { shownAt = window.scrollY; break; }
      await delay(200);
    }
    stats.timedWidgets.waitedMs = Date.now() - t0;
    await settle();
    const shown = latent.filter(paintedNow);
    stats.timedWidgets.appeared = shown.length;
    if (!shown.length) {
      truncatedReasons.push('timed widget ' + stats.timedWidgets.selectors.join(', ') + ' stayed hidden for ' + OPTS.timedWidgetWaitMs + 'ms across ' + stops.length + ' scroll positions, so its overlap was not graded');
      return [];
    }
    return [shownAt === null ? window.scrollY : shownAt, ...stops.filter((y) => y !== 0)];
  };
  return (async () => {
    html.style.scrollBehavior = 'auto';
    try {
      const timedStops = latent.length ? await awaitTimedWidget() : [];
      const stops = [...timedStops, ...positions].filter((y, i, all) => all.indexOf(y) === i);
      for (const y of stops) {
        if (window.scrollY !== y) {
          window.scrollTo(startX, y);
          await settle();
        }
        scanFloatingAt(y);
      }
    } finally {
      restoreScroll();
    }
    return result();
  })();
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
