/**
 * AntiFan Browser Desktop — Full-Page Capture Scroll Pre-Warm
 *
 * A full-page capture of a lazily rendered storefront only sees what has
 * already mounted. Scrolling during the raster is not an option (the raster is
 * one compositor snapshot), so the page must be walked before capture: each
 * step materializes the next band of panels, and the capture then gets a
 * document that is as tall as it is ever going to be.
 *
 * The walk is deliberately bounded. Collection and search pages on storefront
 * themes mount forever, so an unbounded walk (or a capture that believes the
 * growing height) grows the renderer until the Skia capture buffer cannot be
 * allocated and the GPU process dies. Every loop here has a hard ceiling and an
 * anomaly detector that stops on runaway insertion instead of chasing it.
 */

export interface ScrollPrewarmOptions {
  /** Hard ceiling on scroll steps. */
  maxSteps?: number;
  /** Stop once the document claims this height (CSS px). */
  maxDocumentHeight?: number;
  /** Fraction of the viewport advanced per step. */
  stepRatio?: number;
  /** Settle time per step; long enough for an IntersectionObserver fetch to start. */
  settleMs?: number;
  /** Ceiling on the post-walk image decode wait. */
  imageDecodeBudgetMs?: number;
}

export interface ScrollPrewarmReceipt {
  performed: boolean;
  steps: number;
  startHeight: number;
  endHeight: number;
  stoppedReason: 'COMPLETE' | 'MAX_SCROLL_STEPS' | 'MAX_DOCUMENT_HEIGHT' | 'GROWTH_ANOMALY';
  infiniteScrollSuspected: boolean;
  totalImages: number;
  pendingImages: number;
  fontsReady: boolean;
  returnedToTop: boolean;
  elapsedMs: number;
}

export const SCROLL_PREWARM_DEFAULTS = {
  maxSteps: 12,
  maxDocumentHeight: 10_000,
  stepRatio: 0.85,
  settleMs: 40,
  imageDecodeBudgetMs: 2_000,
} as const;

/**
 * Builds the in-page pre-warm expression. Every wait is timer-backed: Chrome
 * suspends `requestAnimationFrame` in background tabs, and the tab under test
 * is usually not the visible one, so a frame-based wait would hang the whole
 * capture instead of warming it.
 */
