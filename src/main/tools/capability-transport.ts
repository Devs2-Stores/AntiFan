import * as crypto from 'node:crypto';
import { CapabilityCatalogue } from './capability-catalogue';
import { AttachmentRegistry } from '../run/attachment-registry';
import { InvocationLedger } from '../session/invocation-ledger';
import {
  AuthenticatedCapabilityContext,
  CapabilityError,
  CapabilityRequestContext,
  ClientInvocationIntent,
  ExecutionAttachmentRecord,
  MainResolvedAuthority,
  makeControlPlaneId,
} from '../../shared/control-plane-contracts';

export interface CapabilityListItem {
  name: string;
  description: string;
  risk: string;
  inputSchema: Record<string, unknown>;
}

export interface CapabilityTransportResponse {
  ok: boolean;
  requestId: string;
  invocationId: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  evidence?: Record<string, unknown>;
  replacementAuthorityRevision?: string;
}

export class CapabilityTransportAdapter {
  constructor(
    private readonly catalogue: CapabilityCatalogue,
    private readonly attachmentRegistry: AttachmentRegistry,
    private readonly ledger?: InvocationLedger
  ) {}

  list(context?: Pick<CapabilityRequestContext, 'grant'>): CapabilityListItem[] {
    return this.catalogue.list(context);
  }

