import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';

export interface ProfileRecoveryState {
  cleanShutdown: boolean;
  startedAt?: number;
  lastCleanShutdownAt?: number;
  safeStartRecommended: boolean;
}

export interface ProfileLeaseInfo {
  pid: number;
  host: string;
  startedAt: number;
  profilePath: string;
}

export interface ProfileLease {
  readonly owner: boolean;
  readonly info: ProfileLeaseInfo;
  readonly recovery: ProfileRecoveryState;
  markReady(): void;
  markCleanShutdown(): void;
  release(): void;
}

export interface ProfileOwnershipOptions {
  pid?: number;
  hostname?: string;
  now?: () => number;
  force?: boolean;
}
const LOCK_FILE = 'antifan-profile.lock';
const RECOVERY_FILE = 'antifan-recovery.json';

export class ProfileOwnership {
  private readonly pid: number;
  private readonly hostname: string;
  private readonly now: () => number;
  private readonly force: boolean;

  constructor(private readonly options: ProfileOwnershipOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? os.hostname();
    this.now = options.now ?? Date.now;
    this.force = options.force ?? false;
  }

  acquire(profilePath: string): ProfileLease {
    const normalizedProfilePath = path.resolve(profilePath);
    fs.mkdirSync(normalizedProfilePath, { recursive: true });
    const lockPath = path.join(normalizedProfilePath, LOCK_FILE);
    const recoveryPath = path.join(normalizedProfilePath, RECOVERY_FILE);
    const info: ProfileLeaseInfo = {
      pid: this.pid,
      host: this.hostname,
      startedAt: this.now(),
      profilePath: normalizedProfilePath,
    };
    const recovery = this.readRecovery(recoveryPath);
    let lockFd: number | null = null;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      lockFd = fd;
      fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), 'utf8');
    } catch (error) {
      const existing = this.readLease(lockPath);
      const isStale = !existing || !this.isProcessAlive(existing.pid) || this.force;
      if (isStale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          throw new ProfileOwnershipError('PROFILE_LOCKED', `Profile lease is held by pid ${existing?.pid}`, existing);
        }
        const fd = fs.openSync(lockPath, 'wx');
        lockFd = fd;
        fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), 'utf8');
      } else {
        throw new ProfileOwnershipError('PROFILE_LOCKED', 'Chromium profile is already owned by another AntiFan instance', existing, error);
      }
    }

    const startedRecovery: ProfileRecoveryState = {
      ...recovery,
      cleanShutdown: false,
      startedAt: info.startedAt,
      safeStartRecommended: !recovery.cleanShutdown,
    };
    this.writeRecovery(recoveryPath, startedRecovery);
    let released = false;
    return {
      owner: true,
      info,
      recovery: startedRecovery,
      markReady: () => {
        this.writeRecovery(recoveryPath, { ...startedRecovery, safeStartRecommended: startedRecovery.safeStartRecommended });
      },
      markCleanShutdown: () => {
        this.writeRecovery(recoveryPath, {
          cleanShutdown: true,
          startedAt: startedRecovery.startedAt,
          lastCleanShutdownAt: this.now(),
          safeStartRecommended: false,
        });
      },
      release: () => {
        if (released) return;
        released = true;
        try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
        try {
          const current = this.readLease(lockPath);
          if (current?.pid === info.pid && current.startedAt === info.startedAt) fs.unlinkSync(lockPath);
        } catch {}
      },
    };
  }

  private readLease(filePath: string): ProfileLeaseInfo | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const value = parsed as Partial<ProfileLeaseInfo>;
      if (typeof value.pid !== 'number' || typeof value.startedAt !== 'number' || typeof value.profilePath !== 'string') return null;
      return { pid: value.pid, host: typeof value.host === 'string' ? value.host : '', startedAt: value.startedAt, profilePath: value.profilePath };
    } catch {
      return null;
    }
  }

  private readRecovery(filePath: string): ProfileRecoveryState {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProfileRecoveryState>;
      return {
        cleanShutdown: value.cleanShutdown === true,
        startedAt: typeof value.startedAt === 'number' ? value.startedAt : undefined,
        lastCleanShutdownAt: typeof value.lastCleanShutdownAt === 'number' ? value.lastCleanShutdownAt : undefined,
        safeStartRecommended: value.safeStartRecommended === true,
      };
    } catch {
      return { cleanShutdown: true, safeStartRecommended: false };
    }
  }

  private writeRecovery(filePath: string, state: ProfileRecoveryState): void {
    const temp = `${filePath}.tmp-${this.pid}`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, filePath);
  }

  private isProcessAlive(pid: number): boolean {
    if (pid <= 0 || pid === this.pid) return pid === this.pid;
    try {
      process.kill(pid, 0);
      if (process.platform === 'win32') {
        try {
          const output = cp.execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 1000 });
          const lower = output.toLowerCase();
          if (!lower.includes('electron') && !lower.includes('antifan') && !lower.includes('node')) {
            return false;
          }
        } catch {}
      }
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

export class ProfileOwnershipError extends Error {
  constructor(public readonly code: 'PROFILE_LOCKED', message: string, public readonly existingLease: ProfileLeaseInfo | null, public readonly cause?: unknown) {
    super(message);
    this.name = 'ProfileOwnershipError';
  }
}
