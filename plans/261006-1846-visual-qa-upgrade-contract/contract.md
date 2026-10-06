# BRAINSTORM CONTRACT: NÂNG CẤP TRỤC VISUAL QA CHO ANTIFAN DESKTOP
**Tập trung góc nhìn Candidate 1/5: Per-Viewport Integrity Sweep**
**Target Codebase:** `E:/Work/apps/AntiFan` @ `main` (commit `40af4b1e`)

---

## 1. BỐI CẢNH VÀ CHẨN ĐOÁN GỐC RỄ (EMPIRICAL EVIDENCE)

User nhận xét: *"Visual là tính năng yếu nhất — không check được layout vỡ, UI tràn, responsive, element đè nhau"*. 

Kiểm chứng trực tiếp trên source code AntiFan xác nhận nhận xét của user là **hoàn toàn chính xác**, bắt nguồn từ 4 đứt gãy kiến trúc trong pipeline hiện tại:

1. **Integrity Scanner chỉ chạy trên Active Viewport (`theme-qa-workflow.ts:803-838`)**:
   - `LayoutIntegrityEngine` sở hữu đầy đủ 6 detector hình học: `overlap` (đè nhau), `clipping` (tràn/cắt chữ), `occlusion` (CTA bị che khuất), `offscreen` (nút bấm văng khỏi màn hình), `zero-size`, `sticky-obstruction`.
   - Tuy nhiên, Step 6.5 chỉ chạy scanner này duy nhất một lần trên `activeTarget` (thường là desktop 1440px do agent/dev mở trên màn hình lớn).
   - Comment tại `theme-qa-workflow.ts:834-838` thừa nhận: *"multi-breakpoint sweep (runResponsiveCheck) only measures document-level horizontal overflow per width; integrity detectors run on the active viewport, so non-active widths report overflow-only counts and never claim measured overlap/occlusion evidence."*

2. **Lỗi đứt gãy Key Index khiến `responsiveMap` luôn báo 0 (`theme-qa-workflow.ts:849-862` vs `native-tab-host.ts:15047`)**:
   - Trong `NativeTabHost.runResponsiveCheck`, kết quả các breakpoint được lưu theo ID preset: `results[bp.id]` với `bp.id` là `'mobile-small'`, `'mobile-standard'`, `'tablet-portrait'`, `'tablet-landscape'`, `'desktop-laptop'`.
   - Nhưng tại `theme-qa-workflow.ts:850`, workflow lại tra cứu: `responsiveBreakpoints?.[String(w)]` với `w ∈ [320, 375, 768, 1024, 1440]`.
   - Do `responsiveBreakpoints["320"]` luôn trả về `undefined`, `bp && bp.hasHorizontalOverflow === true` luôn là `false`. Kết quả là `responsiveMap` gửi về cho user/agent **luôn báo 0 critical issues và 0 overflow trên tất cả các breakpoint không active**, bất kể giao diện mobile có vỡ nát hay tràn khung.

3. **Mất dấu Culprit Element khi Responsive Overflow xảy ra (`theme-qa-workflow.ts:773-795`)**:
   - `runResponsiveCheck` chỉ inject đoạn script tối giản đo `scrollWidth > clientWidth + 1` (không chạy hàm tìm selector đệ quy của `LayoutOverflowEngine`).
   - Khi có breakpoint mobile bị tràn, workflow ghi đè `overflowResult.hasOverflow = true`, nhưng giữ nguyên `overflowResult.culprits` của active viewport (`[]`). Developer nhận được thông báo "Responsive bị tràn" nhưng mảng `culprits` rỗng, không biết class/id nào gây tràn.

4. **Đồng nhất hóa vô lý trong Checklist 8-key (`theme-qa-workflow.ts:1146-1148`)**:
   - `checklist.layout`, `checklist.responsive`, và `checklist.overflow` đều bị gán chung công thức: `!overflowResult.hasOverflow`.
   - Ngay cả khi trên active viewport phát hiện hàng loạt critical `overlap` hoặc `occlusion`, `checklist.layout` vẫn trả về `true` nếu trang không bị thanh cuộn ngang!

---

## 2. BRAINSTORM CONTRACT

