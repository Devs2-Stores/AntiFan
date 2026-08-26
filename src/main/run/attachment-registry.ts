import * as crypto from 'node:crypto';
import {
  AttemptState,
  AuthenticatedCapabilityContext,
  CapabilityError,
  hashSecret,
  makeControlPlaneId,
  McpAttachmentLaunch,
  ExecutionAttachmentRecord,
  RuntimeLease,
  UntrustedCapabilityClaims,
  validateControlPlaneId,
  verifySecret,
  BrowserTarget,
} from '../../shared/control-plane-contracts';

export interface AttachmentValidatorDelegate {
  getAttemptState?: (attemptId: string) => AttemptState | undefined;
  getHostEpoch?: () => number;
  getProcessPid?: (runId: string, attemptId: string) => number | undefined;
  getBackendId?: (attemptId: string) => string | undefined;
  getDocumentGeneration?: (tabId?: string) => number;
  getAutomationTabId?: () => string | null;
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

export class AttachmentRegistry {
  private readonly records = new Map<string, ExecutionAttachmentRecord>();
  private readonly attemptIndex = new Map<string, Set<string>>();
  private readonly invocationNonces = new Map<string, Set<string>>();

  constructor(private readonly delegate?: AttachmentValidatorDelegate) {}
  issueAttachment(
    runId: string,
    attemptId: string,
    projectId: string,
    workspaceId: string,
    options: IssueAttachmentOptions
  ): { record: ExecutionAttachmentRecord; launch: McpAttachmentLaunch } {
    const validRunId = validateControlPlaneId(runId, 'run');
    const validAttemptId = validateControlPlaneId(attemptId, 'attempt');
    const validProjectId = validateControlPlaneId(projectId, 'project');
    const validWorkspaceId = validateControlPlaneId(workspaceId, 'workspace');

    const attachmentId = makeControlPlaneId('binding');
    const plainSecret = crypto.randomBytes(32).toString('hex');
    const secretHash = hashSecret(plainSecret);
    const now = Date.now();
    const ttlMs = options.ttlMs ?? 60_000;
    const expiresAt = now + ttlMs;

    const record: ExecutionAttachmentRecord = {
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
      browserTarget: options.browserTarget,
      grant: options.grant,
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
      documentGeneration: options.documentGeneration,
      boundPid: options.boundPid,
    };
    this.records.set(attachmentId, record);

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
      hostEpoch: record.hostEpoch,
      grant: options.grant,
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
    };

    return { record, launch };
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
      throw new CapabilityError('TARGET_MISMATCH', `Tab ID mismatch: expected ${record.tabId}, got ${claims.tabId}`);
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
  updateAttachmentTab(attachmentId: string, tabId: string, documentGeneration?: number): boolean {
    const record = this.records.get(attachmentId);
    if (!record) return false;
    record.tabId = tabId;
    if (typeof documentGeneration === 'number') {
      record.documentGeneration = documentGeneration;
    }
    if (record.browserTarget) {
      record.browserTarget.tabId = tabId;
      if (typeof documentGeneration === 'number') {
        record.browserTarget.documentGeneration = documentGeneration;
      }
    }
    return true;
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

  revokeAttachment(attachmentId: string): void {
    const record = this.records.get(attachmentId);
    if (record) {
      record.state = 'revoked';
      record.revokedAt = Date.now();
    }
  }

  revokeForAttempt(attemptId: string): void {
    const ids = this.attemptIndex.get(attemptId);
    if (ids) {
      for (const id of ids) {
        this.revokeAttachment(id);
      }
    }
  }

  getRecord(attachmentId: string): ExecutionAttachmentRecord | undefined {
    const record = this.records.get(attachmentId);
    return record ? { ...record } : undefined;
  }
}
