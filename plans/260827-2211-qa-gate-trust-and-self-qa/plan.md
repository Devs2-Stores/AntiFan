---
title: "QA Gate Trust (Item A) + Annotation Self-QA Prompt (P1)"
description: "Làm gate QA tin cậy (origin filter, buffer clear theo navigation, console/network fail-fast) rồi nối vào prompt annotation để agent tự QA sau khi sửa. P2 loop bị hoãn."
status: done
priority: P1
effort: "0.5-1d"
tags: [qa, theme, annotation, reliability]
created: 2026-08-27
extends: "260827-1600-theme-qa-automation-and-verification-gate"
---

# QA Gate Trust (Item A) + Annotation Self-QA (P1)

## Overview

`ThemeQaWorkflow.validate` hiện báo kết quả dựa trên buffer diagnostics **không được clear theo navigation** (lỗi cũ từ trang trước làm sai kết quả trang mới) và **không lọc theo origin** (console/network lỗi của GTM, FB Pixel, chat widget bị tính là lỗi theme). Mục tiêu: gate QA trở nên đáng tin (0 lỗi ma, 0 false-fail do third-party) — nền móng bắt buộc trước khi trao cho agent tự QA. Sau đó nối gate đã sạch vào prompt annotation (P1) qua một module filter chung dùng cho cả đường full validate lẫn đường fallback `browser-capabilities.ts`.

**Không làm (đã quyết định ở lượt brainstorm/ultra):** P2 control-plane loop (verifying/requeued/blocked, cap attempts) — hoãn vô thời hạn cho tới khi đo được tần suất re-prompt thực tế. Không sửa sanitizePii (ngoài phạm vi; chỉ đảm bảo findings đưa vào prompt không chứa stack trace thô — thay vào đó `sanitizeDiagnosticText`/`stripUrlQuery` trong module filter mới).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | `ThemeQaWorkflow.validate` không bao giờ fail vì lỗi cũ từ trang trước (buffer clear on navigation) | P1 |
| 2 | Fail-fast console error (level ≥3) + network failure chỉ tính lỗi first-party/theme-asset; third-party chỉ thành warning | P1 |
| 3 | Một module filter chung dùng cho cả `theme-qa-workflow.ts` full path lẫn fallback `browser-capabilities.ts:106-142` | P1 |
| 4 | `annotation-prompt.ts` yêu cầu agent tự gọi `theme.qa_validate` sau khi sửa, kèm fallback khi IDE chưa bind MCP AntiFan (3 nhánh: no-tool / auth-error / fail-sau-2-vòng) | P2 |
| 5 | 255+ tests hiện có vẫn xanh; thêm test cho filter mới | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Diagnostics buffer clear + origin-scoped capture](./phase-01-diagnostics-buffer-and-origin-clear.md) | Done |
| 2 | [Shared testability filter module](./phase-02-shared-testability-filter.md) | Done |
| 3 | [Annotation self-QA prompt (P1)](./phase-03-annotation-self-qa-prompt.md) | Done |
| 4 | [Tests & verification](./phase-04-tests-and-verification.md) | Done |

## Success Criteria

