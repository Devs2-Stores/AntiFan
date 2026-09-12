import { DEFAULT_STOREFRONT_WIDGETS } from '../../src/main/tools/browser-control-port';
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort, computePixelDiff } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { CaptureError, type VerificationCaptureEnvelope } from '../../src/main/verification/visual-capture';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import vm from 'node:vm';
import { computeStructuralMetrics, buildStructuralQueryScript } from '../../src/main/verification/visual-region';

// Minimal valid-PNG-shaped buffer the parity guard can measure (real decoding is
// stubbed below via a fake electron nativeImage when the pixel diff runs).
function createTestPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0, 29);
  return buf;
}

interface EvalLogEntry {
  script: string;
  tabId?: string;
}

// visual_compare asserts route identity: a comparison that omits the expected URL settles
// INCONCLUSIVE with URL_EXPECTATION_MISSING instead of diffing. This suite therefore declares the
// route its mock tabs report and routes every comparison through it, so an assertion about the
// pixel diff can only pass when the diff actually ran.
const ROUTE_URL = 'https://store.example.com/product';

function createRoutePort(host: unknown, artifactSink?: unknown): BrowserControlPort {
  const port = new BrowserControlPort(host as any, artifactSink as any);
  const baseVisualCompare = port.visualCompare.bind(port);
  port.visualCompare = ((target, runId, attemptId, params = {}) =>
    baseVisualCompare(target, runId, attemptId, {
      expectedTargetUrl: ROUTE_URL,
      expectedBaselineUrl: ROUTE_URL,
      ...params,
    })) as typeof port.visualCompare;
  return port;
}

interface MaskRow {
  selector: string;
  error: string | null;
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
}

interface MockHostOptions {
  /** per-tab mask payload overrides: tabId -> rows matching `selector` */
  maskRows?: (tabId: string) => MaskRow[];
  /** capture failure for a tab (V-12) */
  captureThrowsFor?: string;
  /** restore returns `false` (style still present) for a tab (restore-failure path) */
  restoreFailsFor?: Set<string>;
  /** per-tab documentGeneration */
  docGenFor?: (tabId: string) => number;
  /** per-tab mutationRevision */
  mutationRevFor?: (tabId: string) => number;
  /** hook fired after each capture (tests mutate identity clocks here) */
  onCapture?: (tabId: string) => void;
  /** inject evalJs result per tab (presence and ownership consistency) */
  injectResultFor?: (tabId: string) => boolean | { owned: boolean; present: boolean };
  /** inject evalJs throws for a tab */
  injectThrowsFor?: Set<string>;
  captureBackendFor?: (tabId: string) => string;
  dprFor?: (tabId: string) => number;
  zoomFor?: (tabId: string) => number;
  viewportFor?: (tabId: string) => { width: number; height: number };
  fontsReadyFor?: (tabId: string) => boolean;
  brokenImagesFor?: (tabId: string) => string[];
  imagesSettledFor?: (tabId: string) => boolean;
  domQuietFor?: (tabId: string) => boolean;
  networkSettledFor?: (tabId: string) => boolean;
  networkTimedOutFor?: (tabId: string) => boolean;
  structuralRowsFor?: (tabId: string) => any[];
  evalJsOverride?: (script: string, tabId?: string) => Promise<unknown> | unknown;
  pngDimensionsForTab?: (tabId: string) => { width: number; height: number };
  /** Wraps each verification capture: gate, fail, or observe concurrency. */
  captureHook?: (
    args: { tabId: string; callIndex: number },
    run: () => Promise<VerificationCaptureEnvelope>
  ) => Promise<VerificationCaptureEnvelope>;
  /** Host-level draining probe (T1 host API) used by compare quarantine. */
  isTargetDrainingFor?: (tabId: string) => boolean;
  /** Host-level bounded recovery (T1 host API) used by compare quarantine. */
  drainTargetFor?: (tabId: string) => Promise<{ ok: boolean; drained: boolean; resetPerformed: boolean; elapsedMs: number }>;
  evalLog: EvalLogEntry[];
}

function buildMockHost(opts: MockHostOptions) {
  const getDims = (tabId: string) => opts.pngDimensionsForTab ? opts.pngDimensionsForTab(tabId) : { width: 800, height: 600 };
  const curPng = createTestPng(getDims('tab-a').width, getDims('tab-a').height);
  const basePng = createTestPng(getDims('tab-b').width, getDims('tab-b').height);
  const captureCounts = new Map<string, number>();
  const host = {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
    getTabUrl: () => ROUTE_URL,
    evalJs: async (script: string, tabId?: string): Promise<unknown> => {
      opts.evalLog.push({ script, tabId });
      if (script.includes('__antifan_compare_txn__')) {
        // Reversible normalization transaction: a static fixture records no
        // mutations and restores cleanly.
        return script.includes('alreadyRestored')
          ? { restored: true, alreadyRestored: true, failed: 0 }
          : { applied: true, alreadyApplied: true, recorded: 0 };
      }
      if (script.includes('el.remove')) {
        if (tabId && opts.restoreFailsFor?.has(tabId)) return false;
        return true;
      }
      if (script.includes('__antifan_normalize_scroll')) {
        if (tabId && opts.injectThrowsFor?.has(tabId)) throw new Error('simulated inject failure');
        if (opts.injectResultFor) return opts.injectResultFor(tabId || '');
        return true;
      }
      if (script.includes('document.fonts.ready')) {
        return opts.fontsReadyFor ? opts.fontsReadyFor(tabId || '') : true;
      }
      if (script.includes('img.decode')) {
        const settled = opts.imagesSettledFor ? opts.imagesSettledFor(tabId || '') : true;
        const brokenImages = opts.brokenImagesFor ? opts.brokenImagesFor(tabId || '') : [];
        return { settled, brokenImages };
      }
      if (script.includes('requestAnimationFrame')) {
        return opts.domQuietFor ? opts.domQuietFor(tabId || '') : true;
      }
      if (script.includes('innerWidth')) return { vw: 800, vh: 600, dh: 1600, sx: 0, sy: 0 };
      if (script.includes('r.width <= 0')) {
        return { x: 0, y: 0, width: 800, height: 200 };
      }
      if (script.includes('root.children')) {
        if (opts.structuralRowsFor && tabId) return opts.structuralRowsFor(tabId);
        if (opts.evalJsOverride) return opts.evalJsOverride(script, tabId);
        return [];
      }
      if (script.includes('const selectors =')) {
        if (!tabId) return [];
        const rows = opts.maskRows ? opts.maskRows(tabId) : [{ selector: '.badge', error: null, boxes: [{ x: 100, y: 100, width: 50, height: 50 }] }];
        return rows;
      }
      if (opts.evalJsOverride) {
        const custom = await opts.evalJsOverride(script, tabId);
        if (custom !== undefined) return custom;
      }
      return null;
    },
    captureScreenshot: async (_rect: unknown, tabId?: string): Promise<string> => {
      if (tabId) opts.onCapture?.(tabId);
      if (tabId && opts.captureThrowsFor === tabId) {
        throw new Error('simulated capture failure');
      }
      return (tabId === 'tab-b' ? basePng : curPng).toString('base64');
    },
    captureVerificationScreenshot: async (rect: unknown, tabId?: string, paneId?: string, options?: any) => {
      const key = tabId || '';
      const callIndex = (captureCounts.get(key) || 0) + 1;
      captureCounts.set(key, callIndex);
      const run = async (): Promise<VerificationCaptureEnvelope> => {
        const data = await host.captureScreenshot(rect, tabId);
        const backend = opts.captureBackendFor ? opts.captureBackendFor(tabId || '') : 'cdp';
        const dpr = opts.dprFor ? opts.dprFor(tabId || '') : 1;
        const zoom = opts.zoomFor ? opts.zoomFor(tabId || '') : 1.0;
        const cssViewport = opts.viewportFor ? opts.viewportFor(tabId || '') : { width: 800, height: 600 };
        return {
          data,
          backend,
          dpr,
          zoom,
          cssViewport,
          // The fake capture ignores rect geometry and always returns the
          // per-tab raster from getDims; cssCaptureSize mirrors the CSS viewport
          // so structural-truncation scenarios surface as raster deltas, not as
          // an artificial capture-state mismatch.
          cssCaptureSize: { width: cssViewport.width, height: cssViewport.height },
          rasterSize: { width: getDims(tabId || '').width, height: getDims(tabId || '').height },
          captureMode: rect ? 'clip' : 'viewport',
          timestamp: Date.now(),
        };
      };
      return opts.captureHook ? opts.captureHook({ tabId: key, callIndex }, run) : run();
    },
    getBrowserEpoch: () => 1,
    getDocumentGeneration: (tabId?: string) => (opts.docGenFor ? opts.docGenFor(tabId || '') : 1),
    getMutationRevision: (tabId?: string) => (opts.mutationRevFor ? opts.mutationRevFor(tabId || '') : 1),
    isTargetDraining: (tabId?: string) => (opts.isTargetDrainingFor ? opts.isTargetDrainingFor(tabId || '') : false),
    drainTarget: async (tabId?: string) => {
      if (!opts.drainTargetFor) {
        return { ok: false, drained: false, resetPerformed: false, elapsedMs: 0 };
      }
      return opts.drainTargetFor(tabId || '');
    },
    getNetworkTracker: () => ({
      isAttached: () => true,
      awaitQuiescence: async (tabId: string) => ({
        settled: opts.networkSettledFor ? opts.networkSettledFor(tabId) : true,
        durationMs: 10,
        timedOut: opts.networkTimedOutFor ? opts.networkTimedOutFor(tabId) : false,
      }),
    }),
  };
  return host;
}

