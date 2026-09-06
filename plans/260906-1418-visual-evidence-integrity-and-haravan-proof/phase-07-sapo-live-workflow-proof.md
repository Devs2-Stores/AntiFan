---
title: "Phase 7: Sapo-first live workflow proof"
status: todo
---

# Phase 7: Sapo-first live workflow proof

## Overview

V-25 (Audit v5 §25) — proof end-to-end thật định hướng Sapo:
edit theme fixture → CLI sync attestation → preview `documentGeneration` advance →
settle gate → capture → compare → `MetricSample[]` → evaluator verdict → evidence
receipt. Nếu thiếu prerequisite (store/credentials/preview) → phase BLOCKED với
thiếu chính xác được nêu, KHÔNG làm proof giả.

## Requirements

- [ ] R1. Scout hiện hữu: `scripts/smoke-theme-golden-live.cjs`,
  `scripts/smoke-visual-compare.cjs`, `scripts/run-theme-golden-live-proof.cjs`,
  `src/main/qa/haravan-sync-barrier.ts` — tái sử dụng, không xây mới song song.
- [ ] R2. Script `scripts/smoke-visual-evidence-live.cjs` (hoặc mở rộng golden-live):
  fixture theme → sync attestation → chờ documentGeneration advance →
  `CaptureSettleGate` → capture (canonical backend) → compare (mask fail-closed +
  coherence) → `MetricSample[]` → `VerificationEvaluator` → VERIFIED/REJECTED +
  receipt in ra. V-25 EVIDENCE BẮT BUỘC từ đường sync Sapo thật (Sapo CLI
  event/output hoặc preview store Sapo); chạy qua `haravan-sync-barrier` chỉ là
  chạy phụ trợ, KHÔNG bao giờ tính là evidence V-25/freeze #18.
- [ ] R3. Không hardcode credential; đọc từ env/CLI hiện hữu; không commit secret.
- [ ] R4. Xác định store identity qua kiểm tra an toàn (storefront URL thật, không
  production tuỳ tiện) — bám bất biến "StoreIdentityGuard" nếu có sẵn.

## Implementation Steps

1. Kiểm tra prerequisites live (script hiện hữu đọc config gì, có preview URL/credential không).
2. Viết/extend smoke script nối toàn bộ gate ở Phase 1-6.
3. Chạy Tier 3 thật, lưu receipt + log làm evidence (không tự nhận PASS giả).

## Todo

- [ ] Scout prerequisites (golden-live scripts, Sapo/Haravan CLI evidence, preview URL)
- [ ] Smoke script end-to-end V-25
- [ ] Chạy live proof, thu evidence receipt
- [ ] Checklist 18/18 freeze hoàn tất từ evidence

## Success Criteria

- V-25 xanh: receipt + evidence thật (log/artifact lưu làm chứng) — điều kiện duy nhất
  để phase ĐẠT — freeze #18
- Nếu thiếu prerequisite (credential/preview URL/CLI sync evidence): phase KHÔNG đạt;
  giữ trạng thái terminal blocker BLOCKED với đúng thiếu sót được nêu, V-25 vẫn pending
  — không có proof giả, không tính BLOCKED là thành công
- Freeze checklist 18/18 có bằng chứng tương ứng từng mục (mục 18 phụ thuộc V-25 xanh)