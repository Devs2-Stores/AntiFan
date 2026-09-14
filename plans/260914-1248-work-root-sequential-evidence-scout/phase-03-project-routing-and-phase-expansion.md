---
phase: 3
title: "project-routing-and-phase-expansion"
status: done
priority: P1
effort: ""
dependencies: [2]
---

# Phase 3: project-routing-and-phase-expansion

Context: [Plan](./plan.md). Execution pending; paths relative to this parent plan unless absolute.

## Overview
Biến inventory thật thành project/work-unit register và các phase chi tiết không giới hạn số lượng. Không suy project chỉ từ folder name.
## Requirements
- Mọi in-scope file hoặc member có owner unit, exclusion hoặc unresolved routing task.
- Root loose files, shared tools, skills, notes, media, history và dữ liệu không giống project đều có unit.
## Architecture
Inventory -> project candidates -> ownership reconciliation -> queue.json -> CLI-generated child plans -> sequential execution barrier.
## Related Code Files
| Role | Path | Treatment |
|---|---|---|
| Input | reports/inventory.jsonl; reports/archive-members.jsonl | Read |
| Output | reports/project-register.json; reports/queue.json | Create |
| Output | work-units/<CLI-created-plan>/plan.md + phase files | Create only after actual unit discovered |
## Implementation Steps
1. Dùng manifest, docs và cấu trúc source xác định candidates; preserve UNKNOWN platform, multi-platform units được tách rõ contract.
2. Gán stable unitId và đúng một primary owner cho mỗi artifact; additional cross-links không tăng denominator. Nested repo/package có parent-child ownership rõ, không đọc lặp như evidence độc lập.
3. Tạo queue theo dependency thật (shared base trước consumer nếu xác định), tie-break bằng exact relative path. Cycle dependency thành một nhóm điều tra tuần tự, không deadlock.
4. Với từng unit, dùng live ak plan create/add-phase help để scaffold child plan dưới work-units; đọc mọi stub rồi điền concrete file inventory, checklist và evidence outputs. Parent references child bằng relative links, không dựa cross-plan index resolution cho nested roots.
5. Mỗi child bao phủ tiếp nhận, content batches, history/context khi có, và dossier verification; unit đơn giản có thể một phase đầy đủ, project lớn tách nhiều phase; số batch/phase tăng theo file coverage thực tế. Không có child placeholder được tính hoàn tất.
6. queue.json chứa unitId, source roots/entryIds, childPlanPath, dependsOn, state, order, pendingArtifacts, unresolved. Parent phase 4 giữ success gate tới khi toàn child-required work complete; không cấm partial reporting khi blockers tồn tại.
7. Chưa xử lý nổi unit thì checkpoint BLOCKED, chuyển unit độc lập kế tiếp tuần tự; giữ queue trở lại blocker. Không cho skip trở thành completed.
8. Mỗi domain mới phải tạo owner/task hoặc ghi không đủ evidence; seed taxonomy không ép tất cả vào Haravan/Sapo/Shopify.
9. Tạo skills-register với skillId, name/namespace, locations, originEvidence, AK disposition, package members, references, ownerUnit và analysisState. Mỗi skill non-AK có work unit/child phase tuần tự; duplicate aliases dùng cùng revision evidence nhưng không xóa location. AK chỉ exclusion record, không content task; ambiguous origin có resolution task. Skills là input chính thức, không phụ thuộc việc project có package manifest.
## Contract Checklist
- [x] Artifact-to-unit mapping total, không trùng primary ownership.
- [x] Dynamic child plans linked và queue persisted trước content execution.
## Validation Matrix
| Scenario | Expected |
|---|---|
| loose screenshot / quote | Có unit, không bị bỏ vì không có package |
| nested repo/shared source | Explicit ownership + lineage candidate |
| project mới phát hiện muộn | Append unit, reopen aggregate gate |
## Success Criteria
- [x] Unassigned eligible artifacts = 0; unresolved identity vẫn có owner và task.
- [x] Không có giới hạn tổng child phase/todo; một active work unit.
## Risk Assessment
Tên manifest trùng không có nghĩa cùng project; ambiguity giữ candidate. Không tạo Super Core module từ tên domain. Physical project list/count chỉ công bố từ inventory execution.

## Partial Run Exit
Khi không còn runnable work, BLOCKED units giữ failed success gate và reason/retry prerequisite; cho phép phase 5 phân tích phần có evidence rồi phase 6 xuất INCOMPLETE. Đây là reporting path, không đổi blocked thành completed. Child plans scaffold với --basedir theo live help dưới chính plan/work-units; paths trong tài liệu này relative to parent plan directory.

## Full Goal Boundary
Read-only/source execution restrictions above apply to scouting phases 1–6. Phase 7–15 implement and verify Core/AntiFan integration under C1–C8. Corpus and excluded AK skills remain protected; no arbitrary source execution. This phase completion is not goal completion.
