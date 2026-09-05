#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const reportsDir = path.join(rootDir, 'plans', '260905-0012-core-pre-freeze-hardening-and-live-proof', 'reports');
const thresholdsPath = path.join(reportsDir, 'freeze-thresholds.json');
const certificatePath = path.join(reportsDir, 'freeze-certificate.json');
const freezeCore = require('./freeze-certification-core.cjs');
const themeWorkload = require('./freeze-theme-workload.cjs');

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function runCompile() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'compile'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Compile failed with exit code ${result.status}`);
}

function computeBuildIdentity() {
  const files = [
    '.compiled/src/main/browser/native-tab-host.js',
    '.compiled/src/main/tools/browser-control-port.js',
    '.compiled/src/main/tools/browser-capabilities.js',
    '.compiled/src/main/tools/capability-transport.js',
    '.compiled/src/main/session/invocation-ledger.js',
    '.compiled/src/main/session/receipt-store.js',
    '.compiled/src/main/tools/artifact-store.js',
    'scripts/freeze-certification-core.cjs',
    'scripts/freeze-theme-workload.cjs',
    'scripts/smoke-real-soak.cjs',
    'scripts/certify-core-freeze.cjs',
  ];
  const entries = files.map((relativePath) => {
    const content = fs.readFileSync(path.join(rootDir, relativePath));
    return { path: relativePath.replace(/\\/g, '/'), sha256: freezeCore.sha256(content) };
  });
  return freezeCore.sha256(freezeCore.canonicalJson(entries));
}

function assertCompiledOwnerBounds() {
  const { DEFAULT_MAX_ARTIFACT_BYTES } = require(path.join(rootDir, '.compiled', 'src', 'main', 'tools', 'artifact-store.js'));
  const { DEFAULT_MAX_INVOCATION_FRAME_BYTES } = require(path.join(rootDir, '.compiled', 'src', 'main', 'session', 'invocation-ledger.js'));
  const { DEFAULT_MAX_RECEIPT_BYTES } = require(path.join(rootDir, '.compiled', 'src', 'main', 'session', 'receipt-store.js'));
  if (DEFAULT_MAX_ARTIFACT_BYTES !== freezeCore.MAX_ARTIFACT_BYTES ||
      DEFAULT_MAX_INVOCATION_FRAME_BYTES !== freezeCore.MAX_INVOCATION_FRAME_BYTES ||
      DEFAULT_MAX_RECEIPT_BYTES !== freezeCore.MAX_RECEIPT_BYTES) {
    throw new Error('Freeze threshold owner ceilings do not match the compiled implementation');
  }
}

function removeStaleOutputs() {
  fs.mkdirSync(reportsDir, { recursive: true });
  for (const filename of ['freeze-certificate.json', 'windows-soak-run-1.json', 'windows-soak-run-2.json', 'windows-soak-run-3.json']) {
    try { fs.unlinkSync(path.join(reportsDir, filename)); } catch {}
  }
}

function killOwnedTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
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

async function runCertificationChild(runNumber, buildIdentity) {
  const reportPath = path.join(reportsDir, `windows-soak-run-${runNumber}.json`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-core-freeze-'));
  const electronBin = require('electron');
  const env = {
    ...process.env,
    ANTIFAN_FREEZE_BUILD_IDENTITY: buildIdentity,
    ANTIFAN_FREEZE_THRESHOLD_PATH: thresholdsPath,
    ANTIFAN_FREEZE_TEMP_ROOT: tempRoot,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(electronBin, [
        path.join(rootDir, 'scripts', 'smoke-real-soak.cjs'),
        '--certification',
        '--duration',
        String(freezeCore.CERTIFICATION_DURATION_MINUTES),
        '--run',
        String(runNumber),
        '--report',
        reportPath,
      ], {
        cwd: rootDir,
        env,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
      const timeout = setTimeout(() => {
        killOwnedTree(child);
        reject(new Error(`Freeze run ${runNumber} exceeded the 50-minute process timeout`));
      }, 50 * 60 * 1000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    if (exit.code !== 0) {
      throw new Error(`Freeze run ${runNumber} exited with code ${exit.code} signal ${exit.signal || 'none'}`);
    }
    const manifest = freezeCore.validateThresholdManifest(JSON.parse(fs.readFileSync(thresholdsPath, 'utf8')));
    if (manifest.buildIdentity !== buildIdentity) throw new Error('Threshold build identity changed during certification');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    freezeCore.validateRunReport(report, manifest);
    return report;
  } finally {
    await removeTempDirectoryWhenUnlocked(tempRoot);
    if (fs.existsSync(tempRoot)) throw new Error(`Freeze run ${runNumber} retained its process-bound temp root`);
  }
}

async function main() {
  runCompile();
  assertCompiledOwnerBounds();
  removeStaleOutputs();
  const buildIdentity = computeBuildIdentity();
  const workload = themeWorkload.certificationWorkloadCounts();
  const thresholds = freezeCore.buildThresholdManifest({ buildIdentity, workload });
  atomicWriteJson(thresholdsPath, thresholds);
  freezeCore.validateThresholdManifest(JSON.parse(fs.readFileSync(thresholdsPath, 'utf8')));

  const reports = [];
  for (let runNumber = 1; runNumber <= 3; runNumber += 1) {
    const currentThresholds = freezeCore.validateThresholdManifest(JSON.parse(fs.readFileSync(thresholdsPath, 'utf8')));
    if (currentThresholds.thresholdChecksum !== thresholds.thresholdChecksum) {
      throw new Error(`Threshold manifest changed before run ${runNumber}`);
    }
    reports.push(await runCertificationChild(runNumber, buildIdentity));
  }

  const finalThresholds = freezeCore.validateThresholdManifest(JSON.parse(fs.readFileSync(thresholdsPath, 'utf8')));
  const certificate = freezeCore.aggregateCertification(reports, finalThresholds);
  atomicWriteJson(certificatePath, certificate);
  console.log(JSON.stringify({
    verdict: certificate.verdict,
    buildIdentity,
    thresholdChecksum: certificate.thresholdChecksum,
    certificateChecksum: certificate.certificateChecksum,
    reports: certificate.runs.map((run) => ({ runNumber: run.runNumber, reportChecksum: run.reportChecksum })),
    certificatePath: path.relative(rootDir, certificatePath).replace(/\\/g, '/'),
  }, null, 2));
}

main().catch((error) => {
  try { fs.unlinkSync(certificatePath); } catch {}
  console.error('[core-freeze-certification] BLOCKED:', error);
  process.exitCode = 1;
});
