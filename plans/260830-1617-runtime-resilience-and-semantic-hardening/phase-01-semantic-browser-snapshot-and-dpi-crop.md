---
phase: 1
title: "Semantic Snapshot Wiring, @ref Contract Integration & Frame Walker Extension"
status: completed
priority: P1
effort: "3-4d"
dependencies: []
---

# Phase 1: Semantic Snapshot Wiring, @ref Contract Integration & Frame Walker Extension

<!-- Updated: Validation Session 1 - Same-Origin iframe strategy confirmed -->

## Overview
Khắc phục điểm nghẽn nhận thức của Agent: Sửa hàm `NativeTabHost.agentSnapshot()` để gọi trực tiếp `window.__antifanAgentSnapshot()` thay vì gọi `getDom()` thô; mở rộng hợp đồng `ref` qua `BrowserActionRegistry` và `agentClick` để hỗ trợ click trực tiếp bằng `@ref`; và mở rộng thuật toán in-page walker trong `agent-browser.ts` để duyệt đệ quy `<iframe>` same-origin kèm frame context và Shadow-DOM.

---

## Requirements

### Functional:
1. `NativeTabHost.agentSnapshot()` phải thực thi `window.__antifanAgentSnapshot()` trên active WebContentsView và trả về chuỗi snapshot `@e1`, `@e2`... chứa role, label và metadata storefront (`section`, `product`, `block`).
2. `BrowserActionRegistry` và `NativeTabHost.agentClick({ ref: string, selector?: string })` phải nhận diện `ref`:
   - Nếu có `ref`, truy vấn DOM node từ `window.__antifanRefMap.get(ref)`.
   - Nếu phần tử nằm trong `<iframe>`, chuyển đổi tọa độ và dispatch click trong context của frame tương ứng.
   - Nếu không tìm thấy theo `ref`, fallback về `selector` hoặc báo lỗi rõ ràng.
3. Mở rộng `window.__antifanAgentSnapshot` trong `agent-browser.ts`:
   - Duyệt qua các `<iframe>` cùng nguồn (**Same-Origin Only**, bỏ qua cross-origin để tránh lỗi SOP), lưu frame identifier vào context của ref để giải quyết được node con từ top-level.
   - Duyệt qua open `shadowRoot`.
   - Bổ sung trích xuất computed label (kết hợp `aria-label`, `aria-labelledby`, `placeholder`, `title`, innerText).

### Non-functional:
- Payload snapshot wire qua IPC giới hạn $\le 40\text{ KiB}$ hoặc 150 phần tử.
- `[MỤC TIÊU ĐỀ XUẤT — CHƯA ĐO: Cắt giảm 60-80% token LLM so với getDom() thô]`.
- `[MỤC TIÊU ĐỀ XUẤT — CHƯA ĐO: Thời gian tạo snapshot <= 50ms trên trang 3000 DOM nodes]`.

---

## Architecture & Code Seams

```
+-------------------------------------------------------------------------------+
|                      Agent Perception & Action Wire                           |
|                                                                               |
|  [Agent / MCP] ---> agentSnapshot() ---> NativeTabHost                        |
|                            |                   |                              |
|                            | (Executes JS)     v                              |
|                            v         [window.__antifanAgentSnapshot()]        |
|                  Returns Snapshot Text       |                                |
|                  "@e1 [button] 'Add to Cart'"|                                |
|                            |                 v                                |
|                            |     [window.__antifanRefMap]                     |
|                            |     Maps '@e1' -> DOM Node                       |
|                            |     Maps '@e4' -> { frameIndex, node }           |
|                            v                                                  |
|  [Agent / MCP] ---> agentClick({ ref: "@e4" })                                |
|                            |                                                  |
|                            v                                                  |
|                  NativeTabHost.agentClick()                                   |
|                            |                                                  |
|                            v (Resolves ref via __antifanRefMap)               |
|                  Calculates BoundingBox & Triggers AI Cursor Kinematics       |
+-------------------------------------------------------------------------------+
```

