#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const reportsDir = path.join(rootDir, 'plans', '260905-0012-core-pre-freeze-hardening-and-live-proof', 'reports');
const finalProofPath = path.join(reportsDir, 'live-theme-proof.json');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-theme-golden-live-'));
const stagingPath = path.join(reportsDir, `.live-theme-proof.staging-${process.pid}.json`);

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
  try { fs.unlinkSync(finalProofPath); } catch {}
  try { fs.unlinkSync(stagingPath); } catch {}

  const electronBin = require('electron');
  const env = {
    ...process.env,
    ANTIFAN_LIVE_PROOF_TEMP_ROOT: tempRoot,
    ANTIFAN_LIVE_PROOF_STAGING_PATH: stagingPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [path.join(rootDir, 'scripts', 'smoke-theme-golden-live.cjs')], {
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
  assert.equal(timedOut, false, 'Live theme proof exceeded 180 seconds');
  assert.equal(exitCode, 0, `Live theme proof Electron worker exited with code ${exitCode}`);

  const staged = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
  assert.equal(staged.type, 'antifan-live-theme-proof');
  assert.equal(staged.verdict, 'PROOF_PASSED_CLEANUP_PENDING');
  assert.equal(staged.proofChecksum, checksumObject(staged, 'proofChecksum'));
  assert.equal(staged.teardown?.passed, true);
  assert.equal(staged.teardown?.processBoundTempCleanup, 'pending');
  assert.ok(Object.values(staged.teardown?.resourceOwners || {}).every((value) => value === 0));

  await removeTempDirectoryWhenUnlocked(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false, 'Process-bound live proof temp root must be removed after Electron exit');
  const report = {
    ...staged,
    verdict: 'PASSED',
    completedAt: new Date().toISOString(),
    teardown: { ...staged.teardown, processBoundTempCleanup: 'completed' },
  };
  report.proofChecksum = checksumObject(report, 'proofChecksum');
  atomicWriteJson(finalProofPath, report);
  fs.unlinkSync(stagingPath);
  console.log(`[OK] Persisted bounded live proof: ${path.relative(rootDir, finalProofPath).replace(/\\/g, '/')}`);
  console.log('LIVE THEME GOLDEN PRODUCT CARD AND DRAWER SLICES PASSED.');
}

main().catch(async (error) => {
  try { fs.unlinkSync(finalProofPath); } catch {}
  try { fs.unlinkSync(stagingPath); } catch {}
  try { await removeTempDirectoryWhenUnlocked(tempRoot); } catch {}
  console.error('[Live Theme Proof Orchestrator FAIL]', error);
  process.exitCode = 1;
});
