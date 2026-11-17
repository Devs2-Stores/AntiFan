# Work order — fixer A1 (Haravan theme part 1)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-A1.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = A1). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### haravan-botgate-parity-fix → rename `haravan-ps-botgate`
- class: **OWNER**; scout cluster A1; roots: managed; SKILL.md 73 lines; desc 286 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Becomes `haravan-ps-botgate`: absorb googlebot-exclusion as references/googlebot-exclusion.md; Step 5-7 (endpoint/CORS/font-claims) to references/ps-endpoint-and-cors.md; correct the "AGENTS §4 forbids" citation
- scout verdict text: MERGE (owner)
- stale/verified: `E:/Work/tools/Pagespeed/probes/gate-parity-probe.js` verified; line 11 cites "AGENTS §4 forbids" platform-dependent detector (AGENTS §4:78 says UA + viewport, not platform)
- contradiction: Slight: "viewport corroboration only" vs AGENTS §4:78 "UA + viewport 412/1350"
- structure: 7 steps + pitfalls; no references; mixes fix, CORS probe, font claims (Step 5-7 diverge)
- overlap: haravan-ps-botgate-googlebot-exclusion (same detector, Googlebot), haravan-font-gate-and-dedupe (reuses gate-parity-probe), pagespeed
- absorbs: haravan-font-gate-and-dedupe, haravan-ps-botgate-googlebot-exclusion
### haravan-demo-kit
- class: **OWNER**; scout cluster A1; roots: agents,claude; SKILL.md 89 lines; desc 179 chars; uses30d(sessions): 54; descQ 4/5; lang EN + VI rules
- action: Absorb live-seed as references/live-seed.md; wrap long step lines into a command table in references
- scout verdict text: KEEP (owner)
- stale/verified: All backend paths verified exist (cli.js, jewelry.example.json, haravan-data-migrator); industry-seed-{pc,fashion,furniture,spa,watch,wine}.md exist
- structure: 12 files (agents/openai.yaml, evals, 8 references); SKILL.md dense lines 44-52, 63 (>800 chars each); `scripts/contact-sheet.mjs` mentioned but lives in haravan-demo-data-audit
- overlap: haravan-demo-live-seed (same stages), haravan-demo-data-audit
- absorbs: haravan-demo-live-seed
### haravan-lazy-below-fold-proof → rename `haravan-lazy-images`
- class: **OWNER**; scout cluster A1; roots: managed; SKILL.md 32 lines; desc 223 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Becomes `haravan-lazy-images`: Step 0 decision (keep lazysizes per AGENTS §4:76 unless user asks migration); proof section stays; migration moves to references/lazysizes-to-native.md
- scout verdict text: MERGE (owner)
- stale/verified: `lazy-audit.js`, `bot-img-probe.js`, `img-choice.js`, `parity-shot.js`, `rte_clean_split.liquid` all verified in E:/Work/tools/Pagespeed
- contradiction: Line 19 "Keep lazysizes... do not invent nosrc" vs haravan-lazysizes-to-native which deletes lazysizes (OPPOSITE advice, no decision rule)
- structure: no references
- overlap: haravan-lazysizes-to-native, ghn-theme-lazyload-migration
### haravan-partners-theme-submit
- class: **OWNER**; scout cluster A1; roots: agents,claude; SKILL.md 66 lines; desc 269 chars; uses30d(sessions): 40; descQ 4/5; lang EN
- action: Absorb switch-account + reply-email as references; add test for diff()/setScope against a fixture DOM; Windows note
- scout verdict text: KEEP (owner)
- stale/verified: `scripts/partners-form.js` exists
- contradiction: AGENTS §8:151-152 per-action approval: consistent
- structure: `scripts/partners-form.js` has no tests/platform note; Update flow + Gotchas partly duplicate
- overlap: haravan-partners-switch-account, reply-email, final-showcase
- absorbs: haravan-partners-reply-email, haravan-partners-switch-account
### f1genz-client-layout-proof
- class: **REWRITE**; scout cluster A1; roots: managed; SKILL.md 47 lines; desc 238 chars; uses30d(sessions): 1; descQ 3/5; lang VI body, EN desc
- action: Split: keep layout-measure; move "prove Pages push" (SKILL.md:26-38) to cf-pages-deploy-regression-triage references; add repo path, not-for, DoD; verify domain
- stale/verified: Repo `Haravan-Client--Multilanguage` verified at E:/Work/apps/F1GENZ MultiLanguage/Haravan-Client--Multilanguage (skill never gives the path); host multilanguage.f1genz.com SKILL.md:8,29 may be stale after the .com→.dev move (cf-hostname-migrate-f1genz) [INFERENCE]; `.tmp-harness-mf/` harness name :46
- structure: no "not for"; no H1 boundary; mixes 2 jobs (layout measure, deploy proof); no references
- overlap: cf-pages-deploy-regression-triage, f1genz-client-local-harness (outside cluster) for harness/Pages proof
### f1genz-live-vs-build-audit
- class: **REWRITE**; scout cluster A1; roots: managed; SKILL.md 29 lines; desc 159 chars; uses30d(sessions): 0; descQ 3/5; lang EN + VI quote
- action: Add trigger/not-for to description; move baseline + IDs to a dated references/baseline-2026-11-07.md; keep only method + verdict rules; note ssh to a root host must stay read-only
- stale/verified: Contains VPS root IP (line 11) and Cloudflare account id (line 17) + dated baseline "07/11/2026" (line 27): volatile facts; cannot verify live
- structure: no "when to use" trigger; volatile baseline in body; infra identifiers inline
- overlap: kaizen-readonly-app-audit, f1genz-ml-shop-state-readonly-triage (outside)
### f1genz-review
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 174 lines; desc 534 chars; uses30d(sessions): 14; descQ 3/5; lang VI with diacritics
- action: Restrict description to Haravan (or add Sapo/Shopify branch files); move sold-count (107-135), CSS overflow (137-148), schema JSON-LD (150-160) to references; update hrv line; keep SKILL.md <120 lines
- stale/verified: Pattern from Mulgati theme 1001506747 dated 2026-08-07 (line 18); `apiUrl` loader fine
- contradiction: AGENTS §8: line 166 "Không auto-run hrv" stale; line 172 "Theme code không comment" matches §11
- structure: description claims Haravan/Sapo/Shopify but body is Haravan-only Liquid (`include`, `noPS`, `img_url`); no "not for"; 3 references (noPS-gating, placement-patterns, verification-checklist exist)
- overlap: haravan-product-recommend (same shape: app embed into product template); sapo-review-app-antifan-feature-walkthrough (outside)
### haravan
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 192 lines; desc 319 chars; uses30d(sessions): 66; descQ 3/5; lang EN
- action: Cut to <=120 lines: one routing table generated from the live catalog incl. every haravan-*/f1genz-*/ghn-* skill; delete Quick Reference + Common Workflows; update CLI/settings_data text to AGENTS §8; remove haravan-pages mention
- stale/verified: Refs `../references/*` exist; `audit-settings-schema.mjs` found only in haravan-settings-schema tests; `RESTYLE_MASTER_KIT` listed in "Skill" column (line 178) but is a tool dir E:/Work/tools/RESTYLE_MASTER_KIT; `references/liquid-cheatsheet.md` lives in haravan-theme (not here)
- contradiction: AGENTS §8: line 28 "never auto-run Haravan/HRV CLI" stale; "settings_data read-only" (187) vs AGENTS §8:136 allows edit after fetch gate; table omits 29 sibling skills; routes `haravan-pages` retired
- structure: Routing table + Quick Reference table duplicate each other (31-51 vs 155-179); Common Workflows pseudo-code (65-139) adds little; no references/ load rules; evals/ only
- overlap: local-skill-routing.md duplicates the table
### haravan-accessibility
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 52 lines; desc 288 chars; uses30d(sessions): 14; descQ 3/5; lang EN
- action: Sync roots to the 24px version; delete apply_patch line; add pointer to references/lighthouse-fixes.md; single source for contrast/tap rules; audit links here instead of repeating
- stale/verified: `.agents` copy line 32,41 says 44px touch target; `.claude` copy says hit area >=24px (WCAG 2.2 SC 2.5.8); haravan SKILL.md:176 and haravan-audit:44 say 24px
- contradiction: CONTRADICTION between its own two roots (44 vs 24) and with haravan-audit; "Prefer apply_patch" (line 20) stale tool name; Work override ok (§5)
- structure: description cuts off mid-sentence in field; `.agents` and `.claude` copies DIFFER
- overlap: haravan-audit (P1/P2 duplicate), ghn-pagespeed-contract a11y part
- absorbs: lighthouse-a11y-verification
### haravan-audit
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 172 lines; desc 383 chars; uses30d(sessions): 7; descQ 3/5; lang EN
- action: Keep procedure + preflight + output format; replace P1/P2/P5 checklists by links; delete __pycache__; add preflight test + platform note (py launcher, Windows)
- stale/verified: `scripts/haravan_preflight.py` exists; refs `../references/*` exist
- contradiction: `apply_patch` line 21 stale; "settings_data read-only" vs AGENTS §8:136; "Work: do not" reduced-motion (§5 ok)
- structure: checklist bulk (P1-P9) duplicates accessibility/performance/theme; emphasis 8, pressure 1; scripts/ has `haravan_preflight.py` + committed `__pycache__/*.pyc`; no script tests; ERR-link 3
- overlap: haravan-accessibility (P1,P2), haravan-performance (P5,P6), theme-qa-az
### haravan-empty-settings-render
- class: **REWRITE**; scout cluster A1; roots: managed; SKILL.md 59 lines; desc 256 chars; uses30d(sessions): 17; descQ 3/5; lang EN
- action: Re-scope to "empty-settings safe rendering" consistent with §4:82 (guard with != blank, render nothing); move Sass-parser crash fact to haravan-theme cheatsheet; split PDF/SMask extraction into its own tiny skill or drop
- stale/verified: no paths
- contradiction: CONTRADICTS AGENTS §4:82 (no hardcoded fallback) and haravan-audit P8 line 122: lines 11,22,28 teach `{% else %}FALLBACK{% endif %}`, bundled-asset fallback, hardcoded token values
- structure: mixes 4 topics: Liquid defaults, toggles, scss compile, PDF/SMask extraction (Canva) ; no trigger sentence; prefix `tb_`/`.tb-hero__slide` is Epres-specific
- overlap: haravan-theme (Liquid pitfalls), haravan-settings-schema
### haravan-lazysizes-to-native
- class: **REWRITE**; scout cluster A1; roots: managed; SKILL.md 45 lines; desc 155 chars; uses30d(sessions): 0; descQ 1/5; lang EN (+garbage CJK)
- action: Delete lines 22-44 (garbage + duplicate), keep one copy; add "only when user requests migration; AGENTS §4:76" gate; then merge into haravan-lazy-images
- stale/verified: assets/lazysizes.min.js etc theme-level
- contradiction: Conflicts with AGENTS §4:76 (keep nosrc/lazyload) unless user explicitly asks; opposite to lazy-below-fold-proof:19
- structure: CORRUPTED FILE: lines 22-44 contain a stray Chinese paragraph, then a second full frontmatter+body duplicate (name/description/Procedure repeated, 9 duplicate lines); description no trigger
- overlap: haravan-lazy-below-fold-proof, ghn-theme-lazyload-migration
- absorbs: ghn-theme-lazyload-migration
### haravan-performance
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 56 lines; desc 291 chars; uses30d(sessions): 9; descQ 3/5; lang EN
- action: Make it the generic performance index linking pagespeed (bot gate/nosrc/PSI) and the lazy/font/recaptcha skills; fix tool name; remove duplication with audit P5
- stale/verified: `references/external-sources.md` exists
- contradiction: `apply_patch` line 19 stale; "settings_data read-only" vs §8
- structure: ERR-link 2 (ref external-sources); thin vs pagespeed
- overlap: pagespeed (375 lines), haravan-lazy-*, haravan-font-gate
### haravan-preview-screenshot
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 335 lines; desc 230 chars; uses30d(sessions): 6; descQ 2/5; lang EN + VI inline
- action: Cut to <=150: boundary, approval gates, annotation defaults, link scripts; move widget crop/PPTX (243-315) and settings.html copy rules (229-241) to references; delete residue; fix AGENTS section cites
- stale/verified: scripts verified exist; line 8,34,64,216 cite `AGENTS.md §3.1` which does NOT exist; Puppeteer/Catbox refs
- contradiction: Self-contradiction: F1GENZ must not touch settings.html (line 8) yet 200 lines specify settings.html; Playwright "fallback only" (68) vs "preferred for single-widget crops" (285); description lacks trigger for Vietnamese phrasing
- structure: OVER 300 lines; ERR-link; scripts (screenshot.js, haravan-preview-screenshot.mjs, kill-haravan-preview-chrome.js) with no tests; stray "## Run" empty heading (line 106); "MANUAL MIGRATION REQUIRED" export residue (332-334); two overlapping approval sections (22-37, 108-132)
- overlap: haravan-ep2-preview-capture-antifan, haravan-upload-file, final-showcase
- absorbs: haravan-ep2-preview-capture-antifan
### haravan-product-recommend
- class: **REWRITE**; scout cluster A1; roots: agents,claude; SKILL.md 83 lines; desc 169 chars; uses30d(sessions): 13; descQ 4/5; lang VI with diacritics
- action: Delete Security Policy block; move general DotLiquid rules 1-3 to haravan-theme cheatsheet (cheatsheet currently lacks `!= empty` entry); add "not for other recommend apps" in description; keep app-specific rules
- stale/verified: refs liquid-patterns.md, troubleshooting.md exist
- structure: "Security Policy" boilerplate lines 16-20 (prompt-injection/jailbreak) = cruft, not task guidance; 2 evals + 2 references exist
- overlap: f1genz-review (embed-app shape); haravan-theme cheatsheet already has `.size` note
### f1genz-header-desktop-menu
- class: **KEEP**; scout cluster A1; roots: agents,claude; SKILL.md 43 lines; desc 218 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Fix line 42 dead pointer; add one-line DoD (measured hover gap=0)
- stale/verified: Verified references/header-menu-pattern.md exists; `themes/f1genz/GenZ/CLAUDE.md` (SKILL.md:42) MISSING on disk (E:/Work/themes/f1genz/GenZ exists, no CLAUDE.md)
- contradiction: none (R18-R19 rule IDs only defined in ref)
- structure: frontmatter extras applyTo/category/keywords; links `../references/local-skill-routing.md` ok; Port/Related sections thin
- overlap: none (theme-specific, unique)
### f1genz-theme-project-scaffold
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 51 lines; desc 218 chars; uses30d(sessions): 6; descQ 4/5; lang EN + VI trigger
- action: Make this the owner of `references/theme-folder-baseline.md` (.gitignore, .workspace-context.json, git baseline); store-bootstrap links to it
- stale/verified: `E:/Work/themes/f1genz/Lux Shoes/.antifan/space.json` verified exists
- contradiction: scaffold lines 44-45 forbid running hrv (AGENTS §8 permits fetch/push) but intent is "don't add dev terminals" - wording
- structure: OK structure; "Do not" list good
- overlap: haravan-partners-store-bootstrap §0 (local theme folder + .gitignore + .workspace-context.json) duplicated with different .gitignore (14 entries here vs 7 there)
### h2s-visual-parity-certify
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 42 lines; desc 165 chars; uses30d(sessions): 1; descQ 4/5; lang EN
- action: Add not-for (visual parity only; checklist QA = theme-qa-az); parametrize Lux `lxs` selectors; add DoD "CERTIFIED receipt path"
- scout verdict text: KEEP (cross-link)
- stale/verified: `fresh_reconvert.py` verified at E:/Work/tools/Convert Sapo - Haravan/; "verified live 2026-10-24" on Lux Shoes (line 8); selectors `.lxs-pop-sale` theme-specific
- structure: no "when not"; no references
- overlap: theme-qa-az (.agents, owns H→S gates), sapo-h2s-live-parity-sweep, sapo-h2s-antifan-tool-feedback (outside)
### haravan-admin-page-create-antifan
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 58 lines; desc 170 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Add not-for/DoD; extract shared "driving web.haravan.app iframe" facts to one reference used by all three admin skills
- stale/verified: Facts "verified 2026-11-04" on s2-corporate.myharavan.com; tools `anti.browser.evaluate_frame`, `anti.agent.cursor.click` exist
- structure: no "not-for"; verified-on s2-corporate dated
- overlap: haravan-menu-apply-admin-session, haravan-partners-store-bootstrap §2 (same web.haravan.app iframe driving)
### haravan-antifan-full-site-sweep
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 37 lines; desc 169 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Reword line 13 to "do not run `theme dev`; fetch/push per AGENTS §8"; replace MUST/NEVER with reasons; link batch_matrix tool
- stale/verified: `terminal.list`, `anti.browser.set_viewport`, `theme.qa_validate` exist
- contradiction: line 13 "NEVER run hrv" stale vs AGENTS §8 (push --nodelete allowed)
- structure: no references; emphasis without reason (cruft 3, threat 1)
- overlap: theme-qa-az, anti.qa.batch_matrix (tool), haravan-storefront-qa-proof-gate (outside)
### haravan-collection-defect-sweep
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 92 lines; desc 246 chars; uses30d(sessions): 12; descQ 4/5; lang EN
- action: Add DoD/notChecked template link; drop line-number cite or mark dated
- stale/verified: theme folder shape `themes/devs2/S2 */Haravan` correct (S2 Corporate/Haravan verified)
- structure: no references; some cites volatile (`Purity main.scss.liquid:2368`)
- overlap: haravan-audit (generic)
### haravan-demo-data-audit
- class: **KEEP**; scout cluster A1; roots: agents,claude; SKILL.md 35 lines; desc 233 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Keep as diagnosis skill; replace model names by "kit config"; add contact-sheet test + Windows note; link to demo-kit
- scout verdict text: KEEP (cross-link)
- stale/verified: `E:/Work/tools/HaravanDemoKit/src/hrv-token.js`, cli.js, `sharp` (HaravanDemoKit and Generate node_modules) verified
- contradiction: Hardcodes `qwen3.7-max`, `qwen-image-3.0-pro`, api.ai-box.vn (lines 22,28) while haravan-demo-kit:30 says provider/model authority is Demo Kit config, do not hardcode
- structure: scripts/contact-sheet.mjs without tests/platform note; hardcodes model names
- overlap: haravan-demo-kit (writes), haravan-demo-live-seed
### haravan-f1genztabs-hrv-live-test
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 83 lines; desc 238 chars; uses30d(sessions): 19; descQ 4/5; lang EN
- action: Add not-for (demo-kit seeding); mark unverified DELETE as [INFERENCE]
- stale/verified: `hrv api` syntax claims "DELETE was not verified" (line 80)
- contradiction: Consistent with AGENTS §8:150 (hrv api needs approval)
- structure: no references; code sample inline fine
- overlap: haravan-demo-kit (also writes live data), haravan-product-recommend
### haravan-menu-apply-admin-session
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 41 lines; desc 182 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Add not-for; cite AGENTS §8:150; fine
- stale/verified: `E:/Work/apps/Haravan CLI/src/commands/menu.ts` and `src/helper/admin-session.ts` verified exist; `hrv menu` not in AGENTS §8 allowlist so per-call approval (line 11) is correct
- structure: no references
- overlap: haravan-admin-page-create-antifan (iframe admin)
### haravan-overflow-debug
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 52 lines; desc 139 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Update CLI line to AGENTS §8; add DoD
- stale/verified: `anti.inspect.responsive_matrix`, `anti.theme.style_override` exist
- contradiction: line 39 "never run haravan/hrv" stale vs AGENTS §8; line 38 reduced-motion removal consistent with §5
- structure: no "not-for"
- overlap: haravan-audit/accessibility (overflow rules), theme-qa-az
### haravan-partners-store-bootstrap
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 61 lines; desc 225 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Fix path; replace §0 with link to scaffold baseline reference; add DoD
- stale/verified: Line 17 `E:/Work/themes/devs2/Haravan/<Theme Name>/` is WRONG: actual layout is `themes/devs2/<Theme Name>/Haravan` (S2 Corporate verified)
- contradiction: Own .gitignore (7 entries) differs from scaffold (14); line 8 "Never use hrv" vs §8 (fine, store creation)
- structure: 4 numbered phases ok; long lines
- overlap: f1genz-theme-project-scaffold (folder baseline), haravan-admin-page-create (iframe)
### haravan-recaptcha-intent-gate
- class: **KEEP**; scout cluster A1; roots: managed; SKILL.md 33 lines; desc 161 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Move "Related pitfalls" (28-32) to haravan-theme cheatsheet; name `skyOnIntent` generic
- stale/verified: theme-specific `head-script.liquid`, `skyOnIntent`; ref `psi-antifan-serial-runner` exists
- structure: no references; last section "Related pitfalls" is unrelated (cart qty, pagination, grid)
- overlap: pagespeed, haravan-performance
### ghn-theme-lazyload-migration
- class: **MERGE** → `haravan-lazysizes-to-native`; scout cluster A1; roots: managed; SKILL.md 27 lines; desc 144 chars; uses30d(sessions): 0; descQ 2/5; lang EN
- action: Fold "intentional non-image lazy patterns" (14-17) and QA-gate limits (26) into the lazy owner as references/ghn-case.md or drop line anchors; retire skill
- scout verdict text: MERGE→haravan-lazysizes-to-native
- stale/verified: Preview id 1001503470 and giaohangnang.com (line 24) not verifiable; line anchors fragile
- contradiction: Says "lazysizes deleted" and native lazy; AGENTS §4:76 says keep nosrc/lazyload when present
- structure: customer-theme-specific, line-number anchors (SKILL.md:21 "~line 148, 247, 618, 518-564, 357") will rot; no not-for
- overlap: haravan-lazysizes-to-native (same migration), haravan-lazy-below-fold-proof
### haravan-demo-live-seed
- class: **MERGE** → `haravan-demo-kit`; scout cluster A1; roots: agents,claude; SKILL.md 42 lines; desc 267 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Move to demo-kit references/live-seed.md; keep gotchas; add trigger phrase "live import approved" to demo-kit description; drop dated subagent note
- scout verdict text: MERGE→haravan-demo-kit
- stale/verified: Token store path `%USERPROFILE%/.haravan-cli.json`; hrv-token.js verified; "designer subagent failed 2026-10-06 (re-test pending)" line 38 volatile
- contradiction: line 14 `hrv refresh-all` "needs user approval" vs AGENTS §8:140 (Leader jobs may run it)
- structure: says "stage names follow haravan-demo-kit" - dependent skill
- overlap: haravan-demo-kit
### haravan-ep2-preview-capture-antifan
- class: **MERGE** → `haravan-preview-screenshot`; scout cluster A1; roots: managed; SKILL.md 14 lines; desc 236 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Becomes references/antifan-capture.md (primary path per AGENTS surface hierarchy); keep trigger words in owner description
- scout verdict text: MERGE→haravan-preview-screenshot
- stale/verified: Dated "Epres, 2026-11-09"; `anti.screenshot.full_page saveTo` exists
- structure: no H1, no trigger section, 7-line procedure of very long lines; "ep2" is a project code
- overlap: haravan-preview-screenshot (335 lines, same job, different surface)
### haravan-font-gate-and-dedupe
- class: **MERGE** → `haravan-ps-botgate`; scout cluster A1; roots: managed; SKILL.md 49 lines; desc 227 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Becomes references/font-gate.md of the bot-gate owner; keep symptoms in description
- scout verdict text: MERGE→haravan-ps-botgate
- stale/verified: `gate-parity-probe.js` verified; asset names `timber-mini.css.liquid`, `fontawesome.css.liquid` are theme-specific
- contradiction: line 35 "AGENTS §4" cited as ban on second detector; AGENTS §4:78 only bans reload
- structure: no references; reuses gate-parity-probe
- overlap: haravan-botgate-parity-fix (same gate), pagespeed
### haravan-partners-reply-email
- class: **MERGE** → `haravan-partners-theme-submit`; scout cluster A1; roots: managed; SKILL.md 37 lines; desc 196 chars; uses30d(sessions): 3; descQ 4/5; lang VI (diacritics ok)
- action: Move to references/reply-email.md; add "rep mail" trigger words to owner description; drop the Gmail address
- scout verdict text: MERGE→haravan-partners-theme-submit
- stale/verified: Line 8 contains a personal Gmail address (PII) and a dated 04/11/2026 example; refs skills exist
- structure: correct Vietnamese body; description mixes VI trigger
- overlap: haravan-partners-theme-submit (same flow), haravan-partners-switch-account
### haravan-partners-switch-account
- class: **MERGE** → `haravan-partners-theme-submit`; scout cluster A1; roots: managed; SKILL.md 29 lines; desc 230 chars; uses30d(sessions): 7; descQ 4/5; lang EN
- action: Move to references/switch-account.md; fix partners-form.js bugs and delete line-27 workaround
- scout verdict text: MERGE→haravan-partners-theme-submit
- stale/verified: Line 11 lists account emails (PII) and `persist:profile-profile-2`; dated 2026-11-04; line 27 documents bugs of `partners-form.js` (inventory mode unknown, priceIndex -1) instead of fixing the script
- structure: Facts+Steps+Limits good
- overlap: haravan-partners-theme-submit
### haravan-ps-botgate-googlebot-exclusion
- class: **MERGE** → `haravan-ps-botgate`; scout cluster A1; roots: managed; SKILL.md 55 lines; desc 228 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: references/googlebot-exclusion.md; update push wording; keep "manifest lies" facts in hrv-theme-push-fetch-syntax
- scout verdict text: MERGE→haravan-ps-botgate
- stale/verified: Line 45 push "needs explicit per-invocation approval" stale vs AGENTS §8:139 (allowed with --nodelete on bound id); section 6 lists many dead URLs (unverifiable)
- contradiction: Same detector, complementary (UA bot list vs Googlebot allow)
- structure: no references
- overlap: haravan-botgate-parity-fix
### lighthouse-a11y-verification
- class: **MERGE** → `haravan-accessibility`; scout cluster A2; roots: managed; SKILL.md 18 lines; desc 144 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Move to haravan-accessibility/references/axe-rule-gate.md
- scout verdict text: MERGE->haravan-accessibility
- structure: no outcome section, thin
- overlap: haravan-accessibility (neighbour, separate roots), web-perf
### haravan-pages
- class: **RETIRE**; scout cluster A1; roots: agents,claude; SKILL.md 16 lines; desc 137 chars; uses30d(sessions): 3; descQ 1/5; lang EN
- action: Delete from .agents, .claude and any managed root; remove "Do not route to haravan-pages" from haravan SKILL.md:61
- stale/verified: Canonical ref E:/Work/themes/.claude/skills/haravan-theme/references/page-templates.md exists
- contradiction: haravan router still mentions it
- structure: `disable-model-invocation`, `status: retired`
- overlap: haravan-theme owns

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. Bot gate / PageSpeed detector -> owner `haravan-ps-botgate` (rename of haravan-botgate-parity-fix)
   - botgate-parity-fix: SKILL.md = symptom, probe run both ways, UA-first guard, per-profile proof; references/ps-endpoint-and-cors.md = Steps 5-7.
   - ps-botgate-googlebot-exclusion: references/googlebot-exclusion.md (UA matrix, whitelist patch, PSI baseline); push-sync wording goes to hrv-theme-push-fetch-syntax.
   - font-gate-and-dedupe: references/font-gate.md.
   - recaptcha-intent-gate: stays separate (different contract: intent gating) but link from owner.
   - ghn-pagespeed-contract: nosrc/content_for_header parts -> `pagespeed` references/nosrc-contract.md.
