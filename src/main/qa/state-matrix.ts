/**
 * AntiFan Browser Desktop — interactive state matrix for overlays (drawers, modals, dropdowns,
 * mega menus).
 *
 * The static QA scan only measures a page at rest, so a cart drawer that opens clipped or never
 * closes on Escape passes it. This module drives each overlay through OPEN -> MEASURE -> CLOSE
 * with trusted input supplied by the caller (CDP clicks / key presses, never element.click()),
 * and measures every state in the page:
 *
 *   open:   rendered, effective opacity >= 0.95, visibility, pointer-events, minimum size,
 *           inside the viewport, not clipped by an ancestor, not occluded at its centre,
 *           no content spilling past the panel, scroll lock (modal/drawer), focus moved inside
 *           (modal/drawer), a close control present (modal/drawer); then the visual-quality
 *           scanner grades contrast and tap targets inside the open panel.
 *   close:  Escape, the close control and the backdrop are each tried from a fresh open; after
 *           each, the panel must be gone, the page scroll lock released and focus returned to
 *           the trigger. The closed state is re-read until it settles (a timer or rAF driven close
 *           is invisible to the animation settle). An Escape that left the panel open is sent once
 *           more: a close on the repeat is CLOSE_ESCAPE_FLAKY (warning), not a failure.
 *
 * Safe mode is always on: navigation from anchors and form submissions are blocked by
 * capture-phase listeners for the duration of the run (and the host refuses navigation a theme
 * script starts itself, reported as `blockedNavigations`), and add-to-cart / submit / foreign-origin
 * controls are never used as triggers. A panel that will not close by any method stops the run
 * (remaining triggers are reported NOT_RUN) instead of forcing classes back.
 */
import { VisualQualityScanner, type VisualQualityFinding } from './scanners/visual-quality-scanner';
import { PLATFORM_PREVIEW_CHROME } from './platform-preview-chrome';

export type StateMatrixKind = 'drawer' | 'modal' | 'dropdown' | 'megamenu';
export type StateMatrixCloseMethod = 'escape' | 'close-button' | 'backdrop';
/** Menus also close when the pointer leaves them; that attempt is internal to menu kinds. */
export type StateMatrixCloseAttemptMethod = StateMatrixCloseMethod | 'pointer-leave';

export type StateMatrixFailureCode =
  | 'TRIGGER_NOT_ACTIONABLE'
  | 'OVERLAY_NOT_OPENED'
  | 'OVERLAY_TOO_SMALL'
  | 'OVERLAY_OFFSCREEN'
  | 'OVERLAY_CLIPPED'
  | 'OVERLAY_TRANSPARENT'
  | 'OVERLAY_POINTER_EVENTS_NONE'
  | 'OVERLAY_OCCLUDED'
  | 'CONTENT_OVERFLOWS_PANEL'
  | 'SCROLL_NOT_LOCKED'
  | 'FOCUS_NOT_MOVED'
  | 'CLOSE_CONTROL_MISSING'
  | 'CLOSE_ESCAPE_FAILED'
  | 'CLOSE_ESCAPE_UNMEASURED'
  | 'CLOSE_ESCAPE_FLAKY'
  | 'MODAL_UNSTYLED'
  | 'CLOSE_BUTTON_FAILED'
  | 'CLOSE_BACKDROP_FAILED'
  | 'BODY_NOT_RESTORED'
  | 'FOCUS_NOT_RETURNED'
  | 'STATE_STUCK_OPEN';

export interface StateMatrixFailure {
  code: StateMatrixFailureCode;
  severity: 'critical' | 'warning';
  message: string;
}

export interface StateMatrixTriggerSpec {
  /** CSS selector of the control that opens the overlay. */
  selector: string;
  /** CSS selector of the overlay panel when discovery cannot resolve it. */
  panelSelector?: string;
  /** CSS selector of the close control inside the panel. */
  closeSelector?: string;
  kind?: StateMatrixKind;
}

export interface StateMatrixOptions {
  triggers?: StateMatrixTriggerSpec[];
  /** Upper bound on overlays exercised (default 8, max 12). */
  maxTriggers?: number;
  /** Wait after each open/close input (default 450ms, 100-2000). */
  settleMs?: number;
  closeMethods?: StateMatrixCloseMethod[];
  /** Grade contrast/tap targets inside each open panel (default true). */
  gradeVisualQuality?: boolean;
  /** `pdp` also opens size-guide, quick-view, share and review openers that sit inside the product form or card. */
  autoPopulate?: 'pdp';
}

export interface StateMatrixOpenMeasurement {
  opened: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
  effectiveOpacity: number;
  visibility: string;
  pointerEvents: string;
  withinViewport: boolean;
  clippedByAncestor: boolean;
  occluded: boolean;
  overflowingChildren: string[];
  scrollLocked: boolean;
  focusInside: boolean;
  closeControl: string | null;
  backdropPoint: { x: number; y: number } | null;
  /** The panel actually measured (resolved at open time when discovery could not name it). */
  panelSelector?: string | null;
}

export interface StateMatrixCloseAttempt {
  method: StateMatrixCloseAttemptMethod;
  closed: boolean;
  bodyRestored: boolean;
  focusReturned: boolean;
  skipped?: string;
}

export interface StateMatrixTriggerResult {
  index: number;
  trigger: string;
  panel: string | null;
  kind: StateMatrixKind;
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'NOT_RUN';
  failures: StateMatrixFailure[];
  open?: StateMatrixOpenMeasurement;
  closes: StateMatrixCloseAttempt[];
  visualQuality?: VisualQualityFinding[];
}

export interface StateMatrixResult {
  measured: boolean;
  safeMode: true;
  viewport: { width: number; height: number };
  triggers: StateMatrixTriggerResult[];
  summary: { total: number; passed: number; warned: number; failed: number; notRun: number; criticalCount: number };
  skippedTriggers: Array<{ selector: string; reason: string }>;
  durationMs: number;
  error?: string;
  /** Pages a trigger's own script tried to open (origin + path); the host refused each. */
  blockedNavigations?: string[];
}

/** Trusted-input and evaluation seams; the port wires them to CDP-backed automation. */
export interface StateMatrixDeps {
  evalJs(script: string): Promise<unknown>;
  click(selector: string): Promise<{ ok: boolean; error?: string }>;
  clickAt(x: number, y: number): Promise<{ ok: boolean; error?: string }>;
  hover(selector: string): Promise<{ ok: boolean; error?: string }>;
  hoverAt(x: number, y: number): Promise<{ ok: boolean; error?: string }>;
  pressKey(key: string): Promise<{ ok: boolean; error?: string }>;
  wait(ms: number): Promise<void>;
  now?(): number;
}

export const STATE_MATRIX_LIMITS = Object.freeze({
  defaultMaxTriggers: 8,
  hardMaxTriggers: 12,
  defaultSettleMs: 450,
  minSettleMs: 100,
  maxSettleMs: 2000,
  minOpacity: 0.95,
  /** Upper bound on waiting for open/close transitions to finish after each input. */
  maxAnimationSettleMs: 1500,
  /** Extra measurement turns before an overlay is declared unopened (script-driven openings). */
  openPollTurns: 8,
  openPollIntervalMs: 250,
  /**
   * Run-wide budget for re-reading "is it closed yet" after a close input: a page whose overlay
   * never closes must not eat the workflow deadline, so once spent each read is a single sample.
   */
  closePollBudgetMs: 8000,
  minPanelPx: { modal: { w: 200, h: 120 }, drawer: { w: 200, h: 120 }, dropdown: { w: 120, h: 40 }, megamenu: { w: 200, h: 80 } },
});

const CRITICAL_CODES: ReadonlySet<StateMatrixFailureCode> = new Set([
  'TRIGGER_NOT_ACTIONABLE',
  'OVERLAY_NOT_OPENED',
  'OVERLAY_TOO_SMALL',
  'OVERLAY_OFFSCREEN',
  'OVERLAY_CLIPPED',
  'OVERLAY_TRANSPARENT',
  'OVERLAY_POINTER_EVENTS_NONE',
  'OVERLAY_OCCLUDED',
  'CONTENT_OVERFLOWS_PANEL',
  'CLOSE_CONTROL_MISSING',
  'MODAL_UNSTYLED',
  'CLOSE_ESCAPE_FAILED',
  'CLOSE_BUTTON_FAILED',
  'BODY_NOT_RESTORED',
  'STATE_STUCK_OPEN',
]);

/** Escape and a close control are hard requirements only for dialogs; menus degrade to warnings. */
export function failureSeverity(code: StateMatrixFailureCode, kind: StateMatrixKind): 'critical' | 'warning' {
  if (!CRITICAL_CODES.has(code)) return 'warning';
  if ((kind === 'dropdown' || kind === 'megamenu') && (code === 'CLOSE_ESCAPE_FAILED' || code === 'CLOSE_CONTROL_MISSING' || code === 'CLOSE_BUTTON_FAILED' || code === 'MODAL_UNSTYLED')) {
    return 'warning';
  }
  return 'critical';
}

const SM_TRIGGER = 'data-antifan-sm-trigger';
const SM_PANEL = 'data-antifan-sm-panel';
const SM_CLOSE = 'data-antifan-sm-close';
/** The visible dialog box inside a full-viewport panel wrapper. */
const SM_BOX = 'data-antifan-sm-box';
export const smTriggerSelector = (i: number) => `[${SM_TRIGGER}="${i}"]`;
export const smPanelSelector = (i: number) => `[${SM_PANEL}="${i}"]`;
export const smCloseSelector = (i: number) => `[${SM_CLOSE}="${i}"]`;

