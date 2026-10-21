/**
 * Document-generation fence classification for `anti.agent.sequence`.
 *
 * A sequence is fenced on the document generation its caller observed because a step that
 * addresses the page by `selector`, `@eN` ref or coordinates acts on the DOM the caller
 * inspected; a newer document makes those addresses meaningless. A sequence whose steps
 * never touch that document (it navigates first, or only waits / screenshots) has nothing
 * to be stale against, so the fence would only refuse it for no reason.
 *
 * Step kinds are the host's `SequenceActionItem['type']` values:
 * navigate | click | type | scroll | hover | pressKey | wait | screenshot | snapshot |
 * awaitNetwork | dismissModals.
 */

type SequenceStep = Record<string, unknown>;

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function addressesPage(step: SequenceStep): boolean {
  return hasValue(step.selector) || hasValue(step.ref) || hasValue(step.x) || hasValue(step.y);
}

/**
 * True when some step that runs against the document the caller observed (before the first
 * navigation) depends on it. Fail-closed: a step of any kind not listed as independent, a
 * malformed step, and `dismissModals` (which inspects the live DOM) all count as dependent.
 */
export function sequenceDependsOnPriorDocument(actions: ReadonlyArray<Record<string, unknown>>): boolean {
  for (const step of actions) {
    if (!step || typeof step !== 'object') return true;
    const kind = typeof step.type === 'string' ? step.type : undefined;
    // The first navigation replaces the document: it and every later step run on the new one.
    if (kind === 'navigate') return false;
    switch (kind) {
      case 'wait':
      case 'screenshot':
      case 'awaitNetwork':
        break;
      case 'pressKey':
        if (addressesPage(step)) return true;
        break;
      case 'snapshot':
        if (typeof step.ref === 'string' && /^@e\d+$/.test(step.ref.trim())) return true;
        break;
      default:
        return true;
    }
  }
  return false;
}
