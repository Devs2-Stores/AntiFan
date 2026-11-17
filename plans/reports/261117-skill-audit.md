# Skill audit — 417 non-AgentKit skills (2026-11-17)

Scope: every skill installed for Tài outside AgentKit (`ak-*`, AgentKit-authored, claudekit-authored `ghpm`/`shopify`, and Superpowers process skills — see §0.3). Report-only: no skill file was edited. Detail files: `261117-skill-audit-detail/result-<cluster>.md` (per-skill scout tables), executable work orders: `261117-skill-audit-actions/fixer-<cluster>.md`.

## Executive summary

- **417 skills, ~90K characters of descriptions (~25K tokens) injected into every turn**, on top of ~110 AgentKit skills. Median SKILL.md is 45 lines, so the cost is breadth, not file size; the real size outliers are `antifan-leader` (67 KB in 179 lines), `furniture-reels` (38 KB + a 548-line reference), `wrangler` (923 lines, vendor).
- **Storage is the root cause of "scattered"**: 334 skills live only in `~/.omp/agent/managed-skills` (real dirs, no git, 331 with no repo source), 76 are duplicated in `~/.agents/skills` + `~/.claude/skills` (4 diverged: `haravan-accessibility` 44px vs 24px, `haravan-settings-schema`, `pagespeed` 376 vs 407 lines, `shopify`), 2 come from the AntiFan repo. Relative links to a shared `../references/` resolve only under `.agents`/`.claude`, not under managed-skills. `.claude/skills` also holds ghost dirs without SKILL.md (8 `sapo-theme-*`, `references/`, `ak-ak`, `ak-handover`).
- **Verdicts (416 + 1 inferred)**: KEEP 151, OWNER (keep and absorb others) 41, MERGE into an owner 123, REWRITE 80, RETIRE 22. After consolidation: **273 skills** (417 − 123 merged − 22 retired + 1 new router `muse-studio-ops`); P3 of the plan takes the *visible* catalog to ~190 and ≤14K tokens by moving rarely used runbooks out of the catalog (kongming advice, §6).
- **Usage (last 30 days, 5,859 sessions)**: 108 skills never referenced, 84 more in ≤2 sessions. Top: `furniture-reels` 357 sessions, `antifan-mcp-tab-health-check` 118, `f1genz-feedback-comment-post` 103, `antifan-leader-worker-round` 102, `ui-ux-pro-max` 90, `tiktok-studio-web-publish-antifan` 85, `antifan-leader` 78, `haravan` 66.
- **Mechanical standard (ak-skill-creator)**: 105/417 clean; 216 `standard-sections` (no boundary / done-when), 137 `description-trigger` (no "Use when"), 61 broken relative links (36 in `antifan-leader` alone), 13 oversized files, 19 broken asset links, lint_cruft: 83 findings (166 `emphasis-no-reason`, 17 threat-language). Only ~8-15% of descriptions have a not-for clause; almost none has a definition of done.
- **Truth drift is the bigger defect than style**: 15 skills still say "never run hrv" against `E:/Work/AGENTS.md` §8 (push `--nodelete` allowed since 03-04/11); 5 vendor design skills prescribe `prefers-reduced-motion`/44px against AGENTS §5; 5 Tường Studio/Finds skills and the golden-slot/content-team/page-engage/daily-status/posting-tokens skills describe channels deleted on 06/11; ML skills still teach Postgres/Redis/VPS after the 07/11 Cloudflare cutover; muagi skills (7 copies of one engine) omit that an expired `taphoa/hard-until.txt` makes the supervisor write a permanent `STOP`; 53 skills depend on gitignored `E:/Work/scratch` paths, many already missing; VPS IP in 6 skills and the Cloudflare env prelude in 20.
- **Decision**: one git repo as source (`E:/Work/skills`, flat `skills/<name>/`), installed by the existing installer pattern into managed-skills (+ a generated mirror to `~/.claude/skills`, because Claude Code was used on 2026-11-16, 10 sessions/30 d). Retire = move to `~/.omp/agent/skills/_retired/<name>/`, never delete. 10 parallel fixers, one per cluster, own disjoint dirs; the orchestrator alone installs, once per wave, behind gates incl. a routing eval on the real catalog.

## 0. Method, scope, caveats

0.1 Inventory: scanned 5 roots (`~/.omp/agent/skills`, `managed-skills`, `~/.claude/skills`, `~/.agents/skills`, `E:/Work/apps/AntiFan/skills`); no project-level `.omp/skills`/`.claude/skills` were found under the searched paths (a broad glob timed out — not proof of absence). Backups under `.antifan-skill-backups`, `.trash`, `.venv` ignored.
0.2 Tools run: `skill_standard_report.py --details` on managed, agents, repo roots; `lint_cruft.py --routing --json --min-level medium` on managed and agents roots; own regex secret scan, absolute-path existence scan, usage scan over 5,859 session JSONL (last 30 days) counting `skill://<name>` and `/skills/<name>/SKILL.md` mentions. 10 `task` scouts read each SKILL.md and verified cited paths; kongming reviewed the architecture.
0.3 Excluded: all `ak-*` (108), claudekit `ghpm` and `shopify` (name `ck:shopify`), `ak-cti-expert`/`ak-graphify` third-party-in-kit, Superpowers process skills (no on-disk copy under these roots; plugin-provided). **Included despite the name**: `ak-vault-env-consolidation` (user-authored; its `ak-` prefix collides with the kit namespace → rename `vault-env-consolidation` in P1 FHI) and `ak-ai-multimodal-native` (frontmatter name `ak:ai-multimodal-native` mismatches its dir; absent from the live catalog → fix or retire in FHI). `superpowers-omp-overlay` is user-authored and included.
0.4 Caveats: usage counts are mentions in session JSONL, an upper bound (system-prompt/skill-listing noise cannot be fully separated; `skill://` reads and SKILL.md path reads are the signal). Scouts verified paths by existence only; live Cloudflare/Haravan/VPS state was not probed. Scout verdicts are proposals with evidence per row in the detail files; where scouts disagreed the lock table in §4.3 decides.

## 1. Inventory (417 skills)

Columns: roots (a=.agents, c=.claude, M=managed, r=repo-source, o=.omp), SKILL.md lines, sessions in 30 days that referenced it, scout cluster, verdict. Per-cluster totals:

| cluster | skills | KEEP | OWNER | MERGE | REWRITE | RETIRE | work order |
|---|---|---|---|---|---|---|---|
| A1 | 38 | 12 | 4 | 10 | 11 | 1 | [fixer-A1.md](261117-skill-audit-actions/fixer-A1.md) |
| A2 | 38 | 14 | 0 | 11 | 9 | 4 | [fixer-A2.md](261117-skill-audit-actions/fixer-A2.md) |
| B1 | 51 | 21 | 5 | 11 | 13 | 1 | [fixer-B1.md](261117-skill-audit-actions/fixer-B1.md) |
| B2 | 50 | 23 | 5 | 13 | 7 | 2 | [fixer-B2.md](261117-skill-audit-actions/fixer-B2.md) |
| C | 47 | 20 | 3 | 12 | 9 | 3 | [fixer-C.md](261117-skill-audit-actions/fixer-C.md) |
| D | 42 | 10 | 5 | 23 | 2 | 2 | [fixer-D.md](261117-skill-audit-actions/fixer-D.md) |
| E1 | 34 | 13 | 3 | 7 | 8 | 3 | [fixer-E1.md](261117-skill-audit-actions/fixer-E1.md) |
| E2 | 34 | 7 | 3 | 9 | 10 | 5 | [fixer-E2.md](261117-skill-audit-actions/fixer-E2.md) |
| FHI | 58 | 25 | 9 | 17 | 6 | 1 | [fixer-FHI.md](261117-skill-audit-actions/fixer-FHI.md) |
| G | 25 | 6 | 4 | 10 | 5 | 0 | [fixer-G.md](261117-skill-audit-actions/fixer-G.md) |

Cluster ids: A1/A2 Haravan theme; B1/B2 F1GENZ apps/Cloudflare/Haravan ops; C AntiFan; D Sapo+Shopify; E1/E2 Gác content/video/TikTok/TTB; G muagi/Facebook; FHI Windows/OMP/Google/guides/vendor/misc.

