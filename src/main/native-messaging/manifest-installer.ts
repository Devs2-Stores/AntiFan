import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export const HOST_NAME = 'com.antifan.bridge';
export const HOST_DESCRIPTION = 'AntiFan Browser Desktop Native Messaging Bridge';
export const COMPANION_EXTENSION_ID = 'khjcaadjohoclofjkkfblkbfbpmjjedp';
export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

export type SupportedBrowser = 'chrome' | 'edge' | 'brave';

export const WINDOWS_REGISTRY_KEYS: Record<SupportedBrowser, string> = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
};

export function getDefaultManifestPath(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'AntiFan', 'NativeMessagingHosts', `${HOST_NAME}.json`);
}

export function getDefaultHostBinaryPath(): string {
  // 1. If running inside packaged Electron, check sibling to process.execPath
  if (process.execPath && !process.execPath.endsWith('node.exe') && !process.execPath.endsWith('node')) {
    const appDir = path.dirname(process.execPath);
    const candidateExe = path.join(appDir, 'antifan-bridge-host.exe');
    if (fs.existsSync(candidateExe)) {
      return candidateExe;
    }
  }

  // 2. Check workspace dev bin directory
  const workspaceBin = path.join(process.cwd(), 'bin', 'antifan-bridge-host.exe');
  if (fs.existsSync(workspaceBin)) {
    return workspaceBin;
  }

  // 3. Fallback to LocalAppData
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'AntiFan', 'bin', 'antifan-bridge-host.exe');
}
export function generateHostManifest(extensionId: string, hostBinaryPath?: string): NativeHostManifest {
  const binaryPath = hostBinaryPath || getDefaultHostBinaryPath();
  const cleanId = extensionId.trim().replace(/^chrome-extension:\/\/|\/$/g, '');

  return {
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    path: binaryPath,
    type: 'stdio',
    allowed_origins: [
      `chrome-extension://${cleanId}/`,
    ],
  };
}

export function writeManifestFile(manifest: NativeHostManifest, targetPath?: string): string {
  const manifestPath = targetPath || getDefaultManifestPath();
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

export function registerWindowsRegistryKey(registryKey: string, manifestPath: string): boolean {
  try {
    execFileSync('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    console.error(`[NativeInstaller] Failed to write registry key ${registryKey}:`, err);
    return false;
  }
}

export function unregisterWindowsRegistryKey(registryKey: string): boolean {
  try {
    execFileSync('reg.exe', ['delete', registryKey, '/f'], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export interface InstallResult {
  success: boolean;
  manifestPath: string;
  registeredKeys: string[];
  failedKeys: string[];
}

export async function installNativeHost(
  extensionId: string,
  options: { hostBinaryPath?: string; manifestPath?: string; browsers?: SupportedBrowser[] } = {}
): Promise<InstallResult> {
  const manifest = generateHostManifest(extensionId, options.hostBinaryPath);
  const manifestPath = writeManifestFile(manifest, options.manifestPath);

  const browsers: SupportedBrowser[] = options.browsers || ['chrome', 'edge', 'brave'];
  const registeredKeys: string[] = [];
  const failedKeys: string[] = [];

  if (process.platform === 'win32') {
    for (const browser of browsers) {
      const regKey = WINDOWS_REGISTRY_KEYS[browser];
      const ok = registerWindowsRegistryKey(regKey, manifestPath);
      if (ok) {
        registeredKeys.push(regKey);
      } else {
        failedKeys.push(regKey);
      }
    }
  }

  return {
    success: failedKeys.length === 0,
    manifestPath,
    registeredKeys,
    failedKeys,
  };
}

export async function uninstallNativeHost(
  options: { manifestPath?: string; browsers?: SupportedBrowser[] } = {}
): Promise<{ success: boolean; uninstalledKeys: string[] }> {
  const manifestPath = options.manifestPath || getDefaultManifestPath();
  const browsers: SupportedBrowser[] = options.browsers || ['chrome', 'edge', 'brave'];
  const uninstalledKeys: string[] = [];

  if (process.platform === 'win32') {
    for (const browser of browsers) {
      const regKey = WINDOWS_REGISTRY_KEYS[browser];
      unregisterWindowsRegistryKey(regKey);
      uninstalledKeys.push(regKey);
    }
  }

  if (fs.existsSync(manifestPath)) {
    try {
      fs.unlinkSync(manifestPath);
    } catch {}
  }

  return {
    success: true,
    uninstalledKeys,
  };
}
