---
phase: 9
title: "Phase 9: Chrome Tab Hibernation (15 phút)"
status: in-progress
priority: P1
effort: "2d"
dependencies: [1]
---

# Phase 9: Chrome Tab Hibernation (15 phút)

## Overview
Tab Chrome nền không dùng ≥ 15 phút → huỷ WebContentsView, giữ state; bấm vào → tạo lại.

## Requirements
- Functional: ngưỡng 15 phút (quyết định user). KHÔNG hibernate: tab active của mỗi window, audible, đang loading, offscreen/ephemeral agent, `automationTabId`, tab có binding MCP/attachment hoặc CDP target đang mở, tab có form dirty (`beforeunload` handler) — tab bị loại trừ giữ nguyên.
- Lưu URL, title, favicon, scroll; hiển thị trạng thái "ngủ" trên tab strip.

## Architecture
Đường recreate: logic trong `switchTab()` và `restoreTabs()` (`native-tab-host.ts`, re-grep line) — đóng gói thành helper tái dùng. Huỷ view = mất CDP session + navigation history back/forward: chấp nhận, ghi rõ UX (chỉ URL được khôi phục). Split mode: dispose cả `mobileView`. Timer quét 60s/host.

## Related Code Files
- Modify: `native-tab-host.ts`, toolbar tab strip
- Test: unit hibernation policy + e2e

## Implementation Steps
1. Tách helper recreate từ switchTab/restoreTabs, test.
2. Policy thuần `shouldHibernate(tab, now)` + test mọi loại trừ.
3. Hibernate/restore; tương thích capture: MCP gọi tab ngủ → tự wake trước thao tác.

## Success Criteria
- [ ] RSS N=7 giảm so baseline — chưa đo: probe `scripts/probe-tab-hibernation.cjs` chứng minh renderer process bị huỷ (pid rời `app.getAppMetrics()`) nhưng chưa có N=7 A/B measurement; đo trong phase 11 certification.
- [ ] `window.background-surface-and-capture-ready` — chưa chạy e2e surface probe (ngoài scope probe này).
- [ ] MCP target tới tab ngủ: wake qua `getTabWebContents`/`ensureTabReady` funnel đã chứng minh probe + unit (tab ngủ → capability call wake + trả wc sống); chưa đo qua full MCP attachment path — cần run sau khi `.compiled` ổn định.

## Risk Assessment
Wake chậm 400-800ms [INFERENCE]. Tab mất state form. Phản ứng: loại trừ dirty form; nếu MCP wake lỗi → loại trừ tab có lịch sử attachment.
