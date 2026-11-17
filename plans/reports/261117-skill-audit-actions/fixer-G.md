# Work order — fixer G (muagi / Facebook group / ttb-cloud)

Generated from the audit `plans/reports/261117-skill-audit.md` (read its section 4 first: canonical root, rules R1-R12, name lock, gates). Detailed scout notes: `plans/reports/261117-skill-audit-detail/result-G.md`.

Rules that apply to every row below (summary of R1-R12):
- Work only inside the skills you own (rows with fixer = G). Cross-cluster merge rows are performed by the fixer that owns the TARGET; the source cluster does nothing to them.
- "Delete"/"remove skill" in a scout action means RETIRE: move the dir to `C:/Users/Admin/.omp/agent/skills/_retired/<name>/` (installed copy) and `git rm` it from the skills repo; add a row to `MIGRATION.md` (old → new/where). Never `rm -rf`.
- Never run the installer; the orchestrator installs once per wave after the gates are green.
- Description <=250 chars: owned action first, "Use when …", "Not for …". Body: Boundary / Workflow / Done when. SKILL.md <=150 lines target (hard 300), references one level deep <=300 lines. Dated facts, line-number citations, one-off incident logs: remove or move to `references/field-notes.md` with a date.
- Shared facts live once: hrv gate → AGENTS.md §8 (cite, do not restate); Cloudflare env/ids/VPS → `E:/Work/docs/naming-cloudflare.md`; Leader report contract → antifan-leader reference. Remove the copies.
- Before removing/renaming any skill name: `rg -n "skill://<old>|<old>" ` across the repo, `E:/Work/AGENTS.md`, `C:/Users/Admin/.omp/agent` memory/rules and other skills; fix references.
- Verify each edited skill: `python ak-skill-creator/scripts/quick_validate.py <dir>`, `lint_cruft.py --routing`, relative links resolve, dir name == frontmatter name.
- Reply/notes Vietnamese; skill bodies stay in their current language unless the action says otherwise; descriptions: English trigger sentence + Vietnamese trigger phrases in `when_to_use`.

Legend: class OWNER = absorbs other skills; MERGE→x = fold into x then retire; REWRITE; KEEP (with small fixes); RETIRE.

## Rows

