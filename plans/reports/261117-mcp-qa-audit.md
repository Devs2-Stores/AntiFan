# Audit MCP và QA engine, 17/11/2026

## 1. Bề mặt MCP: schema công bố so với cài đặt

| Kiểm tra | Kết quả |
|---|---|
| `node scripts/probe-rpc-surface-coverage.cjs --static-only` (check:rpc-surface) | OK, 37 phương thức GUI, 0 lỗi |
| `test/unit/mcp-published-schema`, `mcp-core-parity`, `proxy-tool-rows`, `proxy-catalogue-hint`, `proxy-capability-policy` | 61/61 pass |
| `scripts/check-mcp-budget-dominance.mjs` | OK: 282 capability, trần proxy 240000 ms chi phối mọi policy (lớn nhất 210000 ms `anti.sheet.write_range`) |
| Tên tool giả `browser_wait_placeholder` (audit P2-5) | Không có chỗ nào trong repo sinh tên này (`rg` trong `scripts/antifan-omp-mcp.cjs` và `src`: 0 hit). Chuỗi chỉ xuất hiện ở log phiên `01a1e3c1:L88` do model tự bịa; không phải drift schema. Đóng. |

Không phát hiện drift giữa schema công bố và cài đặt.

## 2. Điểm nóng lỗi/độ trễ trong audit chat

| Mục | Nguyên nhân | Trạng thái |
|---|---|---|
| `terminal.wait` biến "chưa xong" thành lỗi (P1-2) | `terminal-capabilities.ts` ném khi không `clamped`; RPC daemon mất `.code` | đã sửa tối nay, đã commit (ShipKaizen, origin/main 107d4d0b) |
| `evaluate`/`browser.wait` lease, viewport 2px, hướng dẫn quyền tab (P1-4, P1-5) | xem audit chat | đã sửa tối nay, đã commit |
| `theme.qa_validate` p50 25 → 50 s, p95 88 s | Chưa chứng minh nguyên nhân. Code đáng ngờ duy nhất đổi từ 10/11: quy tắc `sibling-content-overlap` (c64f48d3, thêm một bước quét cho mọi cặp anh em trong mọi container). Probe visual-qa cho thấy quét của từng fixture mất 11-25 ms trong trang nhỏ, nên bước này không đủ giải thích 25 s; thời gian chủ yếu nằm ở reload/CDP chờ tab (audit ghi `TARGET_STALE` "Reload failed or timed out…" `browser-control-port.ts:3242`, tab nền). Không có telemetry theo pha ở workflow (`phaseMs` chỉ nằm trong engine bố cục). | **open**: cần đo pha trên storefront thật; không đoán sửa |
| `browser_wait_placeholder` | xem trên | không phải lỗi app |

## 3. QA engine: kết luận từng mục

### 3.1 Fixture visual-qa: 3 ca kiểm chứng (`34` mobile+desktop, `50` desktop)

Cảnh báo `Sibling content overlaps` xuất hiện từ c64f48d3 (10/11). Kết luận theo từng ca:

- **34-floated-label-filled-fields (scanner sai, đã sửa scanner)**: nhãn nổi `position:absolute` nằm trên mép trên đúng ô nó đặt tên (`label[for]`). Đó là mẫu thiết kế floating label, không phải lỗi. Thêm `labelOfOther` bỏ qua cặp khi một bên là `<label>` absolute mà `label.control` là bên kia (hoặc nằm trong bên kia). Không nới cho label không gắn với ô.
- **50-pdp-healthy-spacing-and-wrapping-control (fixture cũ, scanner đúng)**: ở desktop 3 đoạn chữ chỉ cao ~82 px, dưới `max-height:110px`, nên khối KHÔNG bị cắt và nút "Xem thêm" `bottom:4px` che 18 px thật của dòng chữ cuối. Quét đúng; fixture mô tả "mô tả thu gọn" nhưng desktop không thu gọn. Sửa fixture: `max-height:60px` để khối thật sự bị cắt ở mọi viewport. Đồng thời bổ sung ngoại lệ có phạm vi hẹp trong scanner cho mẫu thật "nút đọc thêm đè lên chữ đã bị cắt": nút `position:absolute` thuộc container có `overflow` khác `visible` mà nội dung tràn (`scrollHeight > clientHeight`) hoặc phần tử chữ vượt mép. Lần chạy đầu với điều kiện "chữ vượt mép" còn trượt vì chữ bị che là đoạn kế cuối (không vượt mép), nên điều kiện dùng `scrollHeight` của container.
- Không nới verdict nào khác. Phép thử âm: `absolute-button-over-unclipped-text` (nút đè chữ không bị cắt) vẫn phải báo 1 cảnh báo.

### 3.2 smoke:terminal Step 10

