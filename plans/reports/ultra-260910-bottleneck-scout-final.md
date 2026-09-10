# Ultra Scout — Điểm nghẽn còn lại của AntiFan

**Ngày:** 2026-09-10 · **Repo:** `E:/Work/apps/AntiFan` · **HEAD tree:** clean (1,144 tracked files)
**Chế độ:** `ak:scout --ultra` — 5 candidate read-only độc lập + 1 verifier hợp nhất union

> Mọi kết luận dưới đây đã được controller đọc lại code/config tại HEAD sau khi verifier hợp nhất.
> Chỗ nào chỉ suy luận (không chạy được) đều ghi `[INFERENCE]`.

---

## 0. Cách chạy và mức tin cậy

- 5 candidate read-only nhận **cùng một evidence packet** (scale, số đo, 5 vùng mục tiêu T1–T5, luật cấm mutation, rubric).
- 1 verifier chấm 1–20 trên 5 tiêu chí cho từng candidate, rồi trả về **union đã validate** (không chọn winner-duy-nhất, vì một điểm nghẽn thật có thể chỉ xuất hiện ở một candidate).
- Verifier chạy **cùng tier model** với candidate (runtime role-typed agents dùng chung session model) → đây là **same-tier best-of-5** (independent samples + rubric selection), **không phải** asymmetric verification. Rủi ro correlated error/self-preference vẫn còn, nên controller đã tự chạy lại verification tầng thứ hai (mục 1 + mục 4).

---

## 1. Số đo live tại máy này (controller, 2026-09-10)

| Hạng mục | Số đo | Nguồn |
|---|---|---|
| `npm run typecheck` (`tsc -p ./ --noEmit`) | **12.9 s** | chạy thật, exit 0 |
| `npm run compile` (clean + shim + tsc + copy-static + build:extension) | **18.4 s** | chạy thật, exit 0 (OS cache nóng) |
| `npm run test:fast` | **10.4 s** | chạy thật, exit 0 |
| `npm run test:main` (128 file) | **5 m 40 s (340 s)** | chạy thật, exit 0 |
| `npm run verify` = typecheck + clean + compile + 5 suite | **≥ 6 phút**, typecheck chạy 2 lần trên cùng 1 program | suy ra từ 4 dòng trên |
| Working tree (trừ node_modules) | **~4.6 GB** | đo đệ quy |
| `.canary/` | **955 MB** / 20 thư mục `run3*` trùng lặp | đo đệ quy |
| `out/` | **699 MB**, chứa `antigravity-browser-desktop-win32-x64` — tên gói cũ, `scripts/package-windows.mjs:27` giờ đặt tên `AntiFan-Browser-Desktop` | đo + đọc script |
| `appdata/` | **1,885 MB** / 10,305 file | đo đệ quy |
| `plans/` | **486 MB** / 878 file | đo đệ quy |
| PNG rác ở repo root | **57 file = 43 MB** | đo |
| `.antifan/annotations/` | **1,428 file** | đếm |
| Program TypeScript 1 khối | `src/main` 62,121 LOC + `test/**` ~55k LOC + `src/renderer` 10,892 LOC | `tsconfig.json` include |

---

## 2. Union điểm nghẽn (đã validate, xếp theo mức chặn việc)

### B1 — `clean` xoá `.compiled` dưới app đang chạy và dưới mọi gate · **P0 blocking**

- **Bằng chứng:** `package.json:18` = `node -e "fs.rmSync('.compiled',{recursive:true,force:true})"`; `:21` `compile` mở đầu bằng `npm run clean`; `:37` `test` cũng chạy `clean`; 14 script `smoke:*` (`:40-56`) và `package` đều gọi `npm run compile`. `scripts/dev.mjs` chạy Electron trỏ vào `.compiled/src/main/index.js` **đồng thời** chạy `tsc -p ./ --watch` ghi vào chính thư mục đó.
- **Ý nghĩa với dev solo:** Terminal 1 đang `npm run dev`; Terminal 2 chạy `npm test`, `npm run verify`, `npm run certify:*` hay bất kỳ `smoke:*` → `.compiled` bị xoá ngay dưới chân app đang chạy → preload ENOENT / module not found / webview chết. Đây đúng là căn nguyên đã được ghi trong `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md` (hạng mục 6, "ĐÍNH CHÍNH LẠI"). Mọi gate đều là mìn cho phiên dev đang mở.
- **Fix:** bỏ `npm run clean` khỏi `compile` và `test` (tsc ghi đè an toàn); thêm script `rebuild` riêng cho trường hợp cần xoá sạch; bỏ `clean` khỏi 14 `smoke:*` + `certify-core-freeze.cjs:25`.

