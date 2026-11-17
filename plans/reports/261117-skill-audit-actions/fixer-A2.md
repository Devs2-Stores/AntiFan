# Work order — fixer A2 (Haravan theme part 2)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-A2.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = A2). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### haravan-settings
- class: **REWRITE**; scout cluster A2; roots: agents,claude; SKILL.md 277 lines; desc 201 chars; uses30d(sessions): 39; descQ 3/5; lang EN
- action: Add not-for line "F1GENZ themes -> haravan-settings-schema"; delete duplicate haravan-theme/references/settings-html.md and point haravan-theme Quick Reference row (SKILL.md:25) here; inline the two shared links or add one baseline file inside the skill; move Anti-patterns (261-276) + Special Input Types to references/ to get SKILL.md <150 lines
- scout verdict text: REWRITE (owner of legacy settings.html)
- stale/verified: `../references/*` exist only under .agents/.claude (verified)
- contradiction: SKILL.md:8-10 of haravan-settings-schema says "do not create settings.html" for themes/f1genz; haravan-settings has no f1genz warning, will generate settings.html for f1genz themes
- structure: frontmatter has applyTo/category; 276 lines (<300 but dense); links `../references/haravan-baseline.md`, `../references/haravan-theme-operating-contract-addendum.md` point to shared dir `skills/references/` (exists in .agents/.claude, absent in managed-skills) so not portable; no activation boundary vs F1GENZ
- overlap: haravan-theme/references/settings-html.md (81 of 207/126 lines identical, same headings Rules/Simple/Multi-Item/Anti-patterns); haravan-settings-html-guide (guide block); haravan-settings-schema (F1GENZ, opposite policy)
- absorbs: haravan-settings-html-guide
### haravan-settings-schema
- class: **REWRITE**; scout cluster A2; roots: agents,claude; SKILL.md 62 lines; desc 346 chars; uses30d(sessions): 61; descQ 4/5; lang EN
- action: Sync .agents<-.claude copy (hybrid line); replace line 18 with the §8 rule reference; split Completion Gate rule catalog into references/audit-rules.md; keep description (346 chars, has scope + not-for)
- stale/verified: audit script + references exist (verified); .claude copy has extra hybrid-mode bullet missing in .agents copy
- contradiction: "Never run haravan or hrv CLI without approval for that exact invocation" (SKILL.md:18) vs AGENTS §8 exception (fetch/push allowed w/o approval on bound theme)
- structure: extra dirs agents/openai.yaml (non-standard), references/schema-and-editor-contract.md present, scripts/test present; Completion Gate lines 48-60 are 1-3 line giants (dense, 5 emphasis cruft)
- overlap: haravan-settings (legacy), haravan-theme (page templates), settings-key-live-audit
### haravan-stitch-full-run
- class: **REWRITE**; scout cluster A2; roots: agents,claude; SKILL.md 78 lines; desc 378 chars; uses30d(sessions): 14; descQ 3/5; lang EN
- action: Cut stacked MUST/NEVER (lines 17-26, 65-69) into one "Hard gates" table with reasons; split new-theme-master-prompt.md (569) into phases 0-4/5-9; replace slash refs by skill names; make the kit-file refs absolute (E:/Work/tools/RESTYLE_MASTER_KIT/...); update safety line to AGENTS §8
- stale/verified: `E:/Work/scratch/stitch/prompt-chunk1.txt` in new-theme-master-prompt.md:133,137 (missing, one-off); STITCH_FIDELITY.md etc not in references/; "/haravan" skill exists in .agents/.claude only
- contradiction: SKILL.md:68 "never invoke Haravan CLI without per-action approval" vs AGENTS §8 (bound-theme fetch/push allowed); "load /haravan first" (:19) is a slash-command, not a catalog skill
- structure: SKILL.md ok but 33 emphasis-no-reason, 2 threat-language, 8 broken links; references oversized: new-theme-master-prompt.md 569, final-showcase-pptx.md 283(near), implementation-phase-guide.md 293; refs dir has no STITCH_FIDELITY.md/SKILL_IMPROVEMENT_LOG.template.md/RESTYLE_PROGRESS_LEDGER.md (kit files, referenced like local)
- overlap: final-showcase (final-showcase-pptx.md overlaps), ak-stitch, stitch-chunked-generation, haravan-demo-kit
- absorbs: stitch-chunked-generation
### haravan-theme-verify-without-watcher
- class: **REWRITE**; scout cluster A2; roots: managed; SKILL.md 69 lines; desc 132 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Make owner; fold harness-ab-verify + live-theme-interception-ab as references/; move sections 3-4 (mobile icons, sort order) to references/proof-recipes.md; correct "CLI not allowed" to "CLI only per AGENTS §8, else NEEDS_INPUT"
- scout verdict text: REWRITE (owner of pre-sync proof)
- stale/verified: `E:/Work/tools/RESTYLE_MASTER_KIT/{sanitize_theme_liquid,final_theme_export,description_check}.js` exist
- contradiction: :8 "CLI/push is not allowed", :11 "Never run hrv" vs AGENTS §8 (push --nodelete to bound theme allowed); desc "not for pushing"
- structure: 8 sections incl. unrelated sort/mobile-icon/ZIP/patch hygiene; no activation limit
- overlap: harness-ab-verify, live-theme-interception-ab, prove-floating-controls-hidden (section 3), theme-worker-patch-and-zip (sections 5-6)
- absorbs: haravan-theme-harness-ab-verify, live-theme-interception-ab, prove-floating-controls-hidden
### improve-animations
- class: **REWRITE**; scout cluster A2; roots: claude; SKILL.md 110 lines; desc 447 chars; uses30d(sessions): 33; descQ 4/5; lang EN
- action: Out of Tài's domain; if kept, strip reduced-motion checks and the scripted greeting, add not-for (single diff review); else retire
- scout verdict text: REWRITE or RETIRE
- contradiction: AUDIT/SKILL.md:48,82 and PLAN-TEMPLATE.md:64 recommend/check prefers-reduced-motion; AGENTS §5 forbids it workspace-wide
- structure: extra files AUDIT.md/PLAN-TEMPLATE.md ok; mandatory canned "Initial Response" sentence (:10-14) is prompt cruft; claims "my knowledge comes from Emil Kowalski"
- overlap: none in cluster (not Haravan)
### liquid-theme-static-check
- class: **REWRITE**; scout cluster A2; roots: managed; SKILL.md 54 lines; desc 215 chars; uses30d(sessions): 16; descQ 4/5; lang EN
- action: Add "false positives" note (dynamic keys) + not-for; move script to scripts/ with a test fixture or retire when theme.package_check works
- contradiction: theme-worker-patch-and-zip says theme.settings_check supersedes it
- structure: embedded 30-line script with no tests; no platform note
- overlap: theme.settings_check (AntiFan), theme-worker-patch-and-zip §2 states script false-positives DEAD/DATA MISMATCH with dynamic settings[capture]
### pagespeed
- class: **REWRITE**; scout cluster A2; roots: agents,claude; SKILL.md 376 lines; desc 724 chars; uses30d(sessions): 28; descQ 3/5; lang VI+EN mix
- action: Sync from .claude, cut to <=300: move sections A (noPS), F, G/H/I lessons into references/{nops.md,patterns-audit.md,case-lessons.md}; fix invariant 6; fix worker path; make description "Use for ... not for single-page PSI measuring -> psi-measure-proven-haravan"
- stale/verified: `server-cloudflare.js` not found (:98,:373); probes and templates exist; .claude copy is newer by 32 lines
- contradiction: :31 "Haravan: không tự chạy hrv" vs AGENTS §8; :30 "không dùng prefers-reduced-motion" aligns with §5; :100 says worker misses PSI desktop vs psi-bot-gate "UA regex alone fails desktop" (consistent) but invariant 10 detect uses `viewport 412/1350` while psi-bot-gate says never bare 1350 viewport rule
- structure: >300 lines (oversized-file); invariants mix VI/EN; 10 invariants + 9 more sections (A..K) ; description lists features not a trigger+not-for; refs rely on E:/Work/tools/Pagespeed
- overlap: psi-bot-gate-and-lazy-verify, psi-measure-proven-haravan, hidden-popup-image-deferral, haravan-performance (outside), web-perf, tiny-image
- absorbs: ghn-pagespeed-contract, hidden-popup-image-deferral, psi-bot-gate-and-lazy-verify, psi-measure-proven-haravan
### storefront-translation-script-benchmark
- class: **REWRITE**; scout cluster A2; roots: managed; SKILL.md 54 lines; desc 232 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Re-anchor to the real MultiLanguage repo path, drop session-specific starter prompt (:14), add DoD; move to MultiLanguage/Cloudflare cluster
- stale/verified: bench page `.worktrees/visual-translate-client/bench/text-dictionary.html` missing: `E:/Work/apps/AntiFan/.worktrees` does not exist; repo `public/*.js` unverified; starter prompt in body is cruft
- structure: not Haravan theme work (MultiLanguage app) -> misplaced in cluster
### theme-qa-az
- class: **REWRITE**; scout cluster A2; roots: agents,claude; SKILL.md 77 lines; desc 561 chars; uses30d(sessions): 51; descQ 3/5; lang VI body/desc, diacritics ok
- action: Split H->S convert gates into its own skill (different authority: Sapo convert) or keep with description focused; shrink description to <=450; split qa-checklist (431); fix :68 to §8; add platform note to scripts
- stale/verified: `qa_gate.js` exists; `.claude/skills/haravan-settings-schema/scripts/audit-settings-schema.mjs` exists; `/ck:`-style none
- contradiction: :68 "KHÔNG tự chạy lệnh Haravan/HRV CLI ... luôn hỏi user" vs AGENTS §8
- structure: description 561 chars with ~10 topics (QA + convert + AntiFan + Sapo); refs qa-checklist-a-to-z.md 431 (oversized), h2s-convert-gates 214; assets feedback-dataset 714 lines; scripts/test exist (good) but no platform note; ERR-link 2
- overlap: haravan-storefront-qa-proof-gate, theme-qa-critical-triage, h2s-visual-parity-certify (outside), antifan-qa-cockpit
- absorbs: haravan-storefront-qa-proof-gate, theme-qa-critical-triage
### haravan-settings-key-live-audit
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 51 lines; desc 140 chars; uses30d(sessions): 18; descQ 4/5; lang EN
- action: Add not-for "static only -> haravan-settings-schema audit"; add DoD sentence (CSV path + per-phase table) in a "Done when" line
- stale/verified: cites `haravan-settings-schema/scripts/audit-settings-schema.mjs` rule `settings-duplicate-semantic-key` -> exists as alias at audit script:75 (maps to `duplicate-semantic-key`)
- structure: 10 steps in one body; step 7 line truncated by me only (long); ok
- overlap: haravan-settings-schema (static audit) complements; theme.settings_check
### haravan-storefront-cart-qty-trace
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 76 lines; desc 183 chars; uses30d(sessions): 0; descQ 4/5; lang VI body, desc mixes VI/EN
- action: Add "Done when" line; mark Apshop section 3 as example (dated 06/11/2026) not rule
- stale/verified: cites `assets/main.js.liquid`, `main-no-index.js.liquid`, `F1GEN.Product.clampQuantity` (theme-specific, not verified: no theme path given)
- contradiction: uses `hrv theme push --only ... --nodelete` (consistent with §8)
- structure: no DoD heading (std-warn); fine
### haravan-storefront-get-probes
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 56 lines; desc 260 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Add not-for "clicks/viewports -> AntiFan"; no change needed otherwise
- stale/verified: cites `storefront-widget-cdn-bypass-verify` (exists only in managed-skills), `anti.theme.await_cdn_sync`
- structure: python snippet inline ok
- overlap: storefront-widget-cdn-bypass-verify; haravan-storefront-qa-proof-gate (different evidence tier)
### haravan-theme
- class: **KEEP**; scout cluster A2; roots: agents,claude; SKILL.md 117 lines; desc 254 chars; uses30d(sessions): 41; descQ 4/5; lang EN
- action: Split two oversized refs into <=300-line files (e.g. page-templates-pdp.md / -blog-cart.md; cheatsheet-filters.md / -img-url.md); drop settings-html.md; delete retired haravan-pages dir
- scout verdict text: KEEP (trim)
- stale/verified: `haravan-pages` "retired" (:13) but dir still in .agents/.claude skills
- structure: refs oversized: page-templates.md 478, liquid-cheatsheet.md 466 (>300); links `../references/haravan-baseline.md`, `local-skill-routing.md` (shared dir only); cites `themes/docs/rules/` (E:/Work/themes/docs/rules exists, relative path)
- overlap: haravan-settings (settings-html.md dup), haravan-audit, haravan-performance
### haravan-theme-dead-code-purge
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 40 lines; desc 193 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Rephrase 12 to "no `--prune`, no push of deletes; watcher handles deletes"; add DoD (dangling-ref scan = 0 new, counters gate)
- scout verdict text: KEEP (edit)
- stale/verified: uses `settings_merge.js` (exists)
- contradiction: "Never run hrv/haravan yourself" (:12) vs AGENTS §8; also deletes via watcher "pushes deletes" while §8 requires --nodelete for CLI push
- structure: no DoD; refers Epres 2026-10-24 incident (volatile intro)
- overlap: liquid-theme-static-check (dangling refs check)
### haravan-theme-image-compression
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 14 lines; desc 143 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Absorb s2-spa figures as an example; add not-for "upload to Haravan Files -> haravan-upload-file"
- scout verdict text: KEEP (owner)
- stale/verified: `E:/Work/tools/Generate` + sharp exist
- structure: no DoD heading; single paragraph steps
- overlap: s2-spa-sharp-theme-compression (same recipe), haravan-upload-file (also Sharp, other contract)
### haravan-theme-niche-scan
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 41 lines; desc 194 chars; uses30d(sessions): 3; descQ 4/5; lang EN desc, VI-instruction end
- action: Move 2026-10 numbers (lines 8, 28, 30) into a dated "Evidence" block so they are not read as rules
- stale/verified: `E:/Work/themes/devs2`, `themes/f1genz` exist
- structure: OK; contains dated results (2026-10)
### haravan-theme-vietnamese-localization
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 32 lines; desc 212 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Replace line 20 with §8 fetch gate (agent runs `hrv theme fetch --only config/settings_data.json`); add "Done when" (key count equal, English regex 0 hits)
- scout verdict text: KEEP (edit)
- stale/verified: `E:/Work/tools/RESTYLE_MASTER_KIT/settings_merge.js` exists
- contradiction: :20 "user must run hrv theme fetch (agent hooks refuse...)" vs AGENTS §8: any agent may fetch on bound theme
- structure: no DoD heading
- overlap: haravan-settings (settings_data patch rules), MultiLanguage app (declared not-for)
### haravan-thiet-lap-save-roundtrip
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 31 lines; desc 186 chars; uses30d(sessions): 2; descQ 4/5; lang VI desc
- action: Keep separate (writes live store via Lưu); add not-for pointer to haravan-settings for authoring
- stale/verified: "verified on TrueBeef 2026-10-26" volatile
- contradiction: none (uses hrv fetch consistent with §8)
- structure: dense procedure 7 steps, no refs
- overlap: haravan-settings-html-guide (admin iframe verify), haravan-settings
### haravan-upload-file
- class: **KEEP**; scout cluster A2; roots: agents,claude; SKILL.md 196 lines; desc 135 chars; uses30d(sessions): 30; descQ 4/5; lang EN
- action: Add scripts/test with 1 offline test per script; replace absolute .agents path by `<skill-dir>/scripts/...`; trim "Known limits (not yet verified)" to references/
- scout verdict text: KEEP (harden)
- stale/verified: `scripts/antifan-stage.mjs`, `upload.mjs` exist; `E:/Work/tools/haravan-upload-toolkit` exists; no tests found (verified listing)
- contradiction: none; says "does NOT run Haravan/HRV CLI" (consistent)
- structure: 4 subdirs but scripts have NO test dir (std-warn script-tests); evals/evals.json ok; hard-coded `C:/Users/Admin/.agents/skills/...` script path
- overlap: haravan-settings (assets upload contract), tiny image skills not overlapping
### levents-guide-pipeline
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 36 lines; desc 178 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Rename to customer-scoped (levents-*) is fine; move counts to a "last run" note; add DoD (HEAD verify)
- scout verdict text: KEEP (move)
- stale/verified: scripts `plans/build-levents-guide.py`, `upload-to-r2.py` exist; "AGENTS.md §8" cited for approval, hard-coded counts (21 sections, 596 fields) volatile; themeid 1001507718
- structure: customer-specific one-off
- overlap: customize-customer-guide, theme-handover-guide, customer-theme-guide (outside cluster)
### site-clone
- class: **KEEP**; scout cluster A2; roots: agents,claude; SKILL.md 219 lines; desc 140 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Replace `/ck:*` by ak-* skill names; add not-for "Stitch export -> haravan-stitch-full-run"
- scout verdict text: KEEP (fix)
- stale/verified: `/ck:*` at SKILL.md:35,63,200-202; target-adapters.md:10
- structure: refs 6 files <=144 lines OK; README.md in skill dir; `/ck:xia /ck:plan /ck:cook /ck:scout` slash commands stale (catalog uses ak-xia, ak-plan, ak-cook, ak-scout)
- overlap: haravan-stitch-full-run (other upstream), ak-xia
### theme-worker-patch-and-zip
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 78 lines; desc 191 chars; uses30d(sessions): 13; descQ 4/5; lang EN
- action: Own patch/ZIP hygiene; remove duplicate sections from verify-without-watcher; mark :9 as "when job forbids CLI"
- scout verdict text: KEEP (owner of patch+ZIP)
- contradiction: "without running hrv/haravan/sapo theme commands" (:9) is a Leader-job constraint, conflicts with §8 generally
- structure: ok; refers script file must not be `python -c`
- overlap: verify-without-watcher §5-6 (same patch/zip hygiene)
### tiny-product-image-qa
- class: **KEEP**; scout cluster A2; roots: managed; SKILL.md 33 lines; desc 188 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Move "Seed temp product" (live-store write) to references with explicit approval gate; add DoD
- stale/verified: none verifiable; seeds products in live Sapo admin via fetch
- contradiction: `hrv product create` / `hrv api POST` (:15) need approval; AGENTS §8 does not list them (only 4 theme/org forms) so still user-gated: consistent
- structure: no outcome heading; verified date 2026-10-28 Lux Shoes
### antifan-haravan-verify-loop
- class: **MERGE** → `haravan-storefront-qa-proof-gate` (final `theme-qa-az`); scout cluster C; roots: managed; SKILL.md 41 lines; desc 225 chars; uses30d(sessions): 5; descQ 2/5; lang EN
- action: Move "images pending / compositor stalls / failover trap" to proof-gate `references/antifan-verify-pitfalls.md`; drop theme-specific selectors; retire name.
- scout verdict text: MERGE→haravan-storefront-qa-proof-gate
- stale/verified: tool names written `anti_browser_evaluate` (underscore alias) vs docs `anti.browser.evaluate`
- structure: desc lists tricks, no trigger/not-for; selectors `.tb-hero__slide` etc are theme-specific example
- overlap: haravan-storefront-qa-proof-gate, haravan-antifan-full-site-sweep, antifan-qa-cockpit
### antifan-qa-verdict-qualification
- class: **MERGE** → `haravan-storefront-qa-proof-gate` (final `theme-qa-az`); scout cluster C; roots: managed; SKILL.md 19 lines; desc 169 chars; uses30d(sessions): 8; descQ 4/5; lang EN
- action: Single place for verdict wording; others link.
- scout verdict text: MERGE→haravan-storefront-qa-proof-gate or cockpit
- stale/verified: `qa_gate.js --coverage-floor 1` exists
- structure: tiny; good
- overlap: cockpit (§2 step 6 repeats "only CERTIFIED counts"), haravan-storefront-qa-proof-gate
### ghn-pagespeed-contract
- class: **MERGE** → `pagespeed`; scout cluster A1; roots: managed; SKILL.md 34 lines; desc 137 chars; uses30d(sessions): 5; descQ 2/5; lang EN
- action: Move nosrc contract + content_for_header removal into pagespeed references/nosrc-contract.md; a11y fixes (video-caption, heading-order) into haravan-accessibility references/lighthouse-fixes.md; retire name
- scout verdict text: MERGE→pagespeed
- stale/verified: nothing checked on disk (customer theme); mentions `?themeid=` flows
- contradiction: AGENTS §4 line 76 consistent
- structure: description no trigger/not-for, no "when"; no H1; customer name in skill name
- overlap: pagespeed (375 lines, .agents), haravan-performance, haravan-botgate-parity-fix, haravan-accessibility
### haravan-preview-pagespeed-measurement
- class: **MERGE** → `psi-measure-proven-haravan` (final `pagespeed`); scout cluster A1; roots: managed; SKILL.md 31 lines; desc 135 chars; uses30d(sessions): 11; descQ 3/5; lang EN
- action: Move steps 1-8 into psi-measure-proven-haravan; keep fallback local Lighthouse as references/local-lighthouse.md; retire name
- scout verdict text: MERGE→psi-measure-proven-haravan
- stale/verified: `psi-antifan-runner.js` verified in E:/Work/tools/Pagespeed/probes
- structure: no "not-for"
- overlap: psi-measure-proven-haravan (22 lines), psi-antifan-serial-runner (67 lines), pagespeed (.agents 375 lines)
### haravan-settings-html-guide
- class: **MERGE** → `haravan-settings`; scout cluster A2; roots: managed; SKILL.md 47 lines; desc 188 chars; uses30d(sessions): 5; descQ 4/5; lang VI body, EN-VI desc
- action: Move to haravan-settings/references/guide-block.md (sections 2-6), keep one-line pointer in SKILL.md; keep section 3 as the only hrv push recipe
- scout verdict text: MERGE->haravan-settings
- stale/verified: cites `E:/Work/themes/ref/Dressly_final_new/config/settings.html` (exists) and `C:/Users/Admin/.claude/skills/haravan-settings-schema/scripts/audit-settings-schema.mjs` (exists); dated "04/11/2026" volatile
- contradiction: consistent with AGENTS §8 (single-line hrv, bound theme id); push step relies on "hook workspace" wording
- structure: no references; missing outcome/DoD section (std-warn)
- overlap: haravan-settings (settings.html authoring)
### haravan-storefront-qa-proof-gate
- class: **MERGE** → `theme-qa-az`; scout cluster A2; roots: managed; SKILL.md 17 lines; desc 141 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Move steps 1-9 to theme-qa-az/references/antifan-live-qa-recipe.md "Proof gate" section (that file already covers sync gate/CERTIFIED/QA_PENDING_SYNC); retire dir
- scout verdict text: MERGE->theme-qa-az
- stale/verified: none (generic)
- structure: 9 dense numbered lines, no DoD section
- overlap: theme-qa-az Pass 3 (same qa_validate gate), theme-qa-critical-triage, haravan-theme-verify-without-watcher
- absorbs: antifan-haravan-verify-loop, antifan-qa-verdict-qualification
### haravan-theme-harness-ab-verify
- class: **MERGE** → `haravan-theme-verify-without-watcher`; scout cluster A2; roots: managed; SKILL.md 50 lines; desc 184 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: See cluster 1
- scout verdict text: MERGE->haravan-theme-verify-without-watcher
- stale/verified: none verifiable
- structure: no refs, long; section 4 packaging overlaps
- overlap: haravan-theme-verify-without-watcher, live-theme-interception-ab (all "prove edit before CDN sync")
### hidden-popup-image-deferral
- class: **MERGE** → `pagespeed`; scout cluster A2; roots: managed; SKILL.md 28 lines; desc 206 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Move to pagespeed/references/hidden-popup-images.md; psi-bot-gate keeps only its section 2 pointer
- scout verdict text: MERGE->pagespeed (as reference)
- stale/verified: cites `probes/lazy-audit.js` (= E:/Work/tools/Pagespeed/probes/lazy-audit.js exists) but writes relative path
- structure: none; contains measured numbers
- overlap: psi-bot-gate-and-lazy-verify section 2 (same lazy rule), pagespeed D
### live-theme-interception-ab
- class: **MERGE** → `haravan-theme-verify-without-watcher`; scout cluster A2; roots: managed; SKILL.md 20 lines; desc 206 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: reference file `references/interception-ab.md`; replace scratch dependency with `E:/Work/tools/Pagespeed` puppeteer env
- scout verdict text: MERGE->haravan-theme-verify-without-watcher
- stale/verified: `E:/Work/scratch/lh/node_modules` exists but scratch = fragile
- structure: terse steps
- overlap: harness-ab-verify, verify-without-watcher
### prove-floating-controls-hidden
- class: **MERGE** → `haravan-theme-verify-without-watcher`; scout cluster A2; roots: managed; SKILL.md 28 lines; desc 179 chars; uses30d(sessions): 7; descQ 4/5; lang EN
- action: Move recipe to proof-recipes.md as "Positive-control probe"; keep unique acceptance bullets
- scout verdict text: MERGE->haravan-theme-verify-without-watcher
- structure: no DoD heading
- overlap: verify-without-watcher §3 (same proof, different probe), tiny-product-image-qa
### psi-bot-gate-and-lazy-verify
- class: **MERGE** → `pagespeed`; scout cluster A2; roots: managed; SKILL.md 34 lines; desc 215 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move into pagespeed/references/verify-gate.md; pagespeed SKILL.md keeps a "Close-out" pointer
- scout verdict text: MERGE->pagespeed
- stale/verified: `E:/Work/tools/Pagespeed/probes/{gate-parity-probe,lazy-audit,parity-shot}.js` exist
- overlap: pagespeed (A, J, K), hidden-popup-image-deferral, psi-measure-proven-haravan
### psi-measure-proven-haravan
- class: **MERGE** → `pagespeed`; scout cluster A2; roots: managed; SKILL.md 23 lines; desc 197 chars; uses30d(sessions): 0; descQ 4/5; lang VI body
- action: Move to pagespeed/references/psi-measure.md (keep nc token + Captured at + two-panel check)
- scout verdict text: MERGE->pagespeed
- stale/verified: none (pagespeed.web.dev)
- overlap: pagespeed section B
- absorbs: haravan-preview-pagespeed-measurement
### stitch-chunked-generation
- class: **MERGE** → `haravan-stitch-full-run`; scout cluster A2; roots: managed; SKILL.md 32 lines; desc 139 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: references/stitch-upstream-chunked.md (or into ak-stitch if exclusive to Stitch); remove scratch dependency (mkdir at run)
- scout verdict text: MERGE->haravan-stitch-full-run
- stale/verified: `E:\Work\scratch\stitch` missing (scratch); `~/.omp/agent/skills/ak-stitch/scripts` exists
- contradiction: none; "Never print values" ok
- structure: no DoD heading
- overlap: haravan-stitch-full-run (upstream stage), ak-stitch
### theme-qa-critical-triage
- class: **MERGE** → `theme-qa-az`; scout cluster A2; roots: managed; SKILL.md 49 lines; desc 251 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: Move to theme-qa-az/references/critical-triage.md; theme-qa-az Pass 3 links it
- scout verdict text: MERGE->theme-qa-az
- contradiction: edit & push section :45 allows push --nodelete (consistent)
- structure: no DoD heading (std-warn desc-trigger)
- overlap: theme-qa-az (Pass 3), qa-proof-gate
### levents-product-card-gallery-diagnosis
- class: **RETIRE**; scout cluster A2; roots: managed; SKILL.md 15 lines; desc 161 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Fold into levents-guide-pipeline or levents project notes; not a reusable contract
- stale/verified: cites annotation id `element_1791356505075` and `lv-home-bp*.css.liquid` (not checked)
- structure: single-incident skill
### mnbakery-about-header-clearance
- class: **RETIRE**; scout cluster A2; roots: managed; SKILL.md 11 lines; desc 105 chars; uses30d(sessions): 0; descQ 2/5; lang EN
- action: Fold the CAPTURE_FRAME_STARVATION tip into levents-guide-pipeline/antifan-qa-cockpit notes; delete
- structure: 3-line customer-specific note; no frontmatter beyond name/desc
- overlap: prove-floating-controls-hidden (probing method)
### s2-spa-sharp-theme-compression
- class: **RETIRE**; scout cluster A2; roots: managed; SKILL.md 15 lines; desc 154 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Move the 54 images/2.77 MB data point into haravan-theme-image-compression as an example; delete
- stale/verified: sharp path exists
- structure: customer/theme-specific duplicate of image-compression
- overlap: haravan-theme-image-compression (same)
### web-perf
- class: **RETIRE**; scout cluster A2; roots: agents,claude; SKILL.md 202 lines; desc 453 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Retire; its generic CWV workflow is covered by pagespeed + AntiFan inspect tools
- scout verdict text: RETIRE (or make pagespeed reference)
- stale/verified: `chrome-devtools-mcp` tools (navigate_page, performance_start_trace) not among mounted tools
- structure: not Tài's toolchain: requires chrome-devtools MCP (not mounted; Tài uses AntiFan, Lighthouse CLI); no not-for; "Be assertive" rules
- overlap: pagespeed (B measure, C playbook), psi-measure

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters
1. **Pre-sync / watcher-dead proof** — owner: `haravan-theme-verify-without-watcher`.
   - harness-ab-verify -> references/proxy-harness.md (sections 1-3 proxy, measure, honest report).
   - live-theme-interception-ab -> references/interception-ab.md.
   - prove-floating-controls-hidden -> references/proof-recipes.md (positive-control probe).
   - verify-without-watcher keeps: watcher-absent proof, style_override flow, harness traps, report states (QA_PENDING_SYNC). Move its sections 3-4 (mobile icons, sort order) and 5-6 patch/ZIP to proof-recipes.md / theme-worker-patch-and-zip. Fix all "never run hrv" to AGENTS §8 wording.
