import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

describe('Priority 2: Behavior Verification Core & Dual-Scope Semantic Inference', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: 'run-1',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  it('1. Detects MODAL_OPENED with body overflow lock and dialog overlay appearance', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        // Before state (call 1)
        if (callCount === 1) {
          return {
            url: 'https://storefront.dev/',
            title: 'Storefront',
            bodyClasses: [],
            bodyOverflowLocked: false,
            bodyOverflowY: 'auto',
            bodyOverflowX: 'hidden',
            target: { found: true, tagName: 'button', classes: ['btn-modal'], rect: { width: 100, height: 40 }, ariaExpanded: null },
            activeOverlays: [],
            hasHorizontalOverflow: false,
          };
        }
        // After state (call 2)
        return {
          url: 'https://storefront.dev/',
          title: 'Storefront',
          bodyClasses: ['modal-open'],
          bodyOverflowLocked: true,
          bodyOverflowY: 'hidden',
          bodyOverflowX: 'hidden',
          target: { found: true, tagName: 'button', classes: ['btn-modal'], rect: { width: 100, height: 40 }, ariaExpanded: null },
          activeOverlays: [
            { tagName: 'div', id: 'promo-modal', className: 'modal show', rect: { width: 600, height: 400 }, role: 'dialog' },
          ],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.btn-modal', settleMs: 10 });

    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.verdict, 'MODAL_OPENED');
    assert.ok((res.confidence as number) >= 0.95);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.bodyDelta.overflowLocked, true);
    assert.strictEqual(evidence.overlays.openedCount, 1);
  });

  it('2. Detects DRAWER_EXPANDED when nav-open class is added to body and drawer overlay appears', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            url: 'https://storefront.dev/',
            title: 'Storefront',
            bodyClasses: [],
            bodyOverflowLocked: false,
            activeOverlays: [],
            hasHorizontalOverflow: false,
          };
        }
        return {
          url: 'https://storefront.dev/',
          title: 'Storefront',
          bodyClasses: ['nav-open'],
          bodyOverflowLocked: true,
          activeOverlays: [
            { tagName: 'aside', id: 'mobile-nav', className: 'drawer active', rect: { width: 320, height: 800 } },
          ],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.menu-toggle', settleMs: 10 });

    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.verdict, 'DRAWER_EXPANDED');
    assert.ok((res.confidence as number) >= 0.95);
    const evidence = res.evidence as Record<string, any>;
    assert.deepStrictEqual(evidence.bodyDelta.classesAdded, ['nav-open']);
  });

  it('3. Detects SUBMENU_EXPANDED when aria-expanded flips false to true on hover', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentHover: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          title: 'Storefront',
          bodyClasses: [],
          bodyOverflowLocked: false,
          target: {
            found: true,
            tagName: 'a',
            classes: ['nav-link'],
            rect: { width: 120, height: 40 },
            ariaExpanded: callCount === 1 ? 'false' : 'true',
          },
          activeOverlays: callCount === 1 ? [] : [{ tagName: 'ul', className: 'submenu open', rect: { width: 240, height: 300 } }],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'hover', selector: '.category-item', settleMs: 10 });

    assert.strictEqual(res.action, 'hover');
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.verdict, 'SUBMENU_EXPANDED');
  });

  it('4. Detects PAGE_NAVIGATION when URL changes after link click', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: callCount === 1 ? 'https://storefront.dev/' : 'https://storefront.dev/products/shirt-blue',
          title: callCount === 1 ? 'Home' : 'Blue Shirt',
          bodyClasses: [],
          bodyOverflowLocked: false,
          activeOverlays: [],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.product-card', settleMs: 10 });

    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.verdict, 'PAGE_NAVIGATION');
    assert.strictEqual(res.confidence, 1.0);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.navigated, true);
    assert.strictEqual(evidence.urlAfter, 'https://storefront.dev/products/shirt-blue');
  });

  it('5. Detects TAB_SWITCHED when aria-selected transitions', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/p/1',
          bodyClasses: [],
          bodyOverflowLocked: false,
          target: {
            found: true,
            tagName: 'button',
            ariaSelected: callCount === 1 ? 'false' : 'true',
            rect: { width: 80, height: 32 },
          },
          activeOverlays: [],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '#tab-specs', settleMs: 10 });

    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.verdict, 'TAB_SWITCHED');
  });

  it('6. Detects COLLAPSIBLE_TOGGLED when element height expands significantly', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/faq',
          bodyClasses: [],
          bodyOverflowLocked: false,
          target: {
            found: true,
            tagName: 'div',
            rect: { width: 400, height: callCount === 1 ? 40 : 220 },
            ariaExpanded: callCount === 1 ? 'false' : 'true',
          },
          activeOverlays: [],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.accordion-item', settleMs: 10 });

    assert.strictEqual(res.verified, true);
    assert.ok(res.verdict === 'SUBMENU_EXPANDED' || res.verdict === 'COLLAPSIBLE_TOGGLED');
  });

  it('7. Returns NO_OBSERVABLE_EFFECT and verified: false when action causes zero changes', async () => {
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({ color: 'black' }),
      evalJs: async () => ({
        url: 'https://storefront.dev/',
        bodyClasses: [],
        bodyOverflowLocked: false,
        target: { found: true, tagName: 'span', rect: { width: 50, height: 20 }, ariaExpanded: null },
        activeOverlays: [],
        hasHorizontalOverflow: false,
      }),
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.dead-badge', settleMs: 10 });

    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.verdict, 'NO_OBSERVABLE_EFFECT');
    assert.strictEqual(res.confidence, 1.0);
  });

  it('8. Reports layout overflow bleed when action expands element beyond viewport width', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => true,
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['broken-overflow'],
          bodyOverflowLocked: false,
          activeOverlays: [],
          hasHorizontalOverflow: callCount > 1,
          scrollWidth: callCount === 1 ? 390 : 540,
          viewportWidth: 390,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.broken-tab', settleMs: 10 });

    assert.strictEqual(res.verified, true);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.overflowBleed.detected, true);
    assert.strictEqual(evidence.overflowBleed.scrollWidth, 540);
  });

  it('9. Returns ACTION_FAILED and verified: false when underlying agentClick returns false, ignoring ambient mutations', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => false, // Action failed / click was rejected
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        // Ambient background change occurs (e.g. carousel autoplay or timer)
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['carousel-slide-next'],
          bodyOverflowLocked: false,
          activeOverlays: callCount === 1 ? [] : [{ tagName: 'div', id: 'ambient-toast', className: 'toast show' }],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.unresponsive-btn', settleMs: 10 });

    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.actionSuccess, false);
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.verdict, 'ACTION_FAILED');
    assert.strictEqual(res.confidence, 0);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.causalityViolation, true);
  });
});
