# Phase 8 — Re-acceptance handoff

Kết quả cuối, đo được, không suy luận.

## 1. Kết quả Final

| Trường | Giá trị |
|---|---|
| Điều kiện Final | `PASS == 31 AND NOT_IMPLEMENTED == 0 AND BLOCKED == 0` |
| Tally | `{"PASS": 31}` |
| `finalHolds` | `true` |
| Runner status | `completed`, không abort |
| `unboundPasses` | `[]` — mọi `PASS` có receipt revision-bound |
| git SHA trong receipt | `2985471fb37f9544be7e0de9ea646f920b8fb613` (31/31 receipt cùng một SHA) |
| `exit` | `0` trên cả 31 route |
| `finishedAt` | 31 giá trị phân biệt |
| `routeIdentity` | có trên cả 31 (đường verify thật, theo quyết định của user) |
| Thời lượng | 39 192 ms |
| Bản ghi | `reports/ladder-run-2026-09-16T01-22-35-255Z.json` |

Route timeout **không** là một verdict: timeout biểu hiện thành `FAIL` (`reason: ROUTE_TIMEOUT`), nên "0 TIMEOUT" thoả theo cấu trúc chứ không theo tuyên bố. Từ vựng verdict không có `SKIP`.

Chạy lại: `npm run goal:ladder` (preflight tự build `.compiled/**` và `packages/super-core/dist`).

## 2. Hai hạng mục phải implement thật trong re-acceptance

Ladder phát hiện hai hạng mục **không có surface**, chỉ có composition nằm trong script. Cả hai đã được implement, có fail-before/pass-after:

- **#25 Health metrics (MCP)** — không có dispatch key nào trả `{status, reasonCode}`; chỉ `core.stats`/`core.corpus_audit` trả số thô. Đã thêm `health()` vào store + `core.health` (advertise + dispatch) và CLI dùng chung một composition.
  - Fail-before: probe → `NOT_IMPLEMENTED` (exit 3); sau khi thêm → `PASS` (exit 0).
- **#27 Historical reuse** — metric `found + injected + outcome-linked` chỉ tính được bằng query tự chế, `dedicatedSurface: null`. Đã thêm `reuseMetric({ task })` (read-only) + `core.reuse_metric` + CLI `reuse-metric`.
  - Fail-before: probe `FAIL` ("surface followed pack …, rows witness …"); sau khi sửa → `PASS`, surface khớp đúng số do row chứng thực.

Hai test mới đều đã chứng minh fail-before:

- `health()` — bỏ guard empty-store → `actual: 'DEGRADED', expected: 'UNKNOWN'`.
- `reuseMetric` — thay join bằng echo `injected` → fail ở "a receipt-less pack links no outcome yet".

## 3. Lỗi trong chính harness, đã sửa

Ladder là code mới; bốn lỗi dưới đây do chính nó phơi ra và đã sửa:

1. **Pattern rỗng vẫn PASS.** `node --test` báo `# tests 1 / # pass 1` khi pattern lọc sạch mọi test — nó tính chính file là một test placeholder lấy tên bằng đường dẫn file. Guard: route chỉ có tên pass bằng đường dẫn file ⇒ `FAIL` (`ROUTE_PATTERN_MATCHED_NOTHING`). Bằng chứng: pattern sai → `FAIL`; pattern đúng → `PASS`.
   - Lần sửa đầu **không** bắt được, vì TAP escape dấu phân cách nên tên placeholder có `\\` đôi và không khớp target. Đã chuẩn hoá lại (`/`+ gộp separator).
2. **`spawnSync` chặn heartbeat.** Route chạy đồng bộ làm nhịp tim đứng suốt thời gian route; supervisor ngoài đọc nhịp tim không tự làm mới được sẽ coi runner đã chết và kill — một hạng mục chậm nhưng khoẻ sẽ bị báo `HEARTBEAT_STALE`. Đã chuyển sang spawn bất đồng bộ + kill theo cây tiến trình.
3. **`npm.cmd` không exec được không có shell** (Node 24 từ chối `.cmd` thiếu shell) → preflight fail tức thì. Đã gọi bằng một command line hằng, không nội suy.
4. **`--test-force-exit`.** Lớp Core Health là surface sống; render nó để lại timer sống lâu hơn assertion (đo được: 5 `Timeout` lúc teardown, các surface khác 0). Đây là vệ sinh thoát tiến trình, không phải tín hiệu acceptance, nên route dùng đúng flag mà lane của repo dùng. Không assertion nào bị nới.

