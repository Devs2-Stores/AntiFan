---
type: brainstorm
date: 2026-09-06
audited_report: "E:/Download/AntiFan-Visual-Verification-Codebase-Adversarial-Audit-v5-2026-09-06.md"
audited_head: "dd33cf67828613ac4401c19f1d6676d9d7c56669"
mode: advice
advisory_supervision: "kongming (supervisor unavailable on current host; logged as non-fatal advisory miss per protocol)"
---

# Báo cáo Phân tích Đối kháng và Tái Định hình Hệ thống Kiểm chứng Thị giác AntiFan v5

## Tóm tắt điều hành

Báo cáo kiểm toán đối kháng v5 (`AntiFan-Visual-Verification-Codebase-Adversarial-Audit-v5-2026-09-06.md`) xem xét mã nguồn tại commit HEAD `dd33cf67828613ac4401c19f1d6676d9d7c56669`. Bản kiểm toán này hoàn toàn chính xác về mặt định hướng: **AntiFan không cần một thuật toán so sánh pixel thông minh hơn hay phức tạp hơn, mà cần một hợp đồng xác thực trung thực, tất định và fail-closed xoay quanh các pixel mà nó đã có khả năng so sánh**.

Tuy nhiên, đối chiếu thực chứng với cây mã nguồn HEAD cho thấy báo cáo v5 có **hai điểm quá đà (over-engineering)** và **hai mâu thuẫn nội tại về ranh giới thẩm quyền**:
1. **Quá đà về phân mảnh mã nguồn:** Đề xuất chia nhỏ thành 8 file trong thư mục `visual/` vi phạm trực tiếp nguyên tắc KISS/YAGNI của dự án. Thực tế chỉ cần 1 module hỗ trợ `visual-capture-space.ts` và tích hợp thẳng vào hệ thống hiện có.
2. **Quá đà về kiểm thử:** Đòi hỏi cả 25 ca kiểm thử đóng băng (V-01 đến V-25) đều phải chạy trên môi trường đồ họa Electron thật trên Windows là thiếu thực tế, gây chậm và dễ flaky; cần phân tầng kim tự tháp: **Unit Test thuần túy (Toán học/Ledger) $\to$ Integration Mock Test $\to$ Electron Smoke Test tối thiểu**.
3. **Mâu thuẫn thẩm quyền phán quyết:** Báo cáo một mặt khẳng định `VerificationEvaluator` là cơ quan thẩm quyền duy nhất, mặt khác lại đòi hỏi primitive `visualCompare()` phải trực tiếp trả về verdict `INCONCLUSIVE / MASK_RESOLUTION_FAILED`. Giải pháp đúng đắn là `visualCompare()` chỉ thu thập chứng cứ và phát sinh `MetricSample[]`; `VerificationEvaluator` mới có thẩm quyền ban hành phán quyết.
4. **Nhầm lẫn giữa mục tiêu sản phẩm và bất biến cốt lõi:** Việc ưu tiên quy trình Sapo-first là yêu cầu sản phẩm cấp cao (P1), không phải lỗi tính đúng đắn toán học P0 của lõi so sánh thị giác nền tảng.

---

## 1. Đối chiếu Thực chứng Mã nguồn với Các Phát hiện của Báo cáo

### Nhóm 1: Lỗi Mã nguồn Đã Được Chứng minh (Confirmed Source Defects — P0)

