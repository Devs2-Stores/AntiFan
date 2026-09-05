/**
 * AntiFan Core — Theme Transaction Registry
 *
 * Runtime-owned transaction authority for storefront mutations.
 * Bounded strictly to ControlPlaneRuntime tenancy (no global static maps).
 * Coordinates exclusive workspace locks, CAS writes, and R0 rollback.
 */

import {
  ThemeWorkspaceContext,
  CasFileWrite,
  CasFileResult,
  ThemeTransactionReceipt,
} from '../../shared/theme-task-context';
import {
  CapabilityError,
  canonicalizeWorkspaceRoot,
  BrowserTarget,
} from '../../shared/control-plane-contracts';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { HaravanSyncBarrier, SyncSettleResult, ReloadSettleResult, TerminalSyncCursor } from './haravan-sync-barrier';
import { ThemeMutationSession, BeginSessionOptions } from './theme-mutation-session';
import { TerminalManager } from '../browser/terminal-manager';
import { BrowserControlPort } from '../tools/browser-control-port';
import { WorkspaceRollbackResult } from './workspace-snapshot-rollback';

export interface RuntimeTenancyIdentity {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runtimeId: string;
}

export class ThemeTransactionRegistry {
  private readonly sessions = new Map<string, ThemeMutationSession>(); // canonicalRoot -> ThemeMutationSession
  private readonly inFlightReservations = new Set<string>();

  private browserPort?: BrowserControlPort;

  constructor(
    private readonly tenancy: RuntimeTenancyIdentity,
    private readonly filePort: WorkspaceFilePort,
    private readonly terminalManager?: TerminalManager,
    browserPort?: BrowserControlPort
  ) {
    this.browserPort = browserPort;
  }

  public bindBrowserPort(browserPort: BrowserControlPort): void {
    this.browserPort = browserPort;
  }
  public isLocked(workspaceRoot: string): boolean {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    if (this.inFlightReservations.has(canonical)) return true;
    const session = this.sessions.get(canonical);
    if (!session) return false;
    if (session.sessionState === 'committed' || session.sessionState === 'rolled_back') {
      this.sessions.delete(canonical);
      return false;
    }
    return true;
  }

  public getActiveSession(workspaceRoot: string): ThemeMutationSession | undefined {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const session = this.sessions.get(canonical);
    if (!session) return undefined;
    if (session.sessionState === 'committed' || session.sessionState === 'rolled_back') {
      this.sessions.delete(canonical);
      return undefined;
    }
    return session;
  }

  public async begin(
    context: ThemeWorkspaceContext,
    callerTenancy?: Partial<RuntimeTenancyIdentity>,
    options?: BeginSessionOptions
  ): Promise<{ sessionId: string; canonicalRoot: string }> {
    this.assertTenancy(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(context.workspaceRoot);

    if (this.isLocked(canonical)) {
      const active = this.sessions.get(canonical);
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" is locked by active transaction ${active?.sessionId || 'in-flight'}`,
        { workspaceRoot: canonical, activeSessionId: active?.sessionId }
      );
    }

    // Atomic synchronous reservation prevents concurrent begin() races
    this.inFlightReservations.add(canonical);

    try {
      const syncBarrier = this.terminalManager
        ? new HaravanSyncBarrier(this.terminalManager, this.browserPort)
        : undefined;

      const session = new ThemeMutationSession(
        context,
        this.filePort,
        syncBarrier,
        this.browserPort,
        options,
        () => {
          this.sessions.delete(canonical);
        }
      );

      await session.begin();
      this.sessions.set(canonical, session);
      return { sessionId: session.sessionId, canonicalRoot: canonical };
    } finally {
      this.inFlightReservations.delete(canonical);
    }
  }

  public async writeCAS(
    workspaceRoot: string,
    fileWrite: CasFileWrite,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<CasFileResult> {
    if (callerTenancy) this.assertTenancy(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const session = this.sessions.get(canonical);
    if (!session || session.sessionState === 'committed' || session.sessionState === 'rolled_back') {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session for writeCAS`
      );
    }
    return await session.writeCAS(fileWrite);
  }

  public async awaitSyncAndReload(
    workspaceRoot: string,
    target: BrowserTarget,
    options: { cursor: TerminalSyncCursor; pattern?: string; timeoutMs?: number },
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<{ sync: SyncSettleResult; reload: ReloadSettleResult; lineage: unknown }> {
    if (callerTenancy) this.assertTenancy(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const session = this.sessions.get(canonical);
    if (!session || session.sessionState === 'committed' || session.sessionState === 'rolled_back') {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session for sync settlement`
      );
    }
    return await session.awaitSyncAndReload(target, options);
  }

  public async settle(
    workspaceRoot: string,
    verdict: 'VERIFIED' | 'REJECTED' | 'HELD',
    details?: Record<string, unknown>,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<ThemeTransactionReceipt> {
    if (callerTenancy) this.assertTenancy(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const session = this.sessions.get(canonical);
    if (!session) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session to settle`
      );
    }
    const receipt = await session.settle(verdict, details);
    if (receipt.verdict === 'VERIFIED' || receipt.rolledBack) {
      this.sessions.delete(canonical);
    }
    return receipt;
  }

  public async resolveHold(
    workspaceRoot: string,
    action: 'rollback',
    reason?: string,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<{ action: 'rollback'; rollbackResult: WorkspaceRollbackResult }> {
    if (callerTenancy) this.assertTenancy(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const session = this.sessions.get(canonical);
    if (!session) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active held transaction session`
      );
    }
    const result = await session.resolveHold(action, reason);
    this.sessions.delete(canonical);
    return result;
  }

  public async rollback(
    workspaceRoot: string,
    reason?: string,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<WorkspaceRollbackResult> {
    if (callerTenancy) this.assertTenancy(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const session = this.sessions.get(canonical);
    if (!session) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session to rollback`
      );
    }
    const result = await session.rollback(reason);
    this.sessions.delete(canonical);
    return result;
  }

  private assertTenancy(callerTenancy?: Partial<RuntimeTenancyIdentity>): void {
    if (!callerTenancy) return;
    if (callerTenancy.projectId && callerTenancy.projectId !== this.tenancy.projectId) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        `Project tenancy mismatch: caller presented "${callerTenancy.projectId}", expected "${this.tenancy.projectId}"`
      );
    }
    if (callerTenancy.workspaceId && callerTenancy.workspaceId !== this.tenancy.workspaceId) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        `Workspace tenancy mismatch: caller presented "${callerTenancy.workspaceId}", expected "${this.tenancy.workspaceId}"`
      );
    }
  }
}