2. Lazy images -> owner `haravan-lazy-images` (rename of haravan-lazy-below-fold-proof)
   - lazy-below-fold-proof: SKILL.md (decision step + implement + prove).
   - lazysizes-to-native: references/lazysizes-to-native.md (after repairing corruption), guarded by AGENTS §4:76.
   - ghn-theme-lazyload-migration: references/ghn-case.md (intentional non-image lazy patterns, QA-gate caveats), drop line anchors.
3. Demo shop data -> owner `haravan-demo-kit`
   - demo-live-seed -> references/live-seed.md (stages with approvals).
   - demo-data-audit stays a separate skill (diagnose + fix existing data, owns contact-sheet script); link both ways.
   - f1genztabs-hrv-live-test stays (different target: theme feature test data); add "not for demo seeding".
4. Partners -> owner `haravan-partners-theme-submit`
   - switch-account -> references/switch-account.md; reply-email -> references/reply-email.md.
   - store-bootstrap stays separate (irreversible store creation + OTP, different authority).
5. Preview screenshot -> owner `haravan-preview-screenshot`
   - ep2-preview-capture-antifan -> references/antifan-capture.md (primary surface); screenshot.js stays as fallback.
6. PSI measurement -> owner `psi-measure-proven-haravan` (outside cluster)
   - haravan-preview-pagespeed-measurement -> merge steps 1-8; local Lighthouse -> references/local-lighthouse.md. psi-antifan-serial-runner remains the failure-mode skill.
