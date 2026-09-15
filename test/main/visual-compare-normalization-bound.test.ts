/**
 * The B30 defect: the reversible-normalization apply script dwelled between
 * scroll-cascade steps with `setTimeout(60)`. Compare runs on background tabs,
 * where timers are clamped to >=1s, so a ~25-step page exceeded the 15s
 * NORMALIZATION_BOUND_MS before any capture ran — every desktop/tablet case
 * surfaced as CAPTURE_INVALID with a fabricated mismatchPercentage of 100 and
 * null artifacts.
 *
 * These tests prove the apply script no longer depends on a throttled timer
 * (it runs to completion with setTimeout removed entirely), that the cascade
 * is deadline-bounded and reports truncation, and that a compare which never
 * reached a pixel diff emits no mismatch number at all.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  BrowserControlPort,
  buildReversibleNormalizationApplyScript,
  NORMALIZATION_SCROLL_CASCADE_BUDGET_MS,
} from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';
import type { VerificationCaptureEnvelope } from '../../src/main/verification/visual-capture';

const NORMALIZATION_BOUND_MS = 15_000;

/** Minimal valid-PNG-shaped buffer whose IHDR carries the given dimensions. */
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
  buf.writeUInt32BE(0, 29);
  return buf;
}

/**
 * A page context for the apply script: a document `scrollHeight` tall, a
 * viewport `innerHeight` high, and NO setTimeout — the exact condition that
 * broke the old cascade, since a background tab's clamped timer is
 * indistinguishable from an absent one for a script that must not use it.
 */
function runApplyScript(opts: { scrollHeight: number; innerHeight: number; cascadeBudgetMs?: number }) {
  const scrollCalls: Array<{ top: number; left: number }> = [];
  const documentElement = { scrollHeight: opts.scrollHeight, scrollTop: 0, scrollLeft: 0 };
  const body = { scrollHeight: opts.scrollHeight, scrollTop: 0, scrollLeft: 0 };
  const windowObj = {
    innerHeight: opts.innerHeight,
    scrollTo: (arg: { top?: number; left?: number }) => {
      scrollCalls.push({ top: arg?.top ?? 0, left: arg?.left ?? 0 });
    },
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
  };
  const context = vm.createContext({
    window: windowObj,
    document: {
      documentElement,
      body,
      querySelectorAll: () => [],
      getElementsByClassName: () => [],
      getElementById: () => null,
      createElement: () => ({ dataset: {}, style: {} }),
      head: { appendChild: () => undefined },
    },
    MessageChannel,
    // Deliberately absent: setTimeout. If the script ever awaits a timer it
    // throws ReferenceError inside the cascade's try/catch and the scroll calls
    // below prove whether the cascade actually ran.
  });
  const script = buildReversibleNormalizationApplyScript('txn-test', opts.cascadeBudgetMs);
  return { scrollCalls, result: vm.runInContext(script, context) as Promise<{ applied: boolean; recorded: number; scrollCascadeComplete?: boolean }> };
}

describe('reversible normalization apply script (B30)', () => {
  it('completes the hydration cascade inside the bound without any timer', async () => {
    // 20,000px page at 800px steps = 26 dwells. Under the old setTimeout(60)
    // dwell, background-tab clamping stretched each step to >=1s (~26s total),
    // past the 15s bound. The MessageChannel yield is not clamped.
    const { scrollCalls, result } = runApplyScript({ scrollHeight: 20_000, innerHeight: 900 });
    const started = Date.now();
    const res = await result;
    const elapsed = Date.now() - started;

    assert.equal(res.applied, true);
    assert.equal(res.scrollCascadeComplete, true);
    assert.ok(elapsed < NORMALIZATION_BOUND_MS, `cascade took ${elapsed}ms, over the ${NORMALIZATION_BOUND_MS}ms bound`);
    assert.ok(scrollCalls.length >= 26, `expected the full cascade (>=26 scrolls), got ${scrollCalls.length}`);
    assert.equal(scrollCalls[scrollCalls.length - 1]?.top, 0, 'the cascade returns the page to the origin');
  });

  it('a cascade that cannot finish inside its budget reports truncation instead of overrunning', async () => {
    // A 200,000px page needs 251 dwells; a 120ms budget admits ~2. The loop must
    // stop at the deadline and say so, not run past the normalization bound.
    const { scrollCalls, result } = runApplyScript({ scrollHeight: 200_000, innerHeight: 900, cascadeBudgetMs: 120 });
    const started = Date.now();
    const res = await result;
    const elapsed = Date.now() - started;

    assert.equal(res.applied, true);
    assert.equal(res.scrollCascadeComplete, false, 'a truncated cascade is reported, not hidden');
    assert.ok(elapsed < NORMALIZATION_SCROLL_CASCADE_BUDGET_MS, `truncated cascade overran its budget (${elapsed}ms)`);
    assert.ok(scrollCalls.length < 251, 'the cascade stopped at the deadline');
    assert.equal(scrollCalls[scrollCalls.length - 1]?.top, 0, 'the page still returns to the origin');
  });
});

// ── Port-level: no-diff results carry no fabricated percentage ────────────────

const dummyTarget: BrowserTarget = {
  tabId: 'tab-a',
  documentGeneration: 1,
  projectId: 'test-proj',
  workspaceId: 'test-ws',
  runtimeId: 'test-rt',
  browserEpoch: 1,
};

// computePixelDiff requires Electron's nativeImage; under plain node the
// electron package resolves to a path string. Stub the module cache so the
// diff path is exercisable (same pattern as visual-compare-mask-ledger.test).
const electronResolved = require.resolve('electron');
let electronEntry: NodeModule | undefined = require.cache[electronResolved];
let electronExportsBackup: unknown;

