# Audit 4 phiên theme Haravan (2026-10-15/16) — điểm cần cập nhật

Nguồn: Sky Fashion `01a14044` (đã có 1 vòng audit + fix), Smart Furniture `01a13e72`, PC `01a13f7b`, Ăn Vặt `01a13f5f`.
Báo cáo chi tiết (đọc theo field): thư mục `local/` của phiên audit `01a14511`:
`an-furniture.md` (FUR-01..30), `an-pc.md` (PC-01..29), `an-anvat.md` (AV-01..30), `sky-delta.md`, `antifan-map.md`, `skills-map.md`.
Đánh dấu: **[V]** = kiểm lại trực tiếp trong lượt này (file:line/lệnh), còn lại do analyzer báo kèm evidence.

## 0. Số liệu

| Phiên | Tool call (main) | Tool error | `qa_validate` | CERTIFIED | Model |
|---|---|---|---|---|---|
| Sky | 2058 | 70 | nhiều | 0 | opus-5-5 suốt |
| Furniture | 2250 (+6695 sub) | 63 (236 tổng) | 21 | 0 | opus → **sonnet `role:temporary` 08:20Z** [V] |
| PC | 1236 | 45 | 45 | 0 | opus → **sonnet 12:19:15Z** [V] |
| Ăn Vặt | 2337 | 92 | 54 | 0 (`STRUCTURAL` 3 lần cuối) | opus → **sonnet 12:19:22Z** [V] |

## 1. Nguyên nhân gốc xuyên suốt

1. **QA PASS không có nghĩa là xong/đẹp.** Main: `theme.qa_validate` mặc định `audit` (`browser-capabilities.ts:1786`) [V]. Hook (cả main và WT) xoá gate qua `reconcileReceipts` khi `QA_PASSED|PASS` hoặc receipt legacy `verdict === undefined && passed !== false` (WT `theme-qa-gate.ts:1113-1116` → `clearPending` `:1154`) [V]; không xét `execution`, root, `certification`. `isCompletePassReceipt` (`:921`) chỉ dùng cho debt (`:953`). 120 lần chạy trên 3 phiên mới, 0 CERTIFIED.
2. **Bản sửa AntiFan nằm trong worktree chưa merge** (`AntiFan-toolchain-wt`, nhánh `toolchain/qa-truthfulness`, 32 file chưa commit) [V]. Worktree có blocker: default `build-strict` (`browser-capabilities.ts:302`) [V] + không có thresholds mặc định → evidence gap (`theme-qa-workflow.ts:2151-2152`) [V] → INCONCLUSIVE → `qa-debt.json` không bao giờ clear (`theme-qa-gate.ts:921-925`) [V]; proxy không inject thresholds (`antifan-omp-mcp.cjs:25-26`) [V].
3. **Cockpit Hub không được dùng**: `theme.cockpit_*` = 0 call ở cả 3 phiên mới; checklist 78–80 mục toàn tick tay, chỉ 1 mục có `action` [V]. Agent tự viết 135–258 `anti.browser.evaluate` + bộ Playwright riêng (4181 dòng ở Furniture).
4. **Không có cổng thiết kế/reference trước khi build** → PC rebuild 3 lần ("quá AI"), Furniture đổi hướng luxury sau khi Stitch + build xong, Ăn Vặt "vẫn xấu quá".
5. **Dữ liệu demo thiếu là nguồn lỗi "theme"**: ảnh theo màu (58/58 sp thiếu), menu 3 cấp phẳng, 23 link 404, MST giả, store sheet trống.
6. **Subagent không đọc skill miền** (Furniture: `haravan-theme` 0, `theme-qa-az` 0, `antifan-qa-cockpit` 0) → mẫu menu sai, không QA theo slice.
7. **Phần rebuild chạy trên sonnet**: PC (12:19:15Z) và Ăn Vặt (12:19:22Z) có `model_change role:temporary` ngay sau một `user` entry, không có lỗi trước đó, `resolvedModelIsFallback:false` [V] → nhiều khả năng user tự chọn model tạm (tiết kiệm quota Opus), không phải lỗi harness. Đòn bẩy chất lượng: giữ Opus cho pha design/rebuild.

