import { CapabilityCatalogue } from './capability-catalogue';
import { ArtifactStore, ArtifactPreflightInput, ArtifactPreflightResult } from './artifact-store';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  ArtifactReadInput,
  ArtifactReadResult,
  ArtifactRef,
} from '../../shared/control-plane-contracts';

export function registerArtifactCapabilities(
  catalogue: CapabilityCatalogue,
  artifacts: ArtifactStore
): void {
  catalogue.register<ArtifactReadInput, ArtifactReadResult>({
    name: 'artifact.read',
    description: 'Read an authorized artifact by ID in 1 MiB chunks with MIME-correct framing',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Artifact ID' },
        offset: { type: 'number', description: 'Byte offset to start reading from' },
        limit: { type: 'number', description: 'Maximum bytes to read (capped at 1 MiB)' },
      },
      required: ['artifactId'],
    },
    execute: (params: ArtifactReadInput, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      if (!params.artifactId || typeof params.artifactId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Artifact ID is required');
      }
      return artifacts.readChunkById(params.artifactId, params.offset, params.limit, context);
    },
  });

  catalogue.register<{ artifactId: string }, ArtifactRef>({
    name: 'artifact.stat',
    description: 'Retrieve metadata and hash information for an authorized artifact',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Artifact ID' },
      },
      required: ['artifactId'],
    },
    execute: (params: { artifactId: string }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      if (!params.artifactId || typeof params.artifactId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Artifact ID is required');
      }
      return artifacts.stat(params.artifactId, context);
    },
  });

  catalogue.register<ArtifactPreflightInput, ArtifactPreflightResult>({
    name: 'artifact.preflight',
    description: 'Acquire an exclusive evidence-run artifact lease and reserve per-artifact and aggregate byte capacity',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Evidence run that owns the lease' },
        artifactBytes: { type: 'number', description: 'Bytes of the artifact about to be staged' },
        aggregateBytes: { type: 'number', description: 'Additional bytes expected across the run beyond this artifact' },
        leaseTtlMs: { type: 'number', description: 'Lease time-to-live in milliseconds (default 900000)' },
      },
      required: ['runId', 'artifactBytes'],
    },
    execute: (params: ArtifactPreflightInput) => {
      if (!params || typeof params !== 'object') {
        throw new CapabilityError('INVALID_ARGUMENT', 'artifact.preflight requires an input object');
      }
      return artifacts.preflight(params);
    },
  });

  catalogue.register<{ runId: string; leaseToken: string }, { released: boolean }>({
    name: 'artifact.release_lease',
    description: 'Release an exclusive evidence-run artifact lease so another run can acquire it',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Evidence run that owns the lease' },
        leaseToken: { type: 'string', description: 'Lease token returned by artifact.preflight' },
      },
      required: ['runId', 'leaseToken'],
    },
    execute: (params: { runId: string; leaseToken: string }) => {
      if (!params || typeof params.runId !== 'string' || typeof params.leaseToken !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'runId and leaseToken are required to release an artifact lease');
      }
      return artifacts.releaseLease(params.runId, params.leaseToken);
    },
  });

  /**
   * `report.generate` is the only capability declared permanent, so its staged artifacts outlive the
   * retention sweep. The policy literal and the stage call both read this constant so they cannot drift.
   */
  const REPORT_ARTIFACT_RETENTION: ArtifactRef['retentionPolicy'] = 'permanent';

  catalogue.register<{
    name?: string;
    params?: unknown;
    data?: unknown;
    mime?: string;
    kind?: ArtifactRef['kind'];
  }, { generated: boolean; artifactRef: ArtifactRef }>({
    name: 'report.generate',
    description: 'Generate and stage an immutable report artifact in ArtifactStore with durable lineage',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: REPORT_ARTIFACT_RETENTION,
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 10_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        params: { type: 'object' },
        data: {},
        mime: { type: 'string' },
        kind: { type: 'string' },
      },
    },
    execute: async (
      params: { name?: string; params?: unknown; data?: unknown; mime?: string; kind?: ArtifactRef['kind'] },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const runId = context?.runId;
      const attemptId = context?.attemptId || 'attempt-1';
      const projectId = context?.projectId;
      const workspaceId = context?.workspaceId;

      if (!runId || !projectId || !workspaceId) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          'runId, projectId, and workspaceId are required for report generation'
        );
      }

      const reportPayload = params.data !== undefined
        ? (typeof params.data === 'string' ? params.data : JSON.stringify(params.data, null, 2))
        : JSON.stringify(
            {
              name: params.name || 'Report',
              params: params.params,
              browserTarget: context?.browserTarget,
              timestamp: Date.now(),
            },
            null,
            2
          );

      const art = await artifacts.stageAsync({
        kind: params.kind || 'report',
        mime: params.mime || 'application/json',
        data: reportPayload,
        runId,
        attemptId,
        projectId,
        workspaceId,
        maxBytes: 64 * 1024 * 1024,
        retentionPolicy: REPORT_ARTIFACT_RETENTION,
      });

      return {
        generated: true,
        artifactRef: art,
      };
    },
  });
}
