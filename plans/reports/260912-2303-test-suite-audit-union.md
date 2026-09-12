# Hợp nhất sửa lỗi audit suite — `ak:test audit --ultra --advice` (12/09/2026)

Tài liệu này ghi lại **lần sửa duy nhất trên hợp nhất đã được verifier xác thực** của đợt audit
suite. Gói bằng chứng đo trước khi sửa: `plans/reports/ultra-test-audit-packet-260912.md`.
Năm ứng viên đọc-only (C1–C5) chạy độc lập trên 5 lát cắt; mọi phát hiện dưới đây đã được đối
chiếu lại với file tại thời điểm sửa (không dùng lại kết luận cũ).

- Repo: worktree của dự án (`<repo>`), nhánh `main`, gốc audit `6fcb9f3` (đã push, cây sạch).
- Không có `.github/` → repo không có CI; gate duy nhất là `npm test` / `npm run verify` chạy tay.
- Nền tảng: Haravan. Không áp giả định Shopify trong bất kỳ mục nào.

## 1. Sửa theo phát hiện

| # | Mức | Phát hiện | Vị trí | Sửa | Bằng chứng |
| --- | --- | --- | --- | --- | --- |
| 1 | Critical | `npm test` dừng ngay sau canary đỏ (`&&`), ~1.957 test phía sau **chưa từng chạy** | `package.json` | `scripts/run-test-pipeline.mjs`: chạy 9 làn, làn nào đỏ thì ghi nhận, `compile` hỏng ⇒ các làn phụ thuộc `skipped`, thoát 1 nếu có bất kỳ làn đỏ | `npm test` chạy hết 9 làn; `npm run verify` thêm `audit` + `plans:check` |
| 2 | Critical | 12 test `test:main` đỏ vì fixture thiếu `expectedTargetUrl` → route settlement trả `URL_EXPECTATION_MISSING`/`INCONCLUSIVE`; kèm `diffPixels` bị bỏ khỏi payload so sánh | `test/main/visual-compare-mask-ledger.test.ts`, `test/main/baseline-authority-integration.test.ts`, `src/main/tools/browser-control-port.ts` | Thêm `ROUTE_URL` + `createRoutePort(host, artifactSink?)` (44/45 chỗ `new BrowserControlPort(` → wrapper; giữ nguyên host không có URL), `getTabUrl` trên host giả; khôi phục `diffPixels` ở tầng production | `test:main` 1092 test / 1091 pass / 0 fail / 1 skip |
| 3 | Critical | `callTool` **nuốt** `isError` và trả chuỗi lỗi như kết quả thành công | `scripts/lib/antifan-mcp-client.mjs` | Ném lỗi khi `res.isError`; thêm `resolveSession()` + seam `mcpScript` | `test/unit/antifan-mcp-client.test.mjs` (2/2) chạy trên double stdio hermetic mới `test/fixtures/mcp/fake-omp-mcp.cjs` (52 tool) |
| 4 | Critical | 3 test replay canary "pass" dù artifact không tồn tại (bỏ qua âm thầm) | `test/unit/build-report-*.test.mjs` | `test/fixtures/canary-run/replay-precondition.mjs`: `assessCanaryReplay()` liệt kê 9 tiền đề thiếu (id + byteLength + sha256); test `t.skip(reason)` có tên, không fail giả | 5 skip / 0 fail; lý do in ra nguồn artifact đã dò |
| 5 | Critical | Test soak e2e khẳng định **literal** thay vì số đo (`passed: true`, `peakRssMB: 145`) | `test/e2e/soak-test.test.ts` | Mọi trường báo cáo suy ra từ `samples` đã đo; `REQUIRED_SAMPLES = 10`, `SOAK_SLOPE_LIMIT_MB_PER_MIN = 5`; assertion tái tính từ mẫu | file: 2/2 pass |
| 6 | Critical | Test "cookie isolation" dựng lại RFC 6265 bằng `Map` nội bộ, không chạm production | `test/main/capsule-partition-cookie-isolation.test.ts` | Stub **biên Electron `session`** trước khi nạp module; chạy thật `configureBrowserSessionPartition`/`clearBrowserSessionPartitionPolicies` | 6/6 pass; đột biến M1/M2 đỏ (xem §2) |
| 7 | Critical | Test "terminal invariants" ghi đè `privates.spawn` — chính hàm cần kiểm | `test/main/terminal-stream-invariants.test.ts` | Chỉ stub biên `node-pty` (`installPtyStub()` ném lỗi nếu identity không đổi); production `spawn`/`appendData`/`getDiagnostics` chạy thật | 5/5 pass; M1–M3 đỏ |
| 8 | Important | Test "gap state machine" mô phỏng lại máy trạng thái bằng biến cục bộ | `test/renderer/terminal-gap-state-machine.test.ts` | Nạp `src/renderer/standalone.js` thật trong `vm` (DOM/xterm/bridge stub) qua harness dùng chung `test/renderer/standalone-harness.ts`; đọc `MAX_RECOVERY_QUEUE_*` từ chính script | 10/10 pass; M1–M3 + M4 (`setActiveTerminalSession`) đỏ |
| 9 | Important | `terminal-split-hardened.test.ts` Round 1/4/6/8 kiểm **chuỗi nguồn** và **số học sao chép** (tautology) | `test/main/terminal-split-hardened.test.ts` → `test/renderer/terminal-split-behaviour.test.ts` | 8 ca hành vi mới chạy `getSplitGeometry`/`applySplitRatio`/`splitButton.onclick`/`customKeyHandler`/`showContextMenu`/`unmountSplit` thật; 4 Round cũ thay bằng con trỏ | 8/8 pass; M1–M5 đỏ |
| 10 | Important | `attachWebLinksAddon` được kiểm bằng regex trên nguồn | `test/main/terminal-process-tree-and-links.test.ts` → renderer suite | Ca hành vi: handler thật `→ api.createTab(uri)`, fallback `openExternal` khi thiếu `createTab` **và** khi promise reject, `uri` rỗng không mở gì | 8/8 pass; M1/M2 đỏ |
| 11 | Important | "Low-spec latency" đo vòng lặp `setImmediate` của Node — không chạm production | `test/main/low-spec-optimization.test.ts:23-33` | Thay bằng hai bất biến thật của `AsyncThemeQaQueue`: supersede abort đồng bộ + job cũ settle muộn **không** xoá generation mới; vòng enqueue nhanh chỉ generation mới hoàn tất (chờ có hạn, bỏ `setTimeout(100)`) | 3/3 pass; M1 (bỏ guard generation) / M2 (bỏ `abort` trong `enqueue`) đỏ |
| 12 | Important | `check-plans.mjs` bỏ qua plan **không có frontmatter** ⇒ 11 plan không bao giờ bị gate | `scripts/check-plans.mjs` | Plan thiếu frontmatter được nêu tên và **thoát 1**; summary vẫn đếm `no-frontmatter` | `plans=61 classified=61 no-frontmatter=0`, exit 0; 11 plan được ghi `status` có bằng chứng |
| 13 | Important | Bất biến "zero remote hotlink" của site-clone không thấy `srcset`/`poster`/CSS `url()` | `packages/site-clone/src/generators/independent-html-clone.test.ts` | Oracle độc lập `remoteResourceUrls()` tách từng candidate trong `srcset`/`imagesrcset`; fixture mang `srcset` remote thật; ca riêng chứng minh oracle bắt đủ 6 ngữ cảnh | 7/7 pass; M1 (nhánh `srcset` trả tag gốc) / M2 (tắt `urlMap`) đỏ; bổ sung khẳng định **chiều dương** — `srcset` đã bản địa hoá phải còn trong bundle kèm `1x`/`2x` và không host remote, nên ca này không thể xanh nhờ attribute bị xoá |
| 14 | Minor | Test title trùng `CAPTURE_EMPTY_PAYLOAD` ở hai gate PNG/JPEG | `test/unit/visual-capture.test.ts` | Đổi tiêu đề gate JPEG thành `rejects an empty JPEG payload …` | làn `test:fast` xanh |
| 15 | Minor | Chú thích đầu file nói sai: `/api/cookies/import` "đã bị gỡ" (endpoint vẫn tồn tại; chỉ handshake extension bị gỡ) | `test/main/bridge-cookie-import.test.ts` | Chú thích mô tả đúng trạng thái, trỏ sang test endpoint | 1/1 pass |
| 16 | Minor | `.antifan-data/` (data root cục bộ) không được ignore | `.gitignore` | Thêm `.antifan-data/` | `git check-ignore` khớp |
| 17 | Minor | 8 chỗ `await responsePromise` không có hạn — child im lặng ⇒ treo cả làn (`--test-force-exit` chỉ thoát sau khi test kết thúc) | `test/main/omp-mcp-adapter.test.ts` | `withDeadline(promise, label)` cho mọi handshake; giữ `child.kill()` trong `finally` | 13/13 pass |