### A. Outcome (Mục tiêu đạt được)
Nâng cấp trục Visual QA từ cơ chế "Single-viewport Overflow-only" thành **"Per-Viewport Integrity & Overflow Sweep"** chuẩn hoá trên toàn bộ 5 canonical breakpoints (`320px`, `375px`, `768px`, `1024px`, `1440px`):
1. **Toàn diện 5 Viewports**: Tại mỗi viewport, chạy đồng thời cả đo tràn ngang định danh thủ phạm (Culprit Discovery) và 6 detector của `LayoutIntegrityEngine` (overlap, clipping, occlusion, offscreen, zero-size, sticky).
2. **Dữ liệu thật trong `responsiveMap`**: Điền số lượng lỗi thực tế (`criticalOverlap`, `criticalClipping`, `criticalOcclusion`, `criticalOffscreen`, `criticalOverflow`) thay vì hardcode số `0`.
3. **Phân định rõ ràng trong Checklist**:
   - `checklist.overflow`: `true` khi cả 5 viewports không tràn ngang (`scrollWidth <= clientWidth + deadband`).
   - `checklist.responsive`: `true` khi cả 5 viewports không có critical overflow và không có critical overlap/occlusion.
   - `checklist.layout`: `true` khi viewport active không có vi phạm integrity critical và không tràn.
4. **An toàn vòng đời Viewport (Lifecycle Isolation)**: Tự động khôi phục 100% viewport/preset ban đầu của tab sau khi quét xong (kể cả khi process gặp abort signal hoặc runtime error).

### B. Constraints (Ràng buộc bất biến)
1. **Không thêm MCP Server mới**: Hoàn toàn kế thừa và mở rộng bên trong `NativeTabHost`, `BrowserControlPort`, và `ThemeQaWorkflow`.
2. **Read-only / Non-mutating**: Quy trình quét DOM và CDP device emulation không được mutate dữ liệu, không ghi đè cấu hình theme, không kích hoạt stateful action (form submit, click navigation).
3. **Evidence Budget Bounded**: Tổng thời gian sweep qua cả 5 viewports không được vượt quá **850ms** (mỗi breakpoint ~120-150ms).
4. **Receipt Projection Contract**: Giữ nguyên projection 16 trường của `ThemeQaReport` và checklist 8-key; không làm gãy schema của consumers hiện tại (`theme.qa_validate`).
5. **Fail-Closed Target Lifecycle**: Nếu tab bị crash/destroy giữa quá trình sweep, phải throw lỗi chuẩn `TARGET_STALE` / `TARGET_REQUIRED` thay vì fabricate dữ liệu rỗng.

### C. Non-goals (Không thuộc phạm vi đợt này)
1. **Full-page Visual Regression Stitching**: Không chụp screenshot full-page đa tầng ở cả 5 viewport để pixel-diff (thuộc trục baseline visual compare của Candidate 2).
2. **Stateful Interaction Crawling**: Không tự động tương tác sâu (click mở toàn bộ accordion, mở modal, trigger dynamic forms) trong lượt sweep tĩnh này (thuộc phạm vi của Candidate 3).
3. **External Vision AI Inference**: Không gọi LLM multimodal API (Gemini/Claude) trong vòng lặp QA đồng bộ (vi phạm constraint offline và latency budget).

### D. Acceptance Criteria (Tiêu chí nghiệm thu định lượng)
1. **Đồng bộ Key Indexing**: `runResponsiveCheck` trả về kết quả được index song song theo cả `bp.id` (`'mobile-standard'`) và `String(bp.width)` (`"375"`), giúp `theme-qa-workflow.ts:850` đọc chính xác dữ liệu từng viewport.
2. **Responsive Culprit Extraction**: Khi mobile (320px/375px) bị tràn ngang, `report.findings.overflow.culprits` chứa ít nhất 1 selector CSS cụ thể và bounding box của phần tử gây tràn thay vì mảng rỗng `[]`.
3. **Đo lường thật tại Mobile**: Trang web có 2 button đè lên nhau (>60% intersection) ở độ phân giải 375px phải được ghi nhận vào `report.findings.responsive['375'].criticalOverlap >= 1`.
4. **Miễn dịch với Off-canvas False Positives**: Mobile drawer/menu dùng `transform: translateX(-100%)` hoặc `left: -9999px` không bị detector `offscreen` đánh trượt oan (`isEffectivelyHidden` được mở rộng để nhận diện mẫu off-canvas container).
5. **Checklist Gating Chính xác**: Khi responsive có critical overlap, `checklist.responsive` trả về `false` ngay cả khi active viewport desktop đang sạch bóng.
6. **Zero Viewport Leak**: Tab active của người dùng được restore về đúng `devicePresetId` hoặc window dimensions ban đầu trong block `finally`, kiểm chứng qua 100 lần chạy liên tục không lệch 1 pixel.
7. **Performance Benchmark**: Thời gian thực thi `runResponsiveCheck` trên theme Haravan/Shopify trung bình không quá 800ms trên môi trường Electron chuẩn.

