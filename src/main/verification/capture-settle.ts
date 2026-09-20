/**
 * Visual Settle Gate & Resource Integrity Barrier
 *
 * Implements Phase 4 composed settle barrier (Audit v5 §14, V-16..V-18):
 * 1. First-party network quiescence (bounded)
 * 2. Document fonts readiness (document.fonts.ready bounded)
 * 3. In-viewport image decoding and broken-image detection (0x0 / complete failure)
 * 4. DOM quiet (double-rAF with background tab fallback)
 *
 * Emits an auditable VisualSettleReceipt.
 * Broken images fail closed with RESOURCE_FAILURE.
 * Settle timeouts fail closed with INCONCLUSIVE / SETTLE_INCOMPLETE.
 */

import { CapabilityError } from '../../shared/control-plane-contracts';
import { injectedScriptStore } from '../browser/scripts/injected-script-store.js';

export interface VisualSettleReceipt {
  settleComplete: boolean;
  failingPredicate?: string;
  gates: {
    network: boolean;
    fonts: boolean;
    images: boolean;
    dom: boolean;
    documentGeneration?: boolean;
    viewport?: boolean;
    imageIdentity?: boolean;
    layout?: boolean;
  };
  timingsMs: {
    network: number;
    fonts: number;
    images: number;
    dom: number;
    total: number;
  };
  brokenImages: string[];
  measurements?: Record<string, unknown>;
}
export interface CaptureSettlePredicates {
  /**
   * Waits for first-party critical network quiescence.
   * Returns true if settled within timeoutMs, false if timed out.
   */
  networkIdle?: (timeoutMs: number) => Promise<boolean>;

  /**
   * Evaluates document.fonts.ready bounded by timeoutMs.
   * Returns true if fonts settled, false if timed out.
   */
  fontsReady?: (timeoutMs: number) => Promise<boolean>;

  /**
   * Inspects and decodes images in the capture region/viewport.
   * Returns { settled: boolean, brokenImages: string[] }.
   */
  imagesDecoded?: (timeoutMs: number) => Promise<{ settled: boolean; brokenImages: string[] }>;

  /**
   * Waits for visual layout / DOM quiet (e.g. double-rAF).
   * Returns true if DOM settled, false if timed out.
   */
  domQuiet?: (timeoutMs: number) => Promise<boolean>;
}

export interface CaptureSettleOptions {
  networkTimeoutMs?: number;
  fontsTimeoutMs?: number;
  imagesTimeoutMs?: number;
  domTimeoutMs?: number;
  totalTimeoutMs?: number;
  scopeSelector?: string;
  ignoreSelectors?: string[];
  enableMediaFreeze?: boolean;
  enableStructuralRenderProbe?: boolean;
}

export const DEFAULT_SETTLE_TIMEOUTS = {
  networkTimeoutMs: 2000,
  fontsTimeoutMs: 1000,
  imagesTimeoutMs: 3500,
  domTimeoutMs: 300,
  totalTimeoutMs: 6000,
} as const;

