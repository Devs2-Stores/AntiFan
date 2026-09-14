---
phase: 5
title: "cross-project-correlation"
status: done
priority: P1
effort: ""
dependencies: [4]
---

# Phase 5: cross-project-correlation

Context: [Plan](./plan.md). Execution pending; paths relative to this parent plan unless absolute.

## Overview
Đối chiếu toàn bộ dossiers và evidence để tìm pattern, genealogy, conflicts và mức reconstructability; không xây engine hoặc kích hoạt rule.
## Requirements
- Chỉ một correlation work unit active; append domain tasks từ dữ liệu thực, không giới hạn số.
- Cross-platform analogy không phải xác nhận target semantics; nhiều bản copy không phải validation độc lập.
## Architecture
Dossiers + source anchors -> lineage candidates -> cases/decisions -> conflicts/temporal mapping -> domain findings. Re-read evidence qua explicit sequential task.
## Related Code Files
| Role | Path | Treatment |
|---|---|---|
| Input | reports/units/*/dossier.md; claims.jsonl | Read |
| Output | reports/lineage.jsonl; conflicts.jsonl; domain-register.json | Create |
| Output | reports/corpus-findings.md | Evidence-backed synthesis |
## Implementation Steps
1. Tạo correlation matrix bao phủ mọi unit/domain; từng pair candidate có lý do lựa chọn, không cần brute force mọi pair không liên quan.
2. Hash equality chứng minh same bytes, không chứng minh author/ancestry/success. Git ancestry hoặc explicit copy evidence mới nâng lineage; output do AI tạo phải ghi origin để tránh self-reinforcement.
3. Tách Haravan/Sapo/Shopify/generic/unknown, platform version và temporal applicability. Conflicts không chọn theo majority; giữ unresolved khi context thiếu.
4. Reconstruct request -> decision -> implementation -> verification -> outcome chỉ ở các cạnh có evidence. Explicit rationale và candidate explanation tách riêng.
5. Bao phủ skills genealogy, declared-vs-observed, requirement patterns, quality acceptance, commercial estimate-vs-actual, tool usage/maintenance, workarounds, root-cause candidates, archetypes theo evidence có thật; không ép domain không có data.
6. Mỗi domain ghi evidence availability, limitations và missing inputs. Không tạo maturity score giả hoặc auto-promote principles.
7. Đối chiếu các câu hỏi FACT/CASE/DECISION/WHY/RISK/VERIFICATION/HISTORY/EXPERIENCE; recommendation chỉ là candidate có applicability và uncertainty, không có execution authority.
8. Đối chiếu skill non-AK với project evidence: declared workflow vs observed practice, bug/fix liên quan, genealogy và repeated principles chỉ là candidate. AK excluded không được dùng làm evidence cho identity user; không có project usage log là NOT_OBSERVED, không kết luận skill chưa từng dùng.
## Contract Checklist
- [x] Evidence independence và self-generated origin được giữ.
- [x] Conflict/candidate/validated observation không trộn active rule.
## Validation Matrix
| Scenario | Expected |
|---|---|
| repeated base implementation | One lineage cluster, không đếm independent wins |
| old workaround/new version | Context-specific/needs revalidation |
| commercial dates only | Không suy actual effort/ROI |
## Success Criteria
- [x] Mọi discovered domain có finding hoặc no-evidence disposition.
- [x] Mọi retained cross-project claim có anchors; contradictions visible.
## Risk Assessment
Correlation không phải causation; root causes cần evidence chain. Thiếu outcome không được gắn success/failure. New domain reopens queue thay vì bỏ vào future ngoài scope.

## Incomplete Input Rule
Partial-report path nhận dossiers có blockers và giữ label INCOMPLETE; không kết luận không có pattern ở vùng chưa đọc. Sau delta re-analysis, invalidate và recompute affected correlations trước closure.

## Full Goal Boundary
Read-only/source execution restrictions above apply to scouting phases 1–6. Phase 7–15 implement and verify Core/AntiFan integration under C1–C8. Corpus and excluded AK skills remain protected; no arbitrary source execution. This phase completion is not goal completion.
