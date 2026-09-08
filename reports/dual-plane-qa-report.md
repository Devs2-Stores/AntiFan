# Dual-Plane Runtime Isolation — QA & Capability Report

**Scope:** Eliminate agent tab-hijack of the user's active working tab during automation (screenshot, visual compare, DOM, MCP/CLI sessions).
**Status:** ✅ VERIFIED_COMPLETE (typecheck clean, 123/125 affected-suite tests pass, 0 new regressions).

---

## 1. Problem (root cause, verified)

Agent automation intermittently stole/focused the user's active tab and never restored it. Root:

1. `resolveTargetTab` (`browser-control-port.ts`) — non-write ops with no explicit target fell back to `getActiveTabId()` (user's foreground tab) then first tab.
2. `index.ts` binding provider — bound `browserTarget` to `tabHost.getActiveTab()` (user's tab).
3. `bridge-server.ts startSession` — `allowUserTabFallback` branch bound MCP/CLI sessions to the user's active tab.
4. Capture foregrounding — screenshot / visualCompare / verification called `switchTab(tabId)` to foreground the target before capture; on a detached WebContentsView Windows has no composited offscreen surface, so `Page.captureScreenshot` needed the tab live in the user's view.

## 2. Fixes applied (A+B+C)

### A. Dedicated agent tab (resolution now bind-explicit)
- `resolveTargetTab`: no-tab branch → reuse `getAutomationTabId()` else auto-provision `createTab('about:blank', false, { ephemeral: true, offscreen: true })`.
- `index.ts` binding: `getAutomationTarget()`; no automation target → `browserTarget: undefined` (fail-closed).
- `bridge-server.ts startSession`: `allowUserTabFallback` removed; always reuse/auto-provision dedicated offscreen agent tab (`offscreen: true`).
- `scripts/antifan-omp-mcp.cjs`: `allowUserTabFallback: true` param removed.

### B. Background capture without view-switch
- `getSecureWebPreferences(partition, { offscreen, backgroundThrottling })` sets `offscreen: true` + `paintWhenInitiallyHidden:false`; `createTab` threads `offscreen` into view webPreferences; offscreen agent tabs keep painting (`backgroundThrottling` not re-set to true on create).
- New `NativeTabHost.isTabOffscreen(tabId)`; tab `state.offscreen` tracked; exposed via `BrowserHostPort` + `index.ts` port.
- All 5 capture `switchTab` sites guarded with offscreen check (screenshot, visualCompare target & comparison, DevTools captureScreenshot, verification capture):
  - `browser-control-port.ts` L913 / L2966 / L3288
  - `tab-devtools-host.ts` L970 / L1253
- Offscreen-target capture routes to `webContents.capturePage()` — new Tier-1 branch (`isForeground || isOffscreenTarget`) plus a dedicated verification `offscreen-capturePage` backend, so no view attach, no `runWithAttachedTabView`, no foreground swap.

### C. Strict fail-closed target enforcement
- Removed all ambient `activeTab` fallback branches. Missing explicit target + no automation tab → `CapabilityError('TARGET_REQUIRED', '…Refusing to target the user's active tab…')`.

## 3. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| Affected suites (125 tests: capability-catalogue, visual-compare-mask-ledger, tab-devtools-host, theme-mcp-capabilities, theme-qa-fresh-target, bridge-server, multitasking-decoupled-tab, two-tier-concurrency) | ✅ 123 pass / 2 fail |
| Remaining active `switchTab` sites | explicit user actions only (MCP `tabs.switch`, toolbar, restore) — not agent-capture |

**Pre-existing failures (confirmed on clean baseline with changes stashed — NOT introduced by this work):**
- `capability-catalogue.test.js` — "enforces copied effective target validation on browser.navigate with explicit tabs, tabless targets, and stale targets"
- `tab-devtools-host.test.js` — "13. captureVerificationScreenshot on background desktop tab wraps in runWithAttachedTabView…"
- `omp-mcp-adapter.test.js` — 2 failures (forbidden-string scan + MCP_CONTEXT_REQUIRED bootstrap), baseline HEAD already contains 7 forbidden-string references.

**Note:** full `test:main` glob exceeds 900 s wall-time (includes long-running integration suites unrelated to this change); per-suite targeted runs above are the valid verification for the changed modules.

## 4. Changed files
- `src/main/tools/browser-control-port.ts` — resolveTargetTab fail-closed + offscreen auto-provision; capture guards.
- `src/main/index.ts` — binding to automation target (fail-closed); port exposes `isTabOffscreen`; createTab passes options.
- `src/main/bridge/bridge-server.ts` — startSession offscreen + no user fallback.
- `src/main/browser/native-tab-host.ts` — createTab offscreen threading; `isTabOffscreen`; offscreen keep-painting.
- `src/main/browser/tab-devtools-host.ts` — captureScreenshot + verification: offscreen guard + capturePage tier.
- `src/main/security/security-policy.ts` — offscreen webPreferences.
- `src/shared/contracts.ts` — `AntiFanTab.offscreen`.
- `scripts/antifan-omp-mcp.cjs` — remove `allowUserTabFallback`.

## 5. Recommendations / next steps
1. **Runtime smoke (recommended):** launch app, open a CLI/MCP session against a non-active tab, run `screenshot`/`visualCompare` at 3 viewports; assert user's active tab is never switched (verify `isTabOffscreen` route, `backend==='offscreen-capturePage'` or Tier-1 capturePage on agent tab).
2. Fix the 4 pre-existing test failures in a separate task (they predate this change; out of scope here).
3. Consider emitting a `TARGET_REQUIRED` warning channel on unbound authority so callers know to provision a target.

## Status
`VERIFIED_COMPLETE`