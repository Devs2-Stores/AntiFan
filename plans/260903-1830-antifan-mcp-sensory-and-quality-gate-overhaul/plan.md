# Plan: AntiFan MCP Sensory Engine & Quality Gate Overhaul

**ID:** `260903-1830-antifan-mcp-sensory-and-quality-gate-overhaul`  
**Date:** 2026-09-03  
**Status:** In Progress  
**Mode:** `--parallel --advice --auto`  
**Author:** Principal Systems & Reliability Engineer  
**Supervisor:** Khổng Minh (Kongming Adversarial Advisory)

---

## 1. Context & Problem Statement
Phiên benchmark `roahtrip.com` vừa qua đã phát hiện 4 điểm yếu chí mạng trong AntiFan:
1. `captureScreenshot({ fullPage: true })` bị dính hard timeout 5s trong `tab-devtools-host.ts:688`, âm thầm rơi về `wc.capturePage(rect)` (viewport) sinh ra kết quả giả `0% mismatch`.
2. Schema MCP trong `scripts/antifan-omp-mcp.cjs` khuyết thiếu các tham số `fullPage`, `maskSelectors`, `normalizeScroll`.
3. Agent phải gọi `anti_browser_evaluate` 229 lần để tự đo đạc box model, đếm section, dễ gây lỗi cú pháp và bỏ sót khối Newsletter ngoài `<main>`.
4. Thiếu công cụ đóng băng media dynamic (`media.freeze`) và cổng kiểm định `HTML_SPEC_READY`.

---

## 2. Opening Contract
* **Outcome:** Nâng cấp AntiFan Core Host, MCP Server Schema, bổ sung bộ công cụ Semantic Inspector, triệt tiêu silent fallback, và tạo chốt chặn kiểm thử chất lượng.
* **Constraints:** Không thêm dependency ngoài cồng kềnh; zero TypeScript compiler errors; tương thích 100% với `@modelcontextprotocol/sdk`.
* **Non-goals:** Không nhúng Playwright vào core; không sinh Liquid trực tiếp; không can thiệp theme bên ngoài.
* **Acceptance Criteria:**
  1. `captureScreenshot` tăng timeout lên 20s và fail-closed khi `isFullPage: true`.
  2. `scripts/antifan-omp-mcp.cjs` công khai đầy đủ schema cho `anti.visual.compare`, `anti.screenshot.viewport`, và các semantic tools mới.
  3. Bổ sung `anti.media.freeze` và `anti.inspect.page_inventory` vào `browser-control-port.ts` / `browser-capabilities.ts`.
  4. `npm run typecheck` PASS 100%.
  5. Test suites PASS.
  6. Git conventional commit & push.

---

## 3. Work Breakdown & Touchpoints
- `src/main/browser/tab-devtools-host.ts`: Nâng timeout 20s, khử silent fallback khi `isFullPage: true`.
- `scripts/antifan-omp-mcp.cjs`: Bổ sung schema `fullPage`, `normalizeScroll`, `maskSelectors`, `anti.media.freeze`, `anti.inspect.page_inventory`.
- `src/main/tools/browser-control-port.ts`: Thêm xử lý `anti.media.freeze`, `anti.inspect.page_inventory`.
- `src/main/tools/browser-capabilities.ts`: Đăng ký catalogue các capabilities mới.
