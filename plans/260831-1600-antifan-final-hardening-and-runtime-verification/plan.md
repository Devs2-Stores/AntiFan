---
title: "AntiFan Final Hardening & Runtime Verification"
status: pending
priority: P1
totalPhases: 4
planSlug: "260831-1600-antifan-final-hardening-and-runtime-verification"
created: "2026-08-31T16:00:00Z"
targetBranch: "HEAD 9e06cc4"
---

# AntiFan Final Hardening & Runtime Verification Plan

## Executive Summary
This plan delivers the complete and final hardening of AntiFan desktop application before permanent feature freeze. It directly addresses the critical vulnerabilities, V8 isolation boundaries, Windows NTFS file lock collisions, Theme QA settle races, and reality gaps identified during the deep audit, adversarial Red Team review, and technical advisory:
1. **Workspace Tenancy & File I/O Safety:** Strict `WORKSPACE_UNBOUND` enforcement, elimination of ambient directory fallbacks in `AnnotationManager`, and Windows `writeAtomicWithRetry` handling `EBUSY`/`EPERM` locks without watcher storms.
2. **Untrusted DOM Security:** Neutralization of prompt injection vectors via `<storefront_untrusted_dom>` XML CDATA taint envelopes with closing tag sanitization.
3. **Dual-Tier Interaction Engine (Synthetic & CDP Trusted):** 
   - *Tier 1 (Fast Synthetic DOM Cascade):* Native prototype descriptor setter stealing in World 1004 and bubbling synthetic `InputEvent` cascade (`isTrusted: false`, sub-5ms) for React 16–19, Vue 3, and Web Components.
   - *Tier 2 (Required CDP Trusted Path):* Explicit CDP `Input.insertText` / `Input.dispatchKeyEvent` execution via `TabAutomationHost` for security-gated forms and bot-detection fields requiring authentic browser-generated events (`isTrusted: true`), verified via live Electron/CDP test.
4. **Theme QA Reliability:** Bounded 3-stage settle gates (FS debounce, 1st-party network idle, 400ms font timeout, double-rAF) and differential issue attribution with manifest-backed automatic snapshot rollback.
5. **Runtime Soak & Process Verification:** Production-grade multi-process Electron + Chromium + PTY + CDP live soak test runner with single-pass OS process tree tracking and OLS memory regression verification.

---

## Phase Roadmap

| Phase | Title | Priority | Status | Description |
|:---:|---|:---:|:---:|---|
| [01](./phase-01-core-safety-and-tenancy-isolation.md) | Core Safety & Tenancy Isolation | P0 | pending | Enforce `WORKSPACE_UNBOUND`, remove ambient fallbacks in `AnnotationManager`, XML CDATA taint envelope, Windows Named Pipe DACL, `writeAtomicWithRetry`, and eliminate inspect polling in `tab-devtools-host.ts`. |
| [02](./phase-02-controlled-inputs-and-synthetic-events.md) | Controlled Inputs & Dual-Tier Synthetic/CDP Interaction Engine | P0 | pending | Tier 1 fast native prototype descriptor setter stealing in World 1004 (`isTrusted: false`) + Tier 2 required CDP `Input.insertText` path (`isTrusted: true`) for security-gated forms with live verification test. |
| [03](./phase-03-theme-qa-settle-gates-and-rollback.md) | Theme QA 3-Stage Settle Gates & Differential Rollback | P1 | pending | Eliminate FOUC false positives via bounded 3-stage settle gates, differential issue categorization, and manifest-backed automatic workspace rollback on R2 failure. |
| [04](./phase-04-live-electron-soak-and-final-hygiene.md) | Live Electron Soak Runner & Final Hygiene | P1 | pending | Multi-process live Electron E2E soak test runner with single-pass OS process tree tracking, OLS memory slope verification ($\beta \le 0.5\text{ MB/min}$), ESM bundler cleanup, and permanent feature freeze. |

---

## Key Invariants
- **Zero Ambient Root Fallback:** Any file capability invoked without valid authenticated workspace context must fail closed immediately (`WORKSPACE_UNBOUND`).
- **NTFS File Lock Resilience:** File writing must never crash on Windows `EBUSY`/`EPERM` file watcher locks, and temp files must not trigger spurious watcher reloads.
- **Dual-Tier Input Epistemic Precision:** Clear distinction between fast synthetic DOM cascade (`isTrusted: false`) and genuine CDP hardware emulation (`isTrusted: true`).
- **Theme QA Settle Guarantee:** No layout overflow or liquid diagnostic may execute until filesystem, 1st-party network, fonts, and layout compositor have fully settled.
- **Zero Orphan OS Processes:** Process cleanup must guarantee 0 lingering `conhost.exe`, `node.exe`, or Chromium helper processes upon session close.

---

## Red Team Review

### Session — 2026-08-31
**Findings:** 8 total (8 accepted, 0 rejected)  
**Severity breakdown:** 2 Critical, 4 High, 2 Medium

| # | Finding | Severity | Disposition | Applied To |
|:---:|---|:---:|:---:|:---:|
| 1 | Cross-World V8 Isolation Barrier for React `_valueTracker` (World 1004 vs World 0) | Critical | Accept | Phase 02 |
| 2 | Stage 2 Settle Gate Indefinitely Stalls on Open Streams / Broken Webfonts | Critical | Accept | Phase 03 |
| 3 | Mislocated DOM Polling Loop in `tab-devtools-host.ts:349-354` | High | Accept | Phase 01 |
| 4 | Temp Files in `writeAtomicWithRetry` Triggering Watcher Reload Storms & EXDEV | High | Accept | Phase 01 |
| 5 | `AnnotationManager` Ambient Directory Fallback & Cross-Project Traversal | High | Accept | Phase 01 |
| 6 | Orphan File Leak & Recursive Symlink Escape in Automated Theme QA Rollback | High | Accept | Phase 03 |
| 7 | High-Frequency PowerShell Process Querying & Teardown Grace Window Race | Medium | Accept | Phase 04 |
| 8 | XML CDATA Prompt Injection Boundary Escapes (`</storefront_untrusted_dom>`) | Medium | Accept | Phase 01 |

### Advisory Checkpoint & Epistemic Calibration
- **Advisory:** `dispatchEvent` in DOM necessarily yields `isTrusted: false`.
- **Resolution:**
  1. Updated terminology across all plan files: Script dispatch is strictly labeled **Synthetic DOM Cascade (`isTrusted: false`)**.
  2. Defined CDP `Input.insertText` / `Input.dispatchKeyEvent` via `TabAutomationHost` as the **required first-class path** whenever `isTrusted: true` is needed.
  3. Added live Electron/CDP test contract (`test/e2e/semantic-ref-trusted-cdp.test.ts`) asserting `event.isTrusted === true` for CDP and `event.isTrusted === false` for synthetic DOM dispatch.

### Whole-Plan Consistency Sweep
- **Decision Delta:** All 8 Red Team findings and Advisory refinements applied across all 4 phase files and `plan.md`.
- **Contradictions Checked:** 0 contradictions remain.
- **Status:** **Ready to Cook**.
