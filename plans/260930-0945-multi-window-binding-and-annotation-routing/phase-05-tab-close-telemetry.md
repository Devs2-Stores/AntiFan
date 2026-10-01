---
title: "Phase 5: Tab-close telemetry"
status: done
---

# Phase 5: Tab-close telemetry

## Overview

`NativeTabHost.closeTab` (native-tab-host.ts:8841) emits ZERO lifecycle events — the only
emission is `recordBenchmark`. One path bypasses it entirely: `disposeChildViewContents`
(:14574) clears `this.tabs` on host/window dispose. The live incident's tab vanished with
no attributable row. `recordLifecycleEvent` (main-lifecycle-log.ts:119) is the
established synchronous appendFileSync journal (`<runtime>/logs/main.log`,
`ANTIFAN_RUNTIME_DIR`-overridable, 2MB rotation, never throws) — already imported in
native-tab-host.ts:11.

New event `tabhost.tabClosed` fits the dotted convention (`tabhost.agentTabReaped`,
`tabhost.presentedViewReattached`, `capture.*`, `window-close.*`).

## Requirements

- [ ] `closeTab(tabId: string, source?: string): boolean`; emit immediately after
      `this.tabs.delete(tabId)` (:8953) while `target` is in scope — snapshot fields
      BEFORE any re-assert/refill tail (kongming: payload snapshot ordering):
      `{tabId, source, ephemeral, offscreen, capsuleId: target.state.capsuleId,
      projectId: target.projectId, urlOrigin, lastActiveAt, agentActivityAt}`.
      `urlOrigin` = `new URL(url).origin` for http/https only (origin-only convention
      matches diagnostics `stripUrlQuery`; full URL not needed — capsule+project+tabId
      carry attribution).
- [ ] `closeSource = source ?? (authorizedByAttempt ? 'close-attempt' : 'unspecified')`
      (`authorizedByAttempt` already computed at :8855).
- [ ] Source taxonomy (kongming — enumerate all ~15 sites):
      `user-toolbar` (:2364 IPC), `user-close-other`/`user-close-right` (:9974/:9985),
      `user-menu` (app-menu.ts:347), `bridge-rpc` (bridge-server.ts:2746), `mcp-tool`
      (browser-action-registry.ts:230, browser-control-port.ts:3887),
      `agent-adopt-failed` (browser-control-port.ts:3711), `attachment-dispose` /
      `attachment-dispose-child` (index.ts:3253/:3267), `view-close`/`view-destroyed`
      (:8126/:8133), `agent-open-adopt-failed` (:8192), `agent-reap` (:9528),
      `close-attempt` (via `authorizedByAttempt`), `host-dispose` (dispose bypass).
- [ ] `disposeChildViewContents` (:14574): emit `tabhost.tabClosed` with
      `source:'host-dispose'` per tab inside the clearing loop — do NOT route through
      full `closeTab` (touches shell/views mid-dispose).
- [ ] `BrowserHostPort.closeTab` signature (browser-control-port.ts:136) gets optional
      `source`; port passes 'mcp-tool'/'agent-adopt-failed' at its two sites.
      index.ts:3337 adapter MUST forward it — current shape
      `closeTab: (tabId) => hostForTabOrBootstrap(tabId).closeTab(tabId)` silently drops
      the arg; change to `(tabId, source) => …closeTab(tabId, source)` — a modify site.
- [ ] Taxonomy addition: `finalizeClosedPage` (native-tab-host.ts:9280, post-closePage
      reconcile) → 'view-destroyed' or 'close-attempt' via the `authorizedByAttempt`
      fallback.

## Related Code Files

- Modify: `src/main/browser/native-tab-host.ts` (:8841-8970 closeTab, :14574 dispose,
  ~10 internal call sites)
- Modify: `src/main/tools/browser-control-port.ts` (:136 signature, :3887, :3711)
- Modify: `src/main/app-menu.ts` (:347), `src/main/browser/browser-action-registry.ts`
  (:230), `src/main/bridge/bridge-server.ts` (:2746)
- Modify: `src/main/index.ts` (:3253, :3267 call sites AND :3337 adapter — forwards `source`)
- Read: `src/main/diagnostics/main-lifecycle-log.ts` (:36-135)

## Test Coverage

- New unit test mirroring `test/unit/native-tab-host-presented-view.test.ts:24-26` (set
  `ANTIFAN_RUNTIME_DIR` to mkdtemp BEFORE first event — journal binds real dir otherwise):
  assert `{event:'tabhost.tabClosed', source:'user-toolbar', capsuleId, projectId,
  offscreen:true}`.
- Extend `native-tab-host-close-disposal.test.ts` for `close-attempt` source and the
  `host-dispose` emit.
- `native-tab-host-agent-tab-reap.test.ts`: wrap real closeTab (pattern :97-101) to assert
  `agent-reap` — the suite stubs closeTab wholesale at :26-29.

## Success Criteria

Every removal path — user, MCP, bridge, adopt-fail, attachment dispose, wc close/destroy,
reap sweep, project/window close, host dispose — produces exactly one `tabhost.tabClosed`
row carrying source + capsule + project attribution; double-emit impossible (second
closeTab no-ops on missing record).

## Risks / Rollback

- `recordLifecycleEvent` swallows all errors — partially-constructed test hosts are safe.
- closeTab can synthesize a refill tab (:8963) — emit before `broadcastState`/
  `reassertPresentedView` tail keeps ts ordering honest.
- Revert = remove the emit line + optional params; additive.
