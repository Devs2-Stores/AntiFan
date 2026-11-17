# Work order — fixer E1 (Gác content/video/TikTok/FB part 1)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-E1.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = E1). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### ai-model-character-refs
- class: **OWNER**; scout cluster E1; roots: managed; SKILL.md 52 lines; desc 190 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Become owner `ai-model-character-refs`; add references/qa.md, references/revision-round.md, references/from-footage.md; delete dead bao-chau pointers; add "Done when"
- scout verdict text: KEEP (as owner)
- stale/verified: L8 cites `_character/bao-chau/` and L16 `_character/bao-chau/_gen_refs.py`: both MISSING (verified); `tuong-vy` dir exists; yunet.onnx exists
- structure: description lacks not-for; no definition-of-done section; hard-coded Cloudflare account id (L36, an ID not a secret) and R2 pub URL (L38)
- overlap: MERGE target: overlaps ai-model-reference-set-qa (steps 1-4 near-identical), character-ref-revision-round, identity-locked-character-from-footage
- absorbs: ai-model-reference-set-qa, character-ref-revision-round, identity-locked-character-from-footage
### capcut-draft-test-windows
- class: **OWNER**; scout cluster E1; roots: managed; SKILL.md 47 lines; desc 173 chars; uses30d(sessions): 2; descQ 4/5; lang VI body, EN desc
- action: Absorb harness; add not-for ("not for building CapCut video via API: none exists"); keep dated facts in a references/facts-261113.md
- scout verdict text: KEEP (as owner)
- stale/verified: no absolute paths to verify; winget commands unverified; MCP URL external
- structure: standard-sections warn (no Done/When-not); facts dated "đo 13/11/2026"
- overlap: owner of capcut pair
- absorbs: capcut-draft-test-harness
### muse-studio-add-account → rename `muse-studio-accounts`
- class: **OWNER**; scout cluster E1; roots: managed; SKILL.md 59 lines; desc 160 chars; uses30d(sessions): 2; descQ 4/5; lang VI body, EN desc
- action: Rename, absorb recovery; update pool facts; add Done (capacity() = accounts×slots)
- scout verdict text: KEEP (rename→muse-studio-accounts)
- stale/verified: verified `muse.db accounts` has only muse-10; L55 "đo với 4 tài khoản" stale; port formula 9332+n → muse-10=9342 ✓ matches DB port 9342; `.muse-account-4.env` MISSING
- contradiction: none; secrets handling is correct (L57-59)
- structure: standard-sections warn (no Done); 6 stale-path hits are placeholders (`.muse-account-<n>.env`, `.muse-chrome-<n>`)
- overlap: overlaps muse-account-login-recovery
- absorbs: muse-account-login-recovery
### an-vat-muse-cart-clip
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 79 lines; desc 220 chars; uses30d(sessions): 20; descQ 3/5; lang EN desc, VI/EN body
- action: Keep ≤120 stable lines: gates + workflow + Done; move lesson narrative and dated numbers to channels/an-vat/team-lessons.md (already the owner of lessons); absorb lot-finalize as references/finalize.md and wan-voice as references/wan-variant.md
- stale/verified: L56 `scratch/an-vat-6clip-261103/r5/` exists only under `E:/Work/Gác/scratch/` (as `E:/Work/scratch/...` MISSING); channels/an-vat/tools/r5/build_r5.py, tools/build6p.py, reference-channels.md exist; `Muse Studio http://127.0.0.1:8790/` live task
- contradiction: vs an-vat-wan-voice-clip: Muse 30 s vs Wan 4×5 s take; vs gateway-tts-capability-probe L42 (an-vat "stays music-only") ; vs furniture-reels L77 ("all channels except ttb music only")
- structure: density far above 300-line-equivalent; description exposes internal IDs; no Done section; owner quotes and dated measurements in body (volatile facts: L29-30 "34 h wall clock", "227 files 1,097.71 MB", L56 scratch path); numbered sections "000/00/0" are non-standard
- overlap: overlaps an-vat-muse-lot-finalize (steps 4-6 overlap), an-vat-wan-voice-clip (labels, hook, fact rules), gac-content-team adapter row (an-vat), channel-rules-digest-refresh
- absorbs: an-vat-muse-lot-finalize, an-vat-wan-voice-clip
### furniture-reels
- class: **REWRITE**; scout cluster E1; roots: claude; SKILL.md 242 lines; desc 684 chars; uses30d(sessions): 357; descQ 3/5; lang mix VI/EN
- action: Split: keep ≤150-line SKILL (flow table + hard rules + errors); move Fanpage-publish block (L187-216) → references/publish.md; "Đo bộ viết brief" (L227-237) → references/briefeval.md; split prompt-template.md into 3 files ≤300; remove .git/.bak from skill dir; rename or alias `shopee-product-reels`
- stale/verified: L25 `E:/Work/shopee-reels` mention ok (historic); `E:/Work/scratch/fade-rule/` + `measure.json` MISSING (referenced in refs); `channels/ttb` exists; scripts/assets/yunet.onnx exists; name "furniture" misleading (L13-14)
- contradiction: L77 "only ttb has character voice, all other channels music-only" vs an-vat Adam voice (cart-clip L8, wan-voice L23); L159 "do not use Muse for reel" vs ttb-muse-30s-reel; L213 TTB FB only
- structure: prompt-template.md 548 lines >300; SKILL lines up to 1500 chars of owner-dated quotes; nested `.git`, `.pytest_cache`, `variety.py.bak-261113-*` inside skill dir (cruft); user-invocable/category/keywords extras; description mixes EN/VI and ends with not-for (good)
- overlap: overlaps gac-content-team, an-vat-*, ttb-muse-30s-reel (L159-160), facebook-page-reels-setup, character skills
### gac-content-team
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 126 lines; desc 334 chars; uses30d(sessions): 23; descQ 4/5; lang EN
- action: Cut dead channels from adapter table; move "Self-learning loop" L48-91 → references/lessons.md; keep ≤100 lines; link live channels only
- stale/verified: adapter table L106-112 lists `nha-cua-doi-song, bep-gia-dung, tui-xach, thu-cung, giay-dep, bao-chau-beauty, thoi-trang-nam, tap-hoa, xa-xiu-ban-lang, tuong-studio, tuong-finds` — only an-vat, flycam, tap-hoa, ttb, tuong-vy exist (verified `ls channels`); `tiktok-reviewer.md` agent exists; "ak-team" exists only in `.claude/skills`
- contradiction: max 6 teammates (L15) vs gac-golden-slot-fill-fleet 14 agents
- structure: SKILL.md body ≤300 but lines up to 1000 chars; many MUST-style rules; one contract (team protocol) + one (lesson loop) + adapter table
- overlap: overlaps ak-team (generic), an-vat-muse-cart-clip
### gac-daily-status-check
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 51 lines; desc 177 chars; uses30d(sessions): 4; descQ 3/5; lang EN
- action: Re-baseline to the 5 live channels; absorb gac-golden-slot-coverage-check as references/slot-coverage.md; drop dated anecdotes
- stale/verified: `E:/Work/.ttb-dash-data/ttbdash.log` not checked; section 0 assumes tray exists
- contradiction: CONTRADICTS gac-page-engage L6 (tray off since 02/11/2026) and its own step 0 premise; ranking ignores 9 deleted channels
- structure: long dated facts (01/11, 30/10 D1 code 7403, 28/10 cutoff, "Băng Sương, Nhã Uyên retired") ; no Done section beyond Report
- overlap: overlaps gac-golden-slot-coverage-check, gac-page-engage-agent-session (engage status), gac-telegram-alert-triage
### gac-new-tiktok-channel-setup
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 37 lines; desc 152 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Remove snack-cga pointer (point to ttbdash gen gateway docs), move §5 food results to LOG; add Done
- scout verdict text: REWRITE (light)
- stale/verified: L24 `scratch/snack-cga/gen.py` MISSING (verified); `rules_hard.py` VY set exists; HappyHorse/Wan results 01/11 volatile
- structure: standard-sections warn; dated results §5
- overlap: overlaps nothing; related an-vat-muse-cart-clip
### gac-page-engage-agent-session
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 48 lines; desc 350 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Update page list to live ones; split pitfalls → references/pitfalls.md; leave runner commands + hard rules (no engage reset, no TTB_ENGAGE_DIR)
- stale/verified: `scratch/fill0211/runner.py`, `produce_loop.py` exist; `plans/reports/engage/ledger.jsonl` exists; live Pages "ttb, vy, nha, bep, giay, nam" – nha/bep/giay/nam channels gone
- contradiction: tray off since 02/11 (self) vs daily-status step 0
- structure: description 363 chars; lines up to 1100 chars; pitfalls as dated incident log (02/11)
- overlap: overlaps gac-daily-status-check §3
### gateway-tts-capability-probe
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 47 lines; desc 207 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Delete §5 baseline or move to references; delete L42; merge with probe-9router-models (owner: this)
- stale/verified: endpoints http://127.0.0.1:20128/v1, api.ai-box.vn/v1 not verified
- contradiction: L42 "Ăn Vặt stays music-only... voice clips are tests (C8)" contradicts an-vat skills (Adam voice, vclip.io, since 03/11)
- structure: volatile fact warn: §5 baseline 02/11 (36 models etc.); L8 cost claim "few thousand tokens"
- overlap: overlaps probe-9router-models (other cluster)
- absorbs: probe-9router-models
### muse-studio-app-ops
- class: **REWRITE**; scout cluster E1; roots: managed; SKILL.md 100 lines; desc 271 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Split Flycam block (§"Reel audio" + "Rules the app enforces") → references/flycam.md; scope taskkill clause to approved restart; add Done (new pid StartTime > file mtime)
- stale/verified: verified: schtasks "Muse Studio (Gác)" exists; `musestudio/flycam.py`, `autopilot.py` exist; `E:/Work/.flycam-yt.env` MISSING (documented as blocker, L94) ; `/trang-thai`/`/jobs` 404 fact not rechecked
- contradiction: L30 instructs `taskkill /PID <pid> /F` which collides with Level-0 CLAUDE.md "uncoordinated pkill/taskkill NEVER" — needs scoping ("only the Muse serve pids the user asked to restart")
- structure: mixes two contracts (app ops + Flycam audio cache/slots rules); emphasis-no-reason warn; lines up to 400 chars; volatile numbers (847 scenes, 12/day, STOCK_TARGET)
- overlap: an-vat-autopilot-stall-triage (explicit hand-off, good)
### ai-image-studio
- class: **KEEP**; scout cluster E1; roots: agents,claude; SKILL.md 121 lines; desc 653 chars; uses30d(sessions): 35; descQ 4/5; lang EN
- action: Replace relative script path with `~/.claude/skills/ai-image-studio/scripts/...` (or `$ENV`); move L56 to haravan-upload-file; keep one root (drop duplicate in .agents or symlink)
- stale/verified: verified: scripts/gen-images.mjs+test, references/colour-map.md+scene-archetypes.md, `E:/Work/tools/Generate/node_modules/sharp`, HaravanDemoKit cli.js exist; .agents and .claude copies byte-identical (fc)
- structure: fm has category/keywords/argument-hint/user-invocable (non-standard extras); no not-for in description (only in when_to_use:5, ok); L56 Haravan image_picker upload paragraph is off-scope; commands use relative `node .claude/skills/ai-image-studio/scripts/gen-images.mjs` (L49,50,91,111) = works only if cwd holds `.claude/skills` (`E:/Work/.claude/skills/ai-image-studio` does not exist)
- overlap: feeds ai-model-character-refs, character-ref-revision-round
### an-vat-autopilot-stall-triage
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 114 lines; desc 1030 chars; uses30d(sessions): 0; descQ 5/5; lang EN desc + VI body (consistent diacritics)
- action: Trim description to ≤1024 chars (move trigger quotes to when_to_use); move L74-82 "gate invariants" to references/gate-invariants.md; model of the cluster, copy its structure
- stale/verified: verified scripts/stallprobe.py + tests dir; muse.db exists; `musestudio/autopilot.py` exists; port 8790 task exists; L79-80 voice-estimate numbers dated 06/11 (volatile)
- structure: desc 1043 chars (limit 1024 for description alone – borderline over 1024? measured 1043 incl. quotes, check); has scripts/stallprobe.py + tests/ ; hand-off table to 5 neighbours; Done section present
- overlap: clean boundary vs an-vat-muse-cart-clip, muse-studio-app-ops, muse-account-login-recovery
### channel-rules-digest-refresh
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 39 lines; desc 188 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: Name channel an-vat in description (only supported one); add exit-code Done line
- stale/verified: `reels_lib/digest.py` exists (verified); only an-vat has spec (L23)
- structure: uses `sed -n` in code block (fine); no Done section
- overlap: closest: an-vat-muse-cart-clip (consumes digest)
### customer-guide-narrated-video
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 34 lines; desc 167 chars; uses30d(sessions): 2; descQ 4/5; lang EN desc, EN body
- action: Add not-for pointing to theme-handover-guide; recheck merge with those three in Haravan cluster audit
- stale/verified: python-docx, edge-tts install hints; `bash expands $` note valid
- structure: no not-for; mis-clustered (Haravan customer guide, not Gác)
- overlap: neighbours customer-theme-guide, customize-customer-guide, theme-handover-guide (other clusters)
### fb-reel-competitor-analysis
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 32 lines; desc 147 chars; uses30d(sessions): 3; descQ 3/5; lang EN
- action: Add triggers ("phân tích reel đối thủ"); add Done (table + patterns saved to scratch/ref-<name>)
- stale/verified: `C:/Users/Admin/.venvs/vieneu/Scripts/python.exe` exists
- structure: description 147 chars thin, no not-for; no Done
- overlap: none; related furniture-reels
### gac-channel-posting-tokens
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 40 lines; desc 176 chars; uses30d(sessions): 8; descQ 4/5; lang EN
- action: Replace Tường Studio example (retired channel); add "Done when: wrangler secret list shows names, TTB names unchanged"
- stale/verified: `channels/tuong-studio/` MISSING (L8 "Proven for Tường Studio"); FB app id `1083408444321293` is an identifier (L32, not a secret); `.wrangler-devs2` and `ttb-dash/cloud` exist
- contradiction: gac-content-team L119 "never touch Page tokens" (scoped: that skill is for roles, this is the grant flow)
- structure: no Done; very concrete UI selectors (volatile); "NEVER" bold hard rules with reasons (acceptable)
- overlap: related facebook-page-reels-setup (other cluster)
### gac-cut-channel
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 47 lines; desc 139 chars; uses30d(sessions): 2; descQ 3/5; lang EN desc, VI body
- action: Rewrite description as "Use when owner says cắt/ngừng/xóa a Gác channel; not for Page remote deletion (gac-facebook-page-bulk-delete)"
- stale/verified: verified: Gác CLAUDE.md:375 section exists; `post-plan.json` exists; ttbdash CLI commands not individually run
- structure: description-trigger warn (no "Use when"), EN desc 139 chars, VI body
- overlap: partner of gac-facebook-page-bulk-delete (remote delete)
### gac-facebook-page-bulk-delete
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 60 lines; desc 123 chars; uses30d(sessions): 0; descQ 4/5; lang EN desc, VI body
- action: Mark as completed-flow (pages deleted 06/11); remove scratch hard path or note it as historic; add Done = result.json gone table
- stale/verified: `scratch/fbdel-261106/urls.json` exists; `_backup/261101-bang-suong-nha-uyen` exists; `batch.py` ("batch.py cũ") not located; scratch/fill0211/STOP legit absent
- contradiction: consistent with CLAUDE.md remote-destructive rule (owner names pages; agent doesn't type password)
- structure: description 123 chars, no trigger examples; typo `-Graph` L11; NO Done section
- overlap: partner of gac-cut-channel
### gac-golden-slot-coverage-check
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 37 lines; desc 197 chars; uses30d(sessions): 8; descQ 3/5; lang baochau
- action: bep|tui|pet|giay|finds`: 8 of 10 deleted/missing (channels verified); "from 28/10/2026 3 reels+1 photo" dated|overlaps gac-daily-status-check; precursor of fill-fleet|n/a|EN|MERGE→gac-daily-status-check|Reduce to references/slot-coverage.md for current channels (an-vat, ttb, tuong-vy, tap-hoa, flycam) and plan-from-code rule (L11 "never hardcode times" keep)
- scout verdict text: nha
- stale/verified: lists `ttb
- contradiction: vy
- structure: standard-sections warn; expects 10 Pages
- overlap: studio
### gac-lookbook-lot-rerender
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 46 lines; desc 176 chars; uses30d(sessions): 1; descQ 4/5; lang EN desc, EN+VI body
- action: Add Done: spend.json total + both gates empty + product record keyed on new sha
- stale/verified: `_fashion-models/_wan_gen.py` and `_final.py` exist; `channels/tuong-vy` exists; trend pool IDs not verified
- structure: description-trigger warn
- overlap: owner for tuong-vy lookbook
### gac-telegram-alert-triage
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 17 lines; desc 198 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Reconcile log path; add report template; optionally move to daily-status references/alerts.md
- stale/verified: tray log path `C:/Users/Admin/AppData/Local/ttb-dash/ttbdash.log` (differs from daily-status `E:/Work/.ttb-dash-data/ttbdash.log`)
- contradiction: log path inconsistency between the two
- structure: thin: no Done, no examples
- overlap: neighbour gac-daily-status-check
### gac-writer-backend-triage
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 29 lines; desc 167 chars; uses30d(sessions): 0; descQ 4/5; lang EN desc, VI body
- action: Move L24 model list and L27-28 measurement into a dated note; add Done (named dead model + live key proof)
- stale/verified: none verifiable offline
- structure: no Done; volatile model names (qwen3.8-*, kimi-k3, glm-5.3) and "đã đo 06/11/2026"
- overlap: related gateway-tts-capability-probe and probe-9router-models (other cluster)
### instagram-web-caption-edit-antifan
- class: **KEEP**; scout cluster E1; roots: managed; SKILL.md 22 lines; desc 126 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add Done and restore-log template; add not-for (other platforms)
- stale/verified: tool names anti.browser.tabs.create / anti.agent.cursor.click exist in MCP route list
- structure: thin; no Done; no sample selectors fallback
- overlap: none (IG); relates to facebook-profile-post-antifan
### ai-model-reference-set-qa
- class: **MERGE** → `ai-model-character-refs`; scout cluster E1; roots: managed; SKILL.md 23 lines; desc 215 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Move "QA (every set)" bullets + Hand-off into ai-model-character-refs/references/qa.md; delete skill
- scout verdict text: MERGE→ai-model-character-refs
- stale/verified: yunet path exists; AIBOX key via winreg (same text as character-refs L26)
- structure: no definition of done; description is "Use when" without not-for
- overlap: DUPLICATE of ai-model-character-refs §2-3 (same eval-kernel-died-twice note, same ≥3 visible traits rule, same 182 VND cost)
### an-vat-muse-lot-finalize
- class: **MERGE** → `an-vat-muse-cart-clip`; scout cluster E1; roots: managed; SKILL.md 29 lines; desc 260 chars; uses30d(sessions): 8; descQ 3/5; lang VI
- action: Move to cart-clip/references/finalize.md; keep trap list; add "Done when"
- scout verdict text: MERGE→an-vat-muse-cart-clip
- stale/verified: commands `hooktext`, `tiktokreview`, `productmatch` exist in reels_lib (verified)
- structure: description-trigger warn (does not start with Use when); VI description with diacritics ok; no not-for
- overlap: contiguous with an-vat-muse-cart-clip §3-6
### an-vat-wan-voice-clip
- class: **MERGE** → `an-vat-muse-cart-clip`; scout cluster E1; roots: managed; SKILL.md 44 lines; desc 174 chars; uses30d(sessions): 3; descQ 3/5; lang EN desc, VI body
- action: Confirm with owner whether Wan route is dead; if yes retire, else keep only joins/fade QA (§6)
- scout verdict text: MERGE→an-vat-muse-cart-clip (as references/wan-variant.md) or RETIRE
- stale/verified: `musestudio.dub`, `cutcheck.join_report` not verified; 364 đ/s price volatile
- contradiction: CONTRADICTS cart-clip L8 (Muse 30 s, ONE vclip, never joined) — [INFERENCE] Wan route superseded for an-vat
- structure: description-trigger warn; body dated "03/11"; body L42 "kênh an-vat chưa có ledger ttbdash" (may be false now)
- overlap: overlaps an-vat-muse-cart-clip (hook, labels, Adam)
### capcut-draft-test-harness
- class: **MERGE** → `capcut-draft-test-windows`; scout cluster E1; roots: managed; SKILL.md 39 lines; desc 150 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Move "preconditions: finished out/*.mp4, no paid render" + "things that bite" into windows skill references/gac-harness.md
- scout verdict text: MERGE→capcut-draft-test-windows
- stale/verified: L8 cites `plans/reports/research-261113-ultra-capcut-api-hieu-ung.md` — resolves only at `E:/Work/Gác/plans/reports/` (`E:/Work/plans/reports/` MISSING); scratch/capcut-test-<date> placeholder; L38 volatile hook name REFUSED_LEADER_INVESTIGATE
- structure: description-trigger warn; terse
- overlap: DUPLICATE of capcut-draft-test-windows (same T0 criteria, same pyCapCut venv/draft steps)
### character-ref-revision-round
- class: **MERGE** → `ai-model-character-refs`; scout cluster E1; roots: managed; SKILL.md 45 lines; desc 307 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Move to references/revision-round.md; the R2 sha-keyed purge procedure is the unique value
- scout verdict text: MERGE→ai-model-character-refs
- stale/verified: `_character/yen-nhi/` exists; wrangler `.wrangler-devs2` exists; judge.py/finish_v2.py live in scratch (fragile)
- structure: description-trigger warn; "ALWAYS" emphasis L21 (cruft hit)
- overlap: overlaps ai-model-character-refs §4 (R2 register) and identity-locked-character-from-footage
### identity-locked-character-from-footage
- class: **MERGE** → `ai-model-character-refs`; scout cluster E1; roots: managed; SKILL.md 43 lines; desc 258 chars; uses30d(sessions): 0; descQ 4/5; lang VI
- action: Move §1-3 (find person, calibrate, i2i) to references/from-footage.md; unique value = calibrated self/other cosine band
- scout verdict text: MERGE→ai-model-character-refs
- stale/verified: `reels_lib/characters.py` presumably; Vietnamese path warning is valid
- structure: description-trigger + standard-sections warn; VI; hard-coded CF account id L38 (ID)
- overlap: overlaps ai-model-character-refs §3 (img2img), character-ref-revision-round §2 (judge.py)
### muse-account-login-recovery
- class: **MERGE** → `muse-studio-accounts`; scout cluster E1; roots: managed; SKILL.md 31 lines; desc 131 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: Make recovery a references/recovery.md of the merged account skill
- scout verdict text: MERGE→muse-studio-accounts
- stale/verified: `tools/muse-login.cjs` exists; ports 9336/9337 in L12 stale (muse-10 uses 9342); account naming
- structure: description-trigger warn; one section per stage but no Done
- overlap: overlaps muse-studio-add-account (same muse-login.cjs flow)
### probe-9router-models
- class: **MERGE** → `gateway-tts-capability-probe`; scout cluster E2; roots: managed; SKILL.md 46 lines; desc 218 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: If gateway-tts-capability-probe owns "probe capability", move this body to its references/9router-probe.md; else KEEP
- scout verdict text: MERGE→gateway-tts-capability-probe (confirm in cluster owning it)
- stale/verified: Base `127.0.0.1:20128` not probed (service); registry-key method plausible
- contradiction: none; reads key from registry and says never print (good)
- structure: No done-section; includes ~25-line code block inline (acceptable but could be reference)
- overlap: none (neighbour: gateway-tts-capability-probe in another cluster: SAME contract, TTS probe via 9router/AI Box)
### gac-golden-slot-fill-fleet
- class: **RETIRE**; scout cluster E1; roots: managed; SKILL.md 44 lines; desc 217 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Archive; keep only the "session restart kills agents: inventory by mtime, re-read Graph, progress/<Agent>.md" pattern as 8 lines in gac-content-team references/resume.md
- stale/verified: `shared/post-plan.json` exists; Finds Muse Chrome blocker (L35) ; `scratch/slots-<ddmm>/` ephemeral; channels list obsolete
- contradiction: CONTRADICTS gac-content-team max-6 parallel (L15)
- structure: emphasis-no-reason warn; written for 27/10 (10 channels, 14 agents)
- overlap: depends on coverage-check
### gac-offline-metric-reporter
- class: **RETIRE**; scout cluster E1; roots: managed; SKILL.md 55 lines; desc 159 chars; uses30d(sessions): 0; descQ 3/5; lang EN desc, VI body
- action: Fold L33 vault.redact caveat and L37-43 importlib pattern into ttb-dash test notes; fix typo if kept
- stale/verified: `ttbdash/slotmeasure.py`, `collect_fb.py`, `notify`, `vault` modules (not individually verified); `E:/Work/scratch/leader/<job>` ephemeral
- structure: description-trigger + standard-sections warns; EN desc, VI body; stray Chinese "传" L33
- overlap: one-off job pattern
### gac-workspace-state
- class: **RETIRE**; scout cluster E1; roots: managed; SKILL.md 40 lines; desc 98 chars; uses30d(sessions): 0; descQ 2/5; lang VI+EN mix
- action: Delete; keep only key-file list in `E:/Work/Gác/CLAUDE.md`
- stale/verified: accounts "muse-4..9 (only 4/5 enabled)" FALSE: `muse.db` accounts = muse-10 only; pending list 05/11 obsolete; "Flycam module" files exist
- contradiction: hrv rule is a copy (drift risk)
- structure: no routing value; description 98 chars generic; state not skill
- overlap: duplicates memory/handoff; rules duplicate AGENTS.md (hrv push --nodelete) and mix theme rules (reduced-motion) into Gác

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. Character reference sets → owner **ai-model-character-refs** (4 skills). Members: ai-model-reference-set-qa (QA recipe → references/qa.md), character-ref-revision-round (revision + R2 purge → references/revision-round.md), identity-locked-character-from-footage (calibration/from footage → references/from-footage.md). Owner SKILL.md keeps: persona prompts, front-first approval gate, registration (R2 upload + profile.json), cost. Remove dead `bao-chau` pointers; one shared "R2 object put/delete" snippet in owner SKILL.
2. An Vặt clip pipeline → owner **an-vat-muse-cart-clip** (3 + 1 keep). Members: an-vat-muse-lot-finalize → references/finalize.md; an-vat-wan-voice-clip → references/wan-variant.md (or retire if Muse-only); channel-rules-digest-refresh and an-vat-autopilot-stall-triage stay separate (different task contracts: digest regeneration; read-only diagnosis). Lessons/L-ids go to channels/an-vat/team-lessons.md, not SKILL.md.
3. CapCut draft test → owner **capcut-draft-test-windows**. capcut-draft-test-harness → references/gac-harness.md (input-clip preconditions, ban on paid render, what bites).
4. Gác read-only status → owner **gac-daily-status-check**. gac-golden-slot-coverage-check → references/slot-coverage.md; gac-telegram-alert-triage optionally references/alerts.md; engage-status part of gac-page-engage-agent-session stays there (that one performs actions).
5. Muse accounts → owner **muse-studio-accounts** (rename of muse-studio-add-account). muse-account-login-recovery → references/recovery.md. muse-studio-app-ops stays separate (restart authority, different evidence).
6. Gateway probes (cross-cluster) → owner **gateway-tts-capability-probe** with probe-9router-models (not in this cluster; flag for owner of cluster that holds it).
7. Slot fill/coverage: gac-golden-slot-fill-fleet RETIRE; its resume pattern → gac-content-team references/resume.md.
8. Customer guide (cross-cluster): customer-guide-narrated-video vs customer-theme-guide / customize-customer-guide / theme-handover-guide — decide in Haravan cluster audit.

## (c) Rewrite candidates (top 4)

1. **furniture-reels** — 242 dense lines + prompt-template.md 548 lines (>300); owner-quote history instead of rules; wrong name; nested .git/.bak cruft; contradicts voice/Muse rules of other skills. Gap: split SKILL (flow+hard rules) from publish/briefeval references, cap files ≤300, remove history and the 'music only' claim or scope it to non-an-vat, add Done evidence.
2. **an-vat-muse-cart-clip** — becomes the single An Vặt pipeline: gates + workflow + Done, absorbing finalize/wan; strip lesson IDs and dated measurements (put in team-lessons.md); description as routing trigger, not index of lesson IDs.
3. **gac-content-team** — prune dead channel adapters (verified only 5 channels remain), split self-learning loop to references, align parallel limits (max 6) and tray/producer status with live state.
4. **gac-daily-status-check** (with coverage-check absorbed) — re-baseline for 5 live channels, drop dated anecdotes, add Done/report template, reconcile tray status with `gac-page-engage-agent-session` (tray off) and the log path with telegram-alert-triage.

## (d) Cluster-level inconsistencies

- Stale channel universe: golden-slot-* (10 Pages), gac-content-team adapters (≈11 channels), gac-page-engage (nha, bep, giay, nam), gac-daily-status (Băng Sương, Nhã Uyên), gac-channel-posting-tokens (tuong-studio) all pre-date 06/11 cut; live `channels/` = an-vat, flycam, tap-hoa, ttb, tuong-vy.
- Voice policy conflict: furniture-reels L77 ("only ttb has character voice; others music only") and gateway-tts L42 ("Ăn Vặt stays music-only") vs an-vat skills (Adam beta 1 via vclip.io) — [INFERENCE] an-vat later rules supersede.
- Tray status conflict: gac-daily-status-check §0 treats tray as the scheduler; gac-page-engage says tray off since 02/11 and OMP-session runners replaced it; log path differs (`E:/Work/.ttb-dash-data/ttbdash.log` vs `C:/Users/Admin/AppData/Local/ttb-dash/ttbdash.log`).
- Muse pool facts stale across skills: gac-workspace-state (muse-4..9), muse-account-login-recovery (ports 9336/9337), muse-studio-add-account ("4 accounts"); live DB has only muse-10 (port 9342).
- Path hygiene: ai-image-studio relative `.claude/skills/...` commands; missing referenced paths: `scratch/snack-cga/gen.py`, `_character/bao-chau/*`, `E:/Work/scratch/fade-rule/*`, `E:/Work/plans/reports/research-261113-...` (exists only under `E:/Work/Gác/plans/reports/`), `E:/Work/.flycam-yt.env`.
- Format drift: 12 skills lack "Use when" (description-trigger warn); 17 lack Done/When-not sections (standard-sections warn); descriptions mix EN with VI bodies (no missing diacritics found; an-vat-muse-lot-finalize and identity-locked-character use proper VI descriptions); volatile facts and dated owner quotes stored in SKILL.md bodies (an-vat-*, furniture-reels, gateway-tts, gac-daily-status).
- Root-rule collisions: muse-studio-app-ops L30 `taskkill ... /F` vs Level-0 "uncoordinated pkill/taskkill"; gac-workspace-state duplicates the hrv push rule (drift risk).
- Secrets: none found in text; Cloudflare account id (ai-model-character-refs:36, identity-locked:38) and FB app id (gac-channel-posting-tokens:32) are identifiers only; secret-handling guidance present and consistent.
- Cruft inside skill folder: furniture-reels has `.git`, `.pytest_cache`, `reels_lib/variety.py.bak-261113-phase0`, `…-wire`.
