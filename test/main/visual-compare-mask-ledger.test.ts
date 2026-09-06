import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, computePixelDiff } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';

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
  evalLog: EvalLogEntry[];
}

function buildMockHost(opts: MockHostOptions) {
  const curPng = createTestPng(800, 600);
  const basePng = createTestPng(800, 600);
  return {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
    evalJs: async (script: string, tabId?: string): Promise<unknown> => {
      opts.evalLog.push({ script, tabId });
      if (script.includes('el.remove')) {
        if (tabId && opts.restoreFailsFor?.has(tabId)) return false;
        return true;
      }
      if (script.includes('__antifan_normalize_scroll')) {
        if (tabId && opts.injectThrowsFor?.has(tabId)) throw new Error('simulated inject failure');
        if (opts.injectResultFor) return opts.injectResultFor(tabId || '');
        return true;
      }
      if (script.includes('innerWidth')) return { vw: 800, vh: 600, dh: 1600, sx: 0, sy: 0 };
      if (script.includes('querySelectorAll')) {
        if (!tabId) return [];
        const rows = opts.maskRows ? opts.maskRows(tabId) : [{ selector: '.badge', error: null, boxes: [{ x: 100, y: 100, width: 50, height: 50 }] }];
        return rows;
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
    getBrowserEpoch: () => 1,
    getDocumentGeneration: (tabId?: string) => (opts.docGenFor ? opts.docGenFor(tabId || '') : 1),
    getMutationRevision: (tabId?: string) => (opts.mutationRevFor ? opts.mutationRevFor(tabId || '') : 1),
  };
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
    createFromBuffer: (buf: Buffer) => ({
      getSize: () => ({ width: 800, height: 600 }),
      isEmpty: () => false,
      getBitmap: () => bitmapByBuffer.get(buf) ?? Buffer.alloc(800 * 600 * 4),
    }),
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
    const port = new BrowserControlPort(host as any);

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

    // Normalization: inject first, restore last — no leftovers.
    const injects = evalLog.filter((e) => e.script.includes('appendChild'));
    const restores = evalLog.filter((e) => e.script.includes('el.remove'));
    assert.strictEqual(injects.length, 2, 'one inject per side');
    assert.strictEqual(restores.length, 2, 'one verified restore per side');
    assert.deepEqual(new Set(injects.map((e) => e.tabId)), new Set(['tab-a', 'tab-b']));
    assert.deepEqual(new Set(restores.map((e) => e.tabId)), new Set(['tab-a', 'tab-b']));

    const captureIndex = evalLog.findIndex((e) => e.script === ''); // no captures logged; injects must precede restores
    void captureIndex;
    const firstInject = evalLog.findIndex((e) => e.script.includes('appendChild'));
    const firstRestore = evalLog.findIndex((e) => e.script.includes('el.remove'));
    assert.ok(firstInject >= 0 && firstRestore > firstInject, 'restore must run after inject');
    assert.ok(evalLog.every((e, idx) => !e.script.includes('el.remove') || idx > firstInject));

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
    assert.strictEqual(mask.target.entries.length, 1);
    assert.strictEqual(mask.target.entries[0].selector, '.badge');
    assert.strictEqual(mask.target.entries[0].status, 'resolved');
    assert.strictEqual(mask.target.entries[0].required, true);
    assert.ok(mask.target.maskedAreaRatio > 0 && mask.target.maskedAreaRatio < 0.1);
    assert.ok(mask.baseline, 'comparison side receipt must exist');
    assert.strictEqual(mask.baseline.entries.length, 1);
  });

  it('V-12: cleanup runs (verified restore) when capture throws', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog, captureThrowsFor: 'tab-a' });
    const port = new BrowserControlPort(host as any);

    await assert.rejects(
      () =>
        port.visualCompare(dummyTarget, 'run-1', 'att-1', {
          comparisonTabId: 'tab-b',
          normalizeScroll: true,
          maskSelectors: ['.badge'],
        }),
      (err: unknown) => err instanceof Error && err.message.includes('simulated capture failure')
    );

    const restores = evalLog.filter((e) => e.script.includes('el.remove') && e.tabId === 'tab-a');
    assert.strictEqual(restores.length, 1, 'finally must restore the owned style after an exception');
  });

  it('V-01: required mask zero-match returns MASK_RESOLUTION_FAILED, never match:true', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({
      evalLog,
      maskRows: () => [{ selector: '.never-present', error: null, boxes: [] }],
    });
    const port = new BrowserControlPort(host as any);

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
    const port = new BrowserControlPort(host as any);

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
    // One record per side (target + comparison both report the absent optional).
    assert.deepEqual((result.maskResolution as any).optionalUnmatched, ['.maybe-gone', '.maybe-gone']);
    assert.strictEqual((result.maskResolution as any).status, 'ok');
  });

  it('owned style that fails verified restore returns NORMALIZATION_RESTORE_FAILED, not a clean run', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog, restoreFailsFor: new Set(['tab-a']) });
    const port = new BrowserControlPort(host as any);

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
    const port = new BrowserControlPort(host as any);
    const res = (await port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b', normalizeScroll: true })) as any;
    assert.strictEqual(res.match, true);
    assert.strictEqual(res.coherence.identityCoherent, true);
    assert.strictEqual(res.coherence.captureStateCompatible, true);
    assert.strictEqual(res.coherence.resampleCount, 1);
    // Both attempts injected and restored normalization on both tabs (per-attempt cleanup).
    const injectCount = evalLog.filter((e) => e.script.includes('createElement')).length;
    const restoreCount = evalLog.filter((e) => e.script.includes('el.remove')).length;
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
    const port = new BrowserControlPort(host as any);
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
    const port = new BrowserControlPort(host as any);
    await assert.rejects(
      port.visualCompare(dummyTarget, 'run', 'att', { comparisonTabId: 'tab-b' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });

  it('cancels the pixel diff with INCONCLUSIVE when comparison-side normalization fails to inject', async () => {
    const evalLog: EvalLogEntry[] = [];
    const host = buildMockHost({ evalLog, injectThrowsFor: new Set(['tab-b']) });
    const port = new BrowserControlPort(host as any);
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
    const port = new BrowserControlPort(host as any);
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
    const port = new BrowserControlPort(host as any);
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
    const port = new BrowserControlPort(host as any);
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