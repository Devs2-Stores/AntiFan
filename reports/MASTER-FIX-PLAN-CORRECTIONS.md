# MASTER-FIX-PLAN — CORRECTIONS ADDENDUM

**Ngày:** 2026-09-15
**Vai trò:** tài liệu bắc cầu. **Không thay thế** và **không sửa** `MASTER-FIX-PLAN.md`.
**Đối tượng đọc:** phiên `/ak-cook --auto --advice` đã thi hành plan (tác giả `MASTER-FIX-PLAN-EXECUTION-STATUS.md`).

## 0. Bối cảnh

`MASTER-FIX-PLAN-EXECUTION-STATUS.md` ghi `Plan: reports/MASTER-FIX-PLAN.md (656 lines)`.
`MASTER-FIX-PLAN.md` hiện tại: **729 dòng**, mtime `2026-09-15 17:52:24`, sha256 `f93fee6107a0f4081a5753b136b6a91f…`.

⇒ Phiên Fix đọc bản **656 dòng** — tức bản **trước** khi Part "PHASE 9" và tiêu chí E12–E15 được thêm (+73 dòng). **Toàn bộ PHASE 9 vô hình với phiên Fix.**

Tài liệu này ghi lại: (1) lỗi trong plan do tôi gây ra, (2) đính chính lại chính status report, (3) thực tế PHASE 9, (4) sự cố, (5) quyết định còn treo.

**Quy ước nhãn:** `[OBSERVED]` = tôi tự chạy/đọc trong phiên này · `[SECONDARY]` = trích từ status report, tôi chưa tự kiểm · `[DERIVED]` = suy ra từ OBSERVED.

---

## 1. Lỗi trong MASTER-FIX-PLAN do tôi gây ra

### 1.1. Sai mốc thời gian scan — lệch 23 giờ

| | |
|---|---|
| Plan nói | "ingest chạy lần cuối `2026-09-15T06:01:34Z`" |
| Thực tế | scan dừng ở **`2026-09-14T15:43:09Z`** |
| Bằng chứng `[OBSERVED]` | `MAX(artifacts.observedAt) = 2026-09-14T15:45:29.171Z`; **cả 177.009 dòng** cùng nằm trong giờ `2026-09-14T15`; `delta-sweep.json.generatedAt = 2026-09-14T15:43:09.231Z` |

`06:01:34Z` là `corpus_audit.createdAt` — chỉ **tính lại thống kê**, không quét filesystem. Tôi đọc hai trường khác nhau thành một.

**Hệ quả:** cửa sổ mất mát là **~23 giờ**, không phải ~3 giờ.

### 1.2. "7.658 dòng trùng lặp" — sai bản chất

| | |
|---|---|
| Plan nói | "Entropy 63.1% → 7.658 dòng trùng lặp" |
| Thực tế | 779 dòng claim `contains 1 Liquid form tag(s)` có **779 `claimId` khác nhau**, trải trên 71 unit |
| Bằng chứng `[OBSERVED]` | `SELECT COUNT(*), COUNT(DISTINCT claimId), COUNT(DISTINCT unitId)` → `779 / 779 / 71` |

Chúng **không trùng** — là 779 quan sát riêng biệt. Đúng phải gọi là **nghèo thông tin (low-entropy)**, không phải trùng lặp.

### 1.3. ".md không ingest được" — sai

| | |
|---|---|
| Plan nói | "`importScout` chỉ đọc register, không đọc `.md`" ⇒ `.md` không vào được Core |
| Thực tế | **4.924 artifact là `.md`**, trong đó **4.924 (100%)** có claims |
| Bằng chứng `[OBSERVED]` | `SELECT COUNT(*) FROM artifacts WHERE relPath LIKE '%.md'` |

`.md` **được** ingest đầy đủ. Nguyên nhân 24 file vắng mặt là **scan cũ**, không phải định dạng.

### 1.4. "Không nối ra tool surface" — nửa sự thật

| | |
|---|---|
| Plan nói | đường nạp "tồn tại trong store nhưng không nối ra tool surface" |
| Thực tế | `scripts/antifan-core.cjs:36` — CLI 45 lệnh, có `case 'import'` |
| Bằng chứng `[OBSERVED]` | đọc toàn bộ `scripts/antifan-core.cjs` |