- [x] Scan QA trên cùng một tab, navigate A→B: kết quả B không chứa lỗi của A — `clear(tabId)` tại `did-start-navigation` gate (main-frame, !isInPlace, authorityPane), verified: `tab-diagnostics.test.ts` clear ordering + `native-tab-host.ts:1728-1737`; race chống Finding 11 bằng snapshot diagnostics tại đầu `validate()` trước MỌI await.
- [x] Storefront có GTM/FB Pixel/chat widget lỗi: `summary.passed` vẫn `true` — third-party → warning (classifyDiagnostics + step-5 correlation restricted), verified: `diagnostics-filter.test.ts` + `theme-qa-parity.test.ts` test #2 (third-party-only pass trên CẢ HAI path).
- [x] Console error level ≥3 (first-party/theme-asset) hoặc network failure (Chromium NetError âm, trừ -3 aborted) của asset first-party theme: fail-fast, `criticalCount` tăng — matrix 28 ca trong `diagnostics-filter.test.ts` (Finding 1, 4).
- [x] `browser-capabilities.ts` fallback path và `theme-qa-workflow.ts` full path trả kết quả nhất quán trên cùng dữ liệu; CẢ HAI đều có `summary` object đầy đủ — verified: `theme-qa-parity.test.ts` (`summary.criticalCount` + `passed` bằng nhau, cả 2 có summary — Finding 6).
- [x] Prompt annotation có directive self-QA + 3 nhánh fallback rõ ràng (no-tool / auth-error / fail-sau-2-vòng) — `SELF_QA_DIRECTIVE` có ATTACHMENT_REQUIRED/INVALID/MCP_CONTEXT_REQUIRED + "CẤM bịa kết quả"; verified `annotation-prompt.test.ts`; read-only intents dùng variant không bắt buộc.
- [x] `npm run verify` + typecheck xanh — 306/306 tests pass (255 baseline + 51 mới), smoke:theme-qa PASS. Chi tiết: `reports/harness/verification.json`.

## Outside Scope (Stop Rules)

- P2 control-plane loop (hoãn — plan riêng khi có telemetry).
- Sửa `sanitizePii` / artifact store / PII policy (sanitize mới nằm trong `diagnostics-filter.ts`, không đụng file cũ).
- Thêm UI state mới (toolbar attempt states) — thuộc P2.
- Bind MCP AntiFan vào IDE chat (hướng dẫn, không code trong repo này). **LƯU Ý (Red Team Finding 5):** bind CHƯA ĐỦ — `AntiFanMcpServer.callTool` chặn mọi call thiếu `attachmentClaims` (mcp-server.ts:448-453); AnnotationManager không phát claims. Điều kiện bật P1 đầy đủ: cấp scoped read claims cho IDE agent hoặc thêm đường unauthenticated read — quyết định security để user chọn, ngoài repo này.

## Validation Log

### Verification Results (2026-08-27, Standard tier — Fact Checker + Contract Verifier)

- Claims checked: 12
- Verified: 11 | Failed: 1 | Unverified: 0
- Tier: Standard
- Failures:
  - `test/main/annotation-prompt.test.ts` KHÔNG tồn tại (phase 3/4 ghi "Modify" → đã sửa thành Create).
  - `test/main/tab-diagnostics.test.ts` KHÔNG tồn tại (phase 4 ghi "Modify" → đã sửa thành Create).
- Verified highlights (bằng chứng):
  - `did-start-navigation` native-tab-host.ts:1721 có `isMainFrame` param — phase 1 clear-on-nav khả thi đúng thiết kế.
  - `did-navigate-in-page` native-tab-host.ts:1888 (hash navigation) tách biệt — KHÔNG clear, đúng yêu cầu.
  - `recordConsole` native-tab-host.ts:1713, `recordFailure` :1738 — call sites phase 1 chính xác.
  - `AGENT_CONTRACT_VERSION = '3.0.0'` annotation-prompt.ts:6 — phase 3 bump hợp lệ.
  - `ThemeQaWorkflowPorts` theme-qa-workflow.ts:41-47 — stub test parity khả thi.
  - `npm test` glob chỉ phẳng `test/main/*.test.js` + `test/integration/*.test.js` (package.json:24) — mọi test mới phải nằm phẳng.
  - MCP IDE config: `.codex/config.toml` KHÔNG có AntiFan server — fallback P1 là đường chính hiện tại.

### Validation Session 1 — Decisions