/** Shared in-page helpers (closest-style lookups, visibility maths). */
const PAGE_HELPERS = String.raw`
  const PREVIEW_CHROME = ${JSON.stringify(PLATFORM_PREVIEW_CHROME)};
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.getAttribute('id')) return '#' + el.getAttribute('id');
    let sel = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).filter((c) => c && !c.includes(':')).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
    }
    return sel;
  };
  const effectiveOpacity = (el) => {
    let op = 1;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const v = parseFloat(getComputedStyle(cur).opacity);
      if (!isNaN(v)) op *= v;
    }
    return op;
  };
  const effectivePointerEvents = (el) => {
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const pe = getComputedStyle(cur).pointerEvents;
      if (pe === 'none') return 'none';
    }
    return 'auto';
  };
  const displayed = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.hasAttribute('hidden')) return false;
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isOpen = (panel) => {
    if (!displayed(panel)) return false;
    if (effectiveOpacity(panel) < 0.05) return false;
    const r = panel.getBoundingClientRect();
    // Parked off-canvas (translateX(100%)) counts as closed.
    if (r.right <= 1 || r.left >= window.innerWidth - 1 || r.bottom <= 1 || r.top >= window.innerHeight - 1) return false;
    return true;
  };
  const scrollLocked = () => {
    const b = getComputedStyle(document.body);
    const h = getComputedStyle(document.documentElement);
    return b.overflow === 'hidden' || b.overflowY === 'hidden' || h.overflow === 'hidden' || h.overflowY === 'hidden' || b.position === 'fixed';
  };
  const CLOSE_CONTROL = '[data-modal-close], [data-drawer-close], [data-close], [data-dismiss], [data-bs-dismiss], [data-action*="close"], button[aria-label*="Đóng" i], button[aria-label*="Close" i], button[class*="close"], a[class*="close"], [role="button"][class*="close"], button[title*="Đóng" i], button[title*="Close" i]';
  const LAYER_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open], [class*="drawer"], [class*="modal"], [class*="popup"], [class*="offcanvas"], [class*="sidebar"], [class*="dropdown"], [class*="megamenu"], [class*="mega-menu"], [role="menu"]';
  const PREOPEN = 'data-antifan-sm-preopen';
`;

/**
 * Discover overlay triggers, tag triggers/panels/close controls with data attributes, and install
 * the safe-mode navigation guard. Returns the tagged list.
 */
