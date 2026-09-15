// Populate v4 domain tables in .super-core/core.db from existing claims.
// Run from repo root:  node plans/260914-1248-work-root-sequential-evidence-scout/tools/populate-v4.mjs
// Every inserted row carries its source claimId in an evidence/source/derivedFrom/risk field.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { openCore } = require('./packages/super-core/dist/index.js');

const core = openCore(process.env.SUPER_CORE_DB ?? '.super-core/core.db');
const db = core.db; // runtime-accessible handle for reads, transaction, and observations inserts
const now = () => new Date().toISOString();

const claims = db.prepare(
  'SELECT claimId, unitId, statement, kind, status, contextPlatform, confidence, sourceKind, subject FROM claims'
).all();

// unitId -> skill name, for SKILL claims whose subject is null
const skillNameByUnit = new Map(
  db.prepare('SELECT unitId, name FROM skills WHERE unitId IS NOT NULL').all().map((r) => [r.unitId, r.name])
);

const counts = {
  antiPatterns: 0, fixPatterns: 0, principles: 0, hiddenRequirements: 0,
  commercialIntel: 0, toolIntel: 0, platformSemantics: 0, observations: 0,
};
const skipped = {}; // kind -> reason
const seen = {
  antiPatterns: new Set(), fixPatterns: new Set(), principles: new Set(),
  hiddenRequirements: new Set(), commercialIntel: new Set(), toolIntel: new Set(),
  platformSemantics: new Set(), observations: new Set(),
};
// Cross-run idempotency: seed `seen` with keys already in the DB so a re-run
// inserts nothing instead of doubling rows. Keys mirror the per-case dedup
// keys used below.
for (const r of db.prepare('SELECT name FROM anti_patterns').all()) seen.antiPatterns.add(r.name);
for (const r of db.prepare('SELECT lesson FROM fix_patterns').all()) seen.fixPatterns.add(r.lesson);
for (const r of db.prepare('SELECT statement FROM principles').all()) seen.principles.add(r.statement);
for (const r of db.prepare('SELECT inferredReq FROM hidden_requirements').all()) seen.hiddenRequirements.add(r.inferredReq);
for (const r of db.prepare('SELECT scope FROM commercial_intel').all()) seen.commercialIntel.add(r.scope);
for (const r of db.prepare('SELECT name, problemSolved FROM tool_intel').all()) seen.toolIntel.add(`${r.name}|${String(r.problemSolved ?? '').replace(/ \[claim:[^\]]+\]$/, '')}`);
for (const r of db.prepare('SELECT platform, semanticTruth FROM platform_semantics').all()) seen.platformSemantics.add(`${r.platform}|${r.semanticTruth}`);
for (const r of db.prepare('SELECT payload FROM observations').all()) {
  try { seen.observations.add(JSON.parse(r.payload).statement); } catch {}
}

const REQUIREMENT_RE = /must|never|required|bắt buộc|không được/i;
const MARKERS_RE = /^platform markers observed:\s*(.+)$/;
const SKILL_PREFIX_RE = /^skill\s+/i;
const SKILL_NAME_RE = /^skill\s+([\w-]+)\s*:/i;

const insObservation = db.prepare(
  'INSERT INTO observations(id,source,kind,payload,ingestedAt) VALUES (?,?,?,?,?)'
);

function topMarker(parsed) {
  // "generic-liquid:226, haravan:28" -> highest-count marker
  let best = null, bestN = -1;
  for (const part of parsed.split(',')) {
    const m = part.trim().match(/^([\w-]+):(\d+)$/);
    if (m && Number(m[2]) > bestN) { best = m[1]; bestN = Number(m[2]); }
  }
  return best;
}

