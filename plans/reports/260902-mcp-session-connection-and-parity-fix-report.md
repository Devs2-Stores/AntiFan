# AntiFan MCP Session Lifecycle, Screenshot ArtifactRef, & Playwright Parity Completion Report

**Date:** 2026-09-02  
**Project:** AntiFan Browser Desktop (`antifan-browser-desktop`)  
**Status:** `VERIFIED_COMPLETE` (43/43 tests passed, live Electron smoke passed, git pushed)

---

## 1. Tóm Tắt Sự Cố & Phân Tích Hiện Tượng (Incident Analysis)

Trong quá trình Agent vận hành tự động hóa trên AntiFan Browser qua giao thức MCP (Model Context Protocol), nhiều lỗi liên tiếp xảy ra trong cùng một phiên làm việc:

1. **Lỗi Screenshot ArtifactRef**: `Error: {"code":"CAPABILITY_ERROR","message":"Expected ArtifactRef metadata from screenshot capability"}`
2. **Lỗi Schema MCP Cursor Type**: `Validation failed for tool "anti_agent_cursor_type": - selector: is required`
3. **Lỗi Quyền Thực Thi Eval**: `POLICY_DENIED: Capability anti.browser.evaluate is not enabled by the current policy`
4. **Lỗi Mất Đồng Bộ Tab & Revision**: `TARGET_MISMATCH: Tab ID mismatch: expected ..., got ...` và `CAPABILITY_NOT_FOUND: Unknown tab ID`

---

## 2. Nguyên Nhân Gốc Rễ & Giải Pháp Mã Nguồn (Root Causes & Solutions)

### 2.1 Khởi Tạo `BrowserControlPort` Thiếu `ArtifactSink` (`src/main/index.ts`)
- **Nguyên nhân:** Tại `src/main/index.ts` (dòng 218–254), `BrowserControlPort` được khởi tạo bằng `new BrowserControlPort(hostPort)` mà không truyền `controlPlane.artifacts`. Khi không có `ArtifactSink`, phương thức `screenshot()` trả về chuỗi Base64 trực tiếp thay vì `ArtifactRef`. Proxy `scripts/antifan-omp-mcp.cjs` mong đợi đối tượng `ArtifactRef` (`{ kind: 'screenshot', id: 'artifact-...', mime: 'image/png' }`) để tải binary qua HTTP `/api/artifacts/:id`. Khi nhận chuỗi string, proxy ném `CAPABILITY_ERROR`.
- **Khắc phục:** Truyền `controlPlane.artifacts` vào constructor:
  ```typescript
  const browserPort = new BrowserControlPort({
    ...
  }, controlPlane.artifacts);
  ```

### 2.2 Đồng Bộ Schema Công Cụ MCP (`scripts/antifan-omp-mcp.cjs`)
- **Nguyên nhân:** Schema proxy đặt `required: ['selector', 'text']` cho `anti.agent.cursor.type` và không định nghĩa trường `ref: { type: 'string' }`. Khi Agent gửi ref `@e1` mà không có CSS selector, validator của MCP từ chối nhận lệnh.
- **Khắc phục:**
  - Bổ sung `ref: { type: 'string' }` cho toàn bộ các công cụ cursor (`type`, `click`, `hover`, `move`, `scroll`, `highlight`).
  - Đổi `required` của `anti.agent.cursor.type` thành `['text']`.
  - Đăng ký công cụ chuẩn Playwright `browser_find` và `browser_press_key`.

### 2.3 Cách Ly Trạng Thái Regular Expression & Chuẩn Hóa Bàn Phím
- **`src/main/browser/semantic-ref-registry.ts`:** Loại bỏ các cờ stateful `/g` và `/y` trong biểu thức chính quy của `findInSnapshot` để tránh ô nhiễm `lastIndex` làm bỏ sót phần tử xen kẽ.
- **`src/main/browser/keyboard-normalizer.ts`:** Xử lý tổ hợp phím chứa dấu cộng đuôi (`Control++`, `Shift++`, `+`) và ném lỗi fail-closed khi gặp phím cụt (`Ctrl+`).
- **`src/main/browser/tab-automation-host.ts`:** Tránh deadlock tái nhập trên hàng đợi `runTargetOperation` khi snapshot trên cold tab bằng cách gọi trực tiếp `internalCollectSnapshot`.

---

## 3. Danh Sách Tệp Đã Thay Đổi (Touched Files)

| Tệp tin | Mô tả thay đổi |
| :--- | :--- |
| `src/main/index.ts` | Truyền `controlPlane.artifacts` vào constructor `BrowserControlPort`. |
| `scripts/antifan-omp-mcp.cjs` | Bổ sung `ref` vào schema cursor tools, relax `required: ['text']`, đăng ký `browser_find` / `browser_press_key`. |
| `src/main/browser/semantic-ref-registry.ts` | Strip cờ `/g`/`/y` trong regex findInSnapshot. |
| `src/main/browser/keyboard-normalizer.ts` | Hardening tổ hợp phím trailing plus và validation. |
| `src/main/browser/tab-automation-host.ts` | Tránh deadlock tái nhập trên hàng đợi operation. |
| `src/main/mcp/mcp-server.ts` | Đăng ký alias và schema Playwright tools. |
| `test/main/mcp-industrial-e2e.test.ts` | Thêm test E2E HTTP image stream, ref-only type, browser_find, tab create -> screenshot -> action. |
| `test/main/playwright-parity-kernel.test.ts` | Thêm test ArtifactRef staging và schema validation. |
| `scripts/smoke-mcp-industrial-e2e.cjs` | Tích hợp Milestone 6 kiểm thử live Electron: create tab ➔ screenshot ➔ browser_find ➔ ref-only type. |

---

## 4. Kết Quả Kiểm Thử (Verification Metrics)

- **TypeScript Typecheck**: `npm run typecheck` ➔ **0 errors**.
- **Unit & Integration Test Suites**: **43/43 tests passed**.
  - `test/main/mcp-industrial-e2e.test.ts`: **6/6 passed**.
  - `test/main/omp-mcp-adapter.test.ts`: **5/5 passed**.
  - `test/main/playwright-parity-kernel.test.ts`: **19/19 passed**.
  - `test/main/semantic-ref-registry.test.ts`: **13/13 passed**.
- **Live Electron Smokes**:
  - `scripts/smoke-playwright-parity.cjs`: **6/6 milestones passed**.
  - `scripts/smoke-mcp-industrial-e2e.cjs`: **6/6 milestones passed** (bao gồm tạo tab ➔ chụp ảnh ➔ tìm ref ➔ gõ chữ bằng ref-only và xác thực DOM events `isTrusted === true`).

---

## 5. Trạng Thái Git

- **Commit**: `fix(mcp): wire artifact sink, relax cursor schema, and harden playwright parity` (`66cee88`)
- **Remote**: Đã đẩy lên nhánh `main` (`Devs2-Stores/AntiFan.git`).
