export type McpEvidence = {
  timestamp?: number;
  tabId?: string;
  url?: string;
  title?: string;
  documentGeneration?: number;
  browserEpoch?: number;
  viewport?: { width: number; height: number };
  [key: string]: unknown;
};

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