1. **Test files**: `annotation-prompt.test.ts` + `tab-diagnostics.test.ts` không tồn tại → Create mới, không Modify (đã propagate vào phase 3/4).
2. **Buffer clear timing**: ~~giữ 2 phương án...~~ **SUPERSEDED bởi Red Team Finding 2** (2026-08-27): pendingClear tại did-finish-load XÓA lỗi console phát trong lúc parse → đổi chính thức thành clear đồng bộ tại did-start-navigation (gate `authorityPane === paneId`), không còn lựa chọn cho cook.
3. **P2 loop**: xác nhận lại hoãn — không có telemetry tần suất re-prompt (grep sạch), ASSUMED attended workflow giữ nguyên.

## Red Team Review

### Session 1 — 2026-08-27
**Findings:** 14 unique (18 raw, dedup 4) | **Accepted:** 12 | **Rejected:** 2
**Severity breakdown:** 4 Critical, 7 High, 1 Medium accepted; 2 rejected
**Reviewers:** Security Adversary (8 findings), Assumption Destroyer (5), Failure Mode Analyst (5) — Standard tier (Fact Checker + Contract Verifier)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Network filter `errorCode >= 400` là dead code (did-fail-load trả mã Chromium âm) | Critical | Accept | Phase 2 |
| 2 | pendingClear tại did-finish-load xóa lỗi bootstrap (console error trong parse window) | Critical | Accept | Phase 1 |
| 3 | Split-mode: desktop/mobile share tabId → mirror navigation xóa diag pane kia | Critical | Accept | Phase 1 |
| 4 | Console filter bỏ sót THEME_ASSET_HOSTS → CDN theme crash thành warning | Critical | Accept | Phase 2 |
| 5 | MCP attachmentClaims chặn mọi call của IDE agent (ATTACHMENT_REQUIRED) | High | Accept | Phase 3, Outside Scope |
| 6 | Fallback path thiếu `summary` → contract P1 `summary.passed` undefined | High | Accept | Phase 2 |
| 7 | `new URL('')` throw trên source rác (eval/blob/empty) trong main process | High | Accept | Phase 1 |
| 8 | `AGENT_CONTRACT_VERSION` bump vỡ `element-picker-resolution.test.ts:424-425` | High | Accept | Phase 3/4 |
| 9 | Prompt injection qua raw console message (untrusted storefront text → agent prompt) | High | Accept | Phase 2 |
| 10 | PII qua query params URL (`?apiKey&token&email`) — sanitizePii không bắt | High | Accept | Phase 2 |
| 11 | Race: validate đọc diagnostics giữa flow (sau asset scan) vs navigation clear | High | Accept | Phase 2 |
| 12 | `workspaceRoot` không confine → PlatformDetector đọc file ngoài workspace | Medium | Accept | Phase 2 |
| 13 | Suffix-match spoofing multi-tenant (attacker-store.myharavan.com) | Medium | **Reject**: base = hostname storefront tab cụ thể (phase-01:36), không phải apex; `attacker-store.*` không endsWith `.victim-store.*`; chỉ cần chú thích "không dùng apex" — đã thêm vào phase-01 Risk | — |
| 14 | "CẤM bịa kết quả" không enforce (P2 postponed) | Medium | **Reject**: quyết định scope đã chốt ở brainstorm/ultra; P1 prompt-only có giới hạn đã ghi trong Risk phase 3 | — |

### Whole-Plan Consistency Sweep (Red Team Session 1)
- Files reread: plan.md, phase-01, phase-02, phase-03, phase-04 (rewrite full — engine diff lỗi, đã ghi sạch từng file)
- Decision deltas checked: 4 (clear timing đảo chiều; network rule đổi sang Chromium âm; summary shape bắt buộc 2 path; MCP claims note)
- Reconciled stale references: 6 (success criteria 4xx/5xx → Chromium âm; Goals "228+" → "255+"; Decision 2 superseded; phase-02 network rule; phase-04 test matrix; phase-03 fallback 2 nhánh → 3 nhánh)
- Unresolved contradictions: 0
- Khuyến nghị: proceed to cook (sau khi user duyệt findings đã apply).