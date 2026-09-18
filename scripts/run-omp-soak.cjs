#!/usr/bin/env node
'use strict';

/**
 * AntiFan OMP Soak Stability Runner & Acceptance Gate (P1-7)
 *
 * Runs the real Electron + Windows + OMP closed-loop harness repeatedly for a
 * configurable duration (default 30 min, --minutes N).
 *
 * Telemetry & Verification:
 *   - Samples process memory (heapUsed, RSS, heapTotal, external) each iteration
 *   - Samples artifact counts and bytes staged in ArtifactStore
 *   - Samples InvocationLedger partition WAL frames & verifies inFlightCount === 0
 *   - Samples Super Core health surface snapshot
 *   - Writes streaming JSONL telemetry report
 *   - Analyzes linear regression memory slopes (MB/min) & net resource growth
 *   - Exits 0 on stable certification, non-zero on failure or threshold breach
 *
 * Usage:
 *   node scripts/run-omp-soak.cjs --minutes 2      # Fast 2-minute proof of harness
 *   node scripts/run-omp-soak.cjs --minutes 30     # Full 30-minute soak certification
 *   node scripts/run-omp-soak.cjs --minutes 120    # Certification soak (260917-1821 phase 10)
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const reportsDir = path.join(rootDir, 'plans', '260917-1821-antifan-consolidated-remediation-soak', 'reports');

function parseArgs(argv) {
  const parsed = {
    minutes: 30, // Default 30 min
    reportPath: null,
    summaryPath: null,
    thresholdHeapGrowthMb: 80,
    thresholdRssGrowthMb: 250,
    thresholdHeapSlopeMbPerMin: 5.0,
    intervalMs: 1000,
    selfcheck: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--minutes' && argv[i + 1]) {
    } else if ((arg === '--report' || arg === '--jsonl') && argv[i + 1]) {
      parsed.reportPath = argv[++i];
    } else if (arg === '--summary' && argv[i + 1]) {
      parsed.summaryPath = argv[++i];
    } else if (arg === '--threshold-heap-growth-mb' && argv[i + 1]) {
      parsed.thresholdHeapGrowthMb = parseFloat(argv[++i]) || 80;
    } else if (arg === '--threshold-rss-growth-mb' && argv[i + 1]) {
      parsed.thresholdRssGrowthMb = parseFloat(argv[++i]) || 250;
    } else if (arg === '--threshold-heap-slope' && argv[i + 1]) {
      parsed.thresholdHeapSlopeMbPerMin = parseFloat(argv[++i]) || 5.0;
    } else if (arg === '--interval-ms' && argv[i + 1]) {
      parsed.intervalMs = parseInt(argv[++i], 10) || 1000;
    } else if (arg === '--selfcheck') {
      parsed.selfcheck = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!parsed.reportPath) {
    parsed.reportPath = path.join(reportsDir, `omp-soak-samples-${timestamp}.jsonl`);
  }
  if (!parsed.summaryPath) {
    parsed.summaryPath = path.join(reportsDir, `omp-soak-summary-${timestamp}.json`);
  }

  return parsed;
}

function calculateSlope(samples, valueSelector) {
  if (!Array.isArray(samples) || samples.length < 3) return 0;
  const firstTimestamp = samples[0]?.timestamp;
  if (!Number.isFinite(firstTimestamp)) return 0;

  const points = samples.map((sample) => ({
    minutes: (sample.timestamp - firstTimestamp) / 60000,
    value: valueSelector(sample),
  }));

  const meanTime = points.reduce((sum, p) => sum + p.minutes, 0) / points.length;
  const meanValue = points.reduce((sum, p) => sum + p.value, 0) / points.length;

  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const deltaTime = point.minutes - meanTime;
    covariance += deltaTime * (point.value - meanValue);
    variance += deltaTime * deltaTime;
  }

  if (!Number.isFinite(variance) || variance <= 0) return 0;
  return Number((covariance / variance).toFixed(3));
}

// Pure gate evaluation (phase 10 R7): every gate names the counter it guards,
// and a breached gate must exit non-zero naming that counter. Extracted so the
// --selfcheck mode can prove verdicts + exit codes over synthetic samples
// without the app or the compiled tree.
function evaluateGates(samples, exitCode, args) {
  const firstSample = samples[0];
  const lastSample = samples[samples.length - 1];

  const heapValues = samples.map((s) => s.memory.heapUsedMb);
  const rssValues = samples.map((s) => s.memory.rssMb);

  const initialHeapMb = firstSample.memory.heapUsedMb;
  const finalHeapMb = lastSample.memory.heapUsedMb;
  const peakHeapMb = Math.max(...heapValues);
  const netHeapGrowthMb = Number((finalHeapMb - initialHeapMb).toFixed(2));

  const initialRssMb = firstSample.memory.rssMb;
  const finalRssMb = lastSample.memory.rssMb;
  const peakRssMb = Math.max(...rssValues);
  const netRssGrowthMb = Number((finalRssMb - initialRssMb).toFixed(2));

  const heapSlopeMbPerMin = calculateSlope(samples, (s) => s.memory.heapUsedMb);
  const rssSlopeMbPerMin = calculateSlope(samples, (s) => s.memory.rssMb);

  // Final-30-minute window slope (phase 10 R5.6): a leak that starts late is
  // diluted by the whole-window slope, so the tail window is reported beside it.
  const finalWindowStart = lastSample.timestamp - 30 * 60 * 1000;
  const finalWindowSamples = samples.filter((s) => s.timestamp >= finalWindowStart);
  const final30mHeapSlopeMbPerMin = calculateSlope(finalWindowSamples, (s) => s.memory.heapUsedMb);
  const final30mRssSlopeMbPerMin = calculateSlope(finalWindowSamples, (s) => s.memory.rssMb);

  const failedIterations = samples.filter((s) => s.status !== 'PASS').length;
  const leakedInFlight = samples.filter((s) => s.ledger.inFlightCount > 0).length;

  const gates = {
    childExitCodeZero: { passed: exitCode === 0, detail: `Exit code: ${exitCode}` },
    zeroFailedIterations: { passed: failedIterations === 0, detail: `Failed: ${failedIterations} / ${samples.length}` },
    zeroLeakedFlights: { passed: leakedInFlight === 0, detail: `Leaked flights observed: ${leakedInFlight}` },
    heapGrowthWithinLimit: {
      passed: netHeapGrowthMb <= args.thresholdHeapGrowthMb,
      detail: `Net heap growth: ${netHeapGrowthMb} MB (limit: ${args.thresholdHeapGrowthMb} MB)`,
    },
    rssGrowthWithinLimit: {
      passed: netRssGrowthMb <= args.thresholdRssGrowthMb,
      detail: `Net RSS growth: ${netRssGrowthMb} MB (limit: ${args.thresholdRssGrowthMb} MB)`,
    },
    heapSlopeWithinLimit: {
      passed: heapSlopeMbPerMin <= args.thresholdHeapSlopeMbPerMin,
      detail: `Heap slope: ${heapSlopeMbPerMin} MB/min (limit: ${args.thresholdHeapSlopeMbPerMin} MB/min)`,
    },
  };

  const allPassed = Object.values(gates).every((g) => g.passed);
  const failedGateNames = Object.entries(gates).filter(([, g]) => !g.passed).map(([name]) => name);

  return {
    gates,
    allPassed,
    failedGateNames,
    metrics: {
      initialHeapMb,
      finalHeapMb,
      peakHeapMb,
      netHeapGrowthMb,
      heapSlopeMbPerMin,
      final30mHeapSlopeMbPerMin,
      initialRssMb,
      finalRssMb,
      peakRssMb,
      netRssGrowthMb,
      rssSlopeMbPerMin,
      final30mRssSlopeMbPerMin,
    },
    counters: { failedIterations, leakedInFlight },
  };
}

// Offline self-check (phase 10 R7 acceptance): drives the fixture's expectation
// model and this runner's gate evaluation over synthetic results — one success,
// one refused-where-success-expected, one refused-where-refused-expected, one
// missing-refusal — and proves the verdicts and exit codes are right without
// the app or the compiled tree.
function runSelfCheck() {
  const assert = require('node:assert/strict');
  const { evaluateProbeOutcome, describeToolResult } = require('./smoke-omp-closed-loop.cjs');

  const results = [];
  const record = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
      console.log(`  [FAIL] ${name}: ${results[results.length - 1].detail}`);
    }
  };

  // 1. success expected + success arrived -> pass
  record('expectation: success expected, call succeeded', () => {
    const v = evaluateProbeOutcome('success', { ok: true, code: null, text: '' });
    assert.equal(v.pass, true, `expected pass, got ${JSON.stringify(v)}`);
  });

  // 2. success expected + refusal arrived -> fail (the vacuous-pass hole)
  record('expectation: success expected, call refused', () => {
    const v = evaluateProbeOutcome('success', { ok: false, code: 'TARGET_BUSY_DRAINING', text: 'draining' });
    assert.equal(v.pass, false, 'refused call must fail a success expectation');
  });

  // 3. refused:<CODE> expected + that refusal arrived -> pass
  record('expectation: refused:TARGET_MISMATCH expected and arrived', () => {
    const v = evaluateProbeOutcome('refused:TARGET_MISMATCH', { ok: false, code: 'TARGET_MISMATCH', text: 'foreign tab' });
    assert.equal(v.pass, true, `expected pass, got ${JSON.stringify(v)}`);
  });

  // 4. refused:<CODE> expected + call succeeded (missing refusal) -> fail
  record('expectation: refused expected, call succeeded (missing refusal)', () => {
    const v = evaluateProbeOutcome('refused:TARGET_MISMATCH', { ok: true, code: null, text: '' });
    assert.equal(v.pass, false, 'a missing refusal must fail the iteration');
  });

  // 5. refused:<CODE> expected + wrong code arrived -> fail
  record('expectation: refused:TARGET_MISMATCH expected, got NO_RENDER_SURFACE', () => {
    const v = evaluateProbeOutcome('refused:TARGET_MISMATCH', { ok: false, code: 'NO_RENDER_SURFACE', text: 'no surface' });
    assert.equal(v.pass, false, 'a refusal with the wrong code must fail');
  });

  // 6. describeToolResult extracts the typed code from a `CODE: message` string
  record('describeToolResult: CODE-prefixed refusal text', () => {
    const outcome = describeToolResult({
      result: { isError: true, content: [{ type: 'text', text: 'TARGET_MISMATCH: tab not owned' }] },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'TARGET_MISMATCH');
  });

  // 7. describeToolResult extracts the typed code from a JSON envelope
  record('describeToolResult: JSON envelope refusal', () => {
    const outcome = describeToolResult({
      result: { isError: true, content: [{ type: 'text', text: '{"code":"TARGET_BUSY_DRAINING","message":"draining"}' }] },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'TARGET_BUSY_DRAINING');
  });

  // 8. describeToolResult: a thrown/timed-out call is a failure, never a pass
  record('describeToolResult: RPC-level error', () => {
    const outcome = describeToolResult({ error: 'timed out' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'RPC_ERROR');
  });

  // Gate evaluation over synthetic samples: a clean window must pass, a window
  // with a failed sample must fail and name zeroFailedIterations.
  const mkSample = (i, status) => ({
    iteration: i,
    timestamp: 1000 + i * 1000,
    status,
    memory: { heapUsedMb: 100, rssMb: 200 },
    ledger: { inFlightCount: 0, frameCount: 2 + i },
    artifacts: { count: 1 + i, storedBytes: 1000 },
    health: { status: 'ok' },
  });
  const gateArgs = { thresholdHeapGrowthMb: 80, thresholdRssGrowthMb: 250, thresholdHeapSlopeMbPerMin: 5.0 };

  record('gates: clean window passes and exits 0', () => {
    const evalResult = evaluateGates([mkSample(1, 'PASS'), mkSample(2, 'PASS'), mkSample(3, 'PASS')], 0, gateArgs);
    assert.equal(evalResult.allPassed, true, `expected all gates passed, failed: ${evalResult.failedGateNames.join(',')}`);
  });

  record('gates: failed sample fails zeroFailedIterations and names it', () => {
    const evalResult = evaluateGates([mkSample(1, 'PASS'), mkSample(2, 'FAIL'), mkSample(3, 'PASS')], 0, gateArgs);
    assert.equal(evalResult.allPassed, false);
    assert.ok(evalResult.failedGateNames.includes('zeroFailedIterations'), `expected zeroFailedIterations in ${evalResult.failedGateNames}`);
  });

  record('gates: non-zero child exit fails childExitCodeZero', () => {
    const evalResult = evaluateGates([mkSample(1, 'PASS'), mkSample(2, 'PASS'), mkSample(3, 'PASS')], 1, gateArgs);
    assert.equal(evalResult.allPassed, false);
    assert.ok(evalResult.failedGateNames.includes('childExitCodeZero'));
  });

  record('gates: leaked in-flight fails zeroLeakedFlights', () => {
    const leaked = mkSample(2, 'PASS');
    leaked.ledger.inFlightCount = 1;
    const evalResult = evaluateGates([mkSample(1, 'PASS'), leaked, mkSample(3, 'PASS')], 0, gateArgs);
    assert.equal(evalResult.allPassed, false);
    assert.ok(evalResult.failedGateNames.includes('zeroLeakedFlights'));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[Soak-Runner SelfCheck] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`[Soak-Runner SelfCheck] FAILED checks: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
AntiFan OMP Soak Stability Runner (P1-7 Gate)

Options:
  --minutes <N>                     Duration in minutes to run soak (default: 30)
  --interval-ms <N>                 Delay between iterations in ms (default: 1000)
  --report, --jsonl <path>          JSONL file path for iteration telemetry samples
                                    (default: plans/260917-1821-antifan-consolidated-remediation-soak/reports/)
  --summary <path>                  JSON file path for certification summary
                                    (default: plans/260917-1821-antifan-consolidated-remediation-soak/reports/)
  --threshold-heap-growth-mb <N>    Maximum allowable net heap growth in MB (default: 80)
  --threshold-rss-growth-mb <N>     Maximum allowable net RSS growth in MB (default: 250)
  --threshold-heap-slope <N>        Maximum allowable heap slope in MB/min (default: 5.0)
  --selfcheck                       Offline proof of the expectation + gate logic
                                    over synthetic results; no app, no compiled tree
  --help, -h                        Show this help text
`);
    process.exit(0);
  }

  if (args.selfcheck) {
    runSelfCheck();
    return;
  }

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(args.reportPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(args.summaryPath)), { recursive: true });

  console.log('================================================================');
  console.log('  AntiFan OMP Soak Stability Certification Harness (P1-7 Gate)  ');
  console.log('================================================================');
  console.log(`Target Duration:      ${args.minutes} minute(s) (${args.minutes * 60} seconds)`);
  console.log(`Iteration Interval:   ${args.intervalMs} ms`);
  console.log(`Telemetry Report:     ${args.reportPath}`);
  console.log(`Certification File:   ${args.summaryPath}`);
  console.log('Stability Thresholds:');
  console.log(`  - Max Net Heap Growth:   <= ${args.thresholdHeapGrowthMb} MB`);
  console.log(`  - Max Net RSS Growth:    <= ${args.thresholdRssGrowthMb} MB`);
  console.log(`  - Max Heap Slope:        <= ${args.thresholdHeapSlopeMbPerMin} MB/min`);
  console.log('  - In-Flight Flight Leak: 0 allowed');
  console.log('  - Failed Iterations:     0 allowed');
  console.log('================================================================\n');

  const runElectronScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
  const closedLoopScript = path.join(rootDir, 'scripts', 'smoke-omp-closed-loop.cjs');

  const childArgs = [
    runElectronScript,
    closedLoopScript,
    '--soak',
    '--minutes',
    String(args.minutes),
    '--interval-ms',
    String(args.intervalMs),
    '--jsonl',
    args.reportPath,
    '--report',
    args.summaryPath,
  ];

  console.log(`[Soak-Runner] Spawning Electron closed-loop soak child...`);
  const soakStartTime = Date.now();

  const child = spawn(process.execPath, childArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code !== null ? code : (signal ? 1 : 0));
    });
    child.on('error', (err) => {
      console.error('[Soak-Runner] Child process spawn error:', err);
      resolve(1);
    });
  });

  const totalElapsedMs = Date.now() - soakStartTime;
  console.log(`\n[Soak-Runner] Child exited with code ${exitCode} after ${(totalElapsedMs / 1000).toFixed(1)}s`);

  // Post-run evaluation of JSONL telemetry
  if (!fs.existsSync(args.reportPath)) {
    console.error(`[Soak-Runner] FAIL: Telemetry file was not generated: ${args.reportPath}`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(args.reportPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const samples = [];
  for (const line of rawLines) {
    try {
      samples.push(JSON.parse(line));
    } catch {}
  }

  if (samples.length === 0) {
    console.error(`[Soak-Runner] FAIL: Zero telemetry samples recorded in: ${args.reportPath}`);
    process.exit(1);
  }

  const lastSample = samples[samples.length - 1];

  const evaluation = evaluateGates(samples, exitCode, args);
  const { gates, allPassed, failedGateNames, metrics: gateMetrics } = evaluation;
  const {
    initialHeapMb,
    finalHeapMb,
    peakHeapMb,
    netHeapGrowthMb,
    heapSlopeMbPerMin,
    final30mHeapSlopeMbPerMin,
    initialRssMb,
    finalRssMb,
    peakRssMb,
    netRssGrowthMb,
    rssSlopeMbPerMin,
    final30mRssSlopeMbPerMin,
  } = gateMetrics;
  const { leakedInFlight } = evaluation.counters;

  const verdict = allPassed ? 'PASS' : 'FAIL';

  const finalCertification = {
    verdict,
    timestamp: new Date().toISOString(),
    configuration: {
      requestedMinutes: args.minutes,
      actualDurationSeconds: Number((totalElapsedMs / 1000).toFixed(1)),
      samplesRecorded: samples.length,
      thresholds: {
        maxHeapGrowthMb: args.thresholdHeapGrowthMb,
        maxRssGrowthMb: args.thresholdRssGrowthMb,
        maxHeapSlopeMbPerMin: args.thresholdHeapSlopeMbPerMin,
      },
    },
    metrics: {
      iterationsCompleted: samples.length,
      meanIterationDurationMs: Number((totalElapsedMs / samples.length).toFixed(1)),
      memory: {
        initialHeapMb,
        finalHeapMb,
        peakHeapMb,
        netHeapGrowthMb,
        heapSlopeMbPerMin,
        final30mHeapSlopeMbPerMin,
        initialRssMb,
        finalRssMb,
        peakRssMb,
        netRssGrowthMb,
        rssSlopeMbPerMin,
        final30mRssSlopeMbPerMin,
      },
      resources: {
        totalArtifactsStored: lastSample.artifacts.count,
        finalLedgerFrameCount: lastSample.ledger.frameCount,
        leakedInFlightCount: leakedInFlight,
      },
      health: {
        finalStatus: lastSample.health.status,
      },
    },
    gates,
  };

  fs.writeFileSync(args.summaryPath, JSON.stringify(finalCertification, null, 2), 'utf8');

  console.log('\n================================================================');
  console.log(`               OMP SOAK VERIFICATION: ${verdict}                `);
  console.log('================================================================');
  console.log(`Iterations:        ${samples.length} cycles completed`);
  console.log(`Elapsed Time:      ${(totalElapsedMs / 1000).toFixed(1)}s (${(totalElapsedMs / 60000).toFixed(2)} min)`);
  console.log(`Mean Cycle Time:   ${finalCertification.metrics.meanIterationDurationMs} ms`);
  console.log('Memory Performance:');
  console.log(`  - Heap: Initial=${initialHeapMb}MB | Peak=${peakHeapMb}MB | Final=${finalHeapMb}MB | Delta=${netHeapGrowthMb >= 0 ? '+' : ''}${netHeapGrowthMb}MB | Slope=${heapSlopeMbPerMin}MB/min | Final30mSlope=${final30mHeapSlopeMbPerMin}MB/min`);
  console.log(`  - RSS:  Initial=${initialRssMb}MB | Peak=${peakRssMb}MB | Final=${finalRssMb}MB | Delta=${netRssGrowthMb >= 0 ? '+' : ''}${netRssGrowthMb}MB | Slope=${rssSlopeMbPerMin}MB/min | Final30mSlope=${final30mRssSlopeMbPerMin}MB/min`);
  console.log('Stability Gates:');
  for (const [name, gate] of Object.entries(gates)) {
    console.log(`  - [${gate.passed ? 'PASS' : 'FAIL'}] ${name}: ${gate.detail}`);
  }
  console.log('================================================================');
  console.log(`Artifacts Staged:  ${lastSample.artifacts.count} artifacts verified`);
  console.log(`Telemetry Report:  ${args.reportPath}`);
  console.log(`Summary Report:    ${args.summaryPath}`);
  console.log('================================================================\n');

  console.log('To run the full 30-minute soak certification, execute:');
  console.log('  node scripts/run-omp-soak.cjs --minutes 30\n');
  console.log('To run the plan certification soak (120 minutes), execute:');
  console.log('  node scripts/run-omp-soak.cjs --minutes 120\n');

  if (!allPassed) {
    console.error(`[Soak-Runner] Soak certification FAILED gates: ${failedGateNames.join(', ')}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[Soak-Runner Fatal]', err);
  process.exit(1);
});
