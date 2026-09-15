/**
 * Cross-platform e2e launcher.
 *
 * The dev environment may export ELECTRON_RUN_AS_NODE=1 (e.g. for shell
 * tooling); that breaks Electron GUI apps (they run as plain Node and lose
 * the `app` API). This spawns Electron with the variable stripped so the app
 * entry or e2e runner gets a real GUI runtime.
 *
 * This process is also the only one that knows the instance's pid and outlives
 * it, so when `--state-record <path>` (or ANTIFAN_INSTANCE_RECORD) is given it
 * publishes `.canary/state/canary-instance.json` atomically after a successful
 * spawn and removes it on a controlled exit — but only while the record still
 * names that child (pid **and** start token). Readers (the session mint) verify
 * the record against the live process instead of trusting it.
 *
 * Usage: node scripts/run-electron.cjs <app-dir-or-entry> [...args]
 *        [--state-record <path>]
 */
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

// `--state-record` is consumed here; every other argument reaches Electron.
const rawArgs = process.argv.slice(2);
const stateRecordArgIdx = rawArgs.indexOf('--state-record');
const stateRecordPath = stateRecordArgIdx !== -1
  ? rawArgs[stateRecordArgIdx + 1]
  : (process.env.ANTIFAN_INSTANCE_RECORD || null);
const childArgs = stateRecordArgIdx !== -1
  ? rawArgs.filter((_, idx) => idx !== stateRecordArgIdx && idx !== stateRecordArgIdx + 1)
  : [...rawArgs];

// Launcher coherence: align with dev.mjs and run-antifan.vbs.
//
// `src/main/index.ts` resolves ALLOW_EVAL from `--allow-eval`/`--mcp-high-risk` or
// ANTIFAN_ALLOW_EVAL=true, and treats every launch that is not `--production`/NODE_ENV=production
// as a dev launch (its IS_PROD/IS_DEV pair). This launcher used to add the flag only for an
// explicit `--dev`/development-env caller, so `npm start` (`node scripts/run-electron.cjs .`)
// booted a DEV app with ALLOW_EVAL=false: every eval-risk capability was refused with
// POLICY_DENIED and nothing indicated that the launcher, not the policy, was the reason.
// Default the flag on for any non-production start — the same default dev.mjs and
// run-antifan.vbs already apply — and say which rule decided it. Production starts add nothing,
// and an explicit opt-out wins over everything below, including an inherited ANTIFAN_ALLOW_EVAL.
const isProduction = childArgs.includes('--production') || process.env.NODE_ENV === 'production';
const hasEvalFlag = () => childArgs.includes('--allow-eval') || childArgs.includes('--mcp-high-risk');
const noEvalIdx = childArgs.indexOf('--no-eval');
const isExplicitNoEval = noEvalIdx !== -1 || process.env.ANTIFAN_ALLOW_EVAL === 'false';
if (noEvalIdx !== -1) {
  childArgs.splice(noEvalIdx, 1);
}
if (isExplicitNoEval) {
  // Make the opt-out mean what this file claims. It used to remove only `--no-eval` itself, so
  // `run-electron.cjs . --allow-eval --no-eval` — or an inherited ANTIFAN_ALLOW_EVAL=true, since
  // the caller's environment is passed through below — still started with eval ENABLED while the
  // caller believed it was disabled.
  for (const conflicting of ['--allow-eval', '--mcp-high-risk']) {
    const conflictingIdx = childArgs.indexOf(conflicting);
    if (conflictingIdx !== -1) childArgs.splice(conflictingIdx, 1);
  }
}
let evalSource;
if (hasEvalFlag()) {
  evalSource = 'cli-flag';
} else if (isExplicitNoEval) {
  evalSource = 'explicit-opt-out (--no-eval or ANTIFAN_ALLOW_EVAL=false)';
} else if (isProduction) {
  evalSource = 'production-default-deny';
} else if (process.env.ANTIFAN_ALLOW_EVAL === 'true' || process.env.ANTIFAN_ALLOW_EVAL === '1') {
  evalSource = 'env ANTIFAN_ALLOW_EVAL';
} else {
  childArgs.push('--allow-eval');
  evalSource = 'dev-default (non-production start)';
}
const script = childArgs[0];
if (!script) {
  console.error('usage: node scripts/run-electron.cjs <app-dir-or-entry> [...args] [--state-record <path>]');
  process.exit(1);
}
// The flag this launcher forwards, its source, and the env opt-in that could still decide the
// runtime's ALLOW_EVAL. The app logs the value it actually resolved at boot.
console.log(
  `[run-electron] eval flag: ${hasEvalFlag() ? '--allow-eval' : 'none'} (source: ${evalSource}); ` +
  `ANTIFAN_ALLOW_EVAL=${process.env.ANTIFAN_ALLOW_EVAL ?? '<unset>'}; electron args: ${childArgs.join(' ')}`
);

const ROOT = path.resolve(__dirname, '..');
const compiledMain = path.join(ROOT, '.compiled', 'src', 'main', 'index.js');
const resolvedTarget = path.resolve(script);
if ((script === '.' || resolvedTarget === ROOT) && !fs.existsSync(compiledMain)) {
  console.log('[run-electron] Missing compiled bundle. Running npm run compile...');
  execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
}

