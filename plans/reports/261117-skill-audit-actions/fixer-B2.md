# Work order — fixer B2 (F1GENZ apps / Cloudflare part 2 (+ Haravan inventory/Pancake ops))

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-B2.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = B2). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### haravan-inventory-write-safety
- class: **OWNER**; scout cluster B2; roots: managed; SKILL.md 71 lines; desc 232 chars; uses30d(sessions): 0; descQ 4/5; lang desc EN, body VI (diacritics ok)
- action: Absorb stock-load + false-halt as references; add DoD (Σ before/after printed) and "Not for: read-only audits (see invariant-audit)"
- scout verdict text: KEEP as OWNER
- stale/verified: `scripts/lib/inventory-ledger.ts`, `import-stock.ts`, `clear-committed.ts`, `reconcile-inventory.ts` exist in `E:/Work/apps/F1GENZ MultiSync/scripts`; `data/*.halt/.stop` markers not checked (runtime files)
- structure: no DoD; no "not for"; mixes rules with measured facts (11 s lag, 3.6 GB ledger)
- overlap: haravan-stock-load-after-legacy-ledger (section 4 = same import-stock modes); haravan-ledger-false-halt-triage (section 2 lag = same fact); outside cluster: haravan-inventory-ledger-forensics, haravan-inventory-invariant-audit
- absorbs: haravan-ledger-false-halt-triage, haravan-stock-load-after-legacy-ledger
### kaizen-readonly-app-audit
- class: **OWNER**; scout cluster B2; roots: managed; SKILL.md 40 lines; desc 188 chars; uses30d(sessions): 0; descQ 2/5; lang desc EN with VI quote (diacritics ok), body EN
- action: Rewrite description: owned action + when + "Not for: fixes, deploy"; absorb recommend as `references/recommend.md`; unify report contract line
- scout verdict text: KEEP as OWNER (REWRITE desc)
- contradiction: report contract differs from recommend ("STATUS:" vs leader-report/1 + notChecked)
- structure: description is not "Use when ..."; trigger quote only; no "not for"; description-trigger warn
- overlap: recommend-readonly-kaizen-audit (app-specific copy of steps 1-6)
- absorbs: recommend-readonly-kaizen-audit
### multisync-order-lineitem-diagnose → rename `multisync-order-diagnose`
- class: **OWNER**; scout cluster B2; roots: managed; SKILL.md 63 lines; desc 202 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Rename to `multisync-order-diagnose`, add "Use when / Not for: write fixes" to description, include brief as reference
- scout verdict text: KEEP as OWNER
- stale/verified: same repo/file checks as above; sample counts 1.098/1.548 (dated)
- structure: 2 ERR-links, description-trigger warn (no Use when)
- overlap: brief (see above)
- absorbs: multisync-order-customer-brief
### redis-cloud-exit-runbook
- class: **OWNER**; scout cluster B2; roots: managed; SKILL.md 48 lines; desc 258 chars; uses30d(sessions): 0; descQ 3/5; lang VI body, EN desc
- action: Absorb the two dashboard skills; tighten desc to Use when + Not for; label "historical" if subscription is already closed
- scout verdict text: KEEP as OWNER
- stale/verified: `E:/Work/scratch/leader/261107-ml-review-db-exit/tools/redis-dump.cjs` EXISTS (verified); token-hunt result "no provisioning token" dated, so volatile
- contradiction: none besides the above
- structure: VI/EN mix; description-trigger warn; dated lessons "07/11/2026"
- overlap: cancel-antifan, dashboard-delete, migration-prep
- absorbs: redis-cloud-cancel-antifan, redis-cloud-dashboard-db-delete-antifan
### worker-origin-discrimination
- class: **OWNER**; scout cluster B2; roots: managed; SKILL.md 25 lines; desc 183 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Own SKILL.md of merged skill
- scout verdict text: MERGE→worker-cutover-proof owner
- stale/verified: none by path
- structure: description-trigger warn; no "Use when" opener
- overlap: verify-worker-webhook-cutover
- absorbs: backend-cutover-origin-proof, cf-worker-deploy-commit-correlation, verify-worker-webhook-cutover
### haravan-login-via-otp
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 38 lines; desc 194 chars; uses30d(sessions): 13; descQ 4/5; lang EN, VI quotes with diacritics
- action: Split: SKILL.md (authority, secrets rule, 9 steps, DoD = `hrv theme info --json` ok) + `references/telegram-otp.md` (topic click by coords, activate tab, probe) + `references/pitfalls.md`; drop dated narrative; secrets: no value, but names Trello-card password handling (type only)
- stale/verified: `E:/Work/AGENTS.md` section 8 bullet "Đăng nhập Haravan do Leader duyệt" exists (line 140); `scripts/leader/hrv-whoiam-find.mjs`, `shop-org-resolve.mjs`, `shop-folder-index.mjs` exist; `scratch/leader/261109-2344-otp-automation` cited as "designed not deployed" (exists with only SKILL.draft.md/auto.prompt.md); telegram group id hardcoded line 15 (volatile)
- contradiction: none (consistent with AGENTS section 8: one login per job, no hrv theme dev)
- structure: postmortem log style ("verified 09/11", "Kaizen 13/11", "Pitfalls seen"); emphasis-no-reason; Telegram/clipboard tricks inline
- overlap: none in cluster; neighbours outside: haravan-partners-switch-account, antifan-leader-worker-round
### haravan-order-migration-audit
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 39 lines; desc 278 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Align scratch policy to %TEMP%; trim description to trigger + not-for; keep body
- scout verdict text: REWRITE light
- stale/verified: `PANCAKE_ATTRIBUTE_NAMES`, `resolveWarehouseRoute` symbol names not verified; says writes throwaway scripts to `scripts/_tmp-*`
- contradiction: CONFLICT: tells to put scripts in `scripts/_tmp-*` while multisync-order-* skills say throwaway goes to `%TEMP%` never `scripts/`/`reports/` (AGENTS section 15 scope lock)
- structure: description too long and lists contents instead of trigger; no DoD
- overlap: multisync-order-* (different intent: they diagnose one order); haravan-per-line? no
### haravan-webhook-not-processed-triage
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 16 lines; desc 168 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Add H1, activation boundary, DoD; generalise root cause (numeric org_id) into a checklist; link to verify-worker-webhook-cutover for delivery proof
- stale/verified: none by path
- structure: no H1 and no intro; no "not for"; is a Multiform-specific incident ("proven on Multiform 2026-11") presented as generic
- overlap: verify-worker-webhook-cutover (webhook proof, different phase), worker-origin-discrimination
### ml-visual-translate-local-demo
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 56 lines; desc 303 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Split to references (harness, clone-theme, cross-window test); once feat/visual-translate is deployed, retire the local harness part
- scout verdict text: REWRITE (or ARCHIVE after feature ships)
- stale/verified: worktrees `.worktrees/visual-translate-worker` exists (verified); ports 8787/5183 pinned; `scratch/visual-dev/` deleted per run by design (fragile, per skill); `proc://visual-dev-worker/kill`
- contradiction: none; real token in `.dev.vars` handled
- structure: description 303 chars with feature list; worktree-and-port bound; writes to REAL shop, warned
### multiform-prod-deploy-and-shard-migrate → rename `multiform-prod-deploy`
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 51 lines; desc 174 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Make it the single `multiform-prod-deploy`: Deploy (clean worktree), demo-plan, check pass; delete the dated state header; split Read-only smoke + ShopDO migration into references
- scout verdict text: REWRITE as OWNER
- stale/verified: VERIFIED STALE: repo HEAD is `b3852cc` (2026-11-16), `worker/drizzle` now has `0013_staff_management.sql`; `worker/src/billing/demo-plan.ts` exists; scratch template path `scratch/load-secrets/demo-plan-token.txt` (dir exists, file absent = deleted by design)
- contradiction: verify duration "about 6 min" in ship vs "2-5 min" in clean-worktree; push before deploy (ship) vs after (here)
- structure: volatile header "State as of 2026-11-12: main 3e2ec04, version bf3c4887, 29 files 412 tests, migrations through 0011"
- overlap: ship-and-plan-grant (demo-plan section duplicated), clean-worktree-deploy (Deploy section duplicated), ml-worker-client-deploy
- absorbs: multiform-clean-worktree-deploy, multiform-ship-and-plan-grant
### pm2-deploy-502-window-measure
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 34 lines; desc 205 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: If PM2 apps still deploy (CheckOrders per vps-secret-rotation), keep generic version without ML/ml-deploy references; else archive with ml-prod-measure
- scout verdict text: REWRITE or RETIRE
- stale/verified: `deploy/ml-deploy.sh` refers to retired ML NestJS stack; `C:/Program Files/Git/bin/bash.exe` ok
- structure: ML-specific (ml-deploy.sh, F1GENZ VPS) while title generic
- overlap: ml-prod-measure (same data)
### prod-db-baseline-backup
- class: **REWRITE**; scout cluster B2; roots: managed; SKILL.md 17 lines; desc 187 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Remove Supabase/Redis Cloud specifics or mark historical; keep manifest/sha256/restore-test pattern; add DoD
- stale/verified: Supabase projects deleted (supabase-dead-verify-probe) so Supabase parts are historical; `C:/Program Files/PostgreSQL/17/bin/pg_dump.exe` not checked
- structure: 17 very dense lines, no sections, references `/root/backups-261031/` and `bk261031_*` dated names
- overlap: redis-cloud-exit-runbook (dump step), vps-baseline
### haravan-membership-ledger-repair
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 35 lines; desc 193 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Make it the OWNER of the "customer import" write recipe; reference haravan-customer-app-ledger-read for read endpoints instead of re-listing; add "Not for: refund/relocation runs"
- scout verdict text: KEEP (REWRITE light)
- stale/verified: none verifiable by path; references `customers.haravan.app` iframe
- structure: no H1 convention issue; standard-sections warn; "Repair (needs explicit user approval)" good, no DoD
- overlap: split-customer-consolidation section 3 (same import UI steps); haravan-customer-app-ledger-read (outside, read endpoints duplicated in section "Read ledgers"); returned-orders-refund-run (same ledger cause, different fix)
### haravan-per-line-discount-report
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 26 lines; desc 147 chars; uses30d(sessions): 2; descQ 4/5; lang desc EN, body EN (VI UI labels with diacritics)
- action: Add one-line "Not for: voucher discount (use standard export)"; add verification date policy
- stale/verified: facts dated 2026-11-12 (volatile but labelled)
- structure: clean, short, no DoD
### haravan-returned-orders-refund-run
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 36 lines; desc 186 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move run stats/pending targets to a dated note; keep steps + gotchas; add DoD (0 paid, held==expected) and cross-link to membership-ledger-repair
- scout verdict text: KEEP (trim)
- stale/verified: none by path; account 1176404469 guest id also in lineitem/brief skills (consistent)
- contradiction: none; approval gates present
- structure: stale numbers in body ("4,577 + 455 orders", pending targets -56.57bn debt, 185bn cash) = volatile facts; emphasis-no-reason
- overlap: haravan-split-customer-consolidation and membership-ledger-repair (same ledger family), haravan-bulk-settle-committed (outside)
### haravan-split-customer-consolidation
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 48 lines; desc 199 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Replace section 3 with link to membership-ledger-repair import recipe; replace section 1 with link to parity-trace; fix links
- stale/verified: `scripts/relocate-orders.ts` exists; org 200001202565 and `~/.haravan-cli.json` token source cited; `reports/membership-test/` path (project-local)
- contradiction: scratch: logs to `reports/membership-test/` vs multisync skills' "never reports/"
- structure: ERR-link, standard-sections
- overlap: membership-ledger-repair (import steps duplicated); pancake-haravan-customer-parity-trace (section 1 map duplicated, even same "6 min" scan)
### ml-do-datastudio-shop-datafix
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 40 lines; desc 161 chars; uses30d(sessions): 2; descQ 3/5; lang desc EN, body EN
- action: Rewrite description to "Use when owner approved fixing one shop's ShopDO rows...; Not for: bulk, deploy"; mark ml-ops-import-grant RETIRE (outside cluster)
- stale/verified: account dc25380a46ad0853b9b0d98ce7a74270 and DO namespace ids 9f09a626.../e6655072... hardcoded (identifiers not secrets; not verified live); `src/ops/import.ts` stated "no longer deployed": `worker/src/ops` absent in repo (verified) ok; `COUNT_COLUMNS_SQL` in `resource-status.ts:104` not verified; email support@f1genz.com appears
- contradiction: f1genz-ml-ops-import-grant describes `MIGRATION_IMPORT_TOKEN` route this skill says is gone: ml-ops-import-grant is stale
- structure: description starts with product name, not trigger; no DoD (verify step 6 is DoD in practice)
- overlap: f1genz-ml-ops-import-grant (outside, older route, now removed)
### ml-prod-health-check
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 34 lines; desc 218 chars; uses30d(sessions): 0; descQ 3/5; lang desc EN, body VI (diacritics ok)
- action: Becomes the single MultiLanguage prod-probe skill; remove step 6 VPS ssh or mark optional legacy; absorb probes from ml-worker-client-deploy step 4
- stale/verified: `worker/src/edge-routing.ts` UNGUARDED_ROUTES exists (file present in worker/src); VPS 178.128.216.88 + `ssh root@` command (volatile); shop m-n-bakery/product id hardcoded
- contradiction: DIRECT with ml-prod-measure: health says "no PM2 ML process, no Supabase/PG/Redis"; measure says ML API runs on VPS :3010 with Supabase pooler and BullMQ
- structure: description lists probes not trigger; mixed VI/EN body
- overlap: ml-prod-measure-and-deploy-proof (retired) ; ml-worker-client-deploy (post-deploy probes duplicated)
### ml-worker-client-deploy
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 44 lines; desc 188 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Make it the OWNER of MultiLanguage deploy; reference ml-prod-health-check for post-deploy probes; extract shared F1GENZ Cloudflare env prelude
- stale/verified: repos/branches `master` / `main` and project names cited, unverified live; `javascript-obfuscator 5.3.0` version volatile; `backups/storefront-js-source/` not checked
- structure: long lines, step 6-7 very dense; no "not for"
- overlap: ml-prod-health-check (probes); multiform deploy skills (same pattern: manual wrangler deploy with `*_F1GENZ` env)
### nest-backend-to-do-sqlite-port
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 52 lines; desc 188 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Add DoD and "Not for: greenfield DO work"; link to durable-objects skill
- stale/verified: no path to verify; consistent with real ML migration
- structure: pattern doc, no "not for"; mentions `scout-contract.md` style artifacts
- overlap: workers-best-practices, durable-objects (outside); ml-do-datastudio is post-port ops
### opennext-cloudflare-account-move
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 35 lines; desc 194 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Add DoD (canonical host, 200, no leaked URL) and "Not for: hostname .com to .dev"
- structure: no DoD; Shopify DNS IPs inlined (public, stable)
- overlap: cloudflare-pages-cname-bridge-matbao-dns (neighbour, different), cf-hostname-migrate-f1genz
### pages-support-form-email-turnstile
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 27 lines; desc 171 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Reference turnstile-spin for generic wiring; keep this as the Email Sending + Pages-secrets recipe; document why API path was rejected
- stale/verified: `E:/Work/master/src/pages/api/theme-support.ts` exists (verified); plans/reports dns-backup path pattern only
- contradiction: tension with turnstile-spin: Spin creates the widget by API token (Account.Turnstile:Edit), this skill says API/wrangler OAuth cannot and uses the dashboard UI
- structure: desc lacks not-for; standard-sections warn
- overlap: turnstile-spin (widget creation duplicated), cloudflare-email-service
### ps-worker-allowlist-update
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 73 lines; desc 211 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add DoD already present; add "Not for: PSI measuring"
- stale/verified: VERIFIED: `E:/Work/apps/F1GENZ_PageSpeed_API/src/index.js` has `getCorsHeaders` at line 34 (skill says ~34); `wrangler.jsonc:8` has `"keep_vars": true` (the trap is real); env `CLOUDFLARE_*_F1GENZ` used
- structure: solid; has verify and rollback; no "not for"
- overlap: pagespeed, agents/pagespeed (outside)
### sandbox-migrate-to-next
- class: **KEEP**; scout cluster B2; roots: agents,claude; SKILL.md 186 lines; desc 278 chars; uses30d(sessions): 3; descQ 5/5; lang EN
- action: Leave unmodified; track upstream (cloudflare/skills); present in .agents and .claude only
- scout verdict text: KEEP (vendor)
- stale/verified: doc links not checked live
- structure: upstream vendor skill; well structured, boundaries stated
- overlap: sandbox-next / sandbox-stable (explicit router pairs)
### sandbox-next
- class: **KEEP**; scout cluster B2; roots: agents,claude; SKILL.md 92 lines; desc 352 chars; uses30d(sessions): 4; descQ 5/5; lang EN
- action: Leave unmodified
- scout verdict text: KEEP (vendor)
- structure: vendor, gated
- overlap: sandbox-stable, migrate
### sandbox-stable
- class: **KEEP**; scout cluster B2; roots: agents,claude; SKILL.md 111 lines; desc 351 chars; uses30d(sessions): 3; descQ 5/5; lang EN
- action: Leave unmodified
- scout verdict text: KEEP (vendor)
- structure: vendor, gated
- overlap: sandbox-next, migrate
### sepay-webhook-go-live
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 33 lines; desc 157 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add "Not for: other payment providers (ak-payment-integration)"
- stale/verified: VERIFIED: `E:/Work/VidAff/src/web/sepay.ts` exists; "profile-2" AntiFan profile name volatile
- contradiction: none; secret handling consistent (never echo; `void 0;` lesson)
- structure: standard-sections warn; Vi labels ok
- overlap: vidaff-* skills (outside)
### supabase-dead-verify-probe
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 41 lines; desc 161 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Merge as reference there if Supabase is gone for good; else just fix description
- scout verdict text: KEEP (REWRITE desc) or MERGE→f1genz-cloud-service-cancel-verify
- stale/verified: none by path
- structure: description not trigger ("reuse for any future") ; no quotes
- overlap: f1genz-cloud-service-cancel-verify (outside; same job), worker-origin-discrimination
### turnstile-spin
- class: **KEEP**; scout cluster B2; roots: agents,claude; SKILL.md 331 lines; desc 551 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Do not edit; if localising, shorten description; add Windows note in a sidecar file
- scout verdict text: KEEP (vendor)
- stale/verified: has scripts/, tests/, references/ present; not re-run
- contradiction: requires API token vs the dashboard route in pages-support
- structure: vendor skill; SKILL.md over 300 lines (oversized-file); prohibition-run cruft; description 551 chars and includes "persist the skill"; script-platform-notes warn (scripts need curl/bash on Windows)
- overlap: pages-support-form-email-turnstile (see above)
### verify-http-route-params-before-docs
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 28 lines; desc 216 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add "Not for: writing API docs from source only"
- structure: description-trigger warn; has Pitfalls
### vps-baseline-for-cloudflare-gate
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 72 lines; desc 217 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: If all apps migrated, move to archive-references; otherwise add DoD (script reproduces numbers)
- scout verdict text: KEEP (check relevance)
- stale/verified: `/etc/cloudflared`, nginx/pm2 facts are VPS state; gate is a "Cloudflare must be better" decision that may be closed
- structure: description-trigger warn; very long, but coherent
- overlap: prod-db-baseline-backup, ml-prod-measure
### vps-env-encrypted-export-via-actions
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 17 lines; desc 153 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Keep apart (read vs write authority) but cross-link; add DoD (workflow removed, run deleted)
- stale/verified: note "pushing workflow to main may trigger deploy" good
- contradiction: none; consistent with never-print rule
- structure: standard-sections warn; no DoD
- overlap: vps-secret-rotation-via-github-actions (same mechanism)
### vps-secret-rotation-via-github-actions
- class: **KEEP**; scout cluster B2; roots: managed; SKILL.md 47 lines; desc 229 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Fix broken links; add DoD already in section 4
- stale/verified: `F1GENZ/Haravan-Server--CheckOrders` repo and `scripts/merge-env.js` not verified; `rg --files -uu` line fine
- contradiction: "Deleting originals needs approval; archive with `7z -mhe=on`" consistent with no-rm rule
- structure: ERR-links 2, standard-sections
- overlap: export-via-actions
### workers-best-practices
- class: **KEEP**; scout cluster B2; roots: agents,claude; SKILL.md 128 lines; desc 359 chars; uses30d(sessions): 14; descQ 4/5; lang EN
- action: Leave unmodified
- scout verdict text: KEEP (vendor)
- stale/verified: docs URLs not live-checked
- structure: vendor; emphasis-no-reason ("FIRST:" etc.); oversized-file flag points to references; no not-for beside wrangler
- overlap: wrangler, durable-objects, cloudflare (outside)
### wrangler
- class: **KEEP**; scout cluster B2; roots: agents,claude; SKILL.md 923 lines; desc 336 chars; uses30d(sessions): 10; descQ 4/5; lang EN
- action: Leave unmodified; flag as largest context hog; consider loading only on demand
- scout verdict text: KEEP (vendor)
- stale/verified: upstream; `wrangler check startup` etc. unchecked
- structure: oversized (923 lines) vendor skill, single file, no references split
- overlap: workers-best-practices, cloudflare skill
### backend-cutover-origin-proof
- class: **MERGE** → `worker-origin-discrimination`; scout cluster B1; roots: managed; SKILL.md 23 lines; desc 152 chars; uses30d(sessions): 0; descQ 2/5; lang desc EN-quoted, body VI w/ diacritics
- action: move steps 1-4 as discriminator method; steps 5-6 (shared-infra grep, CI `disabled_manually`) → `references/pre-delete-gates.md`; delete this skill
- scout verdict text: MERGE→worker-origin-discrimination
- stale/verified: none found; cites no local paths
- structure: description lacks "Use when" trigger (std-warn); no standard sections; one dense numbered list
- overlap: worker-origin-discrimination (near-duplicate, other cluster); f1genz-cloud-service-cancel-verify step 2
### cf-worker-deploy-commit-correlation
- class: **MERGE** → `worker-origin-discrimination`; scout cluster B1; roots: managed; SKILL.md 28 lines; desc 184 chars; uses30d(sessions): 2; descQ 4/5; lang VI (with diacritics) — only VI description in cluster
- action: becomes `references/commit-correlation.md`
- scout verdict text: MERGE→deploy-truth owner (worker-origin-discrimination)
- structure: description lacks "Use when" (std-warn); ok size
- overlap: backend-cutover-origin-proof, cf-pages-deploy-regression-triage, worker-origin-discrimination
### haravan-ledger-false-halt-triage
- class: **MERGE** → `haravan-inventory-write-safety`; scout cluster B2; roots: managed; SKILL.md 37 lines; desc 219 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move to `references/false-halt-triage.md`; keep description trigger as owner's conditional; fix the broken link
- scout verdict text: MERGE→haravan-inventory-write-safety
- stale/verified: `scripts/lib/inventory-ledger.ts` exists; `data/<tool>-inv.halt` path pattern consistent with write-safety section 6
- structure: one ERR-link (std-warn); no DoD besides "Reporting"
- overlap: write-safety (lag evidence duplicated, 11.5 s vs 11 s)
### haravan-stock-load-after-legacy-ledger
- class: **MERGE** → `haravan-inventory-write-safety`; scout cluster B2; roots: managed; SKILL.md 38 lines; desc 175 chars; uses30d(sessions): 0; descQ /5; lang EN
- action: Move to haravan-inventory-write-safety/references/stock-load.md; keep one "onhand := counted + committed" explanation
- scout verdict text: MERGE→haravan-inventory-write-safety
- overlap: haravan-inventory-write-safety
### multiform-clean-worktree-deploy
- class: **MERGE** → `multiform-prod-deploy-and-shard-migrate`; scout cluster B2; roots: managed; SKILL.md 18 lines; desc 132 chars; uses30d(sessions): 2; descQ 2/5; lang EN
- action: Fold steps 1-6 into owner; keep "Alert channels" paragraph as `references/alerts.md`; verify cfargotunnel claim before keeping
- scout verdict text: MERGE→multiform-prod-deploy-and-shard-migrate
- stale/verified: `E:/Work/apps/F1GENZ Multiform` exists; account id line 6 identifier; repo HEAD is now b3852cc (2026-11-16) so nothing version-bound here
- contradiction: order: "remove worktree then git push" same as prod-deploy, opposite of ship (push first)
- structure: no H1, no sections, description 132 chars no trigger; DNS note about cfargotunnel CNAME = unverified stale risk
- overlap: multiform-prod-deploy-and-shard-migrate (Deploy section is identical steps) ; multiform-ship-and-plan-grant
### multiform-live-form-e2e-antifan
- class: **MERGE** → `multiform-live-e2e-antifan`; scout cluster B2; roots: managed; SKILL.md 17 lines; desc 185 chars; uses30d(sessions): 3; descQ 2/5; lang EN
- action: Combine as one skill with `references/form-e2e.md` and `references/staff-e2e.md`; shared preconditions (demo shop only, tabId rules)
- scout verdict text: MERGE→multiform-live-e2e-antifan (new name)
- stale/verified: app admin URL id e3dd315f7e38a035fd1675910b5c6e78 and page id 1004525864 hardcoded (volatile)
- structure: no H1, no sections, 17 dense lines; description 185 chars lacks trigger/not-for
- overlap: multiform-live-staff-e2e-antifan (same shop, same tooling)
### multiform-live-staff-e2e-antifan
- class: **MERGE** → `multiform-live-e2e-antifan`; scout cluster B2; roots: managed; SKILL.md 20 lines; desc 227 chars; uses30d(sessions): 2; descQ 2/5; lang EN
- action: See above
- scout verdict text: MERGE→multiform-live-e2e-antifan
- stale/verified: same hardcoded ids; lead ids c2d91152... c81d744a... volatile test data
- structure: same as above; open decision about role deletion in text
- overlap: multiform-live-form-e2e-antifan
### multiform-ship-and-plan-grant
- class: **MERGE** → `multiform-prod-deploy-and-shard-migrate`; scout cluster B2; roots: managed; SKILL.md 29 lines; desc 186 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Keep unique bits (plan-pricing.ts caveat, DevOnly routes, 24e5 minify tip) in references; drop duplicate steps
- scout verdict text: MERGE→multiform-prod-deploy-and-shard-migrate
- stale/verified: `E:/Work/apps/F1GENZ Multiform/worker/src/billing/demo-plan.ts` exists; `client/src/lib/plan-pricing.ts` and Partners plan ids not verified
- contradiction: DEPLOYS FROM WORKING TREE after push vs prod-deploy clean worktree (so BUILD_SHA matches); conflict on safe procedure
- structure: description 186 chars, no not-for; owner standing instruction dated 2026-11-14 inlined
- overlap: prod-deploy-and-shard-migrate (both deploy and plan grant)
### multisync-order-customer-brief
- class: **MERGE** → `multisync-order-lineitem-diagnose`; scout cluster B2; roots: managed; SKILL.md 65 lines; desc 205 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Move sections 1-3 and 6 to `references/customer-linkage-brief.md`; fix AGENTS cite to E:/Work/AGENTS.md section 15
- scout verdict text: MERGE→multisync-order-lineitem-diagnose
- stale/verified: `E:/Work/apps/F1GENZ MultiSync` exists; `scripts/relocate-orders.ts`, `scripts/lib/quarantine-order-payload.ts` exist; `data/migration_ledger.sqlite` not checked live; cites "AGENTS.md section 15" but MultiSync has no AGENTS.md (verified missing); the rule is in E:/Work/AGENTS.md line 210
- structure: 2 ERR-links; covers two intents (Q&A brief + line-item diagnosis); body hardcodes counts (~200k rows, 627 products, ~20% quarantined)
- overlap: multisync-order-lineitem-diagnose (sections 4-6 near copy)
### pancake-haravan-customer-parity-trace
- class: **MERGE** → `pancake-haravan-customer-parity`; scout cluster B2; roots: managed; SKILL.md 36 lines; desc 227 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Parity family: trace = single customer (SKILL.md), tier-scan = shopwide (`references/shopwide-scan.md`); shared "Pancake API quirks" block once
- scout verdict text: MERGE→pancake-haravan-customer-parity (new name)
- stale/verified: repo exists; `order-sync.processor.ts:82-84` line ref not re-verified (volatile); Pancake API facts dated 2026-10-28
- contradiction: scan "6 min" duplicates in split-customer
- structure: standard-sections warn; no DoD
- overlap: tier-parity-scan (shared Pancake quirks), split-customer-consolidation
### pancake-haravan-tier-parity-scan
- class: **MERGE** → `pancake-haravan-customer-parity`; scout cluster B2; roots: managed; SKILL.md 46 lines; desc 147 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: See above; point throwaway scripts to %TEMP%
- scout verdict text: MERGE→pancake-haravan-customer-parity
- stale/verified: none by path; instructs writing `reports/membership-test/_*.py`
- contradiction: scratch policy conflict (writes `_*.py` under reports/ vs multisync skills)
- structure: description 147 chars no Use-when; long recipe
- overlap: trace (shared Pancake quirks)
### recommend-readonly-kaizen-audit
- class: **MERGE** → `kaizen-readonly-app-audit`; scout cluster B2; roots: managed; SKILL.md 14 lines; desc 196 chars; uses30d(sessions): 0; descQ 2/5; lang VI instruction line in EN body
- action: `references/recommend.md` with the 5 scout slices, the SIMILAR SSR trap, GET-only rules
- scout verdict text: MERGE→kaizen-readonly-app-audit
- stale/verified: `E:/Work/apps/F1GENZ Recommend` exists; `f1genz-recommend` worker name not checked
- contradiction: report contract differs from generic
- structure: no H1, dense list, description no Use-when
- overlap: kaizen-readonly-app-audit (same steps)
### redis-cloud-cancel-antifan
- class: **MERGE** → `redis-cloud-exit-runbook`; scout cluster B2; roots: managed; SKILL.md 28 lines; desc 169 chars; uses30d(sessions): 0; descQ 3/5; lang VI
- action: `references/dashboard-ui.md` combining both UI flows with the PING verify + report contract
- scout verdict text: MERGE→redis-cloud-exit-runbook
- stale/verified: `cloud.redis.io` UI flow unverified live; plan likely already executed (2026-11-07 cancel)
- contradiction: CONTRADICTS dashboard-delete: says UI offers no per-DB delete when multi-DB (NEEDS_INPUT) vs dashboard-delete shows kebab Delete database works for Essentials; GUARD "no Cancel subscription" vs exit-runbook "cancel the subscription"
- structure: VI body, description VI with diacritics ok; no DoD beyond report contract
- overlap: redis-cloud-dashboard-db-delete-antifan (same UI action), exit-runbook (pre-conditions)
### redis-cloud-dashboard-db-delete-antifan
- class: **MERGE** → `redis-cloud-exit-runbook`; scout cluster B2; roots: managed; SKILL.md 35 lines; desc 267 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Same reference as above; keep Preconditions as the gate
- scout verdict text: MERGE→redis-cloud-exit-runbook
- stale/verified: UI selectors (`Composestyle__ModalOverlay`) volatile; flow unverified
- contradiction: see above
- structure: threat-language cruft ("Never ... even under clean everything"), description-trigger
- overlap: cancel-antifan
### verify-worker-webhook-cutover
- class: **MERGE** → `worker-origin-discrimination`; scout cluster B2; roots: managed; SKILL.md 37 lines; desc 237 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: New name `worker-cutover-proof`: origin discrimination (SKILL.md), webhook tail/ingest proof as `references/webhook-cutover.md`
- scout verdict text: MERGE→worker-origin-discrimination
- stale/verified: wrangler tail recipe fine; `taskkill` use is process-scoped
- structure: description-trigger warn; "A to B" glyph replaced in desc ("- *.f1genz.dev")
- overlap: worker-origin-discrimination (same cutover family), haravan-webhook-not-processed-triage
### ml-prod-measure-and-deploy-proof
- class: **RETIRE**; scout cluster B2; roots: managed; SKILL.md 48 lines; desc 236 chars; uses30d(sessions): 16; descQ 1/5; lang EN
- action: Archive; nothing to migrate except "push gate / 502 prober" ideas, already in pm2-deploy-502-window-measure
- stale/verified: VERIFIED MISSING: `E:/Work/scratch/ml-r2/run-vps.sh`, `ml-r11/vps.sh`, `ml-r3/item12-db.sh`, `scratch/leader/261102-ml-prod/tmp/leader-sw1-vps-call.sh`; ml-worker-client-deploy.md line 8 says the VPS/NestJS path of this skill "is retired"
- contradiction: contradicts ml-prod-health-check (VPS PG/Redis alive vs gone); ml-worker-client-deploy declares it retired
- structure: giant lines truncated by viewer (lines 12,15,16,19,20,22,23 over 768 bytes), dated incident narrative, stacked rules, 14 stale-count
- overlap: ml-prod-health-check; ml-worker-client-deploy; pm2-deploy-502-window-measure (same VPS deploy facts)
### redis-cloud-to-local-migration-prep
- class: **RETIRE**; scout cluster B2; roots: managed; SKILL.md 29 lines; desc 218 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Move the DUMP/RESTORE copy-tool pattern to a reference of redis-cloud-exit-runbook only if still needed; otherwise archive
- scout verdict text: RETIRE (archive)
- stale/verified: Redis Cloud was cancelled (exit-runbook dated 07/11/2026): migration finished or abandoned; container recipe `redis:8.6-alpine` historical
- structure: VPS IP 178.128.216.88 in title; "prepare only" clear; no DoD
- overlap: exit-runbook, prod-db-baseline-backup

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters (owner in bold)