  async dispatchChildIntent(
    parentInvocationId: string,
    stepId: string,
    attemptIndex: number,
    intent: ClientInvocationIntent,
    invocationSeq?: number | string
  ): Promise<CapabilityTransportResponse> {
    const seqSuffix = invocationSeq !== undefined ? String(invocationSeq) : `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const childIntent: ClientInvocationIntent = {
      ...intent,
      requestId: intent.requestId || makeControlPlaneId('request'),
      idempotencyKey: intent.idempotencyKey || `child:${parentInvocationId}:${stepId}:${attemptIndex}:${seqSuffix}`,
    };
    return this.dispatchIntent(childIntent);
  }

  async dispatchIntent(intent: ClientInvocationIntent): Promise<CapabilityTransportResponse> {
    if (!intent || typeof intent !== 'object') {
      throw new CapabilityError('INVALID_ARGUMENT', 'Client invocation intent is required');
    }
    if (!intent.requestId || typeof intent.requestId !== 'string' || intent.requestId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent requestId must be a non-empty string');
    }
    if (!intent.idempotencyKey || typeof intent.idempotencyKey !== 'string' || intent.idempotencyKey.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent idempotencyKey must be a non-empty string');
    }
    if (!intent.attachmentId || typeof intent.attachmentId !== 'string' || intent.attachmentId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent attachmentId must be a non-empty string');
    }
    if (!intent.attachmentSecret || typeof intent.attachmentSecret !== 'string' || intent.attachmentSecret.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent attachmentSecret must be a non-empty string');
    }
    if (!intent.authorityRevision || typeof intent.authorityRevision !== 'string' || intent.authorityRevision.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent authorityRevision must be a non-empty string');
    }
    if (!intent.name || typeof intent.name !== 'string' || intent.name.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent capability name must be a non-empty string');
    }

    // Step 1: Authenticate lineage
    let authResult: { record: ExecutionAttachmentRecord; authority: MainResolvedAuthority };
    try {
      authResult = this.attachmentRegistry.authenticateLineage(
        intent.attachmentId,
        intent.attachmentSecret,
        { authorityRevision: intent.authorityRevision }
      );
    } catch (err) {
      const typed = err as { code?: string; message?: string; details?: unknown };
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId: makeControlPlaneId('invocation'),
        error: {
          code: typed.code || 'AUTHENTICATION_DENIED',
          message: typed.message || String(err),
          details: typed.details,
        },
      };
    }
    const { record, authority } = authResult;

    // Resolve capability definition and policy
    const definition = this.catalogue.get(intent.name);
    const policy = definition?.policy;
    const policyDigest = policy?.policyDigest || 'unversioned';
    const policyVersion = policy?.policyVersion || 1;
    const recordedVisibility = policy?.recordedVisibility || 'public';

    // Step 2: If ledger is configured, check for existing record (JOIN/REPLAY)
    let invocationId = makeControlPlaneId('invocation');
    let isOwner = true;

    if (this.ledger) {
      try {
        const existing = await this.ledger.observe(intent, authority);
        if (existing) {
          const rec = existing.record;
          if (rec && policyDigest !== 'unversioned' && rec.policyDigest !== policyDigest) {
            throw new CapabilityError('BINDING_COLLISION', 'Recorded policy digest mismatch with current capability policy');
          }

          const canRead = this.canReadReceipt(authority.grant, policy?.receiptReadPermission, rec?.recordedVisibility);
          if (existing.kind === 'replay' && rec) {
            if (!canRead) {
              if (rec.recordedVisibility === 'redacted') {
                throw new CapabilityError('POLICY_DENIED', 'Receipt visibility is redacted');
              }
              return {
                ok: rec.state === 'completed',
                requestId: intent.requestId,
                invocationId: rec.id,
                data: { state: rec.state, redacted: true },
                evidence: rec.evidence,
                replacementAuthorityRevision: rec.replacementAuthorityRevision,
              };
            }
            return {
              ok: rec.state === 'completed',
              requestId: intent.requestId,
              invocationId: rec.id,
              data: rec.result,
              error: rec.error,
              evidence: rec.evidence,
              replacementAuthorityRevision: rec.replacementAuthorityRevision,
            };
          }
          if (existing.kind === 'join' && existing.promise) {
            const joinedRec = await existing.promise;
            if (!this.canReadReceipt(authority.grant, policy?.receiptReadPermission, joinedRec.recordedVisibility)) {
              return {
                ok: joinedRec.state === 'completed',
                requestId: intent.requestId,
                invocationId: joinedRec.id,
                data: { state: joinedRec.state, redacted: true },
                evidence: joinedRec.evidence,
                replacementAuthorityRevision: joinedRec.replacementAuthorityRevision,
              };
            }
            return {
              ok: joinedRec.state === 'completed',
              requestId: intent.requestId,
              invocationId: joinedRec.id,
              data: joinedRec.result,
              error: joinedRec.error,
              evidence: joinedRec.evidence,
              replacementAuthorityRevision: joinedRec.replacementAuthorityRevision,
            };
          }
        }
      } catch (err) {
        const typed = err as { code?: string; message?: string; details?: unknown };
        return {
          ok: false,
          requestId: intent.requestId,
          invocationId,
          error: {
            code: typed.code || 'LEDGER_CLAIM_FAILED',
            message: typed.message || String(err),
            details: typed.details,
          },
        };
      }
    }

    // Step 3: Validate live execution authority for new OWNER (BEFORE claiming OWNER)
    let liveAuthority: MainResolvedAuthority;
    try {
      liveAuthority = this.attachmentRegistry.validateLiveExecution(record, intent.authorityRevision);
    } catch (err) {
      const typed = err as { code?: string; message?: string; details?: unknown };
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId,
        error: {
          code: typed.code || 'UNAUTHENTICATED',
          message: typed.message || String(err),
          details: typed.details,
        },
      };
    }

    // Step 4: Claim OWNER in ledger
    if (this.ledger) {
      try {
        const claim = await this.ledger.claimOwner(
          intent,
          liveAuthority,
          policyDigest,
          policyVersion,
          recordedVisibility
        );
        if (claim.kind === 'replay' && claim.record) {
          const rec = claim.record;
          return {
            ok: rec.state === 'completed',
            requestId: intent.requestId,
            invocationId: rec.id,
            data: rec.result,
            error: rec.error,
            evidence: rec.evidence,
            replacementAuthorityRevision: rec.replacementAuthorityRevision,
          };
        }
        if (claim.kind === 'join' && claim.promise) {
          const rec = await claim.promise;
          return {
            ok: rec.state === 'completed',
            requestId: intent.requestId,
            invocationId: rec.id,
            data: rec.result,
            error: rec.error,
            evidence: rec.evidence,
            replacementAuthorityRevision: rec.replacementAuthorityRevision,
          };
        }
        invocationId = claim.invocationId;
        isOwner = true;
      } catch (err) {
        const typed = err as { code?: string; message?: string; details?: unknown };
        return {
          ok: false,
          requestId: intent.requestId,
          invocationId,
          error: {
            code: typed.code || 'LEDGER_CLAIM_FAILED',
            message: typed.message || String(err),
            details: typed.details,
          },
        };
      }
    }

    // Step 5: Execute capability
    try {
      const authContext: AuthenticatedCapabilityContext = {
        attachmentId: liveAuthority.attachmentId,
        runId: liveAuthority.runId,
        attemptId: liveAuthority.attemptId,
        projectId: liveAuthority.projectId,
        workspaceId: liveAuthority.workspaceId || '',
        chatId: record.chatId,
        backendId: liveAuthority.backendId,
        hostEpoch: liveAuthority.hostEpoch,
        invocationId,
        lease: record.lease!,
        leaseToken: liveAuthority.runtimeLeaseToken || '',
        browserTarget: liveAuthority.browserTarget,
        grant: liveAuthority.grant,
      };
      const data = await this.catalogue.dispatchAuthenticated(
        intent.name,
        (intent.params as Record<string, unknown>) || {},
        authContext
      );

      let replacementAuthorityRevision: string | undefined;
      const p = intent.params as Record<string, unknown> | undefined;
      const isSetTarget = intent.name === 'browser.set-automation-target' || intent.name === 'antifan_set_automation_target';
      const isOpenTab = intent.name === 'browser.open-tab' || intent.name === 'antifan_open_tab' || intent.name === 'anti.browser.tabs.create';
      const isSwitchTab = intent.name === 'browser.switch-tab' || intent.name === 'antifan_switch_tab' || intent.name === 'anti.browser.tabs.activate';
      const isNavigate = intent.name === 'browser.navigate' || intent.name === 'antifan_navigate' || intent.name === 'anti.browser.navigate';
      const isReload = intent.name === 'browser.reload' || intent.name === 'antifan_reload' || intent.name === 'anti.browser.reload';

      if (isSetTarget || isOpenTab) {
        let newTabId: string | undefined;
        if (data && typeof data === 'object' && 'tabId' in data && typeof (data as { tabId: unknown }).tabId === 'string') {
          newTabId = (data as { tabId: string }).tabId;
        } else if (p && typeof p.tabId === 'string' && p.tabId.trim().length > 0) {
          newTabId = p.tabId.trim();
        }
        if (newTabId) {
          const newRev = this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, newTabId);
          if (newRev) replacementAuthorityRevision = newRev;
        }
      } else if (isSwitchTab) {
        const switchedTabId = p && typeof p.tabId === 'string' && p.tabId.trim().length > 0 ? p.tabId.trim() : undefined;
        if (switchedTabId) {
          const newRev = this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, switchedTabId);
          if (newRev) replacementAuthorityRevision = newRev;
        }
      } else if (isNavigate || isReload) {
        if (data && typeof data === 'object' && 'target' in data) {
          const targetObj = (data as { target?: { tabId?: string; documentGeneration?: number } }).target;
          if (targetObj && typeof targetObj.tabId === 'string') {
            const newRev = this.attachmentRegistry.updateAttachmentTab(
              authority.attachmentId,
              targetObj.tabId,
              targetObj.documentGeneration
            );
            if (newRev) replacementAuthorityRevision = newRev;
          }
        }
      }

      if (this.ledger && isOwner) {
        await this.ledger.settle(
          invocationId,
          'completed',
          data,
          undefined,
          undefined,
          undefined,
          replacementAuthorityRevision
        );
      }

      return {
        ok: true,
        requestId: intent.requestId,
        invocationId,
        data,
        ...(replacementAuthorityRevision ? { replacementAuthorityRevision } : {}),
      };
    } catch (error: unknown) {
      const typed = error as { code?: string; message?: string; details?: unknown };
      const errObj = {
        code: typed.code || 'CAPABILITY_ERROR',
        message: typed.message || String(error),
        details: typed.details,
      };

      if (this.ledger && isOwner) {
        try {
          await this.ledger.settle(invocationId, 'failed', undefined, errObj);
        } catch {}
      }

      return {
        ok: false,
        requestId: intent.requestId,
        invocationId,
        error: errObj,
      };
    }
  }

  private canReadReceipt(
    grant?: string,
    requiredPermission?: string,
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
}
