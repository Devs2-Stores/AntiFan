# Security & IPC Audit Report

**Date:** 2026-08-27  
**Scope:** IPC Channels, Attachment Credentials, File Containment, and Scheme Sanitization  

---

## 1. Webview & Extension IPC Security

- **Isolation Contract:** Webview guests and extension background scripts cannot invoke raw Node.js or arbitrary Electron internals.
- **IPC Audit Suite:** `test/main/ipc-audit.test.ts` asserts that all exposed `ipcRenderer.send` and `ipcRenderer.invoke` channels map strictly to verified handler allowlists.
- **Dangerous Schemes Blocked:** `javascript:`, `data:`, `file:`, `vbscript:` URLs in guest navigation are strictly blocked or sanitized by `NativeTabHost.navigate()`.

---

## 2. MCP & Bridge Server Security

- **Attachment Authentication:** `AttachmentRegistry` issues crypographically strong secrets (256-bit entropy) per execution session.
- **Replay Protection:** Replay attacks denied via mandatory unique `invocationId` per capability invocation (`REPLAY_DENIED`).
- **Fail-Closed Policy:** Requests with invalid/missing/tampered attachment secrets return `ATTACHMENT_INVALID` / `UNAUTHENTICATED` without executing host mutations.
- **Scoped Port Access:** Bridge Server accepts local WebSocket connections with explicit token validation; unattached callers cannot trigger host filesystem or browser mutations.

---

## 3. Artifact Containment & Redaction

- **Path Containment:** `ArtifactStore` enforces strict boundary containment (`OUTSIDE_WORKSPACE` on path traversal or symlinks pointing outside the designated root).
- **Secret Redaction:** Tokens, bearer keys, and credentials in staged artifacts and smoke logs are masked before disk persistence.
- **Retention Management:** `ArtifactStore` enforces per-run byte budget limits (default 32MB max run budget, 8MB max artifact) to prevent disk exhaustion.

---

## 4. Verification Evidence

- `test/main/ipc-audit.test.ts` -> PASSED
- `test/main/bridge-attachment-dispatch.test.ts` -> PASSED
- `test/workflow-and-artifact-security.test.ts` -> PASSED
- `scripts/smoke-packaged-theme-developer.cjs` Step 9 (Tampered Secret Rejection) -> PASSED
