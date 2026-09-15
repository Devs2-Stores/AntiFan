/**
 * AntiFan Core — Haravan Sync Barrier (Deterministic Remote Settle)
 *
 * Enforces remote upload attestation:
 * A mutation is ONLY marked synced when the active Haravan Theme CLI watcher
 * produces an authoritative upload/sync acknowledgment occurring AFTER
 * the mutation's captured terminal output sequence (baselineSeq) within
 * the exact sessionGeneration.
 *
 * Fails closed. No timer heuristics, no magic sleep() loops, no swallowed errors.
 */

import { BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';

export interface TerminalSyncCursor {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly baselineSeq: number;
}

/**
 * Read-only lifecycle view of the watcher terminal record.
 *
 * Terminal tabs can be put to SLEEP: a sleeping session keeps its transcript and its
 * browser-tab affinity but holds no live PTY, so the Haravan theme watcher inside it
 * is gone and no upload acknowledgment can ever arrive. The lifecycle lives in
 * `terminal-manager.ts`, so it is read through this widened structural view;
 * `TerminalManager.getSession` satisfies it without an adapter, and a port that does
 * not expose it keeps the legacy behaviour byte-for-byte (the barrier simply cannot
 * tell that the watcher is asleep).
 */
export interface TerminalSyncLifecycleProbe {
  state?: string;
  disposed?: boolean;
  lastSeq?: number;
  sessionGeneration?: number;
}

export interface TerminalSyncPort {
  captureBaselineSeq(sessionId: string): TerminalSyncCursor;
  waitTerminal(input: {
    sessionId: string;
    condition: 'output-match' | 'silence' | 'exit';
    pattern?: string;
    afterSeq?: number;
    sessionGeneration?: number;
    timeoutMs?: number;
  }): Promise<{ satisfied: boolean; lastSeq: number; outputTail?: string; sessionGeneration?: number }>;
  /**
   * Optional lifecycle probe used to avoid waking a sleeping watcher. Optional on
   * purpose: existing ports and test doubles keep compiling, and an absent probe
   * means "unknown", never "awake".
   */
  getSession?(sessionId: string): TerminalSyncLifecycleProbe | undefined;
}

export interface TabReloadPort {
  reload(target: BrowserTarget): Promise<{ reloaded: boolean; target: BrowserTarget }>;
}

export interface SyncBarrierOptions {
  readonly cursor: TerminalSyncCursor;
  readonly pattern?: string;
  readonly timeoutMs?: number;
}

export interface SyncSettleResult {
  readonly syncGen: number;
  readonly durationMs: number;
  /**
   * `'terminal-output'` only when an authoritative post-baseline upload
   * acknowledgment was observed. `'none'` means no attestation was produced, and
   * `unsettledReason` says why — such a receipt is explicitly not a success.
   */
  readonly settledMethod: 'terminal-output' | 'none';
  readonly lastSeq: number;
  readonly sessionGeneration?: number;
  readonly outputTail?: string;
  /**
   * TRUE only when the watcher actually acknowledged the upload. Optional so
   * receipts minted by an older build remain valid; this barrier always sets it.
   */
  readonly settled?: boolean;
  /** Why no attestation was produced. Absent on a settled result. */
  readonly unsettledReason?: 'WATCHER_SLEEPING';
  readonly sessionId?: string;
  /** The caller's own pre-mutation baseline, echoed back — never advanced. */
  readonly baselineSeq?: number;
  /** Human/agent-facing explanation. */
  readonly message?: string;
  /** Machine-readable recovery step. */
  readonly wakeHint?: string;
}

export interface ReloadSettleResult {
  readonly reloaded: boolean;
  readonly target: BrowserTarget;
  readonly documentGeneration: number;
  readonly durationMs: number;
}

const DEFAULT_SYNC_PATTERN = '(?:[Uu]ploaded|[Ss]ynced|[Pp]ushed|[Ff]inished):?\\s+';

export class HaravanSyncBarrier {
  constructor(
    private readonly terminalPort: TerminalSyncPort,
    private readonly reloadPort?: TabReloadPort
  ) {}

  /**
   * Captures the baseline terminal sequence and generation cursor prior to mutation.
   * Fails closed if the terminal session is absent, disposed, or closed.
   *
   * A SLEEPING watcher is allowed to produce a baseline: sequence numbers stay
   * monotonic across a nap (`lastSeq` is never reset), so this is a real cursor and
   * not a fabricated one. Whether a sleeping watcher can ever *acknowledge* the
   * mutation is decided in `awaitSync`, which refuses to wake it.
   */
  public captureBaselineCursor(terminalSessionId: string): TerminalSyncCursor {
    return this.terminalPort.captureBaselineSeq(terminalSessionId);
  }

  /**
   * Waits deterministically for the Haravan Theme CLI watcher to acknowledge remote upload.
   * Fails closed with DURABILITY_FAILED if no acknowledgment is observed after baselineSeq.
   *
   * A sleeping watcher is NOT a timeout and is NOT woken: its shell was released, so
   * the watcher process is gone and no acknowledgment can arrive. That case returns a
   * typed, non-throwing, explicitly unsettled result (`settled: false`,
   * `unsettledReason: 'WATCHER_SLEEPING'`) carrying an actionable wake hint, instead of
   * burning the caller's timeout and then reporting a misleading DURABILITY_FAILED.
   */
  public async awaitSync(
    workspaceGen: number,
    options: SyncBarrierOptions
  ): Promise<SyncSettleResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 15000;
    const { cursor } = options;

    if (!cursor || !cursor.sessionId) {
      throw new CapabilityError(
        'DURABILITY_FAILED',
        'Cannot verify remote sync: valid TerminalSyncCursor is required for authoritative upload attestation'
      );
    }

    const asleepBeforeWait = this.readSleepingWatcher(cursor.sessionId);
    if (asleepBeforeWait) {
      return this.watcherSleepingOutcome(workspaceGen, cursor, timeoutMs, asleepBeforeWait, Date.now() - startTime);
    }

    const waitResult = await this.terminalPort.waitTerminal({
      sessionId: cursor.sessionId,
      condition: 'output-match',
      pattern: options.pattern || DEFAULT_SYNC_PATTERN,
      afterSeq: cursor.baselineSeq,
      sessionGeneration: cursor.sessionGeneration,
      timeoutMs,
    });

    if (!waitResult.satisfied) {
      // The watcher may have been put to sleep while this wait was in flight. That is
      // not a missed acknowledgment, it is an unattestable watcher: report it as such
      // rather than as a timeout.
      const asleepDuringWait = this.readSleepingWatcher(cursor.sessionId);
      if (asleepDuringWait) {
        return this.watcherSleepingOutcome(workspaceGen, cursor, timeoutMs, asleepDuringWait, Date.now() - startTime);
      }
      throw new CapabilityError(
        'DURABILITY_FAILED',
        `Haravan Theme CLI watcher did not acknowledge upload after sequence ${cursor.baselineSeq} (gen ${cursor.sessionGeneration}) within ${timeoutMs}ms`
      );
    }

    return {
      settled: true,
      syncGen: workspaceGen,
      durationMs: Date.now() - startTime,
      settledMethod: 'terminal-output',
      lastSeq: waitResult.lastSeq,
      sessionGeneration: waitResult.sessionGeneration,
      outputTail: waitResult.outputTail,
    };
  }

  /**
   * Returns the lifecycle probe record only when the watcher is genuinely asleep.
   * A disposed or closed record is NOT sleeping: those keep failing loudly through
   * `captureBaselineSeq` / `waitTerminal`, exactly as before.
   */
  private readSleepingWatcher(sessionId: string): TerminalSyncLifecycleProbe | undefined {
    const probe = this.terminalPort.getSession;
    if (typeof probe !== 'function') return undefined;
    const record = probe.call(this.terminalPort, sessionId);
    if (!record || record.disposed === true) return undefined;
    return record.state === 'sleeping' ? record : undefined;
  }

  /**
   * Builds the honest "watcher is asleep" outcome. No cursor is invented: `lastSeq`
   * is the sleeping record's own monotonic counter (sleep never resets it) and
   * `baselineSeq` echoes the caller's pre-mutation baseline. Neither is a claim that
   * output advanced — `settled: false` states plainly that nothing was attested.
   */
  private watcherSleepingOutcome(
    workspaceGen: number,
    cursor: TerminalSyncCursor,
    timeoutMs: number,
    record: TerminalSyncLifecycleProbe,
    durationMs: number
  ): SyncSettleResult {
    const observedLastSeq =
      typeof record.lastSeq === 'number' && Number.isFinite(record.lastSeq) ? record.lastSeq : cursor.baselineSeq;
    return {
      settled: false,
      unsettledReason: 'WATCHER_SLEEPING',
      settledMethod: 'none',
      syncGen: workspaceGen,
      durationMs,
      lastSeq: observedLastSeq,
      baselineSeq: cursor.baselineSeq,
      sessionId: cursor.sessionId,
      sessionGeneration: cursor.sessionGeneration,
      message:
        `Haravan theme-sync watcher terminal "${cursor.sessionId}" is sleeping (no live PTY): its watcher process was released with the shell, ` +
        `so no upload acknowledgment can arrive and the mutation cannot be attested (elapsed ${durationMs}ms of a ${timeoutMs}ms budget; no shell was started and none was woken).`,
      wakeHint:
        `Write input to the watcher session to wake it — terminal.write { "sessionId": "${cursor.sessionId}" } — then restart the Haravan theme watcher in that session and retry awaitSync.`,
    };
  }

  /**
   * Reloads the target browser tab and waits for the document to settle,
   * returning the advanced documentGeneration.
   */
  public async awaitReloadAndSettle(
    target: BrowserTarget,
    explicitReloadPort?: TabReloadPort
  ): Promise<ReloadSettleResult> {
    const port = explicitReloadPort || this.reloadPort;
    if (!port) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        'TabReloadPort is required to reload and settle browser target'
      );
    }

    const startTime = Date.now();
    const reloadResult = await port.reload(target);
    const newDocGen = reloadResult.target.documentGeneration;
    const priorDocGen = target.documentGeneration ?? 0;

    if (typeof newDocGen !== 'number' || newDocGen <= priorDocGen) {
      throw new CapabilityError(
        'STALE_LINEAGE',
        `Browser tab reload failed to advance documentGeneration: expected > ${priorDocGen}, got ${newDocGen ?? 'undefined'}`
      );
    }

    return {
      reloaded: reloadResult.reloaded,
      target: reloadResult.target,
      documentGeneration: newDocGen,
      durationMs: Date.now() - startTime,
    };
  }
}