### B2 — Không có incremental: mỗi vòng lặp dev là một cold build 124k LOC, và `test` nằm chung program với app · **P0 blocking**

- **Bằng chứng:** `tsconfig.json` không có `incremental`/`tsBuildInfoFile`; `include: ["src/**/*.ts","scripts/**/*.ts","test/**/*.ts"]` — toàn bộ test (~55k LOC) nằm trong **cùng một program** với app; `"verify": "npm run typecheck && npm test"` (`package.json:38`) chạy typecheck 2 lần trên cùng tập file; `scripts/dev.mjs` chặn bằng `execSync('npm run compile')` trước khi cài watcher.
- **Ý nghĩa với dev solo:** đo thật: typecheck 12.9 s + compile 18.4 s; `test:main` một mình 340 s. Sửa 1 file test → `tsc -p ./` emit lại toàn bộ app; sửa 1 file `src/main` → typecheck lại cả 128 file test. Mỗi `smoke:*` cõng thêm ~18 s compile trước khi làm bất cứ việc gì.
- **Fix:** thêm `"incremental": true` + `"tsBuildInfoFile"`; tách `tsconfig.test.json` (không emit test trong build app); `verify` chỉ typecheck một lần rồi dùng lại kết quả emit.

### B3 — Mọi sửa `src/main/**` = kill Electron + mất sạch tab/terminal/PTY · **P1 high**

- **Bằng chứng:** `scripts/dev-watcher-helpers.mjs:43` `isHotSwappable` chỉ khớp `^scripts/cdp/([^/]+)\.source\.js$`, mà **`scripts/cdp/` rỗng** (được `dev.mjs:34-36` tạo lúc khởi động); `:231` `isUiHotSwappable` chỉ khớp `src/renderer/*`. Nhánh hot-swap CDP là code chết. Mọi thay đổi khác rơi vào `handleBatch` (`:430`) → `copyStaticFn()` → `relaunchElectronFn()` = `taskkill /T /F` + `setTimeout(800 ms)` + spawn Electron mới.
- **Ý nghĩa với dev solo:** 62k LOC `src/main` (130+ file) — tức gần như toàn bộ logic thật — không hot-swap được. Mỗi lần lưu là mất tab storefront đang mở, session terminal, PTY, attachment agent. Debug một luồng QA theme nhiều bước gần như phải làm lại từ đầu sau mỗi lần sửa.
- **Fix:** xoá nhánh `scripts/cdp` chết; mở rộng soft-reload (`antifan.system.reloadScripts`, đã có ở `bridge-server.ts:2334`) cho module lá `src/main/tools/*`, `src/main/verification/*`; tự khôi phục tab đã persist sau relaunch.

### B4 — Đường capture vẫn là điểm nghẽn chưa đóng của workflow theme QA · **P1 high**

