---
title: "Drive E Storage Relocation, Low-Spec Hardware Optimization & QA Generation Hardening"
description: "Redirect 100% of AntiFan storage to Drive E, optimize Chromium and scanners for i5-9300H/UHD 630 low-spec hardware, harden Async QA generation guards, and build real multi-process endurance soak testing."
status: complete
effort: "1d"
tags: [storage, optimization, performance, theme-qa, soak-test, hardening]
created: 2026-08-30
---

# Drive E Storage Relocation, Low-Spec Hardware Optimization & QA Generation Hardening

## Overview
Comprehensive engineering plan to relocate all storage, cache, session manifests, artifacts, and profiles from Drive C to Drive E (`E:\Work\.antifan-data\...`), optimize Chromium and theme scanners for Intel Core i5-9300H (4C/8T) and Intel UHD 630 iGPU, harden Async Theme QA with generation epoch guards, and build a real multi-process runtime endurance soak test suite.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | **Drive E Zero Footprint:** Redirect 100% of profiles, cache, session manifests, and artifacts to `E:\Work\.antifan-data` with atomic cross-volume migration and NTFS DACL protection | P1 |
| 2 | **Low-Spec Hardware Optimization:** Bound renderer processes to 4, reduce disk/media cache to 128MB/64MB, throttle background tabs, and insert cooperative yields in theme scanners | P1 |
| 3 | **Async QA Generation Guard:** Prevent race conditions by verifying document generation, handling synthetic reloads, and isolating per-tab QA state | P1 |
| 4 | **Real Runtime Soak Endurance:** Build an automated multi-process soak test suite measuring linear memory slope ($\beta \le 1.0\text{ MB/min}$) and verifying zero orphan processes | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Drive E Complete Storage Relocation & Migration Engine](./phase-01-drive-e-storage-relocation.md) | Complete |
| 2 | [Phase 2: Low-Spec Hardware Optimization (Chromium flags, Throttling & Yields)](./phase-02-low-spec-hardware-optimization.md) | Complete |
| 3 | [Phase 3: Async QA Generation Guard & Race-Condition Defense](./phase-03-async-qa-generation-guard.md) | Complete |
| 4 | [Phase 4: Real Runtime Endurance Soak Test Suite & Final Verification](./phase-04-real-runtime-soak-test.md) | Complete |
## Master Verification Gates

| Gate ID | Domain | Invariant / Acceptance Criterion | Verification Method |
| :--- | :--- | :--- | :--- |
| **GATE-01** | Drive E Relocation | 100% of user data, profiles, caches, sessions, and artifacts reside under `E:\Work\.antifan-data`. Zero bytes written to `%APPDATA%\antifan-browser-desktop` or `~/.antifan`. | Inspect filesystem paths during runtime; run `test/main/storage-locations.test.ts` |
| **GATE-02** | Profile Migration | Existing cookies and session state from legacy Drive C locations are safely migrated to Drive E on first run via intra-volume staging (no EXDEV errors) and protected with NTFS ACLs. | Run `test/main/profile-ownership.test.ts` with mock legacy profile |
| **GATE-03** | Low-Spec Flags | Chromium switches `renderer-process-limit=4`, `process-per-site`, 128MB disk cache, 64MB media cache, and disabled GPU memory buffer frames are active. | Verify `app.commandLine` and `app.getAppMetrics()` |
| **GATE-04** | Tab Throttling | Inactive background `WebContentsView` instances have `setBackgroundThrottling(true)` enabled; active foreground tab has throttling disabled. | Run `test/main/low-spec-optimization.test.ts` |
| **GATE-05** | Event-Loop Health | Cooperative yields between Theme QA scanner stages prevent main process event loop delays from exceeding $50\text{ms}$. | Run telemetry delay monitor during large storefront scan |
| **GATE-06** | Async QA Safety | Post-await abort checks, synthetic reload generation propagation, and per-tab `Map<string, ThemeQaState>` prevent race conditions. | Run `test/main/async-qa-generation-guard.test.ts` |
| **GATE-07** | Real Soak Test | Real Electron endurance test runs 4 stages with linear memory slope $\beta \le 1.0\text{ MB/min}$ and 0 orphan processes. | Run `npm run smoke:soak` and `npm run test:soak` |
| **GATE-08** | Full Suite Green | 0 TypeScript compilation errors; 100% of unit, integration, and E2E tests pass. | Run `npm run compile` and `npm test` |

## Red Team Review

### Session — 2026-08-30
**Findings:** 5 (5 accepted, 0 rejected)  
**Severity breakdown:** 3 Critical, 2 High, 0 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | **EXDEV Cross-Volume Directory Rename Failure:** `tempPath` created on Drive C (%APPDATA%) fails with `EXDEV` when renamed to Drive E (`canonicalPath`). | Critical | Accept | Phase 1 (Stage temp directly on destination volume `path.dirname(canonicalPath)`) |
| 2 | **Self-Aborting Workflow on Synthetic Reload:** `ThemeQaWorkflow.validate()` calls `reload()` which triggers `did-start-navigation` and self-aborts the active job. | Critical | Accept | Phase 3 (Update active job generation & signal during synthetic reload) |
| 3 | **Unprotected Secondary Drive NTFS ACLs:** Relocating token files to `E:\Work\.antifan-data` exposes them to unprivileged local users if default volume DACL is permissive. | Critical | Accept | Phase 1 (Apply `enforceProtectedDirectoryDacl` to `StorageLocations` root) |
| 4 | **Singleton `themeQaState` Race Condition:** `NativeTabHost` stores global `themeQaState`, allowing background scan resolution on Tab A to clobber active Tab B's toolbar. | High | Accept | Phase 3 (Refactor to `Map<string, ThemeQaState>` keyed by `tabId`) |
| 5 | **WebSocket Starvation on Tab Throttling:** Background throttling could starve live-reload WebSockets or active PTYs. | High | Accept | Phase 2 (Scope throttling strictly to timers/RAF without closing active sockets) |

### Whole-Plan Consistency Sweep
- **Consistency Verification:** All 4 phase files updated with the 5 red team findings.
- **Zero Contradictions:** All interfaces, path references, error handling, and test plans are synchronized.

<!-- slug: drive-e-migration-and-low-spec-hardening -->
