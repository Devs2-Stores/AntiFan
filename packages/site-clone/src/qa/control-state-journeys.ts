import type {
  InteractionBrowser,
  InteractionInventoryItem,
  InteractionReceipt,
  InteractionVerdict
} from './interaction-suite.js';

export interface InventoryControlItem extends InteractionInventoryItem {
  classes?: string[];
  attributes?: Record<string, string>;
}

interface ElementDescriptor {
  id: string;
  selector: string;
  tag: string;
  name: string;
  href: string | null;
  inputType: string | null;
  classes?: string[];
  parentSelector?: string | null;
  ordinal: number;
}

interface ObservableControlState {
  exists: boolean;
  visible: boolean;
  hit: boolean;
  rect: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  classes: string[];
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
  focused: boolean;
  ariaExpanded: string | null;
  insideForm: boolean;
  hasFormAction: boolean;
  padding: { top: number; right: number; bottom: number; left: number };
  hoverStyles: {
    color: string;
    backgroundColor: string;
    borderColor: string;
    boxShadow: string;
    transform: string;
    opacity: string;
    cursor: string;
    textDecoration: string;
  };
  popupState: {
    classes: string[];
    display: string;
    visibility: string;
    opacity: string;
  } | null;
  externalTargetState: {
    classes: string[];
    display: string;
  } | null;
  slideIndex: string | null;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const literal = (value: unknown) => JSON.stringify(value);

const RESOLVER_HELPER_JS = `
function resolveControl(desc, isReference) {
  const normStr = (s) => (s || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const normHref = (h) => {
    if (!h) return '';
    try {
      const u = new URL(h, 'http://localhost');
      return (u.pathname + u.search).replace(/\\/+$/, '').toLowerCase();
    } catch (e) {
      return h.trim().replace(/\\/+$/, '').toLowerCase();
    }
  };

  const tag = desc.tag || '*';
  let elements = Array.from(document.querySelectorAll(tag));

  // 1. Exact inputType matching (fail closed)
  if (desc.inputType) {
    const targetType = desc.inputType.toLowerCase();
    elements = elements.filter(el => {
      const t = (el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '')).toLowerCase();
      return t === targetType;
    });
    if (elements.length === 0) return null;
  }

  // 2. Exact normalized href matching (fail closed)
  if (desc.href) {
    const targetHref = normHref(desc.href);
    if (targetHref) {
      elements = elements.filter(el => {
        const rawH = el.getAttribute('href');
        if (!rawH) return false;
        return normHref(rawH) === targetHref;
      });
      if (elements.length === 0) return null;
    }
  }

  // 3. Exact normalized name matching (fail closed, truncated to 120 chars)
  if (desc.name) {
    const targetName = normStr(desc.name).slice(0, 120);
    if (targetName.length > 0) {
      elements = elements.filter(el => {
        const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '';
        const elName = normStr(raw).slice(0, 120);
        return elName === targetName;
      });
      if (elements.length === 0) return null;
    }
  }

  // 4. Exact classes filter if provided
  if (Array.isArray(desc.classes) && desc.classes.length > 0) {
    const byClass = elements.filter(el => desc.classes.some(c => el.classList.contains(c)));
    if (byClass.length > 0) {
      elements = byClass;
    }
  }

  // 5. Ordinal disambiguation: exact index only (fail closed, NO clamping to last)
  const ord = typeof desc.ordinal === 'number' ? desc.ordinal : 0;
  if (ord >= 0 && ord < elements.length) {
    return elements[ord];
  }

  // 6. Selector fallback: ALLOWED ONLY on reference surface with identity validation
  // On clone: strictly fail closed, return null!
  if (isReference && desc.selector) {
    try {
      const el = document.querySelector(desc.selector);
      if (el) {
        if (desc.tag && desc.tag !== '*' && el.tagName.toLowerCase() !== desc.tag.toLowerCase()) {
          return null;
        }
        if (desc.inputType && (el.getAttribute('type') || '').toLowerCase() !== desc.inputType.toLowerCase()) {
          return null;
        }
        return el;
      }
    } catch (e) {}
  }

  return null;
}

function captureControlState(desc, isReference) {
  const el = resolveControl(desc, isReference);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = window.getComputedStyle(el);
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);

  const form = el.closest('form');
  const insideForm = Boolean(form);
  const hasFormAction = el.hasAttribute('formaction') || (el.tagName === 'BUTTON' && el.type === 'submit') || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image'));

  const popup = el.closest('.popup, #popup-video, .category-navigation__block, dialog, [role="dialog"]');
  const popupState = popup ? {
    classes: Array.from(popup.classList),
    display: window.getComputedStyle(popup).display,
    visibility: window.getComputedStyle(popup).visibility,
    opacity: window.getComputedStyle(popup).opacity
  } : null;

  const targetSel = el.getAttribute('data-target') || el.getAttribute('data-fancybox') || el.getAttribute('href');
  let externalTargetState = null;
  if (targetSel && targetSel.startsWith('#') && targetSel.length > 1) {
    try {
      const targetEl = document.querySelector(targetSel);
      if (targetEl) {
        externalTargetState = {
          classes: Array.from(targetEl.classList),
          display: window.getComputedStyle(targetEl).display
        };
      }
    } catch (e) {}
  }

  const activeSlide = document.querySelector('.slick-active, .swiper-slide-active');
  const slideIndex = activeSlide ? activeSlide.getAttribute('data-slick-index') : null;

  const padding = {
    top: parseFloat(s.paddingTop) || 0,
    right: parseFloat(s.paddingRight) || 0,
    bottom: parseFloat(s.paddingBottom) || 0,
    left: parseFloat(s.paddingLeft) || 0
  };

  return {
    exists: true,
    visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0,
    hit: !!hit && (el === hit || el.contains(hit)),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    center: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    classes: Array.from(el.classList),
    value: 'value' in el ? el.value : null,
    checked: 'checked' in el ? el.checked : null,
    disabled: el.matches(':disabled, [aria-disabled="true"], [inert]'),
    focused: document.activeElement === el,
    ariaExpanded: el.getAttribute('aria-expanded'),
    insideForm,
    hasFormAction,
    padding,
    hoverStyles: {
      color: s.color,
      backgroundColor: s.backgroundColor,
      borderColor: s.borderColor,
      boxShadow: s.boxShadow,
      transform: s.transform,
      opacity: s.opacity,
      cursor: s.cursor,
      textDecoration: s.textDecoration
    },
    popupState,
    externalTargetState,
    slideIndex
  };
}
`;

async function getObservableState(
  browser: InteractionBrowser,
  descriptor: ElementDescriptor,
  isReference: boolean
): Promise<ObservableControlState | null> {
  const result = await browser.evaluate(`(() => {
    ${RESOLVER_HELPER_JS}
    return captureControlState(${literal(descriptor)}, ${literal(isReference)});
  })()`);
  return (result as ObservableControlState) || null;
}

async function scrollIntoView(
  browser: InteractionBrowser,
  descriptor: ElementDescriptor,
  isReference: boolean
): Promise<boolean> {
  const scrolled = await browser.evaluate(`(() => {
    ${RESOLVER_HELPER_JS}
    const el = resolveControl(${literal(descriptor)}, ${literal(isReference)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
  return Boolean(scrolled);
}

function verifyC8MetricParity(
  refState: ObservableControlState,
  cloneState: ObservableControlState,
  tolerancePx: number = 1.0
): { pass: boolean; reason: string } {
  const widthDelta = Math.abs(cloneState.rect.width - refState.rect.width);
  const heightDelta = Math.abs(cloneState.rect.height - refState.rect.height);
  const paddingTopDelta = Math.abs(cloneState.padding.top - refState.padding.top);
  const paddingLeftDelta = Math.abs(cloneState.padding.left - refState.padding.left);

  if (widthDelta > tolerancePx || heightDelta > tolerancePx) {
    return {
      pass: false,
      reason: `C8 dimension disparity: ref=${refState.rect.width.toFixed(1)}x${refState.rect.height.toFixed(1)}, clone=${cloneState.rect.width.toFixed(1)}x${cloneState.rect.height.toFixed(1)} (delta > ${tolerancePx}px)`
    };
  }

  if (paddingTopDelta > tolerancePx || paddingLeftDelta > tolerancePx) {
    return {
      pass: false,
      reason: `C8 padding disparity: ref padding=${refState.padding.top}/${refState.padding.left}, clone padding=${cloneState.padding.top}/${cloneState.padding.left} (delta > ${tolerancePx}px)`
    };
  }

  return { pass: true, reason: `C8 metric parity verified within ${tolerancePx}px tolerance` };
}

function isSubmitOrRemoteMutation(
  item: InventoryControlItem,
  refState?: ObservableControlState | null,
  cloneState?: ObservableControlState | null
): boolean {
  const tag = item.tag.toLowerCase();
  const inputType = (item.inputType || '').toLowerCase();

  // 1. Explicit submit input types
  if (inputType === 'submit' || inputType === 'image' || inputType === 'reset') {
    return true;
  }

  // 2. Buttons: HTML default inside forms is submit unless explicit type="button"
  if (tag === 'button') {
    if (inputType === 'submit' || !inputType) {
      if (inputType === 'submit') return true;
      if (refState?.insideForm || cloneState?.insideForm) return true;
    }
  }

  // 3. Elements with formaction or form-associated submit
  if (refState?.hasFormAction || cloneState?.hasFormAction) {
    return true;
  }

  // 4. Any button or input inside a form without explicit type="button"
  if ((refState?.insideForm || cloneState?.insideForm) && tag === 'button' && inputType !== 'button') {
    return true;
  }

  // 5. Vietnamese commerce & mutation keywords (expanded coverage)
  const text = (item.name + ' ' + (item.classes || []).join(' ') + ' ' + (item.selector || '')).toLowerCase();
  if (/(?:submit|gửi|gui|đặt hàng|dat hang|thanh toán|thanh toan|thêm vào giỏ|them vao gio|báo giá|bao gia|xóa|xoa|liên hệ|lien he|mua ngay|mua hang|đăng ký|dang ky|đăng nhập|dang nhap|checkout|order|subscribe|add-to-cart|cart|quote)/i.test(text)) {
    return true;
  }

  if (item.events.some(e => /(?:submit|checkout|order|payment|mutate|store|cart)/i.test(e))) {
    return true;
  }

  return false;
}

function isSearchInput(item: InventoryControlItem): boolean {
  if (item.tag !== 'input') return false;
  const type = (item.inputType || '').toLowerCase();
  if (type === 'search') return true;
  const text = (item.name + ' ' + (item.classes || []).join(' ') + ' ' + (item.selector || '')).toLowerCase();
  return text.includes('search') || text.includes('tìm kiếm') || text.includes('tim kiem');
}

function isTextEditable(item: InventoryControlItem): boolean {
  if (item.tag === 'textarea') return true;
  if (item.tag === 'input') {
    const type = (item.inputType || 'text').toLowerCase();
    return ['text', 'search', 'email', 'tel', 'url', 'number', 'password'].includes(type);
  }
  return false;
}

function isSliderControl(item: InventoryControlItem, liveClasses: string[] = []): boolean {
  const combined = [...(item.classes || []), ...liveClasses, item.name, item.selector].join(' ').toLowerCase();
  return combined.includes('slick') || combined.includes('swiper') || combined.includes('carousel') || combined.includes('slide-content__arrow');
}

function isEvidenceBackedLocalDisclosure(
  item: InventoryControlItem,
  liveClasses: string[] = [],
  state?: ObservableControlState | null
): boolean {
  const combinedClasses = [...(item.classes || []), ...liveClasses].join(' ').toLowerCase();
  const selector = (item.selector || '').toLowerCase();

  // 1. Explicit disclosure targets approved by safety policy:
  // .menu-mobile, .open-login, .video-content__button, .popup-close, .info-more__button, .systerm .item-cta
  if (
    combinedClasses.includes('menu-mobile') ||
    selector.includes('.menu-mobile') ||
    combinedClasses.includes('open-login') ||
    selector.includes('.open-login') ||
    combinedClasses.includes('video-content__button') ||
    selector.includes('.video-content__button') ||
    combinedClasses.includes('popup-close') ||
    selector.includes('.popup-close') ||
    combinedClasses.includes('info-more__button') ||
    selector.includes('.info-more__button') ||
    (selector.includes('.systerm') && combinedClasses.includes('item-cta'))
  ) {
    return true;
  }

  // 2. Semantic aria-controls, <details>, <summary>, or aria-expanded
  if (state?.ariaExpanded != null) return true;
  if (item.tag === 'summary' || item.tag === 'details') return true;

  // 3. Local in-page target (data-target="#...", data-fancybox="#...", or hash-only href)
  if (state?.externalTargetState) return true;

  return false;
}

function isOrdinaryNavigationLink(item: InventoryControlItem): boolean {
  if (item.tag !== 'a') return false;
  const href = (item.href || '').trim();
  if (!href) return false;
  if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
    return false;
  }
  return true;
}

function hasPopupDelta(before: ObservableControlState | null, after: ObservableControlState | null): boolean {
  if (!before || !after) return false;
  if (Boolean(before.popupState) !== Boolean(after.popupState)) return true;
  if (before.popupState && after.popupState) {
    if (before.popupState.display !== after.popupState.display) return true;
    if (before.popupState.classes.join(' ') !== after.popupState.classes.join(' ')) return true;
  }
  if (before.externalTargetState && after.externalTargetState) {
    if (before.externalTargetState.display !== after.externalTargetState.display) return true;
    if (before.externalTargetState.classes.join(' ') !== after.externalTargetState.classes.join(' ')) return true;
  }
  return false;
}

function refActiveStateIsOpen(state: ObservableControlState | null, baseline: ObservableControlState | null): boolean {
  if (!state || !baseline) return false;
  if (state.popupState && state.popupState.display !== 'none' && state.popupState.visibility !== 'hidden') {
    return true;
  }
  if (state.externalTargetState && state.externalTargetState.display !== 'none') {
    return true;
  }
  if (state.ariaExpanded === 'true' && baseline.ariaExpanded !== 'true') {
    return true;
  }
  if (state.classes.some(c => c.includes('active') || c.includes('show') || c.includes('open'))) {
    return true;
  }
  return false;
}

async function openPrerequisiteContainer(
  browser: InteractionBrowser,
  desc: ElementDescriptor,
  isReference: boolean
): Promise<boolean> {
  return (await browser.evaluate(`(() => {
    ${RESOLVER_HELPER_JS}
    const target = resolveControl(${literal(desc)}, ${literal(isReference)});

    let inCategorySub = false;
    let inDrawer = false;
    let inPopupOrModal = false;

    // Derive live ancestor roles, classes, and tags from resolved DOM element
    let curr = target ? target.parentElement : null;
    while (curr && curr !== document.body) {
      const cls = (curr.className && typeof curr.className === 'string') ? curr.className.toLowerCase() : '';
      const role = (curr.getAttribute('role') || '').toLowerCase();
      const id = (curr.id || '').toLowerCase();
      const tag = curr.tagName.toLowerCase();

      if (id.includes('category-navigation__sub') || cls.includes('category-navigation__sub') || cls.includes('sub-menu')) {
        inCategorySub = true;
      }
      if (cls.includes('category-navigation__block') || cls.includes('drawer') || (role === 'navigation' && cls.includes('mobile'))) {
        inDrawer = true;
      }
      if (id.includes('popup') || cls.includes('popup') || cls.includes('modal') || role === 'dialog' || tag === 'dialog') {
        inPopupOrModal = true;
      }
      curr = curr.parentElement;
    }

    // Fallback if element itself not rendered: inspect desc hints
    if (!inCategorySub && !inDrawer && !inPopupOrModal) {
      const hint = ((desc.selector || '') + ' ' + (desc.parentSelector || '') + ' ' + (desc.classes || []).join(' ')).toLowerCase();
      if (hint.includes('sub-menu') || hint.includes('category-navigation__sub')) inCategorySub = true;
      if (hint.includes('drawer') || hint.includes('category-navigation__block')) inDrawer = true;
      if (hint.includes('popup') || hint.includes('modal') || hint.includes('dialog')) inPopupOrModal = true;
    }

    // Native user actions ONLY (no inline style or class mutations)
    if (inCategorySub) {
      const parent = document.querySelector('.category-navigation__list > ul > li, .category-navigation__main > li');
      if (parent) {
        parent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        return true;
      }
    }

    if (inDrawer) {
      const btn = document.querySelector('.menu-mobile, [data-toggle="menu-mobile"], .header-mobile__menu');
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
    }

    if (inPopupOrModal) {
      const btn = document.querySelector('.video-content__button, [data-fancybox="video"], [data-toggle="modal"], [data-target*="modal"]');
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
    }

    return false;
  })()`)) as boolean;
}

async function closePrerequisiteContainer(browser: InteractionBrowser): Promise<void> {
  try {
    // Native reset only: Escape key, pointer move to origin, or clicking native close button
    await browser.key('Escape');
    await browser.move(1, 1);
    await browser.evaluate(`(() => {
      const closeBtn = document.querySelector('.category-navigation_header .close, .category-navigation__header .close, .popup-close, .mfp-close, [data-dismiss="modal"]');
      if (closeBtn && typeof closeBtn.click === 'function') {
        closeBtn.click();
      }
      const parent = document.querySelector('.category-navigation__list > ul > li, .category-navigation__main > li');
      if (parent) {
        parent.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      }
    })()`);
    await pause(60);
  } catch (e) {}
}

async function tabToElementNatively(
  browser: InteractionBrowser,
  desc: ElementDescriptor,
  isReference: boolean
): Promise<boolean> {
  const info = (await browser.evaluate(`(() => {
    ${RESOLVER_HELPER_JS}
    const target = resolveControl(${literal(desc)}, ${literal(isReference)});
    if (!target) return { found: false, count: 0 };
    const focusables = Array.from(document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    return {
      found: true,
      count: focusables.length,
      rank: focusables.indexOf(target)
    };
  })()`)) as { found: boolean; count: number; rank: number } | null;

  if (!info || !info.found || info.count <= 0) {
    return false;
  }

  // Reset focus from top of document before starting Tab sequence
  await browser.evaluate('window.scrollTo(0, 0); if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();');
  await pause(30);

  // Iterate actual eligible focusable count with cycle detection (no arbitrary cap)
  const seenActiveElements = new Set<string>();
  const maxIterations = info.count + 2;

  for (let i = 0; i < maxIterations; i++) {
    await browser.key('Tab');

    const check = (await browser.evaluate(`(() => {
      ${RESOLVER_HELPER_JS}
      const target = resolveControl(${literal(desc)}, ${literal(isReference)});
      const active = document.activeElement;
      if (!active) return { isTarget: false, fp: null };

      const isTarget = target ? (active === target) : false;
      const tag = active.tagName || '';
      const id = active.id || '';
      const name = active.getAttribute('name') || '';
      const href = active.getAttribute('href') || '';
      const text = (active.textContent || '').trim().slice(0, 30);
      const rect = active.getBoundingClientRect();
      const fp = tag + '#' + id + '.' + name + '[' + href + ']:' + text + '@' + Math.round(rect.x) + ',' + Math.round(rect.y);

      return { isTarget, fp };
    })()`)) as { isTarget: boolean; fp: string | null } | null;

    if (check?.isTarget) {
      return true;
    }

    if (check?.fp) {
      if (seenActiveElements.has(check.fp)) {
        // Cycle detected: focus traversal wrapped around without reaching target
        break;
      }
      seenActiveElements.add(check.fp);
    }
  }

  return false;
}

async function resetSurface(
  browser: InteractionBrowser,
  initialUrl: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await browser.key('Escape');
    await browser.move(1, 1);
    await pause(60);
    const currentUrl = await browser.evaluate('window.location.href');
    if (typeof currentUrl === 'string') {
      const normCurrent = currentUrl.replace(/#.*$/, '').replace(/\/+$/, '');
      const normInitial = initialUrl.replace(/#.*$/, '').replace(/\/+$/, '');
      if (normCurrent !== normInitial) {
        await browser.navigate(initialUrl);
        await pause(300);
        const restoredUrl = await browser.evaluate('window.location.href');
        const normRestored = typeof restoredUrl === 'string' ? restoredUrl.replace(/#.*$/, '').replace(/\/+$/, '') : '';
        if (normRestored !== normInitial) {
          return { success: false, error: `Failed to restore initial URL: expected "${initialUrl}", found "${restoredUrl}"` };
        }
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export async function runControlStateJourneys(options: {
  reference: InteractionBrowser;
  clone: InteractionBrowser;
  inventory: InteractionInventoryItem[];
  viewport: string;
  mobile: boolean;
  referenceUrl: string;
  cloneUrl: string;
  save(path: string, content: string | Buffer): Promise<void>;
}): Promise<InteractionReceipt[]> {
  const receipts: InteractionReceipt[] = [];

  // Assign deterministic ordinal to disambiguate controls sharing (tag, name, href, inputType)
  const ordinalMap = new Map<string, number>();
  const descriptors: ElementDescriptor[] = options.inventory.map(rawItem => {
    const item = rawItem as InventoryControlItem;
    const key = `${item.tag}::${item.name}::${item.href || ''}::${item.inputType || ''}`;
    const ordinal = ordinalMap.get(key) || 0;
    ordinalMap.set(key, ordinal + 1);
    return {
      id: item.id,
      selector: item.selector,
      tag: item.tag,
      name: item.name,
      href: item.href,
      inputType: item.inputType,
      classes: item.classes,
      parentSelector: item.parentSelector,
      ordinal
    };
  });

  // FULL DISCOVERED DENOMINATOR: Every item in options.inventory is processed without sampling cap
  for (let i = 0; i < options.inventory.length; i++) {
    const item = options.inventory[i] as InventoryControlItem;
    const desc = descriptors[i];
    const states = item.states && item.states.length ? item.states : ['initial', 'hover', 'focus', 'activate', 'exit', 'reopen'];

    // 1. Hidden controls: attempt prerequisite opening (dropdown links, mobile drawer, modals)
    let openedPrereq = false;
    if (!item.visible && (item.parentSelector || item.classes?.length)) {
      const refOpened = await openPrerequisiteContainer(options.reference, desc, true);
      const cloneOpened = await openPrerequisiteContainer(options.clone, desc, false);
      openedPrereq = refOpened || cloneOpened;
      if (openedPrereq) await pause(150);
    }

    // If disabled or permanently hidden
    if (item.disabled) {
      for (const st of states) {
        receipts.push({
          id: `${item.id}-${st}`,
          viewport: options.viewport,
          verdict: 'UNVERIFIED',
          reason: `Control "${item.name || item.tag}" is disabled/inert in current state`,
          evidence: [],
          observations: [{ item, state: st, visible: item.visible, disabled: item.disabled }]
        });
      }
      if (openedPrereq) {
        await closePrerequisiteContainer(options.reference);
        await closePrerequisiteContainer(options.clone);
      }
      continue;
    }

    // Execute state journey across reference and clone
    // NOTE: Initial, hover, and focus are purely read-only observational states and run safely
    // for ALL controls. Only activate triggers live actions.
    try {
      await scrollIntoView(options.reference, desc, true);
      await scrollIntoView(options.clone, desc, false);
      await pause(80);

      const refInitial = await getObservableState(options.reference, desc, true);
      const cloneInitial = await getObservableState(options.clone, desc, false);

      // Initial State Receipt (Read-only observation)
      const initialReceipt: InteractionReceipt = {
        id: `${item.id}-initial`,
        viewport: options.viewport,
        verdict: 'UNVERIFIED',
        reason: '',
        evidence: [],
        observations: [{ refInitial, cloneInitial }]
      };

      if (!refInitial || !refInitial.visible) {
        initialReceipt.verdict = 'UNVERIFIED';
        initialReceipt.reason = openedPrereq
          ? 'Reference control remained hidden even after prerequisite opening attempted'
          : 'Control is not visible in initial viewport (resolver failed closed)';
        receipts.push(initialReceipt);
        for (const st of states.filter(s => s !== 'initial')) {
          receipts.push({
            id: `${item.id}-${st}`,
            viewport: options.viewport,
            verdict: 'UNVERIFIED',
            reason: 'Baseline reference control not observable',
            evidence: [],
            observations: []
          });
        }
        if (openedPrereq) {
          await closePrerequisiteContainer(options.reference);
          await closePrerequisiteContainer(options.clone);
        }
        continue;
      }

      if (!cloneInitial || !cloneInitial.visible) {
        initialReceipt.verdict = 'FAIL';
        initialReceipt.reason = 'Clone target missing or not resolved via semantic exact matching';
        receipts.push(initialReceipt);
        for (const st of states.filter(s => s !== 'initial')) {
          receipts.push({
            id: `${item.id}-${st}`,
            viewport: options.viewport,
            verdict: 'FAIL',
            reason: 'Clone target missing or not resolved via semantic exact matching',
            evidence: [],
            observations: []
          });
        }
        if (openedPrereq) {
          await closePrerequisiteContainer(options.reference);
          await closePrerequisiteContainer(options.clone);
        }
        continue;
      }

      // Verify C8 baseline geometry parity within 1px
      const initialC8 = verifyC8MetricParity(refInitial, cloneInitial, 1.0);
      if (!initialC8.pass) {
        initialReceipt.verdict = 'FAIL';
        initialReceipt.reason = initialC8.reason;
      } else {
        initialReceipt.verdict = 'PASS';
        initialReceipt.reason = `Both reference and clone present and visible at baseline; ${initialC8.reason}`;
      }

      const refInitShot = `${options.viewport}/${item.id}-initial-reference.png`;
      const cloneInitShot = `${options.viewport}/${item.id}-initial-clone.png`;
      await options.save(refInitShot, await options.reference.screenshot());
      await options.save(cloneInitShot, await options.clone.screenshot());
      initialReceipt.evidence.push(refInitShot, cloneInitShot);
      receipts.push(initialReceipt);

      // Determine control specializations using live class list
      const liveClasses = refInitial?.classes || [];
      const isSearch = isSearchInput(item);
      const isText = isTextEditable(item);
      const isSlider = isSliderControl(item, liveClasses);
      const isDisclosure = isEvidenceBackedLocalDisclosure(item, liveClasses, refInitial);
      const isNav = isOrdinaryNavigationLink(item);
      const isMutation = isSubmitOrRemoteMutation(item, refInitial, cloneInitial);

      // Hover State Receipt (Read-only observation)
      if (states.includes('hover')) {
        const hoverReceipt: InteractionReceipt = {
          id: `${item.id}-hover`,
          viewport: options.viewport,
          verdict: 'UNVERIFIED',
          reason: '',
          evidence: [],
          observations: []
        };

        if (options.mobile) {
          hoverReceipt.verdict = 'UNVERIFIED';
          hoverReceipt.reason = 'Hover state not applicable on mobile touch viewport';
        } else {
          try {
            await options.reference.move(refInitial.center.x, refInitial.center.y);
            await options.clone.move(cloneInitial.center.x, cloneInitial.center.y);
            await pause(100);

            const refHover = await getObservableState(options.reference, desc, true);
            const cloneHover = await getObservableState(options.clone, desc, false);
            hoverReceipt.observations.push({ refHover, cloneHover });

            if (!cloneHover?.hit) {
              hoverReceipt.verdict = 'FAIL';
              hoverReceipt.reason = 'Clone element occluded or not hit-testable on hover';
            } else if (!refHover?.hit) {
              hoverReceipt.verdict = 'UNVERIFIED';
              hoverReceipt.reason = 'Reference element occluded on hover';
            } else {
              // C7/C8: hit-only is insufficient for PASS. Must compare specific changed properties/effects and C8 rect/padding <= 1px
              const refColorDelta = refHover.hoverStyles.color !== refInitial.hoverStyles.color;
              const refBgDelta = refHover.hoverStyles.backgroundColor !== refInitial.hoverStyles.backgroundColor;
              const refBorderDelta = refHover.hoverStyles.borderColor !== refInitial.hoverStyles.borderColor;
              const refCursorDelta = refHover.hoverStyles.cursor !== refInitial.hoverStyles.cursor;
              const refClassDelta = refHover.classes.join(' ') !== refInitial.classes.join(' ');
              const refPopupDelta = hasPopupDelta(refInitial, refHover);
              const refHasObservableDelta = refColorDelta || refBgDelta || refBorderDelta || refCursorDelta || refClassDelta || refPopupDelta;

              const cloneColorDelta = cloneHover.hoverStyles.color !== cloneInitial.hoverStyles.color;
              const cloneBgDelta = cloneHover.hoverStyles.backgroundColor !== cloneInitial.hoverStyles.backgroundColor;
              const cloneBorderDelta = cloneHover.hoverStyles.borderColor !== cloneInitial.hoverStyles.borderColor;
              const cloneCursorDelta = cloneHover.hoverStyles.cursor !== cloneInitial.hoverStyles.cursor;
              const cloneClassDelta = cloneHover.classes.join(' ') !== cloneInitial.classes.join(' ');
              const clonePopupDelta = hasPopupDelta(cloneInitial, cloneHover);
              const cloneHasObservableDelta = cloneColorDelta || cloneBgDelta || cloneBorderDelta || cloneCursorDelta || cloneClassDelta || clonePopupDelta;

              // Check C8 geometry parity on hover
              const hoverC8 = verifyC8MetricParity(refHover, cloneHover, 1.0);

              if (refHasObservableDelta && cloneHasObservableDelta) {
                let matchesSpecificProperty = true;
                if (refColorDelta && !cloneColorDelta) matchesSpecificProperty = false;
                if (refBgDelta && !cloneBgDelta) matchesSpecificProperty = false;
                if (refPopupDelta && !clonePopupDelta) matchesSpecificProperty = false;

                if (!matchesSpecificProperty) {
                  hoverReceipt.verdict = 'FAIL';
                  hoverReceipt.reason = 'Hover property disparity: clone did not exhibit matching specific style/popup delta';
                } else if (!hoverC8.pass) {
                  hoverReceipt.verdict = 'FAIL';
                  hoverReceipt.reason = `Hover C8 metric disparity: ${hoverC8.reason}`;
                } else {
                  hoverReceipt.verdict = 'PASS';
                  hoverReceipt.reason = `Observable hover effect and C8 geometry parity verified on reference and clone (${hoverC8.reason})`;
                  const refHovShot = `${options.viewport}/${item.id}-hover-reference.png`;
                  const cloneHovShot = `${options.viewport}/${item.id}-hover-clone.png`;
                  await options.save(refHovShot, await options.reference.screenshot());
                  await options.save(cloneHovShot, await options.clone.screenshot());
                  hoverReceipt.evidence.push(refHovShot, cloneHovShot);
                }
              } else if (refHasObservableDelta && !cloneHasObservableDelta) {
                hoverReceipt.verdict = 'FAIL';
                hoverReceipt.reason = 'Hover delta disparity: reference exhibited hover style change, clone did not';
              } else {
                hoverReceipt.verdict = 'UNVERIFIED';
                hoverReceipt.reason = 'Hit-testable on hover, but no observable hover delta on reference oracle (C7/C8 unverified)';
              }
            }
          } catch (err) {
            hoverReceipt.verdict = 'FAIL';
            hoverReceipt.reason = `Hover execution error: ${String(err)}`;
          }
        }
        receipts.push(hoverReceipt);
      }

      // Focus State Receipt (Native keyboard Tab journey only; read-only observation)
      if (states.includes('focus')) {
        const focusReceipt: InteractionReceipt = {
          id: `${item.id}-focus`,
          viewport: options.viewport,
          verdict: 'UNVERIFIED',
          reason: '',
          evidence: [],
          observations: []
        };

        try {
          const refTabLanded = await tabToElementNatively(options.reference, desc, true);
          const cloneTabLanded = await tabToElementNatively(options.clone, desc, false);
          await pause(60);

          const refFocus = await getObservableState(options.reference, desc, true);
          const cloneFocus = await getObservableState(options.clone, desc, false);
          focusReceipt.observations.push({ refTabLanded, cloneTabLanded, refFocus, cloneFocus });

          if (refFocus?.focused && cloneFocus?.focused) {
            const focusC8 = verifyC8MetricParity(refFocus, cloneFocus, 1.0);
            if (!focusC8.pass) {
              focusReceipt.verdict = 'FAIL';
              focusReceipt.reason = `Focus C8 metric disparity: ${focusC8.reason}`;
            } else {
              focusReceipt.verdict = 'PASS';
              focusReceipt.reason = `Native keyboard Tab focus successfully acquired with C8 metric parity (${focusC8.reason})`;
              const refFocShot = `${options.viewport}/${item.id}-focus-reference.png`;
              const cloneFocShot = `${options.viewport}/${item.id}-focus-clone.png`;
              await options.save(refFocShot, await options.reference.screenshot());
              await options.save(cloneFocShot, await options.clone.screenshot());
              focusReceipt.evidence.push(refFocShot, cloneFocShot);
            }
          } else if (refFocus?.focused && !cloneFocus?.focused) {
            focusReceipt.verdict = 'FAIL';
            focusReceipt.reason = 'Native keyboard Tab focus disparity: reference acquired focus, clone did not';
          } else {
            focusReceipt.verdict = 'UNVERIFIED';
            focusReceipt.reason = 'Native keyboard Tab did not land on target control in document tab order';
          }
        } catch (err) {
          focusReceipt.verdict = 'FAIL';
          focusReceipt.reason = `Focus error: ${String(err)}`;
        }
        receipts.push(focusReceipt);
      }

      // Activate State Receipt (Constrained to Safe Evidence-Backed Local Disclosure only)
      let refActiveState: ObservableControlState | null = null;
      let cloneActiveState: ObservableControlState | null = null;

      if (states.includes('activate')) {
        const activateReceipt: InteractionReceipt = {
          id: `${item.id}-activate`,
          viewport: options.viewport,
          verdict: 'UNVERIFIED',
          reason: '',
          evidence: [],
          observations: []
        };

        if (isMutation) {
          // Safety policy: form submission / backend mutation blocked
          activateReceipt.verdict = 'BLOCKED';
          activateReceipt.reason = `Safe action policy: remote data mutation / form submission blocked for control "${item.name || item.tag}"`;
          activateReceipt.observations.push({ safeActionRule: 'NO_SUBMIT_MUTATION' });
        } else if (isNav) {
          // Ordinary navigation links prohibited from clicking to prevent page teardown
          activateReceipt.verdict = 'UNVERIFIED';
          activateReceipt.reason = 'Ordinary navigation link click prohibited during in-page control suite to prevent page teardown; route suite handles route transitions';
        } else if (isSearch) {
          // Read-only search typing is NOT a mutation by itself, but unknown handlers unverified
          try {
            await options.reference.click(refInitial.center.x, refInitial.center.y);
            await options.clone.click(cloneInitial.center.x, cloneInitial.center.y);
            await pause(60);
            await options.reference.type('antifan');
            await options.clone.type('antifan');
            await pause(100);

            refActiveState = await getObservableState(options.reference, desc, true);
            cloneActiveState = await getObservableState(options.clone, desc, false);
            activateReceipt.observations.push({ refActiveState, cloneActiveState });

            if (refActiveState?.value === 'antifan' && cloneActiveState?.value === 'antifan') {
              activateReceipt.verdict = 'PASS';
              activateReceipt.reason = 'Search input accepted typed value natively on reference and clone without triggering remote form submit';
              const refActShot = `${options.viewport}/${item.id}-activate-reference.png`;
              const cloneActShot = `${options.viewport}/${item.id}-activate-clone.png`;
              await options.save(refActShot, await options.reference.screenshot());
              await options.save(cloneActShot, await options.clone.screenshot());
              activateReceipt.evidence.push(refActShot, cloneActShot);
            } else if (refActiveState?.value === 'antifan' && cloneActiveState?.value !== 'antifan') {
              activateReceipt.verdict = 'FAIL';
              activateReceipt.reason = `Search input value disparity: reference accepted value, clone was "${cloneActiveState?.value}"`;
            } else {
              activateReceipt.verdict = 'UNVERIFIED';
              activateReceipt.reason = 'Search input did not accept typed value on reference oracle';
            }
          } catch (err) {
            activateReceipt.verdict = 'FAIL';
            activateReceipt.reason = `Search typing error: ${String(err)}`;
          }
        } else if (isText) {
          // Other text inputs not classified as search: blocked from unconstrained typing
          activateReceipt.verdict = 'BLOCKED';
          activateReceipt.reason = 'Non-search text input typing blocked on live production reference pending explicit safe contract';
          activateReceipt.observations.push({ safeActionRule: 'UNCONSTRAINED_TYPING_DISALLOWED' });
        } else if (!isDisclosure) {
          // Clicks: only allow evidence-backed local disclosure controls with known target
          // (.menu-mobile, .open-login, .video-content__button, .popup-close, .info-more__button, .systerm .item-cta, semantic aria-controls/details)
          activateReceipt.verdict = 'BLOCKED';
          activateReceipt.reason = 'Activation blocked by safety policy: unconstrained native click disallowed on live production reference without explicit safe local disclosure contract';
          activateReceipt.observations.push({ safeActionRule: 'UNCONSTRAINED_CLICK_DISALLOWED' });
        } else {
          // Evidence-backed local disclosure control with known target: safe native click journey
          try {
            await options.reference.click(refInitial.center.x, refInitial.center.y);
            await options.clone.click(cloneInitial.center.x, cloneInitial.center.y);
            await pause(250);

            refActiveState = await getObservableState(options.reference, desc, true);
            cloneActiveState = await getObservableState(options.clone, desc, false);
            activateReceipt.observations.push({ refActiveState, cloneActiveState });

            // Compare specific changed properties/effects and C8 rect/padding <= 1px
            const refPopupDelta = hasPopupDelta(refInitial, refActiveState);
            const clonePopupDelta = hasPopupDelta(cloneInitial, cloneActiveState);
            const refClassDelta = refActiveState?.classes.join(' ') !== refInitial.classes.join(' ');
            const cloneClassDelta = cloneActiveState?.classes.join(' ') !== cloneInitial.classes.join(' ');
            const refAriaDelta = refActiveState?.ariaExpanded !== refInitial.ariaExpanded && refActiveState?.ariaExpanded != null;
            const cloneAriaDelta = cloneActiveState?.ariaExpanded !== cloneInitial.ariaExpanded && cloneActiveState?.ariaExpanded != null;
            const refSlideDelta = refActiveState?.slideIndex !== refInitial.slideIndex && refActiveState?.slideIndex != null;
            const cloneSlideDelta = cloneActiveState?.slideIndex !== cloneInitial.slideIndex && cloneActiveState?.slideIndex != null;

            const refObserved = refPopupDelta || refClassDelta || refAriaDelta || refSlideDelta;
            const cloneObserved = clonePopupDelta || cloneClassDelta || cloneAriaDelta || cloneSlideDelta;

            if (refObserved && cloneObserved && refActiveState && cloneActiveState) {
              let matchesSpecificEffect = true;
              let specificReason = '';

              if (refPopupDelta) {
                const refPopupDisplay = refActiveState.popupState?.display || refActiveState.externalTargetState?.display;
                const clonePopupDisplay = cloneActiveState.popupState?.display || cloneActiveState.externalTargetState?.display;
                if (refPopupDisplay !== clonePopupDisplay) {
                  matchesSpecificEffect = false;
                } else {
                  specificReason = `popup/modal opened with display="${refPopupDisplay}"`;
                }
              } else if (refSlideDelta) {
                if (refActiveState.slideIndex !== cloneActiveState.slideIndex) {
                  matchesSpecificEffect = false;
                } else {
                  specificReason = `slider shifted to index ${refActiveState.slideIndex}`;
                }
              } else if (refAriaDelta) {
                if (refActiveState.ariaExpanded !== cloneActiveState.ariaExpanded) {
                  matchesSpecificEffect = false;
                } else {
                  specificReason = `aria-expanded="${refActiveState.ariaExpanded}"`;
                }
              } else if (refClassDelta) {
                specificReason = 'class mutation observed';
              }

              const activeC8 = verifyC8MetricParity(refActiveState, cloneActiveState, 1.0);

              if (!matchesSpecificEffect) {
                activateReceipt.verdict = 'FAIL';
                activateReceipt.reason = 'Activation effect disparity: clone did not reproduce specific effect observed on reference';
              } else if (!activeC8.pass) {
                activateReceipt.verdict = 'FAIL';
                activateReceipt.reason = `Activation C8 metric disparity: ${activeC8.reason}`;
              } else {
                activateReceipt.verdict = 'PASS';
                activateReceipt.reason = `Specific observable transition verified (${specificReason}) and C8 metric parity confirmed`;
                const refActShot = `${options.viewport}/${item.id}-activate-reference.png`;
                const cloneActShot = `${options.viewport}/${item.id}-activate-clone.png`;
                await options.save(refActShot, await options.reference.screenshot());
                await options.save(cloneActShot, await options.clone.screenshot());
                activateReceipt.evidence.push(refActShot, cloneActShot);
              }
            } else if (refObserved && !cloneObserved) {
              activateReceipt.verdict = 'FAIL';
              activateReceipt.reason = 'Activation state disparity: reference triggered observable transition, clone failed to respond';
            } else {
              activateReceipt.verdict = 'UNVERIFIED';
              activateReceipt.reason = 'No observable state transition on reference oracle upon activation; unknown target transition';
            }
          } catch (err) {
            activateReceipt.verdict = 'FAIL';
            activateReceipt.reason = `Activation error: ${String(err)}`;
          }
        }
        receipts.push(activateReceipt);
      }

      // Exit State Receipt (Close / Escape / Reset)
      if (states.includes('exit')) {
        const exitReceipt: InteractionReceipt = {
          id: `${item.id}-exit`,
          viewport: options.viewport,
          verdict: 'UNVERIFIED',
          reason: '',
          evidence: [],
          observations: []
        };

        try {
          const wasOpen = refActiveStateIsOpen(refActiveState, refInitial);
          await options.reference.key('Escape');
          await options.clone.key('Escape');
          await options.reference.move(1, 1);
          await options.clone.move(1, 1);
          await pause(150);

          const refExit = await getObservableState(options.reference, desc, true);
          const cloneExit = await getObservableState(options.clone, desc, false);
          exitReceipt.observations.push({ refExit, cloneExit });

          if (wasOpen && refExit && cloneExit) {
            const refClosed = !refActiveStateIsOpen(refExit, refInitial);
            const cloneClosed = !refActiveStateIsOpen(cloneExit, cloneInitial);

            if (refClosed && cloneClosed) {
              const exitC8 = verifyC8MetricParity(refExit, cloneExit, 1.0);
              if (!exitC8.pass) {
                exitReceipt.verdict = 'FAIL';
                exitReceipt.reason = `Exit C8 metric disparity: ${exitC8.reason}`;
              } else {
                exitReceipt.verdict = 'PASS';
                exitReceipt.reason = `Exit action (Escape) closed active state with C8 metric parity (${exitC8.reason})`;
                const refExitShot = `${options.viewport}/${item.id}-exit-reference.png`;
                const cloneExitShot = `${options.viewport}/${item.id}-exit-clone.png`;
                await options.save(refExitShot, await options.reference.screenshot());
                await options.save(cloneExitShot, await options.clone.screenshot());
                exitReceipt.evidence.push(refExitShot, cloneExitShot);
              }
            } else if (refClosed && !cloneClosed) {
              exitReceipt.verdict = 'FAIL';
              exitReceipt.reason = 'Exit disparity: reference closed active state on Escape, clone remained open';
            } else {
              exitReceipt.verdict = 'UNVERIFIED';
              exitReceipt.reason = 'Reference oracle did not close active state on Escape';
            }
          } else {
            exitReceipt.verdict = 'UNVERIFIED';
            exitReceipt.reason = 'No active open state to exit; exit transition unobservable';
          }
        } catch (err) {
          exitReceipt.verdict = 'FAIL';
          exitReceipt.reason = `Exit error: ${String(err)}`;
        }
        receipts.push(exitReceipt);
      }

      // Reopen State Receipt (for toggles)
      if (states.includes('reopen')) {
        const reopenReceipt: InteractionReceipt = {
          id: `${item.id}-reopen`,
          viewport: options.viewport,
          verdict: 'UNVERIFIED',
          reason: '',
          evidence: [],
          observations: []
        };

        try {
          const activatePassed = receipts.find(r => r.id === `${item.id}-activate`)?.verdict === 'PASS';
          const exitPassed = receipts.find(r => r.id === `${item.id}-exit`)?.verdict === 'PASS';

          if (isDisclosure && activatePassed && exitPassed) {
            await scrollIntoView(options.reference, desc, true);
            await scrollIntoView(options.clone, desc, false);
            await pause(60);
            const refCenter = (await getObservableState(options.reference, desc, true))?.center || refInitial.center;
            const cloneCenter = (await getObservableState(options.clone, desc, false))?.center || cloneInitial.center;

            await options.reference.click(refCenter.x, refCenter.y);
            await options.clone.click(cloneCenter.x, cloneCenter.y);
            await pause(200);

            const refReopen = await getObservableState(options.reference, desc, true);
            const cloneReopen = await getObservableState(options.clone, desc, false);
            reopenReceipt.observations.push({ refReopen, cloneReopen });

            const refReopened = refActiveStateIsOpen(refReopen, refInitial);
            const cloneReopened = refActiveStateIsOpen(cloneReopen, cloneInitial);

            if (refReopened && cloneReopened && refReopen && cloneReopen) {
              const reopenC8 = verifyC8MetricParity(refReopen, cloneReopen, 1.0);
              if (!reopenC8.pass) {
                reopenReceipt.verdict = 'FAIL';
                reopenReceipt.reason = `Reopen C8 metric disparity: ${reopenC8.reason}`;
              } else {
                reopenReceipt.verdict = 'PASS';
                reopenReceipt.reason = `Reopen toggle cycle completed with C8 metric parity (${reopenC8.reason})`;
                const refReopenShot = `${options.viewport}/${item.id}-reopen-reference.png`;
                const cloneReopenShot = `${options.viewport}/${item.id}-reopen-clone.png`;
                await options.save(refReopenShot, await options.reference.screenshot());
                await options.save(cloneReopenShot, await options.clone.screenshot());
                reopenReceipt.evidence.push(refReopenShot, cloneReopenShot);
              }
            } else if (refReopened && !cloneReopened) {
              reopenReceipt.verdict = 'FAIL';
              reopenReceipt.reason = 'Reopen disparity: reference re-opened on click, clone did not';
            } else {
              reopenReceipt.verdict = 'UNVERIFIED';
              reopenReceipt.reason = 'Reference oracle did not re-open upon second click';
            }
          } else {
            reopenReceipt.verdict = 'UNVERIFIED';
            reopenReceipt.reason = 'Reopen state not applicable; control is not a local disclosure toggle or prior open-close cycle was not established';
          }
        } catch (err) {
          reopenReceipt.verdict = 'FAIL';
          reopenReceipt.reason = `Reopen error: ${String(err)}`;
        }
        receipts.push(reopenReceipt);
      }

      // Clean up prerequisite container if it was opened
      if (openedPrereq) {
        await closePrerequisiteContainer(options.reference);
        await closePrerequisiteContainer(options.clone);
      }

      // Reset surface state and fail receipt if restore fails (preventing hidden state poisoning)
      const refReset = await resetSurface(options.reference, options.referenceUrl);
      const cloneReset = await resetSurface(options.clone, options.cloneUrl);
      if (!refReset.success || !cloneReset.success) {
        const restoreError = `Surface restore failure: ref=${refReset.error || 'ok'}, clone=${cloneReset.error || 'ok'}`;
        receipts.push({
          id: `${item.id}-surface-reset`,
          viewport: options.viewport,
          verdict: 'FAIL',
          reason: `Surface restore failure (state poisoning prevented): ${restoreError}`,
          evidence: [],
          observations: [{ refReset, cloneReset }]
        });
      }

      // Ensure NO state in item.states is omitted
      for (const st of states) {
        if (!receipts.some(r => r.id === `${item.id}-${st}`)) {
          receipts.push({
            id: `${item.id}-${st}`,
            viewport: options.viewport,
            verdict: 'UNVERIFIED',
            reason: `State "${st}" unexecuted or unsupported for control "${item.name || item.tag}"`,
            evidence: [],
            observations: [{ item, state: st }]
          });
        }
      }
    } catch (error) {
      if (openedPrereq) {
        await closePrerequisiteContainer(options.reference);
        await closePrerequisiteContainer(options.clone);
      }
      const refReset = await resetSurface(options.reference, options.referenceUrl);
      const cloneReset = await resetSurface(options.clone, options.cloneUrl);
      if (!refReset.success || !cloneReset.success) {
        receipts.push({
          id: `${item.id}-surface-reset`,
          viewport: options.viewport,
          verdict: 'FAIL',
          reason: `Surface restore failure after error: ref=${refReset.error || 'ok'}, clone=${cloneReset.error || 'ok'}`,
          evidence: [],
          observations: [{ refReset, cloneReset }]
        });
      }

      for (const st of states) {
        if (!receipts.some(r => r.id === `${item.id}-${st}`)) {
          receipts.push({
            id: `${item.id}-${st}`,
            viewport: options.viewport,
            verdict: 'FAIL',
            reason: `Journey execution exception: ${String(error)}`,
            evidence: [],
            observations: [{ error: String(error) }]
          });
        }
      }
    }
  }

  return receipts;
}
