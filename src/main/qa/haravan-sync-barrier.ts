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
  readonly settledMethod: 'terminal-output';
  readonly lastSeq: number;
  readonly sessionGeneration?: number;
  readonly outputTail?: string;
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
   * Fails closed if the terminal session is absent or non-running.
   */
  public captureBaselineCursor(terminalSessionId: string): TerminalSyncCursor {
    return this.terminalPort.captureBaselineSeq(terminalSessionId);
  }

  /**
   * Waits deterministically for the Haravan Theme CLI watcher to acknowledge remote upload.
   * Fails closed with DURABILITY_FAILED if no acknowledgment is observed after baselineSeq.
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

    const waitResult = await this.terminalPort.waitTerminal({
      sessionId: cursor.sessionId,
      condition: 'output-match',
      pattern: options.pattern || DEFAULT_SYNC_PATTERN,
      afterSeq: cursor.baselineSeq,
      sessionGeneration: cursor.sessionGeneration,
      timeoutMs,
    });

    if (!waitResult.satisfied) {
      throw new CapabilityError(
        'DURABILITY_FAILED',
        `Haravan Theme CLI watcher did not acknowledge upload after sequence ${cursor.baselineSeq} (gen ${cursor.sessionGeneration}) within ${timeoutMs}ms`
      );
    }

    return {
      syncGen: workspaceGen,
      durationMs: Date.now() - startTime,
      settledMethod: 'terminal-output',
      lastSeq: waitResult.lastSeq,
      sessionGeneration: waitResult.sessionGeneration,
      outputTail: waitResult.outputTail,
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
