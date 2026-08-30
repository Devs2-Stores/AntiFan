---
phase: 2
title: "Zero-Touch Local Named Pipe IPC & Mutual Authentication Layer"
status: ready
priority: P1
effort: "4h"
dependencies: ["1"]
---

# Phase 2: Zero-Touch Local Named Pipe IPC & Mutual Authentication Layer

## Overview
Phase 2 eliminates the friction of manual token copying by establishing a high-speed, authenticated Local Inter-Process Communication (IPC) transport between the Native Messaging Host and AntiFan Desktop on Windows. Using Windows Named Pipes (`\\.\pipe\antifan-bridge-ipc-<UUID>`), the extension automatically negotiates an ephemeral session token upon startup, storing it in memory (`chrome.storage.session`) for seamless zero-touch pairing.
---

## Requirements

1. **Windows Named Pipe IPC Transport & Pipe Squatting Protection**:
   - **Windows**: Local Named Pipe `\\\\.\\pipe\\antifan-bridge-ipc-<INSTANCE_UUID>` where `INSTANCE_UUID` is generated dynamically per desktop launch.
   - **Kernel-Level Named Pipe Security Descriptor**: The Named Pipe server is created with an explicit Win32 Security Descriptor Definition Language (SDDL) string `D:P(A;;GA;;;<CURRENT_USER_SID>)(A;;GA;;;SY)` (where `<CURRENT_USER_SID>` is resolved at runtime via `whoami /user` or `GetTokenInformation`). This ensures the Windows kernel rejects pipe connection requests from any other user SID before application code executes.
   - **Explicit Windows DACL Isolation for Nonce File**: AntiFan Desktop resolves `<CURRENT_USER_SID>`, initializes `%LOCALAPPDATA%\\AntiFan\\runtime`, and enforces an explicit protected DACL `D:P(A;OICI;FA;;;<CURRENT_USER_SID>)(A;OICI;FA;;;SY)` (purging all inherited and third-party explicit ACEs while retaining required Local SYSTEM and current user Full Access).
   - **Local Nonce Secret Gate**: The 256-bit runtime launch nonce is written to `%LOCALAPPDATA%\\AntiFan\\runtime\\bridge-auth.json` inside this DACL-restricted directory. The Native Messaging Host reads this protected local file and supplies the `launchNonce` in its `HANDSHAKE` payload to complete mutual pairing.
   - The Extension background service worker initiates connection via `chrome.runtime.connectNative('com.antifan.bridge')`.
   - Native Host reads the local `bridge-auth.json` launch nonce and connects to AntiFan Desktop's Local IPC socket.
   - Native Host transmits `{ action: 'HANDSHAKE', launchNonce }` over stream-framed IPC.
   - AntiFan Desktop verifies `launchNonce` against the active runtime instance and issues an ephemeral scoped session token.
   - The Extension persists the token exclusively in `chrome.storage.session` (in-memory, flushed on browser close).
3. **Stream-Safe IPC Framing**:
   - Local IPC socket uses 32-bit LE uint32 length prefixing matching Phase 1 (`NativeMessageDecoder`) to ensure fragmented or concatenated chunks never corrupt JSON parsing.
4. **MV3 Service Worker Lifecycle Resilience**:
   - Extension service worker gates all cookie sync operations behind an `ensureConnected()` asynchronous promise.
   - Uses `chrome.alarms` for background reconnection retries to survive MV3 30-second service worker suspension.
   - Desktop toolbar and Extension popup reflect real-time pairing status (`PAIRED_ZERO_TOUCH` / `DESKTOP_OFFLINE`).
---

## Architecture & Handshake Flow

```
┌─────────────────────────┐          ┌───────────────────────┐          ┌───────────────────────────┐
│ Chrome Extension        │          │ Native Messaging Host │          │ AntiFan Desktop           │
│ (Background Worker)     │          │ (antifan-bridge-host) │          │ (BridgeServer & IPC Host) │
└────────────┬────────────┘          └───────────┬───────────┘          └─────────────┬─────────────┘
             │                                   │                                    │
             │ 1. connectNative('com.antifan')   │                                    │
             │──────────────────────────────────>│                                    │
             │                                   │ 2. Connects Local Named Pipe       │
             │                                   │    (\\.\pipe\antifan-bridge-ipc)   │
             │                                   │───────────────────────────────────>│
             │                                   │                                    │ 3. Validate OS Peer
             │                                   │                                    │    Generate Ephemeral Token
             │                                   │                                    │    (crypto.randomBytes(32))
             │                                   │ 4. IPC Response                    │
             │                                   │    { token, port, activeCapsule }  │
             │                                   │<───────────────────────────────────│
             │ 5. Stdio Length-Prefixed Frame    │                                    │
             │    { status: 'PAIRED', token, ...}│                                    │
             │<──────────────────────────────────│                                    │
             │                                   │                                    │
             │ 6. Store in chrome.storage.session│                                    │
             │    (Ready for Scoped Cookie Sync) │                                    │
             │                                   │                                    │
```

