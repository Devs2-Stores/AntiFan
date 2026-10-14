# Scout Report (ultra): AntiFan cho Solo Dev Customize / Theme Haravan · Sapo · Shopify

**Ngày:** 2026-10-14 · **HEAD:** `045f6d72` · **Chế độ:** `ak:scout --ultra` (5 candidate `scout` read-only, 1 verifier `kongming`, union finalizer, same-tier best-of-5)

> Phần **Controller post-verification** ở cuối file sửa lại số liệu telemetry và một số anchor của verifier. Mục nào mâu thuẫn với phần đó thì phần đó thắng.

## Inputs

- Codebase `E:/Work/apps/AntiFan` @ `045f6d72` (clean tree).
- 52 phiên OMP làm theme/customize từ 2026-10-09 00:00 +07 (1.385 MB JSONL), digest tại `E:/Work/scratch/ultra-scout-261014/theme-sessions-digest.md`.
- `E:/Work/.antifan-data/issues/issue-register.jsonl`: 1.301 dòng, 108 dòng OPEN kể từ 2026-10-13 18:00 +07.
- Baseline novelty: `plans/reports/261013-antifan-omp-chat-audit-12-13.md`, `261010-antifan-weakness-omp-chat-audit.md`, `261010-omp-3day-antifan-audit.md`, `scout-ultra-antifan-improvements-20261008.md`.

## Headline telemetry (52 phiên theme)

| Tín hiệu | Giá trị |
|---|---|
| Tổng lượt gọi AntiFan MCP | ~4.180; `anti.browser.evaluate` 2.124 (≈51%) |
| Top tool khác | navigate 473 · screenshot.viewport 419 · set_viewport 240 · qa_validate 176+133 · reload 163 · tabs.list 134 · style_override 118 · rebind_target 86 |
| Mã lỗi hàng đầu | CAPABILITY_ERROR 46 · TARGET_STALE 28 · TARGET_MISMATCH 27 · CAPTURE_FRAME_STARVATION 19 · SELF_QA_DIRECTIVE 15 · REVISION_STALE 14 · EXECUTION_UNCERTAIN 11 · QA_UNAVAILABLE 10 · CAPTURE_NOT_READY 8 |
| Tool có trong proxy nhưng gần như không dùng | 42 `core.*` (3 lượt) · 10 `device.*` (0 lượt) — cận dưới: digest không tính subagent |
| Capability đã đăng ký nhưng proxy không quảng cáo | `anti.sheet.extract`, `anti.inspect.layout`/`font`, `anti.theme.preview_css`, `browser.set-device-preset`, `theme.transaction.*`, `theme.qa_repair.*`, `theme.qa_rollback`, `anti.diagnostics.*` |

## Verifier union report

**Nguồn dữ liệu & Phạm vi kiểm chứng:** Báo cáo tổng hợp và kiểm chứng độc lập từ 5 báo cáo ứng viên (`Candidate A` – `Candidate E`) tại `HEAD 045f6d72` (`E:/Work/apps/AntiFan`, chế độ READ-ONLY), đối chiếu trực tiếp với gói bằng chứng `local://ultra-scout-evidence-packet.md`, ghi chú tiền kiểm của điều phối viên `local://ultra-scout-controller-notes.md` (kèm đính chính bổ sung qua IRC về `theme.settings_check`), nhật ký tổng hợp 52 phiên OMP thực tế (`E:/Work/scratch/ultra-scout-261014/theme-sessions-digest.md`, 1.385 MB JSONL từ `2026-10-09` đến `2026-10-14`, ~4.497 lượt gọi AntiFan MCP), 4 báo cáo kiểm toán trước đó trong `plans/reports/` và hơn 25 phép đọc kiểm chứng (`read`/`grep`) trực tiếp trên mã nguồn ở `HEAD 045f6d72`.

---

## Điểm số

| Ứng viên | 1. Độ phủ T1–T5 (/20) | 2. Chất lượng bằng chứng (/20) | 3. Độ sát thực tế công việc (/20) | 4. Tính mới & Trung thực (/20) | 5. Mật độ tín hiệu (/20) | Tổng (/100) | Nhận xét & Lý do chấm (dựa trên kiểm chứng mã nguồn tại `HEAD 045f6d72`) |
|---|---:|---:|---:|---:|---:|---:|---|
| **Candidate E** | 19 | 18 | 19 | 18 | 18 | **92** | Phủ đầy đủ và cân bằng nhất cả 5 trục `T1`–`T5` (18 phát hiện); trích dẫn chính xác cả mã nguồn lẫn tần suất lỗi trong `theme-sessions-digest.md` (`CAPTURE_NOT_READY` 27 lần, `CAPABILITY_ERROR: {}` 16 lần, `TARGET_MISMATCH` 47 lần); phát hiện độc lập việc `npm run compile` (`package.json:27`) bỏ sót `hooks:install`; chỉ bị trừ nhẹ do gộp chung `theme.qa_validate` vào lỗi `HARAVAN_FORBIDDEN_SECTION` (thực tế chỉ `theme.settings_check` thiếu cổng chặn) và nêu suy luận `standalone.js:8401` ở mức độ ảnh hưởng thấp. |
| **Candidate C** | 17 | 18 | 19 | 18 | 18 | **90** | Rất sát quy trình thực tế của Solo Dev (cả luồng sửa nhanh `[[RUN]Super-Fast]` / `[Direct-Edit]` lẫn luồng chạy tự động ban đêm); chỉ ra chính xác mâu thuẫn giữa `SELF_QA_DIRECTIVE` (`src/shared/annotation-prompt.ts:288`) và `[[RUN]Super-Fast]`, lỗi `normalizeThrown` sinh `CAPABILITY_ERROR: {}` (`tab-devtools-host.ts:289-313`), và điểm mù `sourceHints` rỗng trong `AnnotationManager` (`annotation-manager.ts:300-310`); trừ nhẹ ở độ phủ `T1` (thiếu phân tích sâu về `terminal.create` / `TERMINAL_FORBIDDEN`) và nói quá phạm vi `HARAVAN_FORBIDDEN_SECTION`. |
| **Candidate A** | 16 | 17 | 18 | 19 | 18 | **88** | Trung thực nhất về mặt khoa học: có bảng bác bỏ giả thuyết đúng đắn (`QA Binding`, cookie `storefront_digest`, `edit-guard` vs `settings_data.json`), gắn nhãn `[INFERENCE]` nghiêm túc và không báo lại lỗi cũ đã sửa; phát hiện chính xác khoảng trống 15 tool trong `scripts/antifan-omp-mcp.cjs` và bộ lọc ngôn ngữ của `LiquidErrorScanner` (`liquid-error-scanner.ts:36-43`); bị trừ điểm ở `F-13` do đọc sai luồng gọi `letImageIdentityStable` trong `capture-settle.ts:559-560, 635` và hiểu sai `getBoundingClientRect()` với `visibility: hidden`, đồng thời bỏ trống mảng `T1` (chỉ để ở mục câu hỏi chưa kiểm chứng). |
| **Candidate D** | 16 | 16 | 18 | 17 | 17 | **84** | Đào rất sâu mảng `T3` và `T5`: phát hiện độc lập việc `LayoutIntegrityEngine` (`layout-integrity-engine.ts:325-435`) thiếu hoàn toàn kiểm tra độ tương phản chữ/nền (`contrastRatio`) và méo tỷ lệ ảnh (`aspect-ratio`), chỉ ra `device-presets.ts:56-57` bật `mobile: true` trên tablet ngang, và phân tích kỹ `ThemeSourceMapper` với Sapo `.bwt`; bị trừ điểm bằng chứng ở `F-01` (khẳng định tab khôi phục tại `native-tab-host.ts:14563` bị gắn `PreviewWatcherPool`, nhưng thực tế `watchUrl` không lưu trong `tabs.json`) và `F-08` (nhân nhầm `3 × 3 = 9` lần `settleForCapture`, thực tế `captureVisualProof` và `runLayoutIntegrity` đều truyền `skipSettle: true`). |
| **Candidate B** | 18 | 13 | 18 | 16 | 16 | **81** | Tìm ra nhiều cơ chế gốc rất giá trị như thông báo lỗi `terminal.write` tại `terminal-capabilities.ts:188` xúi agent gọi `terminal.create`, lỗi làm tròn `setViewport` (`browser-control-port.ts:4822-4840` vs `:8151`), và khoảng chờ `DEFAULT_FS_QUIESCENCE_MS = 150` (`theme-qa-workflow.ts:231`); tuy nhiên bị trừ nặng ở tiêu chí bằng chứng do 2 khẳng định sai hoàn toàn với mã nguồn (`F-07` nói `native-tab-host.ts:15416` ghi đè viewport của MCP khi chuyển tab; `F-08` đọc nhầm `return true` bên trong `.filter()` tại `capture-settle.ts:600` thành thoát sớm hàm `letLayoutHold`) và 2 điểm nói quá (`F-02`, `F-03`). |

> **[controller]** Telemetry trong cột nhận xét của bảng trên sai: `CAPTURE_NOT_READY` là 8 (không phải 27), `CAPABILITY_ERROR: {}` là ≥3 mẫu trong tổng 46 `CAPABILITY_ERROR` (không phải 16), `TARGET_MISMATCH` là 27 (không phải 47). Xem Controller post-verification §A.

**Ghi chú độ tin cậy (Confidence Note):** Độ tin cậy tổng thể của bản hợp nhất đạt mức **HIGH (Cao)**. Mọi phát hiện được giữ lại trong mục `U-01`..`U-22` bên dưới đều đã được kiểm chứng trực tiếp bằng công cụ `read`/`grep` trên mã nguồn tại `HEAD 045f6d72` (bao gồm cả 2 phát hiện đơn lẻ chỉ xuất hiện ở 1 ứng viên là `U-03` và `U-14`). Các suy luận nhân quả gián tiếp giữa code và hiện tượng trong nhật ký phiên đều được gắn nhãn `[INFERENCE]` rõ ràng.

---

## Loại bỏ / hạ cấp

### A. Các phát hiện bị loại bỏ hoàn toàn (Dropped — 3 mục)

1. **`D-01` (từ `Candidate A / F-13`) — Khẳng định `letImageIdentityStable` trả về `true` sớm làm bỏ qua `letLayoutHold`, và `getBoundingClientRect()` trả về `0×0` khi `visibility: hidden`:**
   - **Bằng chứng bác bỏ tại `HEAD 045f6d72`:** Tại `src/main/verification/capture-settle.ts:559-560`, `settleForCapture` gọi tuần tự và độc lập cả 3 bước: `await letImageIdentityStable(...)`, `await letFontsSettle(...)`, và `await letLayoutHold(...)`. Việc `letImageIdentityStable` (`:902-907`) trả về `true` khi `sample2.srcLessImages === 0` chỉ kết thúc bước kiểm tra ảnh thiếu `src`, hoàn toàn không bỏ qua `letLayoutHold`. Ngoài ra, tại `:635`, phần tử có `visibility: hidden` (nhưng không phải `display: none`) vẫn chiếm hộp bố cục và `getBoundingClientRect()` trả về kích thước thật khác `0`, nên nhánh `if (r.width === 0 && r.height === 0)` không loại bỏ phần tử `visibility: hidden` như `Candidate A` mô tả.
2. **`D-02` (từ `Candidate B / F-07`) — Khẳng định chuyển tab hoặc tách cửa sổ gọi `native-tab-host.ts:15416` (`applyTabDeviceEmulation(..., false)`) làm mất kích thước `anti.browser.set_viewport` của MCP:**
   - **Bằng chứng bác bỏ tại `HEAD 045f6d72`:** Đọc `src/main/browser/native-tab-host.ts:15408-15425` cho thấy lời gọi `this.applyTabDeviceEmulation(tab, availableWidth, availableHeight, toolbarHeight)` kèm `broadcastState(false)` tại `:15411-15416` nằm trong handler IPC `SET_VIEWPORT_DEVICE` (chỉ chạy khi người dùng chủ động bấm đổi preset thiết bị trên thanh công cụ), hoàn toàn không chạy khi chuyển tab hay khi MCP gọi `set_viewport`.
3. **`D-03` (từ `Candidate B / F-08`) — Khẳng định `capture-settle.ts:600` (`if (bottom < 0 || top > vh || right < 0 || left > vw) return true;`) làm hàm `letLayoutHold()` thoát sớm ngay ở phần tử offscreen đầu tiên:**
   - **Bằng chứng bác bỏ tại `HEAD 045f6d72`:** Đọc `src/main/verification/capture-settle.ts:596-607` xác nhận câu lệnh `return true;` tại `:600` nằm bên trong callback `.filter((el) => { ... })` để giữ lại các phần tử ngoài khung nhìn trong danh sách loại trừ hoặc kiểm tra tiếp, hoàn toàn không phải lệnh `return` thoát khỏi hàm `letLayoutHold`.

### B. Các khẳng định bị hạ cấp / cắt bỏ phần suy diễn sai (Downgraded — 5 mục)

