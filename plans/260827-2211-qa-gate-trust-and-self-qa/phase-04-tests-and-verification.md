---
phase: 4
title: "Tests & Verification"
status: done
priority: P1
effort: "2h"
dependencies: [1, 2, 3]
---

# Phase 4: Tests & Verification

## Overview

Test buffer clear theo navigation, origin classification, shared filter verdict nhất quán giữa 2 path, và prompt directive — rồi chạy toàn bộ suite + typecheck + smoke thật trên storefront. Đây là phase đóng gói: mọi phase trước đều phải có test riêng, phase này tổng hợp + xác minh live. **Đã bổ sung test cho 12 finding của Red Team Session 1** (matrix errorCode âm, sanitize, auth-error fallback, version literal, snapshot timing).

## Requirements

- Functional:
  - Bộ test đơn vị cho: `computeOrigin` (gồm source bất thường), `classifyDiagnostics` (matrix critical/warning — gồm errorCode < 0, -3 aborted, console từ CDN theme), `buffer clear order`, `sanitizeDiagnosticText`/`stripUrlQuery`.
  - Bộ test cho prompt: directive xuất hiện/không xuất hiện theo intent; nhánh auth-error; version bump.
  - So khớp verdict: cùng fake diagnostics → full path vs fallback path cùng `summary.criticalCount`; CẢ HAI đều có `summary` object đầy đủ (Finding 6).
  - Regression test cũ `element-picker-resolution.test.ts:424-425` xanh sau bump version (Finding 8).
  - Smoke thật (manual hoặc CDP script): mở storefront Haravan có tracking 3rd-party lỗi → `theme.qa_validate` không fail; navigate A→B → không lỗi ma.
- Non-functional:
  - Không vô hiệu test cũ; mọi suite hiện có (255 tests) vẫn xanh.
  - Mọi test mới đặt PHẲNG trong `test/main/*.test.ts` — `npm test` (package.json:24) chỉ glob `.compiled/test/main/*.test.js` + `.compiled/test/integration/*.test.js`; test trong thư mục con không bao giờ chạy.

## Architecture

```text
test/main/diagnostics-filter.test.ts   — computeOrigin + classifyDiagnostics matrix + sanitize + stripUrlQuery
test/main/tab-diagnostics.test.ts      — clear on navigation order (mock events) + clear-at-start timing
test/main/annotation-prompt.test.ts    — directive presence/absence + auth-error branch + version
test/main/theme-qa-parity.test.ts      — full path vs fallback path cùng summary.criticalCount (giả lập ports)
npm run verify && npm run typecheck
Smoke: chạy app + theme.qa_validate qua MCP bridge trên storefront live
```

Xem package.json scripts trước (`npm run verify` = typecheck + compile + node --test). Test `classifyDiagnostics`/`computeOrigin` là pure function — không cần Electron; test parity giả lập `ThemeQaWorkflowPorts` bằng stub object (theme-qa-workflow.ts:41-47 — interface `ThemeQaWorkflowPorts`).

## Related Code Files

- Create: `test/main/diagnostics-filter.test.ts`, `test/main/theme-qa-parity.test.ts`
- Create: `test/main/tab-diagnostics.test.ts` (KHÔNG tồn tại hiện tại — verified 2026-08-27; tạo mới với pattern node:test của các test khác trong `test/main/`)
- Create: `test/main/annotation-prompt.test.ts` (KHÔNG tồn tại hiện tại — verified 2026-08-27; tham khảo pattern `contracts.test.ts`)
- Modify: `test/main/element-picker-resolution.test.ts` (:424-425 literal `contract_version: "3.0.0"` → `"3.1.0"` — Finding 8; grep `"3.0.0"` toàn `test/` cho literal khác)
- Docs: `CHANGELOG.md` — mục "fear(qa): trusted diagnostics gate + annotation self-QA prompt" (2 dòng: thay đổi verdict 3rd-party, version contract prompt).

## Implementation Steps

