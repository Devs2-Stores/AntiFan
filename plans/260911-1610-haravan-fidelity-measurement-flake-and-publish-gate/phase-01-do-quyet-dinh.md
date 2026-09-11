---
title: "Phase 1: Đo quyết định (kill-test V0)"
status: in-progress
---

# Phase 1: Đo quyết định (kill-test V0)

## Overview

Chốt thủ phạm của `content-changed-between-passes` bằng **một** phép đo rẻ (một browser session, một document replay có sẵn), trước khi sửa bất kỳ dòng nào. Không có bước này thì mọi sửa cổng là đoán.

## Requirements

- [ ] Bridge canary sống trên port 20131 và session mint được (`.canary/state/canary-session.json`).
- [ ] Fixture replay `product__1024x900.html` phục vụ từ `serve-static.mjs` ở port 7861.
- [ ] Probe `.canary/tools/probe-fingerprint-cycle.mjs` chạy xong, ghi `.canary/state/probe-fingerprint-cycle.json`.
- [ ] Mỗi mẫu lưu đủ 11 khoá fingerprint + số lần ghi `style`/`class` của trang giữa các mẫu.
- [ ] Nhánh V2a / V2b / V3 được chọn và ghi lại kèm số đo.

## Implementation Steps

1. Mint session: `node .canary/tools/canary-session.mjs 20131 .canary/state/canary-session.json` (đã chạy, session hiện có hiệu lực tới `leaseUntil`).
2. Serve fixture: `node .canary/tools/serve-static.mjs .canary/theme-fidelity-run4/compare/r2-vs-subject/replay/reference 7861`.
3. Chạy probe ở ba nhịp 0.4 s / 4 s / 40 s, mặc định `[[400,30],[4000,12],[40000,3]]`.
4. Đọc `cadences[].consecutiveEqualPairs`, `cadences[].transitions[].changedKeys`, `cadences[].probeDelta`, `passComparison.changedKeys`, `passes[].stillMovingAfterGuard`.
5. Áp bảng quyết định §4 của winner để chọn nhánh; ghi số đo vào báo cáo phase.

## Todo

- [x] Viết probe `.canary/tools/probe-fingerprint-cycle.mjs`
- [x] Mint session + serve fixture
- [ ] Chạy probe và thu JSON
- [ ] Chốt nhánh V2a / V2b / V3 kèm số đo

## Decision Table (bắt buộc dùng, không thay bằng cảm tính)

| Quan sát | Kết luận | Hành động |
|---|---|---|
| Hai mẫu cách 40 s **bằng nhau** | trôi do pha/nhịp lấy mẫu | Phase 2 → **V2b** |
| Không bao giờ bằng nhau, số lần ghi `style` giữa hai pass = 0 | trang tự đổi, không do bộ đo | Phase 2 → **V2a** |
| Số lần ghi `style` giữa hai pass > 0 | bộ đo tự sửa trang | Phase 2 → **V3** (V2b không đủ) |

## Falsifiers

- Nếu ở nhịp 40 s vẫn bằng nhau 100 % ⇒ giả thuyết chu kỳ dài đúng, V2b là bắt buộc, không được chọn V2a.
- Nếu `probeDelta.styleWrites` tăng đều đặn giữa các mẫu ngay cả khi không gọi `settleAndMeasure` ⇒ có nguồn ghi thứ ba (site JS), phải nêu riêng, không gán cho guard.

## Success Criteria

- Tồn tại `.canary/state/probe-fingerprint-cycle.json` với đủ ba cadence, mỗi cadence có `consecutiveEqualPairs` và `transitions`.
- Báo cáo ghi rõ: nhánh được chọn, số đo quyết định, và dự đoán sẽ kiểm ở Phase 4.

## Kết quả đo (2026-09-11)

Probe `.canary/tools/probe-fingerprint-cycle.mjs`, fixture replay `product__1024x900.html` (server `serve-static` cổng 7861, tab riêng qua canary bridge 20131):

