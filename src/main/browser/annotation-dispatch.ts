/**
 * Annotation → terminal prompt dispatch.
 *
 * Queue/draft delivery was removed: every annotation prompt is written to the
 * terminal immediately, and the picked payload carries no delivery mode. The
 * terminal surface is expressed as a structural port so
 * the dispatch invariant is unit-testable without pulling node-pty/Electron
 * runtime into the test process.
 */
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