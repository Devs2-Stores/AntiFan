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

export interface VisualSettleReceipt {
  settleComplete: boolean;
  gates: {
    network: boolean;
    fonts: boolean;
    images: boolean;
    dom: boolean;
  };
  timingsMs: {
    network: number;
    fonts: number;
    images: number;
    dom: number;
    total: number;
  };
  brokenImages: string[];
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
}

export const DEFAULT_SETTLE_TIMEOUTS = {
  networkTimeoutMs: 2000,
  fontsTimeoutMs: 500,
  imagesTimeoutMs: 1000,
  domTimeoutMs: 200,
  totalTimeoutMs: 3500,
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

    return {
      settleComplete,
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
  return `(() => {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve(false); }
      }, ${Math.max(1, timeoutMs)});
      if (document.fonts && typeof document.fonts.ready === 'object' && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(() => {
          if (!done) { done = true; clearTimeout(timer); resolve(true); }
        }).catch(() => {
          if (!done) { done = true; clearTimeout(timer); resolve(false); }
        });
      } else {
        if (!done) { done = true; clearTimeout(timer); resolve(true); }
      }
    });
  })()`;
}

/**
 * Builds the in-page image decode and broken image detection script.
 * Only inspects images intersecting the capture region or viewport (ignores lazy off-screen images).
 */
export function buildImageDecodeScript(
  timeoutMs: number,
  clipRect?: { x: number; y: number; width: number; height: number }
): string {
  const clipJson = clipRect ? JSON.stringify(clipRect) : 'null';
  return `(() => {
    return new Promise((resolve) => {
      const clip = ${clipJson};
      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;

      const imgs = Array.from(document.images || []);
      const relevantImages = imgs.filter(img => {
        try {
          const rect = img.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            // Invisible/display:none images without layout are not broken in-region images
            // unless they have a src that explicitly failed loading
            return false;
          }
          if (clip) {
            return (
              rect.right >= clip.x &&
              rect.left <= clip.x + clip.width &&
              rect.bottom >= clip.y &&
              rect.top <= clip.y + clip.height
            );
          }
          return (
            rect.right >= 0 &&
            rect.left <= vw &&
            rect.bottom >= 0 &&
            rect.top <= vh
          );
        } catch {
          return false;
        }
      });

      let finished = false;
      const finish = (settled) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const broken = [];
        for (const img of relevantImages) {
          try {
            const src = img.currentSrc || img.src;
            if (img.complete && img.naturalWidth === 0 && img.naturalHeight === 0 && src) {
              broken.push(src);
            }
          } catch {}
        }
        resolve({ settled, brokenImages: broken });
      };

      const timer = setTimeout(() => {
        finish(false);
      }, ${Math.max(1, timeoutMs)});

      const decodePromises = [];
      for (const img of relevantImages) {
        if (typeof img.decode === 'function') {
          decodePromises.push(img.decode().catch(() => {}));
        }
      }
      if (decodePromises.length === 0) {
        finish(true);
      } else {
        Promise.all(decodePromises).then(() => finish(true)).catch(() => finish(false));
      }
    });
  })()`;
}

/**
 * Builds the in-page DOM quiet script using double-requestAnimationFrame.
 * Includes a fallback timer for background tabs where rAF is throttled.
 */
export function buildDomQuietScript(timeoutMs: number): string {
  const maxTimeout = Math.max(1, timeoutMs);
  const quietWindowMs = Math.min(50, Math.max(10, Math.floor(maxTimeout / 3)));
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
      // Install MutationObserver first so there is zero blind window
      if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
        try {
          observer = new MutationObserver(() => {
            lastMutation = Date.now();
          });
          observer.observe(document.documentElement, {
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
        const script = buildDomQuietScript(timeoutMs);
        const res = await evalHost.evalJs(script, tabId, paneId);
        return res === true;
      } catch {
        return false;
      }
    },
  };
}
