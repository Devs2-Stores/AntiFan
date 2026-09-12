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

import * as zlib from 'node:zlib';
import type { MetricSample, VisualEvidenceReceipt } from './verification-contract';
import type { RouteRefusalCode as SharedRouteRefusalCode } from '../../shared/control-plane-contracts';
import type { GroupStructuralMetrics } from './visual-region';

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
  if (document.getElementById(ID)) return { owned: false, present: true };
  const style = document.createElement('style');
  style.id = ID;
  style.dataset.antifanOwned = '1';
  style.textContent = 'html { overflow-y: scroll !important; scrollbar-gutter: stable !important; }';
  document.head.appendChild(style);

  // Deterministically normalize viewport scroll state to top (0, 0)
  try {
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    }
    if (document.documentElement) {
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    }
    if (document.body) {
      document.body.scrollTop = 0;
      document.body.scrollLeft = 0;
    }
  } catch {}

  return { owned: true, present: !!document.getElementById(ID) };
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
  /** true when THIS caller created the style element (and therefore owns cleanup) */
  owned: boolean;
  /**
   * true when the style element was PRESENT after the inject call (created by us
   * or pre-existing). Presence is what symmetry classification needs; ownership
   * only gates restore (we never remove a style we did not create). Populated
   * by inject(); restore() outcomes omit it.
   */
  present?: boolean;
  error?: string;
}

/**
 * Scoped DOM normalization transaction. inject() reports ownership (true only
 * when THIS caller created the style element); restore() removes it only when
 * owned, preserving pre-existing page styles. Never throws — outcomes are
 * auditable (receipt fields), so a failed restore is recorded, not hidden:
 * callers must surface normalizeInjected/normalizeRestored on the receipt and
 * treat an injected-but-not-restored pair as an operational flag, never a clean
 * run. The restore call itself runs from finally — the outcome proves it executed.
 */
