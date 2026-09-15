---
phase: 2
title: "Retrieval integrity — platform isolation, pack identity, real confidence"
status: done
priority: P0
effort: ""
dependencies: [1]
---

# Phase 2: Retrieval integrity — platform isolation, pack identity, real confidence

## Overview
Locked contract items: C3, C5. Block 1. Ứng với upstream phase 11 ("Retrieval, recommendation and context delivery") và P0-1 của MASTER UPGRADE.

Phase này sở hữu **5 hạng mục**: 4 (Core retrieval), 5 (Context Pack), 26 (Retrieval precision), 27 (Historical reuse), 30 (Knowledge gap detection) — xem `reports/ladder-31-items.md`.

Phase này là **test + fix**, không phải viết mới: mọi defect dưới đây đã được đo tại dòng. Vòng bắt buộc: test chứng minh defect **fail** → fix → test **pass**.

Vì sao phải xong trước Bridge: pack còn nhiễu thì phase 3 sẽ **công nghiệp hoá nhiễu đó vào mọi OMP turn**. Không được build Bridge trên nền retrieval sai.

## Requirements

### R0 — Tính hợp lệ của test (chống vacuous truth) — QUAN TRỌNG NHẤT
Đây là hàng rào chống False PASS mạnh nhất của phase này, vì cả bốn test dưới đây đều là **phép thử phủ định** và phép thử phủ định **tự động pass trên tập rỗng**.

- **Bắt buộc precondition khẳng định DB đã nạp**: trước mọi test, khẳng định DB có baseline khác rỗng với con số đã biết (ví dụ `haravan >= 13.000`, tổng `claims >= 20.000`). Test chạy trên DB rỗng là **không hợp lệ**, không phải "pass".
- **Bắt buộc positive control cho mọi test phủ định**: test "query Sapo trả **0** claim Haravan" chỉ hợp lệ khi **đồng thời** khẳng định "query Sapo trả **> 0** claim Sapo". Nếu không, một hàm search hỏng hoàn toàn (trả mảng rỗng) sẽ **pass toàn bộ** suite.
- **Kiểm tra cả hai chiều**: mỗi khẳng định cách ly phải đi kèm khẳng định recall. Mất recall toàn phần **không** được trông giống như cách ly thành công.
- **Không dùng DB rỗng để test migration**: migration schema v6 phải chạy trên DB đã populate, vì đó là điều kiện thật khi vận hành.
- **`importScout()` phải được xử lý trong cùng thay đổi**: `index.ts:114` `importScout()` hiện **không** ghi cột platform cho conflicts. DB được dựng lại được từ 19 ledger có sẵn, nên nếu ai rebuild sau khi có schema v6 thì dữ liệu platform sẽ **mất hoặc sai**. Phải làm `importScout` nhận biết schema mới, **hoặc** chứng minh và ghi rõ rằng rebuild phải xảy ra trước migration — không được để mơ hồ.

### R1 — Cách ly platform ở mọi đường truy hồi
- `query()` hiện có lỗ hổng: khi lọc theo platform, nó vẫn cho claim **chưa gắn platform** đi qua.
- **Số thật đo trên DB tại `E:/Work/apps/AntiFan/.super-core/core.db`** (20.832 claim):
  `haravan 13.378` · `generic-liquid 2.191` · `sapo 1.368` · `shopify 990` · **`NULL 2.905` (13,9%)**.
- Nghĩa là **2.905 claim untagged rò vào mọi query có platform filter** — một tập rò lớn và liên tục, không phải cạnh biên. Đồng thời 13.378 claim Haravan và 1.368 claim Sapo cùng nằm trong một store: nếu không lọc, task Sapo sẽ nhận tri thức Haravan.
- Chuyển sang chính sách tường minh: mặc định **loại** claim untagged khi có yêu cầu platform; có cờ `includeGlobal` (mặc định `false`) cho ai thật sự muốn claim platform-agnostic.
- `findSimilar()` phải áp cùng chính sách cho **cả sáu** collection, không chỉ claims.

