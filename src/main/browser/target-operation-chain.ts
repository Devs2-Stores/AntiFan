/**
 * Bounded settle-wait for a per-target operation chain.
 *
 * `NativeTabHost.runTargetOperation` serializes operations per (tab, pane) by
 * chaining promises. Awaiting that chain without a bound is what makes a single
 * operation that never settles fatal for the whole tab: every later capability
 * queues behind the same tail and never answers at all, so callers observe silence
 * rather than an error, and the tab stays unusable until the runtime restarts.
 *
 * These helpers keep the serialization but make the wait bounded and total, so a
 * stuck predecessor degrades into a structured refusal instead of a dead tab.
 */

/**
 * Resolves `true` when `tail` has settled (or already settled) inside `boundMs`,
 * and `false` when the bound expires first.
 *
 * A rejected predecessor counts as settled: it has left the chain, so refusing to
 * wait for it would be wrong, and rejecting here would replace one wedge with
 * another. The tail of an operation queue is settle-only by construction, so this
 * never rejects.
 */
export async function settleWithinBound(tail: Promise<unknown>, boundMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      tail.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, boundMs));
        // Never hold the process open just to observe a bound that is only a guard.
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
