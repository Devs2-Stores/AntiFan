---
title: "Hardening Controlled Inputs, Theme QA Parity, and Runtime Isolation"
date: 2026-08-31
summary: "Hardened AntiFan Desktop across dual-tier inputs (World 1004 prototype setter & CDP trusted input), theme QA parity with asset correlation helper, and multi-tenant isolation, verified across 612 tests."
---

# Hardening Controlled Inputs, Theme QA Parity, and Runtime Isolation

## What happened

During the AntiFan Desktop v1.3.4 hardening and review cycle, we resolved several critical edge cases across interaction fidelity, theme diagnostic parity, and runtime lifecycle:

1. **Controlled Inputs & Synthetic Events (Dual-Tier Engine)**:
   - *Tier 1*: Addressed React 18/19 controlled input state dropping by stealing the native prototype property descriptor setter (`setNativeValue`) inside Isolated World 1004, accompanied by a complete synthetic event cascade (`beforeinput`, `input`, `change`, `composed: true`). Live Chromium E2E tests confirmed sub-5ms execution latency and proper React state synchronization without dropping characters.
   - *Tier 2*: Integrated hardware-level CDP trusted event dispatch (`Input.insertText` and OS-aware SelectAll key combinations) for masked or sensitive fields. Hardened caller methods (`dispatchAgentAction` / `agentType`) with post-execution semantic document generation and `webContents.isDestroyed()` validation to fail closed if page navigation occurs mid-stroke.

2. **Theme QA Verdict Parity & Asset Correlation**:
   - Resolved parity discrepancies between full-workflow and fallback QA paths where critical first-party asset failures (such as missing theme stylesheets) were miscounted.
   - Extracted `extractCorrelatableAssetFailures` in `src/main/qa/diagnostics-filter.ts` as a unified single source of truth handling both `validatedURL` and `url`, negative Chromium error codes, and theme CDN hosts (`theme.hstatic.net`, `cdn.shopify.com`), while cleanly rejecting `ERR_ABORTED (-3)` and third-party script crashes.

3. **Tab Host Automation & Lifecycle Fixes**:
   - Resolved `viewPageSource` duplicate network fetch by creating an `about:blank` tab and awaiting `fetchAndLoadPageSource` with the captured DOM HTML exactly once.
   - Added `maxTimer` autonomous ceiling to `CookieDebouncer`, preventing flush starvation under continuous event streams.
   - Enforced strict `WORKSPACE_UNBOUND` error handling and traversal protection (`confineWorkspaceRoot`).

## Decisions & Trade-offs

- **Dual-Tier over pure CDP**: Maintained Tier 1 (Isolated World prototype setter stealing) as the primary execution path for speed and DevTools coexistence, with Tier 2 (CDP hardware dispatch) as an opt-in path for trusted input requirements.
- **Fail-Closed on Navigation**: Explicitly rejected continuing or retrying actions if document generation increments during execution to prevent keystroke bleeding into newly navigated origins.
- **Shared Correlation Filter**: Replaced duplicate ad-hoc mapping logic with a dedicated pure helper to guarantee byte-for-byte parity across QA analysis paths.

## Verification & Outcomes

- Verified full test suite across 612 tests in 115 test suites with 0 failures, 0 skipped, and 0 regressions (covering live Electron Chromium E2E, 4-stage soak endurance, two-tier concurrency stress, and zero-mutation walker suites).
- Verified git synchronization (`git rev-parse HEAD main origin/main`) confirming commit `aa2fb40` is deployed to `origin/main`.

## Next steps

- Monitor live telemetry from storefront audit runs in production workloads.
- Extend differential rollback snapshotting to track theme assets deployed across multi-capsule workspaces.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
