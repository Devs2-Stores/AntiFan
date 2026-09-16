// Schema for the local-first evidence core. node:sqlite, WAL mode.
// All tables use TEXT primary keys (sha1/uuid-derived) — no autoincrement
// coupling to import order.

export const SCHEMA_VERSION = 10;

export const CORE_NAMESPACES = ['PLATFORM_KNOWLEDGE', 'ANTIFAN_ENGINEERING', 'PERSONAL_PRACTICE'] as const;
export type CoreNamespace = typeof CORE_NAMESPACES[number];

// Platforms recognized by the keyword-derivation backfill. A row's own text
// (conflict subject, case task/context) may tag its platform ONLY when exactly
// one known platform name appears — zero or ambiguous matches stay NULL.
export const KNOWN_PLATFORMS = ['haravan', 'sapo', 'shopify', 'generic-liquid'] as const;

// One UNION ALL branch per known platform: `SELECT '<p>' p WHERE <expr> LIKE '%<p>%'`.
// The constant is the single source of truth — the backfill below derives its
// keyword lists from it, so adding a platform here changes the SQL. Names are
// compile-time literals, never request input, so interpolation is safe.
const platformKeywordUnion = (matchExpr: string) =>
  KNOWN_PLATFORMS.map((p, i) => `${i === 0 ? 'SELECT' : 'UNION ALL SELECT'} '${p}'${i === 0 ? ' p' : ''} WHERE ${matchExpr} LIKE '%${p}%'`).join('\n    ');

// Idempotent scope backfill for conflicts/cases/decisions. Derivation order:
//   1. conflicts.unitId  <- single unit resolvable via positionsJson skillIds
//   2. *.platform        <- unanimous contextPlatform of the unit's claims
//   3. *.platform        <- exactly-one known-platform keyword in the row's text
// Anything not derivable stays NULL — never fabricated. Runs inside migration
// 5->6 and again at the end of every importScout() so rebuilt DBs converge.
export const PLATFORM_BACKFILL_SQL = `
UPDATE conflicts SET unitId = (
  SELECT MIN(s.unitId) FROM json_each(conflicts.positionsJson) je
  JOIN skills s ON s.skillId = json_extract(je.value, '$.skillId')
  WHERE s.unitId IS NOT NULL
  HAVING COUNT(DISTINCT s.unitId) = 1
) WHERE unitId IS NULL;
UPDATE conflicts SET platform = (
  SELECT MIN(c.contextPlatform) FROM claims c
  WHERE c.unitId = conflicts.unitId AND c.contextPlatform IS NOT NULL
  HAVING COUNT(DISTINCT c.contextPlatform) = 1
) WHERE platform IS NULL AND unitId IS NOT NULL;
UPDATE conflicts SET platform = (
  SELECT MIN(p) FROM (
    ${platformKeywordUnion('conflicts.subject')}
  ) HAVING COUNT(*) = 1
) WHERE platform IS NULL AND subject IS NOT NULL;
UPDATE cases SET platform = (
  SELECT MIN(c.contextPlatform) FROM claims c
  WHERE c.unitId = cases.unitId AND c.contextPlatform IS NOT NULL
  HAVING COUNT(DISTINCT c.contextPlatform) = 1
) WHERE platform IS NULL AND unitId IS NOT NULL;
UPDATE cases SET platform = (
  SELECT MIN(p) FROM (
    ${platformKeywordUnion("(cases.task || ' ' || COALESCE(cases.context,''))")}
  ) HAVING COUNT(*) = 1
) WHERE platform IS NULL;
UPDATE decisions SET platform = (
  SELECT MIN(c.contextPlatform) FROM claims c
  WHERE c.unitId = decisions.unitId AND c.contextPlatform IS NOT NULL
  HAVING COUNT(DISTINCT c.contextPlatform) = 1
) WHERE platform IS NULL;
`;

