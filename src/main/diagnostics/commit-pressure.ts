/**
 * System commit pressure watch (Windows only).
 *
 * Every terminal lives in one daemon process. When Windows runs out of commit (RAM + pagefiles), the
 * next allocation anywhere fails, and a Chromium-based process ends itself on that (0xe0000008 at
 * KERNELBASE). On 02/11/2026 that happened three times; twice the process that died was the terminal
 * daemon, and every agent terminal went with it. The watch says so while the user can still close
 * something, instead of leaving the evidence to the next morning's event log.
 *
 * Headroom is measured against the commit limit the pagefiles can grow to, not the current limit: a
 * system-managed pagefile grows only when the charge reaches the limit, so "current limit minus charge"
 * is routinely near zero on a machine that still has tens of gigabytes to go.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** One faster-whisper medium run commits ~5 GB; below this, one more such job ends someone. */
export const COMMIT_ALARM_HEADROOM_BYTES = 4 * GIB;
/** Cleared only well above the alarm line, so a charge hovering at the line does not flap. */
export const COMMIT_CLEAR_HEADROOM_BYTES = 8 * GIB;
/** Consecutive low samples before the alarm: a single spike that the system absorbs is not news. */
export const COMMIT_ALARM_STREAK = 2;
export const COMMIT_SAMPLE_INTERVAL_MS = 10_000;

const MEMORY_MANAGEMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management';

export interface PagefileSpec {
  /** Drive letter, upper case; `?` is Windows' automatic placement on the system drive. */
  drive: string;
  /** Configured maximum, or 'system' for a system-managed size (`0 0` or no sizes). */
  maxBytes: number | 'system';
}

/** Entries of `reg query <Memory Management> /v PagingFiles` (REG_MULTI_SZ, `\0`-separated). */
export function parsePagingFiles(regOutput: string): PagefileSpec[] {
  const line = regOutput.split(/\r?\n/).find((l) => /\bPagingFiles\b/.test(l) && /REG_MULTI_SZ/.test(l));
  if (!line) return [];
  const value = line.slice(line.indexOf('REG_MULTI_SZ') + 'REG_MULTI_SZ'.length).trim();
  const specs: PagefileSpec[] = [];
  for (const entry of value.split('\\0')) {
    const m = /^([A-Za-z?]):\\\S+(?:\s+(\d+)\s+(\d+))?\s*$/.exec(entry.trim());
    if (!m?.[1]) continue;
    const max = m[3] ? Number(m[3]) : 0;
    specs.push({ drive: m[1].toUpperCase(), maxBytes: max > 0 ? max * MIB : 'system' });
  }
  return specs;
}

/**
 * The commit limit the configured pagefiles can reach. A system-managed pagefile tops out at
 * max(3 x RAM, 4 GiB), capped at one eighth of its volume (on this machine: 259 GB C: -> 32.4 GB,
 * which is exactly the 48.3 GB limit Windows reported with 15.9 GB of RAM).
 */
export function maxCommitBytes(ramBytes: number, specs: PagefileSpec[], volumeBytes: (drive: string) => number): number {
  let total = ramBytes;
  for (const spec of specs) {
    total += spec.maxBytes === 'system'
      ? Math.min(Math.max(3 * ramBytes, 4 * GIB), volumeBytes(spec.drive) / 8)
      : spec.maxBytes;
  }
  return total;
}

export interface CommitPressureState {
  alarmed: boolean;
  lowStreak: number;
}

export const INITIAL_COMMIT_PRESSURE: CommitPressureState = { alarmed: false, lowStreak: 0 };

/** One sample through the alarm/clear hysteresis. */
export function stepCommitPressure(
  state: CommitPressureState,
  headroomBytes: number
): { state: CommitPressureState; transition: 'alarm' | 'clear' | null } {
  if (state.alarmed) {
    return headroomBytes >= COMMIT_CLEAR_HEADROOM_BYTES
      ? { state: { alarmed: false, lowStreak: 0 }, transition: 'clear' }
      : { state, transition: null };
  }
  const lowStreak = headroomBytes < COMMIT_ALARM_HEADROOM_BYTES ? state.lowStreak + 1 : 0;
  return lowStreak >= COMMIT_ALARM_STREAK
    ? { state: { alarmed: true, lowStreak: 0 }, transition: 'alarm' }
    : { state: { alarmed: false, lowStreak }, transition: null };
}