interface StagedArtifactRecord {
  id: string;
  kind: string;
  mime: string;
  byteLength: number;
  runId: string;
  attemptId: string;
  overflowMode?: string;
  leaseToken?: string;
}

/** Minimal ArtifactRef-shaped sink so compare staging is observable end-to-end. */
function buildArtifactSink(): { sink: any; staged: StagedArtifactRecord[] } {
  const staged: StagedArtifactRecord[] = [];
  let seq = 0;
  const sink = {
    stage: async (input: {
      kind: string;
      mime: string;
      data: string | Buffer;
      runId: string;
      attemptId: string;
      projectId: string;
      workspaceId: string;
      maxBytes?: number;
      leaseToken?: string;
      overflowMode?: 'truncate' | 'reject';
    }) => {
      seq += 1;
      const buf = Buffer.isBuffer(input.data) ? input.data : Buffer.from(String(input.data), 'base64');
      staged.push({
        id: `art-${seq}`,
        kind: input.kind,
        mime: input.mime,
        byteLength: buf.length,
        runId: input.runId,
        attemptId: input.attemptId,
        overflowMode: input.overflowMode,
        leaseToken: input.leaseToken,
      });
      return {
        id: `art-${seq}`,
        kind: input.kind,
        mime: input.mime,
        byteLength: buf.length,
        sha256: `sha256-${seq}`,
        runId: input.runId,
        attemptId: input.attemptId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        createdAt: Date.now(),
      };
    },
  };
  return { sink, staged };
}

const dummyTarget: BrowserTarget = {
  tabId: 'tab-a',
  documentGeneration: 1,
  projectId: 'test-proj',
  workspaceId: 'test-ws',
  runtimeId: 'test-rt',
  browserEpoch: 1,
};

// computePixelDiff requires Electron's nativeImage. Under plain node the
// `electron` package resolves to a path string, so the diff path throws
// CAPABILITY_NOT_FOUND. Stub the module cache for the duration of these tests:
// preload the (cheap, path-exporting) real entry first so the cache slot exists,
// then replace its exports until the suite finishes.
const electronResolved = require.resolve('electron');
let electronEntry: NodeModule | undefined = require.cache[electronResolved];
let electronExportsBackup: unknown;

// Per-buffer bitmaps so targeted diff tests can plant specific pixels.
const bitmapByBuffer = new WeakMap<Buffer, Buffer>();

const fakeNativeImageFactory = () => ({
  nativeImage: {
    createFromBuffer: (buf: Buffer) => {
      let width = 800;
      let height = 600;
      if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        width = buf.readUInt32BE(16);
        height = buf.readUInt32BE(20);
      }
      return {
        getSize: () => (buf.length === 0 ? { width: 0, height: 0 } : { width, height }),
        isEmpty: () => buf.length === 0,
        getBitmap: () => (buf.length === 0 ? null : (bitmapByBuffer.get(buf) ?? Buffer.alloc(width * height * 4))),
      };
    },
  },
});

before(() => {
  if (!electronEntry) {
    require(electronResolved);
    electronEntry = require.cache[electronResolved];
  }
  if (electronEntry) {
    electronExportsBackup = electronEntry.exports;
    electronEntry.exports = fakeNativeImageFactory();
  }
});

after(() => {
  if (electronEntry && electronExportsBackup !== undefined) {
    electronEntry.exports = electronExportsBackup;
  }
});

describe('visualCompare fail-closed mask ledger & normalization transaction', () => {
  it('V-11: normalizeScroll style is injected before capture and verified-removed after success', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      {
        comparisonTabId: 'tab-b',
        normalizeScroll: true,
        maskSelectors: ['.badge'],
        tolerance: 5,
      }
    );

    assert.strictEqual(result.match, true, 'identical bitmaps must match');
    assert.strictEqual((result.maskResolution as any).status, 'ok');

    // Normalization: inject first, restore last — no leftovers. The filters are
    // scoped to the normalizeScroll style script: the reversible-normalization
    // transaction also contains `el.removeAttribute`.
    const injects = evalLog.filter((e) => e.script.includes('__antifan_normalize_scroll') && e.script.includes('appendChild'));
    const restores = evalLog.filter((e) => e.script.includes('__antifan_normalize_scroll') && e.script.includes('el.remove()'));
    assert.strictEqual(injects.length, 2, 'one inject per side');
    assert.strictEqual(restores.length, 2, 'one verified restore per side');
    assert.deepEqual(new Set(injects.map((e) => e.tabId)), new Set(['tab-a', 'tab-b']));
    assert.deepEqual(new Set(restores.map((e) => e.tabId)), new Set(['tab-a', 'tab-b']));

    const captureIndex = evalLog.findIndex((e) => e.script === ''); // no captures logged; injects must precede restores
    void captureIndex;
    const firstInject = evalLog.findIndex((e) => e.script.includes('__antifan_normalize_scroll') && e.script.includes('appendChild'));
    const firstRestore = evalLog.findIndex((e) => e.script.includes('__antifan_normalize_scroll') && e.script.includes('el.remove()'));
    assert.ok(firstInject >= 0 && firstRestore > firstInject, 'restore must run after inject');
    assert.ok(evalLog.every((e, idx) => !e.script.includes('el.remove()') || idx > firstInject));

    // Receipt: immutable per-side fields all settled.
    const norm = (result.normalization as any);
    assert.deepEqual(norm.target, {
      requested: true,
      injected: true,
      owned: true,
      restored: true,
    });
    assert.deepEqual(norm.comparison, {
      requested: true,
      injected: true,
      owned: true,
      restored: true,
    });

    // Mask ledger: per-side entries resolved with a sane ratio.
    const mask = (result.maskResolution as any);
    assert.strictEqual(mask.target.entries.length, DEFAULT_STOREFRONT_WIDGETS.length + 1, 'exactly defaults + user mask');
    assert.strictEqual(mask.target.entries[0].selector, '.badge');
    assert.strictEqual(mask.target.entries[0].status, 'resolved');
    assert.strictEqual(mask.target.entries[0].required, true);
    assert.strictEqual(mask.target.entries.some((e: any) => e.selector === 'iframe[id]'), false, 'broad iframe[id] must be excluded when user masks present');
    // Assert full status and requiredness across all default widgets on both sides
    for (let i = 1; i <= DEFAULT_STOREFRONT_WIDGETS.length; i++) {
      const targetEntry = mask.target.entries[i];
      const baselineEntry = mask.baseline.entries[i];
      const expectedSelector = DEFAULT_STOREFRONT_WIDGETS[i - 1];
      assert.strictEqual(targetEntry.selector, expectedSelector);
      assert.strictEqual(targetEntry.required, false, 'Default storefront widgets must be optional');
      assert.strictEqual(baselineEntry.selector, expectedSelector);
      assert.strictEqual(baselineEntry.required, false, 'Default storefront widgets must be optional');
    }
    assert.ok(mask.target.maskedAreaRatio > 0 && mask.target.maskedAreaRatio < 0.1);
    assert.ok(mask.baseline, 'comparison side receipt must exist');
    assert.strictEqual(mask.baseline.entries.length, DEFAULT_STOREFRONT_WIDGETS.length + 1);
  });

  it('V-12: cleanup runs (verified restore) when capture throws', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog, captureThrowsFor: 'tab-a' });
    const port = createRoutePort(host as any);

    await assert.rejects(
      () =>
        port.visualCompare(dummyTarget, 'run-1', 'att-1', {
          comparisonTabId: 'tab-b',
          normalizeScroll: true,
          maskSelectors: ['.badge'],
        }),
      (err: unknown) => err instanceof Error && err.message.includes('simulated capture failure')
    );

    const restores = evalLog.filter((e) => e.script.includes('__antifan_normalize_scroll') && e.script.includes('el.remove()') && e.tabId === 'tab-a');
    assert.strictEqual(restores.length, 1, 'finally must restore the owned style after an exception');
  });

  it('V-01: required mask zero-match returns MASK_RESOLUTION_FAILED, never match:true', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      maskRows: () => [{ selector: '.never-present', error: null, boxes: [] }],
    });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      { comparisonTabId: 'tab-b', maskSelectors: ['.never-present'] }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'MASK_RESOLUTION_FAILED');
    assert.strictEqual(result.match, false);
    assert.strictEqual((result.maskResolution as any).status, 'MASK_RESOLUTION_FAILED');
    assert.ok(String(result.reason).includes('.never-present'));
    const coh = (result as any).coherence;
    assert.strictEqual(coh.identityCoherent, false);
    assert.strictEqual(coh.captureStateCompatible, false);
    assert.strictEqual(coh.resampleCount, 0);
  });

  it('optional zero-match records optionalUnmatched without failing the compare', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      maskRows: () => [
        { selector: '.badge', error: null, boxes: [{ x: 100, y: 100, width: 50, height: 50 }] },
        { selector: '.maybe-gone', error: null, boxes: [] },
      ],
    });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      {
        comparisonTabId: 'tab-b',
        maskSelectors: ['.badge'],
        maskOptionalSelectors: ['.maybe-gone'],
      }
    );

    assert.strictEqual(result.match, true);
    // Both sides report absent optional masks deterministically:
    // mock maskRows returns boxes for .badge and empty boxes for .maybe-gone.
    // All defaultStorefrontWidgets are also absent in maskRows (empty), so each side reports [.maybe-gone, ...DEFAULT_STOREFRONT_WIDGETS].
    const expectedPerSide = ['.maybe-gone', ...DEFAULT_STOREFRONT_WIDGETS];
    const expectedAll = [...expectedPerSide, ...expectedPerSide];
    const unmatched = (result.maskResolution as any).optionalUnmatched as string[];
    assert.deepEqual(unmatched, expectedAll, 'optionalUnmatched must exactly match user optional plus default storefront widgets across both sides');
    assert.strictEqual((result.maskResolution as any).status, 'ok');
  });

  it('owned style that fails verified restore returns NORMALIZATION_RESTORE_FAILED, not a clean run', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog, restoreFailsFor: new Set(['tab-a']) });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      { comparisonTabId: 'tab-b', normalizeScroll: true, maskSelectors: ['.badge'] }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'NORMALIZATION_RESTORE_FAILED');
    assert.strictEqual(result.match, false);
    assert.ok(String(result.reason).includes('still present'));
    const norm = (result.normalization as any);
    assert.strictEqual(norm.target.owned, true);
    assert.strictEqual(norm.target.restored, false);
    assert.ok(norm.target.restoreError && norm.target.restoreError.includes('still present'));
    assert.ok((result as any).coherence);
    assert.strictEqual((result as any).coherence.identityCoherent, true);
  });

  it('maskOptionalSelectors is additive in both capability schemas (R3 contract)', () => {
    const catalogue = new CapabilityCatalogue({
      runtime: { allowEval: true } as any,
      projectId: 'test',
      workspaceId: 'test',
      runtimeId: 'test',
    });
    const mockPort = {} as unknown as BrowserControlPort;
    registerBrowserCapabilities(catalogue, mockPort);

    for (const name of ['browser.visual_compare', 'anti.visual.compare']) {
      const cap = catalogue.get(name);
      assert.ok(cap, `${name} must be registered`);
      const props = (cap?.inputSchema as any)?.properties;
      assert.ok(props?.maskSelectors, `${name} keeps maskSelectors`);
      assert.ok(props?.maskOptionalSelectors, `${name} must expose additive maskOptionalSelectors`);
    }
  });
});

