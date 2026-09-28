import type { WebContents } from 'electron';
import { CapabilityError } from '../../shared/control-plane-contracts';

/**
 * Two-tier ceiling for one renderer script round trip.
 *
 * A page-side evaluation can be answered with NOTHING at all: measured on this platform,
 * `executeJavaScript` on a WebContents whose renderer never came up (`pid = 0`, an un-navigated
 * view) or has since died neither resolves nor rejects — ever. Nothing downstream can tell that
 * apart from a slow page, so a caller that awaits it waits forever, and in a serialized pipeline
 * every later operation queues behind it and never answers either.
 *
 * The soft tier only warns: a busy CPU or a genuinely heavy script is slow, not dead. The hard
 * tier terminates the renderer-side execution and refuses with `EVAL_HARD_TIMEOUT`, so silence
 * becomes a typed failure a caller can retry or re-target instead of an unbounded wait. Nothing
 * is fabricated: the refusal never stands in for a result the page did not produce.
 */

/** Hard ceiling derived above a soft budget: +3s or 2.5x, whichever is later. */
export function evalHardCeilingMs(softBudgetMs: number): number {
  return Math.max(softBudgetMs + 3_000, Math.round(softBudgetMs * 2.5));
}

export interface EvalCeilingOptions<T> {
  /** The WebContents whose renderer runs `work`; a destroyed/absent one skips the terminate step. */
  wc: WebContents | undefined;
  /** Name of the round trip for the warning and the refusal (e.g. 'dom dump'). */
  label: string;
  /** Budget the page is expected to answer within; the hard ceiling derives above it. */
  softBudgetMs: number;
  /** The renderer round trip. Called once, immediately. */
  work: () => Promise<T>;
  /** Terminates the overrunning renderer-side execution (`Runtime.terminateExecution`). */
  terminate?: (wc: WebContents) => Promise<unknown>;
}

export async function withEvalCeiling<T>(options: EvalCeilingOptions<T>): Promise<T> {
  const { wc, label, work, terminate } = options;
  // A budget that is not a positive finite number would derive a NaN ceiling, and setTimeout(NaN)
  // fires immediately — refusing a page that was never given a chance to answer. Fail loudly
  // instead: a wrong budget is a wiring bug, not a slow page.
  if (!Number.isFinite(options.softBudgetMs) || options.softBudgetMs <= 0) {
    throw new CapabilityError(
      'INVALID_ARGUMENT',
      `${label} was scheduled with an invalid soft budget: ${String(options.softBudgetMs)}`
    );
  }
  const softBudgetMs = Math.round(options.softBudgetMs);
  const hardBudgetMs = evalHardCeilingMs(softBudgetMs);

  const terminateScript = async (): Promise<void> => {
    if (!terminate || !wc || wc.isDestroyed()) return;
    try {
      await terminate(wc);
    } catch {
      // The already-issued refusal is the outcome that matters; a failed terminate never replaces it.
    }
  };

  const softTimer = setTimeout(() => {
    console.warn(
      `[evalCeiling:SoftWarning] ${label} reached its soft budget ${softBudgetMs}ms ` +
        `(a slow page or a busy CPU is not a dead one); awaiting the hard ceiling ${hardBudgetMs}ms`
    );
  }, softBudgetMs);
  softTimer.unref?.();

  const { promise: hardCeiling, reject: refuse } = Promise.withResolvers<never>();
  const hardTimer = setTimeout(() => {
    // The refusal is issued first and the termination is best-effort cleanup: `terminate` is itself
    // a call a dead or wedged renderer can leave unanswered (the very condition that brought us
    // here), so gating the outcome behind it would re-open the unbounded wait this ceiling exists
    // to close. Terminating still runs, to leave the renderer able to accept later work.
    refuse(
      new CapabilityError(
        'EVAL_HARD_TIMEOUT',
        `${label} did not answer within ${hardBudgetMs}ms; its renderer never settled the call`
      )
    );
    void terminateScript();
  }, hardBudgetMs);
  hardTimer.unref?.();

  try {
    return await Promise.race([work(), hardCeiling]);
  } finally {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
  }
}
