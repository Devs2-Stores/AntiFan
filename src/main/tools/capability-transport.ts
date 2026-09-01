import { CapabilityCatalogue } from './capability-catalogue';
import { AttachmentRegistry } from '../run/attachment-registry';
import {
  AuthenticatedCapabilityContext,
  CapabilityError,
  CapabilityRequestContext,
  ClientInvocationIntent,
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
    private readonly attachmentRegistry: AttachmentRegistry
  ) {}

  list(context?: Pick<CapabilityRequestContext, 'grant'>): CapabilityListItem[] {
    return this.catalogue.list(context);
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

    const invocationId = makeControlPlaneId('invocation');

    try {
      const authority = this.attachmentRegistry.resolveAuthority(intent);
      const record = this.attachmentRegistry.getAttachment(authority.attachmentId);
      if (!record || !record.lease) {
        throw new CapabilityError('UNAUTHENTICATED', 'No active lease on resolved attachment record');
      }

      const authContext: AuthenticatedCapabilityContext = {
        attachmentId: authority.attachmentId,
        runId: authority.runId,
        attemptId: authority.attemptId,
        projectId: authority.projectId,
        workspaceId: authority.workspaceId || '',
        chatId: record.chatId,
        backendId: authority.backendId,
        hostEpoch: authority.hostEpoch,
        invocationId,
        lease: record.lease,
        leaseToken: authority.runtimeLeaseToken || '',
        browserTarget: authority.browserTarget,
        grant: authority.grant,
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

      return {
        ok: true,
        requestId: intent.requestId,
        invocationId,
        data,
        ...(replacementAuthorityRevision ? { replacementAuthorityRevision } : {}),
      };
    } catch (error: unknown) {
      const typed = error as { code?: string; message?: string; details?: unknown };
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId,
        error: {
          code: typed.code || 'CAPABILITY_ERROR',
          message: typed.message || String(error),
          details: typed.details,
        },
      };
    }
  }
}