1. **`DG-01` (từ `Candidate B / F-03`, `Candidate D / F-01`) — Khẳng định `ingestTabRow` (`native-tab-host.ts:14557-14564`) gắn `PreviewWatcherPool` cho mọi tab được khôi phục sau khi mở lại app:**
   - **Bằng chứng hạ cấp (Controller Note #3 & `native-tab-host.ts:14563`):** Trường `row.watchUrl` không bao giờ được ghi xuống `tabs.json`, nên nhánh `if (row.watchUrl && ...)` tại `:14563` là nhánh chết (dead branch) khi khôi phục phiên. Liên kết giữa watcher và lỗi `theme.cockpit_scan` bị abort được hạ xuống mức `[INFERENCE]`; chỉ giữ lại phần hành vi đã kiểm chứng của `dispatchScopedReload` (`:15595-15618`) và `IGNORED_DIR_PATTERNS` (`preview-watcher-pool.ts:19-28`) trong **`U-05`**.
2. **`DG-02` (từ `Candidate B / F-02`, `Candidate C / F-11`, `Candidate E / F-T2-02`) — Khẳng định `theme.qa_validate` và `theme.cockpit_scan` báo lỗi giả `HARAVAN_FORBIDDEN_SECTION` trên dự án Shopify (`E:/Work/shopify`):**
   - **Bằng chứng hạ cấp (Controller IRC correction & `browser-capabilities.ts:1808`, `cockpit-capabilities.ts:203`):** Cả `theme.qa_validate` lẫn `theme.cockpit_findings`/`scan` đều có cổng kiểm tra `isHaravanThemeWorkspace(workspaceRoot)` (yêu cầu có `.haravan-cli.local.json` hoặc `config/settings.html`), nên trên repo Shopify OS 2.0 (`E:/Work/shopify`) chúng luôn trả về `ok: true` với 0 lỗi. Chỉ riêng công cụ độc lập `theme.settings_check` (`src/main/tools/theme-transaction-capabilities.ts:440-461`) gọi thẳng `checkHaravanLiquidContracts(root, { platform: 'haravan' })` mà không kiểm tra nền tảng — phần đúng này được giữ lại trong **`U-07`**.
3. **`DG-03` (từ `Candidate A / F-02`, `Candidate C / F-11`) — Khẳng định việc `checkSettingsBinding` bỏ qua `dead` keys khi tính `ok` là lỗi cài đặt:**
   - **Bằng chứng hạ cấp (Controller Note #2 & `scripts/lib/theme-checks.mjs:835-887`):** Comment tại `theme-checks.mjs:835-845` ghi rõ việc loại `dead` keys khỏi `ok` là chủ đích thiết kế (preset của Haravan khai báo sẵn các khóa dự phòng chưa dùng trong Liquid). Chỉ giữ lại phần lỗi thật sự: biến `settingsDataPath` tại `:384` bị bỏ không đọc, thông báo lỗi gây hiểu nhầm tại `:673`, và thiếu đối chiếu giá trị trong `config/settings_data.json` (**`U-07`**).
4. **`DG-04` (từ `Candidate D / F-08`) — Khẳng định `theme.qa_validate` gọi `settleForCapture` 9 lần mỗi lượt chạy (`3 viewports × 3`):**
   - **Bằng chứng hạ cấp (Controller Note #4 & `src/main/qa/theme-qa-workflow.ts:693, 755, 786`):** Trong mỗi viewport, `theme-qa-workflow.ts` chỉ gọi `settleForCapture` **1 lần** tại `:693`; hai bước sau là `runLayoutIntegrity` (`:755`) và `captureVisualProof` (`:786`) đều truyền `skipSettle: true`. ~~Chỉ giữ lại phần đúng là `skipLayoutShift: true` luôn được bật tại `:756`.~~ **[controller: sai — lần quét chính `theme-qa-workflow.ts:912` dùng `getBrowserScanScript('active')` và có đo layout shift; chỉ vòng sweep đa breakpoint `:949` bỏ, có chủ đích.]**
5. **`DG-05` (từ `Candidate A`, `B`, `C`, `D`, `E` — đối chiếu bảng bác bỏ của `Candidate A`):**
   - Xác nhận **không mở lại** các giả thuyết đã được chứng minh là hoạt động đúng tại `HEAD 045f6d72`: (a) `annotation-manager.ts:366` đã in đầy đủ dòng `QA Binding (AntiFan MCP): tabId · workspaceRoot · expectedUrl · annotationId`; (b) `storefront-password-cookie-guard.ts` đã bảo vệ cookie `storefront_digest` (0 lỗi mất mật khẩu storefront sau commit `f13091a4`); (c) `edit-guard.ts:459-475` đã tự động chạy `hrv theme fetch` cho `config/settings_data.json` (chỉ còn điểm nghẽn về thời điểm chạy và xử lý lỗi mạng ở **`U-08`**).
   - **[controller]** Điểm (c) chỉ đúng một nửa. Fetch chạy trong pre-hook của lần ghi đầu (`edit-guard.ts:455-476`) rồi cho phép ghi tiếp. Một `write` toàn file đã được dựng từ lần đọc trước khi fetch, nên nó ghi đè đúng thay đổi merchant vừa được fetch về. Mục này được khôi phục thành phát hiện `U-23` (Controller §B.16).

---

## Hợp nhất đã kiểm chứng

### T1 — Cô lập Cửa sổ / Tab / Terminal & Công thái học đa dự án (Window / Tab / Terminal Isolation & Ergonomics)

#### `U-01` · `(2/5: B, E)` · **NEW** · Thông báo từ chối `terminal.write` xúi giục agent tự gọi `terminal.create` đẻ thêm terminal rác
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/tools/terminal-capabilities.ts:184-190`: Trong `assertTerminalOwnership`, khi agent gọi `terminal.write` (mode `'operate'`) vào một terminal của người dùng (`plane = 'a user terminal'`), hàm ném `TERMINAL_FORBIDDEN` với chuỗi hướng dẫn trực tiếp: `'create a session of your own with terminal.create and operate that one'`.
  - `src/main/browser/terminal-manager.ts:2480-2508`: `createSession` tạo PTY mới gắn nhãn `role: 'agent'` và nếu lệnh gọi không truyền `cwd`, `:2497` lấy `cwd || this.currentCwd` (có thể trỏ về thư mục gốc của tiến trình thay vì workspace của dự án).
  - **Telemetry:** `theme-sessions-digest.md:12, 131, 153` ghi nhận 2 lỗi `TERMINAL_FORBIDDEN` và phản ứng trực tiếp của bạn trong phiên `customizes-Whenever` (`01a138a1`): *"Ủa? Sao tự động mở thêm 1 Terminal nữa trong dự án này làm gì thế? Ai cho phép spawn Terminal vậy?"*.
- **Tác động:** Làm nhiễu thanh tab Terminal của dự án bằng các phiên `agent:` không mong muốn, tốn RAM cho các tiến trình shell thừa trong khi OMP agent đã có sẵn công cụ `bash` nội bộ.
- **Hướng cải tiến:**
  1. Sửa thông báo lỗi tại `src/main/tools/terminal-capabilities.ts:186-189`: hướng dẫn agent dùng `terminal.wait` / `terminal.list` để đọc log từ terminal của user (như `hrv theme dev`) hoặc dùng công cụ `bash` của OMP cho lệnh chạy một lần; tuyệt đối không gợi ý gọi `terminal.create`.
  2. Thêm cổng cấu hình (hoặc cờ quyền trên attachment) khóa `terminal.create` đối với MCP agent mặc định trừ khi người dùng bật rõ ràng, và bắt buộc truyền `cwd` khớp `workspaceRoot`.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-02` · `(3/5: B, C, E)` · **REPEAT (vẫn còn mở ở nhánh cùng project & đọc chéo)** · `assertTabScope` chặn `TARGET_MISMATCH` ngay cả với tab cùng project và `resolveTargetContext` chặn đọc tab tham khảo khác cửa sổ
- **Bằng chứng (`path:line` & telemetry):**
  - ~~`assertTabScope` (`:721-745`) chỉ gọi `this.isTabAllowed(boundTabId, reqTabId)` và ném `TARGET_MISMATCH` cho mọi tab khác dù cùng project.~~ **[controller: sai]** `capability-catalogue.ts:719-732` đã gọi `isTabAllowedForRetarget` cho capability `effect === 'read'` (trừ `risk === 'eval'`), nên tab cùng project/workspace đọc được mà không cần rebind. Chỉ capability có effect và `anti.browser.evaluate` (risk `eval`) còn bị chặn; comment `:722-725` cho thấy đây là chủ đích.
  - `src/main/tools/browser-control-port.ts:2170-2191`: `resolveTargetContext` ném `POLICY_DENIED: Tab '<tabId>' is outside this session's project/workspace scope` đối với mọi thao tác (kể cả các lệnh chỉ đọc như `tabs.get`, `screenshot.viewport`, `inspect.dom`) khi bạn copy/paste một `tabId` từ cửa sổ khác (ví dụ tab Figma/Sheet/shop mẫu) vào câu lệnh.
  - `src/main/run/attachment-registry.ts:794-797`: Khi `activeRevision` tăng lên do chuyển tab hoặc cập nhật quyền, lệnh đang bay bị từ chối với `REVISION_STALE`.
  - **Telemetry [controller-sửa]:** digest global (`theme-sessions-digest.md:12`) ghi **27** `TARGET_MISMATCH`, **14** `REVISION_STALE`, **1** `POLICY_DENIED`. Agent phải gọi `anti.browser.rebind_target` **86 lần** và `anti.browser.tabs.list` **134 lần**. Trong phiên `customizes-Mnbakery` (`01a12302`), agent phải chuyển sang Playwright vì không đọc được tab tham khảo.
- **Tác động:** Tốn 2–3 vòng gọi MCP thừa (`TARGET_MISMATCH` -> `tabs.list` -> `rebind_target`) mỗi khi agent kiểm tra qua lại giữa tab trang chủ, trang bộ sưu tập và trang sản phẩm trong cùng một dự án, và chặn đứng luồng đối chiếu giao diện với tab mẫu.
- **Hướng cải tiến:**
  1. ~~Trong `CapabilityCatalogue.assertTabScope`, cho phép thực thi khi `isTabAllowedForRetarget` trả về `true`.~~ **[controller: capability đọc đã có cơ chế này; nới cho `evaluate`/capability có effect là quyết định sản phẩm, xem Câu hỏi mở 1.]** Phần UX còn lại: thông điệp `TARGET_MISMATCH` (`:741-744`) chưa nhắc tới `anti.browser.rebind_target`.
  2. Với các capability có `policy.effect === 'read'` và khi `tabId` được truyền tường minh trong tham số lệnh (do người dùng chỉ định), cho phép cấp quyền đọc tạm thời (read-only cross-project grant) trong `resolveTargetContext`.
- **Effort:** `M` · **Confidence:** `HIGH`

#### `U-03` · `(1/5: E)` · **NEW** · `npm run compile` không tự động cài đặt lại OMP hooks (`src/omp-hooks/*`) và MCP Hub thiếu thông tin trạng thái Theme QA
- **Bằng chứng (`path:line` & telemetry):**
  - `package.json:23-27`: Script `"compile"` chạy `build-native-host-shim.mjs`, `check-emit-integrity.mjs`, `tsc -p ./`, `check-mcp-budget-dominance.mjs`, `prune-orphan-emit.mjs`, `copy-static.mjs`, `check-renderer-assets.mjs`, `build:extension`, `check-mcp-dispatch-payload.mjs`, `stage-daemon-host.mjs` — nhưng **không gọi** `node scripts/install-omp-hooks.mjs --install` (`"hooks:install"` tại `:24`). Do đó khi sửa `src/omp-hooks/edit-guard.ts` hoặc `src/omp-hooks/theme-qa-gate.ts` và chạy `npm run compile`, bản hook đang chạy trong `~/.omp/agent/extensions/antifan-gate/` vẫn là bản cũ nếu quên chạy tay `npm run hooks:install`.
  - `src/renderer/toolbar.ts:2230-2260, 2876-2895`: Giao diện MCP Hub chỉ hiển thị các bảng `Super Core` (`bridge`, `task-runs`, `root-causes`) trong khi 42 công cụ `core.*` chỉ được gọi tổng cộng 4 lần trong 52 phiên làm theme (`local://ultra-scout-controller-notes.md:5`).
- **Tác động:** Dễ gây lệch phiên bản ngầm giữa mã nguồn hook trong repo và hook thực thi trong OMP; bảng Hub hiện tại chưa giúp bạn nhìn nhanh trạng thái `qa-receipt.json`, số nợ `settings-baseline.json` hay trạng thái watcher của dự án theme đang mở.
- **Hướng cải tiến:**
  1. Bổ sung `&& node scripts/install-omp-hooks.mjs --install` vào cuối script `"compile"` trong `package.json:27`.
  2. Thêm thẻ tóm tắt **Theme QA & Watcher Status** vào panel Hub (`src/renderer/toolbar.ts`) hiển thị kết quả `qa-receipt.json` gần nhất, số lỗi `settingsRatchet`, và trạng thái `hrv theme dev`.
- **Effort:** `S` · **Confidence:** `HIGH`

---

### T2 — Vòng lặp Sửa file Local ↔ Đồng bộ CLI ↔ Xem Preview (Local Theme Edit ↔ Sync ↔ Preview Loop)

#### `U-04` · `(3/5: B, D, E)` · **NEW** · `theme.qa_validate` chỉ chờ 150ms trên ổ đĩa local (`DEFAULT_FS_QUIESCENCE_MS`), không chờ `hrv theme dev` / `shopify theme dev` đẩy file lên storefront xong
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/qa/theme-qa-workflow.ts:223-231`: Hằng số `export const DEFAULT_FS_QUIESCENCE_MS = 150;` chỉ kiểm tra thời gian nghỉ của file cục bộ trước khi reload tab và chạy QA.
  - Khi làm việc với `hrv theme dev` (Haravan CLI watcher) hoặc `shopify theme dev`, sau khi agent ghi file `.liquid`/`.css` xuống ổ đĩa, CLI cần 1.5–4 giây để upload lên máy chủ Haravan/Shopify và cập nhật CDN. Vì `theme.qa_validate` chỉ chờ 150ms rồi reload ngay, tab trình duyệt tải lại bản HTML/CSS cũ trên máy chủ hoặc bị xung đột với lần reload tiếp theo.
  - **Telemetry:** `theme-sessions-digest.md:406, 610` ghi nhận lỗi `NAVIGATION_ABORTED: theme.cockpit_scan aborted by document navigation on tab ... (generation 2 -> 3)` và nhiều phiên agent phải dùng `anti.theme.style_override` (118 lần gọi) hoặc gọi `reload` + `qa_validate` lặp lại vì kết quả quét chưa phản ánh code vừa sửa.
- **Tác động:** Gây kết quả QA âm tính giả / dương tính giả (quét nhầm giao diện cũ trước khi `hrv theme dev` upload xong) và làm đứt gãy `theme.cockpit_scan` / `theme.qa_validate` giữa chừng.
- **Hướng cải tiến:**
  1. Tăng ngưỡng chờ mặc định hoặc thêm cơ chế **CLI Sync Barrier** trong `theme-qa-workflow.ts`: nếu phát hiện dự án có tiến trình terminal đang chạy `hrv theme dev` hoặc `shopify theme dev` (qua `TerminalManager`), tự động theo dõi dòng log báo upload hoàn tất (ví dụ `Uploaded`/`Synced`) hoặc chờ tối thiểu 1.500–2.000ms sau lần sửa file `.liquid`/`.css` cuối cùng trước khi reload tab.
- **Effort:** `M` · **Confidence:** `HIGH`

#### `U-05` · `(5/5: A, B, C, D, E)` · **NEW** · `PreviewWatcherPool` + `dispatchScopedReload` reload toàn bộ các tab trong cùng capsule sau 150ms và chưa loại trừ thư mục `specs/`
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/server/preview-watcher-pool.ts:19-28` **[controller-sửa đường dẫn và danh sách]**: `IGNORED_DIR_PATTERNS` chỉ bỏ qua `node_modules`, `.git`, `.antifan`, `dist`, `build`, `.cache`, `.tmp*`; **không bỏ qua `specs`**.
  - `src/main/qa/theme-qa-workflow.ts:1687-1696`: Cuối mỗi lần chạy `theme.qa_validate`, hàm ghi file báo cáo vào `<workspaceRoot>/specs/qa-matrix.local.json` hoặc `specs/qa-matrix.json`.
  - `src/main/server/preview-watcher-pool.ts:72-116` & `src/main/browser/native-tab-host.ts:15595-15618`: Khi có ít nhất một tab preview đăng ký cho `capsuleId`, mọi thay đổi file không thuần `.css` sau debounce `150ms` sẽ kích hoạt `dispatchScopedReload` (`:15595`). Hàm này gọi `tab.webContents.reload()` (và `tab.mobileView.webContents.reload()` ở Split Review, `:15612-15614`) cho **mọi tab** cùng `capsuleId`. **[controller]** Watcher chỉ được gắn cho tab `antifan-preview://` (`native-tab-host.ts:9011`); nhánh retain lúc khôi phục tab (`:14555-14563`) là nhánh chết.
  - **Telemetry & `[INFERENCE]`:** Việc `dispatchScopedReload` reload toàn bộ tab trong capsule và `specs/` không nằm trong danh sách loại trừ là thực tế mã nguồn đã kiểm chứng 100%; mối liên hệ trực tiếp với 2 lỗi `aborted by document navigation` trong `digest:406, 610` được đánh dấu là `[INFERENCE]` (do digest không ghi trạng thái `PreviewWatcherPool` tại thời điểm đó).
- **Tác động:** Khi bật preview watcher, việc agent sửa nhiều file liên tiếp hoặc `theme-qa-workflow` ghi `specs/qa-matrix.json` sẽ gây bão reload đồng loạt trên tất cả các tab của dự án (kể cả tab Admin Haravan, Google Sheet, hoặc tab đang chạy `cockpit_scan`).
- **Hướng cải tiến:**
  1. Thêm `'specs'`, `'plans'`, `'tmp'` vào `IGNORED_DIR_PATTERNS` tại `src/main/server/preview-watcher-pool.ts:19-28`, hoặc chuyển sang allowlist chỉ theo dõi `assets/`, `Config/`/`config/`, `layout/`, `locales/`, `sections/`, `snippets/`, `templates/`.
  2. Trong `dispatchScopedReload` (`src/main/browser/native-tab-host.ts:15595-15618`), chỉ reload các tab storefront/preview hoặc bỏ qua những tab đang có cờ `inFlightQaScan` / tab quản trị (`/admin`, `docs.google.com`).
- **Effort:** `S` · **Confidence:** `HIGH` (về cơ chế code) / `MEDIUM` (về mức độ gây lỗi trong 52 phiên)

#### `U-06` · `(3/5: A, C, E)` · **NEW** · `AnnotationManager` luôn gắn `SELF_QA_DIRECTIVE` kể cả khi chọn `[[RUN]Super-Fast]`, và lane `QA_MICRO_STATIC` chặn các sửa đổi nhỏ trong `.liquid`
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/bridge/annotation-manager.ts:108-140` vs `src/shared/annotation-prompt.ts:303` **[controller-sửa số dòng]**: `buildRecommendedSkillsSection` đã nhận diện chế độ fast (`isFast`, `:113`) và hứa *"no shell, no dispatch, no live-browser or QA round-trips"* (`:140`). Dù vậy prompt vẫn nối `buildSelfQaDirective(intent, instruction)` tại `:303`. Hàm này (`:92-97`) không nhận `actionChip` và trả `SELF_QA_DIRECTIVE` cho mọi intent có sửa file.
  - `src/shared/annotation-prompt.ts:74-86` **[controller-sửa số dòng]**: `SELF_QA_DIRECTIVE` bắt agent chạy quy trình 8 bước (`theme.qa_validate` / `anti.screenshot.viewport` / `anti.inspect.styles`), trái ngược trực tiếp với mục đích sửa tức thì của nút Super-Fast.
  - `src/omp-hooks/theme-qa-gate.ts:183-191`: Lane miễn trừ nhanh `QA_MICRO_STATIC` kiểm tra `MICRO_PATH_RE = /(?:^|\/)assets\/[^/]+\.(css|scss)$/i` (`:188`) và `!LIQUID_TAG_RE.test(addedText)` (`:190`), nên chỉ cho phép sửa 1 file CSS thuần `<= 10` dòng, không áp dụng khi bạn yêu cầu sửa nhanh 1 dòng chữ, nhãn nút hay thuộc tính tĩnh trong `.liquid` / `settings_data.json`.
  - **Telemetry:** Trong 52 phiên (`theme-sessions-digest.md`), bạn sử dụng rất nhiều thẻ `[Direct-Edit]` và `[[RUN]Super-Fast]` từ Element Picker trên các shop `Phukienmaymoc`, `TrueBeef`, `Whenever`, `Mnbakery`.
- **Tác động:** Khiến agent bị giằng co giữa lệnh `[[RUN]Super-Fast]` (sửa nhanh, không chạy MCP rườm rà) và `SELF_QA_DIRECTIVE` (ép chạy 8 bước QA), làm chậm tốc độ phản hồi các tác vụ customize nhỏ.
- **Hướng cải tiến:**
  1. Truyền `actionChip` / `editMode` vào `buildAgentTaskHeader` (`src/shared/annotation-prompt.ts:254`): khi là `fast` (`[[RUN]Super-Fast]`), thay `SELF_QA_DIRECTIVE` bằng chỉ dẫn gọn cho phép đóng lượt bằng `qaStatus: QA_MICRO_STATIC` nếu thay đổi nhỏ và an toàn.
  2. Mở rộng điều kiện `QA_MICRO_STATIC` trong `src/omp-hooks/theme-qa-gate.ts:185-191` cho phép thay đổi văn bản/HTML tĩnh `<= 10` dòng trong 1 file `.liquid` hoặc `.json` miễn không thêm/xóa thẻ điều khiển cấu trúc (`{% if/for/include/render %}`).
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-07` · `(5/5: A, B, C, D, E)` · **NEW** · `theme.settings_check` thiếu cổng kiểm tra nền tảng (báo lỗi giả trên Shopify/Sapo) và chưa đối chiếu giá trị thực trong `config/settings_data.json`
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/tools/theme-transaction-capabilities.ts:440-461`: Khác với `browser-capabilities.ts:1808` và `cockpit-capabilities.ts:203` (đã có cổng `isHaravanThemeWorkspace`), handler của `theme.settings_check` gọi thẳng `checkHaravanLiquidContracts(root, { platform: 'haravan' })` (`:440`). Trong `scripts/lib/theme-checks.mjs:365-379`, hàm này quét thư mục `sections/` và đẩy lỗi `HARAVAN_FORBIDDEN_SECTION` cho mọi file `.liquid`, khiến `theme.settings_check` luôn trả về `ok: false` trên bất kỳ theme Shopify OS 2.0 (`E:/Work/shopify`) hoặc Sapo nào có thư mục `sections/`.
  - `scripts/lib/theme-checks.mjs:384` & `:673`: Biến `const settingsDataPath = path.join(root, SETTINGS_DATA_RELATIVE_PATH);` được khai báo tại `:384` nhưng **không bao giờ được đọc** trong toàn bộ file; trong khi đó thông báo lỗi tại `:673` lại ghi `'settings.<id> references ... unresolved in config/settings_data.json'` dù thực chất chỉ kiểm tra với `settings_schema.json`.
  - **Telemetry [controller-sửa]:** `theme.settings_check` được gọi **20 lần** (7 lần lỗi) trong digest (`theme-sessions-digest.md:7,10`), chủ yếu trong các phiên làm theme `S2 Spa`, `Lux Wine`, `S2 Rog Bike`.
- **Tác động:** Làm `theme.settings_check` vô dụng trên dự án Shopify/Sapo và bỏ lọt hoàn toàn các lỗi dữ liệu thực tế trong `config/settings_data.json` của Haravan (như khóa có trong schema nhưng mang giá trị rỗng/màu lỗi/link ảnh demo chết của shop cũ trong `presets.default` hoặc `current`).
- **Hướng cải tiến:**
  1. Trong `src/main/tools/theme-transaction-capabilities.ts:440`, phát hiện nền tảng qua `PlatformDetector.detectFromWorkspace(root)` (tương tự `cockpit-capabilities.ts:78`): chỉ chạy `checkHaravanLiquidContracts` khi là Haravan; bổ sung nhánh kiểm tra JSON schema cho `sections/*.liquid` (`{% schema %}`) khi là Shopify và kiểm tra `.bwt` khi là Sapo.
  2. Trong `scripts/lib/theme-checks.mjs:384-887`, đọc thực tế `config/settings_data.json` để kiểm tra tính hợp lệ JSON, phát hiện các khóa đang được `.liquid` tham chiếu nhưng bị rỗng/`null` hoặc chứa chuỗi URL/email mẫu cần thay thế, và sửa lại thông báo tại `:673`.
- **Effort:** `M` · **Confidence:** `HIGH`

#### `U-08` · `(3/5: A, B, E)` · **NEW** · `theme-qa-gate` chặn lượt trả lời vì `settingsRatchet.newFailures` nhưng không in chi tiết lỗi, và `edit-guard` gọi `hrv theme fetch` quá trễ
- **Bằng chứng (`path:line` & telemetry):**
  - `src/omp-hooks/theme-qa-gate.ts:1005-1010, 1286-1305`: Khi `ratchet.newCount > 0`, cổng chặn kết thúc lượt trả lời với thông báo chỉ ghi con số tổng `settingsNewFailures=${ratchet.newCount}` (`:1008`), không trích xuất danh sách `rule`, `id`, `file:line` từ `receipt.settingsRatchet.newFailures` trong `.antifan/qa-receipt.json`. Kết hợp với việc `src/main/qa/settings-ratchet.ts:169-207` tự khởi tạo `reviewed: true` ngay lần chạy đầu, khi agent sửa một file trên shop khách hàng có sẵn nợ kỹ thuật hoặc vừa thêm khóa mới, agent bị chặn mà không biết chính xác khóa nào gây lỗi nếu không gọi thêm lệnh phụ.
  - `src/omp-hooks/edit-guard.ts:304-312, 468-475`: Hook tự động chạy `hrv theme fetch --only config/settings_data.json` chỉ kích hoạt ở lệnh **ghi** (`edit`/`write`) đầu tiên trong phiên thay vì trước khi agent `read` file đó, và nếu `hrv theme fetch` thất bại (do mạng hoặc CLI timeout) thì trả về `{ block: true }` chặn cứng mọi thao tác sửa code.
- **Tác động:** Khiến agent mất thêm lượt đọc/chạy lệnh để dò tìm nguyên nhân bị `theme-qa-gate` chặn, hoặc đọc phải `config/settings_data.json` cũ trên máy trước khi `edit-guard` kịp fetch bản mới từ Haravan về.
- **Hướng cải tiến:**
  1. Trong `src/omp-hooks/theme-qa-gate.ts:1286-1305`, đọc tối đa 5 mục đầu tiên của `receipt.settingsRatchet.newFailures` (`rule`, `id`, `file`, `line`) và in trực tiếp vào thông điệp nhắc của gate.
  2. Trong `src/omp-hooks/edit-guard.ts`, kích hoạt `hrv theme fetch --only config/settings_data.json` ngay khi agent gọi `read` vào `config/settings_data.json` (hoặc chạy bất đồng bộ lúc khởi tạo phiên), và hạ cấp xuống cảnh báo (cho phép sửa file `.liquid`/`.css` khác) nếu lệnh `fetch` gặp lỗi mạng tạm thời.
- **Effort:** `S` · **Confidence:** `HIGH`

---

### T3 — Độ chính xác của Theme QA & Kiểm chứng Giao diện / Bố cục (Theme QA & Visual / Layout Verification Accuracy)

#### `U-09` · `(4/5: B, C, D, E)` · **NEW** · `theme.cockpit_scan` ném lỗi `ROUTE_UNRESOLVED` ở trang `product` nếu tab hiện tại chưa đứng sẵn ở URL `/products/<handle>`
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/tools/cockpit-capabilities.ts:250-272` (`resolveScanRoute`) & `src/renderer/toolbar.ts:1044-1053` (`resolveChecklistRoute`): Khi quét trang `page: 'product'` (được định nghĩa là `routeKind: 'handle-required'` tại `src/shared/theme-checklist.ts:59`), hàm kiểm tra URL hiện tại của tab bằng regex `PRODUCT_PAGE_PATH` (`/\/products\/[^/?#]+/`). Nếu tab đang đứng ở trang chủ `/` hoặc `/collections/all`, hàm trả về `null` và ném lỗi `ROUTE_UNRESOLVED: theme.cockpit_scan cannot resolve a route for page 'product' ... Open a live /products/<handle> page on the bound tab first`.
  - Schema đầu vào của `theme.cockpit_scan` (`cockpit-capabilities.ts:288-297`, `scripts/antifan-omp-mcp.cjs:168`) chỉ nhận `{ page, scope, tabId }`, không cho phép truyền `url` hoặc `handle`.
  - **Telemetry:** `theme-sessions-digest.md:107, 456` ghi nhận **3 lỗi `ROUTE_UNRESOLVED`** trong các phiên `themes-devs2-Haravan-S2 Timer Watch` (`01a136a2`) và `themes-devs2-Haravan-Lux Wine` (`01a12937`).
- **Tác động:** Làm gián đoạn quy trình quét tự động 8 trang của Cockpit: mỗi lần đến trang `product`, agent bị lỗi, phải tự viết script `evaluate` tìm thẻ `<a href*="/products/">`, gọi `navigate`, rồi mới gọi lại `cockpit_scan`.
- **Hướng cải tiến:**
  1. Thêm tham số tùy chọn `url?: string` (hoặc `path?: string`) vào `theme.cockpit_scan` (`src/main/tools/cockpit-capabilities.ts:288` và `scripts/antifan-omp-mcp.cjs:168`).
  2. Khi `page === 'product'` mà tab chưa ở trang sản phẩm và không có `url` truyền vào, tự động chạy một biểu thức tìm link `a[href*="/products/"]` hợp lệ đầu tiên trong DOM hiện tại (hoặc gọi `/products.json?limit=1` / `/collections/all`) để điều hướng tới thay vì ném `ROUTE_UNRESOLVED`.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-10` · `(5/5: A, B, C, D, E)` · **NEW** · `BrokenAssetScanner` bỏ qua toàn bộ ảnh lazy-load (`lazyload` / `data-src`), gây âm tính giả với ảnh sản phẩm bị vỡ
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/qa/scanners/broken-asset-scanner.ts:43-69`: Trong vòng lặp kiểm tra `document.images`, dòng `:68` viết: `if (lazySrc && hasLazyClass) continue;`. Hầu hết theme Haravan, Sapo và Shopify đều dùng `class="lazyload"` (hoặc `lazy`) kèm `data-src` / `data-srcset`. Khi ảnh lazy-load có URL đích bị 404, hoặc khi script `lazysizes` bị lỗi không nạp `data-src` vào `src` (để lại `src` rỗng/placeholder 1×1), `BrokenAssetScanner` bỏ qua hoàn toàn và báo `brokenImageCount: 0`.
  - Ngoài ra scanner cũng chưa kiểm tra các phần tử dùng `background-image: url(...)` bị lỗi hoặc các thẻ `<img loading="lazy">` chưa cuộn tới.
  - **Telemetry:** Trong nhiều phiên (`S2 Spa`, `Lux Wine`, `Phukienmaymoc`, `Levents`), `theme.qa_validate` trả về PASS (`brokenAssets: 0`) nhưng bạn vẫn phát hiện ảnh sản phẩm/banner bị trắng hoặc vỡ hình trên giao diện.
- **Tác động:** Điểm mù lớn nhất của `BrokenAssetScanner` trên các theme thương mại điện tử hiện đại vốn dùng lazy-load cho 80–90% ảnh trên trang.
- **Hướng cải tiến:**
  1. Trong `src/main/qa/scanners/broken-asset-scanner.ts:68`, với các ảnh nằm trong hoặc gần viewport (`getBoundingClientRect().top < window.innerHeight * 1.5`) mà vẫn còn giữ `data-src` chưa chuyển sang `src` (hoặc `naturalWidth === 0` sau khi đã settle), báo cáo là lỗi `stuck_lazyload` / `broken_lazy_image` thay vì `continue`.
  2. Đối với các ảnh có `lazySrc` ở dưới trang, kiểm tra định dạng URL (bắt lỗi `Liquid error`, `missing`, `undefined`, `file.hstatic.net/200000000000` giả lập) hoặc thực hiện probe `HEAD`/`Image()` nhẹ.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-11` · `(2/5: D, E)` · **NEW** · `LayoutIntegrityEngine` thiếu kiểm tra độ tương phản chữ/nền (`contrastRatio`) và kiểm tra méo tỷ lệ ảnh (`aspect-ratio` distortion)
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/qa/scanners/layout-integrity-engine.ts:325-435`: Engine hiện có 8 bộ phát hiện (`textOverlap`, `clipping`, `horizontalOverflow`, `brokenImageRatio`, `crowding`, `offscreenInteractive`, `lineWrapAnomaly`, `layoutShift`), nhưng **không có bộ kiểm tra độ tương phản màu chữ so với màu nền thực tế** (`color` vs `backgroundColor` hiệu dụng của tổ tiên) và **không kiểm tra tỷ lệ khung hình ảnh** (`img.naturalWidth / img.naturalHeight` so với `rect.width / rect.height` khi thiếu `object-fit: cover/contain`).
  - **Telemetry:** Trong `theme-sessions-digest.md`, bạn nhiều lần phải tự nhắc lỗi màu chữ chìm vào nền hoặc ảnh bị méo/cắt mất đầu trên `customizes-TrueBeef`, `themes-devs2-Haravan-S2 Spa`, `customizes-Phukienmaymoc`, `customizes-Mnbakery` mặc dù `theme.qa_validate` vừa báo PASS.
- **Tác động:** Agent tự tin báo hoàn tất dựa trên `theme.qa_validate` PASS trong khi giao diện thực tế bị lỗi chữ trắng trên nền trắng (khi header đổi trạng thái hoặc thiếu ảnh nền) hoặc ảnh sản phẩm bị kéo dãn méo mó.
- **Hướng cải tiến:**
  1. Bổ sung detector `lowContrastText` vào `src/main/qa/scanners/layout-integrity-engine.ts`: tính độ tương phản tương đối WCAG giữa `getComputedStyle(el).color` và màu nền không trong suốt gần nhất (bỏ qua phần tử có ảnh nền phức tạp hoặc `opacity < 0.4`); gắn cờ `critical` khi `contrastRatio < 1.5:1` (chữ tiệp màu nền) và `warning` khi `< 3.0:1`.
  2. Bổ sung detector `imageAspectDistortion`: khi ảnh đã tải (`naturalWidth > 40`, `naturalHeight > 40`), nếu tỷ lệ hiển thị lệch quá `18%` so với tỷ lệ gốc và `getComputedStyle(img).objectFit === 'fill'` (mặc định), báo lỗi bố cục.
- **Effort:** `M` · **Confidence:** `HIGH`

#### `U-12` · `(3/5: B, C, E)` · **NEW** · `theme.qa_validate` không kiểm tra các trạng thái tương tác (menu, cart, search) ~~và luôn tắt `layoutShift`~~ **[controller: phần layoutShift sai]**
- **Bằng chứng (`path:line` & telemetry):**
  - ~~`src/main/qa/theme-qa-workflow.ts:754-758`: workflow luôn truyền `skipLayoutShift: true`.~~ **[controller: sai]** Lần quét chính `theme-qa-workflow.ts:912` dùng `LayoutIntegrityEngine.getBrowserScanScript('active')` và không bỏ layout shift. Chỉ vòng sweep đa breakpoint (`:949`) truyền `skipLayoutShift: true`, có chủ đích (comment `:945-946`: việc đổi kích thước tự sinh ra shift).
  - Toàn bộ luồng `theme-qa-workflow.ts:660-900` chỉ chụp và quét trang ở trạng thái tĩnh vừa tải xong; không hề kích hoạt thử Mobile Menu drawer, Cart drawer, Search suggest dropdown, Quickview modal hay chuyển tab/variant.
  - Hơn nữa, hàm `freezeMedia` (`src/main/browser/scripts/injected-script-store.ts:268-303`) chỉ dừng CSS animation/transition và `window.Swiper`/`jQuery.fn.slick`, nhưng không dừng các vòng lặp `requestAnimationFrame` hoặc `setInterval` tùy chỉnh của theme.
  - **Telemetry:** Hàng loạt phản hồi của bạn trong `theme-sessions-digest.md` (`customizes-Whenever`, `customizes-TrueBeef`, `S2 Spa`, `Lux Wine`) nằm ở menu mobile khi mở ra bị lệch, popup giỏ hàng/search suggest bị tràn hoặc đè z-index — tất cả đều không được `theme.qa_validate` chạm tới.
- **Tác động:** Các thành phần tương tác quan trọng nhất của storefront (Menu, Giỏ hàng, Tìm kiếm, Quickview) hoàn toàn nằm ngoài vùng phủ tự động của `theme.qa_validate`.
- **Hướng cải tiến:**
  1. Thêm tùy chọn `probeInteractions?: boolean` vào `theme.qa_validate` / `theme.cockpit_scan`: tự động thử click mở nút Hamburger menu (ở viewport mobile 390px), nút Cart/Search (ở desktop/mobile), chạy nhanh `LayoutIntegrityEngine` trên trạng thái mở để bắt lỗi tràn ngang/đè chữ/z-index, rồi đóng lại.
  2. ~~Cho phép bật đo `layoutShift` thay vì gán cứng `skipLayoutShift: true`.~~ **[controller: bỏ, vì lần quét chính đã đo layout shift.]**
- **Effort:** `L` · **Confidence:** `HIGH`

#### `U-13` · `(4/5: A, C, D, E)` · **NEW** · `anti.inspect.responsive_matrix` làm rơi tham số `widths` tùy chỉnh và `device-presets.ts` bật `mobile: true` trên các preset tablet ngang
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/tools/browser-control-port.ts:7587` vs `src/main/tools/browser-capabilities.ts:2907-2916` & `scripts/antifan-omp-mcp.cjs:117`: `BrowserControlPort.inspectResponsiveMatrix` đã nhận `params: { selector?: string; widths?: number[]; tabId?: string }` (`:7587`) và mặc định dùng `RESPONSIVE_MATRIX_WIDTHS = [375, 430, 768, 1024, 1440]` (`:102`). Tuy nhiên `browser-capabilities.ts:2907-2916` và `antifan-omp-mcp.cjs:117` chỉ khai báo và chuyển tiếp `{ selector, tabId }`, làm rơi hoàn toàn tham số `widths`.
  - **[controller-sửa]** Ở `browser-control-port.ts:7587` không có `inspectResponsiveMatrix(params.widths)`. Host nhận `customBreakpoints` (`browser-control-port.ts:102`, `native-tab-host.ts:15062-15085`), còn capability `anti.inspect.responsive_matrix` (`browser-capabilities.ts:2907-2916`) chỉ chuyển tiếp `{ selector, tabId }`.
  - `src/main/browser/device-presets.ts:42-57`: Tất cả các preset nhóm `tablet`, bao gồm cả `tablet-landscape-1024` (`1024×768`) và `tablet-landscape-1280` (`1280×800`), đều được gán `mobile: true, maxTouchPoints: 5`. Trong Chromium CDP (`enableDeviceEmulation`), `mobile: true` kích hoạt chế độ co giãn `<meta name="viewport">` của điện thoại và tắt `:hover` chuột chuẩn, làm sai lệch bố cục khi bạn muốn kiểm tra màn hình laptop nhỏ / iPad ngang `1024px–1280px`.
  - **Telemetry [controller-sửa]:** `anti.browser.set_viewport` được gọi **240 lần** trong 52 phiên (`theme-sessions-digest.md:6`), so với **22 lần** `anti.inspect.responsive_matrix`. Agent tự gọi `set_viewport` + `evaluate` cho các mốc `390`, `770`, `991`, `1280`.
- **Tác động:** Tốn hàng trăm lượt gọi `set_viewport` rời rạc và dễ bỏ sót lỗi vỡ giao diện ở các điểm gãy trung gian (`768px–1024px`, `1280px`).
- **Hướng cải tiến:**
  1. Mở tham số `widths?: number[]` trong `inputSchema` và phần gọi hàm tại `src/main/tools/browser-capabilities.ts:2907-2916` cũng như `scripts/antifan-omp-mcp.cjs:117`.
  2. Trong `src/main/browser/device-presets.ts:56-57`, tách rõ preset laptop/desktop `1024px`/`1280px` (`mobile: false`) hoặc thêm tùy chọn bật/tắt touch emulation.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-14` · `(1/5: A)` · **NEW** · `LiquidErrorScanner` chỉ khớp mẫu lỗi tiếng Anh cơ bản, bỏ sót biến thể lỗi tiếng Việt / Sapo `.bwt` và dữ liệu JSON rò rỉ ra văn bản
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/qa/scanners/liquid-error-scanner.ts:36-43`: `ERROR_PATTERNS` chỉ có 4 mẫu: `/Liquid syntax error/i`, `/Liquid error.*Could not find asset/i`, `/translation missing:/i`, và `/Liquid error/i`, cộng với kiểm tra `{{` hoặc `{%` trong text node (`:52-55`).
  - Khi Haravan, Sapo (`.bwt`) hoặc app thứ ba xuất thông báo lỗi bằng tiếng Việt hoặc định dạng khác (ví dụ: `Không tìm thấy snippet`, `Lỗi Liquid`, chuỗi `null`/`undefined`/`[object Object]` in thẳng ra giá tiền hoặc tiêu đề sản phẩm, hoặc nội dung JSON của `{% schema %}` bị rò rỉ ra ngoài thẻ), `LiquidErrorScanner` không phát hiện được.
- **Tác động:** Agent có thể bỏ sót các lỗi render văn bản đặc thù của Haravan/Sapo Việt Nam nếu không nhìn ảnh chụp màn hình bằng mắt.
- **Hướng cải tiến:**
  1. Mở rộng `ERROR_PATTERNS` trong `src/main/qa/scanners/liquid-error-scanner.ts:36-43` để bắt thêm: `/Không tìm thấy (?:snippet|file|asset|template)/i`, `/Lỗi (?:Liquid|cú pháp)/i`, `/\[object Object\]/`, chuỗi giá tiền chứa `NaN` / `undefined₫`, và khối JSON `{"name":..."settings":` rò rỉ ra text node hiển thị.
- **Effort:** `S` · **Confidence:** `HIGH`

---

### T4 — Bề mặt Công cụ MCP cho Agent & Tốc độ Thực thi (Agent MCP Surface & Speed)

#### `U-15` · `(5/5: A, B, C, D, E)` · **NEW (latent)** · `checkRouteIdentity` nối nhầm `"https://"` vào đường dẫn tương đối (`expectedUrl: "/collections/all"`) **[controller: kết quả là `ROUTE_MISMATCH` về host, không phải `URL_PARSE_FAILED`]**
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/verification/visual-capture.ts:1325-1344` **[controller-sửa đường dẫn]**: Hàm chuẩn hóa URL viết:
    `const normalizeUrlInput = (u: string) => /^https?:\/\//i.test(u.trim()) ? u.trim() : 'https://' + u.trim();`
    Khi agent truyền đường dẫn tương đối như `expectedUrl: "/collections/all"`, hàm biến chuỗi đó thành `"https:///collections/all"`. `new URL(...)` **không ném lỗi** mà cho `host = 'collections'`, `pathname = '/all'` (đã thử bằng `node`), nên `:1359-1368` trả `ROUTE_MISMATCH` về host.
  - **Telemetry [controller-sửa]:** digest có **0** lần `URL_PARSE_FAILED` (mã này không tồn tại trong `src/`) và 0 lần "Requested host". Đây là bug tiềm ẩn, chưa xảy ra trong 52 phiên.
- **Tác động:** Bắt buộc agent phải biết đầy đủ tên miền preview/live của shop mỗi khi gọi `theme.qa_validate`, gây lỗi không đáng có khi kiểm tra các route chuẩn (`/`, `/collections/all`, `/cart`).
- **Hướng cải tiến:**
  1. Tại `src/main/verification/visual-capture.ts:1325-1344`, nếu `expectedUrl.trim().startsWith('/')`, phân giải đường dẫn tương đối theo `origin` của `observedUrl` (`new URL(expectedUrl.trim(), observedParsed.origin)`) trước khi so sánh `pathname`.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-16` · `(3/5: B, C, E)` · **NEW** · `normalizeThrown` biến các lỗi `Event` / `DOMException` trong `anti.browser.evaluate` thành `Error: CAPABILITY_ERROR: {}` mù thông tin
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/browser/tab-devtools-host.ts:289-314`: Trong hàm `normalizeThrown(err)`, khi mã JS chạy trong trang (`anti.browser.evaluate`) ném hoặc reject một đối tượng không phải `Error` chuẩn của context đó hoặc có thuộc tính nằm trên prototype không enumerable (ví dụ `Event` từ `img.onerror`, `DOMException`, hoặc `Response` của `fetch`), `typeof obj.message` không phải chuỗi nên code rơi xuống dòng `:301`: `const json = JSON.stringify(err); if (json && json !== 'null') return new Error(json);`. Vì `JSON.stringify(new Event('error'))` trả về chuỗi `'{}'`, hàm trả về `new Error('{}')` và `capability-transport.ts:39-40` giữ nguyên chuỗi `'{}'` (vì `message.length > 0`), trả về cho agent `Error: CAPABILITY_ERROR: {}`.
  - **[controller-sửa số dòng]** Nhánh `JSON.stringify(err)` nằm ở `tab-devtools-host.ts:297`, không phải `:301`. Với `Event`, `name` rỗng nên message thành `'{}'`.
  - Ngoài ra, tại `src/main/browser/tab-devtools-host.ts:232, 3203`, khi `evalJs` hết thời gian chờ (`DEFAULT_EVAL_TIMEOUT_MS = 15_000`), thông báo lỗi chỉ ghi `Script evaluation timed out after 15000ms` mà không kèm đoạn đầu của biểu thức JS bị treo.
  - **Telemetry [controller-sửa]:** digest có tổng **46** `CAPABILITY_ERROR` và **≥3 mẫu** `CAPABILITY_ERROR: {}` trên `anti.browser.evaluate` (`theme-sessions-digest.md:970-972`; err_samples có giới hạn), cùng **7** `EXECUTION_TIMEOUT`.
- **Tác động:** Khi script kiểm tra ảnh/fetch trong `evaluate` bị reject, agent chỉ nhận được `{}` rỗng, không biết lỗi gì nên phải viết lại script thử lại nhiều lần.
- **Hướng cải tiến:**
  1. Tại `src/main/browser/tab-devtools-host.ts:297`, khi `JSON.stringify(err)` cho ra `'{}'`/`'[]'`, dựng message từ `obj.constructor?.name`, `obj.type`, `obj.code`, `String(err)`.
  2. Trong `evalJs` (`:3203`), đính kèm 120 ký tự đầu của `expression` vào thông báo lỗi timeout.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-17` · `(3/5: A, D, E)` · **NEW** · Bề mặt MCP (`scripts/antifan-omp-mcp.cjs`) bỏ sót 15 công cụ theme/inspect đã đăng ký trong khi nạp 52 công cụ `core.*`/`device.*` hầu như không dùng
- **Bằng chứng (`path:line` & telemetry):**
  - `local://ultra-scout-controller-notes.md:5` & `scripts/check-mcp-budget-dominance.mjs:222-245`: `scripts/antifan-omp-mcp.cjs` hiện quảng cáo 142 công cụ, nhưng **bỏ sót 15 capability hữu ích đã được cài đặt sẵn trong `src/main/tools/`**: `anti.sheet.extract`, `anti.inspect.layout`, `anti.inspect.font`, `anti.theme.preview_css`, `browser.set-device-preset`, `theme.transaction.{begin,write_cas,settle,rollback,resolve_hold}`, `theme.qa_repair.{begin,verify}`, `theme.qa_rollback`, `anti.diagnostics.*`.
  - Nguyên nhân kỹ thuật (đã kiểm chứng tại `scripts/check-mcp-budget-dominance.mjs:222-245`): script kiểm tra lúc build chỉ kiểm tra chiều `advertised -> catalogue` (mọi tool có trong `antifan-omp-mcp.cjs` phải tồn tại trong `CapabilityCatalogue`), còn chiều ngược lại chỉ bắt buộc đối với nhóm `core.*`!
  - Ngược lại, 42 công cụ `core.*` và 10 công cụ `device.*` đang chiếm hơn 1/3 bảng định nghĩa MCP trong mọi phiên nhưng chỉ được gọi tổng cộng **4 lần** (`core_stats` 2, `core_find_similar` 2) và **0 lần** (`device.*`) trong suốt 52 phiên làm theme; trong khi `anti.browser.evaluate` phải gánh **2.124 lượt gọi** (50.8% tổng số lệnh MCP) để đo font, layout, đọc sheet.
- **Tác động:** Agent không nhìn thấy các công cụ chuyên dụng (`anti.sheet.extract`, `anti.inspect.layout`, `anti.inspect.font`, `browser.set-device-preset`) nên phải tự viết hàng nghìn đoạn JS `evaluate` thủ công tốn token và thời gian; trong khi ngữ cảnh prompt của mọi phiên lại bị phình to bởi 52 schema `core.*`/`device.*`.
- **Hướng cải tiến:**
  1. Quảng cáo bổ sung các công cụ phục vụ trực tiếp công việc theme vào `scripts/antifan-omp-mcp.cjs`: `anti.sheet.extract`, `anti.inspect.layout`, `anti.inspect.font`, `anti.theme.preview_css`, `browser.set-device-preset`, và bổ sung kiểm tra danh sách allowlist hai chiều trong `scripts/check-mcp-budget-dominance.mjs`.
  2. Thêm chế độ lọc theo profile công việc (ví dụ biến môi trường `ANTIFAN_MCP_PROFILE=theme` hoặc tự động ẩn bớt `core.*` nâng cao / `device.*` khi không có thiết bị iOS cắm vào) để giảm kích thước prompt công cụ.
- **Effort:** `M` · **Confidence:** `HIGH`

#### `U-18` · `(2/5: B, E)` · **REPEAT** · `anti.screenshot.viewport` bị chặn bởi `CAPTURE_NOT_READY` khi `docHeight` dao động nhẹ ~~và `setViewport` so sánh kích thước chưa làm tròn~~ **[controller: phần `setViewport` sai; số đúng là 8 lần `CAPTURE_NOT_READY`]**
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/verification/capture-settle.ts:559-610` & `theme-sessions-digest.md:7, 973`: `anti.screenshot.viewport` gặp **27 lỗi `CAPTURE_NOT_READY`** (chiếm 15% tổng số lỗi MCP trong 52 phiên). Ví dụ điển hình tại `digest:973`: `Pre-capture quiescence predicate 'layoutStable' failed on tab ... docHeight 3845 -> 3828, scrollWidth 390 -> 390`. Trên các trang storefront có slideshow tự chạy, marquee, hoặc sticky header co giãn, `docHeight` dao động 10–20px khiến phép chụp màn hình bị từ chối cứng dù agent chỉ cần chụp ảnh để quan sát nhanh.
  - **[controller-sửa]** Digest global ghi **8** `CAPTURE_NOT_READY` (cộng 19 `CAPTURE_FRAME_STARVATION`), không phải 27.
  - ~~`setViewport` (`:4822-4840`) so sánh `if (n1 !== n2)` trên giá trị thô, gây 6 lỗi `VIEWPORT_MISMATCH`.~~ **[controller: sai]** `mismatched()` (`browser-control-port.ts:4802-4817`) đã có dung sai `±1px`. Mã `VIEWPORT_MISMATCH` không tồn tại và digest không có lần nào; mã thật là `VIEWPORT_NOT_APPLIED` (3 lần).
- **Tác động [controller-sửa]:** Luồng chụp ảnh kiểm tra giao diện thất bại 8 lần (`CAPTURE_NOT_READY`) cộng 19 lần `CAPTURE_FRAME_STARVATION`, buộc agent phải gọi thêm `anti.media.freeze` rồi chụp lại.
- **Hướng cải tiến:**
  1. Trong `anti.screenshot.viewport` (`src/main/tools/browser-control-port.ts` / `capture-settle.ts`), nếu `letLayoutHold` thất bại lần đầu do `docHeight` dao động nhưng `scrollWidth` đã ổn định, tự động kích hoạt `freezeMedia` tạm thời rồi thử lại 1 lần (hoặc hỗ trợ cờ `allowDegraded: true` trả về ảnh chụp kèm cảnh báo `layoutUnstableWarning` khi không dùng làm bằng chứng đóng cổng QA).
  2. ~~Áp dụng `Math.round()` tại `browser-control-port.ts:4822-4840`.~~ **[controller: bỏ, vì `mismatched()` đã có dung sai ±1px.]**
- **Effort:** `S` · **Confidence:** `HIGH`

---

### T5 — Quy trình Đặc thù cho Customize Khách hàng & Phát triển Theme (Customer Customize & Theme Pipeline Specials)

#### `U-19` · `(4/5: A, C, D, E)` · **NEW** · `anti.sheet.extract` tách dòng CSV ngây thơ làm gãy các ô feedback nhiều dòng và thiếu công cụ cập nhật trạng thái lên Google Sheet
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/tools/browser-capabilities.ts:3448-3464, 3452`: Hàm `parseCsvRow` xử lý dấu ngoặc kép trên từng dòng đơn lẻ, nhưng ở `:3452` dữ liệu CSV trả về từ `/export?format=csv` lại bị cắt trước bằng `const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);`. Trong Google Sheet phản hồi của khách hàng (`Phukienmaymoc`, `Whenever`, `TrueBeef`, `Mnbakery`), cột mô tả lỗi gần như luôn có ký tự xuống dòng (`Alt+Enter` / `\n`) bên trong một ô có ngoặc kép `"..."`. Cách cắt `split(/\r?\n/)` trước khi parse trạng thái ngoặc kép làm 1 dòng feedback của khách bị xé thành 3–5 hàng giả bị lệch cột hoàn toàn.
  - **[controller-sửa số dòng]** Lệnh cắt dòng nằm trong script chạy trong trang: `browser-capabilities.ts:3529` (`csv.split(/\r?\n/)`), còn `parseCsvRow(line)` ở `:3509`.
  - Ngoài ra, để đánh dấu trạng thái `Stage = Done` và ghi `Dev-note` sau khi sửa xong (theo skill `google-sheet-feedback-row-marking`), agent hiện phải bấm từng ô trên DOM canvas của Google Sheet qua `evaluate` / `cursor.click` rất dễ trượt ô.
- **Tác động:** Ngay cả khi `anti.sheet.extract` được quảng cáo ra MCP (`U-17`), dữ liệu đọc về từ các bảng feedback nhiều dòng sẽ bị lệch cột và hỏng cấu trúc.
- **Hướng cải tiến:**
  1. Thay `text.split(/\r?\n/)` + `parseCsvRow` tại `src/main/tools/browser-capabilities.ts:3433-3464` bằng máy trạng thái (state machine) đọc CSV chuẩn RFC 4180 theo từng ký tự trên toàn bộ chuỗi `text` (chỉ ngắt hàng khi gặp `\r\n` hoặc `\n` nằm **ngoài** cặp ngoặc kép `inQuotes === false`).
  2. Bổ sung capability `anti.sheet.update_cell` (hoặc hỗ trợ chọn ô thông qua ô Name Box `input.waffle-name-box` của Google Sheet trên tab đang mở) để ghi giá trị vào đúng tọa độ ô (ví dụ `F12`, `G12`) một cách tất định.
- **Effort:** `S` (sửa bộ đọc CSV RFC 4180) / `M` (thêm `sheet.update_cell`) · **Confidence:** `HIGH`

#### `U-20` · `(4/5: A, C, D, E)` · **NEW** · `HaravanUploader.uploadImageToHaravan` chỉ là stub giả lập và thiếu MCP capability đẩy file/ảnh lên Haravan / Sapo / Shopify Admin Files
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/browser/haravan-uploader.ts:570-605`: Hàm `uploadImageToHaravan` ghi rõ trong comment (`:571-573, 583-585`): *"Simulated path only: no upload request is issued, the file is not stored anywhere"*, chỉ tạo một chuỗi giả `https://file.hstatic.net/200000000000/file/upload_${Date.now()}.png` và chép vào clipboard.
  - **Telemetry:** Trong các phiên customize và làm theme (`Phukienmaymoc`, `S2 Spa`, `Lux Wine`), agent phải gọi script ngoài qua `bash` (`curl` 61 lần trong digest) hoặc yêu cầu bạn lấy cookie/upload thủ công để có link CDN `hstatic.net`.
- **Tác động:** Gây hiểu nhầm nếu bấm nhầm tính năng upload trên menu chuột phải của trình duyệt AntiFan, và làm chậm quy trình thay banner/icon mới cho khách hàng trên Haravan/Sapo/Shopify.
- **Hướng cải tiến:**
  1. Cài đặt upload thật trong `HaravanUploader.uploadImageToHaravan` (`src/main/browser/haravan-uploader.ts:574`) hoặc cung cấp MCP capability `anti.theme.upload_asset`: tận dụng phiên đăng nhập sẵn có của tab Admin Haravan (`/admin/files` hoặc API upload multipart của shop hiện tại) để tải file từ workspace lên và trả về URL CDN `https://file.hstatic.net/...` thật.
- **Effort:** `M` · **Confidence:** `HIGH`

#### `U-21` · `(3/5: C, D, E)` · **NEW** · `AnnotationManager` không gọi `ThemeSourceMapper` (để `sourceHints` luôn rỗng trên Liquid/BWT) và `ThemeSourceMapper` bỏ qua file `.bwt` của Sapo
- **Bằng chứng (`path:line` & telemetry):**
  - `src/main/bridge/annotation-manager.ts:300-310`: Khi tạo prompt cho Element Picker (`processAnnotationPayload`), hàm chỉ đọc `payload.sourceHints` có sẵn từ trình duyệt (vốn chỉ có dữ liệu nếu trang web là React/Vue dev mode có gắn `data-source`), mà **không hề gọi** `ThemeSourceMapper.mapElementToSource(payload, payload.workspaceDir)` dù đã có sẵn cả `payload` lẫn `workspaceDir`.
  - `src/main/browser/theme-source-mapper.ts:376`: Hàm `collectLiquidFiles` chỉ nhận `entry.name.endsWith('.liquid')`, bỏ qua hoàn toàn các file `.bwt` của nền tảng **Sapo** cũng như các file `.css`/`.scss` trong `assets/`.
  - **Telemetry:** `local://ultra-scout-controller-notes.md:5` xác nhận công cụ `anti.theme.resolve_element` có **0 lượt gọi** trong 52 phiên; mỗi khi bạn dùng Element Picker chọn một phần tử để `[Direct-Edit]` hoặc `[[RUN]Super-Fast]`, agent phải tự chạy 3–8 lệnh `grep`/`read` để dò tìm file `.liquid` tương ứng.
- **Tác động:** Bỏ phí bộ `ThemeSourceMapper` đã viết sẵn trong codebase, làm tăng độ trễ (mất thêm нескольких vòng `grep`/`read`) trước khi agent tìm ra đúng dòng code `.liquid`/`.bwt` cần sửa.
- **Hướng cải tiến:**
  1. Trong `src/main/bridge/annotation-manager.ts:300-310`, nếu `payload.sourceHints` rỗng và `payload.workspaceDir` hợp lệ, gọi `ThemeSourceMapper.mapElementToSource(payload, payload.workspaceDir)` để điền tự động top 3 ứng viên `file:line` vào mục `Source Hints` của prompt Element Picker.
  2. Tại `src/main/browser/theme-source-mapper.ts:376`, mở rộng `collectLiquidFiles` để quét cả `.liquid` và `.bwt`.
- **Effort:** `S` · **Confidence:** `HIGH`

#### `U-22` · `(4/5: A, B, D, E)` · **NEW** · `compile-haravan-theme.mjs` và `tree-walker-sanitizer.ts` đóng cứng dữ liệu của shop `Hoplongtech` / `Phụ kiện máy móc`, và thiếu cổng kiểm tra độ khác biệt giữa các preset Devs2
- **Bằng chứng (`path:line` & telemetry):**
  - `scripts/compile-haravan-theme.mjs:950-989`: Đóng cứng logic thay thế `'info@hoplong.com' -> 'info@phukienmaymoc.com'` và `'Hoplongtech.com' -> 'Phụ kiện máy móc'` cho mọi thư mục đích không chứa chuỗi `'customizes/'` (`:951-966`), cùng 4 câu lệnh `assert` chuỗi cứng (`:985-989`).
  - `src/main/tools/adapters/tree-walker-sanitizer.ts:156-210, 480-500`: Bộ sanitize dùng chung của `anti.theme.export_clean` chèn `<style id="antifan-clone-parity">` (gồm `html, body { overflow-x: hidden !important }` và CSS riêng cho `#category-navigation__sub`) cùng script tương tác (login popup, `#suggest`) vào **mọi** export full-document, không lọc theo site. **[controller: file không có chuỗi "Omron"/"Schneider"; chi tiết đó sai.]**
  - **Telemetry:** Trong các phiên xây dựng chuỗi theme thương mại `themes-devs2-Haravan-*` (`S2 Spa`, `Lux Wine`, `S2 Rog Bike`, `S2 Timer Watch`), bạn nhiều lần phê bình agent làm preset mới *"y hệt bản cũ"* hoặc để sót tên thương hiệu/màu sắc của bản gốc (`digest:127, 456, 712`).
- **Tác động:** Làm nhiễm CSS/JS và dữ liệu của shop `Phụ kiện máy móc` / `HopLong` sang các dự án clone/theme khác khi dùng `anti.theme.export_clean` hoặc `compile-haravan-theme.mjs`, và thiếu công cụ tự động phát hiện việc agent copy nguyên xi preset cũ.
- **Hướng cải tiến:**
  1. Tách toàn bộ cấu hình thay thế chuỗi và script/style đặc thù của `HopLong` / `Phụ kiện máy móc` ra khỏi `src/main/tools/adapters/tree-walker-sanitizer.ts:161-200, 444-508` và `scripts/compile-haravan-theme.mjs:950-989` thành file cấu hình theo từng dự án (ví dụ `<workspaceRoot>/.antifan/clone-profile.json`).
  2. Thêm bước kiểm tra **Preset Differentiation Check** trong `theme-checks.mjs` (hoặc script kiểm tra Devs2): cảnh báo nếu `config/settings_data.json` hoặc CSS biến màu/font và cấu trúc `templates/index.liquid` trùng lặp quá ngưỡng (ví dụ `> 85%`) so với theme gốc hoặc còn chứa tên thương hiệu của preset khác.
- **Effort:** `M` · **Confidence:** `HIGH`

---

## Top 10 ưu tiên

Xếp hạng theo **Tác động × Tần suất xuất hiện thực tế** trong 52 phiên làm việc của bạn:

1. **`U-10` (`S`)** — Sửa `BrokenAssetScanner` (`src/main/qa/scanners/broken-asset-scanner.ts:68`) không bỏ qua ảnh `lazyload`/`data-src` bị kẹt hoặc 404 trong vùng nhìn thấy, chặn ngay lỗi ảnh sản phẩm/banner bị trắng mà QA vẫn báo PASS.
2. **`U-04` (`M`)** — Đồng bộ `theme.qa_validate` (`src/main/qa/theme-qa-workflow.ts:231`) với tiến trình upload của `hrv theme dev` / `shopify theme dev` (hoặc nâng ngưỡng chờ sau khi sửa `.liquid`/`.css`) để chấm dứt tình trạng quét nhầm DOM cũ và lỗi `aborted by document navigation`.
3. **`U-06` (`S`)** — Không gắn `SELF_QA_DIRECTIVE` (`src/shared/annotation-prompt.ts:303`, hằng ở `:74-86`) khi dùng chip Super-Fast, và mở rộng `QA_MICRO_STATIC` (`src/omp-hooks/theme-qa-gate.ts:185-191`) cho các chỉnh sửa văn bản `.liquid`/`.json` nhỏ (`<= 10` dòng).
4. **`U-21` (`S`)** — Gọi tự động `ThemeSourceMapper.mapElementToSource` trong `AnnotationManager` (`src/main/bridge/annotation-manager.ts:300-310`) và hỗ trợ file `.bwt` (`src/main/browser/theme-source-mapper.ts:376`) để mỗi lần chọn phần tử bằng Element Picker đều kèm sẵn gợi ý `file:line` chính xác.
5. **`U-09` (`S`)** — Cho phép `theme.cockpit_scan` (`src/main/tools/cockpit-capabilities.ts:250-272`) nhận tham số `url` hoặc tự động tìm link `/products/<handle>` đầu tiên trên trang thay vì ném lỗi `ROUTE_UNRESOLVED`.
6. **`U-15` & `U-16` (`S`)** — Sửa lỗi nối chuỗi `"https:///"` với đường dẫn tương đối trong `checkRouteIdentity` (`src/main/verification/visual-capture.ts:1325`), và sửa `normalizeThrown` (`src/main/browser/tab-devtools-host.ts:297`) để lỗi `CAPABILITY_ERROR: {}` có nội dung. **[controller: số đúng là ≥3 mẫu `{}`; `URL_PARSE_FAILED` = 0]**
7. **`U-17` & `U-19` (`M`)** — Quảng cáo `anti.sheet.extract`, `anti.inspect.layout`, `anti.inspect.font`, `anti.theme.preview_css`, `browser.set-device-preset` trong `scripts/antifan-omp-mcp.cjs`, và sửa bộ đọc CSV của `anti.sheet.extract` (`src/main/tools/browser-capabilities.ts:3529`) theo chuẩn RFC 4180 để hỗ trợ ô nhiều dòng.
8. **`U-11` (`M`)** — Bổ sung kiểm tra độ tương phản chữ/nền (`contrastRatio`) và méo tỷ lệ ảnh (`aspect-ratio`) vào `LayoutIntegrityEngine` (`src/main/qa/scanners/layout-integrity-engine.ts:325-435`).
9. ~~**`U-02`** &~~ **`U-01` (`S`)** — ~~Cho phép `assertTabScope` chấp nhận tab cùng project~~ **[controller: U-02 đã có cho capability đọc; phần còn lại là Câu hỏi mở 1]**. Xóa câu gợi ý gọi `terminal.create` tại `src/main/tools/terminal-capabilities.ts:188`.
10. **`U-07` & `U-05` (`M`)** — Thêm cổng kiểm tra nền tảng Haravan/Sapo/Shopify cho `theme.settings_check` (`src/main/tools/theme-transaction-capabilities.ts:440`), đọc kiểm tra thực tế `config/settings_data.json` (`scripts/lib/theme-checks.mjs:384`), và thêm `'specs'` vào `IGNORED_DIR_PATTERNS` (`src/main/server/preview-watcher-pool.ts:19-28`).

---

## Relevant Files

- `scripts/antifan-omp-mcp.cjs` — Bảng định nghĩa và định tuyến MCP stdio cho OMP; hiện thiếu 15 công cụ theme/inspect đã đăng ký (`U-13`, `U-17`).
- `scripts/check-mcp-budget-dominance.mjs` — Gate kiểm tra tính tương thích giữa `antifan-omp-mcp.cjs` và `CapabilityCatalogue` lúc compile (`U-17`).
- `scripts/lib/theme-checks.mjs` — Bộ kiểm tra tĩnh cho theme (`checkHaravanLiquidContracts`, `checkSettingsBinding`, `checkAssetReferences`); khai báo `settingsDataPath` tại `:384` nhưng chưa đọc (`U-07`).
- `scripts/compile-haravan-theme.mjs` — Script biên dịch theme Haravan; chứa logic đóng cứng của `Phukienmaymoc` / `Hoplongtech` tại `:950-989` (`U-22`).
- `src/main/tools/browser-capabilities.ts` — Đăng ký các capability trình duyệt, QA (`theme.qa_validate`), `anti.inspect.responsive_matrix` (`:2907-2916`, rơi `widths`) và `anti.sheet.extract` (`:3448-3562`, lỗi cắt dòng CSV) (`U-13`, `U-19`).
- `src/main/tools/cockpit-capabilities.ts` — Đăng ký `theme.cockpit_*`; chứa `resolveScanRoute` (`:250-272`) gây lỗi `ROUTE_UNRESOLVED` ở trang `product` (`U-09`).
- `src/main/tools/theme-transaction-capabilities.ts` — Đăng ký `theme.settings_check` (`:440-461`) gọi thẳng `checkHaravanLiquidContracts` không qua cổng kiểm tra nền tảng (`U-07`).
- `src/main/tools/terminal-capabilities.ts` — Đăng ký `terminal.*`; chứa thông báo `TERMINAL_FORBIDDEN` tại `:185-188` xúi agent gọi `terminal.create` (`U-01`).
- `src/main/tools/capability-catalogue.ts` — Kiểm soát phạm vi tab (`isTabAllowedForRetarget` tại `:206-222` và `assertTabScope` tại `:721-745`) (`U-02`).
- `src/main/tools/browser-control-port.ts` — Thực thi điều khiển trình duyệt: `resolveTargetContext` (`:2170-2188`), `setViewport` (`mismatched()` tại `:4802-4817`), `responsiveCheck` (`:4430`, nhận `customBreakpoints` tại `:102`) (`U-13`, `U-18`).
- `src/main/tools/adapters/tree-walker-sanitizer.ts` — Bộ làm sạch DOM cho `anti.theme.export_clean`; chèn style/script riêng của một site (HopLong) tại `:156-210, 480-500` (`U-22`).
- `src/main/qa/theme-qa-workflow.ts` — Luồng thực thi `theme.qa_validate` (`DEFAULT_FS_QUIESCENCE_MS = 150` tại `:231`, quét integrity chính tại `:912`, sweep đa breakpoint với `skipLayoutShift: true` tại `:949`, ghi `specs/qa-matrix.json` tại `:1687-1696`) (`U-04`, `U-05`, `U-12`).
- `src/main/qa/settings-ratchet.ts` — Cơ chế ratchet cho lỗi cấu hình theme và khởi tạo `.antifan/settings-baseline.json` (`U-08`).
- `src/main/qa/scanners/broken-asset-scanner.ts` — Quét ảnh và CSS vỡ; bỏ qua ảnh `lazyload`/`data-src` tại `:68` (`U-10`).
- `src/main/qa/scanners/layout-integrity-engine.ts` — Bộ kiểm tra bố cục trực quan; thiếu kiểm tra tương phản màu chữ (`contrastRatio`) và méo tỷ lệ ảnh (`U-11`, `U-12`).
- `src/main/qa/scanners/liquid-error-scanner.ts` — Quét lỗi cú pháp/render Liquid trên DOM (`:36-43`) (`U-14`).
- `src/main/verification/visual-capture.ts` — Kiểm tra đồng nhất URL (`checkRouteIdentity` tại `:1325-1368`) và chụp bằng chứng hình ảnh (`U-15`).
- `src/main/verification/capture-settle.ts` — Cơ chế chờ trang ổn định trước khi chụp (`letLayoutHold` tại `:559-610`) (`U-18`).
- `src/main/browser/tab-devtools-host.ts` — Thực thi `evalJs` qua CDP và chuẩn hóa lỗi (`normalizeThrown` tại `:289-314`) (`U-16`).
- `src/main/server/preview-watcher-pool.ts` — Theo dõi thay đổi file trong workspace để tự động reload preview (`IGNORED_DIR_PATTERNS` tại `:19-28`, debounce `150ms` tại `:72-116`) (`U-05`).
- `src/main/browser/native-tab-host.ts` — Quản lý vòng đời cửa sổ, tab và `dispatchScopedReload` (`:15595-15618`) (`U-05`).
- `src/main/browser/device-presets.ts` — Danh sách cấu hình thiết bị giả lập (`:42-57`) (`U-13`).
- `src/main/browser/theme-source-mapper.ts` — Ánh xạ phần tử DOM về file nguồn `.liquid` (`:154-279, 376`) (`U-21`).
- `src/main/browser/haravan-uploader.ts` — Công cụ upload ảnh lên Haravan (`:574-605`, hiện là stub giả lập) (`U-20`).
- `src/main/bridge/annotation-manager.ts` — Xử lý dữ liệu Element Picker và tạo file markdown trong `.antifan/annotations/` (`:108-120, 300-310`) (`U-06`, `U-21`).
- `src/shared/annotation-prompt.ts` — Khung prompt cho annotation (`SELF_QA_DIRECTIVE` tại `:74-86`, chèn qua `buildSelfQaDirective` tại `:303`) (`U-06`).
- `src/omp-hooks/edit-guard.ts` & `src/omp-hooks/theme-qa-gate.ts` — Hai hook kiểm soát quyền sửa file và cổng nghiệm thu QA cuối lượt của OMP (`U-06`, `U-08`).
- `src/renderer/toolbar.ts` & `package.json` — Giao diện thanh công cụ/MCP Hub và cấu hình script build (`U-03`, `U-09`).

---

## Câu hỏi còn mở

1. **Quyền đọc tab chéo giữa các dự án (`U-02`):** Khi bạn chủ động dán một `tabId` của cửa sổ khác (ví dụ tab Google Sheet chung, tab Figma hoặc tab shop mẫu) vào câu lệnh cho agent, bạn muốn AntiFan tự động cấp quyền **chỉ đọc (read-only)** cho `tabId` đó trong phạm vi lượt gọi mà không cần chuyển dự án của tab đó, hay vẫn giữ nguyên ranh giới chặn cứng `POLICY_DENIED` như hiện tại?
2. **Chính sách đối với `terminal.create` từ MCP (`U-01`):** Ngoài việc sửa thông báo lỗi tại `terminal-capabilities.ts:188`, bạn có muốn **khóa mặc định `terminal.create`** đối với MCP agent (vì OMP đã có `bash` tool riêng, còn `hrv theme dev` do bạn tự bật trong GUI), chỉ cho phép khi bật cờ cấu hình riêng không?
3. **Chế độ kiểm tra tương tác (Interactive Probe) trong `theme.qa_validate` (`U-12`):** Để giữ thời gian chạy `theme.qa_validate` thông thường nhanh gọn, bạn muốn bước tự động mở thử Mobile Menu / Cart Drawer / Search Suggest chỉ kích hoạt khi truyền cờ `probeInteractions: true` (hoặc khi chạy `theme.cockpit_scan`), hay chạy mặc định ở mỗi lần `theme.qa_validate`?
4. **Cơ chế upload file lên Haravan (`U-20`):** Bạn muốn hoàn thiện `HaravanUploader` / MCP tool theo hướng gửi multipart trực tiếp qua phiên cookie của tab Haravan Admin đang mở trong AntiFan, hay gọi qua Private App API token lưu trong cấu hình từng shop?

_Verifier receipt (trước hậu kiểm): `ultra: union=22/25 single_candidate_only=2`_

---

## Controller post-verification (HEAD `045f6d72`)

Controller đã đọc lại trên đĩa mọi mục `U-01`..`U-22` (grep/read trực tiếp, cộng một phép thử `node` cho `U-15`). Telemetry chuẩn là số liệu trong evidence packet (`local://ultra-scout-evidence-packet.md` §2, trùng khớp `theme-sessions-digest.md:5-12`). Nhiều con số verifier trích dẫn **không khớp** packet; bảng dưới thay thế chúng. Mục nào mâu thuẫn với phần này thì phần này thắng.

### A. Số liệu telemetry đã sửa

| Chỉ số | Verifier ghi | Thực tế (packet / digest:5-12) |
|---|---:|---:|
| `TARGET_MISMATCH` | 47 | **27** |
| `REVISION_STALE` | 17 | **14** |
| `POLICY_DENIED` | 5 | **1** |
| `CAPTURE_NOT_READY` | 27 ("15% lỗi") | **8** (cộng `CAPTURE_FRAME_STARVATION` 19) |
| `anti.inspect.responsive_matrix` | 3 lượt gọi | **22** lượt gọi |
| `theme.settings_check` | 13 lượt gọi | **20** lượt gọi (7 lỗi) |
| `CAPABILITY_ERROR: {}` | 16 | **≥3 mẫu** (`digest:970-972`, err_samples có giới hạn); tổng `CAPABILITY_ERROR` = 46 |
| `VIEWPORT_MISMATCH` | 6 | **0** (mã này không tồn tại trong `browser-control-port.ts`; mã thật là `VIEWPORT_NOT_APPLIED` = 3) |
| `URL_PARSE_FAILED` | 3 | **0** (mã không tồn tại trong `src/`) |
| `ROUTE_UNRESOLVED` | 3 | 1 ở dòng global, 3 dòng trong digest |

Thêm một tín hiệu verifier bỏ sót: `SELF_QA_DIRECTIVE` xuất hiện **15 lần** như một mã lỗi trong kết quả AntiFan, củng cố cho `U-06`.

### B. Phát hiện bị loại / hạ cấp sau hậu kiểm

1. **`U-02` → hạ thành câu hỏi mở, không còn là defect.** `capability-catalogue.ts:719-732` **đã** gọi `isTabAllowedForRetarget` cho capability `effect === 'read'` (trừ `risk === 'eval'`). Tab cùng project/workspace đọc được mà không cần rebind. Phần còn chặn (capability có effect và `anti.browser.evaluate` vì nó mang risk `eval`) là chủ đích; comment `:722-725` viết rõ: *"a foreign-but-affiliated tab can be observed but never driven without an explicit rebind"*. Vẫn còn `TARGET_MISMATCH` 27 và `rebind_target` 86. Có nới cho `evaluate` trên tab cùng project hay không là quyết định sản phẩm, xem Câu hỏi mở 1.
2. **`U-04` → sửa lại hướng.** Barrier đồng bộ CLI **đã có**: `HaravanSyncBarrier` (`src/main/qa/haravan-sync-barrier.ts:104`), được `theme-mutation-session.ts:71,217` và `theme-transaction-registry.ts:96` dùng. `theme-qa-workflow.ts:471-500` từ chối QA khi phiên mutation chưa `settled`. Khoảng trống thật là barrier này chỉ chạy qua `theme.transaction.*`, mà proxy OMP không quảng cáo nhóm đó (xem `U-17`). Vì vậy một edit thô (tool `edit`/`write` của OMP) rồi gọi `theme.qa_validate` chỉ chờ `DEFAULT_FS_QUIESCENCE_MS = 150` (`:231,608`). Nên **nối barrier có sẵn vào luồng edit thô hoặc quảng cáo `theme.transaction.*`**, không viết barrier mới.
3. **`U-05` → sửa đường dẫn và danh sách.** File đúng là `src/main/server/preview-watcher-pool.ts`, không phải `src/main/browser/`. `IGNORED_DIR_PATTERNS` (`:19-28`) gồm `node_modules`, `.git`, `.antifan`, `dist`, `build`, `.cache`, `.tmp*`; **không có** `.super-core`, `.compiled`, `reports` như verifier ghi. Kết luận "không loại `specs/`" vẫn đúng (`:80-99`: mọi file không bị lọc và không phải `.css` đều gây `full-reload`). Ảnh hưởng chỉ có khi có tab `antifan-preview://` của capsule đó (controller note 4).
4. **`U-06` → sửa số dòng.** `SELF_QA_DIRECTIVE` nằm ở `src/shared/annotation-prompt.ts:74-86`, được chèn qua `buildSelfQaDirective(intent, instruction)` tại `:303`. Hàm này **không nhận `actionChip`**. Trong khi đó `annotation-manager.ts:140` hứa với Super-Fast: *"no shell, no dispatch, no live-browser or QA round-trips"*. Mâu thuẫn được xác nhận.
5. **`U-08` → xác nhận và làm rõ.** Receipt **đã chứa** danh sách lỗi: `browser-capabilities.ts:1867-1869` ghi `findings: ratchetResult.newFailures`. Gate chỉ đọc số đếm (`theme-qa-gate.ts:1295-1298`). Sửa ở phía gate là đủ, không cần đổi schema receipt.
6. **`U-09` → giữ, ghi chú thiết kế.** `cockpit-capabilities.ts:252-257` ghi chủ đích *"a scan route is never fabricated"*. Truyền `url`/`handle` tường minh không phải là bịa route, nên hướng sửa 1 phù hợp thiết kế. Hướng 2 (tự chọn sản phẩm đầu tiên) cần đối chiếu với nguyên tắc đó.
7. **`U-12` → bỏ nửa về `layoutShift`.** Lần quét chính dùng `getBrowserScanScript('active')` (`theme-qa-workflow.ts:912`) và **không** bỏ qua layout shift. Chỉ vòng quét đa breakpoint (`:949`) truyền `skipLayoutShift: true`, và comment `:945-946` giải thích lý do (đổi kích thước tự sinh ra shift). Nửa "không thử trạng thái tương tác (menu, cart, search)" vẫn đúng: không có probe mở menu/drawer nào trong workflow hay scanner.
8. **`U-13` → sửa tên tham số.** Host nhận `customBreakpoints` (`browser-control-port.ts:102`, `native-tab-host.ts:15062-15085`), không phải `widths`, và không có hàm `inspectResponsiveMatrix` ở `:7587`. Phần `device-presets.ts:56-57` (`tablet-landscape-1024`/`1280` mang `mobile: true`) đúng.
9. **`U-14` (đơn ứng viên) → hạ độ tin cậy.** `liquid-error-scanner.ts:36-41` có 5 mẫu, tất cả bằng tiếng Anh. Việc Haravan/Sapo in lỗi Liquid bằng tiếng Việt là `[INFERENCE]`, chưa có mẫu nào trong digest. Riêng phần bắt `[object Object]`/`NaN`/`undefined` in ra text là bổ sung hợp lý. Ưu tiên thấp.
10. **`U-15` → bug có thật, nhưng chưa từng xảy ra.** File đúng là `src/main/verification/visual-capture.ts:1325`. Phép thử `node`: `new URL('https:///collections/all')` **không ném lỗi** mà cho `host = 'collections'`, `path = '/all'`. Kết quả thực tế là `ROUTE_MISMATCH` về host (`:1359-1368`), không phải `URL_PARSE_FAILED`. Digest có 0 lần `URL_PARSE_FAILED` và 0 lần "Requested host". Đây là bug tiềm ẩn, ưu tiên thấp.
11. **`U-16` → xác nhận cơ chế.** `NORMALIZE_THROWN_SOURCE` (`tab-devtools-host.ts:289-312`): với `Event`, `JSON.stringify` cho ra `'{}'` và `name` rỗng, nên message thành `'{}'`. Số dòng đúng là `:297`, không phải `:301`.
12. **`U-18` → bỏ nửa về `setViewport`.** `mismatched()` (`browser-control-port.ts:4802-4817`) đã có dung sai `±1px` cho cả `vw/vh`, `visualViewport` và `screen`. Khẳng định "so sánh giá trị thô chưa làm tròn" là **sai**. Giữ nửa `CAPTURE_NOT_READY`/`layoutStable` với số đúng là 8.
13. **`U-19` → sửa số dòng.** Lệnh cắt CSV nằm trong script chạy trong trang tại `browser-capabilities.ts:3529` (`csv.split(/\r?\n/)`), với `parseCsvRow(line)` ở `:3509`; không phải `:3452`.
14. **`U-22` → giữ, bỏ chi tiết sai, thêm một phát hiện.** `tree-walker-sanitizer.ts` không chứa chuỗi "Omron"/"Schneider" (grep 0 hit). Phần đúng: khối `#antifan-clone-parity` (`:156-210`) và script tương tác (login popup, `#suggest`, `#category-navigation__sub`, `:480-500`) được chèn vào **mọi** export full-document, không lọc theo site. Phát hiện thêm của controller: khối đó gồm `html, body { max-width: 100vw !important; overflow-x: hidden !important; }` (`:163`), nên **che mất lỗi tràn ngang** của mọi bản clone được export. `compile-haravan-theme.mjs` thay cứng HopLong → `info@phukienmaymoc.com` ở `:76-116, 406-408, 938`.
15. **`U-03` → làm rõ.** `hooks:check` (`package.json:23`, có hash `STALE` ở `install-omp-hooks.mjs:138-141`) đã tồn tại nhưng không nằm trong `compile`. Cách an toàn hơn là gọi `hooks:check` (không ghi gì) cuối `compile` để cảnh báo `STALE`, thay vì tự `--install` ghi vào `~/.omp`.
16. **`U-23` (controller khôi phục, HIGH) — `edit-guard` fetch `settings_data.json` rồi để `write` ghi đè ngay lên bản vừa fetch.** Verifier đã gộp phát hiện edit-guard của một candidate vào bảng "đã hoạt động đúng" (DG-05c). Đọc `src/omp-hooks/edit-guard.ts:450-476` thấy rằng ở lần ghi đầu tiên trong một run, hook chạy `hrv theme fetch --only config/settings_data.json` rồi `return` cho phép chính lệnh ghi đó. Nếu lệnh đó là `write` toàn file (nội dung dựng từ lần `read` trước khi fetch), nó ghi đè đúng các thay đổi merchant vừa tải về, tức là mất dữ liệu cấu hình của shop khách. `edit` dùng hash anchor thì an toàn vì anchor cũ sẽ không khớp. Hướng sửa: lưu bytes trước khi fetch; nếu sau fetch khác đi, chặn lần ghi với mã "settings_data.json đã đổi trên shop, đọc lại rồi ghi".

Các mục `U-01`, `U-07`, `U-10`, `U-11`, `U-17`, `U-20`, `U-21` khớp mã nguồn như verifier mô tả (đã grep/read lại).

### C. Thứ tự ưu tiên đã sửa (tác động × tần suất theo telemetry thật)

| # | Mục | Effort | Lý do xếp hạng |
|---:|---|:---:|---|
| 1 | `U-23` | S | Có thể mất dữ liệu cấu hình shop khách khi agent `write` `config/settings_data.json` (`edit-guard.ts:455-476`). |
| 1b | `U-17` (+ `U-04` đã sửa) | M | `evaluate` chiếm 2.124/4.180 lượt gọi. Proxy đang ẩn `anti.sheet.extract`, `anti.inspect.layout`/`font`, `browser.set-device-preset` và `theme.transaction.*` (nhóm này mang theo `HaravanSyncBarrier` có sẵn). |
| 2 | `U-10` | S | QA báo PASS dù ảnh lazy bị vỡ (`broken-asset-scanner.ts:52,62-69`). |
| 3 | `U-06` | S | `SELF_QA_DIRECTIVE` xuất hiện 15 lần như mã lỗi. Super-Fast hứa "không QA round-trip" nhưng directive bắt chạy QA 8 bước. |
| 4 | `U-07` | S–M | `theme.settings_check` có 20 lượt gọi, 7 lỗi, và luôn `ok:false` trên Shopify. |
| 5 | `U-21` | S | Element Picker không tự gợi ý `file:line`, dù `ThemeSourceMapper` đã có; chưa hỗ trợ `.bwt`. |
| 6 | `U-08` | S | Receipt đã có `findings`; gate chỉ in số đếm. |
| 7 | `U-19` | S | Sheet feedback có ô nhiều dòng bị cắt sai (`:3529`). |
| 8 | `U-16` | S | Lỗi `CAPABILITY_ERROR: {}` không mang thông tin. |
| 9 | `U-13` | S | Mở `customBreakpoints` (`set_viewport` 240 lần so với `responsive_matrix` 22 lần); preset tablet ngang đang `mobile:true`. |
| 10 | `U-22` | M | Export clone bị nhiễm CSS/JS của site khác và `overflow-x: hidden` che lỗi tràn. |
| — | `U-09`, `U-05`, `U-01`, `U-12` (probe tương tác), `U-11`, `U-20`, `U-03`, `U-18` (capture), `U-15`, `U-14` | | Theo thứ tự giảm dần. |

### D. Kiểm tra controller đã chạy

- `rg`/`read` trên 20+ anchor: `capability-catalogue.ts:699-753`, `theme-qa-workflow.ts:446-503,912,949`, `preview-watcher-pool.ts:19-28,72-116`, `broken-asset-scanner.ts:39-78`, `annotation-prompt.ts:55-100,303`, `theme-qa-gate.ts:1286-1313`, `cockpit-capabilities.ts:250-275`, `browser-control-port.ts:4798-4817`, `tree-walker-sanitizer.ts:140-165,480-500`, `tab-devtools-host.ts:289-312`, `device-presets.ts:42-57`, `liquid-error-scanner.ts:36-41`, `package.json:23-27`, `install-omp-hooks.mjs:138-141`.
- `node -e "new URL('https:///collections/all')"` cho ra `host=collections path=/all`.
- Đếm lại telemetry trong digest: `rg -c` cho `URL_PARSE_FAILED`/`VIEWPORT_MISMATCH`/`Requested host` đều bằng 0.

### E. Ghi chú phương pháp

- Đây là **same-tier best-of-5**: 5 candidate là agent `scout` cùng tier phiên; chỉ verifier chạy trên `kongming`. Không phải framework LLM-as-a-Verifier đầy đủ, không có điểm benchmark.
- Bảng nhãn (riêng tư): `A=UltraScoutC4`, `B=UltraScoutC1`, `C=UltraScoutC3`, `D=UltraScoutC2`, `E=UltraScoutC5`.
- Receipt của verifier trước hậu kiểm: `union=22/25`. Sau hậu kiểm: `U-02` chuyển thành câu hỏi mở; `U-14` và `U-15` vẫn giữ nhưng hạ ưu tiên; `U-23` (edit-guard) do controller khôi phục từ một candidate mà verifier đã loại ở DG-05c.

ultra: union=22/25 single_candidate_only=3 controller_restored=1
