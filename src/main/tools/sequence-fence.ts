/**
 * Document-generation fence classification for `anti.agent.sequence` and the single-step
 * agent actions.
 *
 * A call is fenced on the document generation its caller observed only when it addresses an
 * element through a semantic `@eN` ref: that ref was minted by a snapshot of one specific
 * document, and a newer document makes it meaningless. Everything else (a CSS selector, a
 * coordinate pair, key presses, waits, screenshots) resolves against the live page when it runs,
 * so refusing it for a generation bump only forces the caller to repeat the same call. Such a
 * call is rebased onto the live generation instead and reports the rebase.
 *
 * Step kinds are the host's `SequenceActionItem['type']` values:
 * navigate | click | type | scroll | hover | pressKey | wait | screenshot | snapshot |
 * awaitNetwork | dismissModals.
 */
import { isSemanticRef } from '../browser/semantic-ref-types.js';

/** Every argument field that can carry an `@eN` ref (a bare ref, or a ref-or-selector union). */
export const REF_CARRYING_FIELDS = ['ref', 'selector', 'refOrSelector', 'fromRef', 'toRef', 'fromSelector', 'toSelector'] as const;

/** True when any ref-carrying field of `args` holds a semantic `@eN` ref. */
export function carriesSemanticRef(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const record = args as Record<string, unknown>;
  return REF_CARRYING_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === 'string' && isSemanticRef(value.trim());
  });
}

/**
 * True when some step that runs against the document the caller observed (before the first
 * navigation) depends on it. Fail-closed: a step of any kind not listed below and a malformed
 * step count as dependent.
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
      case 'click':
      case 'hover':
      case 'type':
      case 'scroll':
      case 'pressKey':
      case 'snapshot':
      case 'dismissModals':
        if (carriesSemanticRef(step)) return true;
        break;
      default:
        return true;
    }
  }
  return false;
}

/** The eleven step kinds the sequence host executes. */
export const SEQUENCE_STEP_TYPES: readonly string[] = Object.freeze([
  'navigate', 'click', 'type', 'scroll', 'hover', 'pressKey', 'wait', 'screenshot', 'snapshot', 'awaitNetwork', 'dismissModals',
]);
