// Core: local-first evidence/provenance store over node:sqlite.
// Invariants: no auto-promotion; claims always carry evidence anchors;
// restricted sources never leak into packs; conflicts stay unresolved.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DDL, MIGRATIONS, SCHEMA_VERSION, PLATFORM_BACKFILL_SQL } from './schema.js';

const id = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
// §3 Zero Silent Skip: an artifact is terminal only when it reached a real
// analyzed/excluded state. BLOCKED is terminal only with a recorded reason.
const TERMINAL_DISPOSITIONS = new Set(['ANALYZED_NO_CLAIM', 'ANALYZED_WITH_CLAIMS', 'EXCLUDED']);
const CONFLICT_CLASSIFICATIONS = new Set(['GENERAL_RULE', 'CONTEXTUAL_RULE', 'LEGACY_RULE', 'EXCEPTION', 'CONFLICTED', 'UNRESOLVED']);


export interface QueryOpts { text?: string; platform?: string; unitId?: string; unitIds?: string[]; kind?: string; limit?: number; includeGlobal?: boolean; }
export interface PackOpts { task: string; platform?: string; unitIds?: string[]; limit?: number; sessionId?: string; includeGlobal?: boolean; }
export interface OutcomeInput { task: string; context?: string; outcome: string; verificationRef?: string; unitId?: string; platform?: string; }

