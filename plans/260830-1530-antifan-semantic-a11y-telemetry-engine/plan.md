---
title: "AntiFan Semantic A11y Tree, Ref-Targeted Actions & Live Telemetry Engine"
description: "Implementation plan upgrading AntiFan Desktop Browser MCP with Playwright-grade token-pruned A11y snapshots, zero-shot Ref targeting, async hydration quiescence gates, and live console/network telemetry sniffer."
status: superseded
superseded_by: "plans/260830-1617-runtime-resilience-and-semantic-hardening/plan.md"
priority: P1
effort: "4 phases"
tags: [antifan, mcp, a11y, cdp, electron, browser, telemetry, playwright-parity, hydration]
created: 2026-08-30
superseded_date: 2026-08-30
---

# AntiFan Semantic A11y Tree & Telemetry Engine (SUPERSEDED)

> [!WARNING]
> **Kế hoạch này đã được THAY THẾ TOÀN DIỆN (SUPERSEDED) bởi Kế hoạch 1617:**
> 👉 [`plans/260830-1617-runtime-resilience-and-semantic-hardening/plan.md`](../260830-1617-runtime-resilience-and-semantic-hardening/plan.md)
> 
> **Lý do thay thế & đối chiếu kiến trúc thực tế:**
> 1. **Semantic Snapshot & @ref:** Thay vì dùng CDP `Accessibility.getFullAXTree` thô (làm mất ngữ nghĩa Liquid `section-id`, `product-id`), AntiFan sử dụng động cơ in-page `src/main/browser/agent-browser.ts` (`window.__antifanAgentSnapshot`, `__antifanRefMap`, `querySelectorDeep`, `getElementGlobalRect`) vừa quét Shadow DOM / nested iframes, vừa bảo toàn 100% ngữ nghĩa theme E-commerce.
> 2. **Telemetry & Diagnostics:** Thay vì tạo daemon `TelemetryBufferService` riêng biệt, AntiFan sử dụng `TabDiagnosticsManager` (`src/main/browser/tab-diagnostics.ts`) và `diagnostics-filter.ts` quản lý ring buffer 200 entries theo từng tab, tự động phân loại lỗi First-party vs Third-party.
> 3. **Non-Blocking QA & Epoch Guard:** Thay vì scrape private React Fiber keys (`__reactContainer$*`), AntiFan dùng `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`) hủy bỏ tác vụ quét cũ ngay khi `documentGeneration` tăng.
> 4. **Dual Split-View:** Hoàn thiện qua `src/main/browser/split-review-coordinator.ts` và `NativeTabHost` (view Desktop + mobileView).
> 5. Toàn bộ mã nguồn thực tế đã được triển khai và kiểm chứng 100% trong commit `fe98aef`.

## Original Overview
Upgrade AntiFan Browser MCP with Playwright-grade zero-shot semantic automation capabilities while retaining AntiFan's proprietary visual agent cursor, multi-pane split-view, and E-commerce theme QA contracts.

## Phased Roadmap (Superseded)
| Phase | Title | Status | Priority | Deliverables |
|---|---|---|---|---|
| **Phase 1** | CDP A11y Serializer & Ref Registry | superseded | P1 | Covered by `agent-browser.ts` in Plan 1617 |
| **Phase 2** | Ref-Targeted Cursor & Hydration Gate | superseded | P1 | Covered by `NativeTabHost` + `AsyncThemeQaQueue` in Plan 1617 |
| **Phase 3** | Telemetry Ring Buffer & Inline Diagnostics | superseded | P2 | Covered by `TabDiagnosticsManager` + `diagnostics-filter.ts` in Plan 1617 |
| **Phase 4** | Theme QA Parity & Dual-WebContentsView Split | superseded | P1 | Covered by `split-review-coordinator.ts` + `theme-qa-workflow.ts` in Plan 1617 |
