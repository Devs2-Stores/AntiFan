---
phase: 2
title: "Local Stdio Artifact Backpressure Guard & Chunk Capping"
status: pending
priority: P0
effort: "45m"
dependencies: [1]
---

# Phase 2: Local Stdio Artifact Backpressure Guard & Chunk Capping

## 1. Overview
In `scripts/antifan-omp-mcp.cjs`, `invoke()` communicates with the Electron Main process over WebSocket and receives tool responses. When Electron Main stages large payloads (e.g., large DOM queries or dumps) into `ArtifactStore`, it returns an `ArtifactRef` metadata object (`{ id: 'artifact-...', sha256: '...', bytes: ..., mime: ... }`).

Currently, `antifan-omp-mcp.cjs` unconditionally hydrates all non-image `ArtifactRef` instances by fetching the full binary payload via `fetchArtifactBinary()` and decoding it into a massive UTF-8 string over `stdout`. For multi-megabyte DOM snapshots, this saturates the Windows stdio pipe buffer.

This phase hardens the proxy:
1. **Preserve ArtifactRef for Large Payloads:** If an `ArtifactRef` is returned by a capability and exceeds 64 KiB (and is not an explicit screenshot tool), preserve the `ArtifactRef` metadata (`id`, `sha256`, `bytes`, `mime`) in the MCP tool response instead of forcing a full raw string hydration.
2. **Cap `artifact.read` Chunks:** Ensure MCP-facing `artifact.read` tool respects a bounded chunk size (default $\le 32\text{ KiB}$ per frame) rather than dumping up to 1 MiB per stdout frame.

## 2. Requirements
- Edit `scripts/antifan-omp-mcp.cjs` lines 483–505 to inspect `data.bytes` or payload size before hydrating text.
- If payload $\ge 64\text{ KiB}$ and tool is not an explicit image viewer, return structured `ArtifactRef` metadata with `id: data.id`.
- Ensure callers can read chunks sequentially via `artifact.read` tool with bounded chunk size.

## 3. Architecture & Payload Routing
```text
invoke(name, args) ──► Electron Main
                           │
                           ▼
Returns ArtifactRef: { id: "artifact-...", bytes: 248102, mime: "text/html" }
                           │
                           ▼
antifan-omp-mcp.cjs (CallToolHandler)
  ├─ If Screenshot / Image ────────► Hydrate Image Content (MCP Image Protocol)
  ├─ If Text & bytes < 64 KB ──────► Hydrate Text Content (Inline Text)
  └─ If Text & bytes >= 64 KB ─────► Return ArtifactRef Metadata (id, sha256, bytes)
```

## 4. Related Code Files
- Modify: `scripts/antifan-omp-mcp.cjs`
- Inspect: `src/main/tools/artifact-store.ts`

## 5. Implementation Steps
1. Update `scripts/antifan-omp-mcp.cjs` to check `data.bytes` or payload byte length.
2. If `data.bytes >= 65536` and not a screenshot tool, return `{ content: [{ type: 'text', text: JSON.stringify(data) }] }`.
3. Verify with DOM inspection probe.

## 6. Success Criteria & Verification
- [ ] No non-image tool call forces $>64\text{ KiB}$ text hydration over stdio without explicit chunked read.
- [ ] Existing screenshot tools continue to hydrate images properly.
- [ ] Tool calls return standard `artifact-...` identifiers and metadata.