// Deterministic composite ranking weights (R4/R6). Positive weights sum to 1.0;
// unresolved conflicts SUBTRACT, never add. Frozen before measurement.
const RANK = { text: 0.30, evidence: 0.25, state: 0.20, platform: 0.15, recency: 0.10, conflictPenalty: 0.10 } as const;
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
    for (const m of MIGRATIONS) {
      if (v === m.from) { this.db.exec(m.sql); v = m.to; }
    }
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('schemaVersion', String(v));
  }

  close() { this.db.close(); }

  stats() {
    const c = (t: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      artifacts: c('artifacts'), claims: c('claims'), evidence: c('evidence'),
      units: c('units'), skills: c('skills'), lineage: c('lineage'),
      conflicts: c('conflicts'), cases: c('cases'), candidates: c('candidates'),
      adjudications: c('adjudications'), releases: c('releases'), receipts: c('receipts'),
      packs: c('packs'),
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
      claim: this.db.prepare(`INSERT INTO claims(claimId,unitId,statement,kind,status,extractorVersion,contextPlatform,contextVersion,createdAt,confidence,validFrom,validUntil,sourceKind,subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(claimId) DO UPDATE SET
          unitId=excluded.unitId, statement=excluded.statement, kind=excluded.kind,
          extractorVersion=excluded.extractorVersion, contextPlatform=excluded.contextPlatform,
          contextVersion=excluded.contextVersion, confidence=excluded.confidence,
          validFrom=excluded.validFrom, validUntil=excluded.validUntil,
          sourceKind=excluded.sourceKind, subject=excluded.subject,
          status=CASE WHEN claims.status IN ('REVOKED','SUPERSEDED','STALE_SOURCE_CHANGED','PROMOTED') THEN claims.status ELSE excluded.status END`),
      decision: this.db.prepare('INSERT OR REPLACE INTO decisions(decisionId,unitId,statement,context,alternatives,chosen,evidenceJson,problem,tradeoffs,outcome,confidence,platform,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'),
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
      // lineage + conflicts
      for (const l of jsonl(path.join(reportsDir, 'lineage.jsonl'))) {
        ins.lineage.run(l.id, l.kind, l.name ?? l.base ?? l.sha256 ?? null, l.evidence ?? null, l.strength ?? null, JSON.stringify(l.units ?? l.locations ?? l.paths ?? []));
      // lineage + conflicts. Conflict scope: explicit unitId/platform from the
      // ledger wins; otherwise unitId is derived when positionsJson resolves to
      // exactly one unit via skills. Platform is backfilled post-import once
      // claims exist (PLATFORM_BACKFILL_SQL).
      const skillUnit = new Map<string, string>();
      for (const s of this.db.prepare('SELECT skillId, unitId FROM skills WHERE unitId IS NOT NULL').all() as Array<{ skillId: string; unitId: string }>) {
        skillUnit.set(s.skillId, s.unitId);
      }
      for (const l of jsonl(path.join(reportsDir, 'lineage.jsonl'))) {
        ins.lineage.run(l.id, l.kind, l.name ?? l.base ?? l.sha256 ?? null, l.evidence ?? null, l.strength ?? null, JSON.stringify(l.units ?? l.locations ?? l.paths ?? []));
      }
      for (const c of jsonl(path.join(reportsDir, 'conflicts.jsonl'))) {
        const posUnits = new Set<string>();
        for (const p of (c.positions ?? []) as Array<{ skillId?: string }>) {
          const u = p?.skillId ? skillUnit.get(p.skillId) : undefined;
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
        this.db.prepare('INSERT OR REPLACE INTO fix_patterns(fixId,before,after,why,evidence,lesson,createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(l.fixId ?? `fix-${uuid()}`, l.before ?? null, l.after ?? null, l.why ?? null, l.evidence ?? null, l.lesson ?? null, l.createdAt ?? now());
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
        ins.decision.run(d.decisionId, d.unitId, d.statement, d.context ?? null, d.alternatives ?? null, d.chosen ?? null, JSON.stringify(d.evidence ?? []), d.problem ?? null, d.tradeoffs ?? null, d.outcome ?? null, d.confidence ?? null, d.createdAt ?? now());
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
              ins.claim.run(c.claimId, uid, c.statement, c.kind, c.status ?? 'OBSERVED', c.extractorVersion ?? null, c.context?.platform ?? null, c.context?.version ?? null, c.createdAt ?? now(), c.confidence ?? null, c.validFrom ?? null, c.validUntil ?? null, c.sourceKind ?? null, c.subject ?? null);
              for (const e of c.evidenceRefs ?? []) {
                ins.evidence.run(id(`${c.claimId}${e.entryId ?? e.anchor ?? ''}${e.anchor ?? ''}`), c.claimId, e.entryId ?? null, e.revision ?? null, e.path ?? null, e.anchor ?? null);
              }
              ins.ftsDel.run(c.claimId);
              ins.fts.run(c.claimId, c.statement, c.kind, uid, c.claimId);
            }
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { ...this.stats(), skippedLines };
  }

  query(opts: QueryOpts) {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const where: string[] = [
      "c.status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')",
      // Enforce the pack's 'eligible-content-only' scope: a claim is excluded when
      // any of its evidence anchors to an artifact whose contentPolicy is not ALLOWED.
      `NOT EXISTS (SELECT 1 FROM evidence e JOIN artifacts a ON a.entryId = e.entryId
                   WHERE e.claimId = c.claimId AND a.contentPolicy != 'ALLOWED')`,
    ];
    const args: unknown[] = [];
    if (opts.platform) { where.push('(c.contextPlatform = ? OR c.contextPlatform IS NULL)'); args.push(opts.platform); }
    if (opts.unitId) { where.push('c.unitId = ?'); args.push(opts.unitId); }
    if (opts.unitIds?.length) { where.push(`c.unitId IN (${opts.unitIds.map(() => '?').join(',')})`); args.push(...opts.unitIds); }
    if (opts.kind) { where.push('c.kind = ?'); args.push(opts.kind); }
    let rows: Array<Record<string, unknown>>;
    // FTS5 treats - : ( ) " as syntax; quote each term. AND first for precision;
    // fall back to OR for recall when no claim contains every term.
    const terms = opts.text ? opts.text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`) : [];
    if (terms.length) {
      const andQ = terms.join(' ');
      rows = this.db.prepare(
        `SELECT c.*, bm25(claims_fts) AS rank FROM claims_fts f JOIN claims c ON c.claimId = f.claimId WHERE claims_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
      ).all(andQ, ...args as never[], limit) as Array<Record<string, unknown>>;
      if (rows.length === 0 && terms.length > 1) {
        const orQ = terms.join(' OR ');
        rows = this.db.prepare(
          `SELECT c.*, bm25(claims_fts) AS rank FROM claims_fts f JOIN claims c ON c.claimId = f.claimId WHERE claims_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
        ).all(orQ, ...args as never[], limit) as Array<Record<string, unknown>>;
      }
    } else {
      rows = this.db.prepare(`SELECT * FROM claims c WHERE ${where.join(' AND ')} LIMIT ?`).all(...args as never[], limit) as Array<Record<string, unknown>>;
    }
    return rows.map((r) => ({ ...r, evidence: this.db.prepare('SELECT * FROM evidence WHERE claimId = ?').all(r.claimId as string) })) as Array<Record<string, unknown> & { claimId: string; contextPlatform: string | null; evidence: unknown[] }>;
  }

  contextPack(opts: PackOpts) {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
    const claims = this.query({ text: opts.task, platform: opts.platform, unitIds: opts.unitIds, limit });
    const conflicts = this.db.prepare(`SELECT * FROM conflicts WHERE state = 'UNRESOLVED' LIMIT 50`).all();
    const unknowns = this.db.prepare(`SELECT unitId, COUNT(*) AS n FROM artifacts WHERE disposition IN ('BLOCKED','PENDING') GROUP BY unitId`).all();
    const release = this.db.prepare('SELECT releaseId, createdAt FROM releases ORDER BY createdAt DESC LIMIT 1').get() as { releaseId?: string; createdAt?: string } | undefined;
    const packId = `pack-${uuid()}`;
    this.db.prepare('INSERT INTO packs(packId,task,platform,claimIdsJson,createdAt) VALUES (?,?,?,?,?)')
      .run(packId, opts.task, opts.platform ?? null, JSON.stringify(claims.map((c) => c.claimId)), now());
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
  ingestOutcome(o: OutcomeInput) {
    const caseId = `case-${uuid()}`;
    const candidateId = `cand-${uuid()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO cases(caseId,task,context,outcome,verificationRef,unitId,createdAt) VALUES (?,?,?,?,?,?,?)')
        .run(caseId, o.task, o.context ?? null, o.outcome, o.verificationRef ?? null, o.unitId ?? null, now());
      this.db.prepare('INSERT INTO candidates(candidateId,caseId,statement,kind,evidenceJson,status,createdAt) VALUES (?,?,?,?,?,?,?)')
        .run(candidateId, caseId, `Outcome of "${o.task}": ${o.outcome}`, 'OUTCOME', JSON.stringify({ verificationRef: o.verificationRef ?? null }), 'PENDING', now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { caseId, candidateId, status: 'PENDING' };
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
        const full = this.db.prepare('SELECT c.*, s.unitId AS caseUnitId FROM candidates c LEFT JOIN cases s ON s.caseId = c.caseId WHERE c.candidateId = ?')
          .get(opts.candidateId) as { statement: string; kind: string; evidenceJson: string | null; caseUnitId: string | null } | undefined;
        if (full) {
          const claimId = `claim-${opts.candidateId}`;
          this.db.prepare(`INSERT INTO claims(claimId,unitId,statement,kind,status,extractorVersion,createdAt,confidence,sourceKind,subject)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(claimId) DO UPDATE SET statement=excluded.statement, status='PROMOTED'`)
            .run(claimId, full.caseUnitId ?? 'learning-loop', full.statement, full.kind, 'PROMOTED', 'adjudication', now(), 'HIGH', 'adjudication', opts.candidateId);
          this.db.prepare('DELETE FROM claims_fts WHERE claimId = ?').run(claimId);
          this.db.prepare('INSERT INTO claims_fts(rowid,statement,kind,unitId,claimId) VALUES ((SELECT rowid FROM claims WHERE claimId=?),?,?,?,?)')
            .run(claimId, full.statement, full.kind, full.caseUnitId ?? 'learning-loop', claimId);
          this.db.prepare('INSERT OR REPLACE INTO evidence(id,claimId,entryId,revision,path,anchor) VALUES (?,?,?,?,?,?)')
            .run(id(`${claimId}${adjId}`), claimId, null, null, null, `adjudication:${adjId}`);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { adjudicationId: adjId, candidateId: opts.candidateId, decision: opts.decision, authority: opts.authority, scope };
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
      this.db.prepare('UPDATE claims SET status = (SELECT status FROM release_claims WHERE release_claims.releaseId = ? AND release_claims.claimId = claims.claimId) WHERE claimId IN (SELECT claimId FROM release_claims WHERE releaseId = ?)').run(releaseId, releaseId);
      this.db.prepare('DELETE FROM candidates WHERE candidateId NOT IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)').run(releaseId);
      this.db.prepare('UPDATE candidates SET status = (SELECT status FROM release_candidates WHERE release_candidates.releaseId = ? AND release_candidates.candidateId = candidates.candidateId) WHERE candidateId IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)').run(releaseId, releaseId);
      this.db.prepare('DELETE FROM cases WHERE caseId NOT IN (SELECT caseId FROM candidates WHERE caseId IS NOT NULL)').run();
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
    const abstained = top.length === 0;
    const receipt = this.receipt({
      task: opts.task,
      packId: pack.packId,
      recommendation: abstained ? 'ABSTAIN: insufficient evidence' : `see ${top.length} anchored claim(s)`,
      abstained,
    });
    return { pack, recommendation: receipt.recommendation, abstained, receiptId: receipt.receiptId, differences: pack.conflicts, risks: pack.unknowns };
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
    const nodeId = `exp-${uuid()}`;
    this.db.prepare('INSERT INTO experience_nodes(nodeId,kind,refId,label,context,createdAt) VALUES (?,?,?,?,?,?)')
      .run(nodeId, opts.kind, opts.refId ?? null, opts.label ?? null, opts.context ?? null, now());
    return { nodeId };
  }

  recordExperienceEdge(opts: { fromNodeId: string; toNodeId: string; kind: string; evidence?: string }) {
    const edgeId = `edge-${uuid()}`;
    this.db.prepare('INSERT INTO experience_edges(edgeId,fromNodeId,toNodeId,kind,evidence,createdAt) VALUES (?,?,?,?,?,?)')
      .run(edgeId, opts.fromNodeId, opts.toNodeId, opts.kind, opts.evidence ?? null, now());
    return { edgeId };
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
  recordFixPattern(opts: { before?: string; after?: string; why?: string; evidence?: string; lesson?: string }) {
    const fixId = `fix-${uuid()}`;
    this.db.prepare('INSERT INTO fix_patterns(fixId,before,after,why,evidence,lesson,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(fixId, opts.before ?? null, opts.after ?? null, opts.why ?? null, opts.evidence ?? null, opts.lesson ?? null, now());
    return { fixId };
  }

  fixPatterns(opts?: { limit?: number }) {
    return this.db.prepare('SELECT * FROM fix_patterns ORDER BY createdAt DESC LIMIT ?').all(opts?.limit ?? 50);
  }

  // ---- v4: Case-Based Reasoning (§16) ----------------------------------------
  findSimilar(opts: { task: string; platform?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const terms = opts.task.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
    const orQ = terms.join(' OR ');
    const claims = terms.length
      ? this.db.prepare(`SELECT c.*, bm25(claims_fts) AS rank FROM claims_fts f JOIN claims c ON c.claimId = f.claimId WHERE claims_fts MATCH ? AND c.status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED') ORDER BY rank LIMIT ?`).all(orQ, limit)
      : [];
    const cases = this.db.prepare('SELECT * FROM cases WHERE task LIKE ? OR context LIKE ? ORDER BY createdAt DESC LIMIT ?')
      .all(`%${opts.task}%`, `%${opts.task}%`, limit);
    const decisions = this.db.prepare('SELECT * FROM decisions WHERE statement LIKE ? OR context LIKE ? OR chosen LIKE ? ORDER BY createdAt DESC LIMIT ?')
      .all(`%${opts.task}%`, `%${opts.task}%`, `%${opts.task}%`, limit);
    const antiPatterns = this.db.prepare('SELECT * FROM anti_patterns WHERE name LIKE ? OR symptoms LIKE ? OR affectedPlatform LIKE ? ORDER BY createdAt DESC LIMIT ?')
      .all(`%${opts.task}%`, `%${opts.task}%`, `%${opts.platform ?? ''}%`, limit);
    const workarounds = this.db.prepare('SELECT * FROM workarounds WHERE problem LIKE ? OR condition LIKE ? OR platform LIKE ? ORDER BY createdAt DESC LIMIT ?')
      .all(`%${opts.task}%`, `%${opts.task}%`, `%${opts.platform ?? ''}%`, limit);
    const fixPatterns = this.db.prepare('SELECT * FROM fix_patterns WHERE before LIKE ? OR after LIKE ? OR lesson LIKE ? ORDER BY createdAt DESC LIMIT ?')
      .all(`%${opts.task}%`, `%${opts.task}%`, `%${opts.task}%`, limit);
    return { claims, cases, decisions, antiPatterns, workarounds, fixPatterns };
  }

  // ---- v4: Uncertainty Engine (§37) ------------------------------------------
  classifyUncertainty(opts: { claimId?: string; task?: string }) {
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
    const claims = this.query({ text: opts.task ?? '', limit: 5 });
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

  corpusAudit() {
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
    // coveragePct = claim-yield: share of discovered artifacts that produced
    // claims. A corpus where most artifacts yield nothing reports a low number —
    // never masked as 100% (§3, §50).
    const coveragePct = discovered > 0 ? Math.round((extracted / discovered) * 1000) / 10 : 0;
    const processedPct = discovered > 0 ? Math.round(((analyzed + (byDisp['EXCLUDED'] ?? 0)) / discovered) * 1000) / 10 : 0;
    const reasonsJson = JSON.stringify({ byDisposition: byDisp, blockedReasonless, pending });
    const auditId = `audit-${uuid()}`;
    const pendingCands = (this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'PENDING'").get() as { n: number }).n;
    this.db.prepare('INSERT INTO corpus_audit(auditId,artifactsDiscovered,artifactsRead,artifactsAnalyzed,artifactsClassified,artifactsConnected,artifactsExtracted,blocked,reasonsJson,unresolved,coveragePct,rulesGenerated,candidatesPending,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(auditId, discovered, analyzed, analyzed, analyzed, connected, extracted, blocked, reasonsJson, unresolved, coveragePct, rules, pendingCands, now());
    return { auditId, artifacts: discovered, claims: s.claims, analyzed, extracted, connected, blocked, blockedReasonless, pending, unresolved, coveragePct, processedPct, candidatesPending: pendingCands };
  }

  // ---- v4: Phase Gates (§51) ---------------------------------------------------
  checkPhaseGate(phase: string, gate: string) {
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
      const unresolved = this.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE state = 'UNRESOLVED'").get() as { n: number };
      passed = unresolved.n === 0 ? 1 : 0;
      detail = `${unresolved.n} unresolved conflicts`;
    } else if (gate === 'temporal') {
      const stale = this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status = 'STALE_SOURCE_CHANGED'").get() as { n: number };
      passed = stale.n === 0 ? 1 : 0;
      detail = `${stale.n} stale claims`;
    } else if (gate === 'promotion') {
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'PENDING'").get() as { n: number };
      passed = pending.n === 0 ? 1 : 0;
      detail = `${pending.n} pending candidates`;
    } else if (gate === 'regression') {
      const lastReg = this.db.prepare('SELECT replayResult FROM regressions ORDER BY createdAt DESC LIMIT 1').get() as { replayResult?: string } | undefined;
      passed = lastReg?.replayResult === 'PASS' ? 1 : 0;
      detail = lastReg ? `last regression: ${lastReg.replayResult}` : 'no regression run';
    } else {
      passed = 0;
      detail = `unknown gate '${gate}' — fail closed`;
    }
    this.db.prepare('INSERT INTO phase_gates(gateId,phase,gate,passed,detail,checkedAt) VALUES (?,?,?,?,?,?)')
      .run(gateId, phase, gate, passed, detail, now());
    return { gateId, phase, gate, passed: Boolean(passed), detail };
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
  recordRegression(opts: { newKnowledge?: string; affectedRules?: string[]; affectedCases?: string[]; affectedRecommendations?: string[]; replayResult: 'PASS' | 'FAIL' }) {
    const regressionId = `reg-${uuid()}`;
    this.db.prepare('INSERT INTO regressions(regressionId,newKnowledge,affectedRulesJson,affectedCasesJson,affectedRecommendationsJson,replayResult,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(regressionId, opts.newKnowledge ?? null, JSON.stringify(opts.affectedRules ?? []), JSON.stringify(opts.affectedCases ?? []), JSON.stringify(opts.affectedRecommendations ?? []), opts.replayResult, now());
    return { regressionId };
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
    const claims = pack.claims as Array<Record<string, unknown>>;
    const rules = claims.filter((c) => c.kind === 'RULE' || c.kind === 'CONSTRAINT');
    const similar = this.findSimilar({ task: opts.task, platform: opts.platform, limit: 10 });
    const uncertainty = this.classifyUncertainty({ task: opts.task });
    const confidence = claims.length >= 5 ? 'HIGH' : claims.length >= 2 ? 'MEDIUM' : claims.length >= 1 ? 'LOW' : 'UNKNOWN';
    return {
      ...pack,
      rules,
      historicalCases: similar.cases,
      knownPitfalls: similar.antiPatterns,
      knownWorkarounds: similar.workarounds,
      recommendedPattern: similar.fixPatterns[0] ?? null,
      uncertainty,
      confidence,
    };
  }

  // ---- v4: Enriched Receipt (§40) -----------------------------------------------------
  receiptV2(opts: { task: string; packId?: string; recommendation: string; abstained?: boolean }) {
    const receipt = this.receipt(opts);
    const similar = this.findSimilar({ task: opts.task, limit: 5 });
    const uncertainty = this.classifyUncertainty({ task: opts.task });
    return {
      ...receipt,
      why: similar.decisions.slice(0, 3),
      historicalCases: similar.cases.slice(0, 3),
      risks: similar.antiPatterns.slice(0, 3),
      alternatives: similar.fixPatterns.slice(0, 3),
      uncertainty,
      confidence: receipt.evidenceRevisions.length >= 3 ? 'HIGH' : receipt.evidenceRevisions.length >= 1 ? 'MEDIUM' : 'LOW',
    };
  }
}

export function openCore(dbPath: string) { return new Core(dbPath); }
