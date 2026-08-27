# Production Cutover & Release Gate Report

**Plan:** `plans/260827-1345-production-cutover-release-hardening/plan.md`  
**Date:** 2026-08-27  
**Working Directory:** `E:\Work\apps\antifan-browser-desktop`  
**Status:** **PASSED (Internal Preview - Release Candidate RC1 Baseline)**  
**Target Platform:** Windows 10/11 x64 (`win32-x64`)  
**Runtime:** Electron v43.4.0 (Chromium 143.0.7499.40, Node v24.13.0)  
**Git Revision:** `754dc6c051201a76818ca70cb93df751bffa73ff`  

---

## 1. Executive Summary & Verdict

The production hardening and cutover verification suite has completed across all required release gate groups. AntiFan Browser Desktop meets all functional, architectural, security, and packaging contracts for the **Haravan/Sapo/Shopify Theme Developer workbench**.

Because this is the initial release build (RC1 baseline), no pre-existing prior version release package was available on disk to execute a physical multi-version downgrade test. In strict compliance with the plan's cutover decision rule:
- `all required gates pass -> Ship or Ship opt-in`
- `any required gate fails or is missing evidence -> Internal Preview; fix only that blocker`

**Cutover Decision:** **`Internal Preview` (Release Candidate RC1 Baseline)**

---

## 2. Release Artifact Inventory & Hashes

| Property | Value |
| :--- | :--- |
| **Package Directory** | `plans/260827-1345-production-cutover-release-hardening/reports/artifacts/AntiFan-Browser-Desktop-win32-x64` |
| **Executable Name** | `antifan-browser-desktop.exe` |
| **Executable Size** | `225,562,624 bytes` (~215.1 MB) |
| **Candidate SHA-256** | `764c9ddb91d84c64e7ed845b31276cae734ddac2ea3c95d6076e757a610690f5` |
| **Previous Package Hash** | `N/A (First production release candidate baseline)` |
| **Manifest Path** | `plans/260827-1345-production-cutover-release-hardening/reports/artifacts/windows-x64-manifest.json` |
| **Native Modules** | `node-pty` (win32 x64 prebuild unpacked in `app.asar.unpacked`) |

---

## 3. Detailed Release Gate Evidence by Group

### Gate Group 1: Source, Type, and Unit Test Contracts
- **Working Directory:** `E:\Work\apps\antifan-browser-desktop`
- **Commands & Exit Codes:**
  1. `npm run typecheck` (`tsc -p ./ --noEmit`) -> **Exit 0**, 0 errors.
  2. `npm test` (`node --test .compiled/test/main/*.test.js`) -> **Exit 0**, 228 passed across 52 test suites.
  3. `node --test .compiled/test/workflow-and-artifact-security.test.js` -> **Exit 0**, 10 passed across 3 test suites.
  4. `node --test .compiled/test/main/ipc-audit.test.js` -> **Exit 0**, 11 passed (Enforces single workflow authority in `ControlPlaneRuntime`, strict shortcut ownership, and renderer DOM parity).
  5. `node --test .compiled/test/main/capability-catalogue.test.js` -> **Exit 0**, 15 passed (Enforces lease grants, policy enforcement, and tool discovery).
- **Durable Observation:** Zero type errors, zero test regressions, zero unhandled rejections.

---

### Gate Group 2: Packaged Windows Electron Startup & Native Addons
- **Working Directory:** `E:\Work\apps\antifan-browser-desktop`
- **Build Command:** `node scripts/package-windows.mjs` -> **Exit 0**
- **Executable Verified:** `plans/260827-1345-production-cutover-release-hardening/reports/artifacts/AntiFan-Browser-Desktop-win32-x64/antifan-browser-desktop.exe`
- **Native Addon (`node-pty`):** Packaged application boots into production mode and successfully initializes `node-pty` terminal instances without missing dynamic libraries or source tree dependencies.
- **Process Teardown:** Clean PID exit and process tree termination verified on Windows with 0 zombie processes.

---

### Gate Group 3: Theme Developer Browser / Terminal / Evidence Loop
- **Working Directory:** `E:\Work\apps\antifan-browser-desktop`
- **Command:** `node scripts/smoke-packaged-theme-developer.cjs` -> **Exit 0**
- **Durable Log:** `plans/260827-1345-production-cutover-release-hardening/reports/smoke/packaged-theme-developer-smoke.log`
- **Isolated Directories Used:**
  - Temp User Data: `AppData\Local\Temp\antifan-pkg-theme-userdata-C582ur`
  - Temp Config: `AppData\Local\Temp\antifan-pkg-theme-config-QXP5hU`
  - Temp Workspace: `AppData\Local\Temp\antifan-pkg-theme-ws-OAGsI8`
- **Verified Workflow Steps:**
  1. Local HTTP Theme Preview fixture server started on `http://127.0.0.1:59143/`.
  2. Packaged Electron runtime bootstrap and Bridge Server discovery via `bridge.json` (PID: 30132).
  3. WebSocket connection to Bridge RPC with token authentication.
  4. Authoritative session creation with lease issuance (`session.create`).
  5. Packaged Chromium navigation to Theme Storefront preview (`browser.navigate`).
  6. Real-time DOM element query and inspection (`browser.dom`).
  7. High-fidelity PNG screenshot capture from packaged Chromium with valid header verification (`browser.screenshot`, size: 11270 bytes).
  8. Graceful session termination and audit logging.