## 2. AntiFan / Cockpit Hub MCP

### P0
| # | Việc | Evidence |
|---|---|---|
| A1 | Merge worktree theo từng file (main đã có `recovery:'anti.browser.rebind_target'` mà WT thiếu) sau khi: nạp default thresholds từ kit `registry/thresholds.json` ở tool boundary hoặc proxy; test "bare call trên fixture sạch → QA_PASSED"; sửa CRLF smoke (`smoke-theme-golden-live.cjs:527`); A/B theo test, không theo file | sky-delta §3, §5 M1–M9 |
| A2 | Hook: build-from-scratch phải đòi `certification: CERTIFIED` (hoặc in rõ STRUCTURAL trong reminder); proxy/cockpit_scan advertise `viewports` để CERTIFIED đạt được qua MCP | antifan-map X3; `cockpit-capabilities.ts:609` [V] |
| A3 | Ăn Vặt: 4 receipt trong `An Vat/` (chỉ có `.antifan`, `specs`), mọi receipt ghi `workspaceRoot` = `…/An Vat` [V] → tab/project bị bind vào thư mục ASCII, không phải lỗi fold của `confineWorkspaceRoot`. Fix: warn/refuse ghi receipt khi bound root không có marker theme (`layout/theme.liquid`, `config/settings_schema.json`/`settings.html`) và khi default root rỗng; gợi ý thư mục anh em cùng tên có dấu | AV-03/04 |
| A4 | Giữ emulation viewport qua `navigate/reload`; receipt ghi `viewportRequested` vs `observed`, mismatch → INCONCLUSIVE (9/45 run "1440" thực 949px) | PC-03 |
| A5 | Tab binding: tool status trả tab storefront của project theo URL, tự bind khi chỉ 1 ứng viên; ổn định tabId qua reattach; không mất project window (AV-02 outage 82 phút) | FUR-07, AV-02 |

### P1 — tool mới cho các lớp lỗi user phải tự bắt
| Tool/rule | Bắt lỗi | Gắn checklist |
|---|---|---|
| `anti.qa.variant_image_probe` | click swatch không đổi ảnh, màu thiếu `featured_image` | pdp-01, pdp-04, sys-04, qag-34 |
| `anti.qa.pdp_contract` | thiếu nút size-guide khi có option size, thiếu ATC/buy-now/SKU/breadcrumb | pdp-11 (mới) |
| `anti.qa.menu_depth` | menu 3 cấp/megamenu không render so với linklist | hom-01, hom-09 |
| `anti.qa.page_structure` + rule `home-structure` | home > 10 section, thứ tự phi logic, trang 375 cao 25k px | hom-02..08, QAG-20 |
| rule `min-gap` + promote `sibling-gap`/`edge-control` lên fail ở build-strict | "dính nhau" (hiện là warning, không ảnh hưởng verdict `theme-qa-workflow.ts:1799-1802`) | QAG-25 |
| rule `title-scale`, `input-height-band` (+ merge `control-height-band`, `font-below-min` từ WT) | size lộn xộn trên mobile | qag-29 |
| rule `modal-unstyled` trong `state_matrix` + `autoPopulate:'pdp'`; chạy state_matrix trong build-strict | modal font serif/UA button, SweetAlert, quickview chưa style | QAG-23 |
| option `viewports:[{w,h}]` cho `responsive_matrix`/`batch_matrix` (667×375, 1366×600, 375×350) + rule `fixed-chrome-ratio` | "màn nhỏ bị tràn chiều cao" | qag-36 |
| `image-frame-scanner` (crop ≤ 0.08, natural ≥ 1.5× box) | ảnh lệch khung 20–55% | — |
| `anti.qa.pick_product{max-variants|long-title|sold-out|no-image}` | cockpit_scan chỉ lấy link `/products/` đầu tiên (`cockpit-capabilities.ts:545-560`) | X7 |
| Auto-tick checklist: `theme.cockpit_scan` ghi `done`+`note` khi tool tương ứng PASS | checklist hiện 100% tay | X1 |