2. **PageSpeed** — owner: `pagespeed` (use .claude version as base).
   - psi-bot-gate-and-lazy-verify -> references/verify-gate.md; psi-measure-proven-haravan -> references/psi-measure.md; hidden-popup-image-deferral -> references/hidden-popup-images.md; web-perf retired (generic).
   - SKILL.md keeps invariants + routing table (<=300); moves A (noPS), F, G/H/I into references.
3. **Legacy settings.html** — owner: `haravan-settings`.
   - haravan-theme/references/settings-html.md deleted (duplicate); haravan-settings-html-guide -> references/guide-block.md. Keep `haravan-thiet-lap-save-roundtrip` (live write) and `haravan-settings-key-live-audit` (read-only audit) separate; `haravan-settings-schema` is the F1GENZ counterpart (add cross-not-for in both).
4. **Theme QA** — owner: `theme-qa-az`.
   - storefront-qa-proof-gate -> recipe section; theme-qa-critical-triage -> references/critical-triage.md. Keep `haravan-storefront-get-probes` separate (browserless tier).
5. **Image compression** — owner: `haravan-theme-image-compression`; s2-spa-sharp-theme-compression retired into an example. `haravan-upload-file` stays separate (remote write).
6. **Stitch** — owner: `haravan-stitch-full-run` (conversion) with stitch-chunked-generation as references/upstream-chunked.md (or moved to ak-stitch).
7. **Customer one-offs**: levents-product-card-gallery-diagnosis, mnbakery-about-header-clearance -> retire/fold into the customer notes; levents-guide-pipeline stays customer-scoped.
8. **Accessibility**: lighthouse-a11y-verification -> haravan-accessibility reference.

