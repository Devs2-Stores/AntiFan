---
title: "Personal Commerce Engineering Super Core — Full Goal"
description: "Full goal: scout Work Root và skill non-AK, xây Core, tích hợp AntiFan/OMP, verification và learning loop."
status: done
priority: P1
effort: ""
tags: []
created: 2026-09-14
---

# Personal Commerce Engineering Super Core — Full Goal

## Overview

Outcome: xây Super Core local-first thực sự hoạt động, sử dụng qua AntiFan/OMP trong task thực với recommendation có nguồn, verification và learning qua adjudication; scout là đầu vào, không phải đích cuối. Target E:/Work và skill người dùng ngoài root tại C:/Users/Admin/.claude/skills; chỉ mở rộng thêm skill root khi runtime/manifest cung cấp đường dẫn xác thực, không quét toàn home. Plan project-local trong AntiFan. HOLD SCOPE.

Constraints: corpus read-only trong scout; implementation Core và integration AntiFan được thực hiện ở phase 7–15 sau execution approval; một scout work unit active; phase/todo không giới hạn; exclusions có giải trình; không giả 100% semantic accuracy. Non-goals: execute arbitrary corpus code, publish/deploy không được phép, auto-promote rules hoặc biến AntiFan thành sản phẩm khác.

Mode: deep + independent review, user-approved replacement for unavailable kongming. Không phải --advice; reviewers không được khẳng định mạnh hơn model hiện tại. Hai research slices chỉ chuẩn bị contract, không phải parallel corpus execution.

Evidence: E:/Work/README.md:44-70 mô tả root Git chỉ track một phần; FinalProvenanceLedger source đã đọc chỉ làm reference. Glob root timeout và lượt metadata bị ngắt: không có inventory/coverage thực đo.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Đối soát toàn declared scope, không silent skip | P1 |
| 2 | Phân tích nội dung eligible đầy đủ, claims có anchors | P1 |
| 3 | Sinh project phases từ inventory thật và chạy tuần tự | P1 |
| 4 | Đọc đầy đủ skill không thuộc AK và nội dung phụ trợ; skill AK chỉ metadata/exclusion | P1 |
| 5 | Xây persistent Core, platform/temporal/conflict và toàn P1 intelligence | P1 |
| 6 | Retrieval, recommendation, Context Pack/Receipt qua AntiFan/OMP thật | P1 |
| 7 | Verified learning, recovery, regression và end-to-end acceptance | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Start](./phase-01-start.md) | Pending |


Execution order: [Inventory](./phase-02-filesystem-inventory.md) sau Phase 1 → [Routing](./phase-03-project-routing-and-phase-expansion.md) → [All child analyses](./phase-04-sequential-project-analysis.md) → [Correlation](./phase-05-cross-project-correlation.md) → [Closure](./phase-06-closure-and-handoff.md). Sáu stages đầu là scout; bắt buộc tiếp tục phase 7–15 dưới đây, không phải trần phase. Child plans dưới work-units được tạo khi discovery có project thật; queue.json là barrier, không dùng số phase để bỏ qua child work.

## Cross-Plan Dependencies
Đã scan 60 plan index trong active AntiFan scope qua ba trang grep. Không thấy plan corpus scout trùng mục tiêu; read-only scouting không chờ hoàn tất core-freeze/clone implementation. Không thêm dependency giả hoặc sửa trạng thái plan khác. Các plan hiện hữu là evidence lịch sử, không chứng minh production PASS.

## Outputs and Execution Boundary
Các reports/inventory, queue, unit dossiers, claims, correlation và completion ledger được định nghĩa trong phase files; chưa được tạo bằng dữ liệu corpus. Chỉ viết Plan lúc này. Run bắt đầu sau khi user chọn thực thi.
## Success Criteria

- [ ] Mọi eligible unit và artifact được xử lý với exact disposition; unknown region không bị giấu.
- [ ] Coverage chỉ aggregate từ ledger thực, denominator và cut rõ ràng; exclusions không tính analyzed.
- [ ] Fact có evidence anchor/revision; inference và missing history được ghi riêng.
- [ ] Tất cả child gates và closure delta sweep pass trước SCOUT_COMPLETE_FOR_DECLARED_SCOPE.
- [ ] Core được xây, tích hợp, dùng trong task thực; verification/outcome quay lại case và candidate qua adjudication; toàn C1–C8 có acceptance receipts.

## Review and Validation
Independent red-team: 4 reviewer lenses; findings adjudicated in [Review log](./reports/plan-review.md). User approved corrections and validation: full metadata enumeration including dependency trees; filtered non-sensitive content allowed in session model; sensitive data restricted. No Kongming supervision claimed.

### Validation Log
Run remains pending. Dependencies are normal-success order; partial-report path can end INCOMPLETE without falsely completing blocked phases. Delta returns routing/analysis/correlation before closure. Approved exclusions are not unknown discovery; no pruning dependency metadata. No corpus coverage measured.
User bổ sung scope: phân tích skill riêng, trừ skill AK. Quy tắc thống nhất ở Phase 1; propagate discovery/routing/content/correlation/closure. Đây là amendment sau independent review, không tuyên bố reviewer đã duyệt amendment này.

### Tooling Notes
CLI add-phase created all six files but left only its starter row in the table. The execution-order links above list every parent phase; CLI file validation succeeds. Issue reported; no unsupported table-repair command invented. Active plan pinned via ak plan use; optional session hook unavailable.

