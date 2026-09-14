# Core Design — corpus-informed (Phase 7)

Decisions frozen before implementation. Evidence: reports/corpus-findings.md, domain-register.json, completion-ledger.json.

## Storage
`node:sqlite` (DatabaseSync) — built into Node 24, zero deps, transactional, FTS5 for lexical retrieval. Chosen over graph DB: corpus workload is document/claim lookup + scoped filtering, not deep traversal; relational + FTS5 covers it. Graph views (lineage, conflicts) are queries over relational rows.

DB file: `<workspace>/.super-core/core.db` (configurable). WAL mode for crash safety.

## Schema
- `artifacts(entryId PK, unitId, rootId, relPath, absPath, type, size, mtime, sha256, contentPolicy, disposition, observedAt)`
- `claims(claimId PK, unitId, statement, kind, status, extractorVersion, contextPlatform, contextVersion, createdAt)`
- `evidence(id PK, claimId FK, entryId, revision, path, anchor)` — claim→artifact anchor
- `units(unitId PK, rootId, relPath, kind, disposition, parentId, markers, dossierPath)`
- `skills(skillId PK, name, namespace, rootId, location, akDisposition, analysisState, unitId)`
- `lineage(id PK, kind, subject, evidence, strength, membersJson)`
- `conflicts(id PK, kind, subject, positionsJson, state, note)`
- `cases(caseId PK, task, context, outcome, verificationRef, unitId, createdAt)` — verified outcomes
- `candidates(candidateId PK, caseId FK, statement, kind, evidenceJson, status, createdAt)` — pending knowledge
- `adjudications(id PK, candidateId FK, decision, authority, rationale, at)` — promotion/rejection audit
- `releases(releaseId PK, createdAt, note)` — snapshot markers for regression
- `receipts(receiptId PK, taskContext, packId, evidenceRevisions, recommendation, abstained, createdAt)`
- `observations(id PK, source, kind, payload, ingestedAt)` — raw outcome ingestion
- `claims_fts` FTS5 virtual table over claims(statement, kind, unitId)

## API (packages/super-core/src/index.ts)
- `openCore(dbPath)` → `Core`
- `core.importScout(reportsDir)` → idempotent import of inventory/claims/dossiers/skills/lineage/conflicts
- `core.query({text, platform?, unitId?, kind?, limit?})` → FTS5 hits + claim rows + evidence
- `core.contextPack({task, platform?, unitIds?})` → {release, claims, conflicts, unknowns, permissionScope}
- `core.receipt({task, packId, recommendation})` → Decision Receipt bound to evidence revisions
- `core.ingestOutcome({task, context, outcome, verificationRef})` → case + candidate (PENDING)
- `core.adjudicate({candidateId, decision, authority, rationale})` → audit row; PROMOTE requires authority
- `core.rollback({releaseId})` → restore claims/candidates to release state
- `core.invalidate({entryId|path})` → mark claims STALE on source change/delete
- `core.stats()` → counts for verification

## AntiFan integration (phase 12)
- `core.*` tools in `scripts/antifan-omp-mcp.cjs`: `core.query`, `core.context_pack`, `core.receipt`, `core.ingest_outcome`, `core.adjudicate`, `core.stats` — handled locally (not bridge-dispatched), since Core is a local store.
- `antifan core <cmd>` subcommand in `scripts/antifan-agent.cjs` for CLI access.
- Unavailable-Core: advisory tools return `{available:false}`; receipt-required actions refuse.

## Acceptance thresholds (frozen before evaluation)
- Import: 100% of eligible units imported; claims count matches claims.jsonl totals; zero unanchored claims.
- Retrieval: FTS5 query for a known claim term returns that claim in top-10; wrong-platform filter returns 0; empty query abstains.
- Restart: close+reopen preserves all counts.
- Interruption: kill mid-import → resume completes without duplicate claims.
- Revocation: mark source RESTRICTED → its claims excluded from packs.
- Rollback: restore to release → claim/candidate counts match release snapshot.
- Learning: outcome→case→candidate PENDING; adjudicate with test authority → PROMOTED in acceptance store only; real candidates stay PENDING.
- Latency: contextPack < 2s on full corpus; query < 500ms.
- Memory: import peak RSS < 2GB.

## Non-goals
No auto-promotion, no deployment, no provider calls, no corpus mutation.