1. **Haravan inventory ledger writes** -> owner **haravan-inventory-write-safety**
   - write-safety: three-variable table, async poll rule, freeze files, import modes (stays in SKILL.md)
   - haravan-stock-load-after-legacy-ledger -> `references/stock-load.md` (invariant, 5-step procedure, traps); delete its duplicated "onhand := counted + committed" explanation from section 4 of write-safety, keep one
   - haravan-ledger-false-halt-triage -> `references/false-halt-triage.md`; the owner description gains the trigger "HALT read-back mismatch"
   - outside cluster but same family: haravan-inventory-invariant-audit, haravan-inventory-ledger-forensics (read-only), haravan-ledger-false-halt-triage should link them.

2. **Pancake vs Haravan customer parity (read-only)** -> owner **pancake-haravan-customer-parity** (new name)
   - customer-parity-trace = SKILL.md (one customer); tier-parity-scan = `references/shopwide-scan.md`; shared "Pancake API quirks" block kept once. Both state the same 6 min / 20 min eval-kernel timeout trap.
   - split-customer-consolidation and membership-ledger-repair stay as separate WRITE skills (different authority) but must link to this owner for mapping, and split section 3 must link to membership-ledger-repair for the import recipe.

3. **MultiSync single-order questions** -> owner **multisync-order-lineitem-diagnose** (rename `multisync-order-diagnose`)
   - brief contributes live counts, ledger split, phone-link facts, deliverable shape -> `references/customer-linkage-brief.md`; sections 4-6 of brief are near copies of lineitem sections 2-6, delete.

