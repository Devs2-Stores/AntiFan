---
title: Reattach refusals silently persisted detached windows across restarts
date: 2026-10-07
summary: Reattach close-veto left the detached marker in saved-tabs.json so boot re-detached; fix adds a force-confirm retry and rolls back zero-transfer detaches
---

# Reattach refusals silently persisted detached windows across restarts

**Date:** 2026-10-07
**Status:** VERIFIED_COMPLETE
**Severity:** High (user-facing state loss: silent refusal persisted across restarts)
**Component:** `src/main/index.ts` — detached project lifecycle (`reattachProject`, `detachProject`, `closeDetachedShellForLifecycle`)
**Tests:** `test/main/detached-project-lifecycle.test.ts` (+2)

## What Happened

User reattached several detached project windows, restarted the app, and every single one came back detached. Live evidence in `E:\Work\.antifan-data\runtime\logs\main.log`: `project-reattach.refused` events with `haltedBy: 'unload-veto'` / `'busy'`. Reattach closes the detached shell through the close coordinator; a member tab's `beforeunload` veto refused the close — silently. The `detached: true` owner marker in `saved-tabs.json` was never cleared, so boot restore faithfully re-detached the project. The reattach wasn't broken — it was *refused*, and nobody was told.

Secondary bug found while in there: `project-detach.refused` left a fresh empty `project:<id>` shell plus a marked owner record when the hub→shell tab transfer was refused — a detached project window containing zero tabs.

## The Brutal Truth

We built fail-closed close semantics (correct) and then gave the user absolutely no indication they had fired. The only feedback was a transient `CLOSE_REFUSED` notice on the retained shell's toolbar — gone before anyone reads it. Meanwhile the marker lived on disk, so a *transient* veto produced *permanent* behavior. The detach arm was worse: we created the shell before knowing whether the transfer would succeed, and left the half-built state on disk when it didn't. Two lifecycle bugs, same disease: refusal paths treated as terminal logging events instead of recoverable states.

## Technical Details

**Fix 1 — reattach refusal arm** (`src/main/index.ts`, `reattachProject` ~line 2257): when the `CloseReport` disposition isn't `closed` and the shell isn't already racing a native teardown, a warning dialog on the detached window offers 'Bắt buộc gắn lại' (default: 'Giữ cửa sổ riêng'). A confirmed yes retries via `closeCoordinator.forceClose`, which bypasses the `beforeunload` and busy gates; the fold into `owners.web` then proceeds and the marker dies with the record. New test seams: `setReattachForceConfirmationForTesting` and `closeDetachedShellForLifecycle(shell, force)` threading `force` through `detachedShellCloseDriverForTesting`.

**Fix 2 — detach refusal arm** (`detachProject`): when `created && result.transferred.length === 0`, the operation rolls back by calling `reattachProject` (close the empty shell, fold the record back into `owners.web`, clear the marker). Partial detaches — some tabs moved, some refused — keep the prior honest-partial behavior; only the zero-transfer fresh-shell case rolls back.

## Root Cause Analysis

`forceClose` existed in the close coordinator all along; `reattachProject` simply never called it. There was no forced path at all — a veto was a dead end that also re-stamped the `detached` marker on the next persist (the marker is re-stamped on *every* persist of a project-owner host). Refused close ⇒ permanent detachment. The detach bug is a plain ordering mistake: shell creation predated the transfer result check, with no rollback.

## Lessons Learned

1. Every refused lifecycle transition needs either a visible recovery path or a forced override. "Refused silently, persisted durably" is the worst possible combination — the user sees a bug that isn't one and can't fix it.
2. Don't create persisted state (shell + marked record) before the operation that justifies it is provable; if you must, make rollback first-class, not a cleanup TODO.
3. When a persisted marker drives boot behavior, always ask two questions: what clears it, and can that path be refused? Here the answer to the second was "yes" and the answer to the first was "nothing else."

## Verification

`npm run compile` clean; `detached-project-lifecycle` suite 11/11; adjacent suites (detached-project-restore, detached-project-window, project-window-persistence, close-refusal-notice) 100/100. The two new tests pin: force-confirmed reattach lands and clears the marker; refused fresh-shell detach rolls back with the vetoed tab staying hub-resident.

## Next Steps

- Restart the live Electron app to pick up the fix — the running binary still has the old refusal path.
- Verify one real `beforeunload`-vetoed reattach end-to-end in the live app; the tests prove the seams and the fold, not an actual renderer veto firing.
- Consider whether `project-remove` (~line 3052, same `closeDetachedShellForLifecycle` call) needs the same force-confirm arm — it currently fails closed with no escape.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
