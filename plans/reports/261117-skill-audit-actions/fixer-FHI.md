# Work order — fixer FHI (Windows/OMP ops + Google/Trello/guides + misc + vendor design)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-FHI.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = FHI). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### final-showcase
- class: **OWNER**; scout cluster FHI; roots: agents,claude; SKILL.md 165 lines; desc 566 chars; uses30d(sessions): 20; descQ 4/5; lang mix
- action: Absorb export-rerun as `references/export-rerun.md`; use `<skill-dir>` instead of hardcoded ~/.claude path; add a test for freshness-check.js
- scout verdict text: KEEP (owner)
- stale/verified: `E:/Work/tools/RESTYLE_MASTER_KIT` exists; all 6 npm scripts (`final:capture`, `final:feature-capture`, `final:pptx`, `final:sanitize`, `final:export`, `guard:final`) + `gate:pre-showcase` exist in package.json
- structure: 164 lines OK (<300) but long; desc EN, body VI; heavy MUST stacks; `freshness-check.js` has no test; hardcoded `C:/Users/Admin/.claude/skills/final-showcase/scripts/freshness-check.js` (L145)
- overlap: owner; final-showcase-export-rerun is its step 5; theme-handover-guide cites it for sales deck (consistent)
- absorbs: sapo-final-showcase-package, final-showcase-export-rerun
### haravan-feedback-sheet-audit
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 41 lines; desc 180 chars; uses30d(sessions): 7; descQ 4/5; lang EN (report VI)
- action: Fold levents-feedback-triage as `references/levents.md`; reference sheet-to-spec by skill name, not absolute path
- scout verdict text: KEEP (owner)
- stale/verified: **`C:/Users/Admin/.claude/skills/sheet-to-spec/scripts/extract.py` exists**
- contradiction: L39 "Never run haravan/hrv CLI" stricter than AGENTS.md (allowed read forms) — acceptable
- structure: OK; step 1 runs `~/.claude/skills/sheet-to-spec/scripts/extract.py`
- overlap: levents-feedback-triage is its Levents-specific variant
- absorbs: levents-feedback-triage
### hrv-theme-push-fetch-syntax
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 38 lines; desc 226 chars; uses30d(sessions): 10; descQ 5/5; lang EN
- action: Add one line: pushes only to theme id in `.haravan-cli_local.json` after `hrv theme info --json`; add re-check date for line numbers
- stale/verified: `@local/haravan-theme-ops-cli/dist/commands/theme/{index.js,theme-fetch.js}` **exist**; line refs ~66-76/102-166 not re-verified
- contradiction: template `push --only ... --nodelete` consistent with CLAUDE.md exception; skill itself doesn't mention the "bound theme id" gate
- structure: Excellent (cites file:line); cruft emphasis 1
- overlap: AGENTS.md §8 (E:/Work/AGENTS.md:139-142) restates allowed hrv forms
- absorbs: haravan-push-handoff-commands
### omp-mcp-remote-oauth
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 63 lines; desc 176 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Merge canva-mcp-connect as references/canva.md; remove dated "48 tools"
- scout verdict text: KEEP (owner)
- stale/verified: agent.db exists; mcp.json path not probed
- structure: "Canva specifics (verified 2026-10)" volatile (tool count 48, domains)
- overlap: absorbs canva-mcp-connect; adjacent figma-desktop skill
- absorbs: canva-mcp-connect
### omp-ultra-run-controller
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 72 lines; desc 177 chars; uses30d(sessions): 48; descQ 4/5; lang EN
- action: Absorb fanout-recovery/scout-digest/security-scout/subagent-output-recovery as references; move Shopify false positives to a shopify audit skill
- scout verdict text: KEEP (owner) + REWRITE
- stale/verified: `UltraVerifier.jsonl` path pattern; not probed
- contradiction: L57 "touch minimum is 24px, not 44" is consistent with workspace but contradicts ui-ux-pro-max/impeccable 44px (see inconsistencies)
- structure: Contains Shopify audit false-positive list (L54-58: `listings/`, 24px touch, TemplateLength) = unrelated domain facts inside generic controller; volatile
- overlap: owner of cluster
- absorbs: omp-ultra-fanout-recovery, omp-ultra-scout-telemetry-digest, subagent-output-recovery, security-scout-ultra-safe
### sheet-to-spec
- class: **OWNER**; scout cluster FHI; roots: agents,claude; SKILL.md 184 lines; desc 273 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: Replace `/ck:plan`→`ak-plan`, `haravan-liquid`→`haravan-theme`; cut "Current status" to references/status.md; delete .pytest_cache; use `<skill-dir>` instead of `~/.claude/skills/...`
- scout verdict text: KEEP (owner) + fix
- stale/verified: scripts/tests exist; extract.py exists
- contradiction: stale `/ck:plan` → ak-plan; consumers named do not exist
- structure: 183 lines; "Current status" list (L158-183) is changelog; tests exist (4 files) but **.pytest_cache committed**; references 6; refers to `/ck:plan` and `haravan-liquid` (L21,22,153): `/ck:plan` not an installed skill, **`haravan-liquid` skill does not exist** in any root
- overlap: owner of sheet extraction; absorbs sheet-embedded-image-extract
- absorbs: sheet-embedded-image-extract
### theme-handover-guide
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 86 lines; desc 543 chars; uses30d(sessions): 2; descQ 5/5; lang VI trigger phrases + EN
- action: Make the replacement real: add "Replaced by this skill" stub or delete listed siblings; absorb customer-theme-guide non-Haravan modes
- scout verdict text: KEEP (owner)
- stale/verified: Epres folder `E:/Work/customizes/Epres` exists; image host URL not probed
- contradiction: none internal; conflicts only by siblings still routing
- structure: Reference-quality: outcome/done evidence, authority, failure modes, resources table, scripts+tests+platform note (L84-85)
- overlap: claims to replace 5 sibling skills but they stay active (L13-16)
- absorbs: customer-theme-guide
### trello-card-comment-links-antifan
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 36 lines; desc 190 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Mechanics in SKILL.md; result-comment format as `references/result-comment-format.md`; move shop-link probing to a haravan storefront skill
- scout verdict text: MERGE→trello-card-comment-antifan (new name)
- stale/verified: **L35 default shop password `haravan`** (public default)
- structure: No not-for ("not for non-Trello" in desc only); selectors dated; L34-35 "Shop link probing" off-topic
- overlap: pairs with trello-result-comment-short (content rules vs mechanics)
- absorbs: trello-result-comment-short
### update-agentkit-cli-and-kits
- class: **OWNER**; scout cluster FHI; roots: managed; SKILL.md 72 lines; desc 169 chars; uses30d(sessions): 2; descQ 4/5; lang EN (+VI trigger)
- action: Merge agentkit-update-and-delta-measure; add not-for "kit authoring"
- scout verdict text: KEEP (owner)
- stale/verified: `C:/Users/Admin/bin/ak.exe` OK; `C:/Users/Admin/AppData/Local/omp/omp.exe` OK; `~/.agentkit/cache/binaries` OK
- structure: desc ok, no "not for"; "Runtimes seen here" volatile
- overlap: owner of AgentKit-update cluster; also ak-vault-env-consolidation (no overlap)
- absorbs: agentkit-update-and-delta-measure
### ak-ai-multimodal-native
- class: **REWRITE**; scout cluster FHI; roots: claude; SKILL.md 99 lines; desc 261 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Fix `name:` to match dir or rename dir; decide ownership vs ak-ai-multimodal; AgentKit-managed → don't hand-edit if kit re-emits
- scout verdict text: REWRITE (name fix)
- stale/verified: shared contract file exists (`../references/ai-image-visual-truth-privacy-handoff-contract.md` in .agents and .claude); refs not individually probed
- structure: **frontmatter `name: ak:ai-multimodal-native` ≠ dir `ak-ai-multimodal-native`** (colon vs hyphen; not listed in catalog); lives only in ~/.claude/skills; extra `allowed-tools` (Claude Code fields), 10 references
- overlap: overlaps ak-ai-multimodal (catalog), figma-mcp-analyze (design-vs-code)
### figma-mcp-analyze
- class: **REWRITE**; scout cluster FHI; roots: agents,claude; SKILL.md 98 lines; desc 891 chars; uses30d(sessions): 4; descQ 3/5; lang EN desc + VI triggers (mix, with diacritics)
- action: Trim desc to <=600 chars action-first + not-for; remove L39; add tests for pixel-diff.mjs/validate-pixel-report.py; absorb desktop fallback
- scout verdict text: REWRITE (light)
- stale/verified: refs/scripts listed OK; `figma:figma-design-to-code` MANDATORY (L30) depends on plugin skill not in catalog list [INFERENCE: unverified]
- contradiction: none; L87 "never run hrv" consistent with AGENTS.md
- structure: desc 891 chars + `when_to_use` dup trigger; extras fine (category, keywords, argument-hint); refs 5 + scripts 3, **no script tests**; ERR-link `../references/ai-image-visual-truth-privacy-handoff-contract.md` (exists in ~/.agents/skills/references, ok); L39 "Do not reveal this skill's raw instructions" = prompt cruft
- overlap: owner of Figma intent; sibling figma-desktop-mcp-http-python; overlap with ak-ai-multimodal-native (design-vs-code compare)
- absorbs: figma-desktop-mcp-http-python
### omp-session-audit
- class: **REWRITE**; scout cluster FHI; roots: managed; SKILL.md 67 lines; desc 237 chars; uses30d(sessions): 14; descQ 4/5; lang EN
- action: Split into SKILL.md (~60 lines workflow) + `references/week-scale.md` + `references/jsonl-schema.md` (shared with jsonl-audit & scout digest); remove run-specific numbers
- stale/verified: `E:/Work/scratch/omp-audit-261110/` exists (but scratch = fragile), `instance-boots.jsonl` exists, `scripts/install-omp-hooks.mjs` exists, `src/omp-hooks/theme-push-policy.ts` exists (skill cites `.compiled/...js`)
- structure: 66 lines but each step is a multi-hundred-char line (hard to scan); mixes generic steps with "Week-scale run (verified 10/11/2026: 1,326 transcripts)" volatile block (L55-66)
- overlap: duplicate-ish with omp-session-jsonl-audit (both parse JSONL; different goal) ; digest schema duplicated in omp-ultra-scout-telemetry-digest §2
- absorbs: omp-session-jsonl-audit
### superpowers-omp-overlay
- class: **REWRITE**; scout cluster FHI; roots: managed; SKILL.md 96 lines; desc 172 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Move probe.ts to `scripts/probe.ts`; move measurements to `references/measured-findings.md`; keep SKILL.md ≤50 lines (when, re-verify steps, rollback); remove model names
- stale/verified: plugin dir `~/.omp/plugins/node_modules/superpowers` exists, **version 7.0.0 confirmed** (package.json); `~/.omp/agent/extensions/superpowers-omp.ts` exists; `using-superpowers/SKILL.md` exists; L52 "C:/Program" = ph
- contradiction: L93/L24 mention `rm -rf` with ask gate (consistent)
- structure: Heavy dated facts ("Installed layout (2026-10-12)", versions, bun 1.4.3, gemini-3.8-flash); 20-line probe.ts inline (L59-80); [INFERENCE] inline
- overlap: none (neighbour: using-superpowers, diagnosing-superpowers)
### windows-c-drive-cleanup
- class: **REWRITE**; scout cluster FHI; roots: managed; SKILL.md 60 lines; desc 133 chars; uses30d(sessions): 7; descQ 3/5; lang EN
- action: Split generic procedure (SKILL.md ≤60 lines) from `references/this-machine-inventory.md` (targets, sizes); fix E:-capacity gate (check E: free before offloading); remove dated results; put scan script under scripts/
- stale/verified: `E:/C-Offload` exists; **L12 `E:/Work/scratch/c-sizes.json` missing; L31 `E:\_backup_state_vscdb` missing**
- contradiction: **L8 claim "E: separate partition" contradicts newer memory/lesson (same NVMe)**; deletes data (OK, uses `ask`)
- structure: 59 long lines, many dated measurements (23/10, 31/10, "13.35 GB hermes"); embeds user-specific app inventory
- overlap: none (neighbour: memory note E: disk full — skill says E: is "separate partition" L8 but memory 2026-11-17 says E: shares one NVMe with C: and was 98% full)
### wireframe-roadmap
- class: **REWRITE**; scout cluster FHI; roots: agents,claude; SKILL.md 106 lines; desc 635 chars; uses30d(sessions): 3; descQ 3/5; lang EN desc + VI body
- action: Cut to ≤80 lines action-first desc; move QA View Modes/zoom engine spec (L45-57) to `references/preview-spec-html.md`; fix asset link; fewer emoji/MUST
- stale/verified: refs dir present; `docs/preview-spec.html` outputs
- contradiction: L80 "Zero reduced-motion" aligns with AGENTS.md:98 but contradicts all vendor UI skills
- structure: desc 635 chars; heavy MUST/emoji/LaTeX body; description-trigger warn; asset-link broken
- overlap: overlaps sheet-to-spec (input) and impeccable/design (visual) lightly
### 3dviz-pro-max
- class: **KEEP**; scout cluster FHI; roots: agents; SKILL.md 137 lines; desc 191 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Restrict to non-theme scenes in desc; leave files untouched
- scout verdict text: KEEP (vendor)
- stale/verified: n/a (vendor tree)
- contradiction: **L72 "respect reduced-motion" vs E:/Work/AGENTS.md:98 ban** (only matters if used on storefront themes)
- structure: vendor; scripts, no tests flagged; numeric-cap cruft
- overlap: neighbour ak-threejs (Three.js code) — 3dviz is design/process, ak-threejs API
### ak-vault-env-consolidation
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 39 lines; desc 181 chars; uses30d(sessions): 4; descQ 5/5; lang EN
- action: Add test for key filter/ref builder; vendor dotenv or `npm i` into skill dir
- stale/verified: script exists; `E:/Work/apps/haravan-app-base/server/node_modules/dotenv` exists (fragile dependency on another repo's node_modules, L13)
- contradiction: none; "values never to stdout" matches CLAUDE.md
- structure: Good guardrails; script `scripts/ak-env-import.mjs` exists, **no test**, no platform note
### amazon-associates-signup-antifan
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 53 lines; desc 154 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Re-verify selectors before use; no change needed
- stale/verified: n/a UI
- contradiction: none; owner-only steps for contract/PII consistent
- structure: Good Who-does-what; UI selectors "observed 2026-10-09" dated
### cloud-db-redis-to-local-vps-bridge
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 106 lines; desc 192 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add not-for + link to redis-cloud-exit-runbook; no secrets found (placeholders)
- stale/verified: `/root/<job>` VPS paths illustrative; password placeholders only
- contradiction: none; "secret in file chmod 600, never argv" good
- structure: 105 lines OK; desc lacks "not for permanent migration"; heavy concrete commands
- overlap: related redis-cloud-* and backend-cutover-origin-proof (outside cluster)
### design-taste-frontend
- class: **KEEP**; scout cluster FHI; roots: agents,claude; SKILL.md 530 lines; desc 971 chars; uses30d(sessions): 75; descQ 3/5; lang EN
- action: Do not edit; mark `disable-model-invocation`/lens-only so it does not compete with impeccable on every UI prompt
- scout verdict text: KEEP (vendor, lens only)
- stale/verified: `.taste-skill`, library, scripts present; not deep-checked
- contradiction: references 44px/reduced-motion paths (imagery.md:373, layout.md:266) vs AGENTS.md:98
- structure: vendor; **SKILL.md 529 lines (limit 300)**, 5 oversized files, 4 broken asset links, scripts without tests; desc 971 chars
- overlap: overlap with impeccable, huashu-design, ui-ux-pro-max (all "design a page")
### gh-pr-ci-verify-and-merge-safety
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 40 lines; desc 180 chars; uses30d(sessions): 2; descQ 4/5; lang mix
- action: Add not-for "normal user PR flow (ak-ship / ak-review-pr)"
- stale/verified: no paths; gh commands
- contradiction: L35 "never merge" consistent with AGENTS.md
- structure: Good traps; desc EN, body VI; report format for Leader worker jobs only; no title not-for
### git-worktree-orphan-recovery
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 29 lines; desc 133 chars; uses30d(sessions): 0; descQ 3/5; lang mix (body VI diacritics ok)
- action: Add "Not for: normal worktree add / prune" to description
- stale/verified: none path-based
- contradiction: consistent: bans `git reset --hard` (L28)
- structure: Desc EN, body VI; no title not-for; no done evidence beyond `git worktree list`
- overlap: none (neighbours: using-git-worktrees, ak-worktree — different)
### google-form-sheet
- class: **KEEP**; scout cluster FHI; roots: agents,claude; SKILL.md 155 lines; desc 246 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Move upload-endpoint section to link at drive-upload-via-apps-script; fix paths to `<skill-dir>`; remove empty evals/
- scout verdict text: KEEP (Form half) + trim
- stale/verified: `E:/skills/google-form-sheet/scripts/create_google_form_sheet.py` exists, `E:/skills/.venv` exists; L95 `C:\path\to\oauth-client.json` = ph
- structure: desc says "Create linked Google Forms and Sheets, or a Drive file-upload Web App endpoint" = two contracts; refs 2, scripts + test exist, evals dir empty; hardcodes `E:\skills\...` (L75-101) not skill dir
- overlap: upload endpoint half duplicates drive-upload-via-apps-script Shape B
### google-sheet-bulk-paste-verify-antifan
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 26 lines; desc 210 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Keep separate from google-sheet-feedback-row-marking; extract the shared name-box/SAVED_UNCONFIRMED traps once. `references/bulk-paste.md`; dedupe "NEVER type into #t-name-box" (also in feedback-row-marking L40 & publish-xlsx L56)
- scout verdict text: MERGE→google-sheet-antifan-ops (new)
- stale/verified: n/a UI
- structure: No H1 context/not-for; pixel coords (x~483,y~85) fragile
- overlap: shares traps with google-sheet-feedback-row-marking (name-box typing, SAVED_UNCONFIRMED, write_cell lies)
### google-sheet-feedback-row-marking
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 77 lines; desc 141 chars; uses30d(sessions): 63; descQ 4/5; lang VI
- action: Keep as separate (customer-visible write with exact wording); move shared Sheets-UI traps to common reference
- scout verdict text: KEEP (distinct write contract)
- stale/verified: Examples cite sheet row ids (#238, #285...) volatile; no paths
- contradiction: L76 "no hrv" consistent; L14 CẤM "Cần đồng bộ theme" fine
- structure: 76 lines OK; overruled old rules inline (L10 "thay thế mọi quy tắc cũ") = history in body; well-evidenced
- overlap: shares write-verify traps with bulk-paste; pairs with haravan-feedback-sheet-audit (reads)
### huashu-design
- class: **KEEP**; scout cluster FHI; roots: agents,claude; SKILL.md 216 lines; desc 163 chars; uses30d(sessions): 60; descQ 2/5; lang **ZH only** (no VI/EN trigger words → poor routing for Vietnamese user)
- action: Do not edit; add VI/EN trigger line in a wrapper note or restrict to ux-ui-all lens use
- scout verdict text: KEEP (vendor, opt-in lens)
- stale/verified: no path checks needed
- contradiction: **Forces "100% three directions first, even when style specified"** — conflicts with Tài's direct-delivery workflow; references 44px (web.md:19)
- structure: vendor; 11 oversized files, 2 thoroughness-booster cruft, volatile-fact; desc in Chinese
- overlap: overlap with impeccable/design-taste
### impeccable
- class: **KEEP**; scout cluster FHI; roots: agents,claude; SKILL.md 86 lines; desc 591 chars; uses30d(sessions): 69; descQ 3/5; lang EN
- action: Primary UI design skill; no change
- scout verdict text: KEEP (vendor)
- stale/verified: scripts present
- contradiction: reference/animate.md:77 & audit.md:15 require reduced-motion; adapt.md:46 44px
- structure: vendor; threat-language 5, emphasis 9, prohibition-run 2; scripts without tests; requires running `scripts/impeccable context` per session
- overlap: overlap with ui-ux-pro-max / design-taste
### llm-gateway-model-switch-bench
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 35 lines; desc 277 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Replace scratch path with an inline description; add not-for "choosing models for OMP itself" (use omp-provider-removal)
- stale/verified: **L28 `E:/Work/scratch/leader/261102-ml-prod/ml.sw1.leader-probe.md` missing** (scratch); AIBOX_API_KEY via HKCU env (L11)
- structure: desc 277 chars; "Not yet known on AI Box" section = volatile; secrets by name only
### npx-partial-install-repair
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 49 lines; desc 198 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add "echo the exact path, require it to be under `%LOCALAPPDATA%\npm-cache\_npx`, ask once" before step 4
- stale/verified: none path-based; npm 11 version claim, `%LOCALAPPDATA%\npm-cache\_npx` not probed
- contradiction: **L33 `Remove-Item -Recurse -Force '<npx dir>'`** without approval step; AGENTS.md §3 bans `rm -rf`/destructive FS w/o approval (own cache dir, but no "ask/echo path first")
- structure: OK; "When/Model/Procedure/Traps" good
### omp-cache-hit-rate-report
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 79 lines; desc 141 chars; uses30d(sessions): 2; descQ 5/5; lang EN
- action: Delete duplicate one-liner (L36-46); drop volatile size numbers
- stale/verified: refs `@oh-my-pi/pi-coding-agent/src/...` and `~/.omp/stats.db` not verified; hard numbers (~2 GB / 1.4M rows) volatile
- structure: One code block duplicated (L25-34 and L39-46 same query)
### omp-memory-store-supersede
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 22 lines; desc 211 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Cross-link both skills in "Not for"
- stale/verified: `C:/Users/Admin/.omp/agent/memories/<cwd-slug>/` path pattern not probed
- structure: OK, no H1 not-for; uses Vietnamese markers in EN body
- overlap: near-neighbour superseded-decision-doc-sync (different target: repo reports vs memory store)
### omp-provider-removal
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 33 lines; desc 179 chars; uses30d(sessions): 2; descQ 4/5; lang EN (+VI trigger)
- action: Add `Not for: re-adding provider (needs 200 from /models first)` — memory shows that is the paired workflow
- stale/verified: ~/.omp/agent/{config.yml,.env,models.db} exist as concept; not individually probed
- contradiction: none; ".env read with `read` tool (bash cat blocked)" consistent
- structure: Good surfaces list; no explicit done evidence beyond rg
### samsung-odin-twrp-custom-rom
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 69 lines; desc 130 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Strip device-specific "Tab 4 millet/matisse" into `references/tab4.md`; mark version links as examples
- stale/verified: URLs/versions (Odin3 v3.14.1, MindTheGapps 11.0.0-arm) volatile, not probed
- contradiction: none; consistent user-gated steps
- structure: Good gates, "NOT for" present; contains superseded note L42
### superseded-decision-doc-sync
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 41 lines; desc 154 chars; uses30d(sessions): 2; descQ 4/5; lang VI
- action: Replace hard-coded example greps with `<old-literal>` placeholders; note ERR-link in std-warn
- stale/verified: `plans/reports/` pattern
- structure: Desc in VI with diacritics; Cổng kiểm greps embed one past decision's numbers (L26-29: "1.000 email", "62 tin") = volatile example
- overlap: neighbour omp-memory-store-supersede
### ui-ux-pro-max
- class: **KEEP**; scout cluster FHI; roots: agents; SKILL.md 217 lines; desc 497 chars; uses30d(sessions): 90; descQ 3/5; lang EN
- action: Do not edit; ensure controller rules injected (ux-ui-all does this)
- scout verdict text: KEEP (vendor)
- stale/verified: data/references/scripts present
- contradiction: **L23 44×44px + L28 "No reduced-motion" anti-pattern vs AGENTS.md:98 ban and omp-ultra-run-controller L57 (24px minimum)**
- structure: vendor; desc 497 chars w/ volatile counts ("79 styles, 196 palettes"); emphasis cruft 5; script-platform-notes missing
- overlap: overlap with impeccable/design-taste; ux-ui-all council uses it as a lens
### ux-ui-all
- class: **KEEP**; scout cluster FHI; roots: agents,claude; SKILL.md 65 lines; desc 498 chars; uses30d(sessions): 6; descQ 5/5; lang EN + VI triggers ("hội đồng UI")
- action: Add "Not for" already present; keep as the only entry that calls the vendor lenses
- stale/verified: scripts `update-ui-skills.mjs`, `watchdog-roster.mjs`, `tests/` exist; 4 references exist; stale-path-count 1 not located (likely ph)
- contradiction: injects rules banning 44px/reduced-motion (L27-31) correctly shields vendor conflicts
- structure: Exemplary: authority/bounds, why-injects-rules, flags, done-means, resources, tests (`scripts/tests`)
- overlap: meta-skill over 6 UI skills; not duplicate
### vietnamese-url-slug-normalize
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 52 lines; desc 167 chars; uses30d(sessions): 2; descQ 5/5; lang EN (VI terms)
- action: Add `node --test` sample file under scripts/
- structure: Excellent small skill; code + trap + verify
### vn-otp-provider-vetting
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 62 lines; desc 254 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move dated prices to `references/provider-facts-YYYY-MM.md`; keep gates in SKILL.md
- stale/verified: n/a
- structure: Ordered gates good; pricing/fee facts dated (Zalo terms 09/07/2026) volatile
### windows-intel-9560-wifi-repair
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 103 lines; desc 137 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move symptom table (L26-41) to `references/event-ids.md`; copy toolkit scripts into skill `scripts/` (C:\tmp is volatile); note personal SSID/PCI id
- stale/verified: `C:\tmp\fix-wifi.ps1` exists; wifi-check/soak/etc. not each probed
- structure: 102 lines > practical for SKILL.md; machine-specific; toolkit lives outside skill in C:\tmp
### windows-silent-node-job-death
- class: **KEEP**; scout cluster FHI; roots: managed; SKILL.md 51 lines; desc 171 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: Add done-evidence line (2 Progress lines) already in §4; add not-for "job still alive"
- stale/verified: none path-based
- structure: Good steps; no explicit not-for
### agentkit-update-and-delta-measure
- class: **MERGE** → `update-agentkit-cli-and-kits`; scout cluster FHI; roots: managed; SKILL.md 85 lines; desc 192 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Move §5 "Measure real delta" + Pitfalls to `references/measure-delta.md` in owner; delete this dir
- scout verdict text: MERGE→update-agentkit-cli-and-kits
- stale/verified: `C:/Users/Admin/bin/ak.exe` OK; `E:/Work/scratch/ak-<ver>` = ph; ~/.agentkit/cache/binaries exists
- structure: No "not-for" ; no `when` section (L8 one-liner); delta section (L51-72) is a different task than update
- overlap: ~80% duplicate of update-agentkit-cli-and-kits (§1-5 near identical)
### canva-mcp-connect
- class: **MERGE** → `omp-mcp-remote-oauth`; scout cluster FHI; roots: managed; SKILL.md 50 lines; desc 132 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Keep only Canva gotchas (L44-49) as `references/canva.md`; delete skill
- scout verdict text: MERGE→omp-mcp-remote-oauth
- stale/verified: agent.db exists (C:/Users/Admin/.omp/agent/agent.db); mcp.canva.com not probed
- structure: No H1/title, no done-evidence; whole body repeated in omp-mcp-remote-oauth
- overlap: duplicate of omp-mcp-remote-oauth §Config/§Calling tools/§Canva specifics
### customer-theme-guide
- class: **MERGE** → `theme-handover-guide`; scout cluster FHI; roots: agents,claude; SKILL.md 99 lines; desc 301 chars; uses30d(sessions): 8; descQ 3/5; lang VI w/ diacritics
- action: Keep only unique parts: Sapo/Shopify platform detect + feature-mode annotation rules → `theme-handover-guide/references/other-formats.md` + `scripts/`; replace SKILL.md with one-line redirect then delete after one release
- scout verdict text: MERGE→theme-handover-guide (see §b)
- stale/verified: scripts exist (annotate_images.py, detect_platform.py, upload_to_gdocs.py); refs exist; `upload_to_gdocs.py` webhook mechanism not probed
- contradiction: claims "Master" while theme-handover-guide claims replacement; both active in catalog = routing ambiguity
- structure: desc 301 chars, starts "Master skill" (no use-when); extras `version`, `user-invocable`, `keywords`; has references 3, scripts 3, tests 1 but flagged no script-platform-notes/standard-sections; Mermaid + LaTeX in body; MUST/CẤM stacks
- overlap: **duplicates theme-handover-guide** (L13-14 of that skill says it "Replaces" this one, "kept on disk; prefer this one") and customize-customer-guide
### drive-upload-large-files-antifan-ui
- class: **MERGE** → `google-drive-antifan-ops`; scout cluster FHI; roots: managed; SKILL.md 24 lines; desc 188 chars; uses30d(sessions): 30; descQ 4/5; lang EN
- action: Becomes `references/large-files-ui.md`; drop L22 scratch reference
- scout verdict text: MERGE→google-drive-antifan-ops (new)
- stale/verified: **L22 `scratch/drive-appscript/upload.py` missing** (scratch one-off ref to "TTB 22/10 upload")
- structure: No H2 "when"; good "Do not"
- overlap: sibling of drive-upload-via-apps-script (same intent: files→Drive, differs by size/proof)
### drive-upload-via-apps-script
- class: **MERGE** → `google-drive-antifan-ops`; scout cluster FHI; roots: managed; SKILL.md 52 lines; desc 236 chars; uses30d(sessions): 8; descQ 4/5; lang EN (UI strings VI)
- action: Split: Shape A → `references/bulk-private.md`, Shape B → `references/storefront-endpoint.md`; make google-form-sheet link to Shape B instead of own copy
- scout verdict text: MERGE→google-drive-antifan-ops (keep Shape B owner here vs google-form-sheet)
- stale/verified: Nothing path-checkable; "~(826,240)" pixel coords in Cleanup (L44) fragile
- structure: Two Shapes (A throwaway bulk; B permanent public endpoint) = different authority/side effects in one skill; L19 "Do NOT copy tutorial" rhetoric; cruft emphasis-no-reason 1
- overlap: Shape B duplicates google-form-sheet `references/drive-upload.md` (doPost folder upload endpoint) ; Shape A+large-UI sibling
### figma-desktop-mcp-http-python
- class: **MERGE** → `figma-mcp-analyze`; scout cluster FHI; roots: managed; SKILL.md 24 lines; desc 187 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move to `references/desktop-http-fallback.md`; add trigger line in figma-mcp-analyze §Requirements
- scout verdict text: MERGE→figma-mcp-analyze
- stale/verified: `netstat 3845` not run (runtime); `%TEMP%` cache example volatile
- structure: No H1; no done-evidence; cruft emphasis 1
- overlap: fallback path for figma-mcp-analyze (which assumes Figma MCP mounted, L27-31)
### final-showcase-export-rerun
- class: **MERGE** → `final-showcase`; scout cluster FHI; roots: managed; SKILL.md 34 lines; desc 116 chars; uses30d(sessions): 11; descQ 3/5; lang EN
- action: Move to `final-showcase/references/export-rerun.md`
- scout verdict text: MERGE→final-showcase
- stale/verified: `E:/Work/tools/RESTYLE_MASTER_KIT/{sanitize_theme_liquid,final_theme_export,workflow_final_guard}.js` exist; `E:/Work/tools/Convert Sapo - Haravan` exists (stale hit = space-truncation false positive)
- contradiction: none (says "Never push", consistent)
- structure: desc 116 chars, no when/not-for beyond L8; no title not-for
- overlap: subset of final-showcase Step 5 (L130-151)
### google-docs-docx-to-native-and-verify
- class: **MERGE** → `google-drive-antifan-ops`; scout cluster FHI; roots: managed; SKILL.md 65 lines; desc 203 chars; uses30d(sessions): 7; descQ 4/5; lang EN
- action: Shared procedure `references/convert-on-upload.md` (toggle, drop, discover id, restore); docx-specific verify stays as `references/docx-verify.md`
- scout verdict text: MERGE→google-drive-antifan-ops
- stale/verified: n/a UI
- structure: No not-for; UI-string-dependent (VI labels)
- overlap: Steps §1 (Drive settings toggle → drop → find id → restore) duplicate publish-xlsx-report-to-google-sheet-antifan
### haravan-push-handoff-commands
- class: **MERGE** → `hrv-theme-push-fetch-syntax`; scout cluster A1; roots: managed; SKILL.md 32 lines; desc 181 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Keep only the "agent cannot run" case (Leader ban, unbound id) as references/handoff.md; correct premise
- scout verdict text: MERGE→hrv-theme-push-fetch-syntax
- stale/verified: Names `@local/haravan-theme-ops-cli`; tmp paths `E:/Work/.tmp/<job>-orig` ; E:/Work/.tmp exists
- contradiction: STALE vs AGENTS §8:139-144: agents may run push `--only ... --nodelete` themselves on bound id
- structure: volatile "source read 2026-11-02"; threat/emphasis cruft
- overlap: hrv-theme-push-fetch-syntax (outside; same command syntax/drift check)
### levents-feedback-triage
- class: **MERGE** → `haravan-feedback-sheet-audit`; scout cluster FHI; roots: managed; SKILL.md 25 lines; desc 132 chars; uses30d(sessions): 2; descQ 2/5; lang EN
- action: See above; fix INTAKE.md path
- scout verdict text: MERGE→haravan-feedback-sheet-audit
- stale/verified: **`E:/Work/INTAKE.md` missing** (rule probably at customizes/Levents/INTAKE.md); live store password-walled claim volatile
- contradiction: `!important` rule consistent with AGENTS.md:109-112; "no prefers-reduced-motion" consistent with AGENTS.md:98
- structure: desc lacks trigger; hard constraints list embeds theme rules (INTAKE.md:29)
- overlap: subset of haravan-feedback-sheet-audit
### omp-session-jsonl-audit
- class: **MERGE** → `omp-session-audit`; scout cluster FHI; roots: managed; SKILL.md 67 lines; desc 166 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Move to `references/single-session-handoff.md`; unify the content-block schema table once
- scout verdict text: MERGE→omp-session-audit
- stale/verified: none path-based; `channels/<name>/LOG.md`, `scratch/<loop>/STOP` illustrative
- structure: Desc lacks use-when trigger phrase ("Leader/worker handoff"); L39 "CRITICAL" cruft; schema block repeats session-audit
- overlap: merge target omp-session-audit (schema)
### omp-ultra-fanout-recovery
- class: **MERGE** → `omp-ultra-run-controller`; scout cluster FHI; roots: managed; SKILL.md 59 lines; desc 170 chars; uses30d(sessions): 10; descQ 4/5; lang EN
- action: Take `grab()` pager (L24-34) + 5-agent tier check (L17) into owner `references/recover-yield.md`
- scout verdict text: MERGE→omp-ultra-run-controller
- stale/verified: `agent://:raw:N-M` paging idea matches AGENTS tool text; not path-checkable
- structure: Same 6-step flow as omp-ultra-run-controller (evidence packet, dispatch, recover, anonymize, verifier, post-check)
- overlap: ~75% overlap with omp-ultra-run-controller and omp-ultra-scout-telemetry-digest; subagent-output-recovery (same recover trick)
### omp-ultra-scout-telemetry-digest
- class: **MERGE** → `omp-ultra-run-controller`; scout cluster FHI; roots: managed; SKILL.md 30 lines; desc 200 chars; uses30d(sessions): 4; descQ 3/5; lang EN
- action: `references/scout-telemetry-digest.md`; schema deduped to shared jsonl-schema reference
- scout verdict text: MERGE→omp-ultra-run-controller
- stale/verified: `E:/Work/.antifan-data/issues/issue-register.jsonl` exists
- structure: Desc ok; ERR-link; very dense lines; "verified 2026-10-08" dated schema
- overlap: same JSONL schema as omp-session-audit/jsonl-audit
### publish-xlsx-report-to-google-sheet-antifan
- class: **MERGE** → `google-drive-antifan-ops`; scout cluster FHI; roots: managed; SKILL.md 61 lines; desc 277 chars; uses30d(sessions): 4; descQ 5/5; lang EN
- action: Add "ask before public share" line; shared convert procedure moved to common reference
- scout verdict text: MERGE→google-drive-antifan-ops
- stale/verified: n/a UI; `exceljs` in repo node_modules not verified
- contradiction: **Makes a file public (anyone-with-link) — authority gate not stated** (should ask user before flipping share) unlike google-docs skill L58 which does ask
- structure: desc 277 chars (long but specific); "Proven three times" narrative; UI coords
- overlap: convert-on-upload shared with google-docs-docx
### sapo-final-showcase-package
- class: **MERGE** → `final-showcase`; scout cluster D; roots: managed; SKILL.md 22 lines; desc 162 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Move to `final-showcase/references/sapo-profile.md`; fix freshness-check path
- scout verdict text: MERGE→final-showcase
- stale/verified: `RESTYLE_MASTER_KIT/freshness-check.js` MISSING (l.19; other 5 kit scripts exist: capture, feature_capture, deck, settings_merge, skills_sync, workflow_final_guard)
- contradiction: l.20 "workflow_final_guard.js is Haravan-only" (verified file exists) — consistent
- structure: 10 dense numbered steps one per line; brand example `lux-shoes-features.pptx` baked in
- overlap: final-showcase and final-showcase-export-rerun (other clusters) — same pipeline for Haravan; this is the Sapo profile
### security-scout-ultra-safe
- class: **MERGE** → `omp-ultra-run-controller`; scout cluster FHI; roots: managed; SKILL.md 58 lines; desc 186 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: `references/security-variant.md` (forbidden files, PII count-only scan, receipt line)
- scout verdict text: MERGE→omp-ultra-run-controller (as security variant ref)
- stale/verified: `plans/reports/security-<yymmdd>-...` pattern only
- contradiction: none; "never open .env" consistent
- structure: Hard rules block good; Delete-throwaway step; same ultra flow as omp-ultra-*
- overlap: duplicate flow of omp-ultra-run-controller; unique value = forbidden-file list + PII count scan
### sheet-embedded-image-extract
- class: **MERGE** → `sheet-to-spec`; scout cluster FHI; roots: managed; SKILL.md 48 lines; desc 174 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Move manual procedure to `sheet-to-spec/references/manual-row-image.md` (row-specific anchor mapping the script lacks) or add `--row` to extract.py; delete skill
- scout verdict text: MERGE→sheet-to-spec
- stale/verified: n/a
- structure: desc EN; no H1 title (starts at "Use when"); prohibition-run cruft
- overlap: **reimplements `sheet-to-spec` xlsx floating-image extraction** (sheet-to-spec has tested scripts)
### subagent-output-recovery
- class: **MERGE** → `omp-ultra-run-controller`; scout cluster FHI; roots: managed; SKILL.md 17 lines; desc 127 chars; uses30d(sessions): 1; descQ 3/5; lang EN
- action: `references/recover-yield.md` (single copy); delete dir
- scout verdict text: MERGE→omp-ultra-run-controller
- stale/verified: `~/.omp/agent/sessions/--<cwd>--/<ts>_<id>/<Agent>.jsonl` layout: same as omp-session-audit L21, consistent
- structure: Tiny; no H2; relies on `yield` tool name (L12)
- overlap: same recovery as omp-ultra-fanout-recovery §3 and omp-ultra-run-controller §6
### trello-result-comment-short
- class: **MERGE** → `trello-card-comment-links-antifan`; scout cluster FHI; roots: managed; SKILL.md 30 lines; desc 243 chars; uses30d(sessions): 3; descQ 4/5; lang VI
- action: `references/result-comment-format.md`; delete dated anecdote
- scout verdict text: MERGE→trello-card-comment-links-antifan
- stale/verified: no paths
- structure: Embeds a dated personal complaint (L8 "User (Tài, 13/11/2026) phàn nàn..."); rules clear
- overlap: content layer of trello-card-comment-links-antifan
### customize-customer-guide
- class: **RETIRE**; scout cluster FHI; roots: agents,claude; SKILL.md 19 lines; desc 218 chars; uses30d(sessions): 6; descQ 2/5; lang VI
- action: Delete skill dir (both roots)
- stale/verified: n/a (relative `../customer-theme-guide/SKILL.md` valid)
- contradiction: Says "đã hợp nhất vào customer-theme-guide" while theme-handover-guide says replaced too
- structure: Alias of an alias; empty `assets/` + `scripts/` dirs; own copy of references/customer-guide-quality-contract.md (duplicate of customer-theme-guide copy); ERR-other
- overlap: pure duplicate

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. **AgentKit update** — owner `update-agentkit-cli-and-kits`. Members: agentkit-update-and-delta-measure (same §1-5; unique: §5 delta measurement via old-binary A/B + kit diff). Mechanics: keep §1-4 in owner; move delta to `references/measure-delta.md`; delete member. ak-vault-env-consolidation stays separate (different task).
2. **OMP --ultra controller** — owner `omp-ultra-run-controller`. Members: omp-ultra-fanout-recovery (unique: `grab()` pager, 5-agent tier check), omp-ultra-scout-telemetry-digest (unique: OMP-session digest + issue-register), security-scout-ultra-safe (unique: forbidden-file list, PII count scan, receipt), subagent-output-recovery (unique: yield/JSON decode). Mechanics: SKILL.md = shared 8-step flow; `references/recover-yield.md` (merge 3 recovery copies), `references/scout-telemetry-digest.md`, `references/security-variant.md`; move Shopify false-positive list out.
3. **OMP session mining** — owner `omp-session-audit`. Members: omp-session-jsonl-audit (single-session handoff), omp-ultra-scout-telemetry-digest §2 (schema). Mechanics: one `references/jsonl-schema.md` (type/toolCall/arguments/toolResult), `references/single-session-handoff.md`, `references/week-scale.md`.
4. **Hosted MCP connect** — owner `omp-mcp-remote-oauth`. Member canva-mcp-connect → `references/canva.md`. Figma desktop MCP (figma-desktop-mcp-http-python) is the same "call MCP over HTTP from eval when xd:// absent" pattern: share the SSE/handshake snippet in one reference, keep Figma specifics under figma-mcp-analyze.
5. **Customer guides** — owner `theme-handover-guide` (has scripts, tests, done-evidence, authority). Members: customer-theme-guide (unique: Sapo/Shopify detection, feature mode, annotate_images.py, docx styling), customize-customer-guide (pure alias → delete). Mechanics: SKILL.md of owner unchanged; add `references/other-platforms.md` (detect_platform) + move annotate_images.py/upload_to_gdocs.py into `scripts/`; mark customer-theme-guide as redirect then delete. Out-of-cluster siblings named by owner (levents-guide-pipeline, haravan-ep2-preview-capture-antifan, customer-guide-narrated-video) also still exist in managed-skills (verified) — retire or redirect in same pass.
6. **Final showcase** — owner `final-showcase`; member final-showcase-export-rerun → `references/export-rerun.md` (its content is Step 5 plus Sapo reconvert and ZIP verify).
7. **Drive file ops via AntiFan** — new owner `google-drive-antifan-ops` (or keep `drive-upload-via-apps-script` as name). Members: drive-upload-large-files-antifan-ui, drive-upload-via-apps-script (Shape A/B), google-docs-docx-to-native-and-verify, publish-xlsx-report-to-google-sheet-antifan. Mechanics: SKILL.md = decision table (size, native conversion, public/private); `references/convert-on-upload.md` (toggle checkbox idx 0 → drop on [role=main] → find id in drive/recent → restore; currently duplicated in docs-docx §1 and publish-xlsx §Drive settings/§Upload), `references/docx-verify.md`, `references/publish-public-sheet.md`, `references/large-files-ui.md`, `references/apps-script-bulk.md`, `references/storefront-endpoint.md`. google-form-sheet keeps Form creation only and links to storefront-endpoint (its `references/drive-upload.md` is the same doPost endpoint).
8. **Google Sheet UI writes** — owner `google-sheet-feedback-row-marking` stays (distinct, customer-visible write contract); fold google-sheet-bulk-paste-verify-antifan into new `google-sheet-antifan-ops` only if desired, else keep both but extract shared traps (name-box typing, SAVED_UNCONFIRMED false verified:true, screenshot stale frame, close only own tabs) into one reference.
9. **Feedback sheet reading** — owner `haravan-feedback-sheet-audit`; member levents-feedback-triage → `references/levents.md`; sheet extraction: sheet-embedded-image-extract → `sheet-to-spec/references/manual-row-image.md`.
10. **Trello** — owner `trello-card-comment-links-antifan` (rename `trello-card-comment-antifan`); member trello-result-comment-short → `references/result-comment-format.md`.
11. **Figma** — owner `figma-mcp-analyze`; member figma-desktop-mcp-http-python → `references/desktop-http-fallback.md`.
12. **UI/design family (vendor, light touch)** — no merge: impeccable, design-taste-frontend, huashu-design, ui-ux-pro-max, wireframe-roadmap, ak-ai-multimodal-native, plus out-of-cluster ak-frontend-design/ak-ui-ux-pro-max/ui-ux-pro-max duplicates compete on "design a page" triggers. Owner for routing: `ux-ui-all` for multi-lens; `impeccable` default single lens; others lens-only (disable model invocation) to cut ~3k chars of competing descriptions.

## (c) Rewrite candidates

1. **windows-c-drive-cleanup** — generic procedure mixed with dated user-specific measurements; claim "E: is a separate partition" (L8) contradicted by 2026-11-17 lesson (same NVMe, E: hit 98%); two cited scratch/backup paths missing (L12, L31). Split generic vs machine inventory; add E: free-space gate before offload.
2. **omp-session-audit** — 66 very dense lines plus a run-specific week block; needs SKILL.md ≤ ~60 lines workflow, `references/` for schema, pitfalls, week-scale; remove numbers (1,326 transcripts).
3. **superpowers-omp-overlay** — dated measurements (2026-10-12), model names, inline 20-line probe; extract `scripts/probe.ts`, keep only trigger/re-verify/rollback in SKILL.md; version 7.0.0 verified current but will rot.
4. **Customer-guide consolidation (customer-theme-guide → theme-handover-guide)** — owner claims replacement while old master and alias stay active; rewrite owner description to cover platforms/modes it keeps and retire the rest (also fixes routing for 3 out-of-cluster guide skills).
(runner-ups: wireframe-roadmap — bloated, emoji/LaTeX/MUST stack; figma-mcp-analyze — desc 891 chars + untested scripts.)

## (d) Cluster-level inconsistencies

- **Reduced-motion/touch-target policy split**: E:/Work/AGENTS.md:98 bans `prefers-reduced-motion` workspace-wide; omp-ultra-run-controller:57 says touch minimum is 24px; wireframe-roadmap:80 and levents-feedback-triage agree. But ui-ux-pro-max (SKILL.md:23, :28), impeccable (reference/animate.md:77, adapt.md:46), huashu-design (references/modules/web.md:19), design-taste-frontend (references/layout.md:266, imagery.md:373) and 3dviz-pro-max (SKILL.md:72) all prescribe 44px and/or reduced-motion. Only ux-ui-all (L27-31) injects the workspace rules; a direct call to a vendor skill will emit banned recommendations.
- **Replacement claims not executed**: theme-handover-guide:13-16 says it replaces five skills, but customer-theme-guide, customize-customer-guide, levents-guide-pipeline, haravan-ep2-preview-capture-antifan, customer-guide-narrated-video are all still active (verified in managed-skills). customize-customer-guide says "merged into customer-theme-guide".
- **Stale cross-references**: sheet-to-spec cites `/ck:plan` and `haravan-liquid` (no such skill in any root; haravan-theme exists); levents-feedback-triage cites `INTAKE.md:29` at E:/Work/INTAKE.md (missing); drive-upload-large-files cites missing `scratch/drive-appscript/upload.py`; llm-gateway cites missing scratch leader probe.
- **Hardcoded roots instead of `<skill-dir>`**: final-showcase:145 and haravan-feedback-sheet-audit:11 use `C:/Users/Admin/.claude/skills/...`; google-form-sheet uses `E:\skills\...`; ak-vault-env-consolidation depends on `E:/Work/apps/haravan-app-base/server/node_modules/dotenv`. Roots differ across `.agents`, `.claude`, `managed-skills`, so a skill moved between roots breaks.
- **Destructive-action language uneven**: npx-partial-install-repair:33 uses `Remove-Item -Recurse -Force` with no approval step; agentkit-update L84 and superpowers-omp-overlay L93 correctly gate `rm -rf`; publish-xlsx makes a Sheet public without an ask-gate while google-docs-docx L58 asks.
- **Copied tool-pitfall boilerplate**: "bash blocks cat/head/tail", "PowerShell `$_` mangled → write .ps1" repeated in windows-c-drive-cleanup, windows-silent-node-job-death, omp-session-audit, omp-session-jsonl-audit, omp-ultra-run-controller, omp-ultra-scout-telemetry-digest, superpowers-omp-overlay; should live once (global rule or one reference).
- **Volatile facts in bodies**: dated measurements/versions in windows-c-drive-cleanup, superpowers-omp-overlay, omp-session-audit (week block), omp-mcp-remote-oauth ("48 tools"), ui-ux-pro-max (desc counts), trello-result-comment-short (personal anecdote L8), vn-otp-provider-vetting (prices).
- **Description language mix**: most managed descriptions EN with VI trigger words missing; VI-only bodies (git-worktree-orphan-recovery, gh-pr-ci-verify, trello-result-comment-short, google-sheet-feedback-row-marking, superseded-decision-doc-sync) have EN or VI descriptions inconsistently; huashu-design description is Chinese only; no Vietnamese description lacks diacritics (none observed).
- **Structure gaps vs standard**: 12 skills have no "not-for" in description; 20 are <35-line notes without H1/definition-of-done; 6 scripted skills lack tests/platform notes (figma-mcp-analyze, final-showcase, ak-vault-env-consolidation, design-taste/impeccable/huashu vendor); sheet-to-spec ships `.pytest_cache`; customize-customer-guide has empty `assets/` and `scripts/`; google-form-sheet has empty `evals/`.
- **Name/dir mismatch**: ak-ai-multimodal-native dir vs frontmatter `ak:ai-multimodal-native`; absent from the live catalog.
