/**
 * AntiFan Browser Desktop - Asynchronous Non-Blocking Theme QA Queue
 * Manages background QA validation tasks per tab with AbortController tied to navigation epochs / document generations.
 */

export interface AsyncQaJob {
  tabId: string;
  generation: number;
  controller: AbortController;
  startedAt: number;
}

export class AsyncThemeQaQueue {
  private activeJobs = new Map<string, AsyncQaJob>();

  public enqueue(tabId: string, generation: number, task: (signal: AbortSignal) => Promise<void>): void {
    this.abort(tabId);
    const controller = new AbortController();
    const job: AsyncQaJob = {
      tabId,
      generation,
      controller,
      startedAt: Date.now(),
    };
    this.activeJobs.set(tabId, job);

    task(controller.signal)
      .catch((err) => {
        if (controller.signal.aborted || (err && typeof err === 'object' && (err as any).code === 'TARGET_STALE')) {
          return;
        }
        console.warn(`[async-qa-queue] Background QA job failed for tab ${tabId} (gen ${generation}):`, err);
      })
      .finally(() => {
        const current = this.activeJobs.get(tabId);
        if (current && current.generation === generation) {
          this.activeJobs.delete(tabId);
        }
      });
  }

  public abort(tabId: string): void {
    const job = this.activeJobs.get(tabId);
    if (job) {
      job.controller.abort();
      this.activeJobs.delete(tabId);
    }
  }

  public abortAll(): void {
    for (const job of this.activeJobs.values()) {
      job.controller.abort();
    }
    this.activeJobs.clear();
  }

  public getActiveJob(tabId: string): AsyncQaJob | undefined {
    return this.activeJobs.get(tabId);
  }

  public isRunning(tabId: string): boolean {
    return this.activeJobs.has(tabId);
  }
}
