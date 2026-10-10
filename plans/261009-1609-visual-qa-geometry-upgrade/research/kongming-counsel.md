# KONGMING STRATEGIC ADVISORY: ĐÁNH GIÁ NĂNG LỰC VISUAL QA CỦA ANTIFAN DESKTOP
**Thời điểm đánh giá:** 2026-10-09  
**Đối tượng:** AntiFan Desktop (Electron 43, `src/main/qa/`)  
**Bằng chứng đối soát:** 17 Synthetic Fixtures (Probe 1-3) & 4 Production Haravan Stores (Probe 4)

---

## 1. Phán quyết về Kết luận của Main Agent (Verdict Assessment)

**Phán quyết:** **CONDITIONAL GO** (Chấp thuận định hướng cốt lõi nhưng cập nhật căn bản ranh giới bằng chứng theo Probe 4).

### Điểm chuẩn xác (Fact-grounded):
1. **Không phải chỉ chụp ảnh:** AntiFan sở hữu bộ kiểm tra hình học DOM thực thụ gồm `LayoutOverflowEngine` (`src/main/qa/scanners/layout-overflow-engine.ts`) và `LayoutIntegrityEngine` (`src/main/qa/scanners/layout-integrity-engine.ts`), được tích hợp tại bước 6.5 của `theme-qa-workflow.ts:847-877`.
2. **Đo lường Recall trên lỗi thật rất thấp:** Trên 15 lỗi giả lập thực tế, engine hiện tại chỉ bắt được **4/15 hard FAIL** (01, 02, 09, 13a) và **2 warnings** (05, 07); có tới **9 lỗi lọt lưới hoàn toàn** (silent miss).
3. **CLS Observer hoàn toàn vô hiệu hóa:** Do gọi `observer.disconnect()` đồng bộ ngay sau khi đăng ký (`layout-integrity-engine.ts:531-532`), sự kiện layout-shift không bao giờ được phân phối, `clsScore` luôn bằng 0.
4. **Cắt cụt 2000 node âm thầm:** Lệnh `slice(0, 2000)` (`layout-integrity-engine.ts:174`) không kèm cờ cảnh báo, làm mù hoàn toàn nửa dưới trang khi DOM lớn (13a bắt được ở 110 node, 13b bỏ lọt ở 2510 node).
5. **Lệch pha dây nối Responsive Map:** `native-tab-host.ts:15054, 15142` trả về object key theo ID (`mobile-small`, `mobile-standard`), trong khi `theme-qa-workflow.ts:894` đọc theo `responsiveBreakpoints?.[String(w)]` (320, 375,...), dẫn đến `bp` luôn `undefined` và kết quả responsive luôn báo 0 lỗi overflow trên cả 5 kích thước.

### Điểm cần cập nhật mạnh từ Probe 4 (Precision & False Positive Reality):
* **Nhận định cũ nói giảm mức độ nghiêm trọng của False Positive (FP):** Kết luận ban đầu chỉ nêu "1 false FAIL trên control line-clamp". Probe 4 trên 4 website Haravan thực tế (`phukienmaymoc.com`, `gixjewel.com`, `hapas.vn`, `unitedvision.com.vn`) chứng minh: **AntiFan đánh FAIL oan 3/4 website khỏe mạnh bình thường**:
  - `unitedvision.com.vn`: Nổ 50 critical `offscreen` trên drawer mobile đang đóng (`div.uv-mobile-drawer`, `position: fixed` ngoài viewport).
  - `hapas.vn`: Nổ 20 criticals gồm `zero-size` (0x20px anchor trong swiper) và `offscreen` (slide ẩn của carousel có `visibility: hidden` / transform).
  - `gixjewel.com`: Nổ 41 findings, trong đó có critical `clipping` trên tiêu đề sản phẩm dùng 2-line clamp có chủ đích (`scrollHeight 49-81px > clientHeight 32px`).
* **Nghịch lý hiện tại của AntiFan:** **Vừa đánh rớt 75% website lành lặn vì báo động giả, vừa bị mù trước 91%–96% nội dung chữ của trang web** (do 91%–96% phần tử chữ trên theme thật nằm ở độ sâu `depth > 6`, bị L288 bỏ qua hoàn toàn).
* **Bằng chứng về Prototype Oracle (`oracle.js`):** Thử nghiệm Probe 4 xác nhận Oracle (quét text-run qua Range API + scroll sweep) **chưa an toàn để đưa vào production**. Nó sinh ra hàng loạt FP trên trang thật:
  - Thanh bottom navigation fixed đè vào footer copyright khi cuộn trang (`phukienmaymoc`).
  - `Range.getClientRects()` vẫn tính bounding box cho các dòng chữ bị ẩn bởi CSS line-clamp, tạo ra cảnh báo đè chữ giả với giá tiền (`gixjewel`).
  - Báo động giả trên đồng hồ lật 3D (flip-clock), icon SVG path, và chữ bị che bởi nút hotline/Zalo cố định.