### R2 — Conflict và unknown phải scope được
- `conflicts` hiện **không có** cột platform lẫn unitId → về mặt cấu trúc không thể scope. Đây là root cause thật của việc conflict toàn cục rò vào mọi task.
- `cases` có `unitId` nhưng không có platform. `units` không có platform (chỉ `markers`).
- Thêm cột qua idiom migration đã có; backfill từ `units.markers` khi suy ra được, và để `NULL` khi không suy ra được (không bịa).

### R3 — Pack có danh tính, không spam
- Mỗi lần gọi pack hiện tạo một row mới với id ngẫu nhiên. `contextPackV2` gọi `contextPack` + `findSimilar`; `recommend` gọi `contextPack` + `receipt` → một lượt `recommend` sinh nhiều row.
- Thêm khoá danh tính `(taskHash, platform, sessionId)`; cùng input trong cùng session trả **lại** packId cũ, không thêm row.

### R4 — Confidence phải dựa trên bằng chứng, không đếm claim
- Hiện `contextPackV2` xếp hạng theo **số lượng** claim và `receiptV2` theo **số lượng** revision. Đếm nhiều không có nghĩa là đúng.
- Thay bằng điểm tổ hợp **deterministic**: độ mạnh evidence, trạng thái claim, khớp platform, độ mới, và **conflict chưa giải quyết** (conflict phải **hạ** điểm, không được nâng).

### R5 — Abstain có lý do
- Nếu sau lọc platform còn **< 2** claim chất lượng → trả `UNKNOWN` kèm `reasonCode` (ví dụ `INSUFFICIENT_PLATFORM_EVIDENCE`), **không** trả một kết luận trông tự tin.
- Không bao giờ inject tri thức cross-platform để lấp chỗ trống.

### R6 — Ranking tốt hơn lexical thuần
- Baseline FTS5/BM25 giữ nguyên làm nền; thêm tầng xếp hạng **deterministic** (khớp platform, độ mới, trạng thái, mật độ evidence), ngưỡng chốt trước khi đánh giá.
- Không gọi LLM trong đường truy hồi — phải tái lập được.

### R7 — Phát hiện lỗ hổng tri thức (hạng mục 30)
- `decayCheck()` (`:557`) và `corpusAudit()` (`:572`) **đã có** trong Core. Việc cần làm là biến chúng thành tín hiệu lỗ hổng kiểm được, không phải viết lại.
- Lỗ hổng phải phân biệt được: **chưa bao giờ có** vs **có nhưng cũ** vs **có nhưng mâu thuẫn**. Ba loại này cần cách xử lý khác nhau; gộp chúng thành một con số là mất thông tin.
- Kết quả phải truy được về platform — lỗ hổng ở Sapo không được báo là lỗ hổng ở Haravan.

## Architecture
task query → platform policy → scoped candidates (claims/cases/conflicts/unknowns)  
           → composite rank → confidence score → abstain gate → pack (deduped identity) → receipt  
decayCheck + corpusAudit → phân loại lỗ hổng (chưa có / cũ / mâu thuẫn) theo platform

## Related Code Files

**Repo chuẩn: `E:/Work/apps/AntiFan`** (branch `main`, HEAD `43ffb89`). Mọi anchor dưới đây đã grep xác nhận **trên repo này**.

- `packages/super-core/src/index.ts` (814 dòng) — sửa tại:
  - **`:220`** `query()` — nhánh platform có lỗ hổng: `(c.contextPlatform = ? OR c.contextPlatform IS NULL)`.
  - **`:248`** `contextPack()` — conflicts **không scope**: `SELECT * FROM conflicts WHERE state = 'UNRESOLVED' LIMIT 50`.
  - `:249` — unknowns lấy từ `artifacts` theo `disposition`, cũng không scope platform/unit.
  - **`:251`** — `const packId = \`pack-${uuid()}\``; `:252` `INSERT INTO packs(...)` → row mới **mỗi call**.
  - **`:413`** `recommend()` — `const abstained = top.length === 0`; luôn gọi `contextPack` + `receipt` nên sinh pack + receipt mỗi lượt.
  - **`:516`** `findSimilar()` — query claims **bỏ qua hoàn toàn** `opts.platform`; `:523` cases dùng `task LIKE ? OR context LIKE ?`; `:527` antiPatterns và `:529` workarounds dùng `... LIKE ?` với `opts.platform ?? ''` → khi platform undefined thì `LIKE '%%'` khớp **mọi** row; decisions và fixPatterns không lọc platform.
  - **`:784`** `contextPackV2()` — `confidence` = **đếm claim** (`>= 5 ? HIGH : >= 2 ? MEDIUM : >= 1 ? LOW`).
  - **`:809`** `receiptV2()` — `confidence` = **đếm revision** (`>= 3 ? HIGH : >= 1 ? MEDIUM : LOW`).
  - `:291`/`:293` `ingestOutcome()` — ghi `cases` + `candidates`, **không** ghi `observations`, không gắn evidence link.