| 18 | Important | `test/unit/check-plans.test.mjs` khẳng định **hợp đồng cũ**: "accepts a plan without frontmatter" — tức là test tự khoá hành vi khiếm khuyết | `test/unit/check-plans.test.mjs` | Cập nhật theo hợp đồng mới và mở rộng 3 → 6 ca (plan không frontmatter, frontmatter thiếu `status:`, thông báo tiếng người, cây `plans/` của repo phải `no-frontmatter=0`) | 6/6 pass |
| 19 | Important | Ngăn xếp gate `scripts/check-bottlenecks.mjs` (B8) kiểm `scripts["test"] ~ /test:canary/` — runner mới không còn chuỗi đó nên B8 **REOPENED** (gate `npm run audit` đỏ) | `plans/bottlenecks.json` | Predicate B8 chuyển sang bất biến thật: `file-absent-regex` trên `scripts/run-test-pipeline.mjs` với mẫu `test:canary` (canary rơi khỏi runner ⇒ REOPENED); `closedBy` mô tả runner | `npm run audit`: 35 row (CLOSED=23, REFUTED_OK=4, MANUAL=8), `OK — every declared status matches HEAD`, exit 0 |
| 20 | Critical | **Lỗi production, phát hiện khi làm test "cắn"**: `TerminalManager.spawn` tạo record với `pty: null` rồi **không gán** handle `node-pty` vừa tạo (không có `s.pty = child` ở bất kỳ đâu trong `src/`) ⇒ `writeTo`/`write` nuốt im lặng mọi phím gõ (`ensureSessionPty` coi record không PTY là "chờ khôi phục" nên spawn lại), `resize`/`resizeTo` chỉ ghi `pendingCols/pendingRows`, teardown không kill được shell, `getDiagnostics.runningPtyCount` luôn 0 | `src/main/browser/terminal-manager.ts` (record tạo tại `createSessionRecord` `pty: null`; vị trí gán nay ở `spawn`) | Gán `s.pty = child;` ngay sau khi tạo record, kèm chú thích lý do | Test mới `INVARIANT 4 (Input Routing)` + `INVARIANT 5 (Geometry Routing)` đỏ trước khi sửa, **quan sát được riêng từng ca**: `pty.writes` = `[]` (input) và `pty.cols` = 120 vs 100 (resize — fake PTY giữ cols lúc spawn, lệnh resize không tới); xanh sau (7/7). Hệ quả "mỗi lần gõ spawn lại shell" là **suy ra** từ `ensureSessionPty` + `writeTo` (đã kiểm bằng đọc source), không phải số đo của lần chạy đỏ |

