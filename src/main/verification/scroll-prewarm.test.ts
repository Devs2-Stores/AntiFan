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
  /**
   * The page's CSS sets `scroll-behavior: smooth` on a tab that produces no
   * frames during the walk: a scroll that does not ask for `behavior: 'instant'`
   * only queues an animation and leaves the offset where it was.
   */
  smoothScroll?: boolean;
}

interface PrewarmRun {
  receipt: ScrollPrewarmReceipt;
  /** Scroll animations the walk left queued on the page when it resolved. */
  pendingAnimations: number[];
  scrollY: number;
}

/**
 * Runs the walk against a fake document. The sandbox owns the clock: the script
 * paces itself with `setTimeout` because Chrome suspends rAF in background tabs,
 * so a fake timer that resolves on the microtask queue keeps the test
 * deterministic and instant instead of sleeping out twelve settle windows.
 */
async function runPrewarmOnPage(page: FakePage, options?: { maxSteps?: number }): Promise<PrewarmRun> {
  const viewportHeight = page.viewportHeight ?? 800;
  const pendingAnimations: number[] = [];
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
    scrollTo(xOrOptions: number | ScrollToOptions, y?: number) {
      const options = typeof xOrOptions === 'object' ? xOrOptions : undefined;
      const top = options ? options.top ?? scrollY : y ?? scrollY;
      if (page.smoothScroll && options?.behavior !== 'instant') {
        pendingAnimations.push(top);
        return;
      }
      if (top > 0) scrolledDown += 1;
      scrollY = top;
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
  return { receipt: normalizeScrollPrewarmResult(raw), pendingAnimations, scrollY };
}

async function runPrewarm(page: FakePage, options?: { maxSteps?: number }): Promise<ScrollPrewarmReceipt> {
  return (await runPrewarmOnPage(page, options)).receipt;
}

interface StickyHeaderPage {
  /** Document height while the sticky header shows its full, unscrolled height. */
  docHeight: number;
  /** How much the header shrinks while the page is scrolled away from the top. */
  compactShrinkPx: number;
  /** Gap between rendering steps on a frame-starved agent tab, in ms of virtual time. */
  frameIntervalMs: number;
  viewportHeight?: number;
}

interface StickyHeaderRun {
  receipt: ScrollPrewarmReceipt;
  /** The header state the next reader of the document sees. */
  headerCompact: boolean;
  /** A scroll the page has not yet dispatched its scroll event for. */
  scrollEventPending: boolean;
}

/**
 * Runs the walk on a virtual clock against a theme whose sticky header compacts
 * in its scroll handler. Chrome dispatches `scroll` only at a rendering step, and
 * an agent tab renders rarely, so the handler — and the height change it makes —
 * can run long after the scroll that caused it. Timers fire in due-time order; a
 * rendering step every `frameIntervalMs` dispatches any pending scroll event.
 */
async function runPrewarmOnStickyHeaderPage(page: StickyHeaderPage): Promise<StickyHeaderRun> {
  const viewportHeight = page.viewportHeight ?? 800;
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { due: number; order: number; fn: () => void }>();
  const schedule = (fn: () => void, ms = 0): number => {
    sequence += 1;
    timers.set(sequence, { due: now + Math.max(0, ms), order: sequence, fn });
    return sequence;
  };

  let scrollY = 0;
  let scrollEventPending = false;
  let headerCompact = false;
  const scrollListeners = new Set<() => void>();
  // The theme's own handler, registered before the walk runs.
  scrollListeners.add(() => {
    headerCompact = scrollY > 0;
  });
  const renderingStep = () => {
    if (scrollEventPending) {
      scrollEventPending = false;
      for (const listener of [...scrollListeners]) listener();
    }
    schedule(renderingStep, page.frameIntervalMs);
  };
  schedule(renderingStep, page.frameIntervalMs);

  const document = {
    documentElement: {
      get scrollHeight() {
        return page.docHeight - (headerCompact ? page.compactShrinkPx : 0);
      },
    },
    body: { get scrollHeight() { return 0; } },
    images: [],
    fonts: { ready: Promise.resolve() },
  };
  const window = {
    innerHeight: viewportHeight,
    get scrollY() {
      return scrollY;
    },
    scrollTo(xOrOptions: number | ScrollToOptions, y?: number) {
      const top = typeof xOrOptions === 'object' ? xOrOptions.top ?? scrollY : y ?? scrollY;
      const max = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
      const next = Math.min(Math.max(0, top), max);
      if (next !== scrollY) {
        scrollY = next;
        scrollEventPending = true;
      }
    },
    addEventListener(type: string, listener: () => void) {
      if (type === 'scroll') scrollListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'scroll') scrollListeners.delete(listener);
    },
  };

  const context = vm.createContext({
    window,
    document,
    setTimeout: schedule,
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  });

  let finished = false;
  const walk = (vm.runInContext(buildStaircasePrewarmScript(), context) as Promise<unknown>).then((raw) => {
    finished = true;
    return raw;
  });
  // Advance only while the walk is idle: a real macrotask turn first drains every
  // microtask the walk queued, then the earliest due timer runs.
  for (let turn = 0; !finished; turn++) {
    assert.ok(turn < 100_000, 'the walk never finished on the virtual clock');
    await new Promise((resolve) => setImmediate(resolve));
    if (finished) break;
    const next = [...timers.entries()].sort(([, a], [, b]) => a.due - b.due || a.order - b.order)[0];
    assert.ok(next, 'the walk is waiting on nothing');
    timers.delete(next[0]);
    now = next[1].due;
    next[1].fn();
  }
  const receipt = normalizeScrollPrewarmResult(await walk);
  return { receipt, headerCompact, scrollEventPending };
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

  it('walks a page whose CSS smooth-scrolls without leaving a scroll animation behind', async () => {
    // Measured on f1genz-an-vat (html { scroll-behavior: smooth }): every positional
    // scrollTo ran from scrollY 0, so the walk never saw the bottom, and the queued
    // animation later scrolled the page under the settle gate — the sticky header
    // compacted 16px and the gate refused a document the capture itself was moving.
    const run = await runPrewarmOnPage({ heightAt: () => 4000, smoothScroll: true });

    assert.equal(run.receipt.stoppedReason, 'COMPLETE', 'the walk must reach the bottom of a smooth-scrolling page');
    assert.ok(run.receipt.steps < SCROLL_PREWARM_DEFAULTS.maxSteps, `a 5-viewport page must not run to the step cap (steps=${run.receipt.steps})`);
    assert.equal(run.receipt.returnedToTop, true);
    assert.equal(run.scrollY, 0);
    assert.deepEqual(run.pendingAnimations, [], 'a queued page animation would move the document after the walk returns');
  });

  it('hands over only after the page has handled its return to the top', async () => {
    // Measured on f1genz-an-vat: the sticky header compacted while the walk sat at
    // the bottom, the walk returned to the top and handed over after its 120ms
    // settle, and the scroll event that expands the header ran 173ms after the
    // return — inside the settle gate's window, which saw the document grow 16px.
    // One rendering step every 400ms: the header compacts at the bottom, and the
    // return lands more than one 120ms settle before the next step.
    const run = await runPrewarmOnStickyHeaderPage({ docHeight: 4000, compactShrinkPx: 16, frameIntervalMs: 400 });

    assert.equal(run.receipt.stoppedReason, 'COMPLETE');
    assert.equal(run.receipt.returnedToTop, true);
    assert.equal(run.scrollEventPending, false, 'the return must not leave a scroll event for the page to handle after the walk');
    assert.equal(run.headerCompact, false, 'the header must be back to its top-of-page state before the walk hands over');
    assert.equal(run.receipt.endHeight, 4000, 'the walk reports the height the settle gate will read');
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
