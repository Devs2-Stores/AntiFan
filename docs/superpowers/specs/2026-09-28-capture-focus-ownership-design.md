# Capture lifts and focus stay on the user plane — design

Status: decided with the user on 2026-09-28 as roadmap item S2 (Không để agent chiếm màn
hình và focus). This is the target contract; the code is cited by owning symbol and file
rather than by line, because those files move while this lands — search the symbol. The
companion specs in this roadmap are the edit-mode guard (S1,
`2026-09-28-edit-mode-guard-design.md`), bridge health reporting (S3) and run cards (S4);
nothing here re-opens what they own. The live contract this design belongs to is the
**Scope Rules** / **Keyboard And Focus** / **Surface Hierarchy** sections of
`docs/ui-architecture.md`; the amendments those sections need are spelled out below.

Date: 2026-09-28

## Intent

Agent work must never take the screen or the focus away from the person using the
window. Two failure modes were measured on 2026-09-28 in the forensic audit of the
Comnieusiba and Phukienmaymoc OMP sessions:

1. **A background capture paints over the tab the user is reading.** The frame gate's
   repair ladder (`ensureFramesForRaster`, `src/main/browser/tab-devtools-host.ts`) can
   reach the `in-window-lift` step, which calls
   `NativeTabHost.raiseViewForCapture(view, { inWindow: true })`
   (`src/main/browser/native-tab-host.ts`). `raiseViewInWindow` removes and re-adds the
   target `WebContentsView` as the topmost child of `contentView`, above
   `activeTab.view`, with `activeTabId` unchanged. It does **not** set
   `this.raisedCaptureView`, so `lowerRaisedCaptureView` cannot see it: the pane is only
   lowered as a side effect of the caller's `finally { reassertPresentedView() }` after
   `Page.captureScreenshot` returns. A raster that waits out its bound (8s viewport
   probe, up to 60s full-page) leaves the lifted pane covering the user's tab for the
   whole wait — the reported white pane over the tab being read. Today's log holds 41
   `capture.frameGate` events, 23 of which took the `in-window-lift` branch (17
   recovered). The slot is also host-global: two captures in one window race on it, and a
   `reassertPresentedView` from a different actor (a switch, a refused activation, a
   capture timeout) silently dismantles a host raise mid-flight because
   `lowerRaisedCaptureView` has no notion of an owner.
2. **Agent-plane activation steals focus unconditionally.** `switchTab` calls
   `target.view.webContents.focus()` with no distinction between a user clicking a tab
   and the agent plane activating one (`switchTab`,
   `src/main/browser/native-tab-host.ts`; agent-plane authorization is the "Owner
   decision" comment in `BrowserControlPort.switchTab`,
   `src/main/tools/browser-control-port.ts`, which permits any live tab with no approval
   gate). The agent reaches this through `browser.switch-tab` / `antifan_switch_tab` /
   `anti.browser.tabs.activate` (`registerBrowserCapabilities`,
   `src/main/tools/browser-capabilities.ts`), through the WS-RPC `antifan.switchTab`
   (`src/main/bridge/bridge-server.ts`), and through the action registry's `switchTab`
   handler (`src/main/browser/browser-action-registry.ts`) — 17 activation calls in
   today's sessions, one logged as "Activating tab to restart compositor" while the user
   was working. Two trusted-input paths in `TabAutomationHost`
   (`executeTrustedClick`, `executeTrustedHover`,
   `src/main/browser/tab-automation-host.ts`) additionally call `wc.focus()` even though
   their input is dispatched by CDP `Input.*` plus `Emulation.setFocusEmulationEnabled`,
   which does not need real DOM focus — so the real-focus call is pure theft.

The intent is not to forbid the operations — captures still need a compositor frame, and
the agent may still activate a tab when the user is not mid-gesture — it is to make every
presentation- and focus-affecting act *owned, bounded and recorded* on the user plane's
behalf.

## Decisions

1. **A capture lift is a per-window lease, not a flag.** `NativeTabHost` replaces the
   bare `raisedCaptureView` slot with a `captureLift` record `{ token, view, origin,
   liftedAtMs }` plus a FIFO wait queue, and exposes
   `acquireCaptureLift(view, opts?) → Promise<CaptureLiftLease>` on the
   `TabDevToolsContext` seam (`src/main/browser/tab-devtools-host.ts`). Both raise
   origins — `capture-host` (`raiseViewOnCaptureHost`) and `in-window`
   (`raiseViewInWindow`) — record into the same slot, so an in-window lift is finally
   visible to the lowering path that used to miss it.
