import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import {
  buildStaircasePrewarmScript,
  normalizeScrollPrewarmResult,
  SCROLL_PREWARM_DEFAULTS,
  type ScrollPrewarmReceipt,
} from './scroll-prewarm.js';

interface FakePage {
  /**
   * Total document height, keyed on the walk's own progress: how many scroll
   * steps have run, and how many settle ticks the walk has consumed in total.
   * Keying growth on the clock as well as the scroll is what makes a late append
   * observable at all — a fetch-backed loader appends after the step that
   * triggered it, not during it. The tick count is cumulative so a fixture
   * cannot make the document shrink once it has grown.
   */
  heightAt: (state: { scrolledSteps: number; ticks: number }) => number;
  viewportHeight?: number;
}

/**
 * Runs the walk against a fake document. The sandbox owns the clock: the script
 * paces itself with `setTimeout` because Chrome suspends rAF in background tabs,
 * so a fake timer that resolves on the microtask queue keeps the test
 * deterministic and instant instead of sleeping out twelve settle windows.
 */
async function runPrewarm(page: FakePage, options?: { maxSteps?: number }): Promise<ScrollPrewarmReceipt> {
  const viewportHeight = page.viewportHeight ?? 800;
  const scrollTops: number[] = [];
  let scrollY = 0;
  let scrolledDown = 0;
  let ticks = 0;

  const documentElement = {
    get scrollHeight() {
      return page.heightAt({ scrolledSteps: scrolledDown, ticks });
    },
  };
  const document = {
    documentElement,
    body: { get scrollHeight() { return 0; } },
    images: [],
    fonts: { ready: Promise.resolve() },
  };
  const window = {
    innerHeight: viewportHeight,
    get scrollY() {
      return scrollY;
    },
    scrollTo(_x: number, y: number) {
      scrollTops.push(y);
      if (y > 0) scrolledDown += 1;
      scrollY = y;
    },
  };

  const context = vm.createContext({
    window,
    document,
    setTimeout: (fn: () => void) => {
      ticks += 1;
      queueMicrotask(fn);
      return 0;
    },
    clearTimeout: () => {},
  });

  const raw = await vm.runInContext(buildStaircasePrewarmScript(options), context);
  return normalizeScrollPrewarmResult(raw);
}

describe('Full-page scroll pre-warm', () => {
  it('walks a finite page to the bottom and returns to the top', async () => {
    const receipt = await runPrewarm({ heightAt: () => 1600 });

    assert.equal(receipt.stoppedReason, 'COMPLETE');
    assert.equal(receipt.performed, true);
    assert.ok(receipt.steps >= 1, 'a two-viewport document needs at least one step');
    assert.ok(receipt.steps <= SCROLL_PREWARM_DEFAULTS.maxSteps);
    assert.equal(receipt.infiniteScrollSuspected, false);
    assert.equal(receipt.returnedToTop, true);
  });

  it('stops an endlessly appending document instead of walking into a GPU crash', async () => {
    // Each scroll appends a full extra viewport: unbounded growth, the shape a
    // collection page takes when nothing caps it.
    const receipt = await runPrewarm({ heightAt: ({ scrolledSteps }) => 1000 + scrolledSteps * 4000 });

    assert.equal(receipt.stoppedReason, 'GROWTH_ANOMALY');
    assert.equal(receipt.infiniteScrollSuspected, true);
    assert.ok(receipt.steps < SCROLL_PREWARM_DEFAULTS.maxSteps, 'the anomaly must stop the walk early, not at the step cap');
  });

  it('keeps walking when the append lands several settles after the bottom', async () => {
    // The dominant lazy-load shape: reaching the bottom fetches the next band,
    // and the response lands later than one settle. A walk that confirms with a
    // single settle declares the page finished at 1600 and rasterizes it while
    // 400px of it is still arriving; the bounded grace has to observe the append
    // and keep walking. The append is keyed on elapsed ticks — tick 5 is inside
    // the grace window of the step that reached the bottom — so a one-settle
    // confirmation provably cannot see it.
    const receipt = await runPrewarm({
      heightAt: ({ ticks }) => (ticks >= 5 ? 2000 : 1600),
    });

    // The observable that distinguishes this from a one-settle confirmation is
    // the extra step: the append is only visible during the grace, so a walk
    // that gives up after one settle stops at step 2. `endHeight` cannot carry
    // that claim — it is read after the walk, so it also reflects anything that
    // appended while the fonts and image gates were running.
    assert.ok(receipt.steps >= 3, `the late append must force another scroll step (steps=${receipt.steps})`);
    assert.equal(receipt.stoppedReason, 'COMPLETE');
    assert.equal(receipt.infiniteScrollSuspected, false);
  });

  it('refuses to walk a document past the height ceiling', async () => {
    const receipt = await runPrewarm({ heightAt: () => SCROLL_PREWARM_DEFAULTS.maxDocumentHeight + 5_000 });

    assert.equal(receipt.stoppedReason, 'MAX_DOCUMENT_HEIGHT');
    assert.equal(receipt.performed, false);
    assert.equal(receipt.steps, 0);
  });
});

describe('Prewarm receipt normalization', () => {
  it('never trusts a malformed renderer result into capture geometry', () => {
    const receipt = normalizeScrollPrewarmResult('not-an-object');

    assert.deepEqual(receipt, {
      performed: false,
      steps: 0,
      startHeight: 0,
      endHeight: 0,
      stoppedReason: 'COMPLETE',
      infiniteScrollSuspected: false,
      totalImages: 0,
      pendingImages: 0,
      fontsReady: false,
      returnedToTop: false,
      elapsedMs: 0,
    });
  });

  it('coerces a mistyped result into a bounded receipt with a known stop reason', () => {
    const receipt = normalizeScrollPrewarmResult({
      performed: 'yes',
      steps: Number.NaN,
      startHeight: 100,
      endHeight: 2_500,
      stoppedReason: 'SOMETHING_ELSE',
      totalImages: 4,
      pendingImages: 2,
      returnedToTop: true,
      elapsedMs: 12,
    });

    assert.equal(receipt.performed, false);
    assert.equal(receipt.steps, 0);
    assert.equal(receipt.endHeight, 2_500);
    assert.equal(receipt.stoppedReason, 'COMPLETE');
    assert.equal(receipt.returnedToTop, true);
  });
});
