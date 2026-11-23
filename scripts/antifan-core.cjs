#!/usr/bin/env node
// antifan-core: CLI access to the local Super Core evidence store.
// Usage: antifan-core <command> [json-args]
// `antifan-core help` lists every command; COMMANDS below is that list. Keep it
// in step with the dispatch switch at the bottom of this file.

const path = require('node:path');

const dbPath = process.env.SUPER_CORE_DB || path.join(process.cwd(), '.super-core', 'core.db');
const cmd = process.argv[2];
// `-` as the argument means "read it from stdin": a long prompt cannot travel as
// argv (Windows caps a command line near 32K, a spawn then fails ENAMETOOLONG).
const arg = process.argv[3] === '-' ? require('node:fs').readFileSync(0, 'utf8') : process.argv[3];

/** name, then the shortest arg shape an agent needs before calling it. */
const COMMANDS = [
  ['help', 'print this list'],
  ['import', 'import scout ledgers from a reports directory'],
  ['query', 'anchored claims: {"text","platform","unitIds","limit"}'],
  ['pack', 'context pack for {"task"}; {"minScore"} floors claim score (0..1)'],
  ['scope', 'units a project root resolves to: {"path"}'],
  ['recommend', 'pack plus a recommendation or an explicit abstention: {"task"}'],
  ['receipt', 'decision receipt: {"task","recommendation"}; {"packId"} binds it to a pack'],
  ['outcome', 'record a task outcome: case + PENDING lesson + observation'],
  ['inject-ack', 'record the claim ids a pack actually rendered (only writer of lastSeen)'],
  ['reinforce', 'reinforce the claims a verified outcome relied on'],
  ['unknown', 'record an open question: {"domain","question","platform"}'],
  ['unknown-update', 'compare-and-swap an unknown: {"unknownId","expectedRevision","status"}'],
  ['adjudicate-batch', 'decide several candidates at once: {"authority","items":[]}'],
  ['session-summary', 'upsert a session segment: {"sessionId","request","learned","completed"}'],
  ['search-index', 'compact id/title rows across claims, summaries and kinds'],
  ['timeline', 'rows around one id: {"anchorId","before","after"}'],
  ['get-many', 'full bodies for ids from search-index (max 50)'],
  ['unknowns', 'list unknowns: {"status"}'],
  ['last-summary', 'newest session summary for {"projectRoot"}'],
  ['adjudicate', 'one candidate decision; needs {"candidateId","decision","authority"}'],
  ['stats', 'store counts'],
  ['domain', 'domain view (units, claims, gaps): domain <name>'],
  ['invalidate', 'mark claims stale after a source change: {"path"}'],
  ['revoke', 'revoke claims derived from a restricted source: {"path"}'],
  ['snapshot', 'release snapshot for rollback; optional note'],
  ['rollback', 'restore a release snapshot: rollback <releaseId>'],
  ['exp-node', 'record an experience-graph node'],
  ['exp-edge', 'record an experience-graph edge'],
  ['exp-chain', 'traverse the experience graph from a node id'],
  ['anti-pattern', 'record what not to do: symptoms, evidence, replacement'],
  ['anti-patterns', 'list anti-patterns: {"platform","status"}'],
  ['workaround', 'record a workaround with its condition and evidence'],
  ['workarounds', 'list workarounds: {"platform","stillValid"}'],
  ['fix-pattern', 'record before/after/why for a repeated fix'],
  ['fix-patterns', 'list fix patterns'],
  ['similar', 'find similar claims, cases and lessons for a task'],
  ['uncertainty', 'classify uncertainty for a claim or a task'],
  ['decay', 'stale and aging claims: {"staleDays","platform"}'],
  ['audit', 'corpus audit; read-only unless {"record":true}'],
  ['gate', 'one phase gate: {"phase","gate"}; read-only unless {"record":true}'],
  ['resolve-conflict', 'classify or resolve a conflict: {"conflictId","resolution"}'],
  ['regression', 'record a re-executable regression check'],
  ['observe', 'raw observation into the learning loop: {"source","kind","payload"}'],
  ['replay', 're-execute a recorded regression: replay <regressionId>'],
  ['regressions', 'regression rows plus replay-engine availability'],
  ['task-runs', 'recent task runs, packs and cases'],
  ['pack-detail', 'one pack with its claims and receipts: pack-detail <packId>'],
  ['case-detail', 'one case with its candidates: case-detail <caseId>'],
  ['candidates', 'adjudication queue rows: {"status":"PENDING"}'],
  ['health', 'aggregated health: status, reasonCode, stats, audit, gates, decay'],
  ['reuse-metric', 'pack reuse for a task: found, injected, outcome-linked'],
  ['principle', 'record a principle; needs a source or derivedFrom anchor'],
  ['principles', 'list principles'],
  ['hidden-req', 'record a hidden requirement inferred from a task'],
  ['hidden-reqs', 'list hidden requirements'],
  ['commercial', 'record commercial intelligence for a task type'],
  ['commercial-intel', 'list commercial intelligence'],
  ['tool', 'record tool intelligence'],
  ['tool-intel', 'list tool intelligence'],
  ['archetype', 'record a project archetype'],
  ['archetypes', 'list archetypes'],
  ['platform-semantic', 'record a platform semantic fact'],
  ['platform-semantics', 'list platform semantics'],
  ['practice-parity', 'record declared vs observed practice parity'],
  ['practice-parities', 'list practice-parity records'],
  ['skill-version', 'record a skill version, failure, fix or production event'],
  ['skill-genealogy', 'skill version history'],
  ['pack-v2', 'enriched context pack: rules, cases, pitfalls, confidence'],
  ['receipt-v2', 'enriched decision receipt'],
];