export function buildStaircasePrewarmScript(options?: ScrollPrewarmOptions): string {
  const maxSteps = Math.max(1, Math.round(options?.maxSteps ?? SCROLL_PREWARM_DEFAULTS.maxSteps));
  const maxDocumentHeight = Math.max(1_000, Math.round(options?.maxDocumentHeight ?? SCROLL_PREWARM_DEFAULTS.maxDocumentHeight));
  const stepRatio = Math.min(0.95, Math.max(0.25, options?.stepRatio ?? SCROLL_PREWARM_DEFAULTS.stepRatio));
  const settleMs = Math.max(10, Math.round(options?.settleMs ?? SCROLL_PREWARM_DEFAULTS.settleMs));
  const imageDecodeBudgetMs = Math.max(100, Math.round(options?.imageDecodeBudgetMs ?? SCROLL_PREWARM_DEFAULTS.imageDecodeBudgetMs));
  const growthAnomalyRatio = 0.3;
  const strikesToStop = 2;

  return `(async () => {
    const startedAt = Date.now();
    const MAX_STEPS = ${maxSteps};
    const MAX_DOCUMENT_HEIGHT = ${maxDocumentHeight};
    const STEP_RATIO = ${stepRatio};
    const SETTLE_MS = ${settleMs};
    const IMAGE_DECODE_BUDGET_MS = ${imageDecodeBudgetMs};
    const GROWTH_ANOMALY_RATIO = ${growthAnomalyRatio};
    const STRIKES_TO_STOP = ${strikesToStop};

    const wait = (ms) => {
      const gate = Promise.withResolvers();
      setTimeout(() => gate.resolve(null), ms);
      return gate.promise;
    };
    const readHeight = () => {
      const doc = document.documentElement ? document.documentElement.scrollHeight : 0;
      const body = document.body ? document.body.scrollHeight : 0;
      return Math.max(doc, body);
    };
    const viewportHeight = window.innerHeight || 800;
    // "At the bottom" must be read from where the page ACTUALLY is, not from the
    // requested offset. \`scrollTo\` clamps at the current maximum, so a page that
    // appends a band the moment the bottom becomes visible is only at the bottom
    // of the height it had BEFORE that append. Testing the requested offset
    // instead reports COMPLETE on the first step while most of the document is
    // still unmaterialized — the exact failure this walk exists to prevent.
    const atBottom = () => (window.scrollY || window.pageYOffset || 0) + viewportHeight >= readHeight() - 2;
    const startHeight = readHeight();
    let steps = 0;
    let stoppedReason = 'COMPLETE';
    let infiniteScrollSuspected = false;
    let growthStrikes = 0;

    for (let index = 0; index < MAX_STEPS; index++) {
      const heightBefore = readHeight();
      if (heightBefore >= MAX_DOCUMENT_HEIGHT) {
        stoppedReason = 'MAX_DOCUMENT_HEIGHT';
        break;
      }
      const stride = Math.max(200, Math.round(viewportHeight * STEP_RATIO));
      const scrollTarget = Math.min(heightBefore, (index + 1) * stride);
      window.scrollTo(0, scrollTarget);
      steps = index + 1;
      await wait(SETTLE_MS);

      const heightAfter = readHeight();
      if (heightAfter - heightBefore > heightAfter * GROWTH_ANOMALY_RATIO) {
        growthStrikes += 1;
        if (growthStrikes >= STRIKES_TO_STOP) {
          stoppedReason = 'GROWTH_ANOMALY';
          infiniteScrollSuspected = true;
          break;
        }
      }
      if (heightAfter >= MAX_DOCUMENT_HEIGHT) {
        stoppedReason = 'MAX_DOCUMENT_HEIGHT';
        break;
      }
      // The walk is finished only when it is at the bottom AND the step that got
      // there added nothing. Reaching the bottom is not enough: a page that loads
      // the next band when the bottom becomes visible grows on that very step,
      // and stopping there would rasterize a fraction of a document that is
      // still materializing — the exact failure this walk exists to prevent.
      // The extra settle covers an append that had not landed yet.
      if (atBottom() && heightAfter === heightBefore) {
        await wait(SETTLE_MS);
        if (atBottom() && readHeight() === heightAfter) {
          stoppedReason = 'COMPLETE';
          break;
        }
      }
      if (index === MAX_STEPS - 1) {
        stoppedReason = 'MAX_SCROLL_STEPS';
      }
    }

    let fontsReady = true;
    try {
      if (document.fonts && document.fonts.ready) {
        const fontGate = Promise.withResolvers();
        document.fonts.ready.then(() => fontGate.resolve(true), () => fontGate.resolve(false));
        const fontSettle = setTimeout(() => fontGate.resolve(true), 1500);
        fontsReady = await fontGate.promise;
        clearTimeout(fontSettle);
      }
    } catch {}

    let totalImages = 0;
    let pendingImages = 0;
    try {
      const images = Array.prototype.slice.call(document.images || []);
      totalImages = images.length;
      const undecoded = [];
      for (let i = 0; i < images.length; i++) {
        if (!images[i].complete) undecoded.push(images[i]);
      }
      pendingImages = undecoded.length;
      if (undecoded.length > 0) {
        const decodeGate = Promise.withResolvers();
        const budgetTimer = setTimeout(() => decodeGate.resolve(null), IMAGE_DECODE_BUDGET_MS);
        const decodes = undecoded.map((image) => {
          try {
            if (typeof image.decode === 'function') return image.decode().catch(() => null);
          } catch {}
          return Promise.resolve(null);
        });
        Promise.all(decodes).then(() => decodeGate.resolve(null), () => decodeGate.resolve(null));
        await decodeGate.promise;
        clearTimeout(budgetTimer);
        let stillPending = 0;
        for (let k = 0; k < undecoded.length; k++) {
          if (!undecoded[k].complete) stillPending += 1;
        }
        pendingImages = stillPending;
      }
    } catch {}

    let returnedToTop = false;
    try {
      window.scrollTo(0, 0);
      const settleGate = Promise.withResolvers();
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          settleGate.resolve(null);
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(settle));
      }
      setTimeout(settle, 120);
      await settleGate.promise;
      returnedToTop = (window.scrollY || window.pageYOffset || 0) <= 2;
    } catch {}

    return {
      performed: steps > 0,
      steps: steps,
      startHeight: startHeight,
      endHeight: readHeight(),
      stoppedReason: stoppedReason,
      infiniteScrollSuspected: infiniteScrollSuspected,
      totalImages: totalImages,
      pendingImages: pendingImages,
      fontsReady: fontsReady,
      returnedToTop: returnedToTop,
      elapsedMs: Date.now() - startedAt,
    };
  })()`;
}

const STOPPED_REASONS: Record<string, ScrollPrewarmReceipt['stoppedReason']> = {
  COMPLETE: 'COMPLETE',
  MAX_SCROLL_STEPS: 'MAX_SCROLL_STEPS',
  MAX_DOCUMENT_HEIGHT: 'MAX_DOCUMENT_HEIGHT',
  GROWTH_ANOMALY: 'GROWTH_ANOMALY',
};

/**
 * Narrows the raw renderer result into a receipt. The walk runs inside the page,
 * so its result is external input: anything missing or mistyped is reported as a
 * best-effort receipt rather than trusted into capture geometry.
 */
export function normalizeScrollPrewarmResult(raw: unknown): ScrollPrewarmReceipt {
  const fallback: ScrollPrewarmReceipt = {
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
  };
  if (!raw || typeof raw !== 'object') return fallback;

  const record = raw as Record<string, unknown>;
  const number = (value: unknown, or: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : or);
  const stoppedReason = typeof record.stoppedReason === 'string' ? STOPPED_REASONS[record.stoppedReason] : undefined;

  return {
    performed: record.performed === true,
    steps: number(record.steps, 0),
    startHeight: number(record.startHeight, 0),
    endHeight: number(record.endHeight, 0),
    stoppedReason: stoppedReason ?? 'COMPLETE',
    infiniteScrollSuspected: record.infiniteScrollSuspected === true,
    totalImages: number(record.totalImages, 0),
    pendingImages: number(record.pendingImages, 0),
    fontsReady: record.fontsReady === true,
    returnedToTop: record.returnedToTop === true,
    elapsedMs: number(record.elapsedMs, 0),
  };
}
