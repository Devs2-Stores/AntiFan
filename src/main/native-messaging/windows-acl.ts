import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export interface RuntimeBridgeAuth {
  instanceUuid: string;
  launchNonce: string;
  socketPath: string;
  port: number;
  pid: number;
  createdAt: number;
}

export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export function resolveCurrentUserSid(): string {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Native Messaging and Windows ACL enforcement is only supported on Windows (win32).');
  }

  const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim();
  const parts = output.split(',');
  const rawSid = parts[1];
  if (rawSid) {
    const sid = rawSid.replace(/"/g, '').trim();
    if (/^S-1-5-\d+(-\d+)+$/.test(sid)) {
      return sid;
    }
  }
  throw new Error(`[AntiFan Security] Failed to resolve valid Windows User SID: ${output}`);
}

export function parseSavedDirectorySddl(savedAcl: string): string | null {
  const lines = savedAcl.split(/\r?\n/).filter(Boolean);
  return lines.find((line) => /^D:[A-Z]*\(/.test(line))?.trim() || null;
}

function readDirectorySddl(dirPath: string): string {
  const savePath = path.join(os.tmpdir(), `antifan-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  try {
    execFileSync('icacls.exe', [dirPath, '/save', savePath], { stdio: 'pipe' });
    const sddl = parseSavedDirectorySddl(fs.readFileSync(savePath, 'utf16le'));
    if (!sddl) {
      throw new Error(`[AntiFan Security] icacls returned no DACL for ${dirPath}`);
    }
    return sddl;
  } finally {
    try { fs.unlinkSync(savePath); } catch {}
  }
}

export function hasProtectedDirectoryDacl(dirPath: string, userSid: string): boolean {
  if (process.platform !== 'win32') return false;
  if (!/^S-1-5-\d+(-\d+)+$/.test(userSid)) return false;
  try {
    const sddl = readDirectorySddl(dirPath);
    const controlFlags = sddl.slice(2, sddl.indexOf('('));
    if (!controlFlags.includes('P')) return false;
    const aces = sddl.match(/\([^)]+\)/g) || [];
    if (aces.length !== 2) return false;
    const expected: Record<string, true> = {
      '(A;OICI;FA;;;SY)': true,
      [`(A;OICI;FA;;;${userSid})`]: true,
    };
    return aces.every((ace) => {
      if (expected[ace] !== true) return false;
      delete expected[ace];
      return true;
    }) && Object.keys(expected).length === 0;
  } catch {
    return false;
  }
}

export function enforceProtectedDirectoryDacl(dirPath: string, userSid: string): void {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Native Messaging and Windows ACL enforcement is only supported on Windows (win32).');
  }
  if (hasProtectedDirectoryDacl(dirPath, userSid)) return;

  // Fail-closed repair path: replace inherited ACLs with exactly two explicit ACEs.
  const psScript = `
    $ErrorActionPreference = 'Stop';
    $dir = '${dirPath.replace(/'/g, "''")}';
    $userSid = New-Object System.Security.Principal.SecurityIdentifier('${userSid}');
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
    $acl = New-Object System.Security.AccessControl.DirectorySecurity;
    $acl.SetAccessRuleProtection($true, $false);
    $userRule = New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);
    $systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);
    $acl.AddAccessRule($userRule);
    $acl.AddAccessRule($systemRule);
    Set-Acl -LiteralPath $dir -AclObject $acl;
  `;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
  if (!hasProtectedDirectoryDacl(dirPath, userSid)) {
    throw new Error(`[AntiFan Security] DACL verification failed after repair: ${dirPath}`);
  }
}

export function prepareSecureRuntimeDirectory(runtimeDir: string): void {
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }
  if (process.platform === 'win32') {
    const userSid = resolveCurrentUserSid();
    enforceProtectedDirectoryDacl(runtimeDir, userSid);
  }
}

export function writeRuntimeAuthFile(auth: RuntimeBridgeAuth, runtimeDir: string): string {
  prepareSecureRuntimeDirectory(runtimeDir);
  const authFile = path.join(runtimeDir, 'bridge-auth.json');
  const tmpFile = path.join(runtimeDir, `bridge-auth.${process.pid}.${auth.instanceUuid}.tmp`);
  const content = JSON.stringify(auth, null, 2);
  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    fs.renameSync(tmpFile, authFile);
  } catch {
    fs.writeFileSync(authFile, content, 'utf8');
  }
  return authFile;
}

export function removeRuntimeAuthFile(instanceUuid: string, runtimeDir: string): boolean {
  const authFile = path.join(runtimeDir, 'bridge-auth.json');
  if (!fs.existsSync(authFile)) return false;
  try {
    const raw = fs.readFileSync(authFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeBridgeAuth>;
    if (parsed.instanceUuid === instanceUuid) {
      fs.unlinkSync(authFile);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface RuntimeLockInfo {
  instanceUuid: string;
  pid: number;
  createdAt: number;
}

export function acquireRuntimeOwnershipLock(
  instanceUuid: string,
  runtimeDir: string,
  pid: number = process.pid,
  maxRetries = 5
): { acquired: boolean; currentOwner?: RuntimeLockInfo; lockPath: string } {
  prepareSecureRuntimeDirectory(runtimeDir);
  const lockPath = path.join(runtimeDir, 'bridge-auth.lock');
  const lockData: RuntimeLockInfo = {
    instanceUuid,
    pid,
    createdAt: Date.now(),
  };
  const lockJson = JSON.stringify(lockData, null, 2);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, lockJson, 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, lockPath };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }

      let observedRaw: string | null = null;
      let observedOwner: RuntimeLockInfo | null = null;
      try {
        observedRaw = fs.readFileSync(lockPath, 'utf8');
        observedOwner = JSON.parse(observedRaw) as RuntimeLockInfo;
      } catch {}

      if (observedOwner && typeof observedOwner.pid === 'number') {
        if (observedOwner.pid === pid && observedOwner.instanceUuid === instanceUuid) {
          return { acquired: true, currentOwner: observedOwner, lockPath };
        }
        if (isProcessAlive(observedOwner.pid)) {
          return { acquired: false, currentOwner: observedOwner, lockPath };
        }
      }

      if (observedRaw !== null) {
        try {
          const currentContent = fs.readFileSync(lockPath, 'utf8');
          if (currentContent === observedRaw) {
            fs.unlinkSync(lockPath);
          }
        } catch {}
      }
    }
  }

  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const owner = JSON.parse(raw) as RuntimeLockInfo;
    return { acquired: false, currentOwner: owner, lockPath };
  } catch {
    return { acquired: false, lockPath };
  }
}

export function releaseRuntimeOwnershipLock(instanceUuid: string, runtimeDir: string): boolean {
  const lockPath = path.join(runtimeDir, 'bridge-auth.lock');
  if (!fs.existsSync(lockPath)) return false;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const owner = JSON.parse(raw) as Partial<RuntimeLockInfo>;
    if (owner.instanceUuid === instanceUuid) {
      fs.unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function setupSecureRuntimeAuth(
  instanceUuid: string,
  launchNonce: string,
  port: number,
  runtimeDir: string,
  pid: number = process.pid
): { runtimeDir: string; authFile: string; socketPath: string } {
  prepareSecureRuntimeDirectory(runtimeDir);
  const socketPath = `\\\\.\\pipe\\antifan-bridge-ipc-${instanceUuid}`;
  const authData: RuntimeBridgeAuth = {
    instanceUuid,
    launchNonce,
    socketPath,
    port,
    pid,
    createdAt: Date.now(),
  };
  const authFile = writeRuntimeAuthFile(authData, runtimeDir);
  return { runtimeDir, authFile, socketPath };
}
