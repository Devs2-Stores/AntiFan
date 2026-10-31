/**
 * What the in-page result serializer drops, and how a caller can tell.
 *
 * An evaluated result crosses the Electron boundary through a serializer that stops at a fixed
 * depth and keeps only a prefix of a DOM element's markup. Both leave a recognizable trace in the
 * value, so a reader that needs to know whether it holds the whole answer can look for the trace
 * instead of guessing from the size.
 */

/** Marker the in-page serializer leaves where an evaluated result nested deeper than it walks. */
export const EVAL_MAX_DEPTH_MARKER = '[MaxDepth]';

/** Longest `outerHTML` the in-page serializer keeps for a DOM element in an evaluated result. */
export const EVAL_ELEMENT_HTML_MAX_CHARS = 1000;

/** Nodes inspected before giving up; a result larger than this is not scanned to its end. */
const EVAL_TRUNCATION_SCAN_NODE_BUDGET = 200_000;

export type EvalTruncationReason = 'max-depth' | 'element-html';

/**
 * Reasons an evaluated value is known to be cut short. An empty list means no trace of
 * truncation was found, not a guarantee: a result that exceeds the scan budget is reported only
 * for what was reached.
 */
export function findEvalTruncation(value: unknown): EvalTruncationReason[] {
  const reasons = new Set<EvalTruncationReason>();
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0 && visited < EVAL_TRUNCATION_SCAN_NODE_BUDGET) {
    const node = pending.pop();
    visited++;
    if (typeof node === 'string') {
      if (node === EVAL_MAX_DEPTH_MARKER) reasons.add('max-depth');
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.tagName === 'string' && typeof record.outerHTML === 'string' && record.outerHTML.length >= EVAL_ELEMENT_HTML_MAX_CHARS) {
      reasons.add('element-html');
    }
    for (const key of Object.keys(record)) pending.push(record[key]);
  }
  return [...reasons];
}
