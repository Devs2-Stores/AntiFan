Follow-up của Leader (job {{JOB}}, vòng {{ROUND}}). User đã duyệt đóng issue {{ISSUE_ID}} sau khi Leader kiểm độc lập kết quả của bạn.

Làm đúng các bước sau, không làm gì khác (không sửa theme, không ghi thêm ô sheet, không push):
1. Trong tab dashboard: `const x=originalFeedback.find(r=>String(r.id)==='{{ISSUE_ID}}')`. Chỉ tiếp tục khi `x` tồn tại, `x.host==='{{HOST}}'` và `x.shop==='{{SHOP}}'`; nếu lệch thì dừng và ghi report STATUS: NEEDS_INPUT nêu chỗ lệch.
2. Lấy `x.rowNumber` từ chính danh sách vừa tải, chạy `quickUpdate(<rowNumber>,'Done')`, rồi tải lại trang và xác nhận Stage của issue (tìm theo `id`, không theo số dòng) đã là `Done`. Deadline/Tags/Priority giữ nguyên.
3. Ghi report vào `{{REPORT_PATH}}` theo đúng định dạng đã dùng ở vòng trước: dòng 1 `STATUS: DONE` (hoặc `FAILED` nếu Stage không thành Done), rồi MỘT khối ```json `leader-report/1` với `"job": "{{JOB}}"`, `"round": {{ROUND}}`, cùng `guard` (issueId {{ISSUE_ID}}, host {{HOST}}, shop {{SHOP}}, sheetId {{SHEET_ID}}), `dashboard.stageBefore` / `dashboard.stageAfter` đọc thật từ dashboard, và `notChecked`.
Sau đó kết thúc lượt. Không dùng tool ask.
