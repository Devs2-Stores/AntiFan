const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const launcherPath = path.join(__dirname, 'run-electron.cjs');
const smokePath = path.join(__dirname, 'smoke-profile-persistence.cjs');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-persistence-smoke-'));

function runPhase(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath, smokePath, mode], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ANTIFAN_PERSISTENCE_SMOKE_PROFILE: profilePath,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Persistence smoke ${mode} phase exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

async function main() {
  try {
    await runPhase('write');
    await runPhase('read');
  } finally {
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[profile-smoke-runner] FAILED', error);
  process.exitCode = 1;
});