### TypeScript Contract Updates (`src/shared/contracts.ts`):
```typescript
export interface AgentSnapshotOptions {
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
  maxElements?: number;
  includeIframes?: boolean;
}

export interface AgentClickOptions {
  ref?: string;        // e.g. '@e4'
  selector?: string;   // fallback CSS selector
  paneId?: 'desktop' | 'mobile';
  tabId?: string;
  button?: 'left' | 'right' | 'middle';
}
```

---

## Related Code Files
- Modify: `src/main/browser/agent-browser.ts` (Mở rộng walker cho iframe same-origin/shadow DOM và lưu frame context vào ref map)
- Modify: `src/main/browser/native-tab-host.ts` (Sửa `agentSnapshot` gọi script, sửa `agentClick` giải quyết `ref`)
- Modify: `src/main/browser/browser-action-registry.ts` (Thêm schema validation cho `ref` trong action click/type)
- Modify: `src/shared/contracts.ts` (Bổ sung kiểu dữ liệu cho `ref` trong agent actions)
- Test: `test/main/agent-browser-script.test.ts` (Unit test kiểm chứng snapshot và ref resolution)

---

## Implementation Steps

1. **Sửa `NativeTabHost.agentSnapshot()`**:
   - Thay đổi hàm `agentSnapshot(target, explicitTabId, paneId)` trong `native-tab-host.ts` để gọi:
     ```typescript
     const res = await wc.executeJavaScript(`(() => {
       if (typeof window.__antifanAgentSnapshot === 'function') {
         return window.__antifanAgentSnapshot();
       }
       return '';
     })()`);
     ```
2. **Nối `ref` vào `NativeTabHost.agentClick()`**:
   - Cập nhật script thực thi click trong renderer:
     ```javascript
     let target = null;
     if (ref && window.__antifanRefMap && window.__antifanRefMap.has(ref)) {
       const entry = window.__antifanRefMap.get(ref);
       target = entry && entry.node ? entry.node : entry;
     } else if (selector) {
       target = document.querySelector(selector);
     }
     ```
3. **Mở rộng `window.__antifanAgentSnapshot` trong `agent-browser.ts`**:
   - Duyệt `document` và các same-origin `<iframe>`:
     ```javascript
     function scanContext(doc, prefix = '', frameRef = null) {
       // Quét các phần tử tương tác
       // Lưu vào __antifanRefMap: Map.set(ref, { node, frame: frameRef, rect })
     }
     ```
   - Hỗ trợ giải phóng `__antifanRefMap` sạch sẽ khi có navigation.
4. **Viết và chạy bộ test**:
   - Bổ sung test case trong `test/main/agent-browser-script.test.ts` kiểm thử:
     - Tạo snapshot trên DOM giả lập có button, input và iframe same-origin.
     - Kiểm chứng định dạng chuỗi `@e1 [button] "Title" (section: "header")`.
     - Kiểm chứng resolve `@e1` từ `window.__antifanRefMap`.

---

## Success Criteria
- [ ] `NativeTabHost.agentSnapshot()` không còn trả về HTML thô mà trả về chuỗi snapshot `@e1`, `@e2`...
- [ ] Lệnh click bằng `ref` (`agentClick({ ref: '@e2' })`) tìm và click chính xác DOM node.
- [ ] Phần tử bên trong `<iframe>` cùng nguồn được đánh số `@ref` và resolve thành công.
- [ ] Toàn bộ unit test trong `test/main/agent-browser-script.test.ts` chạy xanh (`PASS`).

---

## Risk Assessment
- **Rủi ro 1: Frame context bị mất khi iframe unmount:**
  - *Hiện tượng:* Agent cố click `@e12` nhưng iframe chứa nó đã reload hoặc biến mất.
  - *Biện pháp:* Kiểm tra `node.isConnected` trước khi thao tác; nếu mất, trả về lỗi `ELEMENT_DETACHED` để agent biết và yêu cầu chụp lại snapshot.
