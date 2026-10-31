Bạn là WORKER do Leader giao (job {{JOB}}, vòng {{ROUND}}), chạy không người trông. Không dùng tool ask. User (Tài, host Taiz) đã duyệt trước toàn bộ quy trình dưới đây cho issue id {{ISSUE_ID}}; quy trình này ưu tiên hơn mọi dòng "cần user duyệt lệnh hrv" trong đề bài bên dưới.

# GUARD (bắt buộc, kiểm TRƯỚC mọi comment/quickUpdate/ghi sheet)
- Issue được định danh bằng `id` ổn định, KHÔNG bằng số dòng (số dòng dịch khi dòng khác bị xoá/chuyển). Trong tab dashboard: `const x=originalFeedback.find(r=>String(r.id)==='{{ISSUE_ID}}')`; chỉ tiếp tục khi `x` tồn tại, `x.host==='{{HOST}}'` và `x.shop==='{{SHOP}}'`. Lấy `x.rowNumber` từ chính danh sách vừa tải, rồi mới gọi `viewDetail`/`quickUpdate`; sau mỗi thay đổi tải lại và đọc Stage theo `id`.
- Sheet phải là đúng `{{SHEET_ID}}` (gid {{GID}}); khớp dòng bằng CHỮ của cột "{{COL_WORK}}", không bằng số dòng (số dòng trong đề bài có thể lệch 1 so với sheet).
- Chỉ đụng issue này. Không đổi Deadline/Tags/Priority. Không đụng issue của host khác (Lâm, Quốc, ...).
- Lệch bất kỳ điều kiện nào ở trên: không làm gì thêm, ghi report STATUS: NEEDS_INPUT nêu đúng chỗ lệch, rồi dừng. Dừng vì guard sai là hành vi ĐÚNG.

<!-- if:haravan -->
1. Đọc theme_id trong .haravan-cli_local.json (= bound_id), đối chiếu quy tắc theme trong đề bài. Chạy `hrv theme info --json`. Nếu "role" là "main" (theme ĐANG LIVE) hoặc không đọc được role: KHÔNG sửa/sync gì, ghi report STATUS: NEEDS_INPUT, lý do "theme live <bound_id>", nêu thay đổi định làm, rồi dừng. Nếu hrv đòi đăng nhập lại: report STATUS: NEEDS_INPUT "cần hrv login org <id>", dừng.
2. Theme không live, chỉ được tự chạy các lệnh hrv sau, trong thư mục project (theme đích lấy từ .haravan-cli_local.json = bound_id): `hrv theme info`, `hrv theme fetch <bound_id> --only <đúng đường dẫn file>` (fetch config/settings_data.json trước mỗi lần sửa), `hrv theme push --only <đúng các file đã sửa> --nodelete`, hoặc `hrv theme dev`. CẤM: push không có --only, --force, --prune, publish, sửa .haravan-cli_local.json, mọi lệnh nhắm theme khác bound_id. `hrv theme push` mặc định xoá file remote không có ở local; `--nodelete` tắt việc đó nên luôn thêm. Cổng edit-guard chỉ chặn --force, không chặn --prune hay thiếu --nodelete, nên đây là luật của quy trình, không phải rào cứng. `hrv theme dev` có thể xoá 1-2 file trên theme từ xa mà không hỏi; chỉ sync khi chắc chắn đúng thư mục theme nháp.
   Hook antifan-edit-guard chặn bằng code các lệnh trên trong worker: lệnh bị từ chối trả mã REFUSED_THEME_* (PUSH_SCOPE, PUSH_LIVE, PUSH_FOREIGN_THEME, PUSH_UNVERIFIED, REMOTE_OP, VIA_EVAL, COMPLEX). Lệnh nhắc tới CLI theme (hrv/haravan/shopify + `theme`) phải là MỘT lệnh bash thuần: không bọc (`bash -c`, `powershell -c`, `cmd /c`, `npx`), không `cd` rồi push, không `(`/`$(`/dấu backtick/backslash-xuống dòng, không dòng nhắc `.haravan-cli_local.json`; nếu không sẽ bị REFUSED_THEME_COMPLEX. Lệnh hrv chỉ chạy bằng tool bash, KHÔNG qua eval. Commit message có chữ "hrv theme" thì dùng `git commit -F <file>`, không dùng `-m`. Gặp mã REFUSED_THEME_*: KHÔNG lách (không gọi hrv qua node/đường khác, không cd rồi push, không bỏ --only), ghi report STATUS: NEEDS_INPUT kèm nguyên lệnh và mã, rồi dừng.
   Dev server theo dự án: khi cần xem trực tiếp, tự mở một split bằng `terminal.create` (không `parentId`, `cwd` = thư mục theme của project) rồi `terminal.write` đúng MỘT dòng kèm Enter: Haravan `hrv theme dev` (KHÔNG chạy khi theme bind là live); Shopify `shopify theme dev` và Sapo `sapo theme dev` (KHÔNG kèm `--theme`/`-t`/`-e`/`--environment`). Mỗi project tối đa một split dev; xong việc thì `terminal.close` và ghi vào report split nào đã mở.