export function buildDiscoverScript(specs: StateMatrixTriggerSpec[], maxTriggers: number, autoPopulate?: 'pdp'): string {
  return `(() => {
  ${PAGE_HELPERS}
  const SPECS = ${JSON.stringify(specs)};
  const MAX = ${JSON.stringify(maxTriggers)};
  const PDP = ${JSON.stringify(autoPopulate === 'pdp')};
  // Safe mode: block real navigation and submissions for the whole run; theme handlers still run.
  if (!window.__antifanStateMatrixGuard) {
    const onClick = (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = (a.getAttribute('href') || '').trim();
      if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) e.preventDefault();
    };
    const onSubmit = (e) => e.preventDefault();
    window.addEventListener('click', onClick, true);
    window.addEventListener('submit', onSubmit, true);
    window.__antifanStateMatrixGuard = { onClick, onSubmit, scrollX: window.scrollX, scrollY: window.scrollY };
  }
  for (const attr of ['${SM_TRIGGER}', '${SM_PANEL}', '${SM_CLOSE}', '${SM_BOX}']) {
    document.querySelectorAll('[' + attr + ']').forEach((n) => n.removeAttribute(attr));
  }
  const UNSAFE = 'button[type="submit"], input[type="submit"], [name="add" i], [data-add-to-cart], [data-variant-id], [class*="add-to-cart" i], [class*="addtocart" i], [class*="add-cart" i], [class*="addcart" i], [class*="buy-now" i], [class*="buynow" i], [class*="wishlist-add" i], [class*="add-wishlist" i], form[action*="/cart/add" i] *, form[action*="/checkout" i] *, a[href*="/checkout" i], a[href*="/account/logout" i]';
  // Wording that means the control changes store or account state, whatever its markup says.
  const UNSAFE_TEXT = /th[eê]m\\s*(.*v[aà]o\\s*)?(gi[oỏ]|y[eê]u\\s*th[ií]ch)|cho\\s*v[aà]o\\s*gi[oỏ]|add\\s*(.*to\\s*)?(cart|bag|wishlist)|(^|\\s)(mua|đặt\\s*mua|ch[oọ]n\\s*mua|tr[aả]\\s*g[oó]p)(\\s|$)|buy\\s*now|đặt\\s*hàng|dat\\s*hang|thanh\\s*to[aá]n|checkout|đăng\\s*xuất|log\\s*out|sign\\s*out|x[oó]a|remove|delete|hủy\\s*đơn/i;
  // Heuristic (ARIA-less) openers are only trusted in page chrome, never inside product context,
  // where an icon-only "cart" button is an add-to-cart.
  const CHROME_REGION = 'header, nav, [role="banner"], [role="navigation"], [class*="header" i], [class*="topbar" i], [class*="navbar" i], [class*="mobar" i], [class*="bottom-nav" i], [class*="toolbar" i]';
  const PRODUCT_CONTEXT = 'form, [data-variant], [data-variant-id], [data-product], [data-product-id], [data-product-handle], [class*="product" i], [class*="card" i]';
  const textOf = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();
  // Storefront overlay openers that carry no ARIA wiring: buttons only (never links), matched by
  // the words themes use for drawers and dialogs.
  const OPENER_WORDS = /\\b(cart|minicart|gi[oỏ]\\s*h[aà]ng|menu|burger|hamburger|search|t[iì]m\\s*ki[eế]m|filter|l[oọ]c|account|t[aà]i\\s*kho[aả]n|quick\\s*view|xem\\s*nhanh|size\\s*guide|b[aả]ng\\s*size|share|chia\\s*s[eẻ]|notification|th[oô]ng\\s*b[aá]o)\\b/i;
  // Product-page openers sit inside the cart form or a product card, which the chrome-only
  // heuristic above skips. Only inert openers qualify, and the form clauses of UNSAFE are lifted
  // for them because a size guide button inside the cart form is not an add-to-cart.
  const PDP_OPENER_WORDS = /size\\s*guide|b[aả]ng\\s*size|h[uư][oớ]ng\\s*d[aẫ]n\\s*ch[oọ]n\\s*size|xem\\s*nhanh|quick\\s*view|\\bshare\\b|chia\\s*s[eẻ]|đánh\\s*giá|\\breviews?\\b/i;
  const UNSAFE_CORE = 'button[type="submit"], input[type="submit"], [name="add" i], [data-add-to-cart], [data-variant-id], [class*="add-to-cart" i], [class*="addtocart" i], [class*="add-cart" i], [class*="addcart" i], [class*="buy-now" i], [class*="buynow" i], [class*="wishlist-add" i], [class*="add-wishlist" i], a[href*="/checkout" i], a[href*="/account/logout" i]';
  const sameOrigin = (el) => {
    if (el.tagName !== 'A') return true;
    const href = el.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return true;
    try { return new URL(href, location.href).origin === location.origin; } catch (e) { return false; }
  };
  const resolvePanel = (trigger) => {
    const attr = trigger.getAttribute('aria-controls') || trigger.getAttribute('data-modal-target') || trigger.getAttribute('data-drawer-target') || trigger.getAttribute('data-target') || trigger.getAttribute('data-bs-target');
    if (attr) {
      const id = attr.replace(/^#/, '').trim();
      let byId = null;
      try { byId = document.getElementById(id) || document.querySelector(attr.startsWith('.') || attr.startsWith('#') ? attr : '#' + id); } catch (e) {}
      if (byId) return byId;
    }
    for (const a of Array.from(trigger.attributes || [])) {
      if (/^data-.*-open$/i.test(a.name)) {
        const token = (a.value || a.name.replace(/^data-|-open$/gi, '')).replace(/^#/, '');
        let found = null;
        try { found = document.getElementById(token) || document.getElementById(token + '-modal') || document.getElementById(token + '-drawer') || document.querySelector('[data-modal="' + token + '"], [data-drawer="' + token + '"]'); } catch (e) {}
        if (found) return found;
      }
    }
    const item = trigger.closest('li, [class*="nav-item"], [class*="menu-item"], [data-megamenu]');
    if (item) {
      // The trigger's own parts (".megamenu__label" inside ".megamenu__link") match the same class
      // fragments; the panel is a node outside the trigger.
      const subs = item.querySelectorAll('[class*="megamenu"], [class*="mega-menu"], [class*="dropdown"], [class*="submenu"], [class*="sub-menu"], [role="menu"]');
      for (const sub of Array.from(subs)) if (sub !== trigger && !trigger.contains(sub) && !sub.contains(trigger)) return sub;
    }
    return null;
  };
  const classify = (trigger, panel) => {
    // The panel's own class/role decides first; the trigger's wording is only a fallback.
    const fromSig = (sig) => {
      if (sig.includes('mega')) return 'megamenu';
      if (sig.includes('dropdown') || sig.includes('submenu') || sig.includes('sub-menu') || / role:menu /.test(sig)) return 'dropdown';
      if (sig.includes('drawer') || sig.includes('sidebar') || sig.includes('offcanvas')) return 'drawer';
      if (sig.includes('modal') || sig.includes('popup') || sig.includes('quickview') || / role:dialog /.test(sig) || sig.includes(' tag:dialog ')) return 'modal';
      return null;
    };
    const panelSig = panel ? (' ' + (panel.getAttribute('id') || '') + ' ' + (typeof panel.className === 'string' ? panel.className : '') + ' role:' + (panel.getAttribute('role') || '') + ' tag:' + panel.tagName.toLowerCase() + ' ').toLowerCase() : '';
    const triggerSig = (' ' + (typeof trigger.className === 'string' ? trigger.className : '') + ' ' + (trigger.getAttribute('aria-label') || '') + ' ').toLowerCase();
    const byPanel = panelSig ? fromSig(panelSig) : null;
    if (byPanel) return byPanel;
    const byTrigger = fromSig(triggerSig);
    if (byTrigger) return byTrigger;
    return /cart|menu|filter|search/.test(triggerSig) ? 'drawer' : 'modal';
  };
  const visibleTrigger = (el) => {
    if (!displayed(el) || effectiveOpacity(el) < 0.05) return false;
    const r = el.getBoundingClientRect();
    const docTop = r.top + window.scrollY;
    return r.right > 0 && r.left < window.innerWidth && docTop + r.height > 0;
  };
  const candidates = [];
  const skipped = [];
  if (SPECS.length) {
    for (const spec of SPECS) {
      let el = null;
      try { el = document.querySelector(spec.selector); } catch (e) {}
      if (!el) { skipped.push({ selector: spec.selector, reason: 'SELECTOR_NOT_FOUND' }); continue; }
      let panel = null;
      if (spec.panelSelector) { try { panel = document.querySelector(spec.panelSelector); } catch (e) {} }
      candidates.push({ el, panel: panel || resolvePanel(el), spec });
    }
  } else {
    const all = document.body ? document.body.querySelectorAll('button, a, [role="button"], summary, [aria-haspopup], [aria-controls], [data-action]') : [];
    for (const el of all) {
      if (el.closest(PREVIEW_CHROME)) continue;
      let isTrigger = false;
      for (const a of Array.from(el.attributes || [])) if (/^data-.*-open$/i.test(a.name)) { isTrigger = true; break; }
      const action = el.getAttribute('data-action') || '';
      if (!isTrigger && /(?:^|\\s)(?:open|toggle)-[a-z0-9_-]+/i.test(action)) isTrigger = true;
      if (!isTrigger && (el.hasAttribute('data-modal-target') || el.hasAttribute('data-drawer-target') || el.hasAttribute('data-open-modal'))) isTrigger = true;
      if (!isTrigger && el.hasAttribute('aria-controls')) {
        const c = document.getElementById(el.getAttribute('aria-controls'));
        if (c && /modal|drawer|dialog|menu|cart|search|filter|sidebar|offcanvas|popup|quick/i.test(c.id + ' ' + c.className + ' ' + (c.getAttribute('role') || ''))) isTrigger = true;
      }
      if (!isTrigger) {
        const hp = el.getAttribute('aria-haspopup');
        if (hp === 'true' || hp === 'dialog' || hp === 'menu') isTrigger = true;
      }
      if (!isTrigger && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && !el.hasAttribute('aria-pressed') && el.closest(CHROME_REGION) && !el.closest(PRODUCT_CONTEXT)) {
        const sig = (typeof el.className === 'string' ? el.className.replace(/[-_]+/g, ' ') : '') + ' ' + textOf(el);
        if (OPENER_WORDS.test(sig)) isTrigger = true;
      }
      let pdpOpener = false;
      if (!isTrigger && PDP) {
        const words = textOf(el);
        const href = el.getAttribute('href');
        const inert = el.tagName !== 'A' || !href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:');
        // A <summary> of a native <details> whose content stays in normal flow expands in place and
        // never opens an overlay. Themes that build modals, drawers or popovers on <details>
        // (details-modal, menu-drawer, a positioned share popover) keep the summary as an opener.
        let disclosure = false;
        const det = el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS' ? el.parentElement : null;
        if (det && !det.closest('details-modal, menu-drawer, header-drawer, [role="dialog"], [aria-modal="true"]')) {
          disclosure = true;
          for (const child of Array.from(det.children)) {
            if (child === el) continue;
            const pos = getComputedStyle(child).position;
            if (pos === 'fixed' || pos === 'absolute') { disclosure = false; break; }
          }
        }
        if (inert && !disclosure && words.length <= 80 && PDP_OPENER_WORDS.test(words)) { isTrigger = true; pdpOpener = true; }
      }
      if (isTrigger) candidates.push({ el, panel: resolvePanel(el), spec: null, pdp: pdpOpener });
    }
  }
  const out = [];
  const seenPanels = new Set();
  const seenActions = new Set();
  for (const c of candidates) {
    if (out.length >= MAX) { skipped.push({ selector: selectorOf(c.el), reason: 'MAX_TRIGGERS' }); continue; }
    const sel = selectorOf(c.el);
    if (c.el.matches(c.pdp ? UNSAFE_CORE : UNSAFE) || UNSAFE_TEXT.test(textOf(c.el)) || !sameOrigin(c.el)) { skipped.push({ selector: sel, reason: 'UNSAFE_TRIGGER' }); continue; }
    if (!visibleTrigger(c.el)) { skipped.push({ selector: sel, reason: 'TRIGGER_NOT_VISIBLE' }); continue; }
    if (c.panel && seenPanels.has(c.panel)) { skipped.push({ selector: sel, reason: 'DUPLICATE_PANEL' }); continue; }
    const action = !c.panel && !c.spec ? c.el.getAttribute('data-action') : null;
    if (action) {
      const key = c.el.tagName + '|' + action;
      if (seenActions.has(key)) { skipped.push({ selector: sel, reason: 'DUPLICATE_ACTION' }); continue; }
      seenActions.add(key);
    }
    if (c.panel && isOpen(c.panel)) { skipped.push({ selector: sel, reason: 'PANEL_ALREADY_OPEN' }); continue; }
    const i = out.length;
    c.el.setAttribute('${SM_TRIGGER}', String(i));
    if (c.panel) { c.panel.setAttribute('${SM_PANEL}', String(i)); seenPanels.add(c.panel); }
    const kind = (c.spec && c.spec.kind) || classify(c.el, c.panel);
    const label = ((c.el.getAttribute('aria-label') || c.el.innerText || c.el.getAttribute('title') || '') + '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    out.push({ index: i, trigger: sel, panel: c.panel ? selectorOf(c.panel) : null, kind, label, closeSelector: c.spec && c.spec.closeSelector ? c.spec.closeSelector : null });
  }
  return { ok: true, viewport: { width: window.innerWidth, height: window.innerHeight }, triggers: out, skipped };
})()`;
}

/**
 * Scroll the trigger into view and record the at-rest state the close must restore. The rest
 * state is recorded only before a trigger's first open: a re-open after a close that leaked the
 * scroll lock must not adopt the leaked lock as the new baseline.
 */
export function buildPrepareScript(index: number, recordRest = true): string {
  return `(() => {
  ${PAGE_HELPERS}
  const t = document.querySelector('${smTriggerSelector(index)}');
  if (!t) return { ok: false, reason: 'TRIGGER_GONE' };
  // The platform preview bar (Haravan ?themeid=) is shown to the merchant only; a shopper never
  // sees it, so it must not cover a bottom dock the run clicks.
  if (!document.getElementById('__antifan_sm_preview_chrome__')) {
    const st = document.createElement('style');
    st.id = '__antifan_sm_preview_chrome__';
    st.textContent = PREVIEW_CHROME + ' { display: none !important; pointer-events: none !important; }';
    (document.head || document.documentElement).appendChild(st);
  }
  t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  // Layers already open before the click (a notification popup, a sticky widget) can never be
  // the panel this trigger opens; mark them so the open measurement skips them.
  document.querySelectorAll('[' + PREOPEN + ']').forEach((n) => n.removeAttribute(PREOPEN));
  document.querySelectorAll(LAYER_SELECTOR).forEach((el) => { if (!el.closest(PREVIEW_CHROME) && isOpen(el)) el.setAttribute(PREOPEN, '1'); });
  if (${JSON.stringify(recordRest)} || !window.__antifanStateMatrixRest) window.__antifanStateMatrixRest = { scrollLocked: scrollLocked() };
  return { ok: true, scrollLocked: window.__antifanStateMatrixRest.scrollLocked };
})()`;
}

/**
 * After a click that opened nothing measurable: is the page free of a scroll lock it did not
 * have at rest? A page that was already locked (a first-visit popup) and is now unlocked
 * (the click dismissed it) is not stuck.
 */
export function buildRestCheckScript(): string {
  return `(() => {
  ${PAGE_HELPERS}
  const rest = window.__antifanStateMatrixRest || { scrollLocked: false };
  return { restored: !scrollLocked() || rest.scrollLocked };
})()`;
}

/**
 * Wait (bounded) for the finite CSS transitions/animations running after an input to finish, so
 * a drawer is measured where it lands rather than mid-slide. Infinite animations (spinners,
 * marquees) and ones that cannot finish within the bound (slideshow timers) are not waited on.
 */
