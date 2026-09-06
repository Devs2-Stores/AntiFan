---
title: "Phase 7: Sapo-first live workflow proof"
status: blocked
---

# Phase 7: Sapo-first live workflow proof

## Overview

V-25 (Audit v5 §25) — proof end-to-end thật định hướng Sapo:
edit theme fixture → CLI sync attestation → preview `documentGeneration` advance →
settle gate → capture → compare → `MetricSample[]` → evaluator verdict → evidence
receipt. Nếu thiếu prerequisite (store/credentials/preview) → phase BLOCKED với
thiếu chính xác được nêu, KHÔNG làm proof giả.

## Requirements

- [x] R1. Scout hiện hữu: `scripts/smoke-theme-golden-live.cjs`,
  `scripts/smoke-visual-compare.cjs`, `scripts/run-theme-golden-live-proof.cjs`,
  `src/main/qa/haravan-sync-barrier.ts` — tái sử dụng, không xây mới song song.
- [ ] R2. Script `scripts/smoke-visual-evidence-live.cjs` và runner
  `scripts/run-visual-evidence-live-proof.cjs`: fail-closed trước Chromium khi thiếu
  prerequisites, xuất sanitized blocker report, không phát receipt giả; V-25 EVIDENCE
  BẮT BUỘC từ đường sync Sapo thật (Sapo CLI event/output hoặc preview store Sapo).
- [ ] R3. Không hardcode credential; kiểm tra hiện diện qua presence-only; không commit secret (Transcript đã xuất hiện biến môi trường chứa credential từ lệnh env trước đó; yêu cầu rotate ngay, giữ pending).
- [ ] R4. Xác định store identity qua kiểm tra an toàn — không production tuỳ tiện.

## Implementation Steps

1. Kiểm tra prerequisites live (script hiện hữu đọc config gì, có preview URL/credential không).
2. Viết/extend smoke script nối toàn bộ gate ở Phase 1-6.
3. Chạy Tier 3 thật, lưu receipt + log làm evidence (không tự nhận PASS giả).

## Todo

- [x] Scout prerequisites (golden-live scripts, Sapo/Haravan CLI evidence, preview URL)
- [x] Blocker probe xác thực thiếu sót prerequisites (Sapo CLI, preview URL) và xuất sanitized blocker report
- [ ] Smoke script end-to-end V-25 chạy qua live Sapo sync thật
- [ ] Chạy live proof, thu evidence receipt (BLOCKED: Thiếu Sapo Theme CLI watcher & live preview URL)
- [ ] Checklist 18/18 freeze hoàn tất từ evidence (mục 18 phụ thuộc V-25 xanh)

## Success Criteria

- V-25 xanh: receipt + evidence thật (log/artifact lưu làm chứng) — điều kiện duy nhất
  để phase ĐẠT — freeze #18
- Nếu thiếu prerequisite (credential/preview URL/CLI sync evidence): phase KHÔNG đạt;
  giữ trạng thái terminal blocker BLOCKED với đúng thiếu sót được nêu, V-25 vẫn pending
  — không có proof giả, không tính BLOCKED là thành công
- Freeze checklist 18/18 có bằng chứng tương ứng từng mục (mục 18 phụ thuộc V-25 xanh)