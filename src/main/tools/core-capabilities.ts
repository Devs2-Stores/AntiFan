// Core capabilities: register the local Super Core evidence store (packages/super-core)
// in the control-plane catalogue. These are LOCAL capabilities — the MCP proxy
// handles them in-process and never forwards them to the bridge; registration
// here keeps the advertised surface honest (check-mcp-budget-dominance requires
// every advertised tool to resolve to a registration) and lets in-app callers
// reach the same store through the control plane.
//
// The store is lazy-loaded: packages/super-core is a sibling TS package whose
// dist/ may not exist in every install. execute() fails closed with
// CORE_UNAVAILABLE rather than fabricating an empty store.

import path from 'node:path';
import { createRequire } from 'node:module';
import { CapabilityCatalogue } from './capability-catalogue';
import { CapabilityError } from '../../shared/control-plane-contracts';

export interface CoreStorePort {
  query(opts: Record<string, unknown>): unknown;
  contextPack(opts: Record<string, unknown>): unknown;
  recommend(opts: Record<string, unknown>): unknown;
  receipt(opts: Record<string, unknown>): unknown;
  ingestOutcome(opts: Record<string, unknown>): unknown;
  adjudicate(opts: Record<string, unknown>): unknown;
  stats(): unknown;
  domain(name: string): unknown;
  invalidate(opts: Record<string, unknown>): unknown;
  revoke(opts: Record<string, unknown>): unknown;
  snapshot(note?: string): unknown;
  rollback(releaseId: string): unknown;
}

// Lazy adapter: resolves packages/super-core/dist relative to this compiled
// module (.compiled/main/tools -> repo root is ../../..). SUPER_CORE_DB
// overrides the database location for tests and non-standard layouts.
export function createLazyCorePort(): CoreStorePort {
  let instance: CoreStorePort | null | undefined;
  const load = (): CoreStorePort => {
    if (instance !== undefined) {
      if (instance === null) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Super Core store unavailable (packages/super-core not built)');
      return instance;
    }
    try {
      const req = createRequire(__filename);
      const mod = req(path.join(__dirname, '..', '..', '..', 'packages', 'super-core', 'dist', 'index.js')) as { openCore: (p: string) => CoreStorePort };
      const dbPath = process.env.SUPER_CORE_DB || path.join(__dirname, '..', '..', '..', '.super-core', 'core.db');
      instance = mod.openCore(dbPath);
      return instance;
    } catch {
      instance = null;
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Super Core store unavailable (packages/super-core not built)');
    }
  };
  return {
    query: (o) => load().query(o),
    contextPack: (o) => load().contextPack(o),
    recommend: (o) => load().recommend(o),
    receipt: (o) => load().receipt(o),
    ingestOutcome: (o) => load().ingestOutcome(o),
    adjudicate: (o) => load().adjudicate(o),
    stats: () => load().stats(),
    domain: (n) => load().domain(n),
    invalidate: (o) => load().invalidate(o),
    revoke: (o) => load().revoke(o),
    snapshot: (n) => load().snapshot(n),
    rollback: (r) => load().rollback(r),
  };
}

const READ_POLICY = {
  effect: 'read' as const,
  risk: 'read' as const,
  requiresBrowserTarget: false,
  schedulerLane: 'unbounded' as const,
  duplicateMode: 'in-process-join' as const,
  recordedVisibility: 'tenant-scoped' as const,
  receiptReadPermission: 'read' as const,
  timeoutMs: 15_000,
  retentionPolicy: 'run-durable' as const,
  ownerCancellationBehavior: 'abort-immediate' as const,
  subscriberDisconnectBehavior: 'abort-when-unobserved' as const,
  cancellationAckTimeoutMs: 5_000,
  policyVersion: 1,
};

const WRITE_POLICY = {
  ...READ_POLICY,
  effect: 'write' as const,
  risk: 'write' as const,
  receiptReadPermission: 'write' as const,
};

