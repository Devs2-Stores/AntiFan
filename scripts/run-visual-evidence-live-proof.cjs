#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const reportsDir = path.join(rootDir, 'plans', '260906-1418-visual-evidence-integrity-and-haravan-proof', 'reports');
const finalProofPath = path.join(reportsDir, 'live-visual-evidence-proof.json');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-live-'));
const stagingPath = path.join(reportsDir, `.live-visual-evidence-proof.staging-${process.pid}.json`);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function checksumObject(value, checksumField) {
  const copy = { ...value };
  delete copy[checksumField];
  return sha256(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function killOwnedTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

async function removeTempDirectoryWhenUnlocked(directory, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function main() {
  fs.mkdirSync(reportsDir, { recursive: true });
  try { fs.unlinkSync(finalProofPath); } catch {}
  try { fs.unlinkSync(stagingPath); } catch {}

  const electronBin = require('electron');
  // Sanitized execution environment: do NOT pass arbitrary secrets to child
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    ANTIFAN_LIVE_PROOF_TEMP_ROOT: tempRoot,
    ANTIFAN_LIVE_PROOF_STAGING_PATH: stagingPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [path.join(rootDir, 'scripts', 'smoke-visual-evidence-live.cjs')], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killOwnedTree(child);
  }, 180_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  }).finally(() => clearTimeout(timeout));
  assert.equal(timedOut, false, 'Live visual evidence proof exceeded 180 seconds');
  assert.equal(exitCode, 0, `Live visual evidence proof Electron worker exited with code ${exitCode}`);

  const staged = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
  assert.equal(staged.type, 'antifan-live-visual-evidence-proof');
  assert.equal(staged.proofChecksum, checksumObject(staged, 'proofChecksum'));

  await removeTempDirectoryWhenUnlocked(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false, 'Process-bound live proof temp root must be removed after Electron exit');

  const report = {
    ...staged,
    completedAt: new Date().toISOString(),
    teardown: { ...staged.teardown, processBoundTempCleanup: 'completed' },
  };
  report.proofChecksum = checksumObject(report, 'proofChecksum');
  atomicWriteJson(finalProofPath, report);
  fs.unlinkSync(stagingPath);
  if (report.verdict === 'BLOCKED') {
    console.log(`[BLOCKED] Persisted live visual evidence report: ${path.relative(rootDir, finalProofPath).replace(/\\/g, '/')}`);
    console.log(`[Live Proof Verdict] ${report.verdict} (V-25: ${report.v25Status})`);
    console.log('[Notice] Phase 7 V-25 terminal blocker acknowledged: Missing real Sapo Theme CLI watcher and preview store credentials.');
    console.log('[Notice] Invariant upheld: 0 synthetic receipts emitted, checklist #18 remains pending.');
    console.log('[Notice] Rule enforced: "không tính BLOCKED là thành công" (exiting with code 2).');
    process.exit(2);
  }

  console.log(`[OK] Persisted live visual evidence report: ${path.relative(rootDir, finalProofPath).replace(/\\/g, '/')}`);
  console.log(`[Live Proof Verdict] ${report.verdict} (V-25: ${report.v25Status})`);
}

main().catch(async (error) => {
  try { fs.unlinkSync(finalProofPath); } catch {}
  try { fs.unlinkSync(stagingPath); } catch {}
  try { await removeTempDirectoryWhenUnlocked(tempRoot); } catch {}
  console.error('[Live Visual Evidence Proof Orchestrator FAIL]', error);
  process.exitCode = 1;
});
