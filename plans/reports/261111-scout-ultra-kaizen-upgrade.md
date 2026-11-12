# Kaizen & Upgrade — AntiFan Browser Desktop

- Ngày: 11/11/2026 · HEAD `b3864f6d` · Chế độ: `ak:scout --ultra` (5 ứng viên scout chỉ-đọc + 1 verifier, finalizer dạng union).
- **Đây là best-of-5 cùng bậc model**: transcript ghi cả 5 ứng viên và verifier đều chạy `anthropic/claude-sonnet-5-5`; controller chạy `claude-fable-5-2`. Không có lợi thế "verifier mạnh hơn"; bù lại controller tự đọc code cho 35/64 mục (cột "Controller đọc code").
- Không file nguồn nào bị sửa. Không compile, không test, không restart app. Mọi "code mới" là đề xuất chưa chạy.
- Kết quả: 121 finding đề xuất → 64 mục union (35 VALIDATED, 24 DOWNGRADED, 5 UNCHECKED), 1 mục bị loại; thêm 2 mục riêng của controller và 7 mục cấu hình agent.

`ultra: union=120/121 single_candidate_only=36`

## 1. Đánh giá tổng quan

Quy mô đo được: 578.828 dòng / 1.403 file (`src/main` 156.228 dòng, `test/main` 125.449, `scripts` 79.273, `test/unit` 65.343, `packages/site-clone` 39.882, `src/renderer` 29.426). Electron 43.7.9 + TypeScript 5.9.3, Node 24.13.0.

### Điểm mạnh
- **Tab duyệt web được hardening đủ bộ**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `allowRunningInsecureContent: false` — `src/main/security/security-policy.ts:128-141`.
- **Bridge mặc định chỉ loopback, cấm secret trong URL, mã pairing băm và chống replay** — `src/main/bridge/bridge-server.ts:1033-1047`, `:1127-1150`, `:2087-2101`.
- **TypeScript nghiêm**: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns` (`tsconfig.json:12-16`); 0 `@ts-ignore`/`@ts-expect-error` trong `src/`; chỉ 8 `TODO|FIXME|HACK`.
- **Nhật ký lifecycle dạng JSON-lines, ghi bất đồng bộ** — `src/main/diagnostics/main-lifecycle-log.ts:185-205`.
- **Sổ tự kiểm có predicate máy** (`npm run audit` → `scripts/check-bottlenecks.mjs`): lần chạy này bắt đúng 1 dòng lệch (B20).
- **Core SQLite có index cho bảng nóng** — `packages/super-core/src/schema.ts:154-160`, `:193-196`, `:206-207`, `:556-562`.
- **Prompt cache phía agent đã tốt**: Anthropic trúng 97–98% (7 ngày).

### Điểm yếu chí mạng (xử lý ngay)
1. **Phụ thuộc có lỗ hổng mà bản vá nằm ngay trong range**: 18 advisory (1 critical, 8 high); `electron` 43.7.9 và `@modelcontextprotocol/sdk` 1.30.0 dính high; Electron 43 hết hỗ trợ 05/01/2027 → K01, K18, K25.
2. **Bridge không kiểm `Host` header; `/api/pairing/challenge` nhận `GET` không cần token (chỉ từ loopback — `:1439-1443` trả 403 cho caller ngoài loopback)** — `bridge-server.ts:1030-1031`, `:1438-1476`. Rủi ro còn lại là DNS-rebinding hoặc tiến trình cục bộ, không phải pairing mở ra mạng → K02, K06.
3. **Các điểm fail-open âm thầm**: danh sách tool bị cấm parse lỗi thành vô hiệu (`scripts/antifan-omp-mcp.cjs:1497-1504`), workspace root lùi về `process.cwd()` (`src/main/tools/browser-capabilities.ts:1469-1475`), tập tab đang bị agent gắn trả về thiếu khi lỗi (`src/main/browser/native-tab-host.ts:10195-10207`); tổng cộng 891 `catch {}` rỗng trong 94 file `src/` → K03, K04, K12.
4. **Không có `setPermissionRequestHandler`**: Electron tự chấp thuận mọi yêu cầu quyền (camera, micro, vị trí, thông báo…) của mọi trang trong tab → K24.
5. **God file**: `native-tab-host.ts` 17.043 dòng, `browser-control-port.ts` 11.061, `standalone.js` 10.303, `toolbar.ts` 6.252, `browser-capabilities.ts` 6.191, `index.ts` 5.473 → K27, K51, K56, K61.
6. **Quan sát lỗi còn hở**: 269 `console.*` trong `src/main` song song với journal có cấu trúc; lỗi khởi động daemon terminal chỉ ra console (`src/main/index.ts:4084`); journal không redact ở sink → K09, K10, K16, K43.
7. **Chi phí agent**: advisor chiếm 33% chi phí danh nghĩa 7 ngày; một model fallback có cache hit 67% chiếm 66,8% input không cache; vai trò `slow` (kongming/verifier) trỏ cùng model với `task` → P4-1…P4-4.
8. **Vệ sinh repo**: dòng B21 còn mở (10 báo cáo rời + file tạm ở root được git theo dõi, `.canary/` 198 file tracked dù bị ignore) → CO-2.

## 2. Kế hoạch hành động Kaizen (dễ & quan trọng trước)

### 2.1 Nhóm cấu hình agent — không đụng code, làm được ngay (chi tiết ở mục 5)

| Mã | Việc | Tác động đo được (7 ngày) | Effort |
|---|---|---|---|
| P4-1 | Advisor review cuối run thay vì mỗi lượt, hạ `xhigh` → `high` | advisor = 54.238 request, 33,0% chi phí danh nghĩa | S |
| P4-2 | Bỏ `devin/swe-2-flash` khỏi advisor/fallback hoặc bật `appendOnlyContext` | cache hit 67,0%; 66,8% input không cache | S |
| P4-3 | `retry.fallbackOn: "usage-limit"` | bớt đổi model giữa phiên (chưa đo được tỷ lệ fallback) | S |
| P4-4 | Phân bậc `modelRoles`; `slow` trỏ model mạnh thật | verifier/kongming hiện cùng model với ứng viên | S |
| P4-5 | `defaultThinkingLevel: "high"` | ngân sách `max` = `xhigh` = 32.768 | S |
| P4-6 | Service tier: giữ `none` | 0 request dùng tier | — |
| P4-7 | Giảm số lần ghi cache và prefix cố định | ghi cache = 42,7% chi phí sonnet; prompt đầu phiên 109k token | S–M |

### 2.2 Nhóm code — 64 mục union theo thứ tự ưu tiên

| Hạng | Mã | Việc | Trụ cột | Effort | Impact | Verifier | Controller đọc code | Vị trí |
|---:|---|---|---|---|---|---|---|---|
| 1 | K01 | Nâng floor dependency trong range để đóng advisory high (electron, MCP SDK, ws, koffi, tldts) | T3 | S | High | VALIDATED | có | `package.json:104-121` |
| 2 | K02 | Bridge không kiểm tra Host header (DNS-rebinding) và /api/pairing/challenge nhận GET không cần token | T5 | S | High | VALIDATED | có | `src/main/bridge/bridge-server.ts:1028-1050,1438-1476,2084-2141` |
| 3 | K03 | ANTIFAN_FORBIDDEN_CAPABILITIES JSON hỏng thành danh sách vô hiệu (fail-open) | T5 | S | Med | VALIDATED | có | `scripts/antifan-omp-mcp.cjs:1478-1511` |
| 4 | K04 | Phân giải workspace root fail-open về process.cwd() ở 5 chỗ và 3 closure upload trùng | T5 | S | Med | DOWNGRADED | có | `src/main/tools/browser-capabilities.ts:1469-1475,1571-1577,2132-2139` |
| 5 | K05 | Handler HTTP bridge không có try/catch ngoài cùng; cookie decodeURIComponent lỗi làm treo request | T5 | S | Med | VALIDATED | có | `src/main/bridge/bridge-server.ts:1028-1031,4734-4737` |
| 6 | K06 | Origin check của WebSocket dựa vào Host do client gửi; LAN origin được qua kể cả khi lanOptIn tắt | T5 | S | Med | VALIDATED | có | `src/main/bridge/bridge-server.ts:2125-2141` |
| 7 | K07 | Hai đường chụp screenshot lớn gọi artifacts.stage đồng bộ, bỏ qua stageArtifact async | T2 | S | Med | DOWNGRADED | có | `src/main/tools/browser-control-port.ts:4422-4440,8543-8560` |
| 8 | K08 | Persist trạng thái terminal nuốt lỗi ghi đĩa, không log | T5 | S | Med | DOWNGRADED | có | `src/main/browser/terminal-manager.ts:1452-1453,1508-1514` |
| 9 | K09 | Lỗi khởi động quan trọng (daemon terminal lùi về in-process, migration cookie) chỉ ghi console.* | T5 | S | Med | VALIDATED | có | `src/main/index.ts:4083-4085` |
| 10 | K10 | Lifecycle journal không redact: 4 callsite ghi String(err) thô; chuyển redact xuống sink và tách khỏi bridge-server | T5 | S | Med | VALIDATED | — | `src/main/index.ts:3130,3148,3323,3751; src/main/diagnostics/main-lifecycle-log.ts:185-200` |
| 11 | K11 | Hàng B20 trong plans/bottlenecks.json lệch code: predicate trỏ chuỗi cũ và evidence 'không có tiled composite' đã sai | T1 | S | Med | VALIDATED | có | `plans/bottlenecks.json:319-333; scripts/check-bottlenecks.mjs:195-200; src/main/browser/tab-devtools-host.ts:3026,3139` |
| 12 | K12 | Hibernation fail-open: lỗi đọc registry attachment có thể khiến tab đang bị agent gắn bị unload | T5 | S | Med | DOWNGRADED | có | `src/main/browser/native-tab-host.ts:10195-10207,10227-10244,10391-10407,10429-10443` |
| 13 | K13 | contextPack kéo toàn bộ claim stale/aging (kèm statement) chỉ để đếm | T2 | S | Med | DOWNGRADED | có | `packages/super-core/src/index.ts:855,883-889,1332-1371` |
| 14 | K14 | knowledgeGaps chạy mỗi turn qua pack và N+1 truy vấn theo platform | T2 | S | Med | DOWNGRADED | có | `packages/super-core/src/index.ts:856,1421-1457` |
| 15 | K15 | taskkill đồng bộ không timeout trên main thread (chrome-profile-sync, codex backend, profile-ownership) | T2 | S | Med | VALIDATED | có | `src/main/browser/chrome-profile-sync.ts:457-468; src/main/agent/codex-execution-backend.ts:139-146` |
| 16 | K16 | Trường fields spread sau khóa lõi: pid của perf.hotProcess ghi đè pid Main trong main.log | T5 | S | Med | VALIDATED | có | `src/main/diagnostics/main-lifecycle-log.ts:185-200` |
| 17 | K17 | Pack Core chèn vào prompt mỗi turn bị nhiễu: gap NO_EVIDENCE toàn platform và JSON thụt lề | T4 | S | Med | DOWNGRADED | có | `.omp/hooks/pre/antifan-core-bridge.ts:966-1013` |
| 18 | K18 | Chưa có cổng npm audit; không nhận đề xuất hạ @electron/packager; chạy audit fix thường | T3 | S | Med | VALIDATED | có | `package.json:16-103 (khối scripts)` |
| 19 | K19 | Tham số chết staticTools và getStaticTools() ~440 dòng bị dựng rồi vứt mỗi listTools | T1 | S | Med | VALIDATED | có | `src/main/mcp/mcp-tool-list.ts:11; src/main/mcp/mcp-server.ts:57-500,516-524` |
| 20 | K20 | Core.invalidate/revoke: UPDATE từng dòng ngoài transaction, truy vấn OR không index trên evidence.path | T2 | S | Med | VALIDATED | có | `packages/super-core/src/index.ts:1084-1096,1145-1161; packages/super-core/src/schema.ts:206-207` |
| 21 | K21 | Gate check-mcp-budget-dominance chưa đo kích thước và tính xác định của tools/list | T4 | S | Med | VALIDATED | — | `scripts/check-mcp-budget-dominance.mjs:422-443` |
| 22 | K22 | Hook run-state ghi file đồng bộ (đọc lease, đọc mode, atomic write) ở mọi tool_call/tool_result | T4 | M | Med | DOWNGRADED | có | `src/omp-hooks/run-state.ts:377-405,724-769` |
| 23 | K23 | zod 3→4: chỉ một file dùng zod; z.record một tham số cần sửa | T3 | M | Med | VALIDATED | có | `src/main/workflow/workflow-schema.ts:345` |
| 24 | K24 | Không có setPermissionRequestHandler/CheckHandler cho phiên duyệt web | T5 | M | Med | DOWNGRADED | có | `src/main/browser/browser-session-partition.ts:135-165` |
| 25 | K25 | Lộ trình Electron 43→45 (node-pty, koffi, đóng gói, CDP) kèm TypeScript 7 | T3 | L | High | VALIDATED | — | `package.json:121,124; scripts/package-windows.mjs:30-106` |
| 26 | K26 | Ba view chrome chạy sandbox:false vì preload không được bundle | T5 | L | Med | VALIDATED | có | `src/main/browser/project-window-shell.ts:330-335,417-421,442-446` |
| 27 | K27 | Tách bảng CHROME_ROUTES (~100 route IPC) ra khỏi class NativeTabHost 15k dòng | T1 | L | Med | VALIDATED | — | `src/main/browser/native-tab-host.ts:2611-5445` |
| 28 | K28 | Ghim toolchain: @types/node khớp Node của Electron, thiếu engines, ghim typescript | T3 | S | Low | VALIDATED | có | `package.json:117-125` |
| 29 | K29 | WebSocketServer dựng 3 lần giống hệt, không đặt maxPayload | T5 | S | Low | DOWNGRADED | có | `src/main/bridge/bridge-server.ts:628-635,1987-1994,2018-2026` |
| 30 | K30 | So sánh token bridge bằng === (không constant-time) | T5 | S | Low | VALIDATED | có | `src/main/bridge/bridge-server.ts:1050,2105` |
| 31 | K31 | body += chunk ghép Buffer thành chuỗi ở hai route bridge (cắt ký tự UTF-8 ở ranh giới chunk) | T5 | S | Low | VALIDATED | có | `src/main/bridge/bridge-server.ts:1094-1104,1720-1730` |
| 32 | K32 | edit-guard.appendRows: mkdir + exists + stat + append mỗi lần ghi audit | T4 | S | Low | DOWNGRADED | — | `src/omp-hooks/edit-guard.ts:255-267` |
| 33 | K33 | leader-guard đọc và parse registry mỗi tool_call; findOpenJobs parse mọi job.json mỗi session_stop | T4 | S | Low | DOWNGRADED | có | `src/omp-hooks/leader-guard.ts:111-131,147-176` |
| 34 | K34 | edit-guard eval: gọi isLeaderWorker() (đọc registry) trước planEvalThemeCode thuần | T4 | S | Low | VALIDATED | — | `src/omp-hooks/edit-guard.ts:611-626` |
| 35 | K35 | Lỗi ghi audit log của edit-guard bị nuốt im lặng | T5 | S | Low | VALIDATED | — | `src/omp-hooks/edit-guard.ts:255-267` |
| 36 | K36 | listTools của proxy dựng lại schema và biên dịch RegExp mỗi lần gọi | T4 | S | Low | DOWNGRADED | có | `scripts/antifan-omp-mcp.cjs:4034-4043,1513-1522` |
| 37 | K37 | importScout prepare lại câu lệnh trong từng dòng JSONL (~12 bảng) | T2 | S | Low | VALIDATED | — | `packages/super-core/src/index.ts:402-467` |
| 38 | K38 | contextPack: unitPlatform N+1 truy vấn khi lọc unknowns theo platform | T2 | S | Low | DOWNGRADED | — | `packages/super-core/src/index.ts:526-530,818-823` |
| 39 | K39 | callTool dựng lại aliasMap ~105 mục mỗi lần; tra khóa prototype | T1 | S | Low | DOWNGRADED | — | `src/main/mcp/mcp-server.ts:526-634` |
| 40 | K40 | Mã chết: applyProtectedFileDacl và nhánh else-if enforceProtectedFileDacl trong bridge-server | T1 | S | Low | VALIDATED | có | `src/main/bridge/bridge-server.ts:137-151` |
| 41 | K41 | Băm lại file proxy ~150KB cho mỗi lần pairing | T2 | S | Low | DOWNGRADED | — | `src/main/bridge/bridge-server.ts:525-534` |
| 42 | K42 | Poll ack run-control dùng existsSync/readFileSync đồng bộ mỗi 100ms trên main | T2 | S | Low | DOWNGRADED | — | `src/main/browser/native-tab-host.ts:5215-5232` |
| 43 | K43 | Log hot-path và cảnh báo bằng console.* thay vì recordLifecycleEvent (persist tabs, eval soft budget) | T5 | S | Low | VALIDATED | — | `src/main/browser/native-tab-host.ts:15378,15426,15381,15429; src/main/browser/tab-devtools-host.ts:3949-3951` |
| 44 | K44 | persistRunIndex ghi lại toàn bộ index (pretty) sau mỗi artifact | T2 | S | Low | DOWNGRADED | có | `src/main/tools/artifact-store.ts:91-106` |
| 45 | K45 | Toolbar poll trạng thái điện thoại 10s vượt TTL cache 5s, quét USB mỗi nhịp kể cả khi cửa sổ ẩn | T2 | S | Low | VALIDATED | có | `src/renderer/toolbar.ts:5543-5545; src/main/browser/native-tab-host.ts:15778-15790` |
| 46 | K46 | theme-compiler resolveRealAsset: existsSync+statSync cho mỗi irAsset (O(refs×assets)) | T2 | S | Low | VALIDATED | — | `packages/site-clone/src/generators/theme-compiler.ts:215-226` |
| 47 | K47 | Hàm đọc registry Leader trùng giữa fleet-watch.mjs và leader-job.mjs (và biến thể readJson) | T1 | S | Low | VALIDATED | — | `scripts/leader/fleet-watch.mjs:67-78; scripts/leader/leader-job.mjs:1454-1466` |
| 48 | K48 | broadcastEvent cấp phát mảng bằng spread cho mỗi sự kiện terminal:session | T2 | S | Low | UNCHECKED | — | `src/main/bridge/bridge-server.ts:4545-4548` |
| 49 | K49 | Proxy: ANTIFAN_HOST không kiểm tra, hai nơi hardcode 127.0.0.1 trong khi pairing dùng candidate.host | T5 | S | Low | DOWNGRADED | — | `scripts/antifan-omp-mcp.cjs:395,2372,2624,2921,3784` |
| 50 | K50 | Ba bản inline 'gửi request chờ id' trong autoheal trong khi đã có wsRequest | T1 | S | Low | VALIDATED | — | `scripts/antifan-omp-mcp.cjs:2331-2352,2672-2699,2708-2731,2761-2790` |
| 51 | K51 | native-tab-host: realpath+isDirectory lặp 7 lần (một chỗ lệch .native) và existsSync(normalize) lặp 12 lần | T1 | S | Low | VALIDATED | — | `src/main/browser/native-tab-host.ts:1732-1736,3685-3689,4613-4617,4691-4695,4811-4815,4930-4934,15018-15022` |
| 52 | K52 | Bốn file src/renderer/*.js là bản sinh từ src/shared (không phải code trùng viết tay) | T1 | S | Low | DOWNGRADED | có | `scripts/copy-static.mjs:137-146; scripts/lib/generated-renderer-assets.cjs:7-12` |
| 53 | K53 | Thiếu index cho tra cứu nóng Core (claims.createdAt, conflicts.subject, packs.task) | T2 | S | Low | UNCHECKED | — | `packages/super-core/src/schema.ts:555-563; src/index.ts:747,1295,1316,1639` |
| 54 | K54 | Giảm bề mặt tools/list của proxy: ẩn tên legacy trùng schema, ẩn họ core.* hiếm dùng, profile env | T4 | M | Low | DOWNGRADED | — | `scripts/antifan-omp-mcp.cjs:90,157,171-231,4034-4043` |
| 55 | K55 | stage và stageAsync của artifact-store trùng ~130 dòng | T1 | M | Low | UNCHECKED | — | `src/main/tools/artifact-store.ts:346-598` |
| 56 | K56 | Mẫu đọc kết quả action lặp 8+ lần với as any trong browser-control-port | T1 | M | Low | UNCHECKED | — | `src/main/tools/browser-control-port.ts:7085-7226` |
| 57 | K57 | Heartbeat discovery 5s chạy ~10 syscall đồng bộ trên main | T2 | M | Low | VALIDATED | — | `src/main/bridge/bridge-server.ts:2286-2292,2394-2420,2430-2453,2476-2490` |
| 58 | K58 | Quét hàng đợi pairing bằng I/O đồng bộ sau mỗi lần claim | T2 | M | Low | UNCHECKED | — | `src/main/bridge/bridge-server.ts:749-773,812-840` |
| 59 | K59 | readChanges đọc và parse lại toàn bộ log edit-guard (tới 2 MiB) mỗi khi file đổi | T2 | M | Low | DOWNGRADED | — | `src/main/run/run-state-service.ts:591-653` |
| 60 | K60 | Đường dẫn E:/Work cứng ở ~14 file, thiếu cơ chế override đồng nhất | T5 | M | Low | VALIDATED | có | `src/main/index.ts:2252,4922; src/omp-hooks/leader-guard.ts:74,76,562-567` |
| 61 | K61 | 7 bản kiểm tra path-nằm-trong-root khác nhau; gom một helper | T1 | M | Low | DOWNGRADED | — | `src/main/server/safe-fs-resolver.ts:122-126; src/main/qa/theme-transaction-registry.ts:43-47` |
| 62 | K62 | tsconfig không bật noUnusedLocals/noUnusedParameters; thêm ratchet riêng | T1 | M | Low | VALIDATED | — | `tsconfig.json:12-16` |
| 63 | K63 | Bảng alias tool MCP ở 3 nơi (mcp-tool-list, mcp-server, proxy CAPABILITY_MAP) và nhân bản schema cho từng alias | T1 | M | Low | DOWNGRADED | — | `src/main/mcp/mcp-tool-list.ts:25-80; src/main/mcp/mcp-server.ts:527-633; scripts/antifan-omp-mcp.cjs:638-646` |
| 64 | K64 | AntiFanMcpServer không còn importer production: chuyển vào test/support | T1 | L | Low | VALIDATED | có | `src/main/mcp/mcp-server.ts:22` |

Gợi ý chia đợt: **Đợt 1 (trong ngày)** K01–K06, K16, K18; **Đợt 2 (trong tuần)** K07–K15, K17, K19–K24, CO-1; **Đợt 3 (có kế hoạch riêng)** K25 (Electron 43→44→45, TS 7), K26, K27; phần còn lại làm kèm khi chạm file.

## 3. Chi tiết 64 mục code (bản viết tốt nhất của ứng viên, giữ nguyên; ghi chú của verifier và controller đặt phía trên)

### K01 — Nâng floor dependency trong range để đóng advisory high (electron, MCP SDK, ws, koffi, tldts)

`U01` · Trụ cột T3 · Effort S · Impact High · Verifier: VALIDATED · Nguồn: A:F2, B:F4, C:F3, D:F17, E:F1 (bản viết dùng: B:F4)

> Lưu ý về code mới (verifier): Dùng npm update kèm nâng floor. KHÔNG chạy npm audit fix --force vì packager bị đề nghị hạ 18.4.4. Chạy smoke terminal vì node-pty và koffi là native.
> Hiệu chỉnh của controller: Số liệu do controller đo ngày 11/11/2026 bằng `npm outdated --json` và `npm audit --json` (18 lỗ hổng: 1 critical, 8 high, 9 moderate). Electron 43 hết hỗ trợ 05/01/2027 (endoflife.date qua web search — nguồn thứ cấp). Chạy trong worktree riêng: `node_modules` của cây chính đang được app live và các worktree khác dùng chung.

- [Trụ cột]: T3
- [Vị trí]: `package.json` — `dependencies`/`devDependencies`
- [Vấn đề]: theo packet §2.3, `electron` 43.7.9 nằm trong dải bị cảnh báo high (43.0.0-alpha.1 – 43.8.0, fix trong range là 43.8.8). `@modelcontextprotocol/sdk` 1.30.0 ≤ 1.31.0 high (fix trong range là 1.32.2). Còn `ws` 8.21.3→8.22.2, `koffi` 3.3.3→3.3.7, `tldts` 7.4.11→7.4.22. Bản MCP SDK này chạy trong tiến trình proxy mà agent nạp. 12 transitive (`proxy-addr` critical, `body-parser`, `undici`…) có `fixAvailable: true`. Chi tiết advisory là `[INFERENCE]`, vì tôi không đọc nội dung.
- [Code cũ] (`package.json`):
```json
    "@modelcontextprotocol/sdk": "^1.30.0",
    "koffi": "^3.3.3",
    "tldts": "^7.4.11",
    "ws": "^8.18.0",
```
- [Code mới]:
```json
    "@modelcontextprotocol/sdk": "^1.32.2",
    "koffi": "^3.3.7",
    "tldts": "^7.4.22",
    "ws": "^8.22.2",
```
- [Cấu hình nâng cấp]:
```
npm install @modelcontextprotocol/sdk@^1.32.2 ws@^8.22.2 koffi@^3.3.7 tldts@^7.4.22 --save
npm install electron@^43.8.8 @types/ws@^8.18.2 --save-dev
npm audit fix            # chỉ bản vá không semver-major. KHÔNG dùng --force: npm đề nghị hạ @electron/packager xuống 18.4.4
npm run compile && npm run test:main && npm run smoke:terminal
```
- [Lợi ích]: đóng cảnh báo high của Electron và MCP SDK. Giảm số vuln từ 18 xuống phần còn lại cần major bump (zod, packager).
- [Effort]: S · Impact: High · Risk: Thấp. Electron 43.7→43.8 cùng major. Gate `smoke:terminal` vì `node-pty` và `koffi` là native.
- [Bằng chứng]: `package.json` (đã đọc); số phiên bản lấy từ packet §2.3.

### K02 — Bridge không kiểm tra Host header (DNS-rebinding) và /api/pairing/challenge nhận GET không cần token

`U02` · Trụ cột T5 · Effort S · Impact High · Verifier: VALIDATED · Nguồn: C:F1 (bản viết dùng: C:F1)

> Ghi chú verifier: Fallback `|| 127.0.0.1` ở dòng 1030 và 2086 che mất trường hợp thiếu Host.
> Lưu ý về code mới (verifier): Khả năng khai thác thực tế (PNA trong Electron 43) vẫn là [INFERENCE]. Kiểm tra client companion/extension trước khi chặn mọi request có Origin trên route challenge. isAllowedHostHeader trả false khi Host rỗng cần test với proxy Node.
> Hiệu chỉnh của controller: Controller đã đọc `bridge-server.ts:1028-1050`, `:1438-1476`. Route challenge có chặn `if (!isLoopback)` → 403 (`:1439-1443`), nên "không cần token" chỉ đúng với caller loopback; đường tấn công còn lại là DNS-rebinding (vì `Host` do client gửi) hoặc một tiến trình cục bộ. Mức tác động thực tế theo controller là **Med**; mục này giữ hạng 2 vì bản sửa rẻ và chuẩn. Khả năng khai thác chưa được chứng minh. Trước khi loại mọi request có `Origin` ở route challenge, kiểm tra extension companion có gọi route này không.

- [Trụ cột]: T5
- [Vị trí]: `src/main/bridge/bridge-server.ts:1029-1046` (`createHttpHandler`), `:1438-1475` (route challenge), `:2085-2101` (WS `connection`)
- [Vấn đề]:
  - Grep `headers.host|isAllowedHost|rebind` trong `src/main` chỉ thấy `host` được dùng để dựng URL (`:1030`, `:2086`), không có allowlist. `docs/security-model.md` không có từ khóa `DNS|rebind|Host header|origin`.
  - Cổng loopback chỉ nhìn `remoteAddress` (`:1041-1043`), nên request từ trang web đã DNS-rebind vào 127.0.0.1 vẫn qua.
  - `/api/pairing/challenge` không cần token, nhận cả `GET`, và trả `code` pairing dùng được ở `/api/pairing/exchange` (`:1438-1475`). Một khi claim, file challenge bị rename/unlink (`:852-860`).
  - Hai caller trong repo đều dùng POST (`antifan-agent.cjs:363`, `antifan-omp-mcp.cjs:1999`), nên không cần GET.
  - `isAllowedOrigin` coi mọi `http://localhost:<port bất kỳ>` là hợp lệ (`:1058-1068`). Đây cũng là bề mặt có thể bị tận dụng.
  - Hậu quả chưa chạy thử: nếu rebinding hoặc fetch cross-origin tới loopback không bị Chromium chặn (Private Network Access, `[INFERENCE]`), trang bất kỳ trong tab có thể lấy mã pairing để mint attachment, hoặc rút cạn hàng đợi 16 challenge.
- [Code cũ] (`bridge-server.ts:1029-1032` và `:1438-1439`):
```ts
    return async (req, res) => {
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      const pathname = reqUrl.pathname;
...
      if (pathname === '/api/pairing/challenge' && (req.method === 'POST' || req.method === 'GET')) {
        if (!isLoopback) {
```
- [Code mới]:
```ts
  /** DNS-rebinding guard: without LAN opt-in the Host header must name the loopback listener. */
  private isAllowedHostHeader(hostHeader: string | undefined): boolean {
    if (this.lanOptIn) return true;
    if (!hostHeader) return false;
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return false;
    }
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  }
```
Trong `createHttpHandler`, ngay đầu handler (trước dòng `new URL`):
```ts
      if (!this.isAllowedHostHeader(req.headers.host)) {
        res.writeHead(421, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'HOST_NOT_ALLOWED', message: 'Host header must name the loopback listener.' }));
        return;
      }
```
Trong `wss.on('connection')`, sau khối loopback (`:2093-2101`):
```ts
      if (!this.isAllowedHostHeader(req.headers.host)) {
        ws.close(4003, 'Forbidden: Host not allowed');
        this.recordBridgeFailure('WS_AUTH_REFUSED', 'Forbidden: Host not allowed');
        return;
      }
```
Route challenge: chỉ POST và loại mọi request có `Origin` (client Node không gửi Origin):
```ts
      if (pathname === '/api/pairing/challenge' && req.method === 'POST') {
        if (!isLoopback || rawOrigin) {
```
- [Cấu hình nâng cấp]: không áp dụng. Thêm vào `docs/security-model.md` một mục "Host/Origin policy".
- [Lợi ích]: đóng đường rebinding và CSRF-GET vào bề mặt cấp quyền.
- [Effort]: S · Impact: High · Risk: các client LAN/mobile có `lanOptIn` giữ nguyên hành vi; probe `fetch` bằng `Host` tùy biến trong test sẽ phải đặt `Host: 127.0.0.1:<port>`.
- [Bằng chứng]: `bridge-server.ts:1029-1046`, `:1058-1068`, `:1438-1475`, `:2085-2101`, `:852-860`; `antifan-agent.cjs:363`; `antifan-omp-mcp.cjs:1999`; grep `headers.host` (chỉ `:1030`, `:2086`); `docs/security-model.md` grep rỗng. `[INFERENCE]` cho khả năng khai thác thực tế của rebinding/PNA trong Electron 43.