2. **The lift dies in the caller's `finally`, never later.** `release(reason)` removes
   the pane from the capture host or buries an in-window-lifted pane back under the
   presented view, clears the slot, disarms the watchdog, records `capture.lift` and
   wakes the queue — and both capture call sites hold the lease across exactly the
   frame-gate-plus-raster window.
3. **One window, one lift at a time.** Concurrent raises serialize through the lease
   queue (bounded wait, `CAPTURE_LIFT_BUSY` on expiry) instead of silently kicking the
   previous occupant, which is what `raiseViewOnCaptureHost` does today when a second
   view arrives.
4. **The in-window lift stays, because the alternatives don't rasterize.** Lifting the
   pane *below* the presented view cannot work: an occluded `WebContentsView` receives
   no BeginFrame, so its compositor surface starves — that is the exact failure the
   frame gate exists to repair (`enforceZOrder`'s contract comment,
   `src/main/browser/native-tab-host.ts`). Off-screen painting on the capture host is
   the default `capture-host` origin and is already chosen first; it is insufficient
   because the off-screen host window is not a surface the Windows compositor drives —
   measured live: a pane parked on it starves while the main window is maximized and
   visible — which is precisely why the repair ladder escalates to `in-window`. The
   conservative option is therefore to keep the in-window lift, but bound it hard.
5. **The bound is asymmetric.** `Page.captureScreenshot({ fromSurface: true })` reads
   the live compositor surface at raster time, so the lift must outlive the dispatch —
   lowering after the liveness probe but before `captureScreenshot` would re-starve the
   raster and hand back the `CAPTURE_TIMEOUT` this design exists to remove. An
   invisible (`capture-host`) lift is bounded by the caller's raster deadline
   (`opts.budgetMs`, typically the CDP bound); a visible (`in-window`) lift is
   additionally capped by `IN_WINDOW_CAPTURE_LIFT_MAX_MS` (10s) — the user should never
   stare at someone else's pane for longer than the no-surface probe bound
   (`NO_SURFACE_CAPTURE_PROBE_BOUND_MS`, 8s, `tab-devtools-host.ts`) plus slack. A
   watchdog armed at lease grant force-releases the lift at `min(budgetMs,
   IN_WINDOW_CAPTURE_LIFT_MAX_MS)` for `in-window`, `budgetMs` for `capture-host`.
6. **`switchTab` gains a declared plane, and only the user plane focuses.** The
   presentation half of a switch — attach, sweep, layout, broadcast, reassert — is
   plane-neutral; the focus half is not. `webContents.focus()` runs only when
   `opts.plane === 'user'`.
7. **The plane defaults to `agent`.** Every entry point that does not declare itself
   user-owned loses the focus call and gains the recency gate — fail-closed for the
   person at the keyboard. The renderer routes, keyboard shortcuts and repair paths
   enumerate small and declare `{ plane: 'user' }` explicitly.
8. **Agent-plane activation defers to recent user input.** A per-window
   `lastUserInputAtMs` is maintained from real `input-event` traffic (keyboard +
   pointer + wheel, `webContents.on('input-event')`, not only `before-input-event`,
   which is keyboard-only). An agent-plane `trySwitchTab` into a window whose last user
   input is younger than `USER_INPUT_RECENCY_MS` (2000ms) is refused with the typed
   `ACTIVATION_DEFERRED_USER_INPUT` and `retryAfterMs`, instead of switching mid-type.
9. **Agent input must not self-attribute as user input.** The `agentInputInFlight`
   counter already marks `sendInputEvent` keystrokes (`syncWithAgentInput`,
   `sendKeyboardPress`, `src/main/browser/native-tab-host.ts`); trusted CDP
   `Input.dispatchMouseEvent` sections are wrapped by a new `withAgentInput` seam on the
   automation context so a CDP click cannot stamp `lastUserInputAtMs` and later trigger
   a bogus deferral.
10. **"Restart the compositor" is a repair, not a presentation.** The frame gate's
    ladder (`invalidate` → `reassert` → `in-window-lift`, `ensureFramesForRaster`) is
    the non-visible repair path and needs no activation. Callers that used
    `tabs.activate` to nudge a stalled presenter must instead capture (which runs the
    gate itself) or `anti.browser.reload`; the deferral error message names exactly
    that remedy.

## The invariant this design restores

