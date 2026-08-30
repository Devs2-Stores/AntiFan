# Ultra Evidence Packet: Drive E Migration, Low-Spec Optimization & QA Generation Hardening

## 1. Project Background & System Context
- **Application:** AntiFan Browser Desktop (v1.3.0)
- **Target Workstation:** Intel Core i5-9300H (4C/8T @ 2.40GHz), Intel UHD Graphics 630 (Shared System VRAM), Windows 11 x64, Drive C (Low Space), Drive E (Primary Work Storage: `E:\Work`).
- **Core Stack:** Electron 43.4.0, TypeScript 5.5, @modelcontextprotocol/sdk 1.30.0, node-pty 1.1.0, @xterm/xterm 6.0.0.
- **Current Test Baseline:** 437/437 tests passing across 81 suites in ~20.3s; 0 TypeScript compilation errors.

---

## 2. Core Problem Statements & Verified Findings

### 2.1 Problem A: Drive C Storage Exhaustion
- **Finding:** `preparePersistentProfile` in `src/main/browser/profile-ownership.ts` defaults to `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop\Profile` and `...-cache`.
- **Finding:** `session-resume-controller.ts`, `bridge-server.ts`, `history-manager.ts`, and `terminal-manager.ts` default to `os.homedir()/.antifan` on Drive C.
- **Requirement:** Auto-detect `E:\Work` or Drive E runtime and redirect 100% of profile, cache, session manifests, artifacts, and config to `E:\Work\.antifan-data\...`. Guarantee zero byte footprint on Drive C.

### 2.2 Problem B: Low-Spec Hardware Stalls (i5-9300H / UHD 630)
- **Finding:** Default Chromium spawns unrestricted Renderer processes per tab/split view, causing memory bloat (>1.5GB) and CPU contention across 4 physical cores.
- **Finding:** Large default disk cache (512MB) and media cache (256MB) stress shared iGPU VRAM on UHD 630.
- **Finding:** Synchronous DOM and Liquid regex evaluation in `LiquidErrorScanner` and `LayoutOverflowEngine` can block the Node/Electron event loop during large storefront scans.
- **Requirement:**
  1. Add Chromium switches: `renderer-process-limit=4`, `process-per-site`, `disk-cache-size=134217728` (128MB), `media-cache-size=67108864` (64MB), `disable-gpu-memory-buffer-video-frames`.
  2. Enable `setBackgroundThrottling(true)` on background `WebContentsView` instances.
  3. Insert cooperative event-loop yields (`await new Promise((r) => setTimeout(r, 0))`) between Theme QA scan stages.

### 2.3 Problem C: Async QA Stale Result Race Condition
- **Finding:** `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`) aborts jobs via `controller.abort()`, but underlying scanners in `ThemeQaWorkflow` awaiting CDP/DOM calls might continue execution if `signal.aborted` is not checked post-await.
- **Requirement:** Enforce post-await `signal.aborted` checks and verify document `generation` before publishing results to ensure previous navigation reports never overwrite fresh document states.

### 2.4 Problem D: Synthetic Soak Test vs Real Endurance Proof
- **Finding:** `test/e2e/soak-test.test.ts` simulates memory slope using `Buffer.alloc(10KB)` and `setTimeout` without exercising physical Chromium/PTY/QA processes.
- **Requirement:** Build a real runtime soak test (`scripts/smoke-real-soak.cjs` / `test/e2e/soak-test.test.ts`) that spawns real Electron instances, navigates physical tabs, runs live QA scans, and verifies linear memory regression under real workloads.

---

## 3. Scope & Phasing Constraints
- **Phase 1:** Drive E Complete Storage Relocation & Migration Engine
- **Phase 2:** Low-Spec Hardware Optimization (Chromium flags, Throttling & Cooperative Yields)
- **Phase 3:** Async QA Generation Guard & Race-Condition Defense
- **Phase 4:** Real Runtime Endurance Soak Test Suite & Final Verification