---

## 2. Xếp hạng Nguyên nhân Gốc rễ theo Mức độ Ảnh hưởng (Root Cause Ranking)

Xếp hạng theo mức độ tàn phá trải nghiệm người dùng trên theme TMĐT Haravan/Shopify thực tế (kết hợp cả tiêu chí **Precision** và **Recall**):

1. **Top 1: Báo động giả giết chết Verdict trên Site khỏe mạnh (Precision = 0% trên Critical Findings)**  
   *Vị trí:* `layout-integrity-engine.ts:189-221, 253-271`  
   *Cơ chế:* Phạt nặng drawer off-canvas đang đóng, slide ẩn trong Swiper/Carousel, và line-clamp/ellipsis có chủ đích.  
   *Hậu quả:* Biến công cụ QA thành "bộ cản trở vô dụng" — người dùng buộc phải tắt engine vì không thể chấp nhận việc theme chuẩn bị đánh FAIL.
2. **Top 2: Vùng mù cấu trúc `depth > 6` trong Overlap Detector**  
   *Vị trí:* `layout-integrity-engine.ts:288` (`if (getDepth(el) > 6) continue;`)  
   *Cơ chế:* Cấu trúc lồng ghép section/container/row/col/card/info/price của Shopify/Haravan luôn có độ sâu từ 8–15.  
   *Hậu quả:* Mù hoàn toàn trước 91%–96% phần tử văn bản trên trang (xác thực từ Probe 4); không thể bắt được lỗi giá đè tên sản phẩm hay chữ tràn mô tả.
3. **Top 3: Cắt cụt âm thầm `slice(0, 2000)` document-order**  
   *Vị trí:* `layout-integrity-engine.ts:174`  
   *Cơ chế:* Trang chủ TMĐT thật có 2.500 – 4.500 nodes. Footer nằm ở chỉ mục node 2.300 – 2.600.  
   *Hậu quả:* Toàn bộ nửa dưới trang web (slider thứ 2, review widget, chính sách, footer links, newsletter) bị loại bỏ khỏi tầm quét.
4. **Top 4: Hiện tượng "Ghost Rect" của Range API trên Line-clamp (Rủi ro Text-run)**  
   *Vị trí:* Kỹ thuật quét `Range.getClientRects()` (chứng minh qua Oracle tại `gixjewel.com`).  
   *Cơ chế:* Trình duyệt Chromium vẫn trả về tọa độ hộp cho các dòng văn bản bị ẩn bởi `-webkit-line-clamp`.  
   *Hậu quả:* Báo lỗi va chạm giả (`textCollision`) giữa tiêu đề sản phẩm và giá tiền nằm ngay bên dưới.
5. **Top 5: Occlusion không cuộn trang và Thiếu nhận thức về Fixed/Sticky Layer khi cuộn**  
   *Vị trí:* `layout-integrity-engine.ts:312, 372`  
   *Cơ chế:* Engine hiện tại chỉ kiểm tra `y < viewportHeight` ở vị trí ban đầu (bỏ sót CTA dưới nếp gấp màn hình). Ngược lại, nếu cuộn trang thô bạo (như Oracle) mà không loại trừ fixed layer, thanh Header/Bottom bar/Zalo widget sẽ bị coi là che khuất toàn bộ nội dung lướt qua nó.
6. **Top 6: Lệch map dữ liệu Responsive Breakpoints**  
   *Vị trí:* `theme-qa-workflow.ts:894` vs `native-tab-host.ts:15054`  
   *Cơ chế:* Sai lệch kiểu dữ liệu key (`mobile-small` vs `320`) khiến báo cáo đa màn hình luôn hiển thị sạch bóng lỗi overflow, mâu thuẫn trực tiếp với verdict tổng.
7. **Top 7: Ngắt kết nối đồng bộ PerformanceObserver (Dead CLS)**  
   *Vị trí:* `layout-integrity-engine.ts:531-532`  
   *Cơ chế:* Gọi `disconnect()` ngay lập tức khiến callback bị hủy; CLS luôn ghi nhận bằng 0.

