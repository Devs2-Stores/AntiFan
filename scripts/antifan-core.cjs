#!/usr/bin/env node
// antifan-core: CLI access to the local Super Core evidence store.
// Usage: antifan-core <command> [json-args]
//   import <reportsDir>     import scout ledgers
//   query '{"text":"..."}'  anchored claims
//   pack '{"task":"..."}'   context pack
//   recommend '{"task":"..."}'
//   receipt '{"task":"...","recommendation":"..."}'
//   outcome '{"task":"...","outcome":"..."}'  case + PENDING candidate + observation
//   adjudicate '{"candidateId":"...","decision":"PROMOTE","authority":"..."}'
//   stats
//   domain <name>
//   invalidate '{"path":"..."}'
//   revoke '{"path":"..."}'
//   snapshot [note]
//   rollback <releaseId>
//   health                 aggregated stats+audit+decay+gates+uncertainty+status (Core Health UI)
//   reuse-metric '{"task":"..."}'  found + injected + outcome-linked reuse for a task
//   regressions            {replayEngineAvailable, rows} from the regressions table
//   task-runs              {taskRunsTable, taskRuns, packs, cases}
//   pack-detail <packId>   pack + its claims + receipts
//   case-detail <caseId>   case + its candidates
//   replay <regressionId>  re-execute a recorded regression's checks against live state
//   candidates '{"status":"PENDING"}'  adjudication queue rows (read-only)
//   observe '{"source":"...","kind":"...","payload":{}}'  raw observation into the learning loop

const path = require('node:path');

const dbPath = process.env.SUPER_CORE_DB || path.join(process.cwd(), '.super-core', 'core.db');
const cmd = process.argv[2];
const arg = process.argv[3];