Câu "không có `reg('core.*')` cho `importScout`" trong `core-capabilities.ts` là **đúng**. Nhưng tôi diễn giải thành "không với tới được" — sai. Nó không ở mặt **MCP**, nhưng ở mặt **CLI**.

### 1.5. FIX-9.2 mô tả sai việc cần làm *(lỗi tốn kém nhất)*

| | |
|---|---|
| Plan nói | "sinh register cho 21 scout report `.md`" — nghe như phải viết converter mới |
| Thực tế | toolchain **đã có sẵn**, 13 script |
| Bằng chứng `[OBSERVED]` | `plans/260914-1248-work-root-sequential-evidence-scout/tools/`: `inventory-scan.mjs` `scaffold-units.mjs` `route-units.mjs` `analyze-unit.mjs` `analyze-all.mjs` `deep-analyze-unit.mjs` `deep-analyze-all.mjs` `correlate.mjs` `populate-v4.mjs` `delta-sweep.mjs` `delta-apply.mjs` `close-scout.mjs` `fixture-smoke.mjs` |

Và `importScout` đọc **21 file register + `units/<uid>/content-ledger.jsonl`** (450 unit) — bản ghi từng file nằm trong `units/`, **không** nằm trong `.md`.

**Việc đúng:** chạy lại toolchain có sẵn, không viết mới.

### 1.6. Bỏ sót cơ chế delta đã tồn tại

`delta-sweep.mjs` + `delta-apply.mjs` **đã chạy một lần**, kết quả lưu sẵn `[OBSERVED]`:

```json
// delta-sweep.json
{"runId":"wrses-20260914T135118Z","generatedAt":"2026-09-14T15:43:09.231Z",
 "inventoried":1063814,"dirsChecked":88627,
 "unchanged":1063247,"added":589,"changed":132,"deleted":435,
 "readdirErrors":0,"statErrors":0}

// delta-applied.json
{"generatedAt":"2026-09-14T15:45:29.189Z","deltaTruncated":false,
 "affectedUnits":3,"addedRegistered":589,"staleClaims":0,
 "reanalyzed":3,"note":"full delta applied"}
```

Cơ chế cập nhật **đã thiết kế, đã chạy, đã kiểm chứng sạch** (0 lỗi readdir/stat). Việc cần làm là **chạy lại**, không phải **xây**.

### 1.7. Trích báo cáo agent khác bằng ngữ pháp quan sát

| | |
|---|---|
| Tôi nói | "hook đã được viết lại 167 → 338 dòng" |
| Thực tế `[OBSERVED]` | file thật **378 dòng** (351 non-blank, 71 comment-only) |
| | mtime hook `16:58:59 +0700` **trước** status report `17:13:49 +0700` ⇒ không thể đổ cho "file đổi sau" |

Chênh lệch 378 vs 338 **chưa giải thích được**. Tôi đã thuật lại nguồn cấp hai như quan sát của mình.

> **Bổ sung — Phase 1 đã được xác minh ĐỘC LẬP `[OBSERVED]`.** Sau khi viết tài liệu này, tôi đọc trực tiếp hook đã sửa và xác nhận từng thay đổi có thật:
> | Thành phần | Dòng | Giá trị |
> |---|---|---|
> | `PENDING_TTL_MS` | 67 | `10 * 60_000` |
> | `REMIND_EVERY` | 69 | `8` |
> | `GATE_MARKER` | 71 | `"[theme-qa-gate]"` |
> | `THEME_PATH_RE` | 81 | `/(^\|\/)(layout\|templates\|sections\|snippets\|assets\|config)\//` |
> | `pruneExpired()` | 175-180 | xóa entry quá TTL |
> | Cổng arm | 331 | `if (!rel \|\| !THEME_PATH_RE.test(rel)) return;` |
> | Throttle + dedupe | 346 | `toolResultCounter % REMIND_EVERY === 0 && !contentHasMarker(...)` |
> | `reminderText()` không chứa token | 291-293, 302-305 | đối chiếu `BYPASS_TOKENS` sau khi serialize |
>
> Header hook ghi rõ: *"only real theme paths arm the gate (reports/, plans/, docs/, scripts/ do not)"*.
>
> **Quan sát hành vi:** mọi lượt ghi/sửa vào `reports/` trước đó trong phiên đều bị chặn (3 lần, ghi ở §A.1 của plan). Lượt ghi `reports/MASTER-FIX-PLAN-CORRECTIONS.md` **không** bị chặn.
>
> Cơ chế đổi hành vi `[INFERRED]`: hook trên đĩa mtime `16:58:59 +0700`, nhưng tiến trình đang chạy giữ module cũ trong bộ nhớ cho tới khi nạp lại — nên các lượt ghi giữa phiên vẫn gặp hook cũ.
>
> ⇒ Sai sót của §1.7 **chỉ là con số dòng** trong status report. **Bản sửa Phase 1 đúng và đã kiểm chứng.**

