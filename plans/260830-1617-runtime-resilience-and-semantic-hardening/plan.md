---
title: "AntiFan Desktop: Chromium Semantic Perception, Terminal Resilience, Non-Blocking QA & Memory Soak Hardening"
description: "Kế hoạch kỹ thuật cấp Production: Nối và mở rộng Semantic Snapshot (@ref + iframe/shadow DOM), tách Theme QA bất đồng bộ phi nghẽn luồng với epoch invalidation, hỗ trợ OMP Agent Session Resume có điều kiện kèm dọn dẹp đĩa ArtifactStore, và xây dựng bộ kiểm thử Soak Test 4 giai đoạn tự động."
status: completed
priority: P1
effort: "2-3 tuần"
tags: ["chromium", "terminal", "resilience", "theme-qa", "accessibility", "memory-soak", "dpi-crop", "mcp"]
created: 2026-08-30
completed: 2026-08-30
---

# AntiFan Desktop: Chromium Semantic Perception, Terminal Resilience, Non-Blocking QA & Memory Soak Hardening

## 1. Tổng quan kế hoạch (Overview)

Kế hoạch này thiết lập lộ trình và quy chuẩn kỹ thuật cấp production nhằm nâng cấp runtime của **AntiFan Browser Desktop** dựa trên kiểm toán trực tiếp mã nguồn thực tế:

- **Bảo toàn nền tảng đã có:** Giữ nguyên các cơ chế đã hoạt động ổn định (Wire budget 40 KiB `GLOBAL_JSON_BUFFER_BUDGET_BYTES`, `safeSliceTailJsonBounded`, `snapshotThroughSeq`, `ArtifactStore` staging 512 KiB DOM, và công thức crop ảnh High-DPI trong `NativeTabHost`).
- **Tập trung vào 4 khoảng trống kiến trúc thực tế:**
  1. Sửa lỗi `NativeTabHost.agentSnapshot()` chuyển sang gọi `window.__antifanAgentSnapshot()`, mở rộng hợp đồng `@ref` cho click/type, và duyệt đệ quy `<iframe>` same-origin kèm frame context.
  2. Tách Theme QA thành hàng đợi bất đồng bộ (`AsyncThemeQaQueue`) chạy ngầm, không chặn tương tác UI khi trang load xong, tự động hủy tác vụ cũ khi `documentGeneration` tăng.
  3. Triển khai cơ chế lưu manifest phục hồi phiên OMP Agent có điều kiện (*"nếu provider AI / backend hỗ trợ"*) và bộ dọn dẹp đĩa theo TTL/LRU cho `ArtifactStore`.
  4. Xây dựng bộ kiểm thử Soak Test 4 giai đoạn tự động (`test/e2e/soak-test.test.ts`) để đo lường độ dốc bộ nhớ thực tế và xác minh dọn sạch tiến trình.

---

## 2. Mục tiêu (Goals) & Danh mục ngoài phạm vi (Non-Goals)

| # | Mục tiêu cốt lõi | Mức ưu tiên | Trạng thái |
|---|---|---|---|
| 1 | **Semantic Snapshot & @ref Wire Integration**: Nối `agentSnapshot()` vào `__antifanAgentSnapshot`, mở rộng `@ref` cho `agentClick`/action-registry, và duyệt iframe same-origin có context. | P1 | Completed |
| 2 | **Non-Blocking Theme QA Pipeline**: Tách việc quét QA ra khỏi critical path navigation, tự động hủy tác vụ cũ theo epoch `documentGeneration`. | P1 | Completed |
| 3 | **Conditional Agent Resume & Artifact Cleaner**: Lưu manifest phục hồi phiên OMP (nếu provider hỗ trợ) và dọn dẹp file `.artifact` cũ theo TTL/LRU. | P2 | Completed |
| 4 | **Automated 4-Stage Soak Test Suite**: Bộ kiểm thử E2E tự động xác thực bộ nhớ phẳng, đo độ dốc hồi quy tuyến tính RAM và kiểm chứng 0 tiến trình zombie. | P1 | Completed |

### Danh mục ngoài phạm vi / ROI thấp (Non-Goals — Tuyệt đối không làm):
- ❌ **Không làm Chrome Extension Store / Bookmark Sync**: Phạm vi ngoài nhu cầu phát triển theme, tránh tăng gánh nặng bảo trì.
- ❌ **Không làm Remote SSH Daemons / Multi-Host Relays**: AntiFan là công cụ desktop local-first.
- ❌ **Không làm Multi-Worktree Hyper-Orchestration**: Duy trì tính cục bộ trực quan 1 Tab Storefront = 1 Terminal.
- ❌ **Không refactor `NativeTabHost` theo cảm tính**: Chỉ can thiệp vào các seam cụ thể (`agentSnapshot`, `agentClick`, event navigation).

