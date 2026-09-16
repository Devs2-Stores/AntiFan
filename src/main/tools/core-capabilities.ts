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
  health(opts?: Record<string, unknown>): unknown;
  reuseMetric(opts: Record<string, unknown>): unknown;
  domain(name: string): unknown;
  invalidate(opts: Record<string, unknown>): unknown;
  revoke(opts: Record<string, unknown>): unknown;
  snapshot(note?: string): unknown;
  rollback(releaseId: string): unknown;
  resolveConflict(opts: Record<string, unknown>): unknown;
  // v4
  recordExperienceNode(opts: Record<string, unknown>): unknown;
  recordExperienceEdge(opts: Record<string, unknown>): unknown;
  experienceChain(fromNodeId: string, depth?: number): unknown;
  recordAntiPattern(opts: Record<string, unknown>): unknown;
  antiPatterns(opts?: Record<string, unknown>): unknown;
  recordWorkaround(opts: Record<string, unknown>): unknown;
  workarounds(opts?: Record<string, unknown>): unknown;
  recordFixPattern(opts: Record<string, unknown>): unknown;
  fixPatterns(opts?: Record<string, unknown>): unknown;
  findSimilar(opts: Record<string, unknown>): unknown;
  classifyUncertainty(opts: Record<string, unknown>): unknown;
  decayCheck(opts?: Record<string, unknown>): unknown;
  corpusAudit(): unknown;
  checkPhaseGate(phase: string, gate: string): unknown;
  recordRegression(opts: Record<string, unknown>): unknown;
  replayRegression(regressionId: string): unknown;
  recordObservation(opts: Record<string, unknown>): unknown;
  recordPrinciple(opts: Record<string, unknown>): unknown;
  principles(opts?: Record<string, unknown>): unknown;
  recordHiddenRequirement(opts: Record<string, unknown>): unknown;
  hiddenRequirements(opts?: Record<string, unknown>): unknown;
  recordCommercial(opts: Record<string, unknown>): unknown;
  commercialIntel(opts?: Record<string, unknown>): unknown;
  recordTool(opts: Record<string, unknown>): unknown;
  toolIntel(opts?: Record<string, unknown>): unknown;
  recordArchetype(opts: Record<string, unknown>): unknown;
  archetypes(opts?: Record<string, unknown>): unknown;
  recordPlatformSemantic(opts: Record<string, unknown>): unknown;
  platformSemantics(opts?: Record<string, unknown>): unknown;
  recordPracticeParity(opts: Record<string, unknown>): unknown;
  practiceParity(opts?: Record<string, unknown>): unknown;
  recordSkillVersion(opts: Record<string, unknown>): unknown;
  skillGenealogy(opts: Record<string, unknown>): unknown;
  contextPackV2(opts: Record<string, unknown>): unknown;
  receiptV2(opts: Record<string, unknown>): unknown;
  knowledgeGaps(opts?: Record<string, unknown>): unknown;
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
    health: (o) => load().health(o),
    reuseMetric: (o) => load().reuseMetric(o),
    domain: (n) => load().domain(n),
    invalidate: (o) => load().invalidate(o),
    revoke: (o) => load().revoke(o),
    rollback: (r) => load().rollback(r),
    snapshot: (n) => load().snapshot(n),
    resolveConflict: (o) => load().resolveConflict(o),
    // v4
    recordExperienceNode: (o) => load().recordExperienceNode(o),
    recordExperienceEdge: (o) => load().recordExperienceEdge(o),
    experienceChain: (id, d) => load().experienceChain(id, d),
    recordAntiPattern: (o) => load().recordAntiPattern(o),
    antiPatterns: (o) => load().antiPatterns(o),
    recordWorkaround: (o) => load().recordWorkaround(o),
    workarounds: (o) => load().workarounds(o),
    recordFixPattern: (o) => load().recordFixPattern(o),
    fixPatterns: (o) => load().fixPatterns(o),
    findSimilar: (o) => load().findSimilar(o),
    classifyUncertainty: (o) => load().classifyUncertainty(o),
    decayCheck: (o) => load().decayCheck(o),
    corpusAudit: () => load().corpusAudit(),
    checkPhaseGate: (p, g) => load().checkPhaseGate(p, g),
    recordRegression: (o) => load().recordRegression(o),
    replayRegression: (r) => load().replayRegression(r),
    recordObservation: (o) => load().recordObservation(o),
    recordPrinciple: (o) => load().recordPrinciple(o),
    principles: (o) => load().principles(o),
    recordHiddenRequirement: (o) => load().recordHiddenRequirement(o),
    hiddenRequirements: (o) => load().hiddenRequirements(o),
    recordCommercial: (o) => load().recordCommercial(o),
    commercialIntel: (o) => load().commercialIntel(o),
    recordTool: (o) => load().recordTool(o),
    toolIntel: (o) => load().toolIntel(o),
    recordArchetype: (o) => load().recordArchetype(o),
    archetypes: (o) => load().archetypes(o),
    recordPlatformSemantic: (o) => load().recordPlatformSemantic(o),
    platformSemantics: (o) => load().platformSemantics(o),
    recordPracticeParity: (o) => load().recordPracticeParity(o),
    practiceParity: (o) => load().practiceParity(o),
    recordSkillVersion: (o) => load().recordSkillVersion(o),
    skillGenealogy: (o) => load().skillGenealogy(o),
    contextPackV2: (o) => load().contextPackV2(o),
    receiptV2: (o) => load().receiptV2(o),
    knowledgeGaps: (o) => load().knowledgeGaps(o),
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
    { type: 'object', properties: { text: { type: 'string' }, platform: { type: 'string' }, unitId: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, kind: { type: 'string' }, limit: { type: 'number' }, includeGlobal: { type: 'boolean' } } },
    READ_POLICY, (p: Parameters<CoreStorePort['query']>[0]) => core.query(p));

  reg('core.context_pack', 'Build a Context Pack for a task: relevant claims, unresolved conflicts, unknowns, permission scope.',
    { type: 'object', properties: { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, sessionId: { type: 'string' }, includeGlobal: { type: 'boolean' } }, required: ['task'] },
    READ_POLICY, (p: Parameters<CoreStorePort['contextPack']>[0]) => core.contextPack(p));

  reg('core.recommend', 'Recommend from evidence: Context Pack + recommendation or explicit abstention.',
    { type: 'object', properties: { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' }, includeGlobal: { type: 'boolean' } }, required: ['task'] },
    READ_POLICY, (p: Parameters<CoreStorePort['recommend']>[0]) => core.recommend(p));

  reg('core.stats', 'Return Super Core store counts for verification.',
    { type: 'object', properties: {} },
    READ_POLICY, () => core.stats());

  reg('core.health', 'Aggregated Core Health: status, reasonCode, stats, audit, decay and phase gates. Read-only.',
    { type: 'object', properties: { staleDays: { type: 'number' } } },
    READ_POLICY, (p: { staleDays?: number }) => core.health(p));

  reg('core.reuse_metric', 'Historical reuse for a task: found + injected + outcome-linked counts, each witnessed by rows. Read-only.',
    { type: 'object', properties: { task: { type: 'string' }, limit: { type: 'number' } }, required: ['task'] },
    READ_POLICY, (p: { task: string; limit?: number }) => core.reuseMetric(p));

  // v4: Experience Graph
  reg('core.record_experience_node', 'Record an experience graph node.',
    { type: 'object', properties: { kind: { type: 'string' }, refId: { type: 'string' }, label: { type: 'string' }, context: { type: 'string' } }, required: ['kind'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordExperienceNode(p));
  reg('core.record_experience_edge', 'Record an experience graph edge.',
    { type: 'object', properties: { fromNodeId: { type: 'string' }, toNodeId: { type: 'string' }, kind: { type: 'string' }, evidence: { type: 'string' } }, required: ['fromNodeId', 'toNodeId', 'kind'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordExperienceEdge(p));
  reg('core.experience_chain', 'Traverse the experience graph from a node.',
    { type: 'object', properties: { fromNodeId: { type: 'string' }, depth: { type: 'number' } }, required: ['fromNodeId'] },
    READ_POLICY, (p: { fromNodeId: string; depth?: number }) => core.experienceChain(p.fromNodeId, p.depth));

  // v4: Anti-Pattern Library
  reg('core.record_anti_pattern', 'Record an anti-pattern.',
    { type: 'object', properties: { name: { type: 'string' }, whatNotToDo: { type: 'string' }, symptoms: { type: 'string' }, evidence: { type: 'string' }, affectedPlatform: { type: 'string' }, replacement: { type: 'string' } }, required: ['name'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordAntiPattern(p));
  reg('core.anti_patterns', 'List anti-patterns.',
    { type: 'object', properties: { platform: { type: 'string' }, status: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.antiPatterns(p));

  // v4: Workaround Library
  reg('core.record_workaround', 'Record a workaround.',
    { type: 'object', properties: { problem: { type: 'string' }, condition: { type: 'string' }, solution: { type: 'string' }, reason: { type: 'string' }, platform: { type: 'string' }, version: { type: 'string' }, evidence: { type: 'string' } }, required: ['problem'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordWorkaround(p));
  reg('core.workarounds', 'List workarounds.',
    { type: 'object', properties: { platform: { type: 'string' }, stillValid: { type: 'boolean' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.workarounds(p));

  // v4: Fix Patterns
  reg('core.record_fix_pattern', 'Record a fix pattern.',
    { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' }, why: { type: 'string' }, evidence: { type: 'string' }, lesson: { type: 'string' } } },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordFixPattern(p));
  reg('core.fix_patterns', 'List fix patterns.',
    { type: 'object', properties: { limit: { type: 'number' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.fixPatterns(p));

  // v4: Case-Based Reasoning
  reg('core.find_similar', 'Find similar claims, cases, decisions, anti-patterns, workarounds, fix patterns.',
    { type: 'object', properties: { task: { type: 'string' }, platform: { type: 'string' }, limit: { type: 'number' }, includeGlobal: { type: 'boolean' } }, required: ['task'] },
    READ_POLICY, (p: Record<string, unknown>) => core.findSimilar(p));

  // v4: Uncertainty Engine
  reg('core.classify_uncertainty', 'Classify uncertainty level for a claim or task.',
    { type: 'object', properties: { claimId: { type: 'string' }, task: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.classifyUncertainty(p));

  // v4: Knowledge Decay
  reg('core.decay_check', 'Check for stale/aging claims.',
    { type: 'object', properties: { staleDays: { type: 'number' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.decayCheck(p));
  reg('core.knowledge_gaps', 'Classify per-platform knowledge gaps: NO_EVIDENCE, STALE, CONFLICTED, NONE.',
    { type: 'object', properties: { staleDays: { type: 'number' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.knowledgeGaps(p));

  // v4: Corpus Audit
  reg('core.corpus_audit', 'Run a corpus completion audit.',
    { type: 'object', properties: {} },
    READ_POLICY, () => core.corpusAudit());

  // v4: Phase Gates
  reg('core.check_phase_gate', 'Check a phase gate.',
    { type: 'object', properties: { phase: { type: 'string' }, gate: { type: 'string' } }, required: ['phase', 'gate'] },
    READ_POLICY, (p: { phase: string; gate: string }) => core.checkPhaseGate(p.phase, p.gate));
  // v4: Core Regression — record stores the definition; only replay writes a result.
  reg('core.record_regression', 'Record a core regression definition (checks re-executed by core.replay_regression).',
    { type: 'object', properties: { newKnowledge: { type: 'string' }, affectedRules: { type: 'array', items: { type: 'string' } }, affectedCases: { type: 'array', items: { type: 'string' } }, affectedRecommendations: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'object' } } } },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordRegression(p));
  reg('core.replay_regression', 'Re-execute a recorded regression\'s checks against live state and write replayResult + replayedAt.',
    { type: 'object', properties: { regressionId: { type: 'string' } }, required: ['regressionId'] },
    WRITE_POLICY, (p: { regressionId: string }) => core.replayRegression(p.regressionId));
  reg('core.record_observation', 'Record a raw observation (source, kind, payload) into the learning loop.',
    { type: 'object', properties: { source: { type: 'string' }, kind: { type: 'string' }, payload: {} }, required: ['source', 'kind'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordObservation(p));

  // v4: Principles
  reg('core.record_principle', 'Record a personal engineering principle.',
    { type: 'object', properties: { statement: { type: 'string' }, source: { type: 'string' }, derivedFrom: { type: 'string' } }, required: ['statement'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordPrinciple(p));
  reg('core.principles', 'List principles.',
    { type: 'object', properties: { status: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.principles(p));

  // v4: Hidden Requirements
  reg('core.record_hidden_requirement', 'Record a hidden requirement.',
    { type: 'object', properties: { task: { type: 'string' }, explicitReq: { type: 'string' }, inferredReq: { type: 'string' }, likelihood: { type: 'string' }, evidence: { type: 'string' } }, required: ['task'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordHiddenRequirement(p));
  reg('core.hidden_requirements', 'List hidden requirements.',
    { type: 'object', properties: { task: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.hiddenRequirements(p));

  // v4: Commercial Intelligence
  reg('core.record_commercial', 'Record commercial intelligence.',
    { type: 'object', properties: { taskType: { type: 'string' }, quote: { type: 'number' }, scope: { type: 'string' }, estimate: { type: 'number' }, actual: { type: 'number' }, risk: { type: 'string' }, revisionCount: { type: 'number' } }, required: ['taskType'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordCommercial(p));
  reg('core.commercial_intel', 'List commercial intelligence.',
    { type: 'object', properties: { taskType: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.commercialIntel(p));

  // v4: Tool Intelligence
  reg('core.record_tool', 'Record tool intelligence.',
    { type: 'object', properties: { name: { type: 'string' }, problemSolved: { type: 'string' }, workflowStage: { type: 'string' }, inputs: { type: 'string' }, outputs: { type: 'string' }, failureModes: { type: 'string' }, timeSaved: { type: 'number' }, maintenanceCost: { type: 'number' }, roi: { type: 'number' }, usageFrequency: { type: 'string' } }, required: ['name'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordTool(p));
  reg('core.tool_intel', 'List tool intelligence.',
    { type: 'object', properties: { status: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.toolIntel(p));

  // v4: Archetypes
  reg('core.record_archetype', 'Record a project archetype.',
    { type: 'object', properties: { name: { type: 'string' }, platform: { type: 'string' }, maturityLevel: { type: 'number' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['name'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordArchetype(p));
  reg('core.archetypes', 'List archetypes.',
    { type: 'object', properties: { platform: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.archetypes(p));

  // v4: Platform Semantics
  reg('core.record_platform_semantic', 'Record a platform semantic fact.',
    { type: 'object', properties: { platform: { type: 'string' }, semanticRole: { type: 'string' }, propertyName: { type: 'string' }, cssFact: { type: 'string' }, semanticTruth: { type: 'string' }, evidence: { type: 'string' } }, required: ['platform', 'semanticRole'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordPlatformSemantic(p));
  reg('core.platform_semantics', 'List platform semantics.',
    { type: 'object', properties: { platform: { type: 'string' }, semanticRole: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.platformSemantics(p));

  // v4: Practice Parity
  reg('core.record_practice_parity', 'Record declared vs observed practice parity.',
    { type: 'object', properties: { practice: { type: 'string' }, declared: { type: 'string' }, observed: { type: 'string' }, gap: { type: 'string' }, evidence: { type: 'string' } }, required: ['practice'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordPracticeParity(p));
  reg('core.practice_parity', 'List practice parity records.',
    { type: 'object', properties: { practice: { type: 'string' } } },
    READ_POLICY, (p: Record<string, unknown>) => core.practiceParity(p));

  // v4: Skill Genealogy
  reg('core.record_skill_version', 'Record a skill version event.',
    { type: 'object', properties: { skillId: { type: 'string' }, version: { type: 'string' }, failure: { type: 'string' }, fix: { type: 'string' }, production: { type: 'string' } }, required: ['skillId'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.recordSkillVersion(p));
  reg('core.skill_genealogy', 'List skill version history.',
    { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] },
    READ_POLICY, (p: Record<string, unknown>) => core.skillGenealogy(p));

  // v4: Enriched Context Pack & Receipt
  reg('core.context_pack_v2', 'Build an enriched Context Pack with rules, cases, pitfalls, workarounds, pattern, uncertainty, confidence.',
    { type: 'object', properties: { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, sessionId: { type: 'string' }, includeGlobal: { type: 'boolean' } }, required: ['task'] },
    READ_POLICY, (p: Record<string, unknown>) => core.contextPackV2(p));
  reg('core.receipt_v2', 'Issue an enriched Decision Receipt with why, cases, risks, alternatives, uncertainty, confidence.',
    { type: 'object', properties: { task: { type: 'string' }, packId: { type: 'string' }, recommendation: { type: 'string' }, abstained: { type: 'boolean' }, platform: { type: 'string' } }, required: ['task', 'recommendation'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.receiptV2(p));

  reg('core.resolve_conflict', 'Resolve or classify a conflict (GENERAL_RULE, CONTEXTUAL_RULE, LEGACY_RULE, EXCEPTION, CONFLICTED, UNRESOLVED).',
    { type: 'object', properties: { id: { type: 'string' }, classification: { type: 'string', enum: ['GENERAL_RULE', 'CONTEXTUAL_RULE', 'LEGACY_RULE', 'EXCEPTION', 'CONFLICTED', 'UNRESOLVED'] }, note: { type: 'string' }, resolved: { type: 'boolean' } }, required: ['id', 'classification'] },
    WRITE_POLICY, (p: Record<string, unknown>) => core.resolveConflict(p));
  reg('core.domain', 'Return a domain view (units, claims, eligible skills, gaps) or insufficient-evidence.',
    { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    READ_POLICY, (p: { name: string }) => core.domain(p.name));

  reg('core.receipt', 'Issue a Decision Receipt binding task context and evidence revisions.',
    { type: 'object', properties: { task: { type: 'string' }, packId: { type: 'string' }, recommendation: { type: 'string' }, abstained: { type: 'boolean' } }, required: ['task', 'recommendation'] },
    WRITE_POLICY, (p: Parameters<CoreStorePort['receipt']>[0]) => core.receipt(p));

  reg('core.ingest_outcome', 'Ingest a verified outcome as a case + pending candidate (never auto-promoted).',
    { type: 'object', properties: { task: { type: 'string' }, context: { type: 'string' }, outcome: { type: 'string' }, verificationRef: { type: 'string' }, unitId: { type: 'string' }, platform: { type: 'string' } }, required: ['task', 'outcome'] },
    WRITE_POLICY, (p: Parameters<CoreStorePort['ingestOutcome']>[0]) => core.ingestOutcome(p));

  reg('core.adjudicate', 'Adjudicate a candidate (PROMOTE/REJECT/SUPERSEDE) with explicit authority.',
    { type: 'object', properties: { candidateId: { type: 'string' }, decision: { type: 'string', enum: ['PROMOTE', 'REJECT', 'SUPERSEDE'] }, authority: { type: 'string' }, rationale: { type: 'string' }, scope: { type: 'string', enum: ['production', 'acceptance-test'] } }, required: ['candidateId', 'decision', 'authority'] },
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