| skill | roots | lines | uses30d | cluster | verdict |
|---|---|---|---|---|---|
| f1genz-client-layout-proof | M | 47 | 1 | A1 | REWRITE |
| f1genz-header-desktop-menu | a,c | 43 | 3 | A1 | KEEP |
| f1genz-live-vs-build-audit | M | 29 | 0 | A1 | REWRITE |
| f1genz-review | a,c | 174 | 14 | A1 | REWRITE |
| f1genz-theme-project-scaffold | M | 51 | 6 | A1 | KEEP |
| ghn-pagespeed-contract | M | 34 | 5 | A1 | MERGE→pagespeed |
| ghn-theme-lazyload-migration | M | 27 | 0 | A1 | MERGE→haravan-lazysizes-to-native |
| h2s-visual-parity-certify | M | 42 | 1 | A1 | KEEP |
| haravan | a,c | 192 | 66 | A1 | REWRITE |
| haravan-accessibility | a,c | 52 | 14 | A1 | REWRITE |
| haravan-admin-page-create-antifan | M | 58 | 3 | A1 | KEEP |
| haravan-antifan-full-site-sweep | M | 37 | 0 | A1 | KEEP |
| haravan-audit | a,c | 172 | 7 | A1 | REWRITE |
| haravan-botgate-parity-fix | M | 73 | 4 | A1 | OWNER→rename haravan-ps-botgate |
| haravan-collection-defect-sweep | M | 92 | 12 | A1 | KEEP |
| haravan-demo-data-audit | a,c | 35 | 5 | A1 | KEEP |
| haravan-demo-kit | a,c | 89 | 54 | A1 | OWNER |
| haravan-demo-live-seed | a,c | 42 | 3 | A1 | MERGE→haravan-demo-kit |
| haravan-empty-settings-render | M | 59 | 17 | A1 | REWRITE |
| haravan-ep2-preview-capture-antifan | M | 14 | 3 | A1 | MERGE→haravan-preview-screenshot |
| haravan-f1genztabs-hrv-live-test | M | 83 | 19 | A1 | KEEP |
| haravan-font-gate-and-dedupe | M | 49 | 0 | A1 | MERGE→haravan-ps-botgate |
| haravan-lazy-below-fold-proof | M | 32 | 2 | A1 | OWNER→rename haravan-lazy-images |
| haravan-lazysizes-to-native | M | 45 | 0 | A1 | REWRITE |
| haravan-menu-apply-admin-session | M | 41 | 5 | A1 | KEEP |
| haravan-overflow-debug | M | 52 | 2 | A1 | KEEP |
| haravan-pages | a,c | 16 | 3 | A1 | RETIRE |
| haravan-partners-reply-email | M | 37 | 3 | A1 | MERGE→haravan-partners-theme-submit |
| haravan-partners-store-bootstrap | M | 61 | 0 | A1 | KEEP |
| haravan-partners-switch-account | M | 29 | 7 | A1 | MERGE→haravan-partners-theme-submit |
| haravan-partners-theme-submit | a,c | 66 | 40 | A1 | OWNER |
| haravan-performance | a,c | 56 | 9 | A1 | REWRITE |
| haravan-preview-pagespeed-measurement | M | 31 | 11 | A1 | MERGE→pagespeed |
| haravan-preview-screenshot | a,c | 335 | 6 | A1 | REWRITE |
| haravan-product-recommend | a,c | 83 | 13 | A1 | REWRITE |
| haravan-ps-botgate-googlebot-exclusion | M | 55 | 3 | A1 | MERGE→haravan-ps-botgate |
| haravan-push-handoff-commands | M | 32 | 5 | A1 | MERGE→hrv-theme-push-fetch-syntax |
| haravan-recaptcha-intent-gate | M | 33 | 4 | A1 | KEEP |
| haravan-settings | a,c | 277 | 39 | A2 | REWRITE |
| haravan-settings-html-guide | M | 47 | 5 | A2 | MERGE→haravan-settings |
| haravan-settings-key-live-audit | M | 51 | 18 | A2 | KEEP |
| haravan-settings-schema | a,c | 62 | 61 | A2 | REWRITE |
| haravan-stitch-full-run | a,c | 78 | 14 | A2 | REWRITE |
| haravan-storefront-cart-qty-trace | M | 76 | 0 | A2 | KEEP |
| haravan-storefront-get-probes | M | 56 | 4 | A2 | KEEP |
| haravan-storefront-qa-proof-gate | M | 17 | 6 | A2 | MERGE→theme-qa-az |
| haravan-theme | a,c | 117 | 41 | A2 | KEEP |
| haravan-theme-dead-code-purge | M | 40 | 0 | A2 | KEEP |
| haravan-theme-harness-ab-verify | M | 50 | 3 | A2 | MERGE→haravan-theme-verify-without-watcher |
| haravan-theme-image-compression | M | 14 | 0 | A2 | KEEP |
| haravan-theme-niche-scan | M | 41 | 3 | A2 | KEEP |
| haravan-theme-verify-without-watcher | M | 69 | 2 | A2 | REWRITE |
| haravan-theme-vietnamese-localization | M | 32 | 0 | A2 | KEEP |
| haravan-thiet-lap-save-roundtrip | M | 31 | 2 | A2 | KEEP |
| haravan-upload-file | a,c | 196 | 30 | A2 | KEEP |
| hidden-popup-image-deferral | M | 28 | 2 | A2 | MERGE→pagespeed |
| improve-animations | c | 110 | 33 | A2 | REWRITE |
| levents-guide-pipeline | M | 36 | 2 | A2 | KEEP |
| levents-product-card-gallery-diagnosis | M | 15 | 0 | A2 | RETIRE |
| lighthouse-a11y-verification | M | 18 | 0 | A2 | MERGE→haravan-accessibility |
| liquid-theme-static-check | M | 54 | 16 | A2 | REWRITE |
| live-theme-interception-ab | M | 20 | 0 | A2 | MERGE→haravan-theme-verify-without-watcher |
| mnbakery-about-header-clearance | M | 11 | 0 | A2 | RETIRE |
| pagespeed | a,c | 376 | 28 | A2 | REWRITE |
| prove-floating-controls-hidden | M | 28 | 7 | A2 | MERGE→haravan-theme-verify-without-watcher |
| psi-bot-gate-and-lazy-verify | M | 34 | 0 | A2 | MERGE→pagespeed |
| psi-measure-proven-haravan | M | 23 | 0 | A2 | MERGE→pagespeed |
| s2-spa-sharp-theme-compression | M | 15 | 0 | A2 | RETIRE |
| site-clone | a,c | 219 | 5 | A2 | KEEP |
| stitch-chunked-generation | M | 32 | 0 | A2 | MERGE→haravan-stitch-full-run |
| storefront-translation-script-benchmark | M | 54 | 2 | A2 | REWRITE |
| theme-qa-az | a,c | 77 | 51 | A2 | REWRITE |
| theme-qa-critical-triage | M | 49 | 6 | A2 | MERGE→theme-qa-az |
| theme-worker-patch-and-zip | M | 78 | 13 | A2 | KEEP |
| tiny-product-image-qa | M | 33 | 2 | A2 | KEEP |
| web-perf | a,c | 202 | 3 | A2 | RETIRE |
| agents-sdk | a,c | 222 | 3 | B1 | KEEP |
| backend-cutover-origin-proof | M | 23 | 0 | B1 | MERGE→worker-origin-discrimination |
| cf-hostname-migrate-f1genz | M | 59 | 0 | B1 | REWRITE |
| cf-pages-deploy-regression-triage | M | 45 | 2 | B1 | KEEP |
| cf-pages-spa-safe-ship | M | 65 | 8 | B1 | REWRITE |
| cf-playground-model-spotcheck | M | 35 | 0 | B1 | KEEP |
| cf-staging-frozen-write-e2e | M | 60 | 0 | B1 | KEEP |
| cf-worker-deploy-commit-correlation | M | 28 | 2 | B1 | MERGE→worker-origin-discrimination |
| cf-worker-kaizen-ship-and-watch | M | 61 | 0 | B1 | OWNER |
| cf-worker-plain-var-update | M | 62 | 0 | B1 | MERGE→cf-worker-kaizen-ship-and-watch |
| cf-worker-prod-404-triage | M | 60 | 0 | B1 | OWNER |
| cloudflare | a,c | 249 | 7 | B1 | KEEP |
| cloudflare-account-token-create-clipboard-only | M | 21 | 6 | B1 | KEEP |
| cloudflare-dns-record-dashboard-ops | M | 42 | 2 | B1 | KEEP |
| cloudflare-email-service | a,c | 104 | 5 | B1 | KEEP |
| cloudflare-one | a,c | 177 | 3 | B1 | OWNER |
| cloudflare-one-migrations | a,c | 111 | 3 | B1 | MERGE→cloudflare-one |
| cloudflare-pages-cname-bridge-matbao-dns | M | 77 | 0 | B1 | MERGE→cf-hostname-migrate-f1genz |
| cloudflare-worker-local-smoke-windows | M | 16 | 2 | B1 | MERGE→local-worker-signed-in-ui-qa |
| durable-objects | a,c | 187 | 4 | B1 | KEEP |
| f1genz-app-host-404-triage | M | 70 | 4 | B1 | MERGE→cf-worker-prod-404-triage |
| f1genz-app-licence-lockout-triage | M | 39 | 3 | B1 | REWRITE |
| f1genz-checkorders-shop-install-verify | M | 40 | 3 | B1 | REWRITE |
| f1genz-client-local-harness | M | 38 | 4 | B1 | REWRITE |
| f1genz-client-worker-route-parity | M | 30 | 6 | B1 | KEEP |
| f1genz-cloud-service-cancel-verify | M | 54 | 2 | B1 | REWRITE |
| f1genz-feedback-ai-prompt-verify | M | 37 | 0 | B1 | KEEP |
| f1genz-feedback-comment-post | M,r | 38 | 103 | B1 | KEEP |
| f1genz-feedback-dashboard-triage | M | 21 | 11 | B1 | KEEP |
| f1genz-hostname-inventory | M | 52 | 0 | B1 | KEEP |
| f1genz-ml-ops-import-grant | M | 46 | 7 | B1 | KEEP |
| f1genz-ml-shop-state-readonly-triage | M | 93 | 2 | B1 | REWRITE |
| f1genz-multilanguage-theme-job-diagnose | M | 17 | 4 | B1 | REWRITE |
| f1genz-multisync-backfill-ops | M | 57 | 2 | B1 | REWRITE |
| f1genz-stock-script-offline-harness | M | 65 | 0 | B1 | KEEP |
| figforyou-amazon-page-check | M | 67 | 3 | B1 | OWNER |
| figforyou-prod-status-check | M | 45 | 0 | B1 | MERGE→figforyou-status-audit |
| figforyou-release | M | 39 | 0 | B1 | KEEP |
| figforyou-status-audit | M | 65 | 1 | B1 | OWNER |
| figforyou-verified-asin-batch | M | 60 | 3 | B1 | MERGE→figforyou-amazon-page-check |
| haravan-api-writability-probe | M | 74 | 0 | B1 | KEEP |
| haravan-app | a,c | 151 | 19 | B1 | REWRITE |
| haravan-app-feasibility | a,c | 13 | 3 | B1 | RETIRE |
| haravan-app-sms-otp | M | 36 | 0 | B1 | REWRITE |
| haravan-bulk-order-job-ops | M | 59 | 5 | B1 | KEEP |
| haravan-bulk-settle-committed | M | 43 | 2 | B1 | KEEP |
| haravan-customer-app-ledger-read | M | 101 | 2 | B1 | REWRITE |
| haravan-dat-ton-reconcile-and-release | M | 89 | 1 | B1 | REWRITE |
| haravan-embedded-app-auth-triage | M | 27 | 4 | B1 | KEEP |
| haravan-inventory-invariant-audit | M | 38 | 0 | B1 | MERGE→haravan-inventory-invariant-audit |
| haravan-inventory-ledger-forensics | M | 61 | 0 | B1 | MERGE→haravan-inventory-invariant-audit |
| haravan-inventory-write-safety | M | 71 | 0 | B2 | OWNER |
| haravan-ledger-false-halt-triage | M | 37 | 0 | B2 | MERGE→haravan-inventory-write-safety |
| haravan-login-via-otp | M | 38 | 13 | B2 | REWRITE |
| haravan-membership-ledger-repair | M | 35 | 0 | B2 | KEEP |
| haravan-order-migration-audit | M | 39 | 0 | B2 | REWRITE |
| haravan-per-line-discount-report | M | 26 | 2 | B2 | KEEP |
| haravan-returned-orders-refund-run | M | 36 | 0 | B2 | KEEP |
| haravan-split-customer-consolidation | M | 48 | 2 | B2 | KEEP |
| haravan-stock-load-after-legacy-ledger | M | 38 | 0 | B2 | MERGE→haravan-inventory-write-safety |
| haravan-webhook-not-processed-triage | M | 16 | 0 | B2 | REWRITE |
| kaizen-readonly-app-audit | M | 40 | 0 | B2 | OWNER |
| ml-do-datastudio-shop-datafix | M | 40 | 2 | B2 | KEEP |
| ml-prod-health-check | M | 34 | 0 | B2 | KEEP |
| ml-prod-measure-and-deploy-proof | M | 48 | 16 | B2 | RETIRE |
| ml-visual-translate-local-demo | M | 56 | 2 | B2 | REWRITE |
| ml-worker-client-deploy | M | 44 | 3 | B2 | KEEP |
| multiform-clean-worktree-deploy | M | 18 | 2 | B2 | MERGE→multiform-prod-deploy-and-shard-migrate |
| multiform-live-form-e2e-antifan | M | 17 | 3 | B2 | MERGE→multiform-live-e2e-antifan |
| multiform-live-staff-e2e-antifan | M | 20 | 2 | B2 | MERGE→multiform-live-e2e-antifan |
| multiform-prod-deploy-and-shard-migrate | M | 51 | 3 | B2 | REWRITE |
| multiform-ship-and-plan-grant | M | 29 | 2 | B2 | MERGE→multiform-prod-deploy-and-shard-migrate |
| multisync-order-customer-brief | M | 65 | 2 | B2 | MERGE→multisync-order-lineitem-diagnose |
| multisync-order-lineitem-diagnose | M | 63 | 0 | B2 | OWNER→rename multisync-order-diagnose |
| nest-backend-to-do-sqlite-port | M | 52 | 4 | B2 | KEEP |
| opennext-cloudflare-account-move | M | 35 | 2 | B2 | KEEP |
| pages-support-form-email-turnstile | M | 27 | 0 | B2 | KEEP |
| pancake-haravan-customer-parity-trace | M | 36 | 0 | B2 | MERGE→pancake-haravan-customer-parity |
| pancake-haravan-tier-parity-scan | M | 46 | 0 | B2 | MERGE→pancake-haravan-customer-parity |
| pm2-deploy-502-window-measure | M | 34 | 0 | B2 | REWRITE |
| prod-db-baseline-backup | M | 17 | 2 | B2 | REWRITE |
| ps-worker-allowlist-update | M | 73 | 0 | B2 | KEEP |
| recommend-readonly-kaizen-audit | M | 14 | 0 | B2 | MERGE→kaizen-readonly-app-audit |
| redis-cloud-cancel-antifan | M | 28 | 0 | B2 | MERGE→redis-cloud-exit-runbook |
| redis-cloud-dashboard-db-delete-antifan | M | 35 | 0 | B2 | MERGE→redis-cloud-exit-runbook |
| redis-cloud-exit-runbook | M | 48 | 0 | B2 | OWNER |
| redis-cloud-to-local-migration-prep | M | 29 | 0 | B2 | RETIRE |
| sandbox-migrate-to-next | a,c | 186 | 3 | B2 | KEEP |
| sandbox-next | a,c | 92 | 4 | B2 | KEEP |
| sandbox-stable | a,c | 111 | 3 | B2 | KEEP |
| sepay-webhook-go-live | M | 33 | 0 | B2 | KEEP |
| supabase-dead-verify-probe | M | 41 | 0 | B2 | KEEP |
| turnstile-spin | a,c | 331 | 5 | B2 | KEEP |
| verify-http-route-params-before-docs | M | 28 | 0 | B2 | KEEP |
| verify-worker-webhook-cutover | M | 37 | 0 | B2 | MERGE→worker-origin-discrimination |
| vps-baseline-for-cloudflare-gate | M | 72 | 0 | B2 | KEEP |
| vps-env-encrypted-export-via-actions | M | 17 | 0 | B2 | KEEP |
| vps-secret-rotation-via-github-actions | M | 47 | 2 | B2 | KEEP |
| worker-origin-discrimination | M | 25 | 0 | B2 | OWNER |
| workers-best-practices | a,c | 128 | 14 | B2 | KEEP |
| wrangler | a,c | 923 | 10 | B2 | KEEP |
| anti-direct | a | 34 | 22 | C | KEEP |
| antifan-ab-test-triage | M | 40 | 4 | C | MERGE→antifan-compiled-ab-test |
| antifan-app-restart | M | 76 | 43 | C | REWRITE |
| antifan-browser-fingerprint-probe | M | 49 | 4 | C | KEEP |
| antifan-compiled-ab-test | M | 28 | 7 | C | OWNER |
| antifan-daemon-host-restart | M | 48 | 5 | C | REWRITE |
| antifan-detach-reattach-debug | M | 31 | 2 | C | KEEP |
| antifan-detached-shutdown-job | M | 40 | 10 | C | MERGE→antifan-daemon-host-restart |
| antifan-dogfood-clone | a,c | 146 | 9 | C | REWRITE |
| antifan-dom-overlap-scan | M | 30 | 0 | C | KEEP |
| antifan-electron-upgrade | M | 47 | 2 | C | KEEP |
| antifan-facebook-page-post | M | 36 | 2 | C | MERGE→facebook-profile-post-antifan |
| antifan-haravan-verify-loop | M | 41 | 5 | C | MERGE→theme-qa-az |
| antifan-history-back-proof | M | 24 | 3 | C | KEEP |
| antifan-leader | M,r | 179 | 78 | C | REWRITE |
| antifan-leader-deploy-ship | M | 42 | 0 | C | MERGE→antifan-leader |
| antifan-leader-dispatch-worker-pane | M | 83 | 10 | C | MERGE→antifan-leader |
| antifan-leader-pagespeed-closeout | M | 103 | 2 | C | KEEP |
| antifan-leader-session-audit | M | 36 | 0 | C | KEEP |
| antifan-leader-wait-workers-polling | M | 24 | 4 | C | RETIRE |
| antifan-leader-worker-round | M | 35 | 102 | C | KEEP |
| antifan-mcp-benchmark | M | 47 | 6 | C | REWRITE |
| antifan-mcp-react-dashboard-ops | M | 35 | 0 | C | KEEP |
| antifan-mcp-tab-health-check | M | 67 | 118 | C | KEEP |
| antifan-partial-commit-shared-tree | M | 24 | 6 | C | KEEP |
| antifan-project-windows-matrix-ab | M | 48 | 3 | C | MERGE→antifan-project-windows-matrix-ab |
| antifan-project-windows-probe-run | M | 46 | 3 | C | MERGE→antifan-project-windows-matrix-ab |
| antifan-qa-baseline-receipt-loop | M | 35 | 5 | C | MERGE→antifan-qa-cockpit |
| antifan-qa-cockpit | a,c | 191 | 26 | C | REWRITE |
| antifan-qa-engine-fixture-probe | M | 49 | 3 | C | REWRITE |
| antifan-qa-scroll-artifact | M | 21 | 7 | C | MERGE→antifan-qa-cockpit |
| antifan-qa-verdict-qualification | M | 19 | 8 | C | MERGE→theme-qa-az |
| antifan-readonly-prod-spa-probe | M | 20 | 2 | C | KEEP |
| antifan-session-loss-triage | M | 52 | 4 | C | KEEP |
| antifan-stdio-mcp-driver | M | 45 | 42 | C | KEEP |
| antifan-terminal-daemon-loss-triage | M | 39 | 4 | C | KEEP |
| antifan-toolbar-action | M | 43 | 2 | C | REWRITE |
| ccs-delegation | a,c | 196 | 3 | C | RETIRE |
| electron-main-live-profiling | M | 74 | 6 | C | REWRITE |
| electron-minidump-symbolize | M | 39 | 0 | C | KEEP |
| local-worker-signed-in-ui-qa | M | 17 | 2 | C | OWNER |
| psi-antifan-serial-runner | M | 68 | 9 | C | KEEP |
| storefront-widget-cdn-bypass-verify | M | 40 | 0 | C | KEEP |
| test-browser-js-probe-offline-node | M | 48 | 2 | C | KEEP |
| tinymce-late-content-blank-after-f5 | M | 21 | 0 | C | MERGE→tinymce-react-init-race-harness |
| tinymce-react-init-race-harness | M | 34 | 0 | C | OWNER |
| worker-local-smoke-antifan-ui-qa | M | 15 | 2 | C | RETIRE |
| devs2-rebel-storefront-verify | M | 45 | 0 | D | REWRITE |
| rebel-demo-store-sync-qa | M | 93 | 9 | D | MERGE→shopify-demo-store-ops |
| sapo | a,c | 85 | 9 | D | OWNER |
| sapo-admin-theme-file-edit-antifan | M | 69 | 0 | D | OWNER |
| sapo-app | a,c | 65 | 18 | D | KEEP |
| sapo-app-feasibility | a,c | 13 | 3 | D | RETIRE |
| sapo-app-live-install-verify | M | 21 | 7 | D | OWNER |
| sapo-app-store-listing-fill-antifan | M | 52 | 2 | D | KEEP |
| sapo-editor-draft-key-fill | M | 37 | 1 | D | KEEP |
| sapo-editor-draft-setting-sweep | M | 40 | 5 | D | MERGE→sapo-editor-setting-sweep |
| sapo-editor-human-input-sweep | M | 50 | 0 | D | MERGE→sapo-editor-setting-sweep |
| sapo-final-showcase-package | M | 22 | 0 | D | MERGE→final-showcase |
| sapo-h2s-antifan-tool-feedback | M | 35 | 0 | D | MERGE→sapo-h2s-convert-verify |
| sapo-h2s-live-parity-sweep | M | 40 | 0 | D | MERGE→sapo-h2s-convert-verify |
| sapo-liquid | a,c | 62 | 4 | D | KEEP |
| sapo-review-app-antifan-feature-walkthrough | M | 28 | 6 | D | MERGE→sapo-app-live-install-verify |
| sapo-theme | a,c | 64 | 3 | D | KEEP |
| sapo-theme-edit-via-admin-editor | M | 15 | 0 | D | MERGE→sapo-admin-theme-file-edit-antifan |
| sapo-theme-install-real-test | M | 23 | 2 | D | KEEP |
| sapo-theme-quality | a,c | 58 | 10 | D | KEEP |
| sapo-theme-snippet-embed-verify | M | 38 | 2 | D | MERGE→sapo-admin-theme-file-edit-antifan |
| sapo-theme-workflow | a,c | 28 | 12 | D | MERGE→sapo |
| sapo-validation | a,c | 36 | 3 | D | RETIRE |
| shopify-demo-image-pipeline | M | 60 | 2 | D | KEEP |
| shopify-demo-store-seed | M | 90 | 0 | D | MERGE→shopify-demo-store-ops |
| shopify-liquid | a,c | 37 | 3 | D | MERGE→shopify-theme |
| shopify-password-store-lighthouse | M | 88 | 4 | D | KEEP |
| shopify-theme | a,c | 67 | 3 | D | OWNER |
| shopify-theme-accessibility | a,c | 21 | 11 | D | MERGE→shopify-theme-quality |
| shopify-theme-audit | a,c | 34 | 3 | D | MERGE→shopify-theme-quality |
| shopify-theme-cli | a,c | 78 | 3 | D | KEEP |
| shopify-theme-collection-page | a,c | 14 | 3 | D | MERGE→shopify-theme |
| shopify-theme-performance | a,c | 15 | 5 | D | MERGE→shopify-theme-quality |
| shopify-theme-product-page | a,c | 15 | 3 | D | MERGE→shopify-theme |
| shopify-theme-quality | a,c | 50 | 3 | D | OWNER |
| shopify-theme-sections | a,c | 15 | 3 | D | MERGE→shopify-theme |
| shopify-theme-seo-content | a,c | 15 | 3 | D | MERGE→shopify-theme-quality |
| shopify-theme-settings | a,c | 18 | 4 | D | MERGE→shopify-theme |
| shopify-theme-snippets | a,c | 14 | 3 | D | MERGE→shopify-theme |
| shopify-theme-store-readiness | a,c | 24 | 7 | D | MERGE→shopify-theme-quality |
| shopify-theme-store-submission | M | 90 | 3 | D | REWRITE |
| shopify-theme-templates | a,c | 14 | 3 | D | MERGE→shopify-theme |
| ai-image-studio | a,c | 121 | 35 | E1 | KEEP |
| ai-model-character-refs | M | 52 | 5 | E1 | OWNER |
| ai-model-reference-set-qa | M | 23 | 2 | E1 | MERGE→ai-model-character-refs |
| an-vat-autopilot-stall-triage | M | 114 | 0 | E1 | KEEP |
| an-vat-muse-cart-clip | M | 79 | 20 | E1 | REWRITE |
| an-vat-muse-lot-finalize | M | 29 | 8 | E1 | MERGE→an-vat-muse-cart-clip |
| an-vat-wan-voice-clip | M | 44 | 3 | E1 | MERGE→an-vat-muse-cart-clip |
| capcut-draft-test-harness | M | 39 | 2 | E1 | MERGE→capcut-draft-test-windows |
| capcut-draft-test-windows | M | 47 | 2 | E1 | OWNER |
| channel-rules-digest-refresh | M | 39 | 6 | E1 | KEEP |
| character-ref-revision-round | M | 45 | 2 | E1 | MERGE→ai-model-character-refs |
| customer-guide-narrated-video | M | 34 | 2 | E1 | KEEP |
| fb-reel-competitor-analysis | M | 32 | 3 | E1 | KEEP |
| furniture-reels | c | 242 | 357 | E1 | REWRITE |
| gac-channel-posting-tokens | M | 40 | 8 | E1 | KEEP |
| gac-content-team | M | 126 | 23 | E1 | REWRITE |
| gac-cut-channel | M | 47 | 2 | E1 | KEEP |
| gac-daily-status-check | M | 51 | 4 | E1 | REWRITE |
| gac-facebook-page-bulk-delete | M | 60 | 0 | E1 | KEEP |
| gac-golden-slot-coverage-check | M | 37 | 8 | E1 | KEEP |
| gac-golden-slot-fill-fleet | M | 44 | 2 | E1 | RETIRE |
| gac-lookbook-lot-rerender | M | 46 | 1 | E1 | KEEP |
| gac-new-tiktok-channel-setup | M | 37 | 2 | E1 | REWRITE |
| gac-offline-metric-reporter | M | 55 | 0 | E1 | RETIRE |
| gac-page-engage-agent-session | M | 48 | 3 | E1 | REWRITE |
| gac-telegram-alert-triage | M | 17 | 3 | E1 | KEEP |
| gac-workspace-state | M | 40 | 0 | E1 | RETIRE |
| gac-writer-backend-triage | M | 29 | 0 | E1 | KEEP |
| gateway-tts-capability-probe | M | 47 | 3 | E1 | REWRITE |
| identity-locked-character-from-footage | M | 43 | 0 | E1 | MERGE→ai-model-character-refs |
| instagram-web-caption-edit-antifan | M | 22 | 0 | E1 | KEEP |
| muse-account-login-recovery | M | 31 | 3 | E1 | MERGE→muse-studio-accounts |
| muse-studio-add-account | M | 59 | 2 | E1 | OWNER→rename muse-studio-accounts |
| muse-studio-app-ops | M | 100 | 5 | E1 | REWRITE |
| muse-studio-library-file-triage | M | 42 | 0 | E2 | MERGE→muse-studio-ops |
| muse-studio-project-cleanup | M | 37 | 0 | E2 | MERGE→muse-studio-ops |
| muse-studio-register-external-render | M | 58 | 0 | E2 | MERGE→muse-studio-ops |
| probe-9router-models | M | 46 | 3 | E2 | MERGE→gateway-tts-capability-probe |
| shopee-affiliate-add-facebook-page | M | 33 | 2 | E2 | MERGE→shopee-affiliate-media-info |
| shopee-affiliate-media-info-edit | M | 32 | 2 | E2 | OWNER→rename shopee-affiliate-media-info |
| shopee-reels-safe-cleanup | M | 46 | 9 | E2 | REWRITE |
| tiktok-shop-pdp-unavailable-triage | M | 30 | 11 | E2 | MERGE→tiktok-shop-share-link-check |
| tiktok-shop-share-link-audit | M | 49 | 2 | E2 | MERGE→tiktok-shop-share-link-check |
| tiktok-shop-share-link-check | M | 60 | 6 | E2 | OWNER |
| tiktok-studio-per-video-retention-read | M | 34 | 5 | E2 | KEEP |
| tiktok-studio-web-publish-antifan | M | 64 | 85 | E2 | REWRITE |
| ttb-code2d-reel | M | 61 | 19 | E2 | REWRITE |
| ttb-crosspost-reel | M | 36 | 8 | E2 | REWRITE |
| ttb-dash-tray-restart | M | 21 | 5 | E2 | REWRITE |
| ttb-muse-30s-reel | M | 93 | 13 | E2 | REWRITE |
| ttb-new-product-reel-brief | M | 32 | 28 | E2 | REWRITE |
| ttb-publish-reel-antifan-token | M | 23 | 5 | E2 | REWRITE |
| ttb-shopee-video-product-clip | M | 34 | 0 | E2 | KEEP |
| ttb-youtube-shorts-upload | M | 57 | 19 | E2 | KEEP |
| tts-pace-check-vclip | M | 33 | 3 | E2 | MERGE→vclip-adam-tts |
| tuong-finds-facebook-reel-post | M | 33 | 5 | E2 | RETIRE |
| tuong-finds-reel | M | 36 | 10 | E2 | RETIRE |
| tuong-studio-code-video | M | 31 | 28 | E2 | RETIRE |
| tuong-studio-long-film-qa | M | 38 | 12 | E2 | RETIRE |
| tuong-studio-post-approved-cut | M | 36 | 8 | E2 | RETIRE |
| tuong-vy-lot-prep-gates | M | 107 | 29 | E2 | REWRITE |
| tuong-vy-reference-clip | M | 76 | 10 | E2 | REWRITE |
| vclip-adam-tts | M | 103 | 4 | E2 | OWNER |
| vidaff-local-runtime-verify | M | 37 | 2 | E2 | KEEP |
| vidaff-price-change | M | 42 | 0 | E2 | KEEP |
| vidaff-production-paid-loop-verify | M | 31 | 0 | E2 | KEEP |
| wan-motion-reference-takes | M | 38 | 6 | E2 | MERGE→tuong-vy-reference-clip |
| wan-take-frame-audit | M | 34 | 0 | E2 | KEEP |
| 3dviz-pro-max | a | 137 | 2 | FHI | KEEP |
| agentkit-update-and-delta-measure | M | 85 | 2 | FHI | MERGE→update-agentkit-cli-and-kits |
| ak-ai-multimodal-native | c | 99 | 5 | FHI | REWRITE |
| ak-vault-env-consolidation | M | 39 | 4 | FHI | KEEP |
| amazon-associates-signup-antifan | M | 53 | 2 | FHI | KEEP |
| canva-mcp-connect | M | 50 | 0 | FHI | MERGE→omp-mcp-remote-oauth |
| cloud-db-redis-to-local-vps-bridge | M | 106 | 0 | FHI | KEEP |
| customer-theme-guide | a,c | 99 | 8 | FHI | MERGE→theme-handover-guide |
| customize-customer-guide | a,c | 19 | 6 | FHI | RETIRE |
| design-taste-frontend | a,c | 530 | 75 | FHI | KEEP |
| drive-upload-large-files-antifan-ui | M | 24 | 30 | FHI | MERGE→google-drive-antifan-ops |
| drive-upload-via-apps-script | M | 52 | 8 | FHI | MERGE→google-drive-antifan-ops |
| figma-desktop-mcp-http-python | M | 24 | 0 | FHI | MERGE→figma-mcp-analyze |
| figma-mcp-analyze | a,c | 98 | 4 | FHI | REWRITE |
| final-showcase | a,c | 165 | 20 | FHI | OWNER |
| final-showcase-export-rerun | M | 34 | 11 | FHI | MERGE→final-showcase |
| gh-pr-ci-verify-and-merge-safety | M | 40 | 2 | FHI | KEEP |
| git-worktree-orphan-recovery | M | 29 | 0 | FHI | KEEP |
| google-docs-docx-to-native-and-verify | M | 65 | 7 | FHI | MERGE→google-drive-antifan-ops |
| google-form-sheet | a,c | 155 | 6 | FHI | KEEP |
| google-sheet-bulk-paste-verify-antifan | M | 26 | 5 | FHI | KEEP |
| google-sheet-feedback-row-marking | M | 77 | 63 | FHI | KEEP |
| haravan-feedback-sheet-audit | M | 41 | 7 | FHI | OWNER |
| hrv-theme-push-fetch-syntax | M | 38 | 10 | FHI | OWNER |
| huashu-design | a,c | 216 | 60 | FHI | KEEP |
| impeccable | a,c | 86 | 69 | FHI | KEEP |
| levents-feedback-triage | M | 25 | 2 | FHI | MERGE→haravan-feedback-sheet-audit |
| llm-gateway-model-switch-bench | M | 35 | 3 | FHI | KEEP |
| npx-partial-install-repair | M | 49 | 0 | FHI | KEEP |
| omp-cache-hit-rate-report | M | 79 | 2 | FHI | KEEP |
| omp-mcp-remote-oauth | M | 63 | 0 | FHI | OWNER |
| omp-memory-store-supersede | M | 22 | 0 | FHI | KEEP |
| omp-provider-removal | M | 33 | 2 | FHI | KEEP |
| omp-session-audit | M | 67 | 14 | FHI | REWRITE |
| omp-session-jsonl-audit | M | 67 | 2 | FHI | MERGE→omp-session-audit |
| omp-ultra-fanout-recovery | M | 59 | 10 | FHI | MERGE→omp-ultra-run-controller |
| omp-ultra-run-controller | M | 72 | 48 | FHI | OWNER |
| omp-ultra-scout-telemetry-digest | M | 30 | 4 | FHI | MERGE→omp-ultra-run-controller |
| publish-xlsx-report-to-google-sheet-antifan | M | 61 | 4 | FHI | MERGE→google-drive-antifan-ops |
| samsung-odin-twrp-custom-rom | M | 69 | 0 | FHI | KEEP |
| security-scout-ultra-safe | M | 58 | 2 | FHI | MERGE→omp-ultra-run-controller |
| sheet-embedded-image-extract | M | 48 | 5 | FHI | MERGE→sheet-to-spec |
| sheet-to-spec | a,c | 184 | 6 | FHI | OWNER |
| subagent-output-recovery | M | 17 | 1 | FHI | MERGE→omp-ultra-run-controller |
| superpowers-omp-overlay | M | 96 | 0 | FHI | REWRITE |
| superseded-decision-doc-sync | M | 41 | 2 | FHI | KEEP |
| theme-handover-guide | M | 86 | 2 | FHI | OWNER |
| trello-card-comment-links-antifan | M | 36 | 5 | FHI | OWNER |
| trello-result-comment-short | M | 30 | 3 | FHI | MERGE→trello-card-comment-links-antifan |
| ui-ux-pro-max | a | 217 | 90 | FHI | KEEP |
| update-agentkit-cli-and-kits | M | 72 | 2 | FHI | OWNER |
| ux-ui-all | a,c | 65 | 6 | FHI | KEEP |
| vietnamese-url-slug-normalize | M | 52 | 2 | FHI | KEEP |
| vn-otp-provider-vetting | M | 62 | 0 | FHI | KEEP |
| windows-c-drive-cleanup | M | 60 | 7 | FHI | REWRITE |
| windows-intel-9560-wifi-repair | M | 103 | 0 | FHI | KEEP |
| windows-silent-node-job-death | M | 51 | 6 | FHI | KEEP |
| wireframe-roadmap | a,c | 106 | 3 | FHI | REWRITE |
| facebook-page-rebrand-antifan | M | 32 | 6 | G | OWNER |
| facebook-page-reels-setup | c | 79 | 37 | G | REWRITE |
| facebook-profile-post-antifan | M | 47 | 0 | G | REWRITE |
| facebook-reel-caption-extract-antifan | M | 59 | 2 | G | KEEP |
| fb-group-affiliate-post-antifan | M | 47 | 5 | G | KEEP |
| fb-group-broadcaster-muagi | M | 48 | 2 | G | MERGE→muagi-ops |
| fb-metrics-audit-ttb-dash | M | 66 | 2 | G | OWNER |
| fb-page-avatar-cover-antifan | M | 30 | 1 | G | MERGE→facebook-page-rebrand-antifan |
| gac-fb-page-live-audit | M | 75 | 0 | G | MERGE→fb-metrics-audit-ttb-dash |
| gac-fb-unschedule-scheduled-reel | M | 40 | 0 | G | KEEP |
| gac-muagi-loop-ops | M | 50 | 6 | G | MERGE→muagi-ops |
| gac-muagi-overnight-ops | M | 100 | 2 | G | MERGE→muagi-ops |
| gac-overnight-share-loop | M | 58 | 3 | G | MERGE→gac-page-group-share-run |
| gac-page-group-share-run | M | 47 | 2 | G | REWRITE |
| muagi-detached-24-7-ops | M | 32 | 0 | G | MERGE→muagi-ops |
| muagi-facebook-group-broadcaster | M | 56 | 2 | G | MERGE→muagi-ops |
| muagi-group-broadcaster-ops | M | 59 | 3 | G | KEEP |
| muagi-group-poster-ops | M | 77 | 2 | G | REWRITE |
| muagi-telegram-inbox-ops | M | 59 | 2 | G | KEEP |
| rutgonlinkpro-tiktok-tool-link-audit | M | 24 | 4 | G | MERGE→rutgonlinkpro-vanity-link-audit |
| rutgonlinkpro-vanity-link-audit | M | 32 | 3 | G | OWNER |
| ttb-cloud-d1-and-antifan-tab-recovery | M | 31 | 5 | G | MERGE→ttb-cloud-job-repost |
| ttb-cloud-job-repost | M | 43 | 1 | G | OWNER |
| vidaff-fb-promo-round-antifan | M | 48 | 0 | G | KEEP |
| vy-tiktok-file-to-fanpage-swap | M | 36 | 5 | G | REWRITE |