let txErrors = 0;
db.exec('BEGIN');
try {
  for (const c of claims) {
    const stmt = c.statement;
    switch (c.kind) {
      case 'ANTIPATTERN': {
        const name = c.subject ?? stmt.slice(0, 80);
        if (seen.antiPatterns.has(name)) break;
        seen.antiPatterns.add(name);
        core.recordAntiPattern({
          name,
          whatNotToDo: stmt,
          symptoms: stmt,
          evidence: `${c.claimId} (sourceKind=${c.sourceKind ?? 'unknown'})`,
          affectedPlatform: c.contextPlatform ?? undefined,
        });
        counts.antiPatterns++;
        break;
      }
      case 'BUGFIX': {
        if (seen.fixPatterns.has(stmt)) break;
        seen.fixPatterns.add(stmt);
        core.recordFixPattern({
          lesson: stmt,
          why: c.subject ?? undefined,
          evidence: c.claimId,
        });
        counts.fixPatterns++;
        break;
      }
      case 'RISK': {
        if (!REQUIREMENT_RE.test(stmt)) { skipped.RISK = 'statement does not imply a requirement (no must/never/required/bắt buộc/không được)'; break; }
        if (seen.hiddenRequirements.has(stmt)) break;
        seen.hiddenRequirements.add(stmt);
        core.recordHiddenRequirement({
          task: c.subject ?? 'corpus',
          inferredReq: stmt,
          likelihood: 'medium',
          evidence: c.claimId,
        });
        counts.hiddenRequirements++;
        break;
      }
      case 'RULE': {
        if (seen.principles.has(stmt)) break;
        seen.principles.add(stmt);
        core.recordPrinciple({
          statement: stmt,
          source: `skill-md:${c.sourceKind ?? c.unitId}`,
          derivedFrom: c.claimId,
        });
        counts.principles++;
        break;
      }
      case 'PLATFORM': {
        const m = stmt.match(MARKERS_RE);
        if (!m) { skipped.PLATFORM = 'statement not in "platform markers observed: X:n" format'; break; }
        const platform = c.contextPlatform ?? topMarker(m[1]) ?? 'unknown';
        const key = `${platform}|${stmt}`;
        if (seen.platformSemantics.has(key)) break;
        seen.platformSemantics.add(key);
        core.recordPlatformSemantic({
          platform,
          semanticRole: 'observed-markers',
          semanticTruth: stmt,
          evidence: c.claimId,
        });
        counts.platformSemantics++;
        break;
      }
      case 'COMMERCIAL': {
        if (seen.commercialIntel.has(stmt)) break;
        seen.commercialIntel.add(stmt);
        core.recordCommercial({
          taskType: c.subject ?? 'unknown',
          scope: stmt,
          risk: `claim:${c.claimId}`, // no evidence column; claimId carried here for traceability
        });
        counts.commercialIntel++;
        break;
      }
      case 'SKILL': {
        if (!SKILL_PREFIX_RE.test(stmt)) { skipped.SKILL = 'statement does not start with "skill "'; break; }
        const parsed = stmt.match(SKILL_NAME_RE)?.[1];
        const name = c.subject
          ?? skillNameByUnit.get(c.unitId)
          ?? (parsed && parsed !== 'trigger' ? parsed : null)
          ?? 'unknown';
        const key = `${name}|${stmt}`;
        if (seen.toolIntel.has(key)) break;
        seen.toolIntel.add(key);
        core.recordTool({
          name,
          problemSolved: `${stmt} [claim:${c.claimId}]`, // no evidence column; claimId embedded for traceability
        });
        counts.toolIntel++;
        break;
      }
      case 'OUTCOME': {
        if (seen.observations.has(stmt)) break;
        seen.observations.add(stmt);
        insObservation.run(
          `obs-${randomUUID()}`,
          c.claimId, // source column carries the claimId
          'OUTCOME',
          JSON.stringify({ statement: stmt, unitId: c.unitId, contextPlatform: c.contextPlatform, sourceKind: c.sourceKind }),
          now()
        );
        counts.observations++;
        break;
      }
      case 'THEME':
      case 'FEATURE': {
        skipped[c.kind] = 'archetype mapping too weak (section-heading subjects, not archetypes) — deliberately skipped to avoid junk rows';
        break;
      }
      default: {
        skipped[c.kind] = skipped[c.kind] ?? 'no v4 mapping specified';
      }
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  core.close();
  throw e;
}

const verify = {};
for (const t of ['anti_patterns', 'fix_patterns', 'principles', 'hidden_requirements',
  'commercial_intel', 'tool_intel', 'platform_semantics', 'observations',
  'workarounds', 'archetypes', 'practice_parity', 'skill_versions',
  'experience_nodes', 'experience_edges']) {
  verify[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}

console.log(JSON.stringify({ inserted: counts, skipped, tableTotals: verify, txErrors }, null, 2));
core.close();
