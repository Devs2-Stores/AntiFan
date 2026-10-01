---
title: Detached project WebHub windows — plan 261001-0902 cooked
date: 2026-10-01
summary: "5-phase detach/reattach lifecycle landed; probe 24/0, restart 5/0, e2e 21/0, test:main 2234/0; two wire-contract breaks documented"
---

# Detached project WebHub windows — plan 261001-0902 cooked

## What happened
Executed plans/261001-0902-detached-project-webhub-windows end-to-end under /ak:cook --auto --advice --parallel. Detached `project:<id>` shells: detach entrypoint + detached:true marker + exclusivity (live+marker consulted) + owner-key mint stamps; reattach via post-dispose scoped fold + live hub ingest; boot restore via 'restore' OpenIntent (zero focus steals); D1-D4 field blockers classified (D3 confirmed bug fixed both layers; D2 producer promoteBaseline documented; D1 unfocused-visible proven at Electron level; D4 pinned invariant).

## Key catches (advisory + review gates earned their keep)
- KmGate2: boot project marked detached → TRANSACTION_CONFLICT killed createWindow (found+fixed in phase-03 along with hub double-presentation suppression).
- CookReview FAIL: parkRowsOnClose skipped entire close/veto pipeline (27 test regressions) → redesigned to parkTabsForClose seam (park before page-close loop, veto intact).
- FinalVerify flake was a real race: ERR_UNSAFE_PORT commits chrome-error:// interstitial with getURL=target → grace recheck false-succeeded. Fixed with navFailed latch + chrome-error: exclusion (fail-before/pass-after proven).
- Re-review PASS_WITH_CONCERNS: also landed isDisposed guard in queued persist task (parked-persist truncation race).

## Decisions
- Close-detached ≠ reattach: detach is a mode, marker survives close/quit, boot restores; Reattach is the only exit.
- Wire breaks (documented, changelog + reports): nav failures now return typed codes not TARGET_STALE; marked-dead project mints refuse TERMINAL_SCOPE_UNRESOLVED instead of hub fallback.

## Evidence
probe-detached-webhub.cjs 24/0 + cold restart 5/0; e2e project-windows 21/0; test:main 2234 pass/0 fail/1 skip; compile 542/542 clean. Reports: plans/261001-0902-detached-project-webhub-windows/reports/.

## Next steps (residuals)
R1: real occlusion starvation unexercised end-to-end (needs 3-monitor field smoke). R2: re-detach after reattach mints stray default tab. R3: hubRowVisible exemption + coordinator settle proven via test seams only. R4: field integrations must update TARGET_STALE retry tables.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