---

## 3. PHÂN TÍCH SO SÁNH CÁC HƯỚNG TIẾP CẬN (TRADE-OFFS MATRIX)

Mỗi phương án được đánh giá cùng **Giả định nặng nhất (Heaviest Assumption)** và **Điều kiện thất bại sớm nhất (Earliest Failure Condition)**:

| Phương án | Cơ chế cốt lõi | Ưu điểm | Heaviest Assumption | Earliest Failure Condition |
| :--- | :--- | :--- | :--- | :--- |
| **Option 1: Per-Viewport Integrity Sweep (Candidate 1 - Khuyến nghị)** | Dùng CDP `setDeviceMetricsOverride` quét 5 breakpoints; inject đồng thời Overflow Culprit + Integrity Detectors. | Phát hiện chính xác vị trí đè nhau, tràn khung, che khuất nút bấm; không cần ảnh mẫu baseline; cực nhanh (<800ms). | **Thời gian settle 80-100ms là đủ** để CSS media query và `ResizeObserver` hoàn tất reflow DOM. | Một theme dùng thư viện carousel (Slick/Swiper) có debounce resize 250ms; scanner chạy ở 80ms đo trúng layout chuyển tiếp tạm thời, sinh ra cảnh báo giả `overlap`. |
| **Option 2: Multi-Breakpoint Pixel Diff Baseline (Candidate 2)** | Chụp ảnh 5 viewport rồi so sánh pixel-by-pixel với baseline `vbase_*`. | Trực quan; phát hiện được cả lỗi lệch font chữ, sai màu sắc hoặc background vỡ. | **Mọi trang web đều đã có sẵn ảnh mẫu baseline chuẩn (`vbase_*`)** đã được duyệt trước đó. | Dev tạo trang landing page mới hoặc sửa code Liquid lần đầu; chưa có baseline tồn tại -> hệ thống trả về `INCONCLUSIVE`, hoàn toàn bất lực không thể QA. |
| **Option 3: Stateful / Interactive Exploration QA (Candidate 3)** | Dùng script click mở mobile menu, mở cart drawer, cuộn trang rồi mới quét visual. | Kiểm tra được trạng thái động (khi drawer mở có đè nội dung hay không). | **Tự động click vào DOM không gây tác dụng phụ** (nhảy URL, reload trang, gọi API thanh toán). | Nút hamburger mobile vô tình bọc trong thẻ `<a href="/menu">`; click tương tác làm tab điều hướng sang route mới, phá huỷ toàn bộ phiên QA (`TARGET_MISMATCH`). |
| **Option 4: Multimodal / AI Vision Review (Candidate 4)** | Chụp screenshot gửi cho mô hình Vision (Gemini 3.1 Flash / Claude 3.7) chấm điểm layout. | Nhận thức ngữ nghĩa như mắt người; hiểu được layout cố tình thiết kế chồng lấn nghệ thuật. | **Có sẵn kết nối internet / API quota / latency cho phép 3-5 giây mỗi ảnh** trong pipeline desktop offline. | Mất mạng hoặc API timeout; chi phí token tăng vọt; verdict không tất định (cùng 1 trang lúc PASS lúc FAIL do hallucination). |
| **Option 5: Evidence Architecture Ratchet Only (Candidate 5)** | Chỉ sửa logic tổng hợp checklist và ratchet diff, giữ nguyên việc quét trên 1 viewport active. | Không tốn thêm thời gian resize tab; code tối giản, an toàn tuyệt đối về hiệu năng. | **Lỗi trên active viewport đại diện đầy đủ cho lỗi trên tất cả các thiết bị**. | Trang web hoàn hảo trên laptop 1440px nhưng vỡ nát menu trên iPhone 375px; hệ thống tiếp tục cấp PASS vì không hề thu thập bằng chứng ở mobile. |

---

## 4. BETTER APPROACHES EVALUATION

**Kết luận:** **None — recommended direction is the requested one (Per-Viewport Integrity Sweep with Culprit & Off-canvas Sanitization).**

