# Problem-solving (ultra): fix bundle cho vòng làm theme của dev solo

**Ngày:** 2026-10-14 · **Base:** `HEAD 045f6d72` · **Đầu vào:** `plans/reports/scout-ultra-antifan-solo-theme-dev-261014.md` (U-01..U-23, U-02 chuyển thành câu hỏi mở).

## Chọn phương án (best-of-5, cùng tier)

5 ứng viên `scout` đọc chung một evidence packet; verifier `kongming` chọn một phương án theo rubric (khớp kỹ thuật, khả thi, sát vòng công việc, trung thực, chia nhóm file song song).

| Ứng viên | Điểm /100 | Lý do chính |
|---|---:|---|
| C (thắng) | 96 | Duy nhất thấy `ThemeTransactionRegistry.awaitSyncAndReload` chưa có capability, nên quảng cáo `theme.transaction.*` một mình không chạm được `HaravanSyncBarrier`; chia 4 nhóm file rời nhau |
| B | 90 | Thiếu `await_sync_and_reload`; dùng `widths` thay vì `customBreakpoints` |
| A | 88 | Như B; bảng phân làn mâu thuẫn chủ sở hữu file |
| E | 81 | Schema proxy sai với catalogue (gãy `check-mcp-budget-dominance`), bịa hành vi `hooks:check` |
| D | 76 | Nới `MICRO_PATH_RE` cho `.liquid`/`.bwt`, phá gate Red Team |

Kỹ thuật được chọn: Meta-Pattern Recognition. Cùng một mẫu lặp lại ở 5 miền: engine đã có (`hrv theme fetch` trong edit-guard, `HaravanSyncBarrier`, `ThemeSourceMapper`, `customBreakpoints`, `settingsRatchet.findings`), nhưng lớp adapter cuối bỏ rơi tham số hoặc không quảng cáo, nên agent tự viết lại bằng `anti.browser.evaluate` (2.124/4.180 lượt gọi).

## Triển khai

| Nhóm | File | Fix |
|---|---|---|
| A — OMP hooks | `src/omp-hooks/edit-guard{,-policy}.ts`, `theme-qa-gate.ts` | U-23 chặn ghi khi fetch trước-ghi đổi `settings_data.json`; U-08 liệt kê finding settings |
| B — MCP surface & offline checks | `scripts/antifan-omp-mcp.cjs`, `check-mcp-budget-dominance.mjs`, `scripts/lib/theme-checks.mjs`, `src/main/tools/{browser,cockpit,theme-transaction}-capabilities.ts` | U-17/U-04, U-07, U-19, U-13 (phần capability), U-09 |
| C — Element Picker | `src/shared/annotation-prompt.ts`, `src/main/bridge/annotation-manager.ts`, `src/main/browser/theme-source-mapper.ts` | U-06, U-21 |
| D — scanner/eval/sanitizer/watcher/terminal | `broken-asset-scanner.ts`, `tab-devtools-host.ts`, `tree-walker-sanitizer.ts`, `preview-watcher-pool.ts`, `terminal-capabilities.ts` | U-10, U-16, U-22, U-05, U-01 |

## Controller corrections

