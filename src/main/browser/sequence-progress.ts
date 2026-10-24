/**
 * Accounting for an action sequence that stops part-way. `executedCount` counts the steps
 * the runner attempted (the failing step included); a caller resuming the sequence needs the
 * other two facts: how many steps actually succeeded, and which step is the one that failed.
 */
export interface SequenceStepOutcome {
  actionIndex: number;
  success: boolean;
}

export interface SequenceProgress {
  /** Steps that ran and succeeded. */
  completedSteps: number;
  /** Index of the first step that failed; absent when no step failed. */
  failedStepIndex?: number;
}

export function sequenceProgress(results: readonly SequenceStepOutcome[]): SequenceProgress {
  let completedSteps = 0;
  let failedStepIndex: number | undefined;
  for (const step of results) {
    if (step.success) {
      completedSteps += 1;
    } else if (failedStepIndex === undefined) {
      failedStepIndex = step.actionIndex;
    }
  }
  return failedStepIndex === undefined ? { completedSteps } : { completedSteps, failedStepIndex };
}
