import { CapabilityError } from '../../shared/control-plane-contracts';
import { COMPARE_DEFAULT_TOLERANCE_PERCENT, readCompareReceipt, type CompareReceiptRecord } from './compare-receipt-store';

/**
 * Turns the `baselineViewports` a caller passes to a QA run into numbers the workflow may grade.
 *
 * An entry that cites `compareReceiptId` is resolved against the host's own comparison ledger and its
 * numbers come from the ledger record, never from the caller. An entry that carries raw
 * `{mismatchPercent, passed}` is still accepted so existing callers keep working, but it is labelled
 * `caller-asserted`, and the workflow will not call a run CERTIFIED on numbers nobody measured.
 */

export const BASELINE_VIEWPORT_NAMES = ['desktop', 'tablet', 'mobile'] as const;
export type BaselineViewportName = (typeof BASELINE_VIEWPORT_NAMES)[number];

export type BaselineViewportEntry =
  | { compareReceiptId: string }
  | { mismatchPercent: number; passed: boolean };

export type BaselineViewportsInput = Partial<Record<BaselineViewportName, BaselineViewportEntry>>;

export type BaselineProvenanceKind = 'compare-receipt' | 'caller-asserted';

export interface BaselineProvenanceRejection {
  viewport: string;
  code:
    | 'RECEIPT_NOT_FOUND'
    | 'NOT_A_BASELINE_COMPARE'
    | 'ORIGIN_MISMATCH'
    | 'ORIGIN_UNKNOWN'
    | 'PATH_MISMATCH'
    | 'PATH_UNKNOWN'
    | 'PARTIAL_COMPARE'
    | 'MASK_RATIO_TOO_HIGH'
    | 'TOLERANCE_TOO_LOOSE'
    | 'PANE_MISMATCH'
    | 'VIEWPORT_MISMATCH'
    | 'VIEWPORT_MISSING'
    | 'RECEIPT_STALE'
    | 'RECEIPT_FROM_FUTURE'
    | 'SETTLE_INCOMPLETE';
  detail: string;
}

export interface ResolvedBaselineViewports {
  viewports?: Partial<Record<BaselineViewportName, { mismatchPercent: number; passed: boolean }>>;
  provenance: Record<string, BaselineProvenanceKind>;
  rejections: BaselineProvenanceRejection[];
}

export const BASELINE_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest share of the compared area masks may hide before the comparison stops standing for the page. */
export const BASELINE_MAX_MASKED_AREA_RATIO = 0.1;
/** Clock skew tolerated between the process that minted a receipt and the one that resolves it. */
const FUTURE_SKEW_MS = 60_000;
export const TABLET_MIN_WIDTH = 768;
export const TABLET_MAX_WIDTH = 1100;

/** Standard viewport a CSS width belongs to: below 768 mobile, 768 to 1100 tablet, above 1100 desktop. */
export function viewportNameForWidth(width: number): BaselineViewportName {
  if (width < TABLET_MIN_WIDTH) return 'mobile';
  if (width <= TABLET_MAX_WIDTH) return 'tablet';
  return 'desktop';
}

export function parseBaselineViewportsInput(value: unknown, label: string): BaselineViewportsInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityError('INVALID_ARGUMENT', `${label} must be an object keyed by desktop, tablet and mobile`);
  }
  const raw = value as Record<string, unknown>;
  const out: BaselineViewportsInput = {};
  for (const key of Object.keys(raw)) {
    if (!(BASELINE_VIEWPORT_NAMES as readonly string[]).includes(key)) {
      throw new CapabilityError('INVALID_ARGUMENT', `${label}.${key} is not a baseline viewport; expected ${BASELINE_VIEWPORT_NAMES.join(', ')}`);
    }
    const entry = raw[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CapabilityError('INVALID_ARGUMENT', `${label}.${key} must be an object with compareReceiptId, or a numeric mismatchPercent and a boolean passed`);
    }
    const { compareReceiptId, mismatchPercent, passed } = entry as { compareReceiptId?: unknown; mismatchPercent?: unknown; passed?: unknown };
    if (compareReceiptId !== undefined) {
      if (typeof compareReceiptId !== 'string' || compareReceiptId.trim().length === 0) {
        throw new CapabilityError('INVALID_ARGUMENT', `${label}.${key}.compareReceiptId must be the compareId string anti.visual.compare returned`);
      }
      out[key as BaselineViewportName] = { compareReceiptId: compareReceiptId.trim() };
      continue;
    }
    if (typeof mismatchPercent !== 'number' || !Number.isFinite(mismatchPercent) || typeof passed !== 'boolean') {
      throw new CapabilityError('INVALID_ARGUMENT', `${label}.${key} needs compareReceiptId (preferred), or a numeric mismatchPercent and a boolean passed`);
    }
    out[key as BaselineViewportName] = { mismatchPercent, passed };
  }
  return out;
}