4. **Multiform deploy** -> owner **multiform-prod-deploy-and-shard-migrate** (rename `multiform-prod-deploy`)
   - clean-worktree-deploy: steps 1-6 identical to owner "Deploy" -> delete; keep alert-channel/Email Service note in `references/alerts.md`
   - ship-and-plan-grant: demo-plan section duplicate -> delete; unique bits (plan-pricing.ts, DevOnly routes, 24e5 minify tip, "commit first because deploy bundles working tree") -> `references/ship-notes.md`
   - Must settle ONE order: gate -> commit -> clean worktree -> deploy -> smoke -> push -> CI watch (the owner order).

5. **Multiform live E2E on demo shop** -> owner **multiform-live-form-e2e-antifan** (rename `multiform-live-e2e-antifan`)
   - staff e2e -> `references/staff-e2e.md`; shared preconditions (demo shop only, fresh tab, tabId rule) in SKILL.md.

6. **Read-only prod audits** -> owner **kaizen-readonly-app-audit**; recommend-readonly-kaizen-audit -> `references/recommend.md`. ml-prod-health-check stays separate (probe sequence, not audit).

7. **MultiLanguage production** -> keep **ml-worker-client-deploy** (deploy) + **ml-prod-health-check** (probes); RETIRE ml-prod-measure-and-deploy-proof; ml-prod-health-check step 6 (VPS ssh) is the only remaining legacy touchpoint.