async function main() {
  let core;
  try {
    const { openCore } = require('../packages/super-core/dist/index.js');
    core = openCore(dbPath);
  } catch (e) {
    console.error(JSON.stringify({ available: false, reason: `super-core unavailable: ${e.message}` }));
    process.exit(2);
  }
  const parse = (s) => { try { return JSON.parse(s ?? '{}'); } catch { return {}; } };
  let out;
  switch (cmd) {
    case 'import': out = core.importScout(arg ?? path.join(process.cwd(), 'plans', '260914-1248-work-root-sequential-evidence-scout', 'reports')); break;
    case 'query': out = core.query(parse(arg)); break;
    case 'pack': out = core.contextPack(parse(arg)); break;
    case 'recommend': out = core.recommend(parse(arg)); break;
    case 'receipt': out = core.receipt(parse(arg)); break;
    case 'outcome': out = core.ingestOutcome(parse(arg)); break;
    case 'adjudicate': out = core.adjudicate(parse(arg)); break;
    case 'stats': out = core.stats(); break;
    case 'domain': out = core.domain(arg); break;
    case 'invalidate': out = core.invalidate(parse(arg)); break;
    case 'revoke': out = core.revoke(parse(arg)); break;
    case 'snapshot': out = core.snapshot(arg); break;
    case 'rollback': out = core.rollback(arg); break;
    // v4
    case 'exp-node': out = core.recordExperienceNode(parse(arg)); break;
    case 'exp-edge': out = core.recordExperienceEdge(parse(arg)); break;
    case 'exp-chain': out = core.experienceChain(arg); break;
    case 'anti-pattern': out = core.recordAntiPattern(parse(arg)); break;
    case 'anti-patterns': out = core.antiPatterns(parse(arg)); break;
    case 'workaround': out = core.recordWorkaround(parse(arg)); break;
    case 'workarounds': out = core.workarounds(parse(arg)); break;
    case 'fix-pattern': out = core.recordFixPattern(parse(arg)); break;
    case 'fix-patterns': out = core.fixPatterns(parse(arg)); break;
    case 'similar': out = core.findSimilar(parse(arg)); break;
    case 'uncertainty': out = core.classifyUncertainty(parse(arg)); break;
    case 'decay': out = core.decayCheck(parse(arg)); break;
    case 'audit': {
      // Read-only by default, exactly like `gate`: both are inspection commands, and an
      // inspection must not grow the store. The store already records only on an explicit
      // opt-in, so the CLI was the last path appending a row unconditionally — every plain
      // `audit` wrote into whatever store the working directory implied. The caller is told
      // what it did not persist and how to persist it.
      const record = parse(arg).record === true;
      if (!record) {
        console.error('note: audit evaluated read-only, nothing persisted — pass {"record":true} to record it');
      }
      out = core.corpusAudit({ record });
      break;
    }
    case 'gate': {
      // Read-only by default. This command doubles as the only way to inspect a single
      // gate, and an inspection must not grow the store — the same rule `health` follows.
      // An unannounced write into whatever store the working directory implies is how a
      // probe appended rows to the live store, so the default is an evaluation and the
      // caller is told what it did not persist. A real run opts in with {"record":true};
      // the store itself records only on that explicit opt-in, so the MCP surface —
      // which passes no record flag — evaluates without appending.
      const gateArgs = parse(arg);
      const record = gateArgs.record === true;
      if (!record) {
        console.error('note: gate evaluated read-only, nothing persisted — pass {"record":true} to record it');
      }
      out = core.checkPhaseGate(gateArgs.phase, gateArgs.gate, record ? { record: true } : { record: false });
      break;
    }
    case 'resolve-conflict': out = core.resolveConflict(parse(arg)); break;
    case 'regression': out = core.recordRegression(parse(arg)); break;
    case 'observe': {
      const obs = parse(arg);
      if (typeof obs.source !== 'string' || typeof obs.kind !== 'string') {
        console.error("usage: observe '{\"source\":\"...\",\"kind\":\"...\",\"payload\":{}}'");
        process.exit(1);
      }
      out = core.recordObservation(obs);
      break;
    }
    case 'replay': {
      const parsed = parse(arg);
      const id = parsed && typeof parsed === 'object' ? parsed.regressionId : typeof parsed === 'string' ? parsed : arg;
      if (typeof id !== 'string' || id.length === 0) {
        console.error("usage: replay <regressionId> or '{\"regressionId\":\"...\"}'");
        process.exit(1);
      }
      out = core.replayRegression(id);
      break;
    }

    // Read-only list surfaces for the Core Health UI. The Core class exposes no
    // list methods for these tables, so the CLI reads them through the same
    // store handle — never a second authority, never a parallel DB.
    case 'regressions': {
      const lim = Math.min(parse(arg).limit ?? 50, 200);
      out = {
        replayEngineAvailable: typeof core.replayRegression === 'function',
        rows: core.db.prepare('SELECT * FROM regressions ORDER BY createdAt DESC LIMIT ?').all(lim),
      };
      break;
    }
    case 'task-runs': {
      const lim = Math.min(parse(arg).limit ?? 50, 200);
      const hasTaskRuns = Boolean(core.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_runs'").get());
      out = {
        taskRunsTable: hasTaskRuns,
        taskRuns: hasTaskRuns ? core.db.prepare('SELECT * FROM task_runs LIMIT ?').all(lim) : [],
        // Ordered by when a pack was last issued, not when it was created: a reused pack is
        // the recent one, which is also the order the reuse metric selects with.
        packs: core.db.prepare('SELECT * FROM packs ORDER BY COALESCE(lastIssuedAt, createdAt) DESC, rowid DESC LIMIT ?').all(lim),
        cases: core.db.prepare('SELECT * FROM cases ORDER BY createdAt DESC LIMIT ?').all(lim),
      };
      break;
    }
    case 'pack-detail': {
      const pack = core.db.prepare('SELECT * FROM packs WHERE packId = ?').get(arg);
      if (!pack) { out = { error: 'PACK_NOT_FOUND', packId: arg }; break; }
      const claimIds = JSON.parse(pack.claimIdsJson || '[]');
      const claims = claimIds.length
        ? core.db.prepare(`SELECT claimId, statement, kind, status, contextPlatform, confidence FROM claims WHERE claimId IN (${claimIds.map(() => '?').join(',')})`).all(...claimIds)
        : [];
      const receipts = core.db.prepare('SELECT * FROM receipts WHERE packId = ? ORDER BY createdAt DESC').all(arg);
      out = { pack, claims, receipts };
      break;
    }
    case 'case-detail': {
      const kase = core.db.prepare('SELECT * FROM cases WHERE caseId = ?').get(arg);
      if (!kase) { out = { error: 'CASE_NOT_FOUND', caseId: arg }; break; }
      const candidates = core.db.prepare('SELECT * FROM candidates WHERE caseId = ?').all(arg);
      out = { case: kase, candidates };
      break;
    }
    case 'candidates': {
      // Read-only list surface for the adjudication queue (same pattern as
      // `regressions`/`task-runs` above): PENDING rows were reachable only out
      // of band, so nothing could enumerate what `adjudicate` would act on.
      out = core.candidates(parse(arg));
      break;
    }
    case 'health': {
      const staleDays = parse(arg).staleDays;
      // Read-only and shared: the composition (stats, audit, decay, gates and the
      // reason-coded status) lives in the store so the CLI and the MCP surface
      // cannot report different health for the same database. Gate and audit
      // evaluation is recorded nowhere on this path — the Core Health UI re-runs
      // it on every open, and a read path must not grow the store. The MCP surface
      // is read-only here too (`core.corpus_audit` and `core.check_phase_gate`
      // dispatch with `record:false`); only an explicit run records, and `audit`
      // and `gate` require {"record":true} to do it.
      out = core.health(staleDays ? { staleDays } : {});
      break;
    }
    case 'reuse-metric': out = core.reuseMetric(parse(arg)); break;
    case 'principle': out = core.recordPrinciple(parse(arg)); break;
    case 'principles': out = core.principles(parse(arg)); break;
    case 'hidden-req': out = core.recordHiddenRequirement(parse(arg)); break;
    case 'hidden-reqs': out = core.hiddenRequirements(parse(arg)); break;
    case 'commercial': out = core.recordCommercial(parse(arg)); break;
    case 'commercial-intel': out = core.commercialIntel(parse(arg)); break;
    case 'tool': out = core.recordTool(parse(arg)); break;
    case 'tool-intel': out = core.toolIntel(parse(arg)); break;
    case 'archetype': out = core.recordArchetype(parse(arg)); break;
    case 'archetypes': out = core.archetypes(parse(arg)); break;
    case 'platform-semantic': out = core.recordPlatformSemantic(parse(arg)); break;
    case 'platform-semantics': out = core.platformSemantics(parse(arg)); break;
    case 'practice-parity': out = core.recordPracticeParity(parse(arg)); break;
    case 'practice-parities': out = core.practiceParity(parse(arg)); break;
    case 'skill-version': out = core.recordSkillVersion(parse(arg)); break;
    case 'skill-genealogy': out = core.skillGenealogy(parse(arg)); break;
    case 'pack-v2': out = core.contextPackV2(parse(arg)); break;
    case 'receipt-v2': out = core.receiptV2(parse(arg)); break;
    default:
      console.error('unknown command; see header usage');
      process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
  core.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
