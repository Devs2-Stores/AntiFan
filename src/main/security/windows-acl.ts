/**
 * AntiFan Browser Desktop — Windows Directory & File DACL Security Utilities
 * Enforces protected NTFS access-control on app data directories and sensitive files
 * (fail-closed: exactly two explicit ACEs — SYSTEM + current user — with no inherited ACLs).
 * Moved out of the removed native-messaging module; storage-locations depends on it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Async spawn: icacls/powershell take seconds and must never stall the main
// thread. windowsHide matches the *Sync default (no console window flash).
const execFileAsync = promisify(execFile);
export interface FileDaclResult {
  enforced: boolean;
  platform: string;
  reason?: string;
}

let cachedUserSid: string | null = null;

export async function resolveCurrentUserSid(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
  }

  if (cachedUserSid) {
    return cachedUserSid;
  }

  const { stdout } = await execFileAsync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const output = String(stdout).trim();
  const parts = output.split(',');
  const rawSid = parts[1];
  if (rawSid) {
    const sid = rawSid.replace(/"/g, '').trim();
    if (/^S-1-5-\d+(-\d+)+$/.test(sid)) {
      cachedUserSid = sid;
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

async function readPathSddl(targetPath: string): Promise<string> {
  const normalizedTarget = path.win32.normalize(targetPath);
  const savePath = path.win32.normalize(
    path.join(os.tmpdir(), `antifan-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
  );
  try {
    await execFileAsync('icacls.exe', [normalizedTarget, '/save', savePath], { windowsHide: true });
    const sddl = parseSavedSddl(fs.readFileSync(savePath, 'utf16le'));
    if (!sddl) {
      throw new Error(`[AntiFan Security] icacls returned no DACL for ${normalizedTarget}`);
    }
    return sddl;
  } finally {
    try { fs.unlinkSync(savePath); } catch {}
  }
}

/**
 * Batched SDDL read: one `icacls /save` invocation covers every path, versus
 * one process spawn per path with readPathSddl. The save file stores entries
 * as name-line / SDDL-line pairs (UTF-16); a path whose SDDL cannot be parsed
 * is simply absent from the result, and callers treat that as "needs repair"
 * — the safe direction.
 */
async function readPathsSddl(targetPaths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (targetPaths.length === 0) return result;
  const savePath = path.win32.normalize(
    path.join(os.tmpdir(), `antifan-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
  );
  try {
    const normalized = targetPaths.map((p) => path.win32.normalize(p));
    await execFileAsync('icacls.exe', [...normalized, '/save', savePath], { windowsHide: true });
    const lines = fs.readFileSync(savePath, 'utf16le').split(/\r?\n/).filter((l) => l.trim().length > 0);
    // Entries pair a bare path line with its SDDL line (contains 'D:').
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const name = (lines[i] ?? '').trim();
      const sddl = (lines[i + 1] ?? '').trim();
      if (!sddl.includes('D:')) continue;
      // Full-path equality only: a basename fallback could attribute one path's
      // valid SDDL to a different, unprotected path — the unsafe direction.
      const match = targetPaths.find((p) => path.win32.normalize(p).toLowerCase() === name.toLowerCase());
      if (match) result.set(match, sddl);
    }
  } catch {
    // Fall through: callers fall back to per-path reads for missing entries.
  } finally {
    try { fs.unlinkSync(savePath); } catch {}
  }
  return result;
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

export async function hasProtectedDirectoryDacl(dirPath: string, userSid: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const sddl = await readPathSddl(dirPath);
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

export async function enforceProtectedDirectoryDacl(dirPath: string, userSid: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
  }
  if (await hasProtectedDirectoryDacl(dirPath, userSid)) return;
  // Fail-closed repair path: replace inherited ACLs with exactly two explicit ACEs.
  const psScript = buildDirectoryAclScript(dirPath, userSid);
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true });
  if (!(await hasProtectedDirectoryDacl(dirPath, userSid))) {
    throw new Error(`[AntiFan Security] DACL verification failed after repair: ${dirPath}`);
  }
}

export async function hasProtectedFileDacl(filePath: string, userSid: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const sddl = await readPathSddl(filePath);
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

export function buildPathsAclScript(paths: string[], userSid: string): string {
  const formattedPaths = paths
    .map((p) => `'${p.replace(/'/g, "''")}'`)
    .join(',\n      ');

  return `
    $ErrorActionPreference = 'Stop';
    $userSid = New-Object System.Security.Principal.SecurityIdentifier('${userSid}');
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');

    $fileUserRule = New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow);
    $fileSystemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow);

    $dirUserRule = New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);
    $dirSystemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);

    $paths = @(
      ${formattedPaths}
    );

    foreach ($p in $paths) {
      if ([System.IO.Directory]::Exists($p)) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity;
        $acl.SetAccessRuleProtection($true, $false);
        $acl.AddAccessRule($dirUserRule);
        $acl.AddAccessRule($dirSystemRule);
        [System.IO.Directory]::SetAccessControl($p, $acl);
      } elseif ([System.IO.File]::Exists($p)) {
        $acl = New-Object System.Security.AccessControl.FileSecurity;
        $acl.SetAccessRuleProtection($true, $false);
        $acl.AddAccessRule($fileUserRule);
        $acl.AddAccessRule($fileSystemRule);
        [System.IO.File]::SetAccessControl($p, $acl);
      } else {
        throw "Path does not exist: $p";
      }
    }
  `;
}

