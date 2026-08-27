---
title: "AntiFan Headless Mode Evaluation"
topic: "Headless browser support for AntiFan Browser Desktop"
status: "research-complete"
conducted: "2026-08-27"
platform: "Electron 43 / Chromium / Windows x64"
---

# Research Report: AntiFan Headless Mode

## Executive Summary

AntiFan should add headless support, but as a separate execution mode for automated Theme QA, CI, MCP jobs, and batch diagnostics—not as a hidden variant of the current desktop `BrowserWindow` + `WebContentsView` host.

The current product is a stateful, visible Chromium control plane. `NativeTabHost` creates a `BrowserWindow`, multiple `WebContentsView` instances, toolbar/sidebar/terminal views, device emulation, visual cursor overlays, screenshots, persistent profiles, and UI lifecycle state. Running that same composition headlessly would retain most Electron/window overhead while introducing display, GPU, profile-lock, focus, and shutdown edge cases. Electron's own documentation describes headless CI as requiring a display driver or virtual display, while Electron offscreen rendering is a bitmap/texture rendering mechanism rather than a general-purpose browser service.

The recommended design is a **Headless Theme QA Runner** with a narrow browser adapter. It should launch or attach to a dedicated Chromium headless process through CDP, implement the existing `BrowserHostPort` contract for the subset required by `ThemeQaWorkflow`, and reuse the current `PlatformDetector`, Liquid scanner, overflow engine, asset scanner, HS rules, `ArtifactStore`, `BrowserTarget`, and result envelopes. Desktop mode remains authoritative for human inspection, login, annotations, visual debugging, and authenticated workflows that need the user's real profile.

## Decision

**Recommendation: YES, staged adoption.**

| Decision | Result |
|---|---|
| Add a headless mode for automated Theme QA and CI | **Yes** |
| Make headless the default desktop mode | **No** |
| Reuse the existing Electron `NativeTabHost` invisibly | **No** |
| Add a separate Chromium/Puppeteer/Playwright dependency immediately | **Not in this phase** |
| First implementation boundary | CDP-compatible headless runner + existing QA workflow adapter |
| Primary initial use cases | `theme.qa_validate`, smoke tests, CI/batch storefront scans |
| Human login / annotation / visual picker | Keep headful |

## Table of Contents

