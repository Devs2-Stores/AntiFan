import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort as RealBrowserControlPort, BrowserHostPort, isStrictActionSuccess, resolveInteractionMode } from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

class BrowserControlPort extends RealBrowserControlPort {
  constructor(host: BrowserHostPort) {
    if (host && typeof host.evalJs === 'function') {
      const origEvalJs = host.evalJs.bind(host);
      host.evalJs = async (script?: string, tabId?: string, pane?: 'desktop' | 'mobile') => {
        const s = String(script || '');
        if (s.includes('window.__antifanMarkAction ?')) {
          return 1000;
        }
        if (s.includes('window.__stopAntifanMotion ?')) {
          return {
            samples: [],
            mutations: [],
            armT: 990,
            actionStartT: 1000,
            markerConfirmed: true,
            stopT: 1050,
            durationMs: 50,
          };
        }
        if (s.includes('__antifanMotionSamples')) {
          return { armed: true, mutationObserver: true, motionObserver: true };
        }
        return origEvalJs(s, tabId, pane);
      };
    }
    super(host);
  }
}
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

  it('10. isStrictActionSuccess normalizer strictly accepts only true or explicit { [actionKey]: true }', () => {
    assert.strictEqual(isStrictActionSuccess(true, 'clicked'), true);
    assert.strictEqual(isStrictActionSuccess({ clicked: true }, 'clicked'), true);
    assert.strictEqual(isStrictActionSuccess({ hovered: true }, 'hovered'), true);
    assert.strictEqual(isStrictActionSuccess({ typed: true }, 'typed'), true);
    assert.strictEqual(isStrictActionSuccess({ scrolled: true }, 'scrolled'), true);
    assert.strictEqual(isStrictActionSuccess({ focused: true }, 'focused'), true);

    // Fail-closed against ambiguous or unconfirmed payloads
    assert.strictEqual(isStrictActionSuccess(false, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess({}, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess({ clicked: false }, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess({ clicked: undefined }, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess({ clicked: null }, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess({ otherKey: true }, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess(undefined, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess(null, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess('true', 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess(1, 'clicked'), false);
    assert.strictEqual(isStrictActionSuccess([], 'clicked'), false);
  });

  it('11. Fails closed when agentClick returns ambiguous objects like {} or { clicked: undefined }, ignoring ambient mutations', async () => {
    let callCount = 0;
    let revision = 1;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      agentClick: async () => ({}) as any, // Ambiguous unconfirmed object
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['carousel-slide-next'],
          bodyOverflowLocked: false,
          activeOverlays: callCount === 1 ? [] : [{ tagName: 'div', id: 'ambient-toast', className: 'toast show' }],
          hasHorizontalOverflow: false,
        };
      },
      bumpMutationRevision: () => ++revision,
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.ambiguous-btn', settleMs: 10 });

    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.interactionMode, 'unknown');
    assert.strictEqual(res.actionSuccess, false);
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.verdict, 'ACTION_FAILED');
    assert.strictEqual(res.confidence, 0);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.causalityViolation, true);
    assert.strictEqual(revision, 1, 'Failed trace must not advance mutation revision');
  });

  it('12. Fails closed with ACTION_FAILED when host does not support agentHover, refusing to forge success', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      // agentHover is undefined on host
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['dropdown-hover-active'],
          bodyOverflowLocked: false,
          activeOverlays: [],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'hover', selector: '.nav-hover-item', settleMs: 10 });

    assert.strictEqual(res.action, 'hover');
    assert.strictEqual(res.interactionMode, 'none');
    assert.strictEqual(res.actionSuccess, false);
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.verdict, 'ACTION_FAILED');
    assert.strictEqual(res.confidence, 0);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.causalityViolation, true);
    assert.match(evidence.error, /agentHover is not supported by host/);
  });

  it('13. Fails closed with ACTION_FAILED when host does not support agentScroll', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      // agentScroll is undefined on host
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: [],
          bodyOverflowLocked: false,
          activeOverlays: [],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'scroll', selector: '.scroll-area', settleMs: 10 });

    assert.strictEqual(res.action, 'scroll');
    assert.strictEqual(res.interactionMode, 'none');
    assert.strictEqual(res.actionSuccess, false);
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.verdict, 'ACTION_FAILED');
    assert.strictEqual(res.confidence, 0);
    const evidence = res.evidence as Record<string, any>;
    assert.strictEqual(evidence.causalityViolation, true);
    assert.match(evidence.error, /agentScroll is not supported by host/);
  });

  it('14. Sets interactionMode to programmatic_dom on fallback click and reports actionSuccess: true on explicit { clicked: true }', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      // agentClick is undefined -> triggers fallback el.click()
      inspectStyles: async () => ({}),
      evalJs: async (code: string) => {
        if (code.includes('el.click()')) {
          return { clicked: true };
        }
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['modal-open'],
          bodyOverflowLocked: callCount > 1,
          activeOverlays: callCount === 1 ? [] : [{ tagName: 'div', id: 'modal', className: 'modal' }],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.trigger-btn', settleMs: 10 });

    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.interactionMode, 'programmatic_dom');
    assert.strictEqual(res.actionSuccess, true);
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.verdict, 'MODAL_OPENED');
  });

  it('15. Accurately classifies interactionMode as programmatic_dom when dispatchAgentAction falls back from CDP to isolated_synthetic', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      dispatchAgentAction: async () => ({
        success: true,
        data: { ok: true, executed: true, executionTier: 'isolated_synthetic' },
      }),
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['modal-open'],
          bodyOverflowLocked: callCount > 1,
          activeOverlays: callCount === 1 ? [] : [{ tagName: 'div', id: 'modal', className: 'modal' }],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.fallback-btn', settleMs: 10 });

    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.actionSuccess, true);
    assert.strictEqual(res.interactionMode, 'programmatic_dom');
    assert.strictEqual(res.verified, true);
  });

  it('16. Accurately classifies interactionMode as trusted_cdp when dispatchAgentAction confirms cdp_trusted tier', async () => {
    let callCount = 0;
    let revision = 1;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      dispatchAgentAction: async () => ({
        success: true,
        data: { ok: true, executed: true, executionTier: 'cdp_trusted' },
      }),
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: callCount === 1 ? [] : ['modal-open'],
          bodyOverflowLocked: callCount > 1,
          activeOverlays: callCount === 1 ? [] : [{ tagName: 'div', id: 'modal', className: 'modal' }],
          hasHorizontalOverflow: false,
        };
      },
      bumpMutationRevision: () => ++revision,
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'click', selector: '.trusted-btn', settleMs: 10 });

    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.actionSuccess, true);
    assert.strictEqual(res.interactionMode, 'trusted_cdp');
    assert.strictEqual(res.verified, true);
    assert.strictEqual(revision, 2, 'Successful trusted trace must advance mutation revision exactly once');
  });

  it('17. resolveInteractionMode contract correctly derives tiers from both executionTier and tier and defaults unconfirmed mocks to unknown', () => {
    assert.strictEqual(resolveInteractionMode({ executionTier: 'cdp_trusted' }), 'trusted_cdp');
    assert.strictEqual(resolveInteractionMode({ data: { executionTier: 'cdp_trusted' } }), 'trusted_cdp');
    assert.strictEqual(resolveInteractionMode({ tier: 'cdp_trusted' }), 'trusted_cdp');
    assert.strictEqual(resolveInteractionMode({ data: { tier: 'cdp_trusted' } }), 'trusted_cdp');
    assert.strictEqual(resolveInteractionMode({ executionTier: 'isolated_synthetic' }), 'programmatic_dom');
    assert.strictEqual(resolveInteractionMode({ data: { executionTier: 'isolated_synthetic' } }), 'programmatic_dom');
    assert.strictEqual(resolveInteractionMode({ tier: 'isolated_synthetic' }), 'programmatic_dom');
    assert.strictEqual(resolveInteractionMode({ data: { tier: 'isolated_synthetic' } }), 'programmatic_dom');
    assert.strictEqual(resolveInteractionMode({ executionTier: 'programmatic_dom' }), 'programmatic_dom');
    assert.strictEqual(resolveInteractionMode(true), 'unknown');
    assert.strictEqual(resolveInteractionMode(false), 'unknown');
    assert.strictEqual(resolveInteractionMode({}), 'unknown');
    assert.strictEqual(resolveInteractionMode(undefined, 'none'), 'none');
  });

  it('18. Accurately classifies interactionMode as trusted_cdp when tracing trusted type action with data.tier: cdp_trusted', async () => {
    let callCount = 0;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      dispatchAgentAction: async () => ({
        success: true,
        data: { ok: true, executed: true, tier: 'cdp_trusted', rect: { x: 10, y: 10, width: 100, height: 30 } },
      }),
      inspectStyles: async () => ({}),
      evalJs: async () => {
        callCount++;
        return {
          url: 'https://storefront.dev/',
          bodyClasses: [],
          bodyOverflowLocked: false,
          activeOverlays: [],
          hasHorizontalOverflow: false,
        };
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);
    const res = await port.traceInteraction(baseTarget, 'run-1', 'att-1', { action: 'type', selector: '.search-input', text: 'AntiFan', settleMs: 10 });

    assert.strictEqual(res.action, 'type');
    assert.strictEqual(res.actionSuccess, true);
    assert.strictEqual(res.interactionMode, 'trusted_cdp');
  });
});
