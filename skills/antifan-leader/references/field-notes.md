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

## 2026-11-24 Worker-does, Leader-QAs gaps (owner: "Fix lại, Kaizen toàn bộ các sơ hở")
- Role source: epres theme 1001522351, `hrv theme info --json` and the storefront at `/` (no `themeid`) both said `main`; the same storefront with `?themeid=1001522351` printed `Haravan.theme.role: "unpublished"`. A `?themeid=` preview therefore always reports `unpublished` and says nothing about the live role; trust `hrv-token-probe.mjs` / `hrv theme info --json` or the no-`themeid` page (password `haravan` per AGENTS §1.B).
- Zesta-CUSNN: `backups/before-fetch-20261124-170952.zip` has 653 entries (413 assets, 152 snippets, 82 templates, 23 layout, 4 config) and every file mtime lies between 17:07 and 17:10 of that day, i.e. written by the same session's own earlier fetch (the folder was created 17:07:32); no older local file existed, so no earlier local-only work was overwritten. A second bound folder (`customizes/Zesta`, theme 1001507674) already existed and the Leader had not listed it (G8).
- Copy-first for live themes was APPLIED the same day (owner Tài, Leader form, option "Áp copy-first (giao một vòng Kaizen nữa)"; `AGENTS.md` §8 "Copy-first cho theme live"; job 261124-1801-kaizen-copy-first-live): work rounds push only to the shop's staging theme, the close round pushes the QA'd files to live. Haravan facts measured while designing it: `hrv theme` has `list|info|fetch|pull|export|push|push-only|publish|delete|rename|lint|console|dev|retry` and NO duplicate (`E:/Work/apps/Haravan CLI/src/commands/theme/index.ts`); the public Omni API creates a theme only from a zip URL (`POST /web/themes.json {name, src, role}`, docs.haravan.com/docs/omni-apis/themes: 20 themes per shop, one main), so a duplicate is the Admin "Sao chép" button (8 themes per shop in the Admin, note (g) of the worker header). `hrv theme fetch <id>` in a folder rewrites `.haravan-cli_local.json` to that id (theme-fetch.ts DOTFILE.PROJECT().write), which is why the worker hook now refuses a fetch of another id in a bound folder.
