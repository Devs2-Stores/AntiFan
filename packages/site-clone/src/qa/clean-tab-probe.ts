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
      // 1. Behavior: Brand Tabs Switching
      evaluator(`(() => {
        const tabs = document.querySelectorAll('.tabs .tab-item, .accessory-tabs li');
        if (tabs.length < 2) return { passed: false, reason: 'Less than 2 tabs found' };
        
        const initialActive = tabs[0].classList.contains('active');
        tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        
        const tab1After = tabs[0].classList.contains('active');
        const tab2After = tabs[1].classList.contains('active');
        
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
      }).catch(err => ({
        name: 'brand_tabs_switching',
        passed: false,
        error: String(err)
      })),

      // 2. Behavior: Category Submenu Hover
      evaluator(`(() => {
        const item = document.querySelector('.category-navigation__list ul li');
        const subMenu = document.getElementById('category-navigation__sub');
        if (!item || !subMenu) return { passed: false, reason: 'Navigation item or subMenu missing' };
        
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const activeAfterEnter = subMenu.classList.contains('active') || subMenu.style.display !== 'none';
        
        const nav = document.querySelector('.category-navigation');
        if (nav) nav.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        
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
      }).catch(err => ({
        name: 'category_submenu_hover',
        passed: false,
        error: String(err)
      })),

      // 3. Behavior: Branch Selector Dropdown Toggle
      evaluator(`(() => {
        const btn = document.querySelector('.systerm .item-cta');
        const list = document.getElementById('systerm-list');
        if (!btn || !list) return { passed: false, reason: 'Branch selector elements missing' };
        
        const initialDisplay = window.getComputedStyle(list).display;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const openedDisplay = window.getComputedStyle(list).display;
        
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const closedDisplay = window.getComputedStyle(list).display;
        
        return {
          passed: openedDisplay === 'block' && (closedDisplay === 'none' || initialDisplay === 'none'),
          details: { initialDisplay, openedDisplay, closedDisplay }
        };
      })()`).then((res) => {
        const parsed = parseProbeResult(res);
        return {
          name: 'branch_selector_toggle',
          passed: Boolean(parsed?.passed),
          details: parsed?.details
        };
      }).catch(err => ({
        name: 'branch_selector_toggle',
        passed: false,
        error: String(err)
      })),

      // 4. Behavior: Video Modal Open & Close
      evaluator(`(() => {
        const videoBtn = document.querySelector('.video-content__button');
        const popup = document.getElementById('popup-video');
        const closeBtn = document.querySelector('.popup-close');
        if (!videoBtn || !popup) return { passed: false, reason: 'Video modal elements missing' };
        
        const initialDisplay = window.getComputedStyle(popup).display;
        videoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const openedDisplay = window.getComputedStyle(popup).display;
        
        if (closeBtn) closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const closedDisplay = window.getComputedStyle(popup).display;
        
        return {
          passed: openedDisplay === 'flex' && (closedDisplay === 'none' || initialDisplay === 'none'),
          details: { initialDisplay, openedDisplay, closedDisplay }
        };
      })()`).then((res) => {
        const parsed = parseProbeResult(res);
        return {
          name: 'video_modal_open_close',
          passed: Boolean(parsed?.passed),
          details: parsed?.details
        };
      }).catch(err => ({
        name: 'video_modal_open_close',
        passed: false,
        error: String(err)
      }))
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
