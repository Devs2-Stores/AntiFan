---
title: Haravan settings — chuyển rule lặp lại thành gate máy chặn được
date: 2026-10-05T23:04
status: accepted
mode: ak:brainstorm --advice
scope: read-only điều tra + bounded delivery contract (không implement)
trigger: "Phân tích sâu báo cáo OMP × AntiFan Cockpit × Theme MCP" → "Tập trung 100% Haravan trước, giải quyết dứt điểm vấn đề settings"
decisions:
  theme_mcp_layer: không dựng Theme MCP riêng; thêm 1 capability `theme.settings_check` (file-scan, không cần tab) vào namespace theme.* hiện có
  upload_contract: "<input type=file name=X> chỉ được đọc bằng 'X' | asset_url — không settings['X'], không existence-gate, không default/fallback, không toggle riêng cho ảnh; chấp nhận ảnh vỡ khi chưa upload"
  shop_identity: org_id/theme_id từ `.haravan-cli_local.json` (hrv CLI); fallback khai trong `.workspace-context.json`
  direct_edit_modes: "[⚡Direct-Edit]/[🚀Super-Fast] không chặn — chỉ in 1 dòng đếm finding ở turn_end"
  preview_upload: haravan-upload-file (Haravan Files/hstatic) là mặc định; Catbox là fallback
  preview_approvals: giữ hai bước duyệt riêng (upload, sửa settings.html)
  legacy_debt: Phukienmaymoc 13 + Seahorse2 49 read sửa ở pass riêng sau P0
  cockpit: "nối nhẹ, không chặn tick — qag-04 theo nền tảng (legacy→settings.html, F1GENZ→schema) trỏ sang theme.settings_check; theme.cockpit_findings/report kèm tóm tắt settings check mới nhất; tick tự do giữ nguyên (plan 261002). Không sync Cockpit↔OMP Todo (extension API không đọc/ghi todo)"
advisory: kongming checkpoint (31.5s) — Conditional Go; đã áp dụng: cắt rule asset_url-không-control khỏi P0 (chỉ report), ratchet thay vì gate toàn cục, nâng shop guard lên P0
handoff: ak:plan --advice, rồi /ak:cook
---

# Brainstorm — Haravan settings enforcement

## Summary

Báo cáo gốc đúng hướng (OMP = suy luận, AntiFan = authority/trạng thái thật) nhưng đề xuất xây mới phần lớn thứ repo đã có,
và gán `settings.html` cho Sapo (sai: `settings.html` là legacy Haravan; Sapo dùng `.bwt` + `settings_schema.json`).
Vấn đề thật: các rule settings user đã nhắc nhiều lần **không được máy kiểm**, và checker hiện tại còn **dạy ngược** rule upload.

## Bằng chứng (đã kiểm chứng)