The presented view belongs to the user. `enforceZOrder`
(`src/main/browser/native-tab-host.ts`) already encodes it as a z-stack — backdrop, tab
views, chrome — and `reassertPresentedView` re-asserts it after every view-stack
mutation. What the invariant lacked was *ownership*: the in-window lift mutated the
stack without registering anywhere, so neither cleanup nor a competing transaction knew
the lift existed, and the only lowerer that ever ran was a `finally` that fires after
the raster — seconds of someone else's pane on the user's screen whenever the presenter
was already sick enough to need the lift in the first place.

Under this design every exception to the invariant is a lease: named, serialized per
window, bounded by the caller's raster deadline and a hard visible cap, lowered by
`finally`, re-buried instantly by any `reassertPresentedView` (user-presents-first
semantics — a starved capture answers `CAPTURE_TIMEOUT`, the user never waits), and
lowered early the moment real user input lands on the window. The compositor facts that
motivated the lift are unchanged and cited as such; what changes is who the pane is
borrowed from and for how long.

## Architecture

### 1. The capture lift lease (`NativeTabHost`, `src/main/browser/native-tab-host.ts`)

- **State.** `private captureLift: { token: number; view: WebContentsView; origin:
  'capture-host' | 'in-window'; liftedAtMs: number } | null` replaces
  `raisedCaptureView`; `private captureLiftQueue: Array<…waiter…>` and a monotonic
  token counter live beside it. `captureHostWindow`, `ensureCaptureHostWindow` and
  `offscreenCaptureOrigin` are unchanged.
- **Acquisition.** `public async acquireCaptureLift(view: WebContentsView, opts?: {
  inWindow?: boolean; budgetMs?: number }): Promise<CaptureLiftLease>`. Same-view
  re-entry by the holder is an upgrade (e.g. `capture-host` → `in-window` when the
  repair ladder escalates): it keeps the original `liftedAtMs`, performs the re-parent
  and re-arms the watchdog for the tighter bound — never a second queue slot. A
  different view while the slot is held queues FIFO; a wait outliving
  `CAPTURE_LIFT_ACQUIRE_BOUND_MS` (30s, covering a full-page raster's 60s caller bound
  minus setup) rejects with `CapabilityError('CAPTURE_LIFT_BUSY', …)`. A destroyed,
  detached and never-attached, or `undefined` view rejects immediately with
  `CapabilityError('NO_RENDER_SURFACE', …)` instead of a silent no-op — today's
  `raiseViewForCapture` swallows all three, which is half of why a failed lift was
  indistinguishable from a fast raster.
- **The lease object.** `{ readonly view, readonly origin, readonly liftedAtMs, readonly
  released: boolean, upgradeToInWindow(opts?): boolean, release(reason): void }`.
  `release` is idempotent (second call is a no-op) and synchronous.
- **Raise internals.** `raiseViewOnCaptureHost` keeps its body but writes the slot
  (`origin: 'capture-host'`); `raiseViewInWindow` likewise writes `origin:
  'in-window'`. The old silent kick (`raiseViewOnCaptureHost` lowering a different
  occupant) is deleted — the queue replaced it.
- **Lowering splits in two.** `buryCaptureLift(reason)` — *keep the lease, bury the
  pane*: remove it from the capture host when raised there, ensure it is attached in
  the window (only when `isTemporarilyAttachedView` holds, the existing contract) and
  `enforceZOrder()` so the presented tab sits on top again. `lowerCaptureLift(reason)`
  = `buryCaptureLift` + clear slot + disarm watchdog + record + wake queue.
  `reassertPresentedView` now calls `buryCaptureLift` (was `lowerRaisedCaptureView`),
  so any actor's reassert re-asserts the user's view *without* pretending the capture
  released — the capture's own `finally` still owns the lease release, and its raster
  degrades to the typed timeout instead of corrupting a second transaction.
- **Watchdog.** Armed at grant and re-armed on upgrade: `setTimeout(() =>
  lease.release('watchdog'), min(opts.budgetMs ?? CAPTURE_LIFT_ACQUIRE_BOUND_MS,
  origin === 'in-window' ? IN_WINDOW_CAPTURE_LIFT_MAX_MS : Infinity))`. Expiry records
  `capture.lift` with `phase: 'watchdog-lowered'`. The watchdog is the only always-run
  backstop for a raster that abandons its dispatch — a wedged `captureScreenshot` can
  no longer pin a pane over the user's tab past the cap.
- **Early lower on real input.** `noteUserActivity` (component 4) calls
  `buryCaptureLift('user-input')` whenever `origin === 'in-window'`: the instant the
  user touches the window, the user's pane is back on top. The lease stays held so the
  in-flight raster fails closed rather than resurrecting the lift.
