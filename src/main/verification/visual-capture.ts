/**
 * AntiFan Core - Visual Capture Space & Fail-Closed Mask Ledger
 *
 * Pure module (no Electron dependency, 100% unit-testable in Node).
 * Owns the deterministic geometry contract for visual evidence:
 *   - VisualCaptureSpace  : CSS Viewport -> Document/Clip -> Raster affine mapping
 *   - transformMaskBoxToRaster : single source of truth for mask placement
 *   - MaskLedger          : fail-closed resolution (required vs optional), per-side
 *   - materializeRasterMasks : scale application + masked-area ratio policy
 *   - NormalizationTransaction : scoped DOM style injection/restore (finally-safe)
 *   - MultiKeyLock        : keyed FIFO mutex with deterministic sorted acquisition
 *
 * Authority boundary: this module produces mechanical geometry and receipts only.
 * It never issues business verdicts (VERIFIED/REJECTED/INCONCLUSIVE belong to
 * VerificationEvaluator). Failures surface as MaskResolutionError, which callers
 * route to their operational status channel.
 */

export interface RasterBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualCaptureSpace {
  /** raster pixels per CSS pixel along x — measured per-axis: pngWidth / captured-css-width */
  scaleX: number;
  /** raster pixels per CSS pixel along y — measured per-axis: pngHeight / captured-css-height */
  scaleY: number;
  /** page scroll offset in CSS pixels at mask-snapshot time (document-relative for fullPage) */
  scrollX: number;
  scrollY: number;
  /** full-page capture: mask coords become document-relative (viewport coords + scroll) */
  fullPage: boolean;
  /** CSS viewport coords of the captured rect; raster origin (0,0) maps to its top-left */
  crop?: RasterBox;
}

export interface MaskResolutionEntry {
  selector: string;
  required: boolean;
  status: 'resolved' | 'missing-required' | 'missing-optional' | 'syntax-error' | 'eval-failed';
  error?: string;
  /** viewport-relative CSS boxes as read from the page */
  cssBoxes: RasterBox[];
  /** raster-space boxes after transform for this side's space */
  rasterBoxes?: RasterBox[];
}

/** Receipt projection of one resolution entry — stable contract for result payloads. */
export function maskEntryReceipt(entry: MaskResolutionEntry): {
  selector: string;
  required: boolean;
  status: MaskResolutionEntry['status'];
  error?: string;
} {
  return entry.error
    ? { selector: entry.selector, required: entry.required, status: entry.status, error: entry.error }
    : { selector: entry.selector, required: entry.required, status: entry.status };
}

export interface MaskLedgerResult {
  entries: MaskResolutionEntry[];
  /** combined accepted raster boxes (required + optional matches), ready for computePixelDiff */
  maskBoxes: RasterBox[];
  optionalUnmatched: string[];
  maskedAreaRatio: number;
}

export type MaskResolutionFailureStatus = 'MASK_RESOLUTION_FAILED' | 'MASK_RATIO_POLICY_VIOLATION';

export class MaskResolutionError extends Error {
  constructor(
    public readonly status: MaskResolutionFailureStatus,
    public readonly entries: MaskResolutionEntry[],
    public readonly maskedAreaRatio: number,
    message: string
  ) {
    super(message);
    this.name = 'MaskResolutionError';
  }
}

/** Policy ceiling: masked area must not exceed 70% of the captured raster area. */
export const MASK_RATIO_POLICY_MAX = 0.7;

