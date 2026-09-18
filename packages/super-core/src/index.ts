// Core: local-first evidence/provenance store over node:sqlite.
// Invariants: no auto-promotion; claims always carry evidence anchors;
// restricted sources never leak into packs; conflicts stay unresolved.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DDL, MIGRATIONS, SCHEMA_VERSION, PLATFORM_BACKFILL_SQL, POST_SCHEMA_SQL, NAMESPACE_BACKFILL_SQL, CORE_NAMESPACES, CoreNamespace, KNOWN_PLATFORMS } from './schema.js';
export { CORE_NAMESPACES, CoreNamespace };

const id = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
// §3 Zero Silent Skip: an artifact is terminal only when it reached a real
// analyzed/excluded state. BLOCKED is terminal only with a recorded reason.
const TERMINAL_DISPOSITIONS = new Set(['ANALYZED_NO_CLAIM', 'ANALYZED_WITH_CLAIMS', 'EXCLUDED']);
const CONFLICT_CLASSIFICATIONS = new Set(['GENERAL_RULE', 'CONTEXTUAL_RULE', 'LEGACY_RULE', 'EXCEPTION', 'CONFLICTED', 'UNRESOLVED']);

/** Whitespace-insensitive statement key: the same sentence re-extracted from
 *  another unit differs only in spacing/line-wrap, never in what it asserts. */
const normalizeStatement = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Collapse claims that assert the same sentence, keeping the strongest row (the
 * input is already ranked) and recording how many copies it stands for. Namespace
 * is part of the key: the same words in PLATFORM_KNOWLEDGE and in
 * ANTIFAN_ENGINEERING are two different pieces of knowledge, and the corpus gate
 * counts a principle per namespace. Platforms are merged into the kept row
 * instead of splitting it, because the copies ARE the same assertion observed in
 * several contexts.
 */
function collapseDuplicateStatements<
  T extends { statement?: unknown; namespace?: unknown; unitId?: unknown; contextPlatform?: unknown },
>(claims: T[], limit: number): Array<T & { duplicateCount: number; alsoInUnitIds: string[]; contextPlatforms: string[] }> {
  const byKey = new Map<string, T & { duplicateCount: number; alsoInUnitIds: string[]; contextPlatforms: string[] }>();
  for (const claim of claims) {
    const key = `${typeof claim.namespace === 'string' ? claim.namespace : ''}|${normalizeStatement(claim.statement)}`;
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, Object.assign(claim, {
        duplicateCount: 1,
        alsoInUnitIds: typeof claim.unitId === 'string' ? [claim.unitId] : [],
        contextPlatforms: typeof claim.contextPlatform === 'string' ? [claim.contextPlatform] : [],
      }));
      continue;
    }
    kept.duplicateCount += 1;
    const unit = typeof claim.unitId === 'string' ? claim.unitId : null;
    if (unit && !kept.alsoInUnitIds.includes(unit) && kept.alsoInUnitIds.length < 8) kept.alsoInUnitIds.push(unit);
    const platform = typeof claim.contextPlatform === 'string' ? claim.contextPlatform : null;
    if (platform && !kept.contextPlatforms.includes(platform) && kept.contextPlatforms.length < 6) kept.contextPlatforms.push(platform);
  }
  return [...byKey.values()].slice(0, limit);
}


export interface QueryOpts { text?: string; platform?: string; unitId?: string; unitIds?: string[]; kind?: string; limit?: number; includeGlobal?: boolean; namespace?: CoreNamespace; }
export interface PackOpts { task: string; platform?: string; unitIds?: string[]; limit?: number; sessionId?: string; includeGlobal?: boolean; namespace?: CoreNamespace; }
export interface OutcomeInput { task: string; context?: string; outcome: string; verificationRef?: string; unitId?: string; platform?: string; namespace?: CoreNamespace; }

// A regression check is a re-executable invariant over live store state.
// claim-status: claimId must hold `expect` ('LIVE' = not stale/revoked/superseded).
// case-present: claimId field carries a caseId that must still exist.
// query-hit: `text` query must return >= min rows (default 1), and when claimId
// is given that claim must be among the hits.
export interface RegressionCheck { kind: 'claim-status' | 'case-present' | 'query-hit'; claimId?: string; expect?: string; text?: string; platform?: string; min?: number; }

// Deterministic composite ranking weights (R4/R6). Positive weights sum to 1.0;
// unresolved conflicts SUBTRACT, never add. Frozen before measurement.
const RANK = { text: 0.25, evidence: 0.20, state: 0.15, platform: 0.15, namespace: 0.15, recency: 0.10, conflictPenalty: 0.10 } as const;
const TOP_SCORE_MIN_THRESHOLD = 0.30;
// SQLite FTS5 bm25() returns a score <= 0 where MORE NEGATIVE is a BETTER match
// (`ORDER BY rank` ascending puts the best first). The text component runs the
// magnitude through q/(q+K) so it increases with match quality and saturates at
// 1. K is the half-saturation point, picked from the spread of bm25() values
// observed on this corpus (strong matches land near 8-16).
const BM25_HALF_SATURATION = 8;
// A row carrying no bm25 rank (rehydrated pack rows have no rank column) is
// neutral — the midpoint, not a perfect match. Scoring it as 1.0 made every
// rehydrated pack report a higher confidence than the same pack scored live.
const TEXT_NEUTRAL = 0.5;
const CONFIDENCE = { high: 0.60, medium: 0.40, low: 0.20 } as const;
// A claim is "quality" when it carries at least one evidence anchor and is not
// dragged below the noise floor by unresolved conflicts.
const QUALITY_MIN_SCORE = 0.30;
const MIN_QUALITY_CLAIMS = 2;
const STATE_SCORE: Record<string, number> = { PROMOTED: 1, ACTIVE: 0.8, OBSERVED: 0.6 };