#### CD-01: Lệch không gian tọa độ Mask khi Screenshot bị Crop bởi Selector hoặc ClipRect (P0)
- **Căn cứ báo cáo:** Section 5.1 (lines 171–219).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:2415–2426, 2432–2467, 2574–2587`; `src/main/tools/browser-control-port.ts:3154–3169`.
- **Thực chứng:** `getBoundingClientRect()` trả về tọa độ theo CSS Viewport của trang. Khi người dùng truyền `selector` hoặc `clipRect`, ảnh chụp bị cắt cục bộ với gốc `(0, 0)` tương ứng với `resolvedRect`, nhưng `maskBoxes` vẫn giữ nguyên tọa độ gốc của Viewport. Trong `computePixelDiff()`, vòng lặp kiểm tra `isMasked(x, y)` chạy trên tọa độ raster cục bộ từ `0` đến `minW - 1`. Nếu phần tử crop ở `(400, 300)` và phần tử con cần che ở `(450, 350)`, giá trị `box.x = 450` sẽ luôn lớn hơn chiều rộng của ảnh crop (ví dụ 100px), khiến mask hoàn toàn rơi ra ngoài biên ảnh và bị bỏ qua 100%. Lỗi này dẫn đến cả false-pass (không che được nội dung động) lẫn false-fail (che nhầm nếu tọa độ vô tình trùng lặp).

#### CD-02: Cơ chế phân giải Mask nuốt lỗi ngoại lệ dẫn đến Fail-Open hoàn toàn (P0)
- **Căn cứ báo cáo:** Section 6 (lines 283–340).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:2407–2430`.
- **Thực chứng:** Khối `evalJs` trích xuất `maskSelectors` được bọc trong:
  ```ts
  try {
    const rawBoxes = await this.host.evalJs(...);
    ...
  } catch {
    // Non-blocking mask resolution
  }
  ```
  Nếu selector có lỗi cú pháp (ví dụ `div[`), trang chưa kịp render hoặc evalJs thất bại, `maskBoxes` mặc định giữ nguyên mảng rỗng `[]`. Hàm tiếp tục chạy so sánh pixel với 0 vùng mask mà không phát ra bất kỳ cảnh báo hay lỗi nào, âm thầm vi phạm hợp đồng kiểm thử của caller.

#### CD-03: So sánh hai tab (`comparisonTabId`) áp đặt Mask đơn phương từ Tab Target (P0)
- **Căn cứ báo cáo:** Section 7 (lines 342–374).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:2407–2430, 2493–2538, 2574–2587`.
- **Thực chứng:** Khi truyền `params.comparisonTabId`, mã nguồn giải quyết `compRect` trên tab so sánh, nhưng `maskBoxes` chỉ được trích xuất từ `tabId` (target tab). Mảng `maskBoxes` này được truyền thẳng vào `computePixelDiff()` để che cả hai ảnh bitmap. Do nội dung động (giá tiền, badge khuyến mãi, giỏ hàng mini) giữa hai phiên bản thường có kích thước văn bản hoặc vị trí khác nhau, việc dùng chung một mask geometry của tab A cho tab B sẽ làm lộ pixel động trên tab B hoặc che nhầm pixel tĩnh hợp lệ.

#### CD-04: `normalizeScroll` gây đột biến DOM vĩnh viễn trong Capability thuộc tính Read (P0/P1)
- **Căn cứ báo cáo:** Section 8 (lines 376–437).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:2394–2405, 2493–2506`; đối chiếu với `src/main/tools/browser-capabilities.ts:2100–2140` và `src/main/browser/tab-devtools-host.ts:1105–1115`.
- **Thực chứng:** `browser.visual_compare` được đăng ký là capability `effect: 'read'`, `risk: 'read'` trên scheduler lane `short-passive`. Tuy nhiên, `normalizeScroll` inject thẻ `<style id="__antifan_normalize_scroll">` vào `document.head` của cả hai tab mà không hề có cơ chế gỡ bỏ trong khối `finally`. Trong khi đó, `TabDevToolsHost.captureScreenshot` tiêm style mask có khối `finally` dọn dẹp sạch sẽ (dòng 1108–1116). Thẻ style bị bỏ rơi gây đột biến layout lâu dài, kích hoạt `MutationObserver` tại `tab-preload.ts:382–391` và làm tăng `mutationRevision` cho các tác vụ tiếp theo.

---