---

### Gate Group 4: NativeTabHost Split Review & Terminal Renderer Smoke
- **Working Directory:** `E:\Work\apps\antifan-browser-desktop`
- **Commands & Logs:**
  1. `npm run smoke:split` -> **Exit 0**  
     **Log:** `plans/260827-1345-production-cutover-release-hardening/reports/smoke/split-review-smoke.log`
  2. `node scripts/run-electron.cjs test/e2e/terminal-renderer-smoke.cjs` -> **Exit 0**  
     **Log:** `plans/260827-1345-production-cutover-release-hardening/reports/smoke/terminal-renderer-smoke.log`
- **Verified Invariants:**
  - Split review desktop/mobile dual viewports (1280x832 & 393x852).
  - Synchronized navigation, reload, history traversal, and zoom scaling.
  - Coordinate crop and DOM inspect mode cleanup.
  - Security scheme rejection (verified `isAllowedNavigation` blocks `javascript:`, `data:`, and `file:` schemes).
  - Terminal geometry stability (946x522), zero scroll-jump (preserved at line 43), and background buffer streaming across switches.

---

### Gate Group 5: Recovery, Process Cleanup, and Persistence Boundaries
- **Working Directory:** `E:\Work\apps\antifan-browser-desktop`
- **Command:** `node scripts/smoke-packaged-recovery.cjs` -> **Exit 0**
- **Durable Log:** `plans/260827-1345-production-cutover-release-hardening/reports/smoke/packaged-recovery-smoke.log`
- **Isolated Directories Used:**
  - Temp User Data: `AppData\Local\Temp\antifan-pkg-recovery-userdata-se2QkM`
  - Temp Config: `AppData\Local\Temp\antifan-pkg-recovery-config-GpoyCw`
- **Verified Lifecycle:**
  1. Run 1 (PID 20004): Launched packaged app, seeded storefront tabs `https://example.com/recovered-tab-alpha` and `https://example.com/recovered-tab-beta`.
  2. Tabs persisted to disk via Bridge RPC `antifan.persistTabs`.
  3. Graceful shutdown requested via Bridge RPC `antifan.quit`; exit code observed: 0 (signal: null, forced: false).
  4. Run 2 (PID 31336): Launched packaged app pointing to the exact same user data directory.
  5. Recovered tabs queried via Bridge RPC: `https://www.google.com`, `https://example.com/recovered-tab-alpha`, `https://example.com/recovered-tab-beta` (100% restored, 0 data loss).
  6. Clean graceful teardown of Run 2 observed with exit code 0.

---

### Gate Group 6: Rollback & Profile Preservation Procedure
- **Working Directory:** `E:\Work\apps\antifan-browser-desktop`
- **Command:** `node scripts/smoke-rollback-procedure.cjs` -> **Exit 0**
- **Durable Log:** `plans/260827-1345-production-cutover-release-hardening/reports/smoke/rollback-smoke.log`
- **Verified Invariants:**
  1. **Checksum Match:** Packaged binary SHA-256 byte-for-byte matches `windows-x64-manifest.json` (`764c9ddb91d84c64e7ed845b31276cae734ddac2ea3c95d6076e757a610690f5`).
  2. **Profile Isolation:** User data directory (`saved-tabs.json`, cookies, workspaces) remains completely isolated from application binaries in `%APPDATA%\antifan-browser-desktop`.
  3. **No Unknown Replay:** Restored tabs match exact persisted URLs without executing un-saved or unknown mutations.
  4. **Multi-Version Downgrade Note:** No prior external binary existed on disk (`ANTIFAN_PREVIOUS_PACKAGE_DIR` unconfigured); candidate baseline recorded.
  5. **Uninstall Boundary:** Deleting package installation directory leaves user profile data completely intact.

---

## 4. Single Workflow Authority & Architecture Pruning Audit

1. **Unified Authority:**
   - Single production `WorkflowRegistry` and `WorkflowEngine` authority consolidated into `ControlPlaneRuntime`.
   - Removed secondary and un-gated `WorkflowRegistry` instantiation from `NativeTabHost`.
   - All renderer workflow invocations routed through `antifan:workflow:*` IPC directly to `ControlPlaneRuntime`.
2. **Pruning Audit Results:**
   - Retained Mobile Remote (`mobile-remote-html.ts`) and QR Generator (`qr-generator.ts`) as low-footprint, verified mobile preview helpers.
   - Retained Chat Store (`chat-store.ts`) and DeepSeek Adapter (`deepseek-harness-adapter.ts`) as isolated, test-covered optional adapters behind explicit configuration flags.

---

## 5. Rollback Procedure Reference

If a regression is reported during Internal Preview:
1. **Preserve User Data:** Keep `%APPDATA%\antifan-browser-desktop` and `%USERPROFILE%\.antifan-browser` intact.
2. **Binary Replacement:** Replace the executable directory with the backup or previous build directory.
3. **Defensive Schema Migration:** `saved-tabs.json` is protected by `migratePersistedTab` and `sanitizeTabForPersistence`, safely degrading missing fields to standard defaults without crashing.
