import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

describe('AntiFan Sensory Engine & Quality Gate Suite', () => {
  const dummyTarget: BrowserTarget = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: 'rt-1',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (overrides: Partial<BrowserHostPort> = {}): any => ({
    getTabList: () => [
      { id: 'tab-1', url: 'https://roahtrip.com/', title: 'ROAHTRIP', alias: '@storefront', role: 'storefront' },
      { id: 'tab-2', url: 'http://127.0.0.1:8989/', title: 'HTML Spec', alias: '@spec', role: 'spec' },
    ],
    hasTab: (id: string) => ['tab-1', 'tab-2'].includes(id),
    switchTab: () => true,
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html><body></body></html>',
    captureScreenshot: async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    evalJs: async () => ({}),
    getDiagnostics: () => ({ console: [], failures: [] }),
    ...overrides,
  });

  describe('Capability Registration & MCP Schema Integrity', () => {
    test('registers all sensory and parity capabilities in the catalogue', () => {
      const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1' });
      const host = createMockHost();
      const port = new BrowserControlPort(host);
      registerBrowserCapabilities(catalogue, port);

      const requiredTools = [
        'anti.media.freeze',
        'browser.media-freeze',
        'anti.inspect.page_inventory',
        'browser.page-inventory',
        'anti.inspect.style_diff',
        'anti.spec.validate_gate',
        'anti.visual.compare',
      ];

      for (const tool of requiredTools) {
        const reg = catalogue.get(tool);
        assert.ok(reg, `Missing tool in catalogue: ${tool}`);
        assert.ok(reg?.inputSchema, `Missing inputSchema for ${tool}`);
      }

      // Verify anti.visual.compare schema includes fullPage and maskSelectors
      const vc = catalogue.get('anti.visual.compare');
      const props = (vc?.inputSchema as any)?.properties;
      assert.ok(props.fullPage, 'anti.visual.compare missing fullPage in schema');
      assert.ok(props.maskSelectors, 'anti.visual.compare missing maskSelectors in schema');
      assert.ok(props.normalizeScroll, 'anti.visual.compare missing normalizeScroll in schema');
    });
  });

  describe('freezeMedia', () => {
    test('dispatches freeze script and returns frozen state', async () => {
      let executedScript = '';
      const host = createMockHost({
        evalJs: async (expr: string) => {
          executedScript = expr;
          return { frozen: true, mediaCount: 3 };
        },
      });
      const port = new BrowserControlPort(host);

      const res = await port.freezeMedia(dummyTarget, { freeze: true, tabId: 'tab-1' });
      assert.strictEqual(res.frozen, true);
      assert.strictEqual(res.mediaCount, 3);
      assert.strictEqual(res.tabId, 'tab-1');
      assert.ok(executedScript.includes('animation-play-state: paused'), 'Script must pause animations');
      assert.ok(executedScript.includes("querySelectorAll('video, audio')"), 'Script must target video and audio');
    });

    test('supports unfreezing media', async () => {
      let executedScript = '';
      const host = createMockHost({
        evalJs: async (expr: string) => {
          executedScript = expr;
          return { frozen: false, mediaCount: 2 };
        },
      });
      const port = new BrowserControlPort(host);

      const res = await port.freezeMedia(dummyTarget, { freeze: false, tabId: 'tab-1' });
      assert.strictEqual(res.frozen, false);
      assert.strictEqual(res.mediaCount, 2);
      assert.ok(executedScript.includes('const freeze = false'), 'Script must record freeze as false');
    });

    test('throws CapabilityError when evalJs fails or returns undefined', async () => {
      const host = createMockHost({
        evalJs: async () => undefined,
      });
      const port = new BrowserControlPort(host);

      await assert.rejects(
        async () => port.freezeMedia(dummyTarget, { tabId: 'tab-1' }),
        (err: any) => err.code === 'TARGET_STALE'
      );
    });
  });

  describe('pageInventory', () => {
    test('scans sections, coordinates, and layout groups accurately', async () => {
      const mockInventory = {
        scrollHeight: 6941,
        viewportHeight: 1006,
        sections: [
          { index: 0, id: 'announcement', tag: 'aside', selector: 'aside.announcement-bar', y: 0, height: 42, group: 'header-group' },
          { index: 1, id: 'hero', tag: 'section', selector: 'section.section-hero', y: 42, height: 964, group: 'main-content', heading: 'Hero Title' },
          { index: 2, id: 'newsletter', tag: 'section', selector: '#shopify-section-newsletter', y: 6097, height: 400, group: 'footer-group' },
          { index: 3, id: 'footer', tag: 'footer', selector: 'footer.site-footer', y: 6497, height: 444, group: 'footer-group' },
        ],
      };

      const host = createMockHost({
        evalJs: async () => mockInventory,
      });
      const port = new BrowserControlPort(host);

      const res = await port.pageInventory(dummyTarget, { tabId: '@storefront' });
      assert.strictEqual(res.scrollHeight, 6941);
      assert.strictEqual(res.sections.length, 4);
      assert.strictEqual(res.sections[0]?.group, 'header-group');
      assert.strictEqual(res.sections[2]?.group, 'footer-group');
      assert.strictEqual(res.sections[2]?.y, 6097);
    });
  });

  describe('styleDiff', () => {
    test('identifies matching and mismatching computed styles across tabs', async () => {
      const host = createMockHost({
        evalJs: async (_expr: string, tabId?: string) => {
          if (tabId === 'tab-1') {
            return { width: '403px', height: '52px', color: 'rgb(255, 255, 255)', 'box-shadow': 'rgb(255, 255, 255) 0px 0px 0px 1px inset' };
          }
          return { width: '128px', height: '52px', color: 'rgb(255, 255, 255)', 'box-shadow': 'none' };
        },
      });
      const port = new BrowserControlPort(host);

      const diff = await port.styleDiff(dummyTarget, {
        selector: '.section-hero__cta',
        tabId: 'tab-1',
        comparisonTabId: 'tab-2',
        properties: ['width', 'height', 'color', 'box-shadow'],
      });

      assert.strictEqual(diff.match, false);
      assert.strictEqual(diff.differences['height']?.status, 'MATCH');
      assert.strictEqual(diff.differences['color']?.status, 'MATCH');
      assert.strictEqual(diff.differences['width']?.status, 'MISMATCH');
      assert.strictEqual(diff.differences['width']?.tab1, '403px');
      assert.strictEqual(diff.differences['width']?.tab2, '128px');
      assert.strictEqual(diff.differences['box-shadow']?.status, 'MISMATCH');
    });
  });

  describe('validateSpecGate', () => {
    test('passes when section count and height parity are within tolerance and zero console errors', async () => {
      const host = createMockHost({
        evalJs: async (_expr: string, tabId?: string) => {
          if (tabId === 'tab-1') {
            return { scrollHeight: 6941, viewportHeight: 1006, sections: [{ index: 0 }, { index: 1 }, { index: 2 }] };
          }
          return { scrollHeight: 6900, viewportHeight: 1006, sections: [{ index: 0 }, { index: 1 }, { index: 2 }] };
        },
        getDiagnostics: () => ({ console: [], failures: [] }),
      });
      const port = new BrowserControlPort(host);

      const res = await port.validateSpecGate(dummyTarget, { specTabId: 'tab-2', targetTabId: 'tab-1', tolerance: 5.0 });
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.criticalCount, 0);
      assert.strictEqual(res.checklist['structuralSections']?.status, 'PASS');
      assert.strictEqual(res.checklist['heightParity']?.status, 'PASS');
      assert.strictEqual(res.checklist['consoleErrors']?.status, 'PASS');
    });

    test('fails when spec is missing sections (e.g. dropped Newsletter)', async () => {
      const host = createMockHost({
        evalJs: async (_expr: string, tabId?: string) => {
          if (tabId === 'tab-1') {
            // Target has 4 sections
            return { scrollHeight: 6941, viewportHeight: 1006, sections: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }] };
          }
          // Spec only has 3 sections (Newsletter missing)
          return { scrollHeight: 6541, viewportHeight: 1006, sections: [{ index: 0 }, { index: 1 }, { index: 2 }] };
        },
        getDiagnostics: () => ({ console: [], failures: [] }),
      });
      const port = new BrowserControlPort(host);

      const res = await port.validateSpecGate(dummyTarget, { specTabId: 'tab-2', targetTabId: 'tab-1' });
      assert.strictEqual(res.passed, false);
      assert.ok(res.criticalCount >= 1);
      assert.strictEqual(res.checklist['structuralSections']?.status, 'FAIL');
      assert.ok(res.checklist['structuralSections']?.message.includes('Spec missing sections'));
    });

    test('respects custom tolerance threshold on height delta', async () => {
      const host = createMockHost({
        evalJs: async (_expr: string, tabId?: string) => {
          if (tabId === 'tab-1') {
            return { scrollHeight: 1000, viewportHeight: 500, sections: [{ index: 0 }] };
          }
          // Spec is 920px (8% delta)
          return { scrollHeight: 920, viewportHeight: 500, sections: [{ index: 0 }] };
        },
        getDiagnostics: () => ({ console: [], failures: [] }),
      });
      const port = new BrowserControlPort(host);

      // Under default 5% tolerance: 8% delta should FAIL
      const resDefault = await port.validateSpecGate(dummyTarget, { specTabId: 'tab-2', targetTabId: 'tab-1', tolerance: 5.0 });
      assert.strictEqual(resDefault.checklist['heightParity']?.status, 'FAIL');

      // Under relaxed 10% tolerance: 8% delta should PASS
      const resRelaxed = await port.validateSpecGate(dummyTarget, { specTabId: 'tab-2', targetTabId: 'tab-1', tolerance: 10.0 });
      assert.strictEqual(resRelaxed.checklist['heightParity']?.status, 'PASS');
    });

    test('fails when spec has unhandled console/syntax errors', async () => {
      const host = createMockHost({
        evalJs: async () => ({ scrollHeight: 1000, viewportHeight: 500, sections: [{ index: 0 }] }),
        getDiagnostics: () => ({
          console: [{ level: 3, message: 'Uncaught SyntaxError: Unexpected identifier' }],
          failures: [],
        }),
      });
      const port = new BrowserControlPort(host);

      const res = await port.validateSpecGate(dummyTarget, { specTabId: 'tab-2', targetTabId: 'tab-1' });
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.checklist['consoleErrors']?.status, 'FAIL');
      assert.ok(res.checklist['consoleErrors']?.message.includes('1 unhandled errors'));
    });

    test('fails closed when target has 0 sections or 0 height', async () => {
      const host = createMockHost({
        evalJs: async (_expr: string, tabId?: string) => {
          if (tabId === 'tab-1') {
            return { scrollHeight: 0, viewportHeight: 500, sections: [] };
          }
          return { scrollHeight: 1000, viewportHeight: 500, sections: [{ index: 0 }] };
        },
        getDiagnostics: () => ({ console: [], failures: [] }),
      });
      const port = new BrowserControlPort(host);

      const res = await port.validateSpecGate(dummyTarget, { specTabId: 'tab-2', targetTabId: 'tab-1' });
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.checklist['structuralSections']?.status, 'FAIL');
      assert.strictEqual(res.checklist['heightParity']?.status, 'FAIL');
      assert.ok(res.checklist['structuralSections']?.message.includes('Invalid section count'));
      assert.ok(res.checklist['heightParity']?.message.includes('Invalid height measurement'));
    });
  });

  describe('Semantic Tab Aliasing with @target', () => {
    test('resolves @target alias to storefront tab seamlessly', async () => {
      const host = createMockHost();
      const port = new BrowserControlPort(host);
      const res = await port.freezeMedia(dummyTarget, { tabId: '@target' });
      assert.strictEqual(res.tabId, 'tab-1');
    });
  });
});
