---
phase: 1
title: "Windows Native Messaging Host Protocol & Registry Subsystem"
status: ready
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Windows Native Messaging Host Protocol & Registry Subsystem

## Overview
Phase 1 establishes the Chromium Native Messaging Host binary communication layer and the automated Windows registry installer for AntiFan Browser Desktop. It implements high-performance, stream-safe 32-bit length-prefixed JSON framing for stdin/stdout, builds the host manifest generator, and provides idempotent installation into the Windows Registry (`HKCU`) for Google Chrome, Microsoft Edge, and Brave.
## Requirements
1. **Chromium Framing Protocol & Asymmetric Size Limits**:
   - Every message begins with a 4-byte 32-bit unsigned integer (Little-Endian) specifying the UTF-8 payload length in bytes.
   - **Asymmetric Chromium Size Boundaries**:
     - **Inbound (Chrome → Host)**: Chromium allows up to 64 MiB (67,108,864 bytes). `NativeMessageDecoder` accepts valid frames up to 64 MiB (with a configurable application warning threshold at 10 MiB for cookie payloads).
     - **Outbound (Host → Chrome)**: Chromium strictly mandates a maximum message size of 1 MiB (1,048,576 bytes). Outbound responses exceeding 1,048,576 bytes are blocked at the framing encoder with a deterministic `PAYLOAD_EXCEEDS_CHROMIUM_1MB_LIMIT` error before touching `stdout`.
   - Streaming chunk buffer accumulator capable of handling fragmented inputs, multi-message TCP/pipe bursts, and partial header reads without data loss.
   - Outbound messages to `stdout` must prepend the 4-byte LE length header before transmitting the UTF-8 JSON payload.
   - Host Name: `com.antifan.bridge`
   - Description: `"AntiFan Browser Desktop Native Messaging Bridge"`
   - Type: `"stdio"`
   - `allowed_origins`: `["chrome-extension://<EXTENSION_ID>/"]` (dynamically injected from config or extension build).
3. **Idempotent Multi-Browser Registration & Shipped Binary Strategy**:
   - **Shipped Executable Architecture (No External Node Dependency)**:
     - **Windows Packaged Execution Mode**:
       - Chrome's manifest `path` requires an absolute path to a direct executable.
       - Implement a dedicated, lightweight Win32 executable launcher `scripts/native-host-shim/main.c` compiled to `antifan-bridge-host.exe`.
       - When invoked by Chrome, `antifan-bridge-host.exe`:
         1. Sets environment variable `ELECTRON_RUN_AS_NODE=1`.
         2. Resolves `<INSTALL_DIR>\antifan-browser-desktop.exe` and target runner script `<INSTALL_DIR>\resources\app.asar\.compiled\src\main\native-messaging\host-runner.js`.
         3. Spawns the Electron process with `CREATE_NO_WINDOW`, passing inherited `stdin`, `stdout`, `stderr`, and command-line arguments.
         4. Forwards process exit codes and terminates cleanly on stream closure.
       - `scripts/package-windows.mjs` enforces a strict build gate: validates that `antifan-bridge-host.exe` and `.compiled/src/main/native-messaging/host-runner.js` exist in the output artifact; fails the packaging build immediately if absent.
     - **Development Mode**:
       - In local dev, manifest points to a script or node runner executing `.compiled/src/main/native-messaging/host-runner.js` with `process.execPath`.
   - **Manifest Paths & Registry Keys**:
   - **Target Platform Tier & Registry Keys**:
     - **Windows (win32-x64 Primary Production Target)**:
       - Manifest path: `%LOCALAPPDATA%\AntiFan\NativeMessagingHosts\com.antifan.bridge.json`
       - Binary path in manifest: `<INSTALL_DIR>\antifan-bridge-host.exe` (or `%LOCALAPPDATA%\AntiFan\bin\antifan-bridge-host.exe`)
       - Registry Keys (HKCU - No Admin / UAC Required):
         - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge`
         - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.antifan.bridge`
         - `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.antifan.bridge`
     - **Non-Goal**: Non-Windows packaging (macOS / Linux) is deferred to future multi-platform milestones.