- `packages/super-core/src/schema.ts` (524 dòng):
  - `:5` `SCHEMA_VERSION = 5`; `:410` idiom `MIGRATIONS: Array<{from,to,sql}>`.
  - **`:103` `conflicts` thiếu cả `platform` lẫn `unitId`** — xác nhận bằng `PRAGMA table_info(conflicts)`: `id, kind, subject, positionsJson, state, note, classification`. Đây là root cause cấu trúc: conflict **không thể** scope.
  - **`:113` `cases` thiếu `platform`** — `PRAGMA table_info(cases)`: `caseId, task, context, outcome, verificationRef, unitId, createdAt`.
  - `:36` `units` chỉ có `markers` (không có cột platform); `:54` `claims.contextPlatform`; `:209` `observations`; `:310` `regressions`.
- `packages/super-core/src/core.test.ts` (116 dòng) — **6 test** hiện có; nền test mỏng, phải bổ sung test thật.
- `scripts/clone-site.mjs` — nơi `contextPack` đang được gọi advisory (caller bị ảnh hưởng).
- `scripts/antifan-core.cjs` — CLI `pack`/`query`/`similar` dùng để chạy characterization test ở vòng đầu.

## Implementation Steps
1. **Trước tiên, khẳng định baseline DB**: đếm `claims` theo `contextPlatform` và ghi lại con số thật (hiện: `haravan 13.378 · generic-local 2.191 · sapo 1.368 · shopify 990 · NULL 2.905`). Test nào chạy trên DB rỗng hoặc vi phạm baseline này là **không hợp lệ**.
2. Viết characterization test #1 **theo cặp âm/dương**: (a) query Sapo trả **0** claim/conflict Haravan/Shopify **và** (b) query Sapo trả **> 0** claim Sapo. Ghi lại output làm bằng chứng defect. Test **fail** ở nhánh (a) trước fix; nếu nhánh (b) cũng fail thì đó là phát hiện khác (mất recall), phải ghi riêng chứ không gộp.
3. Test #2: gọi pack hai lần cùng input → đếm row trong `packs` tăng → test **fail**. Kèm khẳng định pack trả về **không rỗng** (positive control).
4. Test #3: task chỉ có 1 claim chất lượng → hiện trả kết luận tự tin → test **fail**. Kèm khẳng định trường hợp đủ evidence thì **không** abstain (positive control).
5. Migration schema v6 **trên DB đã populate**, sau khi đã `snapshot()`. Thêm `platform` (+`unitId`) cho `conflicts`, `platform` cho `cases`; backfill từ `units.markers`; index theo platform. **Không** chạy migration này trên DB rỗng.
6. **Xử lý `importScout()`** trong cùng thay đổi: hoặc làm nó nhận biết schema mới, hoặc chứng minh rebuild phải chạy trước migration và ghi rõ. Không để mơ hồ.
7. Sửa `query()`: bỏ nhánh `IS NULL`, thêm `includeGlobal` mặc định `false`.
8. Sửa `contextPack()`: scope conflicts theo platform/unit; scope unknowns; dedupe pack theo `(taskHash, platform, sessionId)`.
9. Sửa `findSimilar()`: áp platform policy cho cả sáu collection; **bỏ fallback `LIKE '%%'`** khớp mọi row.
10. Viết `confidenceScore()` deterministic; dùng trong `contextPackV2` và `receiptV2`; conflict chưa giải quyết phải hạ điểm.
11. Thêm abstain gate với `reasonCode`.
12. Thêm tầng xếp hạng tổ hợp; chốt ngưỡng trước khi đo.
13. Chạy lại các test ở bước 2-4 → **pass** ở cả nhánh âm và dương; chạy full super-core + site-clone suite.
14. Trace lại caller bị ảnh hưởng (`clone-site.mjs`, MCP `core.query`) và cập nhật nếu contract đổi.

