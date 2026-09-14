// Core: local-first evidence/provenance store over node:sqlite.
// Invariants: no auto-promotion; claims always carry evidence anchors;
// restricted sources never leak into packs; conflicts stay unresolved.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DDL, MIGRATIONS, SCHEMA_VERSION } from './schema.js';

const id = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export interface QueryOpts { text?: string; platform?: string; unitId?: string; unitIds?: string[]; kind?: string; limit?: number; }
export interface PackOpts { task: string; platform?: string; unitIds?: string[]; limit?: number; }
export interface OutcomeInput { task: string; context?: string; outcome: string; verificationRef?: string; unitId?: string; }

export class Core {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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
      decisions: c('decisions'), dependencies: c('dependencies'), observations: c('observations'),
    };
  }

  // ---- import --------------------------------------------------------------
  importScout(reportsDir: string) {
    const ins = {
      unit: this.db.prepare('INSERT OR REPLACE INTO units(unitId,rootId,relPath,kind,disposition,parentId,markers,dossierPath) VALUES (?,?,?,?,?,?,?,?)'),
      artifact: this.db.prepare('INSERT OR REPLACE INTO artifacts(entryId,unitId,rootId,relPath,absPath,type,size,mtime,sha256,contentPolicy,disposition,observedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
      ftsDel: this.db.prepare('DELETE FROM claims_fts WHERE claimId = ?'),
      fts: this.db.prepare('INSERT INTO claims_fts(rowid,statement,kind,unitId,claimId) VALUES ((SELECT rowid FROM claims WHERE claimId=?),?,?,?,?)'),
      evidence: this.db.prepare('INSERT OR REPLACE INTO evidence(id,claimId,entryId,revision,path,anchor) VALUES (?,?,?,?,?,?)'),
      skill: this.db.prepare('INSERT OR REPLACE INTO skills(skillId,name,namespace,rootId,location,akDisposition,analysisState,unitId) VALUES (?,?,?,?,?,?,?,?)'),
      lineage: this.db.prepare('INSERT OR REPLACE INTO lineage(id,kind,subject,evidence,strength,membersJson) VALUES (?,?,?,?,?,?)'),
      conflict: this.db.prepare('INSERT OR REPLACE INTO conflicts(id,kind,subject,positionsJson,state,note) VALUES (?,?,?,?,?,?)'),
      // Upsert claims but never resurrect an operator-set terminal status
      // (REVOKED / SUPERSEDED / STALE_SOURCE_CHANGED) back to OBSERVED on re-import.
      claim: this.db.prepare(`INSERT INTO claims(claimId,unitId,statement,kind,status,extractorVersion,contextPlatform,contextVersion,createdAt,confidence,validFrom,validUntil,sourceKind,subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(claimId) DO UPDATE SET
          unitId=excluded.unitId, statement=excluded.statement, kind=excluded.kind,
          extractorVersion=excluded.extractorVersion, contextPlatform=excluded.contextPlatform,
          contextVersion=excluded.contextVersion, confidence=excluded.confidence,
          validFrom=excluded.validFrom, validUntil=excluded.validUntil,
          sourceKind=excluded.sourceKind, subject=excluded.subject,
          status=CASE WHEN claims.status IN ('REVOKED','SUPERSEDED','STALE_SOURCE_CHANGED') THEN claims.status ELSE excluded.status END`),
      decision: this.db.prepare('INSERT OR REPLACE INTO decisions(decisionId,unitId,statement,context,alternatives,chosen,evidenceJson,createdAt) VALUES (?,?,?,?,?,?,?,?)'),
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
      }
      for (const c of jsonl(path.join(reportsDir, 'conflicts.jsonl'))) {
        ins.conflict.run(c.id, c.kind, c.subject ?? null, JSON.stringify(c.positions ?? []), c.state ?? 'UNRESOLVED', c.note ?? null);
      }
      for (const d of jsonl(path.join(reportsDir, 'decisions.jsonl'))) {
        ins.decision.run(d.decisionId, d.unitId, d.statement, d.context ?? null, d.alternatives ?? null, d.chosen ?? null, JSON.stringify(d.evidence ?? []), d.createdAt ?? now());
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
            ins.artifact.run(l.entryId, uid, unitRoot[uid] ?? 'work-root', l.relPath, l.path, 'file', l.size ?? null, l.mtime ?? null, l.sha256 ?? null, l.contentPolicy ?? 'ALLOWED', l.disposition, l.observedAt ?? now());
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
      this.db.prepare('DELETE FROM claims WHERE claimId NOT IN (SELECT claimId FROM release_claims WHERE releaseId = ?)').run(releaseId);
      this.db.prepare('UPDATE claims SET status = (SELECT status FROM release_claims WHERE release_claims.releaseId = ? AND release_claims.claimId = claims.claimId) WHERE claimId IN (SELECT claimId FROM release_claims WHERE releaseId = ?)').run(releaseId, releaseId);
      this.db.prepare('DELETE FROM adjudications WHERE candidateId NOT IN (SELECT candidateId FROM release_candidates WHERE releaseId = ?)').run(releaseId);
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
}

export function openCore(dbPath: string) { return new Core(dbPath); }
