/**
 * Annotation → terminal prompt dispatch.
 *
 * Queue/draft delivery was removed: every annotation prompt is written to the
 * terminal immediately, and the picked payload carries no delivery mode. The
 * terminal surface is expressed as a structural port so
 * the dispatch invariant is unit-testable without pulling node-pty/Electron
 * runtime into the test process.
 */
import type { AntiFanPickedElement } from '../../shared/contracts';

export interface TerminalDispatchPort {
  getActiveSessionId(): string;
  switchSession(id: string): boolean;
  writeTo(id: string, input: string): void;
  write(input: string): void;
}

export function dispatchAnnotationToTerminal(tm: TerminalDispatchPort, targetSessionId: string | undefined, fullPrompt: string): void {
  const resolvedTerminalId = targetSessionId && targetSessionId !== 'auto' ? targetSessionId : tm.getActiveSessionId();
  if (resolvedTerminalId) {
    tm.switchSession(resolvedTerminalId);
    tm.writeTo(resolvedTerminalId, fullPrompt + '\r');
  } else {
    tm.write(fullPrompt + '\r');
  }
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