## Contract and Test Matrix
- [ ] **Precondition hợp lệ**: test khẳng định DB đã nạp với baseline khác rỗng (`haravan >= 13.000`, tổng `claims >= 20.000`) trước khi chạy bất kỳ phép thử cách ly nào.
- [ ] Query cho task Sapo trả **0** claim/conflict Haravan/Shopify. (fail trước fix) **kèm positive control: query Sapo trả > 0 claim Sapo.**
- [ ] Test cách ly **fail** khi search trả mảng rỗng — chứng minh suite không thể pass bằng cách hỏng hoàn toàn recall.
- [ ] Query lặp cùng input **không** thêm row `packs`. (fail trước fix) **kèm positive control: pack trả về không rỗng.**
- [ ] < 2 claim chất lượng → `UNKNOWN` + `reasonCode`, không kết luận tự tin. (fail trước fix) **kèm positive control: đủ evidence thì không abstain.**
- [ ] Migration v6 chạy trên DB **đã populate**, có `snapshot()` trước; `importScout()` đã được xử lý cho schema mới hoặc có chứng minh thứ tự rebuild.
- [ ] Conflict chưa giải quyết **hạ** confidence, không nâng.
- [ ] `findSimilar` với platform `sapo` không trả hàng `haravan` ở **bất kỳ** collection nào trong sáu.
- [ ] Pack cùng `(taskHash, platform, sessionId)` trả cùng `packId`.
- [ ] Lỗ hổng tri thức phân biệt được ba loại (chưa có / cũ / mâu thuẫn) và truy được về platform.
- [ ] **Hạng mục 27 (Historical reuse)**: metric `found + injected + outcome-linked` tính được và tái lập được trên dữ liệu thật; con số đo được **không** suy ra từ `claims.length` hay bất kỳ phép đếm ngây thơ nào.
- [ ] **Hạng mục 26 (Retrieval precision)**: xếp hạng mới cải thiện trên baseline lexical theo ngưỡng đã chốt trước, đo trên tập giữ riêng, không rò dữ liệu.
- [ ] **Bound hiệu năng**: `decayCheck()` và `corpusAudit()` chạy trên dữ liệu thật (**184.835 `artifacts`, 20.832 `claims`, 63.654 `platformSemantics`**) phải có thời gian chạy đo được và một ngưỡng; nếu vượt ngưỡng phải có cache hoặc giới hạn phạm vi, không để health snapshot treo runner.
- [ ] Không test nào assert wiring/source text; assert hành vi quan sát được.
- [ ] Caller bị ảnh hưởng đã trace trước khi đổi contract; không bịa số hiện tại.

## Success Criteria
- [ ] Tất cả Requirements R1-R7 delivered và evidence linked cho **5 hạng mục** (4, 5, 26, 27, 30).
- [ ] Ba characterization test chứng minh fail-trước/pass-sau, có trace lưu lại.
- [ ] `super-core` và `site-clone` suite xanh; không test nào bị nới.
- [ ] Không mục nào của phase này bị chuyển thành documentation-only.

## Risk Assessment
- **Migration trên DB đã populate **20.832** claim**: dùng `snapshot()` trước, và `rollback()` đã có sẵn để lùi. Backfill không suy ra được thì để `NULL` — **không bịa** platform.
- **Đổi hành vi `query()` có thể làm giảm recall** đột ngột ở các caller đang dựa vào nhánh `IS NULL`. Đây là thay đổi contract có chủ đích: phải trace caller và ghi rõ, không im lặng.
- **Xếp hạng tổ hợp dễ thành tuỳ biến cảm tính**: ngưỡng phải chốt trước khi đo, và phải deterministic để tái lập.
- Luật `adjudications.scope` đã được sửa ở session trước — phase này **không** được vô tình hạ nó.
