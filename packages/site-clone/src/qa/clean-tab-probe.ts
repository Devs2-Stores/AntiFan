/**
 * QA: Clean Tab Probe
 * Executes real interactive behavioral assertions on clean-reloaded tabs
 */

export interface InteractiveCheckResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

interface ProbeEvalResult {
  passed: boolean;
  details?: Record<string, unknown>;
  reason?: string;
}

function parseProbeResult(val: unknown): ProbeEvalResult | null {
  if (val && typeof val === 'object' && 'passed' in val) {
    const candidate = val as { passed?: unknown; details?: unknown; reason?: unknown };
    return {
      passed: Boolean(candidate.passed),
      details: typeof candidate.details === 'object' && candidate.details !== null ? (candidate.details as Record<string, unknown>) : undefined,
      reason: typeof candidate.reason === 'string' ? candidate.reason : undefined
    };
  }
  return null;
}

export class CleanTabProbe {
  public static async verifyInteractiveChecks(evaluator: (expr: string) => Promise<unknown>): Promise<InteractiveCheckResult[]> {
    return Promise.all([
      // 1. Behavior: Universal Tabs / Toggle Switching
      evaluator(`(() => {
        const tabs = document.querySelectorAll('[data-antifan-toggle], .tabs .tab-item, .accessory-tabs li');
        if (tabs.length < 2) return { passed: false, reason: 'Less than 2 tabs found' };
        
        const initialActive = tabs[0].classList.contains('active') || tabs[0].getAttribute('aria-expanded') === 'true';
        tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        
        const tab1After = tabs[0].classList.contains('active') || tabs[0].getAttribute('aria-expanded') === 'true';
        const tab2After = tabs[1].classList.contains('active') || tabs[1].getAttribute('aria-expanded') === 'true';
        
        // Restore tab 0
        tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        
        return {
          passed: tab2After && !tab1After,
          details: { initialActive, tab1After, tab2After }
        };
      })()`).then((res) => {
        const parsed = parseProbeResult(res);
        return {
          name: 'brand_tabs_switching',
          passed: Boolean(parsed?.passed),
          details: parsed?.details
        };
      }).catch((err) => ({
        name: 'brand_tabs_switching',
        passed: false,
        error: String(err)
      })),

      // 2. Behavior: Dropdown Hover / Category Submenu
      evaluator(`(() => {
        const item = document.querySelector('[data-antifan-hover], .category-navigation__list ul li');
        if (!item) return { passed: false, reason: 'Hover item missing' };
        const subMenuSel = item.getAttribute('data-antifan-target') || item.getAttribute('data-antifan-hover');
        const subMenu = subMenuSel ? document.querySelector(subMenuSel) : (item.querySelector('[data-antifan-dropdown-panel]') || document.getElementById('category-navigation__sub'));
        if (!subMenu) return { passed: false, reason: 'Dropdown subMenu missing' };
        
        item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const activeAfterEnter = subMenu.classList.contains('active') || subMenu.style.display !== 'none';
        
        item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        item.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        
        return {
          passed: activeAfterEnter,
          details: { activeAfterEnter }
        };
      })()`).then((res) => {
        const parsed = parseProbeResult(res);
        return {
          name: 'category_submenu_hover',
          passed: Boolean(parsed?.passed),
          details: parsed?.details
        };
      }).catch((err) => ({
        name: 'category_submenu_hover',
        passed: false,
        error: String(err)
      })),

      // 3. Behavior: Dropdown Toggle / Branch Selector
      evaluator(`(() => {
        const btn = document.querySelector('[data-antifan-toggle], .systerm .item-cta');
        if (!btn) return { passed: false, reason: 'Toggle button missing' };
        const targetSel = btn.getAttribute('data-antifan-target') || btn.getAttribute('data-antifan-toggle');
        const list = targetSel ? document.querySelector(targetSel) : (document.getElementById('systerm-list') || btn.nextElementSibling);
        if (!list) return { passed: false, reason: 'Toggle target element missing' };
        
        const initialDisplay = window.getComputedStyle(list).display;
        const initialActive = list.classList.contains('active');
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const openedDisplay = window.getComputedStyle(list).display;
        const openedActive = list.classList.contains('active');
        
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const closedDisplay = window.getComputedStyle(list).display;
        const closedActive = list.classList.contains('active');
        
        return {
          passed: (openedActive || openedDisplay === 'block') && (!closedActive || closedDisplay === 'none' || initialDisplay === 'none'),
          details: { initialDisplay, openedDisplay, closedDisplay, openedActive, closedActive }
        };
      })()`).then((res) => {
        const parsed = parseProbeResult(res);
        return {
          name: 'branch_selector_toggle',
          passed: Boolean(parsed?.passed),
          details: parsed?.details
        };
      }).catch((err) => ({
        name: 'branch_selector_toggle',
        passed: false,
        error: String(err)
      })),

      // 4. Behavior: Modal Dialog Open & Close
      evaluator(`(() => {
        const modalBtn = document.querySelector('[data-antifan-modal], .video-content__button');
        if (!modalBtn) return { passed: false, reason: 'Modal trigger button missing' };
        const modalSel = modalBtn.getAttribute('data-antifan-target') || modalBtn.getAttribute('data-antifan-modal');
        const popup = modalSel ? document.querySelector(modalSel) : (document.querySelector('[data-antifan-modal-dialog]') || document.getElementById('popup-video'));
        if (!popup) return { passed: false, reason: 'Modal dialog missing' };
        
        const initialDisplay = window.getComputedStyle(popup).display;
        const initialActive = popup.classList.contains('active');
        modalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const openedDisplay = window.getComputedStyle(popup).display;
        const openedActive = popup.classList.contains('active');
        
        const closeBtn = popup.querySelector('[data-antifan-modal-close], .popup-close, .close-btn');
        if (closeBtn) closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        else popup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const closedDisplay = window.getComputedStyle(popup).display;
        const closedActive = popup.classList.contains('active');
        
        return {
          passed: (openedActive || openedDisplay === 'flex' || openedDisplay === 'block') && (!closedActive || closedDisplay === 'none' || initialDisplay === 'none'),
          details: { initialDisplay, openedDisplay, closedDisplay, openedActive, closedActive }
        };
      })()`).then((res) => {
        const parsed = parseProbeResult(res);
        return {
          name: 'video_modal_open_close',
          passed: Boolean(parsed?.passed),
          details: parsed?.details
        };
      }).catch((err) => ({
        name: 'video_modal_open_close',
        passed: false,
        error: String(err)
      })),
    ]);
  }
  public static async verifyCriticalBreaks(evaluator: (expr: string) => Promise<unknown>): Promise<{
    passed: boolean;
    breaks: Array<{ id: string; name: string; passed: boolean; details?: string }>;
  }> {
    const results = await Promise.all([
      // Break 1: Viewport Overflow (No horizontal scroll leak)
      evaluator(`(() => {
        const docWidth = document.documentElement.scrollWidth;
        const winWidth = window.innerWidth;
        const deltaX = docWidth - winWidth;
        return {
          passed: deltaX <= 2,
          details: \`scrollWidth: \${docWidth}px, innerWidth: \${winWidth}px, deltaX: \${deltaX}px\`
        };
      })()`).then(res => {
        const p = parseProbeResult(res);
        return { id: 'break_1_overflow', name: 'Horizontal Viewport Overflow', passed: Boolean(p?.passed), details: typeof p?.details === 'string' ? p.details : JSON.stringify(p?.details || {}) };
      }).catch(err => ({ id: 'break_1_overflow', name: 'Horizontal Viewport Overflow', passed: false, details: String(err) })),

      // Break 2: Commercial Action Integrity
      evaluator(`(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        const productCards = Array.from(document.querySelectorAll('.product-card, [data-product-id], .product-item'));
        const hasFormsOrProducts = forms.length > 0 || productCards.length > 0;
        return {
          passed: hasFormsOrProducts,
          details: \`forms: \${forms.length}, productCards: \${productCards.length}\`
        };
      })()`).then(res => {
        const p = parseProbeResult(res);
        return { id: 'break_2_commercial', name: 'Commercial Action & Product Integrity', passed: Boolean(p?.passed), details: typeof p?.details === 'string' ? p.details : JSON.stringify(p?.details || {}) };
      }).catch(err => ({ id: 'break_2_commercial', name: 'Commercial Action & Product Integrity', passed: false, details: String(err) })),

      // Break 3: Liquid Syntax & Variable Leakage
      evaluator(`(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        const leakedTags = [];
        const pattern = /\\{\\{|\\{%/;
        while ((node = walker.nextNode())) {
          const text = node.textContent || '';
          if (pattern.test(text) && !node.parentElement?.closest('script, style, code, pre')) {
            leakedTags.push(text.trim().slice(0, 50));
            if (leakedTags.length >= 5) break;
          }
        }
        return {
          passed: leakedTags.length === 0,
          details: leakedTags.length === 0 ? 'Zero Liquid syntax leakage' : \`Leaked tags: \${leakedTags.join(', ')}\`
        };
      })()`).then(res => {
        const p = parseProbeResult(res);
        return { id: 'break_3_liquid_leak', name: 'Liquid Syntax & Variable Leakage', passed: Boolean(p?.passed), details: typeof p?.details === 'string' ? p.details : JSON.stringify(p?.details || {}) };
      }).catch(err => ({ id: 'break_3_liquid_leak', name: 'Liquid Syntax & Variable Leakage', passed: false, details: String(err) }))
    ]);

    const passed = results.every(r => r.passed);
    return { passed, breaks: results };
  }
}
