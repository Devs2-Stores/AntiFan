/**
 * Admission of CDP commands to a target that still holds a timed-out in-flight command.
 *
 * A command that outlives its caller's bound keeps its queue slot, so every later
 * command on that target is refused instead of queued behind it. The host clears the
 * stuck command itself on the first command it admits once the entry is older than
 * {@link CDP_DRAIN_SELF_CLEAN_MS}; a refusal therefore always has a definite time after
 * which the same call is admitted, and says so.
 */

/** Age of a drain entry past which the host resets the transport on the next admission. */
export const CDP_DRAIN_SELF_CLEAN_MS = 5000;

export interface CdpDrainEntry {
  method: string;
  /** Epoch ms the drain began; absent on an entry whose start was never recorded. */
  startedAt?: number;
}

/** How long the target has been draining; an entry with no recorded start counts as long expired. */
export function drainAgeMs(entry: CdpDrainEntry, now: number): number {
  return Math.max(0, now - (entry.startedAt || 0));
}

/** True once the host resets the transport on admission instead of refusing. */
export function drainIsExpired(entry: CdpDrainEntry, now: number): boolean {
  return drainAgeMs(entry, now) > CDP_DRAIN_SELF_CLEAN_MS;
}

/** Milliseconds after which the refused call is admitted. 0 when the entry is already expired. */
export function drainRetryAfterMs(entry: CdpDrainEntry, now: number): number {
  const age = drainAgeMs(entry, now);
  return age > CDP_DRAIN_SELF_CLEAN_MS ? 0 : CDP_DRAIN_SELF_CLEAN_MS - age + 1;
}

/**
 * What a caller does about a refusal. Closing a tab sends no CDP command, so it is never
 * queued behind the stuck one; reloading does go through CDP and is deliberately not offered.
 */
export function drainRecoveryGuidance(retryAfterMs: number): string {
  return `Wait ${retryAfterMs} ms and retry the same call: the host resets the stuck command on the first command it admits after ${CDP_DRAIN_SELF_CLEAN_MS} ms. anti.browser.tabs.close closes the tab without sending a CDP command.`;
}

export interface CdpDrainRefusalDetails {
  wcId: number;
  drainingMethod: string;
  refusedMethod?: string;
  drainingForMs: number;
  retryAfterMs: number;
  recovery: string;
}

/** The structured facts of a drain refusal, as carried on the error `details`. */
export function buildDrainRefusalDetails(
  entry: CdpDrainEntry,
  now: number,
  facts: { wcId: number; refusedMethod?: string }
): CdpDrainRefusalDetails {
  const retryAfterMs = drainRetryAfterMs(entry, now);
  return {
    wcId: facts.wcId,
    drainingMethod: entry.method,
    ...(facts.refusedMethod ? { refusedMethod: facts.refusedMethod } : {}),
    drainingForMs: drainAgeMs(entry, now),
    retryAfterMs,
    recovery: drainRecoveryGuidance(retryAfterMs),
  };
}
