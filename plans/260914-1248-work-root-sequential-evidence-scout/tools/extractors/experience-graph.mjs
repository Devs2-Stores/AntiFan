// Extractor: experience-graph — builds the per-unit experience chain
// (CLIENT_REQUEST -> PROJECT -> CONTEXT/TASK -> DECISION -> IMPLEMENTATION ->
// VERIFICATION -> OUTCOME -> LESSON) as experience-nodes.jsonl +
// experience-edges.jsonl rows for importScout.
//
// Evidence discipline: every node is backed by a real claim, decision, file
// entry, or the unit register row itself; every edge carries the backing
// evidence of the node it points to (or the unit anchor for PROJECT edges).
// A unit with no claims, no decisions and no verification artifacts emits
// empty ledgers — an empty graph is a correct result, never a synthetic one.

import crypto from 'node:crypto';

const EXTRACTOR = 'extract/experience-graph';

// Claim kind -> node kind. RULE/PLATFORM claims are knowledge, not experience
// events, so they intentionally produce no node.
const CLAIM_NODE_KIND = {
  COMMERCIAL: 'CLIENT_REQUEST', // client/quote/scope signal = the request that started the work
  SKILL: 'TASK',                // an eligible skill = a task capability exercised in this unit
  HISTORY: 'CONTEXT',           // git-log summary = historical context the work sits in
  BUGFIX: 'IMPLEMENTATION',
  FEATURE: 'IMPLEMENTATION',
  OUTCOME: 'OUTCOME',
  RISK: 'LESSON',               // recorded risk/limitation = a lesson carried forward
  ANTIPATTERN: 'LESSON',        // recorded pitfall = a lesson carried forward
};

// Forward chain order. CONTEXT sits between PROJECT and TASK: history informs
// the tasks taken on. Stages with no nodes are skipped when linking.
const STAGE_ORDER = [
  'CLIENT_REQUEST', 'PROJECT', 'CONTEXT', 'TASK',
  'DECISION', 'IMPLEMENTATION', 'VERIFICATION', 'OUTCOME', 'LESSON',
];

// Cap on pairwise edges between adjacent stages. Below it we link the full
// bipartite pair set (every decision genuinely sits between every task and
// every implementation of the same unit); above it each node links to the
// first node of the previous stage so a 500-commit unit stays bounded.
const MAX_STAGE_PAIR_EDGES = 24;

const TEST_FILE_RE = /(?:[\\/]|^)(?:__tests__|tests?|spec|e2e)[\\/]|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/i;
const VALIDATED_STATUS_RE = /^(VALIDATED|VERIFIED|CONFIRMED)$/i;

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