describe('computePixelDiff mask bounds are half-open (exclusive right/bottom edges)', () => {
  const W = 800;
  const H = 600;
  const mkBitmap = (pixels: Array<[number, number]>): Buffer => {
    const buf = Buffer.alloc(W * H * 4);
    for (const [px, py] of pixels) {
      const idx = (py * W + px) * 4;
      buf[idx] = 255;
      buf[idx + 3] = 255;
    }
    return buf;
  };

  it('a diff pixel exactly at the mask right edge counts (not silently excluded)', () => {
    const a = mkBitmap([[4, 0]]);
    const b = mkBitmap([]);
    bitmapByBuffer.set(a, a);
    bitmapByBuffer.set(b, b);
    const diff = computePixelDiff(a, b, 5, [{ x: 0, y: 0, width: 4, height: 4 }]);
    assert.strictEqual(diff.diffPixels, 1);
    assert.strictEqual(diff.match, true);
  });

  it('masked pixels are excluded while the bottom-edge neighbor still counts', () => {
    const a = mkBitmap([[0, 0], [2, 2], [0, 4]]);
    const b = mkBitmap([]);
    bitmapByBuffer.set(a, a);
    bitmapByBuffer.set(b, b);
    const diff = computePixelDiff(a, b, 5, [{ x: 0, y: 0, width: 4, height: 4 }]);
    // (0,0) and (2,2) are inside the mask; (0,4) is on the bottom edge -> counts.
    assert.strictEqual(diff.diffPixels, 1);
  });
});

describe('visualCompare capture coherence transaction', () => {
  it('resamples when DOM mutation occurs during capture, settling with a coherence receipt', async () => {
    const evalLog: EvalLogEntry[] = [];
    let revA = 1;
    let bumped = false;
    const host = buildMockHost({
      evalLog,
      mutationRevFor: (t) => (t === 'tab-a' ? revA : 1),
      onCapture: (t) => {
        if (t === 'tab-a' && !bumped) {
          bumped = true;
          revA += 1;
        }
      },
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;
    assert.strictEqual(res.match, true);
    assert.strictEqual(res.coherence.identityCoherent, true);
    assert.strictEqual(res.coherence.captureStateCompatible, true);
    assert.strictEqual(res.coherence.resampleCount, 1);
    // Both attempts injected and restored normalization on both tabs (per-attempt cleanup).
    const injectCount = evalLog.filter((e) => e.script.includes('createElement')).length;
    const restoreCount = evalLog.filter((e) => e.script.includes('__antifan_normalize_scroll') && e.script.includes('el.remove()')).length;
    assert.strictEqual(injectCount, 4);
    assert.strictEqual(restoreCount, 4);
  });

  it('settles INCONCLUSIVE without a diff when capture mutation never coheres within retry limit', async () => {
    const evalLog: EvalLogEntry[] = [];
    let revA = 1;
    const host = buildMockHost({
      evalLog,
      mutationRevFor: (t) => (t === 'tab-a' ? revA : 1),
      onCapture: (t) => {
        if (t === 'tab-a') revA += 1;
      },
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b' })) as any;
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.coherence.resampleCount, 2);
    assert.strictEqual(res.match, false);
    assert.strictEqual('diffPixels' in res, false);
  });

  it('fails closed with TARGET_STALE when document generation advances mid-transaction', async () => {
    const evalLog: EvalLogEntry[] = [];
    let genA = 1;
    const host = buildMockHost({
      evalLog,
      docGenFor: (t) => (t === 'tab-a' ? genA : 1),
      onCapture: (t) => {
        if (t === 'tab-a') genA = 2;
      },
    });
    const port = createRoutePort(host as any);
    await assert.rejects(
      port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });

  it('cancels the pixel diff with INCONCLUSIVE when comparison-side normalization fails to inject', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog, injectThrowsFor: new Set(['tab-b']) });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual('diffPixels' in res, false);
    assert.strictEqual(res.coherence.identityCoherent, true);
    assert.strictEqual(res.coherence.captureStateCompatible, false);
    assert.strictEqual(res.maskResolution.status, 'NORMALIZATION_ASYMMETRIC');
    assert.ok(res.normalization.comparison.injectError);
  });

  it('settles INCONCLUSIVE when pre-existing unowned comparison style leaves CSS unverified', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      injectResultFor: (t) => (t === 'tab-b' ? { owned: false, present: true } : true),
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.normalization.comparison.owned, false);
    assert.strictEqual(res.normalization.comparison.injected, true);
    assert.strictEqual(res.coherence.captureStateCompatible, false);
    assert.strictEqual('diffPixels' in res, false);
  });

  it('carries identityCoherent receipts for both sides on settled comparison', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;
    assert.strictEqual(res.coherence.identityCoherent, true);
    assert.strictEqual(res.coherence.captureStateCompatible, true);
    assert.strictEqual(res.coherence.resampleCount, 0);
    assert.strictEqual(res.coherence.target.identity, 'COHERENT');
    assert.strictEqual(res.coherence.baseline.identity, 'COHERENT');
    assert.strictEqual(res.coherence.target.afterCapture.mutationRevision, 1);
    assert.strictEqual(res.coherence.baseline.afterCapture.mutationRevision, 1);
  });
});

