/**
 * Free-disk pressure watch. A full volume stops writes everywhere at once (logs, baselines, session
 * files, the pagefile's growth), so the watch alarms while the owner can still act, mirroring the
 * system commit watch: a streak of low samples raises it, a clearly higher line clears it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMMIT_ALARM_STREAK, COMMIT_SAMPLE_INTERVAL_MS } from './commit-pressure';

const GIB = 1024 ** 3;

/** Under this much free space on a volume, one more agent session or a baseline set can fill it. */
export const DISK_ALARM_FREE_BYTES = 5 * GIB;
/** Cleared only well above the alarm line, so a volume hovering at the line does not flap. */
export const DISK_CLEAR_FREE_BYTES = 10 * GIB;
export const DISK_ALARM_STREAK = COMMIT_ALARM_STREAK;
export const DISK_SAMPLE_INTERVAL_MS = COMMIT_SAMPLE_INTERVAL_MS;

/** Name of the file in the runtime dir that carries the latest reading to processes outside Main. */
export const DISK_PRESSURE_STATE_FILE = 'disk-pressure.json';

export interface DiskPressureState {
  alarmed: boolean;
  lowStreak: number;
}

export const INITIAL_DISK_PRESSURE: DiskPressureState = { alarmed: false, lowStreak: 0 };

/** One sample of one volume through the alarm/clear hysteresis. */
export function stepDiskPressure(
  state: DiskPressureState,
  freeBytes: number
): { state: DiskPressureState; transition: 'alarm' | 'clear' | null } {
  if (state.alarmed) {
    return freeBytes >= DISK_CLEAR_FREE_BYTES
      ? { state: { alarmed: false, lowStreak: 0 }, transition: 'clear' }
      : { state, transition: null };
  }
  const lowStreak = freeBytes < DISK_ALARM_FREE_BYTES ? state.lowStreak + 1 : 0;
  return lowStreak >= DISK_ALARM_STREAK
    ? { state: { alarmed: true, lowStreak: 0 }, transition: 'alarm' }
    : { state: { alarmed: false, lowStreak }, transition: null };
}

export interface DiskVolumeReading {
  /** The volume's label: its drive root on Windows, the watched directory elsewhere. */
  path: string;
  freeBytes: number;
  alarmed: boolean;
}

/** The state file's body: `floorBytes` is the free space under which a volume is alarmed. */
export function diskPressureStateBody(now: number, volumes: DiskVolumeReading[]): string {
  return JSON.stringify({
    schema: 1,
    at: now,
    alarmed: volumes.some((v) => v.alarmed),
    volumes: volumes.map((v) => ({
      path: v.path,
      freeBytes: v.freeBytes,
      floorBytes: DISK_ALARM_FREE_BYTES,
      clearBytes: DISK_CLEAR_FREE_BYTES,
      alarmed: v.alarmed,
    })),
  });
}

export type StatfsFn = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/**
 * Bytes available to this user on the volume holding `dir`, read from the nearest existing
 * ancestor (a directory that is not created yet still lives on a known volume). Null when it
 * cannot be read; never throws.
 */
