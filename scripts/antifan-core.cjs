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
    default:
      console.error('unknown command; see header usage');
      process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
  core.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
