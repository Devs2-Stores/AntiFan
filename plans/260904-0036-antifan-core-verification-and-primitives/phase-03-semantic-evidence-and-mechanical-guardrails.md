---
phase: 3
title: "Semantic Evidence Lean & Mechanical Guardrails"
status: complete
priority: P1
effort: "1.5d"
dependencies: ["phase-02"]
---

# Phase 3: Semantic Evidence Lean & Mechanical Guardrails

## Overview
Giai đoạn này triển khai cơ chế biểu diễn trực quan tinh gọn (`VisualRegion`) trong Core, bảo vệ Core khỏi nguy cơ phình to thành một Computer Vision Engine. Đồng thời, giai đoạn này thiết lập **4 Chốt Chặn Cơ Học** và **Circuit Breaker `VERIFICATION_STALEMATE`** để triệt tiêu mọi khả năng Agent gian lận đề thi, race condition bản build, hay rơi vào vòng lặp Livelock đốt token.

## Requirements
- Functional:
  - Định nghĩa interface `VisualRegion` trong Core: Bounding box, DOM reference (`@e1`), artifact ảnh, computed styles thô. Cấm đưa logic gom cụm $\mathcal{O}(N^2)$ hay đồ thị nhận thức vào Core.
  - Cài đặt 4 Chốt chặn Cơ học:
    1. **Canonical Proof Templates:** Ép buộc danh mục nghĩa vụ chứng minh theo Claim Type (`INTERACTION_STATE`, `LAYOUT_PARITY`, `RESPONSIVE`).
    2. **`StabilityPolicy` Cấu hình:** Quản lý khoảng lặng lắng đọng (`settleWindowMs`) và tín hiệu mạng/media freeze thay thế con số 1500ms cứng.
    3. **DocumentGeneration Barrier:** Bắt buộc $\text{evidence.documentGeneration} > \text{mutation.documentGeneration}$.
    4. **Target Boundary Masking:** Tự động chuyển vùng Canvas 3D / iframe đóng sang Visual Diff Masking.
  - Cài đặt Circuit Breaker: Quản lý `RetryBudget` cho từng workflow. Vượt ngưỡng $\to$ Kích hoạt `VERIFICATION_STALEMATE`.
  - Phân quyền Human: Cho phép đóng task bằng cờ `EXEMPTION_WAIVED`, cấm tuyệt đối làm giả `VERIFIED`.
- Non-functional:
  - Thuật toán trích xuất `VisualRegion` chạy trong phạm vi Viewport với thời gian xử lý $\le 50\text{ms}$.
  - Không gây nghẽn Main thread của Electron khi xử lý trang web có trên 2.500 DOM nodes.

## Architecture
```text
Agent Mutation (Save File / Edit Code)
         │  (mutation.docGen = N)
         ▼
Build Sync Barrier
   Wait for CLI/Vite Reload -> Tab documentGeneration = N + 1
         │
         ▼
Canonical Proof Template Injection
   Core forces fixed obligations based on Claim Type
         │
         ▼
Stability Policy Execution
   anti.media.freeze -> Await Quiescence Window
         │
         ▼
Evidence Capture & Scope Masking
   ├── Normal DOM Area  -> Capture VisualRegion + Computed CSS
   └── Canvas / Blackbox -> Target Boundary Masking (Pixel Diff Only)
         │
         ▼
Verification Evaluation Loop
   ├── Pass -> VERIFIED
   ├── Inconclusive -> Resample / Need Input
   └── Fail -> Decrement RetryBudget
         │
         ▼ (If Budget Exhausted)
   VERIFICATION_STALEMATE -> Halt Auto-repair -> Human Decision (Exemption Only)
```

## Related Code Files
- Create: `src/main/verification/proof-templates.ts`
- Create: `src/main/verification/stability-policy.ts`
- Create: `src/main/verification/circuit-breaker.ts`
- Create: `src/main/verification/visual-region.ts`
- Modify: `src/main/session/issue-register.ts` (Thêm API `updateVerificationStalemate` và ghi nhận `EXEMPTION_WAIVED`)
- Modify: `src/main/tools/browser-capabilities.ts`
- Modify: `src/main/tools/browser-control-port.ts`

## Implementation Steps
1. **Triển khai `VisualRegion` Extractor:**
   - Trong `src/main/verification/visual-region.ts`, xây dựng hàm trích xuất tọa độ bounding box và computed styles cho các node nhìn thấy trong viewport.
   - Không thực hiện gom cụm nhận thức; chỉ gán nhãn thô và hash ảnh chụp màn hình tương ứng.
2. **Xây dựng `CanonicalProofTemplates`:**
   - Định nghĩa mẫu kiểm chứng cố định cho các loại Claim phổ biến:
     - `INTERACTION`: Bắt buộc kiểm tra trigger event, pre/post style delta, và easing curve.
     - `LAYOUT`: Bắt buộc kiểm tra section inventory count, height parity delta $\le 5\%$, và no overflow-x.
3. **Cài đặt `StabilityPolicy` & DocumentGeneration Barrier:**
   - Tích hợp `StabilityPolicy` vào `browser-control-port.ts`: Kiểm tra `documentGeneration` hiện tại của tab so với thời điểm ghi nhận mutation. Nếu bằng chứng sinh ra trên generation cũ $\to$ Bỏ qua và yêu cầu nạp lại.
   - Sử dụng `anti.media.freeze` để dừng rAF và video trước khi lấy mẫu.
4. **Cài đặt `CircuitBreaker` & Phân loại Exemption (Tương thích `IssueRegister`):**
   - Theo dõi số lần thất bại liên tiếp của từng claim/task.
   - Khi vượt `RetryBudget` $\to$ Gọi `IssueRegister.getInstance().updateVerificationStalemate(claimId, 'STALEMATE')`.
   - Tách biệt rõ ràng: `VerificationRecord.stalemateState` chuyển sang `'STALEMATE'`, trong khi `IssueRecord.status` của issue liên kết vẫn giữ `'OPEN'` (để tiếp tục theo dõi, không bị nuốt lỗi).
   - Cung cấp API `applyHumanExemption(claimId, reason)`: Cập nhật `VerificationRecord.stalemateState = 'EXEMPTION_WAIVED'` và `exemptionReason = reason`. Nếu có `linkedIssueId`, đánh dấu `IssueRecord.status = 'RESOLVED'` kèm ghi chú ngoại lệ trong `IssueRecord.notes`, nhưng **tuyệt đối giữ nguyên `VerificationRecord.verdict != 'VERIFIED'`** để bảo toàn tính toàn vẹn của sổ cái bằng chứng.
## Success Criteria
- [x] Core không chứa bất kỳ logic gom cụm Computer Vision $\mathcal{O}(N^2)$ nào.
- [x] Bằng chứng sinh ra trước bản build mới bị DocumentGeneration Barrier đánh chặn thành công.
- [x] Circuit Breaker kích hoạt chính xác khi Agent thử lại quá số lần quy định, bảo vệ an toàn ngân sách token context.

## Risk Assessment
- *Nguy cơ:* Các script bên thứ ba gửi network ping liên tục khiến `StabilityPolicy` không bao giờ đạt `networkIdle`.
- *Tín hiệu nhận biết:* `waitForStability` chạm ngưỡng `maxWaitMs` và văng `INCONCLUSIVE`.
- *Phản ứng dự phòng:* Sử dụng `FirstPartyNetworkTracker` sẵn có trong repo (`src/main/browser/first-party-network-tracker.ts`) để chỉ theo dõi network nội bộ, loại bỏ hoàn toàn các domain quảng cáo/tracking.