1. **Nhóm C do controller tự làm.** Prompt giao việc chứa nguyên văn tag Super-Fast trong ngoặc vuông, nên edit-guard của subagent tự bật chế độ fast và chặn mọi `edit` (`REFUSED_EDIT_SCOPE`); tin IRC không mang `event.prompt` nên không gỡ được. Controller áp các thay đổi trực tiếp. Hệ quả cần nhớ: edit-guard bật chế độ theo bất kỳ tag mode nào xuất hiện nguyên văn trong prompt, kể cả brief giao cho subagent. Prompt điều phối phải nhắc tới tag một cách gián tiếp.
2. **Bỏ `mobile: false` cho `tablet-landscape-1024/1280` (`device-presets.ts:56-57`).** Tablet thật vẫn là thiết bị mobile (touch, meta viewport). Các preset iPad cùng dải rộng (`device-presets.ts:42-46`, 1024–1376 px) đều `mobile: true`, nên chỉ đổi preset Android ngang sẽ làm hai nhóm lệch nhau. Không có telemetry nào cho thấy lỗi.
3. **Mapper chỉ quét thư mục theme** (`layout/ templates/ sections/ snippets/ blocks/`, quét toàn root chỉ khi không có thư mục nào trong số đó). Smoke trên `E:/Work/customizes/Mnbakery` trước sửa: trỏ nhầm `scratch/backup-audit-20260813-v2/aug09/snippets/article-loop.liquid` (bản sao hoà điểm, thắng theo thứ tự tên), 657 file, 957 ms. Sau sửa: `snippets/article-loop.liquid`, 156 file, 135 ms. Test hồi quy fail trước sửa (đã chạy với file mapper bị stash), pass sau sửa.
4. **Section Shopify không có `{% schema %}` là hợp lệ** trong `validateThemeSchemas` khi `platform === 'shopify'` (Section Rendering API: `predictive-search`, `pickup-availability`…). Smoke `theme.settings_check` trên `E:/Work/shopify`: HEAD trả 555 lỗi luật Haravan; sau Fix 5 còn 4 `SECTION_SCHEMA_MISSING` + 2 `SETTING_UNDECLARED`; sau sửa này còn 2 lỗi thật (`settings.header_menu`, `settings.social_linkedin_link` đọc trong snippet nhưng không có trong `settings_schema.json`).
5. **Annotation chỉ gọi mapper khi workspace có thư mục theme** (`themeSourceDirs`). Lý do: mapper đọc file đồng bộ trong Main. Bản đầu gate theo `PlatformDetector.detect`, nhưng hàm này trả nền tảng runtime khi URL là myharavan, nên workspace không phải theme vẫn bị quét toàn root. Probe: `detect(plain, myharavan URL)` = `haravan`, mapper tìm ra `vendor/price.liquid`. Khi các ứng viên hoà điểm, mapper không chọn primary; annotation không còn lấy `candidates[0]` làm "Suggested Source File" mà liệt kê ứng viên và ghi "No single owner file". Dòng gợi ý lấy từ evidence của chính file sở hữu (`render_edge` trỏ vào dòng của file cha). Test mới: ca hoà điểm và ca workspace không phải theme với URL Haravan.
6. **Test RFC-4180 của nhóm B** so sánh mảng từ `vm.runInNewContext` (realm khác) nên `deepStrictEqual` fail; mock `evalJs` giờ trả bản serialize như `executeJavaScript` thật.
7. **Test cockpit của nhóm B** gõ `qaOpts.workspaceRoot` trong khi port khai báo `options?`; typecheck đỏ, đã sửa.

## Kiểm chứng

