# Blank (white/black) tab pane while the page keeps running — root cause and fix

Date: 2026-10-07 · Electron in repo: 43.4.0 (Chromium 150.0.7871.224) · Platform: Windows 11 (22000)

## Conclusion

The recurring "pane goes white/black, the DOM is alive, resize or F5 heals it, it comes back later"
is an Electron bug in `webContents.setBackgroundThrottling()`, fixed upstream in
[electron#52844](https://github.com/electron/electron/pull/52844) and backported to **43.4.1**
([#52864](https://github.com/electron/electron/pull/52864)). AntiFan ships 43.4.0, one patch before
the fix, and calls `setBackgroundThrottling()` on detached (hidden) tab views on every tab switch.

Fix: upgrade Electron to 43.7.9 (latest 43.x). Also stop toggling throttling on detached views
in AntiFan. Every `invalidate()`, re-attach, and 1px-kick workaround in `native-tab-host.ts` treats a
symptom, which is why the bug keeps coming back.

## Mechanism (from source)

Electron 43.4.0 `WebContents::SetBackgroundThrottling(allowed)`
(`shell/browser/api/electron_api_web_contents.cc`):

```cpp
rwh_impl->disable_hidden_ = !background_throttling_;
...
if (rwh_impl->IsHidden()) rwh_impl->WasShown({});   // for allowed == true AND false
```

1. A tab view that is detached from the window has a hidden `RenderWidgetHostImpl`, and its
   `DelegatedFrameHost` is hidden as well: its `FrameEvictor` is *unlocked*, so the frame can be evicted.
2. `setBackgroundThrottling(x)` on that view calls `RenderWidgetHostImpl::WasShown()` directly, skipping
   the view. Now the host is "shown", but `RenderWidgetHostViewAura::visibility_` and the
   `DelegatedFrameHost` still think the view is hidden.
3. When the tab is attached again, `RenderWidgetHostViewAura::ShowImpl()` →
   `OnShowWithPageVisibility()` sees `!host()->IsHidden()` and skips `NotifyHostAndDelegateOnWasShown()`.
   Normally a Chromium `CHECK` would crash here. Electron's
   `allow_disabling_blink_scheduler_throttling_per_renderview.patch` changes that check to an `if`, so the
   desync goes through silently. `DelegatedFrameHost::WasShown()` never runs, so the on-screen frame
   stays **unlocked**.
4. As soon as other views save frames (switches, captures, other windows; AntiFan runs about 20
   WebContents), `FrameEvictionManager` evicts the on-screen frame. Then
   `DelegatedFrameHost::ContinueDelegatedFrameEviction()` → `SetShowSurface(SurfaceId(), …, gutter)`. The
   gutter is the view background (`#ffffff` in AntiFan), which is the **white pane**. The renderer
   keeps running.
5. Anything that allocates a new LocalSurfaceId repaints the pane: a size change from resizing the
   window, F5/navigation, or show-after-eviction. None of these fix the host/view desync, so the next
   eviction blanks the pane again.

The upstream fix replaces `rwh_impl->WasShown({})` with
`rwhv->ShowWithVisibility(PageVisibilityState::kHiddenButPainting)`, so host, view and frame host stay
in sync.

## Reproduction (bare Electron, no AntiFan code)

Script: `E:/tmp/wcv-blank-probe/screen-switch.js`. Two views A and B in one window. B is detached,
gets one throttling call, then is re-attached. Then 8 other views are shown and hidden to create
eviction pressure. Pixels are read from a capture of the window itself (WGC), so other windows on top
do not affect the result. G = page painted (green), W = white pane.

| Scenario | 43.4.0 (repo) | 43.7.9 |
|---|---|---|
| Control: no call while detached | shown GG → evict **GG** | GG → GG |
| `setBackgroundThrottling(true)` while detached | shown GG → evict **GW** | GG → GG |
| `setBackgroundThrottling(false)` while detached | shown GG → evict **GW** | GG → GG |
| Poisoned → plain recycle (remove + add, what `recyclePresentedLayer` does) | heals GG → next evict **GW** again | GG |
| Poisoned → bracketed recycle (see below) | heals GG → next evict **GG** | GG |

The page reports `document.visibilityState = visible` throughout, so the renderer is alive and only the
compositor embedding is lost. This matches the reported symptom.

## How AntiFan triggers it (`src/main/browser/native-tab-host.ts`)

| Site | Call | Why it creates the bad state |
|---|---|---|
| `applyTabThrottling()` (~9406), runs on every `trySwitchTab` (~9342) and split toggle (~11333) | `setBackgroundThrottling(shouldThrottle)` on **every** tab, including detached background tabs | Each pass calls `WasShown` directly on every background tab whose host is hidden |
| Background tab `did-stop-loading` (~9109) | `setBackgroundThrottling(true)` on a view that was never attached | Every tab restored at boot or opened in the background is in the bad state before the user first opens it |
| `runWithAttachedTabView` release (~6312) | restores `wasThrottled`, then detaches | Hides the host correctly, but the next `applyTabThrottling` pass puts the tab back in the bad state. Capture tooling runs this often (`capture.lift`/`capture.frameProbe` show up hundreds of times in `main.log`) |
| `recyclePresentedLayer` (~6225), `reassertPresentedView`, `resurfacePresentedView` | remove + add | Repaints once but leaves the desync in place. The foreground tab has `disable_hidden_ = true`, so `HideImpl` skips hiding the host, `ShowImpl` skips the frame-host show, and the frame stays unlocked |

## Recommended fix

### 1. Root fix: upgrade Electron to 43.7.9

- `npm i -D electron@43.7.9`. Same major version; `package.json` already allows `^43.4.0`, only the lockfile
  pins 43.4.0. The fix landed in 43.4.1, and 43.7.9 is the latest 43.x.
- Stop the live AntiFan main process before installing. `npm install` fails with EBUSY on
  `node_modules/electron/dist` while the app is running.
- Verify with the probe above against the installed binary. The result must be all-G in every row.

### 2. Defense in depth in AntiFan (keep after the upgrade)

Even with 43.7.9, `setBackgroundThrottling()` on a detached view un-hides it as `kHiddenButPainting`,
so background tabs keep painting and keep a locked frame. The throttling intent is inverted. Change it so:

- `applyTabThrottling()` only touches views that are **attached**, and skips views where
  `wc.getBackgroundThrottling() === shouldThrottle`.
- Order on a switch: before `removeChildView`, call `setBackgroundThrottling(true)` on the outgoing view,
  so the hide really hides the host and frame host. After `addChildView`, call
  `setBackgroundThrottling(false)` on the incoming view, so the show goes through the view.
- Remove the `did-stop-loading` → `setBackgroundThrottling(true)` call (~9109). The default
  `webPreferences.backgroundThrottling` is already `true` (`security-policy.ts:137`).
- Detached agent-working tabs that need `false`: apply it only while they are attached for the
  operation, which `runWithAttachedTabView` already does in the right order.

### 3. In-place recovery that works on 43.4.0

The probe shows one sequence that repairs an affected view without reloading and keeps it repaired:

```ts
const was = wc.getBackgroundThrottling();
wc.setBackgroundThrottling(true);   // while attached: disable_hidden_ off, host not hidden → no direct WasShown
contentView.removeChildView(view);  // HideImpl now hides host + DelegatedFrameHost together
contentView.addChildView(view, i);  // ShowImpl → NotifyHostAndDelegateOnWasShown → frame locked again
wc.setBackgroundThrottling(was);    // host visible → no-op on visibility
```

`recyclePresentedLayer` should use this bracket. Today's plain remove + add only hides the problem
until the next eviction.

### Implemented (2026-10-07)

- `package.json` / lockfile: Electron `^43.7.9`.
- `native-tab-host.ts`: every throttling call goes through `setWebContentsThrottling()`, which
  skips no-op calls (`getBackgroundThrottling() === allowed`). `trySwitchTab` and
  `detachUnpresentedTabViews` throttle the outgoing view *before* `removeChildView`. The
  `did-stop-loading` → `setBackgroundThrottling(true)` call on background tabs is removed.
- Switch-cycle probe (`E:/tmp/wcv-blank-probe/cycle.js`): with throttle-before-detach the detached
  tab reports `hidden` (it was `visible` with the old order), and the pane stays painted after
  eviction on both 43.4.0 and 43.7.9.
- The bracketed recycle (section 3) was not adopted: with 43.7.9 and no throttling call reaching a
  detached view, the desync it repairs cannot be created.

## Not verified

- **Black pane** (window backdrop `#060910` showing through, as currently seen in the Levents window):
  not reproduced on its own. White is the measured eviction result with a `#ffffff` view background. [INFERENCE] Black is the
  same family: a surface layer with no embedded surface and nothing painting under it. Upgrading and
  re-checking that window will confirm or rule this out.
- The live tab `9e3c909c…` could not be probed. MCP refuses it with `POLICY_DENIED` / `TARGET_MISMATCH`
  because it belongs to another project, and the user asked for no reload. The diagnosis rests on the
  matching symptoms (DOM alive, resize/F5 heals, recurs) plus the bare-Electron repro.

## Sources

- electron/electron PR #52844 (fix) and #52864 (43-x-y backport, released in 43.4.1)
- `shell/browser/api/electron_api_web_contents.cc` @ v43.4.0 and v43.7.9
- Chromium 150.0.7871.224: `content/browser/renderer_host/render_widget_host_view_aura.cc`
  (`ShowWithVisibility`, `ShowImpl`, `HideImpl`, `NotifyHostAndDelegateOnWasShown`),
  `delegated_frame_host.cc` (`WasShown`, `WasHidden`, `EmbedSurface`, `ContinueDelegatedFrameEviction`),
  `delegated_frame_host_client_aura.cc` (`DelegatedFrameHostIsVisible`, gutter colour)
- Electron patches @ v43.4.0: `disable_hidden.patch`, `allow_disabling_blink_scheduler_throttling_per_renderview.patch`
