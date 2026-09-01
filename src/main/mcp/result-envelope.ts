import type { McpEvidence } from '../../shared/control-plane-contracts';
export type { McpEvidence };

export function envelope<T>(
  data: T,
  evidence: McpEvidence,
  originRequestId: string,
  invocationId: string,
  replacementAuthorityRevision?: string
) {
  return {
    ok: true,
    requestId: originRequestId,
    invocationId,
    data,
    evidence: { timestamp: Date.now(), ...evidence },
    ...(replacementAuthorityRevision ? { authorityRevision: replacementAuthorityRevision } : {}),
  };
}

export function failure(
  message: string,
  code: string,
  details: unknown,
  evidence: McpEvidence,
  originRequestId: string,
  invocationId: string,
  replacementAuthorityRevision?: string
) {
  return {
    ok: false,
    requestId: originRequestId,
    invocationId,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    evidence: { timestamp: Date.now(), ...evidence },
    ...(replacementAuthorityRevision ? { authorityRevision: replacementAuthorityRevision } : {}),
  };
}
