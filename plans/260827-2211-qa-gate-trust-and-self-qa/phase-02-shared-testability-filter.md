---
phase: 2
title: "Shared Testability Filter Module"
status: done
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 2: Shared Testability Filter Module

## Overview

Tạo module `diagnostics-filter.ts` dùng CHUNG cho (a) `ThemeQaWorkflow.validate` full path (theme-qa-workflow.ts:181 area — diagnostics correlation) và (b) fallback quick path `browser-capabilities.ts:106-142` (`theme.qa_validate` execute, hiện **không** goi `browser.diagnostics`). Module quyết định: lỗi nào là fail-fast (critical), lỗi nào chỉ warning, dựa trên origin + error class. Fail-fast: console error level ≥3 VÀ first-party/theme-asset; network failure (lỗi Chromium âm hoặc HTTP status) VÀ first-party/theme-asset. Third-party → warning chỉ.

## Requirements

- Functional:
  - `classifyDiagnostics({ console, failures }, contextUrl, opts?)` → `{ criticalIssues: Array<{ kind, message, origin }>, warnings: Array<{...}> }`.
  - Console: `level >= 3 && (isFirstParty || origin trong allowlist theme-asset)` → critical; `level >= 3 && third-party` → warning; `level < 3` → ignore. **Console phải xét THEME_ASSET_HOSTS như network** (Red Team Finding 4: theme.js từ CDN hstatic.net/shopifycdn.com mang origin CDN → không xét allowlist sẽ bị hạ xuống warning dù là code theme crash).
  - Network: `errorCode` là mã **Chromium NetError ÂM** (did-fail-load, native-tab-host.ts:1738 — KHÔNG phải HTTP status; `errorCode >= 400` sẽ KHÔNG BAO GIỜ đúng với số âm → dead code — Red Team Finding 1). Rule: `errorCode < 0 && errorCode !== -3` (trừ ERR_ABORTED, user cancel) && (isFirstParty || theme-asset) → critical; NẾU entry có `status` HTTP ≥ 400 (mở rộng tương lai) thì dùng status. `isMainFrame` failures → luôn critical (trang không load được).
  - Allowlist theme-asset host (hstatic.net, shopifycdn.com, cdn.shopify.com, cdn.sapo.vn...) là hằng số export, có thể override qua `opts`.
  - Output dùng được ở cả 2 call sites (không import vòng). Output chỉ chứa text đã sanitize — KHÔNG bao giờ raw stack trace/HTML/URL có query params (Red Team Findings 9, 10).
  - Fallback path trả **shape khớp ThemeQaReport**: phải có `summary: { passed, totalIssues, criticalCount }` — agent P1 đọc `summary.passed`/`criticalCount` (Red Team Finding 6; browser-capabilities.ts:106 hiện thiếu summary → undefined → P1 vỡ).
  - `workspaceRoot` truyền vào fallback phải được confine về workspace hợp lệ (Red Team Finding 12): resolve path và kiểm tra nằm trong workspace root hiện tại hoặc `getWorkspaceRoot()`; nếu traversal (`..`, absolute lạ) → bỏ qua, dùng default.
- Non-functional: pure function, không I/O, testable. KISS: không generic, không config file.

## Architecture

```text
src/main/qa/diagnostics-filter.ts
  computeOrigin         (move từ phase 1 — export chung tại đây để phase 1 import)
  THEME_ASSET_HOSTS     = ['hstatic.net', 'shopifycdn.com', 'cdn.shopify.com', 'cdn.sapo.vn'...]
  sanitizeDiagnosticText(text)  — strip control chars/backticks/delimiter, truncate 200 chars (Red Team Finding 9)
  stripUrlQuery(url)            — URL không còn query params (PII tokens) (Red Team Finding 10)
  classifyDiagnostics() → { criticalIssues, warnings }   // cả console lẫn failures qua sanitize

theme-qa-workflow.ts:181 area  → thêm bước 5.5: classify → merge vào assetResult/liquidResult + checklist
browser-capabilities.ts:110-135 → thêm goi browser.diagnostics + classify → checklist.diagnostics + summary ALWAYS
```

Cả 2 path trả object chứa `summary` (với `criticalCount`) / `checklist.diagnostics`; module giữ riêng trách nhiệm "critical hay warning", caller quyết định nhét vào field nào. Đảm bảo **cùng dữ liệu → cùng verdict** ở 2 path (mục tiêu 3).

## Related Code Files

- Create: `src/main/qa/diagnostics-filter.ts`
- Modify: `src/main/qa/theme-qa-workflow.ts` (bước 5.5 sau asset telemetry: `const diag = classifyDiagnostics(diagnostics, tabUrl); if (diag.criticalIssues.length) { assetResult / checklist / criticalCount }`)
- Modify: `src/main/tools/browser-capabilities.ts` (fallback `theme.qa_validate`: thêm `browser.diagnostics` + `classifyDiagnostics` + build `summary` shape)
- Modify: `src/main/browser/tab-diagnostics.ts` (re-export `computeOrigin` từ module mới để phase 1 không import vòng chéo)

## Implementation Steps