7. Theme folder baseline -> owner `f1genz-theme-project-scaffold` references/theme-folder-baseline.md; store-bootstrap §0 links to it.
8. hrv push/fetch syntax -> owner `hrv-theme-push-fetch-syntax` (outside cluster); absorb haravan-push-handoff-commands as references/handoff.md after correcting the AGENTS §8 premise.
9. Accessibility/audit/performance rules -> `haravan-accessibility` and `haravan-performance` own rules; `haravan-audit` keeps procedure/preflight/output and links.
10. Admin iframe driving (web.haravan.app, frameUrl) shared by admin-page-create, menu-apply, store-bootstrap: one shared reference `haravan-admin-iframe.md` owned by haravan-admin-page-create-antifan.
11. Retire: `haravan-pages` (stub).

## (c) Rewrite candidates

1. `haravan` (router): no coverage of 29 sibling skills, duplicated tables, stale CLI/settings_data text; rebuild as a short generated routing table.
2. `haravan-preview-screenshot`: 335 lines, nonexistent AGENTS §3.1 cites, self-contradictions, empty heading, residue; reduce to boundary + gates, move detail to references, and fold ep2 AntiFan path.
3. `haravan-lazysizes-to-native` / lazy owner: file corrupted (CJK garbage + duplicated body); opposite advice vs lazy-below-fold-proof and AGENTS §4:76 needs a decision rule.
4. `haravan-empty-settings-render`: teaches hardcoded fallbacks forbidden by AGENTS §4:82 and haravan-audit P8; mixes four unrelated topics.
(Next: `haravan-accessibility` roots differ 44px vs 24px; `f1genz-review` description over-claims Sapo/Shopify.)