export function extract(ctx) {
  const { unitId, unit, files = [], platform = null, claims = [], decisions = [] } = ctx ?? {};
  const now = () => new Date().toISOString();
  const nid = (kind, refId) => `n-${crypto.createHash('sha1').update(`${unitId}${kind}${refId}`).digest('hex').slice(0, 12)}`;
  const eid = (from, to, kind) => `e-${crypto.createHash('sha1').update(`${unitId}${from}${to}${kind}`).digest('hex').slice(0, 12)}`;

  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();

  const addNode = (kind, refId, label, source, evidenceRefs, createdAt) => {
    const nodeId = nid(kind, refId ?? 'null');
    if (seenNodes.has(nodeId)) return null;
    seenNodes.add(nodeId);
    const node = {
      nodeId,
      unitId,
      kind,
      refId: refId ?? null,
      label: clip(label, 200) ?? null,
      // context column is TEXT — store a compact JSON string, not an object.
      context: JSON.stringify({ unitId, platform, source }),
      createdAt: createdAt ?? now(),
    };
    nodes.push(node);
    return { node, evidenceRefs: evidenceRefs ?? [], source };
  };

  const addEdge = (fromNodeId, toNodeId, kind, evidenceRefs) => {
    const edgeId = eid(fromNodeId, toNodeId, kind);
    if (seenEdges.has(edgeId)) return;
    seenEdges.add(edgeId);
    edges.push({
      edgeId,
      unitId,
      fromNodeId,
      toNodeId,
      kind,
      // evidence column is TEXT — stringify the evidenceRef list.
      evidence: JSON.stringify(evidenceRefs ?? []),
      createdAt: now(),
    });
  };

  // ---------- collect stage members ----------
  /** @type {Map<string, Array<{node: object, evidenceRefs: object[]}>>} */
  const stages = new Map();
  const push = (kind, entry) => {
    if (!entry) return;
    if (!stages.has(kind)) stages.set(kind, []);
    stages.get(kind).push(entry);
  };

  const unitAnchor = [{ entryId: null, revision: null, path: unit?.relPath ?? null, anchor: 'unit-register' }];

  // TASK nodes dedupe on skill subject: a SKILL.md emits two SKILL claims
  // (frontmatter + when_to_use) but they are one task capability.
  const seenTaskSubjects = new Set();

  for (const c of claims) {
    const kind = CLAIM_NODE_KIND[c?.kind];
    if (!kind) continue;
    if (kind === 'TASK') {
      const subj = c.subject ?? c.statement;
      if (seenTaskSubjects.has(subj)) continue;
      seenTaskSubjects.add(subj);
    }
    const label = c.subject ?? c.statement;
    push(kind, addNode(kind, c.claimId, label, c.sourceKind ?? 'claim', c.evidenceRefs, c.validFrom ?? c.createdAt));
  }

  for (const d of decisions) {
    push('DECISION', addNode('DECISION', d.decisionId, d.chosen ?? d.statement, 'decision', d.evidence, d.createdAt));
    // A decision row with a parsed outcome records that the decision was
    // checked against reality — that is a verification event for it.
    if (d.outcome) {
      const v = addNode('VERIFICATION', d.decisionId, `decision outcome recorded: ${clip(d.outcome, 120)}`, 'decision-outcome', d.evidence, d.createdAt);
      push('VERIFICATION', v);
      if (v) addEdge(v.node.nodeId, nid('DECISION', d.decisionId), 'verifies', d.evidence);
    }
  }

  // Claims already validated upstream are verification events for the work
  // they describe; link them to the implementation stage when one exists.
  const validated = claims.filter((c) => VALIDATED_STATUS_RE.test(c?.status ?? ''));
  for (const c of validated) {
    push('VERIFICATION', addNode('VERIFICATION', c.claimId, `validated: ${clip(c.subject ?? c.statement, 140)}`, c.sourceKind ?? 'claim', c.evidenceRefs, c.validFrom ?? c.createdAt));
  }

  // Test/spec files in the unit inventory are verification artifacts — one
  // node summarizing them, anchored on the real file entries.
  const testFiles = files.filter((f) => TEST_FILE_RE.test(f?.relPath ?? f?.path ?? ''));
  if (testFiles.length) {
    const testEv = testFiles.slice(0, 5).map((f) => (ctx.ev ? ctx.ev(f, 'test-file') : { entryId: f.entryId ?? null, revision: f.sha256 ?? null, path: f.relPath ?? null, anchor: 'test-file' }));
    push('VERIFICATION', addNode('VERIFICATION', testFiles[0].entryId ?? 'test-files', `${testFiles.length} test/verification file(s) present`, 'test-files', testEv, testFiles[0].mtime));
  }

  // Nothing experienced -> empty ledgers (no synthetic PROJECT anchor).
  if (!nodes.length) {
    return { claims: [], ledgers: { 'experience-nodes.jsonl': [], 'experience-edges.jsonl': [] } };
  }

  // PROJECT node anchors the chain; refId is the unit itself.
  push('PROJECT', addNode('PROJECT', unitId, `project: ${unit?.relPath ?? unitId}`, 'unit', unitAnchor, unit?.generatedAt));

  // ---------- chain edges ----------
  // Each node links forward to the next non-empty stage. Kind is semantic:
  // 'produces' into OUTCOME (work produces results), 'leads-to' elsewhere.
  // 'verifies'/'caused-by' are reserved for the attribution back-edges below.
  const present = STAGE_ORDER.filter((k) => stages.has(k));
  for (let i = 1; i < present.length; i += 1) {
    const prev = stages.get(present[i - 1]);
    const cur = stages.get(present[i]);
    const kind = present[i] === 'OUTCOME' ? 'produces' : 'leads-to';
    if (prev.length * cur.length <= MAX_STAGE_PAIR_EDGES) {
      for (const p of prev) for (const c of cur) addEdge(p.node.nodeId, c.node.nodeId, kind, c.evidenceRefs);
    } else {
      for (const c of cur) addEdge(prev[0].node.nodeId, c.node.nodeId, kind, c.evidenceRefs);
    }
  }

  // ---------- attribution back-edges ----------
  // VERIFICATION -verifies-> IMPLEMENTATION: test-file and validated-claim
  // verifiers attest the implementation stage (decision-outcome verifiers
  // already point at their own DECISION above).
  const impls = stages.get('IMPLEMENTATION') ?? [];
  const verifs = (stages.get('VERIFICATION') ?? []).filter((v) => v.source !== 'decision-outcome');
  if (impls.length && verifs.length) {
    if (impls.length * verifs.length <= MAX_STAGE_PAIR_EDGES) {
      for (const v of verifs) for (const im of impls) addEdge(v.node.nodeId, im.node.nodeId, 'verifies', v.evidenceRefs);
    } else {
      for (const v of verifs) addEdge(v.node.nodeId, impls[0].node.nodeId, 'verifies', v.evidenceRefs);
    }
  }

  // LESSON -caused-by-> OUTCOME (or IMPLEMENTATION when no outcome was
  // recorded): a lesson is caused by what the work produced.
  const lessons = stages.get('LESSON') ?? [];
  const causes = stages.get('OUTCOME') ?? impls;
  for (const l of lessons) {
    if (causes.length) addEdge(l.node.nodeId, causes[0].node.nodeId, 'caused-by', l.evidenceRefs);
  }

  return { claims: [], ledgers: { 'experience-nodes.jsonl': nodes, 'experience-edges.jsonl': edges } };
}
