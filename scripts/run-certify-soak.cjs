const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const logPath = path.join(rootDir, 'plans', '260905-0012-core-pre-freeze-hardening-and-live-proof', 'reports', 'certify-run.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const out = fs.openSync(logPath, 'w');

const startTime = new Date().toISOString();
fs.writeSync(out, `[Soak-Launcher] Starting 3x45m Core Freeze Soak Certification at ${startTime}\n`);
fs.writeSync(out, `[Soak-Launcher] Node: ${process.execPath}\n`);
fs.writeSync(out, `[Soak-Launcher] Target: scripts/certify-core-freeze.cjs\n\n`);

console.log('[Soak-Launcher] Starting 3x45m Core Freeze Soak Certification...');
console.log(`[Soak-Launcher] Logging directly to: ${logPath}`);

const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'certify-core-freeze.cjs')], {
  cwd: rootDir,
  stdio: ['ignore', out, out],
  env: process.env,
});

child.on('error', (err) => {
  const msg = `\n[Soak-Launcher] Could not spawn the soak child: ${err.message} at ${new Date().toISOString()}\n`;
  try {
    fs.appendFileSync(logPath, msg, 'utf8');
    fs.closeSync(out);
  } catch {}
  console.error(msg);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const msg = `\n[Soak-Launcher] Process exited with code ${code} signal ${signal || 'none'} at ${new Date().toISOString()}\n`;
  try {
    fs.appendFileSync(logPath, msg, 'utf8');
    fs.closeSync(out);
  } catch {}
  console.log(msg);
  // A child killed by a signal reports code === null, and an abnormal termination can report
  // neither a code nor a signal. Only a real numeric exit code is published, so a torn-down
  // or failed soak can never read as a pass.
  process.exit(typeof code === 'number' ? code : 1);
});
