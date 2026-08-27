---
phase: 3
title: "Annotation Self-QA Prompt (P1)"
status: done
priority: P1
effort: "1h"
dependencies: [2]
---

# Phase 3: Annotation Self-QA Prompt (P1)

## Overview

Nối gate đã sạch (phase 1+2) vào vòng làm việc annotation: sửa `annotation-prompt.ts` để mọi prompt annotation yêu cầu agent TỰ gọi `theme.qa_validate` (qua MCP AntiFan) sau khi sửa file, trước khi báo hoàn tất; kèm **fallback bắt buộc** khi agent không có tool MCP AntiFan (đã OBSERVED: `.codex/config.toml` hiện không bind AntiFan MCP server — agent trong IDE chat không thấy `theme.qa_validate`). Đây là P1 "self-QA qua prompt" — KHÔNG phải P2 loop (không có verifying/requeued/blocked, không có auto-requeue).

**OBSERVED (Red Team Session 1, Finding 5):** ngay cả khi bind MCP, mọi tool call qua `AntiFanMcpServer.callTool` đều bị chặn bởi `attachmentClaims` bắt buộc (mcp-server.ts:448-453) — `ATTACHMENT_REQUIRED` trả về khi thiếu claims; `annotation-manager.ts` không phát claims nào (grep sạch). IDE agent KHÔNG thể tự tạo claims hợp lệ. → Directive phải có nhánh handling **auth error** như một dạng fallback: nếu tool gọi được nhưng trả `ATTACHMENT_REQUIRED`/`ATTACHMENT_INVALID` → xử lý như "không có tool" (báo dev xác nhận visual, KHÔNG bịa kết quả). Để P1 thực sự chạy qua MCP, cần thêm cơ chế claims cho IDE agent — ngoài scope repo, ghi trong plan.md "Outside Scope" (điều kiện bật, xem Risk).

## Requirements

- Functional:
  - Mọi `buildAgentTaskHeader` output (annotation prompt) chứa directive: sau khi sửa, gọi `theme.qa_validate` nếu tool có sẵn; chờ kết quả; chỉ báo hoàn tất khi `summary.passed === true && criticalCount === 0`; nếu fail → tự sửa tiếp trong lượt hiện tại (tối đa 2 vòng trong turn), không tự động yêu cầu lượt mới.
  - Fallback (3 nhánh, KHÔNG bịa kết quả):
    1. Tool `theme.qa_validate` KHÔNG có sẵn trong môi trường agent → "không có QA tool, yêu cầu dev xác nhận visual trên AntiFan".
    2. Tool có nhưng trả auth error (`ATTACHMENT_REQUIRED`/`ATTACHMENT_INVALID`/`MCP_CONTEXT_REQUIRED`) → xử lý như nhánh 1, không lặp lại call (Finding 5).
    3. Sau 2 vòng tự sửa vẫn fail → báo kết quả fail trung thực + liệt kê criticalIssues + nhờ dev xác nhận — KHÔNG báo hoàn tất.
  - Directive xuất hiện một lần, đặt sau block "Fable-Thinking Invariant Ledger", trước `STANDALONE_AGENT_CONTRACT` — không lặp trong INTENT_MODULES.
- Non-functional:
  - Không đổi contract `buildAgentTaskHeader(userInstruction, terminalStateOverride)` — append hằng số, không đổi signature.
  - Không chặn READ-ONLY intents (review/research/security/...) — QA directive chỉ áp dụng khi task có sửa file (intent có implementation permission). READ-ONLY: thay bằng "nếu có tool, QA để cung cấp bằng chứng; không bắt buộc".
  - Version bump `AGENT_CONTRACT_VERSION` 3.0.0 → 3.1.0 (thay đổi contract prompt).

## Architecture

```text
buildAgentTaskHeader(...) (annotation-prompt.ts:233-291)
  → selfQaBlock = buildSelfQaDirective(intent, isReadOnly)
      - Implementation intents: "SAU KHI SỬA: gọi theme.qa_validate (nếu tool có). done = summary.passed && criticalCount === 0.
        Fail → tự sửa tiếp (tối đa 2 vòng trong lượt này).
        Không có tool HOẶC tool trả lỗi auth (ATTACHMENT_REQUIRED/INVALID) → báo dev xác nhận visual.
        Hết 2 vòng vẫn fail → báo fail trung thực kèm criticalIssues. CẤM bịa kết quả."
      - READ-ONLY intents: "Nếu tool theme.qa_validate có sẵn, dùng để cung cấp bằng chứng hiện trạng. Không bắt buộc."
  → chèn vào template header giữa Invariant Ledger và STANDALONE_AGENT_CONTRACT
```

