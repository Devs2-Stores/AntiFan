---
phase: 4
title: "Verified learning — outcome producer, không self-promote"
status: done
priority: P0
effort: ""
dependencies: [3]
---

# Phase 4: Verified learning — outcome producer, không self-promote

## Overview
Locked contract item: C7. Block 2. Ứng với upstream phase 13 ("Verified learning and recovery") và phần "learning trace" của MASTER UPGRADE.

Vấn đề đo được: `observations` = **0**, tức **không có producer nào ghi outcome thô**. Vòng học vì thế không khép kín: có chỗ ghi case/candidate nhưng không có chuỗi outcome → case → candidate → adjudication có liên kết bằng chứng.

## Requirements
### R1 — Có producer thật cho `observations`
- Một đường thật ghi observation thô khi task kết thúc (kèm `source`, `kind`, `payload`, `ingestedAt`).
- Không được để bảng tồn tại mà không ai ghi — đó chính là trạng thái hiện tại.

### R2 — `ingestOutcome` phải liên kết, không chỉ chèn
- Hiện `ingestOutcome` chèn `cases` + `candidates` nhưng `evidenceJson` **chỉ chứa `verificationRef`**, không gắn unit/evidence, không ghi `observations`, không gắn experience node/edge.
- Phải gắn: case ↔ unit, candidate ↔ evidence, và ghi observation tương ứng.

### R3 — Không self-promotion
- Candidate do máy sinh **không** được tự chuyển sang trạng thái đã duyệt. Giữ đúng luật `adjudications.scope` đã sửa ở session trước (`production` | `acceptance-test`), và authority phải tường minh.
- Kiểm chứng promote/reject/rollback chỉ trong acceptance store với authority test — **không** giả mạo approval production.

### R4 — Rollback chứng minh được
- `recordRegression` hiện chỉ **nhận** `replayResult`, **không** có replay engine. Phải có đường replay thật hoặc ghi rõ giới hạn và không tuyên bố quá mức.
- Chứng minh rollback khôi phục được trạng thái tri thức trước đó.

## Related Code Files
- `packages/super-core/src/index.ts` — `:286` `ingestOutcome`, `:300` `adjudicate`, `:337` `snapshot`, `:349` `rollback`, `:657` `recordRegression`, `:438`/`:445` `recordExperienceNode`/`Edge`.
- `packages/super-core/src/schema.ts` — `:209` `observations`, `:310` `regressions`, `:310` `phase_gates`.
- `scripts/antifan-core.cjs` — `outcome`, `adjudicate`, `snapshot`, `rollback`.

## Implementation Steps
1. Trace mọi nơi ghi case/candidate hiện có để không tạo producer thứ hai chồng lấn.
2. Viết producer observation trên đường kết thúc task; gắn unit + evidence.
3. Sửa `ingestOutcome` để gắn liên kết đầy đủ và ghi observation trong cùng transaction.
4. Thêm test khẳng định không self-promote (candidate máy sinh vẫn `PENDING`).
5. Kiểm chứng promote/reject/rollback trong acceptance store có scope tường minh.
6. Ghi rõ giới hạn của replay nếu engine chưa có; **không** tuyên bố regression đã chạy khi chưa chạy.

## Contract and Test Matrix
- [ ] `observations` > 0 do producer thật ghi, không phải seed tay.
- [ ] Outcome → case → candidate có liên kết evidence kiểm tra được.
- [ ] Candidate máy sinh giữ `PENDING` — test **fail** nếu có đường tự promote.
- [ ] Promote/reject/rollback chứng minh được trong `acceptance-test` scope.
- [ ] `regressions` không bị ghi `PASS` khi chưa có replay thật.
- [ ] Không test nào assert wiring/source text.

## Success Criteria
- [ ] R1-R4 delivered và evidence linked.
- [ ] Không có self-promotion; `scope` giữ nguyên bất biến.
- [ ] Không mục nào chuyển thành documentation-only.

## Risk Assessment
- Đây là vùng nhạy cảm nhất về "an toàn tri thức": một đường tự promote sẽ làm hỏng toàn bộ giá trị của Core. Health abort ở phase 1 phải bắt được nỗ lực nới tiêu chí ở đây.
- Replay engine chưa tồn tại → nếu không xây được trong ngân sách, ghi `NOT_VERIFIED` + blocker, **không** hạ xuống "chạy được một phần".
