/**
 * AntiFan Benchmark Telemetry (Phase 1 — baseline instrumentation).
 *
 * Every hook is disabled unless `ANTIFAN_BENCHMARK=1` or `--benchmark` is
 * present in argv. When disabled the module is a no-op: no event-loop monitor,
 * no stdout lines, no payload mutation. When enabled it emits one JSON line per
 * metric on stdout with a stable token prefix so the harness
 * (`scripts/benchmark-electron-performance.mjs`) can parse it without touching
 * application log output.
 *
 * Invariants (plan Phase 1):
 * - Never decodes a payload for measurement purposes.
 * - Never alters public payloads or event ordering.
 * - NaN/Infinity values are rejected at emission time (schema contract).
 * - A missing measurement is omitted, never guessed.
 */
import { performance } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const BENCHMARK_LINE_PREFIX = '[antifan-benchmark]';

/**
 * Benchmark mode is opt-in via env var or explicit argv flag.
 *
 * This is read on hot paths (every PTY chunk, every bridge frame), so the
 * expensive part — scanning argv — is resolved once at module load: process
 * arguments cannot change after start.
 *
 * The env var is deliberately NOT cached. It is a runtime-mutable surface (test
 * harnesses and embedding code flip it mid-process), and the module contract is
 * that `isBenchmarkEnabled()` reports the current mode. A frozen env snapshot
 * silently ignored later changes, which is why the contract test rejects it.
 */
const argvRequestsBenchmark = process.argv.includes('--benchmark');
export function isBenchmarkEnabled(): boolean {
  return process.env.ANTIFAN_BENCHMARK === '1' || argvRequestsBenchmark;
}

/**
 * Opt-out for the benchmark-mode window guard below. A value of exactly `1`
 * restores normal close semantics; anything else (including unset) keeps the
 * guard on.
 */
export const BENCHMARK_ALLOW_WINDOW_CLOSE_ENV = 'ANTIFAN_BENCHMARK_ALLOW_WINDOW_CLOSE';

/**
 * Whether the main window's close must be refused because a benchmark run owns it.
 *
 * In benchmark mode the app is a measurement, not a session someone is using:
 * `window-all-closed` quits (src/main/index.ts) and the main window's `closed`
 * quits with it, so one stray close — an ALT+F4, a taskbar close, another
 * window manager — ends a multi-hour run and takes every tab the run was
 * measuring with it. Two runs were lost exactly there before this guard.
 *
 * Nothing legitimate depends on closing it: the soak harness ends the app with
 * a process-tree kill, which no window handler can veto.
 */
export function refusesWindowClose(): boolean {
  if (!isBenchmarkEnabled()) return false;
  return process.env[BENCHMARK_ALLOW_WINDOW_CLOSE_ENV] !== '1';
}

export interface BenchmarkMetric {
  /** scenario/surface name, e.g. 'startup', 'tabs', 'terminal', 'bridge', 'artifact' */
  surface: string;
  /** metric name, e.g. 'firstVisible', 'switched', 'ptyData', 'broadcast', 'stage' */
  name: string;
  /** numeric observation; omit rather than guess */
  value?: number;
  /** string observation (label, mode, status) when value is not numeric */
  stringValue?: string;
  /** ISO timestamp of emission */
  ts?: string;
  /** monotonic ms since process start */
  nowMs?: number;
  /** bounded extra context; must be JSON-serializable and small */
  extra?: Record<string, unknown>;
}

function isValidMetric(metric: BenchmarkMetric): boolean {
  if (!metric || typeof metric !== 'object') return false;
  if (typeof metric.surface !== 'string' || metric.surface.length === 0) return false;
  if (typeof metric.name !== 'string' || metric.name.length === 0) return false;
  if (metric.value !== undefined && (typeof metric.value !== 'number' || !Number.isFinite(metric.value))) return false;
  if (metric.stringValue !== undefined && typeof metric.stringValue !== 'string') return false;
  return true;
}

/** Emits one metric line when benchmark mode is enabled. Never throws. */
export function recordBenchmark(metric: BenchmarkMetric): void {
  if (!isBenchmarkEnabled()) return;
  try {
    if (!isValidMetric(metric)) return;
    const line: BenchmarkMetric = {
      ...metric,
      ts: metric.ts ?? new Date().toISOString(),
      nowMs: metric.nowMs ?? performance.now(),
    };
    console.log(`${BENCHMARK_LINE_PREFIX} ${JSON.stringify(line)}`);
  } catch {
    /* telemetry must never break the app */
  }
}

/**
 * Parses and validates one benchmark line. Returns the normalized metric, or
 * null when the line is not benchmark output or fails the schema contract
 * (missing surface/name, non-finite value, malformed JSON). Missing data is
 * represented by null, never by a guessed value.
 */
export function parseBenchmarkLine(line: string): BenchmarkMetric | null {
  if (typeof line !== 'string') return null;
  if (!line.startsWith(`${BENCHMARK_LINE_PREFIX} `)) return null;
  const json = line.slice(BENCHMARK_LINE_PREFIX.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const metric = parsed as BenchmarkMetric;
  if (!isValidMetric(metric)) return null;
  if (typeof metric.ts === 'string' && Number.isNaN(Date.parse(metric.ts))) return null;
  if (metric.nowMs !== undefined && (typeof metric.nowMs !== 'number' || !Number.isFinite(metric.nowMs))) return null;
  return metric;
}

/**
 * Samples event-loop delay while enabled. Returns a stop function (or null in
 * normal mode). The stop function flushes the final sample and emits one
 * aggregate metric containing all samples; samples are bounded by the same
 * 1s window and are reset after each tick so the series stays finite.
 */
export function startEventLoopDelayMonitor(): (() => void) | null {
  if (!isBenchmarkEnabled()) return null;
  const monitor = monitorEventLoopDelay({ resolution: 20 });
  monitor.enable();
  const samples: Array<{ t: number; p50: number; p95: number; max: number }> = [];
  const timer = setInterval(() => {
    samples.push({
      t: Date.now(),
      p50: monitor.percentile(50),
      p95: monitor.percentile(95),
      max: monitor.max,
    });
    monitor.reset();
  }, 1000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    samples.push({
      t: Date.now(),
      p50: monitor.percentile(50),
      p95: monitor.percentile(95),
      max: monitor.max,
    });
    monitor.disable();
    recordBenchmark({
      surface: 'event-loop',
      name: 'delaySamples',
      value: samples.length,
      extra: { samples },
    });
  };
}