---

## 3. Các giai đoạn thực thi (Phases Roadmap)

| # | Giai đoạn | Mục tiêu chính | Mức ưu tiên | Phụ thuộc | File chi tiết |
|---|---|---|---|---|---|
| 1 | **Phase 1: Semantic Snapshot & @ref Wiring** | Nối `NativeTabHost.agentSnapshot()` vào script semantic, hỗ trợ `@ref` cho click/type, mở rộng duyệt iframe same-origin/shadow DOM. | P1 | Không | [phase-01-semantic-browser-snapshot-and-dpi-crop.md](./phase-01-semantic-browser-snapshot-and-dpi-crop.md) |
| 2 | **Phase 2: Non-Blocking Async Theme QA** | Xây dựng `AsyncThemeQaQueue`, load trang xong tương tác UI ngay, hủy tác vụ quét cũ khi `documentGeneration` tăng. | P1 | Phase 1 | [phase-02-snapshot-first-terminal-and-async-qa.md](./phase-02-snapshot-first-terminal-and-async-qa.md) |
| 3 | **Phase 3: Conditional Resume & Artifact Cleaner** | Ghi manifest phiên OMP ra đĩa (resume nếu AI hỗ trợ), bổ sung cơ chế quét dọn file artifact theo TTL 24h / trần 200MB (chạy khi khởi động và idle). | P2 | Phase 2 | [phase-03-agent-session-resume-and-memory-defense.md](./phase-03-agent-session-resume-and-memory-defense.md) |
| 4 | **Phase 4: 4-Stage Soak Testing Suite** | Tự động hóa bộ test 4 giai đoạn (Mặc định 15–30m, cờ `--endurance` cho 2–4h), đo Memory Slope và xác thực 0 tiến trình zombie. | P1 | Phase 3 | [phase-04-soak-testing-and-process-lifecycle-verification.md](./phase-04-soak-testing-and-process-lifecycle-verification.md) |

---

## 4. Tiêu chí thành công tổng thể (Success Criteria)

- [x] **SC-1 (Semantic Snapshot & @ref Action)**: `agentSnapshot()` trả về snapshot tinh gọn `@e1`, `@e2`... và `agentClick({ ref: "@e4" })` click trúng DOM node thật trong cả main frame lẫn same-origin iframe.
- [x] **SC-2 (Non-Blocking Navigation)**: Điều hướng trang kích hoạt trạng thái tương tác ngay lập tức; tác vụ Theme QA quét ngầm không làm giật khung hình giao diện và bị hủy tự động khi chuyển trang.
- [x] **SC-3 (Session Resume & Disk Safety)**: Manifest phiên OMP được lưu/khôi phục chính xác; file `.artifact` cũ được dọn dẹp định kỳ dưới ngưỡng 200MB khi khởi động và khi idle.
- [x] **SC-4 (4-Stage Soak Pass)**: Chạy hoàn tất bộ kiểm thử Soak Test 4 giai đoạn với $0$ tiến trình zombie PTY và mức tăng RAM phẳng.

---

## 5. Validation Log

### Session 1 (2026-08-30)
- **Q1 (Iframe Perception Strategy):** Xác nhận duyệt đệ quy các `<iframe>` **Same-Origin Only** và gán frame identifier vào context của ref map; bỏ qua cross-origin iframe để đảm bảo an toàn bảo mật và không bị lỗi chặn SOP.
- **Q2 (Artifact Retention Trigger):** Xác nhận cơ chế kích hoạt dọn dẹp đĩa chạy **1 lần khi khởi động app + định kỳ mỗi 1 giờ khi app ở trạng thái Idle**, không chặn luồng I/O khi agent đang stream.
- **Q3 (Soak Test Duration Mode):** Xác nhận cấu hình thời gian chạy **mặc định chế độ rút gọn (15–30 phút)** cho local dev/CI, và cung cấp cờ `--endurance` cho bài ngâm tải 2–4 giờ khi kiểm thử release.

### Whole-Plan Consistency Sweep
- **Claims Verified:** 100% các file, symbol, và hợp đồng đã được đối chiếu trực tiếp với mã nguồn thực tế.
- **Contradictions:** 0 phát hiện mâu thuẫn. Toàn bộ 4 phase đã hoàn thành và kiểm chứng thành công.

<!-- slug: runtime-resilience-and-semantic-hardening -->