### K03 — ANTIFAN_FORBIDDEN_CAPABILITIES JSON hỏng thành danh sách vô hiệu (fail-open)

`U03` · Trụ cột T5 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: B:F2 (bản viết dùng: B:F2)

> Lưu ý về code mới (verifier): Trả ['*'] cho forbidden và ['!*'] cho allowed là đúng với isCapabilityPermitted:1538-1545. Cấu hình hỏng nay ẩn toàn bộ tool nên cần thông báo stderr rõ.

- [Trụ cột]: T5
- [Vị trí]: `scripts/antifan-omp-mcp.cjs:1497-1509` — `resolveForbiddenCapabilities`
- [Vấn đề]: giá trị bắt đầu bằng `[` nhưng JSON hỏng (ví dụ `["a","b"`) thì `JSON.parse` ném và `catch {}` nuốt. Code rơi xuống `raw.split(',')` và ra các pattern rác như `["a"`. `matchCapabilityPattern` (`:1514-1522`) không khớp tool nào, nên tool bị cấm vẫn được publish. `resolveAllowedCapabilities` (`:1478-1495`) có cùng lỗ hổng, nhưng ở đó pattern rác lại làm ẩn hết tool nên vô tình fail-closed. `isFixerSession` dựa vào bộ lọc này (`:1479-1481`).
- [Code cũ]:
```js
    const raw = process.env.ANTIFAN_FORBIDDEN_CAPABILITIES || process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES;
    try {
      if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch {}
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
```
- [Code mới]:
```js
// '*' forbids every tool: a policy that cannot be read must not publish the surface it was meant to cut.
function parseCapabilityList(raw, label) {
  const text = raw.trim();
  if (!text.startsWith('[')) return text.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) return parsed;
    throw new Error('expected a JSON array of strings');
  } catch (err) {
    process.stderr.write(`[antifan-mcp] ${label} is unreadable (${err.message}); refusing every capability\n`);
    return null;
  }
}
// in resolveForbiddenCapabilities:
    const raw = process.env.ANTIFAN_FORBIDDEN_CAPABILITIES || process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES;
    return parseCapabilityList(raw, 'ANTIFAN_FORBIDDEN_CAPABILITIES') ?? ['*'];
// in resolveAllowedCapabilities (same parser): ?? ['!*']
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: policy cắt bề mặt tool không bao giờ mở rộng âm thầm khi cấu hình hỏng.
- [Effort]: S · Impact: Med · Risk: Thấp. Một biến env hỏng giờ làm ẩn toàn bộ tool, nên cần thông báo stderr rõ.
- [Bằng chứng]: `antifan-omp-mcp.cjs:1478-1522`. `[INFERENCE]` về cách `callTool` dùng cùng bộ lọc, vì tôi chưa đọc thân `callTool`.

### K04 — Phân giải workspace root fail-open về process.cwd() ở 5 chỗ và 3 closure upload trùng

`U04` · Trụ cột T5 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: B:F1, B:F11 (bản viết dùng: B:F1)

> Ghi chú verifier: B ghi High, nhưng chính B thừa nhận dispatch đã resolve workspace trước execute nên nhánh catch hiếm xảy ra. Hạ về Med. Hai trong năm bản sao tôi chưa đọc (2370, 2399).
> Lưu ý về code mới (verifier): Helper bỏ `ws?.`: kiểm resolveAuthoritativeWorkspace không trả undefined. Single-tenant trả rootPath '' nên vẫn về cwd như cũ.

- [Trụ cột]: T5
- [Vị trí]: `src/main/tools/browser-capabilities.ts:1469-1475` (`expressionFile`), `:1571-1577` (`confinedOutputFile`, dùng cho `saveTo`), `:2133-2139`, `:2370-2376`, `:2399-2405` (upload)
- [Vấn đề]: khi `resolveAuthoritativeWorkspace` ném lỗi (`WORKSPACE_MISMATCH`/`PROJECT_MISMATCH`, `capability-catalogue.ts:583-598`), `catch {}` nuốt lỗi. `rootPath` giữ giá trị `process.cwd()` của Electron. Các đường ghi file và đọc `expressionFile` khi đó bị confine vào thư mục làm việc của app thay vì workspace của tenant. `file-capabilities.ts:14-53` có comment "Never fall back to global host/runtime workspace root" nhưng 5 chỗ này không dùng nó. Về khả năng chạm tới: `dispatchAuthenticated` đã gọi `resolveAuthoritativeWorkspace` trước (`capability-catalogue.ts:608`, `:689`), nên nhánh catch hiếm xảy ra. Đó là lý do lỗi tồn tại lâu mà không ai thấy. `[INFERENCE]` rằng `execute` luôn đi sau các dispatch đó.
- [Code cũ] (`browser-capabilities.ts:1469-1475`):
```ts
    let rootPath = process.cwd();
    if (context?.projectId && context?.workspaceId) {
      try {
        const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
        if (ws?.rootPath) rootPath = ws.rootPath;
      } catch {}
    }
```
- [Code mới] (một helper trong cùng closure, dùng ở cả 5 chỗ):
```ts
  /** Root of the request's authoritative workspace; undefined when the request names none.
   *  A named workspace that cannot be resolved is a refusal (the CapabilityError propagates), never a fallback. */
  const authoritativeRootOf = (context: CapabilityRequestContext | undefined): string | undefined => {
    if (!context?.projectId || !context?.workspaceId) return undefined;
    const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
    return typeof ws.rootPath === 'string' && ws.rootPath.trim().length > 0 ? ws.rootPath : undefined;
  };
  // expressionFile / confinedOutputFile:
  const rootPath = authoritativeRootOf(context) ?? process.cwd();
  // upload:
  const wsRoot = params.workspaceRoot || authoritativeRootOf(context);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: đóng đường ghi file ra ngoài workspace khi tra cứu workspace lỗi. Xóa 5 khối trùng. Cùng hành vi fail-closed với `file-capabilities.ts`.
- [Effort]: S · Impact: High · Risk: Thấp. Chế độ single-tenant trả `rootPath: ''` (`capability-catalogue.ts:603`) nên vẫn rơi về `cwd` như cũ. Cần chạy `test/main` của browser-capabilities.
- [Bằng chứng]: `browser-capabilities.ts:1461-1483`, `1564-1628`, `2124-2141`, `2361-2378`, `2391-2407`; `file-capabilities.ts:14-53`; `capability-catalogue.ts:583-609`.

### K05 — Handler HTTP bridge không có try/catch ngoài cùng; cookie decodeURIComponent lỗi làm treo request

`U05` · Trụ cột T5 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: C:F2 (bản viết dùng: C:F2)

> Lưu ý về code mới (verifier): Chưa kiểm recordLifecycleEvent đã import trong bridge-server. redactCredentials đã có ở dòng 122.
> Hiệu chỉnh của controller: `bridge-server.ts` hiện KHÔNG import `recordLifecycleEvent` (grep 0 hit) nên phải thêm import; `redactCredentials` có sẵn ở `:122`. `decodeURIComponent` ở `:4735`, `:4737` đã được đọc.

- [Trụ cột]: T5
- [Vị trí]: `bridge-server.ts:1029-1031` (`createHttpHandler`), `:4727-4740` (`extractAuthToken`)
- [Vấn đề]:
  - Handler là `async (req, res) => {...}` và server bỏ qua Promise trả về. Grep `^      (try \{|\} catch)` cho thấy không có `try` ở cấp thân handler (các `try` thấy được đều nằm ở hàm khác).
  - `new URL(req.url, 'http://'+host)` ném với Host có ký tự lạ. `decodeURIComponent` trong `extractAuthToken` ném `URIError` với cookie `antifan_mobile_token=%E0%A4%A`. Cả hai làm request treo không có phản hồi.
  - Lỗi chỉ xuất hiện ở `unhandledRejection`, và `index.ts:174-177` nuốt nó ngoài việc ghi log.
- [Code cũ] (`:1029-1031`, `:4734-4735`):
```ts
    return async (req, res) => {
      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const reqUrl = new URL(req.url || '/', `http://${host}`);
...
    const match = cookieHeader.match(/(?:^|;\s*)antifan_mobile_token=([^;]+)/);
    if (match && match[1]) return decodeURIComponent(match[1].trim());
```
- [Code mới]:
```ts
  private createHttpHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req, res) => {
      void this.handleHttpRequest(req, res).catch((err) => {
        recordLifecycleEvent('bridge.http.handler-failed', {
          method: req.method,
          detail: redactCredentials(String(err)),
        });
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'BRIDGE_INTERNAL_ERROR' }));
      });
    };
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // ...thân handler hiện tại, `return;` thay cho return trong closure...
  }
```
```ts
function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
// trong extractAuthToken: return safeDecode(match[1].trim());  (và nhánh antifan_attachment_secret)
```
Thêm `import { recordLifecycleEvent } from '../diagnostics/main-lifecycle-log';` vào bridge-server nếu chưa có (chưa kiểm tra).
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: không còn request treo, lỗi vào journal JSON có redact.
- [Effort]: S · Impact: Med · Risk: tách thân handler thành method làm diff lớn, nhưng thuần cơ học; test bridge hiện có chạy lại.
- [Bằng chứng]: `bridge-server.ts:1029-1031`, `:4727-4740`; grep `^      (try|} catch)` trong file; `index.ts:174-177`. Chưa dựng được request lỗi thật (`[INFERENCE]` về cách Node xử lý rejection của handler).

### K06 — Origin check của WebSocket dựa vào Host do client gửi; LAN origin được qua kể cả khi lanOptIn tắt

`U06` · Trụ cột T5 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: A:F4, E:F4 (bản viết dùng: A:F4)

> Ghi chú verifier: Nên gộp với U02 khi triển khai.
> Lưu ý về code mới (verifier): Check Origin chạy sau xác thực token (2104-2112) nên là defense-in-depth, không phải chiếm quyền. Cần thử client LAN dùng hostname mDNS. this.lanOptIn tồn tại ở dòng 357.

- [Trụ cột]: T5
- [Vị trí]: `src/main/bridge/bridge-server.ts:2086`, `2130-2135` (xử lý kết nối WS)
- [Vấn đề]:
  - `hostName` lấy từ `req.headers.host` (`:2086`, `:2130`). Điều kiện `originUrl.hostname === hostName` luôn đúng với trang DNS-rebinding, vì `Origin: http://evil.example:port` và `Host: evil.example:port` trùng nhau.
  - Kiểm Origin chạy sau xác thực token (`:2104-2112`), nên đây là phòng thủ chiều sâu chứ chưa phải lỗ hổng chiếm quyền. Kẻ tấn công vẫn cần token.
  - Nhánh `getLocalLanIps().includes(...)` cho qua Origin LAN cả khi `lanOptIn` tắt.
  - Kết nối `ws.close` ở nhánh Origin chạy sau khi `socketBridgeTokens`/`socketAttachmentIds` đã được set. Các map này là `WeakMap`/`WeakSet` (`:325`, `353-355`) nên không rò.
- [Code cũ]:
```ts
          const [hostName] = host.split(':');
          const isAllowedOrigin =
            originUrl.hostname === 'localhost' ||
            originUrl.hostname === '127.0.0.1' ||
            originUrl.hostname === hostName ||
            getLocalLanIps().includes(originUrl.hostname);
```
- [Code mới]:
```ts
          const isAllowedOrigin =
            originUrl.hostname === 'localhost' ||
            originUrl.hostname === '127.0.0.1' ||
            originUrl.hostname === '[::1]' ||
            (this.lanOptIn && getLocalLanIps().includes(originUrl.hostname));
```
  (Chuyển khối kiểm Origin lên trước khối xác thực token, để socket từ Origin lạ không chạm `attachmentRegistry.verifyConnectionToken`.)
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: loại tiêu chí Origin tự-chứng-minh, gắn truy cập LAN vào cờ opt-in đã có.
- [Effort]: S · Impact: Med · Risk: Vừa. Nếu có client LAN truy cập bằng tên máy (mDNS) thay vì IP thì sẽ bị từ chối khi `lanOptIn` bật. Cần thử với app mobile (`/mobile`, `bridge-server.ts:1004-1006`).
- [Bằng chứng]: `bridge-server.ts:2084-2140`, `598-600`, `1002-1006`. `[INFERENCE]`: các client LAN thực tế gửi Origin dạng IP.

### K07 — Hai đường chụp screenshot lớn gọi artifacts.stage đồng bộ, bỏ qua stageArtifact async

`U07` · Trụ cột T2 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: B:F3 (bản viết dùng: B:F3)

> Ghi chú verifier: B ghi High; mỗi lần chặn khoảng chục đến vài chục ms tùy kích thước PNG, chưa đo, nên hạ về Med.
> Lưu ý về code mới (verifier): Đổi sang this.stageArtifact(...) khớp kiểu BrowserArtifactStageInput. Sau đó STAGE_BOUND_MS mới có tác dụng thật.

- [Trụ cột]: T2
- [Vị trí]: `src/main/tools/browser-control-port.ts:4423-4439` (full-page) và `:8545-8558` (verification screenshot). Helper chuẩn: `:2630-2641`.
- [Vấn đề]: helper `stageArtifact` ghi rõ lý do tồn tại: "capture buffers reach several megabytes, and the synchronous store write blocks the main thread" (`:2635-2636`). Hai đường này bọc `this.artifacts!.stage(...)` trong `async () =>`, nhưng thân hàm vẫn chạy đồng bộ: `writeFileSync`, `statSync`, `readFileSync` + sha256 nếu file đã tồn tại (`artifact-store.ts:396-398`, `421-422`), và `persistRunIndex` ghi đồng bộ toàn bộ index (`:465`). `budget.run(..., STAGE_BOUND_MS)` không thể ngắt một lời gọi đồng bộ. Đường nóng: mỗi lần agent gọi screenshot full-page hoặc verification, PNG tối đa 8 MB (`:8554`) hoặc `FULL_PAGE_ARTIFACT_MAX_BYTES`. `stageAsync` đã được dùng ở `artifact-capabilities.ts:228` và `ios-device-adapter.ts:304`.
- [Code cũ] (`:4423-4439`):
```ts
    const artifactRef = this.artifacts
      ? await budget.run(
          'stage full-page',
          async () =>
            this.artifacts!.stage({
              kind: 'screenshot',
              mime,
              data: bytes,
              runId,
              attemptId,
              projectId: target.projectId,
              workspaceId: target.workspaceId,
              maxBytes: FULL_PAGE_ARTIFACT_MAX_BYTES,
              leaseToken,
              overflowMode: 'reject',
            }),
          STAGE_BOUND_MS
        )
      : limit(envelope.data, FULL_PAGE_ARTIFACT_MAX_BYTES);
```
- [Code mới] (cùng cách cho `:8547`):
```ts
    const artifactRef = this.artifacts
      ? await budget.run(
          'stage full-page',
          () =>
            this.stageArtifact({
              kind: 'screenshot',
              mime,
              data: bytes,
              runId,
              attemptId,
              projectId: target.projectId,
              workspaceId: target.workspaceId,
              maxBytes: FULL_PAGE_ARTIFACT_MAX_BYTES,
              leaseToken,
              overflowMode: 'reject',
            }),
          STAGE_BOUND_MS
        )
      : limit(envelope.data, FULL_PAGE_ARTIFACT_MAX_BYTES);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: không chặn event loop vài chục đến vài trăm ms mỗi ảnh lớn. `STAGE_BOUND_MS` bắt đầu có tác dụng thật.
- [Effort]: S · Impact: High · Risk: Thấp. `[INFERENCE]` rằng kiểu `BrowserArtifactStageInput` khớp literal. Chạy lại các test screenshot trong `test/main`.
- [Bằng chứng]: `browser-control-port.ts:2630-2641`, `4414-4443`, `8537-8563`; `artifact-store.ts:346`, `477`, `465`.

### K08 — Persist trạng thái terminal nuốt lỗi ghi đĩa, không log

`U08` · Trụ cột T5 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: D:F3 (bản viết dùng: D:F3)

> Ghi chú verifier: D ghi High; `err` bị bỏ hẳn là thật nhưng mất state chỉ khi ghi lỗi liên tiếp, nên hạ về Med.
> Lưu ý về code mới (verifier): Chuyển console.warn sang recordLifecycleEvent nếu import không tạo vòng. Reset khóa lỗi sau mỗi lần persist thành công.

- [Trụ cột]: T5
- [Vị trí]: `src/main/browser/terminal-manager.ts:1452-1453` (`persistAsync`) và `1508-1514` (`writePersistSync`)
- [Vấn đề]: khi ghi `terminal-state` lỗi (đĩa đầy, AV lock, `EPERM`), `catch (err)` chỉ dọn file tạm; `err` không được dùng. Không có log. Trạng thái bẩn vẫn nằm trong RAM và chỉ được thử lại khi có thay đổi sau đó. Repo đã có cảnh báo đĩa đầy (`index.ts:5102`), nên đây là kịch bản thật. Trong file này không có `recordLifecycleEvent`; chỗ duy nhất báo lỗi persist là `console.warn` ở dòng 1167, nên dùng cùng kênh đó.
- [Code cũ]:
```ts
      } catch (err) {
        await fs.promises.unlink(tempPath).catch(() => {});
      } finally {
```
```ts
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {}
    }
```
- [Code mới]:
```ts
  private lastPersistFailure = '';
  private reportPersistFailure(mode: 'async' | 'sync', err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const key = `${mode}:${message}`;
    if (key === this.lastPersistFailure) return; // một dòng cho mỗi lỗi khác nhau, không một dòng mỗi lần ghi
    this.lastPersistFailure = key;
    console.warn(`[terminal-manager] terminal state persist (${mode}) failed: ${message}`);
  }
```
```ts
      } catch (err) {
        this.reportPersistFailure('async', err);
        await fs.promises.unlink(tempPath).catch(() => {});
      } finally {
```
```ts
    } catch (err) {
      this.reportPersistFailure('sync', err);
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {}
    }
```
Đặt `this.lastPersistFailure = ''` ngay sau mỗi `this.clearDirtySessions(dirtySnapshot)` thành công, để lần lỗi sau lại được báo.
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: lỗi mất state terminal thành quan sát được thay vì im lặng.
- [Effort]: S · Impact: High · Risk: thấp.
- [Bằng chứng]: đọc raw `terminal-manager.ts:1450-1461`, `1503-1514`; `grep recordLifecycleEvent|main-lifecycle-log` trong file này = 0 hit.

### K09 — Lỗi khởi động quan trọng (daemon terminal lùi về in-process, migration cookie) chỉ ghi console.*

`U09` · Trụ cột T5 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: B:F9 (bản viết dùng: B:F9)

> Lưu ý về code mới (verifier): warnAndJournal dùng redactCredentials sẵn trong index.ts. Kiểm tra admitLine không loại bỏ sự kiện.
> Hiệu chỉnh của controller: Đã xác nhận `src/main/index.ts:4084` và `:4683` chỉ ghi `console.warn`.

- [Trụ cột]: T5
- [Vị trí]: `src/main/index.ts:4083-4085` (daemon terminal), `:4683` (migration cookie), `:1793` (kiểm tra không hoạt động); cùng kiểu ở `:2867`, `:4705`, `:4725`, `:4872`, `:4877`
- [Vấn đề]: `main-lifecycle-log.ts:6-11` ghi nhận rằng GUI mở từ Explorer/shortcut không có console nên các dòng `console.*` bị bỏ. Các nhánh trên ném lỗi hoặc rơi về chế độ yếu hơn mà không để lại vệt trong journal. Điển hình: daemon terminal lỗi thì TerminalManager chạy trong tiến trình GUI (`:4081-4084`), và khi GUI chết thì mọi terminal chết theo (comment `:4065`).
- [Code cũ]:
```ts
    } catch (err) {
      console.warn('[index] Failed to initialize Terminal Host Daemon, falling back to in-process:', err);
    } finally {
```
và
```ts
    .catch((err) => console.warn('[antifan] Capsule->profile migration failed:', err));
```
- [Code mới]:
```ts
function warnAndJournal(event: string, err: unknown): void {
  const detail = redactCredentials(err instanceof Error ? err.stack || err.message : String(err));
  console.warn(`[antifan] ${event}:`, detail);
  recordLifecycleEvent(event, { detail });
}
// :4083
    } catch (err) {
      warnAndJournal('terminal-daemon.init-failed', err);
    } finally {
// :4683
    .catch((err) => warnAndJournal('capsule-profile-migration.failed', err));
// :1793
      warnAndJournal('project-inactivity-check.failed', err);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: sự cố nghiêm trọng có dòng JSON-lines có timestamp, `redactCredentials` đã áp dụng. Truy vết được sau khi app tắt.
- [Effort]: S · Impact: Med · Risk: Thấp
- [Bằng chứng]: `index.ts:169-177`, `1788-1794`, `4062-4087`, `4676-4683`; `main-lifecycle-log.ts:6-11`, `263`.

### K10 — Lifecycle journal không redact: 4 callsite ghi String(err) thô; chuyển redact xuống sink và tách khỏi bridge-server

`U10` · Trụ cột T5 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: C:F5, D:F14 (bản viết dùng: D:F14)

> Lưu ý về code mới (verifier): redactFields chỉ xử lý trường chuỗi cấp một. Bản tối thiểu của C:F5 (bọc redactCredentials ở 4 callsite) làm được ngay. Chưa kiểm vòng import khi chuyển redactCredentials ra module riêng.

- [Trụ cột]: T5 (kèm T1)
- [Vị trí]: `src/main/diagnostics/main-lifecycle-log.ts:211-217` (`admitLine`); `src/main/bridge/bridge-server.ts:122-136`; callsite `src/main/index.ts:180-186`, `3130`, `3148`, `3323`, `3751`
- [Vấn đề]: redaction chỉ do từng callsite tự gọi, nên không đồng đều. `index.ts:2120` redact, nhưng `index.ts:3130`, `3148`, `3323`, `3751` ghi `detail: String(err)` thô ngay trên cùng khối mà `return` bên dưới lại redact. `render-process-gone` ghi `url: webContents?.getURL?.()` thô (có thể chứa query nhạy cảm: `[INFERENCE]`). `main-lifecycle-log.ts` không có từ khóa `redact` nào (grep). Hàm redact lại sống trong `bridge-server.ts` (4774 dòng, kéo cả `NativeTabHost`) nên `main-lifecycle-log` không thể import mà không tạo phụ thuộc vòng.
- [Code cũ]:
```ts
function admitLine(event: string, fields: Record<string, unknown> | undefined): string | null {
  initLogFile();
  if (!logFile) return null;
  const record = formatLifecycleRecord(event, fields, Date.now(), process.pid, Math.round(process.uptime() * 1000));
  return `${JSON.stringify(record)}\n`;
}
```
- [Code mới]:
```ts
// src/main/diagnostics/redact-credentials.ts  — chuyển nguyên hàm redactCredentials sang đây (bridge-server.ts và index.ts import từ đây)
export function redactCredentials(input: string): string { /* thân hàm hiện có, dòng 122-136 của bridge-server.ts */ }
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return fields;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = typeof value === 'string' ? redactCredentials(value) : value;
  return out;
}
```
```ts
import { redactFields } from './redact-credentials';
function admitLine(event: string, fields: Record<string, unknown> | undefined): string | null {
  initLogFile();
  if (!logFile) return null;
  const record = formatLifecycleRecord(event, redactFields(fields), Date.now(), process.pid, Math.round(process.uptime() * 1000));
  return `${JSON.stringify(record)}\n`;
}
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: mọi sự kiện đều được redact tự động, không phụ thuộc vào kỷ luật của từng callsite. Tách được một hàm khỏi file god.
- [Effort]: S · Impact: Med · Risk: thấp. Chỉ redact trường chuỗi cấp một; trường lồng nhau cần xử lý riêng nếu có. Callsite giữ `redactCredentials` vẫn đúng (idempotent).
- [Bằng chứng]: đọc `main-lifecycle-log.ts:199-265`, `index.ts:160-200`; grep `redactCredentials` toàn repo (index.ts nhập từ `./bridge/bridge-server:96`).

### K11 — Hàng B20 trong plans/bottlenecks.json lệch code: predicate trỏ chuỗi cũ và evidence 'không có tiled composite' đã sai

`U11` · Trụ cột T1 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: A:F3, B:F7, D:F28 (bản viết dùng: B:F7)

> Ghi chú verifier: D:F28 hiểu sai predicate ('lẽ ra đạt', 'không tái hiện được'); present = !re.test nên REOPENED là đúng. Chỉ phần evidence lỗi thời của D là đúng.
> Lưu ý về code mới (verifier): Phải sửa cả evidence lẫn predicate, không chỉ regex. Pattern mới 'outside the supported range' hoặc FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY đều hợp lệ.
> Hiệu chỉnh của controller: Controller đã chạy `node scripts/check-bottlenecks.mjs --json`: 35 closed, 4 refuted, 6 open, 1 ERROR `B20 REOPENED`.

- [Trụ cột]: T1
- [Vị trí]: `plans/bottlenecks.json:320-333` (B20); `scripts/check-bottlenecks.mjs:195-200`, `:285-286`; `src/main/browser/tab-devtools-host.ts:3026`, `:3139`
- [Vấn đề]: `file-absent-regex` coi "defect present" khi regex KHÔNG khớp (`check-bottlenecks.mjs:199`: `present: !re.test(text)`). Pattern `outside the supported 1` là chuỗi đánh dấu bản sửa. Câu lỗi hiện tại viết "is outside the supported range…" (`tab-devtools-host.ts:3026`, `:3139`). Grep `outside the supported 1` trên `src/main` không có kết quả, nên `npm run audit` báo `REOPENED`. Ngoài lỗi chữ, nội dung dòng cũng mâu thuẫn với code: evidence nói "No tiled-composite … helper exists" và `reVerifyWith` coi ảnh ghép là bất thường. Nhưng `tab-devtools-host.ts:52` import `planTiles`/`finalizeFullPageTiles` từ `../verification/full-page-tiles`, và `:3026`, `:3382-3385`, `:3439` xác nhận chụp theo tile rồi ghép.
- [Code cũ] (`plans/bottlenecks.json`):
```json
      "evidence": "Closed 2026-09-19: CAPTURE_MAX_DIMENSION = 16384 (src/main/verification/visual-capture.ts:703) and the over-ceiling path throws a typed error naming the requested region instead of degrading (src/main/browser/tab-devtools-host.ts:2043-2051, 2131-2135). No tiled-composite or main-thread composition helper exists in the capture path (grepped tile/tiled across src/main/browser + src/main/verification: every hit is 'Turnstile' or 'volatile' outside it). The 16 384 px limit is a capability ceiling; a tiled capture would be a feature row, not this defect.",
      "predicate": {
        "kind": "file-absent-regex",
        "file": "src/main/browser/tab-devtools-host.ts",
        "pattern": "outside the supported 1"
      },
      "reVerifyWith": "capture a page taller than 16384 CSS px: a refusal is correct; a stitched or upscaled image means a tiled composite was introduced"
```
- [Code mới]:
```json
      "evidence": "Re-verified 2026-11-11: a document taller than the per-image ceiling is captured in tiles and stitched (src/main/browser/tab-devtools-host.ts:3017-3029 plans the tiles, :3382-3385 stitches them, receipt carries tiles.count). The geometry refusal FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY remains for regions outside width 1..CAPTURE_MAX_DIMENSION or above fullPageMaxCssHeight (src/main/browser/tab-devtools-host.ts:3026, 3139). The original claim that no tiled composite exists is superseded.",
      "predicate": {
        "kind": "file-absent-regex",
        "file": "src/main/browser/tab-devtools-host.ts",
        "pattern": "outside the supported range"
      },
      "reVerifyWith": "capture a page taller than fullPageMaxCssHeight: FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY must name the height limit; a page below it must return receipt.tiles.stitched === true"
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: `npm run audit` trở lại xanh. Registry không còn khẳng định một điều mà code đã bác bỏ.
- [Effort]: S · Impact: Med · Risk: Thấp. Người chủ registry cần xác nhận việc diễn giải lại (đây là quyết định về nội dung dòng, không chỉ về regex).
- [Bằng chứng]: `check-bottlenecks.mjs:16-20`, `195-200`, `284-286`; `plans/bottlenecks.json:319-335`; `tab-devtools-host.ts:52`, `3017-3029`, `3138-3140`, `3382-3385`, `3439`. Grep `supported 1` trong `src/main` trả về 0 hit.

### K12 — Hibernation fail-open: lỗi đọc registry attachment có thể khiến tab đang bị agent gắn bị unload

`U12` · Trụ cột T5 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: A:F1 (bản viết dùng: A:F1)

> Ghi chú verifier: A ghi High; điều kiện ném lỗi của registry là [INFERENCE] (A tự gắn), hạ về Med.
> Lưu ý về code mới (verifier): Kiểu HibernationContext khớp các trường dùng ở 10394-10401. Với hibernationCdpBoundTabIds nên thêm tab vào bound khi lỗi.

- [Trụ cột]: T5
- [Vị trí]: `src/main/browser/native-tab-host.ts:10195-10206` — `hibernationBoundTabIds()`. Cùng kiểu ở `:10227-10243` (`hibernationCdpBoundTabIds`). Caller: `:10395-10402` (`runHibernationSweep`) và `:10431-10437` (`canStillHibernate`).
- [Vấn đề]:
  - `try {…} catch {}` nuốt mọi lỗi từ `registry.getActiveRecordIds()` hoặc `getRecord()`.
  - Nếu lỗi xảy ra giữa vòng lặp, các attachment còn lại không được thêm vào `bound`. `shouldHibernate` sẽ coi tab của chúng là "không bị gắn" và `hibernateTab` huỷ WebContents của tab đang có MCP attachment.
  - Đường gọi hot: `setInterval` mỗi 60 s (`:10182`, `HIBERNATE_SWEEP_INTERVAL_MS` ở `tab-hibernation.ts:22`) và lại gọi trong `canStillHibernate`.
  - Điều kiện lỗi thực tế `[INFERENCE]`: `getRecord` ném khi registry đang bị dispose lúc tắt cửa sổ. Chưa chứng minh tái hiện.
  - Tab bị gắn mà bị ngủ là sai an toàn, không chỉ là mất hiệu năng.
- [Code cũ]:
```ts
  private hibernationBoundTabIds(): Set<string> {
    const bound = new Set<string>();
    const registry = this.controlPlane?.runs?.attachments;
    if (!registry || typeof registry.getActiveRecordIds !== 'function') return bound;
    try {
      for (const attachmentId of registry.getActiveRecordIds()) {
        const rec = registry.getRecord?.(attachmentId);
        const tabId = rec?.tabId || rec?.browserTarget?.tabId;
        if (typeof tabId === 'string' && tabId) bound.add(tabId);
      }
    } catch {}
    return bound;
  }
```
- [Code mới] (fail-closed + một nơi dựng context, thay cho 2 chỗ dựng lặp `:10395-10402` và `:10431-10437`):
```ts
  /** null = the attachment registry could not be read: no tab may be unloaded on a guess. */
  private hibernationBoundTabIds(): Set<string> | null {
    const bound = new Set<string>();
    const registry = this.controlPlane?.runs?.attachments;
    if (!registry || typeof registry.getActiveRecordIds !== 'function') return bound;
    try {
      for (const attachmentId of registry.getActiveRecordIds()) {
        const rec = registry.getRecord?.(attachmentId);
        const tabId = rec?.tabId || rec?.browserTarget?.tabId;
        if (typeof tabId === 'string' && tabId) bound.add(tabId);
      }
    } catch (err) {
      recordLifecycleEvent('tabhost.hibernationBoundTabsUnreadable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    return bound;
  }

  private buildHibernationContext(): HibernationContext | null {
    const boundTabIds = this.hibernationBoundTabIds();
    if (boundTabIds === null) return null;
    return {
      activeTabId: this.activeTabId,
      automationTabId: this.automationTabId,
      boundTabIds,
      cdpBoundTabIds: this.hibernationCdpBoundTabIds(),
      unloadVetoedTabIds: this.unloadVetoedTabIds,
      idleMs: this.hibernationIdleMs,
    };
  }

  private async runHibernationSweep(): Promise<void> {
    if (this.isDisposed) return;
    await this.sweepIdleMedia();
    const ctx = this.buildHibernationContext();
    if (!ctx) return; // fail closed: skip this sweep, try again in 60 s
    for (const [id, tab] of [...this.tabs.entries()]) {
      const decision = shouldHibernate({ id, state: tab.state, lastActiveAt: tab.lastActiveAt }, ctx);
      if (!decision.hibernate) continue;
      await this.hibernateTab(id);
    }
  }
  // canStillHibernate: `const ctx = this.buildHibernationContext(); if (!ctx) return false;`
  // then `return shouldHibernate({ id: tabId, state: tab.state, lastActiveAt: tab.lastActiveAt }, ctx).hibernate;`
```
  (Áp dụng cùng cách cho `hibernationCdpBoundTabIds`: lỗi ở một tab ⇒ thêm tab đó vào `bound`.)
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: loại một đường tab-đang-gắn-bị-ngủ khi registry lỗi; lỗi để lại dấu vết trong `main.log`; bỏ 2 bản dựng context trùng nhau.
- [Effort]: S · Impact: High · Risk: Thấp. Sweep bỏ một nhịp khi registry lỗi, tab idle ngủ muộn hơn 60 s.
- [Bằng chứng]: `native-tab-host.ts:10181-10187`, `10195-10206`, `10227-10243`, `10391-10403`, `10431-10437`; `tab-hibernation.ts:22`; import `recordLifecycleEvent` tại `native-tab-host.ts:11`. `[INFERENCE]`: tình huống registry ném lỗi.

### K13 — contextPack kéo toàn bộ claim stale/aging (kèm statement) chỉ để đếm

`U13` · Trụ cột T2 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: D:F4 (bản viết dùng: D:F4)

> Ghi chú verifier: D ghi High; số hàng stale thực tế chưa đo, hạ về Med.
> Lưu ý về code mới (verifier): Nhánh countOnly trả kiểu khác (thiếu stale/aging) nên caller health() gãy typecheck. Dùng method decayCounts() riêng hoặc overload.

- [Trụ cột]: T2
- [Vị trí]: `packages/super-core/src/index.ts:855`, `883-889`, `1332-1371` — `Core.contextPack`, `Core.decayCheck`
- [Vấn đề]: đường diagnostics của pack chỉ cần `decay.stale.length` và `decay.aging.length`. `decayCheck` lại `SELECT claimId, statement, …` không có `LIMIT`. Chú thích ở dòng 842-844 xác nhận pack là call chạy ở mỗi turn của agent (hook `before_agent_start`), nên cả bảng stale/aging bị đọc và serialize mỗi turn. `health()` (dòng 1607) vẫn cần danh sách đầy đủ nên giữ nguyên.
- [Code cũ]:
```ts
      const decay = this.decayCheck({ platform: opts.platform, unitIds: diagUnits, includeGlobal: opts.includeGlobal });
```
```ts
        staleClaims: decay.stale.length,
        agingClaims: decay.aging.length,
```
```ts
    const stale = this.db.prepare(
      `SELECT claimId, statement, status, lastSeen, createdAt FROM claims
       WHERE ${staleWhere.join(' AND ')}`,
    ).all(...staleArgs as never[]);
    const aging = this.db.prepare(
      `SELECT claimId, statement, status, agingSince FROM claims
       WHERE ${agingWhere.join(' AND ')}`,
    ).all(...agingArgs as never[]);
    return { stale, aging, cutoff };
```
- [Code mới] (thêm tùy chọn `countOnly`, giữ API cũ cho `health()`):
```ts
  decayCheck(opts?: { staleDays?: number; platform?: string; unitIds?: string[]; includeGlobal?: boolean; countOnly?: boolean }) {
    // … phần dựng staleWhere/staleArgs/agingWhere/agingArgs giữ nguyên …
    if (opts?.countOnly) {
      const count = (where: string[], args: unknown[]) =>
        (this.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE ${where.join(' AND ')}`).get(...args as never[]) as { n: number }).n;
      return { staleCount: count(staleWhere, staleArgs), agingCount: count(agingWhere, agingArgs), cutoff };
    }
    const stale = this.db.prepare(/* như cũ */).all(...staleArgs as never[]);
    const aging = this.db.prepare(/* như cũ */).all(...agingArgs as never[]);
    return { stale, aging, staleCount: stale.length, agingCount: aging.length, cutoff };
  }
