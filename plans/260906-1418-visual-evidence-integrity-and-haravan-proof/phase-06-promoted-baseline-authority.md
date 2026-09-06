---
title: "Phase 6: Promoted baseline authority"
status: todo
---

# Phase 6: Promoted baseline authority

## Overview

Giải P1-3 (Audit v5 §12-13) KHÔNG bằng cách nới lỏng `ArtifactStore.readBytesById`
(runId/attemptId/projectId/workspaceId vẫn nguyên) mà qua cơ chế thăng hạng tường
minh: `VisualBaselineRef` phạm vi workspace/project, checksum SHA-256, chỉ đọc qua
authority; V-22 chéo attempt; V-24 tất định 3 lần chạy.

## Requirements

- [ ] R1. `src/main/verification/baseline-authority.ts`: `promote(sourceArtifactId,
  context, meta)` — đọc artifact qua `ArtifactStore.readBytesById` VỚI context hợp
  lệ (đúng run/attempt của artifact), tính SHA-256, ghi manifest bất biến
  (workspace-scoped, theo `StorageLocations`/cấu hình hiện hữu) + copy PNG; trả
  `VisualBaselineRef` `{ id, sha256, artifactRef, captureStateMini, promotedAt,
  workspaceId, projectId? }`.
- [ ] R2. `resolve(baselineRefId, projectId, workspaceId)` — xác minh sha256 file vs
  manifest trước khi dùng; sai lệch → `BASELINE_TAMPERED`.
- [ ] R3. visualCompare chấp nhận `baselineRef` (thay/ngoài `baselineScreenshotRef`);
  tải qua authority; capture-state mini (dpr/zoom/backend) phải tương thích (nối
  Phase 3 gate).
- [ ] R4. `ArtifactStore.ts` KHÔNG đổi dòng nào (assert trong test).
- [ ] R5. V-24: 3 lần chạy fixture tĩnh → receipt/verdict giống hệt, 0 style rác.

## Implementation Steps

1. Module baseline-authority (pure + fs).
2. Wire vào visualCompare + smoke scripts.
3. Tests: Tier 1 (authority manifest/sha256/tamper), Tier 2 (V-22), Tier 3 (V-24).

## Todo

- [ ] `promote()` — readBytesById hợp lệ + sha256 + manifest + copy PNG
- [ ] `resolve()` — verify checksum, BASELINE_TAMPERED khi lệch
- [ ] Capture-state mini trong ref (dpr/zoom/backend)
- [ ] visualCompare nhận baselineRef qua authority
- [ ] Test ArtifactStore không đổi ràng buộc
- [ ] Tier 1: authority tests; Tier 2: V-22; Tier 3: V-24 determinism

## Success Criteria

- V-22 baseline promote ở attempt A dùng được ở attempt B qua authority (Tier 2) — freeze #15
- Tamper file → `BASELINE_TAMPERED` (Tier 1)
- V-24 3-run: receipt/verdict đồng nhất, không leftover style (Tier 3) — freeze #16
- readBytesById guard giữ nguyên (test so khớp hành vi cũ)
- `tsc --noEmit` sạch