- [Current Architecture Fit](#current-architecture-fit)
- [Research Methodology](#research-methodology)
- [Key Findings](#key-findings)
- [Options Compared](#options-compared)
- [Recommended Architecture](#recommended-architecture)
- [Security Model](#security-model)
- [Performance and Operations](#performance-and-operations)
- [Platform Workflow Fit](#platform-workflow-fit)
- [Staged Implementation Plan](#staged-implementation-plan)
- [Acceptance Criteria](#acceptance-criteria)
- [Risks and Unresolved Questions](#risks-and-unresolved-questions)
- [References](#references)

## Current Architecture Fit

### Evidence from the repository

- `package.json` includes Electron 43, `node-pty`, WebSocket, MCP SDK, xterm, and TypeScript. It does **not** include Puppeteer, Playwright, or a browser-binary manager.
- `src/main/index.ts` creates a visible `BrowserWindow`, enables GPU-oriented Chromium switches, assigns persistent user-data/cache directories, starts `NativeTabHost`, Bridge Server, Control Plane, and optionally MCP stdio.
- `src/main/browser/native-tab-host.ts` owns visible views, toolbar/sidebar/terminal layout, tabs, split review, device emulation, visual inspection, screenshots, and persisted tab state.
- `src/main/tools/browser-control-port.ts` already defines a useful host boundary: navigation, reload, DOM, screenshot, JavaScript evaluation, diagnostics, viewport/device setup, and agent operations.
- `src/main/qa/theme-qa-workflow.ts` already consumes `BrowserControlPort`, `WorkspaceFilePort`, `ArtifactStore`, and a reload port. The static/runtime QA logic is therefore reusable if the browser host contract is implemented headlessly.
- `src/main/tools/browser-capabilities.ts` registers `theme.qa_validate` and `theme.debug_bundle` against the current browser port. The MCP surface can remain stable while target acquisition changes.
- `scripts/smoke-theme-qa-gate.cjs` currently tests scanners and workflow using an in-memory `BrowserHostPort` mock. It does not yet prove a real Chromium process, real DOM execution, screenshot capture, or network telemetry.

### Architectural implication

The repository already has the correct seam for headless support: `BrowserHostPort` / `BrowserControlPort`. The missing piece is not another QA engine. It is a production browser-host implementation and explicit lifecycle/target ownership for a headless runtime.

## Research Methodology

- Research date: 2026-08-27.
- Local evidence: `README.md`, `package.json`, `docs/operations.md`, `src/main/index.ts`, `src/main/browser/native-tab-host.ts`, `src/main/tools/browser-control-port.ts`, `src/main/tools/browser-capabilities.ts`, `src/main/qa/theme-qa-workflow.ts`, `scripts/smoke-theme-qa-gate.cjs`, and existing QA tests.
- External sources: official Chrome, Electron, Playwright, Puppeteer, and Shopify documentation.
- Search scope: current headless browser architecture, Electron offscreen/headless behavior, CDP debugging, automation browser choices, and CI-oriented theme workflows.
- Evaluation criteria: behavior fidelity with storefronts, reuse of current contracts, startup/RAM cost, authentication, screenshots, network telemetry, security isolation, Windows packaging, CI determinism, and operational complexity.

## Key Findings

### 1. Chrome headless is now unified with regular Chrome

Chrome documents `--headless` as an unattended browser mode without visible UI. Since Chrome 132, the old headless implementation is no longer part of the main Chrome binary and is distributed separately as `chrome-headless-shell`. The unified mode shares more of the regular Chrome implementation and is the better fit for high-fidelity storefront checks.

Implication: AntiFan should prefer a normal Chromium/Chrome headless process for fidelity. A legacy headless shell may be faster, but should not be the default for QA where CSS, WebGL, authentication, and browser behavior matter.

### 2. Electron offscreen rendering is not equivalent to a clean headless service

Electron offscreen rendering provides bitmap or shared GPU texture output from a `BrowserWindow`. It remains a window-based Electron process, is always frameless, and has GPU/CPU rendering trade-offs. Electron's CI documentation also states that Electron requires a display driver; Linux CI commonly needs Xvfb.

Implication: `BrowserWindow({ show: false })` or `offscreen: true` could support a narrow prototype, but it is the wrong production boundary for a low-overhead unattended runner. It would still initialize Electron application state, window ownership, Chromium profile handling, and much of `NativeTabHost`.

### 3. Playwright and Puppeteer provide mature browser lifecycle APIs, but add dependency policy

Puppeteer currently defaults to unified Chrome Headless and supports a separate `headless: 'shell'` mode for the old shell. Playwright documents both a headless shell path and a full-browser `channel: 'chromium'` path for higher fidelity. Both ecosystems install/manage browser binaries separately from the application runtime.

Implication: either library can implement the first runner, but adding one means managing browser download size, version pinning, cache location, updates, licensing/release packaging, and a second automation abstraction. A lower-risk first slice is a CDP adapter around an approved Chromium binary or an already available Chrome for Testing installation. Select Puppeteer or Playwright only after a small benchmark proves that the extra lifecycle API materially reduces implementation risk.

### 4. The current QA workflow is already close to headless-compatible

`ThemeQaWorkflow.validate()` performs:

1. DOM and screenshot evidence capture.
2. Reload.
3. Platform detection.
4. Live/static Liquid scan.
5. Layout overflow scan.
6. Broken asset plus diagnostics correlation.
7. HS rules evaluation.
8. Checklist and PII-sanitized report artifact generation.

These operations map naturally to a headless page/context. The main incompatible assumptions are target acquisition, screenshot implementation, diagnostics collection, viewport/device setup, and lifecycle cleanup.

### 5. Headless and headful should not share a persistent profile by default

The desktop app deliberately uses persistent Chromium profile directories for human sessions. A headless job must use a unique temporary or job-scoped profile. Sharing the desktop profile creates lock contention, cookie leakage between jobs, non-deterministic tabs, and a path for CI or MCP requests to access a user's authenticated state.

Authenticated headless runs should be explicit, opt-in, and isolated. Google OAuth should remain external/headful as already designed; headless should not attempt to bypass provider embedded-login policies.

### 6. Shopify's CLI is already designed for machine-readable CI workflows

Shopify's official `theme push` documentation exposes `--json` for machine-readable output and `--strict` to require Theme Check to pass without errors before pushing. This supports a useful boundary: AntiFan headless QA should verify a storefront and produce artifacts, while platform CLIs remain the authority for platform-specific upload/push operations.

AntiFan must not silently turn headless QA into a deployment engine. Any future CLI integration should be a separate, explicitly gated capability.

## Options Compared

| Option | Reuse | Fidelity | Cost | Main risk | Verdict |
|---|---:|---:|---:|---|---|
| Hidden existing Electron window | High | Medium/High | Medium/High | Window/UI lifecycle, profile locks, GPU/display edge cases | Reject for production |
| Electron offscreen `BrowserWindow` | Medium | Medium/High | High | Bitmap copies, still Electron/window-based, not a clean service | Prototype only |
| Puppeteer + dedicated headless Chrome | High at page level | High | Medium | Browser binary/version/package management | Viable |
| Playwright + dedicated headless browser | High at page level | High | Medium/High | Larger API/runtime surface and browser downloads | Viable, benchmark first |
| Raw CDP adapter to approved Chromium | Medium | High | Low/Medium | More lifecycle/protocol code owned by AntiFan | Recommended first seam |
| External remote browser service | Low | Variable | High/ongoing | Data residency, latency, credentials, vendor dependency | Not justified now |

### Why raw CDP is the initial recommendation

The existing project already controls Chromium through Electron and has explicit browser contracts. A small CDP runner can expose only what Theme QA needs, avoid adding a second test framework, and keep the control plane in charge of leases, targets, artifacts, and security. The runner can later be backed by Puppeteer or Playwright internally without changing the MCP/QA contract if the adapter remains stable.

This choice trades implementation effort for dependency and packaging control. It is appropriate for a first bounded slice; it is not a reason to reimplement all of Playwright.

## Recommended Architecture

```text
MCP / CLI / CI request
          |
          v
ControlPlaneRuntime + CapabilityCatalogue
          |
          +--> HeadlessTargetManager
          |       - job-scoped userDataDir
          |       - approved browser binary
          |       - random localhost CDP endpoint
          |       - lifecycle timeout / cleanup
          |
          +--> HeadlessBrowserHost (BrowserHostPort)
          |       - navigate / reload
          |       - DOM / evaluate
          |       - screenshot
          |       - viewport / device emulation
          |       - console + network failures
          |
          v
BrowserControlPort
          |
          v
ThemeQaWorkflow + scanners + HS rules
          |
          v
ArtifactStore + redacted report + receipts
```

### Proposed boundaries

- `HeadlessTargetManager`: owns process startup, CDP connection, job profile, timeout, and cleanup. It must never reuse the desktop profile implicitly.
- `HeadlessBrowserHost`: implements `BrowserHostPort` for a single isolated job. It should not know about toolbar/sidebar/terminal/UI state.
- `HeadlessBrowserSession`: owns one or more pages/tabs and document generations. It supplies exact `BrowserTarget` values to the control plane.
- `ThemeQaWorkflow`: remains the policy/composition layer. Do not duplicate scanners for headless mode.
- MCP: add a distinct capability only if target creation cannot be represented safely by an existing bound-target flow. Keep the existing `theme.qa_validate` contract stable where possible.

### Target model

Every headless execution should carry:

- `projectId`
- `workspaceId`
- `runtimeId`
- `tabId` or page ID
- `browserEpoch`
- `documentGeneration`
- optional `url` metadata
- mode metadata, e.g. `headless`

A headless target must be invalidated when the browser process exits, the page is replaced, or the document generation changes. Do not permit a stale desktop target to dispatch into a headless session or vice versa.

## Security Model

### Required controls

1. **Binary allowlist**: launch only a configured/known Chromium or Chrome executable. Do not accept arbitrary executable paths from MCP input.
2. **Local CDP only**: bind to `127.0.0.1`, use a random port, and never expose the DevTools endpoint on `0.0.0.0`.
3. **Per-job profile**: use a unique profile directory; delete it on normal completion and apply bounded cleanup on failure.
4. **No desktop cookies by default**: no implicit import from `ChromeProfileSyncManager`, Electron session, or the user's default Chrome profile.
5. **Navigation policy**: reuse and extend the existing URL policy. Headless scans must address SSRF risks, including localhost, private-network, file, and metadata-service URLs when running in CI or a shared environment.
6. **Capability separation**: default headless mode is read-only QA. Block arbitrary evaluation, downloads, filesystem access, and deployment actions unless separately granted.
7. **Artifact redaction**: preserve the current PII sanitizer and ensure screenshots, DOM, console, URL query strings, and network failure records do not leak tokens or customer data.
8. **Resource limits**: cap pages/tabs, navigation time, evaluation time, screenshot bytes, DOM bytes, total job duration, and concurrent headless jobs.
9. **Crash cleanup**: close pages, disconnect CDP, terminate the browser process tree, and remove temporary profiles without killing unrelated Chromium instances.
10. **Receipt semantics**: publish one authoritative run/attempt receipt. A timeout after navigation must be `unknown`, not an automatic retry that could duplicate mutations.

### Authentication boundary

- Public storefront QA: supported by default.
- Test-store session cookies: support only through an explicit encrypted/short-lived credential handoff, not by reading the desktop profile.
- Google OAuth: remain external/headful. Do not attempt to solve Google's embedded-WebView restriction with headless flags or user-agent spoofing.
- Haravan/Sapo/Shopify admin sessions: separate from public storefront QA and require an explicit high-risk grant.

## Performance and Operations

### Expected benefits

- No visible window or UI composition cost for CI/batch runs.
- Parallel jobs become possible with isolated profiles and bounded concurrency.
- Better fit for GitHub Actions, local pre-commit checks, nightly theme scans, and MCP-triggered one-off diagnostics.
- Deterministic viewport, locale, timezone, and reduced-motion settings can be applied per job.
- Real browser screenshots and DOM/runtime evidence replace synthetic-only smoke coverage.

### Costs

- A browser binary is large relative to AntiFan's stated lightweight desktop goal.
- Cold startup and browser process management add complexity.
- Headless and headful rendering can still diverge. Use unified Chrome headless for high-fidelity validation and report the mode in every artifact.
- Multiple concurrent Chromium processes can exceed the current memory target. Concurrency must be bounded rather than inferred from CPU count.
- Network-dependent storefronts remain flaky without deterministic wait conditions, request timeouts, and a clear offline/online policy.

### Operational defaults

- One headless job per process initially.
- Default timeout: bounded, configurable, and shorter than an interactive desktop session.
- Unique profile/cache per job, with optional reusable browser binary cache but never reusable authenticated profile state.
- Default viewport set from the existing device presets; active viewport scan first, multi-breakpoint sweep on demand.
- Emit run metadata: browser version, headless mode, viewport, DPR, locale, timezone, URL, and scanner versions.

## Platform Workflow Fit

### Haravan

Headless is valuable for public storefront preview URLs, Liquid runtime checks, responsive checks, broken hstatic assets, and HS compatibility diagnostics. Admin authentication should remain headful/external unless the operator explicitly supplies an isolated test credential.

### Sapo

Headless is valuable for `.bwt` storefront preview flows, `/postcontact` and cart contract checks, responsive QA, and detection of Sapo-specific data fields. The passive cart assertion decision remains correct: observe real forms/network calls; do not add synthetic products to a customer's cart.

### Shopify

Headless is valuable for preview-theme URLs, Theme QA, Liquid rendering, asset/network checks, and machine-readable CI reports. Shopify CLI remains the upload/check authority. The official `theme push --json` and `--strict` flags are compatible with a future CI wrapper, but deployment must be separately gated.

## Staged Implementation Plan

### Stage 0 — Contract and measurement

- Add an explicit browser mode field to internal runtime/session metadata, without changing desktop defaults.
- Define `HeadlessTargetManager` and `HeadlessBrowserHost` interfaces.
- Benchmark one real local storefront against the current mock workflow: cold start, navigation, DOM, screenshot, evaluate, network failures, and cleanup.
- Decide whether raw CDP is sufficient or whether Puppeteer/Playwright reduces risk enough to justify dependency/binary cost.

### Stage 1 — Read-only headless QA runner

- Launch an approved unified Chromium headless process with a unique profile.
- Implement navigation, reload, DOM, evaluate for fixed scanner scripts, screenshot, viewport, console, and network failure capture.
- Run `ThemeQaWorkflow.validate()` against a real local HTTP fixture.
- Stage the same redacted report/artifacts as headful mode.
- Add deterministic cleanup and process-tree tests.

### Stage 2 — MCP/CLI integration

- Add an explicit headless target acquisition capability, likely `theme.qa_validate_headless` or a mode parameter that is only accepted for unbound/new isolated jobs.
- Keep arbitrary `browser.eval` unavailable in default headless mode.
- Return target/lease/run/attempt metadata and artifact references through the existing envelope.
- Add a CLI command for CI with JSON output and non-zero exit on critical QA errors.

### Stage 3 — Real storefront and platform gates

- Add local fixture coverage for Haravan, Sapo, and Shopify platform markers.
- Verify active viewport and optional multi-breakpoint scans.
- Verify passive cart/form assertions and CDP network correlation.
- Add screenshots and DOM evidence to the executable smoke test.
- Add bounded retries only for pre-publication navigation failures; never retry after a published mutation.

### Stage 4 — Packaging and release hardening

- Pin browser version and document cache/update policy.
- Package or provision the browser binary for Windows CI and local use.
- Add Windows process-tree cleanup and profile cleanup tests.
- Add security tests for SSRF, arbitrary executable path, CDP exposure, stale target, and artifact PII.
- Compare headless and headful reports on a representative storefront before making any release claim.

## Acceptance Criteria

Headless mode should not be considered production-ready until all are true:

- A real Chromium headless process can run a local storefront fixture without a visible AntiFan window.
- `ThemeQaWorkflow.validate()` produces the same report schema and redaction guarantees in headless and headful modes.
- DOM, screenshot, JavaScript scanner, viewport, console, and network failure evidence are real—not mocks.
- Headless jobs use isolated profiles and clean up browser processes/files on success, timeout, and crash.
- Stale headless targets are rejected by the same target/lease rules as desktop targets.
- Default headless mode cannot access the desktop user's cookies or arbitrary filesystem/network targets.
- Haravan, Sapo, and Shopify rules remain platform-scoped with no cross-platform leakage.
- CI can consume a deterministic JSON result and exit non-zero for critical QA failures.
- Desktop visual workflows, annotations, external Google OAuth, and current MCP behavior remain unchanged.
- Headless and headful differences are recorded in report metadata and tested on at least one representative storefront per supported platform.

## Risks and Unresolved Questions

1. **Browser provisioning**: Should AntiFan ship a pinned Chrome for Testing binary, discover a system Chrome, or require an operator-provided executable? Shipping is more deterministic but increases installer size and update responsibility.
2. **Library choice**: Raw CDP minimizes dependency surface; Puppeteer/Playwright reduce browser lifecycle code. A Stage 0 benchmark should decide rather than guessing.
3. **Electron reuse**: A hidden Electron mode may be useful for a local prototype or existing-profile debugging, but its security and lifecycle behavior should not define the CI runner.
4. **Authenticated stores**: The exact credential handoff for private Haravan/Sapo/Shopify preview URLs needs a product/security decision. Do not infer permission to import browser cookies.
5. **Network policy**: Headless CI needs an explicit allow/deny policy for localhost and private IP ranges. Public storefront preview URLs and local fixtures have different requirements.
6. **Visual parity**: Device emulation, font availability, GPU behavior, and screenshot encoding need empirical comparison on Windows before setting pixel-diff thresholds.
7. **Concurrency**: The current product goal of low memory usage conflicts with unbounded parallel Chromium processes. Start serially and measure.

## References

### Official Documentation

- Chrome Headless mode: https://developer.chrome.com/docs/automation-and-testing/headless
- Debugging Chrome Headless with remote DevTools: https://developer.chrome.com/docs/automation-and-testing/debug-headless
- Electron Offscreen Rendering: https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- Electron testing on headless CI systems: https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci
- Playwright browsers and headless shell/new headless mode: https://playwright.dev/docs/browsers
- Puppeteer headless modes: https://pptr.dev/guides/headless-modes
- Shopify `theme push` and CI-oriented JSON/strict flags: https://shopify.dev/docs/api/shopify-cli/theme/theme-push

### Local Evidence

- `src/main/index.ts` — Electron startup, persistent profile, GPU switches, window/control-plane initialization.
- `src/main/browser/native-tab-host.ts` — visible tab host, WebContentsView layout, device emulation, inspection, screenshot, and tab lifecycle.
- `src/main/tools/browser-control-port.ts` — browser host boundary reusable by a headless adapter.
- `src/main/qa/theme-qa-workflow.ts` — scanner orchestration, artifacts, checklist, and PII sanitization.
- `src/main/tools/browser-capabilities.ts` — Theme QA MCP capability registration.
- `scripts/smoke-theme-qa-gate.cjs` — current scanner/workflow smoke coverage and its mock browser host.
- `package.json` — current dependency/runtime inventory.

## Conclusion

Add headless support as a **separate, read-only, job-scoped QA runtime**. Do not hide the existing Electron desktop window and call that headless. The repository's existing contracts make a separate adapter practical; the primary engineering work is lifecycle, target ownership, security isolation, real browser telemetry, and packaging—not duplicating Theme QA logic.

The first implementation should prove one real local storefront end-to-end, then decide raw CDP versus Puppeteer/Playwright using measured startup, memory, fidelity, and maintenance cost. Until that proof exists, keep headless as an opt-in capability and retain headful mode as the source of truth for human visual inspection and authentication-heavy workflows.
