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
  /** Total document height as a function of how many times the page has scrolled down. */
  heightAt: (scrolledSteps: number) => number;
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

  const documentElement = {
    get scrollHeight() {
      return page.heightAt(scrolledDown);
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
    const receipt = await runPrewarm({ heightAt: (steps) => 1000 + steps * 4000 });

    assert.equal(receipt.stoppedReason, 'GROWTH_ANOMALY');
    assert.equal(receipt.infiniteScrollSuspected, true);
    assert.ok(receipt.steps < SCROLL_PREWARM_DEFAULTS.maxSteps, 'the anomaly must stop the walk early, not at the step cap');
  });

  it('does not declare COMPLETE when the bottom triggers a sub-viewport append', async () => {
    // The dominant lazy-load shape: reaching the bottom appends a little more,
    // far below the growth-anomaly ratio, so only a no-growth confirmation can
    // tell "fully materialized" from "more is coming".
    const receipt = await runPrewarm({ heightAt: (steps) => (steps <= 1 ? 1600 : 2000) });

    assert.equal(receipt.stoppedReason, 'COMPLETE');
    assert.ok(
      receipt.endHeight >= 2000,
      `the walk must observe the appended content before completing (endHeight=${receipt.endHeight})`
    );
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