Chuỗi directive là hằng số `SELF_QA_DIRECTIVE` export (test so khớp được). Không thêm logic vào AnnotationManager (native-tab-host.ts:3357) — prompt engine là nơi duy nhất thay đổi.

## Related Code Files

- Modify: `src/shared/annotation-prompt.ts` (thêm `SELF_QA_DIRECTIVE`, `buildSelfQaDirective`, gọi trong `buildAgentTaskHeader`, bump version)
- Test (phase 4): TẠO MỚI `test/main/annotation-prompt.test.ts` (KHÔNG tồn tại hiện tại — verified 2026-08-27; mọi test nằm phẳng trong `test/main/*.test.ts` — glob `npm test` không quét thư mục con)
- Modify (bắt buộc khi bump version — Finding 8): `test/main/element-picker-resolution.test.ts:424-425` assert literal `contract_version: "3.0.0"` → cập nhật `"3.1.0"` KÈM lý do; `grep -rn "3.0.0" test/ src/shared/` để bắt mọi literal khác.

## Implementation Steps

1. Đọc test hiện có cho `annotation-prompt` (nếu có) + INTENT_MODULES để biết context chèn.
2. Thêm export `SELF_QA_DIRECTIVE` (implementation variant) + `SELF_QA_DIRECTIVE_READONLY` + helper `buildSelfQaDirective(intent: TaskIntent): string` — nhóm read-only intents: review, research, security, documentation, testing, extract-component (snippet-only không sửa repo — dùng variant read-only).
3. Trong `buildAgentTaskHeader`: sau block Invariant Ledger, chèn `${buildSelfQaDirective(intent)}\n\n`.
4. Bump `AGENT_CONTRACT_VERSION = '3.1.0'` — SAU ĐÓ `grep -rn "3.0.0" test/` và cập nhật mọi literal version trong test (Finding 8: element-picker-resolution.test.ts:424-425 chắc chắn vỡ; test khác kiểm tra tương tự).
5. Không đổi `buildAcceptanceCriteria` (đã có criteria verification cho từng intent).

## Success Criteria

- [ ] Prompt output của `buildAgentTaskHeader('fix lỗi lệch header trên mobile', ...)` chứa chuỗi "theme.qa_validate" VÀ "summary.passed" VÀ "criticalCount" VÀ "CẤM bịa kết quả" VÀ nhánh auth-error ("ATTACHMENT_REQUIRED" hoặc "lỗi auth").
- [ ] Prompt output của intent `research` KHÔNG chứa bắt buộc "SAU KHI SỬA" — hoặc chứa variant read-only đúng.
- [ ] AGENT_CONTRACT_VERSION = 3.1.0.
- [ ] `test/main/element-picker-resolution.test.ts` xanh (literal version đã update có chủ đích).
- [ ] Typecheck + test cũ của annotation-prompt không vỡ (nếu có test snapshot so khớp chính xác → cập nhật snapshot kèm lý do).

## Risk Assessment

- **Agent không có tool MCP (hiện trạng OBSERVED)**: directive rơi vào fallback — vẫn tốt (agent không bịa QA, dev biết cần xác nhận mắt). Bind MCP AntiFan vào IDE là việc ngoài repo — ghi trong plan.md "Outside Scope" + hướng dẫn: chạy `antifan-browser-desktop --mcp-server` và thêm vào IDE config MCP. Khi nào user bind, giá trị 80% tự QA tự bật mà không cần đổi code.
- **Auth error chặn tool (Finding 5 — OBSERVED)**: bind MCP CHƯA ĐỦ — `AntiFanMcpServer.callTool` (mcp-server.ts:448-453) chặn mọi call thiếu `attachmentClaims`; AnnotationManager không phát claims. Hậu quả nếu không xử lý: agent gọi tool → ATTACHMENT_REQUIRED → bối rối, có thể bịa. Đã fix bằng nhánh auth-error trong directive. ĐIỀU KIỆN BẬT P1 thật sự (ghi Outside Scope): cấp claims scoped read-only cho IDE agent hoặc thêm đường unauthenticated read cho `theme.qa_validate` (quyết định security — để user chọn khi cần).
- **Version bump phá test (Finding 8)**: `element-picker-resolution.test.ts:424-425` assert `contract_version: "3.0.0"` literal → vỡ ngay khi bump. Xử lý: update có chủ đích + grep toàn cục literal. KHÔNG xóa assert.
- **Agent bỏ qua directive (kỷ luật LLM)**: đây là giới hạn của P1 — P2 (control-plane) mới ép được; đã chốt hoãn P2 tới khi đo được tần suất re-prompt. Không "sửa" bằng cách thêm cơ chế đếm trong repo lúc này.

<!-- Updated: Red Team Session 1 - Findings 5, 8 (auth-error fallback, version literal tests) -->