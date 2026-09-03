import * as path from 'node:path';
import { BrowserTarget, CapabilityRequestContext, CapabilityError, CapabilityEffectPolicyInput, CapabilityRisk } from '../../shared/control-plane-contracts';
import { BrowserControlPort } from './browser-control-port';
import { CapabilityCatalogue } from './capability-catalogue';
import { PlatformDetector } from '../qa/scanners/platform-detector';
import { LiquidErrorScanner } from '../qa/scanners/liquid-error-scanner';
import { LayoutOverflowEngine } from '../qa/scanners/layout-overflow-engine';
import { HsGateRules, HsEvaluationResult } from '../qa/rules/hs-gate-rules';
import type { ThemeQaWorkflow } from '../qa/theme-qa-workflow';
import { ThemeQaRepairCoordinator } from '../qa/theme-qa-repair-coordinator';
import { confineWorkspaceRoot } from '../qa/diagnostics-filter';
import { recordFallbackTelemetry, FallbackTelemetryPayload } from '../telemetry/fallback-recorder';
function getThemeHierarchyScript(): string {
  return `(() => {
    const template = document.documentElement?.getAttribute('data-template')
      || document.body?.getAttribute('data-template')
      || document.querySelector('meta[name="template"]')?.getAttribute('content')
      || undefined;
    const selector = [
      'header', 'nav', 'main', 'section', 'article', 'aside', 'footer',
      '[data-section-id]', '[data-section-type]', '[data-component]', '[data-section]',
      'section[id^="shopify-section-"]', 'section[id^="haravan-section-"]'
    ].join(', ');
    const sections = Array.from(document.querySelectorAll(selector))
      .slice(0, 200)
      .map((element) => ({
        id: element.getAttribute('data-section-id') || element.getAttribute('data-component') || element.id || undefined,
        type: element.getAttribute('data-section-type') || element.getAttribute('data-component') || element.tagName.toLowerCase(),
        tag: element.tagName.toLowerCase(),
      }));
    return { template, sections };
  })()`;
}
function getProductResolverScript(handle?: string): string {
  const handleJson = JSON.stringify(handle || '');
  return `(async () => {
    try {
      let targetHandle = ${handleJson};
      if (!targetHandle) {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        const prodIdx = pathSegments.findIndex((seg) => seg === 'products' || seg === 'san-pham' || seg === 'product');
        if (prodIdx !== -1 && pathSegments[prodIdx + 1]) {
          targetHandle = pathSegments[prodIdx + 1].split('?')[0].split('#')[0];
        }
      }
      let productData = null;
      // 1. Structured JSON-LD / schema.org detection (universal)
      const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of ldScripts) {
        if (!s.textContent) continue;
        try {
          const parsed = JSON.parse(s.textContent);
          const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
          const prod = items.find((it) => it && (it['@type'] === 'Product' || it['@type']?.includes?.('Product')));
          if (prod) {
            const priceVal = prod.offers ? (Array.isArray(prod.offers) ? prod.offers[0]?.price : prod.offers.price) : undefined;
            const avail = prod.offers ? (Array.isArray(prod.offers) ? prod.offers[0]?.availability : prod.offers.availability) : undefined;
            productData = {
              handle: targetHandle || prod.sku || (prod.name ? prod.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'product'),
              title: prod.name,
              vendor: typeof prod.brand === 'object' ? prod.brand?.name : (prod.brand || prod.manufacturer),
              price: priceVal ? (typeof priceVal === 'number' ? priceVal : parseFloat(String(priceVal).replace(/[^0-9.]/g, ''))) : undefined,
              compare_at_price: undefined,
              available: avail ? String(avail).includes('InStock') : true,
              variants: [],
              featured_image: Array.isArray(prod.image) ? prod.image[0] : (typeof prod.image === 'object' ? prod.image?.url : prod.image),
            };
            break;
          }
        } catch {}
      }
      // 2. Standard e-commerce DOM JSON script blocks
      if (!productData) {
        const scriptEl = document.querySelector('script[type="application/json"][data-product-json], script[type="application/json"][id*="ProductJson"]');
        if (scriptEl && scriptEl.textContent) {
          try {
            const parsed = JSON.parse(scriptEl.textContent);
            productData = Array.isArray(parsed) ? parsed[0] : parsed;
          } catch {}
        }
      }
      // 3. Storefront runtime window globals
      if (!productData && window.meta && window.meta.product) {
        productData = window.meta.product;
      }
      if (!productData && window.product) {
        productData = window.product;
      }
      // 4. Delegated platform endpoint fallback if handle is detected
      if (!productData && targetHandle) {
        const isShopifyOrHaravan = Boolean(window.Shopify || window.Haravan || window.theme || document.querySelector('link[href*="hstatic.net"], link[href*="cdn.shopify.com"]'));
        if (isShopifyOrHaravan) {
          try {
            const res = await fetch('/products/' + encodeURIComponent(targetHandle) + '.js');
            if (res.ok) {
              productData = await res.json();
            }
          } catch {}
        }
      }
      if (productData) {
        return {
          ok: true,
          handle: targetHandle || productData.handle,
          title: productData.title || productData.name,
          vendor: productData.vendor || productData.brand,
          price: productData.price,
          compare_at_price: productData.compare_at_price,
          available: productData.available,
          variantsCount: Array.isArray(productData.variants) ? productData.variants.length : 1,
          variants: Array.isArray(productData.variants) ? productData.variants.map((v) => ({
            id: v.id,
            title: v.title,
            price: v.price,
            compare_at_price: v.compare_at_price,
            sku: v.sku,
            available: v.available,
            featured_image: v.featured_image ? (typeof v.featured_image === 'string' ? v.featured_image : v.featured_image.src) : undefined,
          })) : [],
          options: productData.options || [],
        };
      }
      return {
        ok: false,
        error: 'No product metadata or structured schema found on current page',
        url: window.location.href,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })()`;
}


