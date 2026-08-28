/**
 * AntiFan Browser Desktop — Development Watcher & Auto-Relauncher
 * Watches src/** for changes, recompiles with tsc, copies static assets, and restarts Electron smoothly.
 */
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const electronBin = require('electron');

let electronProc = null;
let tscProc = null;
let cwdChangedAt = Date.now() + 2000;
function reconcileStartupInstances() {
  try {
    const lockFile = path.join(ROOT, 'appdata', 'antifan-browser-desktop', 'Chromium-dev', 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      try { fs.unlinkSync(lockFile); } catch {}
    }
  } catch {}
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
    reconcileStartupInstances();
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

reconcileStartupInstances();
try {
  execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log(`Initial compile failed: ${e.message}`);
}

relaunchElectron();

const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
tscProc = spawn(process.execPath, ['--max-old-space-size=4096', tscBin, '-p', './', '--watch'], {
  cwd: ROOT,
  stdio: 'inherit',
});

let relaunchTimer = null;
function scheduleRelaunch() {
  const now = Date.now();
  if (now < cwdChangedAt || now - cwdChangedAt < 500) return;
  cwdChangedAt = now;

  clearTimeout(relaunchTimer);
  relaunchTimer = setTimeout(() => {
    copyStatic();
    void relaunchElectron();
  }, 600);
}

try {
  fs.watch(path.join(ROOT, 'src'), { recursive: true }, () => scheduleRelaunch());
} catch (err) {
  log(`Warning: recursive watch unavailable: ${err.message}`);
}

log('AntiFan Dev mode ready — editing src/** auto-reloads. Ctrl+C to stop.');

async function shutdown() {
  log('Stopping dev services...');
  clearTimeout(relaunchTimer);
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