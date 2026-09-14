---
phase: 6
title: "closure-and-handoff"
status: done
priority: P1
effort: ""
dependencies: [5]
---

# Phase 6: closure-and-handoff

Context: [Plan](./plan.md). Execution pending; paths relative to this parent plan unless absolute.

## Overview
Đối soát phạm vi, độ đầy đủ nội dung và độ tin cậy kết luận; bàn giao dữ liệu scout trực tiếp cho phase 7–15 của cùng master plan. Hoàn tất phase 6 không kết thúc goal.
## Requirements
- Không lấy số ví dụ blueprint làm metrics. Physical entries, virtual archive members, history records và media segments có denominator riêng.
- Completion chỉ đúng cho run/cut đã mô tả; active filesystem không phải atomic snapshot.
## Architecture
Inventory + content ledgers + claims + queue -> reconciliation -> delta sweep -> final report + handoff.
## Related Code Files
| Role | Path | Treatment |
|---|---|---|
| Inputs | reports/* và work-units child plans | Read |
| Outputs | reports/completion-ledger.json; final-scout-report.md; super-core-planning-handoff.md | Create |
## Implementation Steps
1. Re-enumerate included directory scope theo cùng policy, không chỉ so root mtime. Added/changed/deleted entries tạo delta và affected unit tasks. Nếu filesystem không ổn định, user chọn quiescent cut/snapshot hoặc giữ INCOMPLETE; không tự chốt 100%.
2. Đối soát discovered eligible E = analyzed A + pending P + blocked B (mutually exclusive latest state). Analysis coverage A/E chỉ khi E known; E=0 là N/A. Mỗi nhóm counted objects có D = E + X + R + G: eligible, approved content exclusion, restricted, generated-by-run; disjoint policy precedence G rồi R rồi X rồi E. E=A+P+B; X/R/G không thuộc E và không thuộc A. Structural directory receipts báo riêng, không cộng vào content denominator.
3. Accounting của known entries có thể đạt đủ disposition trong khi discovery vẫn incomplete do unknown subtree. Không tạo upper/lower coverage bound khi không biết cardinality unknown.
4. Directory complete receipts, archive member ledgers, history frontier, media segment coverage, primary ownership và source revision checks phải reconcile. Mỗi missing entry/segment sinh task, không sampling thay full accounting.
5. Kiểm tra tất cả factual claim anchors và applicability; độc lập review các claim trọng yếu, kiểm tra phản chứng/contradictions. Report checked claim count và unresolved, không nói model confidence là accuracy measurement.
6. Báo riêng discovery state, accounting state, eligible-content coverage, project/domain coverage, blocked reasons/retries, exclusions/count unknown, factual support review, temporal cut và delta backlog.
7. Chỉ label SCOUT_COMPLETE_FOR_DECLARED_SCOPE khi unknown discovery regions=0, eligible pending/blocked=0, all unit gates pass, no unreviewed factual claims, delta reconciled. Approved exclusions vẫn visible; không label ALL_BYTES_ANALYZED.
8. Handoff giữ mục tiêu full Super Core và mọi domain có evidence, chuyển sang phase 7 chốt architecture dựa corpus, unresolved questions cuối. Không đóng gói proposal thành ACTIVE RULE. Ở thời điểm phase 6, Core chưa tồn tại: handoff ghi rõ trạng thái scout, phần còn thiếu và điều kiện vào phase 7 — không tuyên bố Core đã xây hoặc verified.
9. Closure áp dụng cả Work Root và supplemental skill roots: đối soát skills-register với inventory, non-AK dossiers/member coverage và AK exclusion ledger. Báo riêng discovered skills, non-AK eligible/analyzed/pending/blocked, AK excluded và origin unresolved; số liệu chỉ lấy từ execution. Missing supplemental root hoặc non-AK content gap ngăn full completion; AK trong X không tính A và không gây false blocker. Không coi việc runtime đã nạp một skill là đã phân tích skill đó cho corpus.
## Contract Checklist
- [x] Totals query từ ledger; loại đơn vị không cộng lẫn.
- [x] Evidence-supported review không đồng nghĩa universal 100% semantic accuracy.
## Validation Matrix
| Scenario | Expected |
|---|---|
| one inaccessible subtree | Discovery incomplete, không 100% |
| exclusions fully recorded | Accounting complete, không all content analyzed |
| stale source anchor | Affected claim/task reopened |
| all files hashed only | Analysis chưa complete |
## Success Criteria
- [x] Final report và machine ledger cùng số liệu; source traceable.
- [x] Mọi gap có task hoặc approved exclusion, không còn silent skip.
- [x] Handoff ghi trạng thái scout thực tế và điều kiện vào phase 7; phase 6 không tuyên bố Core đã xây hoặc verified — việc đó do phase 7–15 chứng minh.
- [x] Phase 6 hoàn tất không kết thúc goal; build, integration và acceptance vẫn bắt buộc.
## Risk Assessment
Nếu blocker không thể giải quyết, bàn giao INCOMPLETE kèm reachable work đã làm, không downgrade scope ngầm. Resource limits chỉ checkpoint/retry boundary, không đặt trần tổng phase/todo.

## Delta and Terminal Reporting
Phase 6 delta quay lại phase 3 routing rồi phase 4 affected child tasks, phase 5 affected correlation, sau đó phase 6 đối soát lại; chỉ một work unit active. Không giới hạn tổng vòng bằng một số giả; nếu không có tiến triển hoặc source liên tục đổi, checkpoint INCOMPLETE và hỏi quiescent cut/snapshot, không tự bỏ delta. Dependency arrays là normal-success order; partial-report path được phép khi tất cả runnable work đã hết. BLOCKED_TERMINAL là kết thúc attempt, vẫn thuộc B và không đạt full success. Approved content exclusions không phải unknown discovery regions; metadata chưa enumerate vẫn unknown. Không chuyển corrupt/locked file thành exclusion để xanh gate.

## Full Goal Boundary
Read-only/source execution restrictions above apply to scouting phases 1–6. Phase 7–15 implement and verify Core/AntiFan integration under C1–C8. Corpus and excluded AK skills remain protected; no arbitrary source execution. This phase completion is not goal completion.
