---
title: "Phase 5: Evaluator integration & structural primacy"
status: todo
---

# Phase 5: Evaluator integration & structural primacy

**INTEGRATION OWNER:** Phase này là chủ tích hợp cuối của
`BrowserControlPort.visualCompare` — rà mọi callers (tool port, MCP, smoke scripts),
chốt contract cuối, đảm bảo tất cả trường mới từ Phase 1-4 hội tụ đúng chỗ.

Ranh giới thẩm quyền (Audit v5 §16, §25 V-09/V-10 + checklist 13-14): visualCompare
chỉ phát `MetricSample[]` + receipt; `VerificationEvaluator` là cơ quan phán quyết
duy nhất. Structural primacy: mask che paint động KHÔNG được che hồi quy cấu trúc
(geometry/cardinality/overflow).

## Requirements

- [ ] R1. `verification-contract.ts`: hằng số metric visual chuẩn
  `visual.pixel_mismatch_pct`, `visual.dimensions_match`,
  `visual.capture_state_compatible`, `visual.mask_resolution_complete`,
  `visual.geometry_within_tolerance`, `visual.cardinality_match`,
  `visual.settle_complete` (producer: Phase 4 receipt); `visual.critical_regions_pass`
  ĐƯỢC HOÃN (chưa có producer) — ghi chú deferred trong contract + type
  `VisualEvidenceReceipt` (tinh gọn, dùng `MetricSample`, `ProofObligation` sẵn có).
- [ ] R2. visualCompare phát `metricSamples: MetricSample[]` + `receipt`; các trạng
  thái operational (`MASK_RESOLUTION_FAILED`, `SETTLE_INCOMPLETE`,
  `CAPTURE_STATE_MISMATCH`, `TARGET_STALE`, `RESAMPLE`, `RESOURCE_FAILURE`) là
  dữ liệu cho evaluator — không tự ban verdict nghiệp vụ. Trường `verdict` hiện hữu
  (`STRUCTURAL_TRUNCATION_DETECTED`, `match`) giữ vai trò operational error flag,
  không thay thế evaluator — ghi chú tương thích ngược, không phá callers.
- [ ] R3. Structural samples: dùng `src/main/verification/visual-region.ts` hiện hữu
  để lấy geometry/cardinality/overflow cho region quan trọng; sinh mẫu
  `visual.geometry_within_tolerance`, `visual.cardinality_match`.
- [ ] R4. Evaluator: mở rộng nhận dòng mẫu visual + structural (KHÔNG đổi verdict
  semantics hiện hữu; chỉ thêm obligations/expected-tolerance mẫu).
- [ ] R5. V-09/V-10: mask che child nhưng parent +100px / grid 4→3 → `REJECTED`
  dù paint diff = 0%.

## Implementation Steps

1. Bổ sung contract (metric constants + receipt types).
2. visualCompare: sinh metricSamples từ diff + mask + structure + captures.
3. Evaluator tests mở rộng (V-09, V-10) + integration test end-to-end mock.
4. Rà callers của visualCompare (tool port, mcp, smoke scripts) — kiểm tra
  trường mới không phá parse.

## Todo

- [ ] Metric constants + VisualEvidenceReceipt types (verification-contract.ts)
- [ ] visualCompare sinh MetricSample[] (pixel/dimensions/mask/structure)
- [ ] Structural samples qua visual-region (geometry, cardinality, overflow)
- [ ] Evaluator: obligations mẫu visual + tolerance
- [ ] Backward-compat ghi chú trường verdict operational
- [ ] Rà callers (browser-control-port tests, runtime-fullpage, smoke scripts)
- [ ] Tests: V-09, V-10 + evaluator unit

## Success Criteria

- V-09 geometry hidden behind mask → `REJECTED` (Tier 2) — freeze #13/#14
- V-10 cardinality 4→3 masked → `REJECTED` (Tier 2) — freeze #13/#14
- Evaluator semantics cũ không đổi (suite cũ xanh)
- visualCompare không còn ban verdict nghiệp vụ (chỉ operational flags + samples)
- `tsc --noEmit` sạch