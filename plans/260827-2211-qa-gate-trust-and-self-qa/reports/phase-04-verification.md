# Phase 4 — Verification Report: QA Gate Trust + Annotation Self-QA

Date: 2026-08-27
Plan: `plans/260827-2211-qa-gate-trust-and-self-qa/`

## Verdict

`npm run verify` (typecheck + compile + node --test) **PASS** — 309 tests green (255 baseline + 54 mới), 0 fail. **Sau review cycle: 2 finding (high + medium) đã fix, 3 test review-finding bổ sung.**
`npm run smoke:theme-qa` (Script smoke gate) **PASS** — full ThemeQaWorkflow integration chạy qua fixture, report JSON hợp lệ.

## Test matrix mới (test/main/, flat glob constraint)

| File | Coverage |
|---|---|
| `diagnostics-filter.test.ts` | `computeOrigin` (7 ca: same-host, subdomain, third-party, empty source, eval-at, blob:, javascript:/data:, never-throws); `classifyDiagnostics` matrix (console 1st-party level 3 → critical, 3rd-party → warning, CDN hstatic.net → critical (F4), level 2 → ignore, network `-105` → critical (F1), `-3` aborted → warning, HTTP-style 404 → critical, isMainFrame → always critical, sanitize + stripUrlQuery trên output); `sanitizeDiagnosticText`/`stripUrlQuery` (backtick/role-marker/control-char strip, truncate ≤200+ellipsis (F9), query/fragment removal (F10)); `confineWorkspaceRoot` (inside accept, traversal reject `../../Windows` → default (F12), unrelated absolute reject, empty candidate → default, empty default → back-compat passthrough) |
| `tab-diagnostics.test.ts` | `clear(tabId)` per-tab isolation; `clear()` global; **clear-at-navigation ordering** — records before clear vanish, records after clear survive (F2); clear on missing tab no-op |
| `annotation-prompt.test.ts` | `AGENT_CONTRACT_VERSION === '3.1.0'` (F8); implementation variant chứa `theme.qa_validate`, `summary.passed`, `criticalCount`, `SAU KHI SỬA`, `CẤM bịa kết quả`, auth-error branches `ATTACHMENT_REQUIRED`/`ATTACHMENT_INVALID`/`MCP_CONTEXT_REQUIRED` (F5), 2-vòng limit; read-only intents (research/security/testing/documentation/extract-component) → variant read-only, không `SAU KHI SỬA`; directive xuất hiện đúng 1 lần, giữa Invariant Ledger và Core Contract |
| `theme-qa-parity.test.ts` | Cùng fixture diagnostics → full path (`ThemeQaWorkflow.validate`) vs fallback (`buildFallbackThemeQaResult` export) cùng `summary.criticalCount` (2), cùng `summary.passed` (F6); cả 2 path đều có `summary` object đầy đủ; third-party-only diagnostics → pass cả 2 path (Goal 2); host không có `getDiagnostics` → empty snapshot, không throw, pass cả 2 path |

## Review cycle (independent code-reviewer + adversarial validator)

- `confineWorkspaceRoot` **traversal bypass (high)**: absolute candidate chứa `..` (vd `C:\\workspace\\store-theme\\..\\..\\Windows`) thoát prefix check vì `resolveNormalized` bỏ qua `resolve()` trên absolute paths — `..` không được chuẩn hoá trước khi so sánh. Fixed: luôn `resolve(String(value))`; thêm 2 test (absolute-smuggle, slash-variant normalization).
- `buildFallbackThemeQaResult` **summary divergence (medium)**: fallback `passed`/`criticalCount`/`totalIssues` chỉ tính diagnostics, khác full path (bỏ qua overflow culprits, HS violations, Liquid errors) → false-pass khi theme overflow/fail HS. Fixed: dùng đúng công thức full path (`passed = mọi checklist`, `criticalCount = HS errors + Liquid errors + diag critical`, `totalIssues = mọi category`); thêm parity test overflow+HS.

## Chỉnh sửa phát sinh trong lúc verify

- `confineWorkspaceRoot` empty-default bug: `resolve('')` trên win32 trả cwd → candidate hợp lệ bị confine nhầm. Fixed bằng early-return trước khi resolve; thêm test back-compat.
- `split-review-tabhost.test.ts:110` stub `diagnosticsManager` thiếu `clear()` (hàm mới Phase 1) → thêm `clear: () => {}`. Không sửa assert gốc.
- `element-picker-resolution.test.ts:425` literal `contract_version: "3.0.0"` → `"3.1.0"` (F8 — cập nhật có chủ đích, assert giữ nguyên).

## Smoke live — giới hạn môi trường

Live storefront smoke qua MCP bridge **KHÔNG chạy được**: `antifan.capability.dispatch` RPC timeout trên cả `anti.browser.tabs.list` và `theme.debug_bundle` (app desktop không bind tab/control-plane trong phiên này). Theo phase-04 Risk Assessment, đánh dấu giới hạn: thay bằng fixture HTML + host stub trong test (đã chạy) + `npm run smoke:theme-qa` (đã chạy). Xác nhận visual/3rd-party gate trên storefront thật cần phiên có app + tab bind — ghi nhận là follow-up ngoài phiên này.

## Files changed (git)

```
M CHANGELOG.md                          (mục Trusted Diagnostics Gate & Annotation Self-QA)
M docs/operations.md                    (summary object + verdict 3rd-party → warning)
M src/main/browser/native-tab-host.ts   (console-message origin, did-start-navigation clear, did-fail-load origin)
M src/main/browser/tab-diagnostics.ts   (origin/isFirstParty fields, clear(), re-export computeOrigin)
M src/main/qa/theme-qa-workflow.ts      (snapshot at validate start, step 5.5 classification, findings/checklist/summary)
M src/main/tools/browser-capabilities.ts (buildFallbackThemeQaResult export, workspace confine, summary+diagnostics)
M src/shared/annotation-prompt.ts       (AGENT_CONTRACT_VERSION 3.1.0, SELF_QA_DIRECTIVE[_READONLY], buildSelfQaDirective)
M test/main/element-picker-resolution.test.ts (version literal 3.1.0)
M test/main/split-review-tabhost.test.ts (stub.clear)
A src/main/qa/diagnostics-filter.ts     (shared filter module)
A test/main/diagnostics-filter.test.ts
A test/main/tab-diagnostics.test.ts
A test/main/annotation-prompt.test.ts
A test/main/theme-qa-parity.test.ts
```