describe('visualCompare pair lock serializes capture transactions', () => {
  it('two concurrent compares on the same tab pair serialize inject/restore transactions', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);
    const [a, b] = await Promise.all([
      port.visualCompare(dummyTarget, 'run1', 'att1', { comparisonTabId: 'tab-b', normalizeScroll: true }),
      port.visualCompare(dummyTarget, 'run2', 'att2', { comparisonTabId: 'tab-b', normalizeScroll: true }),
    ]);
    assert.strictEqual((a as any).match, true);
    assert.strictEqual((b as any).match, true);
    // A serialized job emits target-inject, comp-inject, then both restores as one
    // contiguous block. Without the pair lock the two jobs interleave instead.
    const normEvents = evalLog
      .filter((e) => e.script.includes('__antifan_normalize_scroll'))
      .map((e) => (e.script.includes('createElement') ? 'inject' : 'restore'));
    assert.deepStrictEqual(normEvents, ['inject', 'inject', 'restore', 'restore', 'inject', 'inject', 'restore', 'restore']);
  });
});

describe('visualCompare canonical capture receipts (Phase 3 V-19, V-20, V-21)', () => {
  it('fails closed with CAPABILITY_NOT_FOUND when host lacks captureVerificationScreenshot', async () => {
    const hostWithoutVerif = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-a' }],
      captureScreenshot: async () => 'dGVzdA==',
      evalJs: async (script: string) => {
        if (script.includes('img.decode')) return { settled: true, brokenImages: [] };
        return true;
      },
      getNetworkTracker: () => ({
        isAttached: () => true,
        awaitQuiescence: async () => ({ settled: true, durationMs: 0, timedOut: false }),
      }),
    };
    const port = new BrowserControlPort(hostWithoutVerif as any);
    await assert.rejects(
      () => port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_NOT_FOUND'
    );
  });

  it('projects canonical CDP backend capture receipts across settled result (V-19)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;

    assert.strictEqual(res.match, true);
    assert.strictEqual(res.captureStateCompatible, true);
    assert.ok(res.captureReceipts, 'captureReceipts must be present');
    assert.strictEqual(res.captureReceipts.target.backend, 'cdp');
    assert.strictEqual(res.captureReceipts.baseline.backend, 'cdp');
    assert.strictEqual(res.captureReceipts.target.dpr, 1);
    assert.strictEqual(res.captureReceipts.baseline.dpr, 1);
    assert.strictEqual(res.captureReceipts.target.zoom, 1.0);
    assert.strictEqual(res.captureReceipts.baseline.zoom, 1.0);
    assert.deepStrictEqual(res.captureReceipts.target.cssViewport, { width: 800, height: 600 });
    assert.deepStrictEqual(res.captureReceipts.baseline.cssViewport, { width: 800, height: 600 });
    assert.deepStrictEqual(res.captureReceipts.target.rasterSize, { width: 800, height: 600 });
    assert.deepStrictEqual(res.captureReceipts.baseline.rasterSize, { width: 800, height: 600 });
  });

  it('throws CAPTURE_BACKEND_SWITCH when backend changes between target and baseline (V-20)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      captureBackendFor: (id) => (id === 'tab-a' ? 'cdp' : 'offscreen'),
    });
    const port = createRoutePort(host as any);
    await assert.rejects(
      () => port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPTURE_BACKEND_SWITCH'
    );
  });

  it('settles INCONCLUSIVE when DPR differs between target and baseline (V-21)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      dprFor: (id) => (id === 'tab-a' ? 1.0 : 2.0),
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.captureStateCompatible, false);
    assert.strictEqual(res.maskResolution.status, 'ok');
    assert.ok(res.reason.includes('Device pixel ratio mismatch'));
    assert.strictEqual(res.captureReceipts.target.dpr, 1.0);
    assert.strictEqual(res.captureReceipts.baseline.dpr, 2.0);
  });

  it('settles INCONCLUSIVE when zoom differs between target and baseline (V-21)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      zoomFor: (id) => (id === 'tab-a' ? 1.0 : 1.25),
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.captureStateCompatible, false);
    assert.ok(res.reason.includes('Zoom level mismatch'));
  });

  it('settles INCONCLUSIVE when CSS viewport differs between target and baseline (V-21)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      viewportFor: (id) => (id === 'tab-a' ? { width: 800, height: 600 } : { width: 1024, height: 768 }),
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.captureStateCompatible, false);
    assert.ok(res.reason.includes('CSS viewport dimension mismatch'));
  });

  it('settles INCONCLUSIVE for stored baseline artifact pending Phase 6 baseline authority (R3/R4)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { baselineScreenshotRef: 'art-stored-1' })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.captureStateCompatible, false);
    assert.strictEqual(res.maskResolution.status, 'ok');
    assert.ok(res.reason.includes('pending Phase 6 baseline authority certification'));
  });
});

describe('visualCompare composed settle barrier (Phase 4 V-16, V-17, V-18)', () => {
  it('enforces execution order: normalization -> settle -> metrics -> masks -> capture', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
      maskSelectors: ['.badge'],
    })) as any;

    assert.strictEqual(res.match, true);
    assert.strictEqual(res.settle?.target?.settleComplete, true);
    assert.strictEqual(res.settle?.comparison?.settleComplete, true);

    // Verify ordering in evalLog for target side
    const targetEvals = evalLog.filter((e) => e.tabId === 'tab-a');
    const normIdx = targetEvals.findIndex((e) => e.script.includes('__antifan_normalize_scroll'));
    const fontIdx = targetEvals.findIndex((e) => e.script.includes('document.fonts.ready'));
    const imgIdx = targetEvals.findIndex((e) => e.script.includes('img.decode'));
    const domIdx = targetEvals.findIndex((e) => e.script.includes('requestAnimationFrame'));
    const metricsIdx = targetEvals.findIndex((e) => e.script.includes('documentElement.clientWidth'));
    const maskIdx = targetEvals.findIndex((e) => e.script.includes('const selectors ='));

    assert.ok(normIdx >= 0, 'normalization must run');
    assert.ok(fontIdx > normIdx, 'settle (fonts) must run after normalization');
    assert.ok(imgIdx > normIdx, 'settle (images) must run after normalization');
    assert.ok(domIdx > normIdx, 'settle (DOM) must run after normalization');
    assert.ok(metricsIdx > fontIdx && metricsIdx > imgIdx && metricsIdx > domIdx, 'metrics must run after settle');
    assert.ok(maskIdx > metricsIdx, 'masks must resolve after metrics');
  });

  it('settles INCONCLUSIVE when target fonts fail to settle (V-16)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      fontsReadyFor: (id) => id !== 'tab-a',
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
    })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.settle?.target?.settleComplete, false);
    assert.strictEqual(res.settle?.target?.gates?.fonts, false);
    assert.ok(res.reason.includes('Visual capture settle barrier incomplete'));
  });

  it('settles INCONCLUSIVE when target images fail to decode/settle (V-17)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      imagesSettledFor: (id) => id !== 'tab-a',
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
    })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.settle?.target?.settleComplete, false);
    assert.strictEqual(res.settle?.target?.gates?.images, false);
    assert.ok(res.reason.includes('Visual capture settle barrier incomplete'));
  });

  it('throws RESOURCE_FAILURE when broken images are detected in comparison tab (V-18)', async () => {
    const evalLog: EvalLogEntry[] = [];
    const missingImg = 'https://cdn.example.com/asset-404.png';
    const host = buildMockHost({
      evalLog,
      brokenImagesFor: (id) => (id === 'tab-b' ? [missingImg] : []),
    });
    const port = createRoutePort(host as any);

    await assert.rejects(
      async () => {
        await port.visualCompare(dummyTarget, 'run', 'att', {
          comparisonTabId: 'tab-b',
          normalizeScroll: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'RESOURCE_FAILURE');
        assert.ok((err as CapabilityError).message.includes(missingImg));
        return true;
      }
    );
  });

  it('settles INCONCLUSIVE when network tracker fails or times out', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      networkSettledFor: (id) => id !== 'tab-a',
    });
    const port = createRoutePort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
    })) as any;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.strictEqual(res.settle?.target?.gates?.network, false);
  });
});

