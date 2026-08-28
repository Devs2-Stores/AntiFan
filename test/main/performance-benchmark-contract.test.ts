import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BENCHMARK_LINE_PREFIX,
  isBenchmarkEnabled,
  recordBenchmark,
  parseBenchmarkLine,
  startEventLoopDelayMonitor,
  type BenchmarkMetric,
} from '../../src/main/benchmark/telemetry';

const REAL_ENV = process.env.ANTIFAN_BENCHMARK;

function setBenchmarkMode(value: string | undefined): void {
  if (value === undefined) delete process.env.ANTIFAN_BENCHMARK;
  else process.env.ANTIFAN_BENCHMARK = value;
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, restore: () => { console.log = original; } };
}

describe('Benchmark telemetry contract (Phase 1)', () => {
  beforeEach(() => {
    setBenchmarkMode('0');
  });
  afterEach(() => {
    setBenchmarkMode(REAL_ENV);
  });

  it('is disabled unless ANTIFAN_BENCHMARK=1 or --benchmark is present', () => {
    setBenchmarkMode(undefined);
    const args = process.argv.slice();
    process.argv = [nodeBin(), '-e', 'void 0'];
    try {
      assert.strictEqual(isBenchmarkEnabled(), false);
    } finally {
      process.argv = args;
    }
    setBenchmarkMode('1');
    assert.strictEqual(isBenchmarkEnabled(), true);
  });

  it('recordBenchmark emits nothing in disabled mode', () => {
    setBenchmarkMode('0');
    const { lines, restore } = captureLog();
    recordBenchmark({ surface: 'startup', name: 'bootstrap', value: 1 });
    restore();
    assert.strictEqual(lines.length, 0);
  });

  it('emits one prefix-tagged JSON line with required schema fields in enabled mode', () => {
    setBenchmarkMode('1');
    const { lines, restore } = captureLog();
    recordBenchmark({ surface: 'tabs', name: 'switched', value: 12.5, extra: { attachedViews: 1 } });
    restore();
    assert.strictEqual(lines.length, 1);
    const line = lines[0]!;
    assert.ok(line.startsWith(`${BENCHMARK_LINE_PREFIX} `), 'line carries the benchmark prefix');
    const parsed = parseBenchmarkLine(line);
    assert.ok(parsed, 'line parses to a metric');
    assert.strictEqual(parsed.surface, 'tabs');
    assert.strictEqual(parsed.name, 'switched');
    assert.strictEqual(parsed.value, 12.5);
    assert.strictEqual(parsed.extra?.attachedViews, 1);
    assert.strictEqual(typeof parsed.ts, 'string');
    assert.ok(Number.isFinite(parsed.nowMs), 'nowMs is a finite number');
  });

  it('rejects NaN/Infinity values instead of emitting a guessed number', () => {
    setBenchmarkMode('1');
    const { lines, restore } = captureLog();
    recordBenchmark({ surface: 'artifact', name: 'stage', value: Number.NaN });
    recordBenchmark({ surface: 'artifact', name: 'stage', value: Number.POSITIVE_INFINITY });
    recordBenchmark({ surface: 'artifact', name: 'stage', value: 3 });
    restore();
    assert.strictEqual(lines.length, 1, 'only the valid metric is emitted');
    const [parsed] = lines.map(parseBenchmarkLine);
    assert.strictEqual(parsed?.value, 3);
    assert.strictEqual(
      parseBenchmarkLine(`${BENCHMARK_LINE_PREFIX} ${JSON.stringify({ surface: 'artifact', name: 'stage', value: Number.NaN })}`),
      null,
      'a line carrying a NaN value is rejected rather than trusted'
    );
  });

  it('parseBenchmarkLine returns null for missing data instead of fabricating a value', () => {
    assert.strictEqual(parseBenchmarkLine(''), null);
    assert.strictEqual(parseBenchmarkLine('[antifan-benchmark] not json'), null);
    assert.strictEqual(parseBenchmarkLine('plain console line'), null);
    assert.strictEqual(parseBenchmarkLine(`${BENCHMARK_LINE_PREFIX} {"surface":123}`), null);
    assert.strictEqual(parseBenchmarkLine(`${BENCHMARK_LINE_PREFIX} {"surface":"a"}`), null); // missing name
    assert.strictEqual(parseBenchmarkLine(`${BENCHMARK_LINE_PREFIX} {"surface":"a","name":"b","nowMs":"x"}`), null);
    assert.strictEqual(parseBenchmarkLine(`${BENCHMARK_LINE_PREFIX} {"surface":"a","name":"b","ts":"not-a-date"}`), null);
  });

  it('round-trips a metric with string value and extra context', () => {
    const metric: BenchmarkMetric = { surface: 'process', name: 'afterFirstVisible', extra: { mainRssKB: 42 } };
    const line = `${BENCHMARK_LINE_PREFIX} ${JSON.stringify({ ...metric, ts: new Date().toISOString(), nowMs: 7 })}`;
    const parsed = parseBenchmarkLine(line);
    assert.ok(parsed);
    assert.strictEqual(parsed.surface, 'process');
    assert.strictEqual(parsed.name, 'afterFirstVisible');
    assert.strictEqual(parsed.extra?.mainRssKB, 42);
    assert.strictEqual(parsed.nowMs, 7);
  });

  it('startEventLoopDelayMonitor returns null when disabled', () => {
    setBenchmarkMode('0');
    assert.strictEqual(startEventLoopDelayMonitor(), null);
  });

  it('enabled monitor returns a stop function and records bounded aggregate samples', () => {
    setBenchmarkMode('1');
    const { lines, restore } = captureLog();
    const stop = startEventLoopDelayMonitor();
    assert.strictEqual(typeof stop, 'function');
    stop!();
    restore();
    const delayMetrics = lines.map(parseBenchmarkLine).filter((m): m is NonNullable<typeof m> => m !== null && m.surface === 'event-loop' && m.name === 'delaySamples');
    assert.strictEqual(delayMetrics.length, 1, 'stop flushes one aggregate metric');
    const samples = delayMetrics[0]!.extra?.samples as Array<{ t: number; p50: number; p95: number; max: number }>;
    assert.ok(Array.isArray(samples), 'samples is an array');
    for (const s of samples) {
      assert.strictEqual(typeof s.t, 'number');
      assert.strictEqual(typeof s.p50, 'number');
      assert.strictEqual(typeof s.p95, 'number');
      assert.strictEqual(typeof s.max, 'number');
    }
  });
});

function nodeBin(): string {
  return process.execPath;
}