async function withHardTimeout<T>(fn: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (timeoutMs <= 0) return fallback;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export class CaptureSettleGate {
  /**
   * Pure predicate runner. Executes settle gates in order, measuring duration
   * per gate and bounding the total duration.
   */
  public static async evaluate(
    predicates: CaptureSettlePredicates,
    options: CaptureSettleOptions = {}
  ): Promise<VisualSettleReceipt> {
    const networkTimeout = options.networkTimeoutMs ?? DEFAULT_SETTLE_TIMEOUTS.networkTimeoutMs;
    const fontsTimeout = options.fontsTimeoutMs ?? DEFAULT_SETTLE_TIMEOUTS.fontsTimeoutMs;
    const imagesTimeout = options.imagesTimeoutMs ?? DEFAULT_SETTLE_TIMEOUTS.imagesTimeoutMs;
    const domTimeout = options.domTimeoutMs ?? DEFAULT_SETTLE_TIMEOUTS.domTimeoutMs;
    const totalTimeout = options.totalTimeoutMs ?? DEFAULT_SETTLE_TIMEOUTS.totalTimeoutMs;

    const startTotal = Date.now();
    let brokenImages: string[] = [];

    const gates = {
      network: true,
      fonts: true,
      images: true,
      dom: true,
    };

    const timings = {
      network: 0,
      fonts: 0,
      images: 0,
      dom: 0,
      total: 0,
    };

    const remainingTotal = () => Math.max(0, totalTimeout - (Date.now() - startTotal));

    // 1. Network Idle Gate
    if (typeof predicates.networkIdle === 'function') {
      const budget = Math.min(networkTimeout, remainingTotal());
      const t0 = Date.now();
      gates.network = await withHardTimeout(
        () => predicates.networkIdle!(budget),
        budget,
        false
      );
      timings.network = Date.now() - t0;
    }

    // 2. Fonts Ready Gate
    if (typeof predicates.fontsReady === 'function') {
      const budget = Math.min(fontsTimeout, remainingTotal());
      const t0 = Date.now();
      gates.fonts = await withHardTimeout(
        () => predicates.fontsReady!(budget),
        budget,
        false
      );
      timings.fonts = Date.now() - t0;
    }

    // 3. Images Decoded & Broken Image Detection Gate
    if (typeof predicates.imagesDecoded === 'function') {
      const budget = Math.min(imagesTimeout, remainingTotal());
      const t0 = Date.now();
      const imgResult = await withHardTimeout(
        () => predicates.imagesDecoded!(budget),
        budget,
        { settled: false, brokenImages: [] }
      );
      gates.images = Boolean(imgResult.settled);
      brokenImages = Array.isArray(imgResult.brokenImages) ? [...imgResult.brokenImages] : [];
      timings.images = Date.now() - t0;
    }
    // 4. DOM Quiet Gate
    if (typeof predicates.domQuiet === 'function') {
      const budget = Math.min(domTimeout, remainingTotal());
      const t0 = Date.now();
      gates.dom = await withHardTimeout(
        () => predicates.domQuiet!(budget),
        budget,
        false
      );
      timings.dom = Date.now() - t0;
    }

    timings.total = Date.now() - startTotal;

    const settleComplete =
      gates.network &&
      gates.fonts &&
      gates.images &&
      gates.dom &&
      brokenImages.length === 0;

    let failingPredicate: string | undefined;
    if (!settleComplete) {
      if (!gates.network) failingPredicate = 'network';
      else if (!gates.fonts) failingPredicate = 'fonts';
      else if (!gates.images || brokenImages.length > 0) failingPredicate = 'images';
      else if (!gates.dom) failingPredicate = 'dom';
    }

    return {
      settleComplete,
      failingPredicate,
      gates,
      timingsMs: timings,
      brokenImages,
    };
  }

  /**
   * Asserts that no critical resource failures (broken images) were encountered.
   * Throws CapabilityError('RESOURCE_FAILURE') if broken images exist.
   */
  public static assertResources(receipt: VisualSettleReceipt): void {
    if (receipt.brokenImages && receipt.brokenImages.length > 0) {
      throw new CapabilityError(
        'RESOURCE_FAILURE',
        `Detected ${receipt.brokenImages.length} broken image(s) in capture region: ${receipt.brokenImages.join(', ')}`
      );
    }
  }
}

/**
 * Builds the in-page font readiness script.
 */
export function buildFontSettleScript(timeoutMs: number): string {
  return injectedScriptStore.getScript('settle.fonts', { timeoutMs });
}

/**
 * Builds the in-page image decode and broken image detection script.
 * Only inspects images intersecting the capture region or viewport (ignores lazy off-screen images).
 */
export function buildImageDecodeScript(
  timeoutMs: number,
  clipRect?: { x: number; y: number; width: number; height: number }
): string {
  return injectedScriptStore.getScript('settle.images', { timeoutMs, clipRect });
}

/**
 * Builds the in-page DOM quiet script using double-requestAnimationFrame.
 * Includes a fallback timer for background tabs where rAF is throttled.
 */
export interface DomQuietOptions {
  scopeSelector?: string;
  ignoreSelectors?: string[];
}

export function buildDomQuietScript(timeoutMs: number, options: DomQuietOptions = {}): string {
  const maxTimeout = Math.max(1, timeoutMs);
  const quietWindowMs = Math.min(50, Math.max(10, Math.floor(maxTimeout / 3)));
  const defaultIgnore = [
    '[data-countdown]', '[data-timer]', '.timer', '.countdown',
    '[data-live-visitor]', '.live-views', '.marquee', '[class*="ticker"]'
  ];
  const combinedIgnore = options.ignoreSelectors && options.ignoreSelectors.length > 0
    ? [...defaultIgnore, ...options.ignoreSelectors]
    : defaultIgnore;
  const scopeSelectorJson = JSON.stringify(options.scopeSelector || null);
  const ignoreListJson = JSON.stringify(combinedIgnore);

  return `(() => {
    return new Promise((resolve) => {
      let finished = false;
      let observer = null;
      let pollInterval = null;
      let lastMutation = Date.now();
      let timer = null;

      const cleanup = () => {
        if (observer) {
          try { observer.disconnect(); } catch {}
          observer = null;
        }
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const finish = (result) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };

      timer = setTimeout(() => {
        if (!finished) {
          finish(false);
        }
      }, ${maxTimeout});

      const scopeSelector = ${scopeSelectorJson};
      const targetScope = scopeSelector && typeof document !== 'undefined'
        ? document.querySelector(scopeSelector) || (document ? document.documentElement : null)
        : (typeof document !== 'undefined' ? document.documentElement : null);

      const ignoreList = ${ignoreListJson};
      const shouldIgnoreNode = (node) => {
        if (!node || node.nodeType !== 1) return false;
        for (let i = 0; i < ignoreList.length; i++) {
          try {
            if (node.matches(ignoreList[i]) || node.closest(ignoreList[i])) return true;
          } catch {}
        }
        return false;
      };

      // Install MutationObserver first so there is zero blind window
      if (typeof MutationObserver === 'function' && targetScope) {
        try {
          observer = new MutationObserver((mutations) => {
            let hasRelevantMutation = false;
            for (let i = 0; i < mutations.length; i++) {
              const m = mutations[i];
              if (!shouldIgnoreNode(m.target)) {
                hasRelevantMutation = true;
                break;
              }
            }
            if (hasRelevantMutation) {
              lastMutation = Date.now();
            }
          });
          observer.observe(targetScope, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });

          pollInterval = setInterval(() => {
            if (Date.now() - lastMutation >= ${quietWindowMs}) {
              finish(true);
            }
          }, 15);
        } catch {
          if (typeof requestAnimationFrame !== 'function') {
            finish(false);
          }
        }
      } else if (typeof requestAnimationFrame !== 'function') {
        finish(false);
      }

      // Double-rAF path for active foreground tabs (requires quiet window to pass)
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (Date.now() - lastMutation >= ${quietWindowMs}) {
              finish(true);
            }
          });
        });
      }
    });
  })()`;
}

export interface EvalHost {
  evalJs: (script: string, tabId?: string, paneId?: 'desktop' | 'mobile') => Promise<unknown>;
}

export interface NetworkTrackerHost {
  isAttached?: (tabId: string, paneId?: 'desktop' | 'mobile') => boolean;
  awaitQuiescence?: (
    tabId: string,
    paneId?: 'desktop' | 'mobile',
    options?: { idleWindowMs?: number; maxCeilingMs?: number; requireAttached?: boolean },
    signal?: AbortSignal
  ) => Promise<{ settled: boolean; durationMs: number; timedOut: boolean }>;
}

/**
 * Creates live browser predicates wired to an EvalHost and optional NetworkTrackerHost.
 */
export interface BrowserSettlePredicatesOptions {
  clipRect?: { x: number; y: number; width: number; height: number };
  networkTracker?: NetworkTrackerHost;
  requireNetworkTracker?: boolean;
  signal?: AbortSignal;
  scopeSelector?: string;
  ignoreSelectors?: string[];
  enableMediaFreeze?: boolean;
}

export function createBrowserSettlePredicates(
  evalHost: EvalHost,
  tabId: string,
  paneId: 'desktop' | 'mobile' = 'desktop',
  options: BrowserSettlePredicatesOptions = {}
): CaptureSettlePredicates {
  return {
    networkIdle: async (timeoutMs: number): Promise<boolean> => {
      const requireTracker = options.requireNetworkTracker !== false;
      if (!options.networkTracker || typeof options.networkTracker.awaitQuiescence !== 'function') {
        // Fail closed: without a valid network tracker, first-party network quiescence cannot be verified
        return !requireTracker;
      }
      if (typeof options.networkTracker.isAttached === 'function' && !options.networkTracker.isAttached(tabId, paneId)) {
        // Fail closed: tracker is not attached to this target; cannot certify network idle
        return false;
      }
      try {
        const res = await options.networkTracker.awaitQuiescence(
          tabId,
          paneId,
          {
            idleWindowMs: Math.min(200, timeoutMs),
            maxCeilingMs: timeoutMs,
            requireAttached: true,
          },
          options.signal
        );
        return Boolean(res.settled && !res.timedOut);
      } catch {
        return false;
      }
    },

    fontsReady: async (timeoutMs: number): Promise<boolean> => {
      try {
        const script = buildFontSettleScript(timeoutMs);
        const res = await evalHost.evalJs(script, tabId, paneId);
        return res === true;
      } catch {
        return false;
      }
    },

    imagesDecoded: async (timeoutMs: number): Promise<{ settled: boolean; brokenImages: string[] }> => {
      try {
        const script = buildImageDecodeScript(timeoutMs, options.clipRect);
        const res = (await evalHost.evalJs(script, tabId, paneId)) as {
          settled?: boolean;
          brokenImages?: string[];
        } | null;
        return {
          settled: res?.settled === true,
          brokenImages: Array.isArray(res?.brokenImages) ? res!.brokenImages : [],
        };
      } catch {
        return { settled: false, brokenImages: [] };
      }
    },
    domQuiet: async (timeoutMs: number): Promise<boolean> => {
      try {
        const script = buildDomQuietScript(timeoutMs, {
          scopeSelector: options.scopeSelector,
          ignoreSelectors: options.ignoreSelectors,
        });
        const res = await evalHost.evalJs(script, tabId, paneId);
        return res === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Canonical Pre-Capture Quiescence Predicates and Evaluation Gate
 *
 * Evaluates the harness-identical predicate set before any rasterization:
 * - documentGenerationSettled (readyState === 'complete')
 * - viewportStable (dimensions finite, positive, and unchanged)
 * - fontsSettled (document.fonts.status === 'loaded')
 * - imagesSettled (no image still loading; a broken image is a warning, not a refusal)
 * - imageIdentityStable (the tracked image SET and the layout each image occupies must hold
 *   while geometry holds constant; a source swap inside one unchanged element — a rotating
 *   banner or an ad creative — is recorded as churn and never refuses the raster)
 * - layoutStable (geometry converged across the observation window within a small drift
 *   allowance; a document that keeps growing still refuses)
 *
 * Every predicate here must be decidable by *waiting*, because the caller cannot repair it:
 * a page whose ad rotator swaps a banner every 110 ms, whose ad frame permanently 404s, or
 * whose document height settles 7 px late is capturable — its pixels are stable enough to
 * rasterize — and refusing it made evidence capture impossible on real ad-bearing pages
 * (measured: `anti.screenshot.full_page` refused on tiki.vn and vnexpress.net while the
 * cheap viewport path captured both). Conditions that no wait can clear belong in
 * `warnings`, so the receipt can say what the capture tolerated instead of pretending the
 * page was clean.
 */
export interface PreCaptureQuiescenceResult {
  ready: boolean;
  failingPredicate?: string;
  reason?: string;
  predicates: {
    documentGenerationSettled: boolean;
    viewportStable: boolean;
    fontsSettled: boolean;
    imagesSettled: boolean;
    imageIdentityStable: boolean;
    layoutStable: boolean;
  };
  /**
   * Non-fatal observations that the capture ran despite. Present on success as well as
   * failure, because `ready: true` with warnings is a materially different claim from a
   * quiet page, and the receipt has to be able to say which one it is.
   */
  warnings: CaptureSettleWarnings;
  measurements: {
    readyState: string;
    docHeight: number;
    scrollWidth: number;
    imageCount: number;
    pendingImages: number;
    brokenImages: string[];
    imageSetHash?: string;
    movingWitness?: string;
    durationMs: number;
    /** Largest document-geometry movement seen across the observation window, in CSS px. */
    layoutDriftPx: number;
    /** Tracked images whose source changed while their layout held constant. */
    rotatedImages: number;
    /** Predicates satisfied by tolerance rather than by an exact reading. */
    toleratedPredicates: string[];
  };
}

/** Non-fatal settle observations recorded on a capture that ran anyway. */
export interface CaptureSettleWarnings {
  /** Images that failed to load at capture time. A broken resource never becomes loadable by waiting. */
  brokenImages: string[];
  /** Tracked images whose source changed during the window (rotators, ad creatives, beacons). */
  rotatedImages: number;
  /** Document-geometry movement tolerated across the window, in CSS px. */
  layoutDriftPx: number;
  /** Predicates admitted by tolerance instead of by an exact reading. */
  toleratedPredicates: string[];
}

/**
 * Drift allowance for the layout predicate, as a fraction of the observed document height.
 * Real pages settle late: a collapsing ad container moved docHeight 7583 -> 7576 on tiki.vn
 * and 7597 -> 7596 on tiki's full-page walk, and both documents were capturable. 0.1% keeps
 * the allowance under a single text row on a typical page (7 px at 7583, 35 px at 35472) so
 * a document that is genuinely still growing keeps refusing, while a page that finished
 * settling one row late no longer blocks the raster.
 */
export const LAYOUT_DRIFT_TOLERANCE_RATIO = 0.001;

/** Floor for {@link LAYOUT_DRIFT_TOLERANCE_RATIO}: rounding must never produce a zero allowance. */
export const LAYOUT_DRIFT_TOLERANCE_MIN_PX = 2;
/**
 * Per-dimension allowance when matching a tracked image's box across readings, in CSS
 * px. Sub-pixel reflow jitters a box by a fraction of a pixel; 4 px absorbs that and
 * the rounding of fractional layouts without admitting a genuinely reshaped slot.
 */
export const IMAGE_BOX_TOLERANCE_PX = 4;

/**
 * Observation window for the layout predicate. A single dwell sees a movement but cannot
 * tell "settled 7 px late" from "still growing", which is the distinction the predicate
 * exists to make, so the sampler takes up to this many readings and requires the document
 * to hold within tolerance across the whole window — last pair agreeing AND last reading
 * still matching the first.
 */
export const LAYOUT_OBSERVATION_ATTEMPTS = 3;

/** Layout drift allowance for an observed document height, in CSS px. */
export function layoutDriftTolerancePx(docHeight: number): number {
  const scaled = Number.isFinite(docHeight) && docHeight > 0 ? docHeight * LAYOUT_DRIFT_TOLERANCE_RATIO : 0;
  return Math.max(LAYOUT_DRIFT_TOLERANCE_MIN_PX, Math.ceil(scaled));
}

export function buildPreCaptureSampleExpr(options: { fullPage?: boolean } = {}): string {
  const fullPage = Boolean(options.fullPage);
  return `(() => {
  const readyState = document.readyState;
  const fontsStatus = document.fonts ? document.fonts.status : 'loaded';
  const fontsSettled = fontsStatus === 'loaded';
  const imgs = Array.from(document.images || []);
  const isCannotLoad = (img) => {
    if (!img) return false;
    if (img.offsetParent === null && img.offsetWidth === 0 && img.offsetHeight === 0) {
      return true;
    }
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    const vh = window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 0) || 0;
    ${fullPage ? `if (img.loading === 'lazy') {
      return (r.top > vh * 2 || r.bottom < -vh);
    }` : `const vw = window.innerWidth || (document.documentElement ? document.documentElement.clientWidth : 0) || 0;
    const top = typeof r.top === 'number' ? r.top : (typeof r.y === 'number' ? r.y : 0);
    const bottom = typeof r.bottom === 'number' ? r.bottom : top + (r.height || 0);
    const left = typeof r.left === 'number' ? r.left : (typeof r.x === 'number' ? r.x : 0);
    const right = typeof r.right === 'number' ? r.right : left + (r.width || 0);
    if (bottom < 0 || top > vh || right < 0 || left > vw) return true;`}
    return false;
  };
  // A 1-2 px image is a tracking beacon, not page content: it is re-issued by ad
  // scripts on its own schedule and its state says nothing about whether the
  // raster is stable. Measured witnesses on real pages were a 1x1 data:gif on
  // vnexpress.net and a rotating banner on tiki.vn, neither of which made the
  // captured pixels unstable. The exemption covers every reading of the image —
  // identity, pending, and broken — not just the identity set.
  const isTrackingBeacon = (img) => {
    const r = img.getBoundingClientRect();
    return r.width <= 2 && r.height <= 2;
  };
  const isIgnorableIdentityImage = (img) => {
    if (!img) return true;
    if (img.offsetParent === null && img.offsetWidth === 0 && img.offsetHeight === 0) {
      return true;
    }
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    if (isTrackingBeacon(img)) return true;
    ${fullPage ? '' : `const vh = window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 0) || 0;
    const vw = window.innerWidth || (document.documentElement ? document.documentElement.clientWidth : 0) || 0;
    const top = typeof r.top === 'number' ? r.top : (typeof r.y === 'number' ? r.y : 0);
    const bottom = typeof r.bottom === 'number' ? r.bottom : top + (r.height || 0);
    const left = typeof r.left === 'number' ? r.left : (typeof r.x === 'number' ? r.x : 0);
    const right = typeof r.right === 'number' ? r.right : left + (r.width || 0);
    if (bottom < 0 || top > vh || right < 0 || left > vw) return true;`}
    return false;
  };
  const pendingImages = imgs.filter(i => !i.complete && !isCannotLoad(i) && !isTrackingBeacon(i)).length;
  const brokenImages = imgs.filter(i => i.complete && i.naturalWidth === 0 && !isCannotLoad(i) && !isTrackingBeacon(i)).map(i => (i.currentSrc || i.src || '').slice(0, 150));

  const hash32 = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  const trackedImages = imgs.filter(i => !isIgnorableIdentityImage(i));
  // Two readings per image: the full identity (which a rotator moves) and the
  // structural identity alone (the size of the box the image occupies). A source swap
  // inside an unmoved element is content churn; an image that appears, disappears, or
  // changes size means the document is still assembling, which is what this predicate
  // refuses.
  //
  // The structural reading is deliberately size-only, not position:
  //  - It excludes naturalWidth/naturalHeight, because an ad slot that loads a 300x250
  //    creative into a box that held a 1x1 beacon has not changed the document's shape.
  //    Keying on natural size read that swap as an added element (measured:
  //    vnexpress.net refused full-page capture, witness the swapped 1x1 gif).
  //  - It excludes position, because transform-driven carousels and sticky elements
  //    move boxes without mounting content (measured: tiki.vn refused full-page capture
  //    with witness box 1000,4680,156,156 while docHeight held at 7576). A snapshot of
  //    a moving carousel is a legitimate capture; a document that is growing is not,
  //    and growth is already refused by the layout predicate.
  // Sizes are emitted raw; the host compares them pairwise with a small allowance so
  // sub-pixel reflow of a 150-image grid does not read as a reshaped document.
  const imageParts = trackedImages.map(i => {
    const r = i.getBoundingClientRect();
    return (i.currentSrc || i.src || '').slice(0, 200) + '|' + i.naturalWidth + 'x' + i.naturalHeight + '|' +
      Math.round(r.x) + ',' + Math.round(r.y + (window.scrollY || 0)) + ',' + Math.round(r.width) + ',' + Math.round(r.height) + '|' + (i.complete ? 'c' : 'p');
  });
  // Position-free content identity: the same creative riding a carousel is not churn.
  const imageContentParts = trackedImages.map(i =>
    (i.currentSrc || i.src || '').slice(0, 200) + '|' + i.naturalWidth + 'x' + i.naturalHeight
  );
  const imageStructureParts = trackedImages.map(i => {
    const r = i.getBoundingClientRect();
    return r.width + 'x' + r.height;
  });
  const imageSetHash = hash32(imageParts.join('\\n'));
  const imageStructureHash = hash32(imageStructureParts.join('\\n'));
  const docHeight = Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  );
  const scrollWidth = document.documentElement ? document.documentElement.scrollWidth : 0;

  return {
    readyState,
    fontsSettled,
    fontsStatus,
    imageCount: imgs.length,
    pendingImages,
    brokenImages,
    imageSetHash,
    imageStructureHash,
    imageStructureCount: imageStructureParts.length,
    imageParts,
    imageContentParts,
    imageStructureParts,
    docHeight,
    scrollWidth,
  };
})()`;
}

export const PRE_CAPTURE_SAMPLE_EXPR = buildPreCaptureSampleExpr({ fullPage: false });

export async function evaluatePreCaptureQuiescence(
  evalHost: EvalHost,
  tabId: string,
  paneId: 'desktop' | 'mobile' = 'desktop',
  options: { dwellMs?: number; signal?: AbortSignal; fullPage?: boolean } = {}
): Promise<PreCaptureQuiescenceResult> {
  const t0 = Date.now();
  const dwellMs = options.dwellMs ?? 250;
  const sampleExpr = buildPreCaptureSampleExpr({ fullPage: options.fullPage });

  type InPageSample = {
    readyState: string;
    fontsSettled: boolean;
    fontsStatus: string;
    imageCount: number;
    pendingImages: number;
    brokenImages: string[];
    imageSetHash: string;
    imageStructureHash?: string;
    imageStructureCount?: number;
    imageParts: string[];
    imageContentParts?: string[];
    imageStructureParts?: string[];
    docHeight: number;
    scrollWidth: number;
  };

  const emptyWarnings = (): CaptureSettleWarnings => ({
    brokenImages: [],
    rotatedImages: 0,
    layoutDriftPx: 0,
    toleratedPredicates: [],
  });

  let sample1: InPageSample | null = null;
  try {
    sample1 = (await evalHost.evalJs(sampleExpr, tabId, paneId)) as InPageSample | null;
  } catch {}

  // If evaluation isn't available (e.g. synthetic test mock), pass through gracefully
  if (!sample1 || typeof sample1 !== 'object') {
    return {
      ready: true,
      predicates: {
        documentGenerationSettled: true,
        viewportStable: true,
        fontsSettled: true,
        imagesSettled: true,
        imageIdentityStable: true,
        layoutStable: true,
      },
      warnings: emptyWarnings(),
      measurements: {
        readyState: 'unknown',
        docHeight: 0,
        scrollWidth: 0,
        imageCount: 0,
        pendingImages: 0,
        brokenImages: [],
        durationMs: Date.now() - t0,
        layoutDriftPx: 0,
        rotatedImages: 0,
        toleratedPredicates: [],
      },
    };
  }

  const readSample = async (): Promise<InPageSample | null> => {
    if (dwellMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, dwellMs);
      await promise;
    }
    try {
      const next = (await evalHost.evalJs(sampleExpr, tabId, paneId)) as InPageSample | null;
      return next && typeof next === 'object' ? next : null;
    } catch {
      return null;
    }
  };

  // Layout convergence: take up to LAYOUT_OBSERVATION_ATTEMPTS readings and require the
  // document to hold within the drift allowance across the whole window — the last pair
  // must agree (the document stopped moving) AND the last reading must still match the
  // first (it did not keep growing in steps too small for any single pair to catch).
  // A single dwell reports *that* the document moved but cannot separate "settled one
  // row late" from "still growing" — and that distinction is the entire job of this
  // predicate. A perfectly still document is the only early exit: once any movement is
  // observed, the full window is spent confirming it stopped, because a document that
  // keeps growing by less than the per-pair tolerance is still growing.
  let sample2 = await readSample();
  let layoutObservations = 2;
  if (!sample2) {
    sample2 = sample1;
    layoutObservations = 1;
  }
  let layoutDriftPx = 0;
  let layoutStable = false;
  let layoutWindowTruncated = false;
  let lastLayoutTolerance = layoutDriftTolerancePx(Math.max(sample1.docHeight, sample2.docHeight));
  const layoutWindow = {
    firstHeight: sample1.docHeight,
    firstWidth: sample1.scrollWidth,
    lastHeight: sample2.docHeight,
    lastWidth: sample2.scrollWidth,
  };
  for (let attempt = 0; attempt < LAYOUT_OBSERVATION_ATTEMPTS; attempt++) {
    const drift = Math.max(
      Math.abs(sample1.docHeight - sample2.docHeight),
      Math.abs(sample1.scrollWidth - sample2.scrollWidth)
    );
    const tolerance = layoutDriftTolerancePx(Math.max(sample1.docHeight, sample2.docHeight));
    lastLayoutTolerance = tolerance;
    const cumulativeDrift = Math.max(
      Math.abs(layoutWindow.firstHeight - sample2.docHeight),
      Math.abs(layoutWindow.firstWidth - sample2.scrollWidth)
    );
    layoutDriftPx = Math.max(layoutDriftPx, drift, cumulativeDrift);
    layoutStable = drift <= tolerance && cumulativeDrift <= tolerance;
    if (drift === 0 && cumulativeDrift === 0) break;
    if (attempt === LAYOUT_OBSERVATION_ATTEMPTS - 1) break;
    sample1 = sample2;
    const next = await readSample();
    if (!next) {
      // A failed mid-window read is inconclusive, not observed movement: judge the last
      // good pair and say the window ended early instead of reporting drift never seen.
      layoutWindowTruncated = true;
      break;
    }
    sample2 = next;
    layoutObservations += 1;
    layoutWindow.lastHeight = sample2.docHeight;
    layoutWindow.lastWidth = sample2.scrollWidth;
  }

  const documentGenerationSettled = sample2.readyState === 'complete';
  const viewportStable = sample2.docHeight > 0 && sample2.scrollWidth > 0;
  const fontsSettled = sample2.fontsSettled === true;
  // Only a still-loading image is worth waiting for. A broken image never becomes
  // loadable by waiting, so refusing the capture on one made every ad-bearing page
  // uncapturable (measured: 2 broken ad images refused vnexpress.net outright).
  // After the observation window, a leftover pending image among already-decoded
  // siblings is the same class: it will not become loadable by refusing the raster
  // (measured: 1 pending image refused phongvu.vn after network_idle). Refuse only
  // while pending images still outnumber loaded ones — the page is still loading.
  const loadedImages = Math.max(0, sample2.imageCount - sample2.pendingImages);
  const leftoverPendingTolerated = sample2.pendingImages > 0 && loadedImages >= sample2.pendingImages;
  const imagesSettled = sample2.pendingImages === 0 || leftoverPendingTolerated;

  // Structural identity: the tracked image set and each image's layout must hold.
  // A source swap inside an unmoved element is churn to report, not a reason to refuse.
  let imageIdentityStable = true;
  let movingWitness: string | undefined;
  let rotatedImages = 0;

  const structure1 = sample1.imageStructureParts || [];
  const structure2 = sample2.imageStructureParts || [];
  // Churn is counted on the position-free content identity: a creative riding a
  // carousel or a beacon re-issued at a new offset is the same image, not a rotation.
  const contentParts1 = sample1.imageContentParts || sample1.imageParts || [];
  const contentParts2 = sample2.imageContentParts || sample2.imageParts || [];

  // Box sizes are compared raw with a per-dimension allowance, not snapped to a grid:
  // quantizing aliases sub-pixel drift across a grid boundary (101.9 -> 100 while
  // 102.1 -> 104 reads as a 4 px move that never happened).
  type TrackedBox = { w: number; h: number; raw: string };
  const parseBox = (raw: string): TrackedBox => {
    const [w, h] = raw.split('x').map(Number);
    return { w: w ?? NaN, h: h ?? NaN, raw };
  };
  const boxesMatch = (a: TrackedBox, b: TrackedBox): boolean =>
    Number.isFinite(a.w) && Number.isFinite(b.w) &&
    Math.abs(a.w - b.w) <= IMAGE_BOX_TOLERANCE_PX &&
    Math.abs(a.h - b.h) <= IMAGE_BOX_TOLERANCE_PX;
  const boxOrder = (b: TrackedBox): number => b.w - b.h / 1000000;
  // Multiset diff on the two sorted box lists: the witness is a size present in one
  // reading but not the other — the box that was added, removed, or reshaped — never
  // a surviving box that merely slid into a vacated slot.
  const firstUnmatchedBox = (before: TrackedBox[], after: TrackedBox[]): string | undefined => {
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
      const a = before[i]!;
      const b = after[j]!;
      if (boxesMatch(a, b)) {
        i += 1;
        j += 1;
      } else if (!Number.isFinite(boxOrder(a)) || boxOrder(a) < boxOrder(b)) {
        return a.raw;
      } else {
        return b.raw;
      }
    }
    if (i < before.length) return before[i]!.raw;
    if (j < after.length) return after[j]!.raw;
    return undefined;
  };

  if (layoutStable) {
    const boxes1 = structure1.map(parseBox).sort((a, b) => boxOrder(a) - boxOrder(b));
    const boxes2 = structure2.map(parseBox).sort((a, b) => boxOrder(a) - boxOrder(b));
    const unmatched = firstUnmatchedBox(boxes1, boxes2);
    if (unmatched !== undefined) {
      imageIdentityStable = false;
      movingWitness = unmatched;
    } else if (
      (sample1.imageStructureCount ?? structure1.length) !== (sample2.imageStructureCount ?? structure2.length)
    ) {
      // The emitted count disagrees with the box list itself: the sample is internally
      // inconsistent, which is movement the diff cannot name.
      imageIdentityStable = false;
      movingWitness = `count_${sample1.imageStructureCount}_to_${sample2.imageStructureCount}`;
    } else {
      // Same set, same layout: count the source churn for the receipt.
      const maxLen = Math.max(contentParts1.length, contentParts2.length);
      for (let i = 0; i < maxLen; i++) {
        if (contentParts1[i] !== contentParts2[i]) rotatedImages += 1;
      }
    }
  }

  // Named only when the predicate passed and something was actually tolerated. This list is
  // read on the refusal path too, so listing a predicate that caused the refusal would send
  // the reader after the wrong gate: layout drift above tolerance must not appear as tolerated.
  const toleratedPredicates: string[] = [];
  if (layoutStable && layoutDriftPx > 0) toleratedPredicates.push('layoutStable');
  if (imageIdentityStable && rotatedImages > 0) toleratedPredicates.push('imageIdentityStable');
  if (imagesSettled && (sample2.brokenImages.length > 0 || leftoverPendingTolerated)) toleratedPredicates.push('imagesSettled');

  const warnings: CaptureSettleWarnings = {
    brokenImages: sample2.brokenImages,
    rotatedImages,
    layoutDriftPx,
    toleratedPredicates,
  };

  const predicates = {
    documentGenerationSettled,
    viewportStable,
    fontsSettled,
    imagesSettled,
    imageIdentityStable,
    layoutStable,
  };

  const measurements = {
    readyState: sample2.readyState,
    docHeight: sample2.docHeight,
    scrollWidth: sample2.scrollWidth,
    imageCount: sample2.imageCount,
    pendingImages: sample2.pendingImages,
    brokenImages: sample2.brokenImages,
    imageSetHash: sample2.imageSetHash,
    movingWitness,
    durationMs: Date.now() - t0,
    layoutDriftPx,
    rotatedImages,
    toleratedPredicates,
  };

  let ready = true;
  let failingPredicate: string | undefined;
  let reason: string | undefined;

  if (!documentGenerationSettled) {
    ready = false;
    failingPredicate = 'documentGenerationSettled';
    reason = `Document readyState is '${sample2.readyState}' (expected 'complete')`;
  } else if (!viewportStable) {
    ready = false;
    failingPredicate = 'viewportStable';
    reason = `Document dimensions unmeasurable (${sample2.docHeight}x${sample2.scrollWidth})`;
  } else if (!fontsSettled) {
    ready = false;
    failingPredicate = 'fontsSettled';
    reason = `Fonts not settled (document.fonts.status is '${sample2.fontsStatus}', expected 'loaded')`;
  } else if (!imagesSettled) {
    ready = false;
    failingPredicate = 'imagesSettled';
    reason = `Detected ${sample2.pendingImages} pending image(s) still loading`;
  } else if (!imageIdentityStable) {
    ready = false;
    failingPredicate = 'imageIdentityStable';
    // The only facts measured here are the image sizes that changed, the witness box,
    // and the document geometry that held constant: a page-specific class name in the
    // reason would assert an observation this gate never made for any other page.
    reason = `Tracked image inventory moved while document geometry held constant: docHeight ${sample2.docHeight} / scrollWidth ${sample2.scrollWidth} constant (${sample2.imageStructureCount ?? structure2.length} tracked image(s)), first differing box size: ${movingWitness}`;
  } else if (!layoutStable) {
    ready = false;
    failingPredicate = 'layoutStable';
    reason = `Document layout did not hold within tolerance across ${layoutObservations} observation(s): docHeight ${layoutWindow.firstHeight} -> ${layoutWindow.lastHeight}, scrollWidth ${layoutWindow.firstWidth} -> ${layoutWindow.lastWidth}, drift ${layoutDriftPx}px exceeds tolerance ${lastLayoutTolerance}px${layoutWindowTruncated ? ' (window ended early: a sample evaluation failed)' : ''}`;
  }

  return {
    ready,
    failingPredicate,
    reason,
    predicates,
    warnings,
    measurements,
  };
}