export class NormalizationTransaction {
  static async inject(host: EvalHostLike, tabId: string | undefined, paneId: 'desktop' | 'mobile' | undefined): Promise<NormalizationOutcome> {
    try {
      const raw = await host.evalJs(normalizeScrollInjectScript(), tabId, paneId);
      if (raw === true) return { ok: true, owned: true, present: true };
      if (raw && typeof raw === 'object') {
        const o = raw as { owned?: unknown; present?: unknown };
        return { ok: true, owned: o.owned === true, present: o.present === true };
      }
      // Unknown/absent payloads fail closed: not owned, assumed not normalized.
      return { ok: true, owned: false, present: false };
    } catch (err: unknown) {
      return { ok: false, owned: false, present: false, error: err instanceof Error ? err.message : String(err) };
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

/**
 * Two-source capture coherence primitives. A capture transaction is coherent
 * when, per side, the browser/document identity is unchanged and the DOM
 * mutation revision is stable across the capture window.
 */
export interface CaptureIdentitySnapshot {
  browserEpoch: number;
  documentGeneration: number;
  mutationRevision: number;
}

export type CoherenceVerdict = 'COHERENT' | 'RESAMPLE' | 'TARGET_STALE';

/**
 * Full classification between two snapshots:
 *  - browserEpoch or documentGeneration changed -> TARGET_STALE (navigation)
 *  - only mutationRevision changed -> RESAMPLE (same document, DOM mutated)
 *  - identical -> COHERENT
 */
export function classifyCoherence(before: CaptureIdentitySnapshot, after: CaptureIdentitySnapshot): CoherenceVerdict {
  if (after.browserEpoch !== before.browserEpoch || after.documentGeneration !== before.documentGeneration) {
    return 'TARGET_STALE';
  }
  if (after.mutationRevision !== before.mutationRevision) {
    return 'RESAMPLE';
  }
  return 'COHERENT';
}

/**
 * Identity-only classification (revision-insensitive): used across the
 * normalization-inject span, where our own style insertion legitimately moves
 * the mutation revision.
 */
export function classifyIdentity(preInject: CaptureIdentitySnapshot, after: CaptureIdentitySnapshot): CoherenceVerdict {
  if (after.browserEpoch !== preInject.browserEpoch || after.documentGeneration !== preInject.documentGeneration) {
    return 'TARGET_STALE';
  }
  return 'COHERENT';
}
/**
 * Mutation-only classification (identity-insensitive): checks whether the DOM
 * mutation revision advanced during the strict capture window.
 */
export function classifyMutation(window: CaptureIdentitySnapshot, after: CaptureIdentitySnapshot): CoherenceVerdict {
  return after.mutationRevision !== window.mutationRevision ? 'RESAMPLE' : 'COHERENT';
}

export interface CoherencePairCheck {
  preInject: CaptureIdentitySnapshot;
  postInject: CaptureIdentitySnapshot;
  afterCapture: CaptureIdentitySnapshot;
  /** TARGET_STALE when epoch/documentGeneration moved (identity span) */
  identity: CoherenceVerdict;
  /** RESAMPLE when mutationRevision moved after our inject (strict capture window) */
  mutation: CoherenceVerdict;
}

/**
 * Two coherence spans per side, so the check is not fooled by mutations our
 * own normalization inject introduces:
 *  1. recordPreInject   -> snapshot BEFORE any DOM write (navigation span)
 *  2. openMutationWindow-> snapshot AFTER the inject, BEFORE geometry/capture
 *  3. check             -> classify both spans against the post-capture snapshot
 */
export class TwoSourceCoherenceGuard {
  private readonly pairs = new Map<'target' | 'baseline', { pre: CaptureIdentitySnapshot; window: CaptureIdentitySnapshot | null }>();

  recordPreInject(side: 'target' | 'baseline', snapshot: CaptureIdentitySnapshot): void {
    this.pairs.set(side, { pre: { ...snapshot }, window: null });
  }

  openMutationWindow(side: 'target' | 'baseline', snapshot: CaptureIdentitySnapshot): void {
    const pair = this.pairs.get(side);
    if (!pair) {
      throw new Error(`TwoSourceCoherenceGuard: recordPreInject('${side}') is required before openMutationWindow`);
    }
    pair.window = { ...snapshot };
  }

  check(side: 'target' | 'baseline', after: CaptureIdentitySnapshot): CoherencePairCheck {
    const pair = this.pairs.get(side);
    if (!pair || !pair.window) {
      throw new Error(`TwoSourceCoherenceGuard: capture coherence window not open for side '${side}'`);
    }
    return {
      preInject: { ...pair.pre },
      postInject: { ...pair.window },
      afterCapture: { ...after },
      identity: classifyIdentity(pair.pre, after),
      mutation: classifyMutation(pair.window, after),
    };
  }

  /**
   * A pixel diff is only meaningful when both sides were captured under
   * symmetric normalization. Symmetry follows PRESENCE (both normalize-scroll
   * styles present, or both absent, free of inject errors). When the style is
   * present, ownership must also be symmetric on both sides: a pre-existing
   * element with our reserved ID carries unverified CSS content, so any
   * presence/ownership asymmetry cancels the diff with INCONCLUSIVE.
   */
  static normalizationSymmetric(target: NormalizationReceipt, baseline: NormalizationReceipt): boolean {
    if (!target.requested || !baseline.requested) return false;
    if (target.injectError || baseline.injectError) return false;
    if (target.injected !== baseline.injected) return false;
    if (!target.injected) return true; // both verified absent: comparable unnormalized layout
    return target.owned === baseline.owned && target.owned;
  }
}

/**
 * Receipt projection for a completed coherence check. The port's visualCompare
 * embeds this shape under `coherence` in every settled result.
 */
export function coherencePairReceipt(c: CoherencePairCheck): {
  preInject: CaptureIdentitySnapshot;
  postInject: CaptureIdentitySnapshot;
  afterCapture: CaptureIdentitySnapshot;
  identity: CoherenceVerdict;
  mutation: CoherenceVerdict;
} {
  return {
    preInject: c.preInject,
    postInject: c.postInject,
    afterCapture: c.afterCapture,
    identity: c.identity,
    mutation: c.mutation,
  };
}

/**
 * Capture lineage mode. `clip` wins over `full-page` when both are requested;
 * the combination captures an out-of-viewport rectangle.
 */
export type CaptureMode = 'viewport' | 'clip' | 'full-page';

/** Largest CSS capture dimension Chromium can composite in a single screenshot. */
export const CAPTURE_MAX_DIMENSION = 16384;

/**
 * Live render-surface geometry read from a tab's renderer in one bounded CDP
 * round-trip. A surface with `vw < 1` or `vh < 1` is alive but not composited:
 * bounded render work (capture, materialization) cannot complete on it, so
 * callers must refuse instead of fabricating a viewport.
 */
export interface RenderSurfaceSnapshot {
  vw: number;
  vh: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  docH: number;
  readyState: string;
  hidden: boolean;
}

export const RENDER_SURFACE_PROBE_EXPRESSION =
  '({ vw: window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0, ' +
  'vh: window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0, ' +
  'dpr: window.devicePixelRatio || 1, ' +
  'scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, ' +
  'docH: Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0), ' +
  'readyState: document.readyState || "unknown", hidden: document.hidden === true })';

/** Bound for the render-surface probe: small enough to fail fast, one round-trip. */
export const RENDER_SURFACE_PROBE_BOUND_MS = 3_000;

/** Classified cause for a rejected render surface, used to keep failures diagnosable. */
export function classifyRenderSurfaceCause(snapshot: Partial<RenderSurfaceSnapshot> | null | undefined): string {
  if (!snapshot) return 'probe-unavailable';
  if (snapshot.readyState && snapshot.readyState !== 'complete') return 'document-not-loaded';
  if (snapshot.hidden === true) return 'background-hidden';
  // This probe measures innerWidth/innerHeight only, so a zero reading means the
  // view has no bounds — it carries no compositor signal. Anything else stays
  // unclassified rather than claiming a cause the probe cannot observe.
  if (typeof snapshot.vw === 'number' && typeof snapshot.vh === 'number' && (snapshot.vw < 1 || snapshot.vh < 1)) return 'zero-viewport';
  return 'viewport-unmeasured';
}

/** Scroll step for the materialization walk, in CSS pixels. */
export const REFERENCE_MATERIALIZATION_STEP_PX = 400;
/** Dwell at each step so lazy observers can mount content before the next step. */
export const REFERENCE_MATERIALIZATION_DWELL_MS = 50;
/** Passes of the walk: the walk repeats while the document keeps growing. */
export const REFERENCE_MATERIALIZATION_MAX_PASSES = 6;
/** Bound for the whole materialization walk, including decode waits. */
export const REFERENCE_MATERIALIZATION_BOUND_MS = 30_000;

/**
 * Materialize lazily-mounted content in place: walk the document in bounded
 * steps so lazy observers fire, repeat while the document keeps growing, wait
 * for pending decodes, then return to the top. A clone built from a DOM that
 * never mounted its below-fold content is not the page the comparator rasterizes,
 * so this runs before any reference measurement, not after.
 */
export function buildReferenceMaterializationScript(): string {
  return `(async () => {
    const step = ${REFERENCE_MATERIALIZATION_STEP_PX};
    const dwell = ${REFERENCE_MATERIALIZATION_DWELL_MS};
    const maxPasses = ${REFERENCE_MATERIALIZATION_MAX_PASSES};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const height = () => Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    for (const img of Array.from(document.querySelectorAll('img[loading="lazy"]'))) {
      try { img.loading = 'eager'; } catch {}
    }
    const startY = window.scrollY || window.pageYOffset || 0;
    const docHeightBefore = height();
    const countPlaceholders = () => {
      let n = 0;
      for (const img of Array.from(document.images)) {
        const src = img.getAttribute('src') || '';
        if (!src || src.indexOf('data:') === 0 || !img.complete) n++;
      }
      return n;
    };
    const placeholdersBefore = countPlaceholders();
    let lastH = 0;
    let passes = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      passes = pass + 1;
      const H = height();
      for (let y = Math.max(0, lastH - step); y <= H; y += step) {
        window.scrollTo(0, y);
        await sleep(dwell);
      }
      window.scrollTo(0, H);
      await sleep(200);
      if (height() === H && pass >= 1) break;
      lastH = H;
    }
    let decoded = 0;
    try {
      const pending = Array.from(document.images).filter((i) => i.src && !i.complete);
      const work = pending.slice(0, 60).map((i) => (i.decode ? i.decode().catch(() => {}) : Promise.resolve()));
      await Promise.race([Promise.allSettled(work), sleep(6000)]);
      decoded = work.length;
    } catch {}
    window.scrollTo(0, startY);
    return {
      materialized: true,
      href: String(location.href || ''),
      passes,
      docHeightBefore,
      docHeight: height(),
      scrollYRestored: window.scrollY || 0,
      startY,
      decoded,
      imagesTotal: document.images.length,
      imagesStillPending: Array.from(document.images).filter((i) => i.src && !i.complete).length,
      placeholdersBefore,
      placeholdersAfter: countPlaceholders(),
    };
  })()`;
}

/**
 * Geometry before/after a capture that rasterizes beyond the viewport. Evidence
 * capture must leave the tab's layout viewport and scroll offset where it found
 * them; a capture that cannot prove restoration is a failed capture.
 */
export interface CaptureViewportTransaction {
  before: { width: number; height: number; scrollX: number; scrollY: number } | null;
  after: { width: number; height: number; scrollX: number; scrollY: number } | null;
  restored: boolean;
  attempts: number;
  /**
   * True when restoration could not be attempted inline because the CDP
   * transport was draining; the caller must run `reapplyTabGeometry` after the
   * target is drained instead of treating the tab as unrestorable.
   */
  deferred?: boolean;
}

/**
 * Canonical verification capture envelope returned by CDP Page.captureScreenshot.
 */
export interface VerificationCaptureEnvelope {
  data: string;
  backend: 'cdp' | string;
  dpr: number;
  zoom: number;
  cssViewport: { width: number; height: number };
  /** CSS size of the actually captured region (viewport | clip | document). */
  cssCaptureSize: { width: number; height: number };
  rasterSize: { width: number; height: number };
  captureMode: CaptureMode;
  timestamp: number;
  /** Layout-viewport movement caused by the capture and whether it was restored. */
  viewportTransaction?: CaptureViewportTransaction;
  expectedUrl?: string | null;
  expectationMarker?: 'URL_EXPECTATION_MISSING';
  missingExpectation?: boolean;
  routeAssertion?: RouteAssertionResult;
}

/**
 * Capture receipt projected into visual-compare result metadata.
 */
export interface VerificationCaptureReceipt {
  backend: string;
  dpr: number;
  zoom: number;
  cssViewport: { width: number; height: number };
  cssCaptureSize: { width: number; height: number };
  rasterSize: { width: number; height: number };
  captureMode: CaptureMode;
  timestamp: number;
  viewportTransaction?: CaptureViewportTransaction;
  expectedUrl?: string | null;
  expectationMarker?: 'URL_EXPECTATION_MISSING';
  missingExpectation?: boolean;
  routeAssertion?: RouteAssertionResult;
}

export function verificationCaptureReceipt(env: VerificationCaptureEnvelope): VerificationCaptureReceipt {
  return {
    backend: env.backend,
    dpr: env.dpr,
    zoom: env.zoom,
    cssViewport: { width: env.cssViewport.width, height: env.cssViewport.height },
    cssCaptureSize: { width: env.cssCaptureSize.width, height: env.cssCaptureSize.height },
    rasterSize: { width: env.rasterSize.width, height: env.rasterSize.height },
    captureMode: env.captureMode,
    timestamp: env.timestamp,
    ...(env.viewportTransaction ? { viewportTransaction: env.viewportTransaction } : {}),
    expectedUrl: env.expectedUrl ?? null,
    ...(env.expectationMarker ? { expectationMarker: env.expectationMarker } : {}),
    ...(env.missingExpectation ? { missingExpectation: env.missingExpectation } : {}),
    ...(env.routeAssertion ? { routeAssertion: env.routeAssertion } : {}),
  };
}

/**
 * Artifact-backed evidence envelope returned by the screenshot capabilities.
 * `artifactRef` is an ArtifactRef when an artifact store is bound, otherwise the
 * inline base64 payload bounded by the caller's byte limit.
 */
export interface EvidenceCaptureEnvelope {
  ok: true;
  artifactRef: unknown;
  receipt: VerificationCaptureReceipt;
  sha256: string;
  byteLength: number;
  leaseToken?: string;
}

/**
 * Typed capture failure codes. Callers route these to quarantine, retry, or
 * human escalation decisions; never collapse them into a generic message.
 */
export type CaptureFailureCode =
  | 'FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN'
  | 'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY'
  | 'FULLPAGE_CAPTURE_UNSUPPORTED_FORMAT'
  | 'CAPTURE_TIMEOUT'
  | 'CAPTURE_EMPTY_PAYLOAD'
  | 'CAPTURE_PNG_SIGNATURE_INVALID'
  | 'CAPTURE_PNG_TRUNCATED'
  | 'CAPTURE_PNG_UNDECODABLE'
  | 'CAPTURE_JPEG_SIGNATURE_INVALID'
  | 'CAPTURE_JPEG_TRUNCATED'
  | 'CAPTURE_JPEG_UNDECODABLE'
  | 'CAPTURE_SCALE_MISMATCH'
  | 'TARGET_BUSY_DRAINING'
  | 'NO_RENDER_SURFACE'
  | 'CAPTURE_VIEWPORT_NOT_RESTORED'
  | 'CAPTURE_NOT_READY'
  | 'SETTLE_PREDICATE_FAILED'
  | 'IMAGE_IDENTITY_UNSTABLE'
  | 'DOCUMENT_GENERATION_UNSETTLED'
  | 'URL_HOST_MISMATCH'
  | 'URL_THEME_MISMATCH'
  | 'URL_PATH_MISMATCH'
  | 'URL_EXPECTATION_MISSING';

export type RouteRefusalCode = SharedRouteRefusalCode;

export type RouteAssertionResult =
  | {
      ok: true;
      status: 'MATCH' | 'URL_EXPECTATION_MISSING';
      requestedUrl: string | null;
      expectedUrl: string | null;
      observedUrl: string;
      redirectChain: string[];
      code?: 'URL_EXPECTATION_MISSING';
      reason?: string;
    }
  | {
      ok: false;
      status: RouteRefusalCode;
      code: RouteRefusalCode;
      reason: string;
      requestedUrl: string | null;
      expectedUrl: string | null;
      observedUrl: string;
      redirectChain: string[];
    };

export function normalizeRoutePath(pathname: string): string {
  if (!pathname) return '/';
  const stripped = pathname.replace(/\/+$/, '');
  return stripped.length === 0 ? '/' : stripped;
}

export function checkRouteIdentity(
  expectedUrl: string | null | undefined,
  observedUrl: string,
  redirectChain: string[] = []
): RouteAssertionResult {
  const safeObserved = String(observedUrl || '').trim();
  const safeChain = Array.isArray(redirectChain) ? [...redirectChain] : [];

  if (!expectedUrl || typeof expectedUrl !== 'string' || expectedUrl.trim().length === 0) {
    return {
      ok: true,
      status: 'URL_EXPECTATION_MISSING',
      requestedUrl: null,
      expectedUrl: null,
      observedUrl: safeObserved,
      redirectChain: safeChain,
      code: 'URL_EXPECTATION_MISSING',
      reason: 'No expected URL was supplied for route identity assertion',
    };
  }

  const trimmedExpected = expectedUrl.trim();
  let expectedParsed: URL;
  let observedParsed: URL;
  try {
    expectedParsed = new URL(trimmedExpected);
  } catch (err) {
    return {
      ok: false,
      status: 'URL_HOST_MISMATCH',
      code: 'URL_HOST_MISMATCH',
      requestedUrl: trimmedExpected,
      expectedUrl: trimmedExpected,
      observedUrl: safeObserved,
      redirectChain: safeChain,
      reason: `Malformed expected URL '${trimmedExpected}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    observedParsed = new URL(safeObserved);
  } catch (err) {
    return {
      ok: false,
      status: 'URL_HOST_MISMATCH',
      code: 'URL_HOST_MISMATCH',
      requestedUrl: trimmedExpected,
      expectedUrl: trimmedExpected,
      observedUrl: safeObserved,
      redirectChain: safeChain,
      reason: `Malformed observed URL '${safeObserved}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 1. Host mismatch check
  if (expectedParsed.host.toLowerCase() !== observedParsed.host.toLowerCase()) {
    return {
      ok: false,
      status: 'URL_HOST_MISMATCH',
      code: 'URL_HOST_MISMATCH',
      requestedUrl: trimmedExpected,
      expectedUrl: trimmedExpected,
      observedUrl: safeObserved,
      redirectChain: safeChain,
      reason: `Requested host '${expectedParsed.host}' does not match observed host '${observedParsed.host}'`,
    };
  }

  // 2. Theme mismatch check (when themeid query param is specified in expected URL)
  const expectedTheme = expectedParsed.searchParams.get('themeid');
  const observedTheme = observedParsed.searchParams.get('themeid');
  if (expectedTheme !== null && observedTheme !== expectedTheme) {
    return {
      ok: false,
      status: 'URL_THEME_MISMATCH',
      code: 'URL_THEME_MISMATCH',
      requestedUrl: trimmedExpected,
      expectedUrl: trimmedExpected,
      observedUrl: safeObserved,
      redirectChain: safeChain,
      reason: `Requested themeid '${expectedTheme}' does not match observed themeid '${observedTheme ?? '<none>'}'`,
    };
  }

  // 3. Path mismatch check (origin + pathname identity)
  const expectedPath = normalizeRoutePath(expectedParsed.pathname);
  const observedPath = normalizeRoutePath(observedParsed.pathname);
  if (expectedPath !== observedPath) {
    return {
      ok: false,
      status: 'URL_PATH_MISMATCH',
      code: 'URL_PATH_MISMATCH',
      requestedUrl: trimmedExpected,
      expectedUrl: trimmedExpected,
      observedUrl: safeObserved,
      redirectChain: safeChain,
      reason: `Requested pathname '${expectedPath}' does not match observed pathname '${observedPath}'`,
    };
  }

  return {
    ok: true,
    status: 'MATCH',
    requestedUrl: trimmedExpected,
    expectedUrl: trimmedExpected,
    observedUrl: safeObserved,
    redirectChain: safeChain,
  };
}
export class CaptureError extends Error {
  constructor(
    public readonly code: CaptureFailureCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

export interface PngValidation {
  ok: boolean;
  code?: CaptureFailureCode;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Start-of-frame markers that carry real image dimensions. */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Markers with no length field. */
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd8, 0xd9, ...Array.from({ length: 8 }, (_, i) => 0xd0 + i)]);

/**
 * Pure JPEG integrity gate: SOI/EOI framing plus a SOF marker carrying real
 * dimensions. A truncated or dimension-less payload never yields a receipt.
 */
export function validateJpegBuffer(buf: Buffer): PngValidation {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, code: 'CAPTURE_EMPTY_PAYLOAD', width: 0, height: 0 };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { ok: false, code: 'CAPTURE_JPEG_SIGNATURE_INVALID', width: 0, height: 0 };
  }
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    return { ok: false, code: 'CAPTURE_JPEG_TRUNCATED', width: 0, height: 0 };
  }
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) {
      // Entropy-coded scan data is only reachable after a valid SOF.
      return { ok: false, code: 'CAPTURE_JPEG_UNDECODABLE', width: 0, height: 0 };
    }
    let marker = buf[offset + 1] ?? 0;
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1] ?? 0;
    }
    offset += 2;
    if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
    if (offset + 1 >= buf.length) break;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buf.length) {
      return { ok: false, code: 'CAPTURE_JPEG_TRUNCATED', width: 0, height: 0 };
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        return { ok: false, code: 'CAPTURE_JPEG_UNDECODABLE', width: 0, height: 0 };
      }
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) {
        return { ok: false, code: 'CAPTURE_JPEG_UNDECODABLE', width, height };
      }
      return { ok: true, width, height };
    }
    if (marker === 0xda) {
      // Start of scan before any SOF: dimensions can never be reported.
      return { ok: false, code: 'CAPTURE_JPEG_UNDECODABLE', width: 0, height: 0 };
    }
    offset += segmentLength;
  }
  return { ok: false, code: 'CAPTURE_JPEG_UNDECODABLE', width: 0, height: 0 };
}