export function buildSettleAnimationsScript(maxMs: number): string {
  return `(async () => {
  const until = Date.now() + ${JSON.stringify(Math.max(0, Math.round(maxMs)))};
  const finishing = (a) => {
    try {
      if (a.playState !== 'running' || !a.effect || typeof a.effect.getComputedTiming !== 'function') return false;
      const t = a.effect.getComputedTiming();
      if (!Number.isFinite(t.endTime)) return false;
      const remaining = (t.endTime - (Number(a.currentTime) || 0)) / Math.abs(a.playbackRate || 1);
      return remaining <= until - Date.now();
    } catch (e) { return false; }
  };
  const runningNow = () => (typeof document.getAnimations === 'function' ? document.getAnimations() : []).filter(finishing);
  // One frame (bounded: a non-painting page never runs it), then a macrotask, so transitionend
  // handlers and timer-driven steps get to start whatever comes next.
  const turn = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), new Promise((r) => setTimeout(r, 50))])
    .then(() => new Promise((r) => setTimeout(r, 30)));
  let waited = 0;
  // Chained openings are common (Bootstrap fades the backdrop, then shows the dialog on its
  // transitionend, then fades the dialog): settled means quiet across a full turn.
  while (Date.now() < until) {
    const running = runningNow();
    if (running.length) {
      waited += running.length;
      await Promise.race([Promise.allSettled(running.map((a) => a.finished)), new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())))]);
      continue;
    }
    await turn();
    if (!runningNow().length) return { settled: true, waited };
  }
  return { settled: false, waited, running: runningNow().length };
})()`;
}

/** Measure the open state; also resolves (and tags) the panel when discovery could not. */
export function buildMeasureOpenScript(index: number, kind: StateMatrixKind, closeSelector: string | null): string {
  const minSize = STATE_MATRIX_LIMITS.minPanelPx[kind];
  return `(() => {
  ${PAGE_HELPERS}
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const trigger = document.querySelector('${smTriggerSelector(index)}');
  let panel = document.querySelector('${smPanelSelector(index)}');
  if (panel && !isOpen(panel)) {
    // A tagged wrapper may stay put while an inner panel animates in: prefer an open descendant.
    const inner = panel.querySelector('[role="dialog"], [aria-modal="true"], [class*="__panel"], [class*="-panel"], [class*="__content"], [class*="-content"], [class*="__inner"], [class*="drawer"], [class*="modal"]');
    if (inner && isOpen(inner)) panel = inner;
  }
  if (!panel || (!isOpen(panel) && ${JSON.stringify(kind !== 'megamenu' && kind !== 'dropdown')})) {
    // Discovery had no panel: take the newest dialog-like layer this click opened. Layers that
    // were open before the click are excluded, so a resident popup is never mistaken for it. A
    // menu whose own panel stays shut is unopened: the layer that appeared meanwhile is a timed
    // popup, not this menu.
    const layers = Array.from(document.querySelectorAll(LAYER_SELECTOR))
      .filter((el) => !el.closest(PREVIEW_CHROME) && !el.closest('[' + PREOPEN + ']') && isOpen(el))
      .filter((el) => { const cs = getComputedStyle(el); return cs.position === 'fixed' || cs.position === 'absolute' || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG'; });
    // Backdrops and scrims match the same class fragments but are not the panel. A wrapper named
    // "overlay" that is itself the dialog or holds the close control is the panel, not a scrim.
    const BACKDROP = /backdrop|overlay|overplay|scrim|mask|shade|dimmer/i;
    const scrim = (el) => BACKDROP.test(typeof el.className === 'string' ? el.className : '') && el.getAttribute('role') !== 'dialog' && el.getAttribute('aria-modal') !== 'true' && el.tagName !== 'DIALOG' && !el.querySelector(CLOSE_CONTROL);
    const candidates = layers.filter((el) => !scrim(el));
    // Class fragments also match a panel's own parts (".drawer__close" is absolutely positioned
    // inside ".drawer"): keep only outermost layers. Prefer the layer holding focus, then the one
    // holding a close control, then the largest.
    const outermost = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
    const active = document.activeElement;
    const score = (el) => {
      const b = el.getBoundingClientRect();
      return (active && active !== document.body && el.contains(active) ? 4e8 : 0) + (el.querySelector(CLOSE_CONTROL) ? 2e8 : 0) + b.width * b.height;
    };
    outermost.sort((a, b) => score(b) - score(a));
    panel = outermost.length ? outermost[0] : null;
  }
  if (!panel) return { opened: false, rect: null, effectiveOpacity: 0, visibility: 'hidden', pointerEvents: 'none', withinViewport: false, clippedByAncestor: false, occluded: false, overflowingChildren: [], scrollLocked: scrollLocked(), focusInside: false, closeControl: null, backdropPoint: null, panelSelector: null };
  // One tag per trigger: a stale tag on a wrapper would make the close check read the wrong node.
  document.querySelectorAll('${smPanelSelector(index)}').forEach((n) => { if (n !== panel) n.removeAttribute('${SM_PANEL}'); });
  panel.setAttribute('${SM_PANEL}', '${index}');
  const r = panel.getBoundingClientRect();
  const cs = getComputedStyle(panel);
  const op = effectiveOpacity(panel);
  const opened = displayed(panel) && op >= 0.05;
  let clipped = false;
  for (let cur = panel.parentElement; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
    const pcs = getComputedStyle(cur);
    const clipX = pcs.overflowX !== 'visible';
    const clipY = pcs.overflowY === 'hidden' || pcs.overflowY === 'clip';
    if (clipX || clipY) {
      const cr = cur.getBoundingClientRect();
      if ((clipX && (r.right > cr.right + 2 || r.left < cr.left - 2)) || (clipY && (r.bottom > cr.bottom + 2 || r.top < cr.top - 2))) { clipped = true; break; }
    }
  }
  // Sapo's admin-session script (content_for_header, logged-in admins only) adds 40px to the inline
  // top of every fixed element on window.onload; customers never get that shift.
  const adminShift = Array.from(document.scripts).some((s) => !s.src && s.textContent.includes('function doShift(down)') && s.textContent.includes('admin_bar_iframe')) && /(^|;)\\s*top:\\s*-?\\d/.test(panel.getAttribute('style') || '') ? 40 : 0;
  const within = r.left >= -1 && r.top - adminShift >= -1 && r.right <= vw + 1 && r.bottom - adminShift <= vh + 1;
  let occluded = false;
  const cx = Math.floor(Math.max(0, Math.min(vw - 1, r.left + r.width / 2)));
  const cy = Math.floor(Math.max(0, Math.min(vh - 1, r.top + Math.min(r.height / 2, 120))));
  const hit = document.elementFromPoint(cx, cy);
  if (hit && !panel.contains(hit) && !hit.contains(panel)) occluded = true;
  const spill = [];
  // A panel that clips its own overflow (parked sub-menus at translateX(100%)) hides what sticks
  // out; only a panel with visible overflow can spill.
  const kids = cs.overflowX === 'visible' ? panel.querySelectorAll('*') : [];
  for (let k = 0; k < kids.length && spill.length < 6; k++) {
    const el = kids[k];
    const kr = el.getBoundingClientRect();
    if (kr.width <= 0 || kr.height <= 0) continue;
    if (kr.right <= r.right + 2 && kr.left >= r.left - 2) continue;
    // Content inside a horizontal scroller is reachable; only unscrollable spill counts.
    let scroller = false;
    for (let p = el.parentElement; p && p !== panel; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') { scroller = true; break; }
    }
    if (!scroller && displayed(el)) spill.push(selectorOf(el) + ' (' + Math.round(kr.left) + '..' + Math.round(kr.right) + ' vs panel ' + Math.round(r.left) + '..' + Math.round(r.right) + ')');
  }
  // A visible-overflow panel shows the spill; a scrolling panel (overflow-y:auto computes
  // overflow-x to auto) turns it into a sideways scroll inside the drawer. Only hidden/clip
  // panels legitimately park content outside their box.
  if (panel.scrollWidth > panel.clientWidth + 2 && (cs.overflowX === 'visible' || cs.overflowX === 'auto' || cs.overflowX === 'scroll')) {
    spill.push(selectorOf(panel) + (cs.overflowX === 'visible' ? ' scrollWidth ' : ' scrolls sideways: scrollWidth ') + panel.scrollWidth + ' > ' + panel.clientWidth);
  }
  const BACKDROP_CLASS = /backdrop|overlay|overplay|scrim|mask|shade|dimmer/i;
  const coversViewport = (c) => { const b = c.getBoundingClientRect(); return b.width >= vw * 0.9 && b.height >= vh * 0.9; };
  let close = null;
  const explicit = ${JSON.stringify(closeSelector)};
  if (explicit) { try { close = document.querySelector(explicit); } catch (e) {} }
  if (!close) {
    // A full-viewport button named "close" is the backdrop in disguise; it is graded under the
    // backdrop method only, never taken as the panel's close control.
    const cands = Array.from(panel.querySelectorAll(CLOSE_CONTROL)).concat(Array.from(document.querySelectorAll(CLOSE_CONTROL)).filter((c) => !panel.contains(c)));
    const usable = (c) => displayed(c) && effectiveOpacity(c) > 0.05 && (panel.contains(c) || c.closest('[${SM_PANEL}]')) && !coversViewport(c) && !(BACKDROP_CLASS.test(typeof c.className === 'string' ? c.className : '') && !panel.contains(c));
    close = cands.find(usable) || null;
  }
  document.querySelectorAll('[${SM_CLOSE}]').forEach((n) => n.removeAttribute('${SM_CLOSE}'));
  if (close) close.setAttribute('${SM_CLOSE}', '${index}');
  // A full-viewport wrapper (Bootstrap ".modal") is its own backdrop around a smaller dialog box
  // (".modal-dialog"): the uncovered strips are measured around that box.
  let box = panel;
  if (r.width >= vw * 0.9 && r.height >= vh * 0.9) {
    let inner = panel.querySelector('.modal-dialog, .modal-content, [role="document"], [class*="__dialog"], [class*="-dialog"], [class*="__content"], [class*="__inner"], [class*="__panel"]');
    // The match can be a part inside the card (".sky-account-modal__panel" is a tab pane inside an
    // unnamed ".sky-modal-card"): the dialog box is the wrapper's child that holds it.
    while (inner && inner.parentElement && inner.parentElement !== panel) inner = inner.parentElement;
    // An opaque full-viewport panel is a full-screen sheet (mobile drawer at 375px): it has no
    // backdrop, so its painted header/footer strips are never taken as the dialog box.
    const panelBg = cs.backgroundColor;
    const panelPainted = panelBg !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(panelBg);
    if (!inner && !panelPainted) {
      // Unnamed card (".sky-modal-card" beside a backdrop button): the painted child that does not
      // cover the viewport and is not the scrim.
      const painted = Array.from(panel.children).filter((c) => {
        const bg = getComputedStyle(c).backgroundColor;
        return displayed(c) && bg !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(bg) && !coversViewport(c) && !BACKDROP_CLASS.test(typeof c.className === 'string' ? c.className : '');
      });
      painted.sort((a, b) => { const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; });
      inner = painted[0] || null;
    }
    if (inner) {
      const ir = inner.getBoundingClientRect();
      if (ir.width > 0 && ir.height > 0 && ir.width * ir.height < r.width * r.height * 0.8) box = inner;
    }
  }
  document.querySelectorAll('[${SM_BOX}]').forEach((n) => n.removeAttribute('${SM_BOX}'));
  if (box !== panel) box.setAttribute('${SM_BOX}', '${index}');
  const br = box.getBoundingClientRect();
  // A point on the backdrop: the widest strip of viewport the visible box leaves uncovered.
  let backdrop = null;
  const strips = [
    { x: br.left / 2, y: vh / 2, w: br.left },
    { x: (br.right + vw) / 2, y: vh / 2, w: vw - br.right },
    { x: vw / 2, y: adminShift + (br.top - adminShift) / 2, w: br.top - adminShift },
    { x: vw / 2, y: (br.bottom + vh) / 2, w: vh - br.bottom },
  ].filter((s) => s.w >= 24).sort((a, b) => b.w - a.w);
  if (strips.length) backdrop = { x: Math.round(strips[0].x), y: Math.round(strips[0].y) };
  const active = document.activeElement;
  return {
    opened,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    effectiveOpacity: Math.round(op * 1000) / 1000,
    visibility: cs.visibility,
    pointerEvents: effectivePointerEvents(panel),
    withinViewport: within,
    clippedByAncestor: clipped,
    occluded,
    overflowingChildren: spill,
    scrollLocked: scrollLocked(),
    focusInside: !!(active && active !== document.body && panel.contains(active)),
    closeControl: close ? selectorOf(close) : null,
    backdropPoint: backdrop,
    panelSelector: selectorOf(panel),
    tooSmall: r.width < ${minSize.w} || r.height < ${minSize.h},
  };
})()`;
}