const bridgePort = Number(process.env.ANTIFAN_BRIDGE_PORT || 0) || null;

/** A second launcher must not adopt (or overwrite) an instance already serving the port. */
function portAlreadyOwned(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (owned) => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      resolve(owned);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let child = null;
let recordPath = null;
let childIdentity = null;
let killed = false;
let childExited = false;
let helpers = null;

function killChildTree() {
  if (childExited || killed || !child || !child.pid) return;
  killed = true;
  if (process.platform === 'win32') {
    try {
      require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
}

/** Controlled teardown: drop the record only while it still names this child. */
function dropRecord() {
  if (!recordPath || !helpers || !child || !child.pid) return;
  // Deleting on pid alone would be tautological: without a captured token there is
  // nothing to compare, and a recycled pid would let this teardown delete a
  // successor's record. Teardown runs during setup, so this case is reachable.
  const token = childIdentity && childIdentity.processStartToken;
  if (!token) return;
  try {
    const result = helpers.removeRecordIf(recordPath, (current) => (
      current.instancePid === child.pid
      && current.processStartToken === token
      && (!current.processStartTokenFormat || current.processStartTokenFormat === childIdentity.processStartTokenFormat)
    ));
    if (result && result.removed) console.log(`[run-electron] instance record removed (${recordPath})`);
  } catch {}
}

function teardown(code) {
  killChildTree();
  dropRecord();
  process.exit(code);
}

async function main() {
  // Helpers first: nothing may depend on a module that failed to load after the
  // child exists, or a failure here would orphan a running Electron.
  helpers = await import('./lib/atomic-record.mjs');
  const { captureProcessIdentity } = await import('./lib/process-identity.mjs');

  // The guard protects the record: only a launcher that is about to publish one
  // needs to prove it is the instance's sole owner. Plain e2e launches keep their
  // previous behaviour and are not refused for sharing a dev port.
  if (stateRecordPath && await portAlreadyOwned(bridgePort)) {
    console.error(`[run-electron] refusing to start: bridge port ${bridgePort} already has an owner, so this launcher would not own the instance it records`);
    process.exit(1);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // An explicit opt-out must also silence the env-var opt-in: the app ORs the two together, so
  // leaving ANTIFAN_ALLOW_EVAL=true in the child environment would re-enable eval behind the
  // caller's back. `--no-eval` is a denial, never a hint.
  if (isExplicitNoEval) delete env.ANTIFAN_ALLOW_EVAL;

  const electronBin = require('electron'); // resolves to the binary path under Node

  child = spawn(electronBin, childArgs, {
    stdio: 'inherit',
    env,
    detached: process.platform !== 'win32',
  });

  // Handlers are installed before any await, so an early exit or a signal can never
  // leave the child behind.
  child.on('exit', (code) => {
    childExited = true;
    dropRecord();
    process.exit(code !== null ? code : 1);
  });
  child.on('error', (err) => {
    console.error('[run-electron] spawn failed:', err && err.message);
    childExited = true;
    process.exit(1);
  });
  process.on('SIGINT', () => teardown(130));
  process.on('SIGTERM', () => teardown(143));
  process.on('SIGHUP', () => teardown(129));
  process.on('exit', () => {
    killChildTree();
    dropRecord();
  });

  try {
    if (stateRecordPath) {
      recordPath = path.resolve(ROOT, stateRecordPath);
      childIdentity = await captureProcessIdentity(child.pid);
      // The child can die while its identity is being read. The exit handler has
      // already run by then, so writing now would publish a record for a process
      // that no longer exists; a missing record is refused, a dead one is noise.
      if (childExited) {
        console.error('[run-electron] child exited before its instance record was written; no record written');
        return;
      }
      helpers.writeRecordAtomic(recordPath, {
        instancePid: child.pid,
        supervisorPid: process.pid,
        port: bridgePort,
        startedAt: childIdentity.startedAt,
        processStartToken: childIdentity.processStartToken,
        processStartTokenFormat: childIdentity.processStartTokenFormat,
        envFingerprint: {
          ANTIFAN_BRIDGE_PORT: bridgePort,
          ANTIFAN_USER_DATA: env.ANTIFAN_USER_DATA || null,
          ANTIFAN_PROJECT_ID: env.ANTIFAN_PROJECT_ID || null,
          ANTIFAN_WORKSPACE_ID: env.ANTIFAN_WORKSPACE_ID || null,
        },
        launchedBy: 'scripts/run-electron.cjs',
        recordedAt: new Date().toISOString(),
      });
      console.log(`[run-electron] instance record -> ${recordPath} (pid ${child.pid})`);
    }
  } catch (err) {
    // The child is already running: reap it before propagating, otherwise the
    // record's absence would describe an instance nobody tracks.
    killChildTree();
    throw err;
  }
}

main().catch((err) => {
  console.error('[run-electron] fatal:', err && err.message);
  killChildTree();
  process.exit(1);
});
