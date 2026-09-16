/**
 * AntiFan Browser Desktop — Process Lifecycle Registry
 *
 * Tracks all spawned child processes (PTY, diagnostics, CLI runners, MCP hosts)
 * with owner metadata, start-time markers for PID-reuse safety, and lifecycle hooks
 * to guarantee clean exit and orphan cleanup across crashes and restarts on Windows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { StorageLocations } from '../config/storage-locations';
import { recordLifecycleEvent } from '../diagnostics/main-lifecycle-log';

export interface ProcessRegistrationOptions {
  pid: number;
  owner: string; // e.g. 'core-health' | 'terminal' | 'mcp' | 'test'
  name?: string;
  command?: string;
  osStartTime?: number | null;
  processRef?: { kill?: (signal?: NodeJS.Signals | number) => unknown; unref?: () => unknown };
}

export interface TrackedProcess {
  pid: number;
  owner: string;
  name?: string;
  command?: string;
  createdAt: number;
  osStartTime: number | null;
  processRef?: { kill?: (signal?: NodeJS.Signals | number) => unknown; unref?: () => unknown };
}

export interface ProcessMarkerRecord {
  pid: number;
  owner: string;
  name?: string;
  command?: string;
  createdAt: number;
  osStartTime: number | null;
}

export interface SweepReport {
  scanned: number;
  alreadyDead: number;
  killed: number;
  pidReusedSkipped: number;
  errors: Array<{ pid: number; error: string }>;
}

export interface ProcessRegistryOptions {
  stateDir?: string;
  markerFileName?: string;
  autoInstallExitHooks?: boolean;
  now?: () => number;
  getProcessStartTime?: (pid: number) => number | null;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => Promise<boolean>;
  killProcessSync?: (pid: number) => boolean;
  logger?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Check if a process is still alive.
 * On Windows, process.kill(pid, 0) tests existence; EPERM means exists but access denied.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || typeof pid !== 'number' || pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Parse WMIC CreationDate string into UTC epoch milliseconds.
 * WMIC format: YYYYMMDDHHMMSS.mmmmmm+ZZZ (e.g. 20260916152810.607420+420)
 */
export function parseWmicCreationDate(str: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})/.exec(str);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5] || !m[6] || !m[7]) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = parseInt(m[6], 10);
  const ms = parseInt(m[7], 10);
  const tzMatch = /([+-])(\d+)$/.exec(str);
  const tzOffsetMinutes = tzMatch && tzMatch[2] ? parseInt(tzMatch[2], 10) * (tzMatch[1] === '+' ? 1 : -1) : 0;
  return Date.UTC(year, month - 1, day, hour, min, sec, ms) - (tzOffsetMinutes * 60 * 1000);
}

/**
 * Retrieve the OS-level creation timestamp of a process in epoch milliseconds.
 * Returns null if the process is dead, unreachable, or platform cannot determine.
 */
