/**
 * AntiFan Browser Desktop — Windows Directory DACL Security Utilities
 * Enforces protected NTFS access-control on app data directories (fail-closed:
 * exactly two explicit ACEs — SYSTEM + current user — with no inherited ACLs).
 * Moved out of the removed native-messaging module; storage-locations depends on it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

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
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
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