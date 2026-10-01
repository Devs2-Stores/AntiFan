# Phase 4 Diagnosis — MCP Field Blockers (source-trace only, no src/ changes)

**Date**: 2026-10-01 · **Plan**: `plans/261001-0902-detached-project-webhub-windows/plan.md` → `phase-04-mcp-field-blockers.md`
**Field evidence**: `E:/Work/customizes/Levents/plans/260920-1833-levents-storefront-rebuild/reports/antifan-pixel-gate-blocked.md`
**Scope honored**: diagnosis only; every claim below cites a `file:line` producer. No source edited.

---

## D1 — CAPTURE_FRAME_STARVATION / TARGET_BUSY_DRAINING on background-tab capture

### Producers

1. **`src/main/browser/tab-devtools-host.ts:2102-2167`** — `ensureFramesForRaster()`. Frame-liveness gate that probes the target's rAF before dispatching `Page.captureScreenshot`; on a still-starved target after the repair ladder it throws `CAPTURE_FRAME_STARVATION` (`:2163-2166`) with the exact remedy text the field saw ("focus or move the AntiFan window once …").
2. **`src/main/browser/tab-devtools-host.ts:906-927`** — `sendCdpCommand()` drain quarantine. A CDP command that timed out leaves the target in `cdpDrainingTargets` for 5 s; any further command on that WebContents throws `TARGET_BUSY_DRAINING` (`:925`). After 5 s the host force-detaches the debugger and clears the entry (`:920-923`) — self-recovering by design.
3. **`src/main/browser/tab-devtools-host.ts:1935-1943` + `:2582`** — `Page.captureScreenshot` call sites, always `fromSurface: true` (comment `:1928-1932`: `fromSurface:false` dereferences the native window and crashes the browser process on OSR tabs — measured).
4. **`src/main/browser/native-tab-host.ts:1571-1576`** — `getWindowPresentationState`/`isWindowRenderable` feed the gate's per-host window reading (`visible`/`minimized`/`maximized`; focus is deliberately not part of it).

### Mechanism (what the source actually proves)

- The starvation unit is the **presented pane's compositor surface**, not "tab focus". Chromium only issues BeginFrames to surfaces a live window presents. A background (non-active) tab's `WebContentsView` is detached or stacked under the presented view → its renderer answers rAF probes with no frame → raster can never complete.
- The mitigation ladder already exists:
  - Non-foreground windowed targets are raised for the raster via `acquireCaptureLift` (`native-tab-host.ts:5865-5901`, used at `tab-devtools-host.ts:1915-1926` and `:2560-2581`). Default origin is a fully off-screen "capture host" window.
  - `ensureFramesForRaster` then repairs: `wc.invalidate()` → `reassertPresentedView()` (foreground case) or `upgradeToInWindow()` (lifted pane) (`tab-devtools-host.ts:2128-2157`).
- **Measured in-code**: parking the pane on the off-screen capture host *starves it even while the main window is maximized and visible* — "the off-screen capture host is not a surface the Windows compositor drives either (measured live …)" (`tab-devtools-host.ts:2094-2097`). This is why `upgradeToInWindow` exists.
- Focus is **not** required for BeginFrames on Windows — a visible, non-minimized window produces frames regardless of focus. The field remedy "user focused the window → capture passed" is consistent with the *window* having been occluded/minimized or its DirectComposition surface wedged, not with focus per se.
- Known residual wedge: "switchTab's DirectComposition recycle does not restart BeginFrame once capturePage is wedged; F5 does" (`tab-devtools-host.ts:1889-1891`) — a renderer/browser-process-level stall with no automated repair; the only remedies are window re-presentation or reload/restart, which is exactly what the refusal message states.

### Classification: **design-constraint** (with one tool-gap edge)