- **Bằng chứng:** `.canary/CORE-BOTTLENECKS.md` ghi F1–F10 với số đo live: bootstrap trả `tabId` không resolve (`TARGET_MISMATCH`), `tabs.list` trả `[]` khi tab tồn tại, tab background 0×0 viewport, `full_page` fail ngay lần đầu và để tab ở trạng thái draining (`TARGET_BUSY_DRAINING`), capture fail làm viewport bị mutate (900 → 5715), reference producer **không scroll** nên 42/49 ảnh lazy còn nguyên placeholder. Hạng mục 7 của `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md` ghi rõ: `backgroundThrottling: true` (`src/main/security/security-policy.ts:137`) là **🔴 CHƯA FIX — căn nguyên gốc P0**, kèm cảnh báo không được flip toàn cục vì cam kết Low-Spec Hardening (`plans/260830-1903`). Kế hoạch đang mở `plans/260910-2008-clone-campaign-evidence-provenance/phase-02-capture-side-blockers.md` **vẫn là stub rỗng** ("Describe what this phase accomplishes", Requirement A/B).
- **Đã đóng (không còn tính là nghẽn):** F8 (`EXECUTION_TIMEOUT` không còn để lại target wedged — fix đã re-verify 8/8), F9 (eval guard 15 s giờ là tham số caller), và hạng mục 8 của bảng 260905 (artifact 0-byte **nay** trả `Error: EMPTY_ARTIFACT` với `isError` — đã kiểm tra `scripts/antifan-omp-mcp.cjs:1129-1145`).
- **Ý nghĩa với dev solo:** toàn bộ giá trị của app (so khớp live vs clone, theme QA Haravan/Sapo/Shopify) chạy qua đường capture này. Khi capture fail/timeout 10–60 s rồi để tab nhiễm độc, agent không có bằng chứng pixel → mọi verdict phía sau là vô nghĩa.
- **Fix:** theo đúng thứ tự "Recommended core work" trong `CORE-BOTTLENECKS.md` — fail-fast `NO_RENDER_SURFACE` khi viewport 0×0; scoped unthrottling (chỉ tab đang giữ agent lease, **không** flip toàn cục); `anti.browser.set_viewport` vào namespace chuẩn; capture fail phải restore viewport + drain; reference capture phải có materialization (scroll pass + receipt).

### B5 — `ArtifactStore` quét filesystem đồng bộ ngay trong constructor, và retention cleaner chưa bao giờ được bật · **P1 high**

- **Bằng chứng:** `src/main/tools/artifact-store.ts:70` constructor gọi `this.rehydrateIndex()`; `:97-133` `readdirSync` từng `run-*`, `statSync` từng `.artifact`, `readFileSync` + `JSON.parse` từng `index.json` — tất cả trên main thread. `:71` bật sweeper khi `options.enableRetentionCleaner`; grep toàn repo: `enableRetentionCleaner` chỉ xuất hiện tại `artifact-store.ts:48` và `:71` — **không caller nào truyền `true`**, `resolveArtifactStoreOptionsFromEnv` (`src/main/control-plane/control-plane-runtime.ts:61-75`) chỉ parse `maxArtifactBytes`/`maxRunBytes`.
- **Ý nghĩa với dev solo:** thời gian khởi động app tỉ lệ thuận với số run đã tích luỹ và **không bao giờ được dọn** → app chậm dần theo tuần, không có cơ chế tự phục hồi. `[INFERENCE]` cho phần "chậm bao nhiêu giây" vì không đo được nếu không chạy app.
- **Fix:** truyền `enableRetentionCleaner: true` mặc định trong `resolveArtifactStoreOptionsFromEnv`; làm `rehydrateIndex()` lazy (nạp theo run khi được truy cập) hoặc chuyển ra khỏi đường khởi động main thread.

### B6 — `test:main` 340 s + test khoá cứng vào text nguồn · **P1 high**

- **Bằng chứng:** đo thật 5 m 40 s cho 128 file, chạy tuần tự, `package.json` không có script chạy 1 file. 25 file `test/main/*.test.ts` dùng `fs.readFileSync`; 6 file đọc trực tiếp `src/main/browser/native-tab-host.ts` (6,749 LOC) / `browser-control-port.ts` (6,033 LOC) và assert chuỗi/regex trên text. Ví dụ `test/main/ipc-audit.test.ts:10-12,52,66,81,102-117` (`content.includes('ipcMain.handle(...)')`, assert symbol cũ không được quay lại).
- **Ý nghĩa với dev solo:** bất kỳ lần dọn dẹp/đổi tên/tách module nào trong 2 file lớn nhất repo đều làm fail một loạt test không liên quan, sau 5–6 phút chờ; và không có cách chạy nhanh đúng 1 test. Đây là lực cản trực tiếp lên chính hai file cần refactor nhất.
- **Fix:** thêm `"test:file": "node --test --test-force-exit"`; chuyển các assert text sang assert hành vi qua bề mặt IPC/capability công khai.

### B7 — Test P0 bị bỏ quên khỏi mọi gate · **P1 high**

