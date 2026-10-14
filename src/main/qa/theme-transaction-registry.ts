/**
 * AntiFan Core — Theme Transaction Registry
 *
 * Runtime-owned transaction authority for storefront mutations.
 * One registry serves every project: each session records the tenancy that
 * opened it, and only that tenancy may drive it. Locks are keyed by canonical
 * workspace root and conflict on overlap (same, ancestor or descendant root).
 * Coordinates exclusive workspace locks, CAS writes, and R0 rollback.
 */

import * as path from 'node:path';
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

/** Live session plus the tenancy that opened it. */
interface RegisteredSession {
  readonly session: ThemeMutationSession;
  readonly owner: RuntimeTenancyIdentity;
}

/** True when `child` is `parent` or lies inside it (both canonical roots). */
function isWithinRoot(parent: string, child: string): boolean {
  const api = /^[a-z]:|^\\\\/i.test(parent) ? path.win32 : path.posix;
  const relative = api.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative));
}

function rootsOverlap(a: string, b: string): boolean {
  return isWithinRoot(a, b) || isWithinRoot(b, a);
}

function sameTenancy(a: Pick<RuntimeTenancyIdentity, 'projectId' | 'workspaceId'>, b: Pick<RuntimeTenancyIdentity, 'projectId' | 'workspaceId'>): boolean {
  return a.projectId === b.projectId && a.workspaceId === b.workspaceId;
}