```
Ở `contextPack`:
```ts
      const decay = this.decayCheck({ platform: opts.platform, unitIds: diagUnits, includeGlobal: opts.includeGlobal, countOnly: true });
      // …
        staleClaims: decay.staleCount,
        agingClaims: decay.agingCount,
        healthy: decay.staleCount === 0 && gapKinds.length === 0 && pendingTotal === 0,
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: hết việc tải và JSON-hóa toàn bộ `statement` mỗi turn. Chi phí chuyển thành hai `COUNT(*)`.
- [Effort]: S · Impact: High · Risk: thấp. Cần sửa 1-2 caller đọc `.stale`/`.aging` nếu có (grep trước khi cắt).
- [Bằng chứng]: `index.ts:842-891` (đã đọc), `1331-1371`. `[INFERENCE]` về số hàng stale trong DB 211 MB, chưa đo.

### K14 — knowledgeGaps chạy mỗi turn qua pack và N+1 truy vấn theo platform

`U14` · Trụ cột T2 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: E:F7 (bản viết dùng: E:F7)

> Ghi chú verifier: E ghi High; mỗi truy vấn COUNT có index idx_claims_platform nên thực tế là vài ms, hạ về Med.
> Lưu ý về code mới (verifier): Truy vấn gộp tương đương logic kind ở 1441-1453 (active/fresh/unresolved); SUM trả number. Cần test tương đương.

- [Trụ cột]: T2
- [Vị trí]: `packages/super-core/src/index.ts:1421-1460`; gọi từ `:856` (mỗi pack có diagnostics) và `:1613`
- [Vấn đề]:
  - Comment `:843-845` nói pack "fires on every agent turn" qua hook `antifan-core-bridge`.
  - Khi không có `platform`, mỗi lượt chạy 1 truy vấn `UNION` 8 bảng cộng 3 `COUNT(*)` cho từng platform (≈ 8 UNION + 3×7 = 22+ truy vấn với 7 platform như trong pack hiện tại).
  - DB lõi 211 MB (§2.6).
- [Code cũ]:
```ts
      const active = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM claims WHERE contextPlatform = ?
         AND status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')`,
      ).get(platform) as { n: number }).n;
      const fresh = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM claims WHERE contextPlatform = ?
         AND status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')
         AND (createdAt >= ? OR lastSeen >= ?)`,
      ).get(platform, cutoff, cutoff) as { n: number }).n;
      const unresolved = (this.db.prepare(
        "SELECT COUNT(*) AS n FROM conflicts WHERE platform = ? AND state = 'UNRESOLVED'",
      ).get(platform) as { n: number }).n;
```
- [Code mới]: thay vòng `.map` bằng một truy vấn gộp (platform lọc sau bằng JS như cũ, giữ nguyên `kind`):
```ts
    const stats = new Map<string, { active: number; fresh: number; unresolved: number }>();
    const rows = this.db.prepare(
      `SELECT p, SUM(a) AS active, SUM(f) AS fresh, SUM(u) AS unresolved FROM (
         SELECT contextPlatform AS p, 1 AS a,
                CASE WHEN createdAt >= ? OR lastSeen >= ? THEN 1 ELSE 0 END AS f, 0 AS u
           FROM claims WHERE contextPlatform IS NOT NULL
            AND status NOT IN ('STALE_SOURCE_CHANGED','REVOKED','SUPERSEDED')
         UNION ALL SELECT platform, 0, 0, 1 FROM conflicts WHERE platform IS NOT NULL AND state = 'UNRESOLVED'
       ) GROUP BY p`,
    ).all(cutoff, cutoff) as Array<{ p: string; active: number; fresh: number; unresolved: number }>;
    for (const r of rows) stats.set(r.p, r);
    const gaps = platforms
      .filter((p) => !opts?.platform || p === opts.platform)
      .map((platform) => {
        const s = stats.get(platform) ?? { active: 0, fresh: 0, unresolved: 0 };
        const kind = s.active === 0 ? 'NO_EVIDENCE' : s.unresolved > 0 ? 'CONFLICTED' : s.fresh === 0 ? 'STALE' : 'NONE';
        return { platform, kind, activeClaims: s.active, freshClaims: s.fresh, unresolvedConflicts: s.unresolved };
      });
```
- [Lợi ích]: từ ~3N+1 truy vấn xuống 2, trên đường nóng của mỗi lượt prompt.
- [Effort]: S · Impact: High · Risk: thấp, cần test tương đương (`test` super-core).
- [Bằng chứng]: `index.ts:843-856`, `:1421-1460`, `:1613`. `[INFERENCE]`: chưa đo thời gian truy vấn.

### K15 — taskkill đồng bộ không timeout trên main thread (chrome-profile-sync, codex backend, profile-ownership)

`U15` · Trụ cột T2 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: B:F10, D:F13, E:F11 (bản viết dùng: B:F10)

> Lưu ý về code mới (verifier): Sau khi bỏ execSync, import execSync ở chrome-profile-sync.ts:11 thành thừa. D:F13 ghi path sai (src/process/...; thật là src/main/process/), đổi POSIX từ SIGTERM sang SIGKILL và chưa kiểm vòng import, nên không dùng bản đó. isProcessAlive của E:F11 lan sang acquire, tách riêng.

- [Trụ cột]: T2
- [Vị trí]: `src/main/browser/chrome-profile-sync.ts:457-468` (gọi từ `:548` trong hàm async); `src/main/agent/codex-execution-backend.ts:140-145`; tham chiếu `src/main/process/process-registry.ts:184` (`killProcessTree` async)
- [Vấn đề]: `killOwnedChrome` chạy `execSync(\`taskkill /PID …\`)` không có `timeout`, nên một taskkill treo sẽ treo luôn main thread. `killOwned` của Codex dùng `execFileSync('taskkill', …)`, và `cancel()` là async nhưng thân đồng bộ. `chrome-profile-sync.ts:13` đã có sẵn `execFileAsync = promisify(execFile)`. `process-registry.ts:252-264` có `killProcessTreeSync` có `timeout: 2000` nhưng đó là biến thể dành cho `process.on('exit')`, không phải lỗi.
- [Code cũ] (`chrome-profile-sync.ts:457-468`):
```ts
  private killOwnedChrome(child: ChildProcess | null): void {
    if (!child || child.pid === undefined || child.pid <= 0) return;
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
```
- [Code mới]:
```ts
  private async killOwnedChrome(child: ChildProcess | null): Promise<void> {
    if (!child || child.pid === undefined || child.pid <= 0) return;
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
    } else {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
// :548
      await this.killOwnedChrome(child);
```
Codex (`codex-execution-backend.ts:143`):
```ts
      childProcess.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (err) => { if (err) child.kill(); });
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: không còn khả năng treo main thread vô hạn. Có timeout.
- [Effort]: S · Impact: Med · Risk: Thấp. Sau `await`, `execSync` còn được dùng ở file khác cần kiểm. `execSync` có thể thành import thừa, nên cần dọn.
- [Bằng chứng]: `chrome-profile-sync.ts:11-13`, `447-468`, `548`; `codex-execution-backend.ts:124-146`; `process-registry.ts:239-278`.

### K16 — Trường fields spread sau khóa lõi: pid của perf.hotProcess ghi đè pid Main trong main.log

`U16` · Trụ cột T5 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: E:F3 (bản viết dùng: E:F3)

> Lưu ý về code mới (verifier): Đổi pid thành targetPid ở index.ts:1099-1100 và thêm test formatLifecycleRecord cho khóa trùng.

- [Trụ cột]: T5
- [Vị trí]: `src/main/diagnostics/main-lifecycle-log.ts:185-200` — `formatLifecycleRecord`; call site `src/main/index.ts:1099-1100`
- [Vấn đề]: `...(fields || {})` được spread SAU các khoá lõi (`iso, ts, pid, uptimeMs, event`). `perf.hotProcess` truyền `pid: metric.pid`, nên dòng log mang pid của tiến trình bị đo thay vì pid của Main. Các trường lõi bị ghi đè âm thầm. Grep consumer của `perf.hotProcess` trong `src;scripts;test;docs` chỉ trả về `index.ts`.
- [Code cũ]:
```ts
  return {
    iso: new Date(now).toISOString(),
    ts: now,
    pid,
    uptimeMs,
    event,
    ...(fields || {}),
  };
