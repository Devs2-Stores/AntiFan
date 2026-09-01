---
title: Decoupled Dual-Plane Background Automation and TARGET_STALE Elimination
date: 2026-09-01
summary: "Comprehensive changelog: eliminated window focus stealing, scoped physical preemption, dynamic background throttling, differential generation auto-sync with HMR_DRIFT diagnostic, and live Electron smoke verification"
---

# Báo Cáo Kỹ Thuật & Nhật Ký Thay Đổi Toàn Diện (Engineering Change Log)

## 1. Bối Cảnh & Phân Tích Nguyên Nhân Gốc (Root Cause Analysis)

Khi người dùng duyệt web, xem YouTube, Facebook hoặc đọc tài liệu ở Tab 2, việc chạy tác vụ tự động hóa kiểm thử theme/storefront ở Tab 1 trong nền từng gặp phải 4 điểm nghẽn nghiêm trọng:

1. **Cướp Focus cửa sổ / Tab:**
   - *Nguyên nhân:* Schema của MCP tool trong `mcp-server.ts` chứa các chuỗi prompt bias như `(auto-switches to target tab)`, `automatically activates and focuses this tab`, khiến LLM chủ động gọi `switchTab` hoặc mong đợi tab được đưa lên foreground.
   - *Giải pháp:* Xóa sạch các prompt bias. Chuẩn hóa ngữ nghĩa `tabId` là tham số chạy ngầm 100% không làm thay đổi `activeTabId`.
2. **Gõ phím ở Tab 2 gây gián đoạn Agent ở Tab 1:**
   - *Nguyên nhân:* Listener `before-input-event` trong `NativeTabHost.setupGlobalShortcutsOnView` bắt mọi phím gõ của người dùng và kích hoạt `preemptActiveAgent()` toàn cục.
   - *Giải pháp (RT-01):* Xác định `eventTabId = tabId ?? this.activeTabId`. Chỉ phím gõ vật lý trực tiếp trên đúng `automationTabId` mới kích hoạt hủy Agent; người dùng gõ ở Tab 2 hay thanh địa chỉ hoàn toàn không ảnh hưởng đến Tab 1.
3. **Lỗi Timeout `TARGET_STALE` khi Tab ở chế độ nền:**
   - *Nguyên nhân:* Chromium tự động throttle timers, rAF và CPU trên các tab ẩn, khiến lệnh `reloadAndWait` vượt quá mức trần 3.000ms.
   - *Giải pháp (RT-02):* Triển khai Dynamic Throttling Exemption (`isForeground || isAgentWorking`), tab nền tự động unthrottle khi Agent làm việc và throttle lại khi idle. Nâng timeout `reloadAndWait` lên 8.000ms cho tab nền và đồng bộ trên cả 2 pane Desktop/Mobile trong Split Review mode.
4. **Dev-Server HMR gây lỗi `TARGET_STALE`:**
   - *Nguyên nhân:* Khi theme dev-server HMR ngầm, `documentGeneration` tăng lên khiến lệnh đọc DOM / chụp ảnh bị từ chối do preflight strict generation check.
   - *Giải pháp (RT-03):* Phân tách 3 chế độ `read | lifecycle | write`. Lệnh đọc và reload tự động đồng bộ `liveDocGen`; chỉ lệnh ghi tương tác (`click`, `type`) mới kiểm tra preflight nghiêm ngặt và ném mã lỗi `HMR_DRIFT`.
5. **Treo Theme QA trên Tab ẩn (RT-04):**
   - *Nguyên nhân:* Settle script sử dụng `requestAnimationFrame` trần bị Chromium đóng băng trên tab ẩn.
   - *Giải pháp (RT-04):* Bổ sung fallback timer 150ms race với `requestAnimationFrame`.

---

## 2. Kiến Trúc Điều Khiển Phân Lập (Dual-Plane Model)

```
[ Human Interaction Plane ]               [ Headless AI Automation Plane ]
┌───────────────────────────────┐         ┌───────────────────────────────┐
│ Active Tab (Tab 2)            │         │ Target Tab (Tab 1 - Storefront│
│ • User browsing YouTube/Docs  │         │ • Background Agent Operations │
│ • Attached to ContentView     │         │ • Isolated World 1004 & CDP   │
│ • Unthrottled                 │         │ • Dynamic Exemption during run│
└──────────────┬────────────────┘         └───────────────┬───────────────┘
               │                                          │
               │ (Physical Keystrokes)                    │ (Agent Input Events)
               ▼                                          ▼
┌───────────────────────────────┐         ┌───────────────────────────────┐
│ Scoped Preemption (RT-01)     │         │ Headless Action Routing       │
│ • eventTabId === targetTabId? │         │ • Zero switchTab() calls      │
│ • Tab 2 typing != Tab 1 abort │         │ • Zero window focus stealing  │
└───────────────────────────────┘         └───────────────┬───────────────┘
                                                          │
                                                          ▼
                                          ┌───────────────────────────────┐
                                          │ Differential Fencing (RT-03)  │
                                          │ • Passive Reads: Auto-sync    │
                                          │ • Reloads: Adaptive 8s Settle │
                                          │ • Writes: Fail-close on HMR   │
                                          └───────────────────────────────┘
```

---

## 3. Chi Tiết Thay Đổi Các File Trong Dự Án