1. Tạo `diagnostics-filter.ts`: `computeOrigin`, `THEME_ASSET_HOSTS`, `sanitizeDiagnosticText`, `stripUrlQuery`, `classifyDiagnostics` — pure functions, nhận entries dạng `{level, message, source, errorCode, validatedURL, isMainFrame, origin?, isFirstParty?}` (import type only từ `tab-diagnostics.ts` để tránh runtime cycle).
2. Trong `ThemeQaWorkflow.validate`: SNAPSHOT diagnostics tại ĐẦU validate (trước mọi `await` — Red Team Finding 11: đọc muộn ở bước 5.5 race với navigation clear; `browser.diagnostics` trả mảng copy sẵn — tab-diagnostics.ts:76-81). Sau đó ở bước 5.5 (theme-qa-workflow.ts:181-207): chạy `classifyDiagnostics` trên snapshot; critical → push vào finding mới `diagnosticIssues`, `checklist.diagnostics = ... && diag.criticalIssues.length === 0`, `summary.criticalCount += diag.criticalIssues.length`.
3. Fallback `browser-capabilities.ts` `theme.qa_validate` execute: trước khi build return, gọi `browser.diagnostics(target.tabId)` + `classifyDiagnostics`; return phải chứa `summary: { passed: !liquid.hasErrors && !assets.hasBrokenAssets && diag.criticalIssues.length === 0, totalIssues: diag.criticalIssues.length + diag.warnings.length, criticalCount: diag.criticalIssues.length }` + checklist.diagnostics cùng công thức (Red Team Finding 6). Confine `workspaceRoot` params (Finding 12).
4. Gỡ import cũ trong tab-diagnostics.ts nếu computeOrigin từng được định nghĩa ở phase 1 tại file đó (chuyển hẳn về module mới — một nguồn duy nhất).
5. Mở rộng `getDiagnostics` (tùy chọn): nếu cần HTTP status cho network, thêm webRequest listener — GHI NHẬN là enhancement chờ, KHÔNG bắt buộc trong phase này (did-fail-load chỉ trả mã âm; 4xx/5xx không fire did-fail-load — Finding 1).

## Success Criteria

- [ ] `classifyDiagnostics` unit test: console error 3rd-party → warning (không critical); console error 1st-party level 3 → critical; console error từ CDN theme (hstatic.net) → critical; network `errorCode: -105` first-party → critical; `errorCode: -3` (aborted) → warning; `isMainFrame` failure → critical luôn.
- [ ] Sanitize: console message chứa `"]; SYSTEM: ignore` → bị strip control/backtick và truncate; URL có `?token=...&email=...` → query bị xóa (Finding 9, 10).
- [ ] Full path và fallback path cho SAME fake diagnostics trả `summary.criticalCount` bằng nhau VÀ cả 2 đều có `summary` object đầy đủ (Finding 6).
- [ ] `workspaceRoot: '../../../../Windows'` bị bỏ qua, fallback dùng workspace default (Finding 12).
- [ ] `browser-capabilities.ts` fallback giờ gọi `browser.diagnostics` (test spy hoặc smoke).
- [ ] `npm run verify` xanh.

## Risk Assessment

- **Import cycle**: `qa/diagnostics-filter` import type từ `browser/tab-diagnostics`; tab-diagnostics re-export từ qa module → cycle tĩnh. Mitigation: `import type` cho interface, hoặc tự khai báo interface thân thiện trong module filter.
- **Allowlist thiếu host**: host asset third-party lạ → warning thay vì critical = an toàn (không fail oan), chấp nhận.
- **Thay đổi verdict so với trước**: dữ liệu 3rd-party giờ thành warning → `criticalCount` giảm trên store có tracking lỗi — ĐÂY LÀ MỤC ĐÍCH (bỏ false-fail), không phải regression. Ghi rõ trong CHANGELOG.
- **Prompt injection (Finding 9)**: `message` từ console là untrusted input đi vào prompt agent (P1). Mitigation: `sanitizeDiagnosticText` strip control chars + backtick + `[SYSTEM`/role markers + truncate 200 chars. KHÔNG đụng `sanitizePii` (stop rule).
- **PII qua query params (Finding 10)**: `validatedURL`/`source` có thể chứa `?apiKey=..&token=..&email=..`; `sanitizePii` (theme-qa-workflow.ts:57-59) chỉ bắt `bearer ` / `token=` literal. Mitigation: `stripUrlQuery` trên mọi URL trước khi vào report/findings.
- **Network errorCode âm (Finding 1)**: plan cũ dùng `errorCode >= 400` — dead code (did-fail-load chỉ trả mã Chromium âm). Rule mới: âm trừ -3. Ghi chú: HTTP status 4xx/5xx hiện KHÔNG có nguồn dữ liệu (chỉ did-fail-load) — thêm webRequest/CDP nếu cần, đánh dấu enhancement.
- **workspaceRoot traversal (Finding 12)**: caller cấp path tùy ý → PlatformDetector.detect đọc file ngoài workspace (platform-detector.ts:24,61). Mitigation: confine path.resolve vào workspace root; sai → default.

<!-- Updated: Red Team Session 1 - Findings 1, 4, 6, 9, 10, 11, 12 -->