`terminal-renderer-smoke.cjs` bắn `Ctrl+Shift+D` nhưng quy tắc phím tách pane trong `src/renderer/standalone.js:2293` là `Alt+Shift+D` hoặc `Ctrl+\` (từ 6c3e68cd, 31/08). `test/renderer/terminal-split-behaviour.test.ts:204-205` khẳng định rõ `Ctrl+Shift+D` KHÔNG phải phím tách. Smoke dùng phím cũ nên hỏng trên HEAD lẫn trước đó. Sửa smoke sang `Alt+Shift+D` (cả bật và tắt). Chạy lại `terminal-renderer-smoke.cjs`: Step 10 PASS, exit 0. (Hai smoke còn lại trong `smoke:terminal` không chạm đoạn này nên chưa chạy.)

## 4. Thay đổi đã áp dụng (cây main, chưa commit)

| File | Nội dung |
|---|---|
| `src/main/qa/scanners/layout-integrity-engine.ts` ~1814-1828, 1864 | `labelOfOther`, `readMoreOverClamp`, hai điều kiện `continue` trong quy tắc sibling-content-overlap |
| `test/main/layout-integrity-sibling-content-fixtures.cjs` | 3 fixture mới: `floating-label-on-own-field`, `read-more-button-over-clamped-text`, `absolute-button-over-unclipped-text` |
| `test/main/layout-integrity-sibling-content.test.ts` | 2 test mới (hai ca không báo, một ca âm vẫn báo) |
| `test/fixtures/visual-qa/fixtures.cjs` (fixture 50) | `max-height:110px` → `60px` |
| `test/e2e/terminal-renderer-smoke.cjs` ~727-763 | Ctrl+Shift+D → Alt+Shift+D |

## 5. Kiểm chứng (chạy trong worktree sạch `E:/Work/scratch/wt-mcpqa` với cùng 4 file + 1 fixture; các file này không bị phiên khác sửa nên giống main)

- `layout-integrity-sibling-content.test.js`: pass (exit 0, gồm 3 test mới).
- `npm run test:visual-qa`: exit 0 (trước đó fail=1/3 ca).
- `terminal-renderer-smoke.cjs`: exit 0, Step 10 PASS.
- `tsc --noEmit` (typecheck): exit 0.
- `check:rpc-surface` (static): OK.
- Schema MCP: 61/61 pass.
- Không chạy lại toàn bộ `test:main`/`test:fast` (không đụng file ngoài scanner + test của nó). Chưa restart app hay probe live: thay đổi nằm trong quét trang nhúng vào tab, cần restart app mới có hiệu lực; để chủ làm khi commit.

## 5b. Bổ sung theo yêu cầu Main

- **Telemetry `summary.phaseMs`** (`src/main/qa/theme-qa-workflow.ts`: lớp `QaPhaseClock`, kiểu `ThemeQaSummary.phaseMs`, các `phaseClock.lap(...)` trong `validate`): khóa luôn có đủ `prepare, reload, settle, evidence, layoutScans, responsive, responsiveTail, scanners, stateMatrix, finalize, total` (0 nếu run bỏ qua pha). Số nguyên ms; mỗi pha làm tròn xuống, `total` làm tròn lên nên tổng các pha ≤ total. Không verdict nào đọc nó; `summary` nằm trong SKELETON_KEYS nên không bị cắt bớt. Giới hạn: port `responsiveCheck` không trả thời gian từng width nên `responsive` là một khối cho cả lượt quét nhiều viewport, chưa tách theo viewport; `settle` gồm freezeMedia/pause slider + settleCapture. Test: `test/main/theme-qa-phase-timing.test.ts`.
- **Smoke còn lại**: `terminal-recovery-smoke.cjs` exit 0, `terminal-split-hydration-probe.cjs` exit 0 (cả hai chạy bằng Electron riêng, không cần app đang chạy).
- **Worktree** `E:/Work/scratch/wt-mcpqa` đã gỡ: hai junction bỏ bằng `cmd /c rmdir` (node_modules của main còn nguyên), rồi `git worktree remove --force` (chỉ còn bản sao các sửa đã port sang main).
- **Kiểm chứng**: `npm run compile` exit 0 (gồm tsc), 20/20 test (phase-timing, read-as, sibling-content, qa-response-bounds), toàn bộ `theme-qa*`+`qa-*` test main exit 0.

- **Ca âm cho hai ngoại lệ** (fixture/test trong `layout-integrity-sibling-content`): label đè ô khác `for`, label khác parent đè button, label khác parent đè đoạn chữ, nút đọc-thêm trên container `overflow:hidden` chứa vừa nội dung: tất cả vẫn báo. Ca `<p>` ban đầu cho 0 finding trên cả HEAD (trước ngoại lệ của tôi) lẫn bản mới: nguyên nhân là đoạn chữ 300px bị xuống 2 dòng (cao 40px), nhãn 20px nằm trọn trong hộp đoạn chữ nên bị quy tắc `holds` (lồng nhau) có từ trước bỏ qua, không phải lỗ hổng scanner hay ngoại lệ mới. Fixture đổi sang đoạn chữ 1 dòng thì HEAD báo 1 cảnh báo; có comment trong fixture.

## 6. Còn lại

1. `qa_validate` p50 50 s: telemetry đã có (`summary.phaseMs`); lần chạy storefront thật sau khi restart app sẽ cho biết pha nào chậm. Chưa restart app.

Status: DONE_WITH_CONCERNS
