---
title: "Theme QA 3-Axis Stop (Jev-Mem stopping criteria)"
description: "Bound the ThemeQaRepairCoordinator repair retry loop deterministically with the Jev-Mem stopping axes as pure TypeScript."
status: done
priority: P1
effort: "1d"
tags: [qa, theme, stopping-criteria, deterministic]
---

# Theme QA 3-Axis Stop Config (Jev-Mem stopping criteria)

## Status
- **Phase 1 (implement + test + review):** done — see `phase-01-implement-three-axis-stop.md` validation results and `plans/journals/2026-09-27-theme-qa-three-axis-stop.md`. Acceptance 1-6, 8 hold; acceptance 7 (freeze cert) is blocked by a pre-existing, unrelated cert-harness defect.

## Outcome
Bound the `ThemeQaRepairCoordinator` repair retry loop deterministically with the Jev-Mem 3-axis stopping criteria (sufficiency $s_d$, missingness $m_d$, contradiction $c_d$) as pure TypeScript — the single COMMIT item from `docs/research-system-one-jev-repos.md:319` (Phụ lục điều khiển 2, Ultra-Verifier run 2, winner 96/100).

## Constraints
- Pure TS, 0 dependency, 0 I/O trong helper; offline; C-6 (Windows i5, no GPU).
- Không chạm frozen dispatch surface (`capability-transport`, `invocation-ledger`, `receipt-store`, `artifact-store`, invocation-frame-checksum) → `npm run certify:core-freeze` phải pass với SHA256 như cũ.
- Không đổi scoring của `packages/super-core` (không import, không sửa).
- Không model/OCR — thuần deterministic logic.
- Behavior tightening có chủ đích: vòng retry `awaiting_fix` hết điều kiện `awaiting_fix` sau `MAX_REPAIR_ITERATIONS` (3) lượt verify thất bại → `blocked` (terminal). Đây là acceptance change đã được user chấp nhận qua decision record.

## Non-goals
- Không sửa sessions Map TTL cleanup (residual unknown E-3, task riêng).
- Không thêm OCR delegate, model gating, meraGPT — toàn bộ DEFER/REJECT giữ nguyên.
- Không đổi circuit breaker (`src/main/verification/circuit-breaker.ts`).

## Phases
- `phase-01-implement-three-axis-stop.md` — helper + unit tests + coordinator wiring + gates. (Đơn slice, không tách parallel vì wiring phụ thuộc helper; tester + code-reviewer sẽ chạy song song sau implement.)

## Acceptance criteria
1. `evaluateThreeAxisStop` thuần hàm, 4 nhánh quyết định (`PROCEED_VERIFIED` / `ABORT_ROLLBACK` / `ABORT_BLOCKED` / `CONTINUE_REPAIR`), deterministic, không I/O.
2. Unit test phủ 6 ca biên: clean-pass, contradiction→rollback, missingness chặn verified-sai, attempts vượt trần→blocked, sufficiency-thiếu→continue, contradiction ưu tiên trên tất cả.
3. Coordinator: lượt verify thất bại thứ 3 (không regressions, không evidence gaps) → `status: 'blocked'` + `stopReason`, lượt gọi thứ 4 → `REPLAY_DENIED` (state machine hiện hành). Regression → rollback như cũ (không đổi). Passed → verified như cũ.
4. `npm run typecheck` + `npm run compile` sạch (không vi phạm budget-dominance / dispatch-payload).
5. Narrow test file pass + `npm run test:main` 100% (non-regression baseline 217 test).
6. `npm run test:super-core` 100%.
7. `npm run certify:core-freeze` pass, SHA256 không đổi.
8. Chi phí tính 3 trục: trung bình ≤0.5ms/lượt (đo trên 1000 lần gọi trong test).

## Rollback
Revert 3 file (2 new + 1 modified). Không migration, không config, không schema.
