import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export interface RuntimeBridgeAuth {
  instanceUuid: string;
  launchNonce: string;
  socketPath: string;
  port: number;
  createdAt: number;
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

export function enforceProtectedDirectoryDacl(dirPath: string, userSid: string): void {
  if (process.platform !== 'win32') {
    throw new Error('[AntiFan Security] Native Messaging and Windows ACL enforcement is only supported on Windows (win32).');
  }

  // Fail-Closed PowerShell script: Disables inheritance, purges all existing ACEs, and asserts strict DACL invariants
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
    
    # Rigorous Post-set Invariant Verification
    $verified = Get-Acl -LiteralPath $dir;
    if (-not $verified.AreAccessRulesProtected) {
      throw "DACL_INVARIANT_VIOLATION: Access rules are not protected against inheritance.";
    }
    
    $rules = @($verified.Access);
    if ($rules.Count -ne 2) {
      throw "DACL_INVARIANT_VIOLATION: Expected exactly 2 ACEs, found $($rules.Count).";
    }
    
    $allowedSids = @($userSid.Value, 'S-1-5-18');
    foreach ($rule in $rules) {
      $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
      if ($allowedSids -notcontains $ruleSid) {
        throw "DACL_INVARIANT_VIOLATION: Unauthorized SID detected: \${ruleSid}";
      }
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
        throw "DACL_INVARIANT_VIOLATION: Unexpected AccessControlType: $($rule.AccessControlType)";
      }
      if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        throw "DACL_INVARIANT_VIOLATION: Incomplete FileSystemRights for \${ruleSid} - $($rule.FileSystemRights)";
      }
      if ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit') {
        throw "DACL_INVARIANT_VIOLATION: Incorrect InheritanceFlags: $($rule.InheritanceFlags)";
      }
      if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
        throw "DACL_INVARIANT_VIOLATION: Incorrect PropagationFlags: $($rule.PropagationFlags)";
      }
    }
  `;

  // Fail-closed execution: Throws immediately on non-zero exit code or verification failure
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
}

export function setupSecureRuntimeAuth(
  instanceUuid: string,
  launchNonce: string,
  port: number,
  customRuntimeDir?: string
): { runtimeDir: string; authFile: string; socketPath: string } {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const runtimeDir = customRuntimeDir || path.join(localAppData, 'AntiFan', 'runtime');
  const authFile = path.join(runtimeDir, 'bridge-auth.json');
  const socketPath = `\\\\.\\pipe\\antifan-bridge-ipc-${instanceUuid}`;

  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }

  // Enforce explicit fail-closed DACL before writing secret nonce
  const userSid = resolveCurrentUserSid();
  enforceProtectedDirectoryDacl(runtimeDir, userSid);

  const authData: RuntimeBridgeAuth = {
    instanceUuid,
    launchNonce,
    socketPath,
    port,
    createdAt: Date.now(),
  };

  // Write nonce file inside verified protected directory
  fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf8');
  return { runtimeDir, authFile, socketPath };
}