- **Telemetry.** `recordLifecycleEvent('capture.lift', { tabId, paneId?, origin, phase:
  'raised' | 'upgraded' | 'lowered' | 'watchdog-lowered', liftedMs, lowered: boolean,
  reason? })` on each transition; the view's `tabId` resolves through `tabByWebContents`.

### 2. Capture call sites (`TabDevToolsHost`, `src/main/browser/tab-devtools-host.ts`)

- **`captureVerificationScreenshot`** — `shouldRaiseForRaster` becomes
  `const liftLease = await this.ctx.acquireCaptureLift!(targetPaneView, {
  budgetMs: cdpBoundMs })`, ordered *after* `cdpBoundMs` is computed (the lease needs
  the real deadline) and replacing both `raiseViewForCapture` calls. The double-rAF
  warm-up stays. The `finally` calls `liftLease.release('raster-finished')` before
  `reassertPresentedView()` — release is what guarantees the pane is buried even when
  the raster threw.
- **`ensureFramesForRaster`** — its signature changes from `(…, raisedForCapture,
  targetPaneView)` to `(…, liftLease, targetPaneView)`. The `in-window-lift` repair
  step becomes `liftLease?.upgradeToInWindow({ budgetMs: <remaining raster bound> })`
  and is skipped when no lease is held (a foreground target re-presents through
  `reassertPresentedView` exactly as today). Every `capture.frameGate` row gains
  `liftedMs` (now − `liftLease.liftedAtMs`, when a lease exists) and `lowered`
  (`liftLease?.released ?? false`) so the journal row that announces the repair also
  says how long the pane was already borrowed.
- **`captureScreenshot`** (the legacy viewport path, `NATIVE_VIEWPORT_RASTER_BOUND_MS`)
  — same acquisition, `budgetMs` set to its 4s CDP bound, same `finally` release.
- **Context contract.** `TabDevToolsContext` drops `raiseViewForCapture` for
  `acquireCaptureLift` and gains optional `captureLiftState?: () => { view: unknown;
  origin: string; liftedAtMs: number } | null` for diagnostics. No caller keeps the old
  function — this is a clean cutover, not an overload.

### 3. Typed tab switching and the focus rule (`NativeTabHost`)

- **New primary method.** `public trySwitchTab(tabId: string, opts?: SwitchTabOptions):
  SwitchTabResult` where `SwitchTabOptions = { plane?: 'user' | 'agent' }` (default
  `'agent'`) and
  `SwitchTabResult = { ok: true; tabId } | { ok: false; tabId; reason:
  'TARGET_MISSING' | 'TARGET_NOT_ACTIVATABLE' | 'ACTIVATION_DEFERRED_USER_INPUT';
  retryAfterMs?: number }`. The existing `switchTab(tabId)` — today
  `public switchTab(tabId: string): boolean` in `src/main/browser/native-tab-host.ts` — gains
  that same `opts?: SwitchTabOptions` and keeps its boolean signature as a thin wrapper
  (`trySwitchTab(...).ok`) for the interfaces that cannot carry a reason — nothing else calls
  the boolean form directly after this lands.
- **Focus.** The `target.view.webContents.focus()` inside the `invalidateFocus` step
  runs only when `opts.plane === 'user'`. `invalidate()` still runs for every plane —
  the switched view needs a fresh frame even when the agent asked for the switch.
- **Refusals.** `TARGET_MISSING` for an unknown target, and `TARGET_NOT_ACTIVATABLE` for
  `offscreen`/`ephemeral` records. Only the second reasserts: the current offscreen/ephemeral
  branch calls `this.reassertPresentedView()` before answering, because an earlier transaction
  may have taken the presented view away, and the spec keeps that. `TARGET_MISSING` answers
  without reasserting: the call attached nothing, focused nothing and touched no view — today
  `if (!target) return false;` returns before any presentation work, and there is no view to
  restore. (A destroyed-but-known target is not this refusal: the existing path rebuilds its
  view rather than refusing, and that stays.) An agent-plane
  request into a window with `userInputRecentlySeen()` true answers
  `ACTIVATION_DEFERRED_USER_INPUT` with `retryAfterMs = USER_INPUT_RECENCY_MS -
  (Date.now() - lastUserInputAtMs)` and records
  `recordLifecycleEvent('tabhost.agentSwitchDeferred', { tabId, retryAfterMs })`. The
  window's `activeTabId` is untouched on every refusal.