### Nhóm 2: Rủi ro Kỹ thuật Đáng tin nhưng Chưa Có Đo đạc Thực thi (Credible Unproved Risks — P1)

#### CR-01: Sai lệch tỷ lệ Raster do Device Scale Factor (DPR) và Zoom (P1)
- **Căn cứ báo cáo:** Section 5.3 (lines 228–244).
- **Căn cứ mã nguồn:** `src/main/browser/tab-devtools-host.ts:354–369`; `src/main/tools/browser-control-port.ts:2415–2426`.
- **Thực trạng:** Tại `tab-devtools-host.ts`, inspector crop bắt buộc phải tính `scaleX = imgSize.width / domSize.w` vì buffer ảnh trả về từ `capturePage()` là pixel vật lý (Retina/HiDPI có DPR = 2), trong khi DOM rect là CSS pixels. `visualCompare()` hiện không thực hiện phép scale này. Trên màn hình DPR = 2, mask CSS chỉ che 1/4 diện tích raster cần che. Cần một bài test phân định tại DPR = 2 và zoom 125% để lượng hóa sai lệch.

#### CR-02: Thiếu rào cản cố kết danh tính (Two-Source Coherence Barrier) (P1)
- **Căn cứ báo cáo:** Section 9 (lines 439–495).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:745–820` đối chiếu `2368–2589`.
- **Thực trạng:** Trong `observe()`, hàm `assertCoherent()` liên tục xác thực `browserEpoch`, `documentGeneration`, và `mutationRevision` không bị thay đổi. `visualCompare()` trải qua chuỗi async dài (inject style $\to$ resolve mask $\to$ capture target $\to$ capture comparison $\to$ pixel diff) nhưng không có rào cản tương đương. Nếu trang có client-side hydration, live-reload hoặc animation làm thay đổi DOM giữa lúc tính mask và lúc chụp ảnh, bằng chứng sẽ mất tính tương quan.

#### CR-03: Tab đối chiếu không được khóa đồng thời (Comparison Tab Concurrency Hazard) (P1)
- **Căn cứ báo cáo:** Section 10 (lines 497–526).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:158–194, 2393, 2493`.
- **Thực trạng:** `passivePool.execute(tabId, ...)` thực chất là một bộ đếm giới hạn đồng thời (concurrency counter với trần 4 tác vụ/tab, 16 toàn cục), không phải mutex hay hàng đợi khóa tuần tự. `visualCompare()` chỉ tăng đếm trên `tabId` chính; `compTabId` bị truy cập tự do mà không qua bộ đếm này, tạo ra rủi ro tranh chấp nếu có worker chạy ngầm trên tab đối chiếu.

#### CR-04: Sự dao động ngữ nghĩa giữa các tầng Backend chụp ảnh (P1)
- **Căn cứ báo cáo:** Section 11 (lines 528–569).
- **Căn cứ mã nguồn:** `src/main/browser/tab-devtools-host.ts:900–1118`.
- **Thực trạng:** `captureScreenshot()` sử dụng 4 tầng fallback: Tier 1 (`wc.capturePage` trong 600ms), Tier 2 (CDP `Page.captureScreenshot`), Tier 3 (Offscreen CDP), Tier 4 (`wc.capturePage` retry). Sự khác nhau giữa surface capture và CDP capture có thể sinh ra sai lệch nhỏ về timing compositor hoặc khử răng cưa subpixel giữa hai ảnh baseline và current.

---

### Nhóm 3: Quyết định Thiết kế Cần Tinh chỉnh (Design Choices)

