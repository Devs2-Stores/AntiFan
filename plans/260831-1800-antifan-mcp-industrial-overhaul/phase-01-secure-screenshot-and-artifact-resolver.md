---
phase: 1
title: "Secure Screenshot & Server-Side Artifact Resolver"
status: pending
priority: P0
effort: "3h"
dependencies: []
---

# Phase 01: Secure Screenshot & Server-Side Artifact Resolver

## Overview
Reconciles the visual screenshot pipeline with the security model (`docs/security-model.md:31-32,54`). Retains `ArtifactRef` metadata across internal capability dispatch boundaries, exposes an authenticated, bounded binary artifact resource/download edge on the Bridge Server backed by `ArtifactStore.readBytesById()`, strictly enforces tenancy/run ownership matching (`ref.runId === attachmentRecord.runId` and `ref.attemptId === attachmentRecord.attemptId` via resolved attachment secret), mandates single-header authentication (`x-antifan-attachment-secret`), eliminates query-param secret leakage, rejects truncated PNGs (`ref.truncated === true`), and formats standard MCP Image blocks (`type: 'image'`) exclusively at the Stdio adapter edge from the fetched binary stream.

## Requirements
- **Functional:**
  - `anti.screenshot.viewport` (and `antifan_screenshot`) MCP tool returns `{ content: [{ type: 'image', data: base64, mimeType: 'image/png' }] }` containing full authentic Base64 PNG bytes for consumption by AI Vision models.
  - Bridge Server provides an authenticated, bounded HTTP binary resource endpoint `GET /api/artifacts/:id`.
  - **Strict Single-Header Authentication & Zero Query-Param Secrets:** The endpoint requires the caller's attachment secret sent exclusively via `x-antifan-attachment-secret: <attachmentSecret>`. Query parameter token passing is strictly forbidden (`docs/security-model.md:54`), and bridge-token-only requests without attachment secret are rejected.
  - **Mandatory Attachment Ownership Validation:** The handler resolves `verifiedAttachmentId = attachmentRegistry.verifyConnectionToken(secret)` to its active `ExecutionAttachmentRecord`, and verifies that `ref.runId === attachmentRecord.runId` and `ref.attemptId === attachmentRecord.attemptId`. No caller (including `bridgeToken` holders) is exempt from run/attempt ownership verification on artifact downloads.
  - If an artifact was truncated during capture (`ref.truncated === true`), the system fails closed with `422 Unprocessable Entity` (`CapabilityError('INVALID_ARGUMENT', 'Artifact payload truncated during capture')`).
- **Non-functional:**
  - Zero raw Base64 byte payload leakage across internal capability dispatch contracts (`docs/security-model.md:31-32`). Capability outputs return pure `ArtifactRef` metadata.
  - Proxy client (`antifan-omp-mcp.cjs`) NEVER invokes direct `fs.readFile(ref.path)`, preventing bypass of `ArtifactStore` root containment, symlink rejection, and canonical realpath checks.
  - Memory bounds: Maximum 8 MiB per screenshot artifact, stream-buffered safely with accurate `Content-Length`.