- **Caller audit (exhaustive).** `{ plane: 'user' }`: the `SWITCH_TAB` chrome route in
  `CHROME_ROUTES`; the Ctrl+Tab handler inside `setupGlobalShortcutsOnView`;
  `selectSearchResultTab`; `createTab`'s `activate && !isAgentTab` path;
  `restoreSurvivingLayout`; the post-close fallback and `restoreTabs` re-presentation
  calls (these present a tab *to* the user — focus is correct). `{ plane: 'agent' }`:
  `requireActivatedTab` via a new optional `host.trySwitchTab` (with boolean fallback
  for harnesses that only implement `switchTab`), the WS-RPC `antifan.switchTab` case
  and the action registry's `switchTab` handler — both unconditionally agent plane.
  `antifan.openTab`'s `createTab` gains a `plane` field on its options object, set to
  `'agent'` for agent callers, so an agent-requested activate rides the gate too. The
  `switchTab` wiring inside `getDevToolsHost` declares `'user'` explicitly — a capture
  never calls it, and declaring keeps the seam unambiguous.

### 4. User-activity tracking (`NativeTabHost`)

- **`noteUserActivity(inputType)`** stamps `lastUserInputAtMs = Date.now()` only for
  deliberate input types (`USER_ACTIVITY_INPUT_TYPES`: `keyDown`, `char`, `mouseDown`,
  `pointerDown`, `mouseWheel`, `touchStart`, `contextMenu`), and only while
  `agentInputInFlight === 0` — the same attribution guard the preemption path uses.
  Cursor motion (`mouseMove`, `pointerMove`, `mouseEnter/Leave`) deliberately does not
  stamp: the user gliding the mouse to look at the lifted pane should not defer
  anything.
- **Coverage.** A `trackUserActivityOnView(wc)` helper attaches `wc.on('input-event',
  (_e, input) => this.noteUserActivity(input.type))`; it is wired into
  `setupTabWebContentsEvents` for every tab view (desktop and mobile), and once for
  `shell.toolbarView` and `shell.sidebarView` at construction — the sidebar is the
  terminal surface, and typing in it must count. Terminal *popout* windows stay out of
  scope: their input belongs to a different `BrowserWindow`, and activation is a
  per-window notion.
- **Guard completeness.** `NativeTabHost.withAgentInput<T>(action)` is the async twin
  of `syncWithAgentInput` — it holds `agentInputInFlight` incremented across the
  awaited action, not just the synchronous slice. `TabAutomationHost`'s context gains
  `withAgentInput` (wired to it in `getAutomationHost`), and the trusted click/hover
  CDP dispatch sections run inside it so `Input.dispatchMouseEvent` cannot surface as
  a `mouseDown` on the clock.
- **Reader.** `userInputRecentlySeen(): boolean` = `lastUserInputAtMs > 0 &&
  Date.now() - lastUserInputAtMs < USER_INPUT_RECENCY_MS`.

### 5. Activation deferral at the capability boundary

- **`requireActivatedTab`** (`src/main/tools/browser-control-port.ts`) prefers
  `host.trySwitchTab` and maps the reason: `ACTIVATION_DEFERRED_USER_INPUT` →
  `CapabilityError('ACTIVATION_DEFERRED_USER_INPUT', '…user is typing; activation is
  presentation, not compositor repair — capture or anti.browser.reload the target
  instead, or retry after retryAfterMs', { tabId, retryAfterMs })`;
  `TARGET_NOT_ACTIVATABLE` → the existing typed refusal (candidates list preserved);
  `TARGET_MISSING` → `TARGET_STALE`. A host that only implements `switchTab` keeps the
  boolean path — no harness breaks.
- **New code.** `'ACTIVATION_DEFERRED_USER_INPUT'` joins `CapabilityErrorCode`
  (`src/shared/control-plane-contracts.ts`). `'CAPTURE_LIFT_BUSY'` joins it too; both
  are typed refusals, never thrown across the PTY or pty-write boundary — the bridge's
  `respond` carries them as error payloads.
- **No name filtering anywhere.** MCP callers reach this through generic transports —
  a `write` whose `input.path` is `xd://mcp__antifan_browser_*` is indistinguishable
  from file I/O by name — so the gate lives in the host, below every caller. There is
  no tool-name blocklist to bypass.

### 6. Focus surfaces beyond switching (`TabAutomationHost`)

