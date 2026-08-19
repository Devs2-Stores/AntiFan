# Sidecar Contract & Environment Compatibility Probe Report

**Date**: 2026-08-20  
**Phase**: Phase 01 (Prove Sidecar Routing & ID Semantics)  
**Status**: COMPLETE / GO FOR PHASE 2  
**Target Repositories**: `E:/Work/apps/antifan-browser-desktop` & `E:/Work/apps/antigravity-browser`

---

## 1. Environment & Absolute Launch Inventory

- **Host OS**: Windows NT (x64)
- **Verified Node Executable**: `C:\Program Files\nodejs\node.exe` (Node.js v24.13.0)
- **Sidecar Launch Command Model**:
  - Direct execution via verified absolute Node binary: `C:\Program Files\nodejs\node.exe <sidecar-router-entrypoint>`
  - Arguments passed strictly as `string[]` via `child_process.spawn(executable, args, { shell: false, windowsHide: true })`.
  - **Zero shell interpolation**: Prompt text and file URIs are NEVER interpolated into cmd/bash strings, preventing command injection on Windows.

---

## 2. Authoritative Conversation ID Semantics

1. **ID Source Discovery**:
   - `conversation_id` is defined as UUIDv4 / alphanumeric token matching `/^[A-Za-z0-9_.-]{4,128}$/`.
   - In Antigravity runtime, conversation ID matches the directory key under the local AppData brain catalog (`~/.gemini/antigravity-ide/brain/<conversation-id>`).
   - The authoritative ID is passed explicitly in `AntigravityCommandV2.targetConversationId`.
2. **Exact-Route Routing Contract**:
   - Command document specifies:
     ```json
     {
       "protocolVersion": 2,
       "id": "cmd-178716...",
       "action": "send-prompt",
       "mode": "auto",
       "targetWorkspace": { "folderUri": "e:\\Work\\apps\\antifan-browser-desktop" },
       "targetConversationId": "1d321a18-37bd-4165-bd69-39d808c91ace",
       "promptText": "...",
       "promptDigest": "..."
     }
     ```
   - If `targetConversationId` is present and Sidecar route is available:
     ➜ Routed directly to the exact target conversation via Sidecar router.
   - If `mode === 'draft'` or `targetConversationId` is missing:
     ➜ Routed to active panel via standard `sendToAgentPanelCallback` without exact conversation targeting.

---

## 3. Attachment & Payload Capabilities (Per MIME Class)

| MIME Class | Staging Strategy | Capability Status | Contract |
|---|---|:---:|---|
| **`image/png`**, **`image/jpeg`** | File URI Reference (`.antigravity/snapshots/`) | **Supported** | URI reference `@[file://...]` appended to prompt with local hash |
| **`text/markdown`**, **`text/plain`** | Staged File on Disk | **Supported** | URI link referencing file path |
| **Inline Base64** | Direct JSON string | **Deprecated / Blocked** | Banned in Protocol v2 to prevent IPC latency bottlenecks |

---

## 4. Hard Gate Decision

- [x] **Safe Spawn Verified**: `child_process.spawn` with `shell: false` passes all argument bounds and special characters without escaping bugs.
- [x] **Honest Receipts**: `ide-api-accepted` (exit 0), `failed` (exit != 0 or spawn error), `unknown` (timeout exceeded).
- [x] **No Auto-Retry**: Ambiguous execution states stay `unknown`.
- [x] **Redaction Boundary**: Logs and receipts store SHA-256 digests and file metadata; prompt text is not logged in diagnostic output.

**Verdict**: **GO FOR PHASE 2** (Build & Install the Managed Sidecar Router).
