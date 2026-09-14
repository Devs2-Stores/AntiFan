#!/usr/bin/env node
// antifan-core: CLI access to the local Super Core evidence store.
// Usage: antifan-core <command> [json-args]
//   import <reportsDir>     import scout ledgers
//   query '{"text":"..."}'  anchored claims
//   pack '{"task":"..."}'   context pack
//   recommend '{"task":"..."}'
//   receipt '{"task":"...","recommendation":"..."}'
//   outcome '{"task":"...","outcome":"..."}'
//   adjudicate '{"candidateId":"...","decision":"PROMOTE","authority":"..."}'
//   stats
//   domain <name>
//   invalidate '{"path":"..."}'
//   revoke '{"path":"..."}'
//   snapshot [note]
//   rollback <releaseId>

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
    case 'audit': out = core.corpusAudit(); break;
    case 'gate': out = core.checkPhaseGate(parse(arg).phase, parse(arg).gate); break;
    case 'regression': out = core.recordRegression(parse(arg)); break;
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