## 2. Duplicate and overlap clusters (one owner each)

Principle (ak-skill-creator §1): merge by task contract (same intent, output, authority, evidence); keep apart read-only audit vs live write, repair vs diagnose, listing form vs publish. Table lists the final owner (after chain resolution), the fixer that edits it, and the members folded in (each member's content goes to the owner's SKILL.md or `references/<topic>.md`, then the member is retired). New names are marked.

| owner | fixer | members folded in |
|---|---|---|
| shopify-theme | D | shopify-liquid, shopify-theme-collection-page, shopify-theme-product-page, shopify-theme-sections, shopify-theme-settings, shopify-theme-snippets, shopify-theme-templates |
| muagi-ops (new name) | G | fb-group-broadcaster-muagi, gac-muagi-loop-ops, gac-muagi-overnight-ops, muagi-detached-24-7-ops, muagi-facebook-group-broadcaster |
| pagespeed | A2 | ghn-pagespeed-contract, haravan-preview-pagespeed-measurement, hidden-popup-image-deferral, psi-bot-gate-and-lazy-verify, psi-measure-proven-haravan |
| shopify-theme-quality | D | shopify-theme-accessibility, shopify-theme-audit, shopify-theme-performance, shopify-theme-seo-content, shopify-theme-store-readiness |
| google-drive-antifan-ops (new name) | FHI | drive-upload-large-files-antifan-ui, drive-upload-via-apps-script, google-docs-docx-to-native-and-verify, publish-xlsx-report-to-google-sheet-antifan |
| omp-ultra-run-controller | FHI | omp-ultra-fanout-recovery, omp-ultra-scout-telemetry-digest, subagent-output-recovery, security-scout-ultra-safe |
| theme-qa-az | A2 | haravan-storefront-qa-proof-gate, theme-qa-critical-triage, antifan-haravan-verify-loop, antifan-qa-verdict-qualification |
| ai-model-character-refs | E1 | ai-model-reference-set-qa, character-ref-revision-round, identity-locked-character-from-footage |
| haravan-theme-verify-without-watcher | A2 | haravan-theme-harness-ab-verify, live-theme-interception-ab, prove-floating-controls-hidden |
| muse-studio-ops (new name) | E2 | muse-studio-library-file-triage, muse-studio-project-cleanup, muse-studio-register-external-render |
| worker-origin-discrimination | B2 | backend-cutover-origin-proof, cf-worker-deploy-commit-correlation, verify-worker-webhook-cutover |
| an-vat-muse-cart-clip | E1 | an-vat-muse-lot-finalize, an-vat-wan-voice-clip |
| antifan-leader | C | antifan-leader-deploy-ship, antifan-leader-dispatch-worker-pane |
| antifan-project-windows-matrix-ab | C | antifan-project-windows-matrix-ab, antifan-project-windows-probe-run |
| antifan-qa-cockpit | C | antifan-qa-baseline-receipt-loop, antifan-qa-scroll-artifact |
| final-showcase | FHI | sapo-final-showcase-package, final-showcase-export-rerun |
| haravan-inventory-invariant-audit | B1 | haravan-inventory-invariant-audit, haravan-inventory-ledger-forensics |
| haravan-inventory-write-safety | B2 | haravan-ledger-false-halt-triage, haravan-stock-load-after-legacy-ledger |
| haravan-partners-theme-submit | A1 | haravan-partners-reply-email, haravan-partners-switch-account |
| haravan-ps-botgate (new name) | A1 | haravan-font-gate-and-dedupe, haravan-ps-botgate-googlebot-exclusion |
| multiform-live-e2e-antifan (new name) | B2 | multiform-live-form-e2e-antifan, multiform-live-staff-e2e-antifan |
| multiform-prod-deploy-and-shard-migrate | B2 | multiform-clean-worktree-deploy, multiform-ship-and-plan-grant |
| pancake-haravan-customer-parity (new name) | B2 | pancake-haravan-customer-parity-trace, pancake-haravan-tier-parity-scan |
| redis-cloud-exit-runbook | B2 | redis-cloud-cancel-antifan, redis-cloud-dashboard-db-delete-antifan |
| sapo-admin-theme-file-edit-antifan | D | sapo-theme-edit-via-admin-editor, sapo-theme-snippet-embed-verify |
| sapo-editor-setting-sweep (new name) | D | sapo-editor-draft-setting-sweep, sapo-editor-human-input-sweep |
| sapo-h2s-convert-verify (new name) | D | sapo-h2s-antifan-tool-feedback, sapo-h2s-live-parity-sweep |
| shopify-demo-store-ops (new name) | D | rebel-demo-store-sync-qa, shopify-demo-store-seed |
| tiktok-shop-share-link-check | E2 | tiktok-shop-pdp-unavailable-triage, tiktok-shop-share-link-audit |
| antifan-compiled-ab-test | C | antifan-ab-test-triage |
| antifan-daemon-host-restart | C | antifan-detached-shutdown-job |
| capcut-draft-test-windows | E1 | capcut-draft-test-harness |
| cf-hostname-migrate-f1genz | B1 | cloudflare-pages-cname-bridge-matbao-dns |
| cf-worker-kaizen-ship-and-watch | B1 | cf-worker-plain-var-update |
| cf-worker-prod-404-triage | B1 | f1genz-app-host-404-triage |
| cloudflare-one | B1 | cloudflare-one-migrations |
| facebook-page-rebrand-antifan | G | fb-page-avatar-cover-antifan |
| facebook-profile-post-antifan | G | antifan-facebook-page-post |
| fb-metrics-audit-ttb-dash | G | gac-fb-page-live-audit |
| figforyou-amazon-page-check | B1 | figforyou-verified-asin-batch |
| figforyou-status-audit | B1 | figforyou-prod-status-check |
| figma-mcp-analyze | FHI | figma-desktop-mcp-http-python |
| gac-page-group-share-run | G | gac-overnight-share-loop |
| gateway-tts-capability-probe | E1 | probe-9router-models |
| haravan-accessibility | A1 | lighthouse-a11y-verification |
| haravan-demo-kit | A1 | haravan-demo-live-seed |
| haravan-feedback-sheet-audit | FHI | levents-feedback-triage |
| haravan-lazysizes-to-native | A1 | ghn-theme-lazyload-migration |
| haravan-preview-screenshot | A1 | haravan-ep2-preview-capture-antifan |
| haravan-settings | A2 | haravan-settings-html-guide |
| haravan-stitch-full-run | A2 | stitch-chunked-generation |
| hrv-theme-push-fetch-syntax | FHI | haravan-push-handoff-commands |
| kaizen-readonly-app-audit | B2 | recommend-readonly-kaizen-audit |
| local-worker-signed-in-ui-qa | C | cloudflare-worker-local-smoke-windows |
| multisync-order-lineitem-diagnose | B2 | multisync-order-customer-brief |
| muse-studio-accounts (new name) | E1 | muse-account-login-recovery |
| omp-mcp-remote-oauth | FHI | canva-mcp-connect |
| omp-session-audit | FHI | omp-session-jsonl-audit |
| rutgonlinkpro-vanity-link-audit | G | rutgonlinkpro-tiktok-tool-link-audit |
| sapo | D | sapo-theme-workflow |
| sapo-app-live-install-verify | D | sapo-review-app-antifan-feature-walkthrough |
| sheet-to-spec | FHI | sheet-embedded-image-extract |
| shopee-affiliate-media-info (new name) | E2 | shopee-affiliate-add-facebook-page |
| theme-handover-guide | FHI | customer-theme-guide |
| tinymce-react-init-race-harness | C | tinymce-late-content-blank-after-f5 |
| trello-card-comment-links-antifan | FHI | trello-result-comment-short |
| ttb-cloud-job-repost | G | ttb-cloud-d1-and-antifan-tab-recovery |
| tuong-vy-reference-clip | E2 | wan-motion-reference-takes |
| update-agentkit-cli-and-kits | FHI | agentkit-update-and-delta-measure |
| vclip-adam-tts | E2 | tts-pace-check-vclip |

