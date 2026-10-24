/**
 * Keeps the `theme.qa_validate` tool result small enough to cross the MCP transport intact.
 * The full report stays in the workspace receipt; the response carries the verdict, the counts,
 * the receipt path and the first findings of every list, with each cut named.
 */

/** Serialized size above which the response is trimmed. Clients cut larger tool results mid-JSON. */
export const QA_RESPONSE_BUDGET_BYTES = 48 * 1024;

/** Longest string a trimmed response keeps; the receipt holds the rest. */
const MAX_STRING_CHARS = 600;
/** Primitive lists (rule ids, evidence gaps) stay readable even when object lists are cut hard. */
const MIN_PRIMITIVE_LIST = 20;
/** Entry caps tried in order until the response fits. */
const CAP_STEPS = [100, 40, 20, 10, 5, 3, 1, 0] as const;
const MAX_REPORTED_CUTS = 30;

export interface QaResponseCut {
  path: string;
  total: number;
  shown: number;
}

export interface QaResponseBound {
  /** The report exceeded the budget and was trimmed. */
  truncated: true;
  budgetBytes: number;
  originalBytes: number;
  boundedBytes: number;
  /** Where the untrimmed report lives, when a receipt was written. */
  receiptPath?: string;
  cuts: QaResponseCut[];
  /** Cuts beyond the reported ones. */
  moreCuts: number;
  note: string;
}

export type BoundedQaResponse = Record<string, unknown> & { responseBound: QaResponseBound };

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrimitive = (value: unknown): boolean => value === null || typeof value !== 'object';

const severityRank = (entry: unknown): number => (isRecord(entry) && entry.severity === 'critical' ? 0 : 1);

function trim(value: unknown, cap: number, path: string, cuts: QaResponseCut[]): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…[${value.length - MAX_STRING_CHARS} chars cut]` : value;
  }
  if (Array.isArray(value)) {
    const primitive = value.every(isPrimitive);
    const limit = primitive ? Math.max(cap, MIN_PRIMITIVE_LIST) : cap;
    // Critical entries lead, so the first N of a mixed list are the ones that fail the run.
    const ordered = !primitive && value.some((entry) => severityRank(entry) === 0) ? [...value].sort((a, b) => severityRank(a) - severityRank(b)) : value;
    const kept = ordered.slice(0, limit);
    if (kept.length < value.length) cuts.push({ path, total: value.length, shown: kept.length });
    return kept.map((entry) => trim(entry, cap, `${path}[]`, cuts));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = trim(entry, cap, path ? `${path}.${key}` : key, cuts);
    return out;
  }
  return value;
}

/** Top-level keys that make up the verdict; the last-resort response keeps nothing else. */
const SKELETON_KEYS = [
  'runId', 'attemptId', 'summary', 'verification', 'execution', 'recovery', 'profile', 'thresholdsSource', 'coverage',
  'coverageFloor', 'viewport', 'waivers', 'ignoredWaivers', 'receipt',
] as const;

/**
 * Returns the report itself when it fits the budget, otherwise a trimmed copy carrying a
 * `responseBound` record. The input is never mutated.
 */
export function boundQaReportResponse<T extends object>(report: T, budgetBytes: number = QA_RESPONSE_BUDGET_BYTES): T | BoundedQaResponse {
  const originalBytes = byteLength(report);
  if (originalBytes <= budgetBytes) return report;

  const record = report as Record<string, unknown>;
  const receiptPath = isRecord(record.receipt) && typeof record.receipt.path === 'string' ? record.receipt.path : undefined;
  const note = receiptPath
    ? `Response trimmed to ${budgetBytes} bytes; every list keeps its first entries (critical first). The full report is in the receipt at ${receiptPath}.`
    : `Response trimmed to ${budgetBytes} bytes; every list keeps its first entries (critical first). No receipt was written, so the cut entries are not recoverable from this run.`;

  const finish = (body: Record<string, unknown>, cuts: QaResponseCut[]): BoundedQaResponse => {
    const bound: QaResponseBound = {
      truncated: true,
      budgetBytes,
      originalBytes,
      boundedBytes: 0,
      ...(receiptPath ? { receiptPath } : {}),
      cuts: cuts.slice(0, MAX_REPORTED_CUTS),
      moreCuts: Math.max(0, cuts.length - MAX_REPORTED_CUTS),
      note,
    };
    const result = { ...body, responseBound: bound };
    // The size sits inside the object it measures, so it is re-measured with the digits in place.
    for (let pass = 0; pass < 3; pass++) bound.boundedBytes = byteLength(result);
    return result;
  };

  for (const cap of CAP_STEPS) {
    const cuts: QaResponseCut[] = [];
    const candidate = finish(trim(report, cap, '', cuts) as Record<string, unknown>, cuts);
    if (candidate.responseBound.boundedBytes <= budgetBytes) return candidate;
  }

  const cuts: QaResponseCut[] = [];
  const skeleton: Record<string, unknown> = {};
  for (const key of SKELETON_KEYS) {
    if (key in record) skeleton[key] = trim(record[key], 0, key, cuts);
  }
  for (const key of Object.keys(record)) {
    if (!(SKELETON_KEYS as readonly string[]).includes(key)) cuts.push({ path: key, total: 1, shown: 0 });
  }
  return finish(skeleton, cuts);
}
