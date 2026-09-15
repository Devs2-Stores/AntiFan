---
phase: 8
title: "Re-acceptance — ladder 100% revision-bound"
status: todo
priority: P0
effort: ""
dependencies: [7]
---

# Phase 8: Re-acceptance — ladder 100% revision-bound

## Overview
Locked contract items: C1, C8. Block 3, phase cuối. Ứng với upstream phase 14 ("Full corpus core validation") và 15 ("Goal acceptance and handoff").

Mục tiêu: chứng minh **100%** bằng receipt, không bằng tuyên bố. Chạy sau khi phases 2-7 xong, vì verdict QA/visual chỉ adjudicable sau phase 7.

## Requirements

### R1 — Ladder đầy đủ, có verdict terminal
- Bao phủ **toàn bộ 31 hạng mục P0-A → P1** của MASTER UPGRADE (P0-A 10 · P0-B 7 · P0-C 8 · P1 6).
- **Mẫu số nằm ở `reports/ladder-31-items.md`** — đó là định nghĩa của "100%". Không có artifact đó thì "100%" không kiểm được. Phân bổ: phase 2 giữ 5, phase 3 giữ 8, phase 4 giữ 1, phase 5 giữ 8 (MCP), phase 6 giữ 9 (Health + surface); phase 1 và 7 là hạ tầng/mở khoá, không thuộc ladder. Tổng **31**.
- Verdict 4 giá trị: `PASS` · `FAIL` · `NOT_IMPLEMENTED` (+bằng chứng vắng mặt) · `BLOCKED`.
- **0 `SKIP`, 0 `TIMEOUT`** được tính là kết thúc. Không có `SKIP` trong từ vựng.
- Điều kiện Final: `PASS == 31 AND SKIP == 0 AND TIMEOUT == 0`. `NOT_IMPLEMENTED` và `BLOCKED` **không** cộng vào 100%.

### R2 — Revision-bound
- Mọi receipt `PASS` phải gắn được với revision: git SHA + `exit` khác null + `finishedAt` khác null + `routeIdentity` khác null.
- Verdict không gắn được revision thì **không** được trích dẫn như bằng chứng về hành vi hiện tại.

### R3 — Không milestone-only DONE
- Xong phase **không** đồng nghĩa với đạt contract. Chỉ receipt mới là đạt.
- Không được tuyên bố 100% nếu bất kỳ hạng mục nào đang `NOT_IMPLEMENTED` mà contract yêu cầu phải có.

### R4 — Toàn bộ regression xanh, không test nào bị nới
- `super-core`, `site-clone`, `test:fast`, `test:main`, `test:integration`, `test:e2e` theo phạm vi bị ảnh hưởng.
- Diff test phải chứng minh **không** có assertion nào bị làm yếu.

### R5 — Artifact sạch
- Không secret; chỉ ghi presence/absence của env var.
- Prune artifact chỉ giữ đường `FAIL`/`BLOCKED`; đường `PASS` chỉ giữ summary.

## Related Code Files
- `plans/260914-1248-work-root-sequential-evidence-scout/phase-14-full-corpus-core-validation.md`
- `plans/260914-1248-work-root-sequential-evidence-scout/phase-15-goal-acceptance-and-handoff.md`
- `plans/260914-1248-work-root-sequential-evidence-scout/reports/acceptance-matrix.md` — mẫu acceptance có sẵn.
- `plans/260914-1248-work-root-sequential-evidence-scout/reports/goal-acceptance-v2.md`
- `scripts/check-bottlenecks.mjs`, `scripts/check-plans.mjs`, `scripts/check-mcp-budget-dominance.mjs` — gate tổng.
- `plans/bottlenecks.json` — 7 open ban đầu; kỳ vọng 0 open liên quan sau phases 6-7.

## Implementation Steps
1. Dựng ladder artifact đủ 31 hạng mục từ MASTER UPGRADE, mỗi mục một dòng verdict.
2. Với mỗi mục: chạy đường verify thật, gắn revision, ghi verdict + evidence ref.
3. Chạy full regression theo phạm vi ảnh hưởng.
4. Soi diff test để chứng minh không assertion nào bị nới.
5. Chạy các gate tổng: `check-bottlenecks`, `check-mcp-budget-dominance`, `check-plans`.
6. Kiểm artifact sạch secret; prune theo luật.
7. Ghi handoff: cái gì đạt, cái gì không, blocker nào còn.

## Contract and Test Matrix
- [ ] 31/31 hạng mục có verdict terminal; 0 `SKIP`, 0 `TIMEOUT`.
- [ ] Mọi `PASS` có receipt revision-bound (git SHA, `exit`, `finishedAt`, `routeIdentity` đều khác null).
- [ ] Regression xanh trong phạm vi ảnh hưởng; diff test chứng minh không assertion nào bị làm yếu.
- [ ] `check-bottlenecks` không còn mục open thuộc phạm vi phase 6-7, hoặc còn thì ghi `BLOCKED` + blocker nêu tên.
- [ ] Không secret trong bất kỳ artifact nào.
- [ ] Không mục nào được đánh `PASS` trên scaffolding.

## Success Criteria
- [ ] R1-R5 delivered và evidence linked.
- [ ] **100%** hạng mục P0-A→P1 đạt `PASS` có receipt — đây là định nghĩa Final của goal.
- [ ] Không có đường nào để đánh `PASS` bằng cách chạy hết thời gian: không có đồng hồ trong mô hình.

## Risk Assessment
- Phase này là nơi **dễ tự lừa nhất**: áp lực "đạt 100%" sẽ đẩy về phía nới tiêu chí. Health abort và review ở gate là hàng rào, và "nới tiêu chí" là trigger abort.
- Nếu sau phases 2-7 vẫn còn hạng mục `NOT_IMPLEMENTED` mà contract yêu cầu, kết quả đúng là **chưa đạt Final** — phải báo đúng như vậy, không gộp nhóm để trông đủ.
- Verdict QA/visual vẫn có thể `BLOCKED` nếu phase 7 không đóng được — khi đó ghi đúng blocker, không hạ chuẩn.