### 1b. Phát hiện mới trong lúc sửa

| Mức | Phát hiện | Bằng chứng | Xử lý |
| --- | --- | --- | --- |
| Minor | Chạy suite **ghi vào file được track**: `plans/reports/mcp-overhaul-benchmark.json` (timestamp + số đo) và `plans/260905-0012-…/reports/live-theme-proof.json` bị ghi lại sau `npm test`, làm cây làm việc bẩn ngay sau một lần chạy sạch | `git status` sau `npm test`: 2 file `M` dù không ai sửa | Đã `git checkout --` hai file để commit audit không lẫn nhiễu số đo; **chưa** đổi nơi ghi (cần quyết định: chuyển sang đường dẫn bị ignore hay chấp nhận như bằng chứng sống) |
| Minor | Test gate plan (`test:fast`) ban đầu đỏ vì khẳng định hợp đồng cũ — xem hàng 18 | `npm test`: `✖ classifies recognized spellings into buckets and accepts a plan without frontmatter` | Đã cập nhật cùng hợp đồng |


## 2. Đột biến đã chứng minh (đỏ trước, xanh sau, file khôi phục nguyên byte)

| Đối tượng | Đột biến | Kết quả |
| --- | --- | --- |
| `src/main/qa/async-qa-job-queue.ts` | bỏ `current.generation === generation` trong `finally`; bỏ `this.abort(tabId)` trong `enqueue` | RED (2 test) / RED (2 test) |
| `src/main/browser/capsule-*` | bỏ guard `configuredPartitions.has`; nhánh native rơi xuống nhánh clean | RED / RED |
| `src/main/browser/terminal-manager.ts` | `(s.lastSeq\|\|0)+1 → +0`; phát `generation: 0`; `sessionGenerations+1 → +0` | RED ×3 |
| `src/renderer/standalone.js` | bỏ biên `liveQueue`; phá reset khi nhảy generation; degrade khi thiếu delta; gọi `setActiveTerminalSession` khi xử lý chunk | RED ×4 (md5 sau khôi phục `189c72bf…`) |
| `src/renderer/standalone.js` (split/link) | bỏ kẹp `paneMin`; bỏ trần 60px; bỏ debounce nút split; đổi chord `Ctrl+Shift+D`; hoán nhãn context menu; mở mọi link bằng `openExternal`; bỏ fallback khi `createTab` reject | RED ×7 |
| `src/renderer/standalone.js` | — (không còn đột biến sót trên đĩa: `grep -c "if (false)"` = 0, `git diff --stat` rỗng) | khôi phục xanh |
| `src/main/browser/terminal-manager.ts` | bỏ dòng gán `s.pty = child;` | RED ×2 quan sát riêng (`INVARIANT 4`: `pty.writes` = `[]`; `INVARIANT 5`: `pty.cols` = 120 vs 100); khôi phục từ bản sao byte-exact (`md5 8ade45017e54cadd47902b95c5a4cd6b`) → GREEN 7/7 |
| `packages/site-clone/src/models/asset-localizer.ts` | nhánh `srcset` trả tag gốc; vô hiệu `urlMap.get` | RED / RED (md5 sau khôi phục `4add5d65…`) |