### 1.8. FIX-4.2 (staleness fence) — thừa *(phiên Fix phát hiện)*

Fence **đã tồn tại**. Xem §2.1 để biết chứng cứ đúng.

### 1.9. FIX-3.1 (auto-freeze) — phần lớn thừa *(phiên Fix phát hiện)*

`theme-qa-workflow.ts` đã gọi `freezeMedia` trước settle barrier. Xác minh `[OBSERVED]`:

```ts
// src/main/qa/theme-qa-workflow.ts:~539
if (typeof this.ports.browser.freezeMedia === 'function') {
  try {
    await this.ports.browser.freezeMedia(activeTarget, { freeze: true, normalizeSliders: true });
  } catch { /* Best effort freeze before settle barrier */ }
```
Chỉ **đường raw screenshot** là chưa được bảo vệ.

### 1.10. `theme.css.liquid` 406 KB — không tồn tại

Lỗi này **kế thừa từ `SYNTHESIS-REPORT-SUPER-CORE-AND-THEME-CORE.md`**, tôi bê nguyên vào plan. Xác minh `[OBSERVED]`: `find "E:/Work/customizes" "E:/Work/themes" -iname "theme.css.liquid"` → **0 kết quả**.

Số thay thế — xem §2.3 (con số của phiên Fix cũng chưa đúng).

### 1.11. Mô hình chuỗi deadline — sai chiều

Plan đặt `mcpTransportMs` **bên trong** `toolPolicyMs`. Thực tế MCP client là lớp **ngoài cùng**, và trần proxy trong repo là 240 s. Ghi nhận `[SECONDARY]` từ status report §Phase 2; cơ chế đã được phiên Fix sửa và kiểm bằng `scripts/check-mcp-budget-dominance.mjs`.

---

## 2. Đính chính lại MASTER-FIX-PLAN-EXECUTION-STATUS.md

### 2.1. Kết luận đúng, nhưng 2/3 chứng cứ sai đường dẫn

Status report §3 viết: *"the fence already exists in-repo (`browser-control-port.ts` ~2137, ~2773-2789, ~6203-6211; `theme-qa-workflow.ts` 566-574)"*.

**(a) Đường dẫn sai.** `src/main/browser/browser-control-port.ts` **không tồn tại** `[OBSERVED]`. Đường dẫn thật: **`src/main/tools/browser-control-port.ts`** (6.887 dòng, 331.928 B).

**(b) Hai dải dòng không phải staleness fence** `[OBSERVED]`:

| Dòng (tại đường dẫn đúng) | Nội dung thật |
|---|---|
| `2137` | cảnh báo `releaseMediaFreeze` — **media unfreeze**, không phải fence |
| `2773-2789` | `switchTab` / logic failover `failoverTabId` — **không phải fence** |
| `6203-6211` | phương thức `freezeMedia()` — **không phải fence** |

**(c) Chứng cứ ĐÚNG nằm ở chỗ khác** `[OBSERVED]` — `src/main/qa/theme-qa-workflow.ts:571-576`:

```ts
const checkAborted = () => {
  if (input.signal?.aborted) {
    throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
  }
  const currentGen = this.ports.browser.getDocumentGeneration?.(activeTarget.tabId);
```

`TARGET_STALE` còn xuất hiện tại `native-tab-host.ts:7416, 7498`; `tab-automation-host.ts:1521, 1528`; `first-party-network-tracker.ts:254, 361, 373, 383`; `semantic-ref-registry.ts:379`.
`documentGeneration` xuất hiện trong 10+ file gồm `theme-qa-workflow.ts`, `native-tab-host.ts`, `tab-devtools-host.ts`, `theme-mutation-session.ts`.