export async function enforceProtectedPathsDacl(
  paths: string[],
  userSid?: string
): Promise<FileDaclResult> {
  if (process.platform !== 'win32') {
    return {
      enforced: false,
      platform: process.platform,
      reason: 'not enforced (platform)',
    };
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    return {
      enforced: true,
      platform: 'win32',
    };
  }

  const effectiveSid = userSid || (await resolveCurrentUserSid());
  if (!/^S-1-5-\d+(-\d+)+$/.test(effectiveSid)) {
    throw new Error(`[AntiFan Security] Invalid Windows User SID provided for file DACL enforcement: ${effectiveSid}`);
  }

  for (const p of paths) {
    if (!p || typeof p !== 'string') {
      throw new Error('[AntiFan Security] Invalid file path provided for DACL enforcement.');
    }
    if (!fs.existsSync(p)) {
      throw new Error(`[AntiFan Security] File does not exist for DACL enforcement: ${p}`);
    }
  }

  const needingRepair: string[] = [];
  // One icacls spawn verifies every path; per-path reads only for entries the
  // batched save could not resolve (parse gaps are treated as unprotected).
  const batched = await readPathsSddl(paths);
  for (const p of paths) {
    const isDir = fs.statSync(p).isDirectory();
    let sddl = batched.get(p) ?? null;
    if (sddl === null) {
      try {
        sddl = await readPathSddl(p);
      } catch {
        sddl = null;
      }
    }
    const isProtected = sddl !== null && verifyProtectedSddl(sddl, effectiveSid, isDir ? 'directory' : 'file');
    if (!isProtected) {
      needingRepair.push(p);
    }
  }
  if (needingRepair.length === 0) {
    return {
      enforced: true,
      platform: 'win32',
    };
  }

  const psScript = buildPathsAclScript(needingRepair, effectiveSid);
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true });

  for (const p of needingRepair) {
    const isDir = fs.statSync(p).isDirectory();
    const isProtected = isDir
      ? await hasProtectedDirectoryDacl(p, effectiveSid)
      : await hasProtectedFileDacl(p, effectiveSid);
    if (!isProtected) {
      throw new Error(`[AntiFan Security] File DACL verification failed after repair: ${p}`);
    }
  }

  return {
    enforced: true,
    platform: 'win32',
  };
}

export async function enforceProtectedFileDacl(
  filePath: string,
  userSid?: string
): Promise<FileDaclResult> {
  return enforceProtectedPathsDacl([filePath], userSid);
}

export async function applyProtectedPathsDacl(paths: string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!Array.isArray(paths) || paths.length === 0) return;
  const sid = await resolveCurrentUserSid();
  await enforceProtectedPathsDacl(paths, sid);
}

export async function applyProtectedFileDacl(filePath: string): Promise<void> {
  await applyProtectedPathsDacl([filePath]);
}

export async function atomicWriteWithDacl(targetPath: string, content: string): Promise<void> {
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, '', { encoding: 'utf8', mode: 0o600 });
  try {
    await applyProtectedFileDacl(tempPath);
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tempPath, targetPath);
    } catch {
      try {
        if (!fs.existsSync(targetPath)) {
          fs.writeFileSync(targetPath, '', { encoding: 'utf8', mode: 0o600 });
        }
        await applyProtectedFileDacl(targetPath);
        fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o600 });
        try { fs.unlinkSync(tempPath); } catch {}
      } catch (fallbackErr) {
        try { fs.unlinkSync(targetPath); } catch {}
        try { fs.unlinkSync(tempPath); } catch {}
        throw fallbackErr;
      }
    }
    await applyProtectedFileDacl(targetPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}