---

## Related Code Files

| Action | Path | Purpose |
|---|---|---|
| **Create** | `src/main/native-messaging/windows-acl.ts` | Resolves user SID and enforces Windows DACL / SDDL on `%LOCALAPPDATA%\AntiFan\runtime`. |
| **Create** | `src/main/native-messaging/local-ipc-server.ts` | Windows Named Pipe server managing framed desktop IPC and nonce authentication. |
| **Create** | `src/main/native-messaging/local-ipc-client.ts` | Native Host client adapter connecting stdio frames to the local desktop Named Pipe. |
| **Modify** | `src/main/bridge/bridge-server.ts` | Integrate ephemeral token generation, verification, and IPC lifecycle hooks. |
| **Create** | `src/extension/background.ts` | Implement `connectNative` lifecycle, auto-handshake, and `chrome.storage.session` caching. |
| **Modify** | `extension/popup.js` | Display zero-touch pairing state and remove manual token input requirements. |
| **Create** | `test/main/native-messaging-ipc-handshake.test.ts` | Integration tests verifying handshake negotiation, token validation, and disconnect recovery. |
| **Create** | `test/main/windows-acl.test.ts` | Unit tests for User SID resolution and explicit DACL / SDDL enforcement. |

---

## Implementation Steps

### 1. Fail-Closed Windows DACL & Nonce Manager (`src/main/native-messaging/windows-acl.ts`)
```typescript
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
  const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim();
  const parts = output.split(',');
  if (parts.length >= 2) {
    const sid = parts[1].replace(/"/g, '').trim();
    if (/^S-1-5-\d+(-\d+)+$/.test(sid)) {
      return sid;
    }
  }
  throw new Error(`[AntiFan Security] Failed to resolve valid Windows User SID: ${output}`);
}

export function enforceProtectedDirectoryDacl(dirPath: string, userSid: string): void {
  // Fail-Closed PowerShell script: Disables inheritance, purges all existing ACEs, and adds explicit FullControl for User SID and SYSTEM only
  const psScript = `
    $dir = '${dirPath.replace(/'/g, "''")}';
    $userSid = New-Object System.Security.Principal.SecurityIdentifier('${userSid}');
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
    
    $acl = New-Object System.Security.AccessControl.DirectorySecurity;
    $acl.SetAccessRuleProtection($true, $false); # Disable inheritance and purge all inherited ACEs
    
    $userRule = New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
    $systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
    
    $acl.AddAccessRule($userRule);
    $acl.AddAccessRule($systemRule);
    
    Set-Acl -LiteralPath $dir -AclObject $acl;
    
    # Post-set Verification: Ensure no other principal has access
    $verified = Get-Acl -LiteralPath $dir;
    $allowedSids = @($userSid.Value, 'S-1-5-18');
    foreach ($rule in $verified.Access) {
      $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
      if ($allowedSids -notcontains $ruleSid) {
        throw "UNAUTHORIZED_PRINCIPAL_DETECTED: $ruleSid";
      }
    }
  `;

  // Fail-closed execution: Throws on non-zero exit code or verification failure
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
}

export function setupSecureRuntimeAuth(instanceUuid: string, launchNonce: string, port: number): { runtimeDir: string; authFile: string; socketPath: string } {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const runtimeDir = path.join(localAppData, 'AntiFan', 'runtime');
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
    createdAt: Date.now()
  };

  // Write nonce file inside verified protected directory
  fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf8');
  return { runtimeDir, authFile, socketPath };
}
```