/**
 * Decide whether a coordinate click (backdrop / outside click) is harmless. Safe only on a
 * covering overlay or on inert content; never on (or inside) an interactive control, a form,
 * anything the safe-mode lists refuse, or the panel itself.
 */
export function buildPointSafetyScript(index: number, x: number, y: number): string {
  return `(() => {
  ${PAGE_HELPERS}
  const x = ${JSON.stringify(Math.round(x))};
  const y = ${JSON.stringify(Math.round(y))};
  const el = document.elementFromPoint(x, y);
  if (!el) return { safe: false, reason: 'NO_ELEMENT' };
  const panel = document.querySelector('${smPanelSelector(index)}');
  const box = document.querySelector('[${SM_BOX}="${index}"]');
  const UNSAFE = 'a[href], input, select, textarea, form, [data-add-to-cart], [data-variant-id], [class*="add-to-cart" i], [class*="addtocart" i], [class*="buy-now" i], [class*="checkout" i]';
  const INTERACTIVE = 'button, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [onclick], [contenteditable="true"]';
  if (panel && (panel === el || panel.contains(el))) {
    if (!box || box === el || box.contains(el)) return { safe: false, reason: 'INSIDE_PANEL' };
    // Inside a full-viewport wrapper but outside its dialog box: the wrapper's own backdrop,
    // unless a control sits there (a close button parked beside the dialog). A button covering
    // most of the viewport is the scrim made clickable, the same rule as outside the panel.
    const ctl = el.closest(UNSAFE + ', ' + INTERACTIVE);
    if (ctl && panel.contains(ctl)) {
      const cb = ctl.getBoundingClientRect();
      const cpos = getComputedStyle(ctl).position;
      const scrimButton = !ctl.matches(UNSAFE) && (cpos === 'fixed' || cpos === 'absolute') && cb.width * cb.height >= window.innerWidth * window.innerHeight * 0.5;
      if (!scrimButton) return { safe: false, reason: 'INTERACTIVE_TARGET', target: selectorOf(ctl) };
    }
    return { safe: true, reason: 'PANEL_BACKDROP', target: selectorOf(el) };
  }
  if (el.closest(UNSAFE)) return { safe: false, reason: 'INTERACTIVE_TARGET', target: selectorOf(el.closest(UNSAFE)) };
  const vw = window.innerWidth; const vh = window.innerHeight;
  // A layer covering most of the viewport is a backdrop by geometry, even when the theme made it
  // a <button> ("overplay-all"): clicking it is how a shopper dismisses the panel. A control met
  // on the way up (a product button inside a full-screen search layer) is never a backdrop.
  for (let cur = el, d = 0; cur && cur.nodeType === 1 && d < 5; cur = cur.parentElement, d++) {
    const cs = getComputedStyle(cur);
    const b = cur.getBoundingClientRect();
    if ((cs.position === 'fixed' || cs.position === 'absolute') && b.width * b.height >= vw * vh * 0.5) return { safe: true, reason: 'OVERLAY', target: selectorOf(cur) };
    if (cur.matches(INTERACTIVE)) return { safe: false, reason: 'INTERACTIVE_TARGET', target: selectorOf(cur) };
  }
  if (el.closest(INTERACTIVE)) return { safe: false, reason: 'INTERACTIVE_TARGET', target: selectorOf(el.closest(INTERACTIVE)) };
  // Inert page content: still refuse anything that looks clickable through delegated handlers.
  for (let cur = el, d = 0; cur && cur.nodeType === 1 && d < 4; cur = cur.parentElement, d++) {
    if (getComputedStyle(cur).cursor === 'pointer') return { safe: false, reason: 'POINTER_TARGET', target: selectorOf(cur) };
  }
  return { safe: true, reason: 'INERT_CONTENT', target: selectorOf(el) };
})()`;
}

/**
 * Arm a one-shot capture-phase keydown listener before Escape is sent, so "the page never saw the
 * key" (an unfocused pane, a dropped input event) can be told apart from "the page saw Escape and
 * ignored it".
 */
export function buildEscapeArmScript(): string {
  return `(() => {
  if (window.__antifanSmKey && window.__antifanSmKey.off) window.__antifanSmKey.off();
  const rec = { seen: false, key: null };
  const on = (e) => { rec.seen = true; rec.key = e.key; };
  document.addEventListener('keydown', on, { capture: true, once: true });
  rec.off = () => document.removeEventListener('keydown', on, true);
  window.__antifanSmKey = rec;
  return { armed: true, hasFocus: document.hasFocus() };
})()`;
}

export function buildEscapeReadScript(): string {
  return `(() => {
  const rec = window.__antifanSmKey || { seen: false, key: null };
  if (rec.off) rec.off();
  delete window.__antifanSmKey;
  return { seen: rec.seen === true, key: rec.key, hasFocus: document.hasFocus() };
})()`;
}

/**
 * Browser-default rendering inside an open panel: the theme never styled it. Each cue is a
 * measurable default (serif fallback font, native button/input chrome, UA link blue, a bare table,
 * a list whose markers hang outside the panel, text flush against an unpadded panel edge).
 */
