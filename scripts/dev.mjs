/**
 * AntiFan Browser Desktop — Development Watcher & Auto-Relauncher
 * Watches src/** for changes, recompiles with tsc, copies static assets, and restarts Electron smoothly.
 */
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  isHotSwappable,
  isUiHotSwappable,
  processTscLine as parseTscLine,
  sendSoftReload,
  sendUiReload,
  resolveDevBridgeInfo,
  createChangeDispatcher,
  acquireDevLock,
  releaseDevLock,
  resolveElectronArgs,
} from './dev-watcher-helpers.mjs';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Forward extra CLI args to Electron. Coherent with run-antifan.vbs:
// npm run dev defaults to --allow-eval, matching the desktop background launcher,
// while allowing explicit opt-out with --no-eval.
const EXTRA_ELECTRON_ARGS = resolveElectronArgs(process.argv);
const isExplicitNoEval = EXTRA_ELECTRON_ARGS.includes('--no-eval') || process.argv.includes('--no-eval') || process.env.ANTIFAN_ALLOW_EVAL === 'false';
const hasExplicitEval = EXTRA_ELECTRON_ARGS.includes('--allow-eval') || EXTRA_ELECTRON_ARGS.includes('--mcp-high-risk');
if (isExplicitNoEval) {
  const noEvalIdx = EXTRA_ELECTRON_ARGS.indexOf('--no-eval');
  if (noEvalIdx !== -1) EXTRA_ELECTRON_ARGS.splice(noEvalIdx, 1);
} else if (!hasExplicitEval) {
  EXTRA_ELECTRON_ARGS.push('--allow-eval');
}

const cdpDir = path.join(ROOT, 'scripts', 'cdp');
if (!fs.existsSync(cdpDir)) {
  try { fs.mkdirSync(cdpDir, { recursive: true }); } catch {}
}

// Singleton guard: two `npm run dev` watchers both watch src/** and each
// relaunches Electron independently — they kill each other's app and drop
// running Tasks (the "app tự relaunch" chaos). Refuse to start when a live
// watcher already owns the lock; stale locks (dead pid) are taken over.
const lockPath = path.join(ROOT, 'node_modules', '.cache', 'antifan-dev.pid');
const lock = acquireDevLock({ lockPath, pid: process.pid });
if (!lock.ok) {
  const started = lock.existingStartedAt ? ` (started ${new Date(lock.existingStartedAt).toLocaleTimeString()})` : '';
  console.error(
    `[antifan-dev] ⚠ Another AntiFan dev watcher is already running: PID ${lock.existingPid}${started}.\n` +
    `[antifan-dev] Two watchers both watch src/** and each relaunches Electron — they kill each other's app and drop running Tasks.\n` +
    `[antifan-dev] Keep ONE. If that watcher is stale (orphaned terminal), kill it first:\n` +
    `[antifan-dev]     taskkill /F /T /PID ${lock.existingPid}\n` +
    `[antifan-dev] Exiting without touching the running session.`
  );
  process.exit(1);
}
process.on('exit', () => releaseDevLock(lockPath, process.pid));

const electronBin = require('electron');
let electronProc = null;
let tscProc = null;
let cwdChangedAt = Date.now() + 2000;
function log(msg) {
  console.log(`[antifan-dev] ${msg}`);
}

function killTree(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    proc.once('exit', done);
    try {
      if (process.platform === 'win32' && proc.pid) {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } else if (proc.pid) {
        proc.kill('SIGTERM');
      }
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
    setTimeout(done, 1000);
  });
}
async function waitForProcessExit(pid, maxWaitMs = 400, pollIntervalMs = 25) {
  if (!pid) return;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      process.kill(pid, 0);
      // Process still alive, poll again
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    } catch (err) {
      if (err && (err.code === 'ESRCH' || err.code === 'ENOENT')) {
        break;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  // Brief grace period (50ms) for Windows kernel mutexes and file locks to settle
  await new Promise((r) => setTimeout(r, 50));
}


let relaunching = false;
async function relaunchElectron() {
  if (relaunching) return;
  relaunching = true;
  try {
    if (electronProc) {
      log('Restarting AntiFan Electron...');
      const oldPid = electronProc.pid;
      await killTree(electronProc);
      electronProc = null;
      // Allow Windows kernel mutex / file locks for single-instance lock to release cleanly
      // Poll until the process has actually terminated, bounded to avoid dead time
      if (oldPid) {
        await waitForProcessExit(oldPid, 400, 25);
      }
    }
    log(`Starting AntiFan Browser Desktop${EXTRA_ELECTRON_ARGS.length ? ` (${EXTRA_ELECTRON_ARGS.join(' ')})` : ''}...`);
    const env = { ...process.env, NODE_ENV: 'development' };
    delete env.ELECTRON_RUN_AS_NODE;
    electronProc = spawn(electronBin, ['.', '--dev', ...EXTRA_ELECTRON_ARGS], { cwd: ROOT, stdio: 'inherit', env });
    electronProc.on('exit', (code, signal) => {
      log(`Electron process exited (code: ${code}, signal: ${signal})`);
      electronProc = null;
    });
  } finally {
    setTimeout(() => {
      relaunching = false;
    }, 150);
  }
}

function copyStatic() {
  try {
    execSync('node scripts/copy-static.mjs', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    log(`copy-static failed: ${e.message}`);
  }
}

try {
  execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log(`Initial compile failed: ${e.message}`);
}

relaunchElectron();

const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

let tscLineBuffer = '';
let isTscCompiling = false;
let tscHasErrors = false;
let tscSettledPromise = Promise.resolve(true);
let tscSettledResolver = null;

function processTscLine(line) {
  const next = parseTscLine(line, { isTscCompiling, tscHasErrors });
  if (next.isTscCompiling && !isTscCompiling) {
    if (!tscSettledResolver) {
      tscSettledPromise = new Promise((res) => {
        tscSettledResolver = res;
      });
    }
  }
  isTscCompiling = next.isTscCompiling;
  tscHasErrors = next.tscHasErrors;
  if (next.settled && tscSettledResolver) {
    const success = !tscHasErrors;
    tscSettledResolver(success);
    tscSettledResolver = null;
  }
}

tscProc = spawn(process.execPath, ['--max-old-space-size=4096', tscBin, '-p', './', '--watch', '--tsBuildInfoFile', '.compiled/.tsbuildinfo'], {
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'inherit'],
});

if (tscProc.stdout) {
  tscProc.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    tscLineBuffer += chunk.toString('utf8');
    const lines = tscLineBuffer.split(/\r?\n/);
    tscLineBuffer = lines.pop() || '';
    for (const line of lines) {
      processTscLine(line);
    }
  });
}

