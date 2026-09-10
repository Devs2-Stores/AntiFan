# Ultra Scout — Điểm nghẽn còn lại của AntiFan

**Ngày:** 2026-09-10 · **Repo:** `E:/Work/apps/AntiFan`
**Trạng thái tree lúc chạy:** `git status --porcelain` có 1 mục untracked (`plans/260910-2008-clone-campaign-evidence-provenance/`) và chính lượt scout này thêm `plans/reports/ultra-260910-*` → **tree không sạch**.
**Chế độ:** `ak:scout --ultra` — 5 pass read-only độc lập + 2 lượt verifier (lượt 2 chạy mù).
**Trạng thái hiệu chỉnh (2026-09-10, sau kill-test tại chỗ):** đây là **snapshot scout**, đã được sửa ở 4 chỗ so với bản đầu — A1 (mệnh đề "bất khả thi" **bị bác**; phân biệt `0` đã persist với `18` chỉ plan-reported), B2 (**hạ P0 → P1**), B6 (**hạ P1 → P3**), A5 (đã gỡ vì throttling đóng tại HEAD, xem mục 5 #13). **Thẩm quyền cho quyết định "làm gì tiếp theo" là bản chốt cuối phiên**, không phải file này.

> Mọi kết luận đã được controller đọc lại code/config tại HEAD. Chỗ chỉ suy luận ghi `[INFERENCE]`.

---

## 0. Phương pháp và mức tin cậy

- 5 pass read-only nhận **cùng một evidence packet**; 1 verifier chấm 1–20 trên 5 tiêu chí rồi trả về **union đã validate** (không chọn winner-duy-nhất).
- **Lượt 1 KHÔNG mù:** prompt dispatch và header bắt buộc đều ghi "Candidate <n>", nên từng pass tự khai danh tính và verifier tự de-anonymize (bảng điểm của nó ghi `Candidate E (Candidate 5)`). Xếp hạng lượt 1 chỉ là bằng chứng yếu.
- **Lượt 2 MÙ:** đã strip toàn bộ token `candidate <n>`/`pass <n>`, gán lại mapping ngẫu nhiên mới, chạy lại verifier. Kết quả: **hạng nhất, nhì và bét trùng khớp cả hai lượt** (pass 5, 1, 2); chỉ hai pass giữa đổi chỗ liền kề. Xếp hạng không phải sản phẩm của nhãn bị lộ — nhưng vẫn là **same-tier** (verifier chạy cùng tier model với pass), nên **union finding mới là deliverable**, không phải thứ hạng.
- Hai lượt verdict đầy đủ: `plans/reports/ultra-260910-bottleneck-candidates/verifier-verdict.md`. 5 báo cáo gốc + evidence packet + packet mù nằm cùng thư mục.

---

## 1. Số đo live (controller, chạy thật trên máy i5-9300H)

| Hạng mục | Số đo | Nguồn |
|---|---|---|
| `npm run typecheck` | **12.9 s** (exit 0) | chạy thật |
| `npm run compile` | **18.4 s** (exit 0, OS cache nóng) | chạy thật |
| `npm run test:fast` | **10.4 s** (exit 0) | chạy thật |
| `npm run test:main` (128 file) | **5 m 40 s / 340 s** (exit 0) | chạy thật |
| `npm run verify` | **≥ 6 phút**, và typecheck chạy **2 lần** trên cùng 1 program | suy ra |
| Working tree (trừ node_modules) | **~4.6 GB** | đo đệ quy |
| `.canary/` | **955 MB**, 20 thư mục `run3*` trùng lặp | đo |
| `out/` | **699 MB**, gói tên cũ `antigravity-browser-desktop-win32-x64` (`package-windows.mjs:27` giờ đặt `AntiFan-Browser-Desktop`) | đo + đọc |
| `appdata/` | **1,885 MB** / 10,305 file / **7** profile tree | đo |
| `plans/` | **486 MB** / 878 file | đo |
| PNG rác repo root | **57 file = 43 MB** (14 `.md` báo cáo rải root; 81 file lỏng) | đo |
| `.antifan/annotations/` | **1,428 file** (không cleaner nào quét) | đếm |
| `E:/Work/.antifan-data/control-plane-v2/artifacts/` | **176** thư mục run (KHÔNG phải 1,226 như một pass khai) | đếm |
| `.canary/15-pages/_verdicts.json` | **KHÔNG tồn tại** (yêu cầu phase-01 của plan đang mở) | kiểm tra |

---

## 2. Nhóm A — Điểm nghẽn của chính quy trình QA theme (ưu tiên cao nhất)

Đây là việc bạn làm hằng ngày; hiện nó **không đo được**, nên đứng trên mọi vấn đề tốc độ build.

### A1 · P0 — Settle gate fail gián đoạn và không kèm chẩn đoán ⇒ campaign ra 0/45 render case

- **Bằng chứng:** `plans/260910-2008-clone-campaign-evidence-provenance/plan.md` (mục "Why This Plan Exists", facts 1–4 & 14): một run có biên (`--pages 2`) báo `RENDER CASES RUN 0 / 45`, `FINAL DECISION: CLONE_PIPELINE_BLOCKED`, page abort ở bước pre-dump settle. Tái hiện trực tiếp: `mediaFrozen: true, fontsSettled: true, imagesSettled: true, visualStable: true, domSettled: false, structuralMutations: 18` trong khi geometry signature ổn định và metrics giống byte-for-byte qua 4 lượt. Predicate `SETTLE_DOM_EXPR` là proxy **đếm node `childList`**: đòi một cửa sổ liên tục 1500 ms không thêm/bớt node trong ngân sách 9 s (`.canary/tools/canary-settle.mjs:57-69`, AND tổ hợp `:241`, throw `:253`) → bất kỳ widget re-parent node mỗi ~1 s là bất khả thi vĩnh viễn. Khi fail, diagnostics per-flag bị vứt (`stages: {}` ở `page-12-gioi-thieu/evidence/1440.json`). Fact 14: hai predicate settle bất đồng về `fontsSettled` (`canary-settle.mjs:184` vs `:241`) nên lỗi font báo `settled: true, timedOut: false` trong khi gate throw lại đổ lỗi cho composite.
- **Đính chính sau kill-test (2026-09-10):** `page-02-brands/evidence/1440.json` persist `structuralMutations: 0` kèm `settlementDuration: 2882` và per-pass `durationMs: 1617/1636` ⇒ gate **đã từng pass trên chính target này** ⇒ mệnh đề "live storefront không thể satisfy DOM quiet" **bị bác**. Con số `18` chỉ tồn tại ở `plan.md:26`; `grep -rn "structuralMutations.*18"` trên `.canary/state/*` và `.canary/15-pages/*/evidence/*.json` **rỗng** ⇒ **không** phải delta, **không** phải regression, chỉ là **plan-reported chưa tái lập**. Việc còn thiếu là chữ ký mutation để phán churn là cosmetic hay content-changing.
- **Vì sao chặn việc:** toàn bộ giá trị của app là verdict fidelity live-vs-clone; hiện pipeline chết trước khi render case đầu tiên, và khi chết thì **không cho biết predicate nào fail** → bạn debug mù.
- **Fix:** thay proxy `childList` bằng đo trực tiếp cùng invariant (state được so phải ổn định qua 2 lượt liên tiếp — ràng buộc "không nới lỏng" đã ghi trong plan Constraints); persist flags per-stage vào evidence; thống nhất hai predicate về cùng định nghĩa `settled`.

### A2 · P0 — Verdict không gắn bundle/instance ⇒ mọi con số đều không adjudicable

- **Bằng chứng:** plan.md fact 5: không verdict nào nêu bundle nó đo; bundle được rebuild lúc 08:24Z (page 01–11) và 09:26Z (12–15) trong khi evidence ghi 04:57Z–08:22Z; `runId`, `evidenceRunId`, `cloneDir` = `null` trong mọi viewport document (`canary-run.mjs` export env nhưng `fifteen-pages-run.mjs` không). Kiểm tra tại HEAD: `.canary/15-pages/_verdicts.json` **không tồn tại** — đúng yêu cầu phase-01 chưa làm. Fact 13: 10 tab mồ côi từ session chết vẫn nằm trong instance, `browser.list-tabs` → 0 còn `anti.browser.tabs.list` → 10, không session nào đóng được (`TARGET_MISMATCH`).
- **Vì sao chặn việc:** bạn không thể tin bất kỳ FAIL/INCONCLUSIVE nào đang lưu, và không thể tái lập. Fact 12 cho thấy chỉ 5 trang FAIL thật ở 1440 (`STRUCTURAL_PARITY_MISMATCH deltaGeometry=15px`) — nhưng ghi trên bundle đã bị thay.
- **Fix:** bundle identity (entryPath/entrySha256/entryBytes/generatedAt/sourceUrl) vào `evidence/<vp>.json`, `run-<vp>.json`, `summary.json`; refuse bằng `BUNDLE_IDENTITY_MISMATCH` khi lệch; export provenance env cho mọi child của campaign runner; pin instance (`ANTIFAN_BRIDGE_PID`).

### A3 · P1 — Tin cậy & hygiene của chính bộ đo

- **Bằng chứng (plan.md facts 6, 7, 10, 11):** runner **exit 0** trên page không sản xuất gì, và aggregate chỉ là batch cuối: report gốc ghi `PAGES EXECUTED 4 / 15`, `11 pages UNTESTED` trong khi evidence trên đĩa vẫn có cho các page đó. Tầng 390 **không có bundle producer** trong campaign (`canary-run.mjs:359` build `clone/mobile/index.html` cho run3; campaign không dump reference mobile, không build bundle mobile; một case 390 lưu clone `660x1429` trong khi reference `390x844`). Một **session attachment cũ** có thể refuse tab create đầu tiên (`POLICY_DENIED … session tab quota reached`, producer `browser-control-port.ts:2076`). Cause đã lưu của INCONCLUSIVE chiếm ưu thế không thể sinh bởi comparator hiện tại (`visual-capture.ts:1094-1166`) → reason trong file là từ revision cũ.
- **Fix:** exit status chỉ phản ánh runner success, không phải page verdict; aggregate cộng dồn toàn campaign; bổ sung mobile reference+bundle cho tầng 390 hoặc tuyên bố tầng đó là unsupported có type; restart+mint session khi gặp `POLICY_DENIED`.

### A4 · P1 — Trần CDP 16384 px: page-13/15 không thể capture (refusal có type, không phải bug)

- **Bằng chứng:** plan.md fact 8 — `CAPTURE_MAX_DIMENSION = 16384` (`src/main/verification/visual-capture.ts:700`), refusal ở `src/main/browser/tab-devtools-host.ts:1515-1519`; page-13 @1024 đo `1200x30492`, page-15 `1200x32226`. Fact 9: không có cờ **launch** offscreen/no-activate cho cửa sổ; `showMainWindow()` vô điều kiện (`src/main/index.ts:256`) — tab agent offscreen là cơ chế riêng, xem mục 5 #13 — nên "câu chuyện compositor" không áp dụng: drain ở 1440 là document mass.
- **Fix:** chấp nhận là platform refusal có type (đã đúng hướng), đừng trộn nó vào tỉ lệ PASS/FAIL; nếu cần đo page siêu cao → cắt theo segment có khai báo, không crop ngầm.

> **A5 cũ (background tab throttling) đã bị gỡ khỏi danh sách mở** — HEAD đã có scoped unthrottling; xem mục 5 #13.

---

## 3. Nhóm B — Điểm nghẽn vòng lặp dev

### B1 · P0 — `clean` xoá `.compiled` dưới app đang chạy và dưới mọi gate

`package.json:18` `fs.rmSync('.compiled')` ← gọi từ `compile:21`, `test:37`, 14 script `smoke:*` (`:40-56`), `package`, và 7 call site trong code (`main.cjs:25`, `run-electron.cjs:24`, `dev.mjs:129`, `install-windows-shortcut.mjs:38`, `certify-core-freeze.cjs:25`, `benchmark-electron-performance.mjs:506,508`). `dev.mjs` chạy Electron từ `.compiled` **đồng thời** `tsc --watch` ghi vào đó. → Terminal 2 gõ `npm test` khi Terminal 1 đang dev = app chết (preload ENOENT; xác nhận căn nguyên ở `brainstorm-260905…md:33`).
**Fix:** bỏ `clean` khỏi `compile`/`test` và khỏi 14 `smoke:*`; để `clean` là lệnh tay; `rebuild` riêng khi cần.

### B2 · P1 — Không incremental, và test nằm chung program với app (**hạ P0 → P1: 18.4 s đo với OS cache nóng; chưa đo cold**)

`tsconfig.json` không có `incremental`/`tsBuildInfoFile`; `include` gồm `src/**` + `scripts/**` + `test/**` (~124k LOC, 647 file) trong **một** program; `verify:38` = typecheck + `test` (typecheck lại lần 2). Đo thật: 12.9 s + 18.4 s; `test:main` 340 s.
**Fix:** `incremental: true` + `tsBuildInfoFile`; tách `tsconfig.test.json`; smoke script dùng lại `.compiled` thay vì compile lại.

### B3 · P1 — Mọi sửa `src/main/**` = kill Electron + mất sạch tab/terminal/PTY

`dev-watcher-helpers.mjs:43` chỉ khớp `^scripts/cdp/([^/]+)\.source\.js$` mà **`scripts/cdp/` rỗng** (chỉ được `dev.mjs:34-36` tạo rỗng) ⇒ nhánh hot-swap là code chết; `:231` chỉ nhận `src/renderer/*`. Mọi thay đổi khác rơi vào `taskkill /T /F` + 800 ms + respawn (`dev.mjs:102-120`), debounce 1200 ms.
**Fix:** xoá nhánh chết; giảm debounce. **Việc mở rộng soft-reload (`antifan.system.reloadScripts`, `bridge-server.ts:2334`) sang module lá `src/main/tools/*` PHẢI coi là spike, không phải fix chắc chắn** — cả hai lượt verifier đều xếp mức an toàn singleton/`webContents` của nó vào phần chưa giải quyết.

### B4 · P1 — `test:main` 340 s + test khoá cứng vào text nguồn

Đo thật **5 m 40 s** cho 128 file, không có script chạy 1 file. **25** file `test/main` dùng `readFileSync`; 6 file đọc trực tiếp `native-tab-host.ts` (6,749 LOC) / `browser-control-port.ts` (6,033 LOC) và assert chuỗi/regex — vd `test/main/ipc-audit.test.ts:10-12,52,66,81,102-117`.
**Fix:** thêm `"test:file": "node --test --test-force-exit"`; chuyển assert text sang assert hành vi qua IPC/capability công khai.

### B5 · P1 — Test P0 bị bỏ khỏi **gate mặc định** (không phải "không chạy được")

- `test/renderer/terminal-gap-state-machine.test.ts`: **0 tham chiếu** trong `package.json` + `scripts/` → thực sự mồ côi.
- 3 test trong `src/main/**` (`browser/network-policy.test.ts`, `browser/zero-network-interceptor.test.ts`, `tools/browser-control-port-zero-network.test.ts`) compile ra `.compiled/src/**`, không glob nào phủ.
- `test:e2e` chỉ glob `*.test.js` nên bỏ qua 6 file `.cjs`. **Trong đó 4 file chạy tay được qua script có sẵn**: `smoke:terminal` → `terminal-recovery-smoke`, `terminal-renderer-smoke`, `terminal-split-hydration-probe`; `test:terminal-transport` → `terminal-transport-sync`. Chỉ `terminal-rename-space.test.cjs` và `toolbar-qa-hub-empirical-probe.cjs` là **không được tham chiếu ở đâu cả**.
**Fix:** chuyển 3 test trong `src/main` về `test/main/`; thêm glob `.compiled/src/**/*.test.js` + `test/renderer/**`; quyết định chính sách cho 4 harness `.cjs` (đưa vào gate hay tuyên bố chạy tay), và xử lý 2 file mồ côi thật.

### B6 · P3 — `ArtifactStore` quét filesystem đồng bộ lúc khởi động; retention cleaner chưa bao giờ bật (**hạ P1 → P3: 176 run dir, 174 `index.json` = 1.22 MB JSON, 1,460 `statSync` — khối lượng nhỏ và tĩnh, nhưng **chưa đo ms khởi động** nên KHÔNG khẳng định ngưỡng thời gian; residual thật là tăng trưởng không dọn**)

`artifact-store.ts:70` constructor gọi `rehydrateIndex()`; `:97-133` `readdirSync` từng run + `statSync` từng `.artifact` + `readFileSync`/`JSON.parse` từng `index.json` trên main thread. `:48,71` `enableRetentionCleaner` — grep toàn repo chỉ có 2 hit, **không caller nào truyền `true`** (`resolveArtifactStoreOptionsFromEnv`, `control-plane-runtime.ts:61-75`, chỉ parse `maxArtifactBytes`/`maxRunBytes`). Hiện có **176** thư mục run trong `E:/Work/.antifan-data/control-plane-v2/artifacts/` → chi phí khởi động tăng đơn điệu và không bao giờ được dọn. `[INFERENCE]` cho số giây cụ thể.
**Fix:** lazy `rehydrateIndex()`; truyền `enableRetentionCleaner: true` mặc định; parse index off main path.

---

## 4. Nhóm C — Trung bình / thấp

| # | Điểm nghẽn | Mức | Bằng chứng | Fix |
|---|---|---|---|---|
| C1 | `computePixelDiff` chạy vòng lặp pixel thuần JS trên main thread: `isMasked` quét tuyến tính `maskBoxes` **từng pixel**, `Math.sqrt` mỗi pixel + pass 8-neighbor; 1440×5715 = 8.2M pixel | P2 | `browser-control-port.ts:5855-5870` (+8-neighbor tới ~:5965) | bitmask 1 chiều thay `isMasked`; so bình phương khoảng cách; worker thread |
| C2 | Capability khai ở 3 registry đồng bộ tay: `browser-capabilities.ts` (~150 registration, ~72 alias), `mcp-server.ts:769-810`, `antifan-omp-mcp.cjs:10-61` + `CAPABILITY_MAP` + timeout tới 240 s | P2 | đọc trực tiếp 3 file | sinh từ `CapabilityCatalogue` lúc build; clamp timeout về bound policy |
| C3 | Dev port 20130 vs MCP mặc định 20129 → tool list rỗng im lặng | P2 | `bridge-server.ts:245` vs `antifan-omp-mcp.cjs:80,168` | **giữ nguyên fail-closed**: để launcher (`antifan-agent.cjs:87` — nơi ĐÃ đọc `bridge-dev.json`) bơm `ANTIFAN_MCP_BOOTSTRAP`; KHÔNG thêm disk-discovery vào proxy |
| C4 | `main.cjs:12` chỉ `fs.existsSync` bundle, không so mtime; `run-antifan.vbs` chạy thẳng Electron, `npm start` thiếu `--allow-eval` | P2 | `main.cjs:10-30`, `package.json:23`, `index.ts:68-71` | so `mtimeMs` `.compiled` vs `src/**` → cảnh báo/rebuild; đồng bộ cờ với `dev.mjs` |
| C5 | `kill-all.mjs` = `taskkill /F /IM electron.exe` giết **mọi** Electron trên máy, không xoá lock | P2 | `scripts/kill-all.mjs` | scope theo PID/tree AntiFan + xoá `antifan-dev.pid` |
| C6 | Rác tích luỹ: `.canary` 955 MB/20 dir `run3*`, `out/` 699 MB gói tên cũ, `plans/` 486 MB, `appdata/` 1.9 GB/7 profile tree, 57 PNG root = 43 MB, `.antifan/annotations` 1,428 file | P3 | đo trực tiếp; `artifact-retention-cleaner.ts:47` chỉ quét `.artifact` | mở rộng cleaner sang `.antifan/annotations|snapshots`; xoá `out/` + `run3-attempt*` + `appdata/` legacy |

---

## 5. Finding bị loại / đính chính

1. **F1–F6, F7 của `.canary/CORE-BOTTLENECKS.md` không còn là blocker hiện tại.** Tail của chính file đó nói D1–D5 đã commit ở `7d0850b` (fail-fast render surface, verified viewport writes, truthful tab listing, capture geometry transaction, reference capture + materialization) và F8/F9 fix sau đó. Kiểm tra tại HEAD: `NO_RENDER_SURFACE` có thật (`tab-devtools-host.ts:840,1471-1479`, `browser-control-port.ts:128`); `anti.browser.set_viewport` đã vào namespace chuẩn (`browser-capabilities.ts:788`, alias legacy ở `:1188`); `browser.list-tabs` có tham số `all` (`:199,204,857,1607`); `reapplyTabGeometry` có trong port interface và được dùng (`:1772-1776`); `anti.reference.capture` đã đăng ký (`:1676`, budget `REFERENCE_CAPTURE_EXECUTION_BUDGET_MS = 90_000`). ⇒ **Không còn hạng mục nào trong F1–F9 ở trạng thái mở tại HEAD**; mục #13 dưới đây đóng nốt hạng mục throttling.
2. **"1,226 thư mục run" — SAI.** Đếm thật: **176**.
3. **"Không có thư mục `.antigravity/`" — SAI**, thư mục tồn tại.
4. **"57 PNG root"** đúng; các con số 25/56/62 bị loại.
5. **"`native-tab-host.ts` 6,757 LOC"** — SAI, đúng **6,749**.
6. **"God module tự nó là bottleneck"** — loại (smell kiến trúc); hệ quả thật nằm ở B3/B4/C1.
7. **"Dev lock orphanage cần `taskkill` tay"** — SAI: `acquireDevLock` (`dev-watcher-helpers.mjs:520-535`) tự takeover lock có pid đã chết (đúng trạng thái file lock trên đĩa hiện tại: pid 40304 đã chết). Chỉ giữ phần `kill-all.mjs` (C5).
8. **"Port 20129/20130 là discovery hỏng"** — đính chính khung: chặn disk-discovery là **chủ đích fail-closed** (comment trong `resolveBridgeCandidates`), fix phải giữ nguyên.
9. **`renderer-process-limit=4` / `process-per-site`** — loại: hardening có chủ đích cho máy low-spec (`plans/260830-1903`), không có bằng chứng crash.
10. **`certify-core-freeze.cjs` ceremony dư thừa** — loại: không nằm trong vòng lặp dev/test hằng ngày.
11. **Artifact 0-byte trả `{"data":"","isError":false}`** (bảng 260905 #8) — **đã fix tại HEAD**: `scripts/antifan-omp-mcp.cjs:1129-1145` trả `Error: EMPTY_ARTIFACT`.
12. **Hạng mục 9/10/11 bảng 260905 (lease bypass trong `theme.qa_validate`, `dispatchTrusted`, `switchTab`)** — không xác nhận được trạng thái tại HEAD (bảng từ 05-09, code đã đổi qua `7d0850b` + F8/F9) → không đưa vào union.
13. **Hạng mục 7 bảng 260905 ("background tab throttling — CHƯA FIX, căn nguyên gốc P0") — KHÔNG còn đúng tại HEAD.** Bảng 05-09 không có thẩm quyền trước code hiện tại. Kiểm tra trực tiếp:
    - `native-tab-host.ts:3489-3491` — tạo view với `backgroundThrottling: isOffscreen ? false : undefined` ⇒ tab agent offscreen **không bao giờ bị throttle** ngay từ lúc tạo.
    - `native-tab-host.ts:3702-3740` `applyTabThrottling()` — tab `offscreen === true` giữ `setBackgroundThrottling(false)` cho **cả** `view` và `mobileView`; tab thường được unthrottle khi ở foreground **hoặc** đang `aiState === 'agent_working'` / `agentWorkingRefs > 0`, rồi throttle lại khi về idle để giữ cam kết low-spec.
    - `security-policy.ts:137` (`?? true`) chỉ còn là **giá trị mặc định** trước khi host ra quyết định theo từng tab; mọi nhánh capture đều đi qua offscreen hoặc agent-working.
    ⇒ Đây chính là "scoped unthrottling" mà bảng 260905 yêu cầu, đã được implement. A5 bị gỡ khỏi Nhóm A.

---

## 6. Câu hỏi chưa giải quyết

1. `tsc --watch` có tự hồi phục khi `.compiled` bị xoá từ ngoài trên Windows (hay cần restart watcher)? Chưa exercise.
2. Tần suất lỗi `EPERM`/`EBUSY` khi `clean` xoá thư mục đang bị Windows file handle theo dõi — chưa đo.
3. Startup chậm thêm bao nhiêu ms theo số run trong artifact store (176 hiện tại)? Cần chạy Electron có telemetry.
4. `appdata/` (1.9 GB / 7 profile tree) còn đường code nào dùng, hay đã bị `E:/Work/.antifan-data` thay hoàn toàn?
5. 57 PNG root: còn workflow/tài liệu nào tham chiếu, hay xoá được toàn bộ?
6. Soft-reload cho `src/main/**` có an toàn với singleton/`webContents` không? (spike trước khi hứa)
7. Hạng mục lease-bypass #9/10/11 của bảng 260905 còn đúng tại HEAD không?