⇒ **Kết luận "fence đã tồn tại" là ĐÚNG** và được xác nhận độc lập. Chỉ phần trích dẫn `browser-control-port.ts` là sai. Không cần đổi quyết định BLOCKED/đã-có của Phase 4.

### 2.2. `theme-qa-workflow.ts` 534-540 — đúng

`[OBSERVED]` `freezeMedia` nằm ở ~dòng 539 trong dải 530-545. Trích dẫn chấp nhận được.

### 2.3. "largest `settings.html` = 128,509 B" — SAI

`[OBSERVED]` — `find "E:/Work/customizes" -name "settings.html" -printf '%s %p\n' | sort -rn`:

```
756,631  E:/Work/customizes/Apshop/config/settings.html
571,757  E:/Work/customizes/SittoVietnam/config/settings.html
571,408  E:/Work/customizes/SittoVietnam/.haravan-cli_backup/.../settings.html
```

Lớn nhất đo được: **756.631 B** — gấp ~6× con số 128.509. Con số này nằm trong **phạm vi phiên Fix tự khai** (`customizes/`), nên mâu thuẫn trực tiếp.

---

## 3. PHASE 9 — thực tế (vô hình với phiên Fix)

### 3.1. Khoảng trống

```
reports/ trên đĩa : 53 file
có trong artifacts: 29 file
CHƯA nạp          : 24 file
```
24 file gồm **toàn bộ 21 `scout-*.md`** + `SYNTHESIS-REPORT-…md` + 2 `MASTER-FIX-PLAN*`.

Nhưng xem §1.1: **đây chỉ là một thư mục.** Mọi file trong `E:\Work` ghi sau `2026-09-14T15:43:09Z` đều vắng mặt. **Quy mô thật chưa đo được** — `os.walk` toàn `E:\Work` giết kernel 2 lần, tôi bỏ không thử lại.

### 3.2. Chất lượng bản ghi hiện tại

