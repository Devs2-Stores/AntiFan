# 2026-09-26 — Red-lane repair: anchor self-heal layering, PTY teardown EPIPE, wall-clock fixtures

## What was broken

`npm run test` was red in both lanes. Verified counts on the same tree:

- `test:fast` — 1410 tests / **5 fail**: `open-tab-anchor-liveness` (dead-anchor call not refused), `goal-runner` ×2 (supervisor never killed a stalled runner under load), `mcp-proxy-emitter` P6 (rotation ring > 5 s settle), plus a load-sensitive straggler.
- `test:main` — 1403 tests / **fail set**: `bridge-attachment-dispatch` (open-tab after the bound tab closed returned `success:false`), `resource-stability` (`write EPIPE` surfacing at `await closeSession`), `cli-agent-launcher` (`Attachment ... has expired`), `bridge-pairing-queue-concurrency` (queue warm-up by wall-clock budget).

## Root causes (measured, not inferred)

1. **Layer confusion in the dead-anchor path.** `openTab` at port level refused a dead anchor with `TARGET_STALE` — the committed contract, exercised by `open-tab-anchor-liveness`. But the dispatch self-heal never removed the dead `browserTarget` before calling it, so `anti.browser.tabs.create` on a session whose tab was closed hit the refusal instead of creating a tab. The first fix attempt removed the port's refusal — breaking the unit contract. The two tests literally disagree about what `openTab` does with a dead anchor; they can only both be satisfied if the *transport* self-heals (clears `browserTarget`) and the *port* keeps its refusal.

2. **EPIPE surfaced on the wrong emitter.** `teardownSessionPty` silenced `'error'` on the pty object but destroyed `_inSocket`/`_outSocket`/`_socket` while writes could still be queued. A queued write whose peer closed first surfaces as an async `EPIPE` on the **socket**, not the pty — unhandled, it was attributed to whatever test was awaiting at that moment (`closeSession` in `resource-stability`).

3. **Wall-clock fixtures in a ~1400-file parallel lane.** `cli-agent-launcher` created a session with `ttlMs: 50` — the lane's own setup latency spent the window before the first renewal. `mcp-proxy-emitter` P6 relied on a 5 s settle. `bridge-pairing-queue-concurrency` waited for the constructor refill with a `waitFor` on wall-clock budget even though the queue only mints a code after its file exists.

## What was changed

- `src/main/tools/capability-transport.ts` — in the heal block, when the bound tab is dead and no failover exists, an `open-tab` intent is dispatched with `browserTarget: undefined`; the new tab becomes the session's target via the unchanged post-dispatch rotation (`updateAttachmentTab`). The `isOpenTab` predicate moved earlier for reuse; no other change.
- `src/main/browser/terminal-manager.ts` — before destroying the agent sockets in `teardownSessionPty`, attach a no-op `'error'` listener to `_inSocket`, `_outSocket`, and `_socket` (typed facade, no `as any` added beyond the pre-existing pattern).
- `src/main/browser/native-tab-host.ts` — release only re-asserts the presented view when the release actually changed the tree (`attachedByHelper || !isActiveView`); guard `typeof WebContentsView === 'function'` before `instanceof` so the headless double's path-string never throws.
- Test-harness fixes only widen/await, never weaken: `bridge-pairing-queue-concurrency` awaits the public `replenishPairingQueue()`; `cli-agent-launcher` uses `ttlMs: 30000` + `extensionMs: 60000` (renewal restarts as `now + extensionMs`, so the extension must exceed the TTL to prove advance); `mcp-proxy-emitter` uses a named `ROTATION_SETTLE_BUDGET_MS = 30000` for its settle barriers.
- Reverted the earlier over-reach in `browser-control-port.ts` (`git diff` now empty) — the port contract was correct and the transport was where the recovery belonged.

## Evidence

- `npx tsc -p ./` exit 0.
- `node --test` on `bridge-attachment-dispatch` → **8/8** (was 3/3 failing before); `open-tab-anchor-liveness` → **4/4**; `cli-agent-launcher` → **13/13**.
- `npm run test:fast` → **1404 pass / 0 fail / 6 skip**; `npm run test:main` → **1401 pass / 0 fail / 2 skip**. Prior run: the same tree failed at `resource-stability` (EPIPE), `cli-agent-launcher`, `bridge-attachment-dispatch`.
- `git diff --stat -- src test` — 3 source files (+52 net), 6 test files; `browser-control-port.ts` back to HEAD.

## Open / not yet proven

- `goal-runner` supervisor-kill tests passed both lane runs, but their mechanism under load was not diagnosed; if they flake again the fix is likely the 20 s `waitFor` vs `spawnNode`+`killTree` on a busy box.
- `native-tab-host` viewport/pane changes are proven by unit test and by the live Electron smoke below; the `WebContentsView` guard itself is headless-only (its live path is the same `typeof` check that never trips in a real Electron).
- `browser-control-port.ts` stays at HEAD — the dead-anchor contract is *port-level refusal* and *transport-level self-heal*; anyone touching `openTab` must keep both tests green.

## Review follow-up (same day, post-commit review)

The code-review pass over `71bb54ec^..00fc50c4` confirmed all four acceptance
criteria and flagged two concerns; both were addressed:

- **Misleading commit message on the frame-gate commit** — the message
  described "capture a background tab through CDP when not attached" while the
  diff implements the compositor frame-liveness gate (`ensureFramesForRaster`,
  `CAPTURE_FRAME_STARVATION`) + lifecycle logging. Reworded locally before any
  push (history was still unpushed: `main` ahead of `origin/main` by 8).
- **Repair-ladder ordering hazard** — the gate's re-present step called
  `reassertPresentedView` even for a pane that `raiseViewForCapture` had just
  moved onto the capture host window. Reassert's first act is
  `lowerRaisedCaptureView`, so the "repair" dismantled the fresh surface and
  moved the pane back under the presented tab where it cannot raster. Fix:
  `ensureFramesForRaster` now takes `raisedForCapture` and a raised pane stops
  the ladder at the compositor invalidate; a still-starved raised pane is
  refused with `CAPTURE_FRAME_STARVATION` exactly as before. Regression test
  `never lowers a pane raised for capture` — mutation-proved: replacing the
  guard with `if (true)` in the compiled output fails exactly the
  `reassertPresentedView` assertion.

Live verification also closed one open item: `node scripts/run-electron.cjs
test/e2e/site-mute-smoke.cjs` — real Electron, temp profile, multi-tab/split,
navigation — **passed** (exit 0, "[SMOKE-MUTE] All site-mute smoke checks
passed successfully"), exercising the pane attach/release path that the
re-assert gate changed.