- **Bằng chứng (đã kiểm lại):**
  - `test/renderer/terminal-gap-state-machine.test.ts` tồn tại; **không** script npm nào tham chiếu (`grep` trên `package.json` + `scripts/` = 0 hit). `test:fast` chỉ glob `.compiled/test/*.test.js`, `.compiled/test/unit/**`, `.compiled/test/benchmark/**`.
  - 3 file test nằm trong `src/main/**` (`src/main/browser/network-policy.test.ts`, `src/main/browser/zero-network-interceptor.test.ts`, `src/main/tools/browser-control-port-zero-network.test.ts`) compile ra `.compiled/src/**` nhưng không glob nào phủ `.compiled/src/**/*.test.js`.
  - `test:e2e` chỉ glob `".compiled/test/e2e/**/*.test.js"`, trong khi `test/e2e/` có 6 file `.cjs`. 4 trong số đó (`terminal-recovery-smoke`, `terminal-renderer-smoke`, `terminal-split-hydration-probe`, `terminal-transport-sync`) chạy được qua `smoke:terminal`/`test:terminal-transport` (tay, ngoài gate). `test/e2e/terminal-rename-space.test.cjs` và `test/e2e/toolbar-qa-hub-empirical-probe.cjs` **không được tham chiếu ở đâu cả** (0 hit).
- **Ý nghĩa với dev solo:** `npm test`/`npm run verify` là thứ duy nhất bạn tin để nói "xong". Hiện nó bỏ qua regression terminal chunk-loss, 3 invariant zero-network, và 2 harness e2e — tức bạn đang có green giả.
- **Fix:** chuyển 3 test trong `src/main` về `test/main/`; thêm glob `.compiled/src/**/*.test.js` và `.compiled/test/renderer/**`; thêm script chạy `.cjs` e2e hoặc đưa chúng vào gate.

### B8 — `computePixelDiff` chạy vòng lặp pixel thuần JS trên main process · **P2 medium**

- **Bằng chứng:** `src/main/tools/browser-control-port.ts:5855-5870` — `isMasked(x,y)` quét tuyến tính toàn bộ `maskBoxes` **cho từng pixel**; mỗi pixel tính `Math.sqrt(r²+g²+b²)/441.67`; nhánh 8-neighbor cộng thêm tới 16 lần `Math.sqrt`. Với trang 1440×5715 (page-12 Hoplong) = 8.2M pixel. Phía client phải nâng timeout `anti.visual.compare` lên 240,000 ms (`scripts/antifan-omp-mcp.cjs`).
- **Ý nghĩa với dev solo:** so khớp ảnh là thao tác lõi của QA theme; nó khoá main thread → UI đứng, agent timeout, và mọi capture chạy song song bị kéo theo.
- **Fix:** tiền tính bitmask/interval map cho `maskBoxes`; so sánh bình phương khoảng cách (bỏ `Math.sqrt` khỏi hot path); chuyển diff sang worker thread.

### B9 — Một capability được khai ở 3 registry, đồng bộ tay · **P2 medium**

- **Bằng chứng:** `src/main/tools/browser-capabilities.ts` (~3.5k LOC, ~150 registration, ~72 alias, ví dụ `anti.browser.tabs.create → browser.open-tab`); `src/main/mcp/mcp-server.ts:769-810` sinh lớp alias động thứ hai; `scripts/antifan-omp-mcp.cjs:10-61` khai tay 52 tool + `CAPABILITY_MAP` (~42 entry, `:258-305`) và timeout riêng (`:306-316`). Tên lệch nhau: namespace chuẩn `anti.*` thiếu `set_viewport`, chỉ có alias legacy `antifan_set_viewport`.
- **Ý nghĩa với dev solo:** thêm/sửa 1 capability phải sửa 3 nơi bằng 2 ngôn ngữ; quên 1 nơi → tool "biến mất" tuỳ đường gọi (MCP / terminal / IPC) và bạn debug sai chỗ.
- **Fix:** sinh định nghĩa MCP + `CAPABILITY_MAP` từ metadata `CapabilityCatalogue` lúc build; giữ 1 namespace chuẩn + bảng alias mỏng.

### B10 — Dev port 20130 vs MCP mặc định 20129 · **P2 medium**