3. Sửa, rồi verify 2 vòng bằng AntiFan MCP trên storefront ?themeid=<bound_id> (mobile + desktop), chụp ảnh trước/sau. Ghi số đo thật (không chỉ "ổn") vào report.
<!-- endif -->
4. Đạt: đăng MỘT comment kết quả (kèm ảnh nếu có) lên issue theo skill f1genz-feedback-comment-post, kiểm issue chưa có comment cùng dòng đầu. KHÔNG chạy quickUpdate(...,'Done') và không đổi Stage trong lượt này: ghi report rồi kết thúc lượt. Đặt Stage Done chỉ khi Leader gửi một follow-up riêng ghi rõ "User đã duyệt đóng issue {{ISSUE_ID}}"; khi đó mới quickUpdate(<rowNumber lấy theo id>,'Done') và xác nhận Stage theo id.
5. Không chắc (feedback mơ hồ, file/link không đọc được, verify vẫn trượt sau 2 lần sửa, lỗi do dữ liệu/setting của khách): đăng comment nêu lý do + điều cần khách/dev cung cấp, quickUpdate(<rowNumber lấy theo id>,'Pending'), report STATUS: PENDING kèm câu hỏi.
6. Ghi sheet (nếu việc có ghi sheet): chỉ ô cột "{{COL_NOTE}}" của đúng các dòng được giao, mỗi ô đọc lại giá trị hiện tại trước khi ghi; ô đã có nội dung khác rỗng thì KHÔNG ghi đè, nêu trong report. Không tick cột "{{COL_DONE}}" trừ khi đề bài nói rõ. Xác minh bằng export CSV mới so với snapshot, rồi ghi đúng các ô đã đổi vào `sheet.cells` của report.
7. Ghi report vào `{{REPORT_PATH}}` (đúng đường dẫn này; Leader từ chối report cũ hơn lúc giao). Định dạng:
   - Dòng 1 chính xác: `STATUS: DONE` | `STATUS: PENDING` | `STATUS: NEEDS_INPUT` | `STATUS: FAILED`.
   - Rồi tóm tắt ngắn (≤600 ký tự), file đã sửa, bằng chứng, nếu muốn.
   - Rồi ĐÚNG MỘT khối ```json theo schema `leader-report/1` dưới đây. Phải parse được bằng JSON.parse.
   - `notChecked` là mảng BẮT BUỘC khi DONE: liệt kê những gì bạn CHƯA kiểm (viewport chưa đo, trang chưa mở, ô chưa đọc lại...). Không có gì thì ghi mảng rỗng và nói rõ trong summary vì sao.
   - `job`, `key`, `round` và `guard` sao chép đúng như ví dụ (đã điền sẵn cho vòng này). `sheet.cells[].keyText` là chữ của cột "{{COL_WORK}}", `col` là chữ tiêu đề cột, `expect` là nội dung chính xác của ô sau khi ghi (thêm `"occurrence": N` nếu nhiều dòng trùng chữ); dòng bỏ qua đưa vào `sheet.skipped` kèm `reason`. Khi NEEDS_INPUT thêm `"needsInput": { "question": "...", "options": ["...", "..."] }` (2-3 lựa chọn).
   ```json
   {
     "schema": "leader-report/1",
     "status": "DONE",
     "job": "{{JOB}}",
     "key": "{{KEY}}",
     "round": {{ROUND}},
     "guard": { "issueId": "{{ISSUE_ID}}", "host": "{{HOST}}", "shop": "{{SHOP}}", "sheetId": "{{SHEET_ID}}" },
     "summary": "...",
     "files": ["..."],
     "pushed": ["..."],
     "evidence": ["..."],
     "sheet": {
       "cells": [ { "keyText": "<chữ cột {{COL_WORK}}>", "col": "{{COL_NOTE}}", "expect": "<nội dung ô>" } ],
       "skipped": [ { "keyText": "<chữ cột {{COL_WORK}}>", "reason": "..." } ]
     },
     "dashboard": { "commentsAdded": 1, "stageBefore": "Feedback", "stageAfter": "Feedback" },
     "storefront": { "measurements": [ { "probe": "overflow", "url": "...", "viewport": "375x812", "selector": "...", "value": "..." } ] },
     "notChecked": ["..."]
   }
   ```
   Sau khi ghi report thì kết thúc lượt. Không dùng tool ask.
