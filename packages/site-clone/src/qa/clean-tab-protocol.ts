/**
 * QA: Clean Tab Protocol & Reversible State Contract
 * Ensures test probes do not leave persistent mutations in the inspected document
 */

export interface PageSnapshotState {
  scrollX: number;
  scrollY: number;
  bodyClassName?: string;
  injectedElementIds: string[];
  openDialogIds?: string[];
}

export interface ReversibleExecutionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  restored: boolean;
}

export class CleanTabProtocol {
  /**
   * Captures the current DOM state (scroll, injected probe elements)
   */
  public static async captureState(evaluator: (expr: string) => Promise<unknown>): Promise<PageSnapshotState> {
    const raw = await evaluator(`(() => {
      return {
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
        bodyClassName: document.body ? document.body.className : '',
        injectedElementIds: Array.from(document.querySelectorAll('[data-antifan-probe]')).map(el => el.id).filter(Boolean),
        openDialogIds: Array.from(document.querySelectorAll('dialog[open]')).map(el => el.id).filter(Boolean)
      };
    })()`);

    if (raw && typeof raw === 'object') {
      const candidate = raw as { scrollX?: unknown; scrollY?: unknown; bodyClassName?: unknown; injectedElementIds?: unknown; openDialogIds?: unknown };
      return {
        scrollX: typeof candidate.scrollX === 'number' ? candidate.scrollX : 0,
        scrollY: typeof candidate.scrollY === 'number' ? candidate.scrollY : 0,
        bodyClassName: typeof candidate.bodyClassName === 'string' ? candidate.bodyClassName : '',
        injectedElementIds: Array.isArray(candidate.injectedElementIds) ? candidate.injectedElementIds.filter((id): id is string => typeof id === 'string') : [],
        openDialogIds: Array.isArray(candidate.openDialogIds) ? candidate.openDialogIds.filter((id): id is string => typeof id === 'string') : []
      };
    }

    return { scrollX: 0, scrollY: 0, injectedElementIds: [] };
  }

  /**
   * Restores page state back to snapshot
   */
  public static async restoreState(evaluator: (expr: string) => Promise<unknown>, snapshot: PageSnapshotState): Promise<boolean> {
    const bodyClassJson = JSON.stringify(snapshot.bodyClassName ?? '');
    const res = await evaluator(`(() => {
      try {
        // 1. Remove any injected probe elements
        const probes = document.querySelectorAll('[data-antifan-probe]');
        probes.forEach(el => el.remove());

        // 2. Remove freeze styles if injected
        const freezeStyle = document.getElementById('antifan-qa-freeze');
        if (freezeStyle) freezeStyle.remove();

        // 3. Restore scroll position
        window.scrollTo(${Number(snapshot.scrollX) || 0}, ${Number(snapshot.scrollY) || 0});

        // 4. Restore body classes
        if (document.body && ${bodyClassJson} !== '""') {
          document.body.className = ${bodyClassJson};
        }

        // 5. Close newly opened dialogs if any
        const dialogs = document.querySelectorAll('dialog[open]');
        dialogs.forEach(d => {
          try { (d as any).close(); } catch {}
        });

        // 6. Clear runtime initialization flags
        if (window.__antifan_rt) delete window.__antifan_rt;
        if (window.__antifanFreeze) delete window.__antifanFreeze;
        return true;
      } catch {
        return false;
      }
    })()`);

    return Boolean(res);
  }

  /**
   * Executes a probe action inside a reversible scope, guaranteeing cleanup in finally
   */
  public static async withReversibleState<T>(
    evaluator: (expr: string) => Promise<unknown>,
    action: () => Promise<T>
  ): Promise<ReversibleExecutionResult<T>> {
    const snapshot = await this.captureState(evaluator);
    let resultData: T | undefined;
    let executionError: string | undefined;
    let success = false;
    let restored = false;

    try {
      resultData = await action();
      success = true;
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      success = false;
    } finally {
      try {
        restored = await this.restoreState(evaluator, snapshot);
      } catch (err) {
        restored = false;
        const msg = err instanceof Error ? err.message : String(err);
        executionError = executionError ? `${executionError}; Restoration error: ${msg}` : `Restoration error: ${msg}`;
      }
    }

    return {
      success,
      data: resultData,
      error: executionError,
      restored
    };
  }

  /**
   * Verifies that the tab is in a clean reloaded state
   */
  public static async assertCleanTab(evaluator: (expr: string) => Promise<unknown>): Promise<{ clean: boolean; leaks: string[] }> {
    const raw = await evaluator(`(() => {
      const leaks = [];
      if (window.__antifanFreeze) leaks.push('__antifanFreeze');
      if (window.__antifan_rt) leaks.push('__antifan_rt');
      if (document.querySelectorAll('[data-antifan-probe]').length > 0) leaks.push('data-antifan-probe');
      if (document.querySelectorAll('style#antifan-qa-freeze').length > 0) leaks.push('style#antifan-qa-freeze');
      return {
        clean: leaks.length === 0,
        leaks: leaks
      };
    })()`);

    if (raw && typeof raw === 'object') {
      const candidate = raw as { clean?: unknown; leaks?: unknown };
      return {
        clean: Boolean(candidate.clean),
        leaks: Array.isArray(candidate.leaks) ? candidate.leaks.filter((s): s is string => typeof s === 'string') : []
      };
    }

    return { clean: false, leaks: ['invalid_response'] };
  }
}