---

## 3. Đánh giá Hướng Cải tiến & Đề xuất Chiến lược

### Ma trận So sánh 4 Hướng tiếp cận:

| Hướng tiếp cận | Giả định chịu tải (Load-bearing Assumption) | Điều kiện gãy đầu tiên (First Failure Condition) | Trường hợp xấu nhất (Worst Plausible Case) |
|---|---|---|---|
| **(A) Patch Box-level Detectors** | Bounding box của thẻ bao quát đúng chữ; việc nới lỏng depth/cap không làm sập CPU hay bùng nổ FP. | Text tràn khỏi thẻ do height cố định (fixtures 04, 07): box không chạm nhau nhưng chữ đè nhau. | Tốn công sửa chữa nhưng vẫn mù trước lỗi glyph va chạm; thuật toán $O(N^2)$ làm đơ tab trên 4.000 nodes. |
| **(B) Text-run Geometry Layer** | Tọa độ `Range.getClientRects()` và `elementFromPoint` phản ánh chính xác thị giác người dùng. | Text bị line-clamp ẩn đi vẫn sinh rect đè lên giá; thanh fixed bottom nav đè lên nội dung khi cuộn (Probe 4). | FP tràn ngập trên mọi trang TMĐT chuẩn; công cụ bị phế truất vì "quá nhiều cảnh báo rác". |
| **(C) Vision-model Review** | VLM có độ phân giải không gian đủ tốt để nhận diện chữ đè nhau ở mobile và hoạt động offline ổn định. | Mất mạng, timeout, hoặc VLM chỉ đưa ra nhận xét chung chung không map được tới selector/file Liquid. | Vi phạm nguyên tắc local-first của AntiFan; chi phí token cao; latency 15-30s/trang; flaky tests. |
| **(D) Hybrid (Kiến trúc khuyên dùng)** | Có thể dựng "bộ lọc miễn trừ ngữ cảnh" (Contextual Exemption) bằng CSS/DOM rules để chặn đứng FP trước khi đo đạc hình học. | Các component viết CSS quá tùy biến không theo chuẩn chung (ví dụ tự chế slider bằng JS thuần không dùng class chuẩn). | Độ phức tạp kiểm thử tăng do phải bảo trì cả bộ luật miễn trừ và thuật toán hình học. |

---

### Đề xuất Chiến lược: Hướng (D) — 2-Phase Bounded Geometry Engine

Kiến trúc chia làm 2 giai đoạn độc lập:
* **Phase I: Precision Shield (Bảo vệ tính đúng đắn — Bắt buộc làm trước):**
  Xây dựng bộ lọc loại trừ các thành phần giao diện đặc thù trước khi đưa vào bất kỳ detector nào:
  1. *Off-canvas / Hidden Drawer:* Bỏ qua phần tử offscreen/zero-size nếu nằm trong container có class/id/role chứa `drawer`, `modal`, `popup`, `offcanvas` hoặc có thuộc tính `aria-hidden="true"`, `visibility: hidden`.
  2. *Carousels & Swipers:* Miễn trừ các slide không kích hoạt (`.swiper-slide:not(.swiper-slide-active)`, `.slick-slide:not(.slick-active)`).
  3. *Line-clamp & Ellipsis:* Miễn trừ clipping nếu phần tử hoặc tổ tiên trực tiếp có `-webkit-line-clamp` hoặc `text-overflow === 'ellipsis'`.
  4. *Fixed Layer Isolation:* Tách riêng các phần tử `position: fixed / sticky` ra khỏi luồng kiểm tra va chạm nội dung khi cuộn trang.
* **Phase II: High-Yield Geometry (Mở rộng độ phủ lỗi thật):**
  1. *Spatial Y-Bucketing thay cho Depth < 6:* Không so sánh cặp đôi toàn trang ($O(N^2)$). Phân chia phần tử theo dải tọa độ trục Y (mỗi bucket 200px); chỉ so sánh các phần tử trong cùng dải tọa độ, nới lỏng giới hạn depth lên 15.
  2. *Gated Text-run Collisions:* Chỉ chạy đo lường `Range.getClientRects()` khi 2 container đã được xác định có bounding box giao nhau từ 15%–60% và **đã trừ đi phần diện tích bị clip bởi line-clamp**.
  3. *Scroll-swept CTA Occlusion:* Cuộn từng trang màn hình để kiểm tra `elementFromPoint` cho CTA, nhưng bỏ qua các va chạm tạo bởi chính Header/Footer cố định của site.

---

