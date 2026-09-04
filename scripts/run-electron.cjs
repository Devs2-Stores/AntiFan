/**
 * Cross-platform e2e launcher.
 *
 * The dev environment may export ELECTRON_RUN_AS_NODE=1 (e.g. for shell
 * tooling); that breaks Electron GUI apps (they run as plain Node and lose
 * the `app` API). This spawns Electron with the variable stripped so the app
 * entry or e2e runner gets a real GUI runtime.
 */
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const script = process.argv[2];
if (!script) {
  console.error('usage: node scripts/run-electron.cjs <app-dir-or-entry> [...args]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const compiledMain = path.join(ROOT, '.compiled', 'src', 'main', 'index.js');
const resolvedTarget = path.resolve(script);
if ((script === '.' || resolvedTarget === ROOT) && !fs.existsSync(compiledMain)) {
  console.log('[run-electron] Missing compiled bundle. Running npm run compile...');
  execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron'); // resolves to the binary path under Node

const child = spawn(electronBin, process.argv.slice(2), {
  stdio: 'inherit',
  env,
  detached: process.platform !== 'win32',
});

let killed = false;
let childExited = false;
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

process.on('SIGINT', () => {
  killChildTree();
  process.exit(130);
});

process.on('SIGTERM', () => {
  killChildTree();
  process.exit(143);
});

process.on('SIGHUP', () => {
  killChildTree();
  process.exit(129);
});

process.on('exit', () => {
  killChildTree();
});

child.on('exit', (code) => {
  childExited = true;
  process.exit(code !== null ? code : 1);
});