export class Core {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(DDL);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string } | undefined;
    let v = row ? parseInt(row.value, 10) : SCHEMA_VERSION;
    // Each step commits together with its own version bump. Applying the DDL
    // and then recording the version separately means an interruption between
    // them leaves a half-migrated schema whose version still names the previous
    // step — the replay then dies on `duplicate column name` and the store can
    // never be opened again. SQLite DDL is transactional, so one transaction per
    // step makes the upgrade all-or-nothing.
    for (const m of MIGRATIONS) {
      if (v !== m.from) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(m.sql);
        this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('schemaVersion', String(m.to));
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* transaction already unwound by the failed statement */
        }
        throw err;
      }
      v = m.to;
    }
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('schemaVersion', String(v));
    this.db.exec(POST_SCHEMA_SQL);
  }

  close() { this.db.close(); }

  stats() {
    const c = (t: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      artifacts: c('artifacts'), claims: c('claims'), evidence: c('evidence'),
      units: c('units'), skills: c('skills'), lineage: c('lineage'),
      conflicts: c('conflicts'), cases: c('cases'), candidates: c('candidates'),
      adjudications: c('adjudications'), releases: c('releases'), receipts: c('receipts'),
      packs: c('packs'), observations: c('observations'),
      experienceNodes: c('experience_nodes'), experienceEdges: c('experience_edges'),
      antiPatterns: c('anti_patterns'), workarounds: c('workarounds'), fixPatterns: c('fix_patterns'),
      corpusAudits: c('corpus_audit'), phaseGates: c('phase_gates'), regressions: c('regressions'),
      principles: c('principles'), hiddenRequirements: c('hidden_requirements'),
      commercialIntel: c('commercial_intel'), toolIntel: c('tool_intel'),
      archetypes: c('archetypes'), platformSemantics: c('platform_semantics'),
      practiceParity: c('practice_parity'), skillVersions: c('skill_versions'),
    };
  }

  // ---- import --------------------------------------------------------------
  importScout(reportsDir: string) {
    const ins = {
      unit: this.db.prepare('INSERT OR REPLACE INTO units(unitId,rootId,relPath,kind,disposition,parentId,markers,dossierPath) VALUES (?,?,?,?,?,?,?,?)'),
      artifact: this.db.prepare('INSERT OR REPLACE INTO artifacts(entryId,unitId,rootId,relPath,absPath,type,size,mtime,sha256,contentPolicy,disposition,reason,coverage,observedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      conflict: this.db.prepare(`INSERT INTO conflicts(id,kind,subject,positionsJson,state,classification,note,platform,unitId) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind, subject=excluded.subject, positionsJson=excluded.positionsJson,
          state=CASE WHEN conflicts.state='RESOLVED' THEN 'RESOLVED' ELSE excluded.state END,
          classification=COALESCE(conflicts.classification, excluded.classification),
          note=COALESCE(conflicts.note, excluded.note),
          platform=COALESCE(conflicts.platform, excluded.platform),
          unitId=COALESCE(conflicts.unitId, excluded.unitId)`),
      ftsDel: this.db.prepare('DELETE FROM claims_fts WHERE claimId = ?'),
      fts: this.db.prepare('INSERT INTO claims_fts(rowid,statement,kind,unitId,claimId) VALUES ((SELECT rowid FROM claims WHERE claimId=?),?,?,?,?)'),
      evidence: this.db.prepare('INSERT OR REPLACE INTO evidence(id,claimId,entryId,revision,path,anchor) VALUES (?,?,?,?,?,?)'),
      skill: this.db.prepare('INSERT OR REPLACE INTO skills(skillId,name,namespace,rootId,location,akDisposition,analysisState,unitId) VALUES (?,?,?,?,?,?,?,?)'),
      lineage: this.db.prepare('INSERT OR REPLACE INTO lineage(id,kind,subject,evidence,strength,membersJson) VALUES (?,?,?,?,?,?)'),
      // Upsert claims but never resurrect an operator-set terminal status
      // (REVOKED / SUPERSEDED / STALE_SOURCE_CHANGED) back to OBSERVED on re-import.
      claim: this.db.prepare(`INSERT INTO claims(claimId,unitId,statement,kind,status,extractorVersion,contextPlatform,contextVersion,createdAt,confidence,validFrom,validUntil,sourceKind,subject,namespace) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(claimId) DO UPDATE SET
          unitId=excluded.unitId, statement=excluded.statement, kind=excluded.kind,
          extractorVersion=excluded.extractorVersion, contextPlatform=excluded.contextPlatform,
          contextVersion=excluded.contextVersion, confidence=excluded.confidence,
          validFrom=excluded.validFrom, validUntil=excluded.validUntil,
          sourceKind=excluded.sourceKind, subject=excluded.subject,
          namespace=COALESCE(excluded.namespace, claims.namespace),
          status=CASE WHEN claims.status IN ('REVOKED','SUPERSEDED','STALE_SOURCE_CHANGED','PROMOTED') THEN claims.status ELSE excluded.status END`),
      decision: this.db.prepare('INSERT OR REPLACE INTO decisions(decisionId,unitId,statement,context,alternatives,chosen,evidenceJson,problem,tradeoffs,outcome,confidence,platform,createdAt,namespace) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      dependency: this.db.prepare('INSERT OR REPLACE INTO dependencies(id,fromUnitId,toUnitId,kind,evidenceJson) VALUES (?,?,?,?,?)'),
    };
    let skippedLines = 0;
    const jsonl = (f: string) => fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { skippedLines++; return null; } }).filter(Boolean)
      : [];

    this.db.exec('BEGIN');
    try {
      // units + register
      const register = JSON.parse(fs.readFileSync(path.join(reportsDir, 'project-register.json'), 'utf8'));
      for (const u of register.units) {
        ins.unit.run(u.unitId, u.rootId, u.relPath, u.kind, u.disposition, u.parentId ?? null, JSON.stringify(u.markers ?? []), `reports/units/${u.unitId}/dossier.md`);
      }
      // skills
      const skills = JSON.parse(fs.readFileSync(path.join(reportsDir, 'skills-register.json'), 'utf8'));
      for (const s of skills.skills) {
        ins.skill.run(s.skillId, s.name, s.namespace ?? null, s.rootId, s.location, s.akDisposition, s.analysisState ?? null, s.unitId ?? null);
        if (s.surfaceJson !== undefined) {
          this.db.prepare('UPDATE skills SET surfaceJson = ? WHERE skillId = ?').run(JSON.stringify(s.surfaceJson ?? null), s.skillId);
        }
      }
      // lineage + conflicts. Conflict scope: explicit unitId/platform from the
      // ledger wins; otherwise unitId is derived when positionsJson resolves to
      // exactly one unit via skills. Platform is backfilled post-import once
      // claims exist (PLATFORM_BACKFILL_SQL).
      const skillUnit: Record<string, string> = {};
      for (const s of this.db.prepare('SELECT skillId, unitId FROM skills WHERE unitId IS NOT NULL').all() as Array<{ skillId: string; unitId: string }>) {
        skillUnit[s.skillId] = s.unitId;
      }
      for (const l of jsonl(path.join(reportsDir, 'lineage.jsonl'))) {
        ins.lineage.run(l.id, l.kind, l.name ?? l.base ?? l.sha256 ?? null, l.evidence ?? null, l.strength ?? null, JSON.stringify(l.units ?? l.locations ?? l.paths ?? []));
      }
      for (const c of jsonl(path.join(reportsDir, 'conflicts.jsonl'))) {
        const posUnits = new Set<string>();
        for (const p of (c.positions ?? []) as Array<{ skillId?: string }>) {
          const u = p?.skillId ? skillUnit[p.skillId] : undefined;
          if (u) posUnits.add(u);
        }
        const cUnit = c.unitId ?? (posUnits.size === 1 ? [...posUnits][0] : null);
        ins.conflict.run(c.id, c.kind, c.subject ?? null, JSON.stringify(c.positions ?? []), c.state ?? 'UNRESOLVED', c.classification ?? null, c.note ?? null, c.platform ?? null, cUnit);
      }
      // v4: new JSONL types
      for (const l of jsonl(path.join(reportsDir, 'experience-nodes.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO experience_nodes(nodeId,kind,refId,label,context,createdAt) VALUES (?,?,?,?,?,?)')
          .run(l.nodeId ?? `exp-${uuid()}`, l.kind, l.refId ?? null, l.label ?? null, l.context ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'experience-edges.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO experience_edges(edgeId,fromNodeId,toNodeId,kind,evidence,createdAt) VALUES (?,?,?,?,?,?)')
          .run(l.edgeId ?? `edge-${uuid()}`, l.fromNodeId, l.toNodeId, l.kind, l.evidence ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'anti-patterns.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO anti_patterns(patternId,name,whatNotToDo,symptoms,evidence,affectedPlatform,replacement,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(l.patternId ?? `ap-${uuid()}`, l.name, l.whatNotToDo ?? null, l.symptoms ?? null, l.evidence ?? null, l.affectedPlatform ?? null, l.replacement ?? null, l.status ?? 'OBSERVED', l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'workarounds.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO workarounds(workaroundId,problem,condition,solution,reason,platform,version,evidence,stillValid,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(l.workaroundId ?? `wa-${uuid()}`, l.problem, l.condition ?? null, l.solution ?? null, l.reason ?? null, l.platform ?? null, l.version ?? null, l.evidence ?? null, l.stillValid ?? 1, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'fix-patterns.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO fix_patterns(fixId,before,after,why,evidence,lesson,platform,createdAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(l.fixId ?? `fix-${uuid()}`, l.before ?? null, l.after ?? null, l.why ?? null, l.evidence ?? null, l.lesson ?? null, l.platform ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'principles.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO principles(principleId,statement,source,derivedFrom,status,createdAt) VALUES (?,?,?,?,?,?)')
          .run(l.principleId ?? `prin-${uuid()}`, l.statement, l.source ?? null, l.derivedFrom ?? null, l.status ?? 'OBSERVED', l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'hidden-requirements.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO hidden_requirements(reqId,task,explicitReq,inferredReq,likelihood,evidence,createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(l.reqId ?? `req-${uuid()}`, l.task, l.explicitReq ?? null, l.inferredReq ?? null, l.likelihood ?? null, l.evidence ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'commercial-intel.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO commercial_intel(intelId,taskType,quote,scope,estimate,actual,risk,revisionCount,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(l.intelId ?? `ci-${uuid()}`, l.taskType, l.quote ?? null, l.scope ?? null, l.estimate ?? null, l.actual ?? null, l.risk ?? null, l.revisionCount ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'tool-intel.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO tool_intel(toolId,name,problemSolved,workflowStage,inputs,outputs,failureModes,timeSaved,maintenanceCost,roi,usageFrequency,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(l.toolId ?? `tool-${uuid()}`, l.name, l.problemSolved ?? null, l.workflowStage ?? null, l.inputs ?? null, l.outputs ?? null, l.failureModes ?? null, l.timeSaved ?? null, l.maintenanceCost ?? null, l.roi ?? null, l.usageFrequency ?? null, l.status ?? 'OBSERVED', l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'archetypes.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO archetypes(archetypeId,name,platform,maturityLevel,evidenceJson,createdAt) VALUES (?,?,?,?,?,?)')
          .run(l.archetypeId ?? `arch-${uuid()}`, l.name, l.platform ?? null, l.maturityLevel ?? null, JSON.stringify(l.evidence ?? []), l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'platform-semantics.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO platform_semantics(semanticId,platform,semanticRole,propertyName,cssFact,semanticTruth,evidence,createdAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(l.semanticId ?? `sem-${uuid()}`, l.platform, l.semanticRole, l.propertyName ?? null, l.cssFact ?? null, l.semanticTruth ?? null, l.evidence ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'practice-parity.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO practice_parity(parityId,practice,declared,observed,gap,evidence,createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(l.parityId ?? `pp-${uuid()}`, l.practice, l.declared ?? null, l.observed ?? null, l.gap ?? null, l.evidence ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'skill-versions.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO skill_versions(versionId,skillId,version,failure,fix,production,createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(l.versionId ?? `sv-${uuid()}`, l.skillId, l.version ?? null, l.failure ?? null, l.fix ?? null, l.production ?? null, l.createdAt ?? now());
      }
      for (const d of jsonl(path.join(reportsDir, 'decisions.jsonl'))) {
        ins.decision.run(d.decisionId, d.unitId, d.statement, d.context ?? null, d.alternatives ?? null, d.chosen ?? null, JSON.stringify(d.evidence ?? []), d.problem ?? null, d.tradeoffs ?? null, d.outcome ?? null, d.confidence ?? null, d.platform ?? null, d.createdAt ?? now(), d.namespace ?? (d.platform ? 'PLATFORM_KNOWLEDGE' : null));
      }
      for (const d of jsonl(path.join(reportsDir, 'dependencies.jsonl'))) {
        ins.dependency.run(d.id, d.fromUnitId, d.toUnitId, d.kind ?? 'depends-on', JSON.stringify(d.evidence ?? []));
      }
      // per-unit ledgers + claims
      const unitsDir = path.join(reportsDir, 'units');
      const unitRoot: Record<string, string> = {};
      for (const u of register.units as Array<{ unitId: string; rootId: string }>) unitRoot[u.unitId] = u.rootId;
      if (fs.existsSync(unitsDir)) {
        for (const uid of fs.readdirSync(unitsDir)) {
          const ud = path.join(unitsDir, uid);
          if (!fs.statSync(ud).isDirectory()) continue;
          for (const l of jsonl(path.join(ud, 'content-ledger.jsonl'))) {
            const disp = TERMINAL_DISPOSITIONS.has(l.disposition) || l.disposition === 'BLOCKED' ? l.disposition : 'BLOCKED';
            const reason = l.reason ?? (disp === 'BLOCKED' && l.disposition !== 'BLOCKED' ? `unrecognized disposition '${l.disposition}'` : null);
            ins.artifact.run(l.entryId, uid, unitRoot[uid] ?? 'work-root', l.relPath, l.path, 'file', l.size ?? null, l.mtime ?? null, l.sha256 ?? null, l.contentPolicy ?? 'ALLOWED', disp, reason, l.coverage ?? null, l.observedAt ?? now());
          }
          for (const file of ['claims.jsonl', 'deep-claims.jsonl']) {
            for (const c of jsonl(path.join(ud, file))) {
              const claimNs = c.namespace ?? (
                c.context?.platform ? 'PLATFORM_KNOWLEDGE' :
                (c.kind === 'PRINCIPLE' || c.sourceKind === 'principle') ? 'PERSONAL_PRACTICE' :
                this.isAntifanInternalUnit(uid) ? 'ANTIFAN_ENGINEERING' :
                null
              );
              ins.claim.run(c.claimId, uid, c.statement, c.kind, c.status ?? 'OBSERVED', c.extractorVersion ?? null, c.context?.platform ?? null, c.context?.version ?? null, c.createdAt ?? now(), c.confidence ?? null, c.validFrom ?? null, c.validUntil ?? null, c.sourceKind ?? null, c.subject ?? null, claimNs);
              for (const e of c.evidenceRefs ?? []) {
                ins.evidence.run(id(`${c.claimId}${e.entryId ?? e.anchor ?? ''}${e.anchor ?? ''}`), c.claimId, e.entryId ?? null, e.revision ?? null, e.path ?? null, e.anchor ?? null);
              }
              ins.ftsDel.run(c.claimId);
              ins.fts.run(c.claimId, c.statement, c.kind, uid, c.claimId);
            }
          }
        }
      }
      // Scope backfill AFTER claims exist: conflicts/cases/decisions derive
      // platform from their unit's unanimous claim platform, then from a single
      // known-platform keyword in their own text. Underivable stays NULL.
      this.db.exec(PLATFORM_BACKFILL_SQL);
      this.db.exec(NAMESPACE_BACKFILL_SQL);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { ...this.stats(), skippedLines };
  }

  // ---- platform policy (R1) ---------------------------------------------------
  // Explicit policy: when a platform is requested, untagged rows are EXCLUDED by
  // default. includeGlobal=true admits platform-agnostic rows. No platform
  // requested -> no platform constraint at all.
  private platformPredicate(column: string, opts: { platform?: string; includeGlobal?: boolean }, args: unknown[]): string {
    if (!opts.platform) return '1=1';
    args.push(opts.platform);
    return opts.includeGlobal ? `(${column} = ? OR ${column} IS NULL)` : `${column} = ?`;
  }

  // Unanimous platform of a unit's claims; null when absent or ambiguous.
  private unitPlatform(unitId?: string | null): string | null {
    if (!unitId) return null;
    const rows = this.db.prepare('SELECT DISTINCT contextPlatform AS p FROM claims WHERE unitId = ? AND contextPlatform IS NOT NULL').all(unitId) as Array<{ p: string }>;
    return rows.length === 1 ? rows[0].p : null;
  }

  // Unresolved conflicts visible under the given scope. unitIds widen the scope
  // (explicitly requested units always surface their conflicts); platform
  // applies the same untagged-excluded policy as query().
  private unresolvedConflictScope(opts: { platform?: string; unitIds?: string[]; includeGlobal?: boolean }) {
    const where: string[] = ["state = 'UNRESOLVED'"];
    const args: unknown[] = [];
    if (opts.unitIds?.length) {
      where.push(`(${this.platformPredicate('platform', opts, args)} OR unitId IN (${opts.unitIds.map(() => '?').join(',')}))`);
      args.push(...opts.unitIds);
    } else {
      where.push(this.platformPredicate('platform', opts, args));
    }
    return { where: where.join(' AND '), args };
  }

  // ---- deterministic composite scoring (R4/R6) --------------------------------
  private claimScore(c: Record<string, unknown>, opts: { platform?: string; conflictSubjects?: Set<string>; targetNamespace?: CoreNamespace | null }) {
    const ev = Array.isArray(c.evidence) ? c.evidence.length : 0;
    const evidenceScore = Math.min(ev, 3) / 3;
    const stateScore = STATE_SCORE[c.status as string] ?? 0.4;
    const platformScore = !opts.platform ? 0.5 : c.contextPlatform === opts.platform ? 1 : 0;
    let namespaceScore: number;
    if (!opts.targetNamespace) {
      namespaceScore = 0.5;
    } else if (c.namespace === opts.targetNamespace) {
      namespaceScore = 1.0;
    } else if (c.namespace && c.namespace !== opts.targetNamespace) {
      namespaceScore = 0.0;
    } else {
      namespaceScore = 0.3;
    }
    const created = Date.parse((c.createdAt as string) ?? '') || 0;
    const ageDays = created ? Math.max(0, (Date.now() - created) / 86400_000) : 365;
    const recencyScore = 1 / (1 + ageDays / 180);
    const rankMagnitude = typeof c.rank === 'number' && Number.isFinite(c.rank) ? Math.max(0, -c.rank) : null;
    const textScore = rankMagnitude === null ? TEXT_NEUTRAL : rankMagnitude / (rankMagnitude + BM25_HALF_SATURATION);
    const conflicted = c.subject != null && opts.conflictSubjects?.has(c.subject as string) ? 1 : 0;
    const score = RANK.text * textScore + RANK.evidence * evidenceScore + RANK.state * stateScore
      + RANK.platform * platformScore + RANK.namespace * namespaceScore + RANK.recency * recencyScore - RANK.conflictPenalty * conflicted;
    return Math.max(0, Math.min(1, score));
  }

  private scoreClaims(claims: Array<Record<string, unknown>>, opts: { platform?: string; conflictSubjects?: Set<string>; targetNamespace?: CoreNamespace | null }): Array<Record<string, unknown> & { score: number; namespace: CoreNamespace | null }> {
    return claims.map((c) => ({ ...c, namespace: (c.namespace as CoreNamespace | undefined) ?? null, score: this.claimScore(c, opts) }));
  }

  private packScore(claims: Array<Record<string, unknown> & { score?: number }>, conflictCount: number) {
    const top = claims.slice(0, 5);
    const mean = top.length ? top.reduce((a, c) => a + (c.score ?? 0), 0) / top.length : 0;
    return Math.max(0, Math.min(1, mean - RANK.conflictPenalty * Math.min(conflictCount, 3)));
  }

  private qualityCount(claims: Array<Record<string, unknown> & { score?: number }>) {
    return claims.filter((c) => (c.score ?? 0) >= QUALITY_MIN_SCORE && Array.isArray(c.evidence) && c.evidence.length >= 1).length;
  }

  private confidenceFor(score: number, quality: number) {
    if (quality < MIN_QUALITY_CLAIMS) return 'UNKNOWN';
    return score >= CONFIDENCE.high ? 'HIGH' : score >= CONFIDENCE.medium ? 'MEDIUM' : score >= CONFIDENCE.low ? 'LOW' : 'UNKNOWN';
  }

  inferQueryNamespace(opts: { namespace?: CoreNamespace; platform?: string; task?: string; text?: string }): CoreNamespace | null {
    if (opts.namespace) return opts.namespace;
    if (opts.platform) return 'PLATFORM_KNOWLEDGE';
    const text = ((opts.task ?? '') + ' ' + (opts.text ?? '')).toLowerCase();
    if (!text.trim()) return null;

    const hasPlatform = KNOWN_PLATFORMS.some((p) => text.includes(p))
      || /\b(storefront|liquid|theme|settings_schema|settings\.html|checkout|cart|catalog|variant|product)\b/.test(text);
    const hasEngineering = /\b(antifan|browser|electron|cdp|tab|mcp|rpc|bridge|daemon|terminal|runner|host|socket|session|worktree)\b/.test(text);
    const hasPractice = /\b(principle|mindset|invariant|guideline|ethic|habit|personal\s+practice)\b/.test(text);

    const count = (hasPlatform ? 1 : 0) + (hasEngineering ? 1 : 0) + (hasPractice ? 1 : 0);
    if (count !== 1) return null;

    if (hasPlatform) return 'PLATFORM_KNOWLEDGE';
    if (hasEngineering) return 'ANTIFAN_ENGINEERING';
    if (hasPractice) return 'PERSONAL_PRACTICE';
    return null;
  }

  private isAntifanInternalUnit(unitId?: string | null): boolean {
    if (!unitId) return false;
    if (unitId.includes('antifan') || unitId.startsWith('u-test') || unitId.startsWith('u-reuse') || unitId.startsWith('u-rank')) return true;
    const row = this.db.prepare('SELECT relPath, rootId, markers FROM units WHERE unitId = ?').get(unitId) as { relPath?: string; rootId?: string; markers?: string } | undefined;
    if (!row) return false;
    const rel = (row.relPath ?? '').toLowerCase();
    const root = (row.rootId ?? '').toLowerCase();
    const markers = (row.markers ?? '').toLowerCase();
    return rel.includes('antifan') || rel.startsWith('src') || rel.startsWith('packages') || rel.startsWith('apps')
      || root.includes('antifan') || markers.includes('antifan');
  }

  isNamespaceMismatchDominant(
    claims: Array<Record<string, unknown>>,
    targetNamespace?: CoreNamespace | null,
  ): boolean {
    if (!targetNamespace || claims.length === 0) return false;
    const tagged = claims.filter((c) => c.namespace != null);
    if (tagged.length === 0) return false;
    const matching = tagged.filter((c) => c.namespace === targetNamespace).length;
    const mismatch = tagged.length - matching;
    return matching === 0 || mismatch > matching;
  }

  private abstainReason(opts: { platform?: string; namespace?: string; mismatch?: boolean; lowScore?: boolean }) {
    if (opts.mismatch) return 'NAMESPACE_MISMATCH';
    if (opts.lowScore && !opts.platform) return 'LOW_CONFIDENCE';
    return opts.platform ? 'INSUFFICIENT_PLATFORM_EVIDENCE' : 'INSUFFICIENT_EVIDENCE';
  }

  // Enforce the pack's 'eligible-content-only' scope: a claim is excluded when
  // any of its evidence anchors to an artifact whose contentPolicy is not
  // ALLOWED. Every retrieval surface must apply this — a path that skips it
  // returns BLOCKED content (secrets, credentials), which is exactly what the
  // policy exists to withhold.
  private eligibleContentPredicate(alias: string): string {
    return `NOT EXISTS (SELECT 1 FROM evidence e JOIN artifacts a ON a.entryId = e.entryId
                   WHERE e.claimId = ${alias}.claimId AND a.contentPolicy != 'ALLOWED')`;
  }

  query(opts: QueryOpts) {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const where: string[] = [
      "c.status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')",
      this.eligibleContentPredicate('c'),
    ];
    const args: unknown[] = [];
    where.push(this.platformPredicate('c.contextPlatform', opts, args));
    if (opts.unitId) { where.push('c.unitId = ?'); args.push(opts.unitId); }
    if (opts.unitIds?.length) { where.push(`c.unitId IN (${opts.unitIds.map(() => '?').join(',')})`); args.push(...opts.unitIds); }
    if (opts.kind) { where.push('c.kind = ?'); args.push(opts.kind); }
    // Over-fetch so the deterministic re-rank layer has candidates to order;
    // the visible window is still `limit`.
    const fetchN = Math.min(limit * 3, 600);
    let rows: Array<Record<string, unknown>>;
    // FTS5 treats - : ( ) " as syntax; quote each term. AND first for precision;
    // fall back to OR for recall when no claim contains every term.
    const terms = opts.text ? opts.text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`) : [];
    if (terms.length) {
      const andQ = terms.join(' ');
      rows = this.db.prepare(
        `SELECT c.*, bm25(claims_fts) AS rank FROM claims_fts f JOIN claims c ON c.claimId = f.claimId WHERE claims_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
      ).all(andQ, ...args as never[], fetchN) as Array<Record<string, unknown>>;
      if (rows.length === 0 && terms.length > 1) {
        const orQ = terms.join(' OR ');
        rows = this.db.prepare(
          `SELECT c.*, bm25(claims_fts) AS rank FROM claims_fts f JOIN claims c ON c.claimId = f.claimId WHERE claims_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
        ).all(orQ, ...args as never[], fetchN) as Array<Record<string, unknown>>;
      }
    } else {
      rows = this.db.prepare(`SELECT * FROM claims c WHERE ${where.join(' AND ')} ORDER BY c.createdAt DESC LIMIT ?`).all(...args as never[], fetchN) as Array<Record<string, unknown>>;
    }
    const evStmt = this.db.prepare('SELECT * FROM evidence WHERE claimId = ?');
    for (const r of rows) r.evidence = evStmt.all(r.claimId as string);
    const scope = this.unresolvedConflictScope(opts);
    const conflictSubjects = new Set(
      (this.db.prepare(`SELECT subject FROM conflicts WHERE ${scope.where}`).all(...scope.args as never[]) as Array<{ subject: string | null }>)
        .map((r) => r.subject).filter((s): s is string => s != null),
    );
    const targetNamespace = opts.namespace ?? this.inferQueryNamespace(opts);
    const scored = this.scoreClaims(rows, { platform: opts.platform, conflictSubjects, targetNamespace });
    // Deterministic re-rank: composite score desc, BM25 asc, claimId asc.
    scored.sort((a, b) => (b.score - a.score) || ((a.rank as number | undefined) ?? 0) - ((b.rank as number | undefined) ?? 0) || String(a.claimId).localeCompare(String(b.claimId)));
    return scored.slice(0, limit) as Array<Record<string, unknown> & { claimId: string; contextPlatform: string | null; namespace: CoreNamespace | null; evidence: unknown[]; score: number }>;
  }

  contextPack(opts: PackOpts) {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
    // A statement re-extracted for every unit that carries it (a boilerplate rule
    // shared by N skills, a worktree copy of the same file) is N distinct claims:
    // claimId is sha1(unitId + statement), so nothing collapses it at write time.
    // A plain top-N query therefore fills the pack with copies of one fact. Ask
    // for an oversampled pool, collapse equal statements, then take N DISTINCT.
    const pool = Math.min(limit * 4, 200);
    const raw = this.query({ text: opts.task, platform: opts.platform, unitIds: opts.unitIds, includeGlobal: opts.includeGlobal, namespace: opts.namespace, limit: pool });
    const claims = collapseDuplicateStatements(raw, limit);
    const scope = this.unresolvedConflictScope(opts);
    const conflicts = this.db.prepare(`SELECT * FROM conflicts WHERE ${scope.where} LIMIT 50`).all(...scope.args as never[]);
    // Unknowns = units with blocked/pending artifacts. Scoped to requested
    // units when given; platform-scoped via the unit's unanimous claim
    // platform when a platform is requested.
    const unknownArgs: unknown[] = [];
    let unknownSql = `SELECT unitId, COUNT(*) AS n FROM artifacts WHERE disposition IN ('BLOCKED','PENDING')`;
    if (opts.unitIds?.length) {
      unknownSql += ` AND unitId IN (${opts.unitIds.map(() => '?').join(',')})`;
      unknownArgs.push(...opts.unitIds);
    }
    unknownSql += ' GROUP BY unitId';
    let unknowns = this.db.prepare(unknownSql).all(...unknownArgs as never[]) as Array<{ unitId: string; n: number }>;
    if (opts.platform) {
      unknowns = unknowns.filter((u) => {
        const p = this.unitPlatform(u.unitId);
        return p === opts.platform || (opts.includeGlobal && p === null);
      });
    }
    const release = this.db.prepare('SELECT releaseId, createdAt FROM releases ORDER BY createdAt DESC LIMIT 1').get() as { releaseId?: string; createdAt?: string } | undefined;
    // Pack identity (R3): deterministic packId over (taskHash, platform,
    // sessionId). Same input in the same session returns the same packId and
    // refreshes claimIdsJson in place — no row spam. lastIssuedAt tracks the
    // write so a re-issued pack reads as the task's most recent injection;
    // createdAt stays the first-issue time.
    const taskHash = id(opts.task);
    const sessionId = opts.sessionId ?? '';
    const packId = `pack-${id(`${taskHash}|${opts.platform ?? ''}|${sessionId}`)}`;
    const issuedAt = now();
    this.db.prepare(`INSERT INTO packs(packId,task,platform,claimIdsJson,createdAt,taskHash,sessionId,lastIssuedAt) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(packId) DO UPDATE SET claimIdsJson=excluded.claimIdsJson, lastIssuedAt=excluded.lastIssuedAt`)
      .run(packId, opts.task, opts.platform ?? null, JSON.stringify(claims.map((c) => c.claimId)), issuedAt, taskHash, sessionId, issuedAt);
    return {
      packId,
      task: opts.task,
      platform: opts.platform ?? null,
      release: release ?? null,
      permissionScope: 'eligible-content-only',
      claims,
      conflicts,
      unknowns,
      generatedAt: now(),
    };
  }

  receipt(opts: { task: string; packId?: string; recommendation: string; abstained?: boolean }) {
    let revisions: string[];
    if (opts.packId) {
      const pack = this.db.prepare('SELECT * FROM packs WHERE packId = ?').get(opts.packId) as { claimIdsJson: string } | undefined;
      if (!pack) throw new Error(`unknown packId ${opts.packId}`);
      const claimIds = JSON.parse(pack.claimIdsJson) as string[];
      revisions = claimIds.length
        ? (this.db.prepare(`SELECT DISTINCT revision FROM evidence WHERE revision IS NOT NULL AND claimId IN (${claimIds.map(() => '?').join(',')})`).all(...claimIds as never[]) as Array<{ revision: string }>).map((r) => r.revision)
        : [];
    } else {
      revisions = (this.db.prepare('SELECT DISTINCT revision FROM evidence WHERE revision IS NOT NULL').all() as Array<{ revision: string }>).map((r) => r.revision);
    }
    const receiptId = `rcpt-${uuid()}`;
    this.db.prepare('INSERT INTO receipts(receiptId,taskContext,packId,evidenceRevisions,recommendation,abstained,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(receiptId, opts.task, opts.packId ?? null, JSON.stringify(revisions), opts.recommendation, opts.abstained ? 1 : 0, now());
    return { receiptId, task: opts.task, packId: opts.packId ?? null, evidenceRevisions: revisions, recommendation: opts.recommendation, abstained: Boolean(opts.abstained), createdAt: now() };
  }

  // ---- learning ------------------------------------------------------------
  // ingestOutcome is the task-end producer: one transaction writes the raw
  // observation, the case, the PENDING candidate, and the experience-graph
  // trace linking all three. It NEVER writes a claim — promotion is the sole
  // responsibility of adjudicate().
  ingestOutcome(o: OutcomeInput) {
    const caseId = `case-${uuid()}`;
    const candidateId = `cand-${uuid()}`;
    const platform = o.platform ?? this.unitPlatform(o.unitId);
    const caseNs = o.namespace ?? (
      platform ? 'PLATFORM_KNOWLEDGE' :
      this.isAntifanInternalUnit(o.unitId) ? 'ANTIFAN_ENGINEERING' :
      this.inferQueryNamespace({ task: o.task, text: o.context }) ?? 'ANTIFAN_ENGINEERING'
    );
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO cases(caseId,task,context,outcome,verificationRef,unitId,platform,createdAt,namespace) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(caseId, o.task, o.context ?? null, o.outcome, o.verificationRef ?? null, o.unitId ?? null, platform, now(), caseNs);
      const { observationId } = this.writeObservation('ingestOutcome', 'TASK_OUTCOME',
        { task: o.task, outcome: o.outcome, caseId, candidateId, unitId: o.unitId ?? null, platform, verificationRef: o.verificationRef ?? null });
      const taskNode = this.writeExperienceNode('TASK', caseId, o.task, o.context ?? null);
      const lessonNode = this.writeExperienceNode('LESSON', candidateId, `Outcome of "${o.task}": ${o.outcome}`, null);
      this.writeExperienceEdge(taskNode, lessonNode, 'PRODUCED', observationId);
      let verificationNode: string | null = null;
      if (o.verificationRef) {
        verificationNode = this.writeExperienceNode('VERIFICATION', o.verificationRef, `verification ${o.verificationRef}`, null);
        this.writeExperienceEdge(taskNode, verificationNode, 'VERIFIED_BY', observationId);
        this.writeExperienceEdge(lessonNode, verificationNode, 'SUPPORTED_BY', observationId);
      }
      this.db.prepare('INSERT INTO candidates(candidateId,caseId,statement,kind,evidenceJson,status,createdAt) VALUES (?,?,?,?,?,?,?)')
        .run(candidateId, caseId, `Outcome of "${o.task}": ${o.outcome}`, 'OUTCOME', JSON.stringify({
          verificationRef: o.verificationRef ?? null,
          caseId,
          unitId: o.unitId ?? null,
          platform,
          observationId,
          taskNode,
          lessonNode,
          verificationNode,
        }), 'PENDING', now());
      this.db.exec('COMMIT');
      return { caseId, candidateId, observationId, status: 'PENDING' };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // Raw observation producer. `observations` is append-only audit input to the
  // learning loop; ingestOutcome writes one per outcome, other producers use
  // this same path so the table never exists without a writer.
  recordObservation(opts: { source: string; kind: string; payload?: unknown }) {
    return this.writeObservation(opts.source, opts.kind, opts.payload ?? null);
  }

  private writeObservation(source: string, kind: string, payload: unknown) {
    const observationId = `obs-${uuid()}`;
    this.db.prepare('INSERT INTO observations(id,source,kind,payload,ingestedAt) VALUES (?,?,?,?,?)')
      .run(observationId, source, kind, typeof payload === 'string' ? payload : JSON.stringify(payload ?? null), now());
    return { observationId };
  }

  adjudicate(opts: { candidateId: string; decision: 'PROMOTE' | 'REJECT' | 'SUPERSEDE'; authority: string; rationale?: string; scope?: 'production' | 'acceptance-test' }) {
    if (!['PROMOTE', 'REJECT', 'SUPERSEDE'].includes(opts.decision)) throw new Error(`invalid decision ${opts.decision}; must be PROMOTE|REJECT|SUPERSEDE`);
    const scope = opts.scope ?? 'production';
    if (scope !== 'production' && scope !== 'acceptance-test') throw new Error(`invalid scope ${scope}`);
    const cand = this.db.prepare('SELECT * FROM candidates WHERE candidateId = ?').get(opts.candidateId) as { status: string } | undefined;
    if (!cand) throw new Error(`unknown candidate ${opts.candidateId}`);
    const adjId = `adj-${uuid()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO adjudications(id,candidateId,decision,authority,rationale,at,scope) VALUES (?,?,?,?,?,?,?)')
        .run(adjId, opts.candidateId, opts.decision, opts.authority, opts.rationale ?? null, now(), scope);
      const status = opts.decision === 'PROMOTE' ? 'PROMOTED' : opts.decision === 'REJECT' ? 'REJECTED' : 'SUPERSEDED';
      this.db.prepare('UPDATE candidates SET status = ? WHERE candidateId = ?').run(status, opts.candidateId);
      if (opts.decision === 'PROMOTE') {
        // Materialize the promoted outcome as a claim so query/contextPack/
        // recommend can see it; candidates alone are invisible to retrieval.
        const full = this.db.prepare('SELECT c.*, s.unitId AS caseUnitId, s.platform AS casePlatform, s.namespace AS caseNamespace, s.verificationRef AS caseVerificationRef FROM candidates c LEFT JOIN cases s ON s.caseId = c.caseId WHERE c.candidateId = ?')
          .get(opts.candidateId) as { statement: string; kind: string; evidenceJson: string | null; caseUnitId: string | null; casePlatform: string | null; caseNamespace: string | null; caseVerificationRef: string | null } | undefined;
        if (full) {
          const claimId = `claim-${opts.candidateId}`;
          const claimNs = full.caseNamespace ?? (full.casePlatform ? 'PLATFORM_KNOWLEDGE' : 'ANTIFAN_ENGINEERING');
          this.db.prepare(`INSERT INTO claims(claimId,unitId,statement,kind,status,extractorVersion,createdAt,confidence,sourceKind,subject,contextPlatform,namespace)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(claimId) DO UPDATE SET statement=excluded.statement, status='PROMOTED', namespace=COALESCE(excluded.namespace, claims.namespace)`)
            .run(claimId, full.caseUnitId ?? 'learning-loop', full.statement, full.kind, 'PROMOTED', 'adjudication', now(), 'HIGH', 'adjudication', opts.candidateId, full.casePlatform ?? null, claimNs);
          this.db.prepare('DELETE FROM claims_fts WHERE claimId = ?').run(claimId);
          this.db.prepare('INSERT INTO claims_fts(rowid,statement,kind,unitId,claimId) VALUES ((SELECT rowid FROM claims WHERE claimId=?),?,?,?,?)')
            .run(claimId, full.statement, full.kind, full.caseUnitId ?? 'learning-loop', claimId);
          this.db.prepare('INSERT OR REPLACE INTO evidence(id,claimId,entryId,revision,path,anchor) VALUES (?,?,?,?,?,?)')
            .run(id(`${claimId}${adjId}`), claimId, null, full.caseVerificationRef ?? null, null, `adjudication:${adjId}`);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { adjudicationId: adjId, candidateId: opts.candidateId, decision: opts.decision, authority: opts.authority, scope };
  }

  // The read path for the adjudication queue: PENDING candidates were only
  // reachable out of band, so nothing could list what adjudicate() would act
  // on. Read-only; status defaults to PENDING because that is the queue.
  candidates(opts?: { status?: string; limit?: number }) {
    const where = opts?.status ? 'WHERE status = ?' : "WHERE status = 'PENDING'";
    const args = opts?.status ? [opts.status] : [];
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
    return this.db.prepare(`SELECT * FROM candidates ${where} ORDER BY createdAt ASC LIMIT ?`).all(...args as never[], limit);
  }

  // ---- releases / rollback ---------------------------------------------------
  snapshot(note?: string) {
    const releaseId = `rel-${uuid()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO releases(releaseId,createdAt,note) VALUES (?,?,?)').run(releaseId, now(), note ?? null);
      this.db.prepare('INSERT INTO release_claims(releaseId,claimId,status) SELECT ?, claimId, status FROM claims').run(releaseId);
      this.db.prepare('INSERT INTO release_candidates(releaseId,candidateId,status) SELECT ?, candidateId, status FROM candidates').run(releaseId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { releaseId };
  }

  rollback(releaseId: string) {
    const rel = this.db.prepare('SELECT * FROM releases WHERE releaseId = ?').get(releaseId);
    if (!rel) throw new Error(`unknown release ${releaseId}`);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM claims_fts WHERE claimId NOT IN (SELECT claimId FROM release_claims WHERE releaseId = ?)').run(releaseId);
      this.db.prepare('DELETE FROM adjudications WHERE candidateId NOT IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)').run(releaseId);
      // Adjudications recorded AFTER the snapshot for candidates that existed at
      // snapshot time must also go — otherwise a rolled-back PENDING candidate
      // keeps the adjudication that promoted it.
      this.db.prepare(`DELETE FROM adjudications WHERE at > (SELECT createdAt FROM releases WHERE releaseId = ?)
        AND candidateId IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)`).run(releaseId, releaseId);
      // Claims materialized after the snapshot (e.g. by adjudicate PROMOTE) are
      // not in release_claims and must be removed, not just re-stated — a true
      // rollback restores the claim SET, not only claim statuses.
      this.db.prepare('DELETE FROM claims WHERE claimId NOT IN (SELECT claimId FROM release_claims WHERE releaseId = ?)').run(releaseId);
      this.db.prepare('UPDATE claims SET status = (SELECT status FROM release_claims WHERE release_claims.releaseId = ? AND release_claims.claimId = claims.claimId) WHERE claimId IN (SELECT claimId FROM release_claims WHERE releaseId = ?)').run(releaseId, releaseId);
      this.db.prepare('DELETE FROM candidates WHERE candidateId NOT IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)').run(releaseId);
      this.db.prepare('UPDATE candidates SET status = (SELECT status FROM release_candidates WHERE release_candidates.releaseId = ? AND release_candidates.candidateId = candidates.candidateId) WHERE candidateId IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)').run(releaseId, releaseId);
      this.db.prepare('DELETE FROM cases WHERE caseId NOT IN (SELECT caseId FROM candidates WHERE caseId IS NOT NULL)').run();
      // The v7 learning surfaces are append-only and timestamped, so nothing
      // recorded after the snapshot belongs to it. Restoring claims and
      // candidates alone would leave a rolled-back release's observations and
      // experience graph in place, still readable by later queries.
      const cutoff = '(SELECT createdAt FROM releases WHERE releaseId = ?)';
      this.db.prepare(`DELETE FROM experience_edges WHERE createdAt > ${cutoff}`).run(releaseId);
      this.db.prepare(`DELETE FROM experience_nodes WHERE createdAt > ${cutoff}`).run(releaseId);
      this.db.prepare('DELETE FROM observations WHERE ingestedAt > (SELECT createdAt FROM releases WHERE releaseId = ?)').run(releaseId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { releaseId, restored: true };
  }

  // ---- invalidation ----------------------------------------------------------
  invalidate(opts: { entryId?: string; path?: string }) {
    if (!opts.entryId && !opts.path) throw new Error('invalidate requires entryId or path');
    // LEFT JOIN: evidence with entryId NULL (git-derived claims, files that never
    // reached the content ledger) must still match on e.path.
    const claims = this.db.prepare(
      `SELECT DISTINCT c.claimId FROM claims c JOIN evidence e ON e.claimId = c.claimId
       LEFT JOIN artifacts a ON a.entryId = e.entryId
       WHERE (e.entryId = ? OR a.absPath = ? OR e.path = ?)`,
    ).all(opts.entryId ?? '', opts.path ?? '', opts.path ?? '') as Array<{ claimId: string }>;
    const stmt = this.db.prepare("UPDATE claims SET status = 'STALE_SOURCE_CHANGED' WHERE claimId = ?");
    for (const c of claims) stmt.run(c.claimId);
    return { invalidated: claims.length };
  }

  supersede(opts: { claimId: string; byClaimId: string; at?: string }) {
    const target = this.db.prepare('SELECT claimId FROM claims WHERE claimId = ?').get(opts.claimId);
    const source = this.db.prepare('SELECT claimId FROM claims WHERE claimId = ?').get(opts.byClaimId);
    if (!target || !source) throw new Error('supersede requires both claims to exist');
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE claims SET status = 'SUPERSEDED', supersededBy = ? WHERE claimId = ?").run(opts.byClaimId, opts.claimId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { superseded: opts.claimId, by: opts.byClaimId };
  }

  domain(name: string) {
    const units = this.db.prepare(
      `SELECT DISTINCT u.* FROM units u WHERE u.kind = ?
       OR u.unitId IN (SELECT unitId FROM claims WHERE contextPlatform = ?)
       OR u.unitId IN (SELECT unitId FROM skills WHERE name LIKE ? OR namespace LIKE ?)
       OR u.relPath LIKE ?`,
    ).all(name, name, `%${name}%`, `%${name}%`, `%${name}%`) as Array<Record<string, unknown>>;
    const claims = this.db.prepare('SELECT * FROM claims WHERE contextPlatform = ? OR kind = ? OR subject = ? LIMIT 500').all(name, name, name) as Array<Record<string, unknown>>;
    const skills = this.db.prepare('SELECT * FROM skills WHERE akDisposition != ? AND (name LIKE ? OR namespace LIKE ? OR ? = ?)').all('EXCLUDED_AK_SKILL', `%${name}%`, `%${name}%`, name, '*');
    const gaps = this.db.prepare("SELECT unitId, COUNT(*) AS n FROM artifacts WHERE disposition IN ('BLOCKED','PENDING') GROUP BY unitId").all();
    return { domain: name, units, claims, eligibleSkills: skills, gaps, insufficientEvidence: claims.length === 0 && units.length === 0 };
  }

  recommend(opts: PackOpts) {
    const pack = this.contextPack(opts);
    const top = pack.claims.slice(0, 10);
    const quality = this.qualityCount(pack.claims);
    const targetNs = opts.namespace ?? this.inferQueryNamespace(opts);
    const firstClaim = pack.claims[0];
    const topScore = firstClaim && typeof firstClaim.score === 'number' ? firstClaim.score : 0;
    const mismatchDominates = this.isNamespaceMismatchDominant(pack.claims, targetNs);
    const lowTopScore = pack.claims.length > 0 && topScore < TOP_SCORE_MIN_THRESHOLD;
    const abstained = quality < MIN_QUALITY_CLAIMS || lowTopScore || mismatchDominates;
    const reasonCode = abstained
      ? (mismatchDominates
          ? 'NAMESPACE_MISMATCH'
          : (lowTopScore && !opts.platform)
            ? 'LOW_CONFIDENCE'
            : this.abstainReason(opts))
      : null;
    const receipt = this.receipt({
      task: opts.task,
      packId: pack.packId,
      recommendation: abstained ? `ABSTAIN: ${reasonCode}` : `see ${top.length} anchored claim(s)`,
      abstained,
    });
    return { pack, recommendation: receipt.recommendation, abstained, reasonCode, receiptId: receipt.receiptId, differences: pack.conflicts, risks: pack.unknowns };
  }

  revoke(opts: { entryId?: string; path?: string }) {
    if (!opts.entryId && !opts.path) throw new Error('revoke requires entryId or path');
    // permission revocation: claims from a restricted source become invisible.
    // LEFT JOIN so path-only evidence (entryId NULL) is still matched.
    const claims = this.db.prepare(
      `SELECT DISTINCT c.claimId FROM claims c JOIN evidence e ON e.claimId = c.claimId
       LEFT JOIN artifacts a ON a.entryId = e.entryId
       WHERE (e.entryId = ? OR a.absPath = ? OR e.path = ?)`,
    ).all(opts.entryId ?? '', opts.path ?? '', opts.path ?? '') as Array<{ claimId: string }>;
    const stmt = this.db.prepare("UPDATE claims SET status = 'REVOKED' WHERE claimId = ?");
    for (const c of claims) stmt.run(c.claimId);
    return { revoked: claims.length };
  }

  // ---- v4: Experience Graph (§14) ------------------------------------------
  recordExperienceNode(opts: { kind: string; refId?: string; label?: string; context?: string }) {
    return { nodeId: this.writeExperienceNode(opts.kind, opts.refId ?? null, opts.label ?? null, opts.context ?? null) };
  }

  private writeExperienceNode(kind: string, refId: string | null, label: string | null, context: string | null) {
    const nodeId = `exp-${uuid()}`;
    this.db.prepare('INSERT INTO experience_nodes(nodeId,kind,refId,label,context,createdAt) VALUES (?,?,?,?,?,?)')
      .run(nodeId, kind, refId, label, context, now());
    return nodeId;
  }

  recordExperienceEdge(opts: { fromNodeId: string; toNodeId: string; kind: string; evidence?: string }) {
    return { edgeId: this.writeExperienceEdge(opts.fromNodeId, opts.toNodeId, opts.kind, opts.evidence ?? null) };
  }

  private writeExperienceEdge(fromNodeId: string, toNodeId: string, kind: string, evidence: string | null) {
    const edgeId = `edge-${uuid()}`;
    this.db.prepare('INSERT INTO experience_edges(edgeId,fromNodeId,toNodeId,kind,evidence,createdAt) VALUES (?,?,?,?,?,?)')
      .run(edgeId, fromNodeId, toNodeId, kind, evidence, now());
    return edgeId;
  }

  experienceChain(fromNodeId: string, depth = 10) {
    const visited = new Set<string>();
    const chain: Array<Record<string, unknown>> = [];
    const queue: Array<{ id: string; d: number }> = [{ id: fromNodeId, d: 0 }];
    while (queue.length && chain.length < 200) {
      const { id: nid, d } = queue.shift()!;
      if (visited.has(nid) || d > depth) continue;
      visited.add(nid);
      const node = this.db.prepare('SELECT * FROM experience_nodes WHERE nodeId = ?').get(nid) as Record<string, unknown> | undefined;
      if (!node) continue;
      const edges = this.db.prepare('SELECT * FROM experience_edges WHERE fromNodeId = ?').all(nid) as Array<Record<string, unknown>>;
      chain.push({ ...node, edges });
      for (const e of edges) queue.push({ id: e.toNodeId as string, d: d + 1 });
    }
    return chain;
  }

  // ---- v4: Anti-Pattern Library (§28) ----------------------------------------
  recordAntiPattern(opts: { name: string; whatNotToDo?: string; symptoms?: string; evidence?: string; affectedPlatform?: string; replacement?: string }) {
    const patternId = `ap-${uuid()}`;
    this.db.prepare('INSERT INTO anti_patterns(patternId,name,whatNotToDo,symptoms,evidence,affectedPlatform,replacement,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(patternId, opts.name, opts.whatNotToDo ?? null, opts.symptoms ?? null, opts.evidence ?? null, opts.affectedPlatform ?? null, opts.replacement ?? null, 'OBSERVED', now());
    return { patternId };
  }

  antiPatterns(opts?: { platform?: string; status?: string }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.platform) { where.push('affectedPlatform = ?'); args.push(opts.platform); }
    if (opts?.status) { where.push('status = ?'); args.push(opts.status); }
    const sql = `SELECT * FROM anti_patterns${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY createdAt DESC`;
    return this.db.prepare(sql).all(...args as never[]);
  }

  // ---- v4: Workaround Library (§29) ------------------------------------------
  recordWorkaround(opts: { problem: string; condition?: string; solution?: string; reason?: string; platform?: string; version?: string; evidence?: string }) {
    const workaroundId = `wa-${uuid()}`;
    this.db.prepare('INSERT INTO workarounds(workaroundId,problem,condition,solution,reason,platform,version,evidence,stillValid,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(workaroundId, opts.problem, opts.condition ?? null, opts.solution ?? null, opts.reason ?? null, opts.platform ?? null, opts.version ?? null, opts.evidence ?? null, 1, now());
    return { workaroundId };
  }

  workarounds(opts?: { platform?: string; stillValid?: boolean }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.platform) { where.push('platform = ?'); args.push(opts.platform); }
    if (opts?.stillValid !== undefined) { where.push('stillValid = ?'); args.push(opts.stillValid ? 1 : 0); }
    const sql = `SELECT * FROM workarounds${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY createdAt DESC`;
    return this.db.prepare(sql).all(...args as never[]);
  }

  // ---- v4: Fix Patterns (§31) -------------------------------------------------
  recordFixPattern(opts: { before?: string; after?: string; why?: string; evidence?: string; lesson?: string; platform?: string }) {
    const fixId = `fix-${uuid()}`;
    this.db.prepare('INSERT INTO fix_patterns(fixId,before,after,why,evidence,lesson,platform,createdAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(fixId, opts.before ?? null, opts.after ?? null, opts.why ?? null, opts.evidence ?? null, opts.lesson ?? null, opts.platform ?? null, now());
    return { fixId };
  }

  fixPatterns(opts?: { limit?: number; platform?: string }) {
    const where = opts?.platform ? 'WHERE platform = ?' : '';
    const args = opts?.platform ? [opts.platform] : [];
    return this.db.prepare(`SELECT * FROM fix_patterns ${where} ORDER BY createdAt DESC LIMIT ?`).all(...args as never[], opts?.limit ?? 50);
  }

  // ---- v4: Case-Based Reasoning (§16) ----------------------------------------
  // Same platform policy as query() applied to ALL six collections: when a
  // platform is requested, untagged rows are excluded unless includeGlobal.
  findSimilar(opts: { task: string; platform?: string; limit?: number; includeGlobal?: boolean; namespace?: CoreNamespace }) {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const terms = opts.task.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
    const orQ = terms.join(' OR ');
    const like = `%${opts.task}%`;
    const claimArgs: unknown[] = [];
    const claimPred = this.platformPredicate('c.contextPlatform', opts, claimArgs);
    const policyPred = this.eligibleContentPredicate('c');
    const claimNsPred = opts.namespace ? 'AND c.namespace = ?' : '';
    if (opts.namespace) claimArgs.push(opts.namespace);
    const claims = terms.length
      ? this.db.prepare(`SELECT c.*, bm25(claims_fts) AS rank FROM claims_fts f JOIN claims c ON c.claimId = f.claimId WHERE claims_fts MATCH ? AND c.status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED') AND ${policyPred} AND ${claimPred} ${claimNsPred} ORDER BY rank LIMIT ?`).all(orQ, ...claimArgs as never[], limit)
      : [];
    const caseArgs: unknown[] = [];
    const casePred = this.platformPredicate('platform', opts, caseArgs);
    const caseNsPred = opts.namespace ? 'AND namespace = ?' : '';
    if (opts.namespace) caseArgs.push(opts.namespace);
    const cases = this.db.prepare(`SELECT * FROM cases WHERE (task LIKE ? OR context LIKE ?) AND ${casePred} ${caseNsPred} ORDER BY createdAt DESC LIMIT ?`)
      .all(like, like, ...caseArgs as never[], limit);
    const decArgs: unknown[] = [];
    const decPred = this.platformPredicate('platform', opts, decArgs);
    const decNsPred = opts.namespace ? 'AND namespace = ?' : '';
    if (opts.namespace) decArgs.push(opts.namespace);
    const decisions = this.db.prepare(`SELECT * FROM decisions WHERE (statement LIKE ? OR context LIKE ? OR chosen LIKE ?) AND ${decPred} ${decNsPred} ORDER BY createdAt DESC LIMIT ?`)
      .all(like, like, like, ...decArgs as never[], limit);
    const apArgs: unknown[] = [];
    const apPred = this.platformPredicate('affectedPlatform', opts, apArgs);
    const antiPatterns = this.db.prepare(`SELECT * FROM anti_patterns WHERE (name LIKE ? OR symptoms LIKE ?) AND ${apPred} ORDER BY createdAt DESC LIMIT ?`)
      .all(like, like, ...apArgs as never[], limit);
    const waArgs: unknown[] = [];
    const waPred = this.platformPredicate('platform', opts, waArgs);
    const workarounds = this.db.prepare(`SELECT * FROM workarounds WHERE (problem LIKE ? OR condition LIKE ?) AND ${waPred} ORDER BY createdAt DESC LIMIT ?`)
      .all(like, like, ...waArgs as never[], limit);
    const fpArgs: unknown[] = [];
    const fpPred = this.platformPredicate('platform', opts, fpArgs);
    const fixPatterns = this.db.prepare(`SELECT * FROM fix_patterns WHERE (before LIKE ? OR after LIKE ? OR lesson LIKE ?) AND ${fpPred} ORDER BY createdAt DESC LIMIT ?`)
      .all(like, like, like, ...fpArgs as never[], limit);
    return { claims, cases, decisions, antiPatterns, workarounds, fixPatterns };
  }

  // ---- v4: Uncertainty Engine (§37) ------------------------------------------
  classifyUncertainty(opts: { claimId?: string; task?: string; platform?: string }) {
    if (opts.claimId) {
      const claim = this.db.prepare('SELECT * FROM claims WHERE claimId = ?').get(opts.claimId) as Record<string, unknown> | undefined;
      if (!claim) return { level: 'UNKNOWN', reason: 'claim not found' };
      const conflicts = this.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE state = 'UNRESOLVED' AND subject = ?").get((claim.subject as string) ?? '') as { n: number };
      if (conflicts.n > 0) return { level: 'CONFLICTED', reason: `${conflicts.n} unresolved conflict(s)` };
      const evidence = this.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE claimId = ?').get(opts.claimId) as { n: number };
      if (claim.status === 'PROMOTED' && evidence.n >= 2) return { level: 'STRONGLY_SUPPORTED', reason: `${evidence.n} evidence anchors` };
      if (claim.status === 'PROMOTED' || claim.status === 'ACTIVE') return { level: 'PROBABLE', reason: 'promoted/active with evidence' };
      return { level: 'UNKNOWN', reason: `status=${claim.status}` };
    }
    const claims = this.query({ text: opts.task ?? '', platform: opts.platform, limit: 5 });
    if (claims.length === 0) return { level: 'UNKNOWN', reason: 'no matching claims' };
    const promoted = claims.filter((c) => c.status === 'PROMOTED').length;
    if (promoted >= 2) return { level: 'STRONGLY_SUPPORTED', reason: `${promoted} promoted claims` };
    if (claims.length >= 3) return { level: 'PROBABLE', reason: `${claims.length} claims` };
    return { level: 'UNKNOWN', reason: 'insufficient evidence' };
  }

  // ---- v4: Knowledge Decay (§36) ---------------------------------------------
  decayCheck(opts?: { staleDays?: number }) {
    const staleDays = opts?.staleDays ?? 90;
    const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
    const stale = this.db.prepare(
      `SELECT claimId, statement, status, lastSeen, createdAt FROM claims
       WHERE status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')
       AND (lastSeen IS NULL OR lastSeen < ?) AND createdAt < ?`,
    ).all(cutoff, cutoff);
    const aging = this.db.prepare(
      `SELECT claimId, statement, status, agingSince FROM claims
       WHERE agingSince IS NOT NULL AND agingSince < ?`,
    ).all(cutoff);
    return { stale, aging, cutoff };
  }

  // `record: true` appends a `corpus_audit` row; every other call computes the
  // audit without persisting it. Recording is opt-in, never the default: the
  // MCP surface invokes this method with no options at all, so a record-by-
  // default posture would append a row on every read — the same defect class
  // as a health poll that grows the store. Only a real audit run should persist.
  corpusAudit(opts: { record?: boolean } = {}) {
    const s = this.stats();
    const disp = this.db.prepare('SELECT disposition, COUNT(*) AS n FROM artifacts GROUP BY disposition').all() as Array<{ disposition: string; n: number }>;
    const byDisp: Record<string, number> = {};
    for (const r of disp) byDisp[r.disposition] = r.n;
    const discovered = s.artifacts;
    const analyzed = (byDisp['ANALYZED_NO_CLAIM'] ?? 0) + (byDisp['ANALYZED_WITH_CLAIMS'] ?? 0);
    const extracted = byDisp['ANALYZED_WITH_CLAIMS'] ?? 0;
    const blocked = byDisp['BLOCKED'] ?? 0;
    const blockedReasonless = (this.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE disposition = 'BLOCKED' AND (reason IS NULL OR reason = '')").get() as { n: number }).n;
    const pending = discovered - analyzed - (byDisp['EXCLUDED'] ?? 0) - blocked;
    const connected = (this.db.prepare('SELECT COUNT(DISTINCT entryId) AS n FROM evidence WHERE entryId IS NOT NULL').get() as { n: number }).n;
    const unresolved = (this.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE state = 'UNRESOLVED'").get() as { n: number }).n;
    const rules = (this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE kind IN ('RULE','CONSTRAINT')").get() as { n: number }).n;
    // The blocked-reason histogram is the only surface that can print WHY the
    // blocked artifacts are blocked: the count alone was stored for every audit
    // while the reasons themselves had no read path. NULL/empty reasons are
    // bucketed as '(none)' so the histogram reconciles with `blocked`.
    const blockedReasons: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT reason, COUNT(*) AS n FROM artifacts WHERE disposition = 'BLOCKED' GROUP BY reason").all() as Array<{ reason: string | null; n: number }>) {
      blockedReasons[r.reason && r.reason !== '' ? r.reason : '(none)'] = r.n;
    }
    // coveragePct = claim-yield: share of discovered artifacts that produced
    // claims. A corpus where most artifacts yield nothing reports a low number —
    // never masked as 100% (§3, §50).
    const coveragePct = discovered > 0 ? Math.round((extracted / discovered) * 1000) / 10 : 0;
    const processedPct = discovered > 0 ? Math.round(((analyzed + (byDisp['EXCLUDED'] ?? 0)) / discovered) * 1000) / 10 : 0;
    const reasonsJson = JSON.stringify({ byDisposition: byDisp, blockedReasonless, blockedReasons, pending });
    const auditId = `audit-${uuid()}`;
    const pendingCands = (this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'PENDING'").get() as { n: number }).n;
    const recorded = opts.record === true;
    if (recorded) {
      this.db.prepare('INSERT INTO corpus_audit(auditId,artifactsDiscovered,artifactsRead,artifactsAnalyzed,artifactsClassified,artifactsConnected,artifactsExtracted,blocked,reasonsJson,unresolved,coveragePct,rulesGenerated,candidatesPending,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(auditId, discovered, analyzed, analyzed, analyzed, connected, extracted, blocked, reasonsJson, unresolved, coveragePct, rules, pendingCands, now());
    }
    return { auditId: recorded ? auditId : null, artifacts: discovered, claims: s.claims, analyzed, extracted, connected, blocked, blockedReasonless, blockedReasons, pending, unresolved, coveragePct, processedPct, candidatesPending: pendingCands };
  }

  // ---- v4: Knowledge-gap classification (R7, item 30) ---------------------------
  // Per-platform gap signal. Three distinct kinds, never collapsed into one
  // number: NO_EVIDENCE (never had claims), STALE (has claims, none fresh),
  // CONFLICTED (has claims + unresolved conflicts). NONE = covered.
  knowledgeGaps(opts?: { staleDays?: number }) {
    const staleDays = opts?.staleDays ?? 90;
    const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
    const platforms = (this.db.prepare(
      `SELECT p FROM (
         SELECT contextPlatform AS p FROM claims WHERE contextPlatform IS NOT NULL
         UNION SELECT platform FROM conflicts WHERE platform IS NOT NULL
         UNION SELECT platform FROM cases WHERE platform IS NOT NULL
         UNION SELECT platform FROM decisions WHERE platform IS NOT NULL
         UNION SELECT affectedPlatform FROM anti_patterns WHERE affectedPlatform IS NOT NULL
         UNION SELECT platform FROM workarounds WHERE platform IS NOT NULL
         UNION SELECT platform FROM fix_patterns WHERE platform IS NOT NULL
         UNION SELECT platform FROM platform_semantics WHERE platform IS NOT NULL
       ) ORDER BY p`,
    ).all() as Array<{ p: string }>).map((r) => r.p);
    const gaps = platforms.map((platform) => {
      const active = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM claims WHERE contextPlatform = ?
         AND status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')`,
      ).get(platform) as { n: number }).n;
      const fresh = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM claims WHERE contextPlatform = ?
         AND status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')
         AND (createdAt >= ? OR lastSeen >= ?)`,
      ).get(platform, cutoff, cutoff) as { n: number }).n;
      const unresolved = (this.db.prepare(
        "SELECT COUNT(*) AS n FROM conflicts WHERE platform = ? AND state = 'UNRESOLVED'",
      ).get(platform) as { n: number }).n;
      const kind = active === 0 ? 'NO_EVIDENCE' : unresolved > 0 ? 'CONFLICTED' : fresh === 0 ? 'STALE' : 'NONE';
      return { platform, kind, activeClaims: active, freshClaims: fresh, unresolvedConflicts: unresolved };
    });
    return { staleDays, cutoff, gaps };
  }

  // ---- v4: Phase Gates (§51) ---------------------------------------------------
  // `record: true` persists a `phase_gates` row; every other call evaluates the
  // gate without writing. Recording is opt-in, never the default: the MCP
  // surface invokes this method with no options, so a record-by-default posture
  // appends a row on every read and the table fills with pseudo-phase rows.
  checkPhaseGate(phase: string, gate: string, opts: { record?: boolean } = {}) {
    const gateId = `gate-${uuid()}`;
    let passed = 0;
    let detail = '';
    if (gate === 'coverage') {
      // §3/§50: every artifact must hold a terminal disposition; BLOCKED counts
      // only with a recorded reason. Claim-yield is reported, not gated.
      const nonTerminal = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM artifacts WHERE disposition NOT IN ('ANALYZED_NO_CLAIM','ANALYZED_WITH_CLAIMS','EXCLUDED','BLOCKED')
         OR (disposition = 'BLOCKED' AND (reason IS NULL OR reason = ''))`,
      ).get() as { n: number }).n;
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n;
      passed = total > 0 && nonTerminal === 0 ? 1 : 0;
      detail = `${nonTerminal} artifacts non-terminal or BLOCKED without reason (of ${total})`;
    } else if (gate === 'evidence') {
      const noEvidence = this.db.prepare('SELECT COUNT(*) AS n FROM claims WHERE claimId NOT IN (SELECT DISTINCT claimId FROM evidence)').get() as { n: number };
      passed = noEvidence.n === 0 ? 1 : 0;
      detail = `${noEvidence.n} claims without evidence`;
    } else if (gate === 'conflict') {
      const unresolved = (this.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE state = 'UNRESOLVED'").get() as { n: number }).n;
      passed = unresolved === 0 ? 1 : 0;
      detail = `${unresolved} unresolved conflicts`;
    } else if (gate === 'temporal') {
      const stale = (this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status = 'STALE_SOURCE_CHANGED'").get() as { n: number }).n;
      passed = stale === 0 ? 1 : 0;
      detail = `${stale} stale claims`;
    } else if (gate === 'promotion') {
      const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'PENDING'").get() as { n: number }).n;
      passed = pending === 0 ? 1 : 0;
      detail = `${pending} pending candidates`;
    } else if (gate === 'regression') {
      const lastReg = this.db.prepare('SELECT replayResult, replayedAt FROM regressions ORDER BY createdAt DESC LIMIT 1').get() as { replayResult?: string; replayedAt?: string } | undefined;
      // A verdict only counts when a replay produced it. replayResult without a
      // replayedAt is an asserted value, not an observed one, so it cannot open
      // the gate — the migration that withdrew legacy assertions makes this
      // branch unreachable for stored rows, and it stays as the guard for
      // anything that reaches the table another way.
      passed = lastReg?.replayResult === 'PASS' && lastReg.replayedAt != null ? 1 : 0;
      detail = !lastReg ? 'no regression run'
        : lastReg.replayResult == null ? 'last regression recorded but never replayed'
        : lastReg.replayedAt == null ? `last regression asserts ${lastReg.replayResult} with no replay — not adjudicated`
        : `last regression: ${lastReg.replayResult} at ${lastReg.replayedAt}`;
    } else if (gate === 'principles') {
      // Principles carry no evidence rows, so the claims' evidence gate cannot
      // see them. Their invariant is the pair a principle must hold to be
      // load-bearing: a unique normalized statement (dedupe) and an anchor
      // (source or derivedFrom). A corpus that stores the same principle ten
      // times, or a principle with no provenance, fails this gate — the same
      // fail-closed posture as `evidence`.
      const rows = this.db.prepare('SELECT statement, source, derivedFrom FROM principles').all() as Array<{ statement: string | null; source: string | null; derivedFrom: string | null }>;
      const seen = new Set<string>();
      let duplicates = 0;
      let unanchored = 0;
      for (const r of rows) {
        const normalized = (r.statement ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (normalized.length > 0) {
          if (seen.has(normalized)) duplicates += 1;
          else seen.add(normalized);
        }
        const anchored = (r.source != null && r.source !== '') || (r.derivedFrom != null && r.derivedFrom !== '');
        if (!anchored) unanchored += 1;
      }
      passed = duplicates === 0 && unanchored === 0 ? 1 : 0;
      detail = `${duplicates} duplicate normalized statement(s), ${unanchored} unanchored principle(s) (of ${rows.length})`;
    } else {
      passed = 0;
      detail = `unknown gate '${gate}' — fail closed`;
    }
    const recorded = opts.record === true;
    if (recorded) {
      this.db.prepare('INSERT INTO phase_gates(gateId,phase,gate,passed,detail,checkedAt) VALUES (?,?,?,?,?,?)')
        .run(gateId, phase, gate, passed, detail, now());
    }
    return { gateId: recorded ? gateId : null, phase, gate, passed: Boolean(passed), detail };
  }

  // ---- Core Health -------------------------------------------------------------
  // One composition of the health signal, shared by the CLI and the MCP surface
  // so neither can drift into reporting a different status for the same store.
  // Read-only by construction: gate and audit evaluation is recorded nowhere
  // here, because a UI refresh or a client poll would otherwise write rows on
  // every open and grow the database from a read path.
  //
  // `status` is three-valued rather than a percentage. An empty store cannot
  // support a judgement, so it reports UNKNOWN instead of a flattering score,
  // and DEGRADED names every failing gate in a stable order — a single named
  // gate would mask whichever other gates failed alongside it.
  health(opts: { staleDays?: number } = {}) {
    const gate = (name: string) => this.checkPhaseGate('health-surface', name, { record: false });
    const stats = this.stats();
    const audit = this.corpusAudit({ record: false });
    const gates: Record<string, { passed: boolean; detail: string }> = {
      coverage: gate('coverage'),
      evidence: gate('evidence'),
      conflict: gate('conflict'),
      temporal: gate('temporal'),
      promotion: gate('promotion'),
      regression: gate('regression'),
      principles: gate('principles'),
    };
    const empty = stats.artifacts === 0 && stats.claims === 0;
    const failedGates = Object.entries(gates).filter(([, g]) => !g.passed).map(([name]) => name);
    const status = empty ? 'UNKNOWN' : failedGates.length > 0 ? 'DEGRADED' : 'HEALTHY';
    const reasonCode = empty
      ? 'EMPTY_STORE'
      : failedGates.length > 0
        ? failedGates.map((name) => `GATE_${name.toUpperCase()}_FAILED`).join('+')
        : 'ALL_GATES_PASSED';
    return {
      status,
      reasonCode,
      failedGates,
      stats,
      audit,
      decay: this.decayCheck(opts.staleDays ? { staleDays: opts.staleDays } : undefined),
      gates,
      // The largest store signal reaches the health surface: per-platform gap
      // classification (NO_EVIDENCE / STALE / CONFLICTED / NONE) computed from
      // the same store, so a platform with zero claims is visible here instead
      // of only through a dedicated call nobody makes.
      knowledgeGaps: this.knowledgeGaps(opts.staleDays ? { staleDays: opts.staleDays } : undefined),
      // Uncertainty is scoped to a task or claim by construction. Classifying the
      // corpus-wide newest rows and presenting that as a health signal answers a
      // question nobody asked, so the missing scope is named instead.
      uncertainty: { level: 'UNKNOWN', reason: 'unscoped: uncertainty is per-task/claim, not corpus-wide' },
    };
  }

  // ---- Historical reuse --------------------------------------------------------
  // The reuse metric fixed by the plan: `found + injected + outcome-linked` — how
  // many prior claims a task could reuse, how many actually reached its context
  // pack, and how many of those were later tied to a recorded outcome.
  //
  // Read-only by construction. It measures the packs that were really written for
  // the task, rather than building a pack to measure: a metric that grows the
  // store on every call is the same defect as a health read that appends rows,
  // and it would also report a synthetic answer instead of what the task reused.
  reuseMetric(opts: { task: string; limit?: number }) {
    if (!opts?.task) throw new Error('reuseMetric requires a task');
    const foundRows = this.query({ text: opts.task, limit: opts.limit ?? 200 }) as Array<{ claimId: string }>;
    const foundIds = foundRows.map((r) => r.claimId).sort();
    // "Latest" means last issued, not first created: the dedupe upsert refreshes
    // lastIssuedAt on every re-issue while createdAt stays put. COALESCE covers
    // rows written before the column existed; rowid and packId break same-millisecond
    // ties by real insert order and stable key so the pick stays deterministic.
    const packRow = this.db
      .prepare('SELECT packId, claimIdsJson FROM packs WHERE task = ? ORDER BY COALESCE(lastIssuedAt, createdAt) DESC, rowid DESC, packId DESC LIMIT 1')
      .get(opts.task) as { packId: string; claimIdsJson: string } | undefined;
    const injectedIds = packRow ? (JSON.parse(packRow.claimIdsJson) as string[]).slice().sort() : [];
    const injectedFlag: Record<string, true> = {};
    for (const id of injectedIds) injectedFlag[id] = true;
    const linkedFlag: Record<string, true> = {};
    if (packRow) {
      const linkRows = this.db
        .prepare(
          `SELECT p.claimIdsJson AS ids FROM cases c
           JOIN receipts r ON r.receiptId = c.verificationRef
           JOIN packs p ON p.packId = r.packId
           WHERE c.task = ? AND p.packId = ?`,
        )
        .all(opts.task, packRow.packId) as Array<{ ids: string }>;
      for (const row of linkRows) {
        for (const id of JSON.parse(row.ids) as string[]) if (injectedFlag[id]) linkedFlag[id] = true;
      }
    }
    return {
      metric: 'found + injected + outcome-linked',
      task: opts.task,
      packId: packRow?.packId ?? null,
      found: { value: foundIds.length, claimIds: foundIds, witness: 'claims returned by the task query' },
      injected: { value: injectedIds.length, claimIds: injectedIds, witness: 'packs.claimIdsJson for the task\'s latest pack' },
      outcomeLinked: {
        value: Object.keys(linkedFlag).length,
        claimIds: Object.keys(linkedFlag).sort(),
        witness: 'cases.verificationRef -> receipts.receiptId -> receipts.packId -> packs.claimIdsJson',
      },
    };
  }

  // ---- conflict resolution ----------------------------------------------------
  resolveConflict(opts: { id: string; classification: string; note?: string; resolved?: boolean }) {
    if (!CONFLICT_CLASSIFICATIONS.has(opts.classification)) {
      throw new Error(`invalid classification ${opts.classification}; must be one of ${[...CONFLICT_CLASSIFICATIONS].join('|')}`);
    }
    const row = this.db.prepare('SELECT id FROM conflicts WHERE id = ?').get(opts.id);
    if (!row) throw new Error(`unknown conflict ${opts.id}`);
    const state = opts.resolved === false || opts.classification === 'UNRESOLVED' || opts.classification === 'CONFLICTED' ? 'UNRESOLVED' : 'RESOLVED';
    this.db.prepare('UPDATE conflicts SET state = ?, classification = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(state, opts.classification, opts.note ?? null, opts.id);
    return { id: opts.id, state, classification: opts.classification };
  }

  // ---- v4: Core Regression (§46) -----------------------------------------------
  // recordRegression stores the regression DEFINITION only. replayResult is
  // never accepted from a caller — it is written exclusively by
  // replayRegression(), which re-executes the recorded checks against live
  // state. A regression with no replay has replayResult NULL and fails the
  // 'regression' phase gate closed.
  recordRegression(opts: { newKnowledge?: string; affectedRules?: string[]; affectedCases?: string[]; affectedRecommendations?: string[]; checks?: RegressionCheck[] }) {
    if ('replayResult' in opts) {
      throw new Error('replayResult is produced by replayRegression(), never accepted at record time');
    }
    // Explicit checks augment — never replace — the checks derived from the
    // affected* declarations: recording an affected rule without checking it
    // would be a stored lie.
    const checks: RegressionCheck[] = [
      ...(opts.affectedRules ?? []).map((claimId): RegressionCheck => ({ kind: 'claim-status', claimId, expect: 'LIVE' })),
      ...(opts.affectedCases ?? []).map((claimId): RegressionCheck => ({ kind: 'case-present', claimId })),
      ...(opts.affectedRecommendations ?? []).map((text): RegressionCheck => ({ kind: 'query-hit', text, min: 1 })),
      ...(opts.checks ?? []),
    ];
    const regressionId = `reg-${uuid()}`;
    this.db.prepare('INSERT INTO regressions(regressionId,newKnowledge,affectedRulesJson,affectedCasesJson,affectedRecommendationsJson,checksJson,replayResult,replayedAt,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(regressionId, opts.newKnowledge ?? null, JSON.stringify(opts.affectedRules ?? []), JSON.stringify(opts.affectedCases ?? []), JSON.stringify(opts.affectedRecommendations ?? []), JSON.stringify(checks), null, null, now());
    return { regressionId };
  }

  private runRegressionCheck(c: RegressionCheck): { kind: string; pass: boolean; detail: string } {
    if (c.kind === 'claim-status') {
      if (!c.claimId) return { kind: c.kind, pass: false, detail: 'check missing claimId' };
      const row = this.db.prepare('SELECT status FROM claims WHERE claimId = ?').get(c.claimId) as { status: string } | undefined;
      const expect = c.expect ?? 'LIVE';
      const pass = expect === 'LIVE'
        ? !!row && !['STALE_SOURCE_CHANGED', 'REVOKED', 'SUPERSEDED'].includes(row.status)
        : row?.status === expect;
      return { kind: c.kind, pass, detail: `claim ${c.claimId} status=${row?.status ?? 'MISSING'} expect=${expect}` };
    }
    if (c.kind === 'case-present') {
      if (!c.claimId) return { kind: c.kind, pass: false, detail: 'check missing caseId' };
      const row = this.db.prepare('SELECT caseId FROM cases WHERE caseId = ?').get(c.claimId);
      return { kind: c.kind, pass: !!row, detail: `case ${c.claimId} ${row ? 'present' : 'missing'}` };
    }
    if (c.kind === 'query-hit') {
      if (!c.text) return { kind: c.kind, pass: false, detail: 'check missing text' };
      const hits = this.query({ text: c.text, platform: c.platform, limit: 50 });
      const min = typeof c.min === 'number' ? c.min : 1;
      const pass = hits.length >= min && (!c.claimId || hits.some((h) => h.claimId === c.claimId));
      return { kind: c.kind, pass, detail: `query '${c.text}' hits=${hits.length} min=${min}${c.claimId ? ` claimId=${c.claimId}` : ''}` };
    }
    return { kind: String(c.kind), pass: false, detail: 'unknown check kind' };
  }

  replayRegression(regressionId: string) {
    const reg = this.db.prepare('SELECT * FROM regressions WHERE regressionId = ?').get(regressionId) as { checksJson: string | null } | undefined;
    if (!reg) throw new Error(`unknown regression ${regressionId}`);
    const checks: RegressionCheck[] = reg.checksJson ? (JSON.parse(reg.checksJson) as RegressionCheck[]) : [];
    const results = checks.map((c) => this.runRegressionCheck(c));
    const replayResult = results.length > 0 && results.every((r) => r.pass) ? 'PASS' : 'FAIL';
    const replayedAt = now();
    this.db.prepare('UPDATE regressions SET replayResult = ?, replayedAt = ?, replayDetailJson = ? WHERE regressionId = ?')
      .run(replayResult, replayedAt, JSON.stringify(results), regressionId);
    return { regressionId, replayResult, replayedAt, checks: results };
  }


  // ---- v4: Principles (§23) -----------------------------------------------------
  recordPrinciple(opts: { statement: string; source?: string; derivedFrom?: string }) {
    const principleId = `prin-${uuid()}`;
    this.db.prepare('INSERT INTO principles(principleId,statement,source,derivedFrom,status,createdAt) VALUES (?,?,?,?,?,?)')
      .run(principleId, opts.statement, opts.source ?? null, opts.derivedFrom ?? null, 'OBSERVED', now());
    return { principleId };
  }

  principles(opts?: { status?: string }) {
    const where = opts?.status ? 'WHERE status = ?' : '';
    const args = opts?.status ? [opts.status] : [];
    return this.db.prepare(`SELECT * FROM principles ${where} ORDER BY createdAt DESC`).all(...args as never[]);
  }

  // ---- v4: Hidden Requirements (§25) --------------------------------------------
  recordHiddenRequirement(opts: { task: string; explicitReq?: string; inferredReq?: string; likelihood?: string; evidence?: string }) {
    const reqId = `req-${uuid()}`;
    this.db.prepare('INSERT INTO hidden_requirements(reqId,task,explicitReq,inferredReq,likelihood,evidence,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(reqId, opts.task, opts.explicitReq ?? null, opts.inferredReq ?? null, opts.likelihood ?? null, opts.evidence ?? null, now());
    return { reqId };
  }

  hiddenRequirements(opts?: { task?: string }) {
    const where = opts?.task ? 'WHERE task LIKE ?' : '';
    const args = opts?.task ? [`%${opts.task}%`] : [];
    return this.db.prepare(`SELECT * FROM hidden_requirements ${where} ORDER BY createdAt DESC`).all(...args as never[]);
  }

  // ---- v4: Commercial Intelligence (§26) ----------------------------------------
  recordCommercial(opts: { taskType: string; quote?: number; scope?: string; estimate?: number; actual?: number; risk?: string; revisionCount?: number }) {
    const intelId = `ci-${uuid()}`;
    this.db.prepare('INSERT INTO commercial_intel(intelId,taskType,quote,scope,estimate,actual,risk,revisionCount,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(intelId, opts.taskType, opts.quote ?? null, opts.scope ?? null, opts.estimate ?? null, opts.actual ?? null, opts.risk ?? null, opts.revisionCount ?? null, now());
    return { intelId };
  }

  commercialIntel(opts?: { taskType?: string }) {
    const where = opts?.taskType ? 'WHERE taskType = ?' : '';
    const args = opts?.taskType ? [opts.taskType] : [];
    return this.db.prepare(`SELECT * FROM commercial_intel ${where} ORDER BY createdAt DESC`).all(...args as never[]);
  }

  // ---- v4: Tool Intelligence (§27) -----------------------------------------------
  recordTool(opts: { name: string; problemSolved?: string; workflowStage?: string; inputs?: string; outputs?: string; failureModes?: string; timeSaved?: number; maintenanceCost?: number; roi?: number; usageFrequency?: string }) {
    const toolId = `tool-${uuid()}`;
    this.db.prepare('INSERT INTO tool_intel(toolId,name,problemSolved,workflowStage,inputs,outputs,failureModes,timeSaved,maintenanceCost,roi,usageFrequency,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(toolId, opts.name, opts.problemSolved ?? null, opts.workflowStage ?? null, opts.inputs ?? null, opts.outputs ?? null, opts.failureModes ?? null, opts.timeSaved ?? null, opts.maintenanceCost ?? null, opts.roi ?? null, opts.usageFrequency ?? null, 'OBSERVED', now());
    return { toolId };
  }

  toolIntel(opts?: { status?: string }) {
    const where = opts?.status ? 'WHERE status = ?' : '';
    const args = opts?.status ? [opts.status] : [];
    return this.db.prepare(`SELECT * FROM tool_intel ${where} ORDER BY createdAt DESC`).all(...args as never[]);
  }

  // ---- v4: Archetypes (§33) ------------------------------------------------------
  recordArchetype(opts: { name: string; platform?: string; maturityLevel?: number; evidence?: string[] }) {
    const archetypeId = `arch-${uuid()}`;
    this.db.prepare('INSERT INTO archetypes(archetypeId,name,platform,maturityLevel,evidenceJson,createdAt) VALUES (?,?,?,?,?,?)')
      .run(archetypeId, opts.name, opts.platform ?? null, opts.maturityLevel ?? null, JSON.stringify(opts.evidence ?? []), now());
    return { archetypeId };
  }

  archetypes(opts?: { platform?: string }) {
    const where = opts?.platform ? 'WHERE platform = ?' : '';
    const args = opts?.platform ? [opts.platform] : [];
    return this.db.prepare(`SELECT * FROM archetypes ${where} ORDER BY createdAt DESC`).all(...args as never[]);
  }

  // ---- v4: Platform Semantics (§12) -----------------------------------------------
  recordPlatformSemantic(opts: { platform: string; semanticRole: string; propertyName?: string; cssFact?: string; semanticTruth?: string; evidence?: string }) {
    const semanticId = `sem-${uuid()}`;
    this.db.prepare('INSERT INTO platform_semantics(semanticId,platform,semanticRole,propertyName,cssFact,semanticTruth,evidence,createdAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(semanticId, opts.platform, opts.semanticRole, opts.propertyName ?? null, opts.cssFact ?? null, opts.semanticTruth ?? null, opts.evidence ?? null, now());
    return { semanticId };
  }

  platformSemantics(opts?: { platform?: string; semanticRole?: string }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.platform) { where.push('platform = ?'); args.push(opts.platform); }
    if (opts?.semanticRole) { where.push('semanticRole = ?'); args.push(opts.semanticRole); }
    const sql = `SELECT * FROM platform_semantics${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY createdAt DESC`;
    return this.db.prepare(sql).all(...args as never[]);
  }

  // ---- v4: Practice Parity (§21) ---------------------------------------------------
  recordPracticeParity(opts: { practice: string; declared?: string; observed?: string; gap?: string; evidence?: string }) {
    const parityId = `pp-${uuid()}`;
    this.db.prepare('INSERT INTO practice_parity(parityId,practice,declared,observed,gap,evidence,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(parityId, opts.practice, opts.declared ?? null, opts.observed ?? null, opts.gap ?? null, opts.evidence ?? null, now());
    return { parityId };
  }

  practiceParity(opts?: { practice?: string }) {
    const where = opts?.practice ? 'WHERE practice LIKE ?' : '';
    const args = opts?.practice ? [`%${opts.practice}%`] : [];
    return this.db.prepare(`SELECT * FROM practice_parity ${where} ORDER BY createdAt DESC`).all(...args as never[]);
  }

  // ---- v4: Skill Genealogy (§22) ----------------------------------------------------
  recordSkillVersion(opts: { skillId: string; version?: string; failure?: string; fix?: string; production?: string }) {
    const versionId = `sv-${uuid()}`;
    this.db.prepare('INSERT INTO skill_versions(versionId,skillId,version,failure,fix,production,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(versionId, opts.skillId, opts.version ?? null, opts.failure ?? null, opts.fix ?? null, opts.production ?? null, now());
    return { versionId };
  }

  skillGenealogy(opts: { skillId: string }) {
    return this.db.prepare('SELECT * FROM skill_versions WHERE skillId = ? ORDER BY createdAt ASC').all(opts.skillId);
  }

  // ---- v4: Enriched Context Pack (§39) -----------------------------------------------
  contextPackV2(opts: PackOpts) {
    const pack = this.contextPack(opts);
    const claims = pack.claims;
    const rules = claims.filter((c) => c.kind === 'RULE' || c.kind === 'CONSTRAINT');
    const targetNs = opts.namespace ?? this.inferQueryNamespace(opts);
    const similar = this.findSimilar({ task: opts.task, platform: opts.platform, includeGlobal: opts.includeGlobal, namespace: targetNs ?? undefined, limit: 10 });
    const uncertainty = this.classifyUncertainty({ task: opts.task, platform: opts.platform });
    const quality = this.qualityCount(claims);
    const score = this.packScore(claims, pack.conflicts.length);
    const firstClaim = claims[0];
    const topScore = firstClaim && typeof firstClaim.score === 'number' ? firstClaim.score : 0;
    const mismatchDominates = this.isNamespaceMismatchDominant(claims, targetNs);
    const lowTopScore = claims.length > 0 && topScore < TOP_SCORE_MIN_THRESHOLD;
    let confidence = this.confidenceFor(score, quality);
    if (lowTopScore || mismatchDominates) {
      confidence = 'UNKNOWN';
    }
    const abstained = confidence === 'UNKNOWN';
    return {
      ...pack,
      rules,
      historicalCases: similar.cases,
      knownPitfalls: similar.antiPatterns,
      knownWorkarounds: similar.workarounds,
      recommendedPattern: similar.fixPatterns[0] ?? null,
      uncertainty,
      confidence,
      confidenceScore: abstained ? null : Math.round(score * 1000) / 1000,
      qualityClaims: quality,
      abstained,
      reasonCode: abstained
        ? (mismatchDominates
            ? 'NAMESPACE_MISMATCH'
            : (lowTopScore && !opts.platform)
              ? 'LOW_CONFIDENCE'
              : this.abstainReason(opts))
        : null,
    };
  }

  // ---- v4: Enriched Receipt (§40) -----------------------------------------------------
  receiptV2(opts: { task: string; packId?: string; recommendation: string; abstained?: boolean; platform?: string }) {
    const receipt = this.receipt(opts);
    const similar = this.findSimilar({ task: opts.task, platform: opts.platform, limit: 5 });
    const uncertainty = this.classifyUncertainty({ task: opts.task, platform: opts.platform });
    // R4: confidence derives from the pack's scored claims, not revision count.
    let confidence = 'UNKNOWN';
    let reasonCode: string | null = 'NO_PACK';
    if (opts.packId) {
      const pack = this.db.prepare('SELECT * FROM packs WHERE packId = ?').get(opts.packId) as { claimIdsJson: string; platform: string | null } | undefined;
      const claimIds = pack ? (JSON.parse(pack.claimIdsJson) as string[]) : [];
      const platform = opts.platform ?? pack?.platform ?? undefined;
      const scope = this.unresolvedConflictScope({ platform });
      const conflictSubjects = new Set(
        (this.db.prepare(`SELECT subject FROM conflicts WHERE ${scope.where}`).all(...scope.args as never[]) as Array<{ subject: string | null }>)
          .map((r) => r.subject).filter((s): s is string => s != null),
      );
      const conflictCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM conflicts WHERE ${scope.where}`).get(...scope.args as never[]) as { n: number }).n;
      const evStmt = this.db.prepare('SELECT * FROM evidence WHERE claimId = ?');
      const rows = claimIds.length
        ? (this.db.prepare(`SELECT * FROM claims WHERE claimId IN (${claimIds.map(() => '?').join(',')})`).all(...claimIds as never[]) as Array<Record<string, unknown>>)
        : [];
      for (const r of rows) r.evidence = evStmt.all(r.claimId as string);
      const targetNs = opts.platform ? 'PLATFORM_KNOWLEDGE' : this.inferQueryNamespace({ platform, task: opts.task });
      const scored = this.scoreClaims(rows, { platform, conflictSubjects, targetNamespace: targetNs });
      const ranked = [...scored].sort((a, b) => (b.score - a.score) || String(a.claimId).localeCompare(String(b.claimId)));
      const quality = this.qualityCount(ranked);
      const firstClaim = ranked[0];
      const topScore = firstClaim && typeof firstClaim.score === 'number' ? firstClaim.score : 0;
      const mismatchDominates = this.isNamespaceMismatchDominant(ranked, targetNs);
      const lowTopScore = ranked.length > 0 && topScore < TOP_SCORE_MIN_THRESHOLD;
      if (lowTopScore || mismatchDominates) {
        confidence = 'UNKNOWN';
        reasonCode = mismatchDominates
          ? 'NAMESPACE_MISMATCH'
          : (lowTopScore && !platform)
            ? 'LOW_CONFIDENCE'
            : this.abstainReason({ platform });
      } else {
        confidence = this.confidenceFor(this.packScore(ranked, conflictCount), quality);
        reasonCode = confidence === 'UNKNOWN' ? this.abstainReason({ platform }) : null;
      }
    }
    return {
      ...receipt,
      why: similar.decisions.slice(0, 3),
      historicalCases: similar.cases.slice(0, 3),
      risks: similar.antiPatterns.slice(0, 3),
      alternatives: similar.fixPatterns.slice(0, 3),
      uncertainty,
      confidence,
      reasonCode,
    };
  }
}

export function openCore(dbPath: string) { return new Core(dbPath); }
