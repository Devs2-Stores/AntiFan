# Work order — fixer D (Sapo + Shopify)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-D.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = D). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### sapo
- class: **OWNER**; scout cluster D; roots: agents,claude; SKILL.md 85 lines; desc 146 chars; uses30d(sessions): 9; descQ 3/5; lang EN
- action: Keep as the single Sapo entrypoint; drop duplicate routing-table.md; add rows for the managed sapo-* ops skills (editor sweeps, admin edit, app live verify) which are currently undiscoverable from the router
- scout verdict text: KEEP (trim)
- stale/verified: links to ../references/{ai-image-visual-truth..., proof-block-output-template, local-skill-routing}.md all exist (.agents/skills/references/); `.workspace-context.json` convention not verified
- contradiction: l.36 says "do not invoke ghost skills (sapo-theme-audit…)" but sapo-liquid:16,20 routes to `sapo-theme-templates/-snippets/-settings/-audit`
- structure: has refs (3) + routing-table duplicating the in-body table; 6 ERR-link (std-warn)
- overlap: duplicates routing-table.md; overlaps sapo-validation (routing checks)
- absorbs: sapo-theme-workflow
### sapo-admin-theme-file-edit-antifan
- class: **OWNER**; scout cluster D; roots: managed; SKILL.md 69 lines; desc 142 chars; uses30d(sessions): 0; descQ 4/5; lang EN (VI UI strings)
- action: Absorb the other two editor skills (see cluster 1); description add "not for Haravan/Shopify" already present
- scout verdict text: KEEP as OWNER
- stale/verified: facts verified on one shop f1genz-seafoods (l.68) — shop-specific; selectors not re-verifiable offline
- contradiction: l.63 "Never call UpdateAssets endpoint or any Theme API yourself" vs sapo-theme-install-real-test:12 and sapo-app-live-install-verify:8 which write assets.json via cookie fetch; l.30 uses replaceRange('+input') because setValue "sometimes ignored" vs sapo-theme-edit-via-admin-editor:10 uses cm.setValue and works; l.65 theme-CLI guard note
- structure: no DoD heading but §7-9 are evidence steps; clean
- overlap: sapo-theme-edit-via-admin-editor, sapo-theme-snippet-embed-verify (same editor, same #save-button trap, same backup+hash+rollback)
- absorbs: sapo-theme-edit-via-admin-editor, sapo-theme-snippet-embed-verify
### sapo-app-live-install-verify
- class: **OWNER**; scout cluster D; roots: managed; SKILL.md 21 lines; desc 196 chars; uses30d(sessions): 7; descQ 4/5; lang EN
- action: Owner of "Sapo app live verification"; add references/review-app-feature-walkthrough.md from the walkthrough skill; state this is F1GENZ Review-specific or generalise
- scout verdict text: MERGE (owner)
- stale/verified: repo F1GENZ_Review_Sapo paths not checked (not cited as absolute); developers.sapo.vn URL form unverifiable
- contradiction: secrets: see sapo-app
- structure: single wall-of-steps, no DoD; F1GENZ_Review_Sapo-specific (aggregateRating, Prisma, port 5174, dist/main.js) though name/desc are generic
- overlap: sapo-review-app-antifan-feature-walkthrough (same app, same tunnel/admin tab prereqs); sapo-theme-install-real-test (real-shop asset writes)
- absorbs: sapo-review-app-antifan-feature-walkthrough
### shopify-theme
- class: **OWNER**; scout cluster D; roots: agents,claude; SKILL.md 67 lines; desc 246 chars; uses30d(sessions): 3; descQ 2/5; lang EN
- action: Absorb the 7 specialists as references/<surface>.md (their checklists are 96-134 lines each); fix refs; fix l.44-45
- scout verdict text: KEEP as OWNER
- stale/verified: refs missing as listed; ../shopify/references/theme-preflight-evidence-contract.md exists
- structure: quick-ref points to 4 NON-EXISTENT refs (liquid-patterns.md, template-architecture.md, collection-patterns.md, settings-patterns.md; only common/section/snippet/product-page exist); stray corruption at l.44-45 ("Goal** 4—", "5." line number glitch); applyTo frontmatter
- overlap: specialists shopify-theme-{sections,snippets,templates,settings,collection-page,product-page,liquid}: 7 thin skills point back here ("route code to shopify-theme")
- absorbs: shopify-liquid, shopify-theme-collection-page, shopify-theme-product-page, shopify-theme-sections, shopify-theme-settings, shopify-theme-snippets, shopify-theme-templates
### shopify-theme-quality
- class: **OWNER**; scout cluster D; roots: agents,claude; SKILL.md 50 lines; desc 238 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Absorb the 5 specialists as references/{audit,a11y,performance,seo,store-readiness}.md; description keeps one trigger per dimension
- scout verdict text: KEEP as OWNER
- stale/verified: refs audit-checklist.md & a11y-checklist.md (copies of specialists')
- contradiction: "Work: no prefers-reduced-motion" OK
- structure: umbrella that duplicates five specialists in a table and routes fixes to shopify-theme; ERR-link; applyTo
- overlap: specialists audit/accessibility/performance/seo-content/store-readiness
- absorbs: shopify-theme-accessibility, shopify-theme-audit, shopify-theme-performance, shopify-theme-seo-content, shopify-theme-store-readiness
### devs2-rebel-storefront-verify → rename `devs2-sartor-storefront-verify`
- class: **REWRITE**; scout cluster D; roots: managed; SKILL.md 45 lines; desc 164 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Rename `devs2-sartor-storefront-verify`; move baseline numbers into a dated reference; make the 3 other skills point here for QA gates/triage; recreate or remove journeys.cjs/r5-axe refs
- scout verdict text: REWRITE (rename)
- stale/verified: `E:/Work/shopify/runs/e2e/journeys.cjs` MISSING (l.18; only hidden-focus.cjs, lib.cjs exist; l.18 itself says "may need recreating"); `r5-axe.cjs` cited by shopify-demo-image-pipeline:53 MISSING; theme renamed Rebel→Sartor 2026-10-30 (rebel-demo-store-sync-qa:8) but name/title still "Rebel"; render-check.mjs + check-discovery-surfaces.mjs exist (OK)
- contradiction: "never stop it"/"Run no shopify * command" consistent with rules; "Workspace rules forbid prefers-reduced-motion" matches E:/Work/AGENTS.md:98
- structure: no Use-when trigger beyond "verifying"; no not-for; no DoD block; hardcoded baselines (97 rows, 13 err/20 warn/28 info, 259 tab stops)
- overlap: rebel-demo-store-sync-qa §6 (same triage list), shopify-demo-image-pipeline §6, shopify-demo-store-seed §6 (all repeat QA gates/known false positives)
### shopify-theme-store-submission
- class: **REWRITE**; scout cluster D; roots: managed; SKILL.md 90 lines; desc 255 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Split: keep submission ops; move §5 demo-tag enablement to shopify-demo-store-ops; mark one version of tag count authoritative; drop "update this skill" line; move org/email facts to a dated reference
- stale/verified: `dist/sartor-v1.0.0.zip` MISSING (sync-qa:45; here ok: no absolute); scratch/submission/{shots,highlights}.mjs, scratch/lh/node_modules not verified (shopify/scratch/lh exists); Partners URL/org ids unverifiable offline
- contradiction: l.34 vs sync-qa:90 (replace-file wipes vs preserves); l.52 44 tags vs sync-qa:91 43; l.76 `REBEL_SHOPIFY` consistent; contains personal Gmail address (l.12) and CF email routing recipe (l.86) — PII/oversharing not secret
- structure: many dated incident lessons ("update this skill after every run" self-edit instruction); one truncated 44-tag line (l.52); demo-ops §5 is a second task (making demo show tags)
- overlap: rebel-demo-store-sync-qa §7, shopify-theme-store-readiness (generic)
### sapo-app
- class: **KEEP**; scout cluster D; roots: agents,claude; SKILL.md 65 lines; desc 166 chars; uses30d(sessions): 18; descQ 4/5; lang EN
- action: Add cross-link to sapo-app-live-install-verify and a "local-secret exception for own app" line; delete feasibility stub
- stale/verified: refs hard-stops.md/sandbox-validation.md exist and duplicate sapo-app-feasibility copies (md5 identical)
- contradiction: l.37 "do not request or process secrets, webhook secrets" vs sapo-app-live-install-verify:15 compares HMAC against client secret and reads session tokens — no documented exception
- structure: 6 refs fine; no explicit "not for" in description; std-warn missing sections
- overlap: sapo-app-feasibility (retired stub), sapo-app-live-install-verify (different: real-store run)
### sapo-app-store-listing-fill-antifan
- class: **KEEP**; scout cluster D; roots: managed; SKILL.md 52 lines; desc 160 chars; uses30d(sessions): 2; descQ 4/5; lang EN (VI UI strings)
- action: Add not-for (theme upload, other Sapo forms); move measured limits to a dated reference
- stale/verified: form field limits measured on 1 app — volatile; "publish playbook" in project not located
- contradiction: l.22 "never click Đăng ứng dụng without approval" consistent
- structure: description is VI-form context but EN; facts block dated "2026-11-11 (app 3833)"; ok size
- overlap: none (Haravan analogue haravan-partners-theme-submit is another cluster)
### sapo-editor-draft-key-fill
- class: **KEEP**; scout cluster D; roots: managed; SKILL.md 37 lines; desc 174 chars; uses30d(sessions): 1; descQ 3/5; lang EN
- action: Keep (it writes live settings; different authority) but move mechanism block to shared `references/editor-draft-mechanism.md` in the sweep owner and link
- scout verdict text: KEEP (shared ref)
- stale/verified: refs `Sapo/backups/...` relative project path; no absolute paths
- contradiction: l.13 NEVER SaveSettingChanges vs l.26 clicks Save button (editor Save; ambiguity) ; sweeps are no-save while this one persists — different authority
- structure: emphasis NEVER (l.13) has reason, ok; step list lacks DoD
- overlap: sapo-editor-draft-setting-sweep, sapo-editor-human-input-sweep (same override.json/?_sc=1&designThemeId mechanism, repeated in 3 skills)
### sapo-liquid
- class: **KEEP**; scout cluster D; roots: agents,claude; SKILL.md 62 lines; desc 310 chars; uses30d(sessions): 4; descQ 3/5; lang audit` that have NO SKILL.md (only references/scripts dirs)
- action: contradicts sapo/SKILL.md:36 ghost rule|EN|MERGE→sapo-theme|Fold SKILL body into sapo-theme "Liquid" section; keep liquid-patterns.md (54 lines, differs from sapo-theme's 34) as references/liquid-patterns.md; drop duplicate theme-tags.md
- scout verdict text: sapo-theme (same Platform Rules block, same reference file, same workflow steps)
- stale/verified: refs theme-tags.md (md5 identical to sapo-theme's) ; l.16/20 routes to ghost skills `sapo-theme-templates
- contradiction: settings
- structure: description 310 chars packed with keywords (form quirks) that the body does not carry (only in refs); duplicates sapo-theme platform rules verbatim
- overlap: snippets
### sapo-theme
- class: **KEEP**; scout cluster D; roots: agents,claude; SKILL.md 64 lines; desc 227 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Fix 2 links; absorb sapo-liquid; delete duplicated refs in ghost dirs
- scout verdict text: KEEP as OWNER
- stale/verified: l.12 `../references/sapo-baseline.md` MISSING (file is in sapo/references/); l.13 `../../references/ai-image...` MISSING (correct is ../references/); 2 refs listed but 4 exist
- structure: desc lacks not-for; "Output Format" prescribes 5-heading report for code gen (heavy); broken links
- overlap: sapo-liquid, sapo-theme-quality (audit duplication), ghost sapo-theme-snippets (snippet-patterns.md md5-identical), ghost sapo-theme-product-page (product-page-checklist.md identical)
### sapo-theme-install-real-test
- class: **KEEP**; scout cluster D; roots: managed; SKILL.md 23 lines; desc 235 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Keep distinct (unpublished theme, programmatic); add "scope: unpublished theme only" to owner's trap rule
- scout verdict text: KEEP (reconcile)
- stale/verified: esbuild alias paths, `worker/src/shims` project-specific, unverified
- contradiction: l.12 direct asset-API writes via cookie vs sapo-admin-theme-file-edit-antifan:63 "never call UpdateAssets/Theme API; UI buttons only"
- structure: procedure + facts OK; no DoD but §6-7 define proof/not-proven
- overlap: sapo-app-live-install-verify (real-shop), sapo-admin-theme-file-edit (writes assets)
### sapo-theme-quality
- class: **KEEP**; scout cluster D; roots: agents,claude; SKILL.md 58 lines; desc 230 chars; uses30d(sessions): 10; descQ 3/5; lang EN
- action: Fix link + rule citation; delete duplicated checklists in ghost dirs; keep as Sapo quality owner
- stale/verified: l.12 `../references/sapo-baseline.md` MISSING; l.39 "Work override ... root CLAUDE.md": rule actually lives in E:/Work/AGENTS.md:98 (rg: NOT in ~/.claude/CLAUDE.md); sapo-checklist.md md5-identical to ghost sapo-theme-audit's
- contradiction: cites wrong rule file
- structure: umbrella that points findings to sapo-theme; ERR-link; Output format duplicates sapo-theme
- overlap: ghost sapo-theme-audit/performance/accessibility/seo/store-readiness (reference-only dirs); shopify-theme-quality is its twin
### shopify-demo-image-pipeline
- class: **KEEP**; scout cluster D; roots: managed; SKILL.md 60 lines; desc 167 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Keep (distinct task); replace r5-axe ref; link seed skill for stagedUploads helper instead of re-describing
- stale/verified: `runs/demo-images/{gen-batch,img-tools,json-patch}.mjs` exist (OK); `runs/e2e/r5-axe.cjs` MISSING (l.53); "ai-image-studio" skill exists only in .agents/.claude, not managed/omp root; "297 AI Box generations" volatile
- contradiction: shopify/AGENTS.md media rule cited (file exists); consistent with demo-store write approval
- structure: one 6-stage procedure, solid; NEVER/mandatory emphasis has reasons
- overlap: shopify-demo-store-seed (Files upload/stagedUploads steps overlap), ai-image-studio
### shopify-password-store-lighthouse
- class: **KEEP**; scout cluster D; roots: managed; SKILL.md 88 lines; desc 195 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Move baseline/forced-layout tables to a dated reference; keep rules + procedure
- scout verdict text: KEEP (trim)
- stale/verified: scratch/lh/{run-demo,trace-one,trace-own-tab}.mjs exist; assets/product.js, header.js exist; cited line numbers (product.js:199-201, header.js:10-18) not re-verified [INFERENCE: likely drifted]; reports dir exists
- contradiction: secrets handling consistent with AGENTS (env only, print lengths)
- structure: good validity rules; Rebel baseline table + forced-layout table (l.69-87) volatile
- overlap: shopify-theme-performance (generic CWV), pagespeed skill (Haravan PSI)
### shopify-theme-cli
- class: **KEEP**; scout cluster D; roots: agents,claude; SKILL.md 78 lines; desc 189 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Add "every shopify theme command needs per-command approval; hook matches literal `shopify theme push`" line
- scout verdict text: KEEP (patch)
- stale/verified: refs exist
- contradiction: l.49 "publish only when user clearly intends" is weaker than workspace rule: `shopify theme push*` refused without per-command approval (AGENTS.md §3; also devs2 skills l.13); no mention that hook matches literal string
- structure: good Use-when + "does NOT handle"; Output Format ok
- overlap: none (neighbour hrv/Haravan skills are other cluster)
### rebel-demo-store-sync-qa
- class: **MERGE** → `shopify-demo-store-ops`; scout cluster D; roots: managed; SKILL.md 93 lines; desc 260 chars; uses30d(sessions): 9; descQ 4/5; lang EN
- action: Fold sections 1-6 into new owner `shopify-demo-store-ops` (references/sync-drift.md); delete §7 (owner = shopify-theme-store-submission); fix seedlib path (see cluster-level)
- scout verdict text: MERGE→shopify-demo-store-ops
- stale/verified: `E:/Work/scratch/demo-seed/seedlib.py` MISSING (l.21; dir E:/Work/scratch/demo-seed does not exist); `dist/sartor-v1.0.0.zip` MISSING (dist/ holds sartor-v1.0.0-75d43c9.zip and sartor-v1.0.0-sartor.zip; l.45); backup dir plans/reports/theme-store-listing-backup-261031 exists (OK); `.git-nested` exists
- contradiction: §7 l.90 "Per-preset details and listing fields are preserved" vs shopify-theme-store-submission:34 "Replace file WIPES the unsubmitted draft listing, incl. presets" (direct conflict); l.91 "all 43 selected" vs submission:52 "44 ticked (46 checkboxes)"; l.15 "never plain shopify theme push" consistent with root rule
- structure: 7 sections mix 3 tasks (sync, QA receipt, Theme Store facts §7); dated facts "as of 2026-10-31" lists of demo-owned files; password-login code block inline
- overlap: shopify-demo-store-seed (same demo store, same seedlib, same Admin API upsert/verify); §7 duplicates shopify-theme-store-submission §0/§2/§4; §6 duplicates devs2-rebel-storefront-verify
### sapo-editor-draft-setting-sweep
- class: **MERGE** → `sapo-editor-setting-sweep`; scout cluster D; roots: managed; SKILL.md 40 lines; desc 149 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: See cluster 2
- scout verdict text: MERGE→sapo-editor-setting-sweep
- stale/verified: refs `fresh_reconvert.py`, `theme-xplat stripPickerDefaults` not verified; E:/Work/tools/Convert Sapo - Haravan/{theme-xplat,data-xplat} exist
- contradiction: l.26 colors "unverifiable without Save" vs human-input-sweep:16 tests hex colours in draft
- structure: no discard step; Haravan "no unsaved preview" claim
- overlap: sapo-editor-human-input-sweep (same goal: per-setting live proof, classification enums differ EFFECT vs EFFECT_BOUND)
### sapo-editor-human-input-sweep
- class: **MERGE** → `sapo-editor-setting-sweep`; scout cluster D; roots: managed; SKILL.md 50 lines; desc 207 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Merge as "human-input mode" reference; remove scripts promise or restore them into skill scripts/ with tests
- scout verdict text: MERGE→sapo-editor-setting-sweep
- stale/verified: `E:/Work/scratch/purity-qa/sapo_recheck_lib.py` and `sapo_human_driver.py` MISSING (l.8; scratch/purity-qa does not exist) — fragile scratch path
- contradiction: colour handling differs from setting-sweep
- structure: long; two concerns (sweep + Haravan parity reporting)
- overlap: sapo-editor-draft-setting-sweep
### sapo-h2s-antifan-tool-feedback
- class: **MERGE** → `sapo-h2s-convert-verify`; scout cluster D; roots: managed; SKILL.md 35 lines; desc 196 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: See cluster 3
- scout verdict text: MERGE→sapo-h2s-convert-verify
- stale/verified: `E:/Work/apps/bugs/registry.md` exists; theme-xplat/data-xplat exist; theme-qa-az present only under .agents/.claude
- contradiction: l.14 `sapo` CLI push needs per-invocation approval consistent with root; vs sapo-theme-snippet-embed-verify:11 "prefer CLI" without approval note
- structure: cites `references/h2s-convert-gates.md` relative to itself (l.34) — real file lives in theme-qa-az (.agents/.claude only, NOT in managed-skills)
- overlap: sapo-h2s-live-parity-sweep (same principle "fix in tool, not theme"); h2s-visual-parity-certify (other cluster)
### sapo-h2s-live-parity-sweep
- class: **MERGE** → `sapo-h2s-convert-verify`; scout cluster D; roots: managed; SKILL.md 40 lines; desc 194 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Keep probe list as references/parity-probes.md
- scout verdict text: MERGE→sapo-h2s-convert-verify
- stale/verified: tool dirs exist; `fresh_reconvert.py` not verified
- structure: good; uses DELETE-and-recreate collects with ask-user gate
- overlap: sapo-h2s-antifan-tool-feedback; h2s-visual-parity-certify
### sapo-review-app-antifan-feature-walkthrough
- class: **MERGE** → `sapo-app-live-install-verify`; scout cluster D; roots: managed; SKILL.md 28 lines; desc 171 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Move as reference; make baseline counts "read dashboard first" not constants
- scout verdict text: MERGE→sapo-app-live-install-verify
- stale/verified: `sapo-backend-live` managed service, :3000 not verified
- structure: volatile baseline (3 reviews, 2 questions, avg 4.0 on f1genz-purity, l.15)
- overlap: sapo-app-live-install-verify
### sapo-theme-edit-via-admin-editor
- class: **MERGE** → `sapo-admin-theme-file-edit-antifan`; scout cluster D; roots: managed; SKILL.md 15 lines; desc 188 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Move bulk-dump receiver + new-snippet creation to references/bulk-edit.md
- scout verdict text: MERGE→sapo-admin-theme-file-edit-antifan
- stale/verified: receiver script not shipped; cites only C:/Users/Admin/AppData/Local/Temp/<job>
- contradiction: l.10 cm.setValue works vs owner's "setValue ignored" ; l.13 "avoid {% comment %}, no slice" matches owner l.66
- structure: one dense numbered list, no heading sections; hard-coded "not port 47831", Temp path
- overlap: sapo-admin-theme-file-edit-antifan (owner), sapo-theme-snippet-embed-verify
### sapo-theme-snippet-embed-verify
- class: **MERGE** → `sapo-admin-theme-file-edit-antifan`; scout cluster D; roots: managed; SKILL.md 38 lines; desc 129 chars; uses30d(sessions): 2; descQ 3/5; lang VI with diacritics (desc)
- action: Keep §3 5-point verify + §5 traps as references/widget-embed-verify.md; remove "prefer CLI"
- scout verdict text: MERGE→sapo-admin-theme-file-edit-antifan
- stale/verified: `sapo whoiam` (l.11) not a verified CLI command (Sapo CLI name unverifiable; probably typo of whoami [INFERENCE])
- contradiction: l.11 "ưu tiên CLI … theme push --only" vs root AGENTS rule: `sapo theme *` refused without approval (only hrv push allowed) and sapo-h2s-antifan:14 requires per-invocation approval
- structure: desc "Nhúng…" has no "Use when" (std-warn); mixed VI/EN; names two F1GENZ snippets
- overlap: sapo-admin-theme-file-edit-antifan (§6 save-button trap duplicated l.20-22), sapo-theme-edit-via-admin-editor
### sapo-theme-workflow
- class: **MERGE** → `sapo`; scout cluster D; roots: agents,claude; SKILL.md 28 lines; desc 151 chars; uses30d(sessions): 12; descQ 3/5; lang EN
- action: Move detection + deploy-caution into sapo/references/workflow.md; ship script test or drop script
- scout verdict text: MERGE→sapo
- stale/verified: script exists; markers duplicated in sapo and sapo-theme
- contradiction: l.17 "don't claim official Sapo theme CLI exists" vs managed skills that run `sapo` CLI export/fetch/push (snippet-embed:11, h2s-feedback:12-14)
- structure: script `scripts/detect_sapo_theme.py` (48 lines) has no test and no platform note (std-warn)
- overlap: sapo (First steps), sapo-theme (Workflow step 1)
### shopify-demo-store-seed
- class: **MERGE** → `shopify-demo-store-ops`; scout cluster D; roots: managed; SKILL.md 90 lines; desc 146 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Becomes owner; references/seed.md + references/sync-drift.md; restore/relocate seedlib into skill scripts/ with a test
- scout verdict text: MERGE→shopify-demo-store-ops (OWNER)
- stale/verified: `E:/Work/scratch/demo-seed/seedlib.py` MISSING (l.27; dir absent); source/demo store domains hardcoded
- contradiction: l.14-15 approvals consistent w/ rebel sync gate; l.21 token prefix only
- structure: many one-off Rebel facts (2026-10-20, 24h token) ; ok structure
- overlap: rebel-demo-store-sync-qa (same store + helpers)
### shopify-liquid
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 37 lines; desc 124 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Fold into shopify-theme as references/liquid.md; move toolkit-security paragraph to the shared reference only
- scout verdict text: MERGE→shopify-theme
- stale/verified: refs exist; ../references/shopify-ai-toolkit-security-workflow.md exists
- structure: desc 124 chars, no not-for in desc (body has); long toolkit-telemetry paragraph (l.30-36) off-topic
- overlap: shopify-theme (Liquid patterns row), shopify-theme-snippets, -sections, -templates
### shopify-theme-accessibility
- class: **MERGE** → `shopify-theme-quality`; scout cluster D; roots: agents,claude; SKILL.md 21 lines; desc 105 chars; uses30d(sessions): 11; descQ 3/5; lang EN
- action: Becomes references/a11y.md
- scout verdict text: MERGE→shopify-theme-quality
- stale/verified: refs exist
- contradiction: "no prefers-reduced-motion" matches E:/Work/AGENTS.md:98
- structure: no "Use when" (std-warn); refs a11y-checklist.md 107 lines; evals
- overlap: shopify-theme-quality (a11y row + own a11y-checklist), haravan-accessibility (other cluster)
### shopify-theme-audit
- class: **MERGE** → `shopify-theme-quality`; scout cluster D; roots: agents,claude; SKILL.md 34 lines; desc 105 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Becomes references/audit.md; keep read-only/diagnose-only stance
- scout verdict text: MERGE→shopify-theme-quality
- stale/verified: ok
- structure: no "Use when"; 160-line checklist; long toolkit-telemetry paragraph
- overlap: shopify-theme-quality (audit row, same audit-checklist)
### shopify-theme-collection-page
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 14 lines; desc 114 chars; uses30d(sessions): 3; descQ 2/5; lang EN
- action: references/collection-page.md
- scout verdict text: MERGE→shopify-theme
- stale/verified: ref 96 lines exists
- structure: no "Use when"; body = 1 paragraph
- overlap: shopify-theme (PLP row)
### shopify-theme-performance
- class: **MERGE** → `shopify-theme-quality`; scout cluster D; roots: agents,claude; SKILL.md 15 lines; desc 116 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: references/performance.md
- scout verdict text: MERGE→shopify-theme-quality
- stale/verified: exists
- structure: no "Use when"; ref cwv-playbook 106
- overlap: shopify-theme-quality (performance row), shopify-password-store-lighthouse (measurement)
### shopify-theme-product-page
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 15 lines; desc 135 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: references/product-page.md (dedupe with shopify-theme's)
- scout verdict text: MERGE→shopify-theme
- stale/verified: exists
- structure: no "Use when"
- overlap: shopify-theme (PDP row), same product-page-checklist.md also in shopify-theme/references (different file, same name)
### shopify-theme-sections
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 15 lines; desc 99 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: references/sections.md
- scout verdict text: MERGE→shopify-theme
- stale/verified: ref 134 lines
- structure: no "Use when"
- overlap: shopify-theme (section-patterns.md differs)
### shopify-theme-seo-content
- class: **MERGE** → `shopify-theme-quality`; scout cluster D; roots: agents,claude; SKILL.md 15 lines; desc 115 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: references/seo.md
- scout verdict text: MERGE→shopify-theme-quality
- stale/verified: ref 106
- structure: no "Use when"
- overlap: shopify-theme-quality SEO row
### shopify-theme-settings
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 18 lines; desc 123 chars; uses30d(sessions): 4; descQ 3/5; lang EN
- action: references/settings.md
- scout verdict text: MERGE→shopify-theme
- stale/verified: exists
- structure: no "Use when"; ref `settings-placement.md` 121
- overlap: shopify-theme (settings row, nonexistent settings-patterns.md), sapo-theme-settings analogue
### shopify-theme-snippets
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 14 lines; desc 122 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: references/snippets.md
- scout verdict text: MERGE→shopify-theme
- stale/verified: ref 126
- structure: no "Use when"
- overlap: shopify-theme (snippet-patterns.md differs)
### shopify-theme-store-readiness
- class: **MERGE** → `shopify-theme-quality`; scout cluster D; roots: agents,claude; SKILL.md 24 lines; desc 128 chars; uses30d(sessions): 7; descQ 3/5; lang EN
- action: references/store-readiness.md; cross-link to submission skill
- scout verdict text: MERGE→shopify-theme-quality
- stale/verified: exists
- structure: no "Use when"; ref 221 lines
- overlap: shopify-theme-quality readiness row; shopify-theme-store-submission (Devs2 account ops)
### shopify-theme-templates
- class: **MERGE** → `shopify-theme`; scout cluster D; roots: agents,claude; SKILL.md 14 lines; desc 117 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: references/templates.md
- scout verdict text: MERGE→shopify-theme
- stale/verified: ref 120
- structure: no "Use when"
- overlap: shopify-theme (template-architecture.md missing)
### sapo-app-feasibility
- class: **RETIRE**; scout cluster D; roots: agents,claude; SKILL.md 13 lines; desc 97 chars; uses30d(sessions): 3; descQ 1/5; lang EN
- action: Delete dir from .agents and .claude (no unique content); strip mentions from sapo/SKILL.md:36
- stale/verified: l.12 cites `apps/.claude/skills/sapo-app/references/` (path convention not verified/stale)
- contradiction: sapo/SKILL.md:36 and routing-table.md:22 still mention it as "ghost"
- structure: disable-model-invocation + user-invocable false; keeps 2 reference files identical to sapo-app's
- overlap: exact duplicate of sapo-app references (md5)
### sapo-validation
- class: **RETIRE**; scout cluster D; roots: agents,claude; SKILL.md 36 lines; desc 155 chars; uses30d(sessions): 3; descQ 2/5; lang EN
- action: Move evals/*.json to sapo/evals; delete body; ak-skill-creator covers procedure
- stale/verified: refers to "every sapo* skill" incl. ghosts
- structure: maintainer tooling, not user task; evals/ 4 json
- overlap: ak-skill-creator (owns skill eval/validate)

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. **Sapo admin-editor file edit** — owner `sapo-admin-theme-file-edit-antifan` (most complete: 9 steps, 500-vs-#save-button trap, rollback).
   - sapo-theme-edit-via-admin-editor → references/bulk-edit.md (receiver dump of ~136 files, new-snippet creation via `a.add-theme-asset`, single-anchor transform).
   - sapo-theme-snippet-embed-verify → references/widget-embed-verify.md (5-point verify, marker-count anti-duplication, metafield `.value` trap); delete the "prefer sapo CLI push" line (conflicts with the `sapo theme *` approval rule).
   - Reconcile the setValue-vs-replaceRange discrepancy into one tested statement; reconcile "no UpdateAssets / Theme API" with sapo-theme-install-real-test by scoping it to published theme.
2. **Sapo editor-draft settings sweeps** — owner new `sapo-editor-setting-sweep` (no-save contract): merge sapo-editor-draft-setting-sweep (SKILL body, classification enums, Haravan comparison) + sapo-editor-human-input-sweep (references/human-input-mode.md: typing/upload/colour, #btnRemoveSetting discard, postflight sha proof, Haravan parity labels). Keep `sapo-editor-draft-key-fill` separate (it ends in a live Save = different authority) but link; put the shared override.json / `?_sc=1&designThemeId=` mechanism once in the owner references.
3. **H→S convert verify** — owner new `sapo-h2s-convert-verify`: sapo-h2s-antifan-tool-feedback (upload/preview Sapo facts, finding→owning-tool table, fix+re-run) + sapo-h2s-live-parity-sweep (probe order, live-data rules, theme re-apply, QA_INCONCLUSIVE previewer rule) → references/parity-probes.md. Cross-link `h2s-visual-parity-certify` and theme-qa-az (other clusters). Fix the dangling `references/h2s-convert-gates.md` (lives in theme-qa-az, absent from managed-skills).
4. **Sapo generic theme family** — owner `sapo-theme`: absorb sapo-liquid (+liquid-patterns.md), delete duplicated refs (theme-tags.md, snippet-patterns.md, product-page-checklist.md) and the 8 ghost dirs (sapo-theme-{templates,snippets,settings,audit,performance,store-readiness,accessibility,seo-content}: no SKILL.md; their scripts `sapo_theme_preflight.py`, `validate_settings_schema.py` are orphaned and untested → move into sapo-theme-quality/scripts or drop). `sapo` router absorbs sapo-theme-workflow; sapo-validation retired; sapo-app-feasibility retired.
5. **Sapo app live verification** — owner `sapo-app-live-install-verify`: absorb sapo-review-app-antifan-feature-walkthrough as references/feature-walkthrough.md; keep sapo-theme-install-real-test separate (theme-asset writes) and sapo-app-store-listing-fill-antifan separate (listing form, different authority).
6. **Shopify generic theme family (11 thin skills + 2 umbrellas)** — two owners:
   - `shopify-theme` (code): + shopify-liquid, -sections, -snippets, -templates, -settings, -collection-page, -product-page as references/<surface>.md (each ref 96-134 lines, all <300). Fix its 4 dead refs and l.44-45 corruption.
   - `shopify-theme-quality` (review): + -audit, -accessibility, -performance, -seo-content, -store-readiness as references/<dimension>.md. Keeps read-only/diagnose stance of audit. `shopify-theme-cli` stays (distinct side effects).
   Same-contract test: same authority (local theme files, read/write), same evidence; thin SKILL bodies (14-24 lines) with only a "read references/x.md" pointer carry no routing value beyond the description.
7. **Devs2/Sartor demo-store ops** — owner new `shopify-demo-store-ops`: shopify-demo-store-seed (SKILL body, §§1-7) + rebel-demo-store-sync-qa §§1-6 as references/sync-drift.md; both share seedlib, demo store, external-write gate. rebel-demo-store-sync-qa §7 deleted (owner shopify-theme-store-submission). shopify-demo-image-pipeline stays separate (image generation task) but depends on the ops skill for upload helpers. devs2-rebel-storefront-verify renamed and made the single QA-gate/triage source that the others link to.
8. **Theme Store**: shopify-theme-store-readiness (generic checklist, merges into shopify-theme-quality) vs shopify-theme-store-submission (Devs2 Partners ops) stay apart; submission links to readiness checklist.

Net result if applied: 42 → ~17 (sapo, sapo-app, sapo-theme, sapo-theme-quality, sapo-admin-theme-file-edit-antifan, sapo-editor-setting-sweep, sapo-editor-draft-key-fill, sapo-h2s-convert-verify, sapo-app-live-install-verify, sapo-app-store-listing-fill-antifan, sapo-theme-install-real-test, shopify-theme, shopify-theme-quality, shopify-theme-cli, shopify-demo-store-ops, shopify-demo-image-pipeline, shopify-password-store-lighthouse, shopify-theme-store-submission, devs2-sartor-storefront-verify) plus final-showcase absorbing sapo-final-showcase-package.

## (c) Rewrite candidates

1. **shopify-theme-store-submission** — direct factual conflicts with rebel-demo-store-sync-qa (replace-file wipe vs preserve; 44 vs 43 tags); two tasks fused (submission ops + making demo show features); dated incident log style, self-edit instruction ("Update this skill after every run"), personal email, truncated 44-tag enumeration line. Gap: no activation boundary / DoD; no separation of stable rules from dated lessons.
2. **devs2-rebel-storefront-verify** — stale name (theme is Sartor), missing journeys.cjs/r5-axe.cjs, frozen baseline numbers; needs preconditions, DoD, and become the only QA-triage reference for 4 skills.
3. **shopify-theme** — owner of the future merged code skill but has 4 dead refs, corrupted lines 44-45, no activation boundary, and its routing table sends users to files that do not exist; needs reference consolidation of 7 specialists.
4. **sapo-theme-snippet-embed-verify** (or its merge target) — recommends sapo CLI push as preferred path, conflicting with the workspace refusal rule; unverifiable `sapo whoiam`; description has no "Use when"; F1GENZ snippet names hard-coded.

## (d) Cluster-level inconsistencies

- **Ghost skill architecture**: 8 sapo-theme-* dirs exist in .agents/.claude with references+scripts but no SKILL.md; sapo/SKILL.md:36 forbids invoking them, sapo-liquid:16,20 and sapo/references/routing-table.md:8,22 still route to them; scripts inside are undiscoverable and untested.
- **Broken relative links** (std-warn ERR-link confirmed): sapo-theme:12-13, sapo-theme-quality:12 point to non-existent `../references/sapo-baseline.md` (real: sapo/references/sapo-baseline.md); sapo-theme:13 `../../references/...` wrong depth; shopify-theme quick-ref 4 missing files.
- **Missing scratch dependencies** (verified Test-Path false): E:/Work/scratch/demo-seed/seedlib.py (cited by rebel-demo-store-sync-qa:21, shopify-demo-store-seed:27, shopify-theme-store-submission:57), E:/Work/scratch/purity-qa/sapo_*.py (sapo-editor-human-input-sweep:8), runs/e2e/journeys.cjs + r5-axe.cjs, RESTYLE_MASTER_KIT/freshness-check.js, dist/sartor-v1.0.0.zip (renamed with commit suffix). None of these skills ship scripts/ so 6 skills depend on gitignored scratch files.
- **Theme rename drift**: Rebel→Sartor (2026-10-30) applied in rebel-demo-store-sync-qa/store-submission but skill names/titles of devs2-rebel-storefront-verify and rebel-demo-store-sync-qa still "Rebel"; the demo shop brand "Rebel Streetwear" is intentionally kept.
- **Contradiction pairs**: replace-file wipes vs preserves; 43 vs 44 tags; "never call Theme API/UpdateAssets" vs cookie-fetch asset writes (sapo-theme-install-real-test, sapo-app-live-install-verify); sapo-theme-workflow "no official Sapo CLI" vs 3 managed skills running sapo CLI; sapo-app "no secrets" vs live-install HMAC/client-secret use; sapo-theme-quality cites wrong rule file for reduced-motion ban (E:/Work/AGENTS.md:98, not ~/.claude/CLAUDE.md).
- **Authority/guard language not uniform**: root CLAUDE.md lists `sapo theme *` and `shopify theme push*` as refused without approval; shopify-theme-cli (l.49) and sapo-theme-snippet-embed-verify (l.11) do not state it; devs2/seed/h2s skills do.
- **Description style**: 18 generic Shopify/Sapo skills use imperative lines without "Use when" (std-warn description-trigger) and no not-for; managed skills mostly have "Use to/when" but no not-for. Language: all EN except sapo-theme-snippet-embed-verify (VI with diacritics, OK); no Vietnamese-without-diacritics found. Instructions to reply in Vietnamese are not stated in any skill (global rule covers).
- **Volatile facts inline**: dated measurements (2026-10-20/30/31, 2026-11-11), baselines (97 rows, 3 reviews/2 questions), org/theme IDs, personal email (shopify-theme-store-submission:12, PII not secret) belong in dated references.
- **Duplicated references (md5-identical)** across ghost dirs: hard-stops.md, sandbox-validation.md, theme-tags.md, product-page-checklist.md, snippet-patterns.md, sapo-checklist.md, store-readiness-checklist.md.
- .agents and .claude copies of all cluster generic skills identical: pick one root as source and symlink/generate the other.
- Secrets: none found in cluster; submission:25 documents a past leak of demo password into a transcript (incident note, no value).
