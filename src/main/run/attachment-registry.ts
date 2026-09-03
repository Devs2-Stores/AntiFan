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
  getBackendId?: (attemptId: string) => string | undefined;
  getDocumentGeneration?: (tabId?: string) => number;
  getAutomationTabId?: () => string | null;
  isTabAllowed?: (record: any, tabId: string) => boolean;
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

  constructor(
    private readonly delegate?: AttachmentValidatorDelegate,
    private readonly dataRoot?: string,
    maxHistoricalRevisions: number = 100
  ) {
    this.maxHistoricalRevisions = Math.max(1, maxHistoricalRevisions ?? 100);
  }

  private runWithMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationLock.then(fn, fn);
    this.mutationLock = next.then(() => {}, () => {});
    return next;
  }
  public async initialize(): Promise<void> {
    if (!this.dataRoot) return;
    const filePath = path.join(this.dataRoot, 'attachments-v1.jsonl');
    try {
      await fs.promises.access(filePath);
    } catch {
      return;
    }

    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
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
  }

  private async quarantineAttachmentsAsync(filePath: string): Promise<void> {
    this.isQuarantined = true;
    this.records.clear();
    this.revisions.clear();
    this.activeRevisionByAttachment.clear();
    this.revisionHistoryByAttachment.clear();
    this.attemptIndex.clear();
    this.invocationNonces.clear();
    const quarantinePath = `${filePath}.quarantine-${Date.now()}`;
    try {
      await fs.promises.rename(filePath, quarantinePath);
    } catch {}
    throw new CapabilityError('DURABILITY_FAILED', `Attachment registry file ${filePath} is corrupted and quarantined. Startup halted.`);
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
      let delegatedAutomationTabId: string | undefined;
      if (this.delegate?.getAutomationTabId) {
        try {
          const autoTab = this.delegate.getAutomationTabId();
          if (typeof autoTab === 'string' && autoTab.trim().length > 0) {
            delegatedAutomationTabId = autoTab.trim();
          }
        } catch {}
      }
      const effectiveTabId = options.tabId ?? options.browserTarget?.tabId ?? delegatedAutomationTabId;

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

  authenticateAttachmentCredentials(attachmentId: string, secret: string): ExecutionAttachmentRecord {
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
    return record;
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
    }
  ): { record: ExecutionAttachmentRecord; authority: MainResolvedAuthority } {
    const record = this.authenticateAttachmentCredentials(attachmentId, secret);

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
      record.state = 'expired';
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has expired`);
    }

    if (record.state === 'revoked') {
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has been revoked`);
    }

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
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has been revoked`);
    }

    if (record.state === 'expired' || Date.now() > record.expiresAt) {
      record.state = 'expired';
      throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has expired`);
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
          record.state = 'revoked';
          throw new CapabilityError('ATTACHMENT_STALE', `Attachment host epoch ${record.hostEpoch} does not match current host epoch ${currentHostEpoch}`);
        }
      }

      if (this.delegate.getAttemptState) {
        const attemptState = this.delegate.getAttemptState(record.attemptId);
        if (attemptState === undefined || (attemptState !== 'running' && attemptState !== 'prepared' && attemptState !== 'dispatching')) {
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
    if (!targetTabId && this.delegate?.getAutomationTabId) {
      targetTabId = this.delegate.getAutomationTabId() || '';
    }
    let docGen = record.documentGeneration || 1;
    if (targetTabId && this.delegate?.getDocumentGeneration) {
      const dynamicGen = this.delegate.getDocumentGeneration(targetTabId);
      if (typeof dynamicGen === 'number' && dynamicGen > 0) {
        docGen = dynamicGen;
      }
    }
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
  async updateAttachmentTab(attachmentId: string, tabId: string, documentGeneration?: number): Promise<AuthorityRevisionHandle | null> {
    const record = this.records.get(attachmentId);
    if (!record) return null;
    let docGen = documentGeneration;
    if (typeof docGen !== 'number' && this.delegate?.getDocumentGeneration) {
      try {
        const liveGen = this.delegate.getDocumentGeneration(tabId);
        if (typeof liveGen === 'number' && liveGen > 0) {
          docGen = liveGen;
        }
      } catch {}
    }
    const resolvedDocGen = docGen ?? record.documentGeneration ?? 1;
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
    return await this.rotateAuthorityRevision(attachmentId, {
      browserTarget: currentTarget,
      tabId,
      documentGeneration: resolvedDocGen,
    });
  }
  getAttachment(attachmentId: string): ExecutionAttachmentRecord | undefined {
    return this.records.get(attachmentId);
  }

  verifyConnectionToken(token: string): string | null {
    if (!token || typeof token !== 'string') return null;
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.state === 'active' && now <= record.expiresAt) {
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
    if (!record || record.state !== 'active' || Date.now() > record.expiresAt) return false;
    return verifySecret(secret, record.secretHash);
  }
  async renewAttachment(
    attachmentId: string,
    secret: string,
    options?: { extensionMs?: number; ownerPid?: number }
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
        record.state = 'expired';
        throw new CapabilityError('ATTACHMENT_STALE', `Attachment ${record.id} has expired`);
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
            record.state = 'revoked';
            throw new CapabilityError('ATTACHMENT_STALE', `Attachment host epoch ${record.hostEpoch} does not match current host epoch ${currentHostEpoch}`);
          }
        }
        if (this.delegate.getAttemptState) {
          const attemptState = this.delegate.getAttemptState(record.attemptId);
          if (attemptState === undefined || (attemptState !== 'running' && attemptState !== 'prepared' && attemptState !== 'dispatching')) {
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
      const newExpiresAt = Math.max(record.expiresAt, now) + extensionMs;
      const updatedLease = record.lease ? { ...record.lease, expiresAt: Math.max(record.lease.expiresAt, newExpiresAt) } : record.lease;
      const candidateRecord: ExecutionAttachmentRecord = {
        ...record,
        expiresAt: newExpiresAt,
        lease: updatedLease,
        boundPid: options?.ownerPid ?? record.boundPid,
      };

      const existingRevisions = Array.from(this.revisions.values()).filter((r) => r.attachmentId === attachmentId);
      await this.appendPersistenceFrameUnlocked(candidateRecord, existingRevisions);
      this.records.set(attachmentId, candidateRecord);
      return { expiresAt: candidateRecord.expiresAt };
    });
  }

  private async revokeAttachmentUnlocked(attachmentId: string): Promise<void> {
    const record = this.records.get(attachmentId);
    if (record) {
      const candidateRecord: ExecutionAttachmentRecord = {
        ...record,
        state: 'revoked',
        revokedAt: Date.now(),
      };
      const existingRevisions = Array.from(this.revisions.values()).filter((r) => r.attachmentId === attachmentId);
      await this.appendPersistenceFrameUnlocked(candidateRecord, existingRevisions);
      this.records.set(attachmentId, candidateRecord);
    }
  }

  async revokeAttachment(attachmentId: string): Promise<void> {
    await this.runWithMutationLock(async () => {
      await this.revokeAttachmentUnlocked(attachmentId);
    });
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
  getRecord(attachmentId: string): ExecutionAttachmentRecord | undefined {
    const record = this.records.get(attachmentId);
    return record ? { ...record } : undefined;
  }
}
