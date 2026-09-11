---
title: "haravan-fidelity-measurement-flake-and-publish-gate"
description: "Hạ flake mỗi leg của campaign theme-fidelity xuống ≤1/400, đóng cổng publish để REFUSED cấu trúc không lọt, và siết chain-of-custody artifact."
status: in-progress
priority: P0
effort: "3–5 ngày"
tags: [theme-fidelity, canary, settle-gate, evidence-provenance]
created: 2026-09-11
---

# haravan-fidelity-measurement-flake-and-publish-gate

## Overview

Campaign `.canary/theme-fidelity-run4/` kết thúc `INCOMPLETE`: 42 leg bị AND, chỉ 1 leg PASS. Reframing đã được chốt bởi vòng `ak:problem-solving --ultra` (winner `agent://PSRun4`): **trang đã settle thật (28/28 leg `content-changed` có 5/5 thành phần `true`, `churn=0`), lỗi nằm ở tiêu chí so giữa hai lần đo và ở nhịp lấy mẫu chưa hiệu chuẩn** — không phải ở theme.

Đại lượng nghiệm thu bị thay: không phải "số leg PASS" mà là **flake/leg**. Với 42 leg AND, P(publish) ≥ 90% đòi hỏi flake mỗi leg ≤ 1/400 (hiện 41/42).

Kế hoạch này thi hành work list V0–V6 + 6 caveat của winner. Hai boundary không đổi:

- Theme live `1001510509` **không bao giờ** bị ghi. Mọi thao tác theme chỉ trên bản copy `1001512581`.
- Workstream "95 setting chưa khai + 6 asset thiếu" trong `E:\Work\customizes\Phukienmaymoc` là **product line khác** (caveat 5). Không nằm trong plan này; nó là điều kiện để kết quả publish *có nội dung*, không phải để cổng publish *đúng*.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Đo chu kỳ trôi fingerprint + xác định thủ phạm (nhịp lấy mẫu / guard tự sửa trang / trôi thật) bằng một phép đo ~3 phút trên replay fixture có sẵn | P0 |
| 2 | Hạ flake mỗi leg: sửa vị từ hoặc nhịp settle, cắt vòng phản hồi của guard `pinned`, tách trục identity khỏi câu hỏi fidelity | P0 |
| 3 | Đóng cổng publish: `checks.status === 'REFUSED'` phải chặn `COMPLETE`; mint epoch/instrument revision vào artifact để không trộn thế hệ | P0 |
| 4 | Chain-of-custody: 6/6 artifact `report.json` ghim sha256 phải hash lại được (CRLF→LF trong hàm hash) | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Đo quyết định](./phase-01-do-quyet-dinh.md) | In progress |
| 2 | [Phase 2: Vá gate settle](./phase-02-va-gate-settle.md) | Pending |
| 3 | [Phase 3: Custody và cổng publish](./phase-03-custody-va-cong-publish.md) | Pending |
| 4 | [Phase 4: Nghiệm thu campaign run5](./phase-04-nghiem-thu-run5.md) | Pending |

## Success Criteria

- [ ] Kill-test/V0 chạy được: có `fingerprintFields` theo từng mẫu ở nhịp 0.4s / 4s / 40s trên `compare/r2-vs-subject/replay/reference/product__1024x900.html`, kèm số lần ghi của `applyAll()` giữa các pass.
- [ ] Nhánh V2 được chọn bằng dữ liệu, không bằng suy đoán (V2a đổi vị từ / V2b đổi nhịp / V3 cắt vòng phản hồi guard), và mỗi nhánh có falsifier ghi trong phase file.
- [ ] `grep -rl settlePasses .canary/theme-fidelity-run*/compare/` ≥ 1 và mỗi doc `content-changed` có `settlePasses` dài 3.
- [ ] Leg `IDENTITY_DRIFT` đối xứng không còn làm leg rớt; drift bất đối xứng vẫn INCONCLUSIVE.
- [ ] `checks.status === 'REFUSED'` ⇒ `status !== 'COMPLETE'` (có unit test chứng minh vị từ lật).
- [ ] 6/6 artifact report ghim sha256 verify được bằng hàm hash chuẩn hoá LF.
- [ ] Campaign run5 chạy trong thư mục riêng, mọi artifact mang `instrumentRevision` + `epoch`, và số leg PASS/flake/leg được đối chiếu với dự đoán của phase file.

## Boundaries

- Không viết vào theme live; không `hrv theme push/publish`.
- Không sửa `src/**` (product plane) trong plan này — trừ khi một thay đổi `.canary`/`scripts/lib` bắt buộc phải có mirror; mọi mirror như vậy phải được nêu rõ ở phase file.
- Không thêm `.gitattributes` renormalize `.canary/**` (198 file tracked, rủi ro làm bẩn cây làm việc); chuẩn hoá nằm trong hàm hash.

## Evidence Map

| Việc | Bằng chứng nguồn |
|---|---|
| 28/28 leg `content-changed` settled, churn=0 | `agent://PSRun4` §2(a); `.canary/theme-fidelity-run4/compare/*/*.json` |
| 7/7 drift đối xứng cùng biên độ | `agent://PSRun4` §2(b) |
| `settlePasses`/`fingerprintFields` vắng trong run4 | `grep -rl` trên `.canary/theme-fidelity-run4/compare/` = 0 |
| REFUSED lọt cổng publish | `theme-fidelity-run.mjs:1939,1909,1944`; `structuralFindings.checksStatus=REFUSED`, `refused=true`, `gaps=[]` |
| 2/6 artifact hash mismatch do CRLF | 360 CRLF trong `compare/*/index.json`, `core.autocrlf=true`, không có `.gitattributes` |

<!-- slug: haravan-fidelity-measurement-flake-and-publish-gate -->