- OS/Chromium-level BeginFrame suppression for non-presented surfaces and occluded/minimized windows is real and handled fail-closed: starve → bounded repair ladder → typed `CAPTURE_FRAME_STARVATION` *before* the CDP dispatch, precisely to avoid the wedge-into-`TARGET_BUSY_DRAINING` cascade (`:2097-2100`).
- `TARGET_BUSY_DRAINING` is the intended quarantine for a target still draining a timed-out command; it clears itself after 5 s.
- **Gap (not a bug):** for the detached-window topology, the remedy text is authored for the single-window case ("focus or move the AntiFan window"). With N project windows the user needs to know *which* window owns the target; `recordLifecycleEvent('capture.frameGate', …)` already logs `window:` state (`:2159`) but the refusal message does not name the owning window. Also unproven by source alone whether an unfocused-but-visible detached window still delivers BeginFrames — per the Chromium model it should; live probe (phase-05 leg) must confirm `unfocused-visible` passes and `occluded/minimized` gets the typed refuse.

### Minimal fix sketch (none required for confirmed behavior)

No code bug confirmed. If the detached-window unfocused-visible probe starves, the only real fix is `webContents` paint enforcement — explicitly flagged in `phase-04` risk notes as churn-risky; prefer documenting typed-refuse. Cosmetic improvement candidate (optional): include the owning window id in the `CAPTURE_FRAME_STARVATION` message using `hostForRpcTab(tabId)` attribution.

---

## D2 — `anti.visual.compare` baseline rejection: "unverified pending Phase 6 baseline authority certification"

### Producers

1. **`src/main/tools/browser-control-port.ts:6943-6977`** — the exact refuse. When the caller passes `baselineScreenshotRef` (a raw staged artifact id), the compare always settles `INCONCLUSIVE`, `mismatchPercentage: null`, `totalPixels: 0`. Comment at `:6944`: "Stored baselines lack authoritative verification receipts until Phase 6 baseline authority certification."
2. **Certification producer EXISTS**: `promoteBaseline()` at `src/main/tools/browser-control-port.ts:5843-5895` — canonically captures via `captureVerificationScreenshot`, stages the artifact, then calls `this.baselineAuthority.promote(staged.id, context, { captureReceipt })` (`:5893`). `BaselineAuthority` (`src/main/verification/baseline-authority.js:56-64`) mints immutable, SHA-256-verified, workspace-scoped `vbase_*` refs (Phase 6 V-22/V-24).
3. **Reachable consume path**: `browser-control-port.ts:6889-6942` — `params.baselineRef` resolves through `baselineAuthority.resolve()` + `verifyCaptureCompatibility()` and produces a real pixel diff. Registry: `browser-control-port.ts:5734-5743` enforces exactly one of `baselineRef | baselineScreenshotRef | comparisonTabId`.
4. **MCP exposure**: `browser.promote-baseline` and alias `anti.visual.promote_baseline` registered at `src/main/tools/browser-capabilities.ts:2917-2969`. Prerequisites from `promoteBaseline`: `context.browserTarget` (bound tab), `workspaceId`, `projectId`, `runId`, `attemptId` (`:5851-5865`) — all minted at MCP pairing (`bridge-server.ts:1146-1232`), so the tool is usable from a normal MCP session.

### Classification: **tool-gap / documented design-constraint** — NOT unreachable

The gate is reachable; the field session was on the dead-end param. Correct recipe:

1. `anti.visual.promote_baseline { tabId: <baseline tab> }` → returns `vbase_*` ref (capture happens inside the tool — no separate `reference.capture` needed for the baseline).
2. `anti.visual.compare { tabId: <target>, baselineRef: "vbase_…", expectedBaselineUrl, expectedTargetUrl }`.

Two documentation defects worth flagging to the user (no silent weakening, per spec):

- The refuse message says "pending Phase 6 … certification" while Phase 6 promotion already shipped — the message should name `baselineRef`/`anti.visual.promote_baseline` as the remedy instead of a phase reference.
- `baselineScreenshotRef` is a permanently-refusing param; keeping it in the schema invites the exact failure the field hit.

---