Renames (only where a merge happens and uses30d < 20; all others keep their names):

| old name | new name | fixer |
|---|---|---|
| devs2-rebel-storefront-verify | devs2-sartor-storefront-verify | D |
| haravan-botgate-parity-fix | haravan-ps-botgate | A1 |
| haravan-lazy-below-fold-proof | haravan-lazy-images | A1 |
| muagi-group-poster-ops | muagi-ops | G |
| multiform-prod-deploy-and-shard-migrate | multiform-prod-deploy | B2 |
| multisync-order-lineitem-diagnose | multisync-order-diagnose | B2 |
| muse-studio-add-account | muse-studio-accounts | E1 |
| shopee-affiliate-media-info-edit | shopee-affiliate-media-info | E2 |

Overlaps deliberately kept apart (different authority): `muagi-telegram-inbox-ops` (bot), `facebook-profile-post-antifan` (personal profile), `fb-group-affiliate-post-antifan`, `gac-fb-unschedule-scheduled-reel`, `haravan-partners-store-bootstrap` (irreversible store creation), `haravan-demo-data-audit` vs demo-kit, `antifan-daemon-host-restart` / `antifan-detached-shutdown-job` (end all PTYs), `haravan-bulk-settle-committed` / `split-customer-consolidation` / `membership-ledger-repair` (live writes), `google-sheet-feedback-row-marking` (customer-visible write) and `google-sheet-bulk-paste-verify-antifan` (shared traps extracted once), `vidaff-price-change` (prod D1 write), `sapo-editor-draft-key-fill` (ends in a live Save).

