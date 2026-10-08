import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AttemptState,
  AuthenticatedCapabilityContext,
  AuthorityRevisionHandle,
  BrowserTarget,
  CapabilityError,
  CapabilityRisk,
  ClientInvocationIntent,
  ExecutionAttachmentRecord,
  MainResolvedAuthority,
  McpAttachmentLaunch,
  RuntimeLease,
  UntrustedCapabilityClaims,
  hashSecret,
  makeControlPlaneId,
  validateControlPlaneId,
  verifySecret,
} from '../../shared/control-plane-contracts';
export interface AttachmentValidatorDelegate {
  getAttemptState?: (attemptId: string) => AttemptState | undefined;
  getHostEpoch?: () => number;
  getProcessPid?: (runId: string, attemptId: string) => number | undefined;
  /**
   * Liveness of a bound owner process (`boundPid`). Injected so the registry can tell
   * "this owner is gone" from "this owner is quiet" without importing a process host.
   * A pid this predicate reports dead can never dispatch again — every dispatch path
   * refuses a `boundPid` mismatch (see `validateAttachment`), so the binding is holding
   * no work and may be released. Absent, no owner is ever considered gone.
   */
  isOwnerProcessAlive?: (pid: number) => boolean;
  getBackendId?: (attemptId: string) => string | undefined;
  getDocumentGeneration?: (tabId?: string) => number;
  getAutomationTabId?: () => string | null;
  isTabAllowed?: (record: any, tabId: string) => boolean;
  releaseSessionTab?: (sessionId: string, tabId: string) => boolean;
  releaseSessionTabPool?: (sessionId: string) => boolean;
}

/**
 * Close-admission seam. Injected by the composition root rather than imported, so
 * the attachment authority does not depend on the window/browser close coordinator
 * that implements it.
 *
 * A page whose close is reserved is on its way out of the process. A binding minted,
 * rebound or adopted onto it would be destroyed with it without the client ever
 * learning its authority had been lost, and an operation admitted against it would
 * either race the unload or be counted as idle work. Both halves are therefore
 * consulted at the admission points that hold a tab:
 *
 * - `isPageReserved(tabId)` gates every path that binds a tab (attachment mint,
 *   rebind, adopter rotation) and every path that admits tab-scoped work.
 * - `isApplicationAdmissionReserved()` gates every admission while a quit attempt holds
 *   application admission closed: bindings and operations admitted then would attach to
 *   services that attempt is about to dispose.
 * - `beginAdmittedOperation(tabIds?, ownerKey?)` registers in-flight work so a close
 *   measures it instead of guessing, attributing the operation to the pages it reaches
 *   and to the window that asked for it.
 *
 * Injecting nothing keeps the previous behaviour of every consumer.
 */
export interface PageCloseAdmission {
  /** True while the page's close is reserved: it accepts no new binding and no new work. */
  isPageReserved(tabId: string): boolean;
  /**
   * True while an application attempt (a quit) holds all admission closed. A binding or
   * an operation admitted during that window would be created against services that are
   * about to be torn down, so this is the broader refusal and is consulted before the
   * per-page reservation. Read synchronously and fail-closed: an implementation that
   * cannot answer must throw, and the consumer refuses rather than admitting.
   */
  isApplicationAdmissionReserved(): boolean;
  /**
   * Registers one admitted operation and returns its release, attributed to every page
   * it will reach (`tabIds`) so a close measuring that page counts real work instead of
   * guessing from a process-wide number, and to the window that asked for it (`ownerKey`)
   * so a shell-scope close counts work on pages it does not own as member pages — an
   * ephemeral or agent tab — instead of measuring that window as idle. An
   * implementation refuses admission by throwing
   * a `CapabilityError` from the shared error vocabulary; callers surface that refusal as
   * final (no retry-into-success, no silent redirect). The returned release must be safe
   * to call exactly once from every exit path, including a throw or a cancellation.
   */
  beginAdmittedOperation(tabIds?: string | readonly string[], ownerKey?: string): () => void;
}

export interface IssueAttachmentOptions {
  chatId?: string;
  backendId: string;
  lease: RuntimeLease;
  leaseToken: string;
  browserTarget?: BrowserTarget;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  ttlMs?: number;
  hostEpoch?: number;
  tabId?: string;
  browserEpoch?: number;
  documentGeneration?: number;
  boundPid?: number;
  /**
   * Terminal session this attachment was minted from (`antifan.cli.startSession`
   * `terminalSessionId`). Stamped on the record so every later validate re-resolves
   * the terminal's owning project: a terminal moved to another project must lose the
   * authority minted under the old one, not retain it silently.
   */
  originTerminalSessionId?: string;
}

function cloneBrowserTarget(target?: BrowserTarget): BrowserTarget | undefined {
  if (!target) return undefined;
  return Object.freeze({
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    runtimeId: target.runtimeId,
    tabId: target.tabId,
    browserEpoch: target.browserEpoch,
    documentGeneration: target.documentGeneration,
    ...(target.url !== undefined ? { url: target.url } : {}),
  });
}

function cloneAuthoritySnapshot(auth: MainResolvedAuthority): MainResolvedAuthority {
  return Object.freeze({
    attachmentId: auth.attachmentId,
    authorityRevision: auth.authorityRevision,
    revisionNumber: auth.revisionNumber,
    projectId: auth.projectId,
    workspaceId: auth.workspaceId,
    runId: auth.runId,
    attemptId: auth.attemptId,
    backendId: auth.backendId,
    grant: auth.grant,
    hostEpoch: auth.hostEpoch,
    runtimePid: auth.runtimePid,
    runtimeLeaseToken: auth.runtimeLeaseToken,
    leaseExpiresAt: auth.leaseExpiresAt,
    browserTarget: cloneBrowserTarget(auth.browserTarget),
    issuedAt: auth.issuedAt,
  });
}

// Heartbeat renewals slide `expiresAt` in memory on every tick; persisting each one costs a
// durable append per heartbeat per session. Renewals are therefore written through only once
// the in-memory expiry has drifted this far past the last persisted frame, bounding both the
// write rate (~1 append per threshold per session) and how stale a reloaded record can be
// after a restart.
const RENEWAL_PERSIST_THRESHOLD_MS = 60_000;
export const ATTACHMENT_SUSPENDED_GRACE_MS = 10_000;

export class AttachmentRegistry {
  private readonly records = new Map<string, ExecutionAttachmentRecord>();
  private readonly attemptIndex = new Map<string, Set<string>>();
  private readonly revisions = new Map<AuthorityRevisionHandle, MainResolvedAuthority>();
  private readonly activeRevisionByAttachment = new Map<string, AuthorityRevisionHandle>();
  private readonly revisionHistoryByAttachment = new Map<string, AuthorityRevisionHandle[]>();
  private readonly invocationNonces = new Map<string, Set<string>>();
  private readonly maxHistoricalRevisions: number;
  private isQuarantined = false;
  private mutationLock: Promise<void> = Promise.resolve();
  private closeAdmission?: PageCloseAdmission;
  private uncompactedFramesCount = 0;
  private readonly suspendedTimers = new Map<string, NodeJS.Timeout>();
  public suspendedGraceMs = ATTACHMENT_SUSPENDED_GRACE_MS;
  /**
   * Wall-clock stamp of the last durable frame per attachment. Renewals reset `expiresAt`
   * to `now + extensionMs`, so the throttle needs the elapsed time since the last durable
   * write tracked directly rather than derived from deadline arithmetic.
   */
  private readonly lastPersistedAtMs = new Map<string, number>();
  /**
   * Live connections renewing each attachment (attachmentId -> connection ids the last
   * renewal arrived through). The pid half of "is the owner gone" cannot answer for a
   * client whose renewals never carried a `boundPid`, so the connection is the second
   * liveness proof: a record only connection-renewed stays held while any of its
   * connections lives and is released by `revokeForConnection` when the last one is gone.
   * In-memory on purpose — a replayed record has no live connections, so nothing here
   * survives restart; the next live renewal re-stamps it.
   */
  private readonly connectionIndex = new Map<string, Set<string>>();
  /**
   * Project scope the composition root measures for a terminal session, used to
   * re-check an attachment minted from a terminal (`originTerminalSessionId`)
   * against where that terminal lives NOW. Absent → the check cannot verify and
   * refuses (terminal-origin authority is never trusted unmeasured).
   */
  private resolveTerminalProjectScope?: (terminalSessionId: string) => { projectId: string; workspaceId: string } | undefined;
  /**
   * Measured capsule affiliation of a tab. Used to refuse a terminal-origin
   * attachment whose bound tab provably belongs to a different project than the
   * attachment was minted under (e.g. an agent tab provisioned in the wrong
   * window). Undefined answer = unmeasured, not foreign — only positive foreign
   * evidence refuses.
   */
  private resolveTabAffiliation?: (tabId: string) => { projectId?: string; workspaceId?: string; capsuleId?: string } | undefined;
  constructor(
    private readonly delegate?: AttachmentValidatorDelegate,
    private readonly dataRoot?: string,
    maxHistoricalRevisions: number = 100,
    suspendedGraceMs?: number
  ) {
    this.maxHistoricalRevisions = Math.max(1, maxHistoricalRevisions ?? 100);
    if (typeof suspendedGraceMs === 'number' && Number.isFinite(suspendedGraceMs) && suspendedGraceMs >= 0) {
      this.suspendedGraceMs = suspendedGraceMs;
    }
  }