## D3 — TARGET_STALE on navigate while the tab is actually loaded

### Producers

1. **`src/main/tools/browser-control-port.ts:1985-1998`** — `navigate()`. When `host.navigateAndWait()` returns `false`, it throws `CapabilityError('TARGET_STALE', '[<cause>] <msg>')` — **the error CODE is hard-coded `TARGET_STALE` regardless of the recorded cause** (`:1997`). The cause enum (`NAVIGATION_TIMEOUT`, `NAVIGATION_START_TIMEOUT`, `LOAD_FAILED`, `NAVIGATION_BLOCKED`) is embedded in the message bracket, so the wire shows `[NAVIGATION_TIMEOUT] …` under a `TARGET_STALE` code — which is what the field recorded.
2. **`src/main/browser/native-tab-host.ts:10171-10212`** — `navigateAndWait()`: creates `createNavigationLifecycleWaiter` on the authority view's WebContents, calls `navigate()`, awaits the waiter; `false` on timeout.
3. **`src/main/browser/native-tab-host.ts:10364-10489`** — the waiter. Resolves `true` only on `did-finish-load`/`did-navigate-in-page` **after** a main-frame `did-start-navigation`; `false` on `startTimeoutMs` (3 s) or total `timeoutMs` (default **8 s**, `:10171`). **On timeout it does not re-check whether the navigation committed** — no `wc.getURL()`/`readyState` verification before resolving false. A heavy page that commits at T+9 s produces exactly the field observation: tool returns TARGET_STALE while `tabs.list` later shows the clone URL, readyState complete.
4. **`src/main/tools/capability-transport.ts:1151-1155`** — `EXECUTION_TIMEOUT_PENDING_CLEANUP` producer: execution budget (default 30 s per policy) exceeded and owned-resource cleanup still pending. The follow-up `evaluate` hitting this is the cascade: per-tab operations are serialized (`runTargetOperation`/passive pool), so a wedged navigate starves the queued call past its budget.

### Secondary candidate (not eliminated, not provable from source alone)

- `resolveTargetTab` → `assertCurrent` → `host.isCurrentTarget` (`browser-control-port.ts:7934-7936`; `native-tab-host.ts:14390-14400`) refuses with `TARGET_STALE` when `browserEpoch`/`runtimeId`/`projectId` diverge from the current control-plane lease — it checks *authority identity*, not tab liveness. A lease rotation (reattach/restore) would produce the same code for a live tab. The reported `documentGeneration` read path auto-syncs for 'read' ops (`:7909-7911`), so docGen drift alone cannot explain navigate refusing; epoch/lease mismatch remains possible but unproven.

### Classification: **confirmed-bug** (two defects)

- **Bug A — error-code mislabel**: every navigation failure is wrapped as `TARGET_STALE` (`:1995-1997`). A navigation timeout/start-timeout is not a stale target; the code should carry the recorded cause (`NAVIGATION_TIMEOUT`, `NAVIGATION_START_TIMEOUT`, `LOAD_FAILED`) as its own typed code so retry logic and reports classify correctly.
- **Bug B — missing committed-navigation re-check**: `createNavigationLifecycleWaiter`'s timeout paths (`:10453-10477`) resolve `false` without verifying whether the navigation actually committed before settling. For the common "slow load finishes just after the bound" case the tool reports failure for a success.

### Minimal fix sketch

- In `navigateAndWait`/`createNavigationLifecycleWaiter`: on timeout, before resolving false, do one bounded post-timeout check — `wc.getURL()` equals the (redirect-resolved) target and `did-finish-load`/`document.readyState` is reachable, or simplest: extend resolution with a short grace window that still accepts `did-finish-load`/`did-navigate-in-page` — then resolve `true`.
- In `browser-control-port.ts:1991-1998`: throw with the recorded cause mapped to a distinct code (e.g. `NAVIGATION_TIMEOUT`) instead of blanket `TARGET_STALE`; keep `TARGET_STALE` only for genuinely dead targets.

---

