---
title: "Phase 2: Vá gate settle (V1–V4)"
status: complete
---

# Phase 2: Vá gate settle (V1–V4)

## Overview

Sửa đúng cơ chế đã được chứng minh ở Phase 1, cộng hai việc không phụ thuộc dữ liệu V0 (bằng chứng từng pass ra đĩa; tách trục identity).

## Requirements

- [x] V1: `doc.reason` không còn cắt ngang pass #3; `settlePasses` xuất hiện trong artifact sau lần compare kế tiếp.
- [x] V2: đúng **một** trong hai cơ chế được chọn bằng số đo Phase 1, không làm cả hai.
- [x] V3: guard `pinned` không còn tái tạo mỗi pass khi bộ đo tự sửa trang (chỉ khi Phase 1 chỉ ra `styleWrites > 0`).
- [x] V4: drift **đối xứng** không còn làm leg rớt; drift **bất đối xứng** giữ nguyên hành vi từ chối.
- [x] Không đổi ngữ nghĩa `mismatchPercentage`, `POST_COMPARE_MOTION`, `checkServedTheme`.

## Implementation Steps

1. V1 (đã giao `V4Identity`): nâng bound `slice(0, 600)` lên 2048 kèm comment lý do.
2. V4 (đã giao `V4Identity`): `compareIdentityFields` trả thêm `symmetric`/`magnitude`; cổng drift phân loại đối xứng ⇒ ghi `provenanceDrift` rồi đi tiếp; bất đối xứng ⇒ giữ `INCONCLUSIVE`; thêm evidence `crossSideIdentity`.
3. V2 theo nhánh:
   - **V2b** (nhịp): giữ K ≥ 5 pass gần nhất trong `scripts/lib/settle-contract.mjs` `decideSettle` và chấp nhận **bất kỳ** cặp liên tiếp khớp, không chỉ cặp cuối; kèm `canary-settle.mjs` giãn nhịp thử.
   - **V2a** (vị từ): đổi tiêu chí sang **delta ổn định** — tập khoá chuyển động ổn định giữa các cặp và chủ sở hữu chuyển động được `chromeProbe` gọi tên.
4. V3: dựng guard một lần cho mỗi tab rồi truyền vào, thay vì tái tạo trong mỗi `settleAndMeasure`.
5. Unit test cho `decideSettle` ở cả hai nhánh (test thuần, không cần browser).

## Todo

- [x] V1 bound 2048 (agent `V4Identity`)
- [x] V4 symmetric/asymmetric + crossSideIdentity (agent `V4Identity`)
- [x] V2: **không sửa** — đo được là không cần (xem dưới)
- [x] V3: dựng `pinned` một lần cho mỗi document
- [x] Unit test `decideSettle` xanh

## V2 — đo rồi mới quyết, và kết luận là không sửa

Nhánh V2 (vị từ delta ổn định **hoặc** nhịp K pass) đã được đo trước khi viết code, bằng bản tái hiện cô lập và bằng chính 3 pass của artifact mới:

- Nhịp: `SETTLE_STATE_EXPR` ở nhịp 4s cho 12/12 cặp liên tiếp bằng nhau, ở nhịp 40s cho 2/2 — trong khi 3 pass chuẩn của cùng document lại ra 3 `imageSetHash` khác nhau. Nhịp không phải nguyên nhân ⇒ **V2b vô căn cứ**: "chấp nhận bất kỳ cặp liên tiếp khớp" không có cặp nào để khớp.
- Vị từ: nới cổng để nhận một trang còn động sẽ khiến phép so pixel đối chiếu hai khung ở hai pha widget khác nhau; PASS/MISMATCH mất nghĩa. Trang đã chứng minh là tĩnh trong trạng thái bị ghim (48s mẫu không đổi) ⇒ **V2a bị loại vì đánh đổi sai**: nó hạ flake bằng cách hạ tiêu chuẩn.
- Không có thay đổi nào vào `scripts/lib/settle-contract.mjs`; `composeSettleVerdict`/`decideSettle` giữ nguyên ngữ nghĩa.

## V3 — đã sửa, kèm bằng chứng trước/sau

`.canary/tools/canary-settle.mjs` (IIFE `pinned`):

- Thêm handle cấp document `window.__antifanPinnedGuard = { key, guard, guardNodes, layoutNodes, snapshots, observer, applyAll, beforeGuard, restore }`; pass đầu dựng, các pass sau chỉ `applyAll()` lại rồi trả `{ ...guard, reused: true, stillMovingAfterGuard }`.
- `restoreGuardState(state)` thay cho closure cục bộ: `window.__antifanGuardRestore` giờ bám handle sống, nên `releaseSettleOverrides` vẫn hồi phục đúng snapshot của pass đã ghim (không mất pin).
- Không tạo observer thứ hai; không dò lại mover; điều hướng sang document khác thì `key` khác ⇒ dựng lại từ đầu.