/**
 * Pure PNG integrity gate: signature, chunk bounds, IHDR dimensions, terminal
 * IEND, and a real zlib inflate of the concatenated IDAT payload. A base64
 * payload that merely decodes is never treated as valid image evidence.
 */
export function validatePngBuffer(buf: Buffer): PngValidation {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, code: 'CAPTURE_EMPTY_PAYLOAD', width: 0, height: 0 };
  }
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { ok: false, code: 'CAPTURE_PNG_SIGNATURE_INVALID', width: 0, height: 0 };
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const chunkLength = buf.readUInt32BE(offset);
    const chunkType = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd + 4 > buf.length) {
      return { ok: false, code: 'CAPTURE_PNG_TRUNCATED', width, height };
    }
    if (!sawIhdr) {
      if (chunkType !== 'IHDR' || chunkLength !== 13) {
        return { ok: false, code: 'CAPTURE_PNG_UNDECODABLE', width: 0, height: 0 };
      }
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      if (width <= 0 || height <= 0) {
        return { ok: false, code: 'CAPTURE_PNG_UNDECODABLE', width, height };
      }
      sawIhdr = true;
    } else if (chunkType === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (chunkType === 'IEND') {
      if (chunkLength !== 0) {
        return { ok: false, code: 'CAPTURE_PNG_UNDECODABLE', width, height };
      }
      sawIend = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!sawIhdr) {
    return { ok: false, code: 'CAPTURE_PNG_TRUNCATED', width: 0, height: 0 };
  }
  if (!sawIend) {
    return { ok: false, code: 'CAPTURE_PNG_TRUNCATED', width, height };
  }
  // IEND is terminal: trailing bytes mean the payload is not exactly one PNG.
  if (offset !== buf.length) {
    return { ok: false, code: 'CAPTURE_PNG_UNDECODABLE', width, height };
  }
  if (idatChunks.length === 0) {
    return { ok: false, code: 'CAPTURE_PNG_UNDECODABLE', width, height };
  }
  try {
    zlib.inflateSync(Buffer.concat(idatChunks));
  } catch {
    return { ok: false, code: 'CAPTURE_PNG_UNDECODABLE', width, height };
  }
  return { ok: true, width, height };
}