export interface EvalHostLike {
  evalJs(expression: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<unknown>;
}

/**
 * Transform one CSS-viewport mask box into raster coordinates relative to the
 * captured image buffer. Handles: crop origin offset (clipRect/selector),
 * full-page document scroll, and raster scale (DPR x zoom or measured ratio).
 */
export function transformMaskBoxToRaster(box: RasterBox, space: VisualCaptureSpace): RasterBox {
  const scaleX = Number.isFinite(space.scaleX) && space.scaleX > 0 ? space.scaleX : 1;
  const scaleY = Number.isFinite(space.scaleY) && space.scaleY > 0 ? space.scaleY : scaleX;
  const baseX = space.fullPage ? box.x + space.scrollX : box.x;
  const baseY = space.fullPage ? box.y + space.scrollY : box.y;
  const relX = space.crop ? baseX - space.crop.x : baseX;
  const relY = space.crop ? baseY - space.crop.y : baseY;
  // Pixel-grid convention: edges round independently, so the raster box covers
  // pixels [x, x+width) — the column at x+width is NOT masked. A box partially
  // off the left/top edge clips its extent instead of shifting it right/down.
  const left = Math.max(0, Math.round(relX * scaleX));
  const top = Math.max(0, Math.round(relY * scaleY));
  const right = Math.max(0, Math.round((relX + box.width) * scaleX));
  const bottom = Math.max(0, Math.round((relY + box.height) * scaleY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Space from declared device metrics (DPR x zoom); used when measured ratio is unavailable. */
export function visualCaptureSpaceFromMetrics(opts: {
  dpr?: number;
  zoom?: number;
  scrollX?: number;
  scrollY?: number;
  fullPage?: boolean;
  crop?: RasterBox;
}): VisualCaptureSpace {
  const dpr = typeof opts.dpr === 'number' && Number.isFinite(opts.dpr) && opts.dpr > 0 ? opts.dpr : 1;
  const zoom = typeof opts.zoom === 'number' && Number.isFinite(opts.zoom) && opts.zoom > 0 ? opts.zoom : 1;
  const scale = dpr * zoom;
  return {
    scaleX: scale,
    scaleY: scale,
    scrollX: opts.scrollX || 0,
    scrollY: opts.scrollY || 0,
    fullPage: Boolean(opts.fullPage),
    crop: opts.crop,
  };
}

/**
 * Space from measured raster/CSS ratios — self-calibrating, per-axis.
 * The denominator is the CAPTURED CSS width/height, not the viewport:
 *  - crop (selector/clipRect): captured width = crop.width, height = crop.height
 *  - fullPage: x from pngWidth/viewportWidth; y from pngHeight/cssDocumentHeight
 *  - plain viewport: png dims / viewport dims
 * A zero/unknown ratio yields 0 (callers fail closed when masks are present).
 */
export function visualCaptureSpaceFromMeasured(opts: {
  pngWidth: number;
  pngHeight: number;
  cssViewportWidth: number;
  cssViewportHeight?: number;
  /** document scroll height (fullPage denominator for y) */
  cssDocumentHeight?: number;
  scrollX?: number;
  scrollY?: number;
  fullPage?: boolean;
  crop?: RasterBox;
}): VisualCaptureSpace {
  const fullPage = Boolean(opts.fullPage);
  const crop = fullPage ? undefined : opts.crop;
  let scaleX: number;
  let scaleY: number;
  const viewportWidth = opts.cssViewportWidth > 0 ? opts.cssViewportWidth : 0;
  if (crop && crop.width > 0) {
    scaleX = opts.pngWidth > 0 ? opts.pngWidth / crop.width : 0;
    scaleY = crop.height > 0 && opts.pngHeight > 0 ? opts.pngHeight / crop.height : scaleX;
  } else if (fullPage) {
    scaleX = viewportWidth > 0 && opts.pngWidth > 0 ? opts.pngWidth / viewportWidth : 0;
    const docHeight = opts.cssDocumentHeight && opts.cssDocumentHeight > 0 ? opts.cssDocumentHeight : 0;
    scaleY = docHeight > 0 && opts.pngHeight > 0 ? opts.pngHeight / docHeight : scaleX;
  } else {
    scaleX = viewportWidth > 0 && opts.pngWidth > 0 ? opts.pngWidth / viewportWidth : 0;
    const viewportHeight = opts.cssViewportHeight && opts.cssViewportHeight > 0 ? opts.cssViewportHeight : 0;
    scaleY = viewportHeight > 0 && opts.pngHeight > 0 ? opts.pngHeight / viewportHeight : scaleX;
  }
  return {
    scaleX,
    scaleY,
    scrollX: opts.scrollX || 0,
    scrollY: opts.scrollY || 0,
    fullPage,
    crop,
  };
}

const maskQueryScript = (selectors: string[]): string => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const out = [];
  for (const sel of selectors) {
    try {
      const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      out.push({
        selector: sel,
        error: null,
        boxes: els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      });
    } catch (e) {
      out.push({
        selector: sel,
        error: String(e instanceof Error ? e.message : e),
        boxes: [],
      });
    }
  }
  return out;
})()`;

// Shape guard for an untrusted evalJs payload box. Fields must be finite numbers;
// the guard narrows before any member access so no unchecked cast is trusted.
function isRasterBoxLike(v: unknown): v is { x: number; y: number; width: number; height: number } {
  if (typeof v !== 'object' || v === null) return false;
  // v is validated above before any field read; indexing is safe after the object check.
  const o = v as Record<string, unknown>;
  const x = o.x;
  const y = o.y;
  const w = o.width;
  const h = o.height;
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof w === 'number' && Number.isFinite(w)
    && typeof h === 'number' && Number.isFinite(h);
}

/**
 * Fail-closed mask resolution. Every selector in `requiredSelectors` MUST resolve
 * to at least one visible box; a syntax error, evalJs failure, or zero-match for a
 * required selector throws MaskResolutionError — never falls back to unmasked
 * comparison. `optionalSelectors` may legitimately match nothing (recorded).
 */
export class MaskLedger {
  static async resolve(
    host: EvalHostLike,
    tabId: string | undefined,
    paneId: 'desktop' | 'mobile' | undefined,
    requiredSelectors: string[],
    optionalSelectors: string[]
  ): Promise<MaskResolutionEntry[]> {
    const required = Array.isArray(requiredSelectors) ? requiredSelectors : [];
    const optional = Array.isArray(optionalSelectors) ? optionalSelectors : [];
    const all = [...required, ...optional];
    if (all.length === 0) return [];

    let raw: unknown;
    try {
      raw = await host.evalJs(maskQueryScript(all), tabId, paneId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: MaskResolutionEntry[] = all.map((selector) => ({
        selector,
        required: required.includes(selector),
        status: 'eval-failed' as const,
        error: message,
        cssBoxes: [],
      }));
      throw new MaskResolutionError('MASK_RESOLUTION_FAILED', failed, 0, `Mask resolution eval failed on tab '${tabId}': ${message}`);
    }

    if (!Array.isArray(raw)) {
      const failed: MaskResolutionEntry[] = all.map((selector) => ({
        selector,
        required: required.includes(selector),
        status: 'eval-failed' as const,
        error: 'Mask resolution returned a non-array result',
        cssBoxes: [],
      }));
      throw new MaskResolutionError('MASK_RESOLUTION_FAILED', failed, 0, `Mask resolution returned a non-array result on tab '${tabId}'`);
    }

    const entries: MaskResolutionEntry[] = [];
    for (let i = 0; i < all.length; i++) {
      const selector = all[i]!;
      const isRequired = required.includes(selector);
      const item = raw[i] as { selector?: unknown; error?: unknown; boxes?: unknown } | undefined;
      const itemError = item && typeof item.error === 'string' && item.error.length > 0 ? item.error : null;
      const boxes = Array.isArray(item?.boxes) ? (item.boxes as unknown[]).filter(isRasterBoxLike) : [];

      let status: MaskResolutionEntry['status'];
      let error: string | undefined;
      if (itemError) {
        status = 'syntax-error';
        error = itemError;
      } else if (boxes.length === 0) {
        status = isRequired ? 'missing-required' : 'missing-optional';
      } else {
        status = 'resolved';
      }

      entries.push({
        selector,
        required: isRequired,
        status,
        error,
        cssBoxes: boxes.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
      });
    }

    const requiredFailures = entries.filter((e) => e.required && e.status !== 'resolved');
    if (requiredFailures.length > 0) {
      const detail = requiredFailures
        .map((e) => `${e.selector} -> ${e.status}${e.error ? ` (${e.error})` : ''}`)
        .join('; ');
      throw new MaskResolutionError('MASK_RESOLUTION_FAILED', entries, 0, `Required mask resolution failed: ${detail}`);
    }
    return entries;
  }
}

/**
 * Exact masked-pixel count: union of boxes clipped to the capture bounds.
 * Overlapping boxes count once; portions outside [0,boundW]x[0,boundH] are
 * ignored — the ratio policy measures real coverage, not a naive sum.
 */
export function clippedUnionArea(boxes: RasterBox[], boundW: number, boundH: number): number {
  const clipped: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  for (const box of boxes) {
    const x1 = Math.max(0, Math.round(box.x));
    const y1 = Math.max(0, Math.round(box.y));
    const x2 = Math.min(boundW, Math.round(box.x + box.width));
    const y2 = Math.min(boundH, Math.round(box.y + box.height));
    if (x2 > x1 && y2 > y1) clipped.push({ x1, x2, y1, y2 });
  }
  if (clipped.length === 0) return 0;

  const xs = Array.from(new Set(clipped.flatMap((c) => [c.x1, c.x2]))).sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const stripStart = xs[i]!;
    const stripEnd = xs[i + 1]!;
    const stripW = stripEnd - stripStart;
    if (stripW <= 0) continue;
    // A box spans an entire inter-coordinate strip or misses it entirely.
    const spans = clipped
      .filter((c) => c.x1 <= stripStart && c.x2 >= stripEnd)
      .map((c): [number, number] => [c.y1, c.y2])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let reach = Number.NEGATIVE_INFINITY;
    for (const [y1, y2] of spans) {
      if (y1 >= reach) {
        covered += y2 - y1;
        reach = y2;
      } else if (y2 > reach) {
        covered += y2 - reach;
        reach = y2;
      }
    }
    area += covered * stripW;
  }
  return area;
}

/**
 * Apply the side's capture space to resolved entries and enforce the masked-area
 * ratio policy. Masked area is the exact union of raster boxes clipped to the
 * capture bounds — overlaps count once, out-of-bounds portions are ignored —
 * so legitimate overlapping masks are not over-rejected.
 */
export function materializeRasterMasks(
  entries: MaskResolutionEntry[],
  space: VisualCaptureSpace | null,
  captureWidth: number,
  captureHeight: number,
  policyMaxRatio: number = MASK_RATIO_POLICY_MAX
): MaskLedgerResult {
  const resolved = entries.filter((e) => e.status === 'resolved');
  if (resolved.length === 0) {
    return {
      entries,
      maskBoxes: [],
      optionalUnmatched: entries.filter((e) => e.status === 'missing-optional').map((e) => e.selector),
      maskedAreaRatio: 0,
    };
  }
  if (!space || !(space.scaleX > 0) || !(space.scaleY > 0)) {
    throw new MaskResolutionError('MASK_RESOLUTION_FAILED', entries, 0, 'Cannot materialize raster masks without a positive capture scale');
  }
  if (!(captureWidth > 0) || !(captureHeight > 0)) {
    throw new MaskResolutionError('MASK_RESOLUTION_FAILED', entries, 0, 'Cannot materialize raster masks without known capture dimensions');
  }

  const rasterBoxes: RasterBox[] = [];
  for (const entry of resolved) {
    const boxes = entry.cssBoxes.map((box) => transformMaskBoxToRaster(box, space));
    entry.rasterBoxes = boxes;
    rasterBoxes.push(...boxes);
  }

  const maskedPixels = clippedUnionArea(rasterBoxes, captureWidth, captureHeight);
  const area = captureWidth * captureHeight;
  const maskedAreaRatio = Math.min(1, maskedPixels / area);
  if (maskedAreaRatio > policyMaxRatio) {
    throw new MaskResolutionError(
      'MASK_RATIO_POLICY_VIOLATION',
      entries,
      maskedAreaRatio,
      `Masked area ratio ${(maskedAreaRatio * 100).toFixed(1)}% exceeds policy ceiling ${(policyMaxRatio * 100).toFixed(0)}%`
    );
  }

  return {
    entries,
    maskBoxes: rasterBoxes,
    optionalUnmatched: entries.filter((e) => e.status === 'missing-optional').map((e) => e.selector),
    maskedAreaRatio,
  };
}

export function emptyMaskLedgerResult(): MaskLedgerResult {
  return { entries: [], maskBoxes: [], optionalUnmatched: [], maskedAreaRatio: 0 };
}

export const NORMALIZE_SCROLL_STYLE_ID = '__antifan_normalize_scroll';

const normalizeScrollInjectScript = (): string => `(() => {
  const ID = ${JSON.stringify(NORMALIZE_SCROLL_STYLE_ID)};
  if (document.getElementById(ID)) return false;
  const style = document.createElement('style');
  style.id = ID;
  style.dataset.antifanOwned = '1';
  style.textContent = 'html { overflow-y: scroll !important; scrollbar-gutter: stable !important; }';
  document.head.appendChild(style);
  return true;
})()`;

const normalizeScrollRestoreScript = (): string => `(() => {
  const el = document.getElementById(${JSON.stringify(NORMALIZE_SCROLL_STYLE_ID)});
  if (el && el.dataset.antifanOwned === '1') el.remove();
  return document.getElementById(${JSON.stringify(NORMALIZE_SCROLL_STYLE_ID)}) === null;
})()`;

/**
 * Immutable-shape per-side normalization receipt. Fields are written once per
 * stage (inject before compare, restore before delivery); an injected-but-not-
 * restored pair is an operational failure, never a clean run.
 */
export interface NormalizationReceipt {
  requested: boolean;
  /** true when the style element was present after our inject call */
  injected: boolean;
  /** true when THIS caller created the style element (owns cleanup) */
  owned: boolean;
  /** true when the owned element was confirmed removed */
  restored: boolean;
  injectError?: string;
  restoreError?: string;
}

export function emptyNormalizationReceipt(requested: boolean): NormalizationReceipt {
  return { requested, injected: false, owned: false, restored: false };
}

export interface NormalizationOutcome {
  ok: boolean;
  /** true when this caller created the style element (and therefore owns cleanup) */
  owned: boolean;
  error?: string;
}

/**
 * Scoped DOM normalization transaction. inject() reports ownership (true only
 * when THIS caller created the style element); restore() removes it only when
 * owned, preserving pre-existing page styles. Never throws — outcomes are
 * auditable (receipt fields), so a failed restore is recorded, not hidden:
 * callers must surface normalizeInjected/normalizeRestored on the receipt and
 * treat an injected-but-not-restored pair as an operational flag, never a clean
 * run. V-12 requires the restore call itself to run from finally — the outcome
 * proves it executed.
 */
export class NormalizationTransaction {
  static async inject(host: EvalHostLike, tabId: string | undefined, paneId: 'desktop' | 'mobile' | undefined): Promise<NormalizationOutcome> {
    try {
      const owned = (await host.evalJs(normalizeScrollInjectScript(), tabId, paneId)) === true;
      return { ok: true, owned };
    } catch (err: unknown) {
      return { ok: false, owned: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  static async restore(host: EvalHostLike, tabId: string | undefined, paneId: 'desktop' | 'mobile' | undefined, owned: boolean): Promise<NormalizationOutcome> {
    if (!owned) return { ok: true, owned: false };
    try {
      const removed = (await host.evalJs(normalizeScrollRestoreScript(), tabId, paneId)) === true;
      return removed
        ? { ok: true, owned: true }
        : { ok: false, owned: true, error: `Style element '${NORMALIZE_SCROLL_STYLE_ID}' still present after restore` };
    } catch (err: unknown) {
      return { ok: false, owned: true, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Keyed FIFO mutex with deterministic multi-key acquisition.
 * acquire(keys) sorts unique keys, waits for each key's queue in order, and
 * returns a release function. LIFO release; callers MUST release in finally.
 * Deadlock-free: a single global sort order means no lock-hold cycles.
 */
export class MultiKeyLock {
  // Per-key promise tails: runtime-inserted keys, FIFO semantics — Map is the
  // correct structure (dynamic membership, insertion order used as queue).
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(keys: string[]): Promise<() => Promise<void>> {
    const sorted = Array.from(new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))).sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of sorted) {
        const prev = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        this.tails.set(key, prev.then(() => gate));
        await prev;
        releases.push(release);
      }
    } catch (err) {
      for (const release of releases.reverse()) release();
      throw err;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }
}