#### DC-01: Cách ly Vòng đời Artifact theo Run/Attempt trong `ArtifactStore`
- **Căn cứ báo cáo:** Section 12 (lines 571–623).
- **Căn cứ mã nguồn:** `src/main/tools/artifact-store.ts:186–198`.
- **Nhận định:** Việc `ArtifactStore.readBytesById` từ chối đọc nếu `context.attemptId !== ref.attemptId` là **quyết định thiết kế bảo mật có chủ đích** nhằm cô lập bằng chứng giữa các lần chạy, không phải lỗi kỹ thuật. Để hỗ trợ so sánh hồi quy giao diện qua nhiều attempt, giải pháp đúng đắn là xây dựng thực thể `VisualBaselineRef` ở cấp độ workspace/project có kiểm tra chữ ký SHA-256, tuyệt đối không nới lỏng kiểm tra của `ArtifactStore`.

#### DC-02: Loại bỏ Pixel trong Mask (Skip Area) vs Chuẩn hóa Màu Trung tính (Paint Normalization)
- **Căn cứ báo cáo:** Section 19 (lines 887–920).
- **Căn cứ mã nguồn:** `src/main/tools/browser-control-port.ts:3141–3169`.
- **Nhận định:** Báo cáo v5 gợi ý thay thế pixel động bằng màu trung tính trước khi so sánh. Tuy nhiên, giải pháp hiện tại của `computePixelDiff()` (bỏ qua các pixel thuộc `maskBoxes` khỏi tử số và mẫu số) là giải pháp tinh gọn, tiết kiệm bộ nhớ và không làm đột biến buffer ảnh gốc. Chỉ cần bổ sung rào cản trần tỷ lệ diện tích che chắn (`maskedAreaRatio <= 0.50`) để chống gian lận (anti-gaming).

---

### Nhóm 4: Đề xuất Suy đoán Cần Gạt bỏ (Speculative Roadmap — Bác bỏ)

1. **Bác bỏ kiến trúc phân rã 8 file vi mô (`src/main/verification/visual/*`):** Toàn bộ module `visual-region.ts` chỉ có 62 dòng, `verification-evaluator.ts` chỉ có 274 dòng. Việc tạo 8 file cho vài hàm toán học tọa độ và ledger là over-engineering nghiêm trọng. Toàn bộ logic không gian chụp và mask chỉ cần gom vào 1 file duy nhất: `src/main/verification/visual-capture.ts`.
2. **Bác bỏ yêu cầu chạy toàn bộ 25 bài test trên Electron thật:** Chạy 25 test Electron trên Windows sẽ làm chậm CI và phát sinh flaky test. Chỉ cần chạy 4-5 test kịch bản thực tế trên Electron; 20 bài test kiểm tra toán học tọa độ, bounds, và cú pháp selector phải chạy bằng Node.js test runner thuần túy (<100ms).
3. **Bác bỏ việc đưa Sapo-First thành lỗi P0 của Lõi Visual Core:** Toán học tọa độ và cơ chế fail-closed là bất biến phi nền tảng (platform-agnostic). Sapo Platform Driver thuộc về tầng quy trình sản phẩm (P1), không phải lỗi P0 của engine hình ảnh.
4. **Kiên quyết loại bỏ toàn bộ công nghệ AI/CV nặng:** Tiếp tục bác bỏ OCR, CLIP, YOLO, Scene Graphs và Vector DB theo đúng tuyên ngôn tinh gọn của AntiFan.

---

## 2. Giải quyết Mâu thuẫn Nội tại của Báo cáo v5

