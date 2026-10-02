/**
 * Annotation → terminal prompt dispatch.
 *
 * Queue/draft delivery was removed: every annotation prompt is written to the
 * terminal immediately, and the picked payload carries no delivery mode. The
 * terminal surface is expressed as a structural port so
 * the dispatch invariant is unit-testable without pulling node-pty/Electron
 * runtime into the test process.
 *
 * Dispatch is write-only and never resolves: the caller hands a session id it
 * already resolved inside the picking window's scope. There is deliberately no
 * `getActiveSessionId`/`write` arm — the process-global active session belongs
 * to whichever window switched last, and consulting it here is how an
 * annotation picked in one project window used to land in another's terminal.
 */
import type { AntiFanPickedElement } from '../../shared/contracts';

export interface TerminalDispatchPort {
  writeTo(id: string, input: string): void;
}

export function sanitizeTerminalPrompt(prompt: string): string {
  return (prompt || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function dispatchAnnotationToTerminal(tm: TerminalDispatchPort, resolvedSessionId: string | undefined, fullPrompt: string): void {
  const sanitized = sanitizeTerminalPrompt(fullPrompt);
  if (!sanitized) return;
  // A missing or 'auto' id means resolution upstream found no in-scope target:
  // the pick is skipped rather than written to a session nobody resolved.
  if (!resolvedSessionId || resolvedSessionId === 'auto') return;
  tm.writeTo(resolvedSessionId, sanitized + '\r');
}

/**
 * Raw element data reported by the storefront picker. The native host enriches
 * it afterwards with screenshot/markdown/timestamp fields, so those are
 * excluded from the input domain.
 */
export type PickedElementInput = Omit<
  AntiFanPickedElement,
  'screenshotBase64' | 'markdownPath' | 'markdownContent' | 'targetImagePath' | 'viewportImagePath' | 'userComment' | 'timestamp'
>;

/**
 * Remove a legacy `deliveryMode` field from a raw pick payload before it is
 * re-emitted, so the field can never surface on `element-picked`/toolbar
 * payloads even when an older picker build or a storefront page still sets it.
 * The destructuring copy preserves every other key.
 */
export function stripDeliveryMode(payload: PickedElementInput): PickedElementInput {
  if (!('deliveryMode' in payload)) {
    return payload;
  }
  const { deliveryMode: _legacyDeliveryMode, ...rest } = payload;
  void _legacyDeliveryMode;
  return rest;
}