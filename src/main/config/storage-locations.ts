/**
 * AntiFan Browser Desktop — Storage & Location Resolver
 * Centralized, authoritative directory path resolution.
 * Prioritizes Drive E (E:\Work\.antifan-data) to maintain a zero-byte footprint on Drive C.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { enforceProtectedDirectoryDacl, resolveCurrentUserSid } from '../native-messaging/windows-acl';

export class StorageLocations {
  private static cachedDataRoot: string | null = null;

  /**
   * Resolves the primary root directory for all AntiFan persistent data.
   * Priority:
   * 1. ANTIFAN_DATA_ROOT env var
   * 2. E:\Work\.antifan-data (if E:\Work or E:\ exists and is writable)
   * 3. Secondary drive roots (e.g. D:\Work\.antifan-data)
   * 4. Fallback to AppData/UserData
   */
  public static getDataRoot(customRoot?: string): string {
    if (customRoot) {
      return path.resolve(customRoot);
    }
    if (process.env.ANTIFAN_DATA_ROOT) {
      return path.resolve(process.env.ANTIFAN_DATA_ROOT);
    }
    if (this.cachedDataRoot) {
      return this.cachedDataRoot;
    }

    // Check candidate root directories on Drive E: and other drives
    const candidateRoots = [
      path.join('E:', 'Work', '.antifan-data'),
      path.join('E:\\', 'Work', '.antifan-data'),
      path.join('E:', '.antifan-data'),
      path.join('D:', 'Work', '.antifan-data'),
    ];

    for (const candidate of candidateRoots) {
      const parentDir = path.dirname(candidate);
      if (fs.existsSync(parentDir)) {
        try {
          fs.mkdirSync(candidate, { recursive: true });
          const testFile = path.join(candidate, `.probe-${process.pid}-${Date.now()}`);
          fs.writeFileSync(testFile, 'ok', 'utf8');
          fs.unlinkSync(testFile);
          this.cachedDataRoot = path.resolve(candidate);
          return this.cachedDataRoot;
        } catch {
          // Candidate not writable, proceed to next
        }
      }
    }

    // Fallback to user home / appdata
    const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : os.homedir());
    const fallback = path.join(appData, 'antifan-browser-desktop', 'data');
    this.cachedDataRoot = path.resolve(fallback);
    return this.cachedDataRoot;
  }

  public static resetCache(): void {
    this.cachedDataRoot = null;
  }

  public static getProfileDir(customRoot?: string): string {
    return path.join(this.getDataRoot(customRoot), 'Profile');
  }

  public static getCacheDir(customRoot?: string): string {
    return path.join(this.getDataRoot(customRoot), 'Profile-cache');
  }

  public static getNetworkCacheDir(customRoot?: string): string {
    return path.join(this.getCacheDir(customRoot), 'network');
  }

  public static getGpuCacheDir(customRoot?: string): string {
    return path.join(this.getCacheDir(customRoot), 'gpu');
  }

  public static getConfigDir(customRoot?: string): string {
    return path.join(this.getDataRoot(customRoot), 'config');
  }

  public static getSessionsDir(customRoot?: string): string {
    return path.join(this.getDataRoot(customRoot), 'sessions');
  }

  public static getControlPlaneDir(customRoot?: string): string {
    return path.join(this.getDataRoot(customRoot), 'control-plane-v2');
  }

  public static getArtifactsDir(customRoot?: string): string {
    return path.join(this.getControlPlaneDir(customRoot), 'artifacts');
  }

  public static getRuntimeDir(customRoot?: string): string {
    return path.join(this.getDataRoot(customRoot), 'runtime');
  }

  /**
   * Initializes all required storage directories and applies Windows NTFS DACL security.
   */
  public static ensureDirectories(customRoot?: string): void {
    const dirs = [
      this.getDataRoot(customRoot),
      this.getProfileDir(customRoot),
      this.getCacheDir(customRoot),
      this.getNetworkCacheDir(customRoot),
      this.getGpuCacheDir(customRoot),
      this.getConfigDir(customRoot),
      this.getSessionsDir(customRoot),
      this.getControlPlaneDir(customRoot),
      this.getArtifactsDir(customRoot),
      this.getRuntimeDir(customRoot),
    ];

    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.warn(`[storage-locations] Failed to create directory ${dir}:`, err);
      }
    }

    // On Windows, harden the root data directory with user-only DACL
    if (process.platform === 'win32') {
      try {
        const sid = resolveCurrentUserSid();
        enforceProtectedDirectoryDacl(this.getDataRoot(customRoot), sid);
      } catch {
        // Fallback for non-elevated or mocked test environments
      }
    }
  }
}