tscProc.on('exit', (code) => {
  isTscCompiling = false;
  if (code !== 0) {
    tscHasErrors = true;
  }
  if (tscSettledResolver) {
    tscSettledResolver(code === 0);
    tscSettledResolver = null;
  }
});


const dispatcher = createChangeDispatcher({
  isHotSwappableFn: isHotSwappable,
  isUiHotSwappableFn: isUiHotSwappable,
  sendSoftReloadFn: sendSoftReload,
  sendUiReloadFn: sendUiReload,
  copyStaticFn: copyStatic,
  relaunchElectronFn: relaunchElectron,
  getTscCompiling: () => isTscCompiling,
  getTscErrors: () => tscHasErrors,
  getTscSettledPromise: () => tscSettledPromise,
  getElectronProc: () => electronProc,
  debounceMs: 350,
  log,
});

function scheduleRelaunch(filename) {
  const now = Date.now();
  if (now < cwdChangedAt) return;
  if (!filename || typeof filename !== 'string' || !filename.trim()) return;
  dispatcher.scheduleRelaunch(filename.trim()).catch((err) => {
    if (dispatcher.isDisposed() || /disposed|cancelled/i.test(err?.message)) return;
    log(`Watcher dispatch failed: ${err?.message || err}`);
  });
}

try {
  fs.watch(path.join(ROOT, 'src'), { recursive: true }, (event, filename) => {
    if (filename) scheduleRelaunch(`src/${filename}`);
  });
} catch (err) {
  log(`Warning: recursive watch unavailable on src: ${err.message}`);
}

try {
  fs.watch(cdpDir, { recursive: true }, (event, filename) => {
    if (filename) scheduleRelaunch(`scripts/cdp/${filename}`);
  });
} catch (err) {
  log(`Warning: recursive watch unavailable on scripts/cdp: ${err.message}`);
}
log('AntiFan Dev mode ready — editing src/** auto-reloads. Ctrl+C to stop.');

// Watcher code (dev.mjs + helpers) is loaded once at startup and cannot be
// hot-applied. Poll mtimes and warn loudly when it changed on disk, so a
// watcher fix never silently stays inactive in a running session.
const WATCHER_SCRIPTS = ['scripts/dev.mjs', 'scripts/dev-watcher-helpers.mjs'];
const watcherScriptMtimes = new Map(WATCHER_SCRIPTS.map((rel) => [rel, null]));
let staleBannerShown = false;
setInterval(() => {
  let changed = false;
  for (const rel of WATCHER_SCRIPTS) {
    let mtime = null;
    try {
      mtime = fs.statSync(path.join(ROOT, rel)).mtimeMs;
    } catch {
      continue;
    }
    if (watcherScriptMtimes.get(rel) !== null && watcherScriptMtimes.get(rel) !== mtime) {
      changed = true;
    }
    watcherScriptMtimes.set(rel, mtime);
  }
  if (changed && !staleBannerShown) {
    staleBannerShown = true;
    console.error(
      '[antifan-dev] ⚠ Watcher code changed on disk (scripts/dev.mjs or scripts/dev-watcher-helpers.mjs).\n' +
      '[antifan-dev] The RUNNING watcher still uses the logic loaded at startup — restart npm run dev once to activate the new watcher behavior.'
    );
  }
}, 2000);

async function shutdown() {
  log('Stopping dev services...');
  dispatcher.dispose();
  if (electronProc) {
    await killTree(electronProc);
    electronProc = null;
  }
  if (tscProc) {
    await killTree(tscProc);
    tscProc = null;
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('exit', () => {
  if (electronProc && electronProc.pid && process.platform === 'win32') {
    try { execSync(`taskkill /pid ${electronProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  if (tscProc && tscProc.pid && process.platform === 'win32') {
    try { execSync(`taskkill /pid ${tscProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
});