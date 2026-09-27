---
title: "Phase 01 — Implement 3-Axis Stop (helper + tests + coordinator wiring)"
status: done
---

# Phase 01 — Implement 3-Axis Stop (helper + tests + coordinator wiring)

## Context
- Hợp đồng chốt: `docs/research-system-one-jev-repos.md:319` (COMMIT duy nhất của run 2).
- Live anchors đã verify (ultra run 2 verifier + kongming GO-WITH-CHANGES): `src/main/qa/theme-qa-repair-coordinator.ts` — `evidenceGaps` :181 (throws SETTLE_INCOMPLETE), `hasRegressions` :197, rollback R0 :199–223 (deletes session), status decision :225, `verificationAttempts` :166, state machine từ chối lượt sau :143 REPLAY_DENIED.
- Lỗ hổng target: vòng `awaiting_fix` retry không giới hạn cục bộ (chỉ TTL 10 phút + circuit breaker toàn cục); nhánh SETTLE_INCOMPLETE cũng retry vô hạn đến TTL.
- **Test hiện tồn (kongming đính chính):** `test/main/theme-qa-workflow-differential-and-rollback.test.ts` đã phủ coordinator lifecycle qua `catalogue.dispatch('theme.qa_repair.*')` — :341-354 blocks exhausted sessions (do-while đến `blocked`, assert `remainingRepairs === 0`), :356-370 awaiting_fix 1 lượt + REPLAY_DENIED + reuse sau edit, :372+ inconclusive 1 lượt, :303 happy path, :214 regression rollback. Harness: MockBrowserHost + BrowserControlPort + ThemeQaWorkflow thật + CapabilityCatalogue + registerBrowserCapabilities (setup :118-206).
- Capability handler `theme.qa_repair.verify` (`src/main/tools/browser-capabilities.ts:1725-1737`) trả thẳng result của coordinator → field mới tự chảy qua dispatch, không sửa tools layer.

## Files
- NEW `src/main/qa/three-axis-stop.ts` (~55 LOC, thuần hàm, 0 dependency).
- NEW `test/main/theme-qa-three-axis-stop.test.ts` (evaluator thuần + coordinator loop-bounding tái dùng harness MockBrowserHost).
- MODIFY `src/main/qa/theme-qa-repair-coordinator.ts` (import + bound nhánh SETTLE_INCOMPLETE + thay status decision :225 + additive `stopReason`/`remainingRepairs` semantics).

## Steps
1. Helper: `ThreeAxisState {sufficiency, missingness, contradiction}`, `StopDecision` union 4 action + reason, `MAX_REPAIR_ITERATIONS = 3`, `evaluateThreeAxisStop(current, attemptCount, maxAttempts = 3)`:
   - `contradiction > 0` → `ABORT_ROLLBACK` (ưu tiên tuyệt đối)
   - `sufficiency >= 1 && missingness === 0` → `PROCEED_VERIFIED`
   - `attemptCount >= maxAttempts || missingness > 3` → `ABORT_BLOCKED` (reason `STOP_CRITERIA_EXCEEDED`)
   - còn lại → `CONTINUE_REPAIR`
2. Wiring trong `verify()`:
   a. **Nhánh SETTLE_INCOMPLETE (:181):** khi `session.verificationAttempts >= MAX_REPAIR_ITERATIONS` → set `session.status = 'blocked'` trước khi throw như cũ — bound luôn vòng retry thiếu bằng chứng (trục m_d), lượt gọi sau bị state machine :143 từ chối.
   b. **Status decision (:225):** tính state từ dữ liệu thật (`sufficiency = report.summary.passed ? 1 : 0`; `missingness = evidenceGaps?.length ?? 0`; `contradiction = hasRegressions ? 1 : 0` — contradiction đã terminal ở :199, nhánh rollback của helper giữ cho contract thuần). Status mới: `passed ? 'verified' : (stopBlocked || transition.tripped) ? 'blocked' : 'awaiting_fix'`.
   c. **Result:** `stopReason?: 'STOP_CRITERIA_EXCEEDED' | 'CIRCUIT_BREAKER_TRIPPED'` (additive optional) — set theo path blocked; `remainingRepairs = 0` khi stopBlocked (session terminal, không còn budget — giữ assertion `remainingRepairs === 0` của test :353).
3. Tests: (a) 6 ca biên evaluator thuần; (b) coordinator loop-bound: 3× edit-file + verify (fail không regression) → lượt 3 `status:'blocked'`, `stopReason:'STOP_CRITERIA_EXCEEDED'`, `remainingRepairs:0`; lượt 4 → REPLAY_DENIED; (c) settle-gap loop bound: evalJs spoof overflow scan 3× → lượt 4 REPLAY_DENIED (m_d bound); (d) timing 1000-call < 500ms (≈ ≤0.5ms/lượt).
4. Gates: `typecheck` → `compile` → narrow test → `test:main` → `test:super-core` → `certify:core-freeze` → `node scripts/run-theme-harness.mjs --level=L0`.

## Validation
- Mọi acceptance criterion trong `plan.md`.
- Non-regression: 4 test hiện tồn của coordinator (:214, :303, :341, :356, :372) + toàn bộ `test:main` + baseline 217 test.
- Freeze cert: SHA256 không đổi (không file nào trong frozen surface bị sửa — chỉ coordinator + 2 file mới).

## Risk
- Behavior tightening có chủ đích (failed-retry #3 và settle-gap #3 → terminal blocked): đã duyệt qua decision record; call out cho code-reviewer.
- `remainingRepairs` override = 0 khi stopBlocked: đổi semantics field trên path terminal (breaker path giữ nguyên giá trị breaker) — nhất quán với "session terminal, budget = 0".
- Circuit breaker singleton stateless theo key sessionId (randomUUID mỗi session) → không flaky cross-test.

## Rollback
Revert 3 file. Không caller migration (field additive, behavior theo contract mới đã duyệt).

## Validation results (2026-09-27)

- `npm run compile` exit 0; `npm run typecheck` sạch.
- Suite mới `test/main/theme-qa-three-axis-stop.test.ts`: **10/10** — budget test 0.64 ms/1000 lần; micro-bench riêng **14.7 ns/lần gọi** (200k vòng).
- Suite coordinator hiện tồn `theme-qa-workflow-differential-and-rollback`: **7/7**, không sửa file test cũ.
- `npm run test:main`: **1744 pass / 0 fail / 1 skip** (298 suite, ~141 s).
- `npm run test:super-core`: **38/38**.
- Code review: APPROVE, 2 MINOR đã áp (`MAX_MISSINGNESS_GAP` thay magic literal; `report.findings?.evidenceGaps?...` nhất quán optional chaining).
- Acceptance 7 (`certify:core-freeze`): **blocked ngoại vi** — run 1 chết tại `anti.screenshot.viewport` vì host của `scripts/freeze-theme-workload.cjs` thiếu `captureVerificationScreenshot` (guard đã commit từ `48483faf`/`8d820844`; workload chưa bao giờ implement — `git log -S` rỗng; diff lần này không chạm đường đó). Cần chủ sở hữu freeze-surface thêm method vào adapter workload.
- Plan step 4 đính chính cú pháp: `node scripts/run-theme-harness.mjs --layers l0` (không phải `--level=L0`). L0 hiện FAIL do lỗi tồn tại trong cây `Storefront` (15 settings-binding, 6 asset mất, 9 Haravan contract, 5 lint) — không liên quan thay đổi này.