### P2
- `anti.screenshot.full_page` tự ghép tile > 16384 px và stream thay vì `ARTIFACT_TOO_LARGE` 8 MiB (AV-01, FUR-13); `CAPTURE_FRAME_STARVATION` gợi ý `tabs.activate` + retry (6/6 thành công) thay vì restart app (PC).
- `anti.agent.cursor.hover` dispatch mouse event thật (`HOVER_NOT_ACTIVE`, FUR-10).
- `await_cdn_sync` cho `.liquid` (agent tự poll curl ≥ 10 lần, 38 cell ≈ 12 phút ở PC).
- `theme.package_check` cho Partners export (zip dry-run, residue/brand, secrets, form diff giá/ghi chú) — AV-08 đổi giá gợi ý 0→2.4M→2.2M không ai yêu cầu.
- Direct-Edit gate: thay "storefront QA skipped" bằng tự chạy `qa_validate` trên Page URL annotation khi edit không phải micro-CSS (FUR-15).
- Backlog sửa trạng thái: LIVE-10/11 chưa làm dù ghi "implemented"; U-AF-02/03/05, LIVE-7 mới một phần (sky-delta §4).

## 3. Kit / workflow (RESTYLE_MASTER_KIT, HaravanDemoKit, master prompt)

| # | Việc | Evidence |
|---|---|---|
| K1 | **Phase 0 Design Gate**: chạy `ui-ux-pro-max` + capture 2–3 reference (`anti.reference.capture`, `page_inventory`) → `deliverables/reference/*.json` → token đầy đủ (type scale, spacing scale, radius, control height, icon stroke, card density) → user duyệt 1 lần trước Stitch/build | PC-05/07, FUR-21, skills-map gap 8-9 |
| K2 | Ngân sách home: `HOME_SECTION_ORDER` 12 mục (`new-theme-master-prompt.md:37`) [V] → 6–10, có rule `HOME_SECTION_BUDGET` trong `remake_contract_audit.js` + verify DOM order | FUR-01 |
| K3 | Demo data bắt buộc trước theme QA: variant images (recolor có duyệt chi phí 1 lần) → `--attach` → `readiness --live` phải clear `variant-without-image-id`, `empty-size-guide-page`, `swatch-name-unresolved`, menu depth qua `/api/navigations/{id}`; link 404/page/blog handle; không dữ liệu giả (MST, social) | FUR-03/04, PC-11, U-DK-01/02 |
| K4 | `gate:pre-showcase` (readiness --live + qa_gate CERTIFIED + residue/claim scan + 0 ảnh hỏng + hash freshness) chạy trước `final-showcase`/Partners | AV-10, FUR-24, gap 23 |
| K5 | Syntax gate sau mỗi edit asset: `node --check` cho `.js.liquid` (render Liquid stub), Sass compile check (AV-07: 2 lần JS vỡ lên live dev theme) | AV-07 |
| K6 | "Overnight envelope": khi user ghi "không dừng", tự ký STOP 3 chỉ cho bước local (home `approved-final`, ZIP export local, showcase capture); envelope **không bao giờ** gồm Partners Create/Update, `haravan`/`hrv` CLI, theme push, ghi `settings_data.json` (AGENTS.md §8). Báo cáo liệt kê "đã chạy / chưa chạy" từng lệnh trong prompt (19/23 báo cáo Furniture hỏi lại STOP 3) | FUR-05/06 |
| K7 | Per-slice gate: subagent slice phải trả đường dẫn receipt `.antifan/qa-receipts/…`; brief template có "Skills phải đọc" theo slice | FUR-09/22 |
| K8 | Spend ledger ảnh: `usage.jsonl`, trần số ảnh, allowlist model vision (Furniture tự đổi sang `qwen3.6-flash` sau 403) | FUR-18/19/20 |
| K9 | `settings_data.json` write protocol: CLI 1-key cho `settings_merge.js`; cấm script ad-hoc nạp từ backup; diff key-count trước/sau là gate | PC-01 |
| K10 | f1genz legacy `settings.html`: guard có `--settings-mode legacy` (Ăn Vặt `settings_schema.json` = 4 byte, `settings.html` 128 KB) [V] | AV-06 |

## 4. Skills

