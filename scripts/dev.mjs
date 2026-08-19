/**
 * AntiFan Browser Desktop — Development Watcher & Auto-Relauncher
 * Watches src/** for changes, recompiles with tsc, copies static assets, and restarts Electron smoothly.
 */
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let electronProc = null;
let tscProc = null;
let cwdChangedAt = Date.now();

function log(msg) {
  console.log(`[antifan-dev] ${msg}`);
}

function cleanupZombies() {
  // Only clean up if needed without killing external electron instances
}

function killTree(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    const done = () => resolve();
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
    cleanupZombies();
    log('Starting AntiFan Browser Desktop...');
    const env = { ...process.env, NODE_ENV: 'development', ELECTRON_RUN_AS_NODE: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    electronProc = spawn('node', ['scripts/run-electron.cjs', '.', '--dev'], { cwd: ROOT, stdio: 'inherit', env });
    electronProc.on('exit', () => {
      electronProc = null;
    });
  } finally {
    setTimeout(() => {
      relaunching = false;
    }, 400);
  }
}

try {
  execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log(`Initial compile failed: ${e.message}`);
}
copyStatic();
relaunchElectron();

tscProc = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', './', '--watch'], {
  cwd: ROOT,
  stdio: 'inherit',
});

function copyStatic() {
  try {
    execSync('node scripts/copy-static.mjs', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    log(`copy-static failed: ${e.message}`);
  }
}

let relaunchTimer = null;
function scheduleRelaunch() {
  const now = Date.now();
  if (now - cwdChangedAt < 500) return;
  cwdChangedAt = now;

  if (relaunchTimer) clearTimeout(relaunchTimer);
  relaunchTimer = setTimeout(() => {
    copyStatic();
    void relaunchElectron();
  }, 600);
}

fs.watch(path.join(ROOT, 'src'), { recursive: true }, () => scheduleRelaunch());

log('AntiFan Dev mode ready — editing src/** auto-reloads. Ctrl+C to stop.');

setInterval(() => {}, 1_000_000);

process.on('SIGINT', () => {
  cleanupZombies();
  process.exit(0);
});

process.on('exit', () => {
  cleanupZombies();
});