export function registerCoreCapabilities(catalogue: CapabilityCatalogue, core: CoreStorePort): void {
  const reg = (name: string, description: string, inputSchema: object, policy: object, run: (p: never) => unknown) =>
    catalogue.register({ name, description, risk: (policy as { risk: 'read' | 'write' }).risk, policy: policy as never, inputSchema: inputSchema as never, execute: (params: never) => run(params) });

  reg('core.query', 'Query the local Super Core evidence store: anchored claims filtered by text/platform/unit/kind.',
    { type: 'object', properties: { text: { type: 'string' }, platform: { type: 'string' }, unitId: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, kind: { type: 'string' }, limit: { type: 'number' } } },
    READ_POLICY, (p: Parameters<CoreStorePort['query']>[0]) => core.query(p));

  reg('core.context_pack', 'Build a Context Pack for a task: relevant claims, unresolved conflicts, unknowns, permission scope.',
    { type: 'object', properties: { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } }, required: ['task'] },
    READ_POLICY, (p: Parameters<CoreStorePort['contextPack']>[0]) => core.contextPack(p));

  reg('core.recommend', 'Recommend from evidence: Context Pack + recommendation or explicit abstention.',
    { type: 'object', properties: { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } } }, required: ['task'] },
    READ_POLICY, (p: Parameters<CoreStorePort['recommend']>[0]) => core.recommend(p));

  reg('core.stats', 'Return Super Core store counts for verification.',
    { type: 'object', properties: {} },
    READ_POLICY, () => core.stats());

  reg('core.domain', 'Return a domain view (units, claims, eligible skills, gaps) or insufficient-evidence.',
    { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    READ_POLICY, (p: { name: string }) => core.domain(p.name));

  reg('core.receipt', 'Issue a Decision Receipt binding task context and evidence revisions.',
    { type: 'object', properties: { task: { type: 'string' }, packId: { type: 'string' }, recommendation: { type: 'string' }, abstained: { type: 'boolean' } }, required: ['task', 'recommendation'] },
    WRITE_POLICY, (p: Parameters<CoreStorePort['receipt']>[0]) => core.receipt(p));

  reg('core.ingest_outcome', 'Ingest a verified outcome as a case + pending candidate (never auto-promoted).',
    { type: 'object', properties: { task: { type: 'string' }, context: { type: 'string' }, outcome: { type: 'string' }, verificationRef: { type: 'string' }, unitId: { type: 'string' } }, required: ['task', 'outcome'] },
    WRITE_POLICY, (p: Parameters<CoreStorePort['ingestOutcome']>[0]) => core.ingestOutcome(p));

  reg('core.adjudicate', 'Adjudicate a candidate (PROMOTE/REJECT/SUPERSEDE) with explicit authority.',
    { type: 'object', properties: { candidateId: { type: 'string' }, decision: { type: 'string', enum: ['PROMOTE', 'REJECT', 'SUPERSEDE'] }, authority: { type: 'string' }, rationale: { type: 'string' } }, required: ['candidateId', 'decision', 'authority'] },
    WRITE_POLICY, (p: Parameters<CoreStorePort['adjudicate']>[0]) => core.adjudicate(p));

  reg('core.invalidate', 'Mark claims stale when their source changed or was deleted.',
    { type: 'object', properties: { entryId: { type: 'string' }, path: { type: 'string' } } },
    WRITE_POLICY, (p: Parameters<CoreStorePort['invalidate']>[0]) => core.invalidate(p));

  reg('core.revoke', 'Revoke claims derived from a restricted source (permission propagation).',
    { type: 'object', properties: { entryId: { type: 'string' }, path: { type: 'string' } } },
    WRITE_POLICY, (p: Parameters<CoreStorePort['revoke']>[0]) => core.revoke(p));

  reg('core.snapshot', 'Create a release snapshot for regression/rollback.',
    { type: 'object', properties: { note: { type: 'string' } } },
    WRITE_POLICY, (p: { note?: string }) => core.snapshot(p.note));

  reg('core.rollback', 'Restore claims/candidates to a release snapshot.',
    { type: 'object', properties: { releaseId: { type: 'string' } }, required: ['releaseId'] },
    WRITE_POLICY, (p: { releaseId: string }) => core.rollback(p.releaseId));
}