## (d) Cluster-level inconsistencies

- Roots: haravan-accessibility differs between .agents (44px) and .claude (24px); no sync process. 76 skills duplicated across roots; managed-skills copies lack the shared `../references/` dir, so the .agents skills' links only resolve in .agents/.claude.
- CLI rule drift: AGENTS §8 allows agent-run hrv select/info/fetch/push --nodelete (03-04/11/2026) but haravan, f1genz-review, antifan-full-site-sweep, overflow-debug, push-handoff-commands, ps-botgate-googlebot-exclusion still say "never run hrv / needs approval per call".
- settings_data.json: skills say read-only by default; AGENTS §8:136 allows edits behind a mandatory `hrv theme fetch --only config/settings_data.json` gate that none of them mention.
- Lazy loading: AGENTS §4:76 keeps nosrc/lazyload; three skills push toward native lazy / deleting lazysizes; one keeps lazysizes. Needs one decision rule.
- Fallback policy: AGENTS §4:82 and haravan-audit forbid hardcoded fallbacks; haravan-empty-settings-render and haravan-demo-data-audit-style defaults conflict.
- Dead AGENTS cites: `AGENTS.md §3.1` (preview-screenshot) and a mis-cited `AGENTS §4 forbids platform detector` (botgate skills).
- Tool name drift: `apply_patch` in accessibility/audit/performance (harness uses edit).
- Path drift: devs2 theme layout wrong in store-bootstrap; GenZ CLAUDE.md missing in header-desktop-menu.
- Metadata style: 4 different frontmatter conventions (extras applyTo/category/keywords/user-invocable/status in .agents; bare name+description in managed); 15 of 38 descriptions lack a trigger or not-for (cluster std-warn description-trigger counts); 29/38 are not reachable from the router.
- Volatile facts embedded: dated "verified" baselines (live-vs-build 07/11, Epres 09/11, Mulgati 08/07), customer theme ids/line numbers (ghn, collection sweep), infra IDs (VPS IP, CF account id), personal emails.
- Language: bodies mostly EN; VI descriptions (f1genz-review, product-recommend, reply-email) have proper diacritics; client-layout-proof body VI/EN mix. No diacritic-less Vietnamese found.
- Scripts without tests: haravan-audit, demo-data-audit, partners-theme-submit, preview-screenshot (std-warn script-tests); committed `__pycache__` in haravan-audit.