### 1. `src/main/mcp/mcp-server.ts`
- Xóa bỏ toàn bộ các chuỗi prompt bias: `(auto-switches to target tab)`, `(defaults to active tab)`, `If specified, automatically activates and focuses this tab`.
- Chuẩn hóa mô tả `tabId` trên mọi tool: *"Optional target tab ID. Executes directly against the specified tab in the background without stealing visual focus."*
- Cập nhật mô tả `antifan_switch_tab` nhấn mạnh đây chỉ là tiện ích giao diện cho người dùng, cấm AI tự động gọi.

### 2. `scripts/antifan-omp-mcp.cjs`
- Thêm trường `tabId: { type: 'string' }` vào toàn bộ danh sách `definitions` cho adapter MCP.

### 3. `src/main/browser/native-tab-host.ts`
- `setupGlobalShortcutsOnView(wc, tabId)`: Xác định `eventTabId = tabId ?? this.activeTabId`. Chỉ gọi `preemptActiveAgent` khi `eventTabId === this.automationTabId` (RT-01).
- `setupTabWebContentsEvents`: Truyền `id` vào `this.setupGlobalShortcutsOnView(wc, id)`.
- `getAutomationHost()`: Truyền `applyTabThrottling: () => this.applyTabThrottling()` vào context của `TabAutomationHost`.
- `applyTabThrottling()`: Đánh giá `shouldThrottle = !isForeground && !isAgentWorking` (RT-02).
- `reloadAndWait(tabId, timeoutMs)`: Tự động điều chỉnh timeout 8.000ms cho tab nền và đồng bộ trên cả 2 pane Desktop và Mobile khi ở Split Review mode.

### 4. `src/main/browser/tab-automation-host.ts`
- Mở rộng `TabAutomationContext` với `applyTabThrottling?: () => void;`.
- Kích hoạt `this.ctx.applyTabThrottling?.()` trong: `beginTabAgentWorking`, `clearTabAgentWorking`, `endTabAgentWorking`, `markTabAgentWorking`, `setTabAiState`, và `clearAllAgentWorking`.

### 5. `src/main/tools/browser-control-port.ts`
- `ViewportGate.preemptActiveAgent(reason, tabId)`: Bỏ qua lệnh hủy nếu `tabId && this.activeTabId && tabId !== this.activeTabId`.
- `navigate()` và `reload()`: Chuyển sang gọi `resolveTargetTab(target, explicitTabId, 'lifecycle')`.
- `resolveTargetTab(target, explicitTabId, operationType: 'read' | 'lifecycle' | 'write')`:
  - `'read'` & `'lifecycle'`: Tự động nạp `liveDocGen` vào target, triệt tiêu lỗi `TARGET_STALE` khi HMR ngầm.
  - `'write'`: Bắt buộc kiểm tra `target.documentGeneration === liveDocGen`. Nếu lệch thế hệ, ném mã lỗi chuyên dụng `HMR_DRIFT`.

### 6. `src/main/qa/theme-qa-workflow.ts`
- Cập nhật `settleScript` bằng Promise race giữa `requestAnimationFrame` và fallback `setTimeout(finish, 150)` (RT-04).

### 7. `src/shared/control-plane-contracts.ts`
- Bổ sung `'HMR_DRIFT'` vào union type `CapabilityErrorCode`.

### 8. `test/main/multitasking-decoupled-tab.test.ts` (File mới)
- Test suite kiểm thử 4 kịch bản nền:
  1. *Decoupled Dual-Plane Execution:* Agent thao tác trên Tab 1 không đổi `activeTabId` (Tab 2).
  2. *RT-01 Scoped Preemption:* Gõ phím ở Tab 2 không làm hủy agent ở Tab 1.
  3. *RT-02 Dynamic Throttling:* Tab unthrottle khi `agent_working` và throttle lại khi `idle`.
  4. *RT-03 Differential Generation Fencing:* Lệnh đọc tự động sync; lệnh ghi ném mã lỗi `HMR_DRIFT`.

### 9. `scripts/smoke-background-multitasking.cjs` & `package.json` (Mới)
- Live Electron Chromium Smoke Test kiểm tra 4 Milestones:
  - *Milestone 1:* Đọc DOM nền không đổi tab.
  - *Milestone 2:* Click & Type tương tác CDP nền không cướp focus.
  - *Milestone 3:* Background reload với timeout thích ứng thành công.
  - *Milestone 4:* Scoped preemption trên live window.
- Đăng ký script trong `package.json`: `"smoke:multitasking": "npm run compile && node scripts/run-electron.cjs scripts/smoke-background-multitasking.cjs"`.

---

## 4. Bằng Chứng Xác Thực (Verification Evidence)

1. **TypeScript Typecheck:**
   - Lệnh: `npm run typecheck`
   - Kết quả: `0 errors (Exit code 0)`
2. **Unit & Integration Suite:**
   - Lệnh: `npx tsx --test test/main/multitasking-decoupled-tab.test.ts`
   - Kết quả: `4/4 passed (100%), duration 210.8ms`
3. **Live Electron Multi-Tab Smoke Test:**
   - Lệnh: `npm run smoke:multitasking`
   - Kết quả: `ALL LIVE ELECTRON MULTITASKING BACKGROUND AUTOMATION CHECKS PASSED (Exit code 0)`
4. **Plan Tracker:**
   - Kế hoạch: `plans/260901-1630-decoupled-dual-plane-background-automation/`
   - Tiến độ: `4/4 phases complete, 13/13 tasks checked (100%)`
