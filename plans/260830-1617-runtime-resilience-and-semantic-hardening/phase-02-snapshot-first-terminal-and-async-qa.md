---
phase: 2
title: "Asynchronous Non-Blocking Theme QA Pipeline & Navigation Epoch Invalidation"
status: completed
priority: P1
effort: "2-3d"
dependencies: ["phase-01-semantic-browser-snapshot-and-dpi-crop"]
---

# Phase 2: Asynchronous Non-Blocking Theme QA Pipeline & Navigation Epoch Invalidation

## Overview
Tách quy trình Theme QA ra khỏi critical path của sự kiện điều hướng trang: Đảm bảo khi trang nhận sự kiện `did-finish-load`, giao diện được mở khóa tương tác tức thì cho người dùng và Agent (`tab:ready`), trong khi các scanner nặng (Layout Overflow, Liquid regex, Broken Asset) được đẩy vào hàng đợi chạy ngầm (`AsyncThemeQaQueue`) và tự động hủy bỏ qua `AbortController` nếu người dùng chuyển trang mới làm tăng `documentGeneration`.

---

## Requirements

### Functional:
1. Tạo `src/main/qa/async-qa-job-queue.ts`:
   - Hàng đợi quản lý các job Theme QA chạy ngầm theo `tabId`.
   - Mỗi job gắn liền với `documentGeneration` tại thời điểm kích hoạt.
   - Hỗ trợ hủy (`abort`) lập tức các tác vụ đang chạy khi có navigation mới.
2. Cập nhật `NativeTabHost`:
   - Tại `did-finish-load`: Phát sự kiện `tab:ready` ngay lập tức (không chờ QA hoàn tất).
   - Kích hoạt tác vụ QA chạy ngầm qua `AsyncThemeQaQueue`.
   - Tại `did-start-navigation`: Gọi `asyncQueue.abort(tabId)` để hủy bỏ toàn bộ tác vụ QA của document thế hệ cũ.
3. Cập nhật `ThemeQaWorkflow`:
   - Hỗ trợ nhận `AbortSignal` và kiểm tra `signal.aborted` giữa các bước scanner.
   - Trả kết quả trung gian hoặc cập nhật badge trạng thái (`scanning` $\to$ `passed` / `failed`) qua IPC mà không chặn event loop.

### Non-Functional:
- Tác vụ quét nền không làm giảm frame rate của storefront `[MỤC TIÊU ĐỀ XUẤT — CHƯA ĐO: duy trì >= 58 FPS]`.
- Thời gian từ khi `did-finish-load` đến khi tab tương tác được `[MỤC TIÊU ĐỀ XUẤT — CHƯA ĐO: <= 50ms]`.

---

## Architecture

```
User / Agent Điều Hướng Trang
  │
  ▼
[did-start-navigation] ────► Tăng documentGeneration & Gọi asyncQueue.abort(tabId)
  │
  ▼
[did-finish-load] ─────────► Phát 'tab:ready' (UI Tương tác được ngay)
  │
  ▼ (Tác vụ chạy ngầm trên Async Queue)
[AsyncThemeQaQueue.dispatch()]
  ├── Task 1: Snapshot Diagnostics (Đồng bộ, 0ms)
  ├── Task 2: Liquid Regex Scan (Yielding micro-tasks)
  ├── Task 3: Layout Overflow Engine (requestIdleCallback)
  ├── Task 4: Broken Asset HEAD Pings (Async)
  └── Check signal.aborted trước khi ghi đè kết quả
  │
  ▼
[Phát sự kiện cập nhật Badge QA lên Toolbar / Sidebar]
```

---

## Related Code Files
- Create: `src/main/qa/async-qa-job-queue.ts` (Quản lý hàng đợi và AbortController theo tab)
- Modify: `src/main/qa/theme-qa-workflow.ts` (Hỗ trợ nhận AbortSignal và kiểm tra generation)
- Modify: `src/main/browser/native-tab-host.ts` (Tách dispatch QA ra khỏi sự kiện did-finish-load)
- Test: `test/main/theme-qa-fresh-target.test.ts` (Kiểm chứng race condition và abort khi chuyển trang)

---

## Implementation Steps

1. **Xây dựng `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`)**:
   ```typescript
   export class AsyncThemeQaQueue {
     private activeJobs = new Map<string, { controller: AbortController; generation: number }>();

     public enqueue(tabId: string, generation: number, task: (signal: AbortSignal) => Promise<void>) {
       this.abort(tabId);
       const controller = new AbortController();
       this.activeJobs.set(tabId, { controller, generation });
       task(controller.signal).finally(() => {
         const current = this.activeJobs.get(tabId);
         if (current && current.generation === generation) {
           this.activeJobs.delete(tabId);
         }
       });
     }

     public abort(tabId: string) {
       const job = this.activeJobs.get(tabId);
       if (job) {
         job.controller.abort();
         this.activeJobs.delete(tabId);
       }
     }
   }
   ```
2. **Cập nhật `NativeTabHost`**:
   - Khi `did-start-navigation`: Gọi `this.asyncQaQueue.abort(tabId)`.
   - Khi `did-finish-load`: Đặt trạng thái `tab.loading = false` và gọi `this.asyncQaQueue.enqueue(...)`.
3. **Cập nhật `ThemeQaWorkflow.validate()`**:
   - Truyền `signal: AbortSignal` vào các scanner.
   - Thêm kiểm tra:
     ```typescript
     if (signal.aborted) throw new Error('QA_ABORTED_BY_NAVIGATION');
     ```
4. **Kiểm thử tự động**:
   - Bổ sung test trong `test/main/theme-qa-fresh-target.test.ts` mô phỏng chuyển trang nhanh giữa 2 URL và đảm bảo kết quả của URL cũ bị hủy sạch, không ghi đè URL mới.

---

## Success Criteria
- [ ] Chuyển trang xong giao diện mở khóa tương tác ngay, không bị treo đơ bởi Theme QA.
- [ ] Tác vụ QA cũ bị hủy ngay lập tức khi người dùng click link chuyển trang khác.
- [ ] Toàn bộ test trong `test/main/theme-qa-fresh-target.test.ts` chạy xanh.

---

## Risk Assessment
- **Rủi ro:** Scan layout overflow qua `requestIdleCallback` có thể trả về muộn nếu trang có nhiều animation nặng.
- **Biện pháp:** Đặt timeout tối đa 3000ms cho tác vụ chạy ngầm; nếu quá hạn, trả về kết quả từng phần kèm cảnh báo timeout.
