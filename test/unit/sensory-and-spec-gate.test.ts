import * as vm from 'node:vm';
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

    test('freeze script performs transactional slider snapshot, deduplication, and full restoration in DOM VM', async () => {
      let freezeScript = '';
      let unfreezeScript = '';
      const host = createMockHost({
        evalJs: async (expr: string) => {
          if (expr.includes('const freeze = true;')) {
            freezeScript = expr;
            return { frozen: true, mediaCount: 1 };
          }
          unfreezeScript = expr;
          return { frozen: false, mediaCount: 1 };
        },
      });
      const port = new BrowserControlPort(host);
      await port.freezeMedia(dummyTarget, { freeze: true, normalizeSliders: true, tabId: 'tab-1' });
      await port.freezeMedia(dummyTarget, { freeze: false, tabId: 'tab-1' });

      class MockElement {
        public className: string;
        public styleProps = new Map<string, string>();
        public stylePriorities = new Map<string, string>();
        public scrollLeft = 120;
        public scrollTop = 40;
        public style: {
          getPropertyValue: (prop: string) => string;
          getPropertyPriority: (prop: string) => string;
          setProperty: (prop: string, val: string, priority?: string) => void;
          removeProperty: (prop: string) => void;
        };
        constructor(className: string) {
          this.className = className;
          this.style = {
            getPropertyValue: (p: string) => this.styleProps.get(p) || '',
            getPropertyPriority: (p: string) => this.stylePriorities.get(p) || '',
            setProperty: (p: string, v: string, pri = '') => {
              this.styleProps.set(p, v);
              this.stylePriorities.set(p, pri);
            },
            removeProperty: (p: string) => {
              this.styleProps.delete(p);
              this.stylePriorities.delete(p);
            },
          };
        }
        public scrollTo(opts: { left?: number; top?: number }): void {
          if (typeof opts.left === 'number') this.scrollLeft = opts.left;
          if (typeof opts.top === 'number') this.scrollTop = opts.top;
        }
      }

      const multiMatchElement = new MockElement('carousel swiper-wrapper');
      multiMatchElement.style.setProperty('transform', 'translate3d(50px, 0px, 0px)', 'important');
      multiMatchElement.style.setProperty('transition', 'transform 300ms ease', '');
      multiMatchElement.style.setProperty('left', '20px', '');
      multiMatchElement.style.setProperty('margin-left', '10px', 'important');

      const mockElements = [multiMatchElement];
      let videoPlayCount = 0;
      let videoPauseCount = 0;
      let svgPauseCount = 0;
      let svgUnpauseCount = 0;
      let prePausedSvgPauseCount = 0;
      let prePausedSvgUnpauseCount = 0;
      let throwingSvgUnpauseCount = 0;
      let setAttrThrowSvgPauseCount = 0;
      let setAttrThrowSvgRollbackUnpauseCount = 0;
      let unpauseThrowSvgUnpauseAttempts = 0;
      let unpauseThrowSvgPauseCount = 0;
      let clearTimeoutCount = 0;
      let clearedTimerId: unknown = undefined;

      const mockVideo = {
        tagName: 'VIDEO',
        paused: false,
        dataset: {} as Record<string, string>,
        pause: function() {
          videoPauseCount++;
          this.paused = true;
        },
        play: async function() {
          videoPlayCount++;
          this.paused = false;
        },
      };

      class MockSvgElement {
        public tagName = 'SVG';
        public attrs = new Map<string, string>();
        public isPrePaused: boolean;
        public shouldThrowOnPause: boolean;
        public shouldThrowOnSetAttr: boolean;
        public shouldThrowOnUnpause: boolean;
        constructor(isPrePaused = false, shouldThrowOnPause = false, shouldThrowOnSetAttr = false, shouldThrowOnUnpause = false) {
          this.isPrePaused = isPrePaused;
          this.shouldThrowOnPause = shouldThrowOnPause;
          this.shouldThrowOnSetAttr = shouldThrowOnSetAttr;
          this.shouldThrowOnUnpause = shouldThrowOnUnpause;
        }
        public animationsPaused(): boolean {
          return this.isPrePaused;
        }
        public getAttribute(name: string): string | null {
          return this.attrs.get(name) ?? null;
        }
        public setAttribute(name: string, val: string): void {
          if (this.shouldThrowOnSetAttr) {
            throw new Error('setAttribute failed');
          }
          this.attrs.set(name, val);
        }
        public removeAttribute(name: string): void {
          this.attrs.delete(name);
        }
        public pauseAnimations(): void {
          if (this.shouldThrowOnPause) {
            throw new Error('SVG animation pause failed');
          }
          if (this.shouldThrowOnSetAttr) setAttrThrowSvgPauseCount++;
          else if (this.shouldThrowOnUnpause) unpauseThrowSvgPauseCount++;
          else if (this.isPrePaused) prePausedSvgPauseCount++;
          else svgPauseCount++;
        }
        public unpauseAnimations(): void {
          if (this.shouldThrowOnUnpause) {
            unpauseThrowSvgUnpauseAttempts++;
            throw new Error('unpause failed');
          }
          if (this.shouldThrowOnSetAttr) setAttrThrowSvgRollbackUnpauseCount++;
          else if (this.shouldThrowOnPause) throwingSvgUnpauseCount++;
          else if (this.isPrePaused) prePausedSvgUnpauseCount++;
          else svgUnpauseCount++;
        }
      }

      const activeSvg = new MockSvgElement(false);
      const prePausedSvg = new MockSvgElement(true);
      const throwingSvg = new MockSvgElement(false, true);
      const setAttrThrowSvg = new MockSvgElement(false, false, true, false);
      const unpauseThrowSvg = new MockSvgElement(false, false, false, true);

      const mockDocument = {
        querySelectorAll: (sel: string) => {
          if (sel.includes('video, audio')) return [mockVideo];
          if (sel.includes('svg')) return [throwingSvg, setAttrThrowSvg, unpauseThrowSvg, activeSvg, prePausedSvg];
          if (sel.includes('.carousel') || sel.includes('.swiper-wrapper')) {
            return mockElements;
          }
          return [];
        },
        getElementById: () => null,
        createElement: () => ({ id: '', textContent: '', remove: () => {} }),
        head: { appendChild: () => {} },
      };

      const mockWindow: Record<string, unknown> = {
        __antifanSliderSnapshots: undefined,
        requestAnimationFrame: () => 1,
      };
      let capturedTimeoutCb: (() => void) | undefined;
      const ctx = vm.createContext({
        document: mockDocument,
        window: mockWindow,
        performance: { now: () => 1000 },
        clearTimeout: (id: unknown) => {
          clearTimeoutCount++;
          clearedTimerId = id;
        },
        setTimeout: (cb: () => void) => {
          capturedTimeoutCb = cb;
          return 123;
        },
      });
      vm.runInContext(freezeScript, ctx);

      assert.strictEqual(multiMatchElement.style.getPropertyValue('transform'), 'matrix(1, 0, 0, 1, 0, 0)');
      assert.strictEqual(multiMatchElement.style.getPropertyPriority('transform'), 'important');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('transition'), 'none');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('left'), '0px');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('margin-left'), '0px');
      assert.strictEqual(multiMatchElement.scrollLeft, 0);

      const snapshots1 = mockWindow.__antifanSliderSnapshots as unknown[];
      assert.ok(Array.isArray(snapshots1), 'Snapshots array must be initialized');
      assert.strictEqual(snapshots1.length, 1, 'Element matching both selector groups must be snapped exactly once');

      vm.runInContext(freezeScript, ctx);
      const snapshots2 = mockWindow.__antifanSliderSnapshots as Array<{ transform: { value: string; priority: string } }>;
      assert.strictEqual(snapshots2.length, 1, 'Snapshots length must remain 1 after repeated freeze');
      const firstSnap = snapshots2[0];
      assert.ok(firstSnap, 'First snapshot must be present');
      assert.strictEqual(firstSnap.transform.value, 'translate3d(50px, 0px, 0px)', 'Repeated freeze must retain original pre-normalized transform');
      assert.strictEqual(firstSnap.transform.priority, 'important', 'Repeated freeze must retain original property priority');
      assert.strictEqual(mockWindow.__antifanFreezeTimer, 123, 'Timer marker must be set on freeze');
      assert.strictEqual(videoPauseCount, 1, 'Video must be paused once and not re-paused on repeated freeze');
      assert.strictEqual(svgPauseCount, 1, 'Active SVG must be paused once and not re-paused when already marked');
      assert.strictEqual(prePausedSvgPauseCount, 0, 'Pre-paused SVG must NEVER be paused by AntiFan');
      assert.strictEqual(throwingSvg.getAttribute('data-antifan-svg-paused'), null, 'Throwing SVG must not have ownership attribute when pause throws');
      assert.strictEqual(setAttrThrowSvgPauseCount, 2, 'setAttrThrowSvg must have attempted pause on each freeze');
      assert.strictEqual(setAttrThrowSvgRollbackUnpauseCount, 2, 'setAttrThrowSvg must have rollback-unpaused on each freeze when setAttribute threw');
      assert.strictEqual(setAttrThrowSvg.getAttribute('data-antifan-svg-paused'), null, 'setAttrThrowSvg must not have ownership attribute');
      assert.strictEqual(unpauseThrowSvg.getAttribute('data-antifan-svg-paused'), 'true', 'unpauseThrowSvg must have ownership attribute');
      assert.strictEqual(unpauseThrowSvgPauseCount, 1, 'unpauseThrowSvg must be paused once');
      assert.strictEqual(prePausedSvg.getAttribute('data-antifan-svg-paused'), null, 'Pre-paused SVG must not have ownership attribute');
      assert.strictEqual(activeSvg.getAttribute('data-antifan-svg-paused'), 'true', 'Active SVG must be marked with ownership attribute');

      vm.runInContext(unfreezeScript, ctx);

      assert.strictEqual(clearTimeoutCount, 2, 'clearTimeout must be called on repeated freeze and on explicit unfreeze');
      assert.strictEqual(clearedTimerId, 123, 'Must clear scheduled freeze timer ID');
      assert.strictEqual(mockWindow.__antifanFreezeTimer, undefined, 'Timer marker must be deleted after unfreeze');
      assert.strictEqual(videoPlayCount, 1, 'Video must be resumed on unfreeze');
      assert.strictEqual(svgUnpauseCount, 1, 'Active SVG must be unpaused on unfreeze');
      assert.strictEqual(prePausedSvgUnpauseCount, 0, 'Pre-paused SVG must NEVER be unpaused on unfreeze');
      assert.strictEqual(throwingSvgUnpauseCount, 0, 'Throwing SVG must NEVER be unpaused on unfreeze');
      assert.strictEqual(activeSvg.getAttribute('data-antifan-svg-paused'), null, 'Active SVG ownership attribute must be removed on unfreeze');
      assert.strictEqual(unpauseThrowSvgUnpauseAttempts, 1, 'unpauseThrowSvg must have attempted unpause');
      assert.strictEqual(unpauseThrowSvg.getAttribute('data-antifan-svg-paused'), 'true', 'unpauseThrowSvg must retain ownership attribute when unpause throws for retry');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('transform'), 'translate3d(50px, 0px, 0px)');
      assert.strictEqual(multiMatchElement.style.getPropertyPriority('transform'), 'important');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('transition'), 'transform 300ms ease');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('left'), '20px');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('margin-left'), '10px');
      assert.strictEqual(multiMatchElement.style.getPropertyPriority('margin-left'), 'important');
      assert.strictEqual(multiMatchElement.scrollLeft, 120);
      assert.strictEqual(multiMatchElement.scrollTop, 40);
      assert.strictEqual(mockWindow.__antifanSliderSnapshots, undefined, 'Snapshots must be deleted on unfreeze');

      // 4. Test 60s auto-unfreeze timer parity
      vm.runInContext(freezeScript, ctx);
      assert.strictEqual(multiMatchElement.style.getPropertyValue('transform'), 'matrix(1, 0, 0, 1, 0, 0)');
      assert.strictEqual(mockWindow.__antifanFreezeTimer, 123, 'Timer marker must be set for auto-unfreeze');
      assert.ok(typeof capturedTimeoutCb === 'function', 'Timeout callback must be scheduled');

      const clearTimeoutCountBeforeTimerCb = clearTimeoutCount;
      // Trigger the 60s timer callback
      capturedTimeoutCb();

      assert.strictEqual(clearTimeoutCount, clearTimeoutCountBeforeTimerCb, 'Timer callback must NOT call clearTimeout on self');
      assert.strictEqual(mockWindow.__antifanFreezeTimer, undefined, 'Timer marker must be deleted on timeout expiration');
      assert.strictEqual(videoPlayCount, 2, 'Video must be resumed on timeout expiration');
      assert.strictEqual(svgUnpauseCount, 2, 'Active SVG must be unpaused on timeout expiration');
      assert.strictEqual(prePausedSvgUnpauseCount, 0, 'Pre-paused SVG must NEVER be unpaused on timeout expiration');
      assert.strictEqual(throwingSvgUnpauseCount, 0, 'Throwing SVG must NEVER be unpaused on timeout expiration');
      assert.strictEqual(activeSvg.getAttribute('data-antifan-svg-paused'), null, 'Active SVG ownership attribute must be removed on timeout expiration');
      assert.strictEqual(unpauseThrowSvgUnpauseAttempts, 2, 'unpauseThrowSvg must have attempted unpause again on timeout expiration');
      assert.strictEqual(unpauseThrowSvg.getAttribute('data-antifan-svg-paused'), 'true', 'unpauseThrowSvg must retain ownership attribute when unpause throws on timeout expiration');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('transform'), 'translate3d(50px, 0px, 0px)');
      assert.strictEqual(multiMatchElement.style.getPropertyPriority('transform'), 'important');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('transition'), 'transform 300ms ease');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('left'), '20px');
      assert.strictEqual(multiMatchElement.style.getPropertyValue('margin-left'), '10px');
      assert.strictEqual(multiMatchElement.style.getPropertyPriority('margin-left'), 'important');
      assert.strictEqual(multiMatchElement.scrollLeft, 120);
      assert.strictEqual(multiMatchElement.scrollTop, 40);
      assert.strictEqual(mockWindow.__antifanSliderSnapshots, undefined, 'Snapshots must be deleted on timer unfreeze');
    });

    test('throws CapabilityError when evalJs fails or returns undefined', async () => {
      const host = createMockHost({
        evalJs: async () => undefined,
      });
      const port = new BrowserControlPort(host);

      await assert.rejects(
        async () => port.freezeMedia(dummyTarget, { tabId: 'tab-1' }),
        (err: unknown) => {
          if (err && typeof err === 'object' && 'code' in err) {
            return typeof err.code === 'string' && err.code === 'TARGET_STALE';
          }
          return false;
        }
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
    test('normalizes color formats and primary font families', async () => {
      const host = createMockHost({
        evalJs: async (_expr: string, tabId?: string) => {
          if (tabId === 'tab-1') {
            return { color: 'rgba(255, 255, 255, 1)', 'font-family': "'Inter', sans-serif" };
          }
          return { color: 'rgb(255, 255, 255)', 'font-family': 'Inter, -apple-system, sans-serif' };
        },
      });
      const port = new BrowserControlPort(host);

      const diff = await port.styleDiff(dummyTarget, {
        selector: '.title',
        tabId: 'tab-1',
        comparisonTabId: 'tab-2',
        properties: ['color', 'font-family'],
      });

      assert.strictEqual(diff.match, true);
      assert.strictEqual(diff.differences['color']?.status, 'MATCH');
      assert.strictEqual(diff.differences['font-family']?.status, 'MATCH');
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
      assert.strictEqual(res.score, 100);
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