describe('visualCompare evaluator structural primacy & receipts (Phase 5 R1, R2, R3)', () => {
  it('returns canonical metricSamples and receipt conforming to VisualEvidenceReceipt on successful comparison', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-5', 'att-5', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
      maskSelectors: ['.badge'],
    })) as any;

    assert.strictEqual(res.match, true);
    assert.ok(Array.isArray(res.metricSamples), 'Must return metricSamples array');
    assert.ok(res.receipt, 'Must return receipt object');
    assert.strictEqual(res.receipt.match, true);
    assert.strictEqual(res.receipt.captureStateCompatible, true);
    assert.strictEqual(res.receipt.settleComplete, true);
    assert.strictEqual(res.receipt.maskResolutionStatus, 'ok');

    const metrics = res.metricSamples.map((s: any) => s.metric);
    assert.ok(metrics.includes('visual.pixel_mismatch_pct'));
    assert.ok(metrics.includes('visual.dimensions_match'));
    assert.ok(metrics.includes('visual.capture_state_compatible'));
    assert.ok(metrics.includes('visual.mask_resolution_complete'));
    assert.ok(metrics.includes('visual.settle_complete'));
  });

  it('computes structural metrics (geometry and cardinality) via normalizeVisualRegions & computeStructuralMetrics', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      evalJsOverride: async (script: string, tabId?: string) => {
        if (script.includes('root.children')) {
          if (tabId === 'tab-a') {
            // Target tab: 3 items, shifted by +100px (V-09 and V-10 combined scenario)
            return [
              { ref: 'e0', tag: 'div', selector: '.grid', rect: { x: 0, y: 100, width: 800, height: 200, top: 100, right: 800, bottom: 300, left: 0 }, visible: true },
              { ref: 'e1', tag: 'div', selector: '.item-1', rect: { x: 0, y: 100, width: 200, height: 100, top: 100, right: 200, bottom: 200, left: 0 }, visible: true },
              { ref: 'e2', tag: 'div', selector: '.item-2', rect: { x: 200, y: 100, width: 200, height: 100, top: 100, right: 400, bottom: 200, left: 200 }, visible: true },
              { ref: 'e3', tag: 'div', selector: '.item-3', rect: { x: 400, y: 100, width: 200, height: 100, top: 100, right: 600, bottom: 200, left: 400 }, visible: true },
            ];
          } else if (tabId === 'tab-b') {
            // Baseline tab: 4 items at y: 0
            return [
              { ref: 'b0', tag: 'div', selector: '.grid', rect: { x: 0, y: 0, width: 800, height: 200, top: 0, right: 800, bottom: 200, left: 0 }, visible: true },
              { ref: 'b1', tag: 'div', selector: '.item-1', rect: { x: 0, y: 0, width: 200, height: 100, top: 0, right: 200, bottom: 100, left: 0 }, visible: true },
              { ref: 'b2', tag: 'div', selector: '.item-2', rect: { x: 200, y: 0, width: 200, height: 100, top: 0, right: 400, bottom: 100, left: 200 }, visible: true },
              { ref: 'b3', tag: 'div', selector: '.item-3', rect: { x: 400, y: 0, width: 200, height: 100, top: 0, right: 600, bottom: 100, left: 400 }, visible: true },
              { ref: 'b4', tag: 'div', selector: '.item-4', rect: { x: 600, y: 0, width: 200, height: 100, top: 0, right: 800, bottom: 100, left: 600 }, visible: true },
            ];
          }
        }
        return true;
      },
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-struct', 'att-struct', {
      comparisonTabId: 'tab-b',
      selector: '.grid',
      normalizeScroll: true,
    })) as any;
    assert.ok(res.metricSamples, 'Must emit metricSamples');
    const geomSample = res.metricSamples.find((s: any) => s.metric === 'visual.geometry_within_tolerance');
    assert.ok(geomSample, 'Must include visual.geometry_within_tolerance');
    assert.strictEqual(geomSample.passed, false);
    assert.strictEqual(geomSample.delta, 100);

    const cardSample = res.metricSamples.find((s: any) => s.metric === 'visual.cardinality_match');
    assert.ok(cardSample, 'Must include visual.cardinality_match');
    assert.strictEqual(cardSample.passed, false);
    assert.strictEqual(cardSample.delta, 1);

    assert.ok(res.structural, 'Must return structural metrics on result');
    assert.strictEqual(res.structural.geometryWithinTolerance, false);
    assert.strictEqual(res.structural.cardinalityMatch, false);
    assert.ok(res.structural.groups, 'Must preserve groups in structural metrics');
    assert.strictEqual(res.structural.groups['.grid']?.cardinalityMatch, true);
    assert.strictEqual(res.structural.groups['.item-4']?.cardinalityMatch, false);
    assert.strictEqual(res.structural.groups['.item-4']?.skippedForCardinalityMismatch, true);
  });

  it('P0.4 contract: visualCompare respects trackedSelectors scope, isolating Product Grid from untracked header/footer mutations', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      evalJsOverride: async (script: string, tabId?: string) => {
        if (script.includes('root.children')) {
          if (tabId === 'tab-a') {
            // Target tab: 4 product cards (preserved layout) + 2 headers (+1 untracked) + 3 footers (+2 untracked)
            return [
              { ref: 't-h1', tag: 'header', selector: '.site-header', rect: { x: 0, y: 0, width: 1200, height: 60, top: 0, right: 1200, bottom: 60, left: 0 }, visible: true },
              { ref: 't-h2', tag: 'header', selector: '.site-header', rect: { x: 0, y: 60, width: 1200, height: 20, top: 60, right: 1200, bottom: 80, left: 0 }, visible: true },
              { ref: 't-f1', tag: 'footer', selector: '.site-footer', rect: { x: 0, y: 800, width: 1200, height: 50, top: 800, right: 1200, bottom: 850, left: 0 }, visible: true },
              { ref: 't-f2', tag: 'footer', selector: '.site-footer', rect: { x: 0, y: 850, width: 1200, height: 50, top: 850, right: 1200, bottom: 900, left: 0 }, visible: true },
              { ref: 't-f3', tag: 'footer', selector: '.site-footer', rect: { x: 0, y: 900, width: 1200, height: 50, top: 900, right: 1200, bottom: 950, left: 0 }, visible: true },
              { ref: 't-c0', tag: 'div', selector: '.product-card', rect: { x: 0, y: 100, width: 280, height: 350, top: 100, right: 280, bottom: 450, left: 0 }, visible: true },
              { ref: 't-c1', tag: 'div', selector: '.product-card', rect: { x: 300, y: 100, width: 280, height: 350, top: 100, right: 580, bottom: 450, left: 300 }, visible: true },
              { ref: 't-c2', tag: 'div', selector: '.product-card', rect: { x: 600, y: 100, width: 280, height: 350, top: 100, right: 880, bottom: 450, left: 600 }, visible: true },
              { ref: 't-c3', tag: 'div', selector: '.product-card', rect: { x: 900, y: 100, width: 280, height: 350, top: 100, right: 1180, bottom: 450, left: 900 }, visible: true },
            ];
          } else if (tabId === 'tab-b') {
            // Baseline tab: 4 product cards + 1 header + 1 footer
            return [
              { ref: 'b-h1', tag: 'header', selector: '.site-header', rect: { x: 0, y: 0, width: 1200, height: 60, top: 0, right: 1200, bottom: 60, left: 0 }, visible: true },
              { ref: 'b-f1', tag: 'footer', selector: '.site-footer', rect: { x: 0, y: 800, width: 1200, height: 50, top: 800, right: 1200, bottom: 850, left: 0 }, visible: true },
              { ref: 'b-c0', tag: 'div', selector: '.product-card', rect: { x: 0, y: 100, width: 280, height: 350, top: 100, right: 280, bottom: 450, left: 0 }, visible: true },
              { ref: 'b-c1', tag: 'div', selector: '.product-card', rect: { x: 300, y: 100, width: 280, height: 350, top: 100, right: 580, bottom: 450, left: 300 }, visible: true },
              { ref: 'b-c2', tag: 'div', selector: '.product-card', rect: { x: 600, y: 100, width: 280, height: 350, top: 100, right: 880, bottom: 450, left: 600 }, visible: true },
              { ref: 'b-c3', tag: 'div', selector: '.product-card', rect: { x: 900, y: 100, width: 280, height: 350, top: 100, right: 1180, bottom: 450, left: 900 }, visible: true },
            ];
          }
        }
        return true;
      },
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-p4-iso', 'att-p4-iso', {
      comparisonTabId: 'tab-b',
      trackedSelectors: ['.product-card'],
      normalizeScroll: true,
    })) as any;

    assert.ok(res.metricSamples, 'Must emit metricSamples');
    const geomSample = res.metricSamples.find((s: any) => s.metric === 'visual.geometry_within_tolerance');
    assert.ok(geomSample);
    assert.strictEqual(geomSample.passed, true);
    assert.strictEqual(geomSample.delta, 0);

    const cardSample = res.metricSamples.find((s: any) => s.metric === 'visual.cardinality_match');
    assert.ok(cardSample);
    assert.strictEqual(cardSample.passed, true, 'Product grid cardinality must pass despite untracked header/footer changes');
    assert.strictEqual(cardSample.delta, 0);
  });

  it('P0.4 contract: Controlled Mutation A (text wrap breaks height) -> geometry drift detected, fails tolerance', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      evalJsOverride: async (script: string, tabId?: string) => {
        if (script.includes('root.children')) {
          if (tabId === 'tab-a') {
            // Target tab: Card 1 height expanded from 350px to 430px (+80px height drift from 5-line title)
            return [
              { ref: 't-c0', tag: 'div', selector: '.product-card', rect: { x: 0, y: 100, width: 280, height: 430, top: 100, right: 280, bottom: 530, left: 0 }, visible: true },
              { ref: 't-c1', tag: 'div', selector: '.product-card', rect: { x: 300, y: 100, width: 280, height: 350, top: 100, right: 580, bottom: 450, left: 300 }, visible: true },
              { ref: 't-c2', tag: 'div', selector: '.product-card', rect: { x: 600, y: 100, width: 280, height: 350, top: 100, right: 880, bottom: 450, left: 600 }, visible: true },
              { ref: 't-c3', tag: 'div', selector: '.product-card', rect: { x: 900, y: 100, width: 280, height: 350, top: 100, right: 1180, bottom: 450, left: 900 }, visible: true },
            ];
          } else if (tabId === 'tab-b') {
            // Baseline tab: 4 product cards at standard 350px height
            return [
              { ref: 'b-c0', tag: 'div', selector: '.product-card', rect: { x: 0, y: 100, width: 280, height: 350, top: 100, right: 280, bottom: 450, left: 0 }, visible: true },
              { ref: 'b-c1', tag: 'div', selector: '.product-card', rect: { x: 300, y: 100, width: 280, height: 350, top: 100, right: 580, bottom: 450, left: 300 }, visible: true },
              { ref: 'b-c2', tag: 'div', selector: '.product-card', rect: { x: 600, y: 100, width: 280, height: 350, top: 100, right: 880, bottom: 450, left: 600 }, visible: true },
              { ref: 'b-c3', tag: 'div', selector: '.product-card', rect: { x: 900, y: 100, width: 280, height: 350, top: 100, right: 1180, bottom: 450, left: 900 }, visible: true },
            ];
          }
        }
        return true;
      },
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-p4-mutA', 'att-p4-mutA', {
      comparisonTabId: 'tab-b',
      trackedSelectors: ['.product-card'],
      normalizeScroll: true,
    })) as any;

    assert.ok(res.metricSamples);
    const geomSample = res.metricSamples.find((s: any) => s.metric === 'visual.geometry_within_tolerance');
    assert.ok(geomSample);
    assert.strictEqual(geomSample.passed, false, 'Mutation A must fail geometry tolerance due to +80px card expansion');
    assert.strictEqual(geomSample.delta, 80);

    const cardSample = res.metricSamples.find((s: any) => s.metric === 'visual.cardinality_match');
    assert.ok(cardSample);
    assert.strictEqual(cardSample.passed, true);
    assert.strictEqual(cardSample.delta, 0);
  });

  it('P0.4 contract: Controlled Mutation B (content variation with preserved structure) -> verified with geometry and cardinality match', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      evalJsOverride: async (script: string, tabId?: string) => {
        if (script.includes('root.children')) {
          // Both baseline and target have identical 4 cards geometry (price/title text changed but box fits perfectly)
          return [
            { ref: 'c0', tag: 'div', selector: '.product-card', rect: { x: 0, y: 100, width: 280, height: 350, top: 100, right: 280, bottom: 450, left: 0 }, visible: true },
            { ref: 'c1', tag: 'div', selector: '.product-card', rect: { x: 300, y: 100, width: 280, height: 350, top: 100, right: 580, bottom: 450, left: 300 }, visible: true },
            { ref: 'c2', tag: 'div', selector: '.product-card', rect: { x: 600, y: 100, width: 280, height: 350, top: 100, right: 880, bottom: 450, left: 600 }, visible: true },
            { ref: 'c3', tag: 'div', selector: '.product-card', rect: { x: 900, y: 100, width: 280, height: 350, top: 100, right: 1180, bottom: 450, left: 900 }, visible: true },
          ];
        }
        return true;
      },
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-p4-mutB', 'att-p4-mutB', {
      comparisonTabId: 'tab-b',
      trackedSelectors: ['.product-card'],
      normalizeScroll: true,
    })) as any;

    assert.ok(res.metricSamples);
    const geomSample = res.metricSamples.find((s: any) => s.metric === 'visual.geometry_within_tolerance');
    assert.ok(geomSample);
    assert.strictEqual(geomSample.passed, true, 'Mutation B must pass geometry tolerance');
    assert.strictEqual(geomSample.delta, 0);

    const cardSample = res.metricSamples.find((s: any) => s.metric === 'visual.cardinality_match');
    assert.ok(cardSample);
    assert.strictEqual(cardSample.passed, true, 'Mutation B must pass cardinality match');
    assert.strictEqual(cardSample.delta, 0);
  });

  it('emits receipt and metricSamples on settle-incomplete failure', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      fontsReadyFor: () => false,
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-settle-fail', 'att-1', {
      comparisonTabId: 'tab-b',
      // No masks requested: the implicit default widget set would otherwise
      // report NOT_ATTEMPTED because the settle barrier aborts before masking.
      useDefaultWidgetMasks: false,
    })) as any;

    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.ok(res.receipt, 'Must emit receipt on settle-incomplete');
    assert.strictEqual(res.receipt.settleComplete, false);
    assert.strictEqual(res.receipt.maskResolutionStatus, 'ok');
    assert.ok(Array.isArray(res.metricSamples), 'Must emit metricSamples');
    const settleSample = res.metricSamples.find((s: any) => s.metric === 'visual.settle_complete');
    assert.ok(settleSample);
    assert.strictEqual(settleSample.passed, false);
    const maskSample = res.metricSamples.find((s: any) => s.metric === 'visual.mask_resolution_complete');
    assert.ok(maskSample);
    assert.strictEqual(maskSample.passed, true);
  });

  it('fails closed with NOT_ATTEMPTED when settle fails while masks are requested', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      fontsReadyFor: () => false,
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-settle-mask-fail', 'att-1', {
      comparisonTabId: 'tab-b',
      maskSelectors: ['.header-ad'],
    })) as any;

    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.ok(res.receipt, 'Must emit receipt on settle-incomplete');
    assert.strictEqual(res.receipt.settleComplete, false);
    assert.strictEqual(res.receipt.maskResolutionStatus, 'NOT_ATTEMPTED');
    assert.strictEqual(res.maskResolution.status, 'NOT_ATTEMPTED');
    assert.ok(Array.isArray(res.metricSamples), 'Must emit metricSamples');
    const maskSample = res.metricSamples.find((s: any) => s.metric === 'visual.mask_resolution_complete');
    assert.ok(maskSample);
    assert.strictEqual(maskSample.passed, false);
    assert.strictEqual(maskSample.value, false);
  });

  it('emits receipt and metricSamples on capture state mismatch', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      dprFor: (id) => (id === 'tab-a' ? 2 : 1),
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-mismatch', 'att-2', {
      comparisonTabId: 'tab-b',
    })) as any;

    assert.strictEqual(res.status, 'INCONCLUSIVE');
    assert.ok(res.receipt, 'Must emit receipt on capture state mismatch');
    assert.strictEqual(res.receipt.captureStateCompatible, false);
    assert.strictEqual(res.receipt.maskResolutionStatus, 'ok');
    const compatSample = res.metricSamples.find((s: any) => s.metric === 'visual.capture_state_compatible');
    assert.ok(compatSample);
    assert.strictEqual(compatSample.passed, false);
    const maskSample = res.metricSamples.find((s: any) => s.metric === 'visual.mask_resolution_complete');
    assert.ok(maskSample);
    assert.strictEqual(maskSample.passed, true);
  });

  it('emits receipt and metricSamples on mask resolution failure', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      maskRows: () => [{ selector: '.missing', error: null, boxes: [] }],
    });
    const port = createRoutePort(host as any);

    const res = (await port.visualCompare(dummyTarget, 'run-mask-fail', 'att-3', {
      comparisonTabId: 'tab-b',
      maskSelectors: ['.missing'],
    })) as any;

    assert.strictEqual(res.status, 'MASK_RESOLUTION_FAILED');
    assert.ok(res.receipt, 'Must emit receipt on mask resolution failure');
    assert.strictEqual(res.receipt.maskResolutionStatus, 'MASK_RESOLUTION_FAILED');
    const maskSample = res.metricSamples.find((s: any) => s.metric === 'visual.mask_resolution_complete');
    assert.ok(maskSample);
    assert.strictEqual(maskSample.passed, false);
  });

  it('decorates thrown CapabilityError with receipt and metricSamples', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      brokenImagesFor: () => ['https://cdn.example.com/broken.jpg'],
    });
    const port = createRoutePort(host as any);

    await assert.rejects(
      async () => {
        await port.visualCompare(dummyTarget, 'run-err', 'att-4', {
          comparisonTabId: 'tab-b',
          // No masks requested: the implicit default widget set would otherwise
          // report NOT_ATTEMPTED because settle fails before masking.
          useDefaultWidgetMasks: false,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'RESOURCE_FAILURE');
        assert.ok((err as any).receipt, 'Must decorate error with receipt');
        assert.strictEqual((err as any).receipt.maskResolutionStatus, 'ok');
        assert.strictEqual((err as any).receipt.settleComplete, false);
        assert.ok(Array.isArray((err as any).metricSamples), 'Must decorate error with metricSamples');
        const maskSample = (err as any).metricSamples.find((s: any) => s.metric === 'visual.mask_resolution_complete');
        assert.ok(maskSample);
        assert.strictEqual(maskSample.passed, true);
        const settleSample = (err as any).metricSamples.find((s: any) => s.metric === 'visual.settle_complete');
        assert.ok(settleSample);
        assert.strictEqual(settleSample.passed, false);
        return true;
      }
    );
  });
});