| Nhịp | Số mẫu | Fingerprint khác nhau | Cặp liên tiếp khớp | Nhịp thực đo | Ghi `style` của guard |
|---|---|---|---|---|---|
| 400 ms | 30 | 1 | 29/29 | 1242 ms | 0 |
| 4 s | 12 | 1 | 11/11 | 4830 ms | 0 |
| 40 s | 3 | 1 | 2/2 | 40863 ms | 0 |

Hai pass chuẩn (`settleAndMeasure`) liên tiếp: fingerprint bằng nhau; `probeDelta.styleWrites = 0` ở cả ba nhịp; `stillMovingAfterGuard` không được set.

**Kết luận bước 1:** trên document replay tĩnh, chu kỳ trôi **không** tái hiện được, và bộ đo **không** tự sửa trang giữa các mẫu ⇒ nhịp (V2b) và vòng lặp guard (V3) **không có bằng chứng** trên fixture này.

**Kết luận bước 2 (đo lại sau khi advisory chỉ ra hai lỗi của probe gốc):**
- `fingerprintOf` gốc đọc `settle.fingerprint` (chuỗi hash 16 ký tự) thay vì `settle.fingerprintFields` (object 11 khoá) ⇒ `passComparison.fingerprintsEqual = true` của lần chạy đầu là **dương tính giả**; đã sửa.
- Fixture `product__1024x900.html` **không có** phần tử nào khớp selector `TRACKS` của guard ⇒ guard thoát sớm, `pinnedMovers` rỗng ⇒ số đo "0 lần ghi" trên fixture này **không** nói gì về V3; đã thêm `guardCensus` + `guardNodes` và chạy lại trên `home__1024x900.html` (có `s-content` thật).
- Bổ sung prologue thật của campaign (`anti.screenshot.full_page` trước hai pass) vì `hydrateToCapturedState` chụp toàn trang trước khi đo.

Sau khi sửa, chạy lại trên `product__1024x900.html` (có pre-capture):

| Đại lượng | Giá trị đo |
|---|---|
| `guardCensus` | 25 ứng viên, **0** khớp `TRACKS` ⇒ `guardNodes = 0`, `pinnedMovers` rỗng, `stillMovingAfterGuard = null` |
| `passComparison` | `fingerprintsEqual = true` trên fingerprint thật (`sectionCount 4, docHeight 2855, scrollWidth 1009, imageCount 25, imageSetHash 781eaf42, imageSetSize 25, textHash fcdcd7a3, textLength 3663`) |
| Nhịp 400 / 4000 / 40000 ms | 1 fingerprint khác nhau; cặp liên tiếp khớp 29/29, 11/11, 2/2 |
| Bộ đếm ghi | `pinStyleWrites 0`, `foreignStyleWrites 8` (một lần, không tăng giữa các mẫu), `classWrites 0` |

⇒ Trên fixture này guard **không hoạt động** nên kết luận về V3 vẫn để ngỏ; nhưng fingerprint thì ổn định thật (giờ đã đọc đúng khoá) và hai pass chuẩn khớp nhau.

**Phép đo quyết định còn lại:** chạy lại đúng luồng compare thật trên tập rút gọn 6 leg (4 leg `content-changed` + 2 leg identity-drift của bộ r2), dùng `.canary/tools/stage-compare-subset.mjs` để dựng input từ chính capture của run4 và `theme-fidelity.mjs compare` với `--out .canary/theme-fidelity-repro1/out1`. Nếu có leg rớt, artifact mới sẽ mang `settlePasses` (V1 đã land) và chỉ đích danh khoá nào đổi.

**Hiệu lực thật của V4 trên dữ liệu run4** (chạy `compareIdentityFields` + `isSymmetricIdentityDrift` mới trên `pinned`/`measured` của 12 leg drift):

| Bộ | Leg drift | Đối xứng | Bất đối xứng |
|---|---|---|---|
| r2-vs-subject | 7 | **7** (`docHeight` cùng độ lớn hai phía: 489 / 535 / 437 / -106 / -10 / -10 / 808) | 0 |
| r1-vs-subject | 5 | 0 | **5** (magnitude hai phía lệch nhau và ngược dấu: 61 vs -106, 9 vs không đổi, 1439 vs -10, 1836 vs 808; thêm `widgetNodes` chỉ trôi một phía) |