4. **Extension Permissions & Manifest V3**:
   - `extension/manifest.json` MUST declare `"nativeMessaging"` in `permissions` array alongside `"cookies"` and `"storage"`.
5. **Lifecycle & Error Resilience**:
   - Host runner must terminate cleanly when Chrome closes `stdin` (EOF detection).
   - Unhandled exceptions must be logged to a local diagnostic log file (`%LOCALAPPDATA%\AntiFan\logs\native-host.log`) rather than corrupting `stdout`.
---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CHROME NATIVE MESSAGING                          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
               stdio (32-bit LE length-prefixed JSON)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               NativeMessageFraming Engine (framing.ts)                  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Chunk Accumulator Buffer (Stream-safe partial packet assembler)  │  │
│  │ 1. Read 4 bytes: [ L0 | L1 | L2 | L3 ] -> msgLen = readUInt32LE  │  │
│  │ 2. Guard: if (msgLen > 1024 * 1024) throw PayloadTooLargeError   │  │
│  │ 3. Wait for remaining bytes: if (buffer.length < 4 + msgLen)     │  │
│  │ 4. Extract buffer.subarray(4, 4 + msgLen) -> JSON.parse          │  │
│  │ 5. Slice buffer and emit 'message' event                         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Message Serialization: writeNativeMessage(payload)               │  │
│  │ 1. jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8')        │  │
│  │ 2. headerBuf = Buffer.alloc(4); headerBuf.writeUInt32LE(len)     │  │
│  │ 3. stream.write(Buffer.concat([headerBuf, jsonBuf]))             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Registration Subsystem (manifest-installer.ts)             │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Windows Registry Engine (reg.exe / HKCU keys)              │  │
│  │  - Chrome, Edge, Brave NativeMessagingHosts support         │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Related Code Files

| Action | Path | Purpose |
|---|---|---|
| **Create** | `src/main/native-messaging/framing.ts` | Stream-safe 32-bit LE length-prefixed encoder and decoder classes. |
| **Create** | `src/main/native-messaging/manifest-installer.ts` | Cross-platform manifest generator and registry/filesystem installer. |
| **Create** | `src/main/native-messaging/host-runner.ts` | CLI entry point executed by Chrome when extension initiates native connection. |
| **Create** | `scripts/build-native-host-shim.mjs` | Builds/copies the standalone Windows executable shim `antifan-bridge-host.exe`. |
| **Modify** | `extension/manifest.json` | Add `"nativeMessaging"` permission to Chrome Extension Manifest V3. |
| **Modify** | `scripts/package-windows.mjs` | Bundle `antifan-bridge-host.exe` into packaged Windows output artifacts. |
| **Modify** | `src/main/index.ts` | Trigger background host registration check on AntiFan Desktop launch. |
| **Create** | `test/main/native-messaging-framing.test.ts` | Unit tests for binary protocol parsing, chunking, and limit enforcement. |
| **Create** | `test/main/native-messaging-installer.test.ts` | Unit tests for manifest generation and multi-browser path resolution. |
---

## Implementation Steps

### 1. Protocol Framing Engine (`src/main/native-messaging/framing.ts`)
```typescript
import { Transform, TransformCallback } from 'stream';

/** Maximum inbound payload size from Chrome (Chromium limit: 64 MiB) */
export const MAX_INBOUND_NATIVE_MESSAGE_SIZE = 64 * 1024 * 1024; // 64 MB
/** Maximum outbound payload size to Chrome (Chromium limit: 1 MiB) */
export const MAX_OUTBOUND_NATIVE_MESSAGE_SIZE = 1 * 1024 * 1024; // 1 MB

export class NativeMessageDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0);

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readUInt32LE(0);

      if (messageLength > MAX_INBOUND_NATIVE_MESSAGE_SIZE) {
        return callback(new Error(`Native inbound message exceeds 64MB limit: ${messageLength} bytes`));
      }

      if (this.buffer.length < 4 + messageLength) {
        // Incomplete message payload, wait for next stream chunk
        break;
      }

      const jsonSlice = this.buffer.subarray(4, 4 + messageLength);
      this.buffer = this.buffer.subarray(4 + messageLength);

      try {
        const parsed = JSON.parse(jsonSlice.toString('utf8'));
        this.push(parsed);
      } catch (err) {
        return callback(new Error(`Invalid JSON payload from native stream: ${(err as Error).message}`));
      }
    }

    callback();
  }
}

export function encodeNativeMessage(payload: unknown): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  if (jsonBuf.length > MAX_OUTBOUND_NATIVE_MESSAGE_SIZE) {
    throw new Error(`Outbound message exceeds Chromium 1MB limit: ${jsonBuf.length} bytes`);
  }
  const headerBuf = Buffer.alloc(4);
  headerBuf.writeUInt32LE(jsonBuf.length, 0);
  return Buffer.concat([headerBuf, jsonBuf]);
}
```

