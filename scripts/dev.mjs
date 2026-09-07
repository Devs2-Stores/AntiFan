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
  processTscLine as parseTscLine,
  sendSoftReload,
  resolveDevBridgeInfo,
  createChangeDispatcher,
} from './dev-watcher-helpers.mjs';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

let relaunching = false;
async function relaunchElectron() {
  if (relaunching) return;
  relaunching = true;
  try {
    if (electronProc) {
      log('Restarting AntiFan Electron...');
      await killTree(electronProc);
      electronProc = null;
    }
    log('Starting AntiFan Browser Desktop...');
    const env = { ...process.env, NODE_ENV: 'development' };
    delete env.ELECTRON_RUN_AS_NODE;
    electronProc = spawn(electronBin, ['.', '--dev'], { cwd: ROOT, stdio: 'inherit', env });
    electronProc.on('exit', () => {
      electronProc = null;
    });
  } finally {
    setTimeout(() => {
      relaunching = false;
    }, 400);
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

tscProc = spawn(process.execPath, ['--max-old-space-size=4096', tscBin, '-p', './', '--watch'], {
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
  sendSoftReloadFn: sendSoftReload,
  copyStaticFn: copyStatic,
  relaunchElectronFn: relaunchElectron,
  getTscCompiling: () => isTscCompiling,
  getTscErrors: () => tscHasErrors,
  getTscSettledPromise: () => tscSettledPromise,
  getElectronProc: () => electronProc,
  debounceMs: 500,
  log,
});

function scheduleRelaunch(filename) {
  const now = Date.now();
  if (now < cwdChangedAt) return;
  dispatcher.scheduleRelaunch(filename).catch((err) => {
    if (dispatcher.isDisposed() || /disposed|cancelled/i.test(err?.message)) return;
    log(`Watcher dispatch failed: ${err?.message || err}`);
  });
}

try {
  fs.watch(path.join(ROOT, 'src'), { recursive: true }, (event, filename) => scheduleRelaunch(filename ? `src/${filename}` : null));
} catch (err) {
  log(`Warning: recursive watch unavailable on src: ${err.message}`);
}

const cdpDir = path.join(ROOT, 'scripts', 'cdp');
if (!fs.existsSync(cdpDir)) {
  try { fs.mkdirSync(cdpDir, { recursive: true }); } catch {}
}
try {
  fs.watch(cdpDir, { recursive: true }, (event, filename) => scheduleRelaunch(filename ? `scripts/cdp/${filename}` : null));
} catch (err) {
  log(`Warning: recursive watch unavailable on scripts/cdp: ${err.message}`);
}
log('AntiFan Dev mode ready — editing src/** auto-reloads. Ctrl+C to stop.');

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