- The `wc.focus()` calls in `executeTrustedClick` and `executeTrustedHover` are
  deleted. Both paths already run `Emulation.setFocusEmulationEnabled({ enabled: true
  })` and dispatch `Input.dispatchMouseEvent` through the debugger — neither requires
  real DOM focus, and the real focus call moves the window's DOM focus off whatever
  chrome surface the user was typing into. Focus emulation remains the agent's focus
  mechanism, wrapped in `withAgentInput` per component 4.

### 7. What does not change

- Offscreen (OSR) agent tabs never present, never lift and never focus: their capture
  path is untouched.
- `Emulation.setFocusEmulationEnabled`, `viewportGate.preemptActiveAgent`, and the
  existing `before-input-event` keyboard handler are untouched — `input-event` rides
  alongside, it does not replace the shortcut wiring.
- S1's edit-mode modes, S3's bridge-health surface and S4's run-card cancel/steer
  semantics are out of scope by ownership; `switchTab` gains no mode awareness.

## Error handling

| Condition | Behaviour |
|---|---|
| `acquireCaptureLift` on a destroyed, detached-never-attached or absent view | `CapabilityError('NO_RENDER_SURFACE')`; nothing mutates — no silent no-op raise. |
| Lift slot held by another view, wait exceeds `CAPTURE_LIFT_ACQUIRE_BOUND_MS` | Rejects `CAPTURE_LIFT_BUSY`; the queued waiter is removed and the holder is undisturbed — a capture waits on the window's one lift, it never steals it. |
| Lease expires (`watchdog`) while a raster is in flight | `release('watchdog')` buries the pane, clears the slot, wakes the queue and records `capture.lift` `phase:'watchdog-lowered'`; the raster fails `CAPTURE_TIMEOUT` — a typed error, never a white pane. |
| `reassertPresentedView` while a lift is held | `buryCaptureLift` re-asserts the user's view on top; the lease stays held so the capture's `finally` still owns the release and the raster degrades bounded. |
| Real user input during an `in-window` lift | `buryCaptureLift('user-input')` immediately — the user gets the pane back mid-raster; the capture fails closed. |
| Agent-plane `trySwitchTab` while `userInputRecentlySeen()` | `{ ok: false, reason: 'ACTIVATION_DEFERRED_USER_INPUT', retryAfterMs }`; no attach, no focus, `activeTabId` untouched, `tabhost.agentSwitchDeferred` journaled. |
| Agent-plane `trySwitchTab` to an offscreen/ephemeral tab | `TARGET_NOT_ACTIVATABLE` with the presented view reasserted — the window is never left empty by a refused switch. |
| Agent-plane `trySwitchTab` to an unknown target | `TARGET_MISSING`; no attach, no focus, no reassert — the refusal mutates nothing, because a call that never found a target cannot have taken the presented view away. |
| `switchTab` boolean wrapper on a refusal | Returns `false`; the reason is only available through `trySwitchTab` — callers that must name why migrate to it. |
| Trusted input without focus emulation support | Unchanged: `setFocusEmulationEnabled` failure is already caught; only the `wc.focus()` theft is removed. |
| `captureHostWindow` refuses creation | Unchanged: `ensureCaptureHostWindow` answers `null`, the lease grants `origin:'in-window'` — now recorded in the slot and bounded by `IN_WINDOW_CAPTURE_LIFT_MAX_MS` instead of orphaned. |
| `capture.lift` journal write fails | `recordLifecycleEvent` already swallows; a missing row never fails a capture. |

## Testing strategy