export function buildUnstyledProbeScript(index: number): string {
  return `(() => {
  ${PAGE_HELPERS}
  const panel = document.querySelector('${smPanelSelector(index)}');
  if (!panel || !displayed(panel)) return { unstyled: [] };
  const box = document.querySelector('[${SM_BOX}="${index}"]') || panel;
  const boxRect = box.getBoundingClientRect();
  const cues = [];
  const add = (cue, el, detail) => { if (cues.length < 8 && !cues.some((c) => c.cue === cue)) cues.push({ cue: cue, selector: selectorOf(el), detail: detail }); };
  const family = (el) => (getComputedStyle(el).fontFamily.split(',')[0] || '').replace(/["']/g, '').trim().toLowerCase();
  const ICON_FONT = /icon|awesome|material|glyph|symbol|fontello|feather|ionicons/;
  const SERIF_UA = /^(times new roman|times|serif)$/;
  const bodyFamily = family(document.body);
  // A family the page loads through @font-face (a display face for menu headings) was chosen by
  // the theme; only a family nobody declared can be a fallback the panel slipped into.
  const declared = new Set(Array.from(document.fonts || []).map((f) => String(f.family || '').replace(/["']/g, '').trim().toLowerCase()));
  const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 0);
  const textEls = [box].concat(Array.from(box.querySelectorAll('p, li, label, td, th, span, div, a')));
  for (const el of textEls) {
    if (!ownText(el) || !displayed(el) || el.closest('button, select, textarea, option')) continue;
    const fam = family(el);
    if (!fam || ICON_FONT.test(fam)) continue;
    if (SERIF_UA.test(fam) && !SERIF_UA.test(bodyFamily)) { add('font-family', el, 'renders in the serif browser default "' + fam + '" while the page body uses "' + bodyFamily + '"'); break; }
    if (fam !== bodyFamily && !declared.has(fam)) { add('font-family', el, 'renders in "' + fam + '" while the page body uses "' + bodyFamily + '"'); break; }
  }
  for (const el of box.querySelectorAll('button, input, select, textarea')) {
    if (!displayed(el)) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && /^(checkbox|radio|range|file|color|hidden|image)$/.test(type)) continue;
    const cs = getComputedStyle(el);
    const nativeBorder = /^(outset|inset|groove|ridge)$/.test(cs.borderTopStyle) && parseFloat(cs.borderTopWidth) > 0;
    const faceFill = el.tagName === 'BUTTON' && cs.backgroundColor === 'rgb(239, 239, 239)';
    if (nativeBorder || faceFill) { add('ua-control-chrome', el, 'keeps the browser-default ' + (nativeBorder ? cs.borderTopStyle + ' border' : 'button face fill')); break; }
  }
  for (const a of box.querySelectorAll('a[href]')) {
    if (displayed(a) && getComputedStyle(a).color === 'rgb(0, 0, 238)') { add('ua-link-colour', a, 'link keeps the browser-default blue rgb(0, 0, 238)'); break; }
  }
  for (const table of box.querySelectorAll('table')) {
    if (!displayed(table)) continue;
    const cells = Array.from(table.querySelectorAll('td, th')).filter(displayed);
    if (cells.length < 2) continue;
    const tcs = getComputedStyle(table);
    const bare = parseFloat(tcs.borderTopWidth) === 0 && cells.every((c) => { const s = getComputedStyle(c); return parseFloat(s.paddingLeft) <= 1 && parseFloat(s.paddingTop) <= 1 && parseFloat(s.borderTopWidth) === 0 && parseFloat(s.borderBottomWidth) === 0; });
    if (bare) { add('bare-table', table, 'table cells have no padding and no border'); break; }
  }
  for (const list of box.querySelectorAll('ul, ol')) {
    if (!displayed(list)) continue;
    const lcs = getComputedStyle(list);
    if (lcs.listStyleType === 'none' || lcs.listStylePosition !== 'outside' || parseFloat(lcs.paddingLeft) >= 12) continue;
    const item = Array.from(list.children).find((c) => c.tagName === 'LI' && displayed(c));
    if (item && item.getBoundingClientRect().left - boxRect.left < 12) { add('list-padding', list, 'list markers hang outside the panel (padding-left ' + lcs.paddingLeft + ')'); break; }
  }
  const bcs = getComputedStyle(box);
  if (parseFloat(bcs.paddingLeft) === 0 && parseFloat(bcs.paddingRight) === 0 && parseFloat(bcs.paddingTop) === 0) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() && n.parentElement && displayed(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const first = walker.nextNode();
    if (first) {
      const range = document.createRange();
      range.selectNodeContents(first);
      const tr = range.getBoundingClientRect();
      if (tr.width > 0 && tr.left - boxRect.left < 2) add('panel-padding', box, 'panel has no padding and its text starts at the panel edge');
    }
  }
  return { unstyled: cues };
})()`;
}

/** Measure after a close attempt. */
export function buildMeasureClosedScript(index: number): string {
  return `(() => {
  ${PAGE_HELPERS}
  const panel = document.querySelector('${smPanelSelector(index)}');
  const trigger = document.querySelector('${smTriggerSelector(index)}');
  const rest = window.__antifanStateMatrixRest || { scrollLocked: false };
  const active = document.activeElement;
  return {
    closed: !panel || !isOpen(panel),
    // Only a lock the overlay added and left behind is a leak; a lock the page already had at
    // rest (another popup, since dismissed or not) is not this overlay's to release.
    bodyRestored: !scrollLocked() || rest.scrollLocked,
    focusReturned: !!(trigger && active && (active === trigger || trigger.contains(active))),
  };
})()`;
}

/** Remove tags and the safe-mode guard; restore the scroll position the run started from. */
export function buildCleanupScript(): string {
  return `(() => {
  for (const attr of ['${SM_TRIGGER}', '${SM_PANEL}', '${SM_CLOSE}', '${SM_BOX}', 'data-antifan-sm-preopen']) {
    document.querySelectorAll('[' + attr + ']').forEach((n) => n.removeAttribute(attr));
  }
  const g = window.__antifanStateMatrixGuard;
  if (g) {
    window.removeEventListener('click', g.onClick, true);
    window.removeEventListener('submit', g.onSubmit, true);
    window.scrollTo(g.scrollX, g.scrollY);
    delete window.__antifanStateMatrixGuard;
  }
  document.getElementById('__antifan_sm_preview_chrome__')?.remove();
  delete window.__antifanStateMatrixRest;
  return { ok: true };
})()`;
}

interface DiscoveredTrigger {
  index: number;
  trigger: string;
  panel: string | null;
  kind: StateMatrixKind;
  label: string;
  closeSelector: string | null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Drive every discovered overlay through its open/close lifecycle. Pure orchestration: all page
 * access goes through `deps`, so the same code runs against the live tab host and a test harness.
 */
const CLOSE_METHODS: ReadonlyArray<StateMatrixCloseMethod> = ['escape', 'close-button', 'backdrop'];
const KINDS: ReadonlyArray<StateMatrixKind> = ['drawer', 'modal', 'dropdown', 'megamenu'];

/** Validate caller input; throws with a message the capability maps to INVALID_ARGUMENT. */
export function normalizeStateMatrixOptions(options: StateMatrixOptions = {}): { closeMethods: StateMatrixCloseMethod[]; specs: StateMatrixTriggerSpec[] } {
  if (options.autoPopulate !== undefined && options.autoPopulate !== 'pdp') throw new Error(`autoPopulate must be "pdp" (got ${JSON.stringify(options.autoPopulate)})`);
  let closeMethods: StateMatrixCloseMethod[] = [...CLOSE_METHODS];
  if (options.closeMethods !== undefined) {
    if (!Array.isArray(options.closeMethods) || !options.closeMethods.length) throw new Error('closeMethods must be a non-empty array of escape | close-button | backdrop');
    const bad = options.closeMethods.filter((m) => !CLOSE_METHODS.includes(m));
    if (bad.length) throw new Error(`closeMethods has unknown entries: ${bad.join(', ')}`);
    closeMethods = Array.from(new Set(options.closeMethods));
  }
  const specs: StateMatrixTriggerSpec[] = [];
  for (const t of Array.isArray(options.triggers) ? options.triggers : []) {
    if (!t || typeof t.selector !== 'string' || !t.selector.trim()) throw new Error('every trigger needs a non-empty selector');
    if (t.kind !== undefined && !KINDS.includes(t.kind)) throw new Error(`trigger kind "${String(t.kind)}" is not one of ${KINDS.join(', ')}`);
    specs.push(t);
  }
  return { closeMethods, specs };
}

export async function runStateMatrix(deps: StateMatrixDeps, options: StateMatrixOptions = {}): Promise<StateMatrixResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const { closeMethods, specs } = normalizeStateMatrixOptions(options);
  const maxTriggers = clampInt(options.maxTriggers, 1, STATE_MATRIX_LIMITS.hardMaxTriggers, STATE_MATRIX_LIMITS.defaultMaxTriggers);
  const settleMs = clampInt(options.settleMs, STATE_MATRIX_LIMITS.minSettleMs, STATE_MATRIX_LIMITS.maxSettleMs, STATE_MATRIX_LIMITS.defaultSettleMs);
  const gradeVisual = options.gradeVisualQuality !== false;

  const empty = (error: string, viewport = { width: 0, height: 0 }): StateMatrixResult => ({
    measured: false,
    safeMode: true,
    viewport,
    triggers: [],
    summary: { total: 0, passed: 0, warned: 0, failed: 0, notRun: 0, criticalCount: 0 },
    skippedTriggers: [],
    durationMs: now() - started,
    error,
  });