describe('computePixelDiff & visualCompare comprehensive edge cases', () => {
  const W = 800;
  const H = 600;
  const mkBitmap = (pixels: Array<[number, number]>): Buffer => {
    const buf = Buffer.alloc(W * H * 4);
    for (const [px, py] of pixels) {
      const idx = (py * W + px) * 4;
      buf[idx] = 255;
      buf[idx + 3] = 255;
    }
    return buf;
  };

  it('rejects negative tolerance with INVALID_ARGUMENT', () => {
    const a = Buffer.alloc(33);
    assert.throws(
      () => computePixelDiff(a, a, -1),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('rejects tolerance > 100 with INVALID_ARGUMENT', () => {
    const a = Buffer.alloc(33);
    assert.throws(
      () => computePixelDiff(a, a, 100.1),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('rejects NaN tolerance with INVALID_ARGUMENT', () => {
    const a = Buffer.alloc(33);
    assert.throws(
      () => computePixelDiff(a, a, NaN),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('rejects non-finite tolerance with INVALID_ARGUMENT', () => {
    const a = Buffer.alloc(33);
    assert.throws(
      () => computePixelDiff(a, a, Infinity),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('rejects empty buffer with INVALID_ARGUMENT', () => {
    assert.throws(
      () => computePixelDiff(Buffer.alloc(0), Buffer.alloc(0), 5.0),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('returns empty diffBoundingBoxes when diffPixels is 0', () => {
    const a = mkBitmap([]);
    bitmapByBuffer.set(a, a);
    const res = computePixelDiff(a, a, 5.0);
    assert.strictEqual(res.match, true);
    assert.strictEqual(res.diffPixels, 0);
    assert.strictEqual(res.mismatchPercentage, 0);
    assert.deepStrictEqual(res.diffBoundingBoxes, []);
  });

  it('excludes grid block with <= 4 diff pixels from diffBoundingBoxes', () => {
    // 4 diff pixels in block (0, 0)
    const a = mkBitmap([[0, 0], [1, 0], [2, 0], [3, 0]]);
    const b = mkBitmap([]);
    bitmapByBuffer.set(a, a);
    bitmapByBuffer.set(b, b);
    const res = computePixelDiff(a, b, 5.0);
    assert.strictEqual(res.diffPixels, 4);
    assert.strictEqual(res.diffBoundingBoxes.length, 0);
  });

  it('includes grid block with > 4 diff pixels in diffBoundingBoxes', () => {
    // 5 diff pixels in block (0, 0)
    const a = mkBitmap([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    const b = mkBitmap([]);
    bitmapByBuffer.set(a, a);
    bitmapByBuffer.set(b, b);
    const res = computePixelDiff(a, b, 5.0);
    assert.strictEqual(res.diffPixels, 5);
    assert.strictEqual(res.diffBoundingBoxes.length, 1);
    assert.deepStrictEqual(res.diffBoundingBoxes[0], {
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      pixelCount: 5,
    });
  });

  it('caps diffBoundingBoxes at 50 even when many blocks differ', () => {
    // Create 60 blocks with 5 diff pixels each
    const pixels: Array<[number, number]> = [];
    for (let i = 0; i < 60; i++) {
      const bx = (i % 20) * 32;
      const by = Math.floor(i / 20) * 32;
      for (let p = 0; p < 5; p++) {
        pixels.push([bx + p, by]);
      }
    }
    const a = mkBitmap(pixels);
    const b = mkBitmap([]);
    bitmapByBuffer.set(a, a);
    bitmapByBuffer.set(b, b);
    const res = computePixelDiff(a, b, 5.0);
    assert.strictEqual(res.diffPixels, 300);
    assert.strictEqual(res.diffBoundingBoxes.length, 50);
  });

  it('visualCompare rejects missing baseline sources with INVALID_ARGUMENT', async () => {
    const host = buildMockHost({ evalLog: [] });
    const port = createRoutePort(host as unknown as BrowserHostPort);
    await assert.rejects(
      async () => {
        await port.visualCompare(dummyTarget, 'run-1', 'att-1', {});
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('visualCompare rejects conflicting baseline sources with INVALID_ARGUMENT', async () => {
    const host = buildMockHost({ evalLog: [] });
    const port = createRoutePort(host as unknown as BrowserHostPort);
    await assert.rejects(
      async () => {
        await port.visualCompare(dummyTarget, 'run-1', 'att-1', {
          comparisonTabId: 'tab-b',
          baselineScreenshotRef: 'art-1',
        });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('visualCompare rejects baselineRef without workspace context with WORKSPACE_UNBOUND', async () => {
    const host = buildMockHost({ evalLog: [] });
    const port = createRoutePort(host as unknown as BrowserHostPort);
    const unboundTarget = { ...dummyTarget, workspaceId: '' };
    await assert.rejects(
      async () => {
        await port.visualCompare(unboundTarget, 'run-1', 'att-1', {
          baselineRef: 'base-1',
        });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
    );
  });

  it('visualCompare rejects host lacking captureVerificationScreenshot with CAPABILITY_NOT_FOUND', async () => {
    const host = {
      getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
      isCurrentTarget: () => true,
    };
    const port = createRoutePort(host as unknown as BrowserHostPort);
    await assert.rejects(
      async () => {
        await port.visualCompare(dummyTarget, 'run-1', 'att-1', {
          comparisonTabId: 'tab-b',
        });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_NOT_FOUND'
    );
  });

  it('visualCompare extracts specific semantic selectors and matches trackedSelectors despite utility classes', async () => {
    let executedScript = '';
    const host = buildMockHost({
      evalLog: [],
      evalJsOverride: async (script: string, tabId?: string) => {
        if (script.includes('querySelectorAll')) {
          executedScript = script;
          return [
            { ref: 'e1', tag: 'div', selector: '.product-card', rect: { x: 0, y: 0, width: 200, height: 100 }, visible: true },
          ];
        }
        return true;
      },
    });
    const port = createRoutePort(host as unknown as BrowserHostPort);
    const res = (await port.visualCompare(dummyTarget, 'run-spec', 'att-spec', {
      comparisonTabId: 'tab-b',
      trackedSelectors: ['.product-card', '[data-test-card]'],
    })) as Record<string, unknown>;

    assert.ok(res);
    assert.ok(executedScript.includes('querySelectorAll'), 'queryScript must query tracked selectors via querySelectorAll');
    assert.ok(executedScript.includes('getAttribute'), 'queryScript must use getAttribute for class resolution');
    const structural = res.structural as { groups?: Record<string, unknown> } | undefined;
    assert.ok(structural?.groups, 'Must preserve groups in structural telemetry');
    assert.ok('.product-card' in structural.groups, 'Must preserve tracked product-card group in telemetry');
  });

  it('buildStructuralQueryScript executes in DOM context via vm and resolves nested compound and attribute selectors', () => {
    const cardEl = {
      tagName: 'DIV',
      getAttribute: (attr: string) => attr === 'class' ? 'product-card is-featured' : attr === 'data-item-id' ? '42' : null,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 150, top: 20, right: 110, bottom: 170, left: 10 }),
    };
    const svgEl = {
      tagName: 'svg',
      getAttribute: (attr: string) => attr === 'class' ? 'icon-cart' : null,
      getBoundingClientRect: () => ({ x: 5, y: 5, width: 24, height: 24, top: 5, right: 29, bottom: 29, left: 5 }),
    };
    const rootEl = {
      tagName: 'MAIN',
      id: 'main-content',
      getAttribute: (_attr: string) => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1200, height: 800, top: 0, right: 1200, bottom: 800, left: 0 }),
      matches: (sel: string) => sel === '#main-content',
      querySelectorAll: (sel: string) => {
        if (sel === '.product-card.is-featured' || sel === '[data-item-id="42"]') return [cardEl];
        if (sel === 'svg.icon-cart') return [svgEl];
        return [];
      },
      children: [cardEl, svgEl],
    };

    const script = buildStructuralQueryScript('main', ['.product-card.is-featured', 'svg.icon-cart']);
    const context = vm.createContext({
      document: {
        querySelector: (sel: string) => sel === 'main' ? rootEl : null,
      },
      Map,
      Array,
      Math,
    });
    const result = vm.runInContext(script, context) as any[];

    assert.strictEqual(result.length, 2, 'Must extract exactly the 2 matching elements');
    assert.strictEqual(result[0].selector, '.product-card.is-featured');
    assert.strictEqual(result[1].selector, 'svg.icon-cart');

    // Test zero-match contract: non-existent selector yields empty array, does NOT fall back to root/children
    const zeroScript = buildStructuralQueryScript('main', ['.non-existent-component']);
    const zeroResult = vm.runInContext(zeroScript, context) as any[];

    assert.strictEqual(zeroResult.length, 0, 'Zero-match tracked selectors must produce empty candidate list');
  });

  it('computeStructuralMetrics fails closed when requested tracked scope resolves zero elements on both sides', () => {
    const emptyBundle = {
      regions: [],
      viewport: { width: 1200, height: 800 },
      documentGeneration: 1,
      timestamp: Date.now(),
      maskedCount: 0,
    };
    const res = computeStructuralMetrics(emptyBundle, emptyBundle, {
      trackedSelectors: ['.product-card', '.cart-drawer'],
    });

    assert.strictEqual(res.cardinalityMatch, false, 'Zero-match tracked scope must fail cardinalityMatch');
    assert.strictEqual(res.geometryWithinTolerance, false, 'Zero-match tracked scope must fail geometryWithinTolerance');
    assert.ok(res.groups['.product-card'], 'Must seed .product-card in groups');
    assert.ok(res.groups['.cart-drawer'], 'Must seed .cart-drawer in groups');
    assert.strictEqual(res.groups['.product-card']?.cardinalityMatch, true, 'Group-level 0===0 is true');
    assert.strictEqual(res.groups['.product-card']?.targetCount, 0);
    assert.strictEqual(res.groups['.product-card']?.baselineCount, 0);
  });
});

describe('visualCompare structural height drift & truncation controls', () => {
  it('default (no params): height delta > 10% returns STRUCTURAL_TRUNCATION_DETECTED with match:false', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      pngDimensionsForTab: (tabId) => (tabId === 'tab-a' ? { width: 800, height: 1000 } : { width: 800, height: 600 }),
    });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      {
        comparisonTabId: 'tab-b',
      }
    );

    assert.strictEqual(result.match, false);
    assert.strictEqual((result as any).verdict, 'STRUCTURAL_TRUNCATION_DETECTED');
    assert.strictEqual((result as any).mismatchPercentage, 100);
    assert.ok((result as any).reason.includes('Structural height mismatch exceeds 10% tolerance'));
  });

  it('heightTolerance: 0.5 allows 30% height difference without triggering truncation gate', async () => {
    const evalLog: EvalLogEntry[] = [];
    // tab-a: 780, tab-b: 600 -> delta is (780-600)/600 = 0.30 (30%), within 0.50 (50%)
    const host = buildMockHost({
      evalLog,
      pngDimensionsForTab: (tabId) => (tabId === 'tab-a' ? { width: 800, height: 780 } : { width: 800, height: 600 }),
    });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      {
        comparisonTabId: 'tab-b',
        heightTolerance: 0.5,
      }
    );

    // Passes truncation gate and proceeds to diff evaluation (not blocked with STRUCTURAL_TRUNCATION_DETECTED)
    assert.notStrictEqual((result as any).verdict, 'STRUCTURAL_TRUNCATION_DETECTED');
  });

  it('allowHeightDrift: true bypasses truncation gate, proceeds to pixel evaluation and records layout metrics', async () => {
    const evalLog: EvalLogEntry[] = [];
    // tab-a: 1200, tab-b: 600 -> delta is 100%
    const host = buildMockHost({
      evalLog,
      pngDimensionsForTab: (tabId) => (tabId === 'tab-a' ? { width: 800, height: 1200 } : { width: 800, height: 600 }),
    });
    const port = createRoutePort(host as any);

    const result = await port.visualCompare(
      dummyTarget,
      'run-1',
      'att-1',
      {
        comparisonTabId: 'tab-b',
        allowHeightDrift: true,
      }
    );

    // Proves allowHeightDrift is an evidence collection bypass, not a false pass:
    assert.notStrictEqual((result as any).verdict, 'STRUCTURAL_TRUNCATION_DETECTED');
    assert.strictEqual(result.match, false, 'Non-overlapping pixel area with different heights must cause match:false');
    assert.ok((result as any).mismatchPercentage > 0, 'Must record non-zero mismatch percentage for height drift');
  });

  it('wires artifact sink and captures staged artifacts during visualCompare', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog });
    const { sink, staged } = buildArtifactSink();
    const port = createRoutePort(host as any, sink);

    const result = await port.visualCompare(
      dummyTarget,
      'run-sink-1',
      'att-sink-1',
      {
        comparisonTabId: 'tab-b',
      }
    );

    assert.ok(result);
    assert.ok(staged.length > 0, 'Artifact sink must receive staged comparison evidence');
    const kinds = staged.map((s) => s.kind);
    assert.ok(kinds.includes('evidence-envelope') || kinds.includes('screenshot') || kinds.includes('diff'), `Expected evidence kinds in sink, got: ${kinds.join(', ')}`);
    const first = staged[0];
    assert.ok(first, 'Staged artifact record must exist');
    assert.strictEqual(first.runId, 'run-sink-1');
    assert.strictEqual(first.attemptId, 'att-sink-1');
  });

  it('assertTargetsUsable retains quarantine when recovery receipt ok is false, preventing admission to failed targets', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      isTargetDrainingFor: () => false, // Host no longer draining
    });
    const port = createRoutePort(host as any);

    // Manually inject a quarantine entry whose recovery completed with ok: false
    const quarantineMap = (port as any).targetQuarantine as Map<string, any>;
    const qKey = 'tab-a::desktop';
    quarantineMap.set(qKey, {
      tabId: 'tab-a',
      paneId: 'desktop',
      pairKey: qKey,
      since: Date.now(),
      reason: 'CDP timeout during prior transaction',
      recovery: {
        ok: false,
        outcome: 'timeout',
        error: 'CDP drain command timed out after 5000ms',
      },
      pending: Promise.resolve(),
    });

    // Attempting visualCompare on quarantined target must be rejected
    await assert.rejects(
      async () => {
        await port.visualCompare(dummyTarget, 'run-quar-1', 'att-quar-1', { comparisonTabId: 'tab-b' });
      },
      (err: any) => {
        assert.strictEqual(err.code, 'TARGET_BUSY_DRAINING');
        assert.ok(err.message.includes('recovery failed'));
        return true;
      }
    );

    // Crucial check: quarantine entry MUST NOT have been deleted because recovery.ok is false!
    assert.ok(quarantineMap.has(qKey), 'Quarantine entry must be retained when recovery failed');

    // When recovery successfully completes with ok: true, subsequent transaction clears quarantine
    quarantineMap.get(qKey)!.recovery = {
      ok: true,
      outcome: 'recovered',
      elapsedMs: 120,
    };

    const successResult = await port.visualCompare(dummyTarget, 'run-quar-2', 'att-quar-2', { comparisonTabId: 'tab-b' });
    assert.ok(successResult);
    assert.strictEqual(quarantineMap.has(qKey), false, 'Quarantine entry must be deleted after successful recovery');
  });
});