export class ThemeTransactionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>(); // canonicalRoot -> session + owner
  private readonly inFlightReservations = new Set<string>();

  private browserPort?: BrowserControlPort;

  /**
   * @param defaultTenancy owner recorded for internal callers that present no tenancy
   * @param isTenancyActive whether a session owner's workspace is still attached; a
   *   session whose owner is gone may be rolled back by any caller whose workspace
   *   contains it, so a closed project can never wedge the lock until restart
   */
  constructor(
    private readonly defaultTenancy: RuntimeTenancyIdentity,
    private readonly filePort: WorkspaceFilePort,
    private readonly terminalManager?: TerminalManager,
    browserPort?: BrowserControlPort,
    private readonly isTenancyActive?: (tenancy: RuntimeTenancyIdentity) => boolean
  ) {
    this.browserPort = browserPort;
  }

  public bindBrowserPort(browserPort: BrowserControlPort): void {
    this.browserPort = browserPort;
  }

  /** Entry for exactly this canonical root; finished sessions are pruned. */
  private liveEntry(canonical: string): RegisteredSession | undefined {
    const entry = this.sessions.get(canonical);
    if (!entry) return undefined;
    if (entry.session.sessionState === 'committed' || entry.session.sessionState === 'rolled_back') {
      this.sessions.delete(canonical);
      return undefined;
    }
    return entry;
  }

  /** Live session whose root overlaps `canonical` (same, ancestor or descendant). */
  private overlappingEntry(canonical: string): RegisteredSession | undefined {
    for (const root of Array.from(this.sessions.keys())) {
      if (!rootsOverlap(root, canonical)) continue;
      const entry = this.liveEntry(root);
      if (entry) return entry;
    }
    return undefined;
  }

  private hasOverlappingReservation(canonical: string): boolean {
    for (const root of this.inFlightReservations) {
      if (rootsOverlap(root, canonical)) return true;
    }
    return false;
  }

  /** True while any transaction (or begin in flight) holds this root or one overlapping it. */
  public isLocked(workspaceRoot: string): boolean {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    return this.hasOverlappingReservation(canonical) || this.overlappingEntry(canonical) !== undefined;
  }

  /** The live session locking this root, including one opened on an overlapping root. */
  public getLockingSession(workspaceRoot: string): ThemeMutationSession | undefined {
    return this.overlappingEntry(canonicalizeWorkspaceRoot(workspaceRoot))?.session;
  }

  /**
   * Session id of the live transaction locking `workspaceRoot`, disclosed only
   * when `callerTenancy` matches the session's owner (or no tenancy is presented).
   */
  public getVisibleLockingSessionId(
    workspaceRoot: string,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): string | undefined {
    const active = this.overlappingEntry(canonicalizeWorkspaceRoot(workspaceRoot));
    if (!active) return undefined;
    const caller = this.callerIdentity(callerTenancy);
    if (caller && !sameTenancy(caller, active.owner)) return undefined;
    return active.session.sessionId;
  }

  public getActiveSession(workspaceRoot: string): ThemeMutationSession | undefined {
    return this.liveEntry(canonicalizeWorkspaceRoot(workspaceRoot))?.session;
  }

  public async begin(
    context: ThemeWorkspaceContext,
    callerTenancy?: Partial<RuntimeTenancyIdentity>,
    options?: BeginSessionOptions
  ): Promise<{ sessionId: string; canonicalRoot: string }> {
    const caller = this.callerIdentity(callerTenancy);
    const canonical = canonicalizeWorkspaceRoot(context.workspaceRoot);

    if (this.hasOverlappingReservation(canonical)) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" is locked by an in-flight transaction begin`,
        { workspaceRoot: canonical }
      );
    }
    const active = this.overlappingEntry(canonical);
    if (active) {
      // Another tenancy's session id and root path are not this caller's business.
      const visible = !caller || sameTenancy(caller, active.owner);
      const orphaned = this.isOrphaned(active.owner);
      const activeRoot = canonicalizeWorkspaceRoot(active.session.context.workspaceRoot);
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" is locked by ${visible ? `active transaction ${active.session.sessionId} on "${activeRoot}"` : 'an active transaction of another project'}` +
          (orphaned ? '. Its owning workspace is no longer attached: call theme.transaction.rollback from your own workspace to discard it.' : ''),
        { workspaceRoot: canonical, ...(visible ? { activeSessionId: active.session.sessionId } : {}), orphaned }
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
      this.sessions.set(canonical, { session, owner: caller ?? this.defaultTenancy });
      return { sessionId: session.sessionId, canonicalRoot: canonical };
    } finally {
      this.inFlightReservations.delete(canonical);
    }
  }

  /**
   * Verify that `workspaceRoot` has an active transaction and that `callerTenancy`
   * owns it. Used by capability pre-checks so no side effect (such as probing a
   * session's target tab) runs before ownership is established.
   */
  public assertSessionOwner(
    workspaceRoot: string,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): ThemeMutationSession {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const entry = this.liveEntry(canonical);
    const session = entry?.session;
    if (!session || session.sessionState === 'committed' || session.sessionState === 'rolled_back') {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session for writeCAS`
      );
    }
    this.assertOwner(canonical, entry!.owner, callerTenancy, false);
    return session;
  }

  public async writeCAS(
    workspaceRoot: string,
    fileWrite: CasFileWrite,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<CasFileResult> {
    const session = this.assertSessionOwner(workspaceRoot, callerTenancy);
    return await session.writeCAS(fileWrite);
  }

  public async awaitSyncAndReload(
    workspaceRoot: string,
    target: BrowserTarget,
    options: { cursor: TerminalSyncCursor; pattern?: string; timeoutMs?: number },
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<{ sync: SyncSettleResult; reload: ReloadSettleResult; lineage: unknown }> {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const entry = this.liveEntry(canonical);
    const session = entry?.session;
    if (!session || session.sessionState === 'committed' || session.sessionState === 'rolled_back') {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session for sync settlement`
      );
    }
    this.assertOwner(canonical, entry!.owner, callerTenancy, false);
    return await session.awaitSyncAndReload(target, options);
  }

  public async settle(
    workspaceRoot: string,
    verdict: 'VERIFIED' | 'REJECTED' | 'HELD',
    details?: Record<string, unknown>,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<ThemeTransactionReceipt> {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const entry = this.sessions.get(canonical);
    const session = entry?.session;
    if (!session) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session to settle`
      );
    }
    this.assertOwner(canonical, entry!.owner, callerTenancy, false);
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
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const target = this.rollbackTargetEntry(canonical, callerTenancy);
    if (!target) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active held transaction session`
      );
    }
    this.assertOwner(canonical, target.entry.owner, callerTenancy, true);
    const result = await target.entry.session.resolveHold(action, reason);
    this.sessions.delete(target.key);
    return result;
  }

  public async rollback(
    workspaceRoot: string,
    reason?: string,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): Promise<WorkspaceRollbackResult> {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const target = this.rollbackTargetEntry(canonical, callerTenancy);
    if (!target) {
      throw new CapabilityError(
        'TRANSACTION_CONFLICT',
        `Workspace "${canonical}" has no active transaction session to rollback`
      );
    }
    this.assertOwner(canonical, target.entry.owner, callerTenancy, true);
    const result = await target.entry.session.rollback(reason);
    this.sessions.delete(target.key);
    return result;
  }

  /**
   * Resolve the session targeted by `rollback` or `resolveHold` on `canonical`.
   * Exact-root lookup comes first. When `canonical` has no session of its own,
   * an overlapping session of another tenancy is returned so orphan takeover can
   * discard an orphaned ancestor/descendant lock while a live foreign owner is
   * still refused by `assertOwner`.
   */
  private rollbackTargetEntry(
    canonical: string,
    callerTenancy?: Partial<RuntimeTenancyIdentity>
  ): { key: string; entry: RegisteredSession } | undefined {
    const direct = this.liveEntry(canonical);
    if (direct) return { key: canonical, entry: direct };
    for (const root of Array.from(this.sessions.keys())) {
      if (!rootsOverlap(root, canonical)) continue;
      const entry = this.liveEntry(root);
      if (!entry) continue;
      const caller = this.callerIdentity(callerTenancy);
      if (this.isOrphaned(entry.owner) || (caller && !sameTenancy(caller, entry.owner))) {
        return { key: root, entry };
      }
    }
    return undefined;
  }

  /**
   * Identity of an external caller. `undefined` marks an internal call (no
   * tenancy presented); a presented tenancy must name both ids, so a context
   * that lost one of them can never slip past the owner check.
   */
  private callerIdentity(callerTenancy?: Partial<RuntimeTenancyIdentity>): RuntimeTenancyIdentity | undefined {
    if (callerTenancy === undefined) return undefined;
    if (!callerTenancy.projectId || !callerTenancy.workspaceId) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        'Caller tenancy must name both projectId and workspaceId to drive a theme transaction'
      );
    }
    return {
      projectId: callerTenancy.projectId,
      workspaceId: callerTenancy.workspaceId,
      runtimeId: callerTenancy.runtimeId ?? '',
    };
  }

  private isOrphaned(owner: RuntimeTenancyIdentity): boolean {
    return this.isTenancyActive ? !this.isTenancyActive(owner) : false;
  }

  /**
   * Only the tenancy that opened a session may drive it. The runtime id is not
   * compared: a re-paired attachment of the same project/workspace keeps control.
   * `allowOrphanTakeover` lets rollback/resolve_hold discard a session whose
   * owning workspace is no longer attached.
   */
  private assertOwner(
    canonical: string,
    owner: RuntimeTenancyIdentity,
    callerTenancy: Partial<RuntimeTenancyIdentity> | undefined,
    allowOrphanTakeover: boolean
  ): void {
    const caller = this.callerIdentity(callerTenancy);
    if (!caller || sameTenancy(caller, owner)) return;
    if (allowOrphanTakeover && this.isOrphaned(owner)) return;
    throw new CapabilityError(
      'WORKSPACE_UNBOUND',
      `Project tenancy mismatch: the transaction on "${canonical}" belongs to another project/workspace; caller presented project "${caller.projectId}" workspace "${caller.workspaceId}"`
    );
  }
}
