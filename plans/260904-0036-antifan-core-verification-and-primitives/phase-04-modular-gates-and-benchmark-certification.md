---
phase: 4
title: "Modular Gates & Benchmark Certification"
status: complete
priority: P1
effort: "1d"
dependencies: ["phase-03"]
---

# Phase 4: Modular Gates & Benchmark Certification

## Overview
Giai đoạn này triển khai hệ thống **5 Cổng Kiểm Chuẩn Đa Tầng (Modular Gates)** trong Core, thay thế hoàn toàn God Gate cồng kềnh trước đây. Đồng thời, giai đoạn này tích hợp cơ chế kết nối với Theme Workflow tầng trên để nghiệm thu `THEME_READY` và thực thi toàn bộ **Ma trận Benchmark A–F**, đặc biệt là Benchmark F (Anti-Hallucination Barrier).

## Requirements
- Functional:
  - Triển khai 5 Cổng Kiểm chuẩn Độc lập trong Core:
    1. `SPEC_READY`: Cú pháp tĩnh và tính toàn vẹn asset đường dẫn tương đối.
    2. `LAYOUT_READY`: Khớp cấu trúc section (`pageInventory`) và dung sai chiều cao $\le 5\%$.
    3. `RESPONSIVE_READY`: Kiểm tra Desktop ($1440\text{px}$), Tablet ($768\text{px}$), Mobile ($375\text{px}$) không bị tràn ngang (`overflow-x`).
    4. `INTERACTION_READY`: Các trạng thái động (modal, drawer, accordion, dropdown) đóng/mở chuẩn xác.
    5. `MOTION_READY`: Đo lường gia tốc easing và sai số thời lượng $\le 33\text{ms}$.
  - Xác lập ranh giới: `THEME_READY` là cổng tổng hợp thuộc thẩm quyền của Theme Workflow / Platform Adapter, không đặt trong Core.
  - Triển khai và chạy kiểm thử tự động toàn bộ Ma trận Benchmark A–F:
    - Benchmark A: Tái thiết lập website hoàn chỉnh.
    - Benchmark B: Nhận diện vùng trực quan từ frame Figma phẳng.
    - Benchmark C: Đa trạng thái Default $\to$ Hover $\to$ Pressed.
    - Benchmark D: Hoạt ảnh modal phức tạp.
    - Benchmark E: Đối chiếu parity đa chiều Figma $\leftrightarrow$ Website.
    - **Benchmark F (Anti-Hallucination Barrier):** Cố tình gửi claim hoàn thành sai lệch; Verifier phải đánh chặn thành công và trả về `REJECTED`/`PARTIAL`, ngăn chặn việc đóng task.
- Non-functional:
  - Thời gian chạy kiểm thử cho 1 Cổng kiểm chuẩn module hóa $\le 2\text{s}$.
  - Benchmark F phải có tính tất định $100\%$ (không phụ thuộc vào tính ngẫu nhiên của mô hình).

## Architecture
```text
                  ANTIFAN MODULAR CORE GATES
  ┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
  │ SPEC_READY  │ LAYOUT_READY│ RESPONSIVE  │ INTERACTION │ MOTION_READY│
  └──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┘
         │             │             │             │             │
         └─────────────┴─────────────┼─────────────┴─────────────┘
                                     │
                                     ▼
                   THEME WORKFLOW / PLATFORM ADAPTER
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           │ Dynamic E-commerce Contracts Verification         │
           │ (Cart AJAX, Variant Matrix, Storefront Preview)   │
           └─────────────────────────┬─────────────────────────┘
                                     │
                                     ▼
                         Composite: THEME_READY
```

## Related Code Files
- Create: `src/main/verification/modular-gates.ts`
- Create: `test/benchmark/benchmark-anti-hallucination.test.ts`
- Create: `test/benchmark/benchmark-modular-gates.test.ts`
- Modify: `src/main/session/issue-register.ts` (Truy xuất `VerificationRecord` và kiểm chứng tính toàn vẹn trạng thái)
- Modify: `src/main/tools/browser-capabilities.ts`
- Modify: `src/main/tools/browser-control-port.ts`
## Implementation Steps
1. **Module hóa các Cổng Kiểm Chuẩn trong Core:**
   - Trong `src/main/verification/modular-gates.ts`, tái cấu trúc `validateSpecGate` hiện tại thành các validator độc lập:
     - `validateSpecReady(specTabId)`
     - `validateLayoutReady(specTabId, targetTabId, tolerance)`
     - `validateResponsiveReady(targetTabId, viewports)`
     - `validateInteractionReady(targetTabId, interactionSpecs)`
     - `validateMotionReady(targetTabId, motionSpecs)`
   - Cung cấp tool MCP tương ứng cho từng cổng để Agent có thể kiểm tra cuốn chiếu từng khâu thay vì đợi đến cuối trang.
2. **Triển khai Bài Test Benchmark F (Anti-Hallucination):**
   - Viết test `test/benchmark/benchmark-anti-hallucination.test.ts`:
     - Giả lập một Agent gửi claim hoàn thành: `"Mobile navigation menu is 100% fixed and working"`.
     - Cài cắm lỗi thực tế: Thẻ menu ẩn nhưng không thể toggle class `.open` khi click.
     - Kích hoạt `evaluateVerificationContract`: Verifier ghi nhận interaction trace thất bại $\to$ Trả về `REJECTED`.
     - Kiểm tra trạng thái trong `src/main/session/issue-register.ts`: Bản ghi `VerificationRecord.verdict` được ghi nhận là `'REJECTED'`, và bất kỳ `IssueRecord.status` liên kết nào vẫn giữ nguyên `'OPEN'`, ngăn chặn tuyệt đối việc Agent tự ý đổi trạng thái task sang hoàn thành khi thiếu bằng chứng hợp lệ.
3. **Thực thi Toàn bộ Ma trận Benchmark A–E:**
   - Kiểm thử tái tạo cấu trúc với trang mẫu Roahtrip (Benchmark A).
   - Kiểm thử frame phẳng và đa trạng thái nút bấm (Benchmarks B, C).
   - Kiểm thử timing modal transition (Benchmark D) và parity trực quan (Benchmark E).

## Success Criteria
- [x] 5 Cổng kiểm chuẩn module hóa chạy độc lập và trả về kết quả định lượng chi tiết.
- [x] Không có logic `THEME_READY` hay domain Sapo/Shopify nào bị rò rỉ vào Core.
- [x] Benchmark F chạy pass $100\%$: Mọi nỗ lực tự phong danh hiệu `COMPLETED` của Agent mà thiếu bằng chứng đều bị triệt tiêu hoàn toàn quyền lực.
## Risk Assessment
- *Nguy cơ:* Các cổng kiểm chuẩn viewport responsive gây tải nặng bộ nhớ khi resize liên tục tab Chromium.
- *Tín hiệu nhận biết:* Electron crash hoặc mất kết nối CDP session khi chuyển đổi qua lại giữa $1440\text{px}$ và $375\text{px}$.
- *Phản ứng dự phòng:* Sử dụng cơ chế emulation viewport chuẩn qua `Emulation.setDeviceMetricsOverride` thay vì resize cửa sổ vật lý của Electron.