- **Bằng chứng:** `src/main/bridge/bridge-server.ts:245` `this.port = isDev && port === 20129 ? 20130 : port`; proxy `scripts/antifan-omp-mcp.cjs:80,168` đọc `ANTIFAN_MCP_PORT || '20129'`. Discovery từ đĩa **là chủ đích bị chặn** (`resolveBridgeCandidates` chỉ nhận `ANTIFAN_MCP_BOOTSTRAP` / `ANTIFAN_ATTACHMENT_SECRET`; comment nguồn nói rõ ambient discovery là "fail-open vector dual-plane eliminates"). Launcher `scripts/antifan-agent.cjs:87` thì **có** đọc `bridge-dev.json` (`dev-watcher-helpers.mjs:89` cũng vậy).
- **Ý nghĩa với dev solo:** chạy `npm run dev` rồi gọi MCP proxy tay (không set port qua env) → connect sai cổng, tool list rỗng, không log nào nói "dev đang ở 20130".
- **Fix (giữ nguyên fail-closed):** để *launcher* đọc `bridge-dev.json` và bơm `ANTIFAN_MCP_BOOTSTRAP` với port thật cho proxy; **không** thêm disk-discovery vào proxy.

### B11 — `main.cjs` chỉ kiểm tra tồn tại, không kiểm tra mtime → chạy code cũ im lặng · **P2 medium**

- **Bằng chứng:** `main.cjs:12` `if (!fs.existsSync(compiledMain))` — chỉ compile khi **thiếu** file. `run-antifan.vbs` chạy thẳng electron, bỏ qua `scripts/dev.mjs`.
- **Ý nghĩa với dev solo:** sửa `src/**` rồi mở app bằng shortcut → app boot tức thì bằng bundle **cũ**, không cảnh báo; bạn debug tính năng "không ăn" trong khi code chưa hề được build.
- **Fix:** so `mtimeMs` của `.compiled/src/main/index.js` với file mới nhất trong `src/**`; nếu stale → cảnh báo rõ hoặc rebuild.

### B12 — `kill-all.mjs` giết **mọi** electron.exe trên máy · **P2 medium**

- **Bằng chứng:** `scripts/kill-all.mjs` = `execSync('taskkill /F /IM electron.exe')` không lọc theo AntiFan, và không xoá `node_modules/.cache/antifan-dev.pid`.
- **Đính chính so với verifier:** phần "dev lock orphanage cần can thiệp tay" **không đúng** — `acquireDevLock` (`scripts/dev-watcher-helpers.mjs:520-535`) tự takeover lock có pid đã chết (đúng tình trạng file lock hiện tại trên đĩa: pid 40304 không còn sống). Vấn đề thật chỉ còn ở `kill-all.mjs`.
- **Ý nghĩa với dev solo:** một lệnh "dọn dẹp" giết luôn Electron của app khác đang mở (VS Code, app khác) mà không dọn lock.
- **Fix:** scope theo PID/tree của AntiFan và xoá luôn `antifan-dev.pid`.

### B13 — Rác workspace tích luỹ không có cơ chế dọn · **P3 low-medium**

- **Bằng chứng:** `.canary/` **955 MB** với **20** thư mục `run3*` (run3 + attempt1..8 + stale + inconclusive…, mỗi thư mục chứa lại `reference.html`/evidence giống nhau); `out/` **699 MB** còn nguyên gói tên cũ `antigravity-browser-desktop-win32-x64`; `plans/` **486 MB**; `appdata/` **1,885 MB / 10,305 file** (đã có data root chuẩn `E:/Work/.antifan-data`); **57 PNG = 43 MB** + 14 `.md` báo cáo nằm rải ở repo root; `.antifan/` 1,572 file trong đó `.antifan/annotations/` **1,428 file**. Cleaner duy nhất (`src/main/tools/artifact-retention-cleaner.ts:47`) chỉ quét file `.artifact` — **không** đụng `.md`/`.png` của `.antifan/`.
- **Ý nghĩa với dev solo:** git status/IDE index/search/Defender realtime scan chậm trên SSD laptop; `git status` vẫn sạch vì đã ignore, nhưng chi phí I/O là thật.
- **Fix:** mở rộng retention cleaner sang `.antifan/annotations|snapshots` theo `maxAgeMs`; xoá `out/` stale + các `run3-attempt*` trùng; gom report/PNG root vào `plans/reports/`.

---

## 3. Tổng hợp ưu tiên (solo local dev)