/** Pure. True when raster ≈ css * dpr * zoom within 1px per axis. */
export function rasterMatchesCss(
  raster: { width: number; height: number },
  css: { width: number; height: number },
  dpr: number,
  zoom: number
): boolean {
  if (!raster || !css) return false;
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!positive(dpr) || !positive(zoom)) return false;
  if (!positive(raster.width) || !positive(raster.height) || !positive(css.width) || !positive(css.height)) return false;
  const scale = dpr * zoom;
  const matchesDpr = Math.abs(raster.width - css.width * scale) <= 1 && Math.abs(raster.height - css.height * scale) <= 1;
  if (matchesDpr) return true;
  // CDP Page.captureScreenshot in viewport mode or standard desktop backings produces 1x CSS raster (zoom-scaled)
  const matches1x = Math.abs(raster.width - css.width * zoom) <= 1 && Math.abs(raster.height - css.height * zoom) <= 1;
  return matches1x;
}

/**
 * Mode precedence: rect && fullPage -> 'clip' (captureBeyondViewport),
 * rect -> 'clip', fullPage -> 'full-page', else 'viewport'. Pure.
 */
export function resolveCaptureMode(rect: unknown, fullPage?: boolean): CaptureMode {
  if (rect !== null && rect !== undefined && typeof rect === 'object') return 'clip';
  return fullPage ? 'full-page' : 'viewport';
}