function makeBrowserPolicy(options: {
  effect: CapabilityEffectPolicyInput['effect'];
  risk: CapabilityRisk;
  requiresBrowserTarget?: boolean;
  lane?: CapabilityEffectPolicyInput['schedulerLane'];
  timeoutMs?: number;
  duplicateMode?: CapabilityEffectPolicyInput['duplicateMode'];
  ownerCancellationBehavior?: CapabilityEffectPolicyInput['ownerCancellationBehavior'];
  subscriberDisconnectBehavior?: CapabilityEffectPolicyInput['subscriberDisconnectBehavior'];
  cancellationAckTimeoutMs?: number;
  receiptReadPermission?: CapabilityRisk;
}): CapabilityEffectPolicyInput {
  const reqTarget = Boolean(options.requiresBrowserTarget);
  const defaultLane = reqTarget ? (options.risk === 'read' ? 'short-passive' : 'viewport-gate') : 'unbounded';
  const ownerCancellation = options.ownerCancellationBehavior || (options.effect === 'read' ? 'abort-immediate' : 'drain-and-persist');
  const subscriberDisconnect = options.subscriberDisconnectBehavior || (ownerCancellation === 'abort-immediate' ? 'abort-when-unobserved' : 'detach-and-continue');
  const timeoutMs = options.timeoutMs || 30_000;
  const cancellationAckTimeoutMs = options.cancellationAckTimeoutMs || Math.min(timeoutMs, 5_000);
  return {
    effect: options.effect,
    risk: options.risk,
    requiresBrowserTarget: reqTarget,
    schedulerLane: options.lane || defaultLane,
    duplicateMode: options.duplicateMode || (options.effect === 'destructive-mutation' ? 'reject-concurrent' : 'in-process-join'),
    recordedVisibility: 'tenant-scoped',
    receiptReadPermission: options.receiptReadPermission || options.risk,
    timeoutMs,
    retentionPolicy: 'run-durable',
    ownerCancellationBehavior: ownerCancellation,
    subscriberDisconnectBehavior: subscriberDisconnect,
    cancellationAckTimeoutMs,
    policyVersion: 1,
  };
}

