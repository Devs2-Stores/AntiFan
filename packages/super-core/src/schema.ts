// Schema for the local-first evidence core. node:sqlite, WAL mode.
// All tables use TEXT primary keys (sha1/uuid-derived) — no autoincrement
// coupling to import order.

export const SCHEMA_VERSION = 3;

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
  subject TEXT
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
  note TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  caseId TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  context TEXT,
  outcome TEXT,
  verificationRef TEXT,
  unitId TEXT,
  createdAt TEXT NOT NULL
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
  createdAt TEXT NOT NULL
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
];