export interface CommitReading {
  chargeBytes: number;
  limitBytes: number;
  maxLimitBytes: number;
  headroomBytes: number;
}

/** Electron's process.getSystemMemoryInfo(), in KiB; on Windows swapTotal/swapFree are the commit limit/available. */
export interface SystemMemoryInfoKb {
  total: number;
  swapTotal?: number;
  swapFree?: number;
}

export interface CommitPressureWatchOptions {
  readMemory: () => SystemMemoryInfoKb;
  onAlarm: (reading: CommitReading) => void;
  onClear: (reading: CommitReading) => void;
  onUnavailable: (detail: string) => void;
  /** Every reading, after the hysteresis has seen it; `alarmed` is the state that step left. */
  onSample?: (reading: CommitReading, alarmed: boolean) => void;
}

/**
 * Name of the file in the runtime dir that carries the latest reading to processes outside Main:
 * a Leader's `leader-job.mjs dispatch` reads it before starting another agent session.
 */
export const COMMIT_PRESSURE_STATE_FILE = 'commit-pressure.json';

/**
 * The state file's body. `floorBytes` is the headroom below which starting more work is refused;
 * it is the alarm's clear line, so the reader never carries a threshold of its own.
 */
export function commitPressureStateBody(reading: CommitReading, alarmed: boolean, at: number): string {
  return `${JSON.stringify({
    schema: 1,
    at,
    chargeBytes: reading.chargeBytes,
    maxLimitBytes: reading.maxLimitBytes,
    headroomBytes: reading.headroomBytes,
    floorBytes: COMMIT_CLEAR_HEADROOM_BYTES,
    alarmed,
  })}\n`;
}

function readPagingFiles(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile('reg.exe', ['query', MEMORY_MANAGEMENT_KEY, '/v', 'PagingFiles'],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
    (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  return promise;
}

function volumeBytes(drive: string): number {
  const letter = drive === '?' ? (process.env.SystemDrive || 'C:').charAt(0) : drive;
  const stat = fs.statfsSync(`${letter}:\\`);
  return stat.blocks * stat.bsize;
}

/** Starts sampling; returns a stop function. A no-op off Windows, where swap is not commit. */
export function startCommitPressureWatch(options: CommitPressureWatchOptions): () => void {
  if (process.platform !== 'win32') return () => {};
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let state = INITIAL_COMMIT_PRESSURE;

  void readPagingFiles().then((output) => {
    if (stopped) return;
    const specs = parsePagingFiles(output);
    if (specs.length === 0) {
      // No pagefile (or an unreadable value): the current limit is then the real one, but an
      // unparsed value would make every sample look critical, so only a readable answer counts.
      options.onUnavailable(`PagingFiles not understood: ${JSON.stringify(output.trim().slice(-200))}`);
      return;
    }
    const sample = (): void => {
      try {
        const info = options.readMemory();
        if (typeof info.swapTotal !== 'number' || typeof info.swapFree !== 'number') return;
        const limitBytes = info.swapTotal * 1024;
        const chargeBytes = (info.swapTotal - info.swapFree) * 1024;
        const maxLimitBytes = Math.max(limitBytes, maxCommitBytes(info.total * 1024, specs, volumeBytes));
        const reading: CommitReading = { chargeBytes, limitBytes, maxLimitBytes, headroomBytes: maxLimitBytes - chargeBytes };
        const step = stepCommitPressure(state, reading.headroomBytes);
        state = step.state;
        if (step.transition === 'alarm') options.onAlarm(reading);
        if (step.transition === 'clear') options.onClear(reading);
        options.onSample?.(reading, state.alarmed);
      } catch (err) {
        options.onUnavailable(String(err));
        stop();
      }
    };
    sample();
    if (stopped) return;
    timer = setInterval(sample, COMMIT_SAMPLE_INTERVAL_MS);
    timer.unref?.();
  }, (err) => options.onUnavailable(`reg query PagingFiles failed: ${String(err)}`));

  const stop = (): void => {
    stopped = true;
    clearInterval(timer ?? undefined);
    timer = null;
  };
  return stop;
}

/** "12.3 GB" style, for the user-facing notice. */
export function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}