| Skill | Cập nhật |
|---|---|
| `haravan-demo-kit` | Ẩn khỏi catalog vì `disable-model-invocation: true` ở `SKILL.md:5` (cả 3 bản) [V] → bỏ dòng hoặc sửa `haravan/SKILL.md:32,46,167` thành `read skill://haravan-demo-kit`. Thêm step 7b variant-images, megamenu generator (13 script console viết tay), industry seed fashion/furniture/spa/watch/wine, bỏ hard-code `sky_filter_colors` → `colourSettingId`, lệnh `comments` |
| `haravan-stitch-full-run` | K1, K2, K6, K7; sửa mẫu menu `implementation-phase-guide.md:111`, `post-restyle-qa-checklist.md:15` (hiện chỉ dạy `link.links`) [V] thành lookup kép như `haravan-theme` bên dưới — trong `themes/f1genz/Haravan/**/*.liquid`: 0 file dùng `link.links`, 9 file dùng `linklists[link.handle]` [V]; bỏ `ai-artist`/Gemini ở `implementation-phase-guide.md:276-277`, `one-command-workflow.md:38`, `support-skill-routing.md:16`, `workspace-and-environment.md:50`; thống nhất câu "cấm GEMINI/BFL" với việc Phase 3 cần `AIBOX_API_KEY` |
| `ai-image-studio` | `gen-images.mjs`: exit ≠ 0 khi thiếu ảnh, timeout cấu hình (180 s cứng), không log signed URL, `--jobs` (ảnh độc lập, không chỉ hero+variant — PC/Ăn Vặt phải tự viết script), `--style-ref`, `--concurrency`, contact sheet + OCR gate, scene sets wine/spa/watch/banner 1792×1024/blog cover, colour-name map |
| `haravan-theme` | `liquid-cheatsheet.md:316` dạy lookup kép: `link.links`, nếu blank thì `linklists[link.handle].links`, ở cả cấp 2 và 3 (mẫu đang chạy ở `S2 Smart Furniture/snippets/megamenu.liquid:10-19`, `mobile-menu.liquid:24-48`) [V]; thêm `references/home-section-patterns.md` |
| `haravan-settings-schema` | Bắt buộc đọc ở mọi task f1genz (PC/Ăn Vặt: 0 lần đọc); quy tắc id dùng qua `'<id>'`/`setting-id` coi là đã dùng (prune suýt xoá logo/favicon); thêm `theme.settings_check`; `--max-colors 2` vào Completion Gate |
| `theme-qa-az` | Pass 5 visual rubric (gọi `ak-enhance-ux-ax` + `anti.visual_compare` với reference); nhóm L "Mobile density" + thresholds mới; dùng `theme.settings_check`, `compare_candidates`, `state_matrix`, `visual_quality` |
| `antifan-qa-cockpit` | Chỉ có ở `managed-skills` (ngoài sync kit) → đưa vào mirror; bỏ claim "generated capability table" hoặc thêm script; thêm chuỗi tool chuẩn cho build-strict + thresholds |
| `final-showcase` | Step 0 = `gate:pre-showcase`; freshness hash; sanitize đường dẫn có dấu (AV-23) |
| `haravan-partners-theme-submit` | Ship `scripts/partners-form.js` thay `window.__pf` dán tay; pre/post form diff (giá, notes có dấu, đúng theme id); route "new version" |
| `haravan-demo-live-seed`, `haravan-demo-data-audit` | Lỗi thời so với kit 10-16; gộp vào `haravan-demo-kit` hoặc cập nhật; ship `contact-sheet.mjs` |
| `ak-test`, `ak-enhance-ux-ax` | Với theme Haravan: closing evidence = AntiFan receipt + cockpit scan + state_matrix/visual_quality, không chỉ Playwright/axe; `@smoke` < 5 phút, heartbeat; rubric "anti-AI-look/retail" (radius, ≤ 2 font, icon cùng stroke); sửa tên `ak:*` không load được |
| `ui-ux-pro-max` | Thiếu vertical e-commerce VN (điện máy, thời trang, nội thất, đồ ăn vặt): "electronics laptop" trả "Vibrant & Block-based"/landing page (PC-06) |
| Nguồn thật | OMP load theme skills từ `C:/Users/Admin/.claude/skills` (không phải `E:/Work/themes/.claude/skills`); `skills_sync.js:6` coi `~/.claude` canonical → ghi rõ trong `themes/CLAUDE.md` + kit README; mở rộng `PIPELINE_SKILLS` |