## Architecture
```
[Chromium Viewport Capture]
         │ (PNG Buffer)
         ▼
[BrowserControlPort.screenshot]
         │ (PassiveExecutionPool Gate)
         ▼
[ArtifactStore.stage]
         │
         ├── Writes binary to <dataRoot>/artifacts/<runId>/<sha256>.artifact
         └── Returns ArtifactRef { id, path, byteLength, sha256, mime, truncated }
         │
         ▼
[BridgeServer antifan.capability.dispatch]
         │ (Returns ArtifactRef metadata only over JSON-RPC)
         ▼
[antifan-omp-mcp.cjs Proxy]
         │ (Detects kind === 'screenshot' / isArtifactRef)
         ▼
[BridgeServer GET /api/artifacts/:id]
         │ 1. Header Auth: x-antifan-attachment-secret: <secret> (Single Header Only)
         │ 2. Resolve verifiedAttachmentId -> getAttachment(verifiedAttachmentId)
         │ 3. Enforce Strict Ownership: ref.runId === record.runId && ref.attemptId === record.attemptId
         │ 4. ArtifactStore.readBytesById(id) with Root Containment & Realpath Check
         ▼ (Streams binary buffer: application/octet-stream / image/png)
[antifan-omp-mcp.cjs Formatter]
         │ (Buffer.toString('base64'))
         ▼
[MCP Client Stdio] { type: 'image', data: base64, mimeType: 'image/png' }
```
- Modify: `src/main/bridge/bridge-server.ts` (Add authenticated `GET /api/artifacts/:id` binary streaming route with single `x-antifan-attachment-secret` header auth, attachment record ownership matching, and `ArtifactStore.readBytesById()` containment).
- Modify: `src/main/control-plane/control-plane-runtime.ts` (Expose `readArtifactBytes` on control plane interface with strict run/attempt ownership verification against attachment record).
- Modify: `scripts/antifan-omp-mcp.cjs` (Fetch binary buffer from `GET /api/artifacts/:id` using `x-antifan-attachment-secret: ${bootstrap.secret}` single header, remove raw-base64 fallback, and format image tool response to `{ type: 'image', data, mimeType }`).
- Create: `test/main/mcp-secure-image-resolver.test.ts` (Unit & contract tests for single-header authentication, bridge-token-only rejection, attachment record ownership validation, cross-run denial, binary streaming, truncation rejection, and MCP image payload formatting).
## Implementation Steps
1. **Server-Side Binary Resource Endpoint with Mandatory Ownership Enforcement:**
   - In `src/main/bridge/bridge-server.ts`, add HTTP route handler for `/api/artifacts/:id`.
   - Extract secret strictly from single header `req.headers['x-antifan-attachment-secret']`. Reject query parameter tokens with `401 Unauthorized` (`SECRETS_IN_URL_FORBIDDEN`).
   - Reject requests presenting only `bridgeToken` (without valid attachment secret) with `401 Unauthorized` (`ATTACHMENT_SECRET_REQUIRED`).
   - Resolve `verifiedAttachmentId = this.attachmentRegistry.verifyConnectionToken(secret)`. Reject invalid/expired secrets with `401 Unauthorized`.
   - Retrieve `attachmentRecord = this.attachmentRegistry.getAttachment(verifiedAttachmentId)`. If not found or inactive, return `401 Unauthorized`.
   - Call `this.controlPlaneRuntime.artifacts.readBytesById(artifactId)` -> returns `{ ref, data }`.
   - **Enforce Mandatory Ownership:** Assert `ref.runId === attachmentRecord.runId && ref.attemptId === attachmentRecord.attemptId`. If mismatched, reject with `403 Forbidden` (`ATTACHMENT_MISMATCH`). Zero bypass for any caller.
   - **Truncation Check:** Assert `ref.truncated !== true`; reject with `422 Unprocessable Entity` (`CapabilityError('INVALID_ARGUMENT', 'Artifact payload truncated')`) if truncated.
   - Stream binary bytes with `Content-Type: ref.mime` and `Content-Length: ref.byteLength`.
2. **Proxy-Side Binary Stream Fetcher & MCP Formatter:**
   - In `scripts/antifan-omp-mcp.cjs`, inspect the result of `invoke(name, params)`.
   - If `name === 'anti.screenshot.viewport'` or `name === 'antifan_screenshot'`:
     * Enforce that result is an `ArtifactRef` object with `id` starting with `artifact-`. If not, fail closed immediately (`CapabilityError('CAPABILITY_ERROR', 'Expected ArtifactRef metadata from screenshot capability')`). Banish all legacy raw-text/raw-base64 fallback paths.
     * Fetch raw binary bytes via HTTP `GET http://127.0.0.1:${bootstrap.port}/api/artifacts/${data.id}` with single header:
       `{ 'x-antifan-attachment-secret': bootstrap.secret }`.
     * Convert binary buffer into Base64 string at the Stdio edge.
     * Return `{ content: [{ type: 'image', data: base64String, mimeType: data.mime || 'image/png' }] }`.
3. **Unit & Security Tests:**
   - Test that query string tokens (`?token=...`) on `/api/artifacts/:id` are rejected (401).
   - Test that requests authenticated with `bridgeToken` only (missing attachment secret) are rejected (401).
   - Test that requests with valid attachment secret succeed when `ref.runId === record.runId && ref.attemptId === record.attemptId`.
   - Test that cross-run artifact access attempts (valid secret but mismatched `ref.runId`/`ref.attemptId`) are rejected with 403 `ATTACHMENT_MISMATCH`.
   - Test that truncated artifact throws explicit 422 error.
   - Test that root escape / symlink attempts fail closed.
   - Test that non-ArtifactRef capability responses are rejected by the proxy.
   - Test that valid screenshot output matches standard MCP Image schema.
- [ ] Proxy never accesses filesystem directly via `fs.readFile`.
- [ ] Truncated images are rejected with structured error.
- [ ] All unit tests in `test/main/mcp-secure-image-resolver.test.ts` pass green.

## Risk Assessment
- **Risk:** Large 8 MiB Base64 string causes memory pressure in bridge JSON-RPC serialization.
- **Mitigation:** Enforce downscaling at capture time when requested, and stream binary bytes over HTTP/WebSocket rather than accumulating multiple copies in memory.
