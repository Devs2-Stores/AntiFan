/**
 * AntiFan Core — Theme Mutation Session
 *
 * Epistemic Transaction Primitive:
 * Unifies ThemeWorkspaceContext, R0 Snapshot & Rollback, CAS File Writes,
 * Remote Sync Barrier, Tab Reload, and Lineage Attestation into a single
 * deterministic lifecycle.
 *
 * Fails closed. Core is Truth & Recovery Arbiter.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  ThemeWorkspaceContext,
  ThemeLineage,
  VerificationPolicy,
  CasFileWrite,
  CasFileResult,
  ThemeTransactionReceipt,
  assertValidThemeWorkspaceContext,
} from '../../shared/theme-task-context';
import {
  BrowserTarget,
  CapabilityError,
  assertWorkspaceContained,
  assertNoReparseTraversal,
  canonicalizeWorkspaceRoot,
} from '../../shared/control-plane-contracts';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { HaravanSyncBarrier, SyncSettleResult, ReloadSettleResult, TerminalSyncCursor } from './haravan-sync-barrier';
import {
  createWorkspaceSnapshotManifest,
  rollbackWorkspaceToManifest,
  WorkspaceSnapshotManifest,
  WorkspaceRollbackResult,
} from './workspace-snapshot-rollback';
import { BrowserControlPort } from '../tools/browser-control-port';

export type SessionState =
  | 'idle'
  | 'active'
  | 'mutated'
  | 'synced'
  | 'settled'
  | 'committed'
  | 'rolled_back'
  | 'held';

export interface BeginSessionOptions {
  readonly policy?: VerificationPolicy;
  readonly initialBrowserEpoch?: number;
  readonly initialDocGen?: number;
}
export class ThemeMutationSession {
  public readonly sessionId: string;
  public readonly context: ThemeWorkspaceContext;
  public readonly policy: VerificationPolicy;
  public readonly canonicalRoot: string;

  private state: SessionState = 'idle';
  private r0Manifest: WorkspaceSnapshotManifest | null = null;
  private readonly modifiedFiles = new Set<string>();
  private currentLineage: ThemeLineage;
  private readonly initialDocGen: number;
  private verifiedLineage = false;

  constructor(
    context: ThemeWorkspaceContext,
    private readonly filePort: WorkspaceFilePort,
    private readonly syncBarrier?: HaravanSyncBarrier,
    private readonly browserPort?: BrowserControlPort,
    options: BeginSessionOptions = {},
    private readonly onRelease?: () => void
  ) {
    assertValidThemeWorkspaceContext(context);
    this.canonicalRoot = canonicalizeWorkspaceRoot(context.workspaceRoot);
    assertWorkspaceContained(this.canonicalRoot, path.resolve(this.canonicalRoot), true);
    assertNoReparseTraversal(this.canonicalRoot, path.resolve(this.canonicalRoot));

    this.sessionId = `tx-${randomUUID().slice(0, 8)}`;
    this.context = context;
    this.policy = options.policy ?? 'HARD_FAIL_ROLLBACK';
    this.currentLineage = {
      workspaceGen: 0,
      syncGen: 0,
      documentGeneration: options.initialDocGen ?? 1,
      browserEpoch: options.initialBrowserEpoch ?? 1,
    };
    this.initialDocGen = options.initialDocGen ?? 1;
  }
  public get lineage(): Readonly<ThemeLineage> {
    return { ...this.currentLineage };
  }

  public get sessionState(): SessionState {
    return this.state;
  }

  public get snapshotManifest(): WorkspaceSnapshotManifest | null {
    return this.r0Manifest;
  }

  public get touchedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }

  /**
   * Acquires exclusive workspace lock and captures baseline R0 manifest snapshot.
   */
  public async begin(): Promise<{ sessionId: string; r0Manifest: WorkspaceSnapshotManifest; lineage: ThemeLineage }> {
    if (this.state !== 'idle') {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Session ${this.sessionId} is already started (state: ${this.state})`
      );
    }
    this.r0Manifest = await createWorkspaceSnapshotManifest(
      this.canonicalRoot,
      this.sessionId
    );
    this.state = 'active';

    return {
      sessionId: this.sessionId,
      r0Manifest: this.r0Manifest,
      lineage: this.lineage,
    };
  }

  /**
   * Performs an atomic Compare-And-Swap file write.
   * If expectedSha256 is provided, verifies against the on-disk state prior to mutation.
   */
  public async writeCAS(write: CasFileWrite): Promise<CasFileResult> {
    this.assertActive('writeCAS');

    const result = await this.filePort.writeCAS(
      this.context.workspaceRoot,
      write.relativePath,
      write.content,
      write.expectedSha256
    );

    this.currentLineage = {
      ...this.currentLineage,
      workspaceGen: this.currentLineage.workspaceGen + 1,
    };
    this.modifiedFiles.add(write.relativePath);
    this.state = 'mutated';

    return {
      path: result.path,
      relativePath: write.relativePath,
      byteLength: result.byteLength,
      sha256: result.sha256,
      previousSha256: result.previousSha256,
      workspaceGen: this.currentLineage.workspaceGen,
    };
  }

  /**
   * Waits deterministically for the Haravan Theme CLI watcher to confirm remote upload,
   * then reloads the target browser tab and samples the advanced documentGeneration.
   */
  public async awaitSyncAndReload(
    target: BrowserTarget,
    options: {
      cursor: TerminalSyncCursor;
      pattern?: string;
      timeoutMs?: number;
    }
  ): Promise<{ sync: SyncSettleResult; reload: ReloadSettleResult; lineage: ThemeLineage }> {
    this.assertNotTerminated('awaitSyncAndReload');

    if (!this.syncBarrier) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        'HaravanSyncBarrier is required for remote sync settlement'
      );
    }

    if (!options.cursor || !options.cursor.sessionId) {
      throw new CapabilityError(
        'DURABILITY_FAILED',
        'Valid TerminalSyncCursor is required to await authoritative remote sync'
      );
    }

    const syncResult = await this.syncBarrier.awaitSync(this.currentLineage.workspaceGen, {
      cursor: options.cursor,
      pattern: options.pattern,
      timeoutMs: options.timeoutMs,
    });
    this.currentLineage = {
      ...this.currentLineage,
      syncGen: syncResult.syncGen,
    };
    this.state = 'synced';

    const reloadResult = await this.syncBarrier.awaitReloadAndSettle(target, this.browserPort);

    this.currentLineage = {
      ...this.currentLineage,
      documentGeneration: reloadResult.documentGeneration,
    };
    this.state = 'settled';
    // Causal lineage attestation: ensure tab reload successfully advanced document generation
    if (reloadResult.documentGeneration <= this.initialDocGen) {
      throw new CapabilityError(
        'STALE_LINEAGE',
        `Document generation (${reloadResult.documentGeneration}) failed to advance beyond pre-mutation baseline (${this.initialDocGen})`
      );
    }
    this.verifiedLineage = true;
    return {
      sync: syncResult,
      reload: reloadResult,
      lineage: this.lineage,
    };
  }

  /**
   * Settles the transaction according to the chosen VerificationPolicy.
   * If verdict is REJECTED and policy is HARD_FAIL_ROLLBACK, auto-rolls back to R0.
   */
  public async settle(
    verdict: 'VERIFIED' | 'REJECTED' | 'HELD',
    details?: Record<string, unknown>
  ): Promise<ThemeTransactionReceipt> {
    this.assertNotTerminated('settle');

    let rolledBack = false;

    if (verdict === 'VERIFIED') {
      if (this.state !== 'settled') {
        throw new CapabilityError(
          'SESSION_STALE',
          `Cannot mark VERIFIED: session has not completed remote sync and reload settlement (current state: "${this.state}")`
        );
      }
      if (this.currentLineage.documentGeneration <= this.initialDocGen) {
        throw new CapabilityError(
          'STALE_LINEAGE',
          `Cannot mark VERIFIED: documentGeneration (${this.currentLineage.documentGeneration}) did not advance past initial (${this.initialDocGen})`
        );
      }
      this.state = 'committed';
      this.releaseLock();
    } else if (verdict === 'REJECTED') {
      if (this.policy === 'HARD_FAIL_ROLLBACK') {
        await this.executeRollback();
        rolledBack = true;
        this.state = 'rolled_back';
        this.releaseLock();
      } else {
        // EXPLORATORY_HOLD or PERMISSIVE: Quarantine workspace lock for agent inspection
        this.state = 'held';
      }
    } else {
      // HELD: Retain workspace lock in quarantine
      this.state = 'held';
    }

    return {
      receiptId: `rcpt-${randomUUID().slice(0, 8)}`,
      sessionId: this.sessionId,
      context: this.context,
      lineage: this.lineage,
      verdict,
      policy: this.policy,
      rolledBack,
      details,
      timestamp: Date.now(),
    };
  }

  /**
   * Resolves a held quarantine transaction by rolling back to R0.
   * Releases the exclusive workspace lock upon resolution.
   */
  public async resolveHold(
    action: 'rollback',
    reason?: string
  ): Promise<{ action: 'rollback'; rollbackResult: WorkspaceRollbackResult }> {
    if (this.state !== 'held') {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        `Cannot resolveHold: session ${this.sessionId} is not in "held" state (current state: "${this.state}")`
      );
    }

    const rollbackResult = await this.executeRollback();
    this.state = 'rolled_back';
    this.releaseLock();
    return { action: 'rollback', rollbackResult };
  }

  /**
   * Explicitly triggers an immediate rollback to R0 and marks the session rolled_back.
   */
  public async rollback(reason?: string): Promise<WorkspaceRollbackResult> {
    this.assertNotTerminated('rollback');
    const result = await this.executeRollback();
    this.state = 'rolled_back';
    this.releaseLock();
    return result;
  }

  private async executeRollback(): Promise<WorkspaceRollbackResult> {
    if (!this.r0Manifest) {
      throw new CapabilityError(
        'DURABILITY_FAILED',
        `Cannot rollback session ${this.sessionId}: R0 snapshot manifest was not captured`
      );
    }
    return await rollbackWorkspaceToManifest(this.canonicalRoot, this.r0Manifest);
  }
  private releaseLock(): void {
    this.onRelease?.();
  }
  private assertActive(op: string): void {
    if (this.state !== 'active' && this.state !== 'mutated' && this.state !== 'synced' && this.state !== 'held') {
      throw new CapabilityError(
        'SESSION_STALE',
        `Cannot perform ${op}: session ${this.sessionId} is in state "${this.state}"`
      );
    }
  }

  private assertNotTerminated(op: string): void {
    if (this.state === 'committed' || this.state === 'rolled_back') {
      throw new CapabilityError(
        'SESSION_CLOSED',
        `Cannot perform ${op}: session ${this.sessionId} is already ${this.state}`
      );
    }
  }
}