| Điểm mâu thuẫn | Biểu hiện trong báo cáo v5 | Giải pháp chuẩn mực của Hệ thống |
|---|---|---|
| **Thẩm quyền Phán quyết** | Section 16 khẳng định `visualCompare()` chỉ sinh dữ liệu thô, nhưng Section 6 và 25 lại đòi hỏi `visualCompare()` phải trực tiếp trả về `INCONCLUSIVE` hoặc `STRUCTURAL_TRUNCATION_DETECTED`. | **Ranh giới 2 tầng minh bạch:**<br>1. **Tầng năng lực (`visualCompare`):** Thực thi chụp và diff pixel, ném `CapabilityError` nếu lỗi hệ thống, hoặc trả về receipt chứa cờ trạng thái tính toàn vẹn (`maskResolutionStatus: 'FAILED'`, `captureStateCompatible: false`).<br>2. **Tầng phán quyết (`VerificationEvaluator`):** Tiếp nhận `MetricSample[]` từ receipt và ban hành phán quyết hợp đồng (`VERIFIED`, `REJECTED`, `INCONCLUSIVE`). |
| **Tính Nhất quán Danh tính** | Section 9 và 20 đôi khi gộp chung việc kiểm tra danh tính tài liệu giữa hai tab. | **Tách biệt hai khái niệm:**<br>1. **Cố kết nội bộ (Per-side Stability):** `documentGeneration` và `mutationRevision` của từng tab không đổi trong suốt phiên chụp của chính nó.<br>2. **Tương thích tham số (Cross-side Compatibility):** Hai bên phải có cùng CSS viewport, DPR, zoom factor và chế độ fullPage. |

---

## 3. Các Phương án Triển khai (Options Analysis)

### Phương án 1: Triển khai Theo Báo cáo v5 (8-File Split + 25 Electron Tests)
- **Mô tả:** Tách thành 8 file module độc lập và bắt buộc toàn bộ 25 test case chạy trên Electron runtime.
- **Đánh đổi:** Độ chi tiết lý thuyết cao nhưng gây phân mảnh mã nguồn, chi phí nhảy file lớn, CI chạy chậm trên Windows.
- **Giả định cốt lõi:** Hệ thống visual compare sẽ phát triển thành một framework thị giác độc lập đồ sộ.
- **Điểm gãy đầu tiên:** Gãy ở chi phí bảo trì và độ trễ CI; vi phạm trực tiếp quy tắc YAGNI.

### Phương án 2: Vá chắp vá cục bộ trực tiếp trong `browser-control-port.ts`
- **Mô tả:** Viết thêm các hàm helper private bên trong `browser-control-port.ts`.
- **Đánh đổi:** Sửa nhanh nhất nhưng làm phình to file `browser-control-port.ts` (vốn đã hơn 3.200 dòng), biến logic toán học tọa độ thành mã rối khó unit test độc lập.
- **Giả định cốt lõi:** Các hàm biến đổi tọa độ và mask ledger không bao giờ cần tái sử dụng ở nơi khác.
- **Điểm gãy đầu tiên:** Gãy khi cần viết unit test độc lập cho logic toán học tọa độ mà không muốn khởi động runtime Electron cồng kềnh.

### Phương án 3 (Khuyến nghị): Tiến hóa Tinh gọn có Cấu trúc (Lean Structured Evolution)
- **Mô tả:** Tạo **duy nhất 1 module mới** `src/main/verification/visual-capture.ts` (chứa `CaptureSpace`, các hàm biến đổi tọa độ thuần túy, và `MaskLedger`), bổ sung định nghĩa metric vào `src/main/verification/verification-contract.ts`, bọc `finally` dọn dẹp `normalizeScroll`, và phân tầng ma trận 25 test thành 3 cấp độ.
- **Đánh đổi:** Cần 1 file mới nhưng giữ cho `browser-control-port.ts` tinh gọn trong vai trò điều phối I/O.
- **Giả định cốt lõi:** Toán học tọa độ và mask ledger là các hàm thuần túy (pure functions) có thể kiểm thử 100% bằng unit test, `VerificationEvaluator` giữ nguyên vai trò thẩm quyền duy nhất.
- **Điểm gãy đầu tiên:** Không có điểm gãy cấu trúc; rủi ro duy nhất là cần kiểm soát độ lệch subpixel giữa các tầng capture backend trên các môi trường hiển thị khác nhau.

---

## 4. Khuyến nghị và Chuỗi Ưu tiên Thực thi (Priority Sequence)

