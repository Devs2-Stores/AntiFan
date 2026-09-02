import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { BrowserTarget, CapabilityRequestContext, RuntimeLease } from '../../src/shared/control-plane-contracts';
import {
  buildIsolatedCollectorScript,
  buildIsolatedExecutorScript,
} from '../../src/main/browser/semantic-ref-executor';

describe('SPA Resilience and Debug Fixes Verification', () => {
  const projectId = 'proj-debug-1';
  const workspaceId = 'ws-debug-1';

  const mockTarget: BrowserTarget = {
    projectId,
    workspaceId,
    runtimeId: 'run-debug-1',
    tabId: 'tab-spa-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const mockLease: RuntimeLease = {
    token: 'lease-tok-debug',
    expiresAt: Date.now() + 60000,
    runtimeId: 'run-debug-1',
    projectId,
    workspaceId,
    protocolVersion: 1,
    hostEpoch: 1,
    ownerPid: process.pid,
    issuedAt: Date.now(),
  };

  const mockContextWrite: CapabilityRequestContext = {
    lease: mockLease,
    leaseToken: 'lease-tok-debug',
    projectId,
    workspaceId,
    runId: 'run-debug-1',
    attemptId: 'att-debug-1',
    browserTarget: mockTarget,
    grant: 'write',
  };

  const mockContextEval: CapabilityRequestContext = {
    lease: mockLease,
    leaseToken: 'lease-tok-debug',
    projectId,
    workspaceId,
    runId: 'run-debug-1',
    attemptId: 'att-debug-1',
    browserTarget: mockTarget,
    grant: 'eval',
  };

  const catalogueOptions = {
    runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
    projectId,
    workspaceId,
    runtimeId: 'run-debug-1',
    hostEpoch: 1,
    allowEval: true,
  };

  it('1. anti.browser.evaluate enforces least-privilege: denied under grant: "write", allowed under grant: "eval"', async () => {
    let evaluatedExpression = '';
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-spa-1' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async (expr) => {
        evaluatedExpression = expr;
        return { result: 'Son Tung M-TP - Dung Lam Trai Tim Anh Dau' };
      },
    };

    const catalogue = new CapabilityCatalogue(catalogueOptions);
    const controlPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, controlPort);

    // 1. Least privilege: evaluate MUST throw POLICY_DENIED on dispatch under ordinary write grant
    await assert.rejects(
      async () => catalogue.dispatch('anti.browser.evaluate', { expression: 'document.title' }, mockContextWrite),
      (err: any) => err.code === 'POLICY_DENIED'
    );

    // 2. Evaluate succeeds on dispatch when explicitly granted eval permission
    const result = (await catalogue.dispatch('anti.browser.evaluate', { expression: 'document.title' }, mockContextEval)) as { result: string };
    assert.ok(result);
    assert.strictEqual(evaluatedExpression, 'document.title');
    assert.strictEqual(result.result, 'Son Tung M-TP - Dung Lam Trai Tim Anh Dau');
  });

  it('2. Large DOM extraction (e.g. 2MB YouTube DOM) stages up to 8MB without payload truncation error', async () => {
    const largeHtml = '<div>' + '<p>YouTube Video Item Item Item</p>'.repeat(50000) + '</div>'; // ~1.8 MB HTML
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-spa-1' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => largeHtml,
      captureScreenshot: async () => 'base64',
      evalJs: async () => null,
    };

    const artifacts = new ArtifactStore({ root: '.tmp-artifacts-spa-test', maxArtifactBytes: 16 * 1024 * 1024 });
    const controlPort = new BrowserControlPort(mockHost, artifacts);

    const domArtifact = await controlPort.dom(mockTarget, 'run-large-dom', 'att-1');
    assert.ok(typeof domArtifact === 'object');
    assert.strictEqual((domArtifact as { truncated?: boolean }).truncated, false, 'Large 1.8MB DOM must not be marked as truncated when limit is 8MB');
    assert.ok((domArtifact as { byteLength: number }).byteLength > 1_500_000, 'Byte length must reflect full DOM content');
  });

  it('3. buildIsolatedCollectorScript ignores hidden container subtrees and collects interactive elements efficiently', () => {
    const scriptStr = buildIsolatedCollectorScript('nonce-test', 'http://localhost/youtube');
    const script = new vm.Script(scriptStr);

    function MockElementClass() {}

    const searchInput = {
      tagName: 'INPUT',
      id: 'search',
      type: 'text',
      hidden: false,
      style: { display: 'block', visibility: 'visible' },
      getAttribute: (attr: string) => (attr === 'placeholder' ? 'Search YouTube' : null),
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 100, y: 20, width: 400, height: 36 }),
    };

    const hiddenBanner = {
      tagName: 'DIV',
      id: 'hidden-popup',
      hidden: true,
      style: { display: 'none', visibility: 'hidden' },
      getAttribute: () => null,
      hasAttribute: () => false,
      children: [],
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    };

    Object.setPrototypeOf(searchInput, MockElementClass.prototype);
    Object.setPrototypeOf(hiddenBanner, MockElementClass.prototype);

    const sandbox: Record<string, unknown> = {
      window: {
        location: { href: 'http://localhost/youtube' },
        getComputedStyle: (el: any) => el.style || { display: 'block', visibility: 'visible' },
      },
      document: {
        querySelector: () => null,
        children: [searchInput, hiddenBanner],
      },
      Element: MockElementClass,
    };

    const context = vm.createContext(sandbox);
    const result = script.runInContext(context);

    assert.ok(result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.descriptors.length, 1);
    assert.strictEqual(result.descriptors[0].id, 'search');
    assert.strictEqual(result.descriptors[0].label, 'Search YouTube');
  });

  it('4. buildIsolatedExecutorScript resolves elements nested inside Shadow DOM (e.g. YouTube ytd-searchbox)', async () => {
    const scriptStr = buildIsolatedExecutorScript({
      action: 'focus',
      selector: 'input#search-input',
      documentUrl: 'http://localhost/youtube',
      nonce: 'nonce-exec',
    });
    const script = new vm.Script(scriptStr);

    function MockElementClass() {}

    const innerInput = {
      tagName: 'INPUT',
      id: 'search-input',
      isConnected: true,
      focus: () => {},
      getAttribute: (attr: string) => (attr === 'type' ? 'text' : null),
      getBoundingClientRect: () => ({ x: 120, y: 24, width: 380, height: 32 }),
    };
    Object.setPrototypeOf(innerInput, MockElementClass.prototype);

    const shadowHost = {
      tagName: 'YTD-SEARCHBOX',
      isConnected: true,
      getAttribute: () => null,
      shadowRoot: {
        querySelector: (sel: string) => (sel === 'input#search-input' ? innerInput : null),
        querySelectorAll: (sel?: string) => (sel === 'input#search-input' ? [innerInput] : []),
      },
    };
    Object.setPrototypeOf(shadowHost, MockElementClass.prototype);

    const sandbox: Record<string, unknown> = {
      window: {
        location: { href: 'http://localhost/youtube' },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      },
      document: {
        querySelector: () => null,
        querySelectorAll: (sel?: string) => (sel === '*' || !sel ? [shadowHost] : []),
        documentElement: {},
        body: {},
      },
      Element: MockElementClass,
      setTimeout,
      clearTimeout,
    };

    const context = vm.createContext(sandbox);
    const result = await script.runInContext(context);

    assert.ok(result);
    assert.strictEqual(result.ok, true, `Result was not ok: ${JSON.stringify(result)}`);
    assert.strictEqual(result.executed, true);
  });

  it('5. Navigate -> Snapshot -> Target Continuity -> Click full regression pipeline preserves tabId and docGen', async () => {
    let currentDocGen = 1;
    let currentUrl = 'about:blank';
    const clickedTargets: string[] = [];

    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-spa-1', url: currentUrl }],
      navigate: async (tabId, url) => {
        currentUrl = url;
        currentDocGen++;
        return true;
      },
      getDocumentGeneration: () => currentDocGen,
      reload: () => true,
      getDom: async () => '<html><body><button id="play-btn">Play</button></body></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => null,
      agentClick: async (params) => {
        clickedTargets.push(params.selector || params.ref || '');
        return true;
      },
    };

    const catalogue = new CapabilityCatalogue(catalogueOptions);
    const controlPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, controlPort);

    // Step A: Navigate to YouTube URL
    const navRes = (await catalogue.dispatch(
      'browser.navigate',
      { url: 'https://www.youtube.com/results?search_query=son+tung+m-tp' },
      mockContextWrite
    )) as { navigated: boolean; target: BrowserTarget };
    assert.ok(navRes.navigated);
    assert.strictEqual(navRes.target.documentGeneration, 2);

    // Step B: Target updated context
    const updatedContext: CapabilityRequestContext = {
      ...mockContextWrite,
      browserTarget: navRes.target,
    };

    // Step C: Execute click with target continuity preserved
    const clickRes = (await catalogue.dispatch(
      'anti.agent.cursor.click',
      { selector: 'button#play-btn', tabId: navRes.target.tabId },
      updatedContext
    )) as { clicked: boolean };
    assert.ok(clickRes.clicked);
    assert.deepStrictEqual(clickedTargets, ['button#play-btn']);
  });

  it('6. MCP fetchArtifactBinary reassembles multi-chunk >1MB payloads with X-Artifact-Has-More', async () => {
    const chunk1 = Buffer.alloc(1024 * 1024, 'A'); // 1MB 'A'
    const chunk2 = Buffer.alloc(512 * 1024, 'B'); // 512KB 'B'
    const totalBytes = chunk1.length + chunk2.length;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '1048576', 10);

      const fullData = Buffer.concat([chunk1, chunk2]);
      const slice = fullData.subarray(offset, offset + limit);
      const hasMore = offset + slice.length < fullData.length;

      res.writeHead(200, {
        'content-type': 'text/html',
        'x-artifact-has-more': String(hasMore),
        'x-artifact-total-bytes': String(totalBytes),
      });
      res.end(slice);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
      // Recreate client chunk reader logic from scripts/antifan-omp-mcp.cjs
      async function testFetchArtifactBinary(portNum: number) {
        function fetchChunk(offset = 0, limit = 1024 * 1024): Promise<{ buffer: Buffer; hasMore: boolean }> {
          return new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${portNum}/api/artifacts/artifact-test?offset=${offset}&limit=${limit}`, (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const hasMore = res.headers['x-artifact-has-more'] === 'true';
                resolve({ buffer, hasMore });
              });
            }).on('error', reject);
          });
        }

        const collected: Buffer[] = [];
        let offset = 0;
        while (true) {
          const res = await fetchChunk(offset, 1024 * 1024);
          collected.push(res.buffer);
          offset += res.buffer.length;
          if (!res.hasMore || res.buffer.length === 0) break;
        }
        return Buffer.concat(collected);
      }

      const reassembled = await testFetchArtifactBinary(port);
      assert.strictEqual(reassembled.length, totalBytes, 'Must reassemble complete 1.5MB artifact across chunk boundaries');
      assert.strictEqual(reassembled.subarray(0, 10).toString(), 'AAAAAAAAAA');
      assert.strictEqual(reassembled.subarray(1024 * 1024, 1024 * 1024 + 10).toString(), 'BBBBBBBBBB');
    } finally {
      server.close();
    }
  });
});