### facebook-page-rebrand-antifan
- class: **OWNER**; scout cluster G; roots: managed; SKILL.md 32 lines; desc 159 chars; uses30d(sessions): 6; descQ 4/5; lang EN
- action: add `references/gac-engage-lock.md` (from avatar-cover), add "check engage status/identity.json + muagi STOP first" to Safety; drop worked-example ids to one line
- scout verdict text: KEEP as owner (absorb 2)
- stale/verified: worked-example ids only (volatile); pixel coords x655,y153 / 745,825 L19,L22 fragile
- contradiction: uses raw `actorID` HTML check + persist:profile-profile-2; never takes engage `identity.lock`/mark that the Gác muagi loop and avatar-cover skill rely on -> can flip actor under a running muagi loop
- structure: frontmatter name+description only; has Safety/Steps/Gotchas but no done-evidence section; job-specific preamble (Bảo Châu Beauty ids) in L6
- overlap: fb-page-avatar-cover-antifan (same task, other identity mechanism); facebook-page-reels-setup (name/bio/avatar table)
- absorbs: fb-page-avatar-cover-antifan
### fb-metrics-audit-ttb-dash
- class: **OWNER**; scout cluster G; roots: managed; SKILL.md 66 lines; desc 185 chars; uses30d(sessions): 2; descQ 4/5; lang VI body
- action: absorb page-liveness into `references/page-liveness.md`; fix venv note in both; add not-for (does not post)
- scout verdict text: KEEP as owner
- stale/verified: `C:/Users/Admin/.claude/skills/.venv/Scripts/python.exe` exists; collect_fb.py, vault.py exist; tests/test_data_v2.py not checked
- contradiction: claims system python dies at `import pywintypes` -> must use venv; gac-fb-page-live-audit §1 runs plain python importing ttbdash.vault (same dependency) -> would crash
- structure: VI body, EN-ish desc OK; no done section
- overlap: gac-fb-page-live-audit (same Graph/vault token audit)
- absorbs: gac-fb-page-live-audit
### rutgonlinkpro-vanity-link-audit
- class: **OWNER**; scout cluster G; roots: managed; SKILL.md 32 lines; desc 214 chars; uses30d(sessions): 3; descQ 4/5; lang EN
- action: rename `rutgonlinkpro-link-audit`; keep audit read-only, gate repair (write) under explicit "Repair" section requiring owner ask; absorb tiktok source audit; fix truncated sentence
- scout verdict text: KEEP as owner
- stale/verified: no local paths
- structure: desc EN long ok; "NEVER repeatedly GET" emphasis flagged; line 3 (§3) truncated mid-word "authori…" in file itself
- overlap: rutgonlinkpro-tiktok-tool-link-audit
- absorbs: rutgonlinkpro-tiktok-tool-link-audit
### ttb-cloud-job-repost
- class: **OWNER**; scout cluster G; roots: managed; SKILL.md 43 lines; desc 173 chars; uses30d(sessions): 1; descQ 5/5; lang EN
- action: add D1 reference; verify `autoslot` module path; keep
- scout verdict text: KEEP as owner
- stale/verified: cron `*/5`, MAX_ATTEMPTS=6, LATE_LIMIT_MS=6h verified (jobs.ts:42-43, wrangler.jsonc L12); `python -m ttbdash cloud push` / `autoslot sign` exist (cloud.py, autoslot not located by `ls ttbdash` regex: autoslot not matched -> unverified)
- structure: good trigger/not-for-ish; threat-language flagged ("Never recreate a job with the HMAC route...", "Never run wrangler login") but reasons given
- overlap: d1-and-tab-recovery
- absorbs: ttb-cloud-d1-and-antifan-tab-recovery
### facebook-page-reels-setup
- class: **REWRITE**; scout cluster G; roots: claude; SKILL.md 79 lines; desc 363 chars; uses30d(sessions): 37; descQ 4/5; lang VI body / EN desc mix
- action: keep only "Meta app + Page token" (rename `meta-app-page-token-setup`); move Trang settings table to rebrand owner references; move affiliate link/comment/pin section to furniture-reels or ttb-crosspost-reel; move to managed-skills
- scout verdict text: SPLIT+REWRITE
- stale/verified: dated tests 17/10/2026 L~40-50; hard-coded app 1083408444321293; `furniture-reels approve/publish` referenced (skill exists in catalog)
- contradiction: says "không lách bằng base64/DataTransfer" for uploads; fb-group-affiliate-post-antifan prescribes exactly base64 chunk + DataTransfer; vidaff says E:/Work/VidAff is an authorized root
- structure: only in ~/.claude/skills (not managed) => root inconsistency; 3 unrelated jobs in one file (page settings, Meta app/token, affiliate link + pin comment); desc mixes VI triggers in EN
- overlap: name/bio/avatar rows duplicate rebrand skill; affiliate-link + comment section overlaps furniture-reels / ttb-crosspost-reel (other cluster)
### facebook-profile-post-antifan
- class: **REWRITE**; scout cluster G; roots: managed; SKILL.md 47 lines; desc 179 chars; uses30d(sessions): 0; descQ 2/5; lang VI w/o diacritics
- action: rewrite description: "Đăng/hẹn giờ/xóa bài trên profile cá nhân Facebook qua fb-poster (AntiFan tab, không xuất cookie). Dùng khi ... Không dùng cho Page (dùng Graph/Page token) hay né checkpoint"; move doc_id/protocol to references/protocol.md; drop date of incident
- scout verdict text: REWRITE (small)
- stale/verified: `E:/Work/fb-poster` + cli.py verified; "33 test" = 33 `def test_` (verified); incident 16-17/11/2026 volatile (L12); doc_id=29002746079345841 volatile
- contradiction: none (consistent with no-cookie rule)
- structure: description has NO diacritics ("Dang/hen gio/xoa bai ... CA NHAN") and half-EN; ok Khi nào dùng/boundary; test cmd present
- absorbs: antifan-facebook-page-post
### gac-page-group-share-run
- class: **REWRITE**; scout cluster G; roots: managed; SKILL.md 47 lines; desc 169 chars; uses30d(sessions): 2; descQ 3/5; lang VI
- action: resolve whitelist rule (see (b)), remove line numbers (cite symbols), move dated rules to a "Owner rules" block with date, add done evidence (ledger count)
- scout verdict text: REWRITE + become owner
- stale/verified: cites `muagi.py:472` mutate (actual L479), `:985` new_group (L1013), `:1258` (unverified); `REFUSED_LEADER_INVESTIGATE` not found under apps/AntiFan/scripts (unverified, may live in hooks elsewhere)
- contradiction: contradicts overnight-share-loop on whitelist; "Chủ cấm sửa caption (15/11/2026)" is dated owner rule presented as invariant
- structure: desc VI; Bất biến good; mixes worker + whitelist + hook
- overlap: gac-overnight-share-loop
- absorbs: gac-overnight-share-loop
### muagi-group-poster-ops → rename `muagi-ops`
- class: **REWRITE**; scout cluster G; roots: managed; SKILL.md 77 lines; desc 252 chars; uses30d(sessions): 2; descQ 3/5; lang VI
- action: rename; strip dated numbers/line cites into one dated "Snapshot 14/11" block in references; keep reuse-cap / env-load / rejected-bốc-nhóm / restart-via-Python as core
- scout verdict text: REWRITE + become owner `muagi-ops`
- stale/verified: cites `muagi.py:1953` put, `:2354` rejection_streak (actual def at L2424; put defs at L1638,1676,1992,2062,2157) stale; defaults LINK_DAY_MAX=2 ok but supervisor ENV sets 5 (L71); numbers "10 sản phẩm, 28 nhóm" dated 14/11; launch_supervisor.py path exists
- contradiction: step 3 "(+ mô tả nguyên văn)" vs no-description rule; step 6 PowerShell Start-Process with -WorkingDirectory vs later "PowerShell breaks Gác path, use Python"
- structure: heavy; desc 252 VI; sections ok but 80% volatile numbers
- overlap: all muagi-*
- absorbs: fb-group-broadcaster-muagi, gac-muagi-loop-ops, gac-muagi-overnight-ops, muagi-detached-24-7-ops, muagi-facebook-group-broadcaster
### vy-tiktok-file-to-fanpage-swap
- class: **REWRITE**; scout cluster G; roots: managed; SKILL.md 36 lines; desc 249 chars; uses30d(sessions): 5; descQ 3/5; lang VI/EN mix
- action: move scripts out of scratch to repo (ttb-dash/scripts or Gác/tools) and cite stable path; reference job-repost for D1 step instead of repeating the SQL
- scout verdict text: REWRITE (promote scripts)
- stale/verified: `scratch/ultra-csi2-261111/vyfb_push4.py`/`vyfb_xplat3.py` exist but are scratch one-offs = fragile; `fb_page_token_vy` exists in vault (verified)
- structure: desc 249 mixed; owner rule dated 11/11/2026
- overlap: ttb-cloud-job-repost (retire/re-push mechanics)
### facebook-reel-caption-extract-antifan
- class: **KEEP**; scout cluster G; roots: managed; SKILL.md 59 lines; desc 154 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: desc: "Tải MP4 reel Facebook (yt-dlp ẩn danh) và caption Page nguyên văn từ JSON nhúng, chỉ đọc. Dùng khi job cần file/caption của reel. Không dùng để phân tích đối thủ (fb-reel-competitor-analysis) hay đăng bài"
- scout verdict text: KEEP + fix desc
- stale/verified: `antifan-agent.cjs` path used; `ttbdash.engage_run.open_tab()` note OK (function verified); no scripts listed
- structure: desc 154 chars EN, no "use when", no not-for; body opens with "Use when" (L8) instead; long body but <300
- overlap: none direct (fb-reel-competitor-analysis in other cluster)
### fb-group-affiliate-post-antifan
- class: **KEEP**; scout cluster G; roots: managed; SKILL.md 47 lines; desc 207 chars; uses30d(sessions): 5; descQ 4/5; lang EN
- action: replace NEVER with reason; add "if a muagi loop for the same Page runs, STOP it / use identity lock first"; state that file_upload under authorized root is preferred (cross-ref) and base64 is fallback
- stale/verified: no paths to check; claim "Groups API removed 2024-04-22" is external
- contradiction: base64+DataTransfer upload vs facebook-page-reels-setup ban (see above); "never post near-identical text twice" consistent with muagi gate
- structure: no done-evidence section but has Verify; "NEVER click first ..." emphasis flagged cruft L~33
- overlap: muagi-* (automated version of same group posting; different cadence/authority)
### gac-fb-unschedule-scheduled-reel
- class: **KEEP**; scout cluster G; roots: managed; SKILL.md 40 lines; desc 167 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: add source of that rule or delete; link to gac-fb-page-live-audit for token read
- stale/verified: `produce jobs`, `sourcing.title_ok` not verified; dated proof 01-02/11
- contradiction: refers to a "Check once, then post" rule with no source
- structure: good outcome/proof sections; desc EN OK
### muagi-group-broadcaster-ops
- class: **KEEP**; scout cluster G; roots: managed; SKILL.md 59 lines; desc 146 chars; uses30d(sessions): 3; descQ 3/5; lang §5 includes the description; the later rule (TEXT_MAX, no description, verified in muagi.py L6 "KHÔNG mô tả") forbids it; §3 kill contradicts overnight-ops §2 ("không taskkill /F ngay sau STOP; kill ngang để lại 4 hậu quả")
- action: RETIRE (superseded)|delete after salvaging only the NTFS-ADS `write file.py:200-260` pitfall into muagi-ops gotchas
- scout verdict text: VI
- stale/verified: restart §3 uses kill-without-/F and no STOP; content rule §5 "mô tả nguyên văn" + "cắt phần sau
- contradiction: all muagi-*
- structure: desc 146 VI; stale path-count 1 = `file.py:200-260` ADS example (fine, intentionally an anti-example)
- overlap: " + title<=200 predate the 14/11 rule
### muagi-telegram-inbox-ops
- class: **KEEP**; scout cluster G; roots: managed; SKILL.md 59 lines; desc 160 chars; uses30d(sessions): 2; descQ 4/5; lang EN
- action: cross-link to muagi-ops for TTB_MUAGI_* env; fix page-id conflict
- scout verdict text: KEEP (separate: runs a bot, different side effect)
- stale/verified: inbox.py exists; tests dir not verified; taphoa link-share.txt exists; Page id 61595720408813
- contradiction: Tạp hóa id 61595720408813 is also given as the "VidAff Page id" in vidaff-fb-promo-round-antifan (two different pages share one id or one is wrong)
- structure: good invariants, tests, verify table; EN desc
- overlap: muagi-ops (env isolation)
### vidaff-fb-promo-round-antifan
- class: **KEEP**; scout cluster G; roots: managed; SKILL.md 48 lines; desc 208 chars; uses30d(sessions): 0; descQ 4/5; lang EN
- action: confirm Page id; add pre-step: check engage status/identity.json and that no muagi loop owns the browser identity
- stale/verified: VidAff/plans/reports/comment-hooks-261027.md exists; uses `persist:profile-profile-2` shared
- contradiction: Page id 61595720408813 here = "Tạp hóa A-Z" in muagi skills; no mention of engage identity.lock / muagi STOP while switching actor (shared partition)
- structure: desc clear; steps good; owner rules dated (27/10/2026) with pointer to live doc
- overlap: fb-group-affiliate-post-antifan (comment mechanics)
### antifan-facebook-page-post
- class: **MERGE** → `facebook-profile-post-antifan`; scout cluster C; roots: managed; SKILL.md 36 lines; desc 182 chars; uses30d(sessions): 2; descQ 3/5; lang EN with VI UI labels
- action: [target to confirm by fixer G: the Facebook Page video-post owner; candidates facebook-profile-post-antifan references or ttb-publish-reel-antifan-token] Not an AntiFan-app skill; move to Facebook cluster and rename e.g. `facebook-page-video-post-antifan`; keep as reference of the Facebook owner.
- scout verdict text: MERGE→(Facebook/Gác cluster owner)
- stale/verified: `E:/Work/VidAff` exists; `workspace-roots.json` exists; FB UI labels volatile
- structure: no not-for; VidAff-specific example; fine size
- overlap: facebook-page-reels-setup, fb-group-affiliate-post-antifan, ttb-publish-reel-antifan-token, facebook-profile-post-antifan
### fb-group-broadcaster-muagi
- class: **MERGE** → `muagi-ops`; scout cluster G; roots: managed; SKILL.md 48 lines; desc 157 chars; uses30d(sessions): 2; descQ 3/5; lang EN
- action: its "Verify (never trust worker report)" and failure-mode list go to muagi-ops SKILL.md; retire the file
- scout verdict text: MERGE->muagi-ops
- stale/verified: engine/store paths exist; test cmd exists; text rule (title <=200) predates TEXT_MAX
- contradiction: "title <=200 chars" and no TEXT_MAX; says `STOP` stops in 2 min without store caveat (overnight-ops: only the store's own STOP)
- structure: desc no not-for/trigger phrases; fully overlaps 4 siblings
- overlap: muagi-facebook-group-broadcaster, muagi-group-broadcaster-ops, muagi-group-poster-ops, gac-muagi-loop-ops (all same engine)
### fb-page-avatar-cover-antifan
- class: **MERGE** → `facebook-page-rebrand-antifan`; scout cluster G; roots: managed; SKILL.md 30 lines; desc 152 chars; uses30d(sessions): 1; descQ 4/5; lang EN
- action: move Steps 1-8 to rebrand `references/gac-engage-lock.md`; keep image-gen prereqs in `references/avatar-cover-assets.md`
- scout verdict text: MERGE->facebook-page-rebrand-antifan
- stale/verified: engage.{acting_page,set_acting,clear_acting,identity_lock}, engage_run.{open_tab,page_info,switch_to,switch_home,is_admin,acting_as} verified; `gen-images.mjs` path exists; `shared/_character/.../_upload_r2.py` not checked
- contradiction: rebrand says never leave actor as Page / read actorID; this one uses engage lock - two incompatible identity protocols for the same outcome
- structure: no done section
- overlap: facebook-page-rebrand-antifan (same job, different mechanism)
### gac-fb-page-live-audit
- class: **MERGE** → `fb-metrics-audit-ttb-dash`; scout cluster G; roots: managed; SKILL.md 75 lines; desc 146 chars; uses30d(sessions): 0; descQ 4/5; lang VI
- action: move to `references/page-liveness.md`; correct §4 (taphoa has Graph token since 15/11/2026); drop line-range citation
- scout verdict text: MERGE->fb-metrics-audit-ttb-dash
- stale/verified: `E:/Work/ttb-dash/ttbdash/vault.py#13-33` stale: KNOWN dict now extends beyond L33 (many tokens: taphoa, hakura, nachira, ...); `vault.stored()` and `cloud._call` not re-verified
- contradiction: plain-python vs venv (above); says Page of muagi "không có credential Graph" but vault now has fb_page_token_taphoa/fb_page_id_taphoa (vault.py) -> §4 outdated
- structure: desc fine; ok sections; sec-scan step good
- overlap: fb-metrics-audit-ttb-dash
### gac-muagi-loop-ops
- class: **MERGE** → `muagi-ops`; scout cluster G; roots: managed; SKILL.md 50 lines; desc 152 chars; uses30d(sessions): 6; descQ 3/5; lang EN
- action: Kaizen checklist + breaker section -> muagi-ops `references/breaker-and-kaizen.md`
- scout verdict text: MERGE->muagi-ops
- stale/verified: watch.py exists; test/loop.pid layout OK
- contradiction: restart: "STOP -> rm STOP + loop.pid" without the STOP-content-must-avoid-UNTIL_MARKERS caveat (poster-ops) and without hard-until; says breaker handling similar to poster-ops/broadcaster-ops (3 variants)
- structure: desc EN, other muagi skills VI; hard-codes Vy PAGE dict; no done-evidence
- overlap: all muagi-*
### gac-muagi-overnight-ops
- class: **MERGE** → `muagi-ops`; scout cluster G; roots: managed; SKILL.md 100 lines; desc 209 chars; uses30d(sessions): 2; descQ 3/5; lang VI
- action: split into muagi-ops sections: STOP semantics (SKILL.md), content rules, preview, anti-bot (`references/content-and-antibot.md`), supervisor (`references/supervisor-24-7.md`)
- scout verdict text: MERGE->muagi-ops (source of truth for STOP semantics)
- stale/verified: `scratch/muagi/supervise_taphoa.py` exists; "145 OK" tests vs tests/test_muagi.py now has 190 `def test_` (volatile); env defaults TEXT_MAX 150 / POST_GAP 300-420 / JOIN 10-20 match muagi.py L283,304,240; chủ's values (110, 180/240) match supervisor ENV L50-53
- contradiction: §9 `--until` "min(23:59, now+5h)" omits the hard-until cap (supervise_taphoa.py L172-191, L349-355)
- structure: desc VI long; body covers 6 distinct contracts (STOP, recovery, diagnosis, content rules, link preview, anti-bot, 24/7 supervisor) in 100 lines; no done section except §10
- overlap: muagi-detached-24-7-ops (STOP + supervisor + Telegram dup), poster-ops, broadcaster
### gac-overnight-share-loop
- class: **MERGE** → `gac-page-group-share-run`; scout cluster G; roots: managed; SKILL.md 58 lines; desc 188 chars; uses30d(sessions): 3; descQ 3/5; lang VI
- action: move Gate1/STATE.md/watch/counting to `references/orchestrator.md`; delete line-number cites
- scout verdict text: MERGE->gac-page-group-share-run
- stale/verified: STATE.md convention `scratch/<job>/`; cites `muagi.py:1017` due_groups, `:1124` usable_groups (actual L1063, L1183: stale line numbers)
- contradiction: whitelist: "write separate file, NOT state.json" vs gac-page-group-share-run "whitelist = state=white via mutate"; direct contradiction
- structure: desc VI; orchestration procedure + counting rules + cleanup; no explicit not-for
- overlap: gac-page-group-share-run (same job; one is orchestrator view, other worker view)
### muagi-detached-24-7-ops
- class: **MERGE** → `muagi-ops`; scout cluster G; roots: managed; SKILL.md 32 lines; desc 191 chars; uses30d(sessions): 0; descQ 3/5; lang VI
- action: go to `references/supervisor-24-7.md`, add "check hard-until.txt first" (see (d))
- scout verdict text: MERGE->muagi-ops
- stale/verified: supervise_taphoa.py, watchdog_taphoa.py exist; STOP semantics duplicated verbatim from overnight-ops; says "Không bao giờ xoá STOP" (watchdog) but overnight/poster restart procedures delete STOP
- contradiction: does not mention hard-until.txt: supervisor on start with elapsed hard-until writes its own STOP and exits (L349-355); hard-until.txt = 2026-11-16T12:55+07:00 is already in the past today
- structure: short, good; no done other than final check
- overlap: overnight-ops §0/§2/§9, poster-ops restart section
### muagi-facebook-group-broadcaster
- class: **MERGE** → `muagi-ops`; scout cluster G; roots: managed; SKILL.md 56 lines; desc 253 chars; uses30d(sessions): 2; descQ 3/5; lang VI
- action: its "Luật nội dung" + "Lỗi đã gặp" become muagi-ops `references/content-and-antibot.md`
- scout verdict text: MERGE->muagi-ops (best source for content rules)
- stale/verified: "120 test ở bản 14/11" stale (190 `def test_` now); TEXT_MAX 60..600 matches muagi.py L305
- contradiction: consistent with overnight-ops on no-description rule; contradicts broadcaster-ops/poster-ops step 3 (description verbatim)
- structure: desc 253 VI ok-ish, no not-for
- overlap: all muagi-*
### rutgonlinkpro-tiktok-tool-link-audit
- class: **MERGE** → `rutgonlinkpro-vanity-link-audit`; scout cluster G; roots: managed; SKILL.md 24 lines; desc 176 chars; uses30d(sessions): 4; descQ 3/5; lang VI
- action: becomes `references/tiktok-source-audit.md` (read-only); drop uid list to a dated note
- scout verdict text: MERGE->rutgonlinkpro-vanity-link-audit
- stale/verified: hard-coded uid list incl. "Băng Sương đã nghỉ 01/11/2026" volatile L~25
- contradiction: none (both say no live GET)
- structure: desc VI; no diacritic issue; short, ok
- overlap: rutgonlinkpro-vanity-link-audit (same dashboard, same no-click-pollution rules)
### ttb-cloud-d1-and-antifan-tab-recovery
- class: **MERGE** → `ttb-cloud-job-repost`; scout cluster G; roots: managed; SKILL.md 31 lines; desc 101 chars; uses30d(sessions): 5; descQ 2/5; lang VI/EN mix
- action: D1 gotchas (`job` not `jobs`, run_at ms, GROUP BY readback) -> job-repost `references/d1-queries.md`; tab recreate -> add as a section in antifan-mcp-tab-health-check (other cluster) or `references/tab-recovery.md`
- scout verdict text: MERGE->ttb-cloud-job-repost (D1 part) + RETIRE tab part to antifan-mcp-tab-health-check
- stale/verified: `E:/Work/ttb-dash/cloud` + `ttb-cloud` D1 + `job` table verified via wrangler.jsonc/jobs.ts; `project-02c7791a-...` truncated id
- structure: desc 101 chars no trigger/not-for; two unrelated jobs; stray CJK char "传" in §2 step 2 ("KHÔNG传 `cookieJar`") ; no done section
- overlap: ttb-cloud-job-repost (D1 SQL), antifan-mcp-tab-health-check (tab recovery)

## Context from the scout (overlap clusters, rewrite candidates, inconsistencies)

## (b) Overlap clusters
1. **muagi engine ops** -> owner `muagi-ops` (renamed from muagi-group-poster-ops). Members: fb-group-broadcaster-muagi, muagi-facebook-group-broadcaster, muagi-group-broadcaster-ops, muagi-group-poster-ops, gac-muagi-loop-ops, gac-muagi-overnight-ops, muagi-detached-24-7-ops (7 skills, same engine/repo/store/authority, ~420 lines total with ~60% repeated: STOP semantics x3, no-Scheduled-Task x4, PROJECT_MISMATCH x4, autocomplete-space x4, rejected!=removed x4, content rule x6).
   - SKILL.md (<=150 lines): activation + not-for (does not edit muagi.py; Telegram bot -> muagi-telegram-inbox-ops; sharing Reels -> gac-page-group-share-run), definition of done (loop.log line `-> posted`, status, 3 recent posts readback), pre-flight (identity, hard-until/STOP check, orphan check), STOP semantics table (from overnight-ops §0-3), restart/stop procedure (overnight-ops §2-3 is authoritative).
   - references/content-and-antibot.md: content rule (title+link, TEXT_MAX, LINK_FIRST), preview card, 100% Cursor, speeds (from muagi-facebook-group-broadcaster + overnight-ops §5-8).
   - references/pacing-and-caps.md: gaps, join floor, LINK_DAY_MAX/reuse gap/3h text gate, rejected->bốc nhóm, rejection streak (poster-ops).
   - references/supervisor-24-7.md: Start-Process/watchdog/Telegram notify/hard-until (detached-24-7 + overnight-ops §9 + poster-ops "Dựng lại supervisor").
   - references/breaker-and-kaizen.md: breaker reset (loop-ops + broadcaster-ops §4), kaizen checklist, backup-before-edit. Taphoa vs Vy env table (single place for TEXT_MAX 110, gap 180/240, LINK_DAY_MAX).
   - RETIRE muagi-group-broadcaster-ops after salvaging NTFS-ADS note.
2. **Share Reels into groups** -> owner `gac-page-group-share-run`; gac-overnight-share-loop contributes orchestrator procedure -> `references/orchestrator.md`. Must reconcile whitelist (see (d)).
3. **Page profile edit** -> owner `facebook-page-rebrand-antifan`; fb-page-avatar-cover-antifan -> `references/gac-engage-lock.md`; Page settings table of facebook-page-reels-setup -> `references/page-settings.md`; facebook-page-reels-setup shrinks to Meta app + Page token.
4. **FB Graph read-only audits** -> owner `fb-metrics-audit-ttb-dash`; gac-fb-page-live-audit -> `references/page-liveness.md`.
5. **rutgonlinkpro** -> owner `rutgonlinkpro-link-audit` (renamed vanity); tiktok-tool-link-audit -> `references/tiktok-source-audit.md` (read-only). Keep repair behind an explicit write gate.
6. **ttb-cloud D1/queue** -> owner `ttb-cloud-job-repost`; d1-and-tab-recovery D1 part -> `references/d1-queries.md`; tab-recovery -> antifan-mcp-tab-health-check (outside cluster).
7. Keep apart (different authority/side effect): muagi-telegram-inbox-ops (bot), facebook-profile-post-antifan (personal profile), fb-group-affiliate-post-antifan (manual group posts), gac-fb-unschedule-scheduled-reel (destructive-adjacent Business Suite), vidaff-fb-promo-round-antifan, facebook-reel-caption-extract-antifan, vy-tiktok-file-to-fanpage-swap.

## (c) Rewrite candidates
1. **muagi-ops (from muagi-group-poster-ops)**: biggest quality win. Gap: seven overlapping, partly contradictory skills; line-number citations stale (1953/2354/472/985/1017/1124 vs real 1638..2157/2424/479/1013/1063/1183), test counts stale (120/145 vs 190), no hard-until documentation, volatile dated numbers in the body.
2. **gac-page-group-share-run (+ overnight-share-loop)**: gap: whitelist contradiction, dated owner rules as invariants, unverified Leader hook name, no done evidence.
3. **facebook-page-rebrand-antifan (+ avatar-cover, + reels-setup Page settings)**: gap: two incompatible identity protocols (raw actorID/profile-2 vs engage.identity_lock+mark), pixel-coordinate steps, worked-example ids.
4. **facebook-profile-post-antifan**: gap: description without diacritics and with no clear route; protocol facts (doc_id, incident date) inline.

## (d) Cluster-level inconsistencies
- **hard-until.txt / STOP (muagi taphoa)**: no skill in the cluster (or in managed-skills at all, rg returned 0) mentions `taphoa/hard-until.txt`. Verified in supervise_taphoa.py: L172 HARD_UNTIL_FILE; L189-191 caps `--until` to hard-until; L349-355 when now >= hard-until it writes bare `STOP` ("chủ: kết thúc ca 15/11/2026 HH:MM" - date hard-coded 15/11 even if hard-until is 16/11), logs "dừng giám sát" and exits. Current taphoa/hard-until.txt = 2026-11-16T12:55:00+07:00 (past today 17/11) => starting the supervisor now writes STOP and exits; STOP text lacks UNTIL_MARKERS ("kết thúc ca" != "hết ca"), so it counts as a human STOP and blocks permanently (overnight-ops §9). Skills teach "STOP = human, until-markers = auto" but not that hard-until generates a human-looking STOP; poster-ops L-restart says STOP content must avoid UNTIL_MARKERS yet the supervisor itself writes a non-matching text. Also backup files taphoa/hard-until.bak-*.txt and many `STOP.*` renamed files show manual state juggling that no skill documents. Fix: muagi-ops pre-flight "read hard-until.txt; if past, edit it (owner decision) before starting; STOP written by hard-until is not an owner stop".
- **Restart procedure variants**: broadcaster-ops (kill pid, no STOP), loop-ops (STOP then rm STOP+pid), overnight-ops (STOP, wait <=2min, verify no process, composer wipe, rm pid; never taskkill /F quickly), detached-24-7 ("never delete STOP" in watchdog), poster-ops (STOP text must avoid UNTIL_MARKERS). Only overnight-ops+poster-ops together are correct.
- **Content rule**: no-description (14/11) in facebook-group-broadcaster, overnight-ops, muagi.py header (L6) vs description-verbatim in broadcaster-ops §5 and poster-ops step 3; title cap 200 (fb-group-broadcaster-muagi, broadcaster-ops) vs TEXT_MAX 110/150.
- **Whitelist**: overnight-share-loop forbids touching muagi state.json (due_groups/usable_groups ignore keywords -> muagi would post Shopee links into off-topic groups) vs share-run mandates `state="white"` via mutate.
- **Identity protocol**: rebrand (raw actorID + persist:profile-profile-2), vidaff (cookie i_user), avatar-cover/share-run/live-audit (engage identity.lock + mark + `engage status`). Only the engage family protects a running muagi loop; rebrand and vidaff can flip the actor under it.
- **Page id 61595720408813** is "Tạp hóa A-Z" (muagi-group-poster-ops, muagi-telegram-inbox-ops) and "VidAff Page" (vidaff-fb-promo-round-antifan) - needs one owner decision; vault.py says fb_page_id_taphoa is a different real Graph id than profile.php?id=61595720408813, so one of the two skills likely mixes up profile id vs Graph id.
- **Upload rule**: facebook-page-reels-setup forbids base64/DataTransfer workaround; fb-group-affiliate-post-antifan relies on it.
- **Python runtime**: fb-metrics-audit says only the .claude/skills/.venv python (pywin32) works with `ttbdash.vault`; gac-fb-page-live-audit runs it with bare python.
- **Vault vs "no Graph credential"**: gac-fb-page-live-audit §4 says muagi pages have no Graph token; vault.py now holds fb_page_token_taphoa / fb_page_id_taphoa (15/11/2026).
- **Language/format**: descriptions mix EN and VI (muagi family: 4 VI, 3 EN); facebook-profile-post lacks diacritics; 15 of 25 lack not-for in description (cluster std-warn `description-trigger` count 13); none of the 25 uses references/ even where body is 80-100 lines; facebook-page-reels-setup alone sits in ~/.claude/skills.
- **Volatile facts embedded as truth**: test counts (120, 145 vs 190 `def test_`), muagi.py line numbers, dated measurements (14/11 pool numbers, 17/10 token tests), owner rules with dates, fb-poster incident dates; `scratch/` scripts as runbook tools (vy-tiktok-file-to-fanpage-swap, poster-ops launch_supervisor, overnight `scratch/muagi/*`).
