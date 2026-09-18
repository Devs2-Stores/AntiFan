#!/usr/bin/env node
/**
 * Run the five P0 daemon probes against one pinned, throwaway data root.
 *
 * Why this exists: the probes read the staged-host pointer and the terminal session journal from
 * `ANTIFAN_DATA_ROOT`, and one of them falls back to the developer's real data root when that
 * variable is unset. A bare probe chain therefore verifies whatever happens to be staged on the
 * machine rather than a known build. This wrapper stages the daemon into a fresh temp root, points
 * every probe at it, and reports a single exit code for the set.
 *
 * Probes run to completion even after one fails: the `&&` chain this replaces let a red probe in
 * the middle hide every probe after it, which is the failure mode the aggregate is meant to avoid.
 *
 * Usage:
 *   node scripts/run-daemon-probes.mjs [--keep]
 *
 * `--keep` leaves the temp root on disk and prints its path for inspection. Windows sometimes keeps
 * handles on the freshly staged native addons after the probes exit, so the wrapper retries removal
 * and then reports the path rather than failing a green run over it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

// Steps per probe, in order. probe-daemon-reattach is phase-split by design: phase 1 leaves its
// host running so phase 2 can prove the host outlives its client, and only phase 2 kills it. Both
// phases share one scratch root because phase 2 reads the state phase 1 wrote.
const PROBES = [
  { name: 'probe-daemon-reattach.cjs', steps: [['--phase=1'], ['--phase=2']] },
  { name: 'probe-staged-host-rpc.cjs', steps: [[]] },
  { name: 'probe-terminal-host-survival.cjs', steps: [[]] },
  { name: 'probe-rpc-surface-coverage.cjs', steps: [[]] },
  { name: 'probe-persist-cost.cjs', steps: [[]] },
];

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-probes-'));
const env = {
  ...process.env,
  ANTIFAN_DATA_ROOT: dataRoot,
  ANTIFAN_CONFIG_DIR: dataRoot,
};
const scratchRoot = path.join(dataRoot, 'scratch');
fs.mkdirSync(scratchRoot, { recursive: true });

function run(args, extraEnv) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: extraEnv ? { ...env, ...extraEnv } : env,
  });
  return result.status === null ? 1 : result.status;
}

/** Windows keeps handles on a tree a probe just killed, so removal is retried before giving up. */
function removeDirWithRetry(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    if (!fs.existsSync(dir)) return true;
    const end = Date.now() + 250;
    while (Date.now() < end) { /* bounded wait for handle release */ }
  }
  return !fs.existsSync(dir);
}

console.log(`[probes] pinned data root: ${dataRoot}`);
const stageStatus = run(['scripts/stage-daemon-host.mjs']);
if (stageStatus !== 0) {
  console.error('[probes] staging failed, so the probes have no known host to attach to. Run `npm run compile` if the compiled entry is missing.');
  console.log(`[probes] FAIL staging exit=${stageStatus}`);
  process.exit(1);
}

const results = [];
for (const probe of PROBES) {
  // Each probe owns its scratch root and wipes it on entry: sharing one directory made the first
  // probe's staged host lock a tree the later probes then refused to start against (EPERM).
  const scratch = path.join(scratchRoot, path.basename(probe.name, '.cjs'));
  fs.mkdirSync(scratch, { recursive: true });
  const startedAt = Date.now();
  let status = 0;
  for (const argv of probe.steps) {
    status = run([`scripts/${probe.name}`, ...argv], { PROBE_DIR: scratch });
    // Phase 2 assumes phase 1's state file, so a failed first step ends the probe here.
    if (status !== 0) break;
  }
  results.push({ probe: probe.name, status, ms: Date.now() - startedAt });
  console.log(`[probes] ${status === 0 ? 'PASS' : 'FAIL'} ${probe.name} (${Date.now() - startedAt} ms)`);
}

const failed = results.filter((r) => r.status !== 0);
console.log(`[probes] ${results.length - failed.length}/${results.length} passed in ${results.reduce((sum, r) => sum + r.ms, 0)} ms`);
for (const r of failed) console.log(`[probes]   failed: ${r.probe} exit=${r.status}`);

if (keep) {
  console.log(`[probes] kept: ${dataRoot}`);
} else if (!removeDirWithRetry(dataRoot)) {
  console.log(`[probes] temp root could not be removed (a detached host may still hold it): ${dataRoot}`);
}
process.exit(failed.length === 0 ? 0 : 1);