### Giai đoạn 1 (P0 — Tính Đúng đắn Toán học & Fail-Closed Masking)
1. **Module Biến đổi Tọa độ:** Viết hàm thuần túy `transformMaskBoxesToRaster(boxes, space)` trong `src/main/verification/visual-capture.ts` xử lý chuẩn xác 3 trường hợp: (a) Crop selector/clipRect có offset khác 0; (b) FullPage có `scrollY > 0`; (c) Tỷ lệ raster/CSS (`deviceScaleFactor` và zoom).
2. **Cơ chế Fail-Closed Mask:** Chuyển khối bắt lỗi `maskSelectors` thành `MaskLedger`: nếu selector lỗi cú pháp hoặc không tìm thấy phần tử, ghi nhận trạng thái lỗi và từ chối so sánh không che chắn thay vì nuốt ngoại lệ thành `maskBoxes = []`.
3. **Phân giải Mask Độc lập cho Hai Tab:** Khi có `comparisonTabId`, trích xuất mask riêng biệt trên target tab và comparison tab, chuyển đổi tọa độ tương ứng với buffer của từng bên.
4. **Dọn dẹp `normalizeScroll` trong `finally`:** Đảm bảo thẻ `<style id="__antifan_normalize_scroll">` luôn được gỡ bỏ ngay sau khi chụp hoặc khi xảy ra ngoại lệ.

### Giai đoạn 2 (P0/P1 — Cố kết Giao dịch & Thu thập Metadata Capture)
5. **Rào cản Cố kết Danh tính (Per-Side Coherence):** Kiểm tra `browserEpoch`, `documentGeneration`, và `mutationRevision` không bị thay đổi trong khoảng thời gian từ lúc đo mask đến lúc chụp xong bitmap trên từng tab.
6. **Biên nhận Chụp (`VisualCaptureReceipt`):** Trả về đầy đủ kích thước raster, kích thước CSS, capture backend thực tế và trạng thái của `MaskLedger`.

### Giai đoạn 3 (P1 — Tích hợp Thẩm quyền VerificationEvaluator)
7. **Đăng ký Metric Thị giác:** Bổ sung các hằng số `visual.pixel_mismatch_pct`, `visual.dimensions_match`, `visual.mask_resolution_complete`, `visual.capture_state_compatible` vào `verification-contract.ts`.
8. **Chuyển đổi Dữ liệu sang `MetricSample[]`:** Để `visualCompare()` sinh ra danh sách mẫu đo và nạp vào `VerificationEvaluator` đưa ra phán quyết hợp đồng (`VERIFIED`, `REJECTED`, `INCONCLUSIVE`).
9. **Kiểm tra Tính Toàn vẹn Cấu trúc qua Mask:** Với các phần tử bị che động, tiếp tục đánh giá tính toàn vẹn hình học (bounding box, overflow, cardinality) qua `visual-region.ts`.

### Giai đoạn 4 (P1/P2 — Workflow Sản phẩm & Baseline Thăng hạng)
10. **Baseline Bền vững (`VisualBaselineRef`):** Hỗ trợ tham chiếu baseline ở cấp độ workspace/project có checksum SHA-256 để vượt qua ranh giới `attemptId` mà không làm suy yếu `ArtifactStore`.
11. **Sapo Theme Live Workflow:** Tích hợp attestation đồng bộ CLI cho theme Sapo trước khi kích hoạt hàng rào kiểm thử thị giác.

---

## 5. Phân tầng Ma trận Kiểm thử Đóng băng (Test Matrix Stratification)