Bằng chứng (`article__1024x900.html`, cùng prologue pre-capture): `pass0-vs-pass1` `equal=false changedKeys=imageSetHash` **trước** khi vá → `equal=true changedKeys=(none)` **sau** khi vá.

## V3 — kiểm chứng end-to-end trên 6 leg thật (trước/sau)

Bộ tái hiện `.canary/theme-fidelity-repro1` (6 leg lấy từ capture của run4, 4 leg `content-changed` + 2 leg `identity-drift`), cùng input, hai lần chạy cùng instrument trừ bản vá V3:

| Leg | `out1` (trước V3) | `out2` (sau V3) | Cơ chế đã đổi |
|---|---|---|---|
| `404@1024x900` | PASS | PASS (0%) | không đổi |
| `404@1440x900` | PASS | PASS (0%) | không đổi |
| `cart@1024x900` | PASS | PASS (0%) | không đổi (thêm `provenanceDrift` đối xứng `widgetNodes`) |
| `product@1024x900` | PASS | PASS (0%) | không đổi |
| `article@1024x900` | **INCONCLUSIVE** (`content-changed-between-passes`) | **PASS (0%)** | `imageSetHash` d1ca897a→cf4d518b→50e2ba3b → ổn định |
| `search@390x844` | **INCONCLUSIVE** (`content-changed-between-passes`) | **PASS (0%)** | `imageSetHash` dab57fb7→e8e398a1→50570929 → ổn định |

Tổng: `out1` `pass=4 fail=0 inconclusive=2 notMeasurable=2` → `out2` `pass=6 fail=0 inconclusive=0 notMeasurable=0` (509s, `[theme-fidelity] compare COMPLETE`).

Điểm quan trọng nhất — **đây là bỏ từ chối giả, không phải nới phép đo**:

- Bốn leg PASS cũ giữ nguyên `mismatch=0%` và cùng chiều cao hai bên ⇒ bản vá không làm phép so pixel dễ dãi hơn.
- Hai leg từng bị từ chối nay chạy được phép so pixel **lần đầu** và cho `mismatchPercentage=0`, `dimensionsMatch=true`, `identityCoherent=true`, chiều cao hai bên bằng nhau (`article` 4807/4807, `search` 3690/3690 ở bản ghi của `out2` đo trên replay) ⇒ khác biệt duy nhất trước đây nằm ở **dấu vân tay của bộ đo**, không ở trang.
- `settlePasses` trong `out1` chỉ đúng thủ phạm: mọi pass đều `settled=true churn=0 sections`/`textHash` không đổi, chỉ `imageSetHash` đổi — đúng hệ quả của việc guard dò lại mover mỗi pass và ghim một tập node khác nhau, làm đổi lựa chọn `srcset` của ảnh. V1 (giữ `settlePasses` + `fingerprintFields`) là thứ đã gọi tên được thủ phạm này.
- `search` còn cho thấy pass #1 đo `docHeight=3690` rồi #2/#3 đo `3694`: chính guard cũ tạo ra dịch chuyển ở pass đầu.

## V3b — bằng chứng reuse đếm theo element (đóng góp review)

`reuseAfter[i]` vs `prior.beforeGuard[i]` là so theo chỉ số, sai khi DOM mọc/mất node giữa hai pass. Đã thay bằng `snapKeyed()` trả `Map(element → rect)` lưu ở `beforeGuardRects`; chỉ đếm element có rect trước-pin và lệch > 0.5px. Field `pinnedMovers`/`stillMovingAfterGuard`/`reused` giữ nguyên tên và shape; `composeSettleVerdict`/`decideSettle` không đọc field này (đã xác nhận ở `scripts/lib/settle-contract.mjs`), nên đây thuần là sửa chứng cứ.

## Falsifiers

- V2b được chọn mà `content-changed` của r2 không giảm: nếu ≥ 4 leg const-H vẫn chết với đúng mechanism cũ ⇒ nhịp không phải nguyên nhân, chuyển sang V2a/V3 và ghi lại.
- V4: nếu sau khi phân loại đối xứng mà leg vẫn INCONCLUSIVE với mechanism khác ⇒ phải nêu mechanism mới, không được im lặng đổi tên.

## Success Criteria

- `node --test --test-force-exit test/unit/theme-fidelity-identity.test.mjs` xanh.
- `node --test --test-force-exit test/unit/settle-contract*.test.mjs` (hoặc file test tương ứng) xanh.
- Báo cáo nêu rõ nhánh V2, số đo dùng để chọn, và dự đoán số leg sẽ dịch.
