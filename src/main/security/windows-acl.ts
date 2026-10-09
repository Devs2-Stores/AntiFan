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

/**
 * Bounded execution deadline (15,000ms) for Windows security helper binaries
 * (`whoami`, `icacls.exe`, `powershell.exe`).
 *
 * Sits far above the measured round trips on this platform:
 * - `whoami /user`: 15-50ms
 * - `icacls.exe /save`: 25-250ms
 * - `powershell.exe` ACL repair: 800-2,500ms (cold CLR startup and module load)
 * Even under heavy system load, offline domain controller discovery latency, or active
 * Windows Defender / AV filter driver scanning, these operations complete well under 10s.
 *
 * Sits well below the caller durability and user-patience timeout bounds (~30s+),
 * ensuring that a hung process (e.g. `icacls.exe` blocked on a locked file, offline network
 * share, or filter driver hold; or `whoami` stalled on an unreachable domain controller)
 * is forcefully terminated via SIGKILL rather than causing an unbounded hang in state
 * persistence or security enforcement paths.
 */
export const WINDOWS_ACL_SPAWN_TIMEOUT_MS = 15_000;

export interface FileDaclResult {
  enforced: boolean;
  platform: string;
  reason?: string;
}

let cachedUserSid: string | null = null;

/**
 * Reset cached user SID for deterministic testing.
 */
export function _resetCachedUserSidForTesting(): void {
  cachedUserSid = null;
}

