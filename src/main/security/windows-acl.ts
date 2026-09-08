/**
 * AntiFan Browser Desktop — Windows Directory & File DACL Security Utilities
 * Enforces protected NTFS access-control on app data directories and sensitive files
 * (fail-closed: exactly two explicit ACEs — SYSTEM + current user — with no inherited ACLs).
 * Moved out of the removed native-messaging module; storage-locations depends on it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
export interface FileDaclResult {
  enforced: boolean;
  platform: string;
  reason?: string;
}


export function resolveCurrentUserSid(): string {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
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

export function parseSavedSddl(savedAcl: string): string | null {
  const lines = savedAcl.split(/\r?\n/).filter(Boolean);
  return lines.find((line) => /^D:[A-Z]*\(/.test(line))?.trim() || null;
}

export function parseSavedDirectorySddl(savedAcl: string): string | null {
  return parseSavedSddl(savedAcl);
}

export function parseSavedFileSddl(savedAcl: string): string | null {
  return parseSavedSddl(savedAcl);
}

function readPathSddl(targetPath: string): string {
  const normalizedTarget = path.win32.normalize(targetPath);
  const savePath = path.win32.normalize(
    path.join(os.tmpdir(), `antifan-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
  );
  try {
    execFileSync('icacls.exe', [normalizedTarget, '/save', savePath], { stdio: 'pipe' });
    const sddl = parseSavedSddl(fs.readFileSync(savePath, 'utf16le'));
    if (!sddl) {
      throw new Error(`[AntiFan Security] icacls returned no DACL for ${normalizedTarget}`);
    }
    return sddl;
  } finally {
    try { fs.unlinkSync(savePath); } catch {}
  }
}

export function verifyProtectedSddl(
  sddl: string,
  userSid: string,
  targetType: 'directory' | 'file'
): boolean {
  if (!/^S-1-5-\d+(-\d+)+$/.test(userSid)) return false;
  // Isolate DACL: an SDDL string may contain O:owner G:group D:dacl S:sacl
  const daclIdx = sddl.indexOf('D:');
  if (daclIdx === -1) return false;
  const saclIdx = sddl.indexOf('S:', daclIdx);
  const daclPart = saclIdx !== -1 ? sddl.slice(daclIdx, saclIdx) : sddl.slice(daclIdx);

  const parenIdx = daclPart.indexOf('(');
  if (parenIdx === -1) return false;
  const controlFlags = daclPart.slice(2, parenIdx);
  if (!controlFlags.includes('P')) return false;

  // Filter out any SACL / Mandatory Label ACEs (e.g. ML / AU / AL)
  const aces = (daclPart.match(/\([^)]+\)/g) || []).filter(
    (ace) => !ace.startsWith('(ML;') && !ace.startsWith('(AU;') && !ace.startsWith('(AL;')
  );
  if (aces.length !== 2) return false;
  const expected: Record<string, true> = targetType === 'directory'
    ? {
        '(A;OICI;FA;;;SY)': true,
        [`(A;OICI;FA;;;${userSid})`]: true,
      }
    : {
        '(A;;FA;;;SY)': true,
        [`(A;;FA;;;${userSid})`]: true,
      };
  return aces.every((ace) => {
    if (expected[ace] !== true) return false;
    delete expected[ace];
    return true;
  }) && Object.keys(expected).length === 0;
}

export function hasProtectedDirectoryDacl(dirPath: string, userSid: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const sddl = readPathSddl(dirPath);
    return verifyProtectedSddl(sddl, userSid, 'directory');
  } catch {
    return false;
  }
}

export function buildDirectoryAclScript(dirPath: string, userSid: string): string {
  return `
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
    [System.IO.Directory]::SetAccessControl($dir, $acl);
  `;
}

export function enforceProtectedDirectoryDacl(dirPath: string, userSid: string): void {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
  }
  if (hasProtectedDirectoryDacl(dirPath, userSid)) return;
  // Fail-closed repair path: replace inherited ACLs with exactly two explicit ACEs.
  const psScript = buildDirectoryAclScript(dirPath, userSid);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
  if (!hasProtectedDirectoryDacl(dirPath, userSid)) {
    throw new Error(`[AntiFan Security] DACL verification failed after repair: ${dirPath}`);
  }
}

export function hasProtectedFileDacl(filePath: string, userSid: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const sddl = readPathSddl(filePath);
    return verifyProtectedSddl(sddl, userSid, 'file');
  } catch {
    return false;
  }
}

export function buildFileAclScript(filePath: string, userSid: string): string {
  return `
    $ErrorActionPreference = 'Stop';
    $file = '${filePath.replace(/'/g, "''")}';
    $userSid = New-Object System.Security.Principal.SecurityIdentifier('${userSid}');
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
    $acl = New-Object System.Security.AccessControl.FileSecurity;
    $acl.SetAccessRuleProtection($true, $false);
    $userRule = New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow);
    $systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow);
    $acl.AddAccessRule($userRule);
    $acl.AddAccessRule($systemRule);
    [System.IO.File]::SetAccessControl($file, $acl);
  `;
}

export function enforceProtectedFileDacl(
  filePath: string,
  userSid?: string
): FileDaclResult {
  if (process.platform !== 'win32') {
    return {
      enforced: false,
      platform: process.platform,
      reason: 'not enforced (platform)',
    };
  }

  const effectiveSid = userSid || resolveCurrentUserSid();
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('[AntiFan Security] Invalid file path provided for DACL enforcement.');
  }
  if (!/^S-1-5-\d+(-\d+)+$/.test(effectiveSid)) {
    throw new Error(`[AntiFan Security] Invalid Windows User SID provided for file DACL enforcement: ${effectiveSid}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`[AntiFan Security] File does not exist for DACL enforcement: ${filePath}`);
  }

  if (hasProtectedFileDacl(filePath, effectiveSid)) {
    return {
      enforced: true,
      platform: 'win32',
    };
  }

  // Fail-closed repair path: replace inherited ACLs with exactly two explicit ACEs.
  const psScript = buildFileAclScript(filePath, effectiveSid);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
  if (!hasProtectedFileDacl(filePath, effectiveSid)) {
    throw new Error(`[AntiFan Security] File DACL verification failed after repair: ${filePath}`);
  }
  return {
    enforced: true,
    platform: 'win32',
  };
}

export function applyProtectedFileDacl(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const sid = resolveCurrentUserSid();
    enforceProtectedFileDacl(filePath, sid);
  } catch {
    // Non-fatal in non-elevated or mock test environments
  }
}

export function atomicWriteWithDacl(targetPath: string, content: string): void {
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  applyProtectedFileDacl(tempPath);
  fs.renameSync(tempPath, targetPath);
  applyProtectedFileDacl(targetPath);
}