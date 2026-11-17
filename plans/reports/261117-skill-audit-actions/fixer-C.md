# Work order — fixer C (AntiFan app / Leader / QA)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-C.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = C). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### antifan-compiled-ab-test
- class: **OWNER**; scout cluster C; roots: managed; SKILL.md 28 lines; desc 153 chars; uses30d(sessions): 7; descQ 3/5; lang EN
- action: Absorb ab-test-triage; split dated "Known non-diff reds" into references/known-reds.md; add DoD (table of per-file tests/pass/fail).
- scout verdict text: KEEP (owner)
- stale/verified: "Known non-diff reds" has `context-bridge.test.mjs:265`, commit 9f902f10 (dated 2026-10-20); worktree path `E:/Work/scratch/ab-head-<date>`
- contradiction: none; its cleanup says `git worktree remove --force` is destructive, ask user: matches AGENTS
- structure: no not-for
- overlap: antifan-ab-test-triage
- absorbs: antifan-ab-test-triage
### local-worker-signed-in-ui-qa
- class: **OWNER**; scout cluster C; roots: managed; SKILL.md 17 lines; desc 196 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Absorb worker-local-smoke steps (visual_quality, preset restore); coordinate with cloudflare-worker-local-smoke-windows (pick one owner of the pair).
- scout verdict text: KEEP (owner)
- stale/verified: wrangler compat date note (4.104.0 => 2026-06-30) volatile; `.dev.vars` exists in E:/Work/VidAff (matches)
- structure: tiny; good gotchas
- overlap: worker-local-smoke-antifan-ui-qa (duplicate), cloudflare-worker-local-smoke-windows (external)
- absorbs: cloudflare-worker-local-smoke-windows
### tinymce-react-init-race-harness
- class: **OWNER**; scout cluster C; roots: managed; SKILL.md 34 lines; desc 215 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Absorb tinymce-late's prod-evidence; ship `harness/` files (vite config, middleware) in references instead of prose.
- scout verdict text: KEEP (owner)
- stale/verified: tinymce 7.8/6.x facts versioned; CLOUDFLARE_API_TOKEN_F1GENZ env names only
- contradiction: owner of the correct rule
- structure: no references; harness path via `E:/Work/apps/F1GENZ_Review/client/node_modules/playwright` (exists)
- overlap: tinymce-late-content
- absorbs: tinymce-late-content-blank-after-f5
### antifan-app-restart
- class: **REWRITE**; scout cluster C; roots: managed; SKILL.md 76 lines; desc 229 chars; uses30d(sessions): 43; descQ 3/5; lang EN
- action: Move steps 0-7 + Gotchas to `references/live-restart.md`, keep SKILL.md <120 lines (isolated-instance default + gate). Fix dead probe cites; replace line numbers with symbol names; make it the ONLY restart recipe; reference `scripts/antifan-restart.ps1` (which toolbar-action:37 says refuses while engage lock exists).
- stale/verified: CITES MISSING: `probe-multi-window-binding.cjs`, `probe-detached-webhub.cjs` (:14); `index.ts:4631` port 20130 now at index.ts:4747 (dev 20130 / prod 20129); `index.ts:263/:808` line refs unverified/drifted; `run-antifan.vbs` OK; `detached-restore.done` claim correct (no hit in src)
- contradiction: mcp-benchmark:38 relaunches via `Start-Process node scripts/run-electron.cjs` hidden, electron-upgrade:36 via CimMethod, this via `run-antifan.vbs`: three different recipes
- structure: desc OK but no not-for; ERR-link 1; cruft: "HARD RULE", "NEVER"; ~50 long ops lines in body (no references/)
- overlap: daemon-host-restart, electron-upgrade, mcp-benchmark §3, toolbar-action (3 other relaunch recipes); scripts/antifan-restart.ps1 exists but not mentioned
### antifan-daemon-host-restart
- class: **REWRITE**; scout cluster C; roots: managed; SKILL.md 48 lines; desc 312 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Either restore runner into `scripts/` (repo) and cite it, or inline a minimal runner; extract shared "arm via schtasks outside AntiFan tree" into one reference used by this and detached-shutdown-job; drop dated pids.
- stale/verified: CITES MISSING runner `daemon-restart.mjs` (no such file); `src/main/run/live-runs.ts` exists; `daemon.json` exists; "Verified 2026-11-03 pid 3000→4692" volatile
- contradiction: consistent (needs approval)
- structure: desc 312 chars (long but good, gate stated); body ok
- overlap: detached-shutdown-job (same schtasks outside-tree arming); app-restart
- absorbs: antifan-detached-shutdown-job
### antifan-dogfood-clone
- class: **REWRITE**; scout cluster C; roots: agents,claude; SKILL.md 146 lines; desc 370 chars; uses30d(sessions): 9; descQ 2/5; lang EN + VI banner
- action: Cut to <120 lines: contract (inputs, outputs, DoD = acceptance report), move 5-phase detail to references (already exist); drop persona + LaTeX arrows; state the single reason for each invariant; decide owner vs `site-clone` skill and cross-link.
- stale/verified: `npm run clone:site`, `serve:clone`, `scripts/clone-site.mjs`, `serve-clone.mjs` verified; hard-coded port 3300; Ctrl+Shift+U restart prompt unverified; `anti.theme.export_clean` etc exist as MCP tools
- contradiction: "restart" message tells user to close app; app-restart HARD RULE forbids agent doing it (OK: it asks the user)
- structure: desc is keyword soup; persona ("You are ... Principal Systems Engineer"); "6 Inviolable Invariants", many bold NEVER/MUST; ERR-link 5 (the `*See references/...*` lines are not links); references/ 6 files (47-126 lines) OK
- overlap: `site-clone` skill (outside cluster, same capability), `ak-` clone tools
### antifan-leader
- class: **REWRITE**; scout cluster C; roots: managed,repo; SKILL.md 179 lines; desc 273 chars; uses30d(sessions): 78; descQ 3/5; lang EN + VI quotes
- action: Keep SKILL.md <300 lines: role, whitelist, first command (`needs-me`), tool table, ledger commands. Move §2b-2e,2i,2j to `references/ledger-and-rounds.md`, §2f/2g to `references/git-and-cloudflare-safety.md`, §2h removed/updated, mistakes log to a dated changelog not loaded by default. Source of truth is the repo copy; edit there then `install-managed-skills.mjs`.
- stale/verified: All 12 cited scripts exist; `LEADER_INVESTIGATE_LIMIT=4` OK; probes `trello-card`, `telegram-otp`, `wait-any`, `fill-task`, `needs-me`, `lessons` exist in leader-job.mjs; `fleet-watch.mjs` exists; **§2h (:137-138) says `planSapoCommand` absent at HEAD: now exists (theme-push-policy.ts:306,550) = stale**; §2g account id prefix `dc25380a...` (identifier, not secret)
- contradiction: contradicts dispatch-worker-pane/deploy-ship on how Enter is sent (:53 says `input ... \r`; others say Enter separate); contradicts dispatch-worker-pane ("terminal.close") vs "ALWAYS close-worker.mjs"; ok with AGENTS §8
- structure: SKILL.md ~67 KB with 700+ char lines, diary sections 2b-2j ("Mistakes made on 09/11/2026", "from the 09/11 session notes", "Kaizen ... 13/11/2026", §2f git worktree deletion safety, §2g wrangler constraints, §2h Sapo) = not a playbook; ERR-link 36 (backticked paths); cruft: ★ ratings, quoted user outbursts, "hard rule" stacks
- overlap: worker-round (push policy duplicated :62 vs worker-round:14), dispatch-worker-pane, deploy-ship, wait-workers-polling, session-audit, pagespeed-closeout
- absorbs: antifan-leader-deploy-ship, antifan-leader-dispatch-worker-pane
### antifan-mcp-benchmark
- class: **REWRITE**; scout cluster C; roots: managed; SKILL.md 47 lines; desc 146 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Remove §3, link app-restart; move baselines to `references/baselines.md` or delete; keep §1/§2/§4.
- stale/verified: `benchmark-mcp-tools.mjs`, `benchmark-mcp-electron.cjs`, committed baseline json exist; baselines 2026-10-09/10-20 volatile
- contradiction: restart recipe differs from app-restart (no vbs, no listener-owner main check, no compile-staleness check)
- structure: two jobs (benchmark + restart) = §3 duplicates app-restart; ERR-link 6; "Known baselines" dated
- overlap: app-restart (restart), compiled-ab-test (junctions)
### antifan-qa-cockpit
- class: **REWRITE**; scout cluster C; roots: agents,claude; SKILL.md 191 lines; desc 322 chars; uses30d(sessions): 26; descQ 3/5; lang EN
- action: SKILL.md <120 lines (protocol Phases 1-4 + refusal table); move §Sapo, §Functional regressions, §Reviewer M-checks, §Drawer M11 to `references/*.md` (or into theme-qa-az, which already owns M1-M12); delete proposed QAG-38..44 unless implemented; drop :40 hrv sentence or align with AGENTS §8.
- stale/verified: `theme-checklist.ts`, `cockpit-capabilities.ts`, `antifan-omp-mcp.cjs`, `qa_gate.js` exist; `theme-qa-az` exists only in `.agents`/`.claude` (not managed): refs `antifan-live-qa-recipe.md`, `reviewer-haravan-checks.md` exist there; "after fix 7604c068 + restart" hash volatile
- contradiction: :40 "never run haravan/hrv CLI" vs AGENTS §8 allowing `hrv theme push --nodelete` for any agent
- structure: ERR-link 8 + asset-link 7; massive: §2 mixes protocol, dated live findings (2026-10-24, 10-28, 11-12), Sapo recipes, proposed QAG-38..44 items that do not exist; §5 hand-maintained tool table; no references/
- overlap: theme-qa-az (owner of codes), baseline-receipt-loop, verdict-qualification, scroll-artifact, haravan-storefront-qa-proof-gate
- absorbs: antifan-qa-baseline-receipt-loop, antifan-qa-scroll-artifact
### antifan-qa-engine-fixture-probe
- class: **REWRITE**; scout cluster C; roots: managed; SKILL.md 49 lines; desc 223 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Move harness (fixtures.cjs, probe.cjs, oracle.js) into repo `test/fixtures/` or `scripts/probes/` and cite it; keep Electron 43 setup facts + acceptance bar.
- stale/verified: **harness `E:/Work/scratch/visual-qa-probe/` MISSING** (skill says "rebuild from steps": steps are partial); `layout-integrity-engine.ts`/`layout-overflow-engine.ts` exist; public stores list dated 2026-10-09
- structure: ERR-link 1; relies on harness outside repo
### antifan-toolbar-action
- class: **REWRITE**; scout cluster C; roots: managed; SKILL.md 43 lines; desc 152 chars; uses30d(sessions): 2; descQ 3/5; lang VI (diacritics ok)
- action: Replace line numbers with anchors by symbol; remove Python note; delete restart paragraph and link app-restart; keep 5-file chain.
- stale/verified: all 5 files exist (contracts.ts not re-opened); "đo 16/11/2026, Sao chép cookie Facebook" example dated; mentions `plans/reports/engage/identity.lock`, `antifan-restart.ps1` (exists), `fill0211/runner.py` volatile
- contradiction: restart advice consistent with HARD RULE
- structure: VI body and VI desc; contains Python gotcha unrelated (:41); line numbers `~:2500-3100`, `:881`, `:142`, `:4879` will drift
- overlap: app-restart (restart policy repeated)
### electron-main-live-profiling
- class: **REWRITE**; scout cluster C; roots: managed; SKILL.md 74 lines; desc 151 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Embed a 30-line cdp.cjs in `references/cdp.cjs`; move the two Known findings to `references/findings.md`; keep triage order.
- stale/verified: **`E:/Work/scratch/lag-261105/cdp.cjs` MISSING** (cited :42); `daemon-entry` map, `runs/terminal-N.json` OK; 48 Hz display claim is machine-specific/volatile
- structure: no references; "Known AntiFan finding (2026-10-09, 2026-11-05)" sections are incident logs
- overlap: antifan-terminal-daemon-loss-triage, electron-minidump
### anti-direct
- class: **KEEP**; scout cluster C; roots: agents; SKILL.md 34 lines; desc 374 chars; uses30d(sessions): 22; descQ 4/5; lang EN + VI trigger phrases with diacritics
- action: Only in `.agents`; copy to `.claude`/managed or decide it is agents-only. Add 1-line DoD (what "verified" means) and not-for (already in Scope).
- stale/verified: Hooks/tool names (`core.query`, `REFUSED_CORE_RETRIEVAL_POLICY`) not re-verified against src (grep hit only unrelated files)
- structure: `disable-model-invocation:true` + `user-invocable`; no DoD; fine size
- overlap: none (unique)
### antifan-browser-fingerprint-probe
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 49 lines; desc 145 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Mark scratch path as "example"; move "Known tells" to a dated reference; add not-for (login flows).
- stale/verified: scratch dir `E:/Work/scratch/antifan-ua-probe/` MISSING (example path only; fragile); modules `browser/google-auth-identity.js`, `security/security-policy.js` exist as src; "Known tells (2026-10-09)" dated
- contradiction: none (rule "do not boot app via run-electron.cjs ." consistent with app-restart isolation)
- structure: ERR-link 1; no DoD
### antifan-detach-reattach-debug
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 31 lines; desc 201 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Rewrite description with symptoms ("project window stays detached after restart"); remove commit hashes; add DoD.
- stale/verified: commit hashes (1cc3850c, d2dfc6a3, 9e055a5d) and `Ctrl+Alt+R` hot reload unverified; `project-close-coordinator.ts`, `app-menu.ts` exist
- structure: ERR-link 1; desc has no trigger phrase; fact-dump tone
### antifan-dom-overlap-scan
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 30 lines; desc 148 chars; uses30d(sessions): 0; descQ 4/5; lang EN + VI quote
- action: Add not-for: storefront themes -> cockpit. Move "Fix rules" to its own bullet or drop (belongs to CSS rules).
- stale/verified: `prefers-reduced-motion` workspace ban verified (E:/Work/AGENTS.md:98)
- structure: only "# When"/"# Procedure"; description starts with verb list (ok); fix rules inline
- overlap: antifan-qa-cockpit (storefront scans) not same; ok
### antifan-electron-upgrade
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 47 lines; desc 189 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Replace the relaunch step with link to app-restart; make version an example placeholder.
- stale/verified: example "43.4.0→43.7.9" dated; repo now has electron 43.8.8 (node_modules/electron/dist/version); `scripts/kill-all.mjs --daemon --dry-run` exists
- contradiction: relaunch via `Invoke-CimMethod ... run-electron.cjs` vs app-restart vbs
- structure: ERR-link 2; stale 1
- overlap: app-restart (relaunch), daemon-host-restart
### antifan-history-back-proof
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 24 lines; desc 189 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Rename `storefront-history-back-proof` optional; add not-for.
- stale/verified: `anti.browser.tabs.create {anchorTabId, activate, bind}` params match docs; `facet-filters` S2/F1GENZ-specific (named)
- structure: clean; no DoD line but Proof step 6 is one
### antifan-leader-pagespeed-closeout
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 103 lines; desc 266 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Rename `leader-pagespeed-closeout`; link psi-antifan-serial-runner for step 1 instead of its own PSI snippet; move §7 report gotchas to leader reference.
- stale/verified: all 5 `E:/Work/tools/Pagespeed/probes/*.js` exist; `qa-receipts/*.json` glob pattern unverified; round cap "4 work rounds" matches leader
- contradiction: `DONE_WITH_CONCERNS is not valid` correct for leader-report/1 but root CLAUDE.md §2 uses it for terminal yield: scope the sentence
- structure: no references; many probe commands inline; ok size
- overlap: pagespeed, ghn-pagespeed-contract, trello-result-comment-short, psi-antifan-serial-runner (external/in cluster)
### antifan-leader-session-audit
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 36 lines; desc 221 chars; uses30d(sessions): 0; descQ 4/5; lang VI body (diacritics ok), EN desc
- action: Fix the `--peek` trap line; description in EN fine; consider merging as a "scout round" section in leader references.
- stale/verified: `wait-workers.mjs --peek` "not a valid flag" (:32) is STALE: `--peek`, `--once`, `--table` valid in fleet-watch.mjs:554-556 (wait-workers delegates `--mine` to fleet-watch)
- contradiction: contradicts leader (`--mine` fleet waiter OK) none
- structure: VI body, EN description; short
- overlap: antifan-leader (workflow generic), antifan-leader-worker-round no
### antifan-leader-worker-round
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 35 lines; desc 230 chars; uses30d(sessions): 102; descQ 4/5; lang EN
- action: Delete volatile disk line; lives only in managed (no VCS): move to repo `skills/` with antifan-leader so both ship together; trim "each cost dozens of failed calls" fluff.
- stale/verified: "Drive E: ... 145 MB free on 10/11/2026" is volatile and wrong now (E: freed to ~23 GB on 11-17 per memory); `validate-report`, `report.mjs` `validateReportText` exist; stale-path-count 2 (scratch job paths)
- contradiction: none vs AGENTS §8 (matches `--nodelete`, settings_data rule)
- structure: very dense 700+ char lines; valuable; no references
- overlap: antifan-leader §push policy (duplicate text), antifan-leader-session-audit no
### antifan-mcp-react-dashboard-ops
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 35 lines; desc 258 chars; uses30d(sessions): 0; descQ 3/5; lang VI body diacritics ok
- action: Generic parts stay; move Redis-specific section to references/redis-cloud.md and cross-link the redis skills; absorb Cloudflare token recipe from stdio-mcp-driver.
- stale/verified: Tool names via xd:// OK; Redis Cloud flow 07/11/2026 dated; neighbours `redis-cloud-dashboard-db-delete-antifan`, `redis-cloud-cancel-antifan` exist (outside cluster)
- structure: VI body, EN desc; description-trigger flagged
- overlap: redis-cloud-dashboard-db-delete-antifan, redis-cloud-exit-runbook
### antifan-mcp-tab-health-check
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 67 lines; desc 240 chars; uses30d(sessions): 118; descQ 4/5; lang EN
- action: Fix skill name; move dated observations to a reference; keep state table.
- stale/verified: **cites `antifan-tab-drive-via-stdio-mcp` (:12): does not exist; real name `antifan-stdio-mcp-driver`**; observations dated 2026-10-12/11-10; main.log path OK
- structure: no references; good structure
- overlap: antifan-stdio-mcp-driver
### antifan-partial-commit-shared-tree
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 24 lines; desc 136 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Add description trigger ("main tree has other sessions' hunks"), add DoD (tree hash equals tested tip); mention eval `commit.draft()` as the lighter path.
- stale/verified: `scripts/verify-in-worktree.ps1`, `install-managed-skills.mjs --check/--install` exist; "44 commits verified 12/11/2026" dated
- contradiction: its `commit -F msgfile` fine; note: this session's rule says use `commit` eval namespace
- structure: no heading for first section; ERR-link 3
- overlap: root contract skill `antifan-partial-commit` N/A; `ak-git`
### antifan-readonly-prod-spa-probe
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 20 lines; desc 194 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Generalize title to "readonly-spa-api-capture"; keep MultiLanguage as example.
- stale/verified: F1GENZ MultiLanguage specifics (`/api/translation/...`, tinymce v7 note)
- structure: `# When/# Procedure` ok
- overlap: tinymce-late-content (refers to it), tinymce harness
### antifan-session-loss-triage
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 52 lines; desc 130 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Replace line numbers with symbol names; move Known patterns to a dated reference.
- stale/verified: `cookie-eviction-log.ts:62` and `google-auth-cookie-log.ts` exist (line refs 80-93, native-tab-host 6923-6958, google-auth-identity 259-275 not re-verified, will drift)
- structure: no references; dated "Known patterns (2026-10-20)"
- overlap: antifan-terminal-daemon-loss-triage (both read main.log)
### antifan-stdio-mcp-driver
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 45 lines; desc 143 chars; uses30d(sessions): 42; descQ 4/5; lang EN
- action: Move CF token recipe out (react-dashboard-ops or cloudflare skill); align Playwright sentence with AGENTS fallback rule; keep as the target of tab-health-check's link.
- stale/verified: `antifan-agent.cjs mcp --tab` exists; error codes WS_AUTH_REFUSED etc plausible; secrets-handling advice consistent with root rules
- contradiction: says Playwright forbidden (AGENTS §3.1) vs AGENTS fallback-record rule (allows Playwright with record_fallback): wording stronger than root
- structure: includes unrelated "Cloudflare API token recipe" (:34-38) and marketplace page rules
- overlap: mcp-tab-health-check (cross-link broken there)
### antifan-terminal-daemon-loss-triage
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 39 lines; desc 174 chars; uses30d(sessions): 4; descQ 4/5; lang EN
- action: Cross-link minidump skill; move hog list to dated reference.
- stale/verified: `daemon.log` path ok; crash-dump-forensics.ts exists; example 2026-11-02 dated; `reels_lib/whisper_asr.py` path not verified
- structure: no references; good
- overlap: electron-minidump-symbolize (adjacent), electron-main-live-profiling
### electron-minidump-symbolize
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 39 lines; desc 110 chars; uses30d(sessions): 0; descQ 2/5; lang EN
- action: Rewrite description (`Use when a native crash .dmp needs function names`) and link from daemon-loss triage.
- stale/verified: crash dump dir `E:\Work\.antifan-data\runtime\crashDumps\reports` plausible; Electron 43.8.8 current; GitHub symbols URL not re-fetched
- structure: desc is a method sentence, no "Use when"; ok body
- overlap: antifan-terminal-daemon-loss-triage step 2 (already has summarizeCrashDump)
### psi-antifan-serial-runner
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 68 lines; desc 208 chars; uses30d(sessions): 9; descQ 4/5; lang EN
- action: Add not-for; leader closeout should link here; pin version note as example.
- stale/verified: `tools/Pagespeed/probes/psi-antifan-runner.js` exists; `lighthouse@13.6.0` pinned version volatile
- structure: no references
- overlap: pagespeed skills, antifan-leader-pagespeed-closeout step 1
### storefront-widget-cdn-bypass-verify
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 40 lines; desc 155 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add DoD wording ("report iframe result as proof, shopper URL blocked until purge" already there).
- stale/verified: none external
- structure: no references
### test-browser-js-probe-offline-node
- class: **KEEP**; scout cluster C; roots: managed; SKILL.md 48 lines; desc 199 chars; uses30d(sessions): 2; descQ 3/5; lang VI body ok
- action: Move out of AntiFan namespace or rename generic; add not-for (browser E2E).
- structure: VI body, EN desc; generic Python pattern, nothing AntiFan-specific
### antifan-ab-test-triage
- class: **MERGE** → `antifan-compiled-ab-test`; scout cluster C; roots: managed; SKILL.md 40 lines; desc 151 chars; uses30d(sessions): 4; descQ 3/5; lang EN
- action: Move §1 per-file runner + junction cleanup as `references/quick-tsx-triage.md` (flag "non-authoritative for test/main, test/renderer"), keep Classify table in owner; retire name.
- scout verdict text: MERGE→antifan-compiled-ab-test
- stale/verified: `tsx` artifacts section is dated; uses scratch `ab-head-<yymmdd>`
- contradiction: contradicts antifan-compiled-ab-test:8 (tsx unreliable vs this skill's tsx runner as primary)
- structure: no not-for, no neighbour pointer; "Known tsx artifacts (2026-10-11)" is dated
- overlap: antifan-compiled-ab-test (same contract); compiled-ab-test:8 says tsx gives false reds for main/renderer tests
### antifan-detached-shutdown-job
- class: **MERGE** → `antifan-daemon-host-restart`; scout cluster C; roots: managed; SKILL.md 40 lines; desc 158 chars; uses30d(sessions): 10; descQ 3/5; lang EN with VI quote
- action: Same schtasks recipe duplicated at :25-31 and daemon-host-restart:35-40; one reference file.
- scout verdict text: MERGE→antifan-daemon-host-restart (shared `references/detached-runner.md`) or KEEP distinct with link
- stale/verified: `runs/finish-<stamp>.log` convention only; uses "làm hết" trigger
- structure: ERR-link 1; no not-for
- overlap: daemon-host-restart (arming), electron-upgrade (cold stop)
### antifan-leader-deploy-ship
- class: **MERGE** → `antifan-leader`; scout cluster C; roots: managed; SKILL.md 42 lines; desc 183 chars; uses30d(sessions): 0; descQ 2/5; lang EN
- action: Move §1-3 (substitution, `pushed` array) into leader `references/dispatch.md`; move §4-6 (deploy/DO rollback/post-deploy watch) to cf-worker-kaizen-ship-and-watch; retire name.
- scout verdict text: MERGE→antifan-leader (section) + cf-worker-kaizen-ship-and-watch
- stale/verified: `mcp__antifan_browser_terminal_*` xd paths OK; wrangler recipes unverified
- contradiction: says Enter MUST be its own call (:21) while leader:53 says `input ending \r` is normal
- structure: desc starts "Ship..." but title is "Leader: ship a deployed fix"; mixes xd:// tool-substitution workaround, report-schema gotcha, wrangler deploy
- overlap: cf-worker-kaizen-ship-and-watch (external), antifan-leader
### antifan-leader-dispatch-worker-pane
- class: **MERGE** → `antifan-leader`; scout cluster C; roots: managed; SKILL.md 83 lines; desc 293 chars; uses30d(sessions): 10; descQ 3/5; lang EN
- action: Keep §4 (28 s wait), §5 (stage follow-up file), §6 (user screenshots to job dir) as `antifan-leader/references/dispatch.md`; drop §3 launch line in favour of `LJ dispatch` output; retire name.
- scout verdict text: MERGE→antifan-leader
- stale/verified: `cp C:/Users/Admin/.omp/agent/sessions/--<cwd-slug>--/...` path pattern fragile; 28 s wait cap fits leader skill
- contradiction: contradicts leader: closes with plain `terminal.close {sessionId}` (leader requires `close-worker.mjs`); launches `omp "<prose>"` without `@file` and `\r`; report format `STATUS:/SUMMARY:/EVIDENCE:` vs leader-report/1 json
- structure: desc is a feature list, no not-for; hand-written prompt flow ignores `LJ init/dispatch`
- overlap: antifan-leader §1 tools table (same content, richer)
### antifan-project-windows-matrix-ab
- class: **MERGE** → `antifan-project-windows-matrix-ab`; scout cluster C; roots: managed; SKILL.md 48 lines; desc 183 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Absorb probe-run's unique bits (ANTIFAN_COMPILED_ROOT, stdout redirect) ; retire probe-run.
- scout verdict text: MERGE→antifan-project-windows-matrix-ab (owner)
- stale/verified: probe scripts exist; receipts dir `plans/260927-0315-project-windows/reports/` not re-verified; "Known rows (as of 2026-10-24)" dated
- structure: ERR-link 5
- overlap: antifan-project-windows-probe-run (near-identical §1-§7)
- absorbs: antifan-project-windows-matrix-ab, antifan-project-windows-probe-run
### antifan-project-windows-probe-run
- class: **MERGE** → `antifan-project-windows-matrix-ab`; scout cluster C; roots: managed; SKILL.md 46 lines; desc 140 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: See above.
- scout verdict text: MERGE→antifan-project-windows-matrix-ab
- stale/verified: same
- contradiction: same
- structure: ERR-link 8
- overlap: matrix-ab
### antifan-qa-baseline-receipt-loop
- class: **MERGE** → `antifan-qa-cockpit`; scout cluster C; roots: managed; SKILL.md 35 lines; desc 154 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Becomes `references/baseline-receipts-and-waivers.md`; cockpit step 5 points to it.
- scout verdict text: MERGE→antifan-qa-cockpit
- stale/verified: waiver rule-id list (font-below-min ... floating-widget-overlap) not re-verified in src; certification caps at STRUCTURAL consistent with cockpit
- structure: no references
- overlap: antifan-qa-cockpit step 5, verdict-qualification
### antifan-qa-scroll-artifact
- class: **MERGE** → `antifan-qa-cockpit`; scout cluster C; roots: managed; SKILL.md 21 lines; desc 129 chars; uses30d(sessions): 7; descQ 3/5; lang EN
- action: `references/known-false-positives.md` with the `QA_MICRO_STATIC` rule; confirm bug still exists first.
- scout verdict text: MERGE→antifan-qa-cockpit
- stale/verified: claim "scanner measures viewport-relative" not re-verified (engine was fixed per cockpit:103)
- structure: desc has no "Use when"; 21 lines
- overlap: cockpit, verdict-qualification
### cloudflare-worker-local-smoke-windows
- class: **MERGE** → `local-worker-signed-in-ui-qa`; scout cluster B1; roots: managed; SKILL.md 16 lines; desc 149 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: combine into one Windows/D1/R2 smoke skill; this file's items 2-3,8 → `references/windows-gotchas.md`
- scout verdict text: MERGE→(one of three; propose owner local-worker-signed-in-ui-qa [INFERENCE: not read])
- stale/verified: stale-path false positive `C:\Program Files` :5 (text, not a path); no repo named
- structure: 8 dense numbered lines, no H2/DoD; std-warn standard-sections
- overlap: local-worker-signed-in-ui-qa, worker-local-smoke-antifan-ui-qa (3-way duplicate, other clusters)
### tinymce-late-content-blank-after-f5
- class: **MERGE** → `tinymce-react-init-race-harness`; scout cluster C; roots: managed; SKILL.md 21 lines; desc 189 chars; uses30d(sessions): 0; descQ 3/5; lang EN
- action: Keep only prod-evidence steps (own-tab XHR, real reload) as `references/prod-evidence.md`; drop the setTimeout fix.
- scout verdict text: MERGE→tinymce-react-init-race-harness
- stale/verified: fix pattern references `src/components/editor/index.jsx` (app repo, not checked)
- contradiction: **DIRECT CONTRADICTION:** step 3 recommends `window.setTimeout(0)` in onInit; race-harness:12 says NEVER defer with setTimeout, apply in `init_instance_callback` (timer fires 70-190 ms late, data overwritten)
- structure: no not-for; description-trigger flagged
- overlap: tinymce-react-init-race-harness, antifan-readonly-prod-spa-probe
### antifan-leader-wait-workers-polling
- class: **RETIRE**; scout cluster C; roots: managed; SKILL.md 24 lines; desc 168 chars; uses30d(sessions): 4; descQ 2/5; lang EN
- action: Delete; fold the one verified fact (`--ignore` unsupported; pin with `--w ... --all`) into leader references/dispatch.md.
- stale/verified: Superseded: leader §1 now says `--mine` dedups via `fleet-watch.mjs` (exists); `--ignore` still absent (verified: no `--ignore` in wait-workers/fleet-watch)
- contradiction: says `--mine` loops; leader says relaunch `--mine` after every return
- structure: desc is a note, body admits "unconfirmed locally"; incident log dated 2026-11-07
- overlap: antifan-leader §1 rows "Wait for ALL your workers"
### ccs-delegation
- class: **RETIRE**; scout cluster C; roots: agents,claude; SKILL.md 196 lines; desc 450 chars; uses30d(sessions): 3; descQ 2/5; lang EN
- action: Remove from `.agents`/`.claude` unless CCS is in use (run `ccs doctor` first); if kept, shrink to 40 lines and drop the regex algorithm.
- stale/verified: `~/.ccs/config.json` MISSING on this machine (`ccs.cmd` exists in npm global); references/troubleshooting.md suggests `rm ~/.ccs/delegation-sessions.json`
- contradiction: triggers on "fix" keyword vs root rule "never weaken verification", delegating "fix/test" blindly; `/ccs` slash commands may not exist in OMP
- structure: frontmatter `version: 3.0.0` and folded `>-` description 450 chars; vendor docs copy, no Tài context; keyword regex for profile selection
### worker-local-smoke-antifan-ui-qa
- class: **RETIRE**; scout cluster C; roots: managed; SKILL.md 15 lines; desc 130 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Fold `visual_quality`, "restore device preset" and "320px overflows first" lines into local-worker-signed-in-ui-qa; delete.
- scout verdict text: RETIRE (merge)
- structure: no not-for
- overlap: local-worker-signed-in-ui-qa (subset)

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. **Restart / relaunch / shutdown of AntiFan** — owner: `antifan-app-restart`.
   - app-restart: isolated instance default + live restart gate; becomes the only relaunch recipe (`run-antifan.vbs`, listener-owner main check, compile staleness check).
   - daemon-host-restart + detached-shutdown-job: stay separate (different authority: ends all PTYs / needs AntiFan closed) but share one `references/detached-runner.md` (schtasks arm outside tree, runner log, disarm) in daemon-host-restart; detached-shutdown-job links it.
   - electron-upgrade: keep (cold stop + binary), replace its relaunch step with link.
   - mcp-benchmark §3 and toolbar-action restart paragraph: delete, link owner. Restore/commit `daemon-restart.mjs` (cited, missing).
2. **A/B of uncommitted diff vs HEAD** — owner: `antifan-compiled-ab-test`. ab-test-triage → `references/quick-tsx-triage.md` (flag as unreliable for test/main, test/renderer, per owner :8). Separate cluster: `antifan-project-windows-matrix-ab` (owner) absorbs `antifan-project-windows-probe-run`.
3. **Leader family** — owner: `antifan-leader` (repo source). 
   - dispatch-worker-pane → `references/dispatch.md` (wait cap 28 s, stage follow-up file, user screenshots; delete its raw launch/close recipes that contradict `LJ dispatch` and `close-worker.mjs`).
   - deploy-ship → leader `references/dispatch.md` (§1 substitution, §3 `pushed` array) + `cf-worker-kaizen-ship-and-watch` (deploy/DO rollback/watch).
   - wait-workers-polling → retire; add its one verified fact to dispatch.md.
   - session-audit → keep, fix `--peek` note (or leader reference "scout round").
   - pagespeed-closeout → keep separate (own evidence contract) but link psi-antifan-serial-runner.
   - worker-round → keep (worker-side role); move to repo `skills/` beside antifan-leader.
4. **Theme QA verdict stack** — owner: `antifan-qa-cockpit` (slim). baseline-receipt-loop → `references/baseline-receipts-and-waivers.md`; scroll-artifact → `references/known-false-positives.md`; verdict-qualification → `haravan-storefront-qa-proof-gate` (verdict wording; single owner of "only CERTIFIED is PASS"); cockpit's Sapo/M-check/functional-regression tables → `theme-qa-az/references/` (it already owns M1-M12 and codes). `antifan-qa-engine-fixture-probe` stays separate (engine dev, not theme QA).
5. **Local Worker smoke** — owner: `local-worker-signed-in-ui-qa`; retire `worker-local-smoke-antifan-ui-qa`; decide against external `cloudflare-worker-local-smoke-windows` (merge that pair into one owner).
6. **TinyMCE** — owner: `tinymce-react-init-race-harness`; `tinymce-late-content-blank-after-f5` → `references/prod-evidence.md` minus the wrong setTimeout fix; `antifan-readonly-prod-spa-probe` stays (generic SPA capture) and is linked.
7. **MCP-down / tab driving** — keep `antifan-mcp-tab-health-check` (read-only check) and `antifan-stdio-mcp-driver` (fallback driver) separate; fix broken link; move Cloudflare token recipe out of the driver.
8. **Misplaced "antifan-" skills that belong to other domains**: antifan-facebook-page-post (→ Facebook/Gác cluster owner), antifan-haravan-verify-loop (→ haravan-storefront-qa-proof-gate), psi-antifan-serial-runner and storefront-widget-cdn-bypass-verify (→ PageSpeed/Haravan storefront domain, or keep with `antifan-` prefix dropped), antifan-history-back-proof (→ storefront domain). They use AntiFan only as the instrument; routing by domain word will find them more reliably.

## (c) Rewrite candidates

1. **antifan-leader** — 67 KB single-file diary (sections 2b-2j incl. dated mistakes/session notes, git deletion safety, wrangler), stale §2h (planSapoCommand now exists), 36 broken-link flags. Gap: split to <300 lines + references; repo is source of truth.
2. **antifan-qa-cockpit** — 191 lines: protocol buried under dated live findings, proposed non-existent checklist items, hand-maintained tool table; hrv sentence contradicts AGENTS §8. Gap: protocol-only SKILL.md, move findings to theme-qa-az, drop proposals.
3. **antifan-app-restart** — correct and valuable but 76 dense lines with missing probe cites, drifted line numbers (index.ts 4631→4747), and three competing recipes elsewhere. Gap: one recipe + references/live-restart.md.
4. **antifan-dogfood-clone** — persona + "6 inviolable invariants" + LaTeX, description is keyword soup (2/5). Gap: contract-style SKILL.md (input URL, outputs, DoD = acceptance report) and a not-for versus `site-clone`.
(Also strong candidates: antifan-daemon-host-restart for the missing runner; antifan-qa-engine-fixture-probe for the missing harness.)

## (d) Cluster-level inconsistencies

- Tool naming is inconsistent: `xd://mcp__antifan_browser_anti_browser_tabs_list` (tab-health-check), `anti_browser_evaluate` (haravan-verify-loop, psi-serial-runner), `anti.browser.evaluate` (most), `browser.set_viewport`, `tabs_list`. Pick one canonical form per skill family; the xd:// path is the only one that is directly callable.
- Three relaunch recipes (app-restart vbs; mcp-benchmark `Start-Process node run-electron.cjs`; electron-upgrade `Invoke-CimMethod`), plus an unmentioned `scripts/antifan-restart.ps1`.
- Worker dispatch protocol disagrees: Enter via `input ...\r` (leader:53) vs separate `key:"enter"` always (deploy-ship:21, dispatch-worker-pane:32-36); close via `close-worker.mjs` (leader) vs raw `terminal.close` (dispatch-worker-pane:74); report format JSON `leader-report/1` vs `STATUS/SUMMARY/EVIDENCE` lines.
- hrv/CLI authority: antifan-qa-cockpit:40 ("never run haravan/hrv CLI") vs E:/Work/AGENTS.md §8 (any agent may run `hrv theme push --nodelete` to the bound theme) and antifan-leader/worker-round (workers push themselves).
- Citation rot: cites to missing files (`daemon-restart.mjs`, two probe scripts, three scratch harness dirs, skill `antifan-tab-drive-via-stdio-mcp`) and drifted line numbers; many skills hard-code `:line` refs and dated pids/commit hashes.
- Dated incident logs (Known findings/baselines/"verified 2026-10-xx") live inside SKILL.md in ~15 skills; AgentKit standard says no volatile facts: move to references with dates or delete.
- Storage: 333 managed-only skills have no VCS. Of this cluster only antifan-leader (and f1genz-feedback-comment-post) are repo-sourced; the other 44 (including worker-round, which must match the leader contract) can silently drift. Put the AntiFan-owned ones under `E:/Work/apps/AntiFan/skills/` and install with `scripts/install-managed-skills.mjs`.
- Duplicated roots: `.agents` and `.claude` hold identical copies of antifan-qa-cockpit, antifan-dogfood-clone, ccs-delegation; anti-direct only in `.agents`; theme-qa-az (referenced by the cockpit as a hard dependency) is not in managed-skills, so the managed install of the cockpit can reference a skill the same host may not load.
- Description quality: 15 of 47 are method sentences without "Use when"/not-for (wait-workers-polling, minidump, deploy-ship, haravan-verify-loop, dogfood-clone, ccs-delegation lowest). Language: mostly EN; VI bodies (toolbar-action, session-audit, react-dashboard-ops, test-browser-js-probe) keep diacritics; no VI-without-diacritics found in descriptions.
- No secret values found in any file of the cluster.