### Lát cắt Đầu tiên Nhỏ nhất (Smallest First Slice)

Tập trung xử lý gói **"Precision Shield & Wire Hygiene"** để lấy lại niềm tin vào công cụ trước khi mở rộng thuật toán phức tạp:

1. **Khắc phục False Positive trên Production (Precision):**
   - Bổ sung bộ lọc miễn trừ cho Line-clamp & Ellipsis tại `layout-integrity-engine.ts:253`.
   - Bổ sung miễn trừ cho closed off-canvas drawer và swiper inactive slides tại `layout-integrity-engine.ts:203`.
2. **Sửa lỗi Dây nối & Đo lường (Hygiene):**
   - Sửa key mapping trong `theme-qa-workflow.ts:894` để đọc đúng format `bp.id` từ `native-tab-host.ts`.
   - Sửa `PerformanceObserver` CLS bằng cách đo bất đồng bộ sau giai đoạn settle hoặc đọc qua Performance Timeline.
3. **Mở rộng Giới hạn Quét có Kiểm soát (Bounded Recall):**
   - Nâng node cap từ 2.000 lên 5.000 node kèm cờ cảnh báo `truncated: boolean`.
   - Nâng giới hạn depth từ 6 lên 12 cho kiểm tra Overlap nhưng áp dụng lọc thô theo tọa độ Y để giữ thời gian thực thi dưới 1.0 giây.

### Tiêu chí Nghiệm thu (Acceptance Evidence):
* **Corpus Synthetic:** Đạt 15/15 hard FAIL trên các defect giả lập và **0 FAIL trên 2 controls** (Fixture 12 line-clamp và Fixture 16 horizontal slider đạt PASS tuyệt đối).
* **Corpus Production:** Cả 4 website Haravan (`phukienmaymoc.com`, `gixjewel.com`, `hapas.vn`, `unitedvision.com.vn`) phải **đạt PASS 100% với 0 Critical False Positives**.
* **Ngân sách Báo động giả (FP Budget):**
  - `critical findings` (gây rớt verdict): **0% FP** trên website thương mại điện tử chuẩn.
  - `visualAmbiguities` (warnings): Tối đa không quá 3 warnings trên mỗi 1.000 DOM nodes.
* **Hiệu năng:** Thời gian thực thi script kiểm tra trong tab Chromium không vượt quá **1.200ms** trên trang có 4.500 nodes.

---

## 4. Rủi ro Trọng yếu Cần Kiểm soát Trước khi Chuyển sang `ak:plan`

1. **Rủi ro Ghost Rect của Line-clamp trong Range API:**  
   Nếu chuyển sang Text-run geometry, việc `Range.getClientRects()` vẫn trả về rects của dòng chữ bị line-clamp ẩn sẽ gây ra FP tràn ngập trên mọi danh sách sản phẩm. Thuật toán bắt buộc phải thực hiện phép cắt giao (`clipBox intersection`) giữa text-rect và container có line-clamp.
2. **Rủi ro Treo Event Loop khi bỏ Depth > 6 trên DOM lớn:**  
   Nếu bỏ depth limit mà không có cấu trúc phân vùng không gian (Spatial Grid / Y-Buckets), phép tính so sánh trên 4.000 node sẽ tốn hàng triệu lượt tính toán hình học, gây đóng băng renderer của Electron, kích hoạt timeout và làm sập tiến trình QA.
3. **Rủi ro Báo động giả khi Cuộn trang có Fixed/Sticky Layer:**  
   Mọi thuật toán cuộn trang để quét occlusion sẽ biến Header dính, nút Zalo, thanh Add-to-Cart mobile thành "vật che khuất lỗi" cho toàn bộ văn bản cuộn bên dưới nếu không có cơ chế lọc bỏ layer cố định hợp lệ.
4. **Giữ vững Tôn chỉ Local-first & Deterministic:**  
   Không đưa Vision API từ xa vào luồng tính verdict tự động. Mọi quyết định PASS/FAIL phải dựa trên bằng chứng hình học tất định, có thể tái lập 100% trong môi trường kiểm thử offline.

---

**Status: DONE**  
**Summary:** Hoàn thành cập nhật tư vấn chiến lược dựa trên bằng chứng Probe 4 (4 production sites); xác lập nguyên tắc Precision quan trọng ngang Recall; định hình kiến trúc Hybrid 2 giai đoạn (Precision Shield trước, Bounded Geometry sau) và thiết lập tiêu chí nghiệm thu chặt chẽ cho ak:plan.