function printCommands() {
  const width = Math.max(...COMMANDS.map(([name]) => name.length));
  console.log('antifan-core: CLI for the local Super Core evidence store');
  console.log('usage: node scripts/antifan-core.cjs <command> [json-args]');
  console.log('');
  for (const [name, summary] of COMMANDS) console.log(`  ${name.padEnd(width)}  ${summary}`);
}

if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printCommands();
  process.exit(0);
}
if (!COMMANDS.some(([name]) => name === cmd)) {
  console.error(`unknown command: ${cmd}`);
  printCommands();
  process.exit(1);
}

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
    case 'scope': { const s = parse(arg); out = core.resolveScope(s.path ?? arg ?? ''); break; }
    case 'recommend': out = core.recommend(parse(arg)); break;
    case 'receipt': out = core.receipt(parse(arg)); break;
    case 'outcome': out = core.ingestOutcome(parse(arg)); break;
    // Injection ledger: the bridge reports the claim ids it actually rendered.
    case 'inject-ack': out = core.markInjected(parse(arg)); break;
    case 'reinforce': out = core.reinforce(parse(arg)); break;
    case 'unknown': out = core.recordUnknown(parse(arg)); break;
    case 'unknown-update': out = core.updateUnknown(parse(arg)); break;
    case 'adjudicate-batch': out = core.adjudicateBatch(parse(arg)); break;
    case 'session-summary': out = core.upsertSessionSummary(parse(arg)); break;
    case 'search-index': out = core.searchIndex(parse(arg)); break;
    case 'timeline': out = core.timeline(parse(arg)); break;
    case 'get-many': out = core.getMany(parse(arg)); break;
    case 'unknowns': out = core.unknowns(parse(arg)); break;
    case 'last-summary': out = core.lastSummary(parse(arg)); break;
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
      // Unreachable while COMMANDS and this switch agree: the startup gate
      // rejects anything COMMANDS does not list. A command listed but never
      // dispatched is a defect in this file, not a user error.
      throw new Error(`command ${cmd} is listed in COMMANDS but not dispatched`);
  }
  console.log(JSON.stringify(out, null, 2));
  core.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
