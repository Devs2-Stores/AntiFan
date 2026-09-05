#!/usr/bin/env node
'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', (event) => {
  event.preventDefault();
});


const rootDir = path.resolve(__dirname, '..');
const reportsDir = path.join(rootDir, 'plans', '260905-0012-core-pre-freeze-hardening-and-live-proof', 'reports');
const freezeCore = require('./freeze-certification-core.cjs');
const themeWorkload = require('./freeze-theme-workload.cjs');
const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { TerminalManager } = require('../.compiled/src/main/browser/terminal-manager.js');
const { ControlPlaneRuntime } = require('../.compiled/src/main/control-plane/control-plane-runtime.js');
const { DEFAULT_MAX_ARTIFACT_BYTES } = require('../.compiled/src/main/tools/artifact-store.js');
const { DEFAULT_MAX_INVOCATION_FRAME_BYTES } = require('../.compiled/src/main/session/invocation-ledger.js');
const { DEFAULT_MAX_RECEIPT_BYTES } = require('../.compiled/src/main/session/receipt-store.js');

const { makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');
const { LiquidErrorScanner } = require('../.compiled/src/main/qa/scanners/liquid-error-scanner.js');
const { PlatformDetector } = require('../.compiled/src/main/qa/scanners/platform-detector.js');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stage(label) {
  console.log(`[core-freeze] stage: ${label}`);
}

function bounded(label, promise, timeoutMs = 30_000) {
  return themeWorkload.withTimeout(label, promise, timeoutMs);
}


function parseArgs(argv) {
  const certification = argv.includes('--certification');
  const durationIndex = argv.indexOf('--duration');
  const runIndex = argv.indexOf('--run');
  const reportIndex = argv.indexOf('--report');
  const durationMinutes = durationIndex >= 0 ? Number(argv[durationIndex + 1]) : 0;
  const runNumber = runIndex >= 0 ? Number(argv[runIndex + 1]) : 0;
  const reportPath = reportIndex >= 0 ? path.resolve(argv[reportIndex + 1]) : undefined;
  if (durationIndex >= 0 && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
    throw new Error('--duration requires a finite positive number of minutes');
  }
  if (certification) {
    if (durationMinutes !== freezeCore.CERTIFICATION_DURATION_MINUTES) {
      throw new Error('Certification mode requires exactly --duration 45');
    }
    if (!Number.isInteger(runNumber) || runNumber < 1 || runNumber > 3) {
      throw new Error('Certification mode requires --run 1, 2, or 3');
    }
    if (!reportPath) throw new Error('Certification mode requires --report <path>');
  } else if (durationIndex >= 0) {
    throw new Error('--duration is reserved for exact 45-minute certification mode');
  }
  return { certification, durationMinutes, runNumber, reportPath };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function environmentFingerprint() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
  };
}

function processIdentity(metric) {
  if (!Number.isInteger(metric?.pid) || !Number.isFinite(metric?.creationTime)) return null;
  return `${metric.pid}:${metric.creationTime}`;
}

function appMetrics() {
  try {
    return app.getAppMetrics();
  } catch {
    return [];
  }
}

function countSurvivingRenderers(ownedRenderers) {
  const live = new Set(appMetrics()
    .filter((metric) => metric?.type === 'Tab')
    .map(processIdentity)
    .filter(Boolean));
  let count = 0;
  for (const identity of ownedRenderers) {
    if (live.has(identity)) count += 1;
  }
  return count;
}