8. **Redis Cloud exit** -> owner **redis-cloud-exit-runbook**; cancel-antifan and dashboard-db-delete-antifan -> `references/dashboard-ui.md` (the two UI flows reconciled, see inconsistency below); migration-prep -> RETIRE (Redis Cloud cancelled 07/11).

9. **Cutover proof** -> owner **worker-origin-discrimination** (rename `worker-cutover-proof`); verify-worker-webhook-cutover -> `references/webhook-cutover.md`. haravan-webhook-not-processed-triage stays apart (diagnosis, not proof) with a link. verify-http-route-params-before-docs stays apart (docs-proof, generic).

10. **Legacy VPS/PM2 group** (all describe retired infra or a closed migration gate): ml-prod-measure-and-deploy-proof, pm2-deploy-502-window-measure, prod-db-baseline-backup, redis-cloud-to-local-migration-prep, vps-baseline-for-cloudflare-gate, supabase-dead-verify-probe. Action: one owner `legacy-vps-ops` (or archive) unless apps still deployed by PM2 (CheckOrders). Decide per skill: retire 2, rewrite 2 (pm2-502, prod-db-backup), keep 2.

11. **Turnstile** -> turnstile-spin (vendor) owns generic wiring; pages-support-form-email-turnstile owns the Email Sending part and links to Spin.

