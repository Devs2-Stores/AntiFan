# 2026-09-27 — Background-tab capture: off-screen host starves, ladder learns the in-window lift

## What was broken

`anti.screenshot.full_page` (and every CDP verification capture — clip, viewport fallback,
`theme_qa_validate`) on a background tab failed with `CAPTURE_FRAME_STARVATION` while the
window was maximized and visible. Reproduced live on the running app (tab `167b9e3f…`,
phukienmaymoc.com/cart?themeid=1001514194): the pane is raised onto the off-screen capture
host, the rAF probe reads starved, the ladder has no repair for a raised pane, and the gate
refuses before dispatch. The 09-26 journal already recorded that this CDP path was "only
proven by lane, never reproduced by hand on the live app" — the first live exercise failed.

## Root cause (measured)

- The capture host is a frameless `showInactive()` BrowserWindow parked at x:-16000, y:-16000
  (`raiseViewOnCaptureHost`, `src/main/browser/native-tab-host.ts`). A fully off-screen window
  is not a surface the Windows compositor drives: no BeginFrames, rAF stalls, renderer still
  answers. Same presentation starvation the in-window occlusion causes (native-tab-host's own
  measured note: "inactive bagamuioto + mdn video"), just relocated off-screen.
- `setBackgroundThrottling(false)` is already applied by `runWithAttachedTabView` for the
  duration of the capture and does not restore frames — presentation is the lever, not
  throttling.
- Foreground capture of the same tab succeeds immediately after `tabs.activate` (verified live,
  same session): the real window's presented surface is the one frame source that works.

## What was changed

- `src/main/browser/tab-devtools-host.ts` — `ensureFramesForRaster` takes the target pane view;
  a raised pane that stays starved after the compositor invalidate is re-raised **in-window**
  via `ctx.raiseViewForCapture(view, { inWindow: true })` and re-probed before the refusal.
  The STARVATION message now lists the repair steps tried.
- `src/main/browser/native-tab-host.ts` — `raiseViewForCapture(view, opts?)`: `inWindow: true`
  skips the capture host; a pane currently parked on the host is lowered back
  (`lowerRaisedCaptureView`) and lifted with the existing `raiseViewInWindow`. The attach guard
  also admits the host-raised view. `reassertPresentedView` in the capture's finally plus the
  `runWithAttachedTabView` release restore the user's tab exactly as the host-unavailable
  fallback always has. `activeTabId` never changes.
- `test/main/tab-devtools-host.test.ts` — the raised-pane ladder test pins the new contract
  (host raise → in-window re-raise; reassert still never called for a raised pane); new
  regression: a capture-host-starved background pane recovers through the in-window lift and
  completes the capture.

## Evidence

- Live pre-fix reproduction: verbatim `CAPTURE_FRAME_STARVATION` on the running build, window
  maximized and visible, background target (exact user scenario re-run: activate another tab,
  rotate session target, full-page capture).
- Unit fail-before on the old source: both new tests fail exactly as the live defect
  (`1 !== 2` raise calls; `CAPTURE_FRAME_STARVATION` thrown).
- Pass-after: `tab-devtools-host` suite **48/48**; `npm run compile` exit 0 (emit integrity,
  MCP budget, extension, dispatch-payload checks); `npm run test:main` **1417 pass / 0 fail /
  1 skip** (1418 tests). Code review: DONE, no concerns, no critical issues.

## Open / not yet proven

- Live post-fix proof needs an app restart (the running instance still executes the old
  compiled main process): restart, then re-run a full-page capture on a background tab.
- The off-screen capture host remains host-first for the initial raise; on Windows it will
  effectively always fall through to the in-window lift after ~0.7 s of probing. If that
  latency matters, a follow-up can skip the host on win32 — not done here to keep the change
  minimal and platform-neutral.
- Separate defect observed during repro, not addressed: full-page capture on a heavy
  background page (hoplongtech home) times out at the tool layer (`EXECUTION_TIMEOUT`) before
  the gate — walk/quiescence bound exhaustion, own root cause.