### Whole-Plan Consistency Sweep
Reread toàn bộ 7 plan/phase files sau correction; local-link check: 0 broken links; all execution statuses pending; 0 scaffold markers. Đã đối chiếu partial-report path, delta loop, privacy, metadata scope, denominators và archive roll-up. CLI table thiếu rows vẫn là tooling limitation đã ghi, không phải missing phase file. CLI format/link checks không chứng minh corpus outcomes.

<!-- slug: work-root-sequential-evidence-scout -->
## Approved Full Goal Contract and Traceability
User explicitly approved the outcome contract via ask and confirmed again. Original scout-only endpoint is superseded. Stable directory retained for existing links. No automatic goal start.

| Contract | Required outcome | Phases | Acceptance signal | Evidence / prerequisite |
|---|---|---|---|---|
| C1 | Complete scoped corpus + non-AK skills | 1–7,14–15 | Reconciled ledger, no silent skip | No full inventory yet |
| C2 | Local-first identity/revision/provenance | 7–8,13,15 | Restart, idempotency, source trace | Schema selected from corpus |
| C3 | Platform/temporal/conflict safety | 7–9,15 | No semantic leakage; visible conflicts | Current platform evidence needed |
| C4 | Experience and all P1 domain intelligence | 7,10,14–15 | Real queries with evidence or explicit data gaps | Corpus-dependent usefulness |
| C5 | Retrieval/context/recommendation/receipt | 7,11,14–15 | Holdout baseline + abstention | Thresholds/provider unresolved |
| C6 | Actual AntiFan/OMP integration | 7,12,15 | Real task interaction and verification | Entry scripts observed in package.json; owner tracing pending |
| C7 | Verified learning/adjudication/recovery | 7,13,15 | No self-promotion; restore and rollback proof | User decision authority retained |
| C8 | Full regression and end-to-end delivery | 7,14–15 | All contract receipts pass | No milestone-only DONE |

## Required Build Execution Order
7. [Design from corpus](./phase-07-corpus-informed-design.md) — pending; depends on 6.
8. [Persistent Core and provenance](./phase-08-core-storage-and-provenance.md) — pending; depends on 7.
9. [Platform, temporal and conflict contracts](./phase-09-platform-temporal-conflict.md) — pending; depends on 8.
10. [Experience and domain capabilities](./phase-10-experience-and-domain-intelligence.md) — pending; depends on 9.
11. [Retrieval, recommendation and context delivery](./phase-11-retrieval-and-recommendations.md) — pending; depends on 10.
12. [AntiFan and OMP integration](./phase-12-antifan-omp-integration.md) — pending; depends on 11.
13. [Learning, adjudication and recovery](./phase-13-verified-learning-and-recovery.md) — pending; depends on 12.
14. [Complete corpus import and regression](./phase-14-full-corpus-core-validation.md) — pending; depends on 13.
15. [Goal end-to-end acceptance](./phase-15-goal-acceptance-and-handoff.md) — pending; depends on 14.

## Goal Scope Guard
At each phase boundary compare work to C1–C8. New required work expands child phases/todos; no ceiling. Scout partial report is not goal completion. Material outcome change pauses for user. P2 conditional features require corpus justification and cannot override no automatic promotion. Implementation details may evolve in phase 7 without dropping outcomes. No Ready until whole-plan preflight blockers clear and user confirms final packet.

## Current Preflight
See [Full-goal preflight](./reports/full-goal-preflight.md). Earlier review/consistency results apply to scout revision only. Full-goal review and final verification are recorded separately; no claim Core implemented.

## Approved Autonomous Execution Amendment
User selected existing agent/runtime inference, isolated local acceptance tasks and explicitly approved unattended technical execution with real candidates pending for later review. Thresholds are chosen and frozen before evaluation; not lowered to pass. C7/C8 acceptance now requires a real pending candidate plus independently inspectable adjudication/rollback proof in an isolated acceptance store, not promotion of real knowledge during the run. Existing user-promotion-during-run wording is superseded by this explicit amendment. No auto-start in warmup.

### Final warmup verification
Current session agent -> AntiFan read-only tabs.list(all=false) succeeded; no navigation or mutation. This proves present bridge connectivity, not future Core behavior. Node v24.13.0 and ak plan validate available. Whole phase build/integration/acceptance remains pending.

### Whole-Plan Consistency Sweep (full-goal revision)
Reread 16 plan/phase files. Decision deltas checked: scout-only endpoint removal, C1–C8 contract, autonomous amendment, non-goals rewrite.
- Reconciled: phase-06 step 8 and success criteria no longer assert Core is never built; they now require accurate scout status and handoff into phase 7, with build/verification owned by phases 7–15.
- Confirmed already consistent: `plan.md:17` non-goals no longer include building Core; preflight rows 11/13/15 and "Must Verify Before Ready" already encode the approved autonomous amendment.
- Verified unchanged stale-state: 15 phase files all `status: pending`; zero broken local links; zero scaffold markers; `ak plan validate` valid=true.
- Unresolved contradictions: 0. Known tooling limitation only — CLI-generated `## Phases` table shows the starter row while all 15 phase files and execution-order links exist; issue reported, CLI-owned table not hand-edited.
