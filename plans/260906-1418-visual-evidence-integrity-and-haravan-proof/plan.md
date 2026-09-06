---
title: "visual-evidence-integrity-and-haravan-proof"
description: "Fail-closed visual capture + evidence contract: coordinate space, mask ledger, capture coherence, canonical receipts, composed settle, evaluator integration, promoted baselines; 25 discriminating tests (V-01..V-25)."
status: in-progress
priority: P0
effort: "M"
tags: [visual-evidence, verification, audit-v5, fail-closed]
created: 2026-09-06
source_audit: "E:/Download/AntiFan-Visual-Verification-Codebase-Adversarial-Audit-v5-2026-09-06.md"
head_at_audit: dd33cf67828613ac4401c19f1d6676d9d7c56669
---

# visual-evidence-integrity-and-haravan-proof

## Overview

Thi hành hợp đồng bằng chứng thị giác fail-closed theo Audit v5. AntiFan không cần
thuật toán pixel thông minh hơn; cần đúng không gian toạ độ, mask fail-closed,
giao dịch chụp gắn kết hai nguồn, receipt backend chuẩn, settle gate tổ hợp, và
nạp `MetricSample[]` vào `VerificationEvaluator` (cơ quan phán quyết duy nhất).

## Brainstorm contract (reused)

- **Outcome:** Visual compare trở thành bằng chứng tất định: toạ độ CSS→raster chính xác
  (crop/scroll/DPR/zoom), mask fail-closed + độc lập từng bên + trần tỷ lệ, giao dịch
  chụp hai nguồn có rào cản identity, receipt capture chuẩn (backend, DPR, zoom,
  viewport), settle gate tổ hợp, baseline thăng hạng SHA-256, và dòng `MetricSample[]`
  vào `VerificationEvaluator`. Ma trận V-01..V-25 + 18-point freeze checklist xanh
  trước khi tuyên bố đóng băng.
- **Constraints:** `VerificationEvaluator` là thẩm quyền phán quyết duy nhất
  (`VERIFIED/REJECTED/PARTIAL/INCONCLUSIVE`); primitive visual chỉ phát số liệu/receipt
  hoặc ném `CapabilityError`; KHÔNG AI/CV (OCR/CLIP/YOLO); KHÔNG nới lỏng
  `ArtifactStore.readBytesById` (runId/attemptId/projectId/workspaceId) — baseline liên
  attempt chỉ qua `VisualBaselineRef` SHA-256; KISS: tối đa 3 module mới dưới
  `src/main/verification/`; Electron thật tối thiểu (Tier 3 ≤ 6 test); pure unit
  < 100ms; mock integration < 1s.
- **Non-goals:** Không engine phán quyết song song; không đổi `computePixelDiff`
  thuật toán; không distributed lock manager; không mở rộng generic browser sprawl;
  không xây Sapo sync driver mới trước Phase 7 (cân nhắc theo bằng chứng hiện hữu
  `haravan-sync-barrier.ts`); không đổi hành vi public contract MCP/IPC ngoài phạm vi
  đã khai báo ở từng phase. HOÃN TƯỜNG MINH (ngoài freeze §25/26/31, không nằm trong
  phase nào): state-aware capture RAW/STATIC/HOVER/FOCUS/OPEN (Audit §21/§23.11) và
  region/source attribution (§23.13) — P1, tiến hành sau loạt này.
- **Acceptance:** Mỗi phase khoá nhóm V-test tương ứng (liệt kê trong phase file);
  toàn bộ suite `npm test` xanh (gồm runtime-fullpage-evidence, verification-evaluator,
  browser-control-port, capability-catalogue); `tsc --noEmit` sạch; 18/18 freeze
  checklist; thứ tự ưu tiên Sapo-first chỉ áp dụng ở Phase 7.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Mask coordinate space + fail-closed ledger + normalization transaction (P0) | P0 |
| 2 | Capture coherence transaction + joint tab lock (P0/P1) | P0 |
| 3 | Canonical verification capture backend + state receipt (P1) | P1 |
| 4 | Composed settle barrier (network/fonts/images/DOM) (P1) | P1 |
| 5 | Visual metrics into VerificationEvaluator + structural primacy (P1) | P1 |
| 6 | Promoted baseline authority (SHA-256, workspace-scoped) + determinism (P1) | P1 |
| 7 | Sapo-first live workflow proof V-25 (P2) | P2 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Mask space & fail-closed](./phase-01-mask-space-and-fail-closed.md) | Done |
| 2 | [Phase 2: Capture coherence transaction](./phase-02-capture-coherence-transaction.md) | Pending |
| 3 | [Phase 3: Canonical capture receipts](./phase-03-canonical-capture-receipts.md) | Pending |
| 4 | [Phase 4: Composed settle barrier](./phase-04-composed-settle-barrier.md) | Pending |
| 5 | [Phase 5: Evaluator integration & structural primacy](./phase-05-evaluator-integration-and-structural-primacy.md) | Pending |
| 6 | [Phase 6: Promoted baseline authority](./phase-06-promoted-baseline-authority.md) | Pending |
| 7 | [Phase 7: Sapo-first live workflow proof](./phase-07-sapo-live-workflow-proof.md) | Pending |

Ghi chú ownership: Phase 5 là integration owner cuối cho `BrowserControlPort.visualCompare`
(Phase 1-4 sửa theo phần, Phase 5 chốt toàn cục + rà mọi callers).

## Success Criteria

- [x] V-01..V-08, V-11, V-12, V-23 xanh (Phase 1) — unit 31/31, Tier 2 8/8, regress 26/26
- [ ] V-13, V-14, V-15 xanh (Phase 2)
- [ ] V-19, V-20, V-21 xanh (Phase 3)
- [ ] V-16, V-17, V-18 xanh (Phase 4)
- [ ] V-09, V-10 xanh (Phase 5)
- [ ] V-22, V-24 xanh (Phase 6)
- [ ] V-25 xanh (Phase 7) — thiếu credential/preview thật → phase giữ BLOCKED, không tính hoàn thành
- [ ] 18/18 freeze checklist (Audit v5 §26)
- [ ] Toàn bộ test suite + `tsc --noEmit` sạch; `VerificationEvaluator` là thẩm quyền duy nhất; `ArtifactStore` không đổi ràng buộc

<!-- slug: visual-evidence-integrity-and-haravan-proof -->