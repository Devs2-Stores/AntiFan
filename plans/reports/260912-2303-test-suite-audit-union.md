# Hợp nhất sửa lỗi audit suite — `ak:test audit --ultra --advice` (12/09/2026)

Tài liệu này ghi lại **lần sửa duy nhất trên hợp nhất đã được verifier xác thực** của đợt audit
suite. Gói bằng chứng đo trước khi sửa: `plans/reports/ultra-test-audit-packet-260912.md`.
Năm ứng viên đọc-only (C1–C5) chạy độc lập trên 5 lát cắt; mọi phát hiện dưới đây đã được đối
chiếu lại với file tại thời điểm sửa (không dùng lại kết luận cũ).

- Repo: `E:/Work/apps/AntiFan`, nhánh `main`, gốc audit `6fcb9f3` (đã push, cây sạch).
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
| 13 | Important | Bất biến "zero remote hotlink" của site-clone không thấy `srcset`/`poster`/CSS `url()` | `packages/site-clone/src/generators/independent-html-clone.test.ts` | Oracle độc lập `remoteResourceUrls()` tách từng candidate trong `srcset`/`imagesrcset`; fixture mang `srcset` remote thật; ca riêng chứng minh oracle bắt đủ 6 ngữ cảnh | 7/7 pass; M1 (nhánh `srcset` trả tag gốc) / M2 (tắt `urlMap`) đỏ |
| 14 | Minor | Test title trùng `CAPTURE_EMPTY_PAYLOAD` ở hai gate PNG/JPEG | `test/unit/visual-capture.test.ts` | Đổi tiêu đề gate JPEG thành `rejects an empty JPEG payload …` | làn `test:fast` xanh |
| 15 | Minor | Chú thích đầu file nói sai: `/api/cookies/import` "đã bị gỡ" (endpoint vẫn tồn tại; chỉ handshake extension bị gỡ) | `test/main/bridge-cookie-import.test.ts` | Chú thích mô tả đúng trạng thái, trỏ sang test endpoint | 1/1 pass |
| 16 | Minor | `.antifan-data/` (data root cục bộ) không được ignore | `.gitignore` | Thêm `.antifan-data/` | `git check-ignore` khớp |
| 17 | Minor | 8 chỗ `await responsePromise` không có hạn — child im lặng ⇒ treo cả làn (`--test-force-exit` chỉ thoát sau khi test kết thúc) | `test/main/omp-mcp-adapter.test.ts` | `withDeadline(promise, label)` cho mọi handshake; giữ `child.kill()` trong `finally` | 13/13 pass |

| 18 | Important | `test/unit/check-plans.test.mjs` khẳng định **hợp đồng cũ**: "accepts a plan without frontmatter" — tức là test tự khoá hành vi khiếm khuyết | `test/unit/check-plans.test.mjs` | Cập nhật theo hợp đồng mới và mở rộng 3 → 6 ca (plan không frontmatter, frontmatter thiếu `status:`, thông báo tiếng người, cây `plans/` của repo phải `no-frontmatter=0`) | 6/6 pass |
| 19 | Important | Ngăn xếp gate `scripts/check-bottlenecks.mjs` (B8) kiểm `scripts["test"] ~ /test:canary/` — runner mới không còn chuỗi đó nên B8 **REOPENED** (gate `npm run audit` đỏ) | `plans/bottlenecks.json` | Predicate B8 chuyển sang bất biến thật: `file-absent-regex` trên `scripts/run-test-pipeline.mjs` với mẫu `test:canary` (canary rơi khỏi runner ⇒ REOPENED); `closedBy` mô tả runner | `npm run audit`: 35 row (CLOSED=23, REFUTED_OK=4, MANUAL=8), `OK — every declared status matches HEAD`, exit 0 |

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

## 4. Tồn đọng (quyết định còn mở, không tự quyết)

1. **CI**: vẫn không có `.github/workflows`. Lý do chưa thêm: các làn `test:main`/`test:e2e` phụ thuộc
   Windows (`windows-acl`, `node-pty` native, Electron) — một workflow Linux chưa kiểm chứng được ở
   đây sẽ tạo gate đỏ giả. Cần quyết định runner (self-hosted Windows) trước khi thêm.
2. **`test/unit/visual-matrix` / template `plans/reports/_*.mjs`**: `_render-base-theme.mjs` trỏ cứng
   `E:/Work/apps/Haravan CLI/package.json`, không có npm script bọc → tài liệu, không phải gate.
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

- `test:main` (lần chạy riêng): 1091 test / 1090 pass / 0 fail / **1 skip có tiền đề**.
- `test:e2e`: 6/6 pass (gồm soak đã sửa).
- `plans:check`: `plans=61 classified=61 no-frontmatter=0 done=31 active=12 pending=11 superseded=6 blocked=1`, exit 0.
- `npm run audit`: 35 row (CLOSED=23, REFUTED_OK=4, MANUAL=8), "OK — every declared status matches HEAD", exit 0.
- Các làn riêng lẻ trong quá trình sửa: renderer gap 10/10, renderer split+link 8/8, capsule 6/6, terminal invariants 5/5, soak 2/2, omp-adapter 13/13, site-clone generator 7/7, plan gate 6/6, mcp client 2/2.
- `npx tsc -p ./` sạch sau mỗi lần sửa TS; `src/renderer/standalone.js` khôi phục nguyên byte (`md5 189c72bfb50ba86c0b8b0e587f588476`, `git diff` rỗng).


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