/**
 * Pure compatibility gate checking whether baseline and current captures are
 * comparable before computing a pixel diff. Discrepancies in backend, capture
 * mode, DPR, zoom, CSS viewport, or CSS capture size make pixel comparisons
 * inconclusive.
 */
export function checkCaptureStateCompatibility(
  target: VerificationCaptureReceipt,
  baseline: VerificationCaptureReceipt
): { compatible: boolean; reason?: string } {
  if (!target || !baseline) {
    return { compatible: false, reason: 'Capture receipt is missing or undefined' };
  }
  if (typeof target.backend !== 'string' || typeof baseline.backend !== 'string' || target.backend !== baseline.backend) {
    return {
      compatible: false,
      reason: `Capture backend mismatch: target '${target?.backend}' vs baseline '${baseline?.backend}'`,
    };
  }
  if (typeof target.captureMode !== 'string' || typeof baseline.captureMode !== 'string' || target.captureMode !== baseline.captureMode) {
    return {
      compatible: false,
      reason: `Capture mode mismatch: target '${target?.captureMode}' vs baseline '${baseline?.captureMode}'`,
    };
  }
  if (!Number.isFinite(target.dpr) || !Number.isFinite(baseline.dpr) || target.dpr <= 0 || baseline.dpr <= 0) {
    return { compatible: false, reason: `Invalid device pixel ratio: target ${target.dpr} vs baseline ${baseline.dpr}` };
  }
  if (Math.abs(target.dpr - baseline.dpr) > 0.01) {
    return {
      compatible: false,
      reason: `Device pixel ratio mismatch: target ${target.dpr} vs baseline ${baseline.dpr}`,
    };
  }
  if (!Number.isFinite(target.zoom) || !Number.isFinite(baseline.zoom) || target.zoom <= 0 || baseline.zoom <= 0) {
    return { compatible: false, reason: `Invalid zoom level: target ${target.zoom} vs baseline ${baseline.zoom}` };
  }
  if (Math.abs(target.zoom - baseline.zoom) > 0.01) {
    return {
      compatible: false,
      reason: `Zoom level mismatch: target ${target.zoom} vs baseline ${baseline.zoom}`,
    };
  }
  const tVw = target.cssViewport?.width;
  const tVh = target.cssViewport?.height;
  const bVw = baseline.cssViewport?.width;
  const bVh = baseline.cssViewport?.height;
  if (!Number.isFinite(tVw) || !Number.isFinite(tVh) || !Number.isFinite(bVw) || !Number.isFinite(bVh) || tVw <= 0 || tVh <= 0 || bVw <= 0 || bVh <= 0) {
    return { compatible: false, reason: `Invalid CSS viewport dimensions: target ${tVw}x${tVh} vs baseline ${bVw}x${bVh}` };
  }
  if (Math.abs(tVw - bVw) > 1 || Math.abs(tVh - bVh) > 1) {
    return {
      compatible: false,
      reason: `CSS viewport dimension mismatch: target ${tVw}x${tVh} vs baseline ${bVw}x${bVh}`,
    };
  }
  const tCw = target.cssCaptureSize?.width;
  const tCh = target.cssCaptureSize?.height;
  const bCw = baseline.cssCaptureSize?.width;
  const bCh = baseline.cssCaptureSize?.height;
  if (!Number.isFinite(tCw) || !Number.isFinite(tCh) || !Number.isFinite(bCw) || !Number.isFinite(bCh) || tCw <= 0 || tCh <= 0 || bCw <= 0 || bCh <= 0) {
    return { compatible: false, reason: `Invalid CSS capture dimensions: target ${tCw}x${tCh} vs baseline ${bCw}x${bCh}` };
  }
  if (Math.abs(tCw - bCw) > 1) {
    return {
      compatible: false,
      reason: `CSS capture size mismatch: target ${tCw}x${tCh} vs baseline ${bCw}x${bCh}`,
    };
  }
  if (target.captureMode !== 'full-page') {
    if (Math.abs(tCh - bCh) > 1) {
      return {
        compatible: false,
        reason: `CSS capture size mismatch: target ${tCw}x${tCh} vs baseline ${bCw}x${bCh}`,
      };
    }
  }
  return { compatible: true };
}