## 3. Cân nhắc rồi **giữ nguyên** (có lý do, không phải bỏ sót)

- **Assertion trên asset/wiring tĩnh**: nhãn `<script>` trong `src/renderer/standalone.html`, màu
  `#ffffff` trong `src/renderer/frame-backdrop.css`, cờ `wasSidebarOpenBeforePopout` và các kênh
  IPC trong `native-tab-host.ts`/`standalone-preload.ts`. Node không có engine CSS/Electron
  `WebContentsView` để chạy các artifact này; **chuỗi trong file chính là hợp đồng liên file** cần
  kiểm, cùng loại với `test/main/ipc-audit.test.ts` đã có sẵn trong repo. Phần hành vi chạm được
  (z-order với `mockContentView`, split toggle, hyperlink, gap machine) đã được chuyển sang kiểm
  hành vi.
- **3 `.skip` cũ** (phase-02 chờ Windows runtime, `windows-acl` theo nền tảng, provenance phụ thuộc
  host) đều có lý do kèm chủ sở hữu → giữ.
- **48 file có `catch {}` trần**: đã kiểm 16 chỗ ở `omp-mcp-adapter.test.ts` (nuốt dòng JSON hỏng khi
  ghép `stdout`) và 14 chỗ ở `bridge-server.test.ts` (đóng socket) — không chỗ nào nuốt assertion.
- **Replay canary**: không thể tạo lại artifact vì `scripts/lib/build-report.mjs` kiểm `sha256` +
  `byteLength` do fixture khai báo, còn repo là **PUBLIC** (không được đẩy bytes lớn) → giữ dạng
  skip-có-tiền-đề, kèm (a) runner tổng hợp không để skip che regression, (b) test hợp đồng gate.
  Đây là **bảo vệ không chạy (dormant guard), không phải coverage**: khi artifact được khôi phục,
  test chạy thật và fail thật; skip chỉ nêu tên 9 tiền đề thiếu kèm `sha256`/`byteLength`.

### 3b. Việc đã cân nhắc và **hoãn có ý thức** (ghi để báo cáo không đọc như đã bao trùm)

| Việc | Lý do hoãn | Trạng thái |
| --- | --- | --- |
| `test/main/ipc-audit.test.ts:20-80` đọc `native-tab-host.ts` và khẳng định `content.includes('ipcMain.handle(channel)')` | Cùng lớp với assertion wiring/asset ở §3: kênh IPC là hợp đồng liên file giữa preload và main; không có seam IPC thật nào chạy được ngoài Electron. Giữ + đã ghi vào hạn chế tồn dư | Giữ nguyên, có chú thích phân loại |
| Fixture `theme-mcp-capabilities.test.ts:52` dùng host `shop.myshopify.com/cart.js` | **Không phải rò rỉ giả định nền tảng**: đây là app **đa nền tảng** (`native-tab-host.ts:240` xử lý `.myshopify.com/admin`, `domain-scoper.ts:15` đưa `myshopify.com` vào danh sách scope, `AGENTS.md:27` nêu cả `shopify theme push*`); ràng buộc "Haravan-only" của phiên áp cho *theme deliverable*, không áp cho tầng browser/QA của app. Bản sửa `e4511ce` từng đổi URL này là **không cần thiết** | **Đã hoàn nguyên** về mẫu Shopify gốc; việc đáng làm (hoãn): khẳng định `theme.debug_bundle` tôn trọng nền tảng *được phát hiện* thay vì host literal |
| Suite split-terminal trùng lặp/source-text trong `terminal-switching-regression.test.ts` (~:714) | Phần hành vi đã có suite renderer; phần còn lại là text/constant của asset renderer (không có runtime Node). Xoá cả file sẽ mất assertion `convertEol`/`clear()`/`contentTopOffset` — lớp asset ở §3 | Giữ; tautology số học cục bộ đã xoá, trỏ sang suite renderer |
| `test/unit/visual-matrix` không được làn nào gọi; `_render-base-theme.mjs` trỏ cứng đường dẫn ngoài repo | Đã nêu ở §4.2 | Tài liệu hoá, không gate |