## 5. Rules

| File | Cập nhật |
|---|---|
| `E:/Work/AGENTS.md` §1.B.4 | Chỉ cho `VERIFIED_COMPLETE`/`BLOCKED`, global CLAUDE.md cho `DONE_WITH_CONCERNS` → thống nhất từ vựng yield (PC-09: 4 advisor block) |
| `E:/Work/AGENTS.md` §8 + `themes/CLAUDE.md` | Quyền `settings_data.json` cấp trong prompt khởi tạo: phạm vi + thời hạn rõ; vẫn bắt buộc protocol K9 (PC-02: 6 blocker tranh cãi) |
| `themes/CLAUDE.md` F1GENZ | Ngoại lệ theme legacy `settings.html` đã được user chấp nhận (AV-06) |
| `themes/CLAUDE.md` | Haravan menu: cấp con dùng `linklists[link.handle].links` |
| `~/.omp/agent/rules/destructive-commands.md` | Chỉ match lệnh thực thi, miễn `rm` trong `E:/Work/scratch/**` (3 lần ngắt vì chữ trong thinking) |

## 6. OMP harness / config

| # | Việc | Evidence |
|---|---|---|
| H1 | (Không phải lỗi) switch opus→sonnet `role:temporary` là thao tác user; chỉ ghi chú chất lượng ở §1.7 | model_change JSONL [V] |
| H2 | `modelRoles.task/vision/...` = `google-antigravity/gemini-4-argon-high` đang 429 quota (reset ~118h) → mọi subagent fallback `claude-sonnet-5-5` | `config.yml:3-8,112-113` [V]; subagent JSONL 429 [V] |
| H3 | `designer` agent (`model: "@DESIGN"` → `google-antigravity/gemini-3.1-flash-image`) fail "No model selected" | probe 2.7 s [V] |

## 7. Test sinh ảnh bằng đúng model hiện tại (claude-opus-5-5)

| Đường | Kết quả | Dùng được cho pipeline? |
|---|---|---|
| Native (không tool) | Model không xuất raster | Không |
| Native SVG → sharp PNG | `E:/Work/scratch/gen-test-261016/native/shirt.png` 1024×1024, 119 KB [V]; flat illustration | Chỉ icon/placeholder/pattern, không ảnh sản phẩm |
| Canva MCP `generate_image` | SUCCESS, MEDIA `MAHYLkKaMZc` [V]; không có file local | Không (remote-only, không export media) |
| `designer` agent | "No model selected" [V] | Không |
| AIBOX `ai-image-studio` (qwen-image-3.0-pro) | Đã chạy được 10-16 (gen-test.md) | **Có** — đường thật duy nhất |
| `ak-ai-multimodal` (Multix) | Thiếu `GEMINI/OPENROUTER/MINIMAX_API_KEY` [V]; `OPENAI_API_KEY` = AIBOX key, không base URL → 401 | Không |

Kết luận: bỏ `ak-ai-multimodal` khỏi theme pipeline không mất chức năng; nhưng **không** có nghĩa model hiện tại tự sinh ảnh — sinh ảnh vẫn qua AIBOX. Còn 62 file (~/.claude) + 38 file (OMP skills) trỏ tới tên `ak:ai-multimodal`/`ai-artist` cần dọn (skills-map §3.2).

## 8. Dữ liệu `settings_data.json` PC

- Hiện 647 key; backup `backups/before-rebuild-20261015.tgz` có 4433 key; 3992 key bị bỏ, **0 key** trong số đó là id của `config/settings_schema.json` hiện tại (631 id) [V] → key theme cũ bị dọn khi rebuild, không mất dữ liệu merchant đang dùng. Đây là lỗi quy trình (script ad-hoc `.antifan/gen/apply_settings.py`, báo cáo T5 "không bị sửa" sai, không qua `settings_merge.js`), mức high; user đã cấp "full quyền … settings_data.json" nên PC-02 là lỗi câu chữ rule, không phải sửa trái phép.