Retire list (move to `_retired/`, 22):

| skill | cluster | uses30d | reason |
|---|---|---|---|
| antifan-leader-wait-workers-polling | C | 4 | Delete; fold the one verified fact (`--ignore` unsupported; pin with `--w ... --all`) into leader references/dispatch.md. |
| ccs-delegation | C | 3 | Remove from `.agents`/`.claude` unless CCS is in use (run `ccs doctor` first); if kept, shrink to 40 lines and drop the regex algorithm. |
| customize-customer-guide | FHI | 6 | Delete skill dir (both roots) |
| gac-golden-slot-fill-fleet | E1 | 2 | Archive; keep only the "session restart kills agents: inventory by mtime, re-read Graph, progress/<Agent>.md" pattern as 8 lines in gac-content-team references/resume.md |
| gac-offline-metric-reporter | E1 | 0 | Fold L33 vault.redact caveat and L37-43 importlib pattern into ttb-dash test notes; fix typo if kept |
| gac-workspace-state | E1 | 0 | Delete; keep only key-file list in `E:/Work/Gác/CLAUDE.md` |
| haravan-app-feasibility | B1 | 3 | delete directory in both `.agents` and `.claude` (not editing here); keep any eval case that still references it inside haravan-app/evals |
| haravan-pages | A1 | 3 | Delete from .agents, .claude and any managed root; remove "Do not route to haravan-pages" from haravan SKILL.md:61 |
| levents-product-card-gallery-diagnosis | A2 | 0 | Fold into levents-guide-pipeline or levents project notes; not a reusable contract |
| ml-prod-measure-and-deploy-proof | B2 | 16 | Archive; nothing to migrate except "push gate / 502 prober" ideas, already in pm2-deploy-502-window-measure |
| mnbakery-about-header-clearance | A2 | 0 | Fold the CAPTURE_FRAME_STARVATION tip into levents-guide-pipeline/antifan-qa-cockpit notes; delete |
| redis-cloud-to-local-migration-prep | B2 | 0 | Move the DUMP/RESTORE copy-tool pattern to a reference of redis-cloud-exit-runbook only if still needed; otherwise archive |
| s2-spa-sharp-theme-compression | A2 | 0 | Move the 54 images/2.77 MB data point into haravan-theme-image-compression as an example; delete |
| sapo-app-feasibility | D | 3 | Delete dir from .agents and .claude (no unique content); strip mentions from sapo/SKILL.md:36 |
| sapo-validation | D | 3 | Move evals/*.json to sapo/evals; delete body; ak-skill-creator covers procedure |
| tuong-finds-facebook-reel-post | E2 | 5 | Delete or archive; keep generic "post via ttb-cloud Worker" only if still used by ttb (it is `ttb-cloud-job-repost`) |
| tuong-finds-reel | E2 | 10 | Archive both; if "Countdown Skies" Page needs reels, write fresh from flycam channel rules |
| tuong-studio-code-video | E2 | 28 | Archive the 3 Studio skills together; extract any generic Remotion/loudnorm notes to ak-remotion if wanted |
| tuong-studio-long-film-qa | E2 | 12 | Archive; generic glitch-scan/face-band recipe → reference of ttb-code2d-reel if reused |
| tuong-studio-post-approved-cut | E2 | 8 | Archive; only YouTube leg survives (`ttb-youtube-shorts-upload`) |
| web-perf | A2 | 3 | Retire; its generic CWV workflow is covered by pagespeed + AntiFan inspect tools |
| worker-local-smoke-antifan-ui-qa | C | 2 | Fold `visual_quality`, "restore device preset" and "320px overflows first" lines into local-worker-signed-in-ui-qa; delete. |

Contradictory pairs that need one decision each (full list per cluster in detail files):
1. `tinymce-late-content-blank-after-f5` (defer with `setTimeout(0)`) vs `tinymce-react-init-race-harness` (never) → harness wins, owner C.
2. Leader dispatch: `antifan-leader` (Enter inside `input …\r`, close via `close-worker.mjs`, `leader-report/1` JSON) vs `antifan-leader-deploy-ship`/`dispatch-worker-pane` (separate `key:enter`, raw `terminal.close`, `STATUS/SUMMARY/EVIDENCE`) → antifan-leader wins.
3. Multiform deploy order: `multiform-ship-and-plan-grant` (push first, deploy working tree) vs `multiform-prod-deploy-and-shard-migrate` (clean worktree, push after) → clean worktree owner wins.
4. ML: `ml-prod-measure-and-deploy-proof` (VPS/Supabase/BullMQ) vs `ml-prod-health-check`/`ml-worker-client-deploy` (retired infra) → retire the first.
5. Redis Cloud UI: `redis-cloud-cancel-antifan` ("no per-DB delete") vs `redis-cloud-dashboard-db-delete-antifan` (kebab delete works) → reconcile into one reference by live check.
6. FigForYou: `figforyou-release:38` pushes `master`; two siblings forbid pushing without approval → "push only with user approval".
7. pm2: `f1genz-multisync-backfill-ops` requires `pm2 delete/save`; `cf-hostname-migrate-f1genz:50` forbids it on the VPS → name the host in both.
8. muagi whitelist: `gac-overnight-share-loop` (do not touch muagi state.json) vs `gac-page-group-share-run` (set `state="white"` via mutate); content rule: no description (14/11) vs `muagi-group-broadcaster-ops §5` and `muagi-group-poster-ops` step 3 (include description).
9. Voice policy: `furniture-reels:77`/`gateway-tts-capability-probe:42` ("an-vat music only") vs an-vat skills (Adam voice).
10. Shopify store submission: `rebel-demo-store-sync-qa:90` (Replace file preserves listing; 43 tags) vs `shopify-theme-store-submission:34` (wipes draft; 44 tags).
11. Lazy-loading: AGENTS §4:76 keep `nosrc`/lazysizes vs `haravan-lazysizes-to-native`/`ghn-theme-lazyload-migration` (remove) vs `haravan-lazy-below-fold-proof` (keep) → owner `haravan-lazy-images` states one decision rule.
12. Fallbacks: `haravan-empty-settings-render` teaches hardcoded fallbacks forbidden by AGENTS §4:82 and `haravan-audit`.

## 3. Cross-cutting inconsistencies

3.1 **Install roots / drift.** managed-skills (334, no VCS), `.agents/skills` (194 entries incl. AK) and `.claude/skills` (200 incl. AK) hold the same 76 user skills (4 diverged; the cluster files initially picked the older `.agents` copy for `pagespeed` — the `.claude` copy is newer). `.agents/.skill-lock.json` has 3 local-staging entries (`huashu-design`, `impeccable`, `taste-skill` from `E:/Work/tools/_skill-staging`). Loader shows differing same-name skills as `agents/<name>` duplicates (seen for haravan-accessibility, haravan-settings-schema, pagespeed). Ghost dirs without SKILL.md: 8 `sapo-theme-*` (references+scripts, 7 byte-identical references, orphan scripts), `.claude/skills/references` (shared Haravan baselines/addenda), `ak-ak`, `ak-handover`. `haravan-pages`/`haravan-app-feasibility` say "retired" but still ship files.
3.2 **Frontmatter schema.** 359 skills have only `name`+`description`; 58 carry unused extras (`category`, `keywords`, `user-invocable`, `applyTo`, `status`, `version`, `metadata`, `references`); `when_to_use` in 8; one name mismatch (`shopify` ↔ `ck:shopify`, `ak-ai-multimodal-native` ↔ `ak:ai-multimodal-native`). No skill uses `compatibility`.
3.3 **Description style/language.** 242 start with "Use…", others with a verb or noun ("Verify/Build/Audit/Read-only/Vận…"); 4 are YAML block scalars (`>-`); EN 319 / mixed 73 / VI 25; `huashu-design` is Chinese-only; `facebook-profile-post-antifan` is Vietnamese without diacritics; 1 description is 1,030 chars (> cap 1,024: `an-vat-autopilot-stall-triage`). Not-for clauses are rare. Bodies mix VI/EN; Vietnamese strings carry diacritics except that one.
3.4 **Structure.** 344 of 417 skills have no `references/` or `scripts/`; 64 have `references/`, 26 have `scripts/`; 22 of 38 in A2 lack Done-when; 5 skills have SKILL.md > 300 lines; 13 skills carry an oversized file (SKILL.md or reference > 300 lines; e.g. `cloudflare` flagship 469/390, `durable-objects/workers.md` 346, `furniture-reels/prompt-template.md` 548, `haravan-stitch-full-run` 569-line reference, `theme-qa-az` 431-line checklist); very long lines hide size (`tuong-vy-reference-clip` 25 KB in 9 lines; `ml-visual-translate`, `haravan-login-via-otp` lines of 1-5 KB). Cruft inside skill dirs: `.git`, `.pytest_cache`, `__pycache__`, `*.bak-*` (`furniture-reels`, `tuong-vy-lot-prep-gates`, `sheet-to-spec`, `haravan-audit`); empty `assets/`/`scripts/`/`evals/` in `customize-customer-guide`, `google-form-sheet`.
3.5 **Authority/rule drift against `E:/Work/AGENTS.md`, AntiFan AGENTS, `~/.claude/CLAUDE.md`.**
- hrv push/fetch: 15 skills say never/ask (`pagespeed:31`, `haravan-settings-schema:18`, `haravan-stitch-full-run:68`, `theme-qa-az:68`, `haravan-theme-dead-code-purge:12`, `haravan-theme-verify-without-watcher:8,11`, `haravan-theme-vietnamese-localization:20`, `antifan-qa-cockpit:40`, `haravan`, `f1genz-review`, `antifan-haravan-full-site-sweep`, `haravan-overflow-debug`, `haravan-push-handoff-commands`, `haravan-ps-botgate-googlebot-exclusion`; `theme-worker-patch-and-zip` is valid only as a Leader-job constraint). `settings_data.json` edits are allowed behind a `hrv theme fetch --only config/settings_data.json` gate that none mention.
- `prefers-reduced-motion` banned (AGENTS §5:98) vs `ui-ux-pro-max:23,28`, `impeccable` (`reference/animate.md:77`, `adapt.md:46`), `huashu-design` (`modules/web.md:19`), `design-taste-frontend` (`layout.md:266`, `imagery.md:373`), `3dviz-pro-max:72`, `improve-animations:48,82`; 44px vs the 24px target rule (`haravan-accessibility` copies differ).
- Level-0 destructive rules: `muse-studio-app-ops:30` `taskkill /F`, `muse-studio-project-cleanup` `Stop-Process -Force`, `shopee-reels-safe-cleanup` permanent rmtree, `f1genz-cloud-service-cancel-verify:42` and `npx-partial-install-repair:33` `rm -rf`/`Remove-Item -Recurse -Force` without approval; `sapo-theme-snippet-embed-verify:11`, `shopify-theme-cli:49` prefer `sapo`/`shopify theme` push without the approval note; `publish-xlsx-report-to-google-sheet-antifan` makes a Sheet public without asking; `haravan-app` says answer in the user's language (root rule: Vietnamese).
- Dead AGENTS cites: `haravan-preview-screenshot` → "AGENTS §3.1" (no such section); mis-cited "AGENTS §4 forbids platform detector" in botgate skills.
3.6 **Stale facts.**
- Channels: `E:/Work/Gác/channels` has only an-vat, flycam, tap-hoa, ttb, tuong-vy; skills still list 9-11 channels (golden-slot, content-team, page-engage, daily-status, posting-tokens), 5 Tường Studio/Finds skills, 2 Shopee-media skills list 9 rows incl. Studio (CLAUDE.md:265 says 10, no Studio), 5 TTB skills say `#virals #cute` (rule: `#mevabe #xuhuong`, `channels/ttb/channel.json:70-83`), Muse pool "muse-4..9"/"4 accounts" (DB has `muse-10` only).
- ML/Cloudflare post-cutover (07/11): `f1genz-ml-ops-import-grant` (route absent from `worker/src` → retire), `f1genz-ml-shop-state-readonly-triage`, `f1genz-multilanguage-theme-job-diagnose`, `f1genz-app-licence-lockout-triage`, `f1genz-hostname-inventory`, `cf-hostname-migrate-f1genz`, `f1genz-cloud-service-cancel-verify` read Postgres/Redis/`.worktrees/ml-cf`/`scratch/backups` that no longer exist; `multiform-prod-deploy-and-shard-migrate` says main `3e2ec04`, migration 0011 (repo `b3852cc`, 0013).
- Machine facts: `windows-c-drive-cleanup:8` says E: is a separate partition (same NVMe; E: hit 98% on 2026-11-17).
- Citation rot: `muagi.py` line numbers (mutate 472→479, new_group 985→1013, due_groups 1017→1063, usable 1124→1183, rejection_streak 2354→2424), test counts 120/145 vs 190, `index.ts 4631→4747`, missing `daemon-restart.mjs`, `probe-multi-window-binding.cjs`, `probe-detached-webhub.cjs`, `server-cloudflare.js`, `E:/Work/INTAKE.md`, `~/.omp/agent/rules/destructive-commands.md`, skill `antifan-tab-drive-via-stdio-mcp` (real: `antifan-stdio-mcp-driver`; cited by 3 skills), `/ck:plan`, `haravan-liquid`; `site-clone` (`/ck:*`), `haravan-stitch-full-run` (`/haravan`) and `sheet-to-spec` (`/ck:plan`) cite slash commands that the live catalog no longer has.
- Scratch dependence: 53 skills mention `E:/Work/scratch` or `Gác/scratch`; 31 point to files that no longer exist (`demo-seed/seedlib.py` ×3, `purity-qa/sapo_*.py`, `journeys.cjs`, `r5-axe.cjs`, `vy-shishang/*`, `visual-qa-probe`, `drive-appscript/upload.py`, `ml-r2/run-vps.sh`, …).
- Rename drift: theme Rebel→Sartor (30/10) but `devs2-rebel-storefront-verify`, `rebel-demo-store-sync-qa` keep "Rebel".
3.7 **Hard-coded identifiers / duplicated blocks.** VPS `root@178.128.216.88` in 6 skills; `CLOUDFLARE_API_TOKEN_F1GENZ`/`_ACCOUNT_ID_F1GENZ` prelude in 20 (single source `E:/Work/docs/naming-cloudflare.md` exists); Cloudflare account/zone ids inlined in several; Leader report contract restated differently in 8; "Muse only via gen gateway" in 4; tool-pitfall boilerplate ("bash blocks cat/head/tail", PowerShell `$_`) in 7; `C:/Users/Admin/.claude/skills/...` and `E:\skills\...` hard-coded roots in `final-showcase`, `haravan-feedback-sheet-audit`, `google-form-sheet`, `ai-image-studio` (relative `.claude/skills/...` command).
3.8 **Secrets.** No credential values found in any skill (regex + scout reads). Identifier-level items to scrub or relocate (file:line in detail files): Cloudflare account/zone/DO namespace ids (`cloudflare-dns-record-dashboard-ops:11,17`, `cf-hostname-migrate-f1genz:9`, `ml-do-datastudio-shop-datafix:~11`, `multiform-clean-worktree-deploy:6`, `ai-model-character-refs:36`, `identity-locked-character-from-footage:38`), VPS IP/`root@` ssh (6 skills), IndexNow key (`figforyou-release`), Haravan org id (`split-customer-consolidation`), Telegram group id (`haravan-login-via-otp:15`), FB app id (`gac-channel-posting-tokens:32`), personal email (`shopify-theme-store-submission:12`, 2 emails in A1), default public Haravan shop password (`trello-card-comment-links-antifan:35`), PCI id + home SSID (`windows-intel-9560-wifi-repair:10-12`), incident note of a leaked demo password (`shopify-theme-store-submission:25`, no value). Four UUID-shaped regex hits in `cloudflare` and `cloudflare-email-service` references are doc examples. P0 secret/identifier scan precedes the first commit of the skills repo.
3.9 **Corruption.** `haravan-lazysizes-to-native/SKILL.md:22-44` has a stray Chinese paragraph and duplicated frontmatter+body; `shopify-theme` lines 44-45 corrupted, 4 dead reference rows; `haravan-preview-screenshot` self-contradictory with an empty heading.
3.10 **Routing gaps.** The `haravan` router names only 8 of its 38 sibling skills (29 unreachable); `sapo/SKILL.md:36` forbids the ghost `sapo-theme-*` skills that `sapo-liquid:16,20` and `sapo/references/routing-table.md:8,22` still route to.

## 4. Target architecture and executable plan

### 4.1 Canonical root and layout
- **Source of truth: new git repo `E:/Work/skills`**, flat `skills/<name>/SKILL.md` (+ `references/`, `scripts/`), dir name == frontmatter `name`, plus `MIGRATION.md` (old → new/where), `tools/` (gates), `catalog-baseline.json`. Reason (kongming, adopted): the skills are mostly Haravan/Sapo/Gác/muagi/Windows, not AntiFan product code; AntiFan's tree is shared by many sessions. `antifan-leader` and `f1genz-feedback-comment-post` stay in `E:/Work/apps/AntiFan/skills` (tested with Leader code; installer already serves them; repo copy is source).
- **Installers**: managed-skills (OMP, authoritative) via `scripts/install-managed-skills.mjs` extended with `--source-root` (repeatable), `--prune` (skills absent from all sources move to `_retired/`, never deleted), `--target-root`; plus a generated mirror to `~/.claude/skills` for Claude Code (used 2026-11-16, 10 sessions in 30 d). Identical copies dedupe in the loader; never hand-edit mirrors. **`~/.agents/skills` non-AK copies are retired** (its lock file has 3 local staging entries only). No symlinks/junctions.
- **Retire** = move `<name>` to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (depth-2, not loaded; verified `.antifan-skill-backups` nesting is not listed) and `git rm` from the repo; the history is the archive. Never `rm -rf`.
- Naming: `<domain>-<noun-or-verb>`; domains `haravan-`, `sapo-`, `shopify-`, `f1genz-`, `cf-`, `antifan-`, `gac-`, `muagi-`, `ttb-`, `muse-`, `omp-`, `windows-`, `google-`. Rename only when a merge happens and uses30d < 20 (rename table in §2); do not rename for beauty. `antifan-*` is for skills about the AntiFan app itself; skills that only use AntiFan as instrument move to their domain name on the next merge (kept names for now: `antifan-facebook-page-post`→folded, `antifan-haravan-verify-loop`→folded, `psi-antifan-serial-runner`, `storefront-widget-cdn-bypass-verify`, `antifan-history-back-proof` keep names this round).
- No alias stubs: merged names are cut cleanly and recorded in `MIGRATION.md` (stubs cost catalog tokens). Before removing a name, grep `skill://<old>`/name in memory, AGENTS files, rules, other skills, Leader scripts and fix the reference (part of every merge).

### 4.2 Frontmatter and body template
```yaml
---
name: <dir-name>                      # kebab-case, == dir
description: <=250 chars. Action first. "Use when <trigger>." "Not for <neighbour> (use X)."
when_to_use: optional, VI trigger phrases ("khi user nói ...") — total description+when_to_use <=1,536
---
```
Drop `category`, `keywords`, `applyTo`, `user-invocable`, `status`, `version` unless a loader needs them (vendor skills keep theirs). Body sections: **Boundary** (owns / hands off to X), **Workflow** (order only where it protects data), **Done when** (observable evidence; partial state reported honestly). SKILL.md ≤150 lines target, 300 hard; references one level deep, ≤300 lines each, loaded on a stated condition; scripts have tests and a platform note or are exempt with a reason. No dated measurements, `:line` citations, commit hashes, customer ids or incident diaries in SKILL.md (dated notes → `references/field-notes.md` or removed). Skills may cite only paths inside their own dir, `E:/Work/docs/...`, or AGENTS sections — never `E:/Work/scratch`.

### 4.3 Name lock (target → fixer) and rules R1-R12
Targets in §2 are locked; a fixer needing a different name asks Main. Chain merges: `antifan-haravan-verify-loop`, `antifan-qa-verdict-qualification` → `haravan-storefront-qa-proof-gate` → `theme-qa-az`; `haravan-preview-pagespeed-measurement` → `psi-measure-proven-haravan` → `pagespeed`. Scout conflicts resolved: `worker-origin-discrimination` keeps its name (scout B2's `worker-cutover-proof` dropped); `trello-card-comment-links-antifan` keeps its name; `tiktok-shop-share-link-check` is the TikTok link owner; `rutgonlinkpro-vanity-link-audit` keeps its name; `google-sheet-bulk-paste-verify-antifan` stays separate; `haravan-accessibility` touch target = **24px** per AGENTS (reconcile the 44px copy).
R1 one fixer per row (work order files); R2 cross-cluster rows are done by the TARGET's fixer, who also retire-moves the source; R3 never run the installer; R4 merge first, rewrite second (no rewrite of a skill that is about to be merged); R5 shared facts once (hrv gate → AGENTS §8, Cloudflare/VPS → `E:/Work/docs/naming-cloudflare.md`, Leader report contract → antifan-leader reference, "Muse via gen gateway" → one reference), remove copies; R6 destructive steps carry an explicit "owner approval first" line (rm/taskkill/Stop-Process/rmtree/public share/live push); R7 no secrets/identifiers inline (§3.8), point to vault/env names; R8 each fixer works on its own branch/worktree of `E:/Work/skills`, the orchestrator merges in order; R9 vendor skills are not edited in place (§4.6); R10 skills that depend on `E:/Work/scratch` files either copy the file into the skill's `scripts/` (with test) or drop the dependency; R11 field-notes dated, ≤1 per skill; R12 antifan-leader edits happen in the AntiFan repo with its tests (`node --test test/unit/leader-job.test.mjs`), not in the bulk wave.

### 4.4 Waves
**P0 — orchestrator, serial, before any fixer** (≈ half a day):
1. `git init E:/Work/skills`; create `skills/`, `tools/`, `MIGRATION.md`, `.gitignore` (`__pycache__`, `.pytest_cache`, `*.bak*`, `.git` inside skills, `.venv`).
2. **Pre-commit scan** for secrets and the §3.8 identifiers across all 417 (+ `_retired` candidates); fix or redact before first commit.
3. Snapshot-import all 417 into `skills/` without content change; parity rule: managed copy wins except the 4 diverged (take `.claude` copy of `pagespeed` and `haravan-settings-schema`; `haravan-accessibility` → 24px copy; `shopify` excluded). Commit "import". Verify `diff -r` against installed.
4. Move the 8 ghost `sapo-theme-*` dirs, `.claude/skills/references`, `ak-ak`, `ak-handover`, `.agents` non-AK copies, and the `.claude` non-AK copies (after the Claude Code mirror exists) to `_retired/` — but first copy `.claude/skills/references/{{haravan-baseline,haravan-theme-operating-contract-addendum,local-skill-routing}}.md` into the skills that cite them (`haravan`, `haravan-theme`, `haravan-settings`, `haravan-stitch-full-run`) so `../references/` links disappear.
5. Extend installer (`--source-root`, `--prune`→`_retired`, `--target-root`, mirror mode; keep backups/rollback and name==dir check) with tests; add `tools/gate.py` = quick_validate + skill_standard_report + lint_cruft + link/name/dangling-skill-reference check + catalog budget (chars/tokens) + secret scan.
6. **Baseline**: freeze today's catalog (names, description chars) into `catalog-baseline.json`; build a routing eval set of 40-60 hand-labelled prompts from the 30-day sessions (top skills first: furniture-reels, antifan-*, haravan*, f1genz-feedback, tiktok-studio, theme-qa-az, muagi, gac-*), expected skill per prompt.
7. Shared facts: cite AGENTS §8 for the hrv gate (no new doc); ensure `E:/Work/docs/naming-cloudflare.md` carries the Cloudflare env mapping + VPS ssh alias; add `E:/Work/docs/leader-report-contract.md` (or point to the antifan-leader reference) so the 8 restated Leader contracts can link it.
8. Confirm with Tài the open decisions in §4.7.

**P1 — 10 fixers in parallel (branches)**: apply every MERGE/RETIRE row and the shared-fact removals (R5/R6/R7) for the fixer's skills; fix stale facts that are one-line (paths, hashtags, channel lists, hrv sentences, dead skill names); retire the 22. Gate per skill; orchestrator merges branches in the order A1,A2,C,B1,B2,D,E1,E2,G,FHI, runs gate, installs wave 1 (install → managed-skills + `~/.claude/skills` mirror; `--prune` moves retired to `_retired/`).
**P2 — rewrites** (same fixers, after P1 merged): the 80 REWRITE rows, top-10 first (§5), merge-first. `antifan-leader` by a dedicated worker in the AntiFan repo.
**P3 — catalog budget**: description pass to ≤250 chars with not-for (hard gate); route-by-domain *runbook-out-of-catalog* for rarely used ops (cutover, recovery, token signing: ~75 surviving skills with 0 uses in 30 d; use a 90-day window before moving) into `E:/Work/docs/runbooks/` with one-line pointers inside a domain router; vendor skills (§4.6); run routing eval before/after (gate: no regression on labelled prompts, ≥ baseline top-1 on the top-usage skills); target ≤190 visible skills and ≤14K tokens of non-AK descriptions. Install wave 2.
**P4 — anti-rot**: pre-commit/CI in `E:/Work/skills` runs `tools/gate.py`; lint rule for dated facts (`verified 20…`, `:\d+` line cites, commit hashes, VPS/ids).

### 4.5 Per-cluster file actions
Exact per-skill actions (class, target, scout action text, verified stale facts, contradictions) are in the work orders; each file also embeds the scout's overlap clusters, rewrite candidates and inconsistency list for that cluster:

- fixer A1 — Haravan theme 1: [fixer-A1.md](261117-skill-audit-actions/fixer-A1.md) (38 skills in scout cluster; 36 rows to execute)
- fixer A2 — Haravan theme 2: [fixer-A2.md](261117-skill-audit-actions/fixer-A2.md) (38 skills in scout cluster; 41 rows to execute)
- fixer B1 — F1GENZ apps/Cloudflare 1: [fixer-B1.md](261117-skill-audit-actions/fixer-B1.md) (51 skills in scout cluster; 48 rows to execute)
- fixer B2 — F1GENZ apps/Cloudflare 2 + inventory ops: [fixer-B2.md](261117-skill-audit-actions/fixer-B2.md) (50 skills in scout cluster; 52 rows to execute)
- fixer C — AntiFan: [fixer-C.md](261117-skill-audit-actions/fixer-C.md) (47 skills in scout cluster; 45 rows to execute)
- fixer D — Sapo+Shopify: [fixer-D.md](261117-skill-audit-actions/fixer-D.md) (42 skills in scout cluster; 41 rows to execute)
- fixer E1 — Gác content 1: [fixer-E1.md](261117-skill-audit-actions/fixer-E1.md) (34 skills in scout cluster; 35 rows to execute)
- fixer E2 — Gác content 2 / TTB: [fixer-E2.md](261117-skill-audit-actions/fixer-E2.md) (34 skills in scout cluster; 33 rows to execute)
- fixer G — muagi/Facebook: [fixer-G.md](261117-skill-audit-actions/fixer-G.md) (25 skills in scout cluster; 26 rows to execute)
- fixer FHI — Windows/OMP/Google/guides/vendor: [fixer-FHI.md](261117-skill-audit-actions/fixer-FHI.md) (58 skills in scout cluster; 60 rows to execute)

Highlights per cluster (the work orders have all rows):
- **A1/A2 Haravan**: owners `haravan-ps-botgate`, `haravan-lazy-images` (repair the corrupted file first and decide the nosrc rule), `haravan-demo-kit`, `haravan-partners-theme-submit`, `haravan-preview-screenshot`, `pagespeed` (+4 absorbed, `web-perf` retired), `haravan-theme-verify-without-watcher` (+3), `theme-qa-az` (+2 + 2 AntiFan QA skills), `haravan-settings` (+html-guide), `haravan-theme-image-compression`; router `haravan` rebuilt as a short routing table covering all siblings; retire `haravan-pages`, `levents-product-card-gallery-diagnosis`, `mnbakery-about-header-clearance`, `s2-spa-sharp-theme-compression`, `web-perf`.
- **B1/B2 apps**: `worker-origin-discrimination` absorbs 3 deploy-truth skills + webhook cutover; `cf-worker-prod-404-triage` absorbs `f1genz-app-host-404-triage`; `cf-hostname-migrate-f1genz` absorbs the Mắt Bão bridge; FigForYou 5→3; inventory family → `haravan-inventory-write-safety` (+stock-load, false-halt) and `haravan-inventory-invariant-audit` (+forensics); retire `f1genz-ml-ops-import-grant`, `ml-prod-measure-and-deploy-proof`, `redis-cloud-to-local-migration-prep`, `haravan-app-feasibility`; rewrite the ML evidence chain for the DO-SQLite world; extract the Cloudflare env prelude to `E:/Work/docs`.
- **C AntiFan**: owners `antifan-app-restart` (single relaunch recipe), `antifan-compiled-ab-test`, `antifan-project-windows-matrix-ab`, `antifan-qa-cockpit` (slim to protocol), `tinymce-react-init-race-harness`, `local-worker-signed-in-ui-qa`; retire `antifan-leader-wait-workers-polling`, `ccs-delegation`, `worker-local-smoke-antifan-ui-qa`; 44 of 47 have no VCS → move AntiFan-owned ones into the new repo; fix dangling `antifan-tab-drive-via-stdio-mcp` → `antifan-stdio-mcp-driver`; `antifan-leader` split in the app repo (67 KB → ≤300-line SKILL.md + references; §2h stale).
- **D Sapo/Shopify (42→~19)**: `shopify-theme` (+7), `shopify-theme-quality` (+5), `shopify-theme-cli` kept; `sapo-admin-theme-file-edit-antifan` (+2), `sapo-editor-setting-sweep`, `sapo-h2s-convert-verify`, `sapo-app-live-install-verify` (+walkthrough), `shopify-demo-store-ops`, `devs2-sartor-storefront-verify`; retire `sapo-app-feasibility`, `sapo-validation`; resolve the Theme Store contradictions; remove ghost dirs (done in P0).
- **E1/E2 Gác**: channel inventory re-baselined to 5 live channels; `ai-model-character-refs` (+3), `an-vat-muse-cart-clip` (+2), `capcut-draft-test-windows` (+1), `gac-daily-status-check` (+coverage, alerts), `muse-studio-accounts`/`muse-studio-ops`, `tiktok-shop-share-link-check` (+2), `shopee-affiliate-media-info` (+1), `vclip-adam-tts` (+pace), `tuong-vy-reference-clip` (+wan-motion); retire 5 Tường Studio/Finds skills (extract loudnorm/glitch recipe → `ttb-code2d-reel`, held-job flow → `ttb-cloud-job-repost`), `gac-workspace-state`, `gac-offline-metric-reporter`, `gac-golden-slot-fill-fleet`; fix `#mevabe #xuhuong` in 5 TTB skills; approval gates on cleanup skills.
- **G muagi/Facebook**: `muagi-ops` (7→1 + 4 references; document `hard-until.txt`/STOP trap; retire `muagi-group-broadcaster-ops` after salvaging the NTFS-ADS note), `gac-page-group-share-run` (+overnight loop; reconcile whitelist), `facebook-page-rebrand-antifan` (+2 identity protocol unified on engage `identity.lock`), `fb-metrics-audit-ttb-dash` (+live-audit), `rutgonlinkpro` pair, `ttb-cloud-job-repost` (+D1).
- **FHI**: `update-agentkit-cli-and-kits` (+delta), `omp-ultra-run-controller` (+4), `omp-session-audit` (+jsonl-audit), `omp-mcp-remote-oauth` (+canva), `google-drive-antifan-ops` (+4), `theme-handover-guide` (+customer-theme-guide; `customize-customer-guide` retired), `final-showcase` (+rerun), `trello` pair, `figma` pair, vendor overlay (§4.6), `windows-c-drive-cleanup` rewrite (E: is not a separate partition), `ak-vault-env-consolidation` rename.

### 4.6 Vendor and third-party design skills
`impeccable`, `huashu-design`, `design-taste-frontend`, `ui-ux-pro-max`, `3dviz-pro-max`, `improve-animations`, `wireframe-roadmap`, `ux-ui-all`: do not rewrite upstream text in place. Add one short **workspace overlay** reference (loaded by `ux-ui-all`, which already injects the workspace rules) stating *AGENTS wins*: no `prefers-reduced-motion`, 24px touch target, no hardcoded fallbacks. Kongming suggested "always support reduced-motion"; that contradicts AGENTS §5:98 — rejected. Keep one primary UI-design skill in the catalog (`ui-ux-pro-max`: 90 sessions; `impeccable` 69; `design-taste-frontend` 75; `huashu-design` 60 → all four are used, so trim descriptions to ≤250 and make `huashu-design` English/Vietnamese) and mark the rest lens-only (`disable-model-invocation` if the harness honours it — test on one skill first). Patches to vendor text, if unavoidable, are diff-annotated and re-applied on upgrade (sources in `E:/Work/tools/_skill-staging`).

### 4.7 Open decisions for Tài (defaults in bold)
1. Create `E:/Work/skills` as the source (**yes**) vs keep everything under AntiFan.
2. Keep a generated `~/.claude/skills` mirror for Claude Code (**yes**, used 2026-11-16) vs retire it.
3. Wan route for an-vat: retire `an-vat-wan-voice-clip` if dead (**retire if `ttbdash` no longer has a Wan route**; marked [INFERENCE] by scout E1).
4. Retire the 5 Tường Studio/Finds skills (**yes**, channel dirs absent, `Gác/CLAUDE.md:378`).
5. `f1genz-ml-ops-import-grant` retire (**yes**, route absent from `worker/src`).
6. `muagi taphoa`: remove or refresh `hard-until.txt`; the current value `2026-11-16T12:55+07:00` is in the past, so starting the supervisor would write a permanent bare `STOP` (`supervise_taphoa.py:349-355`). Not changed in this audit.
7. Move 108 rarely used skills to out-of-catalog runbooks after a 90-day window (**yes at P3**).

## 5. Top 10 skills to rewrite to "xịn" level

| # | skill | uses30d | specific gap | target shape |
|---|---|---|---|---|
| 1 | furniture-reels (E1) | 357 | 242 dense lines + `prompt-template.md` 548 lines; owner-quote history instead of rules; wrong name vs content; `.git`, `.pytest_cache`, `*.bak-261113-*` inside dir; "an-vat music-only" contradicts an-vat skills; no Done evidence | SKILL.md ≤150 (flow + hard rules + Done), references: publish, brief-eval, prompt-template split ≤300 each; clean dir |
| 2 | antifan-leader (C, repo) | 78 | 67 KB / 179 lines; §2b-2j dated incident diaries; §2h stale (`planSapoCommand` exists, `theme-push-policy.ts:306`); 36 broken links; dispatch/report protocol contradicts 2 sibling skills | ≤300-line SKILL.md + references (dispatch, report contract, feedback case, git safety); done in AntiFan repo with tests; siblings link instead of restating |
| 3 | haravan (router, A1) | 66 | names only 8 of 38 sibling skills (29 unreachable); duplicated tables, stale CLI/settings_data text; hrv "never" line; `../references` links | short generated routing table (task → skill) covering all Haravan skills, one hrv-gate sentence citing AGENTS §8 |
| 4 | tiktok-studio-web-publish-antifan (E2) | 85 | 10.6 KB, no references, contradicts `ttb-crosspost-reel` on `workspaceRoot`, `#virals` hashtags | boundary + Done, references per step (upload, schedule, retention), one hashtag rule source |
| 5 | theme-qa-az (A2) | 51 | 561-char multi-topic description, 431-line checklist, hrv "never", mixes QA and H→S gates; absorbs 4 skills | split QA vs convert gates into references, 250-char description, Done = receipt verdict wording (only CERTIFIED is PASS) |
| 6 | pagespeed (A2) | 28 | two drifted copies (376/407), feature-list description, missing worker file, hrv rule stale; absorbs 4 skills | SKILL.md ≤300 (invariants + routing table), references nops, verify-gate, psi-measure, hidden-popup, case-lessons |
| 7 | muagi-ops (G; from muagi-group-poster-ops) | 2 (7 skills) | 7 copies of one engine (~60% repeated), contradictory restart/STOP/content rules, undocumented `hard-until.txt` trap, stale `muagi.py` line cites and test counts | SKILL.md ≤150 (boundary, STOP table, restart, Done) + 4 references (content/antibot, pacing/caps, supervisor 24/7, breaker/kaizen) |
| 8 | antifan-qa-cockpit (C) | 26 | protocol buried under dated findings and non-existent checklist items; hand-maintained tool table; hrv sentence contradicts AGENTS §8; duplicated in `.agents`+`.claude` | protocol-only SKILL.md; baseline/waiver and false-positive references; findings moved to `theme-qa-az` |
| 9 | an-vat-muse-cart-clip (E1) | 20 | description is an index of lesson IDs; dated measurements and L-ids in body; absorbs finalize + wan skills | gates + workflow + Done; lessons to `channels/an-vat/team-lessons.md`; `references/finalize.md`, `wan-variant.md` |
| 10 | haravan-inventory-write-safety (B2) | 0 (data-integrity) | no activation boundary/not-for/Done; measured facts mixed with rules; absorbs stock-load and false-halt | boundary + dry/live decision table + Done (Σ onhand/committed/available before/after, zero rows with available < 0); references stock-load, false-halt |

Runners-up: `haravan-preview-screenshot`, `multiform-prod-deploy`, `kaizen-readonly-app-audit` (+Recommend), `haravan-login-via-otp`, `f1genz-ml-shop-state-readonly-triage` chain, `tuong-vy-reference-clip`, `shopify-theme-store-submission`, `gac-content-team`, `omp-session-audit`, `windows-c-drive-cleanup`.

## 6. Kongming counsel (recorded) and disposition

Verdict: *conditional* — git as single source and one-time import before edits is right; draft lacked an input check, picked the wrong repo home and aimed too high on count. Points and what this plan does:
- **a) repo home**: use a separate repo `E:/Work/skills` (flat layout, name==dir); keep the 2 AntiFan skills in the app repo; extend installer with multiple source roots, `--install-all --prune` into `_retired/`, git revert + installer backups for rollback. → adopted (§4.1).
- **b) `.claude`/`.agents`**: decide the 4 diverged copies first; no symlinks on Windows; keep `~/.claude/skills` only as generated second install target if Claude Code is used; drop `.skill-lock.json`. → adopted; verified Claude Code last session 2026-11-16 (10 in 30 days), so the mirror stays.
- **c) count**: ~240 is the wrong target; 25K tokens/turn is fixed cost. Cut characters (≤250/description, hard), enforce a catalog budget (≤12K tokens measured on the real catalog), turn the 108 unused skills into out-of-catalog runbooks (`E:/Work/docs/runbooks/`) behind a domain router rather than bulk-retiring; target ~150-180 visible; use lens-only for vendor skills; commit to no number before P1. → adopted as P3 (≤190 visible, ≤14K tokens; budget revisited after P1 data; 90-day window before moving runbooks).
- **d) aliases**: clean cutover with `MIGRATION.md`, grep and fix `skill://old` references; keep names of heavy-use skills; rename only on merge. → adopted (§4.1, rename table; no renames at ≥20 sessions).
- **e) parallel risk**: disjoint ownership, lock target names before work, only the orchestrator installs (once per wave), branch/worktree per fixer, order: P0 import → shared facts → mechanical merges → rewrites → description trim; gates: quick_validate, skill_standard_report, lint_cruft, relative links, dir==name, no dangling old names, catalog budget, and above all a hand-labelled routing eval (40-60 prompts) before/after. → adopted (§4.3-4.4).
- **f) vendor**: do not edit in place; overlay stating AGENTS wins; one main UI skill; manual invocation for niche ones; `huashu-design` description to EN/VI. → adopted; **its suggestion that the overlay "always supports prefers-reduced-motion" is wrong against AGENTS §5:98 and was inverted**.
- **g) missed**: pre-commit secret/identifier scan (added P0.2); baseline before touching (P0.6); skills depending on gitignored scratch (R10); put short always-true rules in AGENTS.md and long shared facts in `E:/Work/docs`, deleting the 15 copies instead of editing them (R5); `antifan-leader` is the biggest token cost — split in the app repo with tests (R12); anti-rot CI (P4); delete dated facts and line-number cites instead of fixing (R11, P4); 90-day window before retiring seasonal ops. → all adopted.
Single check that could flip the answer: whether Claude Code still uses `~/.claude/skills` — checked: yes.

## 7. Notes on evidence quality
- `Verified` = existence/grep by the scout; `[INFERENCE]` marks unverified plans: the merge target of `cloudflare-worker-local-smoke-windows` (bodies of `local-worker-signed-in-ui-qa`/`worker-local-smoke-antifan-ui-qa` unread by B1; C read them and chose `local-worker-signed-in-ui-qa`), the Wan route for an-vat being dead, `REFUSED_LEADER_INVESTIGATE` hook name, which `put` in `muagi.py` is the rejected-bump.
- Not checked: live Cloudflare/Haravan/VPS/FB state; routing precision/recall of any proposed description (needs the P0.6 eval set); per-reference content (scouts listed references and read them only where cited).