```
(và `recordLifecycleEvent('perf.hotProcess', { pid: metric.pid, type: metric.type, …`)
- [Code mới]:
```ts
const RESERVED_FIELDS = new Set(['iso', 'ts', 'pid', 'uptimeMs', 'event']);
…
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) extra[RESERVED_FIELDS.has(key) ? `field_${key}` : key] = value;
  return { iso: new Date(now).toISOString(), ts: now, pid, uptimeMs, event, ...extra };
```
và ở `index.ts`: `targetPid: metric.pid,`
- [Lợi ích]: nhật ký tin được, một `pid` luôn là pid của tiến trình ghi.
- [Effort]: S · Impact: Med · Risk: thấp. Cần thêm test `formatLifecycleRecord` cho khoá trùng.
- [Bằng chứng]: `main-lifecycle-log.ts:185-200`; `index.ts:1099-1100`. Chưa quét hết mọi `recordLifecycleEvent` để tìm trường trùng khác `[INFERENCE]`.

### K17 — Pack Core chèn vào prompt mỗi turn bị nhiễu: gap NO_EVIDENCE toàn platform và JSON thụt lề

`U17` · Trụ cột T4 · Effort S · Impact Med · Verifier: DOWNGRADED · Nguồn: E:F2 (bản viết dùng: E:F2)

> Ghi chú verifier: 'Diagnostics in hai lần' nói quá: banner chỉ liệt kê gapKinds, không in toàn bộ diagnostics. Phần JSON thụt lề và gap vô nghĩa là thật.
> Lưu ý về code mới (verifier): Chưa kiểm pack.platform có tồn tại để lọc NO_EVIDENCE. Cài lại hook; test bridge.

- [Trụ cột]: T4
- [Vị trí]: `.omp/hooks/pre/antifan-core-bridge.ts:966-1013` — `renderPackContent`
- [Vấn đề]: mỗi `before_agent_start` hook chèn pack. Bản `diagnostics` đầy đủ được in hai lần: một lần trong banner `[Core Health …]` (`:1001`), một lần trong body JSON (`diagnostics: pack.diagnostics ?? null`). Khi `ANTIFAN_CORE_PLATFORM` không đặt, `gapKinds` liệt kê mọi platform `NO_EVIDENCE` (haravan, cloudflare-workers, windows…), mỗi cái kèm 3 số 0. JSON lại thụt lề bằng `null, 1`, tốn token whitespace. Chính pack của phiên này minh hoạ đúng: 7 gap NO_EVIDENCE + `unknowns` + diagnostics lặp. Pack nằm ở phần user-message mỗi lượt nên không hưởng prompt-cache.
- [Code cũ]:
```ts
		for (const g of diag.gapKinds) parts.push(`${g.platform}: ${g.kind}`);
…
	text += JSON.stringify(body, null, 1);
```
(và trong `body`: `diagnostics: pack.diagnostics ?? null,`)
- [Code mới]:
```ts
		// A NO_EVIDENCE platform is a coverage fact about the store, not about this task.
		const relevantGaps = diag.gapKinds.filter((g) => g.kind !== "NO_EVIDENCE" || g.platform === pack.platform);
		for (const g of relevantGaps) parts.push(`${g.platform}: ${g.kind}`);
…
	// The banner already carries the diagnostics; do not repeat them in the body.
	text += JSON.stringify({ ...body, diagnostics: undefined });
```
- [Cấu hình nâng cấp]: đặt `ANTIFAN_CORE_PLATFORM` cho phiên (có sẵn, `resolvePlatform()` ở `.omp/hooks/pre/antifan-core-bridge.ts:~645`) để pack gọn từ gốc.
- [Lợi ích]: giảm vài trăm đến vài nghìn token mỗi lượt, bỏ nhiễu. `MAX_PACK_CHARS=12_000` (`:254`) cắt cụt bớt ít hơn.
- [Effort]: S · Impact: Med · Risk: thấp (đổi định dạng văn bản; kiểm tra `test/unit/bridge-*`).
- [Bằng chứng]: `:966-1013`, `:254-257`, pack inject của phiên này; `[INFERENCE]` về số token tiết kiệm.

### K18 — Chưa có cổng npm audit; không nhận đề xuất hạ @electron/packager; chạy audit fix thường

`U18` · Trụ cột T3 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: C:F9, D:F20 (bản viết dùng: D:F20)

> Ghi chú verifier: Phần 'rmdirSync không phải deprecated' trong D:F20 là đúng nhưng không có hành động.
> Lưu ý về code mới (verifier): audit:deps sẽ đỏ tới khi U01 xong, bật dần bằng --audit-level=critical. Đừng dùng --force.
> Hiệu chỉnh của controller: Đã xác nhận: `package.json` scripts không có lệnh `npm audit` nào (`"audit"` hiện là `check-bottlenecks.mjs`).

- [Trụ cột]: T3
- [Vị trí]: `package.json:19-59` (khối `scripts`); `src/main/tools/artifact-retention-cleaner.ts:149`, `src/main/browser/profile-ownership.ts:235`, `scripts/install-managed-skills.mjs:151`
- [Vấn đề]: không có script nào chạy `npm audit`; 18 advisory (1 critical, 8 high) chỉ lộ khi chạy tay. Gợi ý hit "deprecated" trong packet §2.2 là dương tính giả: cả ba chỗ đều là `fs.rmdirSync(dir)` trên thư mục rỗng, dạng không đệ quy, không nằm trong diện cũ (chỉ cờ `{ recursive: true }` bị cảnh báo; `[INFERENCE]` từ tài liệu Node chưa đọc lại). Đề xuất không sửa ba chỗ này.
- [Code cũ]:
```json
    "audit": "node scripts/check-bottlenecks.mjs",
```
- [Code mới]:
```json
    "audit": "node scripts/check-bottlenecks.mjs",
    "audit:deps": "npm audit --omit=dev --audit-level=high",
```
- [Cấu hình nâng cấp]:
```bash
npm audit fix --dry-run    # xem trước; không dùng --force (npm đề xuất hạ @electron/packager về 18.4.4: đó là bước lùi, từ chối)
```
- [Lợi ích]: advisory runtime lộ ra trong CI/verify thay vì phát hiện thủ công. Tránh sửa nhầm 3 chỗ.
- [Effort]: S · Impact: Med · Risk: thấp. Gate sẽ đỏ cho đến khi F17 xong; có thể bật dần bằng `--audit-level=critical`.
- [Bằng chứng]: đọc `package.json:19-59`; grep `url.parse|new Buffer|.substr|fs.exists|rmdir` trên ba file; packet §2.3.

### K19 — Tham số chết staticTools và getStaticTools() ~440 dòng bị dựng rồi vứt mỗi listTools

`U19` · Trụ cột T1 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: C:F4, D:F2 (bản viết dùng: D:F2)

> Ghi chú verifier: Class này không có caller production (U64), nên lợi ích là xóa mã chết, không phải tiết kiệm hiệu năng.
> Lưu ý về code mới (verifier): Cập nhật native-tab-host.ts:4168 và 3 test (capability-catalogue, cookie-jar, runtime-fullpage-evidence). Xóa import thừa trong mcp-server.ts.

- [Trụ cột]: T1
- [Vị trí]: `src/main/mcp/mcp-tool-list.ts:11`; `src/main/mcp/mcp-server.ts:57-~492`, `518`; `src/main/browser/native-tab-host.ts:4168`
- [Vấn đề]: `buildMcpToolList(staticTools, …)` không dùng `staticTools` ở đâu trong thân hàm (đã đọc toàn bộ file, 94 dòng). `listTools()` vẫn gọi `this.getStaticTools()` (khai báo từ dòng 57, hết trước `advertisedSchemaCache` ở dòng 494) và vứt kết quả. `native-tab-host.ts:4168` đã phải truyền `[]`.
- Zero-reference: `grep "getStaticTools|staticTools"` trên `src;scripts;test` chỉ ra `mcp-server.ts:57`, `mcp-server.ts:518`, `mcp-tool-list.ts:11`. `grep "buildMcpToolList|getStaticTools"` trên `test;scripts;packages;src/main/tools;src/main/control-plane` chỉ ra 3 lời gọi test.
- [Code cũ]:
```ts
export function buildMcpToolList(staticTools: Tool[], transport?: CapabilityTransportAdapter, isHighRiskAllowed = false): McpAdvertisedTool[] {
```
```ts
      tools: buildMcpToolList(this.getStaticTools(), this.transport, this.isHighRiskAllowed).map(({ name, description, inputSchema }) => ({
```
```ts
        ? buildMcpToolList([], host.controlPlane.transport, true).map((tool) => {
```
- [Code mới]:
```ts
export function buildMcpToolList(transport?: CapabilityTransportAdapter, isHighRiskAllowed = false): McpAdvertisedTool[] {
```
```ts
      tools: buildMcpToolList(this.transport, this.isHighRiskAllowed).map(({ name, description, inputSchema }) => ({
```
```ts
        ? buildMcpToolList(host.controlPlane.transport, true).map((tool) => {
```
Xóa `getStaticTools()` (`mcp-server.ts:57-~492`). Cập nhật 3 test: `test/main/capability-catalogue.test.ts:396`, `test/main/cookie-jar.test.ts:229`, `test/main/runtime-fullpage-evidence.test.ts:164` từ `buildMcpToolList([], x)` thành `buildMcpToolList(x)`.
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: xóa ~435 dòng chết và một lần dựng mảng lớn mỗi `listTools` (`advertisedInputSchema` cũng gọi qua đây).
- [Effort]: S · Impact: Med · Risk: thấp, compile sẽ bắt mọi caller sót. Cần xóa import không còn dùng trong `mcp-server.ts` sau khi gỡ hàm.
- [Bằng chứng]: các grep nêu trên; `mcp-tool-list.ts:11-94`.

### K20 — Core.invalidate/revoke: UPDATE từng dòng ngoài transaction, truy vấn OR không index trên evidence.path

`U20` · Trụ cột T2 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: A:F6, D:F5, E:F12 (bản viết dùng: A:F6)

> Lưu ý về code mới (verifier): Câu UPDATE gộp của A đổi '' thành NULL và bỏ join claims; an toàn vì FK CASCADE đã xác nhận. D:F5 thêm PRAGMA synchronous=NORMAL: đó là quyết định bền vững, không tự áp dụng. experienceChain/importScout của E:F12 xem U37.

- [Trụ cột]: T2
- [Vị trí]: `packages/super-core/src/index.ts:1084-1096` (`invalidate`) và `:1145-1161` (`revoke`); chỉ mục ở `schema.ts:206-207`
- [Vấn đề]:
  - `for (const c of claims) stmt.run(c.claimId)` chạy autocommit, mỗi dòng một commit (WAL, mặc định `synchronous=FULL` ⇒ fsync mỗi dòng `[INFERENCE]` về mặc định).
  - Truy vấn chọn claim là `… LEFT JOIN artifacts a … WHERE (e.entryId = ? OR a.absPath = ? OR e.path = ?)`. `evidence` chỉ có index `claimId` và `entryId`, không có index cho `path`; `OR` khiến planner khó dùng `idx_artifacts_path`. Trên DB 211 MB (§2.6) đường này có nguy cơ quét toàn bảng evidence. `[INFERENCE]`: chưa chạy `EXPLAIN QUERY PLAN`.
  - Gọi khi thay đổi/xoá nguồn (`core.invalidate`, `core.revoke`). Tần suất thực tế chưa đo.
  - Hai hàm trùng nhau gần như toàn bộ.
  - Hành vi hiện tại: khi chỉ có `entryId`, tham số `path` = `''` khớp mọi evidence có `path=''`. Dùng `NULL` sẽ tránh khớp nhầm.
- [Code cũ] (`invalidate`, `:1088-1094`):
```ts
    const claims = this.db.prepare(
      `SELECT DISTINCT c.claimId FROM claims c JOIN evidence e ON e.claimId = c.claimId
       LEFT JOIN artifacts a ON a.entryId = e.entryId
       WHERE (e.entryId = ? OR a.absPath = ? OR e.path = ?)`,
    ).all(opts.entryId ?? '', opts.path ?? '', opts.path ?? '') as Array<{ claimId: string }>;
    const stmt = this.db.prepare("UPDATE claims SET status = 'STALE_SOURCE_CHANGED' WHERE claimId = ?");
    for (const c of claims) stmt.run(c.claimId);
    return { invalidated: claims.length };
```
- [Code mới]:
```ts
  private markClaimsFromSource(status: 'STALE_SOURCE_CHANGED' | 'REVOKED', opts: { entryId?: string; path?: string }): number {
    const res = this.db.prepare(
      `UPDATE claims SET status = ? WHERE claimId IN (
         SELECT claimId FROM evidence WHERE entryId = ?
         UNION SELECT claimId FROM evidence WHERE path = ?
         UNION SELECT e.claimId FROM evidence e JOIN artifacts a ON a.entryId = e.entryId WHERE a.absPath = ?
       )`,
    ).run(status, opts.entryId ?? null, opts.path ?? null, opts.path ?? null);
    return Number(res.changes);
  }
  invalidate(opts: { entryId?: string; path?: string }) {
    if (!opts.entryId && !opts.path) throw new Error('invalidate requires entryId or path');
    return { invalidated: this.markClaimsFromSource('STALE_SOURCE_CHANGED', opts) };
  }
  revoke(opts: { entryId?: string; path?: string }) {
    if (!opts.entryId && !opts.path) throw new Error('revoke requires entryId or path');
    return { revoked: this.markClaimsFromSource('REVOKED', opts) };
  }
```
- [Cấu hình nâng cấp] (thêm cạnh `schema.ts:206-207`, `PREPARED_STAMP` hash `DDL` nên tự áp dụng lần mở kế tiếp):
```sql
CREATE INDEX IF NOT EXISTS idx_evidence_path ON evidence(path);
```
- [Lợi ích]: một câu lệnh một commit thay vì N; mỗi nhánh tra bằng index riêng; bỏ ~16 dòng trùng.
- [Effort]: S · Impact: Med · Risk: Thấp–Vừa. Bản mới không join bảng `claims`; chỉ đúng nếu `evidence.claimId` luôn trỏ claim tồn tại. `foreign_keys=ON` (`index.ts:218`) nhưng FK trên `evidence` chưa kiểm chứng `[INFERENCE]`. Test hiện có: `packages/super-core/src/core.test.ts`.
- [Bằng chứng]: `index.ts:1088-1096`, `1153-1160`, `216-221`, `27-30`; `schema.ts:154-160`, `193-196`, `206-207`; `core.test.ts:827-828` xác nhận WAL.

### K21 — Gate check-mcp-budget-dominance chưa đo kích thước và tính xác định của tools/list

`U21` · Trụ cột T4 · Effort S · Impact Med · Verifier: VALIDATED · Nguồn: C:F18, D:F10 (bản viết dùng: C:F18)

> Lưu ý về code mới (verifier): Cần commit file baseline JSON. Phép so hai lần listTools của D:F10 gần như luôn bằng nhau nên giá trị thấp, ưu tiên ngưỡng byte của C.

- [Trụ cột]: T4
- [Vị trí]: `scripts/check-mcp-budget-dominance.mjs:424-431`
- [Vấn đề]: gate chạy trong `npm run compile` (`package.json:27`) chỉ so parity và con số `terminal.wait`; không có số đo kích thước danh sách tool. Mọi mô tả mới hoặc alias mới làm phình prompt của mọi agent mà không ai thấy.
- [Code cũ] (`:424` và `:431`):
```js
  notes.push(`parity: ${(proxy.definitions || []).length} advertised tools checked against catalogue schemas; ${advertisedCore.size} core.* dispatched`);
...
    const published = await proxy.listTools();
```
- [Code mới] (chèn ngay sau dòng `notes.push(parity...)`):
```js
  const advertised = await proxy.listTools();
  const listBytes = Buffer.byteLength(JSON.stringify(advertised.tools), 'utf8');
  const baselineFile = path.join(ROOT, 'scripts', 'mcp-tools-list-baseline.json');
  if (process.argv.includes('--update-tools-baseline')) {
    fs.writeFileSync(baselineFile, JSON.stringify({ tools: advertised.tools.length, bytes: listBytes }, null, 2) + '\n');
  } else if (fs.existsSync(baselineFile)) {
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    if (listBytes > baseline.bytes * 1.05) {
      problems.push(`tools/list grew to ${listBytes} bytes (baseline ${baseline.bytes}); review new descriptions or run with --update-tools-baseline`);
    }
  }
  notes.push(`tools/list: ${advertised.tools.length} tools, ${listBytes} bytes`);
```
- [Cấu hình nâng cấp]: chạy `node scripts/check-mcp-budget-dominance.mjs --update-tools-baseline` một lần để tạo baseline rồi commit file JSON.
- [Lợi ích]: có số liệu thật để quyết F17 và chặn phình ngữ cảnh về sau.
- [Effort]: S · Impact: Med · Risk: thấp; dùng `fs`, `path`, `ROOT`, `notes`, `problems`, `proxy` đã có trong file.
- [Bằng chứng]: `check-mcp-budget-dominance.mjs:33-39`, `:54-55`, `:424-431`; `package.json:27`.

### K22 — Hook run-state ghi file đồng bộ (đọc lease, đọc mode, atomic write) ở mọi tool_call/tool_result

`U22` · Trụ cột T4 · Effort M · Impact Med · Verifier: DOWNGRADED · Nguồn: D:F6, E:F17 (bản viết dùng: D:F6)

> Ghi chú verifier: Ghi High; độ trễ từng syscall chưa đo, hạ về Med.
> Lưu ý về code mới (verifier): Giữ writeState ngay khi chuyển waiting_user và running, dọn timer trong dispose(). Chỉ có hiệu lực sau khi cài lại hook. Cấu hình ANTIFAN_RUN_CONTROL_POLL_MS trong D là minh họa vô nghĩa, bỏ.

- [Trụ cột]: T4
- [Vị trí]: `src/omp-hooks/run-state.ts:377-399` (`writeState`), `724-743` (`tool_call`), `745-` (`tool_result`), `89-97` (`atomicWriteJson`), heartbeat `RUN_HEARTBEAT_MS=15_000` ở dòng 30
- [Vấn đề]: mỗi `tool_call` và mỗi `tool_result` đều gọi `writeState()`. `writeState` đọc lại file để kiểm tra quyền sở hữu (`readRunStateForLease`, dòng 121-124), đọc mode (`readMode`, dòng 179+), rồi `mkdirSync` + `writeFileSync` + `renameSync`. Đó là khoảng 6-8 syscall đồng bộ trong tiến trình agent, trước cả khi công cụ chạy, nhân đôi mỗi tool. Heartbeat 15 giây đã đủ giữ `updatedAt` (Main coi stale sau 45 giây: `run-state-service.ts:13`). Hook này đăng ký `pi.on` cho 5 loại sự kiện trên mọi session có `ANTIFAN_TERMINAL_SESSION_ID`.
- [Code cũ]:
```ts
      if (toolName.length > 0) lastTool = toolName;
      lastEventAt = Date.now();
      if (isAskTool(toolName)) {
        state = "waiting_user";
        pendingAskTool = toolName;
      }

      writeState();
```
- [Code mới] (chuyển trạng thái giữ ghi tức thì, các sự kiện công cụ thường được gộp 500 ms):
```ts
  const TOOL_WRITE_COALESCE_MS = 500;
  let toolWriteTimer: NodeJS.Timeout | null = null;
  function scheduleWrite(): void {
    if (toolWriteTimer || retired) return;
    toolWriteTimer = setTimeout(() => {
      toolWriteTimer = null;
      writeState();
    }, TOOL_WRITE_COALESCE_MS);
    toolWriteTimer.unref?.();
  }
  // dispose(): thêm   if (toolWriteTimer) { clearTimeout(toolWriteTimer); toolWriteTimer = null; }
```
```ts
      if (isAskTool(toolName)) {
        state = "waiting_user";
        pendingAskTool = toolName;
        writeState();          // chuyển trạng thái: ghi ngay
      } else {
        scheduleWrite();       // lastTool/lastEventAt: gộp
      }
```
`tool_result`: giữ `writeState()` khi `state` đổi từ `waiting_user` về `running`, còn lại dùng `scheduleWrite()`.
- [Cấu hình nâng cấp]:
```json
{ "env": { "ANTIFAN_RUN_CONTROL_POLL_MS": "1000" } }
```
(giá trị mặc định hiện hành `CONTROL_POLL_INTERVAL_MS`, không đổi; chỉ để minh họa đây là núm duy nhất đã có.)
- [Lợi ích]: ~12-16 syscall/tool-pair còn tối đa ~2 mỗi 500 ms. Giảm độ trễ cộng thêm trước mỗi công cụ, và giảm chạm đĩa.
- [Effort]: M · Impact: High · Risk: Med. Thẻ trạng thái chậm tối đa 500 ms; test hook cần chỉnh. Hook đã cài chỉ có hiệu lực sau `node scripts/install-omp-hooks.mjs --install --hook run-state`.
- [Bằng chứng]: đọc `run-state.ts:329-399`, `724-763`, `79-125`; grep `RUN_HEARTBEAT_MS`. `[INFERENCE]`: chưa đo độ trễ từng syscall.

### K23 — zod 3→4: chỉ một file dùng zod; z.record một tham số cần sửa

`U23` · Trụ cột T3 · Effort M · Impact Med · Verifier: VALIDATED · Nguồn: A:F18, B:F18, C:F21, D:F18, E:F21 (bản viết dùng: D:F18)

> Lưu ý về code mới (verifier): Bước 1 z.record(z.string(), z.unknown()) hợp lệ ở cả zod 3.25 nên làm trước. passthrough vẫn tồn tại ở zod 4 (deprecated), 'bị thay/xóa' chỉ là [INFERENCE]. Phương án import 'zod/v4' của C chưa kiểm trong node_modules.
> Hiệu chỉnh của controller: `@modelcontextprotocol/sdk@1.30.0` đang cài khai `zod: "^3.25 || ^4.0"` (dependency + peer) nên zod 4 không vướng SDK. zod chỉ được import ở `src/main/workflow/workflow-schema.ts`.

- [Trụ cột]: T3
- [Vị trí]: `src/main/workflow/workflow-schema.ts:1`, `28-34`, `38-41`, `345`
- [Vấn đề]: `grep "from 'zod'"` trên `src;scripts;packages` chỉ ra đúng một file. Trong file đó, `z.record(z.unknown())` (dòng 345) là dạng một tham số. `[INFERENCE]`: zod 4 đổi chữ ký `record` thành bắt buộc hai tham số và đánh dấu `.passthrough()` là cũ; changelog không được đọc ở lượt này. Zod 3.25.76 hiện cài chấp nhận dạng hai tham số, nên sửa dòng này an toàn ngay cả trước khi nâng cấp. Advisory `zod <4.6.6` ở packet §2.3 là trực tiếp; bản latest là 4.6.7 (semver-major). `[INFERENCE]`: SDK MCP phải chấp nhận zod 4 mới nâng được, cần đọc `peerDependencies` của SDK 1.32.2.
- [Code cũ]:
```ts
  params: z.record(z.unknown()).default({}),
```
```ts
export const BrowserNavigateParamsSchema = z
  .object({
    url: z.string().min(1),
  })
  .passthrough();
```
- [Code mới] (bước 1, tương thích cả hai phiên bản; bước 2 nâng zod sau khi xác nhận SDK):
```ts
  params: z.record(z.string(), z.unknown()).default({}),
```
- [Cấu hình nâng cấp]:
```bash
# bước 1: sửa dòng 345 như trên, chạy test/main/workflow-schema.test.ts + workflow-engine.test.ts
# bước 2 (sau khi SDK 1.32.2 được xác nhận hỗ trợ zod 4):
npm install zod@^4.6.7
# rồi thay .passthrough() bằng API thay thế của zod 4 (đọc changelog trước) trong các schema params
```
- [Lợi ích]: kế hoạch nâng cấp major có phạm vi hẹp (1 file, 7 test hiện có), tách được phần an toàn làm ngay.
- [Effort]: M · Impact: Med · Risk: Med. Hành vi `.default({})` và `passthrough` trong zod 4 cần test lại bằng `workflow-schema.test.ts`.
- [Bằng chứng]: grep `from 'zod'`; đọc `workflow-schema.ts:1-60`, `336-351`; grep `workflow-schema` xác nhận importers (`workflow-engine.ts`, `workflow-registry.ts`, `workflow-capabilities.ts`, `control-plane-runtime.ts`).

### K24 — Không có setPermissionRequestHandler/CheckHandler cho phiên duyệt web

`U24` · Trụ cột T5 · Effort M · Impact Med · Verifier: DOWNGRADED · Nguồn: B:F8 (bản viết dùng: B:F8)

> Ghi chú verifier: Ghi High; mặc định Electron cho phép mọi quyền khi không có handler là đúng theo checklist bảo mật, nhưng ảnh hưởng sản phẩm lớn nên là quyết định sản phẩm, hạ về Med.
> Lưu ý về code mới (verifier): Chèn của B nằm trong nhánh `if (partition)` nên bỏ sót defaultSession (partition rỗng). Allowlist chỉ 3 quyền có thể làm hỏng Meet/OAuth/clipboard: cần Tài chốt danh sách theo origin.
> Hiệu chỉnh của controller: Đã đối chiếu tài liệu Electron chính thức (Security checklist, mục 5): "By default, Electron will automatically approve all permission requests unless the developer has manually configured a custom handler." Grep `setPermission(Request|Check)Handler|setDevicePermissionHandler` trên `src/` và `main.cjs`: 0 hit. Danh sách quyền cho phép là quyết định sản phẩm của bạn.

- [Trụ cột]: T5
- [Vị trí]: `src/main/browser/browser-session-partition.ts:135-165` — `configureBrowserSessionPartition`
- [Vấn đề]: grep `PermissionRequestHandler|PermissionCheckHandler` trên `src` không có kết quả (chỉ có `webRequest.onBeforeSendHeaders` ở `google-auth-identity.ts:364`). `[INFERENCE]` theo mục danh sách kiểm bảo mật của Electron: khi không có handler, yêu cầu quyền (camera, micro, định vị, thông báo…) của trang web được chấp thuận tự động. Ứng dụng này tải storefront và trang tùy ý và còn chạy agent tự động.
- [Code cũ] (`browser-session-partition.ts`):
```ts
  if (partition && configuredPartitions.has(partition)) {
    return sess;
  }
  if (partition) {
    configuredPartitions.add(partition);
  }
  if (mode === 'native') {
```
- [Code mới]:
```ts
/** Permissions a page may use without a prompt: none of these reach hardware, location or the user's notifications. */
const AUTO_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

function installPermissionPolicy(sess: Session, partition: string): void {
  sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const granted = AUTO_GRANTED_PERMISSIONS.has(permission);
    if (!granted) recordLifecycleEvent('permission.denied', { partition, permission, url: details.requestingUrl });
    callback(granted);
  });
  sess.setPermissionCheckHandler((_wc, permission) => AUTO_GRANTED_PERMISSIONS.has(permission));
}
// inside configureBrowserSessionPartition, right after configuredPartitions.add(partition):
  if (partition) {
    configuredPartitions.add(partition);
    installPermissionPolicy(sess, partition);
  }
```
- [Cấu hình nâng cấp]: nếu cần micro/camera cho một số site, thêm UI hỏi quyền hoặc allowlist theo origin. Đây là quyết định sản phẩm.
- [Lợi ích]: trang web không tự lấy được camera/micro/vị trí. Mọi từ chối đều có dấu vết trong journal.
- [Effort]: M · Impact: High · Risk: Trung bình. Có thể làm hỏng Meet/Zoom/định vị mà user đang dùng ngầm. Cần Tài chốt allowlist. Phần "mặc định Electron cho phép" là `[INFERENCE]`.
- [Bằng chứng]: grep `PermissionRequestHandler|PermissionCheckHandler|onHeadersReceived|webRequest\.` trên `src`; `browser-session-partition.ts:135-185`; `recordLifecycleEvent` đã được dùng trong file này ở `:152-155`.

### K25 — Lộ trình Electron 43→45 (node-pty, koffi, đóng gói, CDP) kèm TypeScript 7

`U25` · Trụ cột T3 · Effort L · Impact High · Verifier: VALIDATED · Nguồn: A:F20, B:F19, C:F22, D:F19, E:F25 (bản viết dùng: B:F19)

> Ghi chú verifier: Mọi 'gãy gì' của ứng viên là [INFERENCE]; không ai đọc changelog.
> Lưu ý về code mới (verifier): Bậc thang 43.8.8 → 44 → 45, mỗi bậc một gate. D:F19 ghi ^45.3.0 nhảy hai major, bỏ. Controller ghi Electron 45 gỡ shim preload sandbox (preload hiện 0 hit Buffer/setImmediate) và deprecate safeStorage đồng bộ (local-credential-vault.ts:213,217,258): không ứng viên nào nêu điểm này. Gate script check-node-pty-internals của C:F22 hợp lý.
> Hiệu chỉnh của controller: Bổ sung của controller: (1) API `safeStorage` đồng bộ bị deprecate và sẽ bị gỡ ở Electron 46 (tài liệu chính thức) — xem CO-1; (2) Electron 45 gỡ shim `Buffer`/`setImmediate`/`events`/`timers`/`url` khỏi preload sandbox (nguồn thứ cấp) — `src/preload/**` hiện 0 hit; (3) `chromeMediaSource`/`setDisplayMediaRequestHandler`/`openAsHidden`: 0 hit trong `src/`; (4) không file nào dùng compiler API của `typescript`, `tsconfig.json` đã `nodenext` + `rootDir` tường minh; `.tsbuildinfo` cũ phải xoá khi lên TS 7 (nguồn thứ cấp).

- [Trụ cột]: T3
- [Vị trí]: `package.json` (`electron`), `scripts/package-windows.mjs:32-35`, `:51-53`, `:79-102`
- [Vấn đề]: `electron ^43.7.9` → mới nhất 45.3.0 (packet §2.3), nhảy hai major. Native: `node-pty` (dùng ở `terminal-manager.ts:1`, `pty-worker.ts:16`) và `koffi` (`native-dialog-boxes.ts:1-2`, nạp qua `createRequire`). Đóng gói chỉ giải nén `*.node` + thư mục `node-pty` và sao chép prebuild `win32-x64` thủ công, đồng thời bỏ prebuild `darwin-*`/`win32-arm64` (`package-windows.mjs:51-53`). Có kiểm tra bắt buộc cho ba addon `pty.node`, `conpty.node`, `conpty_console_list.node` (`:97-102`), nên việc hỏng prebuild sẽ lộ ra khi đóng gói. `[INFERENCE]` rằng `node-pty`/`koffi` dùng prebuild N-API nên không cần rebuild theo ABI. Cần kiểm tra bằng thử nghiệm.
- [Code cũ] (`package.json`):
```json
    "electron": "^43.7.9",
```
- [Code mới] (làm trong nhánh riêng sau F4):
```json
    "electron": "^44.0.0",
```
rồi 45.x. Mỗi bước nhảy một major, không nhảy hai bậc cùng lúc.
- [Cấu hình nâng cấp]:
```
git switch -c chore/electron-44
npm install electron@^44 --save-dev
npm run rebuild && npm run test:main && npm run smoke:terminal && npm run smoke:cdp && npm run smoke:google
npm run package           # yêu cầu có pty.node, conpty.node, conpty_console_list.node ở app.asar.unpacked
```
Gate bắt buộc trước khi lên 45: `smoke:terminal` (node-pty), `smoke:owned-cdp` (`debugger.attach('1.3')` dùng ở `native-tab-host.ts:11903`, `11960`, `12101`), `smoke:oauth-popup` (`setWindowOpenHandler`, `:8792`).
- [Lợi ích]: nhận bản vá Chromium/Electron. Tránh nợ nâng cấp dồn.
- [Effort]: L · Impact: High · Risk: Cao (native + CDP + packaging). Chi tiết breaking change là `[INFERENCE]`, tôi chưa đọc ghi chú phát hành.
- [Bằng chứng]: `package-windows.mjs:30-106`; `native-dialog-boxes.ts:1-2`; `pty-worker.ts:16`; `native-tab-host.ts:11903`.

### K26 — Ba view chrome chạy sandbox:false vì preload không được bundle

`U26` · Trụ cột T5 · Effort L · Impact Med · Verifier: VALIDATED · Nguồn: A:F19, C:F20, E:F23 (bản viết dùng: C:F20)

> Ghi chú verifier: E ghi High; app chỉ tải file cục bộ nên rủi ro thực tế Med.
> Lưu ý về code mới (verifier): standalone-preload dùng clipboard từ electron: [INFERENCE] không có trong preload sandbox nên cần chuyển qua IPC. Ghi bundle ra thư mục riêng để tsc incremental không ghi đè. Tôi không đọc resolvePreloadAsset.

- [Trụ cột]: T5
- [Vị trí]: `src/main/browser/project-window-shell.ts:331-335` (toolbar), `:417-421` (frame backdrop), `:442-446` (sidebar); `:225-227` (`resolvePreloadAsset`)
- [Vấn đề]: ba view giao diện của shell đặt `sandbox: false`, khác chính sách của tab web (`security-policy.ts:129-135`). Preload của chúng chỉ import `electron` và `../shared/contracts` (`src/preload/toolbar-preload.ts:5-7`, `frame-backdrop-preload.ts:5-6`, `standalone-preload.ts:1-3`), nên lý do kỹ thuật khả dĩ là sandbox không cho `require` module tương đối, vốn được biên dịch riêng bằng tsc. Toolbar hiển thị tiêu đề tab lấy từ trang web, nên nên có thêm một lớp.
- [Code cũ] (`:330-335`):
```ts
      webPreferences: {
        preload: resolvePreloadAsset('toolbar-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
```
- [Code mới] (`project-window-shell.ts`):
```ts
export function resolveSandboxedPreloadAsset(fileName: string): string {
  return path.join(__dirname, '..', '..', 'preload-sandboxed', fileName);
}
...
      webPreferences: {
        preload: resolveSandboxedPreloadAsset('toolbar-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
```
Thêm `scripts/build-preloads.mjs` (theo mẫu `scripts/build-extension.mjs:16-25`):
```js
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = process.env.ANTIFAN_COMPILED_ROOT ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT) : path.join(root, '.compiled');
for (const name of ['toolbar-preload', 'standalone-preload', 'frame-backdrop-preload']) {
  await esbuild.build({
    entryPoints: [path.join(compiled, 'src', 'preload', `${name}.js`)],
    outfile: path.join(compiled, 'src', 'preload-sandboxed', `${name}.js`),
    bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false,
  });
}
```
- [Cấu hình nâng cấp]: thêm `&& node scripts/build-preloads.mjs` ngay sau `node scripts/copy-static.mjs` trong script `compile` (`package.json:27`); ghi ra thư mục riêng để tsc incremental không ghi đè bản đã bundle.
- [Lợi ích]: renderer chrome không còn Node access nếu bị XSS; chính sách đồng nhất.
- [Effort]: L · Impact: Med–High · Risk: `standalone-preload.ts` dùng `clipboard` từ `electron` (`:1`). Theo hiểu biết của tôi API này không còn có trong preload sandbox ở Electron mới (`[INFERENCE]`, chưa đọc tài liệu Electron 43), nên có thể phải chuyển sang IPC. Cần chạy `scripts/smoke-*` và probe cửa sổ dự án.
- [Bằng chứng]: `project-window-shell.ts:225-227`, `:331-335`, `:417-421`, `:442-446`; `src/preload/*` grep import; `security-policy.ts:129-135`; `build-extension.mjs:1-25`; `package.json:27`.

### K27 — Tách bảng CHROME_ROUTES (~100 route IPC) ra khỏi class NativeTabHost 15k dòng

`U27` · Trụ cột T1 · Effort L · Impact Med · Verifier: VALIDATED · Nguồn: E:F24 (bản viết dùng: E:F24)

> Ghi chú verifier: Impact là bảo trì, không phải runtime.
> Lưu ý về code mới (verifier): Điểm kết thúc ~5445 chưa xác định chính xác. Giữ tên NativeTabHost.CHROME_ROUTES để test cũ chạy. Export trước isTrustedSessionVaultSender, spaceSplitSessionId.

- [Trụ cột]: T1
- [Vị trí]: `src/main/browser/native-tab-host.ts:2611` (khai báo) đến khoảng `:5445`; class `:1374-17043`; `./ipc-router` đã có (`:87`)
- [Vấn đề]:
  - ~100 route (`channel`/`surface`/`run`) sống trong một `static readonly` của class `NativeTabHost`.
  - Mỗi route chỉ dùng `host` được truyền vào qua tham số (`run: ({ host }, event, args)`), nên không cần ở trong class.
  - Hậu quả: file không thể review, mọi sửa nhỏ làm biên dịch lại 17k dòng, và test khó cô lập theo surface.
- [Code cũ]:
```ts
  public static readonly CHROME_ROUTES: readonly IpcRoute[] = [
  {
    channel: FRAME_BACKDROP_CHANNELS.FOCUS_PANE,
    kind: 'on',
    surface: 'frameBackdrop',
```
- [Code mới]: mỗi nhóm một module, class chỉ ghép:
```ts
// src/main/browser/ipc/toolbar-routes.ts
import type { IpcRoute } from '../ipc-router';
export const toolbarRoutes: readonly IpcRoute[] = [ /* TOOLBAR_CHANNELS.* rows, 2648–3290 */ ];
// src/main/browser/ipc/terminal-routes.ts  (TERMINAL_CHANNELS.*, 3290–4140, 4653–4980)
// src/main/browser/ipc/capsule-routes.ts   (antifan:capsule:*, 4523–4650, 4988–5036)
// src/main/browser/ipc/workflow-routes.ts  (antifan:workflow:*, 4162–4380)
```
```ts
  public static readonly CHROME_ROUTES: readonly IpcRoute[] = [
    ...frameBackdropRoutes, ...toolbarRoutes, ...terminalRoutes, ...capsuleRoutes, ...workflowRoutes,
  ];
```
Các hàm phụ như `isTrustedSessionVaultSender`, `spaceSplitSessionId` cần xuất khỏi module chung trước.
- [Lợi ích]: `native-tab-host.ts` giảm ~2.8k dòng ngay; ranh giới theo surface rõ ràng; dễ viết test route-level.
- [Effort]: L · Impact: High (bảo trì) · Risk: trung bình (di chuyển cơ học, các test `test/main` import thẳng `NativeTabHost.CHROME_ROUTES` vẫn chạy nếu giữ tên).
- [Bằng chứng]: `native-tab-host.ts:87`, `:1374`, `:2611`, grep `^    channel: ` (các dòng 2613–5439), `:17043` (hết class). Điểm kết thúc chính xác của bảng chưa xác định, ≈ sau `SET_WIDTH` ở `:5439`.

### K28 — Ghim toolchain: @types/node khớp Node của Electron, thiếu engines, ghim typescript

`U28` · Trụ cột T3 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: B:F20, E:F22 (bản viết dùng: B:F20)

> Lưu ý về code mới (verifier): @types/node phải khớp Node nhúng trong Electron đích, không phải Node hệ thống 24 (B tự nêu). engines >=24 ở root có thể cảnh báo sai với Electron.
> Hiệu chỉnh của controller: Đã xác nhận `package.json` gốc không có `engines` và không có `overrides`. `packages/site-clone` còn `@types/node ^20.11.0`, `typescript ^5.3.3`.

- [Trụ cột]: T3
- [Vị trí]: `package.json` (devDependencies); `packages/super-core/package.json`; `tsconfig.json:5-7`
- [Vấn đề]: `@types/node ^22` trong khi máy phát triển chạy Node v24.13.0 (packet §0). `super-core` dùng `node:sqlite` (`index.ts:5`), nên kiểu cần khớp runtime. Không có trường `engines` ở manifest nào (grep `engines` trên ba manifest: 0 hit), nên không có cảnh báo khi chạy sai Node. `typescript ^5.5.0` cho phép 5.9.x. Gói TypeScript 7 (mới nhất 7.0.2 theo packet) không có consumer API: grep `require('typescript')` trên `scripts;src;packages/site-clone/src;test` không có kết quả, nên chỉ cần CLI `tsc`. Lưu ý: tôi không kiểm chi tiết tùy chọn nào của `tsconfig` mà TS 7 bỏ, đó là `[INFERENCE]`.
- [Code cũ]:
```json
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
```
- [Code mới]:
```json
  "engines": { "node": ">=24" },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "~5.9.3"
  }
```
(`@types/node` 24 chỉ đúng nếu tiến trình chạy mã `src/main` là Node 24, mà Electron 43 nhúng một bản Node riêng. Hãy khớp với bản Node của Electron, không phải Node hệ thống. Đó là `[INFERENCE]`.)
- [Cấu hình nâng cấp]: ghim `~5.9.3` chặn trôi vào bản 5.x mới ngoài ý muốn. Thử TS 7 trong nhánh riêng chạy `npm run typecheck`.
- [Lợi ích]: kiểu khớp runtime thật. Có cảnh báo khi sai phiên bản Node.
- [Effort]: S · Impact: Low–Med · Risk: Thấp–Trung bình. Nâng `@types/node` có thể lộ lỗi kiểu mới.
- [Bằng chứng]: `package.json`; `packages/super-core/package.json`; `tsconfig.json:4-7`; grep `engines` và `require('typescript')`.

### K29 — WebSocketServer dựng 3 lần giống hệt, không đặt maxPayload

`U29` · Trụ cột T5 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: B:F21, C:F15, D:F12 (bản viết dùng: B:F21)

> Ghi chú verifier: Kẻ tấn công phải ở loopback hoặc LAN opt-in; ghi Med, hạ về Low.
> Lưu ý về code mới (verifier): Chọn trần sau khi đo khung vào lớn nhất; nếu không đo được thì 64 MiB. Với daemon-entry.ts:142 (D) đặt trần riêng.

- [Trụ cột]: T5
- [Vị trí]: `src/main/bridge/bridge-server.ts:628-635`, `:1987-1994`, `:2018-2026`
- [Vấn đề]: ba chỗ lặp cùng đối tượng cấu hình. Không có `maxPayload` (grep `maxPayload` trong file: 0 hit), nên dùng mặc định của thư viện `ws` (`[INFERENCE]` ~100 MiB). Xác thực token chỉ diễn ra sau khi nâng cấp (`:2104-2112`), tức một client chưa xác thực vẫn có thể gửi frame rất lớn tới khi kết nối bị đóng. HTTP đã có trần 64 KiB và 10 MiB (`:1091`, `:1717`) nhưng WS thì chưa.
- [Code cũ] (`:1987-1994`):
```ts
      this.wss = new WebSocketServer({
        server: this.httpServer,
        handleProtocols: (protocols: Set<string>) => {
          if (protocols.has('antifan-auth')) return 'antifan-auth';
          if (protocols.has('antifan')) return 'antifan';
          return false;
        },
      });
```
- [Code mới]:
```ts
const WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

function createBridgeWebSocketServer(server: http.Server): WebSocketServer {
  return new WebSocketServer({
    server,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    handleProtocols: (protocols: Set<string>) => {
      if (protocols.has('antifan-auth')) return 'antifan-auth';
      if (protocols.has('antifan')) return 'antifan';
      return false;
    },
  });
}
// :628   const newWss = createBridgeWebSocketServer(newServer);
// :1987  this.wss = createBridgeWebSocketServer(this.httpServer);
// :2018  this.wss = createBridgeWebSocketServer(altServer);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: một nơi cấu hình; frame quá lớn bị `ws` tự đóng với mã 1009.
- [Effort]: S · Impact: Med · Risk: Thấp–Trung bình. Cần đảm bảo không có thông điệp hợp lệ nào (ví dụ dữ liệu terminal hoặc ảnh) vượt 16 MiB. Cần đo giá trị lớn nhất thực tế, nếu không đo được thì đặt 64 MiB.
- [Bằng chứng]: `bridge-server.ts:627-635`, `1983-1995`, `2017-2027`, `2095-2112`, `1091`, `1717`; grep `maxPayload|perMessageDeflate|verifyClient` trả về 0 hit.

### K30 — So sánh token bridge bằng === (không constant-time)

`U30` · Trụ cột T5 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: A:F5, B:F6, C:F6, D:F11, E:F5 (bản viết dùng: B:F6)

> Ghi chú verifier: 5/5 ứng viên nêu: nhất quán nhưng mức tác động thấp (token là randomUUID, mặc định loopback).
> Lưu ý về code mới (verifier): Băm sha256 hai phía trước timingSafeEqual (A/B/D) tránh lộ độ dài. Bản Buffer.length của C/E rò độ dài, chấp nhận được với UUID.

- [Trụ cột]: T5
- [Vị trí]: `src/main/bridge/bridge-server.ts:1050` (HTTP), `:2105` (WebSocket)
- [Vấn đề]: master token so bằng `clientToken === this.token`. Bridge có LAN opt-in (`:598-600`, bind `0.0.0.0`). Khi đó một máy cùng LAN có thể đo timing. Mức độ là thấp vì mặc định chỉ bind loopback.
- [Code cũ]:
```ts
      const isBridgeToken = Boolean(clientToken && clientToken === this.token);
```
- [Code mới] (`crypto` đã được import ở `:13`):
```ts
function tokensEqual(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  // hashing first makes both buffers 32 bytes, so timingSafeEqual neither throws on length nor leaks it
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(presented).digest(),
    crypto.createHash('sha256').update(expected).digest(),
  );
}
// :1050 and :2105
      const isBridgeToken = tokensEqual(clientToken, this.token);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: loại timing oracle trên master token khi bật LAN.
- [Effort]: S · Impact: Low–Med · Risk: Thấp
- [Bằng chứng]: `bridge-server.ts:12-14`, `341`, `1049-1050`, `2104-2105`, `598-600`.

### K31 — body += chunk ghép Buffer thành chuỗi ở hai route bridge (cắt ký tự UTF-8 ở ranh giới chunk)

`U31` · Trụ cột T5 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: D:F16 (bản viết dùng: D:F16)

> Lưu ý về code mới (verifier): Dùng chunks.push + Buffer.concat(...).toString('utf8') trong 'end'. Route cookies import 10 MB chỉ bị ảnh hưởng với ký tự đa byte.
> Hiệu chỉnh của controller: Đã xác nhận `body += chunk` ở `bridge-server.ts:1103` và `:1729`; không có `setEncoding` trong file.

- [Trụ cột]: T5
- [Vị trí]: `src/main/bridge/bridge-server.ts:1094-1104` (pairing, 64 KB) và `1720-1730` (cookies import, 10 MB)
- [Vấn đề]: `body += chunk` ép từng `Buffer` về chuỗi UTF-8 riêng lẻ. Ký tự nhiều byte bị cắt ngang ranh giới chunk sẽ thành `U+FFFD` và `JSON.parse` có thể sai hoặc ném lỗi (nhất là tên cookie/giá trị có ký tự Việt trong route 10 MB). Hai đoạn code gần như giống hệt nhau.
- [Code cũ]:
```ts
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            isTooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Payload Too Large (max 10MB)' }));
            req.destroy();
            return;
          }
          body += chunk;
        });
```
- [Code mới]:
```ts
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            isTooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Payload Too Large (max 10MB)' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        // trong req.on('end'): const body = Buffer.concat(chunks).toString('utf8');
```
(áp dụng cho cả pairing; gom thành helper `readBoundedBody(req, max)` nếu muốn bỏ trùng.)
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: giải mã UTF-8 đúng một lần trên toàn bộ body.
- [Effort]: S · Impact: Low · Risk: thấp. `[INFERENCE]`: chưa tái hiện lỗi cắt ký tự (cần chunk biên đúng vị trí).
- [Bằng chứng]: đọc `bridge-server.ts:1090-1106`, `1716-1735`.

### K32 — edit-guard.appendRows: mkdir + exists + stat + append mỗi lần ghi audit

`U32` · Trụ cột T4 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F15, B:F22, C:F10, D:F8 (bản viết dùng: D:F8)

> Ghi chú verifier: A/D nói 'mỗi tool call'; thực tế chỉ ghi khi allow/block write và eval, tần suất thấp hơn.
> Lưu ý về code mới (verifier): Trạng thái logBytes/logDirReady lưu trong GuardSession (D) hoặc Map cấp module (C). Phải cài lại hook.

- [Trụ cột]: T4
- [Vị trí]: `src/omp-hooks/edit-guard.ts:256-267` — `appendRows`
- [Vấn đề]: mỗi lần ghi dòng audit (ở mỗi tool call bị đánh giá) đều chạy `mkdirSync(recursive)`, `existsSync`, `statSync` để kiểm tra kích thước rồi mới `appendFileSync`. Kích thước file chỉ tăng đơn điệu, theo dõi trong bộ nhớ là đủ.
- [Code cũ]:
```ts
    const dir = path.dirname(session.logPath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(session.logPath) && fs.statSync(session.logPath).size > LOG_ROTATE_BYTES) {
      fs.renameSync(session.logPath, session.logPath.replace(/\.jsonl$/, ".1.jsonl"));
    }
    fs.appendFileSync(session.logPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
```
- [Code mới] (thêm `logDirReady?: boolean; logBytes?: number` vào `GuardSession`):
```ts
    if (!session.logDirReady) {
      fs.mkdirSync(path.dirname(session.logPath), { recursive: true });
      session.logDirReady = true;
    }
    if (session.logBytes === undefined) {
      try { session.logBytes = fs.statSync(session.logPath).size; } catch { session.logBytes = 0; }
    }
    if (session.logBytes > LOG_ROTATE_BYTES) {
      fs.renameSync(session.logPath, session.logPath.replace(/\.jsonl$/, ".1.jsonl"));
      session.logBytes = 0;
    }
    const chunk = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    fs.appendFileSync(session.logPath, chunk, "utf8");
    session.logBytes += Buffer.byteLength(chunk);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: từ 4 syscall còn 1 mỗi lần ghi (sau lần đầu).
- [Effort]: S · Impact: Low–Med · Risk: thấp (log theo session nên không ai khác xoay file). Hook cần cài lại.
- [Bằng chứng]: đọc raw `edit-guard.ts:251-267`; grep `LOG_ROTATE_BYTES` ở dòng 71.

### K33 — leader-guard đọc và parse registry mỗi tool_call; findOpenJobs parse mọi job.json mỗi session_stop

`U33` · Trụ cột T4 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F16, B:F5, D:F7 (bản viết dùng: B:F5)

> Ghi chú verifier: Một file nhỏ mỗi call; D ghi Med, hạ về Low.
> Lưu ý về code mới (verifier): Cache theo mtime+size vẫn giữ ngữ nghĩa 'đọc mới mỗi call'. Giữ vòng retry cho lỗi tạm thời. A:F16 (findOpenJobs) tần suất thấp hơn.

- [Trụ cột]: T4
- [Vị trí]: `src/omp-hooks/leader-guard.ts:111-133`; call site `:1084` và `:1064`
- [Vấn đề]: handler tại `:1084` chạy `await isLeaderTerminal()` trước mọi quyết định cho mỗi lần gọi tool. Mỗi lần là một `readFileSync` + `JSON.parse` của `leaders.json`. Terminal id đứng yên nên đáp án hầu như không đổi. `[INFERENCE]` hook này được cài cho mọi phiên OMP có terminal id.
- [Code cũ]:
```ts
      const file = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { leaders?: unknown };
      return Array.isArray(file?.leaders) && file.leaders.includes(terminalId);
```
- [Code mới]:
```ts
let leadersCache: { path: string; mtimeMs: number; size: number; leaders: ReadonlySet<string> } | null = null;

function readLeaders(registryPath: string): ReadonlySet<string> {
  const st = fs.statSync(registryPath); // same ENOENT/EBUSY codes as the read, so the retry logic below is unchanged
  if (leadersCache && leadersCache.path === registryPath && leadersCache.mtimeMs === st.mtimeMs && leadersCache.size === st.size) {
    return leadersCache.leaders;
  }
  const file = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { leaders?: unknown };
  const leaders = new Set(Array.isArray(file?.leaders) ? file.leaders.filter((x): x is string => typeof x === "string") : []);
  leadersCache = { path: registryPath, mtimeMs: st.mtimeMs, size: st.size, leaders };
  return leaders;
}
// in the try block:
      return readLeaders(registryPath).has(terminalId);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: mỗi tool call còn một `stat` thay vì đọc file + parse. Giảm độ trễ hook cộng vào mọi lời gọi tool.
- [Effort]: S · Impact: Med · Risk: Thấp. Khóa theo `(mtime,size)`. Nếu ghi hai lần cùng mtime và cùng size, cache có thể cũ. Registry được ghi bằng rename nên mtime đổi.
- [Bằng chứng]: `leader-guard.ts:109-133`, `1063-1064`, `1083-1084`.

### K34 — edit-guard eval: gọi isLeaderWorker() (đọc registry) trước planEvalThemeCode thuần

`U34` · Trụ cột T4 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: C:F7 (bản viết dùng: C:F7)

> Lưu ý về code mới (verifier): Đảo thứ tự tương đương hành vi; nhánh bash đã làm đúng thứ tự. Cài lại hook edit-guard, chạy edit-guard.test.mjs.

- [Trụ cột]: T4
- [Vị trí]: `src/omp-hooks/edit-guard.ts:619-625` (nhánh `eval` của `tool_call`), `:329-352` (`lookupLeaderWorker`)
- [Vấn đề]: sau `planEvalSelfSpawn`, hook gọi `await isLeaderWorker()` trước, rồi mới chạy `planEvalThemeCode`. `lookupLeaderWorker` đọc và `JSON.parse` file registry mỗi lần (`:329-342`, cố ý đọc mới mỗi lần theo comment `:319-328`). `planEvalThemeCode` là hàm thuần và trả `allow` ngay khi cell không chứa subprocess (`theme-push-policy.ts:1961-1962`). Nhánh bash đã làm đúng thứ tự: kiểm `mentionsThemeCli` trước khi tra (`edit-guard.ts:370-371`). Mọi eval của mọi session trong terminal AntiFan đang trả một lần đọc đĩa vô ích.
- [Code cũ] (`edit-guard.ts:619-625`):
```ts
        if (await isLeaderWorker()) {
          const evalPlan = planEvalThemeCode(typeof input.code === "string" ? input.code : "");
          if (evalPlan.decision === "block") {
            appendRows(session, [rowFor(session, "eval", "", "block", evalPlan.code)]);
            warnSafely(pi, evalPlan.reason);
            return { block: true, reason: evalPlan.reason };
          }
        }
```
- [Code mới]:
```ts
        const evalPlan = planEvalThemeCode(typeof input.code === "string" ? input.code : "");
        if (evalPlan.decision === "block" && (await isLeaderWorker())) {
          appendRows(session, [rowFor(session, "eval", "", "block", evalPlan.code)]);
          warnSafely(pi, evalPlan.reason);
          return { block: true, reason: evalPlan.reason };
        }
```
- [Cấu hình nâng cấp]: không áp dụng; cài lại hook bằng `node scripts/install-omp-hooks.mjs --install --hook edit-guard`.
- [Lợi ích]: loại bỏ 1 lần `readFileSync`+`JSON.parse` (kèm nguy cơ retry khi EBUSY) khỏi đường đi mỗi lần gọi eval.
- [Effort]: S · Impact: Med · Risk: hành vi tương đương, vì kết quả chỉ khác khi `evalPlan` block thì mới cần biết worker hay không. Giữ các test `edit-guard.test.mjs`.
- [Bằng chứng]: `edit-guard.ts:329-352`, `:366-371`, `:610-625`; `theme-push-policy.ts:1961-1964`. Tần suất eval là `[INFERENCE]` (không đo).

### K35 — Lỗi ghi audit log của edit-guard bị nuốt im lặng

`U35` · Trụ cột T5 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: E:F9 (bản viết dùng: E:F9)

> Lưu ý về code mới (verifier): Báo một lần bằng stderr trong hook có thể hiện trong TUI của agent: cân nhắc kênh khác.

- [Trụ cột]: T5
- [Vị trí]: `src/omp-hooks/edit-guard.ts:256-268` — `appendRows`
- [Vấn đề]: đây là nhật ký kiểm toán của guard chặn ghi file. Khi ghi lỗi (đĩa đầy, ACL, EPERM), `catch` rỗng làm mất bằng chứng mà không ai biết.
- [Code cũ]:
```ts
  } catch {
    /* audit is best-effort: never break the session over a log write */
  }
```
- [Code mới] (vẫn không làm hỏng phiên, nhưng báo một lần/phiên):
```ts
let auditFailureReported = false;
…
  } catch (err) {
    /* never break the session over a log write, but do not lose the evidence silently */
    if (!auditFailureReported) {
      auditFailureReported = true;
      try {
        process.stderr.write(`[edit-guard] audit log write failed (${(err as NodeJS.ErrnoException)?.code ?? 'ERR'}): ${session.logPath}\n`);
      } catch {}
    }
  }
```
- [Lợi ích]: lỗi của kênh kiểm toán thấy được; vẫn fail-open.
- [Effort]: S · Impact: Low-Med · Risk: rất thấp (stderr một lần).
- [Bằng chứng]: `edit-guard.ts:256-268`.

### K36 — listTools của proxy dựng lại schema và biên dịch RegExp mỗi lần gọi

`U36` · Trụ cột T4 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F7, B:F12, D:F9, E:F6 (bản viết dùng: B:F12)

> Ghi chú verifier: 4 ứng viên viện 'ổn định prompt-cache', nhưng đầu ra đã xác định theo thứ tự definitions; memoize chỉ tiết kiệm CPU và tools/list được gọi hiếm. A ghi đúng Low, B/D/E ghi Med.
> Lưu ý về code mới (verifier): Memoize cố định khóa (env không đổi trong tiến trình). Chạy check-mcp-budget-dominance vì gate gọi proxy.listTools().

- [Trụ cột]: T4
- [Vị trí]: `scripts/antifan-omp-mcp.cjs:4034-4043` (`listTools`), `:1514-1522` (`matchCapabilityPattern`), `:4004-4031` (`publishedTool`)
- [Vấn đề]: mỗi `tools/list` chạy `resolveAllowedCapabilities`/`resolveForbiddenCapabilities` (đọc env + `process.argv.find`). Rồi lọc toàn bộ `definitions`, và `matchCapabilityPattern` biên dịch RegExp mới cho mỗi cặp (pattern × tool). Sau đó dựng lại từng object schema. Đầu vào (env, argv, `isFixerSession`) không bị gán lại trong tiến trình (`:1450-1452`, grep không có gán `ANTIFAN_ALLOWED_CAPABILITIES =`). Danh sách trả về nên cố định trong đời một tiến trình. Danh sách ổn định và đúng thứ tự `definitions` là điều kiện để prompt cache của client không bị vô hiệu bởi thứ tự hoặc nội dung đổi.
- [Code cũ]:
```js
async function listTools() {
  const allowedCaps = resolveAllowedCapabilities();
  const forbiddenCaps = resolveForbiddenCapabilities();
  const filteredDefs = (allowedCaps || forbiddenCaps)
    ? definitions.filter(([name]) => isCapabilityPermitted(name, allowedCaps, forbiddenCaps))
    : definitions;
  return {
    tools: filteredDefs.map(publishedTool),
  };
}
```
- [Code mới]:
```js
// Filters and definitions are fixed for the life of the process, so the advertised list is built once:
// same objects, same order on every tools/list (a stable prefix for the client's prompt cache).
let publishedToolList = null;
async function listTools() {
  if (publishedToolList === null) {
    const allowedCaps = resolveAllowedCapabilities();
    const forbiddenCaps = resolveForbiddenCapabilities();
    const filteredDefs = (allowedCaps || forbiddenCaps)
      ? definitions.filter(([name]) => isCapabilityPermitted(name, allowedCaps, forbiddenCaps))
      : definitions;
    publishedToolList = filteredDefs.map(publishedTool);
  }
  return { tools: publishedToolList };
}

const capabilityPatternCache = new Map();
function matchCapabilityPattern(name, pattern) {
  const trimmed = pattern.trim();
  if (trimmed === '*' || trimmed === name) return true;
  if (!trimmed.includes('*') && !trimmed.includes('?')) return name === trimmed;
  let re = capabilityPatternCache.get(trimmed);
  if (!re) {
    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    re = new RegExp(`^${escaped}$`);
    capabilityPatternCache.set(trimmed, re);
  }
  return re.test(name);
}
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: `tools/list` O(1) sau lần đầu. Danh sách tool byte-identical giữa các phiên, tốt cho prompt cache. Regex không còn biên dịch lặp.
- [Effort]: S · Impact: Med · Risk: Thấp. Mất khả năng đổi bộ lọc giữa chừng, và `[INFERENCE]` rằng không có test nào dựa vào điều đó. Cần chạy `scripts/check-mcp-budget-dominance.mjs` (nó gọi `proxy.listTools()` ở `:431`).
- [Bằng chứng]: `antifan-omp-mcp.cjs:1450-1452`, `1478-1563`, `4004-4043`; `check-mcp-budget-dominance.mjs:431`.

### K37 — importScout prepare lại câu lệnh trong từng dòng JSONL (~12 bảng)

`U37` · Trụ cột T2 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: A:F13, D:F24 (bản viết dùng: A:F13)

> Lưu ý về code mới (verifier): Kiểu row: (l: any) => unknown[] trong helper của A chấp nhận được. Giữ khối principles vì có mergePrincipleProvenance. Test super-core có 1 lỗi môi trường 'populated core.db' ở worktree trần.

- [Trụ cột]: T2
- [Vị trí]: `packages/super-core/src/index.ts:402-467` (nhiều khối giống nhau), trong transaction `BEGIN` (`:366`)
- [Vấn đề]: 12 khối kiểu `for (const l of jsonl(...)) { this.db.prepare('INSERT OR REPLACE INTO …').run(...) }`; mỗi dòng JSONL tốn một lần compile SQL. Các câu lệnh khác của hàm đã được hoist vào `ins` (`:330-358`), phần này không. Tần suất import thực tế chưa đo `[INFERENCE]`. Cùng lúc, việc gộp bằng helper bỏ ~60 dòng lặp.
- [Code cũ] (`:402-409`):
```ts
      for (const l of jsonl(path.join(reportsDir, 'experience-nodes.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO experience_nodes(nodeId,kind,refId,label,context,createdAt) VALUES (?,?,?,?,?,?)')
          .run(l.nodeId ?? `exp-${uuid()}`, l.kind, l.refId ?? null, l.label ?? null, l.context ?? null, l.createdAt ?? now());
      }
      for (const l of jsonl(path.join(reportsDir, 'experience-edges.jsonl'))) {
        this.db.prepare('INSERT OR REPLACE INTO experience_edges(edgeId,fromNodeId,toNodeId,kind,evidence,createdAt) VALUES (?,?,?,?,?,?)')
          .run(l.edgeId ?? `edge-${uuid()}`, l.fromNodeId, l.toNodeId, l.kind, l.evidence ?? null, l.createdAt ?? now());
      }
```
- [Code mới]:
```ts
      // trong importScout, sau khai báo `ins`
      const loadJsonl = (file: string, sql: string, row: (l: any) => unknown[]): void => {
        const stmt = this.db.prepare(sql);
        for (const l of jsonl(path.join(reportsDir, file))) stmt.run(...(row(l) as never[]));
      };
      loadJsonl('experience-nodes.jsonl',
        'INSERT OR REPLACE INTO experience_nodes(nodeId,kind,refId,label,context,createdAt) VALUES (?,?,?,?,?,?)',
        (l) => [l.nodeId ?? `exp-${uuid()}`, l.kind, l.refId ?? null, l.label ?? null, l.context ?? null, l.createdAt ?? now()]);
      loadJsonl('experience-edges.jsonl',
        'INSERT OR REPLACE INTO experience_edges(edgeId,fromNodeId,toNodeId,kind,evidence,createdAt) VALUES (?,?,?,?,?,?)',
        (l) => [l.edgeId ?? `edge-${uuid()}`, l.fromNodeId, l.toNodeId, l.kind, l.evidence ?? null, l.createdAt ?? now()]);
      // … các tệp còn lại (anti-patterns, workarounds, fix-patterns, hidden-requirements, commercial-intel, tool-intel, archetypes, platform-semantics, practice-parity, skill-versions) cùng mẫu
```
  (Giữ nguyên khối `principles.jsonl` vì có nhánh `mergePrincipleProvenance`.)
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: một lần compile mỗi bảng; bớt ~60 dòng lặp.
- [Effort]: S · Impact: Low · Risk: Thấp. Chạy `packages/super-core` test (lưu ý memory: một test đỏ môi trường `populated core.db` trong worktree trần).
- [Bằng chứng]: `index.ts:330-366`, `398-467`.

### K38 — contextPack: unitPlatform N+1 truy vấn khi lọc unknowns theo platform

`U38` · Trụ cột T2 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: B:F13 (bản viết dùng: B:F13)

> Ghi chú verifier: B ghi Med; mỗi truy vấn là một SELECT DISTINCT theo idx_claims_unit, hạ về Low.
> Lưu ý về code mới (verifier): Truy vấn IN chia lô 500 như B đề xuất. Phần (b) importScout của B:F13 thuộc U37.

- [Trụ cột]: T2
- [Vị trí]: `packages/super-core/src/index.ts:818-823` (lọc `unknowns`), `:526-530` (`unitPlatform`), `:402-462` (các `INSERT` trong vòng lặp)
- [Vấn đề]: (a) với `opts.platform`, mỗi unit trong `unknowns` gọi `unitPlatform(u.unitId)` = một `prepare` + `SELECT DISTINCT` riêng. `contextPack` chạy mỗi lần khởi động task và pack mẫu trong prompt này có `unknowns: n=34`. (b) `importScout` gọi `this.db.prepare(...)` bên trong `for (const l of jsonl(...))` cho ~12 bảng (`:403`, `:407`, `:411`, `:415`, …), tức compile lại câu lệnh cho từng dòng JSONL, trong khi `ins` ở `:330-359` đã dùng đúng cách hoist. Các truy vấn `claims_fts`/`bm25` và index nằm ở mức tốt, nên đây không phải điểm yếu cốt lõi.
- [Code cũ] (`:818-823`):
```ts
    if (opts.platform) {
      unknowns = unknowns.filter((u) => {
        const p = this.unitPlatform(u.unitId);
        return p === opts.platform || (opts.includeGlobal && p === null);
      });
    }
```
- [Code mới]:
```ts
  // Unanimous platform of each unit's claims in one pass per 500 units; null when absent or ambiguous.
  private unitPlatforms(unitIds: string[]): Map<string, string | null> {
    const seen = new Map<string, Set<string>>();
    for (let i = 0; i < unitIds.length; i += 500) {
      const chunk = unitIds.slice(i, i + 500);
      const rows = this.db.prepare(
        `SELECT DISTINCT unitId, contextPlatform AS p FROM claims WHERE contextPlatform IS NOT NULL AND unitId IN (${chunk.map(() => '?').join(',')})`,
      ).all(...chunk as never[]) as Array<{ unitId: string; p: string }>;
      for (const r of rows) {
        const set = seen.get(r.unitId) ?? new Set<string>();
        set.add(r.p);
        seen.set(r.unitId, set);
      }
    }
    const out = new Map<string, string | null>();
    for (const id of unitIds) {
      const set = seen.get(id);
      out.set(id, set && set.size === 1 ? [...set][0]! : null);
    }
    return out;
  }
// :818
    if (opts.platform) {
      const platformOf = this.unitPlatforms(unknowns.map((u) => u.unitId));
      unknowns = unknowns.filter((u) => {
        const p = platformOf.get(u.unitId) ?? null;
        return p === opts.platform || (opts.includeGlobal && p === null);
      });
    }
```
Phần `importScout`: chuyển mỗi `this.db.prepare('INSERT OR REPLACE INTO experience_nodes…')` thành một statement trong `ins` (`:330`), ví dụ `ins.expNode = this.db.prepare('INSERT OR REPLACE INTO experience_nodes(nodeId,kind,refId,label,context,createdAt) VALUES (?,?,?,?,?,?)')` rồi gọi `ins.expNode.run(...)` trong vòng lặp. Làm tương tự cho 11 bảng còn lại.
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: số round-trip SQL của `contextPack` giảm từ N+1 xuống ⌈N/500⌉+1. Import nhanh hơn, vì không compile lại cho từng dòng.
- [Effort]: M · Impact: Med · Risk: Thấp–Trung bình. Cần chạy `npm run test:super-core` (có lưu ý môi trường: test 'populated core.db' đỏ trong worktree trần).
- [Bằng chứng]: `index.ts:330-359`, `402-462`, `526-530`, `804-823`; `schema.ts:193-196`, `554-562`.

### K39 — callTool dựng lại aliasMap ~105 mục mỗi lần; tra khóa prototype

`U39` · Trụ cột T1 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F9, D:F1 (bản viết dùng: D:F1)

> Ghi chú verifier: Lớp này không có caller production (chỉ smoke/test), nên 'mọi lời gọi MCP trong app' của A là sai. Lỗi prototype-key có thật nhưng nằm trong mã test-only.
> Lưu ý về code mới (verifier): Dùng Map hoặc Object.freeze ở module scope; aliasMap[toolName] || toolName trên object thường tra được khóa constructor/__proto__.

- [Trụ cột]: T1 (kèm T2)
- [Vị trí]: `src/main/mcp/mcp-server.ts:526-634` — `AntiFanMcpServer.callTool`
- [Vấn đề]: `aliasMap` là literal bên trong hàm (dòng 527-633). Mỗi tool call cấp phát lại ~105 entry rồi dùng một lần ở dòng 634. `aliasMap[toolName] || toolName` trên object thường: với `toolName` là `constructor`, `toString` hay `__proto__` sẽ trả về hàm/prototype có sẵn trong `Object.prototype` (truthy). `name` khi đó không phải chuỗi. Bảng này còn trùng một phần với bảng if-chain ở `mcp-tool-list.ts:23-61` và `CAPABILITY_MAP` ở `scripts/antifan-omp-mcp.cjs:638` (ba nguồn sự thật).
- [Code cũ] (rút gọn bằng dòng `// …`, các dòng còn lại verbatim):
```ts
    const aliasMap: Record<string, string> = {
      'anti.browser.tabs.create': 'antifan_open_tab',
      'anti.browser.open_tab': 'antifan_open_tab',
      'anti.browser.tabs.list': 'antifan_list_tabs',
      // … ~100 mục giữ nguyên …
      'anti.sheet.extract': 'antifan_sheet_extract',
      'sheet.extract': 'antifan_sheet_extract',
    };
    const name = aliasMap[toolName] || toolName;
```
- [Code mới]:
```ts
// module scope, đặt phía trên class AntiFanMcpServer
const TOOL_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  'anti.browser.tabs.create': 'antifan_open_tab',
  'anti.browser.open_tab': 'antifan_open_tab',
  // … chuyển nguyên văn toàn bộ mục của aliasMap cũ …
  'sheet.extract': 'antifan_sheet_extract',
}));
// trong callTool, thay dòng 527-634 bằng:
    const name = TOOL_ALIASES.get(toolName) ?? toolName;
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: bỏ ~105 allocation mỗi call. Hết lỗi tra key prototype. Là bước đầu để gộp ba bảng alias về một nguồn.
- [Effort]: S · Impact: Med · Risk: thấp. Hành vi giữ nguyên, trừ trường hợp key prototype.
- [Bằng chứng]: `mcp-server.ts:526-527`, `633-634`; grep `aliasMap` chỉ có một chỗ dùng (`mcp-server.ts:634`). `[INFERENCE]` về hậu quả khi `name` là hàm: không đọc đường xuống transport.

### K40 — Mã chết: applyProtectedFileDacl và nhánh else-if enforceProtectedFileDacl trong bridge-server

`U40` · Trụ cột T1 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: E:F10 (bản viết dùng: E:F10)

> Lưu ý về code mới (verifier): Sau khi xóa, bỏ enforceProtectedFileDacl khỏi import ở :42. resolveCurrentUserSid vẫn dùng ở nơi khác (E nêu :741, tôi chưa đọc).

- [Trụ cột]: T1
- [Vị trí]: `src/main/bridge/bridge-server.ts:137-151`
- [Vấn đề]:
  - Các kiểm tra `typeof applyProtectedPathsDacl === 'function'` trên hàm import tĩnh luôn đúng, nên nhánh `else if (typeof enforceProtectedFileDacl …)` không bao giờ chạy.
  - `export async function applyProtectedFileDacl` (`:149-151`) không có tham chiếu nào bên ngoài. Grep `applyProtectedFileDacl|applyProtectedPathsDaclBridge` trên `src;scripts;test/main;test/unit` chỉ thấy định nghĩa trùng tên ở `src/main/security/windows-acl.ts:545` (cùng test của nó) và 3 call site của `applyProtectedPathsDaclBridge` (`:924`, `:938`, `:961`).
  - `enforceProtectedFileDacl` chỉ được import để phục vụ nhánh chết (`:42`, `:141-144`).
- [Code cũ]:
```ts
export async function applyProtectedPathsDaclBridge(paths: string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  if (typeof applyProtectedPathsDacl === 'function') {
    await applyProtectedPathsDacl(paths);
  } else if (typeof enforceProtectedFileDacl === 'function') {
    const sid = typeof resolveCurrentUserSid === 'function' ? await resolveCurrentUserSid() : undefined;
    for (const p of paths) {
      await enforceProtectedFileDacl(p, sid);
    }
  }
}

export async function applyProtectedFileDacl(filePath: string): Promise<void> {
  await applyProtectedPathsDaclBridge([filePath]);
}
```
- [Code mới]:
```ts
export async function applyProtectedPathsDaclBridge(paths: string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  await applyProtectedPathsDacl(paths);
}
```
và import ở `:42` bỏ `enforceProtectedFileDacl`.
- [Lợi ích]: bỏ ~15 dòng và một API trùng tên gây nhầm với `windows-acl.ts:545`.
- [Effort]: S · Impact: Low · Risk: rất thấp; `resolveCurrentUserSid` vẫn dùng ở `:741`.
- [Bằng chứng]: các grep nêu trên.

### K41 — Băm lại file proxy ~150KB cho mỗi lần pairing

`U41` · Trụ cột T2 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: E:F15 (bản viết dùng: E:F15)

> Ghi chú verifier: Comment tại chỗ ghi cố ý 'rare, mỗi pairing một lần'; lợi ích nhỏ.
> Lưu ý về code mới (verifier): Cache theo mtime+size giữ đúng ngữ nghĩa 'đo lại khi file đổi'.

- [Trụ cột]: T2
- [Vị trí]: `src/main/bridge/bridge-server.ts:521-534` — `expectedProxyBuildHash`
- [Vấn đề]: comment tự nhận "~150KB read per pairing". Mỗi phiên agent mới kích hoạt một pairing (`antifan-omp-mcp.cjs`). File chỉ đổi khi nâng cấp build, nên stat nhanh đủ để cache an toàn theo `mtimeMs + size`.
- [Code cũ]:
```ts
      const content = fs.readFileSync(scriptPath);
      return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
```
- [Code mới]:
```ts
  private proxyHashCache: { mtimeMs: number; size: number; hash: string } | null = null;
  …
      const stat = fs.statSync(scriptPath);
      const cached = this.proxyHashCache;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
      const hash = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex').slice(0, 16);
      this.proxyHashCache = { mtimeMs: stat.mtimeMs, size: stat.size, hash };
      return hash;
```
- [Lợi ích]: giữ đúng ngữ nghĩa "đo lại khi file đổi", bỏ đọc 150 KB mỗi lần.
- [Effort]: S · Impact: Low · Risk: thấp.
- [Bằng chứng]: `bridge-server.ts:521-534`.

### K42 — Poll ack run-control dùng existsSync/readFileSync đồng bộ mỗi 100ms trên main

`U42` · Trụ cột T2 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F12, D:F22, E:F16 (bản viết dùng: A:F12)

> Ghi chú verifier: Chỉ chạy khi người dùng steer/cancel nên tác động thấp.
> Lưu ý về code mới (verifier): Bản A log lỗi không phải ENOENT; bản E nuốt lỗi. Phần nén JSON saved-tabs (E:F16) chưa kiểm test đọc định dạng pretty.

- [Trụ cột]: T2
- [Vị trí]: `native-tab-host.ts:5218-5232` (handler run-control), đọc run-file ở `:5129-5131` và `:5175-5177`
- [Vấn đề]: handler `async` trong tiến trình main lặp tối đa 5 s (`RUN_CONTROL_ACK_TIMEOUT_MS`, `:326`) mỗi 100 ms, mỗi vòng `existsSync` + `readFileSync` đồng bộ. Mỗi vòng chỉ vài syscall nên tác động nhỏ (Low) và chỉ chạy khi người dùng bấm steer/cancel, nhưng đây là loại chặn main thread mà packet đếm (671 call sync). Đường gọi: IPC steer/cancel của Manager.
- [Code cũ]:
```ts
        const pollIntervalMs = 100;
        const deadline = Date.now() + RUN_CONTROL_ACK_TIMEOUT_MS;
        let ackContent: string | null = null;

        while (Date.now() < deadline) {
          try {
            if (fs.existsSync(ackPath)) {
              ackContent = fs.readFileSync(ackPath, 'utf8');
              try { fs.unlinkSync(ackPath); } catch {}
              break;
            }
          } catch {}
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, pollIntervalMs);
          await promise;
        }
```
- [Code mới]:
```ts
        const pollIntervalMs = 100;
        const deadline = Date.now() + RUN_CONTROL_ACK_TIMEOUT_MS;
        let ackContent: string | null = null;

        while (Date.now() < deadline) {
          try {
            ackContent = await fs.promises.readFile(ackPath, 'utf8');
            await fs.promises.unlink(ackPath).catch(() => {});
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              recordLifecycleEvent('runControl.ackReadFailed', {
                code: (err as NodeJS.ErrnoException)?.code ?? null,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
        }
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: không chặn event loop trong cửa sổ chờ ack; lỗi đọc khác `ENOENT` được ghi nhận thay vì bị nuốt.
- [Effort]: S · Impact: Low · Risk: Thấp.
- [Bằng chứng]: `native-tab-host.ts:325-326`, `5129-5131`, `5175-5177`, `5207-5232`. `[INFERENCE]`: tần suất gọi thấp vì do thao tác người dùng.

### K43 — Log hot-path và cảnh báo bằng console.* thay vì recordLifecycleEvent (persist tabs, eval soft budget)

`U43` · Trụ cột T5 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: A:F14, E:F13 (bản viết dùng: E:F13)

> Lưu ý về code mới (verifier): Kiểm admitLine có giới hạn/loại sự kiện trước khi chuyển hàng loạt. Chuỗi 'running on laptop CPU' là giả định không kiểm chứng.

- [Trụ cột]: T5
- [Vị trí]: `src/main/browser/native-tab-host.ts:15378`, `:15426` (log thành công mỗi lần persist, debounce 400 ms ở `:15169-15172`); 59 `console.*` theo §2.2
- [Vấn đề]: mỗi lần persist tab ghi một dòng `console.log` text-trần, không `ts`/`pid`/mã lỗi. Lỗi (`:15381`, `:15429`) cũng chỉ là `console.warn` kèm object Error, không JSON, không vào `main.log`. Logger có cấu trúc `recordLifecycleEvent` đã được dùng trong chính file này (`:9384`). Kênh này đã có sẵn quay vòng/bounded (`main-lifecycle-log.ts:263-281`).
- [Code cũ]:
```ts
        console.log('[native-tab-host] Persisted tabs async to:', filePath);
…
        console.log('[native-tab-host] Persisted tabs sync to:', filePath);
```
và `console.warn('[native-tab-host] Failed to persist tabs sync:', err);`
- [Code mới]:
```ts
// success lines removed: a healthy persist is the normal case.
…
      recordLifecycleEvent('tabhost.persistFailed', {
        mode: 'sync',
        filePath,
        error: err instanceof Error
          ? { name: err.name, message: err.message, code: (err as NodeJS.ErrnoException).code }
          : String(err),
      });
```
- [Lợi ích]: log có cấu trúc, đối chiếu được với `ts`/`pid`; bớt ồn mỗi 400 ms.
- [Effort]: S cho 3 dòng này (M nếu chuyển cả 59) · Impact: Med · Risk: thấp.
- [Bằng chứng]: `:15169-15172`, `:15378`, `:15381`, `:15426`, `:15429`, `:9384`. `[INFERENCE]`: nơi `console.log` của Main kết thúc khi chạy đóng gói.

### K44 — persistRunIndex ghi lại toàn bộ index (pretty) sau mỗi artifact

`U44` · Trụ cột T2 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: B:F14 (bản viết dùng: B:F14)

> Ghi chú verifier: Ghi Med, hạ về Low cho bước an toàn.
> Lưu ý về code mới (verifier): Chỉ nên áp dụng bước 1 (bỏ null,2). Bước 2 (debounce 250ms) có thể mất index khi app chết và cần flush khi dispose.

- [Trụ cột]: T2
- [Vị trí]: `src/main/tools/artifact-store.ts:91-106` (đồng bộ), `:109-…` (async), gọi tại `:465`, `:588`, `:791`
- [Vấn đề]: mỗi lần `stage` ghi lại toàn bộ danh sách artifact của run bằng `JSON.stringify(runArtifacts, null, 2)`, tức O(n) mỗi artifact và O(n²) cả run, cộng thêm kích thước do thụt lề. Với bản đồng bộ thì chặn main thread (xem F3). `[INFERENCE]` n lớn khi một run QA xuất hàng trăm ảnh/báo cáo.
- [Code cũ]:
```ts
      const payload = JSON.stringify(runArtifacts, null, 2);
      fs.writeFileSync(tempPath, payload, 'utf8');
```
- [Code mới] (bước 1: nén JSON; bước 2: gộp ghi):
```ts
      const payload = JSON.stringify(runArtifacts);
```
```ts
  private readonly dirtyIndexRuns = new Set<string>();
  private indexFlushTimer: NodeJS.Timeout | undefined;

  private scheduleIndexFlush(runId: string): void {
    this.dirtyIndexRuns.add(runId);
    if (this.indexFlushTimer) return;
    this.indexFlushTimer = setTimeout(() => {
      this.indexFlushTimer = undefined;
      const runs = [...this.dirtyIndexRuns];
      this.dirtyIndexRuns.clear();
      for (const id of runs) void this.persistRunIndexAsync(id);
    }, 250);
    this.indexFlushTimer.unref?.();
  }
```
`stageAsync` gọi `this.scheduleIndexFlush(runId)` thay cho `await this.persistRunIndexAsync(runId)` (`:588`).
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: giảm ghi đĩa từ O(n²) xuống O(n) theo cửa sổ 250 ms. File index nhỏ hơn.
- [Effort]: M · Impact: Med · Risk: Trung bình. Bước 2 có thể mất ≤250 ms index nếu app chết giữa chừng và cần flush khi dispose. `[INFERENCE]` về việc có đường dựng lại index từ đĩa (`:139` có đọc index khi khởi động nhưng tôi chưa đọc nhánh phục hồi). Bước 1 an toàn: định dạng JSON là agnostic với reader tại `:139-141`.
- [Bằng chứng]: `artifact-store.ts:84-113`, `139-141`, `465`, `588`, `790-791`.

### K45 — Toolbar poll trạng thái điện thoại 10s vượt TTL cache 5s, quét USB mỗi nhịp kể cả khi cửa sổ ẩn

`U45` · Trụ cột T2 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: D:F23 (bản viết dùng: D:F23)

> Lưu ý về code mới (verifier): document.hidden của WebContentsView có thể không phản ánh cửa sổ thu nhỏ: kiểm thử.

- [Trụ cột]: T2
- [Vị trí]: `src/renderer/toolbar.ts:5543-5545`; `src/main/browser/native-tab-host.ts:15778-15832` (`getPhoneStatus`, `queryPhoneStatus`)
- [Vấn đề]: nhịp 10 giây lớn hơn TTL 5 giây ở dòng 15780, nên mọi nhịp đều bỏ qua cache và gọi `port.list()` (chú thích dòng 15783-15784: "each query walks the USB bus"). Poll chạy kể cả khi cửa sổ bị ẩn. Main đã có kênh đẩy `PHONE_STATUS` (`refreshPhoneStatus`, `broadcastPhoneStatus`) dùng khi bootstrap. `[INFERENCE]`: mỗi cửa sổ project có một toolbar riêng nên số nhịp nhân theo số cửa sổ.
- [Code cũ]:
```ts
  void pollPhoneStatus();
  setInterval(pollPhoneStatus, 10000);
  window.addEventListener('focus', () => void pollPhoneStatus());
```
- [Code mới]:
```ts
  void pollPhoneStatus();
  setInterval(() => { if (!document.hidden) void pollPhoneStatus(); }, 10000);
  window.addEventListener('focus', () => void pollPhoneStatus());
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: cửa sổ ẩn/thu nhỏ không còn quét USB 6 lần/phút.
- [Effort]: S · Impact: Low · Risk: thấp, huy hiệu điện thoại chỉ trang trí (comment `toolbar.ts:5529-5532`).
- [Bằng chứng]: đọc `toolbar.ts:5517-5550`, `native-tab-host.ts:15777-15846`, `toolbar-preload.ts:256-263`.

### K46 — theme-compiler resolveRealAsset: existsSync+statSync cho mỗi irAsset (O(refs×assets))

`U46` · Trụ cột T2 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: D:F25 (bản viết dùng: D:F25)

> Ghi chú verifier: site-clone là CLI offline.
> Lưu ý về code mới (verifier): So tên trước, stat chỉ khi khớp: tương đương hành vi.

- [Trụ cột]: T2
- [Vị trí]: `packages/site-clone/src/generators/theme-compiler.ts:203-221`, `250-252`
- [Vấn đề]: khi không có `dirIndexes` (nhánh không có chỉ mục), mỗi tham chiếu asset thực hiện `existsSync` + `statSync` cho tối đa hai đường dẫn trong mỗi `searchDirs`, rồi vòng "Direct match in irAssets" gọi cặp `existsSync` + `statSync` cho **mỗi** `item` của `irAssets`, lặp lại theo số lượng ref. Một theme lớn thì số syscall là tích hai tập. `statSync` ném khi không tồn tại nên `existsSync` ở trước là thừa. Nhánh có `dirIndexes` (dòng 196-201) đã tránh việc này.
- [Code cũ]:
```ts
  for (const item of irAssets) {
    if (item.localPath && fs.existsSync(item.localPath) && fs.statSync(item.localPath).isFile()) {
      if (
        item.filename === cleanRef ||
        item.originalFilename === cleanRef ||
        path.basename(item.sourceUrl?.split(/[?#]/)[0] || '') === cleanRef
      ) {
        return { sourcePath: item.localPath, resolvedFilename: item.filename || cleanRef };
      }
    }
  }
```
- [Code mới] (so tên trước, chỉ `stat` khi khớp):
```ts
  for (const item of irAssets) {
    if (!item.localPath) continue;
    if (
      item.filename === cleanRef ||
      item.originalFilename === cleanRef ||
      path.basename(item.sourceUrl?.split(/[?#]/)[0] || '') === cleanRef
    ) {
      let isFile = false;
      try { isFile = fs.statSync(item.localPath).isFile(); } catch {}
      if (isFile) return { sourcePath: item.localPath, resolvedFilename: item.filename || cleanRef };
    }
  }
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: số syscall từ O(refs × assets) còn O(refs) cộng số khớp thật.
- [Effort]: S · Impact: Med · Risk: thấp, hành vi trả về giống nhau (chỉ đảo thứ tự kiểm tra).
- [Bằng chứng]: đọc `theme-compiler.ts:195-261`; grep sync-IO trong file này. `[INFERENCE]`: chưa đo số asset thật.

### K47 — Hàm đọc registry Leader trùng giữa fleet-watch.mjs và leader-job.mjs (và biến thể readJson)

`U47` · Trụ cột T1 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: D:F26 (bản viết dùng: D:F26)

> Lưu ý về code mới (verifier): Chạy test/unit liên quan trước khi xóa bản cũ.

- [Trụ cột]: T1
- [Vị trí]: `scripts/leader/fleet-watch.mjs:67-80` (`readRegistry`); `scripts/leader/leader-job.mjs:1455-1466` (`readLeaderRegistry`, đúng vị trí ±1 dòng theo grep `1458-1459`); biến thể JSON "đọc hoặc null" ở `board.mjs:13-18`, `improve-scan.mjs:41-45`, `leader-job.mjs:200-205`, `219-224`
- [Vấn đề]: hai hàm giống từng dòng (vòng retry `EBUSY/EPERM/EACCES`, `Atomics.wait` 50 ms). Cũng có ~6 biến thể `readJson(file) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } }` rải rác. Hook `leader-guard.ts:119-130` lại có bản thứ ba bằng TypeScript.
- [Code cũ]:
```js
export function readRegistry(configDir) {
  const file = path.join(configDir, "leader-terminals.json");
  for (let attempt = 0; ; attempt++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      if (attempt >= 2 || !["EBUSY", "EPERM", "EACCES"].includes(e.code)) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
```
- [Code mới]:
```js
// scripts/leader/json-io.mjs
import fs from "node:fs";
export function readJsonRetry(file, { retries = 2, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      if (attempt >= retries || !["EBUSY", "EPERM", "EACCES"].includes(e.code)) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}
// fleet-watch.mjs
import { readJsonRetry } from "./json-io.mjs";
export function readRegistry(configDir) { return readJsonRetry(path.join(configDir, "leader-terminals.json")); }
```
Trong `leader-job.mjs`, `readLeaderRegistry()` chỉ còn tính `configDir` rồi gọi `readJsonRetry(file)`.
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: một chính sách retry khóa file, bớt ~30 dòng trùng.
- [Effort]: S · Impact: Low · Risk: thấp. Cần kiểm tra `test/unit` cho hai hàm này trước khi xóa bản cũ.
- [Bằng chứng]: đọc `fleet-watch.mjs:63-84`, `leader-job.mjs:1449-1473`, `board.mjs:7-23`; grep `readFileSync|spawnSync` trên `scripts/leader`.

### K48 — broadcastEvent cấp phát mảng bằng spread cho mỗi sự kiện terminal:session

`U48` · Trụ cột T2 · Effort S · Impact Low · Verifier: UNCHECKED · Nguồn: C:F11 (bản viết dùng: C:F11)


- [Trụ cột]: T2
- [Vị trí]: `bridge-server.ts:4545-4548`
- [Vấn đề]: `[...this.clients].some(...)` tạo mảng mới mỗi lần có `antifan:terminal:session` (phát từ `tm.on('session')`, `:2537-2539`). Hàm vốn được tối ưu kỹ (serialize một lần, `:4520-4535`), nên đây là cấp phát thừa duy nhất trong prologue.
- [Code cũ]:
```ts
      const hasCompanion = [...this.clients].some(client =>
        client.readyState === WebSocket.OPEN
        && this.socketMobileGrants.get(client)?.allowedScopes.includes('terminal.sync'));
```
- [Code mới]:
```ts
      let hasCompanion = false;
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN
          && this.socketMobileGrants.get(client)?.allowedScopes.includes('terminal.sync')) {
          hasCompanion = true;
          break;
        }
      }
```
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: bỏ cấp phát mảng theo tần suất session-event.
- [Effort]: S · Impact: Low · Risk: không đổi hành vi.
- [Bằng chứng]: `bridge-server.ts:2537-2539`, `:4545-4549`. Tần suất sự kiện session là `[INFERENCE]`.

### K49 — Proxy: ANTIFAN_HOST không kiểm tra, hai nơi hardcode 127.0.0.1 trong khi pairing dùng candidate.host

`U49` · Trụ cột T5 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: C:F16 (bản viết dùng: C:F16)

> Ghi chú verifier: Kịch bản chiếm env cần quyền chiếm env, nghĩa là đã nắm secret; phần lệch host giữa pairing và dispatch là thật.
> Lưu ý về code mới (verifier): Dùng chung bridgeWsUrl cho 4 nơi; ANTIFAN_ALLOW_REMOTE_BRIDGE là cờ đề xuất, chưa tồn tại.

- [Trụ cột]: T5
- [Vị trí]: `scripts/antifan-omp-mcp.cjs:395-398` (`ANTIFAN_HOST`), `:2372`, `:2624`, `:2921`, `:3783-3785`
- [Vấn đề]: `host` lấy từ `process.env.ANTIFAN_HOST || '127.0.0.1'` không kiểm tra, và header `Authorization`/`x-antifan-attachment-secret` đi qua `ws://` rõ. Hai nơi (dispatch socket `:2921`, heartbeat `:3784`) lại hardcode `127.0.0.1` và bỏ qua host của candidate, nên nếu host là máy khác thì pairing kết nối được nhưng dispatch/heartbeat đi nhầm đích. Cả hai cách đều sai: một thì rò secret nếu env bị chiếm, một thì lệch.
- [Code cũ] (`:2921` và `:3783-3785`):
```js
        const url = `ws://127.0.0.1:${bootstrap.port}`;
...
function heartbeatUrl(bootstrap) {
  return `ws://127.0.0.1:${bootstrap.port}`;
}
```
- [Code mới]:
```js
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function bridgeWsUrl(host, port) {
  const h = typeof host === 'string' && host ? host : '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(h) && process.env.ANTIFAN_ALLOW_REMOTE_BRIDGE !== '1') {
    throw transportError('BRIDGE_HOST_NOT_LOOPBACK', `Refusing to send the attachment secret to non-loopback host ${h}`);
  }
  return `ws://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${port}`;
}
// :2372  new WebSocket(bridgeWsUrl(candidate.host, candidate.port), ...)
// :2624  const wsUrl = bridgeWsUrl(candidate.host, candidate.port);
// :2921  const url = bridgeWsUrl(bootstrap.host, bootstrap.port);
// :3784  return bridgeWsUrl(bootstrap.host, bootstrap.port);
```
Làm tương tự cho `httpJsonPost(host, ...)` ở `:1999`.
- [Cấu hình nâng cấp]: `ANTIFAN_ALLOW_REMOTE_BRIDGE=1` cho trường hợp cố ý dùng bridge từ xa.
- [Lợi ích]: không gửi secret ra ngoài loopback khi env bị đặt sai hoặc bị lạm dụng; 4 nơi dùng chung một builder.
- [Effort]: S · Impact: Low–Med · Risk: người dùng đặt `ANTIFAN_HOST` khác loopback sẽ phải bật cờ.
- [Bằng chứng]: `antifan-omp-mcp.cjs:395-398`, `:1998-2000`, `:2372`, `:2624`, `:2921`, `:3783-3785`, `:1589` (`transportError`). Kịch bản chiếm env chưa chứng minh (`[INFERENCE]`).

### K50 — Ba bản inline 'gửi request chờ id' trong autoheal trong khi đã có wsRequest

`U50` · Trụ cột T1 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: C:F14 (bản viết dùng: C:F14)

> Lưu ý về code mới (verifier): wsRequest reject khi !resp.success còn hai bản inline resolve data bất kể success; .catch(() => null) làm kết quả cuối giống nhau. Test omp-mcp-autoheal-binding.

- [Trụ cột]: T1
- [Vị trí]: `scripts/antifan-omp-mcp.cjs:2672-2699` (`tabs-`), `:2708-2731` (`rebind-`), `:2761-2790` (`autoheal-`); helper `wsRequest` ở `:2331-2352`
- [Vấn đề]: ba khối giống nhau (timer + `onMsg` + `removeListener` + `send`) cùng logic với `wsRequest`. Khác biệt duy nhất là hai khối đầu resolve `null` khi timeout, khối thứ ba reject.
- [Code cũ] (`:2672-2682`):
```js
          const tabListId = 'tabs-' + crypto.randomUUID();
          const tabResult = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              ws.removeListener('message', onMsg);
              resolve(null);
            }, 3000);
            const onMsg = (raw) => {
              try {
                const resp = JSON.parse(raw.toString());
                if (resp && resp.id === tabListId) {
```
- [Code mới]:
```js
function wsRequest(ws, method, params, timeoutMs, idPrefix = 'probe') {
  return new Promise((resolve, reject) => {
    const id = `${idPrefix}-${crypto.randomUUID()}`;
    // ...giữ nguyên phần còn lại như hiện tại...
  });
}
```
```js
          const tabData = await wsRequest(ws, 'antifan.capability.dispatch', {
            name: 'browser.list-tabs',
            attachmentId: pairedExchange.attachmentId,
            attachmentSecret: pairedExchange.secret,
            authorityRevision: pairedExchange.authorityRevision,
            params: { all: true },
          }, 3000, 'tabs').catch(() => null);
          const tabResult = tabData?.data || tabData || [];
```
và khối rebind:
```js
            const rebindData = await wsRequest(ws, 'antifan.capability.dispatch', {
              name: 'browser.rebind-target',
              attachmentId: pairedExchange.attachmentId,
              attachmentSecret: pairedExchange.secret,
              authorityRevision: pairedExchange.authorityRevision,
              params: { tabId: resolvedTabId },
            }, 3000, 'rebind').catch(() => null);
            const replacementRev = rebindData?.replacementAuthorityRevision || rebindData?.authorityRevision;
```
Khối `startSession` giữ reject khi timeout: `session = await wsRequest(ws, 'antifan.cli.startSession', { ... }, 5000, 'autoheal');`.
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: −~70 dòng, một nơi sửa vòng đời listener.
- [Effort]: S · Impact: Low · Risk: `wsRequest` reject khi `!resp.success`, trong khi hai khối inline resolve `resp.data` bất kể success. Với `.catch(() => null)` kết quả cuối giống nhau với mọi lỗi (đều bị coi là "không có kết quả"). Test `omp-mcp-autoheal-binding.test.mjs` bao phủ đường này.
- [Bằng chứng]: `antifan-omp-mcp.cjs:2331-2352`, `:2672-2699`, `:2708-2731`, `:2761-2790`; số dòng đầu khối xác nhận bằng grep.

### K51 — native-tab-host: realpath+isDirectory lặp 7 lần (một chỗ lệch .native) và existsSync(normalize) lặp 12 lần

`U51` · Trụ cột T1 · Effort S · Impact Low · Verifier: VALIDATED · Nguồn: A:F10, A:F11 (bản viết dùng: A:F10)

> Lưu ý về code mới (verifier): Đổi 4613 sang .native có thể đổi chính tả đã dùng làm khóa capsule: chạy test capsule/workspace. A:F11 (14229-14358) tôi chưa đọc lại.

- [Trụ cột]: T1
- [Vị trí]: `src/main/browser/native-tab-host.ts:1732-1736`, `3685-3689`, `4613-4617`, `4691-4695`, `4811-4815`, `4930-4934`, `15018-15022`
- [Vấn đề]: cùng một thao tác "chuẩn hoá thư mục thật hoặc `''`" viết tay 7 lần. Chỗ `:4613` dùng `fs.realpathSync(workspacePath)` (không `.native`) trong khi các chỗ còn lại dùng `.native` (grep `realpathSync`). Hai API có thể trả chính tả đường dẫn khác nhau trên Windows (alias 8.3/junction), mà comment `:4686-4690` nói chính tả chuẩn tránh việc "một thư mục sinh chín capsule trùng tên".
- [Code cũ] (`:1731-1737`):
```ts
    let realPath = '';
    try {
      realPath = fs.realpathSync.native(request.cwd);
      if (!fs.statSync(realPath).isDirectory()) realPath = '';
    } catch {
      realPath = '';
    }
```
- [Code mới]:
```ts
// module scope
/** Canonical (native) spelling of an existing directory, or '' when `candidate` is not one. */
function resolveExistingDirectory(candidate: string): string {
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isDirectory() ? real : '';
  } catch {
    return '';
  }
}
// :1731  → const realPath = resolveExistingDirectory(request.cwd);
// :4613  → resolvedWorkspace = resolveExistingDirectory(workspacePath);   // cũng chuyển sang .native
// :4691, :4811, :4930, :3685, :15018 tương tự
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: một chính tả đường dẫn duy nhất cho mọi điểm mint/placement; bỏ ~30 dòng lặp.
- [Effort]: S · Impact: Med · Risk: Thấp–Vừa. `:4613` đổi sang `.native` có thể đổi chính tả đã dùng làm khoá, cần chạy test liên quan capsule/workspace. `[INFERENCE]` về khác biệt cụ thể hai API.
- [Bằng chứng]: `native-tab-host.ts:1732-1736`, `3685-3689`, `4613-4617`, `4686-4696`, `4811-4815`, `4930-4934`, `15018-15022`.

### K52 — Bốn file src/renderer/*.js là bản sinh từ src/shared (không phải code trùng viết tay)

`U52` · Trụ cột T1 · Effort S · Impact Low · Verifier: DOWNGRADED · Nguồn: B:F23, C:F8, D:F27, E:F14 (bản viết dùng: C:F8)

> Ghi chú verifier: Phần 'không phải trùng lặp' là đúng và hữu ích. Đề xuất gitignore rủi ro Med, lợi ích Low.
> Lưu ý về code mới (verifier): Thêm vào .gitignore không có tác dụng với file đã tracked: cần git rm --cached. standalone.html:259 và launch-guard có thể đọc src/renderer; bản commit có thể là có chủ đích để app chạy không cần compile.
> Hiệu chỉnh của controller: KHÔNG áp dụng đề xuất `.gitignore`: 4 file đang được git theo dõi và được khai trong `scripts/lib/generated-renderer-assets.cjs:9`. Chỉ giữ phần chẩn đoán: đây là bản sinh từ `src/shared`, không phải trùng lặp viết tay (packet của controller đã gọi nhầm).

- [Trụ cột]: T1
- [Vị trí]: `scripts/copy-static.mjs:137-146`, `scripts/lib/generated-renderer-assets.cjs:7-12`, `.gitignore` (không có dòng nào)
- [Vấn đề]:
  - Mục "duplicate seed" của packet (`session-activity` trong `src/shared` và `src/renderer`) là bản sinh tự động, không phải trùng lặp viết tay: `copy-static.mjs` bọc output tsc của `src/shared/*.js` thành global classic-script và ghi vào `src/renderer` (`:127-145`). Bằng chứng ở file: `//# sourceMappingURL=session-activity.js.map` kèm dòng `window.SessionActivityTracker = ...` (`src/renderer/session-activity.js:338-340`).
  - Comment ngay trong script gọi đó là "developer convenience". Mỗi lần compile mặc định đều ghi vào cây nguồn.
  - `.gitignore` không có luật nào cho `src/renderer/*.js`. Cả 4 file hiện diện cạnh `toolbar.ts` và `standalone.js` (glob). Có khả năng chúng đang bị theo dõi và tạo diff mỗi lần compile (`[INFERENCE]`, chưa chạy `git ls-files`).
- [Code cũ] (`copy-static.mjs:137-145`):
```js
  // The source-tree copy is a developer convenience for the default `.compiled` loop; an
  // isolated build (ANTIFAN_COMPILED_ROOT set) must not mutate the source tree at all.
  if (!process.env.ANTIFAN_COMPILED_ROOT) {
    const srcDst = path.join(rendererSrcDir, spec.file);
    try {
      fs.writeFileSync(srcDst, sharedWrapped, 'utf8');
    } catch (err) {
```
- [Code mới] (`.gitignore`):
```
# Derived by scripts/copy-static.mjs from src/shared/*.ts (list: scripts/lib/generated-renderer-assets.cjs)
src/renderer/terminal-write-dispatcher.js
src/renderer/session-activity.js
src/renderer/terminal-file-links.js
src/renderer/markdown-render.js
```
- [Cấu hình nâng cấp]: `git rm --cached src/renderer/{terminal-write-dispatcher,session-activity,terminal-file-links,markdown-render}.js` (chỉ khi `git ls-files` xác nhận chúng đang được theo dõi).
- [Lợi ích]: hết diff giả và hết trùng lặp ảo, giảm ~1.100+ dòng khỏi `src/renderer` khi tính "source".
- [Effort]: S · Impact: Low · Risk: `launch-guard` đã coi các file này là derived (`generated-renderer-assets.cjs:1-6`). Kiểm `npm run compile` sinh lại đủ trước khi chạy `check-renderer-assets`.
- [Bằng chứng]: `copy-static.mjs:121-146`; `generated-renderer-assets.cjs:1-12`; `src/renderer/session-activity.js:338-340`; `src/shared/session-activity.ts:75-79`; glob `src/renderer/*`; grep `.gitignore` (`renderer|\.js\.map` chỉ ra `.compiled-wsf/`).

### K53 — Thiếu index cho tra cứu nóng Core (claims.createdAt, conflicts.subject, packs.task)

`U53` · Trụ cột T2 · Effort S · Impact Low · Verifier: UNCHECKED · Nguồn: E:F8 (bản viết dùng: E:F8)

> Ghi chú verifier: Impact giữ Low cho tới khi có EXPLAIN.
> Lưu ý về code mới (verifier): Index createdAt có thể không giúp khi còn nhiều điều kiện where; tạo index trên DB 211 MB mất thời gian.

- [Trụ cột]: T2
- [Vị trí]: `packages/super-core/src/schema.ts:555-563` (`POST_SCHEMA_SQL`); truy vấn tại `index.ts:747`, `1295`, `1316`, `1639`
- [Vấn đề]:
  - `ORDER BY c.createdAt DESC` trên `claims` (`:747`, `:1295` là `ORDER BY createdAt DESC`).
  - `conflicts WHERE subject = ?` (`:1316`).
  - `packs WHERE task = ? ORDER BY COALESCE(lastIssuedAt, createdAt)` (`:1639`).
  - Chỉ có index trên `claims(unitId/kind/status/contextPlatform/namespace)`, `conflicts(platform)`, `packs(taskHash)` (`schema.ts:193-196`, `556-560`).
- [Code cũ]:
```sql
CREATE INDEX IF NOT EXISTS idx_conflicts_platform ON conflicts(platform);
CREATE INDEX IF NOT EXISTS idx_cases_platform ON cases(platform);
CREATE INDEX IF NOT EXISTS idx_decisions_platform ON decisions(platform);
CREATE INDEX IF NOT EXISTS idx_packs_taskhash ON packs(taskHash);
CREATE INDEX IF NOT EXISTS idx_claims_namespace ON claims(namespace);
```
- [Code mới] (thêm vào cuối `POST_SCHEMA_SQL`; `PREPARED_STAMP` là hash của text DDL nên lần mở sau tự chuẩn bị lại, `index.ts:17-20`):
```sql
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(createdAt);
CREATE INDEX IF NOT EXISTS idx_claims_platform_status ON claims(contextPlatform, status);
CREATE INDEX IF NOT EXISTS idx_conflicts_subject_state ON conflicts(subject, state);
CREATE INDEX IF NOT EXISTS idx_packs_task ON packs(task);
```
- [Lợi ích]: tránh quét toàn bảng ở các truy vấn chạy mỗi lượt.
- [Effort]: S · Impact: Med · Risk: tạo index lần đầu trên DB 211 MB mất thời gian, nên chạy ngoài giờ.
- [Bằng chứng]: `schema.ts:192-196`, `:555-563`; `index.ts:747`, `1295`, `1316`, `1639`. `[INFERENCE]`: chưa chạy `EXPLAIN QUERY PLAN`.

### K54 — Giảm bề mặt tools/list của proxy: ẩn tên legacy trùng schema, ẩn họ core.* hiếm dùng, profile env

`U54` · Trụ cột T4 · Effort M · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F8, C:F17, E:F19 (bản viết dùng: C:F17)

> Ghi chú verifier: Mức tiết kiệm token chưa đo (cả ba tự nhận). Nên làm sau U21 để có số liệu.
> Lưu ý về code mới (verifier): Phải rg các skill/Leader đang gọi core.record_* trước khi ẩn. Chạy check-mcp-budget-dominance. E:F19 sửa cấu hình MCP nằm trong ~/.omp (ngoài phạm vi), repo không có file để sửa.
> Hiệu chỉnh của controller: Phần chỉnh cấu hình MCP trong `~/.omp` nằm ngoài repo — tương đương là P4-7.

- [Trụ cột]: T4
- [Vị trí]: `scripts/antifan-omp-mcp.cjs:171-231+` (hàng `core.*` trong `definitions`), `:4034-4043` (`listTools`)
- [Vấn đề]:
  - `definitions` là bảng tĩnh ~560 dòng (`:73`→`:637`) và `listTools` trả toàn bộ, trừ khi env allow/forbid (`:4035-4040`). Danh sách ổn định theo thứ tự, tốt cho prompt cache.
  - Nhưng nhóm Core v4 (experience graph, anti-pattern, workaround, fix pattern, hidden requirement, commercial, tool intel, archetype, platform semantics: `:185-231`) hiếm khi được agent gọi, mà mỗi mô tả và schema đều vào ngữ cảnh mọi phiên. Kích thước thực chưa đo, nên mức tiết kiệm token là `[INFERENCE]`.
- [Code cũ] (`:4034-4043`):
```js
async function listTools() {
  const allowedCaps = resolveAllowedCapabilities();
  const forbiddenCaps = resolveForbiddenCapabilities();
  const filteredDefs = (allowedCaps || forbiddenCaps)
    ? definitions.filter(([name]) => isCapabilityPermitted(name, allowedCaps, forbiddenCaps))
    : definitions;
  return {
    tools: filteredDefs.map(publishedTool),
  };
}
```
- [Code mới]:
```js
// Họ Core hiếm dùng vẫn gọi được (dispatch không đổi) nhưng không quảng bá mặc định.
const CORE_EXTENDED_RE = /^core\.(record_(experience_node|experience_edge|anti_pattern|workaround|fix_pattern|hidden_requirement|commercial|tool|archetype|platform_semantic)|experience_chain|anti_patterns|workarounds|fix_patterns|hidden_requirements|commercial_intel|tool_intel|archetypes|platform_semantics)$/;
let publishedCache = null;
let publishedCacheKey = null;
async function listTools() {
  const allowedCaps = resolveAllowedCapabilities();
  const forbiddenCaps = resolveForbiddenCapabilities();
  const includeExtended = process.env.ANTIFAN_MCP_CORE_EXTENDED === '1';
  const key = JSON.stringify([allowedCaps, forbiddenCaps, includeExtended]);
  if (publishedCacheKey !== key) {
    const filteredDefs = definitions
      .filter(([name]) => includeExtended || !CORE_EXTENDED_RE.test(name))
      .filter(([name]) => !(allowedCaps || forbiddenCaps) || isCapabilityPermitted(name, allowedCaps, forbiddenCaps));
    publishedCache = filteredDefs.map(publishedTool);
    publishedCacheKey = key;
  }
  return { tools: publishedCache };
}
```
- [Cấu hình nâng cấp]: `ANTIFAN_MCP_CORE_EXTENDED=1` để bật lại toàn bộ.
- [Lợi ích]: bớt token tool-list mỗi phiên (cần đo), cache `publishedTool` thay vì dựng lại theo mỗi `tools/list`.
- [Effort]: M · Impact: Med · Risk: các skill/Leader có thể đang gọi `core.record_fix_pattern`, `core.record_workaround`... Phải `rg "core\.(record_(fix_pattern|workaround|anti_pattern))" skills scripts` rồi bỏ khỏi regex những tên còn dùng. Gate `check-mcp-budget-dominance.mjs` có kiểm tra parity với catalogue; chạy lại.
- [Bằng chứng]: `antifan-omp-mcp.cjs:73-74`, `:171-231` (đã đọc đến `:231`), `:637`, `:4034-4043`; grep đếm hàng `definitions` bị cắt ở giới hạn đọc (`[INFERENCE]` cho phần sau `:231`).

### K55 — stage và stageAsync của artifact-store trùng ~130 dòng

`U55` · Trụ cột T1 · Effort M · Impact Low · Verifier: UNCHECKED · Nguồn: B:F15 (bản viết dùng: B:F15)

> Lưu ý về code mới (verifier): B tự nêu thứ tự persist so với hotDataCache đổi nhẹ.

- [Trụ cột]: T1
- [Vị trí]: `src/main/tools/artifact-store.ts:346-475` và `:477-598`
- [Vấn đề]: hai hàm lặp nguyên văn: literal kiểu input (15 dòng), kiểm tra `overflowMode`/`attemptId`/`projectId`/`workspaceId`, tính `sha256`, kiểm tra `runCeiling`, dựng `ArtifactRef` (`:438-454` so với `:560-576`), cập nhật `runArtifactsCache` và `hotDataCache`. Chỉ khác `fs.*Sync` so với `fs.promises.*`. F3 là hệ quả của việc hai bản có hình dạng giống nhau nhưng dễ gọi nhầm. Phần cuối là đoạn dễ tách nhất.
- [Code cũ] (`:438-465`, bản sync; bản async chỉ khác dòng cuối):
```ts
    const ref: ArtifactRef = {
      id: `artifact-${crypto.randomUUID()}`,
      runId,
      attemptId: input.attemptId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      path: artifactPath,
      byteLength: stored,
      sha256,
      mime: input.mime,
      truncated,
      redacted,
      createdAt: Date.now(),
      retentionPolicy: input.retentionPolicy,
    };
    this.artifacts.set(ref.id, ref);
    const cachedRunList = this.runArtifactsCache.get(runId);
    if (cachedRunList) {
      cachedRunList.push(ref);
    } else {
      this.runArtifactsCache.set(runId, [ref]);
    }
    this.persistRunIndex(runId);
```
- [Code mới]:
```ts
export interface ArtifactStageInput {
  kind: ArtifactRef['kind'];
  mime: string;
  data: string | Buffer;
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  maxBytes?: number;
  leaseToken?: string;
  overflowMode?: ArtifactOverflowMode;
  retentionPolicy?: ArtifactRef['retentionPolicy'];
}

  /** Builds the ref for bytes already on disk, indexes it in memory and hot-caches small payloads. */
  private registerStagedRef(input: ArtifactStageInput, runId: string, artifactPath: string, stored: number, sha256: string, truncated: boolean, redacted: boolean, storedData: Buffer): ArtifactRef {
    const ref: ArtifactRef = {
      id: `artifact-${crypto.randomUUID()}`, runId, attemptId: input.attemptId, projectId: input.projectId,
      workspaceId: input.workspaceId, kind: input.kind, path: artifactPath, byteLength: stored, sha256,
      mime: input.mime, truncated, redacted, createdAt: Date.now(), retentionPolicy: input.retentionPolicy,
    };
    this.artifacts.set(ref.id, ref);
    const cachedRunList = this.runArtifactsCache.get(runId);
    if (cachedRunList) cachedRunList.push(ref);
    else this.runArtifactsCache.set(runId, [ref]);
    if (storedData.byteLength <= 512 * 1024) {
      if (this.hotDataCache.size >= this.MAX_HOT_CACHE_ITEMS) {
        const firstKey = this.hotDataCache.keys().next().value;
        if (firstKey) this.hotDataCache.delete(firstKey);
      }
      this.hotDataCache.set(ref.id, storedData);
    }
    return ref;
  }
// stage():      const ref = this.registerStagedRef(...); this.persistRunIndex(runId);
// stageAsync(): const ref = this.registerStagedRef(...); await this.persistRunIndexAsync(runId);
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: một nơi định nghĩa `ArtifactRef`, kiểu input và hot-cache. Phần validate cũng có thể tách tương tự (`validateStageInput`).
- [Effort]: M · Impact: Med · Risk: Thấp. Thứ tự `persistRunIndex` so với việc set `hotDataCache` đổi nhẹ (trước đây index ghi trước cache). Test `artifact-store` bao quanh.
- [Bằng chứng]: `artifact-store.ts:346-475`, `477-598`.

### K56 — Mẫu đọc kết quả action lặp 8+ lần với as any trong browser-control-port

`U56` · Trụ cột T1 · Effort M · Impact Low · Verifier: UNCHECKED · Nguồn: B:F16 (bản viết dùng: B:F16)

> Lưu ý về code mới (verifier): B nêu có nhánh chỉ đọc reason; helper ưu tiên error: cần đối chiếu từng nhánh.

- [Trụ cột]: T1
- [Vị trí]: `src/main/tools/browser-control-port.ts:7085-7087`, `:7098-7100`, `:7116-7118`, `:7130-7132`, `:7143-7145`, `:7166-7168`, `:7179-7181`, `:7192-7194`, `:7211-7213`, `:7224-7226`
- [Vấn đề]: mỗi nhánh `click/type/hover/scroll/focus…` tự lặp: `(rawRes as any).error` hoặc `(rawRes as any).reason`. Tổng `as any` trong file là 43 (packet §2.2). Rủi ro sai lệch khi một nhánh quên đọc `reason`.
- [Code cũ] (`:7098-7100`):
```ts
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).error === 'string') {
              actionError = (rawRes as any).error;
            }
```
- [Code mới]:
```ts
/** The failure text an agent action result carries: `error` for the DOM paths, `reason` for the cursor paths. */
function actionFailureText(res: unknown): string | undefined {
  if (!res || typeof res !== 'object') return undefined;
  const { error, reason } = res as { error?: unknown; reason?: unknown };
  if (typeof error === 'string') return error;
  if (typeof reason === 'string') return reason;
  return undefined;
}
// each branch:
            if (!actionExecuted) actionError = actionFailureText(rawRes) ?? actionError;
```
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: xóa ~30 dòng lặp và 10+ `as any`. Một chỗ để sửa.
- [Effort]: M · Impact: Med · Risk: Trung bình. Các nhánh dùng `error` và `reason` khác nhau; helper ưu tiên `error` rồi mới tới `reason`, nên cần đối chiếu từng nhánh (có nhánh chỉ đọc `reason`). Test bao quanh `behavior evidence`.
- [Bằng chứng]: `browser-control-port.ts:7040-7230` (grep `any`), `7094-7100`, `7129-7132`.

### K57 — Heartbeat discovery 5s chạy ~10 syscall đồng bộ trên main

`U57` · Trụ cột T2 · Effort M · Impact Low · Verifier: VALIDATED · Nguồn: C:F12 (bản viết dùng: C:F12)

> Ghi chú verifier: Tác động mỗi nhịp chưa đo.
> Lưu ý về code mới (verifier): Giữ persist single-flight; process.kill giữ đồng bộ.

- [Trụ cột]: T2
- [Vị trí]: `bridge-server.ts:2286-2292` (timer), `:2394-2420` (`persistBridgeInfoNow`), `:2430-2453` (`refreshPublishedDiscoveryInPlace`), `:2476-2490` (`canPublishLegacyMirror`)
- [Vấn đề]:
  - Call path: `setInterval(..., BRIDGE_HEALTH_HEARTBEAT_MS = 5000)` (`bridge-health.ts:27`) → `persistBridgeInfo` → `persistBridgeInfoNow`.
  - Mỗi nhịp: `existsSync(geminiDir)`, rồi `canPublishLegacyMirror` (`existsSync` + `readFileSync` + `JSON.parse` + `process.kill(pid,0)`), rồi với mỗi target `refreshPublishedDiscoveryInPlace` (`openSync`, `fstatSync`, `writeSync`, `closeSync`). Khoảng 10 syscall đồng bộ cho 2 file, lặp suốt đời app.
  - Hàm `private` có đúng một caller (`:2415`).
- [Code cũ] (`:2415` và `:2437-2440`):
```ts
      const pending = targets.filter((targetPath) => !this.refreshPublishedDiscoveryInPlace(targetPath, content));
...
    let fd: number | null = null;
    try {
      fd = fs.openSync(targetPath, 'r+');
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.dev !== published.dev || stat.ino !== published.ino || stat.size !== BigInt(published.size)) {
```
- [Code mới]:
```ts
      const pending: string[] = [];
      for (const targetPath of targets) {
        if (!(await this.refreshPublishedDiscoveryInPlace(targetPath, content))) pending.push(targetPath);
      }
...
  private async refreshPublishedDiscoveryInPlace(targetPath: string, content: string): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const published = this.publishedDiscoveryFiles.get(targetPath);
    if (!published) return false;
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length !== published.size) return false;
    let handle: import('node:fs/promises').FileHandle | null = null;
    try {
      handle = await fs.promises.open(targetPath, 'r+');
      const stat = await handle.stat({ bigint: true });
      if (stat.dev !== published.dev || stat.ino !== published.ino || stat.size !== BigInt(published.size)) {
        this.publishedDiscoveryFiles.delete(targetPath);
        return false;
      }
      await handle.write(buffer, 0, buffer.length, 0);
      return true;
    } catch {
      this.publishedDiscoveryFiles.delete(targetPath);
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
```
Đổi tương tự `canPublishLegacyMirror` sang `fs.promises.readFile` (hàm dùng chung một caller `:2408`).
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: main thread không còn chặn I/O đồng bộ mỗi 5 giây; nhất quán với comment "persist is single-flight" (`:2359-2368`).
- [Effort]: M · Impact: Low–Med · Risk: single-flight đã tuần tự hóa; vẫn giữ `process.kill` đồng bộ vì không phải I/O đĩa. Chạy các test bridge-health hiện có.
- [Bằng chứng]: `bridge-health.ts:27`; `bridge-server.ts:2286-2292`, `:2394-2420`, `:2430-2453`, `:2476-2490`. Độ trễ mỗi nhịp chưa đo, chỉ đếm syscall (`[INFERENCE]` về tác động).

### K58 — Quét hàng đợi pairing bằng I/O đồng bộ sau mỗi lần claim

`U58` · Trụ cột T2 · Effort M · Impact Low · Verifier: UNCHECKED · Nguồn: C:F13 (bản viết dùng: C:F13)

> Lưu ý về code mới (verifier): Giữ bước rename claim tuần tự để tránh xung đột giữa tiến trình.

- [Trụ cột]: T2
- [Vị trí]: `bridge-server.ts:749-773` (`replenishPairingQueueNow`), `:812-840` (`claimPairingChallenge`)
- [Vấn đề]:
  - Mỗi claim thành công lên lịch `replenishPairingQueue` bằng `setImmediate` (`:876-880`). Hàm đó `readdirSync` rồi `readFileSync` + `JSON.parse` tuần tự cho mọi file trong hàng đợi (đích 16 file, `:775`).
  - Claim đọc cho đến khi gặp file hợp lệ. Route challenge là endpoint mà mọi proxy gọi khi khởi động hoặc autoheal (`antifan-omp-mcp.cjs:1999`), và đến từ HTTP handler trong main process.
  - Sau đó mới ghi bù qua DACL (đắt hơn nhiều). Phần quét đồng bộ chặn event loop khi nhiều agent khởi động đồng thời.
- [Code cũ] (`:749-773`):
```ts
    try {
      existing = fs.readdirSync(this.pairingQueueDir);
    } catch (err) {
...
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data || !data.code || !data.expiresAt || now > data.expiresAt) {
          fs.unlinkSync(filePath);
        } else {
          activeCount++;
        }
      } catch {
        try { fs.unlinkSync(filePath); } catch {}
      }
```
- [Code mới]:
```ts
    try {
      existing = await fs.promises.readdir(this.pairingQueueDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
    const now = Date.now();
    let activeCount = 0;
    await Promise.all(existing.filter((file) => file.endsWith('.json')).map(async (file) => {
      const filePath = path.join(this.pairingQueueDir, file);
      try {
        const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        if (!data || !data.code || !data.expiresAt || now > data.expiresAt) {
          await fs.promises.unlink(filePath);
        } else {
          activeCount++;
        }
      } catch {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }));
```
Làm tương tự cho vòng đọc trong `claimPairingChallenge` (giữ `renameSync` claim nguyên tử đổi thành `fs.promises.rename`).
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: giữ main process phản hồi khi nhiều proxy pairing đồng thời.
- [Effort]: M · Impact: Med · Risk: thứ tự đọc thay đổi (song song), nên giữ nguyên bước rename claim tuần tự để tránh xung đột giữa process.
- [Bằng chứng]: `bridge-server.ts:728-775`, `:803-892`; `antifan-omp-mcp.cjs:1998-2000`. Hiệu năng thực tế chưa đo (`[INFERENCE]`).

### K59 — readChanges đọc và parse lại toàn bộ log edit-guard (tới 2 MiB) mỗi khi file đổi

`U59` · Trụ cột T2 · Effort M · Impact Low · Verifier: DOWNGRADED · Nguồn: D:F21 (bản viết dùng: D:F21)

> Ghi chú verifier: Log chỉ nhận dòng khi allow/block write hoặc eval, nên tần suất thấp hơn 'mỗi tool call'.
> Lưu ý về code mới (verifier): Đọc phần đuôi theo offset cần xử lý xoay file (size < offset) và dòng cuối chưa hoàn chỉnh.

- [Trụ cột]: T2
- [Vị trí]: `src/main/run/run-state-service.ts:591-653` (`readChanges`), gọi từ `532`; chu kỳ quét `RUN_SWEEP_MS = 5_000` ở dòng 14, debounce 100 ms ở `292-295`
- [Vấn đề]: cache dùng khóa `mtime:size` nên mỗi tool call của agent làm log đổi và buộc đọc lại cả file (tối đa `LOG_ROTATE_BYTES = 2 MiB`, `edit-guard.ts:71`), `split` theo dòng và `JSON.parse` từng dòng, trên luồng Main, cho từng thẻ terminal đang chạy. Tổng công việc theo một phiên là bậc hai. Log chỉ nối thêm, nên đọc phần đuôi theo offset là đủ.
- [Code cũ]:
```ts
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split(/\r?\n/);
      const allowedFiles = new Set<string>();
      let blockedCount = 0;
```
- [Code mới] (giữ offset và tập tích lũy theo `key`; reset khi `size` nhỏ hơn offset cũ hoặc `runSeq` đổi):
```ts
  private readonly changesTail = new Map<string, { path: string; offset: number; runSeq: number; allowed: Set<string>; blocked: number }>();
// trong readChanges, thay đoạn đọc toàn file:
      let tail = this.changesTail.get(key);
      if (!tail || tail.path !== logPath || tail.runSeq !== runSeq || stat.size < tail.offset) {
        tail = { path: logPath, offset: 0, runSeq, allowed: new Set<string>(), blocked: 0 };
      }
      const fd = fs.openSync(logPath, 'r');
      let chunk = '';
      try {
        const len = stat.size - tail.offset;
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, tail.offset);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
      const lastNewline = chunk.lastIndexOf('\n');
      const complete = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
      tail.offset += Buffer.byteLength(complete);
      for (const line of complete.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row || typeof row !== 'object' || row.runSeq !== runSeq) continue;
          if (row.decision === 'allow') { if (typeof row.path === 'string' && row.path.length > 0) tail.allowed.add(row.path); }
          else tail.blocked++;
        } catch { /* dòng bị cắt dở */ }
      }
      this.changesTail.set(key, tail);
      const allowedFiles = tail.allowed;
      const blockedCount = tail.blocked;
```
(dọn `changesTail` cùng với `changesCache` ở dòng 554-556.)
- [Cấu hình nâng cấp]: không áp dụng
- [Lợi ích]: mỗi lần chiếu chỉ đọc phần mới thêm, thay vì tối đa 2 MiB.
- [Effort]: M · Impact: Med · Risk: Med. Phải xử lý xoay file (`stat.size < offset`) và dòng cuối chưa hoàn chỉnh; cần test với log xoay.
- [Bằng chứng]: đọc `run-state-service.ts:589-653`; grep `readChanges|changesCache`, `RUN_SWEEP_MS`, `LOG_ROTATE_BYTES`. `[INFERENCE]`: chưa đo kích thước log thật.

### K60 — Đường dẫn E:/Work cứng ở ~14 file, thiếu cơ chế override đồng nhất

`U60` · Trụ cột T5 · Effort M · Impact Low · Verifier: VALIDATED · Nguồn: D:F15 (bản viết dùng: D:F15)

> Ghi chú verifier: Máy cá nhân một người dùng nên mức tác động thấp.
> Lưu ý về code mới (verifier): Tên env ANTIFAN_WORK_ROOT, ANTIFAN_DATA_ROOT là đề xuất mới, repo chưa có. Hook bundle phải cài lại.

- [Trụ cột]: T5 (kèm T1)
- [Vị trí] (đều verbatim từ grep): `src/omp-hooks/leader-guard.ts:74`, `76`, `562-567`; `src/main/leader/leader-jobs-board.ts:53`; `src/main/qa/diagnostics-filter.ts:434`; `src/main/index.ts:2252`, `4922`; `src/main/browser/native-tab-host.ts:2179`; `src/main/project/workspace-capsule.ts:146`; `src/main/terminal-daemon/daemon-spawner.ts:87`; `scripts/leader/leader-job.mjs:22-23`, `fleet-watch.mjs:47`, `improve-scan.mjs:14`, `wait-workers.mjs:124`, `worker-status.mjs:10`
- [Vấn đề]: cùng một cấu hình (thư mục job leader, data root, work root) lặp ở ≥14 nơi, có nơi có override env (`LEADER_JOBS_ROOT`), nơi không. Trong `src/main` thì `index.ts:2252` (`TERMINAL_ADOPTION_WORK_ROOT = 'E:\\Work'`) và `index.ts:4922` (thư mục mặc định của Workspace) là hành vi sản phẩm bị buộc vào một ổ đĩa. Đây là máy cá nhân của một người dùng; vấn đề là sự trùng lặp và thiếu cơ chế override đồng nhất.
- [Code cũ]:
```ts
const DEFAULT_JOBS_ROOT = "E:/Work/scratch/leader";
const JOB_FILE = "job.json";
const DEFAULT_DATA_ROOT = "E:/Work/.antifan-data";
```
```ts
const TERMINAL_ADOPTION_WORK_ROOT = 'E:\\Work';
```
- [Code mới] (một nguồn, mỗi giá trị đều có env override):
```ts
// src/shared/work-roots.ts  (không phụ thuộc Electron; omp-hooks và main cùng import)
import * as path from 'node:path';
const WORK_ROOT_DEFAULT = 'E:/Work';
export function workRoot(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.ANTIFAN_WORK_ROOT?.trim() || WORK_ROOT_DEFAULT);
}
export function leaderJobsRoot(env = process.env): string {
  return path.resolve(env.LEADER_JOBS_ROOT?.trim() || path.join(workRoot(env), 'scratch', 'leader'));
}
export function dataRoot(env = process.env): string {
  return path.resolve(env.ANTIFAN_DATA_ROOT?.trim() || path.join(workRoot(env), '.antifan-data'));
}
```
Thay lần lượt các hằng trên bằng `leaderJobsRoot()` / `dataRoot()` / `workRoot()`. Script `.mjs` import qua đường dẫn tương đối tới bản biên dịch hoặc giữ một bản nhỏ cùng nội dung (hook cài dạng bundle nên cần `scripts/install-omp-hooks.mjs --install` lại).
- [Cấu hình nâng cấp]:
```json
{ "env": { "ANTIFAN_WORK_ROOT": "E:/Work", "LEADER_JOBS_ROOT": "E:/Work/scratch/leader" } }
```
- [Lợi ích]: một chỗ sửa khi đổi ổ đĩa, test cô lập hơn, đỡ rủi ro lệch giữa hook, main và script.
- [Effort]: M · Impact: Med · Risk: Med. Bundle hook phải cài lại; chủ repo cần xác nhận các tên env mới (đây là đề xuất, repo chưa có `ANTIFAN_WORK_ROOT`).
- [Bằng chứng]: kết quả grep `E:/Work|E:\\Work` trên `src/omp-hooks;scripts/leader;src/main`.

### K61 — 7 bản kiểm tra path-nằm-trong-root khác nhau; gom một helper

`U61` · Trụ cột T1 · Effort M · Impact Low · Verifier: DOWNGRADED · Nguồn: E:F18 (bản viết dùng: E:F18)

> Ghi chú verifier: Biến thể startsWith('..') chỉ từ chối nhầm thư mục tên `..foo` (fail-safe), không phải bypass. Mới đọc 2/7 điểm.
> Lưu ý về code mới (verifier): theme-paths.ts thuộc bundle hook nên cài lại. Phải test từng điểm gọi.

- [Trụ cột]: T1 (kèm T5)
- [Vị trí]:
  - `src/main/server/safe-fs-resolver.ts:122-126`
  - `src/main/tools/artifact-store.ts:628-629`
  - `src/main/verification/baseline-authority.ts:97-98`
  - `src/main/browser/dead-store-cleaner.ts:244-245`
  - `src/main/qa/theme-transaction-registry.ts:43-47`
  - `src/main/control-plane/control-plane-runtime.ts:525-526`
  - `src/omp-hooks/theme-paths.ts:92-97`
- [Vấn đề]:
  - Bảy cách viết khác nhau. Biến thể `!rel.startsWith('..')` (`safe-fs-resolver.ts:123`, `control-plane-runtime.ts:526`, `theme-paths.ts:96`) từ chối nhầm thư mục tên `..foo`. Biến thể `startsWith(prefix)` thì phân biệt hoa/thường (artifact-store và baseline-authority phải tự so `toLowerCase` ở lần kiểm tra thứ hai). `safe-fs-resolver` còn tính hai lần (`isInside && hasBoundary`) cho cùng một điều kiện.
  - Chỉ `theme-transaction-registry.ts:43-47` làm đúng (`'..'` hoặc `'..' + sep`).
- [Code cũ] (`safe-fs-resolver.ts:122-126`):
```ts
    const relFromRoot = path.relative(canonicalRoot, canonicalFinal);
    const isInside = !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot);
    const hasBoundary = canonicalFinal.startsWith(
      canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep
    );
```
- [Code mới] — file mới `src/shared/path-containment.ts`:
```ts
import * as path from 'node:path';

/** True when `candidate` lies inside `root`; `root` itself counts only with allowEqual. */
export function isWithinRoot(root: string, candidate: string, opts: { allowEqual?: boolean } = {}): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return opts.allowEqual === true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}
```
rồi `safe-fs-resolver.ts`: `if (!isWithinRoot(canonicalRoot, canonicalFinal, { allowEqual: true })) { … 403 … }` (tính `relFromRoot` riêng cho `normalizedRel` ở bước sau).
- [Lợi ích]: một cửa duy nhất cho ranh giới bảo mật, hành vi nhất quán (Windows không phân biệt hoa/thường vì `path.relative` xử lý).
- [Effort]: M · Impact: Med · Risk: trung bình. `theme-paths.ts` thuộc hook (bundle bằng `scripts/install-omp-hooks.mjs`) nên cần reinstall hook; cần test từng điểm gọi.
- [Bằng chứng]: các anchor nêu trên. `src/shared` hiện không có helper nào như vậy (glob `src/shared`).

### K62 — tsconfig không bật noUnusedLocals/noUnusedParameters; thêm ratchet riêng

`U62` · Trụ cột T1 · Effort M · Impact Low · Verifier: VALIDATED · Nguồn: C:F23 (bản viết dùng: C:F23)

> Lưu ý về code mới (verifier): tsconfig.unused.json phải đặt incremental false để không ghi đè .compiled/.tsbuildinfo. Số lỗi baseline chưa biết.

- [Trụ cột]: T1
- [Vị trí]: `tsconfig.json:12-15`
- [Vấn đề]: `strict` bật nhưng không có `noUnusedLocals`/`noUnusedParameters` (grep không thấy), nên các lỗi như `staticTools` ở F4 qua mặt compiler. Bật thẳng trên ~580k dòng sẽ ra nhiều lỗi (`[INFERENCE]`), nên cần cơ chế ratchet.
- [Code cũ] (`:12-15`):
```json
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
```
- [Code mới]: file `tsconfig.unused.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "incremental": false,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```
- [Cấu hình nâng cấp]:
```json
"check:unused": "tsc -p tsconfig.unused.json"
```
```bash
npx tsc -p tsconfig.unused.json 2>&1 | rg -c "error TS6133|error TS6196"   # ghi số baseline rồi giảm dần
```
- [Lợi ích]: phát hiện biến, import, tham số chết một cách máy móc thay vì rà tay.
- [Effort]: M · Impact: Med · Risk: thấp vì không chạm `compile`; `--incremental false` tránh ghi đè `.compiled/.tsbuildinfo` (cùng cạm bẫy ghi trong memory).
- [Bằng chứng]: `tsconfig.json:3-22` (grep cờ); `mcp-tool-list.ts:11`.

### K63 — Bảng alias tool MCP ở 3 nơi (mcp-tool-list, mcp-server, proxy CAPABILITY_MAP) và nhân bản schema cho từng alias

`U63` · Trụ cột T1 · Effort M · Impact Low · Verifier: DOWNGRADED · Nguồn: A:F17, B:F17, C:F19, E:F20 (bản viết dùng: C:F19)

> Ghi chú verifier: B:F17/E:F20 coi đây là chi phí token của agent; sai, vì danh sách agent-facing là `definitions` của proxy. Chỉ còn giá trị bảo trì.
> Lưu ý về code mới (verifier): Chuyển chuỗi if sang bảng dữ liệu là cơ học. Gộp ba bảng cần bước dịch hai tầng vì CAPABILITY_MAP trỏ tên catalogue khác tên antifan_*.

- [Trụ cột]: T4
- [Vị trí]: `src/main/mcp/mcp-tool-list.ts:34-80` (khối `aliases`), lặp lại tên ở `mcp-server.ts:527-` (`aliasMap`)
- [Vấn đề]: ~45 dòng `if (item.name === ...) generated.push({ ...item, name })` là dữ liệu viết thành code. Danh sách này còn tồn tại thêm lần nữa như `aliasMap` trong `callTool` (`mcp-server.ts:527-529...`) và `CAPABILITY_MAP` của proxy (`antifan-omp-mcp.cjs:638`). Ba bảng alias phải đồng bộ tay. Hàm được gọi qua IPC `antifan:workflow:get-state` mỗi lần mở panel workflow (`native-tab-host.ts:4167-4168`), dựng lại toàn bộ.
- [Code cũ] (`mcp-tool-list.ts`, 4 dòng đầu của khối alias):
```ts
    if (item.name === 'antifan_open_tab') generated.push({ ...item, name: 'anti.browser.tabs.create' });
    if (item.name === 'antifan_list_tabs') generated.push({ ...item, name: 'anti.browser.tabs.list' });
    if (item.name === 'antifan_switch_tab') generated.push({ ...item, name: 'anti.browser.tabs.activate' });
    if (item.name === 'antifan_close_tab') generated.push({ ...item, name: 'anti.browser.tabs.close' });
```
- [Code mới]:
```ts
type AliasSpec = string | { name: string; description: string };
const TOOL_ALIASES: Record<string, readonly AliasSpec[]> = {
  antifan_open_tab: ['anti.browser.tabs.create'],
  antifan_list_tabs: ['anti.browser.tabs.list'],
  antifan_switch_tab: ['anti.browser.tabs.activate'],
  antifan_close_tab: ['anti.browser.tabs.close'],
  antifan_navigate: ['anti.browser.navigate'],
  antifan_reload: ['anti.browser.reload'],
  antifan_get_dom: ['anti.inspect.dom'],
  antifan_screenshot: ['anti.screenshot.viewport', { name: 'anti.screenshot.full_page', description: 'Capture full-page screenshot of entire scrollable page height using CDP' }],
  antifan_agent_click: ['anti.browser.click', 'anti.agent.cursor.click'],
  antifan_agent_type: ['anti.browser.type', 'anti.agent.cursor.type'],
  // ...chuyển cơ học các dòng còn lại của khối `aliases` hiện tại, giữ nguyên tên và mô tả đè...
};
const aliases = listed.flatMap((item) =>
  (TOOL_ALIASES[item.name] ?? []).map((spec) =>
    typeof spec === 'string' ? { ...item, name: spec } : { ...item, name: spec.name, description: spec.description }));
```
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: một bảng dữ liệu, dễ kiểm tra trùng/lệch với `aliasMap` và `CAPABILITY_MAP`; có thể tạo test đối chiếu.
- [Effort]: M · Impact: Low–Med · Risk: phải giữ `description` đè và các mục có hai nguồn (`browser.dump_dom`/`antifan_dump_dom`, `theme.resolve_product`/`antifan_theme_resolve_product`); test `capability-catalogue.test.ts:396-400` phủ alias.
- [Bằng chứng]: `mcp-tool-list.ts:11-111`; `mcp-server.ts:527-529`; `native-tab-host.ts:4167-4168`; `antifan-omp-mcp.cjs:638`. Chuyển bảng "cơ học" cần người làm đối chiếu từng dòng; đoạn trên chỉ liệt kê 10 mục đầu.

### K64 — AntiFanMcpServer không còn importer production: chuyển vào test/support

`U64` · Trụ cột T1 · Effort L · Impact Low · Verifier: VALIDATED · Nguồn: C:F24 (bản viết dùng: C:F24)

> Ghi chú verifier: Làm sau U19 và U39 để mã chết rút dần.
> Lưu ý về code mới (verifier): Chưa kiểm check-emit-integrity / prune-orphan-emit có liệt kê file này. Nhiều test và smoke phải đổi import.

- [Trụ cột]: T1
- [Vị trí]: `src/main/mcp/mcp-server.ts` (785 dòng), `src/main/index.ts:268-271`
- [Vấn đề]: grep `mcp/mcp-server|'./mcp-server'` trên `src; scripts/*.cjs; scripts/*.mjs; package.json` chỉ trả về `index.ts:268-269` (thông báo "discontinued"), hai smoke script (`scripts/smoke-background-multitasking.cjs:42`, `smoke-dual-plane-two-attachments.cjs:40`) và một comment trong `audit-capability-reachability.mjs`. Ngoài `src`, importer duy nhất là test/e2e. `native-tab-host.ts:77` chỉ import `buildMcpToolList` từ `mcp-tool-list.ts`. Class chỉ còn là harness cho test, nhưng nằm ở `src/main` và theo vào bản đóng gói.
- [Code cũ] (`src/main/index.ts:268-271`):
```ts
if (process.argv.includes('--mcp-server')) {
  console.error('[antifan] Electron --mcp-server is discontinued. Use the standalone Node MCP proxy (scripts/antifan-omp-mcp.cjs) to connect to a running AntiFan Desktop instance.');
  app.exit(1);
  process.exit(1);
```
- [Code mới]: `git mv src/main/mcp/mcp-server.ts test/support/mcp-server-harness.ts` và sửa import trong các test và smoke script, ví dụ:
```ts
// test/main/capability-catalogue.test.ts
import { AntiFanMcpServer } from '../support/mcp-server-harness';
```
```js
// scripts/smoke-*.cjs
const { AntiFanMcpServer } = require('../.compiled/test/support/mcp-server-harness.js');
```
- [Cấu hình nâng cấp]: không áp dụng.
- [Lợi ích]: −785 dòng khỏi `src/main`, ranh giới production/test rõ ràng.
- [Effort]: L · Impact: Low–Med · Risk: nhiều file test và smoke phải sửa đường dẫn; chưa kiểm xem `check-emit-integrity` hay `prune-orphan-emit` có liệt kê file này (`[INFERENCE]`).
- [Bằng chứng]: grep `mcp/mcp-server` (src; scripts; package.json) và grep `AntiFanMcpServer` (src;scripts;test) cho danh sách test; `native-tab-host.ts:77`; `mcp-server.ts:22`, `:516-524`.

## 4. Phát hiện riêng của controller (ngoài 5 ứng viên)

### CO-1 — `safeStorage` đồng bộ sẽ bị gỡ ở Electron 46; API async đã có sẵn trong Electron 43.7.9 đang cài
- [Trụ cột] T3
- [Vị trí] `src/main/browser/local-credential-vault.ts:213-218` (`save`), `:253-263` (`getForOrigin`); interface `SafeStorageLike` (`:51`).
- [Vấn đề] Tài liệu Electron chính thức: "The synchronous API (`isEncryptionAvailable`/`encryptString`/`decryptString`) is deprecated and will be removed in Electron 46. Use the asynchronous API (`isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync`)". `node_modules/electron/electron.d.ts:12022, 12032, 12063` cho thấy API async đã có trong bản 43.7.9 → chuyển được ngay, không cần chờ nâng major.
- [Code cũ]
```ts
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'ENCRYPTION_UNAVAILABLE' };
    }

    const encrypted = this.safeStorage.encryptString(cleanPassword);
    const passwordEnc = encrypted.toString('base64');
```
```ts
    if (!cleanOrigin || !this.safeStorage.isEncryptionAvailable()) return [];
    const result: DecryptedCredential[] = [];
    for (const entry of this.entries) {
      if (entry.origin !== cleanOrigin) continue;
      try {
        const password = this.safeStorage.decryptString(Buffer.from(entry.passwordEnc, 'base64'));
```
- [Code mới] (`save` và `getForOrigin` trở thành `async`)
```ts
    if (!(await this.safeStorage.isAsyncEncryptionAvailable())) {
      return { ok: false, error: 'ENCRYPTION_UNAVAILABLE' };
    }

    const encrypted = await this.safeStorage.encryptStringAsync(cleanPassword);
    const passwordEnc = encrypted.toString('base64');
```
```ts
    if (!cleanOrigin || !(await this.safeStorage.isAsyncEncryptionAvailable())) return [];
    const result: DecryptedCredential[] = [];
    for (const entry of this.entries) {
      if (entry.origin !== cleanOrigin) continue;
      try {
        const { result: password } = await this.safeStorage.decryptStringAsync(Buffer.from(entry.passwordEnc, 'base64'));
```
- [Việc kèm theo] Mở rộng `SafeStorageLike` thêm 3 method async; đổi kiểu trả về của `save`/`getForOrigin` sang `Promise<…>` và `await` ở mọi caller; cập nhật fake trong test. Danh sách caller chưa được controller liệt kê. Theo tài liệu, dữ liệu mã hoá bằng `encryptString` giải được bằng `decryptStringAsync` nên không cần migrate dữ liệu.
- [Lợi ích] Không còn chặn main thread khi mã hoá; gỡ một điểm chắc chắn vỡ khi lên Electron 46.
- Effort: M · Impact: Med · Risk: đổi chữ ký hàm lan sang caller.

### CO-2 — Vệ sinh repo (dòng B21 trong `plans/bottlenecks.json` vẫn mở)
- [Trụ cột] T1
- [Hiện trạng đo được]
  - 6.812 file được git theo dõi; `plans/` 4.717.
  - Tracked dù khớp `.gitignore`: `.canary/` 198 file, `.playwright-mcp/` 3, `clones/` 1. Trong đó `.canary/tools` (27 file) đang được `scripts/` tham chiếu (ví dụ `scripts/run-theme-harness.mjs`, `scripts/lib/build-report.mjs`) → code sống nằm trong thư mục bị ignore, file mới ở đó sẽ không được theo dõi.
  - Root có 10 báo cáo rời (`AntiFan-*.md`, `ANTIFAN_IMPROVEMENTS.md`, `deep-audit-round11-report.md`, `antifan-deep-architecture-6-plan-review.md`, `RESEARCH_REPORT_ANTIFAN_VISUAL_QA_RESOLUTION.md`, `15-PAGE-HOPLONGTECH-CLONE-CANARY.md`, một `.docx`), `issue172_dom.html`, `issue172_pristine.html`, `loop-results.tsv`.
  - `tsconfig.p10.json`: 0 tham chiếu trong `package.json`, `scripts/`, `docs/`, `README.md`.
  - `git count-objects`: 98,72 MiB object rời (6.397), `prune-packable` 3.372.
  - Ngoài git: `.super-core/core.db.bak` 105,7 MB, `.super-core/core.db.pre-healthfix.bak` 175,2 MB, `scratch/core-migration-test.db` 176 MB.
- [Giải pháp] (bạn tự chạy; các lệnh `git rm --cached` giữ nguyên file trên đĩa)
```bash
git rm --cached -r .playwright-mcp clones
git mv .canary/tools scripts/canary-tools        # rồi sửa đường dẫn trong các script tham chiếu
mkdir -p docs/archive && git mv AntiFan-*.md ANTIFAN_IMPROVEMENTS.md deep-audit-round11-report.md antifan-deep-architecture-6-plan-review.md RESEARCH_REPORT_ANTIFAN_VISUAL_QA_RESOLUTION.md docs/archive/
git gc
node scripts/check-bottlenecks.mjs            # B21 phải chuyển trạng thái
```
- [Cần bạn quyết định] Giữ hay bỏ theo dõi 171 file bằng chứng còn lại trong `.canary/` (`theme-fidelity-run4` 132 file…); xoá `tsconfig.p10.json`; xoá 3 file DB sao lưu (~457 MB).
- Effort: S · Impact: Low (runtime) / Med (bảo trì) · Risk: `git mv .canary/tools` phải đi cùng sửa đường dẫn, nếu không harness vỡ.

## 5. Trụ cột 4 — Cấu hình AI Agent (phần do controller đo, ngoài phạm vi 5 ứng viên)

Repo AntiFan **không gọi trực tiếp LLM API nào**: grep `reasoningEffort|X-Service-Tier|service_tier|cache_control|prompt_cache|api.openai.com|api.anthropic.com|chatLanguageModels` trên `src; scripts; packages/*/src; extension; .omp` chỉ ra bộ nhận diện trang chat AI (`src/preload/tab-preload.ts:179`) và regex marker terminal. Không có `settings.json`/`chatLanguageModels.json` để chỉnh. Nơi quyết định model, mức tư duy, service tier và prompt cache là **cấu hình OMP toàn cục** (`~/.omp/agent/config.yml`, đọc qua `cfg://`) — các mục P4-1…P4-7 dưới đây dựa trên cấu hình đó và trên `~/.omp/stats.db` (truy vấn chỉ đọc, snapshot 11/11/2026; dòng mới nhất trong DB cũ hơn ~7 giờ so với lúc đo).

Chi phí trong `stats.db` là giá niêm yết quy đổi; nếu bạn dùng gói thuê bao thì đây là thước đo mức tiêu hạn mức, không phải tiền thật.

### Số đo 7 ngày (mọi dự án)

| Nhóm | Request | Chi phí danh nghĩa (USD) | Tỷ lệ |
|---|---:|---:|---:|
| main | 68.855 | 1.899,88 | 51,0% |
| advisor | 54.238 | 1.229,16 | 33,0% |
| subagent | 20.068 | 592,52 | 15,9% |
| Tổng | 143.186 | 3.722,66 | 100% |

| Model (7 ngày) | Request | Cache hit (công thức status line) | Input không cache (token) | Chi phí (USD) |
|---|---:|---:|---:|---:|
| anthropic/claude-sonnet-5-5 | 42.326 | 97,7% | 2.063.610 | 2.017,32 |
| aibox/ds/deepseek-flash | 49.612 | 98,3% | 127.008.924 | 46,39 |
| devin/swe-2-flash | 19.325 | 67,0% | 655.825.804 | 609,78 |
| google-antigravity/gemini-4-argon | 10.933 | 93,2% | 137.806.354 | 553,91 |
| anthropic/claude-fable-5-2 | 1.256 | 98,0% | 7.858 | 293,52 |
| anthropic/claude-opus-5-5 | 1.009 | 97,3% | 6.197 | 94,58 |

Công thức status line: `cacheRead / (cacheRead + cacheWrite + input)`. Toàn bộ 7 ngày: 94,94%; 24 giờ: 98,04%; riêng thư mục AntiFan: 96,6%. Cột `service_tier` rỗng ở cả 143.161 dòng.

Cơ cấu chi phí `claude-sonnet-5-5` 7 ngày: cache read 913,7 · **cache write 861,4 (42,7%)** · output 238,1 · input 4,1.

Prompt của request đầu tiên mỗi phiên (thư mục AntiFan, 7 ngày, trung vị): main 109.404 token (ghi cache 86.256), subagent 82.830 (ghi 27.651, đọc 41.634), advisor 28.989.

### P4-1 — Advisor review mỗi lượt ở mức `xhigh`: 38% số request, 33% chi phí
- [Vị trí] `advisor.enabled: true`, `advisor.reviewMode: "turn"`, `advisor.reviewInterval: 1`, `modelRoles.advisor: "anthropic/claude-sonnet-5-5:xhigh"`.
- [Vấn đề] Mỗi lượt của agent chính kéo theo một lượt model thứ hai ở mức tư duy cao hơn cả agent chính (`default` = `:high`). 7 ngày: 54.238 request, 1.229,16 USD.
- [Cấu hình cũ]
```yaml
advisor:
  enabled: true
  reviewMode: "turn"
  reviewInterval: 1
modelRoles:
  advisor: "anthropic/claude-sonnet-5-5:xhigh"
```
- [Cấu hình mới] (chọn một trong hai; cả hai giá trị đều là lựa chọn hợp lệ của khoá hiện có)
```yaml
advisor:
  enabled: true
  reviewMode: "agent-end"     # review một lần khi agent kết thúc, thay vì mỗi lượt
  # hoặc giữ "turn" và đặt reviewInterval: 3
modelRoles:
  advisor: "anthropic/claude-sonnet-5-5:high"
```
- [Lợi ích] Cắt phần lớn 33% chi phí danh nghĩa và một nguồn ghi cache riêng (advisor có ngữ cảnh riêng). Đánh đổi: phát hiện lỗi muộn hơn (cuối run thay vì giữa run). Đây là quyết định của bạn.

### P4-2 — `devin/swe-2-flash` chiếm 66,8% toàn bộ input không cache
- [Vị trí] `retry.fallbackChains` (`"aibox/qwen3.8-omni-flash": ["devin/swe-2-flash"]`), và model này còn được dùng trực tiếp làm advisor (11.705 request advisor trong 7 ngày).
- [Vấn đề] Cache hit 67,0% trong khi các model khác 93–98%. 655.825.804 / 982.139.055 token input không cache của cả 7 ngày đến từ một model; 609,78 USD (16,4%). Theo thư mục: Gác 74,9%, `E:/Work/apps` 56,3%, AntiFan 55,6%.
- [Giải pháp] Bỏ model này khỏi vai trò advisor và khỏi chuỗi fallback, hoặc thử `provider.appendOnlyContext: "on"` (hiện `"auto"`; mô tả của khoá: giữ system prompt + tool spec cố định và message log chỉ nối thêm để prefix cache của provider trúng) rồi đo lại. Nguyên nhân gốc của tỷ lệ 67% chưa được xác định `[INFERENCE]`: provider không giữ prefix cache ổn định, hoặc do bị chuyển model giữa phiên.
```yaml
retry:
  fallbackChains:
    "google-antigravity/*": ["anthropic/claude-haiku-5-5"]
    "anthropic/*": ["aibox/ds/deepseek-flash"]
    "devin/*": ["opencode-go/deepseek-v4.1-flash"]
    # bỏ dòng "aibox/qwen3.8-omni-flash": ["devin/swe-2-flash"]
```
- [Đo lại] câu SQL ở mục "Cách đo lại" cuối phần này, lọc `model='swe-2-flash'`.

### P4-3 — Fallback `anthropic/* → aibox/ds/deepseek-flash` bật cho mọi loại lỗi
- [Vị trí] `retry.fallbackOn: "any"`, `retry.fallbackRevertPolicy: "cooldown-expiry"`, `retry.maxRetries: 10`.
- [Vấn đề] Một lỗi tạm thời của Anthropic (không chỉ hết hạn mức) cũng đẩy lượt đó sang model yếu hơn nhiều, và mỗi lần đổi model là một prefix cache lạnh ở cả chiều đi lẫn chiều về. `deepseek-flash` có 49.612 request trong 7 ngày (nhiều nhất theo số lượng). `stats.db` không ghi request nào là fallback, nên tỷ lệ fallback thật chưa đo được `[INFERENCE]`.
- [Cấu hình mới]
```yaml
retry:
  fallbackOn: "usage-limit"   # lỗi tạm thời thì retry cùng model (maxRetries: 10 đã có)
```
- [Lợi ích] Chất lượng code ổn định hơn, ít ghi cache lại. Đánh đổi: khi Anthropic lỗi kéo dài, lượt đó chờ retry thay vì chạy tiếp bằng model khác.

### P4-4 — Mọi vai trò dùng chung một bậc model; "model mạnh nhất" của kongming thực ra là cùng bậc
- [Vị trí] `modelRoles`: `task`, `vision`, `tiny`, `slow`, `smol`, `commit`, `plan`, `memory` = `anthropic/claude-sonnet-5-5:medium`; `default`, `judge` = `:high`; `web` = `anthropic/claude-haiku-5-5:max`. `.omp/agents/kongming.md:5-7` khai `model: "@slow"`, `thinkingLevel: max`, mô tả "strongest available model".
- [Vấn đề]
  - Vai trò `slow` trỏ về đúng model của `task`. Transcript của verifier trong lần chạy này ghi model `claude-sonnet-5-5`, `thinkingLevel: medium` — tức bước "leo thang lên model mạnh nhất" không leo thang gì. Vì sao frontmatter `thinkingLevel: max` không thắng hậu tố `:medium` thì chưa xác minh `[INFERENCE]`.
  - Việc nhỏ (`tiny` đặt tên phiên, `smol`, `commit`, `memory`) chạy sonnet mức medium, trong khi model rẻ `claude-haiku-5-5` lại được đặt `:max` cho `web` — phân bổ ngược.
- [Cấu hình mới] (đề xuất; model cho `slow` do bạn chọn trong các model bạn đang có: `claude-fable-5-2`, `claude-opus-5-5`)
```yaml
modelRoles:
  default: "anthropic/claude-sonnet-5-5:high"
  plan:    "anthropic/claude-sonnet-5-5:high"
  task:    "anthropic/claude-sonnet-5-5:medium"
  slow:    "anthropic/claude-opus-5-5:xhigh"      # bậc leo thang thật cho kongming / verifier
  judge:   "anthropic/claude-sonnet-5-5:medium"
  advisor: "anthropic/claude-sonnet-5-5:high"
  vision:  "anthropic/claude-sonnet-5-5:medium"
  smol:    "anthropic/claude-haiku-5-5:low"
  tiny:    "anthropic/claude-haiku-5-5:low"
  commit:  "anthropic/claude-haiku-5-5:low"
  memory:  "anthropic/claude-haiku-5-5:medium"
  web:     "anthropic/claude-haiku-5-5:medium"
```
- [Lợi ích] Trả đúng giá cho việc nhỏ; bước leo thang (kongming, verifier của `--ultra`) mới thật sự mạnh hơn ứng viên. Chất lượng của haiku cho `commit`/`memory` chưa được đo trên dự án này — thử một tuần rồi so.

### P4-5 — `defaultThinkingLevel: "max"` và ngân sách `max` = `xhigh`
- [Vị trí] `defaultThinkingLevel: "max"` (mặc định của OMP là `"high"`); `thinkingBudgets.max: 32768`, `thinkingBudgets.xhigh: 32768`.
- [Vấn đề] Hai bậc cao nhất có cùng ngân sách token, nên `max` không mua thêm gì so với `xhigh` ở phía ngân sách. Mức mặc định `max` áp cho mọi model/vai trò không có hậu tố `:level` (thứ tự ưu tiên giữa hậu tố vai trò và mặc định chưa xác minh `[INFERENCE]`).
- [Cấu hình mới]
```yaml
defaultThinkingLevel: "high"
```
  Dùng từ khoá `ultrathink` trong prompt khi cần mức tối đa cho một lượt (`magicKeywords.ultrathink: true` đã bật).
- [Lợi ích] Ít token tư duy (tính như output) và thời gian chờ cho các lượt cơ học; lượt khó vẫn nâng được theo yêu cầu.

### P4-6 — Service tier: giữ nguyên; "chế độ nhanh" là tier trả thêm tiền
- [Vị trí] `tier.anthropic: "none"`, `tier.openai: "none"`, `tier.google: "none"`, `tier.advisor: "none"`, `tier.subagent: "inherit"`, `task.agentServiceTierOverrides: {}`.
- [Hiện trạng] Không request nào trong 7 ngày dùng service tier. Header kiểu `X-Service-Tier: fast` tương ứng với `tier.anthropic: "priority"` / `tier.openai: "priority"` trong OMP: nhanh hơn nhưng đắt hơn, **không** tiết kiệm chi phí.
- [Nếu cần độ trễ thấp cho agent chính]
```yaml
tier:
  anthropic: "priority"
  subagent: "none"     # đừng để 20k request subagent/tuần thừa hưởng tier đắt
  advisor: "none"
```
- [Khuyến nghị] Không bật. Độ trễ hiện tại của sonnet: TTFT trung bình ~2,0 s (7 ngày).

### P4-7 — Prompt cache: tỷ lệ trúng đã cao; thứ cần giảm là số lần GHI cache và phần prompt cố định
- [Hiện trạng] `providers.cacheRetention: "auto"`, `providers.cacheWarming: "idle"`, `compaction.supersedeReads: true`, `compaction.dropUseless: true`, status line đã có `cache_hit`. Anthropic trúng 97–98%.
- [Vấn đề] 42,7% chi phí sonnet là ghi cache. Mỗi ngữ cảnh mới (subagent, advisor, phiên mới, đổi model do fallback, sau compaction) ghi lại prefix. Prompt đầu phiên trung vị 109k token (main) và 83k (subagent) ở thư mục AntiFan: system prompt mang danh mục vài trăm skill (`skillful: true`), danh mục thiết bị MCP `xd://` (`tools.xdev: true`, `xdevDocs: "catalog"`), AGENTS.md hai tầng và phần memory. Thành phần chiếm bao nhiêu trong 109k chưa được tách đo `[INFERENCE]`.
- [Giải pháp]
  1. Giảm số ngữ cảnh: P4-1 (advisor), P4-3 (bớt đổi model).
  2. Bật `display.cacheMissMarker: true` để thấy lượt nào mất cache và truy nguyên nhân.
  3. Thu gọn phần cố định theo dự án: `skills.ignoredSkills` (hiện `["ak:*"]`) (giá trị hiện tại dùng mẫu `ak:*`; cú pháp glob theo tên skill và việc đặt ở mức dự án chưa được kiểm chứng `[INFERENCE]`) — trong workspace AntiFan có thể thử loại các nhóm không liên quan (`gac-*`, `ttb-*`, `muse-*`, `an-vat-*`, `tuong-*`, `vidaff-*`, `figforyou-*`, `shopify-*`…) bằng cấu hình mức dự án; hoặc `/skillful` để tắt danh mục skill cho phiên thuần code.
  4. Các mục phía repo làm prompt động phình ra đã nằm trong kế hoạch chính: pack Core bơm mỗi lượt, hồ sơ tool MCP mặc định quảng bá toàn bộ bề mặt, alias nhân đôi schema.
```yaml
display:
  cacheMissMarker: true
skills:
  ignoredSkills: ["ak:*", "gac-*", "ttb-*", "muse-*", "an-vat-*", "tuong-*", "vidaff-*", "figforyou-*"]   # đặt ở cấu hình mức dự án AntiFan
```
- [Lợi ích] Mỗi 10k token bớt khỏi prefix được nhân với số ngữ cảnh mới (129 phiên Anthropic đầu-phiên trong 7 ngày chỉ riêng thư mục AntiFan).

### Cách đo lại (chỉ đọc, không cần `omp stats` đồng bộ)
```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.USERPROFILE+'/.omp/stats.db',{readOnly:true});
const since=Date.now()-7*864e5;
for(const r of db.prepare('select agent_type a,provider p,model m,count(*) n,sum(input_tokens) i,sum(cache_read_tokens) cr,sum(cache_write_tokens) cw,sum(cost_total) c from messages where timestamp>? group by a,p,m order by c desc limit 20').all(since))
  console.log(r.a,r.p+'/'+r.m,'req',r.n,'hit%',(100*r.cr/((r.i+r.cr+r.cw)||1)).toFixed(1),'cost',(r.c||0).toFixed(2));
"
```
Thay đổi cấu hình áp dụng cho tiến trình OMP **mới**; sao lưu `~/.omp/agent/config.yml` trước. Tôi không sửa cấu hình nào trong lần chạy này.

## 6. Hiệu chỉnh của controller

1. Packet của controller ghi `src/renderer/session-activity.js` là "trùng lặp" — sai. Đây là bản sinh từ `src/shared/session-activity.ts`, được khai trong `scripts/lib/generated-renderer-assets.cjs:9` và được git theo dõi. 4 ứng viên đã sửa đúng; mục K52 giữ phần chẩn đoán, bỏ đề xuất `.gitignore`.
2. K24 (quyền trang web): đã đối chiếu tài liệu Electron chính thức và grep 0 hit; giữ mức Med vì danh sách quyền là quyết định sản phẩm.
3. K25 (Electron/TS): không ứng viên nào đọc changelog. Controller bổ sung dữ kiện từ tài liệu Electron chính thức (`safeStorage`) và nguồn thứ cấp (ngày EOL, breaking change 45, TS 7); phần "sẽ gãy gì" còn lại vẫn là suy luận cho tới khi chạy thử từng bậc.
4. K02: verifier ghi High; controller đánh giá tác động thực tế là Med vì route challenge đã giới hạn loopback (`bridge-server.ts:1439-1443`). Giữ hạng 2 theo tỷ lệ tác động/công sức; khả năng khai thác chưa được chứng minh.
5. K36, K39, K63: lý do "ổn định prompt-cache"/"chi phí token của agent" bị bác — `AntiFanMcpServer` chỉ được smoke script và test dùng (`scripts/smoke-background-multitasking.cjs:221`, `scripts/smoke-dual-plane-two-attachments.cjs:207`); bề mặt agent thật là `definitions` trong `scripts/antifan-omp-mcp.cjs`.
6. Verifier chỉ dùng 26 request để kiểm 121 finding; controller đọc code độc lập cho 35 mục. Các mục còn lại dựa trên verifier hoặc mang nhãn UNCHECKED.
7. Mục cấu hình agent (P4-*) do controller đo trực tiếp từ `cfg://` và `~/.omp/stats.db`; verifier không chấm phần này.

## 7. Mục bị loại

| Source | Tiêu đề | Lý do |
|---|---|---|
| B:F24 | Hàm 'deprecated' trong packet không phải deprecated | Chính B ghi 'giữ nguyên'. `fs.rmdirSync(dir)` không đệ quy ở `artifact-retention-cleaner.ts:148-149`, `profile-ownership.ts:235`, `install-managed-skills.mjs:151` đúng là false positive, nhưng không có thay đổi để thực hiện. A, C, D, E cũng nêu cùng kết luận trong phần câu hỏi mở nên không mất thông tin. |

## 8. Câu hỏi còn mở / phần chưa kiểm

- Không ứng viên nào nêu Electron 45 deprecate `safeStorage` đồng bộ đang dùng ở `local-credential-vault.ts:213,217,258` (controller #20); chỉ controller biết điểm này.
- Không ai phân loại nhóm 891 `catch {}` trong 94 file (mới chạm vài chỗ: `native-tab-host.ts:10205`, `browser-capabilities.ts`). Phần lớn của 159 chỗ trong `native-tab-host.ts` và 90 chỗ trong `standalone.js` chưa được xem.
- Rò rỉ listener và timer: `addEventListener` 300 vs `removeEventListener` 15 ở renderer, và `setInterval` 20 vs `clearInterval` 18, không ai kiểm.
- 42 chỗ `eval(`/`new Function(` chưa được phân loại. D chỉ khẳng định 'không có eval trong main' mà không đối chiếu số liệu packet.
- Vệ sinh repo bị bỏ sót: `.canary/` 198 file tracked dù bị ignore, các file report/docx ở root (B21), 6 hàng B21–B37 còn mở trong `plans/bottlenecks.json`.
- `native-tab-host.ts`, `tab-devtools-host.ts` và `terminal-manager.ts` chỉ được xem ở vài điểm. `renderer/standalone.js`, `toolbar.ts` và `terminal-daemon/*` gần như chưa đụng.
- Chưa có đo đạc nào cho kích thước `tools/list`, tần suất hook và độ lớn bảng stale. Mọi mức tác động Med/High liên quan đều chưa có số.
- `packages/site-clone` chỉ được xem ở `theme-compiler.ts` (D:F25); devDeps lệch root (`@types/node ^20.11.0`, `typescript ^5.3.3`) chỉ A thoáng nhắc.
- Tỷ lệ request là fallback thật (P4-3) và thành phần của 109k token prompt đầu phiên (P4-7) chưa tách đo.
- Caller của `LocalCredentialVault.save`/`getForOrigin` (CO-1) chưa liệt kê.
- 5 mục UNCHECKED: K48, K53, K55, K56, K58.

## 9. Phụ lục xếp hạng

### Điểm rubric (1–20 mỗi tiêu chí)

| Ứng viên | Coverage T1–T5 | Evidence | Actionability | Signal & ưu tiên | Honesty | Tổng /100 | Hard constraint |
|---|---:|---:|---:|---:|---:|---:|---|
| A | 17 | 17 | 16 | 14 | 17 | 81 | PASS: không vi phạm §0, không đảo §2.8 |
| B | 18 | 18 | 17 | 15 | 17 | 85 | PASS: F24 là mục không có hành động, nhưng không vi phạm |
| C | 17 | 17 | 16 | 15 | 18 | 83 | PASS |
| D | 18 | 16 | 16 | 15 | 16 | 81 | PASS: F13 ghi sai path `src/process/…`, F28 hiểu sai predicate, đều là lỗi nhỏ, không phải bịa path |
| E | 17 | 16 | 16 | 15 | 18 | 82 | PASS |

Không ứng viên nào vi phạm hard constraint nên không phải reject-all. Điểm chỉ dùng để phân hạng. Việc quyết định giữ hay bỏ dựa trên từng finding.

### Lập luận của verifier

- Cả 5 ứng viên đều phủ T1–T5. Mỗi ứng viên đóng góp mục mà người khác bỏ sót:
  - B: các bản sao fail-open của workspace root, phân giải capability bị cấm, stage đồng bộ, handler quyền.
  - C: kiểm tra Host/DNS-rebinding, handler HTTP không có try/catch.
  - D: terminal persist, `decayCheck`, `body += chunk`, `readChanges`.
  - E: `knowledgeGaps`, `pid` bị ghi đè, helper containment.
  - A: hibernation fail-open, `invalidate` với index.
  Vì vậy cần union, không chọn người thắng.
- Tôi tự đọc code cho các mục High và security. Kết quả đối chiếu:
  - `bridge-server.ts:1028-1050`, `1438-1476`, `2084-2141` khớp C:F1 và A:F4.
  - `browser-capabilities.ts:1571-1577` và `2132-2139` khớp B:F1.
  - `antifan-omp-mcp.cjs:1478-1511` khớp B:F2.
  - `index.ts:1421-1457` và `838-891` khớp E:F7 và D:F4.
  - `schema.ts:198-207` cho thấy `evidence.claimId` có FK `ON DELETE CASCADE`, nên mối lo FK của A:F6 được giải.
  - `check-bottlenecks.mjs:195-199` xác nhận cách đọc B20 của A và B.
  - Không tìm thấy `setEncoding` trong `bridge-server.ts`, nên D:F16 là bug thật.
- Lỗi lặp lại ở nhiều ứng viên (đồng thuận không phải bằng chứng):
  - Coi `mcp-server.ts` / `mcp-tool-list.ts` là bề mặt prompt-token của agent (B:F17, E:F20, A:F9, D:F1). Controller #19 cho thấy `AntiFanMcpServer` chỉ có caller là smoke script và test. Danh sách agent-facing là `definitions` của proxy.
  - Lý do "ổn định prompt-cache" để memoize `listTools` (A:F7, B:F12, D:F9, E:F6). Đầu ra đã xác định theo thứ tự, memoize chỉ tiết kiệm CPU và `tools/list` được gọi hiếm.
  - Gán "High" và "mỗi tool call/mỗi turn" mà không đo tần suất (A:F1, D:F6, D:F4, E:F7, E:F17). Tôi hạ về Med khi tần suất hoặc điều kiện lỗi chỉ là `[INFERENCE]`.
  - 5/5 ứng viên đều đề xuất `timingSafeEqual` cho token. Đây là hardening Low, không phải mục quan trọng.
- 4 ứng viên đề xuất thêm 4 file vào `.gitignore` (B:F23, C:F8, D:F27, E:F14). Controller #14 cho biết các file này đang được git theo dõi và là build product có chủ đích. `.gitignore` một mình không có tác dụng với file đã tracked, cần `git rm --cached`. Tôi hạ xuống Low.
- D:F28 ("không tái hiện được REOPENED, predicate lẽ ra đạt") là hiểu sai. `present = !re.test(text)`, mà chuỗi `outside the supported 1` không còn trong file, nên predicate bắn là đúng. Phần "evidence cũ đã sai với code tile" là đúng và trùng với A:F3 và B:F7.
- B:F24 không đề xuất thay đổi (xác nhận `rmdirSync` không phải false positive deprecated). Tôi DROP vì không có việc để làm.
- Chất lượng code mới: phần lớn compile-plausible. Các điểm cần sửa:
  - D:F4 `countOnly` làm union return type gãy typecheck ở `health()`.
  - B:F10 để thừa import `execSync`.
  - D:F13 ghi path sai và đổi hành vi POSIX.
  - D:F19 ghi `^45.3.0` nhảy hai major, mâu thuẫn với lời bàn bậc thang của chính nó.
  - B:F8 không phủ nhánh `defaultSession` (partition rỗng) và có thể vỡ OAuth/Meet.
- Không ứng viên nào đọc changelog Electron, TS 7 hay zod 4. Mọi "gãy gì" đều `[INFERENCE]`. Tôi cũng không tự kiểm được, nên các mục T3 mang tính kế hoạch, không phải kết luận.
- Độ tin cậy: cao cho các mục có controller ground truth hoặc tôi đã đọc dòng. Trung bình cho các mục mức tác động phụ thuộc tần suất chưa đo. 5/64 mục UNCHECKED (7,8%).

### Kiểm tra controller đã thực chạy
- `npm outdated --json`, `npm audit --json` (không sửa gì).
- `node scripts/check-bottlenecks.mjs --json`.
- `git rev-parse`, `git ls-files`, `git count-objects -vH` (chỉ đọc).
- ripgrep đếm mẫu trên `src/` (sync fs, `catch {}`, `console.*`, `any`, timer/listener…).
- Đọc trực tiếp các dải code nêu ở cột "Controller đọc code".
- Truy vấn chỉ đọc `~/.omp/stats.db`; đọc `cfg://`.
- Tài liệu Electron chính thức: trang Security và trang `safeStorage`; web search cho lịch hỗ trợ Electron và TypeScript 7 (nguồn thứ cấp).
- Không chạy: compile, test, typecheck, app, AntiFan MCP.

### Bản đồ nhãn ứng viên
- A = `KaizenScout5`
- B = `KaizenScout1`
- C = `KaizenScout2`
- D = `KaizenScout4`
- E = `KaizenScout3`

`ultra: union=120/121 single_candidate_only=36`
