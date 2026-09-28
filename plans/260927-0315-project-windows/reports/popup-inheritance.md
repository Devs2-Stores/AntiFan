# Native popup inheritance — verification report

Scope: what a `window.open` child inherits from the tab that opened it, and what happens to that
child when the opener or the adoption is not there any more. Phase-02 step 7 ("parent closure
during child creation") and matrix `R4b` / `R11` / e2e row
`window.native-popup-inherits-window-affiliation`.

## The rule

Chromium answers a page's `window.open` synchronously and blocks the requesting page inside that
call, so the popup tab cannot be built there: the handler records the request and creates the tab
one turn later. The opener's identity is therefore read **before** the deferral, and the child is
created with the opener's capsule **and** its partition **and** its user agent mode — a child in a
different partition reads a cookie jar its opener cannot see, and one in a different mode presents
a different browser than the page that opened it. Two boundaries follow from the deferral: an
opener that is gone when the deferred creation runs produces no child at all, and a child the
adoption refuses is closed again, so neither leaves an orphan tab.

## What changed

| File | Change |
|---|---|
| `src/main/browser/native-tab-host.ts` | The `setWindowOpenHandler` callback captures the opener tab's `capsuleId`, `partition` and `userAgentMode` before `setImmediate`, re-checks `hasExactTab(opener)` inside the deferred turn, passes all three to `createTab`, and closes the new child when `adoptChildTab` refuses it. |

Everything else on the popup path is unchanged: the native window is still denied, and the popup is
still a tab of the opener's own window.

## Evidence

| Check | Command | Result |
|---|---|---|
| Popup suite | `node --test .compiled/test/main/native-popup-inheritance.test.js` | 3/3 — inheritance, dead opener, refused adoption |
| Popup suite, before the fix | same file against the pre-fix handler body | 3/3 **fail** |
| Main lane | `npm run test:main` | 1839 tests, 1838 pass, 0 fail, 1 pre-existing skip |
| E2E, real app | `node --test .compiled/test/e2e/project-windows.test.js` | 1/1, exit 0, 18 rows; receipt `project-windows-e2e.json` |
| Live matrix | `node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs` then `--verify-orphans` | 36 passed, 0 failed, 3 hardware-only blocked |

The e2e receipt now carries the restoration as an observation instead of a swallowed cleanup
error: `nativePopupCapsuleRestored: {restoredTo: "capsule-pw-a1"}`, with `activeCapsuleDuringPopup:
capsule-pw-b2`. Its popup row still reports parity (`partition: persist:profile-default`,
`userAgentMode: clean` on both sides) — that row's opener is a plain user tab, which is exactly why
the focused suite above uses a non-default opener instead: with both sides on the defaults, parity
cannot tell inheritance from a coincidence.

The e2e driver also had `activeCapsuleBeforePopup` declared inside the row body while the row's
cleanup is a sibling callback, so the cleanup's capsule restore threw a `ReferenceError` that the
check wrapper logged and swallowed. The variable is row state now, the row asserts the restore
itself, and the receipt records the result.

## Not covered

- A popup from an *agent* (ephemeral/offscreen) opener: the child inherits the opener's partition
  by the same code path, but no live row drives `window.open` from an agent tab.
- Real OS focus behaviour while a popup opens (deferred hardware row `R2-HW`).