### 2. Standalone Native Host Shim & Build Script (`scripts/native-host-shim/main.c`, `scripts/build-native-host-shim.mjs`)
- Check-in `scripts/native-host-shim/main.c`: A zero-dependency Win32 C launcher that sets `ELECTRON_RUN_AS_NODE=1`, resolves `antifan-browser-desktop.exe` and `.compiled/src/main/native-messaging/host-runner.js`, and spawns the process with inherited stdio (`CREATE_NO_WINDOW`).
- Implement `scripts/build-native-host-shim.mjs`: Compiles `main.c` via MSVC (`cl.exe`), MinGW (`gcc`), or copies the precompiled binary into `dist/native-host/antifan-bridge-host.exe`.
- `scripts/package-windows.mjs` integrates this step: validates presence of `antifan-bridge-host.exe` and fails fast if missing.

### 3. Windows Manifest Registry Installer (`src/main/native-messaging/manifest-installer.ts`)
- Implement `getManifestPaths(browser: 'chrome' | 'edge' | 'brave')` returning appropriate registry paths for Windows.
- Implement `generateHostManifest(extensionId: string, hostBinaryPath: string): object`.
- Implement `installNativeHost(extensionId: string): Promise<{ success: boolean; installedPaths: string[] }>`.
  - On Windows: Points `path` to `<INSTALL_DIR>\antifan-bridge-host.exe` and writes `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge`.
- Implement `uninstallNativeHost(): Promise<void>` for clean teardown.

### 4. Host Runner Entry Point (`src/main/native-messaging/host-runner.ts`)
- Compiles to `.compiled/src/main/native-messaging/host-runner.js`.
- Reads `process.stdin` through `NativeMessageDecoder`.
- Connects to AntiFan Desktop via Local IPC (Phase 2).
- Pumps response frames to `process.stdout` via `encodeNativeMessage`.

## Success Criteria & Test Plan

- [ ] **Framing Unit Tests** (`test/main/native-messaging-framing.test.ts`):
  - Correctly parses single complete frame with LE uint32 length prefix.
  - Reassembles fragmented chunks split across 1-byte, 2-byte, and random boundaries.
  - Unpacks multiple concatenated messages in a single incoming buffer chunk.
  - Throws when inbound length prefix > 64MB.
  - Throws when outbound message payload > 1MB.
  - Rejects malformed JSON syntax cleanly.
- [ ] **Installer Unit Tests** (`test/main/native-messaging-installer.test.ts`):
  - Generates valid Chromium manifest JSON with correct `name`, `type: "stdio"`, and `allowed_origins`.
  - Resolves correct registry keys on Windows (`HKCU\Software\Google\Chrome\...`, `HKCU\Software\Microsoft\Edge\...`, `HKCU\Software\BraveSoftware\...`).
- [ ] **Manual Smoke Test**:
  - Run registration utility -> verify manifest exists in Chrome's NativeMessagingHosts registry / filesystem path.

---

## Risk Assessment & Mitigation
- **Risk**: Windows permissions or locked registry keys prevent installation.
  - **Mitigation**: All registry entries use `HKCU` (Current User), which requires zero Administrator UAC elevation.
- **Risk**: Stdin stream fragmentation in high-throughput environments causes corrupted JSON parsing.
  - **Mitigation**: Pure buffer-slicing accumulator with exact byte length checks prevents off-by-one errors and drops partial reads until the full frame arrives.
