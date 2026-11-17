# Work order — fixer E2 (Gác content/video/TikTok/FB part 2 (TTB, Tường, Muse, Shopee))

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-E2.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = E2). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### shopee-affiliate-media-info-edit → rename `shopee-affiliate-media-info`
- class: **OWNER**; scout cluster E2; roots: managed; SKILL.md 32 lines; desc 199 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Becomes `shopee-affiliate-media-info`; drop stdio skill ref (use antifan-stdio-mcp-driver, which exists); keep Read/Delete sections, add reference for Add flow
- scout verdict text: MERGE (owner)
- stale/verified: Same stale 9-row list; missing skill ref
- contradiction: same as above
- structure: Same LOCKED block duplicated verbatim; precondition cites missing skill `antifan-tab-drive-via-stdio-mcp` (verified absent in managed/.claude/.agents)
- overlap: shopee-affiliate-add-facebook-page
- absorbs: shopee-affiliate-add-facebook-page
### tiktok-shop-share-link-check
- class: **OWNER**; scout cluster E2; roots: managed; SKILL.md 60 lines; desc 187 chars; uses30d(sessions): 6; descQ 4/5; lang EN desc / VI body
- action: Absorb audit unique bits; add references/pdp-unavailable.md; add "Use when / not for" to description
- scout verdict text: KEEP (owner of merged `tiktok-shop-share-link-check`)
- stale/verified: Measured 13/11/2026 (volatile); no files cited
- structure: VI body w/ EN desc; no done section; one measured date (13/11)
- overlap: audit + pdp-unavailable-triage
- absorbs: tiktok-shop-pdp-unavailable-triage, tiktok-shop-share-link-audit
### vclip-adam-tts
- class: **OWNER**; scout cluster E2; roots: managed; SKILL.md 103 lines; desc 135 chars; uses30d(sessions): 4; descQ 3/5; lang EN desc
- action: Move §5 UI route and §6 measurement loop to references; absorb tts-pace-check-vclip as references/pace-check.md; description add "not for"
- scout verdict text: KEEP (owner of vclip TTS)
- stale/verified: venv `vieneu` exists; registry method only
- structure: 7.4 KB; "Measurement loop used to choose a voice" §6 is research, not procedure; contains personal account email `individual.devs2@gmail.com` (l.75, identifier) and `sk_live_` key shape only (no value); WeSpeaker pitfall prose
- overlap: tts-pace-check-vclip; gateway-tts-capability-probe/probe-9router (different vendor)
- absorbs: tts-pace-check-vclip
### shopee-reels-safe-cleanup
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 46 lines; desc 371 chars; uses30d(sessions): 9; descQ 4/5; lang EN
- action: Add owner-approval gate for permanent delete; split Recycle/restore recipes to references/recycle-bin.md; remove dead `scratch/hxr` example; mention Gác channels now only ttb/tuong-vy/an-vat/flycam/tap-hoa
- stale/verified: `E:/Work/Gác/scratch/hxr` missing (verified, l.~27); `E:/Work/shopee-reels` exists (4 folders claimed — not re-counted); dash.db and venv python exist; cites `-m ttbdash video show` (not run)
- contradiction: l.~36 gives permanent `shutil.rmtree` recipe; AGENTS §35 bans rm -rf without approval; skill says to tell user and dry-run but no explicit approval gate
- structure: desc 371 chars ok; SKILL has 4+ unrelated concerns (ledgers, Recycle, Recycle restore, R2); "NEVER/MUST" emphasis w/o reason (cruft finding); no done section besides Verify
- overlap: muse-studio-project-cleanup (video deletion)
### tiktok-studio-web-publish-antifan
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 64 lines; desc 232 chars; uses30d(sessions): 85; descQ 4/5; lang EN desc / mixed body
- action: SKILL.md ≤150 lines: account gate + upload/schedule + read-back; move "Exact AntiFan argument shapes" and "Dialogs" to references/antifan-shapes.md and references/dialogs-drafts.md; keep owner rules in one place
- scout verdict text: REWRITE (split)
- stale/verified: Handle/jar ok vs CLAUDE.md; `reels_lib.tiktokgrid` exists (verified); `an-vat` marked frozen 08/11
- contradiction: l.43 says no `workspaceRoot` field; ttb-crosspost-reel l.8 tells the opposite → contradiction
- structure: 10.6 KB in 64 lines; includes exact tool arg shapes + owner rules + dialogs; owner rules duplicate Gác/CLAUDE.md; "wrong guesses cost 25+ failed calls" anecdote
- overlap: tuong-vy-lot-prep-gates (hashtags/captions), crosspost-reel (TikTok row)
### ttb-code2d-reel
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 61 lines; desc 238 chars; uses30d(sessions): 19; descQ 3/5; lang EN
- action: Cut volatile audit list and anecdotes to references/audit-261021.md; keep layout, commands, rules, review gate; resolve or flag the open conflict to owner
- stale/verified: `E:/Work/Gác/shared/_code2d/make.py` exists; `dna/ink-*` films list not checked; two Studio refs in "Out of niche"/Open-conflict
- contradiction: "Open conflict LOG item 71" says user asked no ads in picture but 13 reels still show cards: unresolved rule left in skill
- structure: 8.4 KB; volatile facts (render timings, "21/10 audit of 13 films", per-film lists) = cruft; Hashline/rm tips duplicate global rules
- overlap: tuong-studio-code-video (cites it)
### ttb-crosspost-reel
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 36 lines; desc 222 chars; uses30d(sessions): 8; descQ 4/5; lang EN
- action: Update hashtag rule to channel.json; drop workspaceRoot claim or verify; defer platform detail to tiktok-studio-web-publish and ttb-youtube-shorts-upload
- stale/verified: Cites `workspace-resolver.ts` authorization of `E:\Work\shopee-reels` (not re-verified); references `ttbdash/rules_hard.py` (exists)
- contradiction: l.16 `#virals #cute` conflicts with channel.json:70-83 (`#mevabe #xuhuong`, CAP12); l.8 `workspaceRoot` conflicts with tiktok-studio-web-publish l.43
- structure: One 700+ byte cell line (l.14 caption paragraph truncated in my read); table-based, good
- overlap: ttb-youtube-shorts-upload (YT row), tiktok-studio-web-publish-antifan (TikTok row), ttb-publish-reel-antifan-token
### ttb-dash-tray-restart
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 21 lines; desc 136 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: Replace dead rule path with `E:/Work/AGENTS.md` §3 Negative Invariants; keep rest
- scout verdict text: REWRITE (small)
- stale/verified: `C:/Users/Admin/.omp/agent/rules/destructive-commands.md` DOES NOT EXIST (rules dir absent) at l.8; `ttbdash.log` and venv python exist
- contradiction: none; asks owner approval for taskkill (consistent with AGENTS §35)
- structure: No done section (step 5 is verify)
### ttb-muse-30s-reel
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 93 lines; desc 153 chars; uses30d(sessions): 13; descQ 3/5; lang mixed
- action: Single language (EN body w/ VI quotes); extract "Muse via gen gateway" section into one shared reference used by muse-30, shopee-video, finds-reel; delete §8 scratch driver list and "Notes"
- stale/verified: `m30.py`, `muse-job.cjs`, `lessons.md`, `wan-lofi-guitar-15s.mp4` exist; `E:/Work/.muse-lock.json` is runtime lock (absent now, expected); cast `that-*` and `v46` template not re-verified
- contradiction: l.17 "Products are Mẹ & Bé only" vs ok; Muse-gateway rule duplicated in 3 skills
- structure: 12 KB; mixes EN and VI in same sections; contains a "Notes" section with sentiments ("user liked v37"), obsolete drivers list; reviewer-brief admitted stale; stale-path-count 4 are placeholders (muse-30-vNN)
- overlap: ttb-shopee-video-product-clip (Muse via gateway, same section 3 prose), ttb-new-product-reel-brief (Muse note)
### ttb-new-product-reel-brief
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 32 lines; desc 186 chars; uses30d(sessions): 28; descQ 4/5; lang EN
- action: Fix hashtag rule; drop hard-coded account id (use config); add done-means
- scout verdict text: REWRITE (small)
- stale/verified: `reels_lib` / `reels.py` exist (furniture-reels present); `E:/Work/Gác/scratch/rembg-venv` not verified; `cf605116e4c029740af5362fe3e33c0e` Cloudflare account id on l.23 (identifier, not secret)
- contradiction: l.29 hashtags `#virals #cute` conflict with ttb channel.json
- structure: No done section; "throwaway builder script" step is hand-wavy
- overlap: furniture-reels (explicitly says to read it first), ttb-muse-30s-reel
### ttb-publish-reel-antifan-token
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 23 lines; desc 145 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Split: (1) token acquisition (merge into facebook-page-reels-setup reference), (2) delete/read-back, (3) publish; remove Studio/Finds token mentions; fix hashtags
- stale/verified: Vault names `fb_page_token_studio` (Studio Page deleted 06/11), `fb_page_token_finds`, `fb_page_token_vy` listed; Finds Page renamed Countdown Skies (CLAUDE.md:378)
- contradiction: l.19 (#virals #cute) vs channel.json
- structure: Dense 4 lines >600 chars, 6.5 KB in 23 lines (step 0, 2, 3, 6 are paragraph-size); mixes token acquisition + delete + publish + log = 3 contracts
- overlap: facebook-page-reels-setup (step 3 same OAuth dialog), tuong-studio-post-approved-cut, tuong-finds-facebook-reel-post
### tuong-vy-lot-prep-gates
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 107 lines; desc 199 chars; uses30d(sessions): 29; descQ 2/5; lang VI desc with diacritics, EN/VI mix body
- action: Split into SKILL.md (≤120: when/§0 styling/§3 constraints/§4 gate loop/done) + references/gates.md, references/kaizen-261113.md, references/vylot.md; replace §4/§5 launcher scripts with `reels_lib.vylot` commands; delete .bak; add "not for: clip from reference video → tuong-vy-reference-clip"
- stale/verified: `E:/Work/scratch/vy-shishang/prep_lot.py`, `run_wan.py`, `run_final.py` MISSING (verified; scratch dir gone, only vy-cat/len/lot2/lot3/ref-*/violation/12-guno9 remain) — §4 and §5 point to dead scripts; `reels_lib/vylot.py`, `refv2v.py` exist
- contradiction: none direct; says "gen thử 2 clip đầu" consistent
- structure: 15.8 KB; stray `SKILL.md.bak-261113-kit`; 6 lines >600 chars; desc VI but flagged (no "Use when"/not-for); §7 "Kaizen 13/11" and §8 `vylot` are separate workflows merged in; includes volatile spend numbers (574.000 đ, 48%)
- overlap: tuong-vy-reference-clip (same channel, shares recipe/hooks); wan-take-frame-audit
### tuong-vy-reference-clip
- class: **REWRITE**; scout cluster E2; roots: managed; SKILL.md 76 lines; desc 258 chars; uses30d(sessions): 10; descQ 2/5; lang VI desc
- action: SKILL.md ≤150: when/not-for, one default flow, command list, acceptance thresholds, done; move §"Bài học gốc", playbook table, yame recipe, refclip bảng nhịp into references/ (≤300 lines each); remove duplicated header; fold wan-motion-reference-takes sàng-clip filters here
- stale/verified: `E:/Work/scratch/vy-ref-kaizen-project/winning-recipe.md` exists; `reels_lib/refv2v.py` exists; `scratch/vy-ref-*` dirs exist
- contradiction: Owner quotes quoted raw in skill; says rules "chưa phải luật đã kiểm thống kê" good hedging
- structure: 25.6 KB (largest); 9 lines >600 chars; five stacked workflows (recipe, refclip bảng nhịp, lessons, product clip yame, playbook for 4 samples); duplicated sections ("Quy trình MẶC ĐỊNH" and "v2v là quy trình MẶC ĐỊNH" at l.10 and l.51); many per-clip anecdotes and numbers (n=1..4) = volatile; "Bài học gốc"
- overlap: wan-motion-reference-takes (explicitly superseded for Vy), tuong-vy-lot-prep-gates
- absorbs: wan-motion-reference-takes
### tiktok-studio-per-video-retention-read
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 34 lines; desc 190 chars; uses30d(sessions): 5; descQ 4/5; lang EN desc / VI body
- action: Add done-means (table + read time); keep separate from publish (different side effects)
- stale/verified: `tiktok-anvat` jar and handle not re-verified live
- structure: Desc EN, body VI; no done section; hard-coded handle `@tuongthichban.toptop`
- overlap: tiktok-studio-web-publish-antifan (same site, different authority: read vs write)
### ttb-shopee-video-product-clip
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 34 lines; desc 129 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Update hashtags; point to shared Muse-gateway reference
- scout verdict text: KEEP (after fixes)
- stale/verified: `shopee-cut.py` exists; `_shopee-drive`, `wan-lofi-guitar-15s.mp4` exist; scratch scripts listed as superseded
- contradiction: l.11,33 `#virals #cute` vs channel.json; uses `shopee_video` channel paused (verify)
- structure: Good size; no done-evidence formal section
- overlap: ttb-muse-30s-reel
### ttb-youtube-shorts-upload
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 57 lines; desc 164 chars; uses30d(sessions): 19; descQ 4/5; lang EN
- action: Fix hashtag line; move client id/email to config note; make this the single YouTube owner (crosspost row links here)
- scout verdict text: KEEP (after fixes)
- stale/verified: Contains OAuth Desktop client id `33846863629-...` (l.15) and email (l.12): identifiers, not secrets; mentions `GOCSPX-` pattern (l.22) only as search term
- contradiction: l.8 `#virals #cute` vs channel.json; uses Playwright MCP Chrome while AntiFan blocked (fine)
- structure: OAuth + Studio manual fixes + comment; secrets section helpful; "proven 2026-10-19" volatile
- overlap: ttb-crosspost-reel (YT row)
### vidaff-local-runtime-verify
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 37 lines; desc 250 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Add "not for production" in description; optionally merge verifies under vidaff-verify
- stale/verified: `E:/Work/VidAff` exists; ports 8787/8788 and `public/app.js` not re-probed
- contradiction: none; cleanup rule present
- structure: Has Done-means (good); desc flagged (no explicit trigger verb)
- overlap: vidaff-production-paid-loop-verify (same verify theme, local vs prod)
### vidaff-price-change
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 42 lines; desc 137 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Replace line-number cites with greps; keep prod-write approval line
- stale/verified: `E:/Work/VidAff` exists; file/line cites (`test/web.test.ts ~1230`, `eval/chat/cases.ts 160-176`) volatile approximate
- structure: Good size; 15-row INSERT recipe; prod write gated "ask user"
- overlap: none (distinct authority: prod write)
### vidaff-production-paid-loop-verify
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 31 lines; desc 149 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add explicit "needs owner OK before spending" line at top
- stale/verified: `E:/Work/VidAff` exists
- structure: Spends real money (750đ) — gate only in prose; "Proven 2026-10-26" volatile
- overlap: vidaff-local-runtime-verify
### wan-take-frame-audit
- class: **KEEP**; scout cluster E2; roots: managed; SKILL.md 34 lines; desc 238 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Add "Use when after a take downloads, before reporting" and Done-means (frame list + verdict)
- stale/verified: `ttbdash.gen.gateway.spent_today()` / `_lookbook_spent` not re-verified
- structure: Good size; desc flagged for trigger shape; no done section
- overlap: tuong-vy-lot-prep-gates (post-gen read), ttb-muse-30s-reel §5 product zoom
### muse-studio-library-file-triage
- class: **MERGE** → `muse-studio-ops`; scout cluster E2; roots: managed; SKILL.md 42 lines; desc 133 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: Move to references/library-triage.md of new `muse-studio-ops` router skill; keep description trigger (tile text + slot boards)
- scout verdict text: MERGE→muse-studio-ops
- stale/verified: `E:/Work/muse-studio/data/muse.db` and `musestudio/mediafiles.py` exist (verified)
- structure: No done-evidence section; no references; body EN, Vietnamese error strings quoted
- overlap: muse-studio-project-cleanup, muse-studio-register-external-render (same app, different contract)
### muse-studio-project-cleanup
- class: **MERGE** → `muse-studio-ops`; scout cluster E2; roots: managed; SKILL.md 37 lines; desc 200 chars; uses30d(sessions): 0; descQ 3/5; lang EN desc / VI body
- action: references/project-cleanup.md; add explicit "ask owner before Stop-Process"; rewrite description to "Use when owner asks to delete a finished Muse Studio project..."
- scout verdict text: MERGE→muse-studio-ops
- stale/verified: tools/ scripts cited are per-project (`tools/<slug>-cleanup-<yymmdd>.py`) = fragile; schtasks task name "Muse Studio (Gác)" unverified
- contradiction: uses `Stop-Process -Force` (l.20 ordering, step 1) and Recycle API: aligned with no-rm; but force-kills the app without owner approval vs AGENTS §35 `uncoordinated taskkill` → needs approval line
- structure: desc is task noun phrase, no "Use when"/not-for (std-warn description-trigger); body VI but desc EN; "thủ tục MỘT LẦN" = volatile one-shot; no done section (verification is in step 7)
- overlap: shopee-reels-safe-cleanup (video deletion, also load-bearing ledgers), muse-studio-library-file-triage
### muse-studio-register-external-render
- class: **MERGE** → `muse-studio-ops`; scout cluster E2; roots: managed; SKILL.md 58 lines; desc 287 chars; uses30d(sessions): 0; descQ 3/5; lang EN desc / VI body
- action: references/register-external.md
- scout verdict text: MERGE→muse-studio-ops
- stale/verified: `importclip.py` exists; ports 8790 not re-probed; `E:/Work/Gác/channels/channel/videos/slug` placeholder only
- contradiction: `--no-score` section cites "luật Ăn Vặt" — channel an-vat still exists (ok)
- structure: desc lacks "Use when"/not-for (std-warn); pseudo-path `channels/channel/videos/slug` in desc is a placeholder; VI body
- overlap: muse-studio-library-file-triage (shares /library verification)
### shopee-affiliate-add-facebook-page
- class: **MERGE** → `shopee-affiliate-media-info`; scout cluster E2; roots: managed; SKILL.md 33 lines; desc 167 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: Keep only the lock gate + read-only snapshot in SKILL.md; move Add-Page mechanism and 8 steps to references/add-facebook-page.md marked "ONLY after owner unlock"; update row list from CLAUDE.md
- scout verdict text: MERGE→shopee-affiliate-media-info (owner = media-info-edit)
- stale/verified: Row list (9 rows incl. Tường Studio, l.12) is stale: CLAUDE.md:265 says 10 rows, Studio row deleted. Personal profile id `100012782612630` and user id `616558905446858` in text (l.15,18,26) = PII-ish, not secret. Channel IDs cited unverified
- contradiction: contradiction with Gác/CLAUDE.md:265 (10 rows, Hàng Quốc Tài recreated and deleted)
- structure: Whole skill is "LOCKED read only" (l.10-12) yet 20 lines of write steps remain; no done section; no not-for
- overlap: shopee-affiliate-media-info-edit (same page, same lock)
### tiktok-shop-pdp-unavailable-triage
- class: **MERGE** → `tiktok-shop-share-link-check`; scout cluster E2; roots: managed; SKILL.md 30 lines; desc 214 chars; uses30d(sessions): 11; descQ 4/5; lang EN
- action: references/pdp-unavailable.md of the merged TikTok link skill
- scout verdict text: MERGE→tiktok-shop-link-triage
- stale/verified: Measured 2026-11-06, volatile but labelled
- contradiction: none; consistent with memory note
- structure: Good facts, desc is fine but flagged (no explicit "not for"); no done section
- overlap: tiktok-shop-share-link-check/audit (same TikTok URL family)
### tiktok-shop-share-link-audit
- class: **MERGE** → `tiktok-shop-share-link-check`; scout cluster E2; roots: managed; SKILL.md 49 lines; desc 166 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: Keep only unique content: step 3 (open shortlink in channel jar for title/price/sold) and the "gate before posting" rule; delete rest
- scout verdict text: MERGE→tiktok-shop-share-link-check
- stale/verified: none missing
- structure: Near-total duplicate of -check
- overlap: **tiktok-shop-share-link-check** (same steps 1-2, 4, 5)
### tts-pace-check-vclip
- class: **MERGE** → `vclip-adam-tts`; scout cluster E2; roots: managed; SKILL.md 33 lines; desc 209 chars; uses30d(sessions): 3; descQ 4/5; lang VI body / EN desc
- action: references/pace-check.md under vclip-adam-tts; drop dead corpus path or mark as lost
- scout verdict text: MERGE→vclip-adam-tts
- stale/verified: `Gác/scratch/voice-trend-261102/...` corpus MISSING (verified: `E:/Work/Gác/scratch/voice-trend-261102` not found); venv `vieneu` exists; persona-adam.md exists
- structure: desc OK; mixes methodology + measured conclusions (§4 volatile, 02/11/2026)
- overlap: **vclip-adam-tts** (JSON-RPC calls + pace table duplicated in its §4)
### wan-motion-reference-takes
- class: **MERGE** → `tuong-vy-reference-clip`; scout cluster E2; roots: managed; SKILL.md 38 lines; desc 160 chars; uses30d(sessions): 6; descQ 3/5; lang VI desc
- action: Move §1 screening and §3 thresholds into references/screening-and-accept.md; retire stub
- scout verdict text: MERGE→tuong-vy-reference-clip
- stale/verified: n/a
- contradiction: its filters ("loại nếu cảnh cắt>0, ≥2 người, ...") contradict the 16/11 owner order allowing cuts for reference mode (stated in its own banner)
- structure: Own header says superseded for Tường Vy by refv2v (l.8); remaining §1 screening + §3 thresholds duplicated in tuong-vy-reference-clip (`precheck`/`accept`); desc flagged (no trigger/not-for)
- overlap: **tuong-vy-reference-clip** (owner)
### tuong-finds-facebook-reel-post
- class: **RETIRE**; scout cluster E2; roots: managed; SKILL.md 33 lines; desc 155 chars; uses30d(sessions): 5; descQ 3/5; lang EN
- action: Delete or archive; keep generic "post via ttb-cloud Worker" only if still used by ttb (it is `ttb-cloud-job-repost`)
- stale/verified: `E:/Work/Gác/channels/tuong-finds/channel.json` MISSING (verified); `E:/Work/amazon-reels/tuong-finds/tools/finds_queue.py` MISSING (only `scratch-frames.jpg` remains in amazon-reels/tuong-finds); CLAUDE.md:378 says folder gone, Page renamed Countdown Skies
- contradiction: Contradicts CLAUDE.md:378 (channel cut, Page renamed)
- structure: 5.3 KB, two long lines
- overlap: tuong-finds-reel
### tuong-finds-reel
- class: **RETIRE**; scout cluster E2; roots: managed; SKILL.md 36 lines; desc 171 chars; uses30d(sessions): 10; descQ 3/5; lang EN
- action: Archive both; if "Countdown Skies" Page needs reels, write fresh from flycam channel rules
- stale/verified: `finds_queue.py`, channel.json missing (verified)
- contradiction: same
- structure: Same
- overlap: tuong-finds-facebook-reel-post
### tuong-studio-code-video
- class: **RETIRE**; scout cluster E2; roots: managed; SKILL.md 31 lines; desc 170 chars; uses30d(sessions): 28; descQ 3/5; lang EN
- action: Archive the 3 Studio skills together; extract any generic Remotion/loudnorm notes to ak-remotion if wanted
- stale/verified: `E:/Work/Gác/channels/tuong-studio/studio` MISSING (verified); channel folder gone; Remotion project absent
- contradiction: CLAUDE.md:112-113 Studio Page deleted; "post 30-60 min before slot" rules for dead channel
- structure: 6.4 KB
- overlap: tuong-studio-long-film-qa, tuong-studio-post-approved-cut, ttb-code2d-reel
### tuong-studio-long-film-qa
- class: **RETIRE**; scout cluster E2; roots: managed; SKILL.md 38 lines; desc 152 chars; uses30d(sessions): 12; descQ 3/5; lang EN
- action: Archive; generic glitch-scan/face-band recipe → reference of ttb-code2d-reel if reused
- stale/verified: `E:/Work/Gác/scratch/zoo-chN` (placeholders), `E:/Work/Gác/channels/tuong-studio/videos/...` missing
- contradiction: n/a
- structure: Procedure bound to `ca-nha-di-so-thu` project
- overlap: tuong-studio-*
### tuong-studio-post-approved-cut
- class: **RETIRE**; scout cluster E2; roots: managed; SKILL.md 36 lines; desc 162 chars; uses30d(sessions): 8; descQ 4/5; lang EN
- action: Archive; only YouTube leg survives (`ttb-youtube-shorts-upload`)
- stale/verified: `GOLDEN_SLOTS["tuongstudio"]` and vault `fb_page_token_studio` refer to Page deleted 06/11
- contradiction: contradicts CLAUDE.md:112-113
- structure: Dated "as of 23/10/2026"; D1/migration hand-applied notes volatile
- overlap: tuong-studio-code-video

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters

1. **Dead channels: Tường Studio + Tường Finds → RETIRE as a group.** Members: tuong-studio-code-video, tuong-studio-long-film-qa, tuong-studio-post-approved-cut, tuong-finds-reel, tuong-finds-facebook-reel-post. Evidence: folders absent (`E:/Work/Gác/channels` listing), `CLAUDE.md:378`, `:112-113`, missing `finds_queue.py`/`studio/`. No owner skill. Action: move all five to an archive (not delete) and extract two generic nuggets before archiving: loudnorm/glitch-scan recipe → ttb-code2d-reel references; Worker held-job + `review decide` flow → ttb-cloud-job-repost (neighbour skill).

2. **TikTok Shop link triage.** Owner: `tiktok-shop-share-link-check`. Members: -audit (unique: open shortlink in channel jar for product facts; gate before posting), tiktok-shop-pdp-unavailable-triage (move whole body to references/pdp-unavailable.md, trigger phrase in description). Merge mechanics: delete -audit after copying its §3 and §5; description: "Resolve/validate vt.tiktok.com share links and diagnose 'not available in your country' PDP; not for creating links".

3. **Shopee Affiliate Media Information.** Owner: `shopee-affiliate-media-info-edit` renamed `shopee-affiliate-media-info`. Member `shopee-affiliate-add-facebook-page` → references/add-facebook-page.md. Lock block lives once at top; refresh row list from CLAUDE.md:265 (10 rows, no Studio). Drop dependency on nonexistent `antifan-tab-drive-via-stdio-mcp`.

4. **Muse Studio app ops.** New router `muse-studio-ops`: members muse-studio-library-file-triage, muse-studio-project-cleanup, muse-studio-register-external-render → each becomes references/<x>.md; SKILL.md holds shared preconditions (app path `E:/Work/muse-studio`, port 8790/8793? verify, DB read-only measure first, restart rule). Keep different authority (cleanup = destructive) as explicitly gated reference. Keep `probe-9router-models` separate (not Muse Studio).

5. **vclip TTS.** Owner: `vclip-adam-tts`; absorb `tts-pace-check-vclip` as references/pace-check.md (JSON-RPC speed/pause calls already half-duplicated). Also cross-check vs `gateway-tts-capability-probe`/`probe-9router-models` (cluster outside E2).

6. **Wan v2v for Vy.** Owner: `tuong-vy-reference-clip`; absorb `wan-motion-reference-takes` §1 screening and §3 accept thresholds; wan-take-frame-audit stays separate (post-gen audit, different trigger). `tuong-vy-lot-prep-gates` stays separate (lookbook-without-reference) but must link both ways ("reference video → tuong-vy-reference-clip").

7. **TTB posting.** `ttb-crosspost-reel` (router for Threads/IG/TikTok/Zalo/Shopee Video) should link to `ttb-youtube-shorts-upload` (YT) and `tiktok-studio-web-publish-antifan` (TikTok) instead of re-stating them; `ttb-publish-reel-antifan-token` token-acquisition part should merge into `facebook-page-reels-setup` (other cluster) as reference.

8. **Muse gateway rule repeated.** Same paragraph ("Muse is driven only by the gen gateway: ttbdash.gen.muse + muse-job.cjs, lock .muse-lock.json, control.json key muse") appears in ttb-muse-30s-reel §3, ttb-shopee-video-product-clip §Muse takes 1, tuong-finds-reel step 4, ttb-new-product-reel-brief §4. Extract once into a shared reference (e.g. under ttb-muse-30s-reel/references/muse-gateway.md) and link.

9. **VidAff.** Optional merge of vidaff-local-runtime-verify + vidaff-production-paid-loop-verify into `vidaff-verify` (local vs prod as two references). Keep vidaff-price-change separate (production DB write authority).

## (c) Rewrite candidates (top 4)

1. **tuong-vy-reference-clip** — 25.6 KB / 9 long lines, duplicated "default v2v" header, five workflows in one file; no references. Split per §(a); target SKILL.md ≤150 lines.
2. **tuong-vy-lot-prep-gates** — dead launcher scripts (`scratch/vy-shishang/*`), bak file, two independent workflows (§7 kaizen, §8 vylot) plus stale volatile numbers; description lacks not-for neighbour.
3. **ttb-publish-reel-antifan-token** — three contracts (token, delete/read-back, publish) in 23 dense lines; contradicts current hashtags; mentions tokens of deleted/renamed Pages.
4. **ttb-muse-30s-reel** — 12 KB, mixed languages, obsolete driver list and sentiment notes, repeats shared Muse-gateway section; same hashtag/gate drift risk. (Runner-up: tiktok-studio-web-publish-antifan, 10.6 KB, needs references split.)

## (d) Cluster-level inconsistencies

- **Hashtags:** five TTB skills (crosspost l.16, publish-token l.19, shopee-video-clip l.11/33, youtube-shorts l.8, new-product-brief l.29) still say `#virals #cute`; current rule is `#mevabe #xuhuong` (`channels/ttb/channel.json:70-83`) and CAP12 refuses international tags (CLAUDE.md:173).
- **Channel inventory:** skills still describe Tường Studio and Tường Finds as live; actual kept channels are ttb, tuong-vy, an-vat, flycam (+ tap-hoa dir) (CLAUDE.md:378).
- **Shopee row list:** both Shopee Media skills list 9 rows including Tường Studio and a "locked" state; CLAUDE.md:265 says 10 rows, Studio removed.
- **`workspaceRoot`:** ttb-crosspost-reel l.8 claims it as upload argument; tiktok-studio-web-publish l.43 says no such field exists.
- **Dead references:** `~/.omp/agent/rules/destructive-commands.md` (ttb-dash-tray-restart l.8, dir absent), `antifan-tab-drive-via-stdio-mcp` (shopee-media-info-edit), `E:/Work/scratch/vy-shishang/*` (lot-prep §4-5), `E:/Work/Gác/scratch/voice-trend-261102/...` (tts-pace-check), `E:/Work/Gác/scratch/hxr` (safe-cleanup), `finds_queue.py`, `studio/`.
- **Language:** English descriptions over Vietnamese bodies (muse cleanup, TikTok check/retention, ttb-muse-30s); pick one body language per skill.
- **Destructive operations without approval gates:** muse-studio-project-cleanup (`Stop-Process -Force`), shopee-reels-safe-cleanup (permanent rmtree). AGENTS §35 requires explicit approval.
- **Missing done-means:** almost every skill (only vidaff-local-runtime-verify has a "Done means").
- **Cruft:** volatile measured facts and per-run anecdotes in ttb-code2d-reel, tuong-vy-*, ttb-muse-30s-reel (dates 21/10, 12-16/11).
- **Size:** 3 skills > 10 KB with no references: tuong-vy-reference-clip (25.6 KB), tuong-vy-lot-prep-gates (15.8 KB), ttb-muse-30s-reel (12 KB), tiktok-studio-web-publish-antifan (10.6 KB).