  private clearSuspendedTimer(attachmentId: string): void {
    clearTimeout(this.suspendedTimers.get(attachmentId));
    this.suspendedTimers.delete(attachmentId);
  }

  private runWithMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationLock.then(fn, fn);
    this.mutationLock = next.then(() => {}, () => {});
    return next;
  }
  public async initialize(currentRuntimeId?: string): Promise<void> {
    if (!this.dataRoot) return;
    const filePath = path.join(this.dataRoot, 'attachments-v1.jsonl');
    try {
      await fs.promises.access(filePath);
    } catch {
      return;
    }

    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    let processed = 0;
    let foreignRuntimeRecords = 0;
    const foreignRuntimeIds = new Set<string>();
    for (const line of lines) {
      if (++processed % 200 === 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setImmediate(resolve);
        await promise;
      }
      try {
        const frame = JSON.parse(line) as {
          formatVersion: number;
          record: ExecutionAttachmentRecord;
          revisions: MainResolvedAuthority[];
          checksum?: string;
        };
        if (frame.formatVersion !== 1 || !frame.record || !frame.record.id || !frame.checksum) {
          await this.quarantineAttachmentsAsync(filePath);
          return;
        }
        const { checksum, ...rest } = frame;
        const serialized = JSON.stringify(rest);
        const calculated = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
        if (checksum !== calculated) {
          await this.quarantineAttachmentsAsync(filePath);
          return;
        }
        const rec = frame.record;
        // An attachment's authority is scoped to the runtime that minted it, and
        // the runtime id is minted per process (`binding-<uuid>`). A frame
        // replayed from a previous process can therefore never dispatch again —
        // the catalogue refuses it with RUNTIME_MISMATCH — yet without this check
        // it is restored as `active` and renewed forever, so the client never
        // learns it must re-pair. Dropping it is also what lets the compaction
        // below physically remove the frame.
        const leaseRuntimeId = rec.lease?.runtimeId;
        if (currentRuntimeId && leaseRuntimeId && leaseRuntimeId !== currentRuntimeId) {
          foreignRuntimeRecords++;
          foreignRuntimeIds.add(leaseRuntimeId);
          continue;
        }
        if (Array.isArray(frame.revisions)) {
          const sortedRevs = [...frame.revisions].sort((a, b) => (a.revisionNumber || 0) - (b.revisionNumber || 0));
          const revHandles: AuthorityRevisionHandle[] = [];
          for (const rev of sortedRevs) {
            if (
              rev.attachmentId !== rec.id ||
              rev.projectId !== rec.projectId ||
              rev.workspaceId !== rec.workspaceId ||
              rev.runId !== rec.runId ||
              rev.attemptId !== rec.attemptId
            ) {
              await this.quarantineAttachmentsAsync(filePath);
              return;
            }
            this.revisions.set(rev.authorityRevision, cloneAuthoritySnapshot(rev));
            revHandles.push(rev.authorityRevision);
          }
          if (revHandles.length > this.maxHistoricalRevisions) {
            const toPrune = revHandles.splice(0, revHandles.length - this.maxHistoricalRevisions);
            for (const oldRev of toPrune) {
              this.revisions.delete(oldRev);
            }
          }
          const prevHistory = this.revisionHistoryByAttachment.get(rec.id);
          if (prevHistory) {
            const activeSet = new Set(revHandles);
            for (const oldHandle of prevHistory) {
              if (!activeSet.has(oldHandle)) {
                this.revisions.delete(oldHandle);
              }
            }
          }
          this.revisionHistoryByAttachment.set(rec.id, revHandles);
        } else if (rec.authorityRevision) {
          this.revisionHistoryByAttachment.set(rec.id, [rec.authorityRevision]);
        }

        this.records.set(rec.id, rec);
        this.lastPersistedAtMs.set(rec.id, Date.now());
        this.activeRevisionByAttachment.set(rec.id, rec.authorityRevision);
        if (!this.attemptIndex.has(rec.attemptId)) {
          this.attemptIndex.set(rec.attemptId, new Set());
        }
        this.attemptIndex.get(rec.attemptId)!.add(rec.id);
      } catch (err) {
        if (err instanceof CapabilityError && err.code === 'DURABILITY_FAILED') throw err;
        await this.quarantineAttachmentsAsync(filePath);
        return;
      }
    }
    this.uncompactedFramesCount = Math.max(0, lines.length - this.records.size);
    if (foreignRuntimeRecords > 0) {
      const foreignIds = [...foreignRuntimeIds];
      const named = foreignIds.slice(0, 5).join(', ');
      console.warn(
        `[AttachmentRegistry] Dropped ${foreignRuntimeRecords} attachment record(s) bound to foreign runtime(s) ` +
          `${named}${foreignIds.length > 5 ? ` (+${foreignIds.length - 5} more)` : ''}; current runtime is ` +
          `${currentRuntimeId}. Their owners re-pair through the bridge's 4001 path.`
      );
    }
    if (lines.length > Math.max(100, this.records.size * 1.5)) {
      await this.compactAttachmentsUnlocked();
    }
  }

  private async quarantineAttachmentsAsync(filePath: string): Promise<void> {
    this.isQuarantined = true;
    this.records.clear();
    this.revisions.clear();
    this.activeRevisionByAttachment.clear();
    this.revisionHistoryByAttachment.clear();
    this.attemptIndex.clear();
    this.connectionIndex.clear();
    this.invocationNonces.clear();
    this.lastPersistedAtMs.clear();
    const quarantinePath = `${filePath}.quarantine-${Date.now()}`;
    try {
      await fs.promises.rename(filePath, quarantinePath);
    } catch {}
    throw new CapabilityError('DURABILITY_FAILED', `Attachment registry file ${filePath} is corrupted and quarantined. Startup halted.`);
  }
  private async compactAttachmentsUnlocked(): Promise<void> {
    if (!this.dataRoot || this.isQuarantined) return;
    const filePath = path.join(this.dataRoot, 'attachments-v1.jsonl');
    const tempFile = path.join(this.dataRoot, `attachments-v1.jsonl.tmp-${Date.now()}`);
    const now = Date.now();
    const MAX_EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;

    const linesToWrite: string[] = [];
    const persistedIds = new Set<string>();
    for (const record of this.records.values()) {
      if (record.state !== 'active' && record.expiresAt && now > record.expiresAt + MAX_EXPIRED_RETENTION_MS) {
        continue;
      }
      const revHandles = this.revisionHistoryByAttachment.get(record.id) || [];
      const candidateRevisions: MainResolvedAuthority[] = [];
      for (const handle of revHandles) {
        const rev = this.revisions.get(handle);
        if (rev) candidateRevisions.push(cloneAuthoritySnapshot(rev));
      }
      const frameData = {
        formatVersion: 1,
        record: { ...record },
        revisions: candidateRevisions,
      };
      const serialized = JSON.stringify(frameData);
      const checksum = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
      linesToWrite.push(JSON.stringify({ ...frameData, checksum }) + '\n');
      persistedIds.add(record.id);
    }

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(tempFile, linesToWrite.join(''), 'utf8');
      await fs.promises.rename(tempFile, filePath);
      this.uncompactedFramesCount = 0;
      this.lastPersistedAtMs.clear();
      for (const id of persistedIds) {
        this.lastPersistedAtMs.set(id, now);
      }
    } catch (err) {
      try {
        if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
      } catch {}
      console.warn('[AttachmentRegistry] Compaction failed:', err);
    }
  }

  public async compact(): Promise<void> {
    return await this.runWithMutationLock(async () => {
      await this.compactAttachmentsUnlocked();
    });
  }

  private async appendPersistenceFrameUnlocked(record: ExecutionAttachmentRecord, candidateRevisions: MainResolvedAuthority[]): Promise<void> {
    if (!this.dataRoot) return;
    const filePath = path.join(this.dataRoot, 'attachments-v1.jsonl');
    const dir = path.dirname(filePath);

    const frameData = {
      formatVersion: 1,
      record: { ...record },
      revisions: candidateRevisions.map((r) => cloneAuthoritySnapshot(r)),
    };
    const serialized = JSON.stringify(frameData);
    const checksum = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
    const line = JSON.stringify({ ...frameData, checksum }) + '\n';

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(filePath, line, 'utf8');
    this.lastPersistedAtMs.set(record.id, Date.now());
    this.uncompactedFramesCount++;
    if (this.uncompactedFramesCount >= 500) {
      this.compactAttachmentsUnlocked().catch(() => {});
    }
  }

  public async flush(): Promise<void> {
    await this.mutationLock;
  }

  async issueAttachment(
    runId: string,
    attemptId: string,
    projectId: string,
    workspaceId: string,
    options: IssueAttachmentOptions
  ): Promise<{ record: ExecutionAttachmentRecord; launch: McpAttachmentLaunch }> {
    return await this.runWithMutationLock(async () => {
      if (this.isQuarantined) {
        throw new CapabilityError('DURABILITY_FAILED', 'Attachment registry is in quarantined failure state');
      }
      const validRunId = validateControlPlaneId(runId, 'run');
      const validAttemptId = validateControlPlaneId(attemptId, 'attempt');
      const validProjectId = validateControlPlaneId(projectId, 'project');
      const validWorkspaceId = validateControlPlaneId(workspaceId, 'workspace');
      const attachmentId = makeControlPlaneId('attachment');
      const plainSecret = crypto.randomBytes(32).toString('hex');
      const secretHash = hashSecret(plainSecret);
      const now = Date.now();
      const ttlMs = options.ttlMs ?? 3_600_000;
      const expiresAt = now + ttlMs;

      const initialRevision: AuthorityRevisionHandle = `rev_${crypto.randomBytes(16).toString('hex')}`;
      // Phase 2 (step 4): an attachment's browser binding must come from its OWN
      // explicit/browserTarget tab — NEVER from the process-global automation target
      // (which may belong to a different concurrent session). No delegatedAutomationTabId.
      const effectiveTabId = options.tabId ?? options.browserTarget?.tabId;
      // A reserved page is about to be destroyed with everything bound to it, so a
      // mint here would hand the caller authority that is already lost. Refused
      // before the record exists (and before any generation probe touches the page).
      this.assertPageAdmitsBinding(effectiveTabId, 'mint an attachment');

      let initialDocGen = options.documentGeneration ?? options.browserTarget?.documentGeneration;
      if (typeof initialDocGen !== 'number' && effectiveTabId && this.delegate?.getDocumentGeneration) {
        try {
          const liveGen = this.delegate.getDocumentGeneration(effectiveTabId);
          if (typeof liveGen === 'number' && liveGen > 0) {
            initialDocGen = liveGen;
          }
        } catch {}
      }
      const resolvedDocGen = initialDocGen ?? 1;

      const effectiveBrowserTarget: BrowserTarget | undefined = options.browserTarget
        ? cloneBrowserTarget({
            ...options.browserTarget,
            tabId: effectiveTabId || options.browserTarget.tabId,
            documentGeneration: options.browserTarget.documentGeneration ?? resolvedDocGen,
          })
        : (effectiveTabId ? {
            projectId: validProjectId,
            workspaceId: validWorkspaceId,
            runtimeId: options.lease.runtimeId,
            tabId: effectiveTabId,
            browserEpoch: options.browserEpoch ?? 1,
            documentGeneration: resolvedDocGen,
          } : undefined);

      const candidateRecord: ExecutionAttachmentRecord = {
        id: attachmentId,
        runId: validRunId,
        attemptId: validAttemptId,
        projectId: validProjectId,
        workspaceId: validWorkspaceId,
        chatId: options.chatId,
        secretHash,
        backendId: options.backendId,
        state: 'active',
        issuedAt: now,
        expiresAt,
        lease: options.lease,
        leaseToken: options.leaseToken,
        hostEpoch: options.hostEpoch ?? 1,
        browserTarget: effectiveBrowserTarget,
        grant: options.grant,
        tabId: effectiveTabId,
        browserEpoch: options.browserEpoch,
        documentGeneration: resolvedDocGen,
        boundPid: options.boundPid,
        ...(options.originTerminalSessionId ? { originTerminalSessionId: options.originTerminalSessionId } : {}),
        authorityRevision: initialRevision,
        revisionNumber: 1,
      };

      const candidateSnapshot = cloneAuthoritySnapshot({
        attachmentId,
        authorityRevision: initialRevision,
        revisionNumber: 1,
        projectId: validProjectId,
        workspaceId: validWorkspaceId,
        runId: validRunId,
        attemptId: validAttemptId,
        backendId: options.backendId,
        grant: options.grant || 'read',
        hostEpoch: options.hostEpoch ?? 1,
        runtimePid: options.lease.ownerPid,
        runtimeLeaseToken: options.leaseToken,
        leaseExpiresAt: options.lease.expiresAt,
        browserTarget: effectiveBrowserTarget,
        issuedAt: now,
      });

      // Durably append candidate frame before modifying in-memory state
      await this.appendPersistenceFrameUnlocked(candidateRecord, [candidateSnapshot]);

      // Now safely commit to in-memory maps
      this.records.set(attachmentId, candidateRecord);
      this.revisions.set(initialRevision, candidateSnapshot);
      this.activeRevisionByAttachment.set(attachmentId, initialRevision);
      this.revisionHistoryByAttachment.set(attachmentId, [initialRevision]);
      if (!this.attemptIndex.has(validAttemptId)) {
        this.attemptIndex.set(validAttemptId, new Set());
      }
      this.attemptIndex.get(validAttemptId)!.add(attachmentId);

      const launch: McpAttachmentLaunch = {
        attachmentId,
        runId: validRunId,
        attemptId: validAttemptId,
        projectId: validProjectId,
        workspaceId: validWorkspaceId,
        secret: plainSecret,
        backendId: options.backendId,
        issuedAt: now,
        expiresAt,
        hostEpoch: candidateRecord.hostEpoch,
        grant: options.grant,
        tabId: options.tabId,
        browserEpoch: options.browserEpoch,
        authorityRevision: initialRevision,
      };

      return { record: candidateRecord, launch };
    });
  }
  async rotateAuthorityRevision(
    attachmentId: string,
    overrides?: {
      browserTarget?: BrowserTarget;
      grant?: 'read' | 'write' | 'execute' | 'eval';
      lease?: RuntimeLease;
      leaseToken?: string;
      tabId?: string;
      documentGeneration?: number;
      expectedRevision?: string;
      expectedTabId?: string;
    }
  ): Promise<AuthorityRevisionHandle> {
    return await this.runWithMutationLock(async () => {
      if (this.isQuarantined) {
        throw new CapabilityError('DURABILITY_FAILED', 'Attachment registry is in quarantined failure state');
      }
      const record = this.records.get(attachmentId);
      if (!record) {
        throw new CapabilityError('ATTACHMENT_INVALID', `No attachment found for id: ${attachmentId}`);
      }
      const activeRev = this.activeRevisionByAttachment.get(attachmentId);
      const prevSnapshot = activeRev ? this.revisions.get(activeRev) : undefined;
      if (overrides?.expectedRevision !== undefined && activeRev !== overrides.expectedRevision) {
        throw new CapabilityError('TRANSACTION_CONFLICT', `CAS conflict: expected authority revision ${overrides.expectedRevision}, but active revision is ${activeRev ?? 'none'}`);
      }
      if (overrides?.expectedTabId !== undefined && record.tabId !== overrides.expectedTabId) {
        throw new CapabilityError('TRANSACTION_CONFLICT', `CAS conflict: expected tabId ${overrides.expectedTabId}, but current tabId is ${record.tabId ?? 'none'}`);
      }
      // Moving the binding onto a different page is a new binding even when the same
      // record is only adopting it: refusing here keeps an adopter from landing on a
      // page whose close is already reserved. A same-page rotation (a document
      // generation advance on the page this attachment already holds) is not a new
      // binding — its work was admitted before the reservation — so it is not refused.
      const rotationTabId = overrides?.tabId ?? overrides?.browserTarget?.tabId;
      if (rotationTabId !== undefined && rotationTabId !== record.tabId) {
        this.assertPageAdmitsBinding(rotationTabId, 'rotate attachment authority onto a tab');
      }
      const nextRevNumber = (prevSnapshot?.revisionNumber ?? record.revisionNumber ?? 1) + 1;
      const nextRev: AuthorityRevisionHandle = `rev_${crypto.randomBytes(16).toString('hex')}`;

      const candidateRecord: ExecutionAttachmentRecord = {
        ...record,
        revisionNumber: nextRevNumber,
        authorityRevision: nextRev,
        tabId: overrides?.tabId ?? (overrides?.browserTarget?.tabId ?? record.tabId),
        documentGeneration: overrides?.documentGeneration ?? (overrides?.browserTarget?.documentGeneration ?? record.documentGeneration),
        browserTarget: overrides?.browserTarget ? cloneBrowserTarget(overrides.browserTarget) : record.browserTarget,
        grant: overrides?.grant ?? record.grant,
        lease: overrides?.lease ?? record.lease,
        leaseToken: overrides?.leaseToken ?? record.leaseToken,
      };

      const nextSnapshot = cloneAuthoritySnapshot({
        attachmentId: record.id,
        authorityRevision: nextRev,
        revisionNumber: nextRevNumber,
        projectId: record.projectId,
        workspaceId: record.workspaceId,
        runId: record.runId,
        attemptId: record.attemptId,
        backendId: record.backendId,
        grant: candidateRecord.grant || 'read',
        hostEpoch: candidateRecord.hostEpoch,
        runtimePid: candidateRecord.lease?.ownerPid ?? process.pid,
        runtimeLeaseToken: candidateRecord.leaseToken,
        leaseExpiresAt: candidateRecord.lease?.expiresAt ?? candidateRecord.expiresAt,
        browserTarget: cloneBrowserTarget(candidateRecord.browserTarget),
        issuedAt: Date.now(),
      });

      const existingRevisions = Array.from(this.revisions.values()).filter((r) => r.attachmentId === attachmentId);
      const candidateRevisions = [...existingRevisions, nextSnapshot];

      // Durably append before modifying in-memory state
      await this.appendPersistenceFrameUnlocked(candidateRecord, candidateRevisions);

      // Now commit in-memory changes
      this.records.set(attachmentId, candidateRecord);
      this.revisions.set(nextRev, nextSnapshot);
      this.activeRevisionByAttachment.set(attachmentId, nextRev);
      const history = this.revisionHistoryByAttachment.get(attachmentId) || [];
      history.push(nextRev);
      if (history.length > this.maxHistoricalRevisions) {
        const toPrune = history.splice(0, history.length - this.maxHistoricalRevisions);
        for (const oldRev of toPrune) {
          this.revisions.delete(oldRev);
        }
      }
      this.revisionHistoryByAttachment.set(attachmentId, history);
      return nextRev;
    });
  }

  authenticateAttachmentCredentials(attachmentId: string, secret: string, connectionId?: string): ExecutionAttachmentRecord {
    if (this.isQuarantined) {
      throw new CapabilityError('DURABILITY_FAILED', 'Attachment registry is in quarantined failure state');
    }
    if (!attachmentId || typeof attachmentId !== 'string') {
      throw new CapabilityError('ATTACHMENT_INVALID', 'Attachment ID is missing or invalid');
    }
    if (!secret || typeof secret !== 'string') {
      throw new CapabilityError('ATTACHMENT_INVALID', 'Attachment secret is missing or invalid');
    }
    const record = this.records.get(attachmentId);
    if (!record) {
      throw new CapabilityError('ATTACHMENT_INVALID', `No attachment found for id: ${attachmentId}`);
    }
    if (!verifySecret(secret, record.secretHash)) {
      throw new CapabilityError('AUTHENTICATION_DENIED', 'Attachment secret verification failed');
    }
    if (record.state === 'revoked') {
      throw new CapabilityError('AUTHENTICATION_DENIED', `Attachment ${record.id} has been revoked`);
    }
    if (record.state === 'suspended') {
      this.clearSuspendedTimer(attachmentId);
      record.state = 'active';
      if (connectionId && typeof connectionId === 'string') {
        let conns = this.connectionIndex.get(attachmentId);
        if (!conns) {
          conns = new Set<string>();
          this.connectionIndex.set(attachmentId, conns);
        }
        conns.add(connectionId);
        record.connectionId = connectionId;
      }
    }
    return record;
  }

  /**
   * Terminal-origin attachments stay bound to the project their terminal lives
   * in: re-resolve the minting terminal's scope on every dispatch/validate so a
   * terminal moved to another project loses the authority minted under the old
   * one instead of silently retaining it. An unattributable terminal fails closed.
   * One level down, the bound tab itself must measure inside the minted project —
   * a measured-foreign tab is proof it was provisioned in another project's
   * window; an unmeasured affiliation is allowed (the bootstrap default capsule
   * legitimately carries none).
   */
  private assertTerminalOriginScope(record: ExecutionAttachmentRecord, tabId: string | undefined): void {
    if (!record.originTerminalSessionId) return;
    const scope = this.resolveTerminalProjectScope?.(record.originTerminalSessionId);
    if (!scope || scope.projectId !== record.projectId || scope.workspaceId !== record.workspaceId) {
      throw new CapabilityError(
        'PROJECT_MISMATCH',
        `Attachment ${record.id} was minted from terminal '${record.originTerminalSessionId}' under project '${record.projectId}'; ` +
          `that terminal now resolves to ${scope ? `project '${scope.projectId}'` : 'no attributable project'}, so this authority is refused. ` +
          'Re-mint the session from the terminal in its current project.',
        { attachmentId: record.id, originTerminalSessionId: record.originTerminalSessionId, mintedProjectId: record.projectId, mintedWorkspaceId: record.workspaceId, resolvedProjectId: scope?.projectId, resolvedWorkspaceId: scope?.workspaceId }
      );
    }
    if (tabId && this.resolveTabAffiliation) {
      const affiliation = this.resolveTabAffiliation(tabId);
      if (affiliation?.projectId && affiliation.projectId !== record.projectId) {
        throw new CapabilityError(
          'POLICY_DENIED',
          `Attachment ${record.id} is bound to tab '${tabId}' which measures in project '${affiliation.projectId}', ` +
            `not the terminal's minted project '${record.projectId}'. Rebind to a tab owned by that project's window.`,
          { attachmentId: record.id, boundTabId: tabId, mintedProjectId: record.projectId, measuredTabProjectId: affiliation.projectId }
        );
      }
    }
  }

  authenticateLineage(
    attachmentId: string,
    secret: string,
    lineage?: {
      projectId?: string;
      workspaceId?: string;
      runId?: string;
      attemptId?: string;
      authorityRevision?: string;
      connectionId?: string;
    }
  ): { record: ExecutionAttachmentRecord; authority: MainResolvedAuthority } {
    const record = this.authenticateAttachmentCredentials(attachmentId, secret, lineage?.connectionId);

    if (lineage?.runId && lineage.runId !== record.runId) {
      throw new CapabilityError('LINEAGE_MISMATCH', `Run ID mismatch: expected ${record.runId}, got ${lineage.runId}`);
    }
    if (lineage?.attemptId && lineage.attemptId !== record.attemptId) {
      throw new CapabilityError('LINEAGE_MISMATCH', `Attempt ID mismatch: expected ${record.attemptId}, got ${lineage.attemptId}`);
    }
    if (lineage?.projectId && lineage.projectId !== record.projectId) {
      throw new CapabilityError('PROJECT_MISMATCH', `Project ID mismatch: expected ${record.projectId}, got ${lineage.projectId}`);
    }
    if (lineage?.workspaceId && lineage.workspaceId !== record.workspaceId) {
      throw new CapabilityError('WORKSPACE_MISMATCH', `Workspace ID mismatch: expected ${record.workspaceId}, got ${lineage.workspaceId}`);
    }

    const revisionToLookup = lineage?.authorityRevision || this.activeRevisionByAttachment.get(record.id);
    if (!revisionToLookup) {
      throw new CapabilityError('AUTHENTICATION_DENIED', 'Authority revision is missing');
    }

    const snapshot = this.revisions.get(revisionToLookup);
    if (!snapshot || snapshot.attachmentId !== record.id) {
      throw new CapabilityError('AUTHENTICATION_DENIED', `Authority revision is not recognized for attachment ${record.id}`);
    }

    return { record, authority: cloneAuthoritySnapshot(snapshot) };
  }

  validateLiveExecution(record: ExecutionAttachmentRecord, revision: string, invocationId?: string): MainResolvedAuthority {
    if (record.state === 'expired' || Date.now() > record.expiresAt) {
      this.clearSuspendedTimer(record.id);
      record.state = 'expired';
      this.notifyDispose(record);
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has expired`);
    }

    if (record.state === 'revoked') {
      this.clearSuspendedTimer(record.id);
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has been revoked`);
    }

    if (record.state === 'suspended') {
      this.clearSuspendedTimer(record.id);
      record.state = 'active';
    }
    // Terminal-origin attachments stay bound to the project their terminal lives
    // in: re-resolve the minting terminal's scope on every dispatch so a terminal
    // moved to another project loses the authority minted under the old one.
    this.assertTerminalOriginScope(record, record.browserTarget?.tabId);

    const activeRevision = this.activeRevisionByAttachment.get(record.id);
    if (activeRevision !== revision) {
      throw new CapabilityError('REVISION_STALE', `Authority revision is inactive for new execution: expected ${activeRevision}, got ${revision}`);
    }

    if (invocationId) {
      let nonces = this.invocationNonces.get(record.id);
      if (!nonces) {
        nonces = new Set();
        this.invocationNonces.set(record.id, nonces);
      }
      if (nonces.has(invocationId)) {
        throw new CapabilityError('REPLAY_DENIED', `Duplicate invocation detected: ${invocationId}`);
      }
      nonces.add(invocationId);
    }

    if (!record.lease || record.lease.expiresAt <= Date.now()) {
      throw new CapabilityError('LEASE_EXPIRED', 'No active runtime lease bound to attachment');
    }

    if (this.delegate?.getAttemptState) {
      const state = this.delegate.getAttemptState(record.attemptId);
      if (state && state !== 'running' && state !== 'dispatching' && state !== 'prepared') {
        throw new CapabilityError('ATTEMPT_NOT_ACTIVE', `Attempt ${record.attemptId} is not active: state is ${state}`);
      }
    }

    const snapshot = this.revisions.get(revision);
    if (!snapshot || snapshot.attachmentId !== record.id) {
      throw new CapabilityError('TARGET_STALE', `Authority revision is not recognized for attachment ${record.id}`);
    }

    return cloneAuthoritySnapshot(snapshot);
  }

  resolveAuthority(intent: ClientInvocationIntent): MainResolvedAuthority {
    if (!intent || typeof intent !== 'object') {
      throw new CapabilityError('INVALID_ARGUMENT', 'Client invocation intent is required');
    }
    const { record } = this.authenticateLineage(intent.attachmentId, intent.attachmentSecret, {
      authorityRevision: intent.authorityRevision,
    });
    return this.validateLiveExecution(record, intent.authorityRevision);
  }

  resolveHistoricalRevision(intent: Pick<ClientInvocationIntent, 'attachmentId' | 'attachmentSecret' | 'authorityRevision'>): MainResolvedAuthority {
    if (!intent || typeof intent !== 'object') {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent is required');
    }
    const { authority } = this.authenticateLineage(intent.attachmentId, intent.attachmentSecret, {
      authorityRevision: intent.authorityRevision,
    });
    return authority;
  }

  canReadReceipt(
    grant?: CapabilityRisk,
    requiredPermission?: CapabilityRisk,
    recordedVisibility?: string
  ): boolean {
    if (recordedVisibility === 'redacted') return false;
    if (!requiredPermission || requiredPermission === 'read') return true;
    if (requiredPermission === 'write') {
      return grant === 'write' || grant === 'execute' || grant === 'eval';
    }
    if (requiredPermission === 'execute') {
      return grant === 'execute' || grant === 'eval';
    }
    if (requiredPermission === 'eval') {
      return grant === 'eval';
    }
    return false;
  }

  authorizeReceiptRead(
    intent: Pick<ClientInvocationIntent, 'attachmentId' | 'attachmentSecret'>,
    requiredPermission?: CapabilityRisk,
    recordedVisibility?: string
  ): { allowed: boolean; record: ExecutionAttachmentRecord; authority: MainResolvedAuthority } {
    const { record, authority } = this.authenticateLineage(intent.attachmentId, intent.attachmentSecret);
    const allowed = this.canReadReceipt(authority.grant, requiredPermission, recordedVisibility);
    return { allowed, record, authority };
  }
  validateAttachment(claims?: UntrustedCapabilityClaims): AuthenticatedCapabilityContext {
    if (!claims || typeof claims !== 'object') {
      throw new CapabilityError('MCP_CONTEXT_REQUIRED', 'Authoritative MCP attachment claims are required');
    }

    if (!claims.attachmentId || typeof claims.attachmentId !== 'string') {
      throw new CapabilityError('ATTACHMENT_INVALID', 'Attachment ID is missing or invalid');
    }

    if (!claims.attachmentSecret || typeof claims.attachmentSecret !== 'string') {
      throw new CapabilityError('ATTACHMENT_INVALID', 'Attachment secret is missing or invalid');
    }

    const record = this.records.get(claims.attachmentId);
    if (!record) {
      throw new CapabilityError('ATTACHMENT_INVALID', `No attachment found for id: ${claims.attachmentId}`);
    }

    if (!verifySecret(claims.attachmentSecret, record.secretHash)) {
      throw new CapabilityError('ATTACHMENT_INVALID', 'Attachment secret verification failed');
    }

    if (record.state === 'revoked') {
      this.clearSuspendedTimer(record.id);
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has been revoked`);
    }

    if (record.state === 'expired' || Date.now() > record.expiresAt) {
      this.clearSuspendedTimer(record.id);
      record.state = 'expired';
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has expired`);
    }

    if (record.state === 'suspended') {
      this.clearSuspendedTimer(record.id);
      record.state = 'active';
    }

    if (claims.runId && claims.runId !== record.runId) {
      throw new CapabilityError('LINEAGE_MISMATCH', `Run ID mismatch: expected ${record.runId}, got ${claims.runId}`);
    }

    if (claims.attemptId && claims.attemptId !== record.attemptId) {
      throw new CapabilityError('LINEAGE_MISMATCH', `Attempt ID mismatch: expected ${record.attemptId}, got ${claims.attemptId}`);
    }

    if (claims.projectId && claims.projectId !== record.projectId) {
      throw new CapabilityError('LINEAGE_MISMATCH', `Project ID mismatch: expected ${record.projectId}, got ${claims.projectId}`);
    }

    if (claims.workspaceId && claims.workspaceId !== record.workspaceId) {
      throw new CapabilityError('LINEAGE_MISMATCH', `Workspace ID mismatch: expected ${record.workspaceId}, got ${claims.workspaceId}`);
    }
    if (claims.tabId && record.tabId && claims.tabId !== record.tabId) {
      const isAllowed = this.delegate?.isTabAllowed ? this.delegate.isTabAllowed(record as any, claims.tabId) : false;
      if (!isAllowed) {
        throw new CapabilityError('TARGET_MISMATCH', `Tab ID mismatch: expected ${record.tabId}, got ${claims.tabId}`);
      }
    }

    if (claims.browserEpoch !== undefined && record.browserEpoch !== undefined && claims.browserEpoch !== record.browserEpoch) {
      throw new CapabilityError('TARGET_MISMATCH', `Browser epoch mismatch: expected ${record.browserEpoch}, got ${claims.browserEpoch}`);
    }

    if (!claims.invocationId || typeof claims.invocationId !== 'string' || claims.invocationId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Authoritative invocationId is required for capability invocation replay protection');
    }

    let nonces = this.invocationNonces.get(record.id);
    if (!nonces) {
      nonces = new Set();
      this.invocationNonces.set(record.id, nonces);
    }
    if (nonces.has(claims.invocationId)) {
      throw new CapabilityError('REPLAY_DENIED', `Duplicate invocation detected: ${claims.invocationId}`);
    }
    if (this.delegate) {
      if (this.delegate.getHostEpoch) {
        const currentHostEpoch = this.delegate.getHostEpoch();
        if (record.hostEpoch !== currentHostEpoch) {
          this.clearSuspendedTimer(record.id);
          record.state = 'revoked';
          throw new CapabilityError('ATTACHMENT_STALE', `Attachment host epoch ${record.hostEpoch} does not match current host epoch ${currentHostEpoch}`);
        }
      }

      if (this.delegate.getAttemptState) {
        const attemptState = this.delegate.getAttemptState(record.attemptId);
        if (attemptState === undefined || (attemptState !== 'running' && attemptState !== 'prepared' && attemptState !== 'dispatching')) {
          this.clearSuspendedTimer(record.id);
          record.state = 'revoked';
          throw new CapabilityError('ATTEMPT_NOT_ACTIVE', `Attempt ${record.attemptId} is in terminal or inactive state: ${attemptState ?? 'unknown'}`);
        }
      }

      if (this.delegate.getBackendId) {
        const backendId = this.delegate.getBackendId(record.attemptId);
        if (!backendId || backendId !== record.backendId) {
          throw new CapabilityError('LINEAGE_MISMATCH', `Backend mismatch: expected ${record.backendId}, got ${backendId ?? 'none'}`);
        }
      }

      if (this.delegate.getProcessPid) {
        const expectedPid = this.delegate.getProcessPid(record.runId, record.attemptId);
        if (expectedPid !== undefined) {
          if (claims.ownerPid === undefined || claims.ownerPid !== expectedPid) {
            throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${expectedPid}, got ${claims.ownerPid ?? 'none'}`);
          }
        } else if (record.boundPid !== undefined) {
          if (claims.ownerPid === undefined || claims.ownerPid !== record.boundPid) {
            throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${record.boundPid}, got ${claims.ownerPid ?? 'none'}`);
          }
        }
      } else if (record.boundPid !== undefined) {
        if (claims.ownerPid === undefined || claims.ownerPid !== record.boundPid) {
          throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${record.boundPid}, got ${claims.ownerPid ?? 'none'}`);
        }
      }
    } else if (record.boundPid !== undefined) {
      if (claims.ownerPid === undefined || claims.ownerPid !== record.boundPid) {
        throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${record.boundPid}, got ${claims.ownerPid ?? 'none'}`);
      }
    }
    if (!record.lease) {
      throw new CapabilityError('UNAUTHENTICATED', 'No runtime lease bound to attachment');
    }

    nonces.add(claims.invocationId);
    const effectiveLease = {
      ...record.lease,
      expiresAt: Math.max(record.lease.expiresAt, record.expiresAt),
    };

    let targetTabId = record.tabId || '';
    // Phase 2 (step 4/6): the attachment's binding comes only from its OWN record.
    // Previously `|| this.delegate.getAutomationTabId()` let an attachment with no
    // owned tab latch onto another session's global automation target. Fail closed:
    // a bindingless attachment keeps an empty tabId → TARGET_REQUIRED.
    let docGen = record.documentGeneration || 1;
    if (targetTabId && this.delegate?.getDocumentGeneration) {
      const dynamicGen = this.delegate.getDocumentGeneration(targetTabId);
      if (typeof dynamicGen === 'number' && dynamicGen > 0) {
        docGen = dynamicGen;
      }
    }
    // Terminal-origin attachments stay bound to the project their terminal lives
    // in — enforced by the shared gate before the target snapshot is returned.
    this.assertTerminalOriginScope(record, targetTabId || record.browserTarget?.tabId);
    const effectiveBrowserTarget: BrowserTarget = record.browserTarget ? {
      ...record.browserTarget,
      tabId: targetTabId || record.browserTarget.tabId,
      documentGeneration: docGen,
    } : {
      projectId: record.projectId,
      workspaceId: record.workspaceId,
      runtimeId: record.lease.runtimeId,
      tabId: targetTabId,
      browserEpoch: record.browserEpoch || record.hostEpoch || 1,
      documentGeneration: docGen,
    };
    // No in-place mutation of lease expiry during validateAttachment (preserves immutable revision semantics)

    return {
      attachmentId: record.id,
      runId: record.runId,
      attemptId: record.attemptId,
      projectId: record.projectId,
      workspaceId: record.workspaceId,
      chatId: record.chatId,
      backendId: record.backendId,
      hostEpoch: record.hostEpoch,
      invocationId: claims.invocationId,
      lease: effectiveLease,
      leaseToken: record.leaseToken || '',
      browserTarget: effectiveBrowserTarget,
      grant: record.grant || claims.grant,
    };
  }
  async updateAttachmentTab(
    attachmentId: string,
    tabId: string,
    documentGeneration?: number,
    casOptions?: { expectedRevision?: string; expectedTabId?: string }
  ): Promise<AuthorityRevisionHandle | null> {
    const record = this.records.get(attachmentId);
    if (!record) {
      console.warn(`[AttachmentRegistry] updateAttachmentTab: no record for attachment ${attachmentId}`);
      return null;
    }
    if (casOptions?.expectedRevision !== undefined) {
      const activeRev = this.activeRevisionByAttachment.get(attachmentId);
      if (activeRev !== casOptions.expectedRevision) {
        console.warn(`[AttachmentRegistry] updateAttachmentTab: CAS revision mismatch for ${attachmentId} (expected ${casOptions.expectedRevision}, active ${activeRev})`);
        return null;
      }
    }
    if (casOptions?.expectedTabId !== undefined && record.tabId !== casOptions.expectedTabId) {
      console.warn(`[AttachmentRegistry] updateAttachmentTab: CAS tabId mismatch for ${attachmentId} (expected ${casOptions.expectedTabId}, bound ${record.tabId})`);
      return null;
    }
    const affiliation = this.resolveTabAffiliation?.(tabId);
    if (affiliation?.projectId && affiliation.projectId !== record.projectId) {
      throw new CapabilityError('PROJECT_MISMATCH', 'Rebinding cannot grant authority over a foreign project');
    }
    if (affiliation?.workspaceId && affiliation.workspaceId !== record.workspaceId) {
      throw new CapabilityError('WORKSPACE_MISMATCH', 'Rebinding cannot grant authority over a foreign workspace');
    }
    // Only a move onto a different page is a new binding: a same-page generation
    // refresh settles work admitted before the reservation, so a reserved page's
    // already-bound authority survives its own close long enough to be honest about
    // what it did.
    if (record.tabId !== tabId) {
      this.assertPageAdmitsBinding(tabId, 'rebind the attachment');
    }
    let docGen = documentGeneration;
    if (casOptions) {
      if (typeof docGen !== 'number' || !Number.isFinite(docGen) || docGen < 1) {
        return null;
      }
    } else if (typeof docGen !== 'number' && this.delegate?.getDocumentGeneration) {
      try {
        const liveGen = this.delegate.getDocumentGeneration(tabId);
        if (typeof liveGen === 'number' && liveGen > 0) {
          docGen = liveGen;
        }
      } catch {}
    }
    const resolvedDocGen = typeof docGen === 'number' && Number.isFinite(docGen) && docGen > 0
      ? Math.floor(docGen)
      : record.documentGeneration || record.browserTarget?.documentGeneration || 1;
    const currentTarget: BrowserTarget = record.browserTarget ? {
      ...record.browserTarget,
      tabId,
      documentGeneration: resolvedDocGen,
    } : {
      projectId: record.projectId,
      workspaceId: record.workspaceId,
      runtimeId: record.lease?.runtimeId || '',
      tabId,
      browserEpoch: record.browserEpoch || record.hostEpoch || 1,
      documentGeneration: resolvedDocGen,
    };
    const previousTabId = record.tabId;
    try {
      const nextRevision = await this.rotateAuthorityRevision(attachmentId, {
        browserTarget: currentTarget,
        tabId,
        documentGeneration: resolvedDocGen,
        expectedRevision: casOptions?.expectedRevision,
        expectedTabId: casOptions?.expectedTabId,
      });
      // The rotation moved the binding to a different tab: the old bound tab's
      // session slot is no longer held by this attachment. Releasing is
      // bookkeeping only — a failure must never fail the rotation — and the
      // same-tab no-op releases nothing.
      if (previousTabId && previousTabId !== tabId && this.delegate?.releaseSessionTab) {
        try {
          this.delegate.releaseSessionTab(previousTabId, previousTabId);
        } catch (err) {
          console.warn(`[AttachmentRegistry] Failed to release session tab ${previousTabId} after rebind:`, err);
        }
      }
      return nextRevision;
    } catch (err: unknown) {
      if (err instanceof CapabilityError && err.code === 'TRANSACTION_CONFLICT') {
        console.warn(`[AttachmentRegistry] updateAttachmentTab: TRANSACTION_CONFLICT rotating ${attachmentId} to tab ${tabId}`);
        return null;
      }
      throw err;
    }
  }
  getDocumentGeneration(tabId?: string): number | undefined {
    if (this.delegate?.getDocumentGeneration) {
      try {
        const liveGen = this.delegate.getDocumentGeneration(tabId);
        if (typeof liveGen === 'number' && Number.isFinite(liveGen) && liveGen > 0) {
          return Math.floor(liveGen);
        }
      } catch {}
    }
    return undefined;
  }
  getAttachment(attachmentId: string): ExecutionAttachmentRecord | undefined {
    return this.records.get(attachmentId);
  }

  verifyConnectionToken(token: string): string | null {
    if (!token || typeof token !== 'string') return null;
    const now = Date.now();
    for (const record of this.records.values()) {
      if ((record.state === 'active' || record.state === 'suspended') && now <= record.expiresAt) {
        if (verifySecret(token, record.secretHash)) {
          return record.id;
        }
      }
    }
    return null;
  }
  verifyAttachmentSecret(attachmentId: string, secret: string): boolean {
    if (!attachmentId || typeof attachmentId !== 'string' || !secret || typeof secret !== 'string') return false;
    const record = this.records.get(attachmentId);
    if (!record || (record.state !== 'active' && record.state !== 'suspended') || Date.now() > record.expiresAt) return false;
    return verifySecret(secret, record.secretHash);
  }
  async renewAttachment(
    attachmentId: string,
    secret: string,
    options?: { extensionMs?: number; ownerPid?: number; connectionId?: string }
  ): Promise<{ expiresAt: number }> {
    return await this.runWithMutationLock(async () => {
      if (this.isQuarantined) {
        throw new CapabilityError('DURABILITY_FAILED', 'Attachment registry is in quarantined failure state');
      }
      if (!attachmentId || typeof attachmentId !== 'string' || !secret || typeof secret !== 'string') {
        throw new CapabilityError('ATTACHMENT_INVALID', 'Valid attachmentId and secret are required for renewal');
      }
      const record = this.records.get(attachmentId);
      if (!record) {
        throw new CapabilityError('ATTACHMENT_INVALID', `No attachment found for id: ${attachmentId}`);
      }
      if (!verifySecret(secret, record.secretHash)) {
        throw new CapabilityError('ATTACHMENT_INVALID', 'Attachment secret verification failed');
      }
      if (Date.now() > record.expiresAt) {
        this.clearSuspendedTimer(attachmentId);
        record.state = 'expired';
        throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has expired`);
      }
      this.clearSuspendedTimer(attachmentId);
      if (record.state === 'suspended') {
        record.state = 'active';
      }
      if (record.state !== 'active') {
        throw new CapabilityError(
          'ATTACHMENT_STALE',
          `Attachment ${record.id} is not renewable in state ${record.state}`
        );
      }

      if (this.delegate) {
        if (this.delegate.getHostEpoch) {
          const currentHostEpoch = this.delegate.getHostEpoch();
          if (record.hostEpoch !== currentHostEpoch) {
            this.clearSuspendedTimer(record.id);
            record.state = 'revoked';
            throw new CapabilityError('ATTACHMENT_STALE', `Attachment host epoch ${record.hostEpoch} does not match current host epoch ${currentHostEpoch}`);
          }
        }
        if (this.delegate.getAttemptState) {
          const attemptState = this.delegate.getAttemptState(record.attemptId);
          // `undefined` means "this registry does not track that attempt", not "that attempt is
          // dead". Pairing-exchange attachments are minted straight into the registry with a fresh
          // run/attempt pair that RunService never registers (bridge-server startSession), so an
          // unknown attempt is the NORMAL answer for them -- validateLiveExecution already reads it
          // that way (`if (state && ...)` above). Revoking on it here made every pair-minted
          // attachment a one-shot handle that the first heartbeat renewal killed, which surfaced
          // mid-session as `AUTHENTICATION_DENIED: Attachment <id> has been revoked` and forced a
          // fresh pairing exchange on nearly every tool call.
          if (attemptState !== undefined && attemptState !== 'running' && attemptState !== 'prepared' && attemptState !== 'dispatching') {
            this.clearSuspendedTimer(record.id);
            record.state = 'revoked';
            throw new CapabilityError('ATTEMPT_NOT_ACTIVE', `Attempt ${record.attemptId} is in terminal or inactive state: ${attemptState}`);
          }
        }
        if (this.delegate.getBackendId) {
          const backendId = this.delegate.getBackendId(record.attemptId);
          // `undefined` here means the same thing it means one block above: this
          // registry does not track that attempt. Pairing-exchange attachments are
          // minted straight into the registry with a run/attempt pair RunService
          // never registers, so reading `undefined` as a lineage violation made
          // renewSession fail for every one of them — which is the client's only
          // liveness proof for reusing a live attachment, so each recovery spent a
          // fresh pairing code. A backend that is *reported* and differs still fails.
          if (backendId !== undefined && backendId !== record.backendId) {
            throw new CapabilityError('LINEAGE_MISMATCH', `Backend mismatch: expected ${record.backendId}, got ${backendId ?? 'none'}`);
          }
        }
        if (this.delegate.getProcessPid) {
          const expectedPid = this.delegate.getProcessPid(record.runId, record.attemptId);
          if (expectedPid !== undefined) {
            if (options?.ownerPid === undefined || options.ownerPid !== expectedPid) {
              throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${expectedPid}, got ${options?.ownerPid ?? 'none'}`);
            }
          } else if (record.boundPid !== undefined) {
            if (options?.ownerPid === undefined || options.ownerPid !== record.boundPid) {
              throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${record.boundPid}, got ${options?.ownerPid ?? 'none'}`);
            }
          }
        } else if (record.boundPid !== undefined) {
          if (options?.ownerPid === undefined || options.ownerPid !== record.boundPid) {
            throw new CapabilityError('PROCESS_MISMATCH', `Process PID mismatch: expected ${record.boundPid}, got ${options?.ownerPid ?? 'none'}`);
          }
        }
      }

      const now = Date.now();
      const extensionMs = options?.extensionMs ?? 3_600_000;
      // A renewal restarts the window rather than extending the previous deadline: the
      // expiry is always `now + extensionMs`, so a heartbeat can never stack extensions
      // into an unbounded TTL. The embedded lease mirrors the same deadline so the
      // LEASE_EXPIRED gate in validateLiveExecution tracks the attachment's real lifetime.
      const newExpiresAt = now + extensionMs;
      const updatedLease = record.lease ? { ...record.lease, expiresAt: newExpiresAt } : record.lease;
      const candidateRecord: ExecutionAttachmentRecord = {
        ...record,
        expiresAt: newExpiresAt,
        lease: updatedLease,
        boundPid: options?.ownerPid ?? record.boundPid,
        connectionId: options?.connectionId ?? record.connectionId,
      };

      const existingRevisions = Array.from(this.revisions.values()).filter((r) => r.attachmentId === attachmentId);
      // A heartbeat renewal only slides the lease window. Persisting that on every tick costs one
      // durable append per second per session, re-serializing every revision each time and driving
      // the 500-frame compaction threshold — measured on a live bridge as a 2.3s first append and
      // 200-2500ms stalls on concurrent dispatch, scaling with heartbeat frequency. Renewals are
      // therefore written through on a throttle: once the last durable frame is
      // RENEWAL_PERSIST_THRESHOLD_MS old, and immediately whenever `boundPid` changes (an
      // authority-affecting binding). Elapsed wall-clock is the criterion because the live
      // record's deadline slides on every renewal — the registry does not retain the last
      // persisted frame's expiry, so time since the last write is tracked directly. The
      // invariant this preserves: after a restart, initialize() replays the last persisted frame,
      // so a reloaded record's expiresAt lags the live in-memory value by at most the threshold —
      // a still-live owner's next heartbeat renews from that floor instead of hitting
      // ATTACHMENT_STALE, while a dead process's extension is moot either way.
      const lastPersistedAt = this.lastPersistedAtMs.get(attachmentId);
      if (
        candidateRecord.boundPid !== record.boundPid ||
        candidateRecord.connectionId !== record.connectionId ||
        lastPersistedAt === undefined ||
        now - lastPersistedAt >= RENEWAL_PERSIST_THRESHOLD_MS
      ) {
        await this.appendPersistenceFrameUnlocked(candidateRecord, existingRevisions);
      }
      this.records.set(attachmentId, candidateRecord);
      if (options?.connectionId) {
        // Every renewal from a connection counts it among this record's live owners;
        // `revokeForConnection` removes it when the socket closes. A renewal without a
        // connection id changes nothing here — whoever renewed last keeps the release
        // reachable, and a connection-less path never steals another owner's binding.
        let conns = this.connectionIndex.get(attachmentId);
        if (!conns) {
          conns = new Set<string>();
          this.connectionIndex.set(attachmentId, conns);
        }
        conns.add(options.connectionId);
      }
      return { expiresAt: candidateRecord.expiresAt };
    });
  }

  private async revokeAttachmentUnlocked(attachmentId: string): Promise<void> {
    this.clearSuspendedTimer(attachmentId);
    const record = this.records.get(attachmentId);
    if (record) {
      // A terminal record renews nothing, so its renewing connections stop counting it:
      // otherwise a socket that outlives the revocation would hold a dead claim here.
      this.connectionIndex.delete(attachmentId);
      const candidateRecord: ExecutionAttachmentRecord = {
        ...record,
        state: 'revoked',
        revokedAt: Date.now(),
      };
      const existingRevisions = Array.from(this.revisions.values()).filter((r) => r.attachmentId === attachmentId);
      await this.appendPersistenceFrameUnlocked(candidateRecord, existingRevisions);
      this.records.set(attachmentId, candidateRecord);
      this.notifyDispose(candidateRecord);
    }
  }

  /**
   * Releases every active binding whose only renewing connections are gone.
   *
   * The pid half of "is the owner gone" cannot answer for a client whose renewals
   * carried no `boundPid`: `revokeGoneOwnerAttachments` must retain that record and its
   * page counts as live use forever (the defect this fixes). The connection is the
   * second liveness proof — the caller reports which transport closed, every record
   * that connection renewed drops its id, and a record left with no live renewing
   * connection is released. A record another live connection still renews is NOT
   * revoked: its set stays non-empty until the last one is gone.
   *
   * Revocation is the same durable mutation as `revokeForAttempt`, so the record, its
   * persisted frame and the ownership-disposal hook stay consistent with any other end
   * of session.
   */
  async revokeForConnection(connectionId: string): Promise<void> {
    await this.runWithMutationLock(async () => {
      if (!connectionId || typeof connectionId !== 'string') return;
      const releasable: string[] = [];
      for (const [attachmentId, conns] of this.connectionIndex) {
        // A record this connection never renewed stays untouched: only a record it
        // renewed can be released by its close, and only when it was the last renewing
        // connection standing.
        if (!conns.delete(connectionId)) continue;
        if (conns.size === 0) {
          this.connectionIndex.delete(attachmentId);
          const record = this.records.get(attachmentId);
          if (record && record.state === 'active') {
            if (this.suspendedGraceMs <= 0) {
              releasable.push(attachmentId);
            } else {
              record.state = 'suspended';
              this.clearSuspendedTimer(attachmentId);
              const timer = setTimeout(() => {
                void this.runWithMutationLock(async () => {
                  this.suspendedTimers.delete(attachmentId);
                  const current = this.records.get(attachmentId);
                  if (current && current.state === 'suspended') {
                    await this.revokeAttachmentUnlocked(attachmentId);
                  }
                });
              }, this.suspendedGraceMs);
              timer.unref?.();
              this.suspendedTimers.set(attachmentId, timer);
            }
          }
        }
      }
      for (const attachmentId of releasable) {
        await this.revokeAttachmentUnlocked(attachmentId);
      }
    });
  }

  async revokeAttachment(attachmentId: string): Promise<void> {
    await this.runWithMutationLock(async () => {
      await this.revokeAttachmentUnlocked(attachmentId);
    });
  }

  dispose(): void {
    for (const [attachmentId, timer] of this.suspendedTimers) {
      clearTimeout(timer);
      const record = this.records.get(attachmentId);
      if (record && record.state === 'suspended') {
        record.state = 'revoked';
        record.revokedAt = Date.now();
        this.notifyDispose(record);
      }
    }
    this.suspendedTimers.clear();
  }

  /**
   * Injects the close-admission seam (see {@link PageCloseAdmission}). Optional: with
   * nothing injected every binding path keeps its previous behaviour.
   */
  setCloseAdmission(admission?: PageCloseAdmission): void {
    this.closeAdmission = admission;
  }

  /**
   * Bind the terminal project-scope resolver after construction: RunService builds
   * this registry inside its own constructor, before the runtime's resolver exists,
   * so the seam arrives here instead of through AttachmentValidatorDelegate.
   */
  setTerminalProjectScopeResolver(
    resolver?: (terminalSessionId: string) => { projectId: string; workspaceId: string } | undefined
  ): void {
    this.resolveTerminalProjectScope = resolver;
  }

  /**
   * Bind the measured tab-affiliation resolver (same probe the browser port uses for
   * routed tab creation). Terminal-origin attachments consult it per validate so a
   * bound tab in a foreign window refuses instead of silently retaining authority.
   */
  setTabAffiliationResolver(
    resolver?: (tabId: string) => { projectId?: string; workspaceId?: string; capsuleId?: string } | undefined
  ): void {
    this.resolveTabAffiliation = resolver;
  }

  /**
   * Refuse a binding while the application admits no new work, or whose target page has
   * its close reserved.
   *
   * `operation` names the refused intent so the caller can act on it. The application
   * gate comes first because it is the broader one: during a quit attempt the services a
   * new binding would rely on are on their way out, whatever page it names — including a
   * bindless mint. The refusal is the existing `RUNTIME_DRAINING` failure and it is not
   * silent: nothing is bound and the caller retries once the quit finishes or is refused.
   *
   * The per-page refusal stays the existing `TARGET_STALE` failure — the page is leaving
   * — and it is final: no silent redirect to another tab, no retry that would turn into a
   * success on a page about to be destroyed. A reservation source that cannot be read is
   * not permission to bind either: the page may be mid-unload, so the same refusal carries
   * the read failure as its reason.
   */
  private assertPageAdmitsBinding(tabId: string | undefined, operation: string): void {
    const admission = this.closeAdmission;
    if (!admission) return;
    let applicationReserved: boolean;
    try {
      applicationReserved = Boolean(admission.isApplicationAdmissionReserved());
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new CapabilityError(
        'RUNTIME_DRAINING',
        `Cannot ${operation}: the application admission state could not be read (${cause}); no new work is admitted while it is unknown. Retry shortly.`,
        { tabId, applicationAdmissionUnreadable: true }
      );
    }
    if (applicationReserved) {
      throw new CapabilityError(
        'RUNTIME_DRAINING',
        `Cannot ${operation}: the application is quitting and admits no new work. Nothing was bound; retry once the quit finishes or is refused.`,
        { tabId, applicationQuitting: true }
      );
    }
    if (!tabId) return;
    let reserved: boolean;
    try {
      reserved = Boolean(admission.isPageReserved(tabId));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new CapabilityError(
        'TARGET_STALE',
        `Cannot ${operation}: the close reservation for tab '${tabId}' could not be read (${cause}). Retry, or rebind to a live tab.`,
        { tabId, closeReservationUnreadable: true }
      );
    }
    if (!reserved) return;
    throw new CapabilityError(
      'TARGET_STALE',
      `Cannot ${operation}: tab '${tabId}' is reserved for close and admits no new binding. Nothing was bound; rebind to a live tab once the close is done.`,
      { tabId, reservedForClose: true }
    );
  }

  private notifyDispose(record: ExecutionAttachmentRecord): void {
    // Session-end quota release: the bound tab's session pool is freed here.
    // Releasing is bookkeeping only and must never break the mutation path
    // that fired it.
    const sessionId = record?.tabId || record?.browserTarget?.tabId;
    if (sessionId && this.delegate?.releaseSessionTabPool) {
      try {
        this.delegate.releaseSessionTabPool(sessionId);
      } catch (err) {
        console.warn(`[AttachmentRegistry] Failed to release session tab pool ${sessionId} on dispose:`, err);
      }
    }
  }

  async revokeForAttempt(attemptId: string): Promise<void> {
    await this.runWithMutationLock(async () => {
      const ids = this.attemptIndex.get(attemptId);
      if (ids) {
        for (const id of ids) {
          await this.revokeAttachmentUnlocked(id);
        }
      }
    });
  }

  /**
   * Release every active binding whose owner provably cannot come back, so a page it
   * holds does not stay busy forever (the fail-closed close gate reads liveness from
   * this registry; see `close-live-use`).
   *
   * Two facts prove an owner is gone, and only these two:
   *
   * - the lease deadline passed. `renewAttachment` refuses a renewal past
   *   `expiresAt` and `validateLiveExecution` refuses dispatch, so the record is already
   *   dead — this marks it expired and runs the same disposal a lazy read would.
   * - `boundPid` is set and the injected liveness predicate reports it dead. Every
   *   dispatch path refuses a `boundPid` mismatch, so no process can use this binding
   *   again: the authority is unreachable and releasing it destroys no work. A missing
   *   predicate or an unset `boundPid` never releases anything, and a live or
   *   unreadable pid is treated as alive — the direction that keeps a real session's
   *   binding intact.
   *
   * Revocation is the same durable mutation as `revokeForAttempt`, so the record, its
   * persisted frame and the ownership-disposal hook stay consistent with any other end
   * of session.
   */
  async revokeGoneOwnerAttachments(): Promise<{ revoked: string[]; expired: string[]; retained: number }> {
    return await this.runWithMutationLock(async () => {
      const revoked: string[] = [];
      const expired: string[] = [];
      let retained = 0;
      const now = Date.now();
      for (const record of [...this.records.values()]) {
        if (record.state !== 'active' && record.state !== 'suspended') continue;
        if (typeof record.expiresAt === 'number' && record.expiresAt <= now) {
          this.clearSuspendedTimer(record.id);
          const candidateRecord: ExecutionAttachmentRecord = { ...record, state: 'expired' };
          const existingRevisions = Array.from(this.revisions.values()).filter((r) => r.attachmentId === record.id);
          await this.appendPersistenceFrameUnlocked(candidateRecord, existingRevisions);
          this.records.set(record.id, candidateRecord);
          // Same cleanup as revocation: an expired record renews nothing, so no
          // connection keeps a claim on it for `revokeForConnection` to release later.
          this.connectionIndex.delete(record.id);
          this.notifyDispose(candidateRecord);
          expired.push(record.id);
          continue;
        }
        const boundPid = record.boundPid;
        const isAlive = this.delegate?.isOwnerProcessAlive;
        if (typeof boundPid !== 'number' || !Number.isInteger(boundPid) || boundPid <= 0 || !isAlive) {
          retained++;
          continue;
        }
        let alive: boolean;
        try {
          // A liveness read that fails is not evidence of death: keep the binding.
          alive = isAlive(boundPid) !== false;
        } catch {
          alive = true;
        }
        if (alive) {
          retained++;
          continue;
        }
        await this.revokeAttachmentUnlocked(record.id);
        revoked.push(record.id);
      }
      return { revoked, expired, retained };
    });
  }
  getRecord(attachmentId: string): ExecutionAttachmentRecord | undefined {
    const record = this.records.get(attachmentId);
    return record ? { ...record } : undefined;
  }
  getActiveRecordIds(): Set<string> {
    const ids = new Set<string>();
    const now = Date.now();
    const MAX_EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;
    for (const record of this.records.values()) {
      if (record.state === 'active' || record.state === 'suspended' || (record.expiresAt && now <= record.expiresAt + MAX_EXPIRED_RETENTION_MS)) {
        ids.add(record.id);
      }
    }
    return ids;
  }
}
