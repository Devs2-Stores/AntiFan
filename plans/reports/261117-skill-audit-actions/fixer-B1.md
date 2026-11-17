# Work order — fixer B1 (F1GENZ apps / Cloudflare part 1)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-B1.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = B1). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### cf-worker-kaizen-ship-and-watch
- class: **OWNER**; scout cluster B1; roots: managed; SKILL.md 61 lines; desc 178 chars; uses30d(sessions): 0; descQ 4/5; lang desc EN, body VI
- action: add `references/rollback-thresholds.md`; remove date stamp; absorb plain-var as reference (see clusters)
- scout verdict text: KEEP (owner of Worker-ship cluster)
- stale/verified: none verifiable offline
- contradiction: none; consistent w/ approval rule
- structure: "ERR-link" std-warn; dated claim :4 "kiểm chứng 13/11/2026"
- overlap: cf-worker-plain-var-update (same wrangler versions flow), cf-pages-spa-safe-ship
- absorbs: cf-worker-plain-var-update
### cf-worker-prod-404-triage
- class: **OWNER**; scout cluster B1; roots: managed; SKILL.md 60 lines; desc 196 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: becomes owner of 404 cluster; f1genz-app-host-404-triage folds into `references/f1genz-root-redirect.md`
- scout verdict text: MERGE (owner)
- structure: emphasis cruft
- overlap: f1genz-app-host-404-triage (same symptom, same body `Cannot GET /`)
- absorbs: f1genz-app-host-404-triage
### cloudflare-one
- class: **OWNER**; scout cluster B1; roots: agents,claude; SKILL.md 177 lines; desc 325 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: absorb migrations
- scout verdict text: KEEP (owner)
- stale/verified: n/a
- structure: single file, ok
- overlap: cloudflare-one-migrations
- absorbs: cloudflare-one-migrations
### figforyou-amazon-page-check
- class: **OWNER**; scout cluster B1; roots: managed; SKILL.md 67 lines; desc 174 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: fix skill name to `antifan-stdio-mcp-driver`; absorb verified-asin-batch selection/data steps; move deploy/smoke to figforyou-release
- scout verdict text: KEEP (owner of ASIN verification)
- stale/verified: skill `antifan-tab-drive-via-stdio-mcp` :12 does not exist (real = `antifan-stdio-mcp-driver`); `C:/Program Files/Git/bin/bash.exe` ✓ pattern; plan/runbook files ✓ exist; threshold file `lib/catalog/indexing.ts` ✓
- contradiction: :66 "Commit. Do not pus[h]" vs figforyou-release:38 "Push master to origin"
- structure: long; mixes browser-drive + D1 sync + deploy; ERR-link std-warn
- overlap: figforyou-verified-asin-batch (older method; this one declares it replaces it :8), figforyou-release
- absorbs: figforyou-verified-asin-batch
### figforyou-status-audit
- class: **OWNER**; scout cluster B1; roots: managed; SKILL.md 65 lines; desc 181 chars; uses30d(sessions): 1; descQ 4/5; lang EN
- action: absorb prod-status-check; move python crawl to `references/crawl.py.md`
- scout verdict text: KEEP (owner)
- stale/verified: `plans/261009-2100-listing-ia/plan.md`, `plans/261004-1143-fig-for-you-mvp/plan.md` ✓ exist
- structure: embedded 20-line Python snippet; fine
- overlap: figforyou-prod-status-check
- absorbs: figforyou-prod-status-check
### cf-hostname-migrate-f1genz
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 59 lines; desc 177 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: add H1 + "Use when/not for"; replace constants with pointer to `E:/Work/docs/naming-cloudflare.md`; drop dead worktree + lock paths; absorb pages-bridge as `references/pages-bridge-matbao.md`
- scout verdict text: REWRITE (owner of hostname cluster)
- stale/verified: `ml-cf` worktree cited (:19 "`.worktrees/ml-cf` on `cf-migration`") does not exist (`.worktrees` has other dirs); account+zone ids :9; `root@178.128.216.88` + `/root/bridge-261104/locks` :11 (volatile 2026-11-04 convention); `Server--Collection-Tabs` branch :48 unverified
- contradiction: :50 "do not pm2 save/delete on the VPS" vs f1genz-multisync-backfill-ops:18-19 `pm2 delete`/`pm2 save` (different host, never stated)
- structure: no H1 (starts `## Constants`); IDs hardcoded; volatile session facts
- overlap: f1genz-hostname-inventory (recon half), cloudflare-pages-cname-bridge-matbao-dns (option iv), cloudflare-dns-record-dashboard-ops (DNS step)
- absorbs: cloudflare-pages-cname-bridge-matbao-dns
### cf-pages-spa-safe-ship
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 65 lines; desc 169 chars; uses30d(sessions): 8; descQ 3/5; lang EN
- action: rewrite description to "Use when deploying … (needs user approval)"; replace env mapping block (:56-58) with pointer to naming-cloudflare.md; drop hash numbers
- stale/verified: uses sample project `Haravan-Client--Multilanguage` :8 (dir exists under F1GENZ MultiLanguage); example bundle hashes :54 volatile
- contradiction: desc says "Ship…" but says nothing of approval; deploying prod without user approval conflicts with kaizen-ship:56 "deploy production always needs user approval"
- structure: desc lacks trigger phrase; no standard sections
- overlap: f1genz-client-local-harness (ship+verify tail), cf-worker-kaizen-ship-and-watch (same env mapping), cf-hostname-migrate step 3 (Pages env)
### f1genz-app-licence-lockout-triage
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 39 lines; desc 175 chars; uses30d(sessions): 3; descQ 3/5; lang desc EN, body EN/VI
- action: rebase evidence on DO SQLite/digest + `wrangler tail`; add routing line "404 JSON → host-404 skill"; drop Redis/Postgres sources
- stale/verified: stale: reads Postgres `Shop` + Redis alias :8, Redis backup key :22 — Postgres/Redis cancelled/deleted 07/11 and `worker/package.json` has no redis (rg exit 1); `client_id 4e30ab07…` fragment :13
- structure: no not-for vs host-404 skill; wrong-host symptom overlap
- overlap: f1genz-app-host-404-triage (same merchant complaint)
### f1genz-checkorders-shop-install-verify
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 40 lines; desc 196 chars; uses30d(sessions): 3; descQ 3/5; lang desc EN, body VI
- action: rename `f1genz-checkorders-install`; "Use when…" description; move widget invariants to `references/widget-invariants.md`
- stale/verified: `E:/Work/apps/F1GENZ Orders/worker/src/order-lookup/widget.ts` ✓ exists; `client/.git-nested` unverified
- contradiction: consistent with AGENTS.md §8 (one-line `hrv theme info --json`, `push --only … --nodelete`) :26 ✓
- structure: name says "verify" but body = install + widget.ts invariants + deploy; description has no trigger (std-warn)
- overlap: haravan-app-sms-otp (CheckOrders OTP), theme push rules
### f1genz-client-local-harness
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 38 lines; desc 197 chars; uses30d(sessions): 4; descQ 3/5; lang VI missing diacritics
- action: restore diacritics; swap host to `.f1genz.dev`; "Use when…"; drop environment claim
- stale/verified: `E:/Work/apps/F1GENZ MultiLanguage/Haravan-Client--Multilanguage` ✓; host `multilanguage.f1genz.com` :6,:37 stale (app moved to `.dev`); claim "live console cannot be signed in" volatile
- structure: headings/body without diacritics (`# Muc đích`, `cua`, `khong`, :2-37 mixed); desc has no trigger (std-warn)
- overlap: local-worker-signed-in-ui-qa, antifan-dom-overlap-scan (other clusters)
### f1genz-cloud-service-cancel-verify
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 54 lines; desc 207 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: cut to "post-cancel health verification"; delete delete-flow + dead-proof (owned by ext skills); remove rm -rf line or require explicit approval; move dated facts to a report
- stale/verified: `E:/Work/scratch/backups/261107-rediscloud-dump/` missing :50 (and `scratch/backups` dir missing); VPS `root@178.128.216.88` :22; Supabase refs :49; Review worker path `E:/Work/apps/F1GENZ_Review/worker-api` ✓ exists
- contradiction: :42 recommends `rm -rf` of retired NestJS checkouts without stating user approval (root contract: `rm -rf` is Level-0 NEVER); cf-hostname-migrate:50 forbids pm2 delete on VPS vs :43 "Remove stopped routes"
- structure: 4 sections of different contracts; "Key facts (verified 2026-11-07)" dated; trigger absent; "Leader dispatches workers; never self-investigate" (role-specific)
- overlap: redis-cloud-dashboard-db-delete-antifan, supabase-dead-verify-probe, redis-cloud-exit-runbook, redis-cloud-cancel-antifan (all other clusters), backend-cutover-origin-proof
### f1genz-ml-shop-state-readonly-triage
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 93 lines; desc 319 chars; uses30d(sessions): 2; descQ 3/5; lang VI body, EN desc
- action: repoint to `worker/scripts/lib/*`; mark source 3 (dump/redis) as "if backup still exists"; add DO-digest route path; remove scratch samples
- stale/verified: `E:/Work/scratch/backups/261104-ml-final-cutover/ml_bridge.dump` missing :20; `ml-cf` worktree imports `.worktrees/ml-cf/worker/scripts/lib/pg-custom.mjs` :23-24 — file now only at `worker/scripts/lib/pg-custom.mjs` (verified); wrangler logs path `xdg.config/.wrangler/logs` :62 not verified; scratch sample files `f1genz-empty-r10` :92 missing
- structure: longest managed skill; table-heavy; dated; includes account id :59
- overlap: f1genz-ml-ops-import-grant, f1genz-app-licence-lockout-triage
### f1genz-multilanguage-theme-job-diagnose
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 17 lines; desc 158 chars; uses30d(sessions): 4; descQ 3/5; lang desc EN, body VI
- action: change source of truth to Worker theme job (DO) + `worker/src/theme/*`; keep Gemini 402 classification
- stale/verified: stale: reads Redis key `haravan:multilanguage:storefront_theme_job:<jobId>` with `ioredis` :9-10 and `src/translate/storefront-theme.service.ts` :14 — job code now at `worker/src/theme/theme-job.ts`, `theme-routes.ts` (verified), worker has no redis dep
- structure: 5 steps; no not-for
- overlap: f1genz-ml-shop-state-readonly-triage
### f1genz-multisync-backfill-ops
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 57 lines; desc 217 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: split: `freeze` + `ledger-query` to references; keep "run/ resume" in body; state host (local Windows pm2) explicitly
- scout verdict text: REWRITE (split)
- stale/verified: scripts ✓; `migrate-api` command ✓ (`src/cli.ts:14`); quarantine `cron_restart` ✓; `C:/Users/Ad…` path :22 truncated (false positive); ledger "~3.6 GB" volatile
- contradiction: :18-19 `pm2 delete … ; pm2 save` host not stated vs cf-hostname-migrate:50 "no pm2 save/delete on VPS"
- structure: mixes 5 contracts (backfill run, freeze, catalog bug, ledger query, settle) ; ERR-link ×2; desc has no trigger
- overlap: haravan-bulk-settle-committed (settle backlog), haravan-dat-ton-reconcile-and-release
### haravan-app
- class: **REWRITE**; scout cluster B1; roots: agents,claude; SKILL.md 151 lines; desc 459 chars; uses30d(sessions): 19; descQ 4/5; lang EN
- action: fix broken link; add routing rows to Tài's operational skills; Vietnamese-reply rule; trim to ≤120 lines
- scout verdict text: REWRITE (light)
- stale/verified: broken link :30 verified; mentions retired feasibility skill :86
- contradiction: :126 "Default to the user's language; English when unclear" vs root rule Vietnamese always; Security Policy refuses live tokens vs Tài's operational skills
- structure: refs 4 files ≤201 lines ok; evals/ present; extra frontmatter (user-invocable, category, keywords); ERR-link ×1 (broken `../references/ai-image-visual-truth-privacy-handoff-contract.md` :30, file missing) ; `--fast/--full` modes not defined by CLI
- overlap: haravan-app-feasibility (retired copy), haravan-app-sms-otp, haravan-embedded-app-auth-triage, haravan-api-writability-probe
### haravan-app-sms-otp
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 36 lines; desc 155 chars; uses30d(sessions): 0; descQ 3/5; lang EN desc, EN body
- action: turn into decision record: move to `plans/` as ADR; keep skill as "how to design OTP" w/o prices; fix citation
- stale/verified: cites `advise-261104-super-heavy-plan.md` :6 — file not found under E:/Work
- structure: desc has no trigger (std-warn); emphasis cruft; dated "Locked decisions (2026-11-04)"
- overlap: haravan-app (design routing), f1genz-checkorders-shop-install-verify
### haravan-customer-app-ledger-read
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 101 lines; desc 248 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: keep read/scan; move import → `references/excel-import.md` w/ approval gate; delete split-customer + Pancake-sync sections (owned by ext skills)
- scout verdict text: REWRITE (split)
- stale/verified: no local paths; Pancake endpoints cited unverified
- contradiction: read-only name vs live import steps :39-69
- structure: three contracts + write authority in one file; dated "done 2026-10-31"
- overlap: haravan-split-customer-consolidation (:89-96 is a copy of that flow), pancake-haravan-tier-parity-scan, haravan-membership-ledger-repair (ext)
### haravan-dat-ton-reconcile-and-release
- class: **REWRITE**; scout cluster B1; roots: managed; SKILL.md 89 lines; desc 195 chars; uses30d(sessions): 1; descQ 3/5; lang EN
- action: generalise case: replace dated numbers with placeholders; move §8 to stock-load skill; keep gate-clearing protocol
- stale/verified: `scripts/clear-committed.ts` ✓ (`LEFT_SHOP` :54, `CLEAR_PAGES` :45 default 240 ✓), `import-stock.ts --physical` ✓; skill link `publish-xlsx-report-to-google-sheet-antifan` ✓; threat-language cruft
- structure: customer-specific numbers inline (anchor 161, 253, order ids); tab names ASCII
- overlap: haravan-bulk-settle-committed, haravan-stock-load-after-legacy-ledger (§8 import-stock answer), haravan-ledger-false-halt-triage
### agents-sdk
- class: **KEEP**; scout cluster B1; roots: agents,claude; SKILL.md 222 lines; desc 431 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: add one-line not-for (Workflows-only → workers-best-practices); have `cloudflare` route here instead of duplicating
- stale/verified: none; mirrors `cloudflare/references/agents-sdk`
- structure: refs/ ok (max 198 lines); no not-for
- overlap: cloudflare umbrella (320-file bundle contains agents-sdk copy)
### cf-pages-deploy-regression-triage
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 45 lines; desc 181 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: optional: fold into deploy-truth owner as `references/pages-regression.md`; keep as is meanwhile
- scout verdict text: KEEP (cluster A reference)
- stale/verified: none (generic API calls)
- structure: fine; references none needed
- overlap: cf-worker-deploy-commit-correlation (same "deployment ≠ content" principle), f1genz-client-worker-route-parity
### cf-playground-model-spotcheck
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 35 lines; desc 339 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: strip emphasis; move quota claim to dated note or remove
- stale/verified: none verifiable offline; "10K-neuron/day free tier" :30 is volatile pricing
- structure: cruft: stacked emphasis (std lint); dense steps
- overlap: llm-gateway-model-switch-bench (other cluster; different goal)
### cf-staging-frozen-write-e2e
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 60 lines; desc 170 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: name target repo + verify `FREEZE_ALLOW_ORGIDS` exists; replace memory-lesson pointer with the actual rule (Haravan `/web/*` ignores `?namespace=`)
- stale/verified: can't verify which repo owns `FREEZE_ALLOW_ORGIDS`; :55 "see the project memory lesson" is a dangling reference
- structure: repo not named (src/app.ts, cron/scheduled.ts, shop-do.ts are ML-style) ; code block inline
- overlap: f1genz-ml-ops-import-grant (token gate), cf-worker-plain-var-update
### cloudflare
- class: **KEEP**; scout cluster B1; roots: agents,claude; SKILL.md 249 lines; desc 368 chars; uses30d(sessions): 7; descQ 3/5; lang EN
- action: do not edit vendor refs; ensure description is a router; split/limit flagship refs ≤300 or exclude from managed set; remove standalone dupes it carries
- scout verdict text: KEEP (vendor) but trim
- stale/verified: n/a
- structure: oversized refs: `references/flagship/patterns.md` 469, `flagship/api.md` 390 lines; ERR-link ×2; emphasis ×27; 320 files; one volatile fact
- overlap: duplicates agents-sdk, durable-objects, email-routing/email-workers, sandbox, workers (vs ext workers-best-practices, wrangler, sandbox-*)
### cloudflare-account-token-create-clipboard-only
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 21 lines; desc 196 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: add H1 + Definition-of-done (verify endpoint 200, value never printed)
- stale/verified: naming doc `E:/Work/docs/naming-cloudflare.md` exists ✓ (:4)
- contradiction: none (secret handling rule consistent)
- structure: no H1 (starts `## Rules`); dense one-line steps
### cloudflare-dns-record-dashboard-ops
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 42 lines; desc 191 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: externalise ids to naming-cloudflare.md; keep hard-gate before delete
- scout verdict text: KEEP (distinct side effect: DNS delete/edit)
- stale/verified: account id + zone id hardcoded :11,:17; `192.0.2.1` placeholder ok
- structure: fine; IDs hardcoded
- overlap: cf-hostname-migrate (DNS record step), cloudflare-pages-cname-bridge (Mat Bao DNS)
### cloudflare-email-service
- class: **KEEP**; scout cluster B1; roots: agents,claude; SKILL.md 104 lines; desc 508 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: none; keep as owner of email, remove from umbrella
- stale/verified: n/a
- structure: refs max 285 lines (`deliverability.md`), ok
- overlap: cloudflare/references/email-routing + email-workers
### durable-objects
- class: **KEEP**; scout cluster B1; roots: agents,claude; SKILL.md 187 lines; desc 382 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: n/a vendor; flag to maintainers
- stale/verified: n/a
- structure: `references/workers.md` 346 lines (>300)
- overlap: cloudflare/references/durable-objects, do-storage
### f1genz-client-worker-route-parity
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 30 lines; desc 191 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: add not-for; link to deploy-truth owner
- structure: fine
- overlap: cf-worker-deploy-commit-correlation (drift step)
### f1genz-feedback-ai-prompt-verify
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 37 lines; desc 140 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: replace scratch-path example with `%TEMP%` pattern; move 7-step smoke to `references/smoke-recipe.md`
- stale/verified: `E:/Work/apps/F1GENZ Feedback/client/public/index.html` ✓, `docs/stage-sync-fixed-vs-done.md` ✓; scratch path `E:/Work/scratch/fb-stage-prompt-check/page-script.js` missing :17 (fragile, one-off); `E:/Work/apps/F1GENZ` truncation = false positive
- structure: desc has NOT-for; heavy procedure; ok
- overlap: f1genz-feedback-comment-post (same dashboard, different contract)
### f1genz-feedback-comment-post
- class: **KEEP**; scout cluster B1; roots: managed,repo; SKILL.md 38 lines; desc 217 chars; uses30d(sessions): 103; descQ 4/5; lang EN desc, VI note format
- action: single source = repo `E:/Work/apps/AntiFan/skills/…`; remove date anecdote
- stale/verified: repo copy == managed copy (identical) ✓; selectors `#newCommentText`, `#editRowNumber` unverified
- contradiction: none; Vietnamese note format consistent w/ rules
- structure: emphasis cruft (NEVER); includes dated "Run live 11/11/2026"
- overlap: f1genz-feedback-dashboard-triage; google-sheet-feedback-row-marking (ext)
### f1genz-feedback-dashboard-triage
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 21 lines; desc 232 chars; uses30d(sessions): 11; descQ 4/5; lang EN
- action: add not-for pointing to comment-post; share tab-binding preamble
- structure: no H2 "Definition of done"; ok size
- overlap: haravan-feedback-sheet-audit, levents-feedback-triage (ext)
### f1genz-hostname-inventory
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 52 lines; desc 163 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: keep separate; remove psql/DB assumption; link to migrate owner
- scout verdict text: KEEP (read-only authority, distinct)
- stale/verified: `root@178.128.216.88` :12; psql `ml_bridge` DB :18 (Postgres retired, bridge DB kept per cancel-verify:37); six numbered "traps" volatile
- structure: threat-language cruft flagged; no standard sections
- overlap: cf-hostname-migrate-f1genz, cloudflare-pages-cname-bridge
### f1genz-ml-ops-import-grant
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 46 lines; desc 193 chars; uses30d(sessions): 7; descQ 3/5; lang none
- action: RETIRE (unless route re-created)|delete after confirming with owner that import route removed; keep "wrangler via cmd /c stores empty secret" pitfall in cloudflare ops note
- scout verdict text: EN
- stale/verified: `worker/src/ops/import.ts`, `ops-auth.ts`, `haravan/trial.ts` :11 — `rg "internal/import
- contradiction: f1genz-ml-shop-state-readonly-triage
- structure: procedure cites repo files
- overlap: MIGRATION_IMPORT_TOKEN"` over `worker/src` returns no route; `.worktrees/ml-cf` missing; Redis backup `E:/Work/scratch/backups/261104-ml-final-cutover/redis-ml.jsonl` :27 missing
### f1genz-stock-script-offline-harness
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 65 lines; desc 181 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: update step 1 to "already present"; add `scripts/` sample as reference
- stale/verified: `PANCAKE_API_BASE` seam already exists in `scripts/clear-committed.ts:40` (recipe step 1 says "add" — stale); `HARAVAN_API_URL` ✓ :38
- contradiction: PowerShell `Get-CimInstance … taskkill` guidance consistent with no-uncoordinated-kill rule
- structure: no standard sections; long
- overlap: haravan-bulk-settle-committed, haravan-dat-ton… (consumers)
### figforyou-release
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 39 lines; desc 144 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: add approval rule; replace key literal with `<key>.txt`; other skills point here
- scout verdict text: KEEP (owner of deploy+smoke)
- stale/verified: `scripts/deploy-production.sh` ✓; IndexNow key file path with key :29 (public file, not secret); `C:/Program Files/Git/bin/bash.exe` ✓
- contradiction: :38 "Push `master`" vs batch:58 / check:66 "do not push without user"
- structure: ERR-link; standard sections missing
- overlap: figforyou-verified-asin-batch step 5-6, figforyou-amazon-page-check step 4 (same deploy/smoke repeated)
### haravan-api-writability-probe
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 74 lines; desc 178 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: add "Use when…"; move 2026-11-05 result to a dated note; state it is excluded from haravan-app's no-credential rule
- stale/verified: `scripts/clear-committed.ts`, `settle-committed.ts` ✓ ; `~/.haravan-cli.json` not checked
- contradiction: haravan-app Security Policy forbids credential use; this skill reads tokens by design
- structure: ERR-link ×2, desc no trigger; dated result :46
- overlap: haravan-inventory-ledger-forensics step 4, haravan-bulk-settle-committed
### haravan-bulk-order-job-ops
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 59 lines; desc 229 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: verify script names; cross-link detach pattern
- stale/verified: `scripts/relocate-orders.ts`/`backfill-order-attributes.ts` mentioned not verified; PowerShell Win32_Process launcher aligned with windows-silent-node-job-death (ext)
- structure: fine
- overlap: windows-silent-node-job-death (ext)
### haravan-bulk-settle-committed
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 43 lines; desc 284 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: absorb duplicate settle bits from backfill-ops; share facts with ext write-safety skill
- scout verdict text: KEEP (owner of settle write protocol)
- stale/verified: `E:/Work/apps/F1GENZ MultiSync/scripts/settle-committed.ts` ✓, `data/launch-settle.ps1`, `launch-chain.ps1`, `watch-settle.ps1` ✓; `E:/Work/apps/F1GENZ` truncation false positive
- structure: ERR-link ×3; dense
- overlap: f1genz-multisync-backfill-ops (settle section), haravan-dat-ton-reconcile-and-release (anchor 161, same journal), haravan-inventory-write-safety, haravan-ledger-false-halt-triage (ext)
### haravan-embedded-app-auth-triage
- class: **KEEP**; scout cluster B1; roots: managed; SKILL.md 27 lines; desc 187 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: add DoD + routing line from haravan-app
- stale/verified: F1GENZ_Review reason string :14 unverified
- structure: no explicit "Definition of done"
- overlap: haravan-app (routing), antifan DOM skills
### cf-worker-plain-var-update
- class: **MERGE** → `cf-worker-kaizen-ship-and-watch`; scout cluster B1; roots: managed; SKILL.md 62 lines; desc 199 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: move as `references/plain-var-breakglass.md` (trigger = dashboard Deploy error); keep trigger sentence in owner description
- scout verdict text: MERGE→cf-worker-kaizen-ship-and-watch
- stale/verified: `E:/Work/apps/F1GENZ_PageSpeed_API` exists ✓
- structure: fine
- overlap: cf-worker-kaizen-ship-and-watch
### cloudflare-one-migrations
- class: **MERGE** → `cloudflare-one`; scout cluster B1; roots: agents,claude; SKILL.md 111 lines; desc 187 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: `references/migrations.md` (111 lines), 1 routing sentence in owner
- scout verdict text: MERGE→cloudflare-one
- stale/verified: n/a
- structure: ok
- overlap: cloudflare-one (same product, planning vs build)
### cloudflare-pages-cname-bridge-matbao-dns
- class: **MERGE** → `cf-hostname-migrate-f1genz`; scout cluster B1; roots: managed; SKILL.md 77 lines; desc 201 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: `references/pages-bridge-matbao.md`; strip service_ref; keep Pages Function sample
- scout verdict text: MERGE→cf-hostname-migrate-f1genz
- stale/verified: `.com0322727` Mat Bao service ref :54; project `f1genz-com-api-bridge` and hosts hardcoded; dated; `one.one.one.one/api/v1/purge` endpoint unverified
- structure: long inline code; proper heading
- overlap: f1genz-hostname-inventory option (iv), cf-hostname-migrate
### f1genz-app-host-404-triage
- class: **MERGE** → `cf-worker-prod-404-triage`; scout cluster B1; roots: managed; SKILL.md 70 lines; desc 282 chars; uses30d(sessions): 4; descQ 4/5; lang desc EN, body VI
- action: steps 0, 2, 4 → `references/f1genz-root-redirect-and-partners.md`; keep desc trigger "hết hạn / không vào được" in owner
- scout verdict text: MERGE→cf-worker-prod-404-triage
- stale/verified: none checked offline; body states `Server:` header method
- contradiction: :56 "Haravan Partners: chỉ đọc" consistent; none
- structure: fine
- overlap: cf-worker-prod-404-triage
### figforyou-prod-status-check
- class: **MERGE** → `figforyou-status-audit`; scout cluster B1; roots: managed; SKILL.md 45 lines; desc 127 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: keep click-smoke section (:30-35) as reference; delete this skill
- scout verdict text: MERGE→figforyou-status-audit
- stale/verified: files ✓; counts `300 products`, `52 base URLs` volatile (:24-26)
- structure: emphasis cruft
- overlap: figforyou-status-audit (near-identical sections 1-4)
### figforyou-verified-asin-batch
- class: **MERGE** → `figforyou-amazon-page-check`; scout cluster B1; roots: managed; SKILL.md 60 lines; desc 137 chars; uses30d(sessions): 3; descQ 2/5; lang EN
- action: keep "pick candidates + data fields + verify:offers" as `references/data-format.md`; delete method section
- scout verdict text: MERGE→figforyou-amazon-page-check
- stale/verified: `data/seed-products.json` count "150" hard-coded :7; `sitemap 52+12+60` dated 2026-10-10 :43
- contradiction: contradicts amazon-page-check (no page fetch vs owner-tab fetch) and release (push)
- structure: superseded: its evidence method ("no page fetch works" :15) is the one amazon-page-check :8 says it replaces
- overlap: figforyou-amazon-page-check
### haravan-inventory-invariant-audit
- class: **MERGE** → `haravan-inventory-invariant-audit`; scout cluster B1; roots: managed; SKILL.md 38 lines; desc 278 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: merge forensics steps 1-3 as `references/attribution-and-pancake-source.md`; keep one skill
- scout verdict text: MERGE→haravan-inventory-invariant-audit
- structure: fine
- overlap: haravan-inventory-ledger-forensics (same read-only measure); both state adjustorset ~11 s
- absorbs: haravan-inventory-invariant-audit, haravan-inventory-ledger-forensics
### haravan-inventory-ledger-forensics
- class: **MERGE** → `haravan-inventory-invariant-audit`; scout cluster B1; roots: managed; SKILL.md 61 lines; desc 252 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: steps 1-3 → reference; step 4 write path → write-safety (ext) / settle owner
- scout verdict text: MERGE→haravan-inventory-invariant-audit
- stale/verified: `inventory_locations 422 without variant_ids/location_ids` repeated in dat-ton:25 and api-probe
- structure: fine
- overlap: haravan-inventory-invariant-audit
### haravan-app-feasibility
- class: **RETIRE**; scout cluster B1; roots: agents,claude; SKILL.md 13 lines; desc 112 chars; uses30d(sessions): 3; descQ 1/5; lang EN
- action: delete directory in both `.agents` and `.claude` (not editing here); keep any eval case that still references it inside haravan-app/evals
- stale/verified: :12 cites `apps/.claude/skills/haravan-app/references/` (dir exists, but unneeded)
- structure: `disable-model-invocation: true`, `user-invocable: false`, `status: retired`; still ships 8 files incl. stale copies of references (3 of 5 differ from haravan-app's)
- overlap: haravan-app

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. **Deploy-truth proofs (read-only).** Owner: `worker-origin-discrimination` (other cluster, existing). Members: backend-cutover-origin-proof (discriminator route + pre-delete gates → `references/pre-delete-gates.md`), cf-worker-deploy-commit-correlation (→ `references/commit-correlation.md`), cf-pages-deploy-regression-triage (→ `references/pages-regression.md`). Keep f1genz-client-worker-route-parity apart (client→route contract) with a link. Body of owner = decision tree: "which host serves?" → "which version?" → "which content?"; one definition-of-done: evidence table with positive control.
2. **404 / "app không vào được" triage.** Owner: `cf-worker-prod-404-triage` (generic name). f1genz-app-host-404-triage → `references/f1genz-root-redirect-and-partners.md` (Steps 0, 2, 4, probe matrix). Keep f1genz-app-licence-lockout-triage separate (different evidence: licence state) and add first-line routing in both descriptions.
3. **Hostname migration (.com → .dev).** Owner: `cf-hostname-migrate-f1genz` (write). Absorb `cloudflare-pages-cname-bridge-matbao-dns` → `references/pages-bridge-matbao.md`. Keep apart: `f1genz-hostname-inventory` (read-only, no side effects) and `cloudflare-dns-record-dashboard-ops` (DNS mutation). Constants (account id, zone id, token env names, VPS) move to `E:/Work/docs/naming-cloudflare.md` (exists) — never inline.
4. **Cloudflare ship/deploy (write, approval-gated).** Owner: `cf-worker-kaizen-ship-and-watch`; absorb `cf-worker-plain-var-update` → `references/plain-var-breakglass.md`. `cf-pages-spa-safe-ship` stays (Pages, build-time env) but must lose the duplicated credential block and add the approval rule. `f1genz-client-local-harness` "Ship + verify Pages live" tail → delete and link to cf-pages-spa-safe-ship.
5. **ML (MultiLanguage) ops.** Owner: new/renamed `f1genz-ml-ops` or keep `f1genz-ml-shop-state-readonly-triage`; members: licence-lockout, theme-job-diagnose (both rewrite to DO SQLite world), ops-import-grant (RETIRE: route absent in `worker/src`), client-local-harness (keep, rewrite). Reason: all four were written against Postgres/Redis/ml-cf worktree that no longer exists.
6. **FigForYou.** Three skills target: `figforyou-status-audit` (absorbs prod-status-check; read-only), `figforyou-release` (deploy+D1 sync+smoke; owner of push/approval rule), `figforyou-amazon-page-check` (absorbs verified-asin-batch; browser evidence + data-file rules). One shared smoke list lives only in release.
7. **Haravan inventory / MultiSync stock.** Read-only: merge forensics → `haravan-inventory-invariant-audit`. Write: `haravan-bulk-settle-committed` owns settle protocol; `haravan-dat-ton-reconcile-and-release` becomes a case-study reference; `f1genz-multisync-backfill-ops` keeps backfill/freeze; `f1genz-stock-script-offline-harness` and `haravan-api-writability-probe` stay as test/probe tools. Common facts (`adjustorset` async ~11 s, `inventory_locations` 422 without both ids, Pancake `remain_quantity`) → one `references/haravan-inventory-api-facts.md` in `haravan-inventory-write-safety` (ext).
8. **Haravan app design.** Owner: `haravan-app`; RETIRE `haravan-app-feasibility`; add routing rows to haravan-app-sms-otp, haravan-embedded-app-auth-triage, haravan-api-writability-probe.
9. **Cloudflare vendor bundle.** `cloudflare` umbrella embeds copies of agents-sdk/durable-objects/email/sandbox; pick standalone skills as owners and make umbrella route-only. Merge `cloudflare-one-migrations` → `cloudflare-one/references/migrations.md`.
10. **Local Worker smoke on Windows.** `cloudflare-worker-local-smoke-windows` + `local-worker-signed-in-ui-qa` + `worker-local-smoke-antifan-ui-qa` (latter two in other clusters, descriptions only seen in catalog): one owner, pick `local-worker-signed-in-ui-qa` [INFERENCE: bodies unread].
11. **Cloud cancel.** `f1genz-cloud-service-cancel-verify` duplicates `redis-cloud-dashboard-db-delete-antifan`, `supabase-dead-verify-probe`, `redis-cloud-exit-runbook`; shrink to health verification only.

## (c) Rewrite candidates (top 4)

1. **f1genz-ml-shop-state-readonly-triage** (+ licence-lockout + theme-job): the whole ML evidence chain still points at Postgres dump/Redis/`ml-cf` worktree; rewrite around DO digest + `worker/scripts/lib` + live `wrangler tail`, with one shared "ML evidence sources" table.
2. **f1genz-cloud-service-cancel-verify**: remove volatile key facts (:41-49), duplicate delete flows, and the unapproved `rm -rf` guidance (:42); keep health-verification checklist with DoD.
3. **haravan-customer-app-ledger-read**: split read vs live-write contracts; delete content owned by ext split-customer/parity skills; add approval gate before Excel import.
4. **cf-hostname-migrate-f1genz** (owner of hostname cluster): add trigger/not-for, remove dead worktree + VPS lock, point constants to naming doc, absorb Mat Bao bridge.

## (d) Cluster-level inconsistencies

- **Credential/constants block copy-pasted**: `CLOUDFLARE_API_TOKEN_F1GENZ` + `CLOUDFLARE_ACCOUNT_ID_F1GENZ` mapping appears in cf-pages-spa-safe-ship:56-58, cf-worker-kaizen-ship-and-watch:7,11, cf-worker-plain-var-update:20,38, cf-hostname-migrate:6, f1genz-hostname-inventory:10, f1genz-ml-shop-state:59, f1genz-cloud-service-cancel-verify:17 and others; account/zone ids hardcoded in cf-hostname-migrate:9, cloudflare-dns-record-dashboard-ops:11,17, f1genz-ml-shop-state:59. Single source exists: `E:/Work/docs/naming-cloudflare.md`.
- **VPS IP `root@178.128.216.88`** inlined in cf-hostname-migrate:11, f1genz-cloud-service-cancel-verify:22, f1genz-hostname-inventory:12. Move to one ssh alias note; no password/keys found.
- **Stale post-cutover assumptions** (Postgres, Redis, `.worktrees/ml-cf`, `scratch/backups/*` — dir missing): f1genz-ml-ops-import-grant, f1genz-ml-shop-state-readonly-triage, f1genz-multilanguage-theme-job-diagnose, f1genz-app-licence-lockout-triage, f1genz-hostname-inventory:18, cf-hostname-migrate:19, f1genz-cloud-service-cancel-verify:50.
- **Push/approval contradiction in FigForYou**: release:38 pushes `master`, batch:58 and amazon-check:66 forbid pushing without user. Pick one: "push only with user approval".
- **pm2 contradiction**: backfill-ops:18-19 requires `pm2 delete` + `pm2 save`; cf-hostname-migrate:50 forbids them "on the VPS". Both need host named (local Windows vs VPS).
- **`rm -rf` vs root contract**: f1genz-cloud-service-cancel-verify:42 gates `rm -rf` of NestJS checkouts but never says explicit approval is required (Level-0 NEVER).
- **Broken skill references**: figforyou-amazon-page-check:12 → `antifan-tab-drive-via-stdio-mcp` (real: `antifan-stdio-mcp-driver`); haravan-app:30 → missing `../references/ai-image-visual-truth-privacy-handoff-contract.md`; haravan-app-sms-otp:6 → missing `advise-261104-super-heavy-plan.md`; cf-staging-frozen-write-e2e:55 → "project memory lesson" not locatable.
- **Description style**: 8 of 11 shortest managed descriptions lack a "Use when" trigger (std-warn); only 1 description is Vietnamese (cf-worker-deploy-commit-correlation); VI bodies are common with EN descriptions; one skill (f1genz-client-local-harness) has VI without diacritics.
- **Structure**: several managed skills have no H1 (cf-hostname-migrate, cloudflare-account-token-create-clipboard-only, cloudflare-worker-local-smoke-windows); none uses `references/` although 5 skills ≥ 80 lines mix contracts; the 6 vendor skills use references well but carry 3 oversized files (>300 lines: cloudflare flagship/patterns 469, flagship/api 390, durable-objects/workers.md 346).
- **Vendor Haravan skill vs operational skills**: haravan-app Security Policy refuses live-credential use and answers in "user's language"; Tài's operational skills use private tokens and the root contract mandates Vietnamese.
- **Volatile facts embedded**: dated "verified 2026-11-07/13/11", customer anchor 161/253, URL counts 52/12/60, ledger 3.6 GB, session ids — move to dated reports.
