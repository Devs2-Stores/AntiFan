# Field notes (dated, not loaded by default)

Incident logs behind the rules. Nothing here is required reading.

## 2026-11-07 wait-workers wake loop
After one worker settled, relaunching `wait-workers.mjs --mine` exited almost at once on already-consumed events. `--ignore` does not exist. The remedy is in `dispatch.md` (Waiting facts).

## 2026-11-09 Leader mistakes
- Queued a fix for a "settled" flag the user had to chase: close the loop yourself (terminals, job, ledger) before reporting.
- Did not reread the template's own contradictions: `originalFeedback` is a global in the dashboard page but NOT a `window` property; use the API by id in follow-ups.
- Everything else the user corrected that day (waiting for all jobs together, jobs left `dispatched`, theme-CLI words in `terminal.write`, Enter-less relays, unproven causes, building the shared CLI under live workers) is covered by the rules of 2b above.

## 2026-11-09 Sapo lane (rewritten 2026-11-17)
The user approved a Sapo command lane for workers on 2026-11-09; the exact one-line forms are in `leader-discipline.md` section 5.5 (a push to a LIVE bound theme needs `--yes`). The decision is made by `planSapoCommand` in `E:/Work/apps/AntiFan/src/omp-hooks/theme-push-policy.ts`, which exists at HEAD (the earlier note that it was absent is stale). If the installed hook still answers `REFUSED_THEME_REMOTE_OP` for such a command, the installed hook is an older build: tell the user once (reinstall: `node E:/Work/apps/AntiFan/scripts/install-omp-hooks.mjs --install --hook edit-guard`) and never hand the worker a workaround.

## 2026-11-13 Trello workers
Card passwords landed in two session logs when workers read `body.innerText` instead of the `trello-card` probe: treat that password as exposed. The Atoha "OTP never arrives" conclusion was wrong: the Telegram tab had been opened with `activate:false` and froze.

## 2026-11-13 BILUX job
A job ran 13 rounds because review rounds never counted and the extra-round flag had no limit; the ceilings in `feedback-rules-and-probes.md` came from it.