*Căn cứ thực chứng (Evidence):*
- Phân tích ở Section 1 chứng minh rằng hạ tầng hình học (`LayoutIntegrityEngine`), hạ tầng điều khiển kích thước CDP (`applyCdpDeviceEmulationState`), và cơ chế cách ly tab nền (`runWithAttachedTabView`) **đã có sẵn 100% trong repo AntiFan**.
- Điểm yếu "Visual không check được" không phải do thiếu công nghệ cao siêu (như AI Vision hay Pixel Diff phức tạp), mà do **bị chặn ở tầng phối hợp (orchestration bottleneck)**: scanner mạnh nhất lại chỉ chạy ở 1 viewport active và kết quả responsive bị rớt do lỗi lệch key index.
- Không có giải pháp nào tốt hơn việc đưa chính các detector hình học tất định, không tốn token, chạy trong 800ms này vào quét trên toàn bộ 5 breakpoint canonical.

---

## 5. THIẾT KẾ KỸ THUẬT CHI TIẾT CHO CANDIDATE 1

### 1. Chuẩn hóa Key Indexing trong `NativeTabHost.runResponsiveCheck`
Tại `src/main/browser/native-tab-host.ts:15047-15053`, lưu song song:
```typescript
results[bp.id] = breakpointData;
results[String(bp.width)] = breakpointData; // Phục vụ trực tiếp lookup theme-qa-workflow
```

### 2. Tích hợp Integrity Script vào Vòng lặp Sweep
Tại mỗi breakpoint `bp`:
1. Gọi `await this.applyCdpDeviceEmulationState(wc, bpState, 1)`.
2. Đợi settle: `await new Promise((r) => setTimeout(r, 80))`.
3. Thực thi kịch bản gộp:
   - Chạy hàm phát hiện thủ phạm tràn ngang (`LayoutOverflowEngine` logic).
   - Chạy 6 detector của `LayoutIntegrityEngine`.
4. Trả về cấu trúc chi tiết:
   ```typescript
   results[String(bp.width)] = {
     width: bp.width,
     hasHorizontalOverflow: docOverflow,
     deltaX,
     culprits: overflowCulprits, // Ghi nhận đúng element gây tràn tại width này
     integrity: {
       criticalOverlap,
       criticalClipping,
       criticalOcclusion,
       criticalOffscreen,
       findings: integrityFindings
     }
   };
   ```

### 3. Khử False-Positive cho Mobile Drawer trong `layout-integrity-engine.ts`
Cập nhật `isEffectivelyHidden` tại `layout-integrity-engine.ts:98-107` để xử lý các kỹ thuật ẩn mobile menu phổ biến của theme Shopify/Haravan:
```typescript
const isEffectivelyHidden = (el, style) => {
  // ... các kiểm tra cũ ...
  // Bổ sung: kiểm tra transform hoặc off-canvas container
  if (style && style.transform && style.transform !== 'none') {
    const matrix = style.transform;
    if (matrix.includes('-') && (matrix.includes('matrix') || matrix.includes('translate'))) {
      // Element nằm trong container bị dịch chuyển ra ngoài màn hình
      if (el.closest('.drawer, .mobile-menu, [class*="offcanvas" i], [class*="nav-drawer" i]')) {
        return true;
      }
    }
  }
  return false;
};
```

### 4. Cập nhật `theme-qa-workflow.ts`
- Tại lines 849-862: Điền trực tiếp các số liệu `criticalOverlap`, `criticalClipping`, `criticalOcclusion`, `criticalOffscreen` từ `bp.integrity` vào `responsiveMap[String(w)]`.
- Tại lines 1145-1153:
  ```typescript
  const hasResponsiveCriticals = Object.values(responsiveMap).some(
    (m) => m.criticalOverflow > 0 || m.criticalOverlap > 0 || m.criticalOcclusion > 0
  );
  const checklist: ThemeQaReport['checklist'] = {
    layout: !overflowResult.hasOverflow && integrityCriticals.length === 0,
    responsive: !overflowResult.hasOverflow && !hasResponsiveCriticals,
    overflow: !overflowResult.hasOverflow,
    // ...
  };
  ```

---

## 6. TỔNG KẾT HÀNH ĐỘNG
Phương án **Per-Viewport Integrity Sweep** của Candidate 1 giải quyết triệt để 100% khiếu nại của user, tận dụng tối đa code hiện có trong AntiFan, không phát sinh chi phí hạ tầng mới, giữ vững nguyên tắc bảo thủ, tất định và fail-closed của hệ thống.