export function getProcessCreationTime(pid: number): number | null {
  if (!pid || pid <= 0 || !Number.isFinite(pid)) return null;

  if (process.platform === 'win32') {
    // 1. Primary fast probe on Windows: wmic.exe (~30ms)
    try {
      const out = cp.execFileSync(
        'wmic.exe',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const line = out.split('\r\n').find((l) => l.startsWith('CreationDate='));
      if (line) {
        const parts = line.split('=');
        const val = parts[1]?.trim();
        if (val) {
          const parsed = parseWmicCreationDate(val);
          if (parsed !== null) return parsed;
        }
      }
    } catch {
      // WMIC not available or process died
    }

    // 2. Fallback probe: powershell.exe
    try {
      const out = cp.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { '' }`,
        ],
        { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const trimmed = out.trim();
      if (trimmed) {
        const ms = Date.parse(trimmed);
        if (Number.isFinite(ms)) return ms;
      }
    } catch {
      // PowerShell fallback failed
    }

    return null;
  }

  if (process.platform === 'linux') {
    try {
      const stat = fs.statSync(`/proc/${pid}`);
      return Math.floor(stat.mtimeMs);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    try {
      const out = cp.execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const trimmed = out.trim();
      if (trimmed) {
        const ms = Date.parse(trimmed);
        if (Number.isFinite(ms)) return ms;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Terminate a process and its full process tree asynchronously.
 * On Windows, uses taskkill /pid <pid> /T /F.
 */
export function killProcessTree(pid: number): Promise<boolean> {
  if (!pid || typeof pid !== 'number' || pid <= 0 || !Number.isFinite(pid)) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (success: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(success);
      }
    };
    const timer = setTimeout(() => settle(false), 3000);
    timer.unref?.();

    if (process.platform === 'win32') {
      try {
        const child = cp.spawn(
          'taskkill',
          ['/pid', String(Math.floor(pid)), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' }
        );
        child.unref();
        child.on('error', () => {
          try {
            process.kill(pid, 'SIGKILL');
            settle(true);
          } catch {
            settle(!isProcessAlive(pid));
          }
        });
        child.on('close', (code) => {
          // 0 = killed, 128 = already dead / not found
          settle(code === 0 || code === 128);
        });
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
          settle(true);
        } catch {
          settle(!isProcessAlive(pid));
        }
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
        settle(true);
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
          settle(true);
        } catch {
          settle(!isProcessAlive(pid));
        }
      }
    }
  });
}

/**
 * Synchronous termination of a process tree (for use in process.on('exit')).
 */
export function killProcessTreeSync(pid: number): boolean {
  if (!pid || typeof pid !== 'number' || pid <= 0 || !Number.isFinite(pid)) {
    return false;
  }
  if (process.platform === 'win32') {
    try {
      const res = cp.spawnSync(
        'taskkill',
        ['/pid', String(Math.floor(pid)), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 2000 }
      );
      return res.status === 0 || res.status === 128;
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
        return true;
      } catch {
        return !isProcessAlive(pid);
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return true;
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
        return true;
      } catch {
        return !isProcessAlive(pid);
      }
    }
  }
}

export class ProcessRegistry {
  private static instance: ProcessRegistry | null = null;

  private readonly tracked = new Map<number, TrackedProcess>();
  private readonly stateDir: string;
  private readonly markerFilePath: string;
  private readonly now: () => number;
  private readonly getProcessStartTime: (pid: number) => number | null;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly killProcess: (pid: number) => Promise<boolean>;
  private readonly killProcessSync: (pid: number) => boolean;
  private readonly logger: (event: string, fields?: Record<string, unknown>) => void;

  private exitHooksInstalled = false;
  private exitHandler: (() => void) | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  constructor(options?: ProcessRegistryOptions) {
    this.now = options?.now ?? Date.now;
    this.getProcessStartTime = options?.getProcessStartTime ?? getProcessCreationTime;
    this.isProcessAlive = options?.isProcessAlive ?? isProcessAlive;
    this.killProcess = options?.killProcess ?? killProcessTree;
    this.killProcessSync = options?.killProcessSync ?? killProcessTreeSync;
    this.logger = options?.logger ?? recordLifecycleEvent;

    this.stateDir = options?.stateDir ?? StorageLocations.getRuntimeDir();
    const markerFileName = options?.markerFileName ?? 'process-registry.json';
    this.markerFilePath = path.join(this.stateDir, markerFileName);

    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
    } catch {}

    if (options?.autoInstallExitHooks !== false) {
      this.installExitHooks();
    }
  }

  public static getInstance(options?: ProcessRegistryOptions): ProcessRegistry {
    if (!ProcessRegistry.instance) {
      ProcessRegistry.instance = new ProcessRegistry(options);
    }
    return ProcessRegistry.instance;
  }

  public static resetInstance(): void {
    if (ProcessRegistry.instance) {
      ProcessRegistry.instance.dispose();
      ProcessRegistry.instance = null;
    }
  }

  public getMarkerFilePath(): string {
    return this.markerFilePath;
  }

  /**
   * Register a newly spawned child process.
   * Immediately records metadata and updates the disk marker.
   */
  public register(options: ProcessRegistrationOptions): TrackedProcess {
    const createdAt = this.now();
    let osStartTime: number | null = options.osStartTime ?? null;
    if (osStartTime === null) {
      osStartTime = this.getProcessStartTime(options.pid);
    }

    const record: TrackedProcess = {
      pid: options.pid,
      owner: options.owner,
      name: options.name,
      command: options.command,
      createdAt,
      osStartTime,
      processRef: options.processRef,
    };

    this.tracked.set(options.pid, record);
    this.persistMarkerFile();

    this.logger('process.spawn', {
      pid: options.pid,
      owner: options.owner,
      name: options.name,
      command: options.command,
      osStartTime,
    });

    return record;
  }

  /**
   * Unregister an exited or cleaned-up child process.
   */
  public unregister(pid: number, exitCode?: number | null): boolean {
    const existing = this.tracked.get(pid);
    if (!existing) return false;

    this.tracked.delete(pid);
    this.persistMarkerFile();

    this.logger('process.exit', {
      pid,
      owner: existing.owner,
      name: existing.name,
      exitCode: exitCode ?? undefined,
    });

    return true;
  }

  public get(pid: number): TrackedProcess | undefined {
    return this.tracked.get(pid);
  }

  public list(): TrackedProcess[] {
    return Array.from(this.tracked.values());
  }

  public listByOwner(owner: string): TrackedProcess[] {
    return Array.from(this.tracked.values()).filter((p) => p.owner === owner);
  }

  public isAlive(pid: number): boolean {
    return this.isProcessAlive(pid);
  }

  /**
   * Terminate a tracked process and remove it from the registry.
   */
  public async kill(pid: number): Promise<boolean> {
    const record = this.tracked.get(pid);
    const killed = await this.killProcess(pid);
    if (record) {
      this.unregister(pid);
    }
    return killed;
  }

  /**
   * Terminate all tracked child processes (e.g. during graceful application shutdown).
   */
  public async killAll(owner?: string): Promise<{ attempted: number; killed: number; errors: Array<{ pid: number; error: string }> }> {
    const targets = owner ? this.listByOwner(owner) : this.list();
    const result = { attempted: targets.length, killed: 0, errors: [] as Array<{ pid: number; error: string }> };

    await Promise.all(
      targets.map(async (proc) => {
        try {
          const success = await this.killProcess(proc.pid);
          if (success) {
            result.killed += 1;
          }
          this.unregister(proc.pid);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push({ pid: proc.pid, error: msg });
          this.unregister(proc.pid);
        }
      })
    );

    return result;
  }

  /**
   * Synchronous kill of all tracked child processes (for process.on('exit')).
   */
  public killAllSync(owner?: string): void {
    const targets = owner ? this.listByOwner(owner) : this.list();
    for (const proc of targets) {
      try {
        if (proc.processRef?.kill) {
          try { proc.processRef.kill('SIGKILL'); } catch {}
        }
        this.killProcessSync(proc.pid);
      } catch {}
      this.tracked.delete(proc.pid);
    }
    this.persistMarkerFile();
  }

  /**
   * Sweep and kill orphaned child processes from prior application runs/crashes.
   *
   * Verifies each recorded PID against its original creation time before killing,
   * guaranteeing that a reused/recycled PID belonging to an innocent process is NEVER killed.
   */
  public async sweepOrphans(options?: { toleranceMs?: number; maxAgeMs?: number }): Promise<SweepReport> {
    const toleranceMs = options?.toleranceMs ?? 5000;
    const maxAgeMs = options?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = this.now();

    const report: SweepReport = {
      scanned: 0,
      alreadyDead: 0,
      killed: 0,
      pidReusedSkipped: 0,
      errors: [],
    };

    const records = this.readMarkerFile();
    if (records.length === 0) {
      return report;
    }

    report.scanned = records.length;
    this.logger('process.orphanSweep.begin', { count: records.length });

    const survivingRecords: ProcessMarkerRecord[] = [];

    for (const record of records) {
      // If this PID is actively tracked by this running session instance, preserve it
      if (this.tracked.has(record.pid)) {
        survivingRecords.push(record);
        continue;
      }

      // 1. Is the process still alive in the OS?
      if (!this.isProcessAlive(record.pid)) {
        report.alreadyDead += 1;
        // Dead process: drop from marker file
        continue;
      }

      // 2. Process is ALIVE in OS! Check for PID reuse:
      const currentStartTime = this.getProcessStartTime(record.pid);

      let isOrphan = false;
      let pidReused = false;

      if (currentStartTime !== null && record.osStartTime !== null) {
        // Both OS start times are known: verify exact match within tolerance
        if (Math.abs(currentStartTime - record.osStartTime) <= toleranceMs) {
          isOrphan = true;
        } else {
          pidReused = true;
        }
      } else if (currentStartTime !== null && record.createdAt) {
        // Fallback: compare currentStartTime against record.createdAt
        // Valid orphan must have been started near createdAt (within 60s and not earlier than createdAt - 10s)
        if (currentStartTime >= record.createdAt - 10000 && currentStartTime <= record.createdAt + 60000) {
          isOrphan = true;
        } else {
          pidReused = true;
        }
      } else {
        // OS creation time could not be queried
        if (now - record.createdAt > maxAgeMs) {
          // Very old record: do not kill unknown process
          pidReused = true;
        } else {
          // Recent record within active session horizon: treat as candidate orphan
          isOrphan = true;
        }
      }

      if (pidReused) {
        report.pidReusedSkipped += 1;
        this.logger('process.orphanSweep.pidReused', {
          pid: record.pid,
          owner: record.owner,
          recordedStartTime: record.osStartTime ?? record.createdAt,
          currentStartTime,
        });
        // Remove the stale marker for the dead child so we don't inspect this reused PID again
        continue;
      }

      if (isOrphan) {
        try {
          const killed = await this.killProcess(record.pid);
          if (killed) {
            report.killed += 1;
            this.logger('process.orphanSweep.killed', {
              pid: record.pid,
              owner: record.owner,
              osStartTime: record.osStartTime,
            });
          } else {
            report.errors.push({ pid: record.pid, error: 'kill returned false' });
            survivingRecords.push(record);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          report.errors.push({ pid: record.pid, error: msg });
          survivingRecords.push(record);
        }
      }
    }

    this.writeMarkerFile(survivingRecords);

    this.logger('process.orphanSweep.complete', {
      scanned: report.scanned,
      alreadyDead: report.alreadyDead,
      killed: report.killed,
      pidReusedSkipped: report.pidReusedSkipped,
    });

    return report;
  }

  public dispose(): void {
    if (this.exitHooksInstalled) {
      if (this.exitHandler) process.removeListener('exit', this.exitHandler);
      if (this.sigintHandler) process.removeListener('SIGINT', this.sigintHandler);
      if (this.sigtermHandler) process.removeListener('SIGTERM', this.sigtermHandler);
      this.exitHooksInstalled = false;
    }
  }

  private installExitHooks(): void {
    if (this.exitHooksInstalled) return;
    this.exitHooksInstalled = true;

    this.exitHandler = () => {
      this.killAllSync();
    };
    process.on('exit', this.exitHandler);

    this.sigintHandler = () => {
      this.killAll().finally(() => {
        process.exit(130);
      });
    };
    this.sigtermHandler = () => {
      this.killAll().finally(() => {
        process.exit(143);
      });
    };

    process.on('SIGINT', this.sigintHandler);
    process.on('SIGTERM', this.sigtermHandler);
  }

  public readMarkerFile(): ProcessMarkerRecord[] {
    try {
      if (!fs.existsSync(this.markerFilePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.markerFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r) => typeof r?.pid === 'number' && r.pid > 0 && typeof r?.owner === 'string'
      );
    } catch {
      return [];
    }
  }

  public writeMarkerFile(records: ProcessMarkerRecord[]): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const json = JSON.stringify(records, null, 2);
      const tmpPath = `${this.markerFilePath}.tmp.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, json, 'utf8');
        fs.renameSync(tmpPath, this.markerFilePath);
      } catch {
        // On Windows, renameSync can fail if antivirus or another handle touched the file; fallback to direct write
        fs.writeFileSync(this.markerFilePath, json, 'utf8');
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } catch (err) {
      this.logger('process.markerWrite.error', { error: String(err) });
    }
  }

  private persistMarkerFile(): void {
    const records: ProcessMarkerRecord[] = Array.from(this.tracked.values()).map((p) => ({
      pid: p.pid,
      owner: p.owner,
      name: p.name,
      command: p.command,
      createdAt: p.createdAt,
      osStartTime: p.osStartTime,
    }));
    this.writeMarkerFile(records);
  }
}