## 4. Tồn đọng (quyết định còn mở, không tự quyết)

1. **CI**: vẫn không có `.github/workflows`. Lý do chưa thêm: các làn `test:main`/`test:e2e` phụ thuộc
   Windows (`windows-acl`, `node-pty` native, Electron) — một workflow Linux chưa kiểm chứng được ở
   đây sẽ tạo gate đỏ giả. Cần quyết định runner (self-hosted Windows) trước khi thêm.
2. **`test/unit/visual-matrix` / template `plans/reports/_*.mjs`**: `_render-base-theme.mjs` trỏ cứng
   `<external>/Haravan CLI/package.json`, không có npm script bọc → tài liệu, không phải gate.
3. **Nhãn Round 5** trong `terminal-split-hardened.test.ts` (khẳng định rule CSS trong asset) giữ
   nguyên theo mục §3; không xoá test để lấy xanh.
4. **Haravan plan `260912-1731`**: ghi `status: pending` (phase-00 READY, 3 phase PLANNED, 5 phase
   BLOCKED_ON_PREDECESSOR; `scripts/run-haravan-verification-loop.mjs` và verdict storefront chưa
   tồn tại). Các commit base-theme/tooling của phiên trước **không** phải phase của plan này.

## 5. Telemetry sau sửa

`npm test` (runner tổng hợp) trên cây đã sửa — **tất cả làn xanh**:

```
compile           passed   5.7s
test:canary       passed   29.9s
test:fast         passed   34.5s
test:site-clone   passed    9.3s
test:integration  passed    6.2s
test:main         passed  186.9s
test:e2e          passed   18.1s
all lanes passed
```

- Các làn riêng lẻ trong quá trình sửa: renderer gap 10/10, renderer split+link 8/8, capsule 6/6, terminal invariants 7/7 (gồm `INVARIANT 4` input + `INVARIANT 5` geometry), terminal switching 18/18, process-tree+links 4/4, theme-mcp 3/3, soak 2/2, omp-adapter 13/13, site-clone generator 7/7, plan gate 6/6, mcp client 2/2.
- `npx tsc -p ./` sạch sau mỗi lần sửa TS; `src/renderer/standalone.js` khôi phục nguyên byte (`md5 189c72bfb50ba86c0b8b0e587f588476`, `git diff` rỗng); `src/main/browser/terminal-manager.ts` sau sửa: `md5 8ade45017e54cadd47902b95c5a4cd6b`.
- Sau khi sửa lỗi PTY: `npm test` chạy lại — **cả 7 làn xanh** (268s), `npm run audit` OK, `plans:check` 61/61.


## 6. Công khai

- **Verifier độc lập**: agent `reviewer` (`UnionVerifier`) đọc lại từng diff của bộ sửa, chạy
  `test/unit/antifan-mcp-client.test.mjs` + `test/unit/check-plans.test.mjs` +
  `build-report-embedded-drift.test.mjs` và `node scripts/run-test-pipeline.mjs audit`; kết luận
  `correct`, 0 phát hiện. Hạn chế: verifier trả kết luận **cấp tóm tắt**, không kèm trích dẫn
  từng hàng — nên bảng §1 vẫn là bằng chứng chính, còn verifier chỉ là lớp soát độc lập bổ sung.
- `kongming` không spawn được trong phiên này (không có trong catalog runtime) → dùng `reviewer`.
- Bề mặt MCP browser của harness bị từ chối trong phiên → các kiểm tra runtime dùng script CDP/vm
  nội bộ repo, không dùng MCP.
- Không có secret nào bị in; không fixture nào chứa credential thật.