export async function resolveCurrentUserSid(
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
  }

  if (cachedUserSid) {
    return cachedUserSid;
  }

  // Armed with a bounded timeout: whoami can hang indefinitely if querying an
  // offline domain controller or if AV/filter drivers stall child process
  // initialization. Pin the System32 binary: a bare 'whoami' resolves through
  // PATH first, and POSIX-shadowed whoami.exe (Git usr/bin, MSYS2, Cygwin)
  // rejects '/user' with 'extra operand' — silently breaking every DACL path.
  const whoamiBin = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const { stdout } = await execFileAsync(whoamiBin, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
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

async function readPathSddl(
  targetPath: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<string> {
  const normalizedTarget = path.win32.normalize(targetPath);
  const savePath = path.win32.normalize(
    path.join(os.tmpdir(), `antifan-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
  );
  try {
    // Armed with a bounded timeout: icacls can hang indefinitely on locked files,
    // offline network shares, roaming profile paths, or AV filter driver locks.
    await execFileAsync('icacls.exe', [normalizedTarget, '/save', savePath], {
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
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
 * Batched SDDL read: one `icacls <dir>\* /save` per parent directory covers
 * every requested child, versus one process spawn per path with readPathSddl.
 * icacls accepts a single file argument (a second one is "Invalid parameter"),
 * and its save file names each entry by basename only, so entries are matched
 * within the directory that was listed - where a basename is the full identity.
 * The save file (UTF-16) holds a name line followed by its SDDL line; a name
 * can never contain ':' while every SDDL does. A path whose SDDL is not found
 * is absent from the result and callers treat it as "needs repair" - the safe
 * direction.
 */
async function readPathsSddl(
  targetPaths: string[],
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const byDir = new Map<string, Map<string, string>>();
  for (const p of targetPaths) {
    const full = path.win32.normalize(p);
    const dir = path.win32.dirname(full);
    const base = path.win32.basename(full);
    // A drive root has no parent listing; it falls back to a per-path read.
    if (!base || dir === full) continue;
    let group = byDir.get(dir);
    if (!group) {
      group = new Map();
      byDir.set(dir, group);
    }
    group.set(base.toLowerCase(), p);
  }
  await Promise.all([...byDir].map(async ([dir, group]) => {
    const savePath = path.win32.normalize(
      path.join(os.tmpdir(), `antifan-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
    );
    try {
      // Armed with a bounded timeout: icacls can stall on a locked or inaccessible
      // child. On timeout/failure the group stays unresolved (safe direction).
      await execFileAsync('icacls.exe', [path.win32.join(dir, '*'), '/save', savePath], {
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      const lines = fs.readFileSync(savePath, 'utf16le').replace(/^\uFEFF/, '').split(/\r?\n/);
      let name: string | null = null;
      for (const line of lines) {
        if (line.length === 0) continue;
        if (!line.includes(':')) {
          name = line;
          continue;
        }
        const match = name === null ? undefined : group.get(name.toLowerCase());
        if (match && line.includes('D:')) result.set(match, line.trim());
        name = null;
      }
    } catch {
      // Fall through: callers fall back to per-path reads for missing entries.
    } finally {
      try { fs.unlinkSync(savePath); } catch {}
    }
  }));
  return result;
}

/**
 * Fast DACL repair: `icacls /inheritance:r /grant:r` drops the inherited ACEs
 * and sets exactly the user + SYSTEM grants in one ~100 ms spawn, where the
 * PowerShell rewrite pays 3-5 s of CLR startup per call. `/grant:r` only
 * replaces grants for the SIDs it names, so a foreign explicit ACE (an extra
 * allow or a deny) survives it; callers re-verify and fall back to the
 * exact-set PowerShell rewrite for whatever is still unprotected.
 */
async function grantProtectedDaclWithIcacls(
  targetPath: string,
  userSid: string,
  isDirectory: boolean,
  timeoutMs: number
): Promise<void> {
  const rights = isDirectory ? '(OI)(CI)F' : 'F';
  await execFileAsync(
    'icacls.exe',
    [path.win32.normalize(targetPath), '/inheritance:r', '/grant:r', `*${userSid}:${rights}`, `*S-1-5-18:${rights}`],
    { windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' }
  );
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

export async function hasProtectedDirectoryDacl(
  dirPath: string,
  userSid: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const sddl = await readPathSddl(dirPath, timeoutMs);
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

export async function enforceProtectedDirectoryDacl(
  dirPath: string,
  userSid: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Windows ACL enforcement is only supported on Windows (win32).');
  }
  if (await hasProtectedDirectoryDacl(dirPath, userSid, timeoutMs)) return;
  // Fail-closed repair path: replace inherited ACLs with exactly two explicit ACEs.
  await grantProtectedDaclWithIcacls(dirPath, userSid, true, timeoutMs);
  if (await hasProtectedDirectoryDacl(dirPath, userSid, timeoutMs)) return;
  // A foreign explicit ACE survived icacls: only the exact-set rewrite removes it.
  const psScript = buildDirectoryAclScript(dirPath, userSid);
  // Armed with a bounded timeout: powershell startup or SetAccessControl can hang under
  // CLR initialization issues, AV inspection, or filesystem lock contention.
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (!(await hasProtectedDirectoryDacl(dirPath, userSid, timeoutMs))) {
    throw new Error(`[AntiFan Security] DACL verification failed after repair: ${dirPath}`);
  }
}

export async function hasProtectedFileDacl(
  filePath: string,
  userSid: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const sddl = await readPathSddl(filePath, timeoutMs);
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
  userSid?: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
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

  const effectiveSid = userSid || (await resolveCurrentUserSid(timeoutMs));
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

  const isDirectory = new Map<string, boolean>();
  for (const p of paths) isDirectory.set(p, fs.statSync(p).isDirectory());
  // One icacls spawn per parent directory reads every path; per-path reads only
  // for entries the batched save could not resolve (unresolved = unprotected).
  const unprotectedAmong = async (candidates: string[]): Promise<string[]> => {
    const batched = await readPathsSddl(candidates, timeoutMs);
    const verdicts = await Promise.all(candidates.map(async (p) => {
      let sddl = batched.get(p) ?? null;
      if (sddl === null) {
        try {
          sddl = await readPathSddl(p, timeoutMs);
        } catch {
          sddl = null;
        }
      }
      return sddl !== null && verifyProtectedSddl(sddl, effectiveSid, isDirectory.get(p) ? 'directory' : 'file');
    }));
    return candidates.filter((_, i) => !verdicts[i]);
  };

  const needingRepair = await unprotectedAmong(paths);
  if (needingRepair.length === 0) {
    return {
      enforced: true,
      platform: 'win32',
    };
  }

  await Promise.all(needingRepair.map((p) => grantProtectedDaclWithIcacls(p, effectiveSid, isDirectory.get(p) === true, timeoutMs)));
  const stillOpen = await unprotectedAmong(needingRepair);
  if (stillOpen.length === 0) {
    return {
      enforced: true,
      platform: 'win32',
    };
  }

  // A foreign explicit ACE survived icacls: only the exact-set rewrite removes it.
  const psScript = buildPathsAclScript(stillOpen, effectiveSid);
  // Armed with a bounded timeout: powershell execution must never stall callers indefinitely
  // during multi-path ACL repair.
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });

  const failed = await unprotectedAmong(stillOpen);
  if (failed.length > 0) {
    throw new Error(`[AntiFan Security] File DACL verification failed after repair: ${failed[0]}`);
  }

  return {
    enforced: true,
    platform: 'win32',
  };
}

export async function enforceProtectedFileDacl(
  filePath: string,
  userSid?: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<FileDaclResult> {
  return enforceProtectedPathsDacl([filePath], userSid, timeoutMs);
}

export async function applyProtectedPathsDacl(
  paths: string[],
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!Array.isArray(paths) || paths.length === 0) return;
  const sid = await resolveCurrentUserSid(timeoutMs);
  await enforceProtectedPathsDacl(paths, sid, timeoutMs);
}

export async function applyProtectedFileDacl(
  filePath: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<void> {
  await applyProtectedPathsDacl([filePath], timeoutMs);
}

export async function atomicWriteWithDacl(
  targetPath: string,
  content: string,
  timeoutMs: number = WINDOWS_ACL_SPAWN_TIMEOUT_MS
): Promise<void> {
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, '', { encoding: 'utf8', mode: 0o600 });
  try {
    await applyProtectedFileDacl(tempPath, timeoutMs);
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tempPath, targetPath);
    } catch {
      try {
        if (!fs.existsSync(targetPath)) {
          fs.writeFileSync(targetPath, '', { encoding: 'utf8', mode: 0o600 });
        }
        await applyProtectedFileDacl(targetPath, timeoutMs);
        fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o600 });
        try { fs.unlinkSync(tempPath); } catch {}
      } catch (fallbackErr) {
        try { fs.unlinkSync(targetPath); } catch {}
        try { fs.unlinkSync(tempPath); } catch {}
        throw fallbackErr;
      }
    }
    await applyProtectedFileDacl(targetPath, timeoutMs);
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}