  let discovered: { ok?: boolean; viewport?: { width: number; height: number }; triggers?: DiscoveredTrigger[]; skipped?: Array<{ selector: string; reason: string }> } | undefined;
  const results: StateMatrixTriggerResult[] = [];
  let viewport = { width: 0, height: 0 };
  let stuck = false;
  // After every input: the caller's settle time, then until the transitions it started finish.
  const settle = async (): Promise<void> => {
    await deps.wait(settleMs);
    try {
      await deps.evalJs(buildSettleAnimationsScript(STATE_MATRIX_LIMITS.maxAnimationSettleMs));
    } catch {
      // Settling is best effort; the measurement that follows reports what the page shows.
    }
  };
  // A close is not always finished when the settle ends: a timer or requestAnimationFrame driven
  // transition is invisible to getAnimations(). Re-read the closed state every poll interval for
  // up to maxAnimationSettleMs, stopping at the first "closed". The run-wide budget bounds the
  // time spent waiting on overlays that did NOT close, so a page that never closes still ends
  // inside the workflow deadline, while a slow-but-valid close costs the budget nothing and
  // cannot starve the triggers that follow it. `since` lets a caller (the Escape retry) put the
  // press and settle that preceded the poll into the same accounting.
  let closePollSpentMs = 0;
  const measureClosedPolled = async (index: number, since?: number): Promise<{ closed: boolean; bodyRestored: boolean; focusReturned: boolean }> => {
    const read = async () => {
      const after = (await deps.evalJs(buildMeasureClosedScript(index))) as { closed?: boolean; bodyRestored?: boolean; focusReturned?: boolean } | null;
      return { closed: Boolean(after && after.closed), bodyRestored: Boolean(after && after.bodyRestored), focusReturned: Boolean(after && after.focusReturned) };
    };
    const startedAt = since ?? now();
    let reading = await read();
    const turns = Math.ceil(STATE_MATRIX_LIMITS.maxAnimationSettleMs / STATE_MATRIX_LIMITS.openPollIntervalMs);
    for (let turn = 0; turn < turns && !reading.closed && closePollSpentMs + (now() - startedAt) < STATE_MATRIX_LIMITS.closePollBudgetMs; turn++) {
      await deps.wait(STATE_MATRIX_LIMITS.openPollIntervalMs);
      reading = await read();
    }
    if (!reading.closed) closePollSpentMs += now() - startedAt;
    return reading;
  };