## (c) Rewrite candidates
1. **pagespeed**: 376/407 lines, copies drifted (.claude newer), feature-list description, missing worker file, hrv rule stale; split into SKILL.md <=300 + 4 references and absorb psi-* skills.
2. **haravan-theme-verify-without-watcher**: 8 mixed sections, "CLI not allowed" contradicts AGENTS §8; make it the single proof-owner with references.
3. **haravan-stitch-full-run**: 33 unreasoned emphasis markers, 569-line reference, slash-command and kit-file references not local, 8 broken links.
4. **theme-qa-az**: 561-char multi-topic description, 431-line checklist, "never run hrv" line; split QA vs H->S convert gates.
(Honourable: haravan-settings-schema sync + hrv line; haravan-settings not-for F1GENZ.)

## (d) Cluster-level inconsistencies
- **hrv rule drift**: AGENTS §8 (04/11/2026) lets any agent run `hrv select/theme info/theme fetch/theme push --only <f> --nodelete` on the bound theme id. Skills still say "never/ask first/user must run": pagespeed:31, haravan-settings-schema:18, haravan-stitch-full-run:68, theme-qa-az:68, haravan-theme-dead-code-purge:12, haravan-theme-verify-without-watcher:8,11, haravan-theme-vietnamese-localization:20, theme-worker-patch-and-zip:9 (this one is valid only as a Leader-job constraint). Meanwhile settings-html-guide, thiet-lap, cart-qty-trace, critical-triage already use the §8 forms. One shared "Haravan CLI gate" paragraph should be referenced instead of copied.
- **Reduced motion**: AGENTS §5 bans `prefers-reduced-motion`; improve-animations (SKILL.md:48,82, PLAN-TEMPLATE.md:64) recommends it; pagespeed:30 matches §5.
- **F1GENZ vs legacy settings**: haravan-settings-schema forbids settings.html for themes/f1genz; haravan-settings and haravan-theme/references/settings-html.md do not mention that boundary.
- **Shared `../references/*` links** (haravan-settings, haravan-theme, haravan-stitch-full-run) resolve only under .agents/.claude (`skills/references/`); managed-skills has no such dir, so the same skill is broken there.
- **Root drift**: `pagespeed` and `haravan-settings-schema` differ between .agents and .claude (the cluster's primary .agents copy is the older one); also haravan-accessibility/shopify differ (outside this cluster).
- **Retired skill still present**: haravan-theme says `haravan-pages` retired (:13) but directory remains in .agents/.claude.
- **Slash-command prefixes**: site-clone uses `/ck:*`, stitch-full-run uses `/haravan`; the live catalog uses ak-* skill names.
- **Fragile anchors**: `E:/Work/scratch/*` (stitch, lh), nonexistent `.worktrees` bench, missing `server-cloudflare.js`; dated incident facts embedded as rules in niche-scan, dead-code-purge, thiet-lap, tiny-image.
- **Structure**: 22 of 38 SKILL.md lack a "Done when/outcome" section; 4 skills >300 lines or with >300-line references (pagespeed, haravan-theme refs, theme-qa-az refs, stitch-full-run refs); haravan-upload-file scripts have no tests.