export interface VisualStructuralMetrics {
  geometryWithinTolerance?: boolean;
  deltaGeometry?: number;
  cardinalityMatch?: boolean;
  deltaCardinality?: number;
  groups?: Record<string, GroupStructuralMetrics>;
}

/**
 * Generates canonical visual and structural MetricSample[] for VerificationEvaluator (Audit v5 §16, §25, Freeze #13/#14).
 * Operational callers (visualCompare) emit these samples; VerificationEvaluator alone issues verdicts.
 */
export function generateVisualMetricSamples(params: {
  diffResult?: {
    match: boolean;
    mismatchPercentage: number;
    dimensionsMatch: boolean;
  };
  captureStateCompatible: boolean;
  maskResolutionStatus: string;
  settleComplete: boolean;
  structural?: VisualStructuralMetrics;
}): MetricSample[] {
  const samples: MetricSample[] = [];

  if (params.diffResult) {
    const mismatchPct = params.diffResult.mismatchPercentage;
    samples.push({
      metric: 'visual.pixel_mismatch_pct',
      value: mismatchPct,
      actual: mismatchPct,
      delta: mismatchPct,
      source: 'deterministic',
      message: `Visual pixel mismatch: ${mismatchPct}%`,
    });

    const dimMatch = params.diffResult.dimensionsMatch;
    samples.push({
      metric: 'visual.dimensions_match',
      value: dimMatch,
      actual: dimMatch,
      passed: dimMatch,
      source: 'deterministic',
      message: dimMatch ? 'Dimensions match between target and baseline' : 'Dimensions mismatch between target and baseline',
    });
  }
  samples.push({
    metric: 'visual.capture_state_compatible',
    value: params.captureStateCompatible,
    passed: params.captureStateCompatible,
    source: 'deterministic',
    message: params.captureStateCompatible ? 'Capture state compatible (DPR, zoom, viewport match)' : 'Capture state incompatible',
  });

  const maskOk = params.maskResolutionStatus === 'ok';
  samples.push({
    metric: 'visual.mask_resolution_complete',
    value: maskOk,
    passed: maskOk,
    source: 'deterministic',
    message: maskOk ? 'All required masks resolved successfully' : `Mask resolution status: ${params.maskResolutionStatus}`,
  });

  samples.push({
    metric: 'visual.settle_complete',
    value: params.settleComplete,
    passed: params.settleComplete,
    source: 'deterministic',
    message: params.settleComplete ? 'All capture settle barriers passed (network, fonts, images, DOM)' : 'Capture settle barriers incomplete',
  });

  if (params.structural) {
    if (params.structural.geometryWithinTolerance !== undefined) {
      samples.push({
        metric: 'visual.geometry_within_tolerance',
        value: params.structural.geometryWithinTolerance,
        delta: params.structural.deltaGeometry,
        passed: params.structural.geometryWithinTolerance,
        source: 'deterministic',
        message: params.structural.geometryWithinTolerance
          ? 'Structural geometry within tolerance'
          : `Structural geometry shifted by ${params.structural.deltaGeometry ?? 'exceeded'}px`,
      });
    }

    if (params.structural.cardinalityMatch !== undefined) {
      samples.push({
        metric: 'visual.cardinality_match',
        value: params.structural.cardinalityMatch,
        delta: params.structural.deltaCardinality,
        passed: params.structural.cardinalityMatch,
        source: 'deterministic',
        message: params.structural.cardinalityMatch
          ? 'Element cardinality matches'
          : `Element cardinality mismatch (delta: ${params.structural.deltaCardinality ?? 'mismatch'})`,
      });
    }
  }

  return samples;
}