## (c) Rewrite candidates

1. **haravan-inventory-write-safety** (becomes owner of cluster 1): gap = no activation boundary / no "Not for", no DoD, measured facts mixed with rules; absorb stock-load and false-halt references; add a "dry vs live" decision table and an explicit definition-of-done (Σ onhand/committed/available before/after printed, zero rows with available < 0).
2. **multiform-prod-deploy** (cluster 4): gap = three skills with a contradictory order (push before vs after deploy, working tree vs clean worktree), dated header (main 3e2ec04, 0011 migration while repo is at b3852cc and 0013). Produce one canonical flow with DoD (BUILD_SHA read back + DB-reading GET).
3. **kaizen-readonly-app-audit** (cluster 6): gap = weak description (no Use-when/Not-for), report contract diverges from other skills; fold Recommend as reference; unify the leader-report/1 + notChecked contract so every audit skill cites one shared reference.
4. **haravan-login-via-otp**: gap = postmortem log tone, ~14 KB body in 38 lines, Telegram UI tricks inline; split into SKILL.md (authority, secret rules, steps, DoD) and references (telegram-otp, pitfalls). Keep the AGENTS section 8 authority line.

## (d) Cluster-level inconsistencies

- **Retired infra still taught as live**: ml-prod-measure (VPS, Supabase, BullMQ) contradicts ml-prod-health-check ("no Supabase/PG/Redis") and ml-worker-client-deploy ("retired"). VPS IP 178.128.216.88 hardcoded in 6 managed skills (ml-prod-health-check x2, redis-cloud-to-local-migration-prep, cf-hostname-migrate-f1genz, f1genz-cloud-service-cancel-verify, f1genz-hostname-inventory, f1genz-live-vs-build-audit).
- **Repeated F1GENZ Cloudflare env prelude** (`CLOUDFLARE_API_TOKEN_F1GENZ` / `_ACCOUNT_ID_F1GENZ`, "bash tool has it, eval kernel does not", "do not use `env VAR=`") copied into ml-prod-health-check, ml-worker-client-deploy, multiform-* (3), ps-worker-allowlist-update, recommend-readonly-kaizen-audit, kaizen-readonly-app-audit. Extract into ONE shared reference (e.g. `f1genz-cloudflare-env`) and link it.
- **Scratch/throwaway policy conflict**: multisync-* say `%TEMP%` only, never `scripts/`/`reports/` (AGENTS section 15); haravan-order-migration-audit uses `scripts/_tmp-*`; pancake-haravan-tier-parity-scan uses `reports/membership-test/_*.py`; split-customer logs in `reports/membership-test/`. Pick one.
- **Report contract divergence**: kaizen has "STATUS:" only; recommend has leader-report/1 + notChecked; redis-cancel/supabase use `STATUS: DONE|NEEDS_INPUT|FAILED` + json fence; verify-worker mentions notChecked. Per Leader rules (STATUS line 1, one leader-report/1 block, notChecked mandatory) all Leader-run skills need one shared reference.
- **Redis Cloud UI contradiction**: cancel-antifan says UI does not allow per-DB delete when multiple DBs (stop NEEDS_INPUT); dashboard-db-delete shows a kebab "Delete database" works on Essentials. Also cancel-antifan forbids Cancel subscription while exit-runbook/dashboard-delete say last DB delete ends billing.
- **Deploy order conflict**: multiform-ship (push first, deploy from working tree) vs prod-deploy (clean worktree, push after); verify duration 6 min vs 2-5 min.
- **Turnstile**: turnstile-spin needs an API token with Account.Turnstile:Edit, pages-support says wrangler OAuth cannot call the API and uses dashboard clicks.
- **Volatile facts embedded** (should be in dated notes, not skill bodies): multiform-prod-deploy header state; returned-orders-refund-run totals; ml-prod-measure counts and commit hashes; order counts in lineitem-diagnose (1.098/1.548 etc.); Pancake API quirks "verified 2026-10-28"; AntiFan profile names; app/page/lead ids in multiform-live-*.
- **Description convention**: only 8 of 50 begin with "Use when"; no skill in the cluster except sandbox-* and haravan-login-via-otp includes a not-for; 14 carry the ak-skill-creator description-trigger warning. All descriptions EN, bodies mix VI/EN; Vietnamese strings all carry diacritics (no missing-diacritics case found).
- **Structure**: skills with no H1/sections (multiform-clean, multiform-live-*, recommend, webhook-not-processed) are dense paragraph lists; 18 skills have the standard-sections warning; no skill has a DoD block. Line counts hide size: ml-prod-measure, haravan-login-via-otp, ml-visual-translate have lines of 1-5 KB each, so they exceed the 300-line budget by bytes.
- **Backups**: 43 managed-only skills have no VCS copy; vendor skills (sandbox-*, turnstile-spin, workers-best-practices, wrangler) exist in .agents and .claude, so merge/rename work should happen on the managed copies and record versions.
- **Secrets**: no credential values in any of the 50; identifiers only: CF account id dc25380a... (ml-do-datastudio:~11, multiform-clean:6), DO namespace ids (ml-do-datastudio), org id 200001202565 (split-customer), Telegram group id (haravan-login-via-otp:15), shop app ids (multiform-live-*:6), email support@f1genz.com (ml-do-datastudio), root@ssh to VPS (ml-prod-health-check, redis-cloud-exit-runbook).