### 2. Stream-Framed Local IPC Server (`src/main/native-messaging/local-ipc-server.ts`)
```typescript
import * as net from 'net';
import * as crypto from 'crypto';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { setupSecureRuntimeAuth } from './windows-acl';

export class LocalIpcServer {
  private server: net.Server | null = null;
  private instanceUuid = crypto.randomUUID();
  private launchNonce = crypto.randomBytes(32).toString('hex');
  private socketPath = '';

  public start(bridgePort: number, onHandshakeRequest: () => { token: string; port: number; activeCapsuleId?: string }): Promise<{ socketPath: string }> {
    return new Promise((resolve, reject) => {
      const { socketPath } = setupSecureRuntimeAuth(this.instanceUuid, this.launchNonce, bridgePort);
      this.socketPath = socketPath;

      this.server = net.createServer((socket) => {
        const decoder = new NativeMessageDecoder();
        socket.pipe(decoder);

        decoder.on('data', (req: any) => {
          try {
            if (req && req.action === 'HANDSHAKE') {
              if (req.launchNonce !== this.launchNonce) {
                const errBuf = encodeNativeMessage({ status: 'ERROR', error: 'INVALID_LAUNCH_NONCE', message: 'Supplied launch nonce does not match active instance.' });
                socket.write(errBuf);
                socket.destroy();
                return;
              }

              const credentials = onHandshakeRequest();
              const response = { status: 'SUCCESS', ...credentials };
              socket.write(encodeNativeMessage(response));
            } else {
              socket.write(encodeNativeMessage({ status: 'ERROR', error: 'UNSUPPORTED_ACTION' }));
            }
          } catch (err) {
            socket.write(encodeNativeMessage({ status: 'ERROR', message: (err as Error).message }));
          }
        });
      });

      this.server.listen(this.socketPath, () => {
        resolve({ socketPath: this.socketPath });
      });

      this.server.on('error', reject);
    });
  }

  public close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
```

### 3. Extension Background Service Worker Integration (`src/extension/background.ts`)
```typescript
let nativePort = null;
let bridgeSession = { token: null, port: 20129, activeCapsuleId: null, paired: false };

function initializeNativeBridge() {
  try {
    nativePort = chrome.runtime.connectNative('com.antifan.bridge');
    
    nativePort.onMessage.addListener((msg) => {
      if (msg.status === 'SUCCESS' && msg.token) {
        bridgeSession = {
          token: msg.token,
          port: msg.port || 20129,
          activeCapsuleId: msg.activeCapsuleId,
          paired: true
        };
        chrome.storage.session.set({ bridgeSession });
        console.log('[AntiFan] Zero-Touch Auto-Handshake completed successfully.');
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn('[AntiFan] Native host disconnected. Retrying in 3s...');
      bridgeSession.paired = false;
      chrome.storage.session.set({ bridgeSession });
      nativePort = null;
      setTimeout(initializeNativeBridge, 3000);
    });

    nativePort.postMessage({ action: 'HANDSHAKE', clientVersion: '1.0.0' });
  } catch (err) {
    console.error('[AntiFan] Failed to connect native host:', err);
    setTimeout(initializeNativeBridge, 5000);
  }
}

chrome.runtime.onStartup.addListener(initializeNativeBridge);
chrome.runtime.onInstalled.addListener(initializeNativeBridge);
initializeNativeBridge();
```

---

## Success Criteria & Test Plan

- [ ] **IPC Handshake Integration Test** (`test/main/native-messaging-ipc-handshake.test.ts`):
  - Server starts on Windows Named Pipe path `\\.\pipe\antifan-bridge-ipc-<UUID>`.
  - Client connects, sends `HANDSHAKE` action with valid `launchNonce`, and receives valid 256-bit token.
  - Ephemeral token allows immediate authenticated access to `/api/cookies/import` on `BridgeServer`.
  - Nonce/token flushes and becomes invalid on server stop.
- [ ] **Windows DACL & Security Check**:
  - `%LOCALAPPDATA%\AntiFan\runtime` directory verified to have inheritance removed and granted strictly to current user SID.
  - Connection attempts without valid `launchNonce` are rejected immediately.
- [ ] **Extension Zero-Touch Smoke Test**:
  - Launch AntiFan Desktop -> Open Chrome -> Extension popup instantly shows `Status: Connected (Zero-Touch)` without any user input.

---

## Risk Assessment & Mitigation
- **Risk**: Extension service worker enters dormant state in Manifest V3.
  - **Mitigation**: Service worker rehydrates `bridgeSession` from `chrome.storage.session` on waking and reconnects native port if disconnected.