export async function readFreeBytes(dir: string, statfs: StatfsFn = (d) => fs.promises.statfs(d)): Promise<number | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const st = await statfs(current);
      const free = Number(st.bavail) * Number(st.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function nearestExisting(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await fs.promises.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Identity of the volume holding `dir`: the drive (or UNC share) root on Windows, otherwise the
 * device id of the nearest existing ancestor, which is the same for every path under one mount.
 */
export async function volumeKeyOf(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  if (process.platform === 'win32') return path.parse(resolved).root.toLowerCase();
  const existing = await nearestExisting(resolved);
  if (!existing) return path.parse(resolved).root;
  try {
    return `dev:${(await fs.promises.stat(existing)).dev}`;
  } catch {
    return path.parse(resolved).root;
  }
}

function volumeLabelOf(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? path.parse(resolved).root : resolved;
}

export interface WatchedVolume {
  key: string;
  /** First directory listed for the volume; the one the reader is asked about. */
  dir: string;
  path: string;
}

/** One entry per volume, in the order the directories were given. */
export async function resolveVolumes(
  dirs: string[],
  keyOf: (dir: string) => Promise<string> = volumeKeyOf
): Promise<WatchedVolume[]> {
  const seen = new Map<string, WatchedVolume>();
  for (const dir of dirs) {
    let key: string;
    try {
      key = await keyOf(dir);
    } catch {
      continue;
    }
    if (!seen.has(key)) seen.set(key, { key, dir, path: volumeLabelOf(dir) });
  }
  return [...seen.values()];
}

export const DISK_READ_TIMEOUT_MS = 5_000;

/** Rejects when `promise` has not settled in `ms`; the timer never keeps the process alive and a late result is dropped. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`read timed out after ${ms} ms`)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export interface DiskPressureWatchOptions {
  /** Directories whose volumes are watched; several on one volume count once. */
  dirs: string[];
  /** Every sample, after the hysteresis has seen it: one reading per readable volume. */
  onSample?: (volumes: DiskVolumeReading[]) => void;
  onAlarm: (volume: { path: string; dir: string; freeBytes: number }) => void;
  onClear: (volume: { path: string; dir: string; freeBytes: number }) => void;
  intervalMs?: number;
  readFree?: (dir: string) => Promise<number | null>;
  keyOf?: (dir: string) => Promise<string>;
  /** Bound on one volume read; a read that outlives it is ignored and the volume skipped for that sample. */
  readTimeoutMs?: number;
}

/** Starts sampling at once and then every interval; returns a stop function. */
export function startDiskPressureWatch(options: DiskPressureWatchOptions): () => void {
  const readFree = options.readFree ?? ((dir: string) => readFreeBytes(dir));
  const readTimeoutMs = options.readTimeoutMs ?? DISK_READ_TIMEOUT_MS;
  const states = new Map<string, DiskPressureState>();
  let stopped = false;
  let busy = false;

  const sample = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const keyOf = options.keyOf ?? volumeKeyOf;
      const volumes = await resolveVolumes(options.dirs, (dir) => withTimeout(keyOf(dir), readTimeoutMs));
      const readings: DiskVolumeReading[] = [];
      for (const volume of volumes) {
        if (stopped) return;
        let freeBytes: number | null = null;
        try {
          freeBytes = await withTimeout(readFree(volume.dir), readTimeoutMs);
        } catch {
          // A volume that cannot be read right now (unplugged drive, hung share) is skipped, not fatal.
        }
        if (freeBytes === null) continue;
        const step = stepDiskPressure(states.get(volume.key) ?? INITIAL_DISK_PRESSURE, freeBytes);
        states.set(volume.key, step.state);
        readings.push({ path: volume.path, freeBytes, alarmed: step.state.alarmed });
        const info = { path: volume.path, dir: volume.dir, freeBytes };
        try {
          if (step.transition === 'alarm') options.onAlarm(info);
          if (step.transition === 'clear') options.onClear(info);
        } catch {
          // A consumer failing must not end the watch.
        }
      }
      try {
        options.onSample?.(readings);
      } catch {
        // Same: the state-file writer failing does not stop sampling.
      }
    } finally {
      busy = false;
    }
  };

  void sample();
  const timer = setInterval(() => void sample(), options.intervalMs ?? DISK_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface BoundedSize {
  bytes: number;
  /** True when the walk stopped at a limit: the real size is at least `bytes`. */
  capped: boolean;
}

/**
 * Size of a tree under a cap on visited entries and on elapsed time, so measuring a huge store at
 * alarm time stays cheap. Symlinks and junctions are never followed.
 */
export async function boundedDirSize(
  root: string,
  limits: { maxEntries: number; maxMs: number },
  now: () => number = Date.now
): Promise<BoundedSize> {
  const deadline = now() + limits.maxMs;
  const stack = [root];
  let bytes = 0;
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= limits.maxEntries || now() > deadline) return { bytes, capped: true };
      visited++;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.promises.lstat(full)).size;
        } catch {
          // Vanished between listing and stat.
        }
      }
    }
  }
  return { bytes, capped: false };
}