export function registerBrowserCapabilities(catalogue: CapabilityCatalogue, browser: BrowserControlPort, themeQaWorkflow?: ThemeQaWorkflow, getWorkspaceRoot?: () => string): void {
  const coordinator = themeQaWorkflow ? new ThemeQaRepairCoordinator(themeQaWorkflow) : undefined;

  // 1. Standard canonical capabilities
  catalogue.register({
    name: 'browser.list-tabs',
    description: 'List Chromium tabs. The tab bound to this session is marked with isBoundTab: true. Always operate on your bound tab or omit tabId.',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: (_params, context) => browser.listTabs({ target: context.browserTarget }),
  });

  catalogue.register({
    name: 'browser.open-tab',
    description: 'Open a Chromium browser tab without changing the visible tab by default',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, activate: { type: 'boolean' } } },
    execute: (params: { url?: string; activate?: boolean }) => browser.openTab(params),
  });

  catalogue.register({
    name: 'browser.close-tab',
    description: 'Close a Chromium browser tab by ID',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.closeTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'browser.switch-tab',
    description: 'Switch to a Chromium browser tab by ID',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.switchTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'browser.navigate',
    description: 'Navigate the explicitly bound Chromium tab (or specified tabId)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'string' } }, required: ['url'] },
    execute: (params: { url: string; tabId?: string }, context) => browser.navigate(context.browserTarget as BrowserTarget, params.url, params.tabId),
  });

  catalogue.register({
    name: 'browser.reload',
    description: 'Reload the explicitly bound Chromium tab (or specified tabId)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reload(context.browserTarget as BrowserTarget, params.tabId),
  });

  catalogue.register({
    name: 'browser.dom',
    description: 'Capture bounded DOM evidence for the explicitly bound tab (or specified tabId/paneId)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dom(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.selector, params.tabId, params.paneId),
  });
  catalogue.register({
    name: 'browser.dump_dom',
    description: 'Stream clean or raw page DOM directly to a workspace file with zero MCP transport truncation and Windows-safe atomic writes',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'Destination file path relative to workspace root' },
        selector: { type: 'string', description: 'Optional CSS selector to isolate subtrees' },
        tabId: { type: 'string', description: 'Optional target tabId' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        clean: { type: 'boolean', description: 'Automatically sanitize Livewire/SSR metadata blobs', default: true },
      },
      required: ['outputPath'],
    },
    execute: async (params: { outputPath: string; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; clean?: boolean }, context) => {
      let rootPath = process.cwd();
      if (context?.projectId && context?.workspaceId) {
        try {
          const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
          if (ws?.rootPath) rootPath = ws.rootPath;
        } catch {}
      }
      const resolvedTarget = path.isAbsolute(params.outputPath)
        ? params.outputPath
        : path.resolve(rootPath, params.outputPath);
      const safePath = confineWorkspaceRoot(resolvedTarget, rootPath);
      return browser.dumpDom(context.browserTarget as BrowserTarget, safePath, params);
    },
  });


  catalogue.register({
    name: 'browser.screenshot',
    description: 'Capture bounded screenshot evidence for the explicitly bound tab (or specified tabId/paneId)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' } } },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number }, context) => browser.screenshot(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.tabId, params.paneId, { format: params.format, quality: params.quality }),
  });
  catalogue.register({
    name: 'browser.observe',
    description: 'Truthful identity-coherent multi-modal observation capturing bounded DOM, screenshot, snapshot, and diagnostics with drift metadata',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        components: {
          type: 'array',
          items: { type: 'string', enum: ['dom', 'screenshot', 'snapshot', 'diagnostics'] },
          description: 'List of up to 4 components to observe',
        },
        selector: { type: 'string', description: 'Optional CSS selector root' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: async (params: { components?: Array<'dom' | 'screenshot' | 'snapshot' | 'diagnostics'>; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.observe(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'browser.wait',
    description: 'Deterministic wait for selector, ref, document_loaded, url_match, network_idle, or dom_stable state',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'event-wait', timeoutMs: 30_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        condition: {
          type: 'string',
          enum: ['selector', 'ref', 'document_loaded', 'url_match', 'network_idle', 'dom_stable'],
          description: 'Wait condition to evaluate',
        },
        selector: { type: 'string', description: 'CSS selector to wait for' },
        ref: { type: 'string', description: 'Semantic reference token (@e1) to wait for' },
        urlPattern: { type: 'string', description: 'URL pattern or substring to match' },
        state: { type: 'string', enum: ['attached', 'visible', 'actionable', 'detached', 'hidden'] },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (5000 default, 30000 max)' },
        idleWindowMs: { type: 'number', description: 'Debounce idle window in milliseconds (500 default)' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['condition'],
    },
    execute: (params: { condition: 'selector' | 'ref' | 'document_loaded' | 'url_match' | 'network_idle' | 'dom_stable'; selector?: string; ref?: string; urlPattern?: string; state?: 'attached' | 'visible' | 'actionable' | 'detached' | 'hidden'; timeoutMs?: number; idleWindowMs?: number; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.wait(context.browserTarget as BrowserTarget, params, params.tabId, params.paneId, context.signal),
  });

  catalogue.register({
    name: 'browser.eval',
    description: 'Evaluate JavaScript only with an explicit eval grant',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['expression'] },
    execute: (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.eval(context.browserTarget as BrowserTarget, params.expression, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'browser.diagnostics',
    description: 'Get tab console logs and network failures',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, level: { type: 'number' } } },
    execute: (params: { tabId?: string; level?: number | string }) => browser.diagnostics(params.tabId, params.level),
  });

  catalogue.register({
    name: 'browser.responsive-check',
    description: 'Run responsive layout verification on a tab',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.responsiveCheck(params.tabId),
  });

  catalogue.register({
    name: 'browser.agent-move',
    description: 'Move agent virtual cursor to an element, ref (@e1), or coordinate',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentMove(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-click',
    description: 'Click an element or coordinate using agent cursor (supports @ref or CSS selector)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, trusted: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClick(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-type',
    description: 'Type text into an input element using agent cursor (supports @ref or CSS selector)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, trusted: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['text'] },
    execute: (params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentType(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.keyboard-press',
    description: 'Send native key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Ctrl+A) to the active tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, required: ['key'] },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-scroll',
    description: 'Scroll page or element using agent cursor (supports @ref or CSS selector)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentScroll(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-hover',
    description: 'Hover an element, ref (@e1), or coordinate using agent cursor',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-highlight',
    description: 'Highlight an element or ref on page',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHighlight(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-clear',
    description: 'Clear all agent visual cursor overlays',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClear(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-snapshot',
    description: 'Capture agent visual snapshot tree (supports selector and viewportOnly filtering)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; viewportOnly?: boolean }, context) => browser.agentSnapshot(params, context.browserTarget),
  });
  catalogue.register({
    name: 'browser.find',
    description: 'Search accessibility snapshot descriptors for text or regex pattern and return matching @eN element references with metadata',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text to search for in page snapshot' },
        regex: { type: 'string', description: 'Regular expression to search for in page snapshot' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-review pane' },
        maxMatches: { type: 'number', description: 'Maximum number of matches to return' },
      },
    },
    execute: (params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });


  catalogue.register({
    name: 'browser.agent-trajectory',
    description: 'Execute a continuous multi-step Bézier mouse trajectory and action sequence',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object' } }, speed: { type: 'string', enum: ['fast', 'natural', 'slow'] }, smoothScroll: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['steps'] },
    execute: (params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentTrajectory(params, context.browserTarget),
  });
  catalogue.register({
    name: 'browser.agent-sequence',
    description: 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['navigate', 'click', 'type', 'scroll', 'hover', 'pressKey', 'wait', 'screenshot', 'snapshot'] },
              url: { type: 'string' },
              ref: { type: 'string' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              text: { type: 'string' },
              clear: { type: 'boolean' },
              deltaY: { type: 'number' },
              key: { type: 'string' },
              modifiers: { type: 'array', items: { type: 'string' } },
              waitMs: { type: 'number' },
              settleMs: { type: 'number' },
              format: { type: 'string', enum: ['jpeg', 'png'] },
              quality: { type: 'number' },
            },
            required: ['type'],
          },
          description: 'Ordered array of action steps to execute sequentially',
        },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        stopOnError: { type: 'boolean' },
      },
      required: ['actions'],
    },
    execute: (params: { actions: Array<Record<string, unknown>>; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }, context) =>
      browser.sequence(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.upload-file',
    description: 'Upload local files into a file input element in active tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        refOrSelector: { type: 'string', description: 'CSS selector or @ref of target file input' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Array of local file paths' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['refOrSelector', 'filePaths'],
    },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.uploadFileInput(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.drop-files',
    description: 'Dispatch native drag and drop file transfer onto a target drop zone element in active tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        refOrSelector: { type: 'string', description: 'CSS selector or @ref of target drop zone' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Array of local file paths' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['refOrSelector', 'filePaths'],
    },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.dropFiles(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.inspect.snapshot',
    description: 'Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references (supports selector and viewportOnly filtering)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; viewportOnly?: boolean }, context) => browser.agentSnapshot(params, context.browserTarget),
  });
  catalogue.register({
    name: 'anti.inspect.find',
    description: 'Alias for browser.find',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text to search for' },
        regex: { type: 'string', description: 'Regular expression to search for' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        maxMatches: { type: 'number' },
      },
    },
    execute: (params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });
  catalogue.register({
    name: 'anti.inspect.observe',
    description: 'Alias for browser.observe',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        components: {
          type: 'array',
          items: { type: 'string', enum: ['dom', 'screenshot', 'snapshot', 'diagnostics'] },
          description: 'List of up to 4 components to observe',
        },
        selector: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: async (params: { components?: Array<'dom' | 'screenshot' | 'snapshot' | 'diagnostics'>; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.observe(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.browser.wait',
    description: 'Alias for browser.wait',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'event-wait', timeoutMs: 30_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        condition: {
          type: 'string',
          enum: ['selector', 'ref', 'document_loaded', 'url_match', 'network_idle', 'dom_stable'],
        },
        selector: { type: 'string' },
        ref: { type: 'string' },
        urlPattern: { type: 'string' },
        state: { type: 'string', enum: ['attached', 'visible', 'actionable', 'detached', 'hidden'] },
        timeoutMs: { type: 'number' },
        idleWindowMs: { type: 'number' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['condition'],
    },
    execute: (params: { condition: 'selector' | 'ref' | 'document_loaded' | 'url_match' | 'network_idle' | 'dom_stable'; selector?: string; ref?: string; urlPattern?: string; state?: 'attached' | 'visible' | 'actionable' | 'detached' | 'hidden'; timeoutMs?: number; idleWindowMs?: number; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.wait(context.browserTarget as BrowserTarget, params, params.tabId, params.paneId, context.signal),
  });


  catalogue.register({
    name: 'anti.browser.evaluate',
    description: 'Execute JavaScript expression in page context',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['expression'] },
    execute: (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.eval(context.browserTarget as BrowserTarget, params.expression, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.eval',
    description: 'Alias for anti.browser.evaluate',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['expression'] },
    execute: (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.eval(context.browserTarget as BrowserTarget, params.expression, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.agent.file_upload',
    description: 'Upload local files into a file input element',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.uploadFileInput(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.drop',
    description: 'Dispatch native drag and drop file transfer onto a target drop zone',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dropFiles(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_upload_file',
    description: 'Alias for browser.upload-file',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.uploadFileInput(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_drop_files',
    description: 'Alias for browser.drop-files',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dropFiles(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.telemetry.record_fallback',
    description: 'Record sanitized structured fallback telemetry when falling back to Playwright',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        targetUrl: { type: 'string' },
        primaryTool: { type: 'string' },
        errorCode: { type: 'string' },
        errorMessage: { type: 'string' },
        fallbackTool: { type: 'string' },
        fallbackResult: { type: 'string', enum: ['SUCCESS', 'FAILED', 'SKIPPED'] },
        durationMs: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['primaryTool', 'fallbackTool', 'fallbackResult'],
    },
    execute: async (params: FallbackTelemetryPayload, context) => recordFallbackTelemetry(params, getWorkspaceRoot ? getWorkspaceRoot() : undefined),
  });
  catalogue.register({
    name: 'browser.set-viewport',
    description: 'Set browser responsive viewport dimensions (width, height, mobile emulation, DPR)',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, tabId: { type: 'string' } }, required: ['width', 'height'] },
    execute: (params: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }, context) => browser.setViewport(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.set-device-preset',
    description: 'Emulate a real device preset (iPhone, iPad, Galaxy, Pixel, MacBook, 4K, Desktop) on a tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { presetId: { type: 'string' }, tabId: { type: 'string' } }, required: ['presetId'] },
    execute: (params: { presetId: string; tabId?: string }, context) => browser.setDevicePreset(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.list-device-presets',
    description: 'List all available responsive device presets with their resolutions and categories',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: () => browser.listDevicePresets(),
  });

  catalogue.register({
    name: 'browser.set-zoom',
    description: 'Set zoom factor for a Chromium tab (0.25 to 5.0)',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Zoom factor between 0.25 and 5.0' }, tabId: { type: 'string' } }, required: ['zoomFactor'] },
    execute: (params: { zoomFactor: number; tabId?: string }, context) => browser.setZoom(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.toggle-inspect',
    description: 'Toggle native element inspection overlay',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: () => browser.toggleInspect(),
  });

  catalogue.register({
    name: 'browser.set-automation-target',
    description: 'Explicitly set the automation target tab for AI actions',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'management', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.setAutomationTarget(params.tabId),
  });

  // 2. Compatibility aliases for MCP & Bridge protocols
  catalogue.register({
    name: 'antifan_list_tabs',
    description: 'List Chromium tabs. The tab bound to this session is marked with isBoundTab: true. Always operate on your bound tab or omit tabId.',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: (_params, context) => browser.listTabs({ target: context.browserTarget }),
  });

  catalogue.register({
    name: 'antifan_open_tab',
    description: 'Alias for browser.open-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, activate: { type: 'boolean' } } },
    execute: (params: { url?: string; activate?: boolean }) => browser.openTab(params),
  });

  catalogue.register({
    name: 'antifan_close_tab',
    description: 'Alias for browser.close-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.closeTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'antifan_switch_tab',
    description: 'Alias for browser.switch-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.switchTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'antifan_navigate',
    description: 'Alias for browser.navigate',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'string' } }, required: ['url'] },
    execute: (params: { url: string; tabId?: string }, context) => browser.navigate(context.browserTarget as BrowserTarget, params.url, params.tabId),
  });

  catalogue.register({
    name: 'antifan_reload',
    description: 'Alias for browser.reload',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reload(context.browserTarget as BrowserTarget, params.tabId),
  });

  catalogue.register({
    name: 'antifan_get_dom',
    description: 'Alias for browser.dom',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dom(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.selector, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'antifan_screenshot',
    description: 'Alias for browser.screenshot',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' } } },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number }, context) => browser.screenshot(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.tabId, params.paneId, { format: params.format, quality: params.quality }),
  });

  catalogue.register({
    name: 'antifan_toggle_inspect',
    description: 'Alias for browser.toggle-inspect',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: () => browser.toggleInspect(),
  });

  catalogue.register({
    name: 'antifan_agent_snapshot',
    description: 'Alias for browser.agent-snapshot',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentSnapshot(params, context.browserTarget),
  });
  catalogue.register({
    name: 'antifan_find',
    description: 'Alias for browser.find',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        regex: { type: 'string' },
        pattern: { type: 'string' },
        query: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        maxMatches: { type: 'number' },
      },
    },
    execute: (params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser_find',
    description: 'Canonical Playwright MCP alias for browser.find',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text to search for in page snapshot' },
        regex: { type: 'string', description: 'Regular expression to search for in page snapshot' },
        pattern: { type: 'string' },
        query: { type: 'string' },
      },
    },
    execute: (params: { text?: string; regex?: string; pattern?: string; query?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });


  catalogue.register({
    name: 'antifan_eval_js',
    description: 'Alias for browser.eval',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['expression'] },
    execute: (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.eval(context.browserTarget as BrowserTarget, params.expression, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'antifan_agent_click',
    description: 'Alias for browser.agent-click',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, trusted: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClick(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_agent_type',
    description: 'Alias for browser.agent-type',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, trusted: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['text'] },
    execute: (params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentType(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_keyboard_press',
    description: 'Alias for browser.keyboard-press',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, required: ['key'] },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget),
  });
  catalogue.register({
    name: 'antifan_agent_sequence',
    description: 'Alias for browser.agent-sequence',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['navigate', 'click', 'type', 'scroll', 'hover', 'pressKey', 'wait', 'screenshot', 'snapshot'] },
              url: { type: 'string' },
              ref: { type: 'string' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              text: { type: 'string' },
              clear: { type: 'boolean' },
              deltaY: { type: 'number' },
              key: { type: 'string' },
              modifiers: { type: 'array', items: { type: 'string' } },
              waitMs: { type: 'number' },
              settleMs: { type: 'number' },
              format: { type: 'string', enum: ['jpeg', 'png'] },
              quality: { type: 'number' },
            },
            required: ['type'],
          },
        },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        stopOnError: { type: 'boolean' },
      },
      required: ['actions'],
    },
    execute: (params: { actions: Array<Record<string, unknown>>; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }, context) =>
      browser.sequence(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.send-keyboard-press',
    description: 'Alias for browser.keyboard-press',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, required: ['key'] },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget),
  });
  catalogue.register({
    name: 'browser_press_key',
    description: 'Canonical Playwright MCP alias for browser.keyboard-press',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or key combination to press (e.g. "Control+a", "Shift+Tab", "Escape", "Enter")' },
        modifiers: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'string' },
      },
      required: ['key'],
    },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget),
  });


  catalogue.register({
    name: 'antifan_agent_scroll',
    description: 'Alias for browser.agent-scroll',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentScroll(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_agent_hover',
    description: 'Alias for browser.agent-hover',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_agent_highlight',
    description: 'Alias for browser.agent-highlight',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHighlight(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_agent_clear',
    description: 'Alias for browser.agent-clear',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClear(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_agent_trajectory',
    description: 'Alias for browser.agent-trajectory',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object' } }, speed: { type: 'string', enum: ['fast', 'natural', 'slow'] }, smoothScroll: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['steps'] },
    execute: (params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentTrajectory(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_console_messages',
    description: 'Alias for browser.diagnostics',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, level: { type: 'number' } } },
    execute: (params: { tabId?: string; level?: number | string }) => browser.diagnostics(params.tabId, params.level),
  });

  catalogue.register({
    name: 'antifan_network_failures',
    description: 'Alias for browser.diagnostics',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }) => browser.diagnostics(params.tabId),
  });

  catalogue.register({
    name: 'antifan_responsive_check',
    description: 'Alias for browser.responsive-check',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.responsiveCheck(params.tabId),
  });

  catalogue.register({
    name: 'antifan_set_viewport',
    description: 'Alias for browser.set-viewport',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, tabId: { type: 'string' } }, required: ['width', 'height'] },
    execute: (params: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }, context) => browser.setViewport(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_set_device_preset',
    description: 'Alias for browser.set-device-preset',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { presetId: { type: 'string' }, tabId: { type: 'string' } }, required: ['presetId'] },
    execute: (params: { presetId: string; tabId?: string }, context) => browser.setDevicePreset(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_list_device_presets',
    description: 'Alias for browser.list-device-presets',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: () => browser.listDevicePresets(),
  });

  catalogue.register({
    name: 'antifan_set_zoom',
    description: 'Alias for browser.set-zoom',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Zoom factor between 0.25 and 5.0' }, tabId: { type: 'string' } }, required: ['zoomFactor'] },
    execute: (params: { zoomFactor: number; tabId?: string }, context) => browser.setZoom(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_set_automation_target',
    description: 'Alias for browser.set-automation-target',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'management', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.setAutomationTarget(params.tabId),
  });

  catalogue.register({
    name: 'theme.qa_validate',
    description: 'Execute the authoritative Theme QA workflow for the bound storefront tab and workspace',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, workspaceRoot: { type: 'string' }, multiBreakpoint: { type: 'boolean' } } },
    execute: async (params: { tabId?: string; workspaceRoot?: string; multiBreakpoint?: boolean }, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (params.tabId && params.tabId !== target?.tabId) {
        throw new CapabilityError('TARGET_MISMATCH', `Tab ID mismatch: expected ${target?.tabId || 'unbound'}, got ${params.tabId}`);
      }
      if (!themeQaWorkflow) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme QA workflow is not available');
      }
      const confinedRoot = confineWorkspaceRoot(params.workspaceRoot, getWorkspaceRoot?.() || '');
      return themeQaWorkflow.validate({
        runId: context.runId || 'run-unbound',
        attemptId: context.attemptId || 'attempt-unbound',
        workspaceRoot: confinedRoot,
        multiBreakpoint: params.multiBreakpoint,
        target,
      });
    },
  });

  catalogue.register({
    name: 'theme.qa_repair.begin',
    description: 'Begin a safe theme repair session: creates immutable R0 snapshot and validates Round 1 baseline',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object' },
    execute: async (_params: Record<string, unknown>, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (!context.runId || !context.attemptId) {
        throw new CapabilityError('UNAUTHENTICATED', 'runId and attemptId context are required for repair session');
      }
      const authWs = catalogue.resolveAuthoritativeWorkspace(
        context.projectId || target.projectId,
        context.workspaceId || target.workspaceId
      );
      if (!coordinator) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme repair coordinator is not available');
      return coordinator.begin({
        workspaceRoot: authWs.rootPath,
        target,
        runId: context.runId,
        attemptId: context.attemptId,
      });
    },
  });

  catalogue.register({
    name: 'theme.qa_repair.verify',
    description: 'Verify a theme repair session: validates Round 2 and auto-rolls back workspace to R0 if regressions are detected',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: async (params: { sessionId: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (!context.attemptId) {
        throw new CapabilityError('UNAUTHENTICATED', 'attemptId context is required for verify session');
      }
      if (!coordinator) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme repair coordinator is not available');
      return coordinator.verify({
        sessionId: params.sessionId,
        target,
        attemptId: context.attemptId,
      });
    },
  });

  catalogue.register({
    name: 'theme.qa_rollback',
    description: 'Roll back an active repair session to its initial R0 baseline',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'destructive-mutation',
      risk: 'write',
      requiresBrowserTarget: true,
      lane: 'viewport-gate',
      duplicateMode: 'reject-concurrent',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
    }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: async (params: { sessionId: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (!coordinator) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme repair coordinator is not available');
      return coordinator.rollback({
        sessionId: params.sessionId,
        target,
      });
    },
  });

  catalogue.register({
    name: 'antifan_theme_qa_repair_begin',
    description: 'Alias for theme.qa_repair.begin',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object' },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_repair.begin')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_qa_repair_verify',
    description: 'Alias for theme.qa_repair.verify',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_repair.verify')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_qa_rollback',
    description: 'Alias for theme.qa_rollback',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'destructive-mutation',
      risk: 'write',
      requiresBrowserTarget: true,
      lane: 'viewport-gate',
      duplicateMode: 'reject-concurrent',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
    }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_rollback')!.execute(params, context),
  });

  catalogue.register({
    name: 'theme.assert_cart',
    description: 'Assert passive storefront AJAX cart contract telemetry without adding synthetic items',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: async (params: { tabId?: string }, context) => {
      const value = await browser.eval(context.browserTarget as BrowserTarget, HsGateRules.getBrowserCartAssertionScript(), params.tabId);
      return HsGateRules.evaluateCartTelemetry(value);
    },
  });

  catalogue.register({
    name: 'theme.debug_bundle',
    description: 'Return a single atomic bundle containing platform metadata, active template/section hierarchy, zero-Liquid error scan, layout overflow deltaX, and passive cart telemetry',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: async (params: { tabId?: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      const domResult = await browser.dom(target, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', undefined, params.tabId);
      let rawHtml = '';
      if (typeof domResult === 'string') {
        rawHtml = domResult;
      } else if (domResult && typeof domResult === 'object' && 'id' in domResult && browser.artifacts && typeof (browser.artifacts as any).readTextById === 'function') {
        try {
          rawHtml = (browser.artifacts as any).readTextById(domResult.id, context).text;
        } catch {
          rawHtml = '';
        }
      }
      const platform = PlatformDetector.detect(undefined, undefined, rawHtml);
      const liquid = LiquidErrorScanner.scanHtmlString(rawHtml);
      let overflow: { hasOverflow: boolean; deltaX: number; culprits: unknown[] } = { hasOverflow: false, deltaX: 0, culprits: [] };
      try { const evalOverflow = await browser.eval(target, LayoutOverflowEngine.getBrowserScanScript('active'), params.tabId); if (evalOverflow && typeof evalOverflow === 'object' && 'hasOverflow' in evalOverflow) { const casted = evalOverflow as { hasOverflow: boolean; deltaX: number; culprits?: unknown[] }; overflow = { hasOverflow: casted.hasOverflow, deltaX: casted.deltaX, culprits: casted.culprits || [] }; } } catch {}
      let hsRules = HsGateRules.evaluateHtml(rawHtml, platform.platform);
      try { const evalHs = await browser.eval(target, HsGateRules.getBrowserEvaluationScript(platform.platform), params.tabId); if (evalHs && typeof evalHs === 'object' && 'passed' in evalHs) hsRules = evalHs as HsEvaluationResult; } catch {}
      let templateHierarchy: unknown = { template: undefined, sections: [] };
      try { templateHierarchy = await browser.eval(target, getThemeHierarchyScript(), params.tabId) || templateHierarchy; } catch {}
      let cartTelemetry = hsRules.cartTelemetry;
      if (!cartTelemetry) { try { const value = await browser.eval(target, HsGateRules.getBrowserCartAssertionScript(), params.tabId); cartTelemetry = HsGateRules.evaluateCartTelemetry(value); } catch {} }
      return { target, platform, templateHierarchy, liquid, overflow, cartTelemetry, hsRules, timestamp: Date.now() };
    },
  });

  catalogue.register({
    name: 'antifan_theme_qa_validate',
    description: 'Alias for theme.qa_validate',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, workspaceRoot: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_validate')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_debug_bundle',
    description: 'Alias for theme.debug_bundle',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.debug_bundle')!.execute(params, context),
  });
  catalogue.register({
    name: 'theme.resolve_product',
    description: 'Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: async (params: { handle?: string; tabId?: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      return browser.eval(target, getProductResolverScript(params.handle), params.tabId);
    },
  });

  catalogue.register({
    name: 'anti.theme.resolve_product',
    description: 'Alias for theme.resolve_product',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.resolve_product')!.execute(params, context),
  });

  catalogue.register({
    name: 'storefront.resolve_product',
    description: 'Alias for theme.resolve_product',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.resolve_product')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_resolve_product',
    description: 'Alias for theme.resolve_product',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.resolve_product')!.execute(params, context),
  });

  // 3. anti.* aliases for unified client / bridge execution
  catalogue.register({
    name: 'anti.browser.tabs.list',
    description: 'List Chromium tabs. The tab bound to this session is marked with isBoundTab: true. Always operate on your bound tab or omit tabId.',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: (_params, context) => browser.listTabs({ target: context.browserTarget }),
  });

  catalogue.register({
    name: 'anti.browser.tabs.create',
    description: 'Alias for browser.open-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, activate: { type: 'boolean' } } },
    execute: (params: { url?: string; activate?: boolean }) => browser.openTab(params),
  });

  catalogue.register({
    name: 'anti.browser.tabs.activate',
    description: 'Alias for browser.switch-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.switchTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'anti.browser.tabs.close',
    description: 'Alias for browser.close-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.closeTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'anti.browser.navigate',
    description: 'Alias for browser.navigate',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'string' } }, required: ['url'] },
    execute: (params: { url: string; tabId?: string }, context) => browser.navigate(context.browserTarget as BrowserTarget, params.url, params.tabId),
  });

  catalogue.register({
    name: 'anti.browser.reload',
    description: 'Alias for browser.reload',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reload(context.browserTarget as BrowserTarget, params.tabId),
  });

  catalogue.register({
    name: 'anti.inspect.dom',
    description: 'Alias for browser.dom',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dom(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.selector, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.screenshot.viewport',
    description: 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes, format: jpeg/png)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' } } },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number }, context) => browser.screenshot(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.tabId, params.paneId, { format: params.format || 'jpeg', quality: params.quality ?? 85 }),
  });

  catalogue.register({
    name: 'anti.agent.cursor.click',
    description: 'Alias for browser.agent-click',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, trusted: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClick(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.cursor.type',
    description: 'Alias for browser.agent-type',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, trusted: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['text'] },
    execute: (params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentType(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.cursor.move',
    description: 'Alias for browser.agent-hover',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.cursor.hover',
    description: 'Alias for browser.agent-hover',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.cursor.scroll',
    description: 'Alias for browser.agent-scroll',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentScroll(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.cursor.highlight',
    description: 'Alias for browser.agent-highlight',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHighlight(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.agent.cursor.clear',
    description: 'Alias for browser.agent-clear',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClear(params, context.browserTarget),
  });
  catalogue.register({
    name: 'anti.agent.sequence',
    description: 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['navigate', 'click', 'type', 'scroll', 'hover', 'pressKey', 'wait', 'screenshot', 'snapshot'] },
              url: { type: 'string' },
              ref: { type: 'string' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              text: { type: 'string' },
              clear: { type: 'boolean' },
              deltaY: { type: 'number' },
              key: { type: 'string' },
              modifiers: { type: 'array', items: { type: 'string' } },
              waitMs: { type: 'number' },
              settleMs: { type: 'number' },
              format: { type: 'string', enum: ['jpeg', 'png'] },
              quality: { type: 'number' },
            },
            required: ['type'],
          },
        },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        stopOnError: { type: 'boolean' },
      },
      required: ['actions'],
    },
    execute: (params: { actions: Array<Record<string, unknown>>; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }, context) =>
      browser.sequence(params, context.browserTarget),
  });
  catalogue.register({
    name: 'browser.inspect_styles',
    description: 'Inspect computed CSS styles, box model, typography, layout, and CSS variables for an element (supports @ref or CSS selector)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectStyles(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.styles',
    description: 'Alias for browser.inspect_styles',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectStyles(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.inspect_region',
    description: 'Inspect spatial region bounds, collecting intersecting visible DOM elements with coordinates and z-index',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        selector: { type: 'string' },
        ref: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectRegion(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.region',
    description: 'Alias for browser.inspect_region',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        selector: { type: 'string' },
        ref: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectRegion(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.trace_interaction',
    description: 'Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout shifts',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] },
        selector: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
        deltaY: { type: 'number' },
        settleMs: { type: 'number' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['action'],
    },
    execute: (params: { action: 'click' | 'hover' | 'focus' | 'type' | 'scroll'; selector?: string; ref?: string; text?: string; deltaY?: number; settleMs?: number; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.traceInteraction(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId, context.signal),
  });

  catalogue.register({
    name: 'anti.trace.interaction',
    description: 'Alias for browser.trace_interaction',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] },
        selector: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
        deltaY: { type: 'number' },
        settleMs: { type: 'number' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['action'],
    },
    execute: (params: { action: 'click' | 'hover' | 'focus' | 'type' | 'scroll'; selector?: string; ref?: string; text?: string; deltaY?: number; settleMs?: number; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.traceInteraction(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId, context.signal),
  });
  catalogue.register({
    name: 'browser.visual_compare',
    description: 'Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking, and configurable tolerance',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        baselineScreenshotRef: { type: 'string' },
        comparisonTabId: { type: 'string' },
        tolerance: { type: 'number' },
        selector: { type: 'string' },
        clipRect: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        maskSelectors: {
          type: 'array',
          items: { type: 'string' },
        },
        normalizeScroll: { type: 'boolean' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { baselineScreenshotRef?: string; comparisonTabId?: string; tolerance?: number; selector?: string; clipRect?: { x: number; y: number; width: number; height: number }; maskSelectors?: string[]; normalizeScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.visualCompare(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.visual.compare',
    description: 'Alias for browser.visual_compare with element selection, dynamic masking, and subpixel stabilization',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        baselineScreenshotRef: { type: 'string' },
        comparisonTabId: { type: 'string' },
        tolerance: { type: 'number' },
        selector: { type: 'string' },
        clipRect: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        maskSelectors: {
          type: 'array',
          items: { type: 'string' },
        },
        normalizeScroll: { type: 'boolean' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { baselineScreenshotRef?: string; comparisonTabId?: string; tolerance?: number; selector?: string; clipRect?: { x: number; y: number; width: number; height: number }; maskSelectors?: string[]; normalizeScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.visualCompare(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId),
  });
}

export function legacyContext(target: BrowserTarget, lease: CapabilityRequestContext['lease']): CapabilityRequestContext {
  return { lease, leaseToken: lease.token, projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
}