| Tầng kiểm thử | Phương thức thực thi | Thời gian chạy | Danh sách bài kiểm thử bao phủ |
|---|---|---|---|
| **Tầng 1: Pure Unit Tests** | Node.js Test Runner thuần túy, không bật Electron, kiểm tra hàm toán học và logic ledger. | < 100 ms | **V-01** (Thiếu selector mask), **V-02** (Cú pháp selector sai), **V-03** (Dịch chuyển crop selector), **V-04** (Dịch chuyển `clipRect`), **V-05** (FullPage + `scrollY`), **V-06** (Tỷ lệ scale DPR = 2), **V-07** (Tỷ lệ scale zoom 125%), **V-08** (Mask độc lập 2 tab), **V-23** (Khống chế tỷ lệ diện tích mask tối đa). |
| **Tầng 2: Integration Tests** | Sử dụng Mock BrowserHostPort và kiểm tra luồng điều khiển của `BrowserControlPort`. | < 1 s | **V-11** (Dọn dẹp `normalizeScroll` thành công), **V-12** (Dọn dẹp `normalizeScroll` khi có lỗi), **V-13** (Lỗi bất đối xứng chuẩn hóa cuộn), **V-14** (Phát hiện đột biến DOM giữa chừng), **V-15** (Phát hiện chuyển trang giữa chừng), **V-21** (Phát hiện không tương thích trạng thái capture), **V-22** (Quyền truy cập baseline thăng hạng), **V-24** (Tính tất định qua 3 lần chạy trên fixture tĩnh). |
| **Tầng 3: Real Electron Live Proof** | Chạy trên tiến trình Electron thực tế với màn hình và GPU compositor. | 5 – 10 s | **V-16** (Đợi font web kết xuất), **V-17** (Đợi decode hình ảnh hiển thị), **V-18** (Phát hiện ảnh hỏng 404), **V-19** (Nhất quán capture foreground và background), **V-20** (Nhất quán capture backend phục vụ verification), **V-25** (Quy trình theme Sapo end-to-end: CLI sync $\to$ settle $\to$ capture $\to$ evaluator). |

---

## 6. Hồ sơ Giám sát Cố vấn (Advisory Supervision Log)

- **Cờ yêu cầu:** `--advice`.
- **Định danh giám sát:** `kongming` (Fable 5 / GPT-5.6-Sol advisory tier).
- **Trạng thái thực tế:** **Supervisor Unavailable**. Runtime máy chủ hiện tại trả về lỗi `Unknown agent "kongming"` (danh mục agent được đăng ký chỉ gồm: `scout`, `reviewer`, `security-reviewer`, `librarian`, `task`, `sonic`).
- **Xử lý theo quy thức:** Ghi nhận sự thiếu hụt giám sát độc lập (non-fatal advisory miss); tiếp tục tiến hành phân tích trung thực dựa trên bằng chứng thực chứng của mã nguồn và quy tắc nghiêm ngặt của `ak:brainstorm`, không tự ý chỉ định agent khác thay thế hay giả mạo kết quả đánh giá.

---

## 7. Các Câu hỏi Kỹ thuật Chưa có Lời giải (Unresolved Questions)

1. **Sai lệch Subpixel của Chromium Compositor trên Windows:** Trên các màn hình Windows 11 có tỷ lệ scale hiển thị hệ thống là 125% hoặc 150%, liệu `webContents.capturePage()` và CDP `Page.captureScreenshot` có sinh ra sai số làm tròn pixel khử răng cưa (subpixel anti-aliasing) trên các khối văn bản hay không? *(Cần bài test phân định V-19 trên môi trường máy trạm thật để đo lường ngưỡng tolerance tối thiểu)*.
2. **Cơ chế Lưu trữ Metadata của Promoted Baseline:** Nên lưu trữ `VisualBaselineRef` và biên nhận chụp `VisualCaptureReceipt` đi kèm dưới dạng một file JSON nằm cạnh ảnh trong `ArtifactStore` hay lưu thành một manifest JSON riêng biệt trong thư mục `.antifan/baselines/` của workspace?
3. **Chính sách Tự động Đóng băng Đa phương tiện:** Có nên tự động kích hoạt `freezeMedia` trước mỗi phiên so sánh hình ảnh hay để OMP agent quyết định dựa trên yêu cầu cụ thể của từng task?