/**
 * Builds the canonical VisualEvidenceReceipt matching the verification-contract (Audit v5 §16, §25).
 */
export function createVisualEvidenceReceipt(params: {
  match: boolean;
  mismatchPercentage: number;
  dimensionsMatch: boolean;
  captureStateCompatible: boolean;
  maskResolutionStatus: string;
  maskedAreaRatio: number;
  settleComplete: boolean;
  metricSamples: MetricSample[];
  notes?: string;
  expectationMarker?: 'URL_EXPECTATION_MISSING';
  missingExpectation?: boolean;
  routeAssertion?: RouteAssertionResult;
}): VisualEvidenceReceipt {
  const isMissingExpectation = params.expectationMarker === 'URL_EXPECTATION_MISSING'
    || params.missingExpectation === true
    || params.routeAssertion?.status === 'URL_EXPECTATION_MISSING';
  const notes = isMissingExpectation
    ? `${params.notes ? `${params.notes}; ` : ''}URL_EXPECTATION_MISSING: capture identity was not asserted against an expected route`
    : params.notes;
  return {
    match: isMissingExpectation ? false : params.match,
    mismatchPercentage: isMissingExpectation ? 100 : params.mismatchPercentage,
    dimensionsMatch: params.dimensionsMatch,
    captureStateCompatible: params.captureStateCompatible,
    maskResolutionStatus: params.maskResolutionStatus,
    maskedAreaRatio: params.maskedAreaRatio,
    settleComplete: params.settleComplete,
    metricSamples: params.metricSamples,
    notes,
  };
}