export const NAMESPACE_BACKFILL_SQL = `
UPDATE claims SET namespace = 'PLATFORM_KNOWLEDGE'
WHERE namespace IS NULL AND contextPlatform IS NOT NULL;

UPDATE claims SET namespace = 'PERSONAL_PRACTICE'
WHERE namespace IS NULL AND (
  kind IN ('PRINCIPLE', 'PERSONAL_PRACTICE', 'PRACTICE', 'MINDSET')
  OR sourceKind IN ('principle', 'personal-practice')
  OR statement LIKE '%principle%'
);

UPDATE claims SET namespace = 'ANTIFAN_ENGINEERING'
WHERE namespace IS NULL AND (
  unitId IN (
    SELECT unitId FROM units
    WHERE relPath LIKE '%antifan%' OR relPath LIKE 'src%' OR relPath LIKE 'packages%' OR relPath LIKE 'apps%' OR rootId LIKE '%antifan%' OR markers LIKE '%antifan%'
  )
  OR unitId LIKE '%antifan%' OR unitId LIKE 'u-test%' OR unitId LIKE 'u-reuse%' OR unitId LIKE 'u-rank%'
);

UPDATE claims SET namespace = 'PLATFORM_KNOWLEDGE'
WHERE namespace IS NULL AND (
  statement LIKE '%haravan%' OR statement LIKE '%sapo%' OR statement LIKE '%shopify%' OR statement LIKE '%generic-liquid%'
  OR subject LIKE '%haravan%' OR subject LIKE '%sapo%' OR subject LIKE '%shopify%'
);

UPDATE claims SET namespace = 'ANTIFAN_ENGINEERING'
WHERE namespace IS NULL;

UPDATE cases SET namespace = 'PLATFORM_KNOWLEDGE'
WHERE namespace IS NULL AND platform IS NOT NULL;

UPDATE cases SET namespace = 'PLATFORM_KNOWLEDGE'
WHERE namespace IS NULL AND (
  (task || ' ' || COALESCE(context,'')) LIKE '%haravan%'
  OR (task || ' ' || COALESCE(context,'')) LIKE '%sapo%'
  OR (task || ' ' || COALESCE(context,'')) LIKE '%shopify%'
  OR (task || ' ' || COALESCE(context,'')) LIKE '%generic-liquid%'
);

UPDATE cases SET namespace = 'ANTIFAN_ENGINEERING'
WHERE namespace IS NULL AND (
  unitId IN (
    SELECT unitId FROM units
    WHERE relPath LIKE '%antifan%' OR relPath LIKE 'src%' OR relPath LIKE 'packages%' OR relPath LIKE 'apps%' OR markers LIKE '%antifan%'
  )
  OR unitId LIKE '%antifan%' OR unitId LIKE 'u-test%'
);

UPDATE cases SET namespace = 'ANTIFAN_ENGINEERING'
WHERE namespace IS NULL;

UPDATE decisions SET namespace = 'PLATFORM_KNOWLEDGE'
WHERE namespace IS NULL AND platform IS NOT NULL;

UPDATE decisions SET namespace = 'PLATFORM_KNOWLEDGE'
WHERE namespace IS NULL AND (
  (statement || ' ' || COALESCE(context,'')) LIKE '%haravan%'
  OR (statement || ' ' || COALESCE(context,'')) LIKE '%sapo%'
  OR (statement || ' ' || COALESCE(context,'')) LIKE '%shopify%'
  OR (statement || ' ' || COALESCE(context,'')) LIKE '%generic-liquid%'
);

UPDATE decisions SET namespace = 'ANTIFAN_ENGINEERING'
WHERE namespace IS NULL;
`;

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  entryId TEXT PRIMARY KEY,
  unitId TEXT NOT NULL,
  rootId TEXT NOT NULL,
  relPath TEXT NOT NULL,
  absPath TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER,
  mtime TEXT,
  sha256 TEXT,
  contentPolicy TEXT NOT NULL DEFAULT 'ALLOWED',
  disposition TEXT NOT NULL DEFAULT 'INVENTORIED',
  reason TEXT,
  coverage TEXT,
  observedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_unit ON artifacts(unitId);
CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(absPath);
CREATE INDEX IF NOT EXISTS idx_artifacts_policy ON artifacts(contentPolicy);

CREATE TABLE IF NOT EXISTS units (
  unitId TEXT PRIMARY KEY,
  rootId TEXT NOT NULL,
  relPath TEXT NOT NULL,
  kind TEXT NOT NULL,
  disposition TEXT NOT NULL,
  parentId TEXT,
  markers TEXT,
  dossierPath TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  claimId TEXT PRIMARY KEY,
  unitId TEXT NOT NULL,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OBSERVED',
  extractorVersion TEXT,
  contextPlatform TEXT,
  contextVersion TEXT,
  createdAt TEXT NOT NULL,
  supersededBy TEXT,
  confidence TEXT,
  validFrom TEXT,
  validUntil TEXT,
  sourceKind TEXT,
  subject TEXT,
  lastSeen TEXT,
  agingSince TEXT,
  namespace TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_unit ON claims(unitId);
CREATE INDEX IF NOT EXISTS idx_claims_kind ON claims(kind);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_platform ON claims(contextPlatform);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  claimId TEXT NOT NULL REFERENCES claims(claimId) ON DELETE CASCADE,
  entryId TEXT,
  revision TEXT,
  path TEXT,
  anchor TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_claim ON evidence(claimId);
CREATE INDEX IF NOT EXISTS idx_evidence_entry ON evidence(entryId);

CREATE TABLE IF NOT EXISTS skills (
  skillId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  namespace TEXT,
  rootId TEXT NOT NULL,
  location TEXT NOT NULL,
  akDisposition TEXT NOT NULL,
  analysisState TEXT,
  unitId TEXT,
  surfaceJson TEXT
);

CREATE TABLE IF NOT EXISTS lineage (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT,
  evidence TEXT,
  strength TEXT,
  membersJson TEXT
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT,
  positionsJson TEXT,
  state TEXT NOT NULL DEFAULT 'UNRESOLVED',
  classification TEXT,
  note TEXT,
  platform TEXT,
  unitId TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  caseId TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  context TEXT,
  outcome TEXT,
  verificationRef TEXT,
  unitId TEXT,
  platform TEXT,
  createdAt TEXT NOT NULL,
  namespace TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  candidateId TEXT PRIMARY KEY,
  caseId TEXT REFERENCES cases(caseId),
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidenceJson TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);

CREATE TABLE IF NOT EXISTS adjudications (
  id TEXT PRIMARY KEY,
  candidateId TEXT NOT NULL REFERENCES candidates(candidateId),
  decision TEXT NOT NULL,
  authority TEXT NOT NULL,
  rationale TEXT,
  at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'production'
);

CREATE TABLE IF NOT EXISTS decisions (
  decisionId TEXT PRIMARY KEY,
  unitId TEXT NOT NULL,
  statement TEXT NOT NULL,
  context TEXT,
  alternatives TEXT,
  chosen TEXT,
  evidenceJson TEXT,
  problem TEXT,
  tradeoffs TEXT,
  outcome TEXT,
  confidence TEXT,
  platform TEXT,
  createdAt TEXT NOT NULL,
  namespace TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_unit ON decisions(unitId);

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  fromUnitId TEXT NOT NULL,
  toUnitId TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidenceJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_dependencies_from ON dependencies(fromUnitId);
CREATE INDEX IF NOT EXISTS idx_dependencies_to ON dependencies(toUnitId);
CREATE INDEX IF NOT EXISTS idx_adjudications_candidate ON adjudications(candidateId);

CREATE TABLE IF NOT EXISTS releases (
  releaseId TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS release_claims (
  releaseId TEXT NOT NULL REFERENCES releases(releaseId),
  claimId TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (releaseId, claimId)
);

CREATE TABLE IF NOT EXISTS release_candidates (
  releaseId TEXT NOT NULL REFERENCES releases(releaseId),
  candidateId TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (releaseId, candidateId)
);

CREATE TABLE IF NOT EXISTS receipts (
  receiptId TEXT PRIMARY KEY,
  taskContext TEXT NOT NULL,
  packId TEXT,
  evidenceRevisions TEXT,
  recommendation TEXT,
  abstained INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packs (
  packId TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  platform TEXT,
  claimIdsJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  taskHash TEXT,
  sessionId TEXT,
  lastIssuedAt TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  ingestedAt TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  statement, kind, unitId, claimId UNINDEXED
);

-- v4: Experience Graph (§14), Anti-Pattern Library (§28), Workaround Library (§29),
-- Fix Patterns (§31), Corpus Audit (§50), Phase Gates (§51), Core Regression (§46),
-- Principles (§23), Hidden Requirements (§25), Commercial Intelligence (§26),
-- Tool Intelligence (§27), Archetypes (§33), Platform Semantics (§12),
-- Practice Parity (§21), Skill Genealogy (§22).

CREATE TABLE IF NOT EXISTS experience_nodes (
  nodeId TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  refId TEXT,
  label TEXT,
  context TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experience_nodes_kind ON experience_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_experience_nodes_ref ON experience_nodes(refId);

CREATE TABLE IF NOT EXISTS experience_edges (
  edgeId TEXT PRIMARY KEY,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experience_edges_from ON experience_edges(fromNodeId);
CREATE INDEX IF NOT EXISTS idx_experience_edges_to ON experience_edges(toNodeId);

CREATE TABLE IF NOT EXISTS anti_patterns (
  patternId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  whatNotToDo TEXT,
  symptoms TEXT,
  evidence TEXT,
  affectedPlatform TEXT,
  replacement TEXT,
  status TEXT NOT NULL DEFAULT 'OBSERVED',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workarounds (
  workaroundId TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  condition TEXT,
  solution TEXT,
  reason TEXT,
  platform TEXT,
  version TEXT,
  evidence TEXT,
  stillValid INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fix_patterns (
  fixId TEXT PRIMARY KEY,
  before TEXT,
  after TEXT,
  why TEXT,
  evidence TEXT,
  lesson TEXT,
  platform TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corpus_audit (
  auditId TEXT PRIMARY KEY,
  artifactsDiscovered INTEGER,
  artifactsRead INTEGER,
  artifactsAnalyzed INTEGER,
  artifactsClassified INTEGER,
  artifactsConnected INTEGER,
  artifactsExtracted INTEGER,
  blocked INTEGER,
  reasonsJson TEXT,
  unresolved INTEGER,
  coveragePct REAL,
  rulesGenerated INTEGER,
  candidatesPending INTEGER,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phase_gates (
  gateId TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  gate TEXT NOT NULL,
  passed INTEGER NOT NULL,
  detail TEXT,
  checkedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regressions (
  regressionId TEXT PRIMARY KEY,
  newKnowledge TEXT,
  affectedRulesJson TEXT,
  affectedCasesJson TEXT,
  affectedRecommendationsJson TEXT,
  checksJson TEXT,
  replayResult TEXT,
  replayedAt TEXT,
  replayDetailJson TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principles (
  principleId TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  source TEXT,
  derivedFrom TEXT,
  status TEXT NOT NULL DEFAULT 'OBSERVED',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hidden_requirements (
  reqId TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  explicitReq TEXT,
  inferredReq TEXT,
  likelihood TEXT,
  evidence TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commercial_intel (
  intelId TEXT PRIMARY KEY,
  taskType TEXT NOT NULL,
  quote REAL,
  scope TEXT,
  estimate REAL,
  actual REAL,
  risk TEXT,
  revisionCount INTEGER,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_intel (
  toolId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  problemSolved TEXT,
  workflowStage TEXT,
  inputs TEXT,
  outputs TEXT,
  failureModes TEXT,
  timeSaved REAL,
  maintenanceCost REAL,
  roi REAL,
  usageFrequency TEXT,
  status TEXT NOT NULL DEFAULT 'OBSERVED',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archetypes (
  archetypeId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  maturityLevel INTEGER,
  evidenceJson TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_semantics (
  semanticId TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  semanticRole TEXT NOT NULL,
  propertyName TEXT,
  cssFact TEXT,
  semanticTruth TEXT,
  evidence TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_semantics ON platform_semantics(platform, semanticRole);

CREATE TABLE IF NOT EXISTS practice_parity (
  parityId TEXT PRIMARY KEY,
  practice TEXT NOT NULL,
  declared TEXT,
  observed TEXT,
  gap TEXT,
  evidence TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  versionId TEXT PRIMARY KEY,
  skillId TEXT NOT NULL,
  version TEXT,
  failure TEXT,
  fix TEXT,
  production TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_versions ON skill_versions(skillId);
`;

// Indexes on v6 columns. These CANNOT live in DDL: DDL runs before migrations,
// and on a pre-v6 database the columns do not exist yet. Executed after the
// migration loop; idempotent on fresh and migrated databases alike.
export const POST_SCHEMA_SQL = `
CREATE INDEX IF NOT EXISTS idx_conflicts_platform ON conflicts(platform);
CREATE INDEX IF NOT EXISTS idx_cases_platform ON cases(platform);
CREATE INDEX IF NOT EXISTS idx_decisions_platform ON decisions(platform);
CREATE INDEX IF NOT EXISTS idx_packs_taskhash ON packs(taskHash);
CREATE INDEX IF NOT EXISTS idx_claims_namespace ON claims(namespace);
CREATE INDEX IF NOT EXISTS idx_cases_namespace ON cases(namespace);
CREATE INDEX IF NOT EXISTS idx_decisions_namespace ON decisions(namespace);
`;

export const MIGRATIONS: Array<{ from: number; to: number; sql: string }> = [
  {
    from: 1, to: 2,
    sql: `ALTER TABLE claims ADD COLUMN supersededBy TEXT;
CREATE TABLE IF NOT EXISTS packs (
  packId TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  platform TEXT,
  claimIdsJson TEXT NOT NULL,
  createdAt TEXT NOT NULL
);`,
  },
  {
    from: 2, to: 3,
    sql: `ALTER TABLE adjudications ADD COLUMN scope TEXT NOT NULL DEFAULT 'production';
ALTER TABLE claims ADD COLUMN confidence TEXT;
ALTER TABLE claims ADD COLUMN validFrom TEXT;
ALTER TABLE claims ADD COLUMN validUntil TEXT;
ALTER TABLE claims ADD COLUMN sourceKind TEXT;
ALTER TABLE claims ADD COLUMN subject TEXT;
ALTER TABLE skills ADD COLUMN surfaceJson TEXT;
CREATE TABLE IF NOT EXISTS decisions (
  decisionId TEXT PRIMARY KEY,
  unitId TEXT NOT NULL,
  statement TEXT NOT NULL,
  context TEXT,
  alternatives TEXT,
  chosen TEXT,
  evidenceJson TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_unit ON decisions(unitId);
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  fromUnitId TEXT NOT NULL,
  toUnitId TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidenceJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_dependencies_from ON dependencies(fromUnitId);
CREATE INDEX IF NOT EXISTS idx_dependencies_to ON dependencies(toUnitId);`,
  },
  {
    from: 3, to: 4,
    sql: `ALTER TABLE decisions ADD COLUMN problem TEXT;
ALTER TABLE decisions ADD COLUMN tradeoffs TEXT;
ALTER TABLE decisions ADD COLUMN outcome TEXT;
ALTER TABLE decisions ADD COLUMN confidence TEXT;
ALTER TABLE claims ADD COLUMN lastSeen TEXT;
ALTER TABLE claims ADD COLUMN agingSince TEXT;
ALTER TABLE conflicts ADD COLUMN classification TEXT;
CREATE TABLE IF NOT EXISTS experience_nodes (
  nodeId TEXT PRIMARY KEY, kind TEXT NOT NULL, refId TEXT, label TEXT, context TEXT, createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experience_nodes_kind ON experience_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_experience_nodes_ref ON experience_nodes(refId);
CREATE TABLE IF NOT EXISTS experience_edges (
  edgeId TEXT PRIMARY KEY, fromNodeId TEXT NOT NULL, toNodeId TEXT NOT NULL, kind TEXT NOT NULL, evidence TEXT, createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experience_edges_from ON experience_edges(fromNodeId);
CREATE INDEX IF NOT EXISTS idx_experience_edges_to ON experience_edges(toNodeId);
CREATE TABLE IF NOT EXISTS anti_patterns (
  patternId TEXT PRIMARY KEY, name TEXT NOT NULL, whatNotToDo TEXT, symptoms TEXT, evidence TEXT, affectedPlatform TEXT, replacement TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workarounds (
  workaroundId TEXT PRIMARY KEY, problem TEXT NOT NULL, condition TEXT, solution TEXT, reason TEXT, platform TEXT, version TEXT, evidence TEXT, stillValid INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fix_patterns (
  fixId TEXT PRIMARY KEY, before TEXT, after TEXT, why TEXT, evidence TEXT, lesson TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corpus_audit (
  auditId TEXT PRIMARY KEY, artifactsDiscovered INTEGER, artifactsRead INTEGER, artifactsAnalyzed INTEGER, artifactsClassified INTEGER, artifactsConnected INTEGER, artifactsExtracted INTEGER, blocked INTEGER, reasonsJson TEXT, unresolved INTEGER, coveragePct REAL, rulesGenerated INTEGER, candidatesPending INTEGER, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phase_gates (
  gateId TEXT PRIMARY KEY, phase TEXT NOT NULL, gate TEXT NOT NULL, passed INTEGER NOT NULL, detail TEXT, checkedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS regressions (
  regressionId TEXT PRIMARY KEY, newKnowledge TEXT, affectedRulesJson TEXT, affectedCasesJson TEXT, affectedRecommendationsJson TEXT, replayResult TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principles (
  principleId TEXT PRIMARY KEY, statement TEXT NOT NULL, source TEXT, derivedFrom TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hidden_requirements (
  reqId TEXT PRIMARY KEY, task TEXT NOT NULL, explicitReq TEXT, inferredReq TEXT, likelihood TEXT, evidence TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commercial_intel (
  intelId TEXT PRIMARY KEY, taskType TEXT NOT NULL, quote REAL, scope TEXT, estimate REAL, actual REAL, risk TEXT, revisionCount INTEGER, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_intel (
  toolId TEXT PRIMARY KEY, name TEXT NOT NULL, problemSolved TEXT, workflowStage TEXT, inputs TEXT, outputs TEXT, failureModes TEXT, timeSaved REAL, maintenanceCost REAL, roi REAL, usageFrequency TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archetypes (
  archetypeId TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, maturityLevel INTEGER, evidenceJson TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_semantics (
  semanticId TEXT PRIMARY KEY, platform TEXT NOT NULL, semanticRole TEXT NOT NULL, propertyName TEXT, cssFact TEXT, semanticTruth TEXT, evidence TEXT, createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_semantics ON platform_semantics(platform, semanticRole);
CREATE TABLE IF NOT EXISTS practice_parity (
  parityId TEXT PRIMARY KEY, practice TEXT NOT NULL, declared TEXT, observed TEXT, gap TEXT, evidence TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_versions (
  versionId TEXT PRIMARY KEY, skillId TEXT NOT NULL, version TEXT, failure TEXT, fix TEXT, production TEXT, createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_versions ON skill_versions(skillId);`,
  },
  {
    from: 4, to: 5,
    sql: `ALTER TABLE artifacts ADD COLUMN reason TEXT;
ALTER TABLE artifacts ADD COLUMN coverage TEXT;
UPDATE anti_patterns SET status = 'OBSERVED' WHERE status = 'ACTIVE';
UPDATE principles SET status = 'OBSERVED' WHERE status = 'ACTIVE';
UPDATE tool_intel SET status = 'OBSERVED' WHERE status = 'ACTIVE';`,
  },
  {
    from: 5, to: 6,
    sql: `ALTER TABLE conflicts ADD COLUMN platform TEXT;
ALTER TABLE conflicts ADD COLUMN unitId TEXT;
ALTER TABLE cases ADD COLUMN platform TEXT;
ALTER TABLE decisions ADD COLUMN platform TEXT;
ALTER TABLE fix_patterns ADD COLUMN platform TEXT;
ALTER TABLE packs ADD COLUMN taskHash TEXT;
ALTER TABLE packs ADD COLUMN sessionId TEXT;
CREATE INDEX IF NOT EXISTS idx_conflicts_platform ON conflicts(platform);
CREATE INDEX IF NOT EXISTS idx_cases_platform ON cases(platform);
CREATE INDEX IF NOT EXISTS idx_decisions_platform ON decisions(platform);
CREATE INDEX IF NOT EXISTS idx_packs_taskhash ON packs(taskHash);
${PLATFORM_BACKFILL_SQL}`,
  },
  {
    from: 6, to: 7,
    sql: `ALTER TABLE regressions ADD COLUMN checksJson TEXT;
ALTER TABLE regressions ADD COLUMN replayedAt TEXT;
ALTER TABLE regressions ADD COLUMN replayDetailJson TEXT;`,
  },
  {
    // Quarantine asserted replay results. Before 6->7 a caller could hand
    // recordRegression a replayResult, so a row can claim PASS without ever
    // having been re-executed. replayResult now belongs to replayRegression()
    // alone, and the regression gate requires a replayedAt to pass — so an
    // asserted value is not merely ignored, it is withdrawn here: the row keeps
    // its definition and reads as "recorded but never replayed" until a real
    // replay earns a verdict.
    from: 7, to: 8,
    sql: `UPDATE regressions SET replayResult = NULL WHERE replayedAt IS NULL AND replayResult IS NOT NULL;`,
  },
  {
    // Track when a pack was last issued, not just created. contextPack's dedupe
    // upsert refreshes claimIdsJson in place without touching createdAt, so a
    // re-issued older pack looked older than a pack merely created later.
    // lastIssuedAt is the write time the upsert maintains; the backfill seeds it
    // from createdAt so existing rows keep their prior order.
    from: 8, to: 9,
    sql: `ALTER TABLE packs ADD COLUMN lastIssuedAt TEXT;
UPDATE packs SET lastIssuedAt = createdAt WHERE lastIssuedAt IS NULL;`,
  },
  {
    from: 9, to: 10,
    sql: `ALTER TABLE claims ADD COLUMN namespace TEXT;
ALTER TABLE cases ADD COLUMN namespace TEXT;
ALTER TABLE decisions ADD COLUMN namespace TEXT;
CREATE INDEX IF NOT EXISTS idx_claims_namespace ON claims(namespace);
CREATE INDEX IF NOT EXISTS idx_cases_namespace ON cases(namespace);
CREATE INDEX IF NOT EXISTS idx_decisions_namespace ON decisions(namespace);
${NAMESPACE_BACKFILL_SQL}`,
  },
];