### Lỗi lặp lại — từ transcript OMP
| Lớp lỗi | Nguồn |
|---|---|
| `settings['X.png']` thay `'X.png' \| asset_url` (URL, existence gate, resolver snippet) | Seahorse2 `01a0ebd8-392d` (5 lần user sửa, gallery 1/5 ảnh); Comnieusiba `01a0f6dc-e60f` (`siba-clone-image`, 86 call site, user ra luật global); Comnieusiba `01a0f0b4-1ca4` (issue #229) |
| Router: legacy `settings.html` → `haravan-theme`; agent nạp `haravan-settings-schema` (F1GENZ) cho theme legacy | `~/.agents/skills/haravan/SKILL.md:40,149`; Levents `01a101cf-63a4` |
| `\| default:` che control đã bị xóa | Comnieusiba `01a0e559-5334` (`siba_order_option_all`) |
| Ghi dữ liệu shop khác vào `settings_data.json` | Levents `01a0d450-ae1c` (collection của `com-nieu-siba` vào Levents) |
| Setting có nhưng không có tác dụng ở web | S2 Spa `01a101b1-018e` (wishlist sai class card, màu hardcode `theme.css`) |
| Header nhóm lệch / rỗng | Levents `01a101cf-63a4` (26 nhãn lệch, 9 header rỗng) |

### Repo (HEAD tại thời điểm brainstorm)
- `scripts/lib/theme-checks.mjs:83-87,93` coi `settings['logo.png']` là spelling hợp lệ; `test/theme-checks.test.mjs:14` + fixture `test/fixtures/theme-checks/theme-haravan-upload/snippets/hero.liquid:1` pin PASS.
- `scripts/lib/theme-checks.mjs:457-466` đưa key của `settings_data.json` vào `knownSettings` → `HARAVAN_SETTING_UNRESOLVED` (dòng 614) bỏ qua mọi key chỉ có giá trị mà không có control.
- `grep theme-checks src/` → 0 kết quả: MCP không gọi checker settings.
- `theme.qa_validate` (`src/main/tools/browser-capabilities.ts:1595`), `theme.debug_bundle` (:1862), `theme.cockpit_scan` (`src/main/tools/cockpit-capabilities.ts:276`) đều `requiresBrowserTarget: true`.
- `src/omp-hooks/theme-qa-gate.ts`: im lặng ở Direct-Edit/Super-Fast (:38-40); thoát bằng tự khai `QA_UNAVAILABLE`/`QA_INCONCLUSIVE` (:133); TTL 10 phút (:137). Receipt đến từ browser QA, không chứa settings scan.
- `file.write` ràng buộc projectId/workspaceId (`src/main/tools/file-capabilities.ts:15-23`), không theo shop. `theme.transaction.begin` nhận `storeDomain`/`targetTabId` do caller khai (`theme-transaction-capabilities.ts:77-84`); không thấy so với origin tab.
- Agent ghi `settings_data.json` bằng `write`/`edit` native của OMP — không qua `file.write`/`write_cas`. Hook `tool_call` có thể block (`src/omp-hooks/edit-guard.ts:360-373`). `bash`/`eval` vẫn ghi được file.
- Workspace không lưu domain shop; `.haravan-cli_local.json` có `org_id`, `theme_id`, `theme_name` (Levents, Phukienmaymoc). `~/.haravan-cli.json` chỉ chứa token theo org_id.
- Quét 38 theme legacy: literal `settings['*.img']` chỉ có ở Phukienmaymoc (13, 10 gated; `snippets/footer.liquid:15`, `snippets/header.liquid:17-18`, `layout/theme.liquid:12`) và Seahorse2 (49, 3 gated). Đây là prevalence, chưa phải bằng chứng không false-positive (read động `settings[var]` chưa phân loại). Quét `E:/Work/themes/*` bị timeout, chưa đủ.
- Hai bản `haravan-settings/SKILL.md` (`~/.claude/skills`, `~/.agents/skills`) giống hệt (sha256 `b062db06…`); chưa có rule upload `asset_url`; rule 4 (toggle cho section/item tùy chọn) dễ bị hiểu là mâu thuẫn với quyết định "ảnh không toggle".
- `haravan-preview-screenshot` đánh số badge theo fieldset của `settings.html` (`SKILL.md:14,193`); upload Catbox với 2 approval riêng; ưu tiên Puppeteer/Playwright (mâu thuẫn AGENTS.md §3.1 — AntiFan MCP trước).

## Hợp đồng

**Outcome:** agent sửa sai rule settings Haravan thì máy tự báo/chặn với `file:line` + hướng sửa; dữ liệu shop khác không vào được `settings_data.json` qua các đường ghi do tool kiểm soát.

**Constraints:**
- Dùng lại `scripts/lib/theme-checks.mjs`, `theme-qa-gate`, `theme.transaction.write_cas`; không parser thứ hai.
- Không fork OMP. Giữ AGENTS.md §3.1 (AntiFan MCP trước, Playwright fallback).
- Không chặn đọc trên tab khác shop (workflow so ref/baseline cần đọc chéo origin).
- Direct-Edit/Super-Fast: không chặn.
- `settings_data.json` vẫn read-only mặc định, chỉ sửa khi user duyệt (skill `haravan-settings`).

**Non-goals:** Theme MCP riêng, `sapo_theme`, `theme.render`, recipe engine, Chrome DevTools MCP gắn tab AntiFan, sửa nợ theme trong P0, Sapo/Shopify.

### Phases
| Phase | Nội dung |
|---|---|
| P0-A | Shop identity = `org_id` từ `.haravan-cli_local.json` (fallback `.workspace-context.json`). Ghi `settings_data.json` phải khai tab nguồn; tab nguồn phải cùng shop. Ngoài Direct-Edit/Super-Fast: hook chặn `write`/`edit` native vào `config/settings_data.json` → đi qua `write_cas`. Direct-Edit/Super-Fast: không chặn, in 1 dòng cảnh báo kèm `org_id`/`theme_id` của workspace (user chốt 2026-10-05). Khe hở `bash`/`eval` ghi rõ trong guarantee. Probe trước: storefront Haravan có lộ org_id không; nếu không, map domain↔org_id một lần. |
| P0-B | `theme-checks.mjs`: rule mới `HARAVAN_SETTINGS_UPLOAD_READ` neo theo tên `<input type="file">` có thật (literal + biến capture từ template có tham số); bỏ `settings_data.json` khỏi `knownSettings`; duplicate name (trừ radio); viết lại test/fixture upload; giữ bracket-read extraction cho UNRESOLVED/dead. Expose qua `theme.settings_check` (không cần tab). |
| P0-C | Router: legacy `settings.html` → `haravan-settings`; `haravan-theme` chỉ Liquid/template. Thêm rule upload `asset_url` vào `haravan-settings`; làm rõ rule 4 (toggle cho section/item, không cho ảnh). Đồng bộ hai bản skill. |
| P0-D | Ratchet: chạy checker trên base tree và working tree, so **multiset** finding theo khóa `(rule, id, file)` — đếm số lần xuất hiện, bỏ `line`. Finding mới = phần đếm tăng (`count_working − count_base > 0`) → FAIL (chặn qua receipt/gate); phần còn lại → `DEBT_WARNING`. Lý do: `theme-checks.mjs:612-621` emit 1 finding cho mỗi lần đọc, không dedup; so tập phẳng sẽ coi lần đọc sai thứ hai cùng key cùng file là nợ cũ. Direct-Edit/Super-Fast: 1 dòng đếm ở turn_end, không chặn. |
| P1 | `settings.X \| default:` ở code mới; header lệch/rỗng; parity theme lai; báo cáo (không chặn) `'X.png' \| asset_url` không có upload control; preview `col-sm-5` có `<img>` không phải placeholder; sinh khung `sections` cho screenshot từ fieldset + đếm badge = số fieldset con; chụp qua AntiFan MCP; upload Haravan Files (`haravan-upload-file`), Catbox fallback; giữ 2 approval. Cockpit: `qag-04` (`src/shared/theme-checklist.ts:164`) đổi mô tả theo nền tảng và trỏ `theme.settings_check`; `theme.cockpit_findings`/`theme.cockpit_report` kèm tóm tắt settings check mới nhất của workspace (số finding mới / nợ cũ); không chặn tick. |
| P1' | Dọn nợ: Phukienmaymoc 13, Seahorse2 49 (pass riêng). |
| P2 | Admin save → mở lại admin → storefront đúng revision. |

**Acceptance criteria:**
1. Phukienmaymoc: FAIL `UPLOAD_READ` tại `snippets/footer.liquid:15`, `snippets/header.liquid:17-18`, `layout/theme.liquid:12`.
2. Seahorse2: bắt được mẫu `capture …-img-N.jpg` → `settings[var]`.
3. Chạy trên toàn bộ theme legacy local; review tay mọi FAIL `UPLOAD_READ` → 0 false positive trước khi bật chặn.
4. 10 tên trùng ở Giaohangnang được review tay là lỗi thật trước khi bật rule duplicate.
5. Test: xóa control trong `settings.html` khi Liquid vẫn đọc → finding mới → FAIL (ratchet theo multiset finding, không theo dòng).
5b. Test: file đã có 1 lần đọc `UPLOAD_READ` cùng key; edit thêm lần đọc thứ 2 cùng key cùng file → đúng 1 finding mới → FAIL. Chỉ chèn dòng phía trên (line dịch chuyển, số lần đọc không đổi) → 0 finding mới.
6. Levents: các key Liquid đọc mà chỉ có trong `settings_data.json` (không có control) báo UNRESOLVED.
7. Ngoài Direct-Edit/Super-Fast: `write`/`edit` native vào `config/settings_data.json` bị chặn. Direct-Edit/Super-Fast: ghi được, có đúng 1 dòng cảnh báo kèm `org_id`/`theme_id`. `write_cas` với tab nguồn khác org_id bị chặn; đọc tab ref khác shop vẫn chạy.
8. Nợ cũ không chặn turn không liên quan; Direct-Edit/Super-Fast chỉ in dòng đếm.
9. (P1) Screenshot sinh từ `settings.html` có đúng N badge cho N fieldset con.
10. (P1) Cockpit: `qag-04` trên theme legacy nói `settings.html`, trên F1GENZ nói `settings_schema.json`; `theme.cockpit_report` hiện số finding mới/nợ cũ của settings check gần nhất; tick `qag-04` khi còn finding vẫn được (không chặn).

## Trade-offs

| Phương án | Giả định chính | Hỏng đầu tiên khi |
|---|---|---|
| A. Rule tĩnh trong `theme-checks.mjs` + gate | Predicate đủ hẹp | Chặn toàn cục trên 38 theme có nợ → kẹt việc không liên quan (giải bằng ratchet) |
| B. Chỉ sửa routing/skill | Agent đọc và tuân thủ skill | Như hiện tại: rule đã nói vẫn sai (Seahorse 5 lần) |
| C. Runtime proof (shop guard, admin roundtrip) | Có tab + đúng shop | Chi phí cao, phụ thuộc trạng thái browser |

Chọn A + B + phần shop guard của C ở P0; roundtrip ở P2.

## Better approaches

Thay vì 4 tool Theme MCP mới (`theme.inspect/validate/render/qa`) + `sapo_theme` như báo cáo đề xuất: `theme.qa_validate`/`theme.cockpit_*` đã có; checker tĩnh đã chạy được trên theme thật (Levents: `undeclared=311 dead=321`, 0.59s). Chỉ cần sửa luật sai, nối vào MCP và receipt. Chi phí chuyển: thấp — không bỏ code nào đang chạy.

## Rủi ro còn mở
- Map org_id ↔ origin tab chưa kiểm chứng (probe đầu P0-A).
- Guarantee shop guard không phủ `bash`/`eval`.
- Quét theme dưới `E:/Work/themes/*` chưa hoàn tất (timeout).

Không truyền `--yagni` (user không yêu cầu).
