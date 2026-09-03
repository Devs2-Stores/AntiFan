import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { buildMcpToolList, AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

// Helper to construct a minimal valid PNG buffer with given width and height
function createTestPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  // PNG signature
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  // IHDR length = 13
  buf.writeUInt32BE(13, 8);
  // IHDR chunk type
  buf.write('IHDR', 12, 'ascii');
  // Width and Height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Bit depth 8, ColorType 2, Compression 0, Filter 0, Interlace 0
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  // CRC placeholder
  buf.writeUInt32BE(0, 29);
  return buf;
}

describe('Runtime Full-Page Evidence & 5D Parity Tests', () => {
  const dummyTarget: BrowserTarget = {
    tabId: 'tab-test',
    documentGeneration: 1,
    projectId: 'test-proj',
    workspaceId: 'test-ws',
    runtimeId: 'test-rt',
    browserEpoch: 1,
  };

  it('1. Bitmap Height Parity Guard rejects structural truncation (>10% height mismatch)', async () => {
    // Current screenshot: 1200x1000 (truncated viewport)
    const curPng = createTestPng(1200, 1000);
    // Baseline screenshot: 1200x3000 (full page) -> delta = (3000 - 1000)/3000 = 66.7% > 10%
    const basePng = createTestPng(1200, 3000);

    const mockHost = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-test' }, { id: 'tab-baseline' }],
      captureScreenshot: async (_rect: unknown, tabId?: string) => {
        if (tabId === 'tab-baseline') return basePng.toString('base64');
        return curPng.toString('base64');
      },
    };

    const port = new BrowserControlPort(mockHost as any);
    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      { comparisonTabId: 'tab-baseline', fullPage: true }
    );

    assert.strictEqual(result.match, false);
    assert.strictEqual(result.mismatchPercentage, 100);
    assert.strictEqual(result.verdict, 'STRUCTURAL_TRUNCATION_DETECTED');
    assert.ok(typeof result.reason === 'string' && result.reason.includes('Structural height mismatch'));
  });

  it('2. Capability Catalogue registers anti.screenshot.full_page and fullPage schema', () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'test', workspaceId: 'test', runtimeId: 'test' });
    const mockPort = {} as unknown as BrowserControlPort;
    registerBrowserCapabilities(catalogue, mockPort);

    // anti.screenshot.full_page must be registered
    const fullPageCap = catalogue.get('anti.screenshot.full_page');
    assert.ok(fullPageCap, 'anti.screenshot.full_page must be registered');
    assert.strictEqual(fullPageCap?.risk, 'read');

    // anti.screenshot.viewport must expose fullPage property
    const viewportCap = catalogue.get('anti.screenshot.viewport');
    assert.ok(viewportCap, 'anti.screenshot.viewport must be registered');
    const viewportProps = (viewportCap?.inputSchema as any)?.properties;
    assert.ok(viewportProps?.fullPage, 'viewport screenshot schema must include fullPage boolean');

    // browser.visual_compare must expose fullPage property
    const visualCompareCap = catalogue.get('browser.visual_compare');
    assert.ok(visualCompareCap, 'browser.visual_compare must be registered');
    const vcProps = (visualCompareCap?.inputSchema as any)?.properties;
    assert.ok(vcProps?.fullPage, 'visual_compare schema must include fullPage boolean');
  });

  it('3. MCP Server generates tool aliases and dispatches anti.screenshot.full_page with fullPage: true', async () => {
    let dispatchedIntent: any = null;
    const mockTransport = {
      list: (_query: { grant?: string }) => [
        {
          name: 'antifan_screenshot',
          description: 'Screenshot tool',
          risk: 'read',
          inputSchema: { type: 'object' },
        },
        {
          name: 'antifan_set_device_preset',
          description: 'Set device preset',
          risk: 'write',
          inputSchema: { type: 'object' },
        },
      ],
      dispatchIntent: async (intent: any) => {
        dispatchedIntent = intent;
        return { ok: true, invocationId: 'inv-1', requestId: intent.requestId, data: 'ok' };
      },
    };

    const tools = buildMcpToolList([], mockTransport as any);
    const toolNames = tools.map((t) => t.name);

    assert.ok(toolNames.includes('anti.screenshot.full_page'), 'Must include anti.screenshot.full_page alias');
    assert.ok(toolNames.includes('anti.screenshot.viewport'), 'Must include anti.screenshot.viewport alias');
    assert.ok(toolNames.includes('anti.browser.set_device_preset'), 'Must include anti.browser.set_device_preset alias');
    assert.ok(toolNames.includes('anti.browser.set_device'), 'Must include anti.browser.set_device alias');

    // Test callTool dispatch for anti.screenshot.full_page
    const server = new AntiFanMcpServer(
      {} as any,
      false,
      mockTransport as any,
      { attachmentId: 'att-1', attachmentSecret: 'sec-1', authorityRevision: 'rev-1' }
    );

    const callRes = await server.callTool('anti.screenshot.full_page', { tabId: 'tab-1' });
    assert.strictEqual(callRes.isError, undefined);
    assert.ok(dispatchedIntent, 'Intent must be dispatched to transport');
    assert.strictEqual(dispatchedIntent.name, 'antifan_screenshot', 'Must map full-page alias to antifan_screenshot');
    assert.strictEqual(dispatchedIntent.params.fullPage, true, 'Must force fullPage: true in transport parameters');
  });

  it('4. traceInteraction V8 Micro-Observer evaluates 4 vectors and returns FAIL on mismatch', async () => {
    // Mock host that simulates in-page rAF motion sampling
    const mockHost = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-test' }],
      evalJs: async (script: string) => {
        if (script.includes('window.__stopAntifanMotion')) {
          return {
            samples: [
              { t: 0, transform: 'scale(1)', opacity: '1', width: '100px', height: '50px' },
              { t: 16, transform: 'scale(1.02)', opacity: '0.9', width: '100px', height: '50px' },
              { t: 33, transform: 'scale(1.05)', opacity: '0.8', width: '100px', height: '50px' },
              { t: 50, transform: 'scale(1.05)', opacity: '0.8', width: '100px', height: '50px' },
              { t: 67, transform: 'scale(1.05)', opacity: '0.8', width: '100px', height: '50px' },
            ],
            computedTimingFunction: 'ease-out',
            computedTransitionProperty: 'transform, opacity',
            animEasing: 'cubic-bezier(0, 0, 0.58, 1)',
            animProps: ['transform', 'opacity'],
          };
        }
        if (script.includes('__antifanMotionSamples')) {
          return true;
        }
        return {};
      },
    };

    const port = new BrowserControlPort(mockHost as any);

    // Case A: Expected duration 33ms (matches observed 33ms within 33ms deadband) -> PASS
    const passResult = await port.traceInteraction(
      dummyTarget,
      'run-1',
      'att-1',
      {
        action: 'hover',
        selector: 'button.cta',
        settleMs: 20,
        motionSpec: {
          expectedDurationMs: 33,
          expectedProperties: ['transform', 'opacity'],
        },
      }
    );

    const passMotion = passResult.motion as any;
    assert.ok(passMotion, 'Motion trace must be present');
    assert.strictEqual(passMotion.hasMotion, true);
    assert.strictEqual(passMotion.observedDurationMs, 33);
    assert.strictEqual(passMotion.vectors.temporal.verdict, 'PASS');
    assert.strictEqual(passMotion.vectors.property.verdict, 'PASS');
    assert.strictEqual(passMotion.verdict, 'PASS');

    // Case B: Expected duration 200ms (observed 33ms exceeds 33ms deadband delta = 167ms > 33ms) -> FAIL
    const failResult = await port.traceInteraction(
      dummyTarget,
      'run-1',
      'att-1',
      {
        action: 'hover',
        selector: 'button.cta',
        settleMs: 20,
        motionSpec: {
          expectedDurationMs: 200,
          expectedProperties: ['transform', 'opacity'],
        },
      }
    );

    const failMotion = failResult.motion as any;
    assert.ok(failMotion, 'Motion trace must be present');
    assert.strictEqual(failMotion.vectors.temporal.verdict, 'FAIL');
    assert.strictEqual(failMotion.verdict, 'FAIL', 'Overall motion verdict must be FAIL when temporal vector fails');
  });

  it('5. traceInteraction accurately measures opacity delta when starting from opacity 0 (fade-in)', async () => {
    const mockHost = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-test' }],
      evalJs: async (script: string) => {
        if (script.includes('window.__stopAntifanMotion')) {
          return {
            samples: [
              { t: 0, transform: 'none', opacity: '0', width: '100px', height: '50px' },
              { t: 16, transform: 'none', opacity: '0.5', width: '100px', height: '50px' },
              { t: 33, transform: 'none', opacity: '1', width: '100px', height: '50px' },
            ],
            computedTimingFunction: 'ease',
            computedTransitionProperty: 'opacity',
            animEasing: 'ease',
            animProps: ['opacity'],
          };
        }
        return true;
      },
    };

    const port = new BrowserControlPort(mockHost as any);
    const res = await port.traceInteraction(
      dummyTarget,
      'run-1',
      'att-1',
      {
        action: 'click',
        selector: '.fade-in-modal',
        settleMs: 20,
        motionSpec: {
          expectedDurationMs: 33,
          expectedAmplitude: { opacityDelta: 1.0 },
        },
      }
    );

    const motion = res.motion as any;
    assert.ok(motion);
    assert.strictEqual(motion.observedAmplitude.opacityDelta, 1.0, 'Opacity delta from 0 to 1 must be 1.0, not 0');
    assert.strictEqual(motion.vectors.amplitude.verdict, 'PASS');
    assert.strictEqual(motion.verdict, 'PASS');
  });

  it('6. traceInteraction accurately measures scale delta from matrix3d and scale3d CSS transforms', async () => {
    const mockHost = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-test' }],
      agentClick: async () => true,
      evalJs: async (script: string) => {
        if (script.includes('window.__stopAntifanMotion')) {
          return {
            samples: [
              { t: 0, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)', opacity: '1', width: '100px', height: '50px' },
              { t: 16, transform: 'matrix3d(1.1, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)', opacity: '1', width: '100px', height: '50px' },
              { t: 33, transform: 'matrix3d(1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)', opacity: '1', width: '100px', height: '50px' },
            ],
            computedTimingFunction: 'ease-out',
            computedTransitionProperty: 'transform',
            animEasing: 'ease-out',
            animProps: ['transform'],
          };
        }
        return true;
      },
    };

    const port = new BrowserControlPort(mockHost as any);
    const res = await port.traceInteraction(
      dummyTarget,
      'run-1',
      'att-1',
      {
        action: 'click',
        selector: '.card-scale-3d',
        settleMs: 20,
        motionSpec: {
          expectedDurationMs: 33,
          expectedAmplitude: { scaleDelta: 0.2 },
        },
      }
    );

    const motion = res.motion as any;
    assert.ok(motion);
    assert.ok(Math.abs(motion.observedAmplitude.scaleDelta - 0.2) < 0.001, 'matrix3d scaleDelta must be 0.2');
    assert.strictEqual(motion.vectors.amplitude.verdict, 'PASS');
    assert.strictEqual(motion.verdict, 'PASS');
  });
});