| Chỉ số | Giá trị |
|---|---|
| `fix_patterns.before` / `.after` có nội dung | **11/733 (1.5%)** |
| `fix_patterns` chứa code fence ``` | **0/733** |
| độ dài `after` trung bình | 218 ký tự (max 402) |
| `anti_patterns.replacement` | **61/499 (12.2%)** |
| `anti_patterns.whatNotToDo` | 173/499 (34.7%) |
| `tool_intel.roi` | **2/700 (0.3%)** |
| `platform_semantics` là `observed-markers` | **48.892/63.597 (76.9%)** |
| claims vs cases/receipts/adjudications | 20.769 vs **8 / 9 / 8** |

Không có bảng `code_samples` / `snippets` — **không có chỗ nào chứa code mẫu**.

### 3.3. Rác trích xuất

Trong 43 `anti_patterns` tạo `2026-09-15`, **30 cái lúc `02:16:57Z` là tiêu đề mục tài liệu** bị thăng cấp `[OBSERVED]`:
```
"Anti-Patterns" · "11. Anti-patterns" · "Anti-Patterns Quick Check"
"Common Pitfalls" · "Pitfall 1: Saving everything" · "Lessons / gotchas"
"Anti-patterns (nhắc nhanh — chi tiết trong skill)"
```

### 3.4. Việc đúng cho PHASE 9

**ĐÃ KIỂM CHỨNG 2026-09-15 — toolchain KHÔNG bị ghim, chạy lại sẽ nhặt được 21 report.**

Chuỗi đã xác minh từng mắt `[OBSERVED]`:

| Mắt | Bằng chứng |
|---|---|
| `delta-sweep.mjs` quét lại filesystem sống | `fs.readdirSync(sysPath(dirAbs), {withFileTypes:true})` + `fs.lstatSync` trên mọi dir/entry — **không** ghim vào snapshot |
| `apps\AntiFan\reports` có trong inventory | 30 entry (1 dir + 29 file) |
| Route đúng unit | `ownerOf()` → `u-faef9d3e3b42` (`apps\AntiFan`, ELIGIBLE) |
| `queue.json` có `fileInventory` | `work-units/u-faef9d3e3b42-apps-antifan/files.jsonl` — tồn tại, 24.888 dòng |
| `delta-apply` ghi vào unit | `fs.appendFileSync(filesPath, …)` với `deltaAdded: true` |
| rồi phân tích lại | `execFileSync(analyze-unit.mjs, [uid])` |
| `importScout` đọc | `units/<uid>/content-ledger.jsonl` (24.888 dòng) |

Kiểm tra toàn vẹn lần quét trước: `completion-ledger.json` → `pending: 0`, `coverage: 100.00%`, `units DONE 246 / PENDING 0`, và `D=E+X+R+G` OK (`1.063.814 = 200.041+765.228+98.537+8`). `frontier.json` → `pendingCount: 0`, `state: EMPTY`.

⇒ 29 file trong `reports/` lúc quét đều đã vào. **24 file mới chỉ đơn thuần là hậu duệ thời gian.**

**Quy trình đúng:**
1. `node tools/delta-sweep.mjs` → ghi `reports/delta-sweep.json` (**ghi đè** — mất baseline `added:589 changed:132 deleted:435`; số liệu đó đã lưu ở §1.6)
2. `node tools/delta-apply.mjs` → append vào `files.jsonl`, chạy lại `analyze-unit.mjs`
3. `node tools/populate-v4.mjs`
4. `node scripts/antifan-core.cjs import <reportsDir>`

**Khuyết điểm thật của toolchain — phải biết trước khi chạy:**

`delta-sweep.mjs` ghi `addedSample: added.slice(0, 200000)`; `delta-apply.mjs` đọc `DELTA.addedSample`. Nếu **> 200.000 file mới**, phần dư **im lặng bị bỏ**; chỉ có cờ `samplesTruncated` báo. Lần chạy trước `added: 589` nên an toàn, nhưng khoảng trống 23 giờ trên toàn `E:\Work` **có thể** vượt ngưỡng. Kiểm `samplesTruncated` trong `delta-sweep.json` sau bước 1 trước khi tin bước 2.

**Bác bỏ một lo ngại của tôi:** `queue.json` ghi `pendingArtifacts: 26315` cho unit AntiFan trong khi `state: COMPLETE` — trông như unit quét dở. Không phải. `queue.json` là **hàng đợi lập kế hoạch** ở thời điểm sinh queue; `completion-ledger.json` mới là nguồn chốt, và nó ghi `pending: 0`.

### 3.5. Việc còn lại của PHASE 9

1. ~~Kiểm `delta-sweep.mjs` có nhặt file mới không~~ → **ĐÃ KIỂM: CÓ.** (§3.4)
2. Chạy 4 bước ở §3.4.
3. Hạ ưu tiên FIX-9.1 (đăng ký `core.import_scout` lên MCP). CLI đã đủ. Nếu vẫn làm: phải có lock/migration story cho DB 163 MB.
4. Chặn thăng cấp heading thành anti_pattern tại nguồn trích xuất.
5. Chỗ chứa code mẫu — **cần đổi schema** (`SCHEMA_VERSION = 5`), thuộc quyền quyết của người dùng.
6. Thêm `samplesTruncated` vào tiêu chí kiểm của pipeline.

---

## 4. Sự cố phiên Fix đã công bố — giữ nguyên, không rút gọn

1. **Mất dữ liệu không cứu được.** `Remove-Item -Recurse -Force tmp` xóa cả `tmp/` — ~37 file untracked của các session trước. Chưa từng commit (`git log --all -- tmp` rỗng), `Remove-Item` bỏ qua Recycle Bin. `[SECONDARY]`
2. **6 row rác trong Core.** PowerShell 5.1 nuốt dấu ngoặc kép khi truyền native args → `fix-pattern` (mọi trường optional) chèn **6 row `fix_patterns` all-NULL**. CLI không có lệnh xóa. `[SECONDARY]` — khớp với phát hiện của tôi ở §3.2 rằng phần lớn `fix_patterns` rỗng.
3. **Va chạm writer.** Session `plans/handoffs/terminal-sidebar-sleep-cls-conpty-perf-20260915-1705.md` sửa cùng working tree; trùng `src/renderer/standalone.js` + `src/preload/standalone-preload.ts`. Hệ quả: 8 fix-pattern ghi ở Phase 7 hóa ra là code đã ship. `[SECONDARY]` — file handoff tồn tại, mtime `17:07` `[OBSERVED]`.

---

## 5. Quyết định còn treo

| # | Việc | Vì sao treo |
|---|---|---|
| 1 | `C:\Users\Admin\.omp\agent\mcp.json` `"timeout": 30000` → phải `> 240_000` | Cài đặt harness toàn cục. Đánh đổi: call treo chặn tới 4 phút. **Người dùng quyết.** |
| 2 | Dọn 6 row `fix_patterns` all-NULL | CLI không có verb delete |
| 3 | Chỗ chứa code mẫu trong Core | Cần bump `SCHEMA_VERSION` |
| 4 | Quy mô thật của khoảng mất mát | Chưa đo được |
| 5 | `delta-sweep.mjs` có nhặt được file mới không | Chưa kiểm — chặn PHASE 9 |
| 6 | 5 chủ đề §A.10 (ledger 1 file · mã trạng thái · mở rộng 4 tầng · bộ lọc giá trị · Nightly Quarantine) | **Chỉ là thảo luận, chưa chốt.** Phiên Fix đã đúng khi KHÔNG thi hành. |

---

## 6. Phụ lục — bảng bằng chứng

| Khẳng định | Lệnh / nguồn | Kết quả |
|---|---|---|
| Mốc scan | `SELECT MAX(observedAt) FROM artifacts` | `2026-09-14T15:45:29.171Z` |
| Delta đã chạy | `cat delta-sweep.json` | `added:589 changed:132 deleted:435 readdirErrors:0 statErrors:0` |
| `.md` được ingest | `SELECT COUNT(*) FROM artifacts WHERE relPath LIKE '%.md'` | `4,924` |
| 779 claim không trùng | `COUNT(*), COUNT(DISTINCT claimId)` | `779 / 779` |
| CLI có `import` | `scripts/antifan-core.cjs:36` | `case 'import': core.importScout(...)` |
| Toolchain tồn tại | `ls plans/260914-…/tools/` | 13 script `.mjs` |
| `theme.css.liquid` không tồn tại | `find … -iname "theme.css.liquid"` | 0 kết quả |
| `settings.html` lớn nhất | `find … -printf '%s %p' \| sort -rn` | `756,631 B` (Apshop) |
| `browser-control-port.ts` path | `find src -name "browser-control-port*"` | `src/main/tools/` (6.887 dòng) |
| Fence thật | `theme-qa-workflow.ts:571-576` | `throw CapabilityError('TARGET_STALE', …)` |
| Hook 378 dòng | `wc -l theme-qa-gate.ts` | `378` (không phải 338) |

---

**Kết luận:**

1. Plan đúng ở phần lớn PHASE 1–8. **PHASE 1 (QA gate) đã được xác minh độc lập là đúng và đang chạy** — không phải chỉ tin theo status report.
2. Sai ở **7 điểm do tôi gây ra** và **1 điểm kế thừa từ `SYNTHESIS-REPORT`** (`theme.css.liquid` 406 KB).
3. Sai ở **2 điểm do tôi kế thừa từ chính plan cũ** mà phiên Fix đã phát hiện: FIX-3.1 phần lớn thừa, FIX-4.2 thừa.
4. **2/3 chứng cứ** phiên Fix dùng cho kết luận "fence đã tồn tại" là sai đường dẫn và sai dải dòng — nhưng **kết luận vẫn đúng**.
5. PHASE 9 **chưa từng tới tay phiên Fix**. Việc rẻ nhất và đúng nhất: **kiểm `delta-sweep.mjs` rồi chạy lại toolchain có sẵn** — không phải xây đường ống mới.

**Việc chặn PHASE 9:** ~~chưa ai kiểm `delta-sweep.mjs` có nhặt được file mới hay không~~ → **ĐÃ KIỂM (2026-09-15): CÓ.** Toolchain quét lại filesystem sống, route đúng unit `u-faef9d3e3b42`, và khép kín tới `importScout`. Xem §3.4. PHASE 9 giờ chỉ còn **4 lệnh**, cộng 1 điều kiện kiểm (`samplesTruncated`).

**Bài học phương pháp luận:** probe đầu tiên của tôi báo "`AntiFan\reports` có 0 entry trong inventory" — **sai**. Nguyên nhân: backslash trong JSONL bị escape đôi, nên tìm chuỗi `AntiFan\reports` không khớp `AntiFan\\reports`. Phải parse JSON rồi mới so path. Một probe âm tính **không** là bằng chứng vắng mặt cho tới khi đã loại trừ lỗi định dạng.