1. Kiểm tra cấu trúc test hiện có: `ls test/`, `package.json` scripts — theo conventions hiện có (không có vitest/jest config; dùng node:test native như các test khác trong `test/main/`).
2. Viết `diagnostics-filter.test.ts`: matrix ít nhất 12 ca:
   - console: 1st-party level 3 → critical; 3rd-party level 3 → warning; CDN theme (hstatic.net) level 3 → critical (Finding 4); level 2 → ignore.
   - network: `errorCode: -105` first-party → critical; `errorCode: -3` (aborted) → warning (Finding 1); `errorCode: 404` (HTTP-style, cho hướng mở rộng) → critical nếu first-party; `isMainFrame` → critical luôn.
   - origin: `""`, `"eval at ..."`, `blob:` → fallback tab origin + `isFirstParty: true` (Finding 7).
   - sanitize: message chứa backtick/`SYSTEM`/control chars → strip/truncate ≤ 200 (Finding 9); URL `?token=...&email=...` → query bị xóa (Finding 10).
   - workspaceRoot traversal `../../Windows` → bị bỏ qua dùng default (Finding 12).
3. Viết `tab-diagnostics.test.ts`: call `clear(tabId)` giữa 2 record batch → batch 2 không chứa batch 1; `clear()` global; **ordering**: clear-at-start giữ record phát sau clear (mô phỏng console error trong parse window — Finding 2).
4. Viết `annotation-prompt.test.ts`: `buildAgentTaskHeader('fix...')` chứa `theme.qa_validate` + `summary.passed` + `criticalCount` + nhánh auth error (Finding 5); intent research không chứa variant implementation; `AGENT_CONTRACT_VERSION === '3.1.0'`.
5. Viết `theme-qa-parity.test.ts`: stub `ThemeQaWorkflowPorts` với `browser.diagnostics` trả fixture; chạy `ThemeQaWorkflow.validate` (full) và code path fallback (tách hàm `buildFallbackQaResult(browser, target, workspaceRoot, params)` ra export) → so sánh `summary.criticalCount` + **assert cả 2 đều có `summary` object** (Finding 6).
6. Sau bump `AGENT_CONTRACT_VERSION`: `grep -rn "3.0.0" test/` → cập nhật mọi literal có chủ đích (Finding 8); verify `element-picker-resolution.test.ts` xanh.
7. Chạy `npm run verify` + typecheck. Sửa lỗi tới khi xanh.
8. Smoke live: chạy app dev, mở storefront, gọi `theme.qa_validate` qua MCP (hoặc nút QA trong app), xác nhận không false-fail 3rd-party + không lỗi ma khi navigate. Ghi kết quả vào phase report.
9. `CHANGELOG.md` + nếu có `docs/operations.md` tham chiếu verdict QA → cập nhật 1 dòng (3rd-party → warning).

## Success Criteria

- [ ] Tất cả test mới xanh; 255+ test cũ vẫn xanh (không xóa/sửa assert cũ trừ literal version có chủ đích — Finding 8).
- [ ] `npm run verify` + typecheck pass.
- [ ] Smoke live xác nhận: storefront có tracking lỗi không fail; navigate không lỗi ma.
- [ ] CHANGELOG cập nhật.

## Risk Assessment

- **Export closure fallback path**: `browser-capabilities.ts` execute được đăng ký dạng closure (`catalogue.register({... execute: async (params, context) => {...}})`) — chưa export được để test. Mitigation: tách logic thành hàm named export `buildFallbackThemeQaResult(browser, params, context)` (thuần, không đụng catalogue) — refactor nhỏ, không đổi behavior. Nếu thấy đắt hơn giá trị, thay bằng test integration qua MCP server thật (tốn hơn) — ưu tiên tách hàm.
- **Snapshot prompt/version literal**: `element-picker-resolution.test.ts:424-425` assert `contract_version: "3.0.0"` — chắc chắn vỡ khi bump. Xử lý: cập nhật có chủ đích + commit message nêu rõ. Không xóa assert.
- **Smoke cần storefront thật + app chạy**: nếu môi trường không mở được storefront (không có project QA), thay bằng fixture HTML giả + CDP local (file://) — đánh dấu giới hạn trong report.
- **MCP auth error khi smoke**: gọi `theme.qa_validate` qua MCP từ ngoài control-plane sẽ trả `ATTACHMENT_REQUIRED` (mcp-server.ts:448-453) — smoke qua app UI hoặc qua control-plane session có claims; nếu chỉ có MCP stdio ngoài, ghi nhận blocking + fallback fixture.

<!-- Updated: Red Team Session 1 - Findings 1, 2, 4, 5, 6, 7, 8, 9, 10, 12 (test matrix mở rộng + version literal + auth smoke) -->