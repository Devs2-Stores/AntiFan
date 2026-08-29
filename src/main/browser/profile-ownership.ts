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

const PROFILE_STATE_MARKERS = [
  path.join('Network', 'Cookies'),
  path.join('Local Storage', 'leveldb'),
  'IndexedDB',
  path.join('Service Worker', 'Database'),
  'Session Storage',
  'Preferences',
  'saved-tabs.json',
];

const TRANSIENT_PROFILE_FILES: Record<string, true> = {
  [LOCK_FILE]: true,
  [RECOVERY_FILE]: true,
  SingletonCookie: true,
  SingletonLock: true,
  SingletonSocket: true,
};

const LEGACY_NESTED_PROFILE_DIRECTORIES: Record<string, true> = {
  'Chromium-dev': true,
  Chromium: true,
  'Chromium-prod': true,
  Profile: true,
  'Chromium-dev-cache': true,
  'Chromium-cache': true,
  'Chromium-prod-cache': true,
  state: true,
};

export interface PersistentProfileOptions {
  appDataPath: string;
  appPath: string;
  customUserData?: string;
  pid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface PersistentProfileResult {
  profilePath: string;
  migratedFrom?: string;
}

export class ProfileMigrationError extends Error {
  constructor(public readonly code: 'PROFILE_IN_USE' | 'PROFILE_MIGRATION_FAILED', message: string, public readonly sourcePath?: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ProfileMigrationError';
  }
}

function hasDirectoryEntries(directoryPath: string): boolean {
  try {
    return fs.readdirSync(directoryPath).length > 0;
  } catch {
    return false;
  }
}

export function hasPersistentProfileState(profilePath: string): boolean {
  return PROFILE_STATE_MARKERS.some((relativePath) => {
    const markerPath = path.join(profilePath, relativePath);
    try {
      const stat = fs.statSync(markerPath);
      return stat.isFile() ? stat.size > 0 : stat.isDirectory() && hasDirectoryEntries(markerPath);
    } catch {
      return false;
    }
  });
}

function profileStateMarkerCount(profilePath: string): number {
  let count = 0;
  for (const relativePath of PROFILE_STATE_MARKERS) {
    const markerPath = path.join(profilePath, relativePath);
    try {
      const stat = fs.statSync(markerPath);
      if (stat.isFile() ? stat.size > 0 : stat.isDirectory() && hasDirectoryEntries(markerPath)) count += 1;
    } catch {}
  }
  return count;
}

function profileCookieStoreSize(profilePath: string): number {
  try {
    return fs.statSync(path.join(profilePath, 'Network', 'Cookies')).size;
  } catch {
    return 0;
  }
}

function profileLastActivity(profilePath: string): number {
  let latest = 0;
  for (const relativePath of PROFILE_STATE_MARKERS) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(profilePath, relativePath)).mtimeMs);
    } catch {}
  }
  return latest;
}

function compareProfileValue(left: string, right: string): number {
  return profileStateMarkerCount(right) - profileStateMarkerCount(left)
    || profileCookieStoreSize(right) - profileCookieStoreSize(left)
    || profileLastActivity(right) - profileLastActivity(left);
}

function readProfileLease(profilePath: string): ProfileLeaseInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profilePath, LOCK_FILE), 'utf8')) as Partial<ProfileLeaseInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number' || typeof parsed.profilePath !== 'string') return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      startedAt: parsed.startedAt,
      profilePath: parsed.profilePath,
    };
  } catch {
    return null;
  }
}

function defaultProcessProbe(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolves one profile path for every launch mode and performs a one-time,
 * whole-profile copy from the richest legacy location. Durable-state breadth
 * and cookie-store size outrank recency so a newly-created sparse profile
 * cannot displace the user's established authenticated browser identity.
 */
export function preparePersistentProfile(options: PersistentProfileOptions): PersistentProfileResult {
  if (options.customUserData) {
    return { profilePath: path.resolve(options.customUserData) };
  }

  const canonicalPath = path.join(options.appDataPath, 'antifan-browser-desktop', 'Profile');
  if (hasPersistentProfileState(canonicalPath)) {
    return { profilePath: canonicalPath };
  }

  if (fs.existsSync(canonicalPath) && hasDirectoryEntries(canonicalPath)) {
    throw new ProfileMigrationError('PROFILE_MIGRATION_FAILED', `Canonical profile directory is non-empty but contains no recognized Chromium state: ${canonicalPath}`);
  }

  const legacyAppDataRoot = path.join(options.appDataPath, 'antifan-browser-desktop');
  const candidatePaths = [
    path.join(options.appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev'),
    path.join(options.appPath, 'appdata', 'antifan-browser-desktop', 'Chromium'),
    path.join(options.appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-prod'),
    path.join(legacyAppDataRoot, 'Chromium-dev'),
    path.join(legacyAppDataRoot, 'Chromium'),
    path.join(legacyAppDataRoot, 'Chromium-prod'),
    legacyAppDataRoot,
    path.join(options.appPath, 'appdata', 'antigravity-browser-desktop', 'Chromium-dev'),
    path.join(options.appDataPath, 'antigravity-browser-desktop'),
  ].map((candidate) => path.resolve(candidate));
  const candidates = candidatePaths
    .filter((candidate, index) => candidatePaths.indexOf(candidate) === index)
    .filter((candidate) => candidate !== path.resolve(canonicalPath) && hasPersistentProfileState(candidate))
    .sort(compareProfileValue);

  const sourcePath = candidates[0];
  if (!sourcePath) {
    return { profilePath: canonicalPath };
  }

  const lease = readProfileLease(sourcePath);
  const isProcessAlive = options.isProcessAlive ?? defaultProcessProbe;
  if (lease && isProcessAlive(lease.pid)) {
    throw new ProfileMigrationError('PROFILE_IN_USE', `Cannot migrate Chromium profile while pid ${lease.pid} is using it`, sourcePath);
  }

  const parentPath = path.dirname(canonicalPath);
  const tempPath = path.join(options.appDataPath, `.antifan-profile-migration-${options.pid ?? process.pid}-${(options.now ?? Date.now)()}`);
  try {
    fs.mkdirSync(parentPath, { recursive: true });
    if (fs.existsSync(canonicalPath)) fs.rmdirSync(canonicalPath);
    fs.cpSync(sourcePath, tempPath, {
      recursive: true,
      filter: (source) => {
        const relativePath = path.relative(sourcePath, source);
        if (relativePath === '') return true;
        if (TRANSIENT_PROFILE_FILES[relativePath] === true) return false;
        if (sourcePath === path.resolve(legacyAppDataRoot)) {
          const topLevelName = relativePath.split(path.sep, 1)[0] ?? '';
          if (LEGACY_NESTED_PROFILE_DIRECTORIES[topLevelName] === true || topLevelName.startsWith('.antifan-profile-migration-')) return false;
        }
        return true;
      },
    });
    if (!hasPersistentProfileState(tempPath)) {
      throw new Error('Copied profile contains no recognized Chromium state');
    }
    fs.renameSync(tempPath, canonicalPath);
    return { profilePath: canonicalPath, migratedFrom: sourcePath };
  } catch (error) {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch {}
    throw new ProfileMigrationError('PROFILE_MIGRATION_FAILED', `Failed to migrate Chromium profile from ${sourcePath}`, sourcePath, error);
  }
}

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