## D4 — `rebind_target` rejects other-project tabs

### Producers

1. **`src/main/tools/browser-control-port.ts:3869-3896`** — `rebindTarget()` scope gate: rebind is permitted only to (a) tabs in the session's managed set (`getManagedTabIds`), (b) tabs `isTabAllowed` relative to the prior binding, or (c) tabs whose *measured* capsule affiliation matches the attachment's `projectId`+`workspaceId` (`resolveTabAffiliation`, `:3882-3890`). Otherwise `TARGET_MISMATCH`: "This session is isolated to tab … and its managed tabs."
2. **`src/main/tools/capability-transport.ts:663-687`** — transport-level retarget gate: `set-automation-target`/`rebind-target` are checked against the attachment's *original* authority **before** bound-tab healing rewrites it, so a dead binding still refuses foreign tabs.
3. **`src/main/tools/browser-control-port.ts:3835-3849`** — `setAutomationTarget()` applies the identical isolation rule.
4. **`src/main/browser/tab-ambient-authority.ts:11-18, 69-80`** — states intent verbatim: an explicit id no live host owns refuses `TARGET_STALE` rather than falling through to the ambient host, because falling through "would let a stale binding silently act on another window's tab."
5. **`src/main/bridge/bridge-server.ts:1663-1676`** — attachment-token direct-RPC surface 403s an explicit `tabId` ≠ the bound tab.

### Classification: **design-constraint — intended fail-closed** ✔

Multi-layer enforcement (bridge token gate → transport retarget gate → port scope gate → ambient-authority degrade) all implement one invariant: a session's authority is its bound tab plus managed/same-project tabs. Nuance the field report missed: rebind to a **same-project** tab is allowed via measured affiliation (`:3885-3890`), so authority is not "one tab forever" — it is "one project scope". Detach does not weaken this: `resolveTabAffiliation` measures the tab's capsule, not its window, so a same-project tab presented in a detached window remains rebindable and foreign-project tabs remain refused. Pin as probe invariant: `rebind_target` at another project's tab → `TARGET_MISMATCH`, journaled.

---

## Verdict table

| # | Symptom | Producer (file:line) | Classification | Action |
|---|---------|----------------------|----------------|--------|
| D1 | `CAPTURE_FRAME_STARVATION` / `TARGET_BUSY_DRAINING` | `tab-devtools-host.ts:2163-2166` (starvation refuse), `:925` (drain quarantine), `native-tab-host.ts:5865+` (lift ladder) | **design-constraint** + minor doc-gap | No src fix. Detached-window probe leg still owed (phase-05): unfocused-visible must pass; occluded/minimized typed-refuse. Optionally name owning window in refuse message. |
| D2 | baseline "unverified pending Phase 6" | `browser-control-port.ts:6943-6977` (refuse); `promoteBaseline` `:5843-5895`; `baseline-authority.js` | **tool-gap** (reachable via `baselineRef`; dead-end param + stale message) | User-facing remedy: `anti.visual.promote_baseline` → `baselineRef`. Recommend (no silent change): update refuse message to name the promote path. |
| D3 | `TARGET_STALE` on navigate | `browser-control-port.ts:1995-1997` (code mislabel); `native-tab-host.ts:10453-10477` (no post-timeout committed re-check) | **confirmed-bug** ×2 | Fix sketch above; regression test: navigate past an 8 s bound that still commits must not return TARGET_STALE. Secondary `isCurrentTarget` epoch path — keep under observation. |
| D4 | `rebind_target` rejects other-project tabs | `browser-control-port.ts:3871-3896`; `capability-transport.ts:663-687`; `tab-ambient-authority.ts:69-80` | **design-constraint** (fail-closed, intended) | Pin as probe invariant under detached topology. |

## Unresolved questions