  // Discovery installs the safe-mode guard, so it sits inside the same try/finally as the run:
  // a failing or malformed discovery still removes the guard and every tag.
  try {
    try {
      discovered = (await deps.evalJs(buildDiscoverScript(specs, maxTriggers, options.autoPopulate))) as typeof discovered;
    } catch (err) {
      return empty(`DISCOVERY_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!discovered || discovered.ok !== true || !Array.isArray(discovered.triggers)) {
      return empty('DISCOVERY_RETURNED_NO_RESULT');
    }
    viewport = discovered.viewport || viewport;
    for (const t of discovered.triggers) {
      const result: StateMatrixTriggerResult = { index: t.index, trigger: t.trigger, panel: t.panel, kind: t.kind, label: t.label, status: 'PASS', failures: [], closes: [] };
      results.push(result);
      if (stuck) {
        result.status = 'NOT_RUN';
        continue;
      }
      const fail = (code: StateMatrixFailureCode, message: string) => {
        result.failures.push({ code, severity: failureSeverity(code, t.kind), message });
      };
      // Coordinate clicks have no element to vet, so the point is hit-tested first: a "backdrop"
      // point that lands on a link, a buy button or the panel itself is never clicked.
      const safeClickAt = async (x: number, y: number): Promise<{ ok: boolean; skipped?: string }> => {
        const verdict = (await deps.evalJs(buildPointSafetyScript(t.index, x, y))) as { safe?: boolean; reason?: string; target?: string } | null;
        if (!verdict || verdict.safe !== true) {
          return { ok: false, skipped: `POINT_UNSAFE: ${verdict?.reason || 'UNKNOWN'}${verdict?.target ? ` ${verdict.target}` : ''}` };
        }
        const clicked = await deps.clickAt(x, y);
        return clicked.ok ? { ok: true } : { ok: false, skipped: `CLICK_REFUSED: ${clicked.error || ''}` };
      };
      let firstOpen = true;
      let escapeProbe: { hasFocus?: boolean; seen?: boolean; key?: string | null } | null = null;
      // Escape is sent through a probe: a page without focus, or a key that never reached it, says
      // nothing about whether the overlay honours Escape, so that is reported as unmeasured.
      const pressEscape = async (): Promise<void> => {
        try { await deps.evalJs(buildEscapeArmScript()); } catch { /* the press below still runs */ }
        await deps.pressKey('Escape');
        try { escapeProbe = (await deps.evalJs(buildEscapeReadScript())) as typeof escapeProbe; } catch { escapeProbe = null; }
      };
      const escapeNotClosing = (): void => {
        const p = escapeProbe;
        if (p === null) {
          fail('CLOSE_ESCAPE_UNMEASURED', `the Escape probe could not be read back from the page, so whether the ${t.kind} closes on Escape is unmeasured`);
        } else if (p.hasFocus === false) {
          fail('CLOSE_ESCAPE_UNMEASURED', `the page did not have focus when Escape was sent, so whether the ${t.kind} closes on Escape is unmeasured`);
        } else if (p.seen === false) {
          fail('CLOSE_ESCAPE_UNMEASURED', `no keydown event reached the page when Escape was sent, so whether the ${t.kind} closes on Escape is unmeasured`);
        } else if (p.seen === true && typeof p.key !== 'string') {
          fail('CLOSE_ESCAPE_UNMEASURED', `the page saw a keydown but not which key, so whether the ${t.kind} closes on Escape is unmeasured`);
        } else if (p.seen === true && p.key !== 'Escape') {
          fail('CLOSE_ESCAPE_UNMEASURED', `the key delivered to the page was "${p.key}", not Escape, so whether the ${t.kind} closes on Escape is unmeasured`);
        } else {
          fail('CLOSE_ESCAPE_FAILED', `Escape does not close the ${t.kind}`);
        }
      };
      // An Escape that left the overlay open is sent once more before it is graded: a first press
      // can be lost to focus or to a page still finishing its own transition. A close on the
      // second press is reported as a warning, not as an overlay that ignores Escape.
      const retryEscape = async (): Promise<{ closed: boolean; bodyRestored: boolean; focusReturned: boolean }> => {
        const retryStartedAt = now();
        await pressEscape();
        await settle();
        return measureClosedPolled(t.index, retryStartedAt);
      };
      const escapeFlaky = (): void => {
        fail('CLOSE_ESCAPE_FLAKY', `Escape closed the ${t.kind} only on the second press; the first press left it open`);
      };
      const open = async (): Promise<boolean> => {
        await deps.evalJs(buildPrepareScript(t.index, firstOpen));
        firstOpen = false;
        const menuLike = t.kind === 'dropdown' || t.kind === 'megamenu';
        if (menuLike) {
          await deps.hover(smTriggerSelector(t.index));
          await settle();
          const probe = (await deps.evalJs(buildMeasureOpenScript(t.index, t.kind, t.closeSelector))) as StateMatrixOpenMeasurement;
          if (probe && probe.opened) return true;
        }
        const clicked = await deps.click(smTriggerSelector(t.index));
        if (!clicked.ok) {
          fail('TRIGGER_NOT_ACTIONABLE', `Trusted click on ${t.trigger} was refused: ${clicked.error || 'not actionable'}`);
          return false;
        }
        await settle();
        return true;
      };

      // Script-driven openings land after the settle on some themes (Bootstrap shows the dialog
      // from the backdrop's transitionend or a timer): poll a few turns before calling it unopened.
      const measureOpen = async (): Promise<StateMatrixOpenMeasurement & { tooSmall?: boolean }> => {
        let measured = (await deps.evalJs(buildMeasureOpenScript(t.index, t.kind, t.closeSelector))) as StateMatrixOpenMeasurement & { tooSmall?: boolean };
        for (let turn = 0; turn < STATE_MATRIX_LIMITS.openPollTurns && (!measured || !measured.opened); turn++) {
          await deps.wait(STATE_MATRIX_LIMITS.openPollIntervalMs);
          try {
            await deps.evalJs(buildSettleAnimationsScript(STATE_MATRIX_LIMITS.maxAnimationSettleMs));
          } catch {
            // Best effort, as in settle().
          }
          measured = (await deps.evalJs(buildMeasureOpenScript(t.index, t.kind, t.closeSelector))) as StateMatrixOpenMeasurement & { tooSmall?: boolean };
        }
        return measured;
      };

      if (!(await open())) {
        result.status = 'FAIL';
        continue;
      }
      const m = await measureOpen();
      result.open = m;
      if (!result.panel && m && m.panelSelector) result.panel = m.panelSelector;
      if (!m || !m.opened) {
        fail('OVERLAY_NOT_OPENED', `${t.trigger} did not open a visible ${t.kind} after a trusted ${t.kind === 'dropdown' || t.kind === 'megamenu' ? 'hover/click' : 'click'}`);
        result.status = 'FAIL';
        // The click may still have opened something this run cannot see (a layer outside the
        // known patterns that locks scrolling). Escape it once; if the page stays changed, stop
        // rather than exercise later triggers on top of an unknown open layer.
        const rest = (await deps.evalJs(buildRestCheckScript())) as { restored?: boolean } | null;
        if (!rest || rest.restored !== true) {
          await deps.pressKey('Escape');
          await settle();
          const again = (await deps.evalJs(buildRestCheckScript())) as { restored?: boolean } | null;
          if (!again || again.restored !== true) {
            fail('STATE_STUCK_OPEN', `after clicking ${t.trigger} the page stayed scroll-locked with no measurable overlay; remaining overlays were not exercised`);
            stuck = true;
          }
        }
        continue;
      }
      if (m.tooSmall) fail('OVERLAY_TOO_SMALL', `${t.kind} panel is ${m.rect?.w}x${m.rect?.h}px, under the ${STATE_MATRIX_LIMITS.minPanelPx[t.kind].w}x${STATE_MATRIX_LIMITS.minPanelPx[t.kind].h} minimum`);
      if (!m.withinViewport) fail('OVERLAY_OFFSCREEN', `${t.kind} panel extends past the viewport: ${JSON.stringify(m.rect)} in ${viewport.width}x${viewport.height}`);
      if (m.clippedByAncestor) fail('OVERLAY_CLIPPED', `${t.kind} panel is cut by an overflow-hidden ancestor`);
      if (m.effectiveOpacity < STATE_MATRIX_LIMITS.minOpacity) fail('OVERLAY_TRANSPARENT', `${t.kind} panel opacity settles at ${m.effectiveOpacity} (< ${STATE_MATRIX_LIMITS.minOpacity})`);
      if (m.pointerEvents === 'none') fail('OVERLAY_POINTER_EVENTS_NONE', `${t.kind} panel ignores pointer input (pointer-events: none)`);
      if (m.occluded) fail('OVERLAY_OCCLUDED', `another layer paints over the ${t.kind} panel centre`);
      if (m.overflowingChildren.length) fail('CONTENT_OVERFLOWS_PANEL', `content spills out of the panel: ${m.overflowingChildren.slice(0, 3).join('; ')}`);
      const dialogLike = t.kind === 'modal' || t.kind === 'drawer';
      if (dialogLike && !m.scrollLocked) fail('SCROLL_NOT_LOCKED', 'the page behind the open panel still scrolls');
      if (dialogLike && !m.focusInside) fail('FOCUS_NOT_MOVED', 'keyboard focus stayed outside the open panel');
      if (dialogLike && !m.closeControl) fail('CLOSE_CONTROL_MISSING', 'no visible close control inside the open panel');
      try {
        const unstyled = (await deps.evalJs(buildUnstyledProbeScript(t.index))) as { unstyled?: Array<{ cue: string; selector: string; detail: string }> } | null;
        if (unstyled && Array.isArray(unstyled.unstyled) && unstyled.unstyled.length > 0) {
          fail('MODAL_UNSTYLED', `${t.kind} panel shows browser-default rendering: ${unstyled.unstyled.slice(0, 3).map((c) => `${c.cue} (${c.detail})`).join('; ')}`);
        }
      } catch {
        // The unstyled probe is advisory; a failed read never masks lifecycle evidence.
      }

      if (gradeVisual) {
        try {
          const vq = VisualQualityScanner.normalize(await deps.evalJs(VisualQualityScanner.getBrowserScanScript({ scopeSelector: smPanelSelector(t.index), skipFloating: true })));
          if (vq.measured) result.visualQuality = vq.findings.filter((f) => f.ruleId !== 'floating-widget-overlap' && f.ruleId !== 'invisible-click-blocker');
        } catch {
          // Visual grading is advisory; a failed scan never masks lifecycle evidence.
        }
      }

      let isOpenNow = true;
      const measureClose = async (method: StateMatrixCloseAttemptMethod): Promise<StateMatrixCloseAttempt> => {
        await settle();
        let reading = await measureClosedPolled(t.index);
        if (method === 'escape' && !reading.closed) {
          reading = await retryEscape();
          if (reading.closed) escapeFlaky();
        }
        return { method, ...reading };
      };
      if (!dialogLike) {
        // Menus: Escape (an accessibility expectation), then the pointer leaving, then a click
        // outside. One success is enough; menus have no close control or modal backdrop. Only
        // the methods the caller allowed run; the pointer leaving is a hover and always safe.
        const neutral = m.backdropPoint || { x: 4, y: Math.max(4, viewport.height - 4) };
        type MenuAttempt = [StateMatrixCloseAttemptMethod, () => Promise<{ skipped?: string }>];
        const menuAttempts: MenuAttempt[] = [];
        if (closeMethods.includes('escape')) menuAttempts.push(['escape', async () => { await pressEscape(); return {}; }]);
        menuAttempts.push(['pointer-leave', async () => { await deps.hoverAt(neutral.x, neutral.y); return {}; }]);
        if (closeMethods.includes('backdrop')) {
          menuAttempts.push(['backdrop', async () => {
            const clicked = await safeClickAt(neutral.x, neutral.y);
            return clicked.ok ? {} : { skipped: clicked.skipped };
          }]);
        }
        for (const [method, perform] of menuAttempts) {
          const performed = await perform();
          if (performed.skipped) {
            result.closes.push({ method, closed: false, bodyRestored: false, focusReturned: false, skipped: performed.skipped });
            continue;
          }
          const attempt = await measureClose(method);
          result.closes.push(attempt);
          if (attempt.closed) {
            isOpenNow = false;
            if (!attempt.bodyRestored) fail('BODY_NOT_RESTORED', `after closing by ${method} the page scroll lock was not released`);
            break;
          }
          if (method === 'escape') escapeNotClosing();
        }
      }
      // Dialogs: each close method from a fresh open so one method's success does not hide another's failure.
      for (const method of dialogLike ? closeMethods : []) {
        if (!isOpenNow) {
          if (!(await open())) break;
          const reopened = await measureOpen();
          if (!reopened || !reopened.opened) break;
          isOpenNow = true;
        }
        const attempt: StateMatrixCloseAttempt = { method, closed: false, bodyRestored: false, focusReturned: false };
        if (method === 'escape') {
          await pressEscape();
        } else if (method === 'close-button') {
          if (!m.closeControl) { attempt.skipped = 'NO_CLOSE_CONTROL'; result.closes.push(attempt); continue; }
          const clicked = await deps.click(smCloseSelector(t.index));
          if (!clicked.ok) { attempt.skipped = `CLICK_REFUSED: ${clicked.error || ''}`; }
        } else {
          if (!dialogLike || !m.backdropPoint) { attempt.skipped = dialogLike ? 'NO_BACKDROP_AREA' : 'NOT_APPLICABLE'; result.closes.push(attempt); continue; }
          const clicked = await safeClickAt(m.backdropPoint.x, m.backdropPoint.y);
          if (!clicked.ok) { attempt.skipped = clicked.skipped; result.closes.push(attempt); continue; }
        }
        await settle();
        let reading = await measureClosedPolled(t.index);
        if (method === 'escape' && !reading.closed) {
          reading = await retryEscape();
          if (reading.closed) escapeFlaky();
        }
        attempt.closed = reading.closed;
        attempt.bodyRestored = reading.bodyRestored;
        attempt.focusReturned = reading.focusReturned;
        result.closes.push(attempt);
        if (attempt.closed) {
          isOpenNow = false;
          if (!attempt.bodyRestored) fail('BODY_NOT_RESTORED', `after closing by ${method} the page scroll lock was not released`);
          if (dialogLike && !attempt.focusReturned) fail('FOCUS_NOT_RETURNED', `after closing by ${method} focus did not return to the trigger`);
        } else if (method === 'escape') {
          escapeNotClosing();
        } else if (method === 'close-button' && !attempt.skipped) {
          fail('CLOSE_BUTTON_FAILED', `clicking the close control ${m.closeControl} does not close the ${t.kind}`);
        } else if (method === 'backdrop') {
          fail('CLOSE_BACKDROP_FAILED', `clicking the backdrop does not close the ${t.kind}`);
        }
      }
      if (isOpenNow) {
        // Still open (the last method failed or was skipped): close it the way that already worked
        // for this overlay, then by the trigger's own toggle, before declaring the page stuck.
        const recoveries: Array<() => Promise<unknown>> = [];
        if (result.closes.some((c) => c.closed && c.method === 'escape')) recoveries.push(() => deps.pressKey('Escape'));
        if (result.closes.some((c) => c.closed && c.method === 'close-button')) recoveries.push(() => deps.click(smCloseSelector(t.index)));
        recoveries.push(() => deps.click(smTriggerSelector(t.index)));
        let recovered = false;
        for (const recover of recoveries) {
          await recover();
          await settle();
          const after = await measureClosedPolled(t.index);
          if (after.closed) { recovered = true; break; }
        }
        if (!recovered) {
          fail('STATE_STUCK_OPEN', `the ${t.kind} could not be closed by any method; remaining overlays were not exercised`);
          stuck = true;
        }
      }
      const failures = result.failures;
      result.status = failures.some((f) => f.severity === 'critical') ? 'FAIL' : failures.length ? 'WARN' : 'PASS';
    }
  } finally {
    try {
      await deps.evalJs(buildCleanupScript());
    } catch {
      // Cleanup failure is reported through the stuck/NOT_RUN statuses already recorded.
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'PASS').length,
    warned: results.filter((r) => r.status === 'WARN').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    notRun: results.filter((r) => r.status === 'NOT_RUN').length,
    criticalCount: results.reduce((n, r) => n + r.failures.filter((f) => f.severity === 'critical').length, 0),
  };
  return {
    measured: results.length > 0 && summary.notRun === 0,
    safeMode: true,
    viewport,
    triggers: results,
    summary,
    skippedTriggers: discovered && Array.isArray(discovered.skipped) ? discovered.skipped : [],
    durationMs: now() - started,
    ...(results.length === 0 ? { error: 'NO_OVERLAY_TRIGGERS_FOUND' } : {}),
  };
}