before(() => {
  if (!electronEntry) {
    require(electronResolved);
    electronEntry = require.cache[electronResolved];
  }
  if (electronEntry) {
    electronExportsBackup = electronEntry.exports;
    electronEntry.exports = {
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
            getBitmap: () => (buf.length === 0 ? null : Buffer.alloc(width * height * 4)),
          };
        },
      },
    };
  }
});

after(() => {
  if (electronEntry && electronExportsBackup !== undefined) {
    electronEntry.exports = electronExportsBackup;
  }
});

interface MockHostOptions {
  /** evalJs result for the normalization apply script */
  applyResult?: unknown;
  /** evalJs throws for the normalization apply script */
  applyThrows?: boolean;
  fontsReady?: boolean;
  /** per-tab raster dimensions */
  pngDimensionsForTab?: (tabId: string) => { width: number; height: number };
}

function buildMockHost(opts: MockHostOptions) {
  const dims = (tabId: string) => (opts.pngDimensionsForTab ? opts.pngDimensionsForTab(tabId) : { width: 800, height: 600 });
  const pngFor = (tabId: string) => createTestPng(dims(tabId).width, dims(tabId).height);
  return {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
    getTabUrl: () => 'https://example.test/',
    evalJs: async (script: string): Promise<unknown> => {
      if (script.includes('__antifan_compare_txn__')) {
        if (script.includes('alreadyRestored')) return { restored: true, alreadyRestored: true, failed: 0 };
        if (opts.applyThrows) throw new Error('simulated normalization apply timeout');
        return opts.applyResult !== undefined ? opts.applyResult : { applied: true, alreadyApplied: true, recorded: 0 };
      }
      // The restore script carries both markers; check removal first.
      if (script.includes('el.remove')) return true;
      if (script.includes('__antifan_normalize_scroll')) return { owned: true, present: true };
      if (script.includes('document.fonts.ready')) return opts.fontsReady !== false;
      if (script.includes('img.decode')) return { settled: true, brokenImages: [] };
      if (script.includes('requestAnimationFrame')) return true;
      if (script.includes('innerWidth')) return { vw: 800, vh: 600, dh: 1600, sx: 0, sy: 0 };
      if (script.includes('const selectors =')) return [];
      return null;
    },
    captureScreenshot: async (_rect: unknown, tabId?: string) => pngFor(tabId || 'tab-a').toString('base64'),
    captureVerificationScreenshot: async (rect: unknown, tabId?: string): Promise<VerificationCaptureEnvelope> => {
      const d = dims(tabId || 'tab-a');
      return {
        data: pngFor(tabId || 'tab-a').toString('base64'),
        backend: 'cdp',
        dpr: 1,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        cssCaptureSize: { width: 800, height: 600 },
        rasterSize: { width: d.width, height: d.height },
        captureMode: rect ? 'clip' : 'viewport',
        timestamp: Date.now(),
      };
    },
    getBrowserEpoch: () => 1,
    getDocumentGeneration: () => 1,
    getMutationRevision: () => 1,
    getNetworkTracker: () => ({
      isAttached: () => true,
      awaitQuiescence: async () => ({ settled: true, durationMs: 0, timedOut: false }),
    }),
  };
}

describe('visualCompare emits no fabricated mismatch (B30)', () => {
  it('a normalization-apply failure settles INCONCLUSIVE with a named reason and no pixel number', async () => {
    const port = new BrowserControlPort(buildMockHost({ applyThrows: true }) as never);
    const result = (await port.visualCompare(dummyTarget, 'run-1', 'att-1', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
    })) as Record<string, unknown>;

    assert.equal(result.status, 'INCONCLUSIVE');
    assert.match(String(result.reason), /normalization/i);
    assert.equal(result.mismatchPercentage, null, 'no diff ran, so no percentage may be emitted');
    assert.equal(result.match, false);
  });

  it('a settle-barrier failure settles INCONCLUSIVE with no pixel number', async () => {
    const port = new BrowserControlPort(buildMockHost({ fontsReady: false }) as never);
    const result = (await port.visualCompare(dummyTarget, 'run-1', 'att-1', {
      comparisonTabId: 'tab-b',
    })) as Record<string, unknown>;

    assert.equal(result.status, 'INCONCLUSIVE');
    assert.equal(result.mismatchPercentage, null);
    assert.equal(result.match, false);
  });

  it('a truncated hydration cascade is reported on the settled result', async () => {
    // The apply reports an incomplete cascade; the compare then short-circuits
    // on a structural height mismatch (tab-b raster is 3x taller), which is a
    // settled result — so the cascade receipt must travel with it.
    const port = new BrowserControlPort(
      buildMockHost({
        applyResult: { applied: true, recorded: 0, scrollCascadeComplete: false },
        pngDimensionsForTab: (tabId) => (tabId === 'tab-b' ? { width: 800, height: 3000 } : { width: 800, height: 1000 }),
      }) as never
    );
    const result = (await port.visualCompare(dummyTarget, 'run-1', 'att-1', {
      comparisonTabId: 'tab-b',
      normalizeScroll: true,
    })) as Record<string, unknown>;

    assert.equal(result.verdict, 'STRUCTURAL_TRUNCATION_DETECTED');
    const cascade = result.scrollCascade as { target?: boolean; comparison?: boolean } | undefined;
    assert.ok(cascade, 'the cascade receipt is attached to the settled result');
    assert.equal(cascade.target, false);
    assert.equal(cascade.comparison, false);
    assert.equal(result.mismatchPercentage, null, 'the truncation gate refused before any pixel diff');
  });
});