- D1 unfocused-visible *detached* window: source predicts frames continue (window presented); live probe required to confirm — the phase-04 matrix rows "D1 unfocused-visible / occluded" are exactly this.
- D3 secondary hypothesis (lease/epoch rotation under reattach flipping `isCurrentTarget`) cannot be confirmed from source; if TARGET_STALE appears on committed navigations *without* a timeout bracket (`[NAVIGATION_TIMEOUT]` in the message), that path is the producer.

---

## D3 port-side fix

**Date**: 2026-10-01 · **Files**: `src/main/tools/browser-control-port.ts`, `test/main/browser-navigate-error-codes.test.ts` (new)

### What changed

- `src/main/tools/browser-control-port.ts:1992-2007` (`navigate()`): the failure branch no longer hard-codes `TARGET_STALE`. The recorded host cause is now thrown AS the `CapabilityError.code` — `failureCause as CapabilityErrorCode` — so `NAVIGATION_TIMEOUT`, `NAVIGATION_START_TIMEOUT`, `NAVIGATION_BLOCKED`, `LOAD_FAILED` reach the wire as their own typed codes and retry logic/reports classify correctly. `TARGET_STALE` remains only for the no-record path (`!failure` and `!timedOut`), where the host could not classify the miss — a genuine stale-target detection. The `[<cause>]` message prefix is preserved so existing log/message parsing still finds the bracketed cause.
- Causes are arbitrary wire strings, not union members — consistent with `EXECUTION_TIMEOUT_PENDING_CLEANUP` (`capability-transport.ts:1152`) and the `'X as unknown as CapabilityErrorCode'` convention (`native-tab-host.ts:3104` etc.).
- Typed errors thrown out of `host.navigateAndWait()`/`host.navigate()` (e.g. `TARGET_BUSY_DRAINING` from the CDP drain quarantine, `native-tab-host.ts` sibling work) already propagate untouched — `navigate()` has no catch/re-wrap — verified by test.
- `src/main/tools/browser-control-port.ts:9`: added `type CapabilityErrorCode` to the existing `control-plane-contracts` import.

### Scope note — residual twin site (Bug A, wait-condition path)

`browser-control-port.ts:3408-3411` (`browser.wait` `condition: 'navigation'`) contains the same blanket-`TARGET_STALE` wrap. It was left unchanged: this agent's file contract covers only `navigate()`, and the current behavior is pinned by `test/main/browser-wait-deterministic.test.ts:208-225` (`assert.strictEqual(err.code, 'TARGET_STALE')` for a `NAVIGATION_TIMEOUT` cause). If the same mislabel matters for `browser.wait`, that site needs the same fix + test update — flag for follow-up.

### Test evidence

`test/main/browser-navigate-error-codes.test.ts` (node:test, same host-mock convention as `browser-wait-deterministic.test.ts`), 5 cases:

| Case | Result |
|---|---|
| `navigateAndWait → false` + recorded `NAVIGATION_TIMEOUT` | code `NAVIGATION_TIMEOUT` ✔ |
| legacy `host.navigate → false` + recorded `LOAD_FAILED` | code `LOAD_FAILED` ✔ |
| host throws typed `CapabilityError(TARGET_BUSY_DRAINING)` | code `TARGET_BUSY_DRAINING` + exact message, unwrapped ✔ |
| `navigateAndWait → false`, no failure record | code `TARGET_STALE` ✔ |
| record with empty `cause` + `timedOut: true` | code `NAVIGATION_TIMEOUT` ✔ |

Runs (node --test on `.compiled/`): new suite 5/5 pass; `browser-wait-deterministic` 18/18; `browser-owner-target-revalidation`, `target-stale-rebind-contract`, `tab-lease-fast-rebinding` 16/16.

### Known transient blocker (sibling work, not this change)

`npm run compile` currently stops at `src/main/browser/native-tab-host.ts:8449` (`Property 'stampProjectIdForMint' does not exist on type 'NativeTabHost'`) — a half-landed edit owned by a concurrent phase-01 agent. tsc still emitted `.compiled/src/main/tools/browser-control-port.js` and the new test (verified), and all tests above ran against that emit.
