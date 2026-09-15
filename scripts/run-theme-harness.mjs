#!/usr/bin/env node
/**
 * Theme QA harness runner — three honest layers, verdicts labeled by evidence tier.
 *
 *   L0  OFFLINE_STATIC   source gate: scripts/theme-checks.mjs + lint-haravan-theme.mjs
 *   L1  LIVE_PUBLISHED   bound-tab measurement of the published theme (?themeid pinned)
 *   L2  WORKING_TREE     gated: approved unpublished theme + hrv theme dev watcher,
 *                        then the L1 suite against ?themeid=<devId>
 *
 * Usage:
 *   node scripts/run-theme-harness.mjs [--theme <dir>] [--layers l0,l1,l2]
 *       [--base-url <url>] [--evidence-dir <dir>] [--json]
 *
 * Exit codes: 0 = no layer FAILed (PASS/BLOCKED/INCONCLUSIVE are reported, not
 * punished), 1 = at least one layer FAILed, 2 = usage error.
 *
 * Evidence lands in `.canary/theme-harness/<runId>/` with a `latest.json`
 * pointer. L1/L2 need the live AntiFan Desktop app; without a bridge they are
 * BLOCKED with the prerequisite named — never simulated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRecordAtomic } from './lib/atomic-record.mjs';
import { resolveThemeBinding } from './theme-harness/binding.mjs';
import { runStaticGate } from './theme-harness/static-gate.mjs';
import { connectBridge } from './theme-harness/mcp-client.mjs';
import { runLivePublished } from './theme-harness/live-published.mjs';
import { evaluateWorkingTreeGate, runWorkingTree } from './theme-harness/working-tree.mjs';
import { LAYERS, blockedVerdict, overallVerdict } from './theme-harness/verdict.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgv(argv) {
  const options = {
    themeDir: 'Storefront',
    layers: ['l0', 'l1', 'l2'],
    evidenceDir: null,
    json: false,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--theme') { options.themeDir = argv[++i] ?? options.themeDir; continue; }
    if (arg === '--layers') {
      const raw = (argv[++i] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const unknown = raw.filter((l) => !['l0', 'l1', 'l2'].includes(l));
      if (unknown.length > 0) return { ok: false, reason: `unknown layer(s): ${unknown.join(', ')}` };
      options.layers = raw.length > 0 ? raw : options.layers;
      continue;
    }
    if (arg === '--evidence-dir') { options.evidenceDir = argv[++i] ?? null; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--base-url') { options.passthrough.push(arg, argv[++i]); continue; }
    return { ok: false, reason: `unrecognised argument '${arg}'` };
  }
  return { ok: true, options };
}

function line(layer) {
  const reasons = layer.blockedReasons.length > 0 ? ` — ${layer.blockedReasons.join('; ')}` : '';
  console.log(`[theme-harness] ${layer.layer} [${layer.tier}] ${layer.verdict}${reasons}`);
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[theme-harness] USAGE (exit 2): ${parsed.reason}`);
    process.exit(2);
  }
  const { themeDir, layers, json } = parsed.options;

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const evidenceDir = parsed.options.evidenceDir
    ? path.resolve(parsed.options.evidenceDir)
    : path.join(repoRoot, '.canary', 'theme-harness', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const resolvedThemeDir = path.resolve(repoRoot, themeDir);
  const binding = resolveThemeBinding({ themeDir: resolvedThemeDir, argv: parsed.options.passthrough });
  console.log(`[theme-harness] theme=${themeDir} org=${binding.orgId ?? '<none>'} themeId=${binding.themeId ?? '<none>'} (source=${binding.source})`);
  console.log(`[theme-harness] target=${binding.baseUrl} (source=${binding.baseUrlSource}) evidence=${evidenceDir}`);

  const layerResults = [];

  if (layers.includes('l0')) {
    layerResults.push(runStaticGate({ repoRoot, themeDir: resolvedThemeDir, evidenceDir }));
    line(layerResults.at(-1));
  }

  // The bridge client is shared by L1 and (when its gate opens) L2. It is
  // connected lazily so an L0-only run never touches the app.
  let client = null;
  let bridge = null;
  let bridgeError = null;
  const wantsLive = layers.includes('l1') || layers.includes('l2');
  if (wantsLive) {
    const connected = await connectBridge({ repoRoot });
    if (connected.ok) {
      client = connected.client;
      bridge = connected.bridge;
    } else {
      bridgeError = connected.reason;
      bridge = connected.bridge ?? null;
    }
  }

  try {
    if (layers.includes('l1')) {
      if (!client) {
        layerResults.push(blockedVerdict(LAYERS.L1, 'BLOCKED', [`live-bridge: ${bridgeError}`], {
          limits: ['the live-published suite needs the running AntiFan Desktop app'],
          evidence: { bridge },
        }));
      } else if (binding.missing.length > 0) {
        layerResults.push(blockedVerdict(LAYERS.L1, 'BLOCKED', [`theme-binding: missing ${binding.missing.join(', ')}`], {
          evidence: { bridge },
        }));
      } else {
        layerResults.push(await runLivePublished({ client, binding, repoRoot, themeDir: resolvedThemeDir, evidenceDir, bridge }));
      }
      line(layerResults.at(-1));
    }

    if (layers.includes('l2')) {
      if (!client) {
        const gate = evaluateWorkingTreeGate({ themeDir: resolvedThemeDir, liveThemeId: binding.themeId });
        const reasons = gate.prerequisites.filter((p) => !p.satisfied).map((p) => `${p.id}: ${p.detail}`);
        if (bridgeError) reasons.push(`live-bridge: ${bridgeError}`);
        layerResults.push(blockedVerdict(LAYERS.L2, 'BLOCKED', reasons, {
          checks: { prerequisites: gate.prerequisites },
          evidence: { bridge },
        }));
      } else {
        layerResults.push(await runWorkingTree({ client, binding, repoRoot, themeDir: resolvedThemeDir, evidenceDir, bridge }));
      }
      line(layerResults.at(-1));
    }
  } finally {
    if (client) client.close();
  }

  const report = {
    harness: 'theme-harness',
    runId,
    generatedAt: new Date().toISOString(),
    theme: {
      dir: themeDir,
      orgId: binding.orgId,
      themeId: binding.themeId,
      themeName: binding.themeName,
      bindingSource: binding.source,
    },
    target: { baseUrl: binding.baseUrl, host: binding.host, source: binding.baseUrlSource },
    verdict: overallVerdict(layerResults),
    layers: layerResults,
  };
  const reportPath = path.join(evidenceDir, 'report.json');
  writeRecordAtomic(reportPath, report);
  writeRecordAtomic(path.join(repoRoot, '.canary', 'theme-harness', 'latest.json'), {
    runId,
    reportPath,
    verdict: report.verdict,
    generatedAt: report.generatedAt,
  });

  console.log(`[theme-harness] overall=${report.verdict} report=${reportPath}`);
  if (json) console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(`[theme-harness] FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(2);
});