The presented-view lane is `test/unit/native-tab-host-presented-view.test.ts`
(`createPresentedHost` doubles build the window's `contentView` for real), the port
refusal lane is `test/main/browser-surface-geometry.test.ts`, and the offscreen
non-switch lane is `test/main/phase-02-agent-plane-authority.test.ts`. Each case below
catches a real consumer-visible bug; none asserts source text.

- **Lift asymmetry** — rewrite of the existing `raiseViewForCapture` case: inside
  `runWithAttachedTabView` + a held lease the pane sits above the presented view
  (`origin:'in-window'`, `captureLift` populated), and on `release` the pane is buried
  below the presented view while the attach count is still held, `captureLift === null`,
  and `capture.lift` carries `liftedMs`/`lowered:true`.
- **Cross-tab concurrent capture** — `acquireCaptureLift` on a second tab's view while
  the first lease is held does not lift it (the first view stays topmost, the second
  waits); releasing the first grants the second; a waiter past
  `CAPTURE_LIFT_ACQUIRE_BOUND_MS` rejects `CAPTURE_LIFT_BUSY`.
- **Raster timeout still lowers** — hold a lease whose `budgetMs` is exceeded via fake
  timers; the watchdog releases (`capture.lift` `phase:'watchdog-lowered'`), the pane
  is buried, and the waiter's queued acquire resolves afterwards.
- **Agent switch no focus** — `switchTab(id, { plane: 'agent' })` asserts zero
  `webContents.focus()` calls on the target; `switchTab(id, { plane: 'user' })`
  asserts exactly one (plus invalidate on both paths). Same file, one spy per case.
- **Activation deferral while typing** — drive `noteUserActivity('keyDown')` (or
  stamp `lastUserInputAtMs` directly), then `trySwitchTab(bg, { plane:'agent' })`
  returns `ACTIVATION_DEFERRED_USER_INPUT` with a positive `retryAfterMs` and no
  children mutation; after the recency window, the same call returns `ok:true`.
- **User-plane immunity** — a `plane:'user'` switch one millisecond after stamped
  input succeeds and focuses; the gate reads the plane, not the clock alone.
- **Port mapping** — `browser-surface-geometry.test.ts` gains the case: a host double
  whose `trySwitchTab` answers the deferred reason surfaces
  `CapabilityError.ACTIVATION_DEFERRED_USER_INPUT` with `details.retryAfterMs` — the
  agent-visible contract.
- **Possibly-existing lanes to keep green** — `capture-lane-host-mirror.test.ts` (host
  mirror contract), `capture-timeout-diagnosis.test.ts`, `action-registry.test.ts`
  (its `switchTab` double keeps `boolean`), `ipc-audit.test.ts` (Ctrl+Tab pinning —
  it asserts `this.switchTab(` text, which survives).

## Acceptance criteria

Observable, not structural:

1. `main.log` gains `capture.lift` rows for every raise — `phase:'raised'` |
   `'upgraded'` | `'lowered'` | `'watchdog-lowered'`, with `tabId`, `origin`,
   `liftedMs` and `lowered` — and every `capture.frameGate` row for a raised pane
   carries `liftedMs` + `lowered`. Today's 41-row frame-gate stream becomes
   interpretable: a lift that never lowered has no terminal row.
2. Reproducing the measured incident — two tabs capturing plus one user reading —
   never leaves a lifted pane over the presented tab past `IN_WINDOW_CAPTURE_LIFT_MAX_MS`,
   and a concurrent reassert buries rather than orphans the lift.
3. An agent-plane `tabs.activate` issued while the user is typing in the sidebar
   terminal is refused with `ACTIVATION_DEFERRED_USER_INPUT`; the agent sees
   `retryAfterMs`; the visible tab and DOM focus do not move. Outside the recency
   window the activation still switches — but never focuses.
4. `npm run test:main` plus the unit lane are green, including the rewritten
   presented-view cases.

## Risks & rollback

- **Fewer successful captures during presenter sickness.** A lift that used to hang
  the raster now fails `CAPTURE_TIMEOUT` once buried or watchdog-lowered. That is the
  intended trade — a typed error the agent can read beats a frozen screen the user
  cannot. Mitigation already exists: `anti.browser.reload` and the frame gate's
  non-visible repair steps.
- **Agent flows that assumed activation focuses.** None should — activation's contract
  is presentation. If a flow regresses, the symptom is a missing focus call, not a
  wrong DOM, and the repair is to drive the page through CDP input, not to restore
  `wc.focus()`.
- **`input-event` on shell chrome is new surface area.** One listener per view, one
  timestamp write; the event is delivered on the main loop anyway. The allowlist keeps
  move-noise from stamping.
- **Rollback order.** Revert the renderer-free layers: (1) `TabAutomationHost`
  `wc.focus()` deletions and `withAgentInput` wiring; (2) `requireActivatedTab`'s
  `trySwitchTab` preference (the boolean path returns); (3) `trySwitchTab`/`plane`/
  `noteUserActivity` (the focus call becomes unconditional again); (4) the lease —
  restoring `raiseViewForCapture`/`lowerRaisedCaptureView` — last, because every
  capture caller sits on it. Step 4 alone restores the measured white-pane bug; it is
  the step to take only while a replacement is prepared. The journal rows and error
  codes are additive — an older build ignores them.

## Owning sources

| Question | Owner |
|---|---|
| What a capture may lift, for how long, and who lowers it | `acquireCaptureLift` / `CaptureLiftLease` / `buryCaptureLift` / `lowerCaptureLift`, `src/main/browser/native-tab-host.ts` |
| When a raster needs a frame, and which repair rung runs | `ensureFramesForRaster`, `src/main/browser/tab-devtools-host.ts` |
| The presented view's place in the stack | `enforceZOrder` / `reassertPresentedView`, `src/main/browser/native-tab-host.ts` |
| Who may switch a tab and whether it focuses | `trySwitchTab` + `SwitchTabResult`, `src/main/browser/native-tab-host.ts`; agent-plane authorization in `BrowserControlPort.switchTab`, `src/main/tools/browser-control-port.ts` |
| What counts as the user being present | `noteUserActivity` / `userInputRecentlySeen` / `USER_ACTIVITY_INPUT_TYPES` / `agentInputInFlight` + `withAgentInput`, `src/main/browser/native-tab-host.ts` |
| Agent-visible refusal codes | `CapabilityErrorCode` + `CapabilityError`, `src/shared/control-plane-contracts.ts`; `requireActivatedTab`, `src/main/tools/browser-control-port.ts` |
| The journal rows acceptance reads | `recordLifecycleEvent`, `src/main/diagnostics/main-lifecycle-log.ts` (`capture.lift`, `capture.frameGate`, `tabhost.agentSwitchDeferred`) |
| Trusted input's focus mechanism | `executeTrustedClick` / `executeTrustedHover`, `src/main/browser/tab-automation-host.ts` |
| User-visible contract wording | `docs/ui-architecture.md`, Surface Hierarchy (capture-host paragraph gains the bounded-lease sentence) and Keyboard And Focus (new bullet: agent-plane work never moves real focus; deferral vocabulary named) |

## Files touched

| File | Change |
|---|---|
| `src/main/browser/native-tab-host.ts` | `captureLift`/`captureLiftQueue` replace `raisedCaptureView`; `acquireCaptureLift`, `buryCaptureLift`, `lowerCaptureLift`; `raiseViewOnCaptureHost`/`raiseViewInWindow` record into the slot; `trySwitchTab` + `SwitchTabResult` + plane-aware `switchTab`; `noteUserActivity`/`trackUserActivityOnView`/`userInputRecentlySeen`/`USER_ACTIVITY_INPUT_TYPES`; `withAgentInput`; `lastUserInputAtMs`; `{plane:'user'}` at every user caller; `{plane:'agent'}` reachable via `createTab` options. |
| `src/main/browser/tab-devtools-host.ts` | `TabDevToolsContext`: `acquireCaptureLift` replaces `raiseViewForCapture`, optional `captureLiftState`; `captureVerificationScreenshot` and `captureScreenshot` hold the lease across the raster; `ensureFramesForRaster` takes the lease and emits `liftedMs`/`lowered`. |
| `src/main/browser/tab-automation-host.ts` | Delete `wc.focus()` in `executeTrustedClick`/`executeTrustedHover`; wrap trusted dispatch sections in `ctx.withAgentInput`. |
| `src/main/tools/browser-control-port.ts` | `requireActivatedTab` prefers `host.trySwitchTab` and maps reasons; `switchTab`'s agent-plane path unchanged semantically (no approval gate added). |
| `src/main/browser/browser-action-registry.ts` | `switchTab` handler passes `plane:'agent'`. |
| `src/main/bridge/bridge-server.ts` | `antifan.switchTab`/`switchTab` case passes `plane:'agent'`; `antifan.openTab` forwards `plane:'agent'` for agent callers. |
| `src/main/index.ts` | `switchTab` host-adapter lambda forwards `opts`. |
| `src/shared/control-plane-contracts.ts` | `CapabilityErrorCode` gains `ACTIVATION_DEFERRED_USER_INPUT` and `CAPTURE_LIFT_BUSY`. |
| `docs/ui-architecture.md` | Surface Hierarchy: the capture-host sentence gains "a capture lift is a bounded, serialized per-window lease; an in-window lift caps at IN_WINDOW_CAPTURE_LIFT_MAX_MS and buries on real user input." Keyboard And Focus gains: "Agent-plane work never moves real DOM focus — it uses focus emulation — and agent-plane tab activation defers to ACTIVATION_DEFERRED_USER_INPUT while recent user input (<2000ms) is in the window." |
| `test/unit/native-tab-host-presented-view.test.ts` | Rewrite the raise case into the lease contract; add lift asymmetry, cross-tab serialization, watchdog-lower, agent-no-focus, deferral-while-typing, user-plane-focus cases. |
| `test/main/browser-surface-geometry.test.ts` | Add the deferred-reason → `CapabilityError` mapping case. |