⇒ Con số "7 leg drift đối xứng" của winner được tái lập độc lập, và 5 leg còn lại đúng là bất đối xứng nên vẫn phải từ chối. V4 có hiệu lực thật trên dữ liệu, không phải suy đoán.

## Chốt nhánh (2026-09-11)

**Tái hiện cô lập được lỗi.** Chạy lại đúng luồng compare thật trên 6 leg rút gọn (`.canary/theme-fidelity-repro1/out1`, dựng input bằng `stage-compare-subset.mjs` từ capture của run4):

```
404@1024x900 PASS 0%   |  404@1440x900 PASS 0%  |  cart@1024x900 PASS 0%
product@1024x900 PASS 0% | article@1024x900 INCONCLUSIVE | search@390x844 INCONCLUSIVE
```

Hai leg rớt chính là hai leg content-nặng, và artifact mới (nhờ V1) ghi được `settlePasses` đủ 3 pass. Ba pass của `article@1024x900` (phía reference):

| Pass | settled | churn | sections | docHeight | imageSetHash | textHash |
|---|---|---|---|---|---|---|
| 1 | true | 0 | 9 | 4807 | `d1ca897a` | `520271e4` |
| 2 | true | 0 | 9 | 4807 | `cf4d518b` | `520271e4` |
| 3 | true | 0 | 9 | 4807 | `50e2ba3b` | `520271e4` |

Mọi thành phần đều tĩnh và bằng nhau; **chỉ `imageSetHash` đổi ở cả ba pass**, ba giá trị khác nhau. `chromeProbe` chỉ đích danh vùng di chuyển: `#fake-order-popup` (rect `-340,765` → `-340,4632` → `20,4632`) — widget thông báo "đơn hàng ảo" tự chạy.

**Cơ chế (đọc code để xác nhận, không suy đoán):** `imageSetHash` băm `currentSrc|naturalWxH|rect(x, y+scrollY, w, h)|complete` của mọi `img`. Guard `pinned` **dò lại mover ở mỗi pass** (7 vòng × 800ms) rồi ghim theo *pha hiện tại* của widget. Vì cửa sổ dò phụ thuộc pha, mỗi pass ghim một tập node/ một hình học khác → chính bộ đo tạo ra chuyển động mà nó rồi từ chối. Trong một pass thì trang tĩnh thật (12/12 mẫu bằng nhau ở nhịp 4s, 2/2 ở 40s, `probeDelta` = 0).

**Bác bỏ từng nhánh:**

- **V2b (nhịp/K pass) — bác bỏ.** Ở nhịp 4s và 40s fingerprint bất động tuyệt đối; ba pass ghi ra ba giá trị khác nhau nên "chấp nhận bất kỳ cặp liên tiếp khớp" không có cặp nào để khớp.
- **V2a (nới vị từ theo delta ổn định) — không chọn.** Nới cổng để chấp nhận trang còn động nghĩa là đem so pixel hai khung ở hai pha widget khác nhau: PASS/MISMATCH sau đó không còn đo nội dung. Trang đã chứng minh là tĩnh trong trạng thái đóng băng, nên không có lý do hạ thấp tiêu chuẩn.
- **V3 (dựng `pinned` một lần cho mỗi document) — chọn, và đã chứng minh trên bản tái hiện.** Handle `window.__antifanPinnedGuard` giữ pin set + observer + snapshot; pass sau chỉ gọi lại `applyAll()`.

**Bằng chứng trước/sau trên đúng document đó** (`probe-fingerprint-cycle.mjs`, cùng prologue pre-capture):

| | `pass0-vs-pass1` | `changedKeys` |
|---|---|---|
| Trước khi vá | `false` | `imageSetHash` |
| Sau khi vá | `true` | (không) |

Kiểm chứng end-to-end: chạy lại tập 6 leg với `--out .canary/theme-fidelity-repro1/out2` (kết quả ghi ở phase-02).
