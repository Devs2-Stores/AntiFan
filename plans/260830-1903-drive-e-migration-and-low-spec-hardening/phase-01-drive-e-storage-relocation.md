---
phase: 1
title: "Drive E Complete Storage Relocation & Migration Engine"
status: complete
effort: "2h"
dependencies: []
---

# Phase 1: Drive E Complete Storage Relocation & Migration Engine

## Overview
Redirect 100% of Chromium user profiles, caches, session manifests, terminal logs, browser history, workspace capsules, window states, and control-plane artifacts from Drive C to `E:\Work\.antifan-data\...`. Provide seamless, atomic one-time migration from legacy Drive C locations without data loss, with intra-volume staging (preventing EXDEV cross-device rename failures) and Windows NTFS ACL hardening.

## Requirements
- **Functional:**
  * Auto-detect `E:\Work\.antifan-data` as the primary root when running on Drive E.
  * Centralize path resolution in a single authoritative module `src/main/config/storage-locations.ts`.
  * Automatically migrate existing cookies, local storage, and profiles from `%APPDATA%\antifan-browser-desktop` on first run if Drive E profile is empty.
  * Construct migration staging temp directories directly on the destination volume (`path.join(path.dirname(canonicalPath), ...)`) to guarantee `fs.renameSync` is strictly intra-volume, eliminating `EXDEV: cross-device link not permitted` errors.
  * Apply `enforceProtectedDirectoryDacl` (from `src/main/native-messaging/windows-acl.ts`) to `E:\Work\.antifan-data` and its `config`/`runtime`/`Profile` subdirectories on Windows to restrict file read/write permissions strictly to the current user SID.
  * Support environment variable overrides (`ANTIFAN_DATA_ROOT`, `ANTIFAN_USER_DATA`, `ANTIFAN_CONFIG_DIR`) for testing and benchmarks.
- **Non-functional:**
  * Zero bytes written to Drive C under normal operation.
  * Atomic migration using temp folder and directory rename with process PID lease locks.

## Architecture
```text
E:\Work\.antifan-data/ (Protected with User-Only NTFS DACL)
├── Profile/                     # Chromium user data, cookies, local storage, extensions
│   ├── Default/
│   ├── Network/Cookies
│   └── antifan-profile.lock     # Process lease lock file
├── Profile-cache/               # Dedicated Chromium cache directory
│   ├── network/                 # disk-cache-dir
│   └── gpu/                     # gpu-cache-dir
├── config/                      # Application configuration & persistent state
│   ├── browser-history.json     # Navigation history (HistoryManager)
│   ├── terminal-sessions.json   # Terminal tabs & working dirs (TerminalManager)
│   ├── workspace-capsules.json  # Capsule definitions (WorkspaceCapsuleManager)
│   ├── window-state.json        # Main window bounds (WindowStateManager)
│   └── bridge-token.json        # Local bridge authentication token
├── sessions/                    # Agent & CLI session manifests (SessionResumeController)
│   └── session_<id>.json
├── control-plane-v2/            # Control plane database & records
│   ├── events.jsonl
│   ├── receipts.jsonl
│   └── artifacts/               # Staged QA reports, DOM dumps, screenshots
└── runtime/                     # Transient IPC descriptors & logs
    ├── bridge-auth.json
    └── logs/
```

## Related Code Files
- **Create:**
  * `src/main/config/storage-locations.ts`
  * `test/main/storage-locations.test.ts`
- **Modify:**
  * `src/main/browser/profile-ownership.ts`
  * `src/main/index.ts`
  * `src/main/agent/session-resume-controller.ts`
  * `src/main/browser/history-manager.ts`
  * `src/main/browser/terminal-manager.ts`
  * `src/main/bridge/bridge-server.ts`
  * `src/main/browser/native-tab-host.ts`
  * `test/main/profile-ownership.test.ts`

## Implementation Steps
1. Create `src/main/config/storage-locations.ts`:
   - Export `StorageLocations` singleton with getters for all data directories.
   - Implement `ensureDirectories()`: creates directories and applies `enforceProtectedDirectoryDacl` on Windows (`process.platform === 'win32'`) to seal permissions.
2. Refactor `preparePersistentProfile` in `src/main/browser/profile-ownership.ts`:
   - Default target canonical path to `StorageLocations.getProfileDir()`.
   - Ensure `tempPath = path.join(path.dirname(canonicalPath), `.antifan-profile-migration-${options.pid ?? process.pid}-${(options.now ?? Date.now)()}`)` so copying from Drive C stages directly on Drive E before executing atomic `fs.renameSync(tempPath, canonicalPath)` on the same volume.
   - Scan candidate legacy locations (`C:\Users\Admin\AppData\Roaming\antifan-browser-desktop`, `C:\Users\Admin\.antifan`, old `appdata/` paths), pick highest-value profile via `compareProfileValue`, verify no live process holds lease lock, and copy to Drive E.
3. Update `src/main/index.ts`:
   - Initialize `StorageLocations.ensureDirectories()`.
   - Pass `StorageLocations.getProfileDir()` to `preparePersistentProfile`.
   - Set `app.setPath('userData', ...)`, `app.setPath('sessionData', ...)`, `app.setPath('cache', ...)`, `disk-cache-dir`, `gpu-cache-dir`, `ControlPlaneRuntime`, `WorkspaceCapsuleManager`, and `WindowStateManager`.
4. Update `SessionResumeController`, `HistoryManager`, `TerminalManager`, `BridgeServer`, and `NativeTabHost` to consume `StorageLocations`.
5. Add unit and integration tests in `test/main/storage-locations.test.ts` and `test/main/profile-ownership.test.ts`.

## Success Criteria
- [x] `app.getPath('userData')` evaluates to `E:\Work\.antifan-data\Profile` when `E:\Work` exists.
- [x] Zero bytes written to `%APPDATA%\antifan-browser-desktop` or `~/.antifan`.
- [x] Intra-volume migration avoids `EXDEV` errors and migrates cookies/sessions from Drive C seamlessly.
- [x] Directory DACL restricts read/write permissions to current user SID on Windows.
- [x] All unit and integration tests pass 100%.

## Risk Assessment
- **Risk:** Drive E unmounted or read-only on some external environments.  
  *Mitigation:* Write probe in `StorageLocations.getDataRoot()` falls back gracefully to `%APPDATA%` with a descriptive console warning.
- **Risk:** Cross-device rename failure (`EXDEV`).  
  *Mitigation:* Staging temp directory is strictly anchored on `path.dirname(canonicalPath)` on Drive E, guaranteeing same-filesystem atomic rename.