function sampleProcessTree(tabHost, ownedRenderers) {
  const started = performance.now();
  const metrics = appMetrics();
  for (const metric of metrics) {
    const identity = processIdentity(metric);
    if (metric?.type === 'Tab' && identity) ownedRenderers.add(identity);
  }
  const classified = freezeCore.classifyAppMetrics(metrics);
  if (classified.totalWorkingSetBytes === 0) {
    classified.totalWorkingSetBytes = process.memoryUsage().rss;
    classified.processCount = Math.max(1, classified.processCount);
    classified.classes.browser.processCount = Math.max(1, classified.classes.browser.processCount);
    classified.classes.browser.workingSetBytes = classified.totalWorkingSetBytes;
  }
  const memory = process.memoryUsage();
  return {
    timestamp: Date.now(),
    totalWorkingSetBytes: classified.totalWorkingSetBytes,
    processCount: classified.processCount,
    classes: classified.classes,
    mainHeap: {
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    tabCount: tabHost ? tabHost.getResourceStats().tabCount : 0,
    samplerDurationMs: Number((performance.now() - started).toFixed(3)),
  };
}

function feedbackGatesPassed(gates) {
  const certificationOnly = new Set([
    'settledTotalRssGrowthMb',
    'overallTotalRssSlopeMbPerMin',
    'rendererRssSlopeMbPerMin',
  ]);
  return Object.entries(gates).every(([name, gate]) => certificationOnly.has(name) || gate.passed);
}

function storageSnapshot(tabHost) {
  const controlPlane = tabHost.getResourceStats().controlPlane;
  if (!controlPlane) throw new Error('Control-plane resource owners are unavailable');
  return {
    artifacts: { ...controlPlane.artifacts },
    receipts: { ...controlPlane.receipts },
    invocations: { ...controlPlane.invocations },
  };
}

function sumCounters(total, next) {
  total.capabilityInvocations += next.capabilityInvocations;
  total.artifactWrites += next.artifactWrites;
  total.receiptWrites += next.receiptWrites;
}

function sumCanaries(total, next) {
  total.staleAuthorityAcceptedCount += next.staleAuthorityAcceptedCount;
  total.staleDocumentAcceptedCount += next.staleDocumentAcceptedCount;
  total.staleMutationVerifiedCount += next.staleMutationVerifiedCount;
  total.falseClaimVerifiedCount += next.falseClaimVerifiedCount;
}

async function runSoak() {
  const args = parseArgs(process.argv.slice(2));
  const processStartId = `process-start-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const orchestratorTempRoot = process.env.ANTIFAN_FREEZE_TEMP_ROOT;
  const tempRoot = orchestratorTempRoot ? path.resolve(orchestratorTempRoot) : fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-core-freeze-'));
  const userDataRoot = path.join(tempRoot, 'user-data');
  app.setPath('userData', userDataRoot);

  assert.equal(freezeCore.MAX_ARTIFACT_BYTES, DEFAULT_MAX_ARTIFACT_BYTES, 'Artifact owner ceiling mismatch');
  assert.equal(freezeCore.MAX_INVOCATION_FRAME_BYTES, DEFAULT_MAX_INVOCATION_FRAME_BYTES, 'Ledger owner ceiling mismatch');
  assert.equal(freezeCore.MAX_RECEIPT_BYTES, DEFAULT_MAX_RECEIPT_BYTES, 'Receipt owner ceiling mismatch');
  const buildIdentity = process.env.ANTIFAN_FREEZE_BUILD_IDENTITY || freezeCore.sha256(
    fs.readFileSync(path.join(rootDir, '.compiled', 'src', 'main', 'browser', 'native-tab-host.js'))
  );
  const workloadCounts = args.certification
    ? themeWorkload.certificationWorkloadCounts()
    : {
        capabilityInvocations: themeWorkload.CAPABILITY_INVOCATIONS_PER_BATCH,
        artifactWrites: themeWorkload.ARTIFACT_WRITES_PER_BATCH,
        receiptWrites: themeWorkload.RECEIPT_WRITES_PER_BATCH,
      };
  const thresholdPath = process.env.ANTIFAN_FREEZE_THRESHOLD_PATH;
  const thresholdManifest = args.certification
    ? freezeCore.validateThresholdManifest(JSON.parse(fs.readFileSync(thresholdPath, 'utf8')))
    : freezeCore.buildThresholdManifest({ buildIdentity, workload: workloadCounts });
  if (thresholdManifest.buildIdentity !== buildIdentity) throw new Error('Runner build identity does not match frozen thresholds');

  const allSamples = [];
  const baselineSamples = [];
  const steadyStateSamples = [];
  const resourceSamples = [];
  const trackedPtyPids = new Set();
  const ownedRendererProcesses = new Set();
  const workloadCounters = { capabilityInvocations: 0, artifactWrites: 0, receiptWrites: 0 };
  const canaries = {
    staleAuthorityAcceptedCount: 0,
    staleDocumentAcceptedCount: 0,
    staleMutationVerifiedCount: 0,
    falseClaimVerifiedCount: 0,
    staleContextAcceptedCount: 0,
  };
  const stageResults = {};
  const unhandledErrors = [];
  let sampling = false;
  let baselineSampling = false;
  let steadySampling = false;
  let sampleTimer;
  let resourceTimer;
  let mainWindow;
  let tabHost;
  let fixture;
  let runtime;
  let session;
  let storageBaseline;
  let storageFinal;
  let teardownResources;
  let ownedOrphanProcessCount = 0;
  let sessionOutcome = 'failed';

  const onUnhandledRejection = (reason) => unhandledErrors.push(`unhandledRejection:${reason instanceof Error ? reason.message : String(reason)}`);
  const onUncaughtExceptionMonitor = (error) => unhandledErrors.push(`uncaughtException:${error.message}`);
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);

  try {
    stage('prepare fixture');
    const workspaceRoot = themeWorkload.prepareFreezeFixture(rootDir, tempRoot);
    fixture = await bounded('Start freeze fixture server', themeWorkload.startFreezeFixtureServer(workspaceRoot));
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    tabHost = new NativeTabHost(mainWindow);
    const initialTabId = tabHost.createTab(fixture.productUrl, true);
    tabHost.setAutomationTabId(initialTabId);
    const createdTabIds = [initialTabId];
    for (let index = 1; index < 4; index += 1) {
      createdTabIds.push(tabHost.createTab(`${fixture.productUrl}?tab=${index}`, false));
    }

    stage('load initial tabs');
    for (const tabId of createdTabIds) {
      tabHost.switchTab(tabId);
      await bounded(`Initial DOM readiness (${tabId})`, tabHost.getDom(undefined, tabId));
    }
    tabHost.switchTab(initialTabId);
    await wait(1000);

    stage('initialize control plane');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    runtime = new ControlPlaneRuntime({
      dataRoot: userDataRoot,
      workspaceRoot,
      projectId,
      workspaceId,
      allowEval: false,
      hostEpoch: tabHost.getBrowserEpoch(),
      getAutomationTabId: () => tabHost.getAutomationTabId(),
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
    });
    await bounded('Initialize control plane runtime', runtime.initialize());
    tabHost.setControlPlane(runtime);
    themeWorkload.createBrowserControl(rootDir, tabHost, runtime);
    session = await bounded('Create control-plane session', runtime.createCliSession({
      projectId,
      workspaceId,
      backendId: 'core-freeze-certification',
      tabId: initialTabId,
      browserEpoch: tabHost.getBrowserEpoch(),
      grant: 'write',
      ownerPid: process.pid,
    }));

    const requiredBatches = args.certification ? themeWorkload.CERTIFICATION_BATCH_COUNT : 1;
    const batchFractions = args.certification ? [0, 1 / 3, 2 / 3] : [0];
    let completedBatches = 0;
    let qaRuns = 0;
    let errorsFound = 0;
    let enduranceCycles = 0;
    const terminal = TerminalManager.getInstance();
    const runTerminalStreaming = async () => {
      const started = Date.now();
      const sessionId = terminal.createSession(os.tmpdir());
      const terminalSession = terminal.getSession(sessionId);
      if (terminalSession?.pty?.pid) trackedPtyPids.add(terminalSession.pty.pid);
      let ptyReceivedBytes = 0;
      const onTerminalData = ({ data }) => { if (data) ptyReceivedBytes += Buffer.byteLength(data, 'utf8'); };
      terminal.on('data', onTerminalData);
      try {
        terminal.writeTo(sessionId, process.platform === 'win32'
          ? '1..100 | ForEach-Object { [Console]::Out.Write("A" * 8192); Start-Sleep -Milliseconds 15 }\r\n'
          : 'for i in $(seq 1 100); do head -c 8192 /dev/zero | tr "\\0" "A"; sleep 0.015; done\r\n');
        const deadline = Date.now() + 30_000;
        while (ptyReceivedBytes < 500 * 1024 && Date.now() < deadline) await wait(100);
      } finally {
        terminal.off('data', onTerminalData);
        await bounded('Close PTY session', terminal.closeSession(sessionId), 10_000);
      }
      assert.ok(ptyReceivedBytes >= 500 * 1024, `PTY workload produced only ${ptyReceivedBytes} bytes`);
      return { status: 'completed', durationMs: Date.now() - started, ptyReceivedBytes };
    };
    const runTabThrash = async () => {
      const started = Date.now();
      tabHost.toggleSplitReview(initialTabId, true);
      await wait(500);
      let tabSwitches = 0;
      for (let index = 0; index < 20; index += 1) {
        tabHost.switchTab(createdTabIds[index % createdTabIds.length]);
        tabSwitches += 1;
        await wait(50);
      }
      tabHost.toggleSplitReview(initialTabId, false);
      tabHost.switchTab(initialTabId);
      await wait(300);
      return { status: 'completed', durationMs: Date.now() - started, tabSwitches, tabCount: createdTabIds.length };
    };


    storageBaseline = storageSnapshot(tabHost);
    stage('warm theme workload');
    const warmBatch = await themeWorkload.runThemeProbeBatch({
      runtime,
      session,
      tabHost,
      tabId: initialTabId,
      productUrl: fixture.productUrl,
      drawerUrl: fixture.drawerUrl,
      workspaceRoot,
      batchIndex: 1,
    });
    sumCounters(workloadCounters, warmBatch.counters);
    sumCanaries(canaries, warmBatch.canaries);
    completedBatches = 1;
    stageResults.warmThemeWorkload = { status: 'completed', completedBatches };
    stage('warm terminal and tab workload');
    const warmTerminalStreaming = await runTerminalStreaming();
    const warmTabThrash = await runTabThrash();
    await wait(5000);
    stageResults.warmRuntimeWorkload = {
      status: 'completed',
      settleDurationMs: 5000,
      terminalStreaming: warmTerminalStreaming,
      tabThrash: warmTabThrash,
    };


    const takeSample = () => {
      if (!sampling) return;
      const sample = sampleProcessTree(tabHost, ownedRendererProcesses);
      allSamples.push(sample);
      if (baselineSampling) baselineSamples.push(sample);
      if (steadySampling) steadyStateSamples.push(sample);
    };
    const takeResourceSample = () => {
      if (!sampling) return;
      const started = performance.now();
      resourceSamples.push({
        timestamp: Date.now(),
        resources: tabHost.getResourceStats(),
        samplerDurationMs: Number((performance.now() - started).toFixed(3)),
      });
    };
    sampling = true;
    sampleTimer = setInterval(takeSample, freezeCore.SAMPLE_INTERVAL_MS);
    resourceTimer = setInterval(takeResourceSample, freezeCore.RESOURCE_SAMPLE_INTERVAL_MS);
    takeSample();
    takeResourceSample();

    stage('warmed idle baseline');
    const baselineStart = Date.now();
    baselineSampling = true;
    await wait(5000);
    baselineSampling = false;
    stageResults.idleBaseline = { status: 'completed', durationMs: Date.now() - baselineStart, samples: baselineSamples.length };

    stage('terminal streaming');
    stageResults.terminalStreaming = await runTerminalStreaming();

    stage('tab thrash');
    stageResults.tabThrash = await runTabThrash();

    stage('theme endurance workload');
    const enduranceStart = Date.now();
    const enduranceDurationMs = args.certification ? freezeCore.CERTIFICATION_DURATION_MINUTES * 60 * 1000 : 0;
    let enduranceSwitches = 0;
    let nextSwitchAt = enduranceStart;
    let nextQaAt = enduranceStart;
    let nextSwitchIndex = 0;
    let nextQaIndex = 1;


    do {
      const elapsed = Date.now() - enduranceStart;
      while (completedBatches < requiredBatches && elapsed >= batchFractions[completedBatches] * enduranceDurationMs) {
        tabHost.switchTab(initialTabId);
        const batch = await themeWorkload.runThemeProbeBatch({
          runtime,
          session,
          tabHost,
          tabId: initialTabId,
          productUrl: fixture.productUrl,
          drawerUrl: fixture.drawerUrl,
          workspaceRoot,
          batchIndex: completedBatches + 1,
        });
        sumCounters(workloadCounters, batch.counters);
        sumCanaries(canaries, batch.canaries);
        completedBatches += 1;
      }

      const now = Date.now();
      if (now >= nextSwitchAt) {
        tabHost.switchTab(createdTabIds[nextSwitchIndex % createdTabIds.length]);
        nextSwitchIndex += 1;
        enduranceSwitches += 1;
        nextSwitchAt = now + 6000;
      }
      if (now >= nextQaAt) {
        const targetId = createdTabIds[nextQaIndex];
        const html = await bounded(`Endurance DOM readiness (${targetId})`, tabHost.getDom(undefined, targetId));
        PlatformDetector.detectFromRuntime(fixture.productUrl, html);
        const scan = LiquidErrorScanner.scanHtmlString(html);
        if (scan.hasErrors) errorsFound += scan.errors.length;
        qaRuns += 1;
        nextQaIndex = nextQaIndex >= createdTabIds.length - 1 ? 1 : nextQaIndex + 1;
        nextQaAt = now + 30_000;
      }
      enduranceCycles += 1;
      if (args.certification) await wait(100);
    } while (args.certification && Date.now() - enduranceStart < enduranceDurationMs);

    assert.equal(completedBatches, requiredBatches, 'All scheduled theme probe batches must complete');
    assert.deepEqual(workloadCounters, workloadCounts, 'Runtime workload counters must match frozen configured counts');
    canaries.staleContextAcceptedCount = canaries.staleAuthorityAcceptedCount + canaries.staleDocumentAcceptedCount + canaries.staleMutationVerifiedCount;
    stageResults.endurance = {
      status: 'completed',
      durationMs: Date.now() - enduranceStart,
      qaRuns,
      errorsFound,
      enduranceCycles,
      enduranceSwitches,
      completedBatches,
    };
    stage('steady-state quiescence');
    await wait(5000);


    stage('settled steady-state sample');
    steadySampling = true;
    await wait(5000);
    steadySampling = false;
    takeResourceSample();
    storageFinal = storageSnapshot(tabHost);
    stageResults.steadyState = { status: 'completed', settleDurationMs: 5000, samples: steadyStateSamples.length, durationMs: 5000 };

    stage('teardown');
    await bounded('Drain invocation ledger', runtime.ledger.drain());
    sessionOutcome = 'completed';
    await bounded('End control-plane session', runtime.endCliSession(session.run.id, session.attempt.id, sessionOutcome));
    await bounded('Dispose control-plane terminal', runtime.terminal.dispose());
    await bounded('Dispose singleton terminal', terminal.dispose());
    tabHost.dispose();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    await wait(250);
    teardownResources = tabHost.getResourceStats();

    const orphanPtyCount = [...trackedPtyPids].filter(isProcessAlive).length;
    let orphanRendererCount = countSurvivingRenderers(ownedRendererProcesses);
    const rendererExitDeadline = Date.now() + 5000;
    while (orphanRendererCount > 0 && Date.now() < rendererExitDeadline) {
      await wait(100);
      orphanRendererCount = countSurvivingRenderers(ownedRendererProcesses);
    }
    ownedOrphanProcessCount = orphanPtyCount + orphanRendererCount;
    sampling = false;
    clearInterval(sampleTimer);
    clearInterval(resourceTimer);

    const incompleteStageCount = Object.values(stageResults).filter((stage) => stage.status !== 'completed').length;
    const baseReport = {
      schemaVersion: freezeCore.SCHEMA_VERSION,
      type: 'antifan-core-freeze-run',
      mode: args.certification ? 'certification' : 'quick-smoke',
      durationMinutes: args.certification ? freezeCore.CERTIFICATION_DURATION_MINUTES : Number(((Date.now() - startedAt) / 60000).toFixed(3)),
      runNumber: args.certification ? args.runNumber : 0,
      processStartId,
      processPid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      buildIdentity,
      thresholdChecksum: thresholdManifest.thresholdChecksum,
      environment: environmentFingerprint(),
      sampleIntervalMs: freezeCore.SAMPLE_INTERVAL_MS,
      resourceSampleIntervalMs: freezeCore.RESOURCE_SAMPLE_INTERVAL_MS,
      samples: allSamples,
      baselineSamples,
      steadyStateSamples,
      resourceSamples,
      workloadCounters,
      stageResults,
      storageBaseline,
      storageFinal,
      canaries,
      teardown: { ownedOrphanProcessCount, resources: teardownResources },
      unhandledErrorCount: unhandledErrors.length,
      incompleteStageCount,
    };
    const evaluated = freezeCore.evaluateRunReport(baseReport, thresholdManifest);
    const feedbackPassed = feedbackGatesPassed(evaluated.gates);
    const report = {
      ...baseReport,
      metrics: evaluated.metrics,
      gates: evaluated.gates,
      passed: args.certification ? evaluated.passed : false,
      feedbackPassed: args.certification ? undefined : feedbackPassed,
      verdict: args.certification
        ? (evaluated.passed ? 'PASSED' : 'FAILED')
        : (feedbackPassed ? 'FEEDBACK_FUNCTIONAL_PASS' : 'FEEDBACK_FUNCTIONAL_FAIL'),
    };
    report.reportChecksum = freezeCore.checksumObject(report, 'reportChecksum');
    const outputPath = args.reportPath || path.join(reportsDir, 'quick-freeze-smoke-report.json');
    atomicWriteJson(outputPath, report);

    console.log(JSON.stringify({
      type: report.type,
      mode: report.mode,
      runNumber: report.runNumber,
      verdict: report.verdict,
      reportChecksum: report.reportChecksum,
      samples: report.samples.length,
      rendererSlope: report.metrics.rendererRssSlopeMbPerMin,
      totalSlope: report.metrics.overallTotalRssSlopeMbPerMin,
      settledGrowthMb: report.metrics.settledGrowthMb,
      teardownResources: freezeCore.activeResourceCount(teardownResources),
      canaries,
      workloadCounters,
      outputPath: path.relative(rootDir, outputPath).replace(/\\/g, '/'),
    }, null, 2));

    if (args.certification ? !evaluated.passed : !feedbackPassed) throw new Error(`Freeze ${report.mode} gates failed`);
    return report;
  } finally {
    sampling = false;
    clearInterval(sampleTimer);
    clearInterval(resourceTimer);
    if (runtime && session && sessionOutcome !== 'completed') {
      try { await runtime.endCliSession(session.run.id, session.attempt.id, 'failed', 'runner failed'); } catch {}
    }
    try { await runtime?.terminal?.dispose(); } catch {}
    try { await TerminalManager.getInstance().dispose(); } catch {}
    try { tabHost?.dispose(); } catch {}
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch {}
    try { await themeWorkload.closeFreezeFixtureServer(fixture?.server); } catch {}
    if (!orchestratorTempRoot) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);
  }
}

app.whenReady().then(() => runSoak()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('[core-freeze-runner] failed:', error);
    app.exit(1);
  }));