| # | Điểm nghẽn | Mức | Chi phí ước tính |
|---|---|---|---|
| B1 | `clean` xoá `.compiled` dưới app đang chạy | P0 | 1 dòng `package.json` ×3 + 15 script |
| B2 | Không incremental / test chung program | P0 | 2 dòng `tsconfig` + 1 tsconfig phụ |
| B3 | Sửa `src/main` = kill + mất session | P1 | xoá nhánh chết + mở soft-reload |
| B4 | Capture path (throttling, viewport, materialize) | P1 | theo `CORE-BOTTLENECKS.md` |
| B5 | `ArtifactStore` sync scan + retention chưa bật | P1 | 1 dòng truyền option + lazy index |
| B6 | `test:main` 340 s + test khoá text nguồn | P1 | script `test:file` + bỏ assert text |
| B7 | Test P0 bị bỏ khỏi gate | P1 | glob + di chuyển file |
| B8 | `computePixelDiff` trên main thread | P2 | bitmask + bỏ sqrt |
| B9 | Capability 3 registry | P2 | sinh tự động lúc build |
| B10 | Dev port 20130 vs MCP 20129 | P2 | bơm bootstrap từ launcher |
| B11 | `main.cjs` existence-only | P2 | check mtime |
| B12 | `kill-all.mjs` giết toàn cục | P2 | scope theo PID |
| B13 | Rác 4.6 GB + 1,428 annotation | P3 | mở rộng cleaner |

---

## 4. Finding bị loại / đính chính (controller tự verify)

1. **"Không có thư mục `.antigravity/`"** — SAI. `.antigravity/` tồn tại (chứa `annotations/`, `harness/`, `mcp-bridge/`, `snapshots/`, `session.json`, `latest_element_mcp.json`). Loại.
2. **"57 PNG root"** vs candidate báo 25/56/62 — con số đúng là **57**; candidate báo 25 và 62 bị loại.
3. **"`native-tab-host.ts` 6,757 LOC"** — SAI, đúng **6,749**.
4. **"God module (6.7k/6.0k LOC) tự nó là bottleneck"** — loại khỏi union: kích thước file là smell kiến trúc, không phải điểm chặn vận hành. Hệ quả thật của nó (B3 không hot-swap được, B6 test khoá text, B8 hot loop) mới là bottleneck.
5. **"Dev lock orphanage cần `taskkill` tay"** — SAI một phần: stale lock **tự động** được takeover (`dev-watcher-helpers.mjs:520-535`). Chỉ giữ phần `kill-all.mjs` (B12).
6. **"Port 20129/20130 là bug discovery hỏng"** — đính chính khung: chặn disk-discovery là **chủ đích fail-closed**, không phải lỗi. Chỉ giữ phần launcher bơm sai/thiếu port (B10) và fix phải giữ nguyên fail-closed.
7. **Artifact 0-byte trả `{"data":"","isError":false}` (bảng 260905 hạng mục 8)** — **đã fix tại HEAD**: `scripts/antifan-omp-mcp.cjs:1129-1145` trả `Error: EMPTY_ARTIFACT`. Không tính là nghẽn.
8. **Hạng mục 9/10/11 của bảng 260905 (lease bypass trong `theme.qa_validate`, `dispatchTrusted`, `switchTab`)** — bảng ghi "CHƯA FIX" ngày 05-09, nhưng code đã đổi nhiều (D1–D5 ở `7d0850b`, F8/F9 sau đó). Controller **không** xác nhận được trạng thái tại HEAD → không đưa vào union, xem mục 5.
9. **Số byte của `.canary`/`out`/`plans`/`appdata`** — verifier không đo lại được (ràng buộc read-only); controller đo trực tiếp bằng script → các số ở mục 1 là số thật.

---

## 5. Câu hỏi chưa giải quyết

1. `tsc --watch` phản ứng thế nào khi `.compiled` bị xoá bởi tiến trình khác trên Windows (tự hồi phục ở lần đổi file kế tiếp hay cần restart watcher)? Chưa exercise.
2. Hạng mục 9/10/11 (lease bypass) có còn đúng tại HEAD không? Bảng nguồn đã cũ.
3. Thời gian khởi động app thực tế tăng bao nhiêu giây theo số run tích luỹ trong artifact store? Cần chạy app để đo.
4. `appdata/` (1.9 GB) hiện còn đường code nào ghi/đọc không, hay đã bị thay hoàn toàn bởi `E:/Work/.antifan-data`?
5. `test/e2e/*.cjs` (4 harness) là "chạy tay có chủ đích" hay "quên đưa vào gate"? Cần quyết định chính sách.
