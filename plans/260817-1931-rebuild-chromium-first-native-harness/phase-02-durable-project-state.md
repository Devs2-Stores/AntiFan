---
title: "Phase 2: Durable Project State And Migration Foundation"
status: done
---

# Phase 2: Durable Project State And Migration Foundation

## Overview

Create Main-owned durable storage for the app catalog and each isolated Project,
plus artifact storage, credential vaulting, event replay, and a non-destructive
legacy migration ledger.

## Requirements

- Main is the only writer; Renderer and Utility access repositories by protocol.
- Use SQLite/WAL for metadata, events, revisions, leases, and mutations, with
  content-addressed Project-local files for large artifacts.
- Verify the selected SQLite implementation inside development and packaged
  Electron before schema work; if Electron's built-in module is unavailable,
  use one Forge-rebuilt native dependency behind the same repository interface.
- Project state lives below Electron `userData`, never inside the source tree.
- Corrupt or unknown legacy data is copied/quarantined and reported, not replaced.
- Secrets are encrypted through OS-backed storage; consumers receive handles and
  redacted status only.
- Legacy partition alias selection is resolved before Phase 3 materializes an
  imported Project; old and new owners are never opened concurrently.
- Encryption unavailable or decryption failure is fail-closed and requires
  re-authentication; plaintext fallback is forbidden.

## Proposed Layout

```text
userData/state/v1/
  catalog.sqlite
  projects/<project-id>/
    project.sqlite
    artifacts/<sha256>
    migration/
  migration-ledger.sqlite
```

Chromium profile bytes remain owned by Electron's stable Project partition.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Add | `src/main/state/app-catalog-store.ts` | Project registry and app-level schema migrations |
| Add | `src/main/state/project-state-store.ts` | Project/Workspace/chat/run/event/lease repositories |
| Add | `src/main/state/artifact-store.ts` | Project-scoped content-addressed blobs and retention |
| Add | `src/main/state/mutation-journal.ts` | Durable side-effect lifecycle and reconciliation |
| Add | `src/main/state/credential-vault.ts` | OS-encrypted credentials and provider handles |
| Add | `src/main/state/legacy-migration-service.ts` | Detect, plan, import, quarantine, and report legacy data |
| Modify | `src/main/chat-sync-service.ts` | Stop whole-file global JSON authority; become migration adapter then remove |
| Modify | `src/main/session-store.ts` | Stop broad cookie export and global browser session authority |
| Modify | `src/main/settings/settings-store.ts` | Separate global preferences from Project state |
| Modify | `src/main/auth/antigravity-auth-service.ts` | Vault-backed storage and redacted status |
| Modify | `src/main/auth/codex-auth-service.ts` | Vault-backed storage and redacted status |
| Add | `test/main/project-state-store.test.ts` | Transaction, revision, recovery, and isolation tests |
| Add | `test/main/legacy-migration-service.test.ts` | Idempotent valid/corrupt/partial/repeated import tests |
| Add | `test/main/credential-vault.test.ts` | Encryption, redaction, rotation, and decrypt-failure tests |

## Implementation Steps

1. Prove SQLite/WAL behavior in the packaged runtime, including clean shutdown,
   abrupt termination recovery, backups, and Forge packaging.
2. Add schema versioning and repository transactions for Project, Workspace,
   ChatSession, Turn, Run, Step, Event, Lease, Mutation, and Artifact metadata.
3. Add append-only event sequencing and snapshot queries for renderer reconnect.
4. Add snapshot compaction, event retention, artifact reference counting,
   orphan-safe garbage collection, quota-pressure behavior, and recoverable
   database maintenance.
5. Add atomic artifact writes with hash/size/MIME verification, byte quotas,
   no-follow path handling, and Project ownership checks.
6. Move provider secrets behind vault handles; record encryption backend/version,
   remove raw secrets from renderer status and request DTOs, and flag the
   historical literal key for manual revocation.
7. Inventory legacy chat, session, DSH, settings, localStorage, and auth sources;
   persist hashes, parse status, source version, and import outcome before writes.
8. Use deterministic imported IDs and a cross-store migration state machine:
   `prepared -> catalog-applied -> project-applied -> artifacts-applied -> verified`,
   with per-resource receipts and recovery at every boundary.
9. Add detect/report mode and make import idempotent. Preserve source bytes unless
   a later explicit cleanup operation is approved.

## Migration Sources

- `.antigravity/harness/trajectory.jsonl`, checkpoints, and goal records.
- `.antigravity/session.json` and app userData session/settings records.
- `~/.gemini/antigravity-browser-desktop/chat_sessions.json`.
- Renderer `agb_*` localStorage state.
- Antigravity and Codex auth files.
- The legacy `persist:antigravity-browser` profile.

The legacy Chromium partition may remain the durable alias of one explicitly
selected imported Project. It is not renamed or copied. If no Project claims it,
new Project partitions require fresh login and the old profile remains untouched.

## Validation

- WAL recovery at each transaction boundary and monotonic revision/event tests.
- Two Project stores with colliding local IDs cannot read each other's records.
- Artifact traversal, symlink/reparse, hash mismatch, quota, and retention tests.
- Secrets absent from repository snapshots, renderer DTOs, utility fixtures,
  logs, and diagnostics.
- Repeated migration produces no duplicate records and leaves originals intact.
- Crash injection between catalog, Project DB, artifact rename, and ledger states
  resumes to one verified import without split ownership.
- Vault tests cover unavailable encryption, backend change, undecryptable data,
  re-authentication, and no-plaintext fallback.
- Long-duration event/artifact load tests prove bounded growth and recoverable GC.

## Success Criteria

The app can create, reopen, query, and recover independent Project stores and can
produce a complete dry-run migration report without mutating legacy sources.

## Risks And Rollback

- SQLite packaging failure blocks later phases; resolve the runtime choice before
  adding schemas.
- Credential migration can lock out providers; retain encrypted source backup and
  require re-authentication rather than treating ciphertext as a token.
- Never distribute one legacy cookie/profile store across Projects.
