/**
 * Cross-platform e2e launcher.
 *
 * The dev environment may export ELECTRON_RUN_AS_NODE=1 (e.g. for shell
 * tooling); that breaks Electron GUI apps (they run as plain Node and lose
 * the `app` API). This spawns Electron with the variable stripped so the app
 * entry or e2e runner gets a real GUI runtime.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const script = process.argv[2];
if (!script) {
  console.error('usage: node scripts/run-electron.cjs <app-dir-or-entry> [...args]');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron'); // resolves to the binary path under Node

const child = spawn(electronBin, process.argv.slice(2), {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => {
  if (process.platform === 'win32') {
    try {
      // Best-effort tree kill: Electron can leave gpu/utility/crashpad orphans.
      require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
  process.exit(code ?? 1);
});