- `npm run typecheck` sạch; `npm run compile` exit 0 (gồm `check-mcp-budget-dominance`, `check-mcp-dispatch-payload`).
- Lần chạy cuối, sau khi sửa mapper và test flaky: `npm run compile` exit 0; `test:main` pass 2509/2509; `test:fast` pass 1927/1927, chạy tuần tự.
- Các lần chạy `test:fast` trước đó mỗi lần có 1 test fail; cả hai đều có sẵn từ trước bundle này:
  - `theme-qa-gate-hook.test.mjs` (#49 "receipt one level under…", #57 "formats reminder when receipt has settings regression"). Nguyên nhân: test ghi receipt ngay sau lệnh edit, còn `reconcileReceipts` (`theme-qa-gate.ts:737`) so `mtimeMs >= editTs`. Probe trên máy này: file ghi ngay sau `Date.now()` có mtime sớm hơn trong 563/2000 lần, lệch tối đa 6,75 ms. Ở #57, hai receipt ghi liền nhau còn có thể trùng mtime. Worktree `HEAD 045f6d72` tái hiện #49 fail 1/8 lần. Đã sửa test: `fs.utimesSync` đặt mtime tăng dần, sau thời điểm edit (giống các test mới ở cuối file). Assertion giữ nguyên. Sau sửa chạy cả file 15 lần: 0 lần fail. Production không bị ảnh hưởng vì QA chạy vài giây sau lần edit.
  - `core-health-cli-deadline.test.js`: phụ thuộc tải máy (đã ghi nhận từ trước); chạy riêng thì pass.
- Smoke `E:/Work/scratch/ultra-scout-261014/smoke.cjs` (đã xoá sau khi chạy): `theme.transaction.await_sync_and_reload` đăng ký trong `ControlPlaneRuntime`; số liệu `settings_check` và mapper như mục 3–4; brief `[🚀Super-Fast]` mang `SELF_QA_DIRECTIVE_FAST` và không còn directive QA 8 bước.

## Kiểm chứng live sau restart (2026-10-14)

Restart Main theo yêu cầu người dùng: PID 2532 → 23936, cổng bridge 20130 lên lại sau 9 s, daemon-host 10416 vẫn sống, `daemon.log` ghi client kết nối lại. Hook OMP: `hooks:check` báo cả 3 hook `IN_SYNC`.

Kiểm bằng proxy stdio `antifan-agent.cjs` mở mới (cùng đường với phiên OMP mới) trên một tab tạm của project Timer Watch. Tab tạm đã đóng sau khi kiểm.

| Mục | Kết quả live |
|---|---|
| U-17/U-04 quảng cáo | `tools/list` = 153; có `anti.sheet.extract`, `anti.inspect.layout/font`, `browser.set-device-preset`, `browser.list-device-presets`, đủ 6 `theme.transaction.*`; không còn `anti.theme.preview_css`; `responsive_matrix` có `customBreakpoints`; `cockpit_scan` có `url` |
| U-04 dùng được | **Không.** `await_sync_and_reload` từ attachment project Timer Watch → `WORKSPACE_UNBOUND: Project tenancy mismatch … expected "project-00000000-…-000000000001"`. `ThemeTransactionRegistry` dựng một lần trong `ControlPlaneRuntime` với tenancy của project boot (`control-plane-runtime.ts:247`). `assertTenancy` (`theme-transaction-registry.ts:214`) nên từ chối mọi project khác, kể cả `begin` (`:79`). Lỗi có từ trước bundle, nhưng nó làm phần quảng cáo vô tác dụng. Cách sửa đụng ranh giới tenancy nên chờ người dùng quyết. |
| U-07 | `theme.settings_check` trên `E:/Work/shopify`: chỉ còn 2 lỗi thật (`header_menu`, `social_linkedin_link`); `haravanContracts` ok; 68 section ok. Trên `S2 Timer Watch` (Haravan): ok |
| U-16 | `evaluate` reject/throw object thuần → `CAPABILITY_ERROR: {"reason":"thrown-object"}` (trước là `{}`). Lưu ý: khoá tên `code` bị lớp redaction thay bằng `[REDACTED]` |
| U-13 | `responsive_matrix` đo 2 breakpoint riêng (1024 `mobile:true`, 1280) trong 1 lần gọi; sau đó tab trở về preset `responsive` |
| U-09 | `cockpit_scan {page:'product', url:'/products/…'}` điều hướng và trả PASS; URL khác origin bị từ chối |
| U-01 | `terminal.resize` vào terminal người dùng → `TERMINAL_FORBIDDEN`, thông báo hướng sang `terminal.wait`/`terminal.list` |
| U-22 | `export_clean` trang sản phẩm Timer Watch: 0 lần xuất hiện `antifan-clone-parity`, `category-navigation__sub`, `overflow-x: hidden !important` |
| U-10 | Trang thật (Timer Watch 58 ảnh, Mnbakery 87 ảnh/31 lazy): HEAD và bản mới đều 0 finding, không báo nhầm. Fixture chèn rồi gỡ trong cùng một lệnh evaluate: bản mới bắt ảnh `data-src` chứa lỗi Liquid và ảnh trong viewport kẹt chưa nạp, bỏ qua ảnh lazy dưới màn hình; HEAD bỏ sót cả hai |
| U-19 | **Chưa đúng trên sheet thật, đã sửa thêm.** GViz không có `headers=0` gộp 49 dòng đầu thành header, nên `row: 34` trả dữ liệu dòng khác. Đã thêm `headers=0` và giữ dòng trống giữa dữ liệu. Script mới chạy trên sheet Mnbakery: dòng 1, 2, 34, 120 khớp đúng GViz `range=A<N>`; 382 dòng. Test mới fail khi bỏ `headers=0`. Live app cần restart lần nữa mới nạp bản này |
| U-05, U-06, U-21 | Không có trigger MCP; kiểm trên module compiled mà app đã nạp. `specs/` không sinh sự kiện reload. Brief Super-Fast mang directive fast, không còn QA 8 bước. Mapper: Mnbakery → `snippets/article-loop.liquid` (HIGH, 235 ms); Shopify → `sections/announcement-bar.liquid`; S2 Spa (47 `.bwt`) quét được `.bwt` |
| U-23, U-08 | Hook chỉ nạp khi phiên OMP mở mới; chưa kiểm live vì kiểm U-23 cần `hrv theme fetch` ghi đè `settings_data.json` trong workspace shop thật. Phủ bằng unit test (edit-guard 34/34, gate 69/69) |

Sau khi sửa U-19: `npm run compile` exit 0; `test:main` pass 2509/2509; `test:fast` pass 1928/1928. Lần chạy `test:fast` đầu fail 1 test có sẵn (`run-state-service` #9, so mtime/size của file ghi lại trong cùng tick). Chạy riêng 3 lần đều pass, lần chạy lại cả lane cũng xanh.

Phát hiện thêm, có từ trước bundle và chưa sửa: trên Windows, sửa một file `.css` đã có sinh thêm sự kiện thư mục (`change:assets`). Vì vậy `PreviewWatcherPool` luôn gửi `full-reload` thay vì `css-swap` (`preview-watcher-pool.ts:98`).

## Vòng sửa thêm: `theme.transaction.*` theo từng project (2026-10-15)

Người dùng chọn sửa (hướng 1). `kongming` tư vấn thiết kế (CONDITIONAL GO); bản cài đặt giữ 1 registry cho cả runtime:

- `ThemeTransactionRegistry` (`src/main/qa/theme-transaction-registry.ts`): mỗi phiên lưu `owner` = tenancy đã `begin`; `writeCAS`/`awaitSyncAndReload`/`settle` chỉ cho chủ phiên. Người gọi có tenancy thiếu `projectId` hoặc `workspaceId` bị từ chối (trước đây trường rỗng lọt qua `assertTenancy`). Khoá xét chồng lấn root (cha/con), cả `isLocked` mà `file.write` dùng. Phiên của project đã đóng/detach (`isTenancyActive` do `ControlPlaneRuntime` cấp) có thể bị `rollback`/`resolve_hold` từ workspace chứa root đó. Thông báo `TRANSACTION_CONFLICT` không lộ session id của project khác.
- `theme-transaction-capabilities.ts`: root lấy từ workspace của người gọi (`resolveTenantWorkspaceRoot`, tách từ `file-capabilities.ts`); `workspaceRoot` truyền vào phải nằm trong đó sau realpath, nếu không → `OUTSIDE_WORKSPACE`. `begin` ghi đè `context.workspaceRoot` bằng root đã chuẩn hoá. Lỗi `PROJECT_MISMATCH`/`WORKSPACE_MISMATCH` đổi thành `WORKSPACE_UNBOUND: Project tenancy mismatch` để giữ hợp đồng mã lỗi cũ. `theme.settings_check` (chỉ đọc) vẫn nhận root bất kỳ; khi bỏ trống thì dùng workspace người gọi thay vì workspace boot.
- Test mới `theme-transaction-control-plane.test.ts` ("lets every project drive its own transaction…"): project thứ hai begin/ghi/rollback; root ngoài workspace bị chặn; workspace cha không điều khiển được phiên của chủ còn sống; root cha bị khoá bởi phiên ở root con (cả `file.write`); project chủ đóng thì workspace cha rollback được. Chạy trên registry ở `HEAD`: fail đúng lỗi live `Project tenancy mismatch`.

Kiểm chứng: `tsc` sạch; `npm run compile` exit 0; `test:main` 2510/2510; `test:fast` 1928/1928.

Restart Main lần 2: PID 23936 → 184 (bridge lên sau 19 s, daemon-host 10416 còn sống). PID 184 treo khoảng 00:44:50 (heartbeat cuối 17:44:49Z), Windows ghi `AppHangTransient` cho `electron.exe` lúc 00:45:23, daemon ghi client ngắt 17:45:27Z. Không có crash dump, không có sự kiện quit. Main 17312 mở lại từ `explorer.exe` lúc 00:45:29. Nguyên nhân treo chưa điều tra; lúc đó chưa có lệnh `theme.transaction.*` nào chạy.

Kiểm live trên Main 17312, proxy stdio mới, project Timer Watch, root tạm `S2 Timer Watch/.antifan/verify-tx-261015` (đã xoá):

| Mục | Kết quả live |
|---|---|
| `begin` trên root tạm | OK `tx-47dd7e1e` (trước: `WORKSPACE_UNBOUND`) |
| `begin` trên root Timer Watch khi root con đang giữ | `TRANSACTION_CONFLICT … locked by active transaction tx-47dd7e1e` |
| `begin` với `E:\Work\shopify` | `OUTSIDE_WORKSPACE` |
| `write_cas` R0→R1, rồi `rollback` | ghi được; `restoredFiles:["probe.txt"]`, file về `R0` |
| `await_sync_and_reload` khi không có giao dịch | `TRANSACTION_CONFLICT … no active transaction session` (trước: `WORKSPACE_UNBOUND`) |
| `anti.sheet.extract` sheet Mnbakery | `row:1` = dòng header; `row:34` = `Fixed / Bánh chi tiết / Sai đoạn design scroll carousel`, đúng dòng 34 |

ultra: winner=C rejected=4 controller_corrections=7