function checkReceipt(
  name: BaselineViewportName,
  record: CompareReceiptRecord,
  ctx: { origin: string | null; pathname: string | null; nowMs: number; ttlMs: number }
): BaselineProvenanceRejection | null {
  if (record.comparisonKind !== 'baseline') {
    return { viewport: name, code: 'NOT_A_BASELINE_COMPARE', detail: `compare ${record.id} compared two live tabs, not a tab against the promoted baseline` };
  }
  if (ctx.origin === null) {
    return { viewport: name, code: 'ORIGIN_UNKNOWN', detail: 'the QA tab origin is unknown, so the comparison cannot be tied to this storefront' };
  }
  if (record.origin !== ctx.origin) {
    return { viewport: name, code: 'ORIGIN_MISMATCH', detail: `compare ${record.id} measured ${record.origin ?? 'an unknown origin'}, the QA tab is ${ctx.origin}` };
  }
  if (ctx.pathname === null) {
    return { viewport: name, code: 'PATH_UNKNOWN', detail: 'the QA tab route is unknown, so the comparison cannot be tied to this page' };
  }
  if (record.pathname === null || record.pathname === undefined) {
    return { viewport: name, code: 'PATH_UNKNOWN', detail: `compare ${record.id} recorded no route` };
  }
  if (record.pathname !== ctx.pathname) {
    return { viewport: name, code: 'PATH_MISMATCH', detail: `compare ${record.id} measured ${record.pathname}, the QA tab is on ${ctx.pathname}` };
  }
  if (record.clipped || record.selector) {
    return { viewport: name, code: 'PARTIAL_COMPARE', detail: `compare ${record.id} covered ${record.selector ? `the element ${record.selector}` : 'a clipped region'}, not the whole page` };
  }
  if (record.maskedAreaRatio !== null && record.maskedAreaRatio > BASELINE_MAX_MASKED_AREA_RATIO) {
    return { viewport: name, code: 'MASK_RATIO_TOO_HIGH', detail: `compare ${record.id} masked ${(record.maskedAreaRatio * 100).toFixed(1)}% of the page; the limit is ${(BASELINE_MAX_MASKED_AREA_RATIO * 100).toFixed(0)}%` };
  }
  if (typeof record.tolerancePercent !== 'number' || record.tolerancePercent > COMPARE_DEFAULT_TOLERANCE_PERCENT) {
    return {
      viewport: name,
      code: 'TOLERANCE_TOO_LOOSE',
      detail: typeof record.tolerancePercent === 'number'
        ? `compare ${record.id} allowed ${record.tolerancePercent}% mismatch; the limit is ${COMPARE_DEFAULT_TOLERANCE_PERCENT}%`
        : `compare ${record.id} recorded no tolerance`,
    };
  }
  if (!record.viewport) {
    return { viewport: name, code: 'VIEWPORT_MISSING', detail: `compare ${record.id} recorded no viewport size` };
  }
  const measured = viewportNameForWidth(record.viewport.width);
  if (measured !== name) {
    return { viewport: name, code: 'VIEWPORT_MISMATCH', detail: `compare ${record.id} measured ${record.viewport.width}px, which is the ${measured} size, not ${name}` };
  }
  if (record.paneId === 'mobile' && name !== 'mobile') {
    return { viewport: name, code: 'PANE_MISMATCH', detail: `compare ${record.id} was taken in the mobile pane, so it cannot stand for the ${name} size` };
  }
  if (record.settleComplete === false) {
    return { viewport: name, code: 'SETTLE_INCOMPLETE', detail: `compare ${record.id} was captured before the page settled` };
  }
  const age = ctx.nowMs - Date.parse(record.createdAt);
  if (age < -FUTURE_SKEW_MS) {
    return { viewport: name, code: 'RECEIPT_FROM_FUTURE', detail: `compare ${record.id} is dated in the future` };
  }
  if (age > ctx.ttlMs) {
    return { viewport: name, code: 'RECEIPT_STALE', detail: `compare ${record.id} is ${Math.round(age / 60_000)} minutes old; the limit is ${Math.round(ctx.ttlMs / 60_000)} minutes` };
  }
  return null;
}

export function resolveBaselineViewports(
  input: BaselineViewportsInput | undefined,
  ctx: { workspaceId: string; origin: string | null; pathname: string | null; now?: number; ttlMs?: number; root?: string }
): ResolvedBaselineViewports {
  const provenance: Record<string, BaselineProvenanceKind> = {};
  const rejections: BaselineProvenanceRejection[] = [];
  if (!input) return { provenance, rejections };
  const nowMs = ctx.now ?? Date.now();
  const ttlMs = ctx.ttlMs ?? BASELINE_RECEIPT_TTL_MS;
  const resolved: Partial<Record<BaselineViewportName, { mismatchPercent: number; passed: boolean }>> = {};
  for (const name of BASELINE_VIEWPORT_NAMES) {
    const entry = input[name];
    if (!entry) continue;
    if ('compareReceiptId' in entry) {
      const record = readCompareReceipt(entry.compareReceiptId, { workspaceId: ctx.workspaceId, root: ctx.root });
      if (!record) {
        rejections.push({ viewport: name, code: 'RECEIPT_NOT_FOUND', detail: `no valid compare receipt ${entry.compareReceiptId} exists for this workspace` });
        continue;
      }
      const rejection = checkReceipt(name, record, { origin: ctx.origin, pathname: ctx.pathname, nowMs, ttlMs });
      if (rejection) {
        rejections.push(rejection);
        continue;
      }
      resolved[name] = { mismatchPercent: record.mismatchPercentage, passed: record.match };
      provenance[name] = 'compare-receipt';
      continue;
    }
    resolved[name] = { mismatchPercent: entry.mismatchPercent, passed: entry.passed };
    provenance[name] = 'caller-asserted';
  }
  const hasAny = Object.keys(resolved).length > 0;
  return {
    ...(hasAny ? { viewports: resolved } : {}),
    provenance,
    rejections,
  };
}