Bằng chứng lỗi #1 được giữ nguyên: `reports/ladder-run-ladder-final.json` (30/31, một `FAIL` `ROUTE_TIMEOUT` ở `p0b/health-ui`), superseded bởi bản ghi ở mục 1.

## 4. Regression (R4)

`npm test` → **all lanes passed**, exit 0:

| Lane | Kết quả |
|---|---|
| compile | passed 6.0s |
| test:canary | passed 35.3s |
| test:fast | passed 42.8s |
| test:site-clone | passed 15.6s |
| test:integration | passed 2.0s |
| test:main | passed 87.7s |
| test:e2e | passed 15.0s |

Bổ sung: `packages/super-core` 24/24; `test/unit/mcp-core-parity.test.mjs` 10/10.

## 5. Gate tổng

| Gate | Kết quả |
|---|---|
| `check-bottlenecks.mjs` | `OK — every declared status matches HEAD` (36 row: CLOSED=25 REFUTED_OK=4 MANUAL=6 OPEN=1) |
| `check-mcp-budget-dominance.mjs` | `OK: one ceiling dominates every server policy` (121 tool advertise, 51 `core.*` dispatch, 242 capability) |
| `check-plans.mjs` | 512 plan, 0 no-frontmatter |

## 6. Còn lại — blocker nêu tên, không hạ chuẩn

- **B23** (phase 7) — cần một lần chạy trên storefront thật. Gate đã có (`npm run harness:theme`); đóng cần `.hrv-sync-state.json` (chưa bind watcher `hrv theme dev`) và `THEME_PUSH_APPROVED=1`. Ghi trong `plans/bottlenecks.json` mục B23.
- **B29** (phase 5) — 20 routing row `anti.*` còn shadow registration. Sweep chứng minh chúng behaviour-preserving và một row lệch registration bị test bắt; retire chúng là **đổi wire-name + payload validation**, tức breaking change cần user quyết, nên row ở lại `open` kèm predicate `manual`. Không tự ý đổi.
- **Theme harness L1/L2** — L1 `INCONCLUSIVE`, L2 `BLOCKED` kèm prerequisite (`THEME_PUSH_APPROVED=1`, `.hrv-sync-state.json`). Không mô phỏng push.

## 7. Trung thực — điều không được đọc quá

- **#26 Retrieval precision**: probe khẳng định thứ tự chặt (strong > weak, score đơn điệu giảm, top > last) và đã chứng minh fail-before khi đảo so sánh. Nhưng biên độ **mỏng**: strong `0.3706216522` vs weak `0.3706215839` (Δ ≈ 6.8e-8) trên corpus 2 document, vì IDF âm. Thứ tự đúng, biên nhỏ — đổi hằng số saturation có thể lật kết quả.
- **#25/#27** là surface do phase 8 thêm, không phải do phase 5/6. Chúng thuộc ladder nên phải có; ghi rõ để không đọc thành "phase 5/6 đã giao".
- **Lớp Core Health** vẫn để lại 5 `Timeout` sau teardown khi chạy **không** có `--test-force-exit`. Chưa sửa vòng đời timer của renderer: không có khiếm khuyết nào người dùng thấy, và lane của repo đã xử lý bằng force-exit. Ghi lại để không bị coi là "không tồn tại".
- **Hai artifact sinh máy** (`plans/reports/mcp-overhaul-benchmark.json`, `.../live-theme-proof.json`) bị lane ghi lại mỗi lần chạy; giá trị là timestamp/số đo, đã khôi phục về bản đã commit để commit không chứa nhiễu.
- **`#10`, `#27` thuộc phase 8** theo bảng phân bổ, và đã được verify ở đây — không mục nào được đánh `PASS` trên scaffolding.
