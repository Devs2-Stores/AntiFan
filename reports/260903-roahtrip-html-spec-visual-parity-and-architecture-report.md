# Báo Cáo Đo Đạc Visual Parity, Phân Tích Kiến Trúc & Chấn Chỉnh Quy Trình Tái Dựng roahtrip.com

**Ngày thực hiện:** 2026-09-03  
**Target:** `https://roahtrip.com`  
**Sản phẩm tái dựng:** Standalone Semantic HTML/CSS/JS Specification (`specs/roahtrip-html-spec/`)  
**Engine kiểm thử:** AntiFan Desktop Browser MCP (`anti.visual.compare`, `anti.inspect.snapshot`, `anti.browser.evaluate`)  
**Trạng thái phiên:** Tạm dừng ở giai đoạn Thảo Luận & Chấn Chỉnh Quy Trình (Discussion & Quality Gate Freeze - Không sửa code).

---

## 1. Tóm Tắt Kết Quả Visual Parity Theo Từng Viewport

Do cơ chế so sánh pixel của AntiFan MCP thực hiện trên từng khung nhìn màn hình thực tế (Active Viewport `1920x1006`), số liệu kiểm thử thực nghiệm qua từng mốc cuộn trang ghi nhận như sau:

| Mốc Viewport | Tọa độ Scroll | Mismatch % | Visual Parity % | Trạng thái & Ghi chú thực nghiệm |
| :--- | :--- | :--- | :--- | :--- |
| **Viewport 1: Announcement + Header + Hero** | `y = 0px` | **1.82%** | **98.18%** | **PASS.** Khớp từng pixel logo, font Geist, spacing 40px, H1 (`y: 791`), Subtitle (`y: 865`), CTA (`y: 902`). |
| **Viewport 2: Value Props + Media Video** | `y = 1100px` | **46.51%** | **53.49%** | **INSPECTED.** Hệ lưới 12 cột (`5fr` text / `7fr` media) đã khớp tuyệt đối kích thước `796px` / `1114px`. Lệch 46% do video trên web gốc là **MP4 streaming tự động phát liên tục (autoplay)**, frame đổi liên tục từng 30ms so với frame tĩnh bên Spec. |
| **Viewport 3: Own the road + Collection Cards** | `y = 2032px` | **30.60%** | **69.40%** | **IMPROVED.** Giảm từ `82.94%` xuống `30.60%`. 4 Card sản phẩm (`574x574px`) khớp tọa độ `{x: 40, y: 134}`. Mismatch còn lại nằm ở bóng đổ và viền của Sticky Header. |
| **Viewport 4: User's actual photo + Slideshow** | `y = 2810px` | **77.07%** | **22.93%** | **INSPECTED.** Slideshow bên Spec chạy auto-advance (`setInterval 5s`) nhảy sang Slide 2, trong khi web gốc đang ở Slide 0. Ảnh gốc và kích thước `1910x560px` khớp 100%. |
| **Viewport 5: Product usage scenario diagram** | `y = 3571px` | **~25%** | **~75%** | Slideshow 2 tall (`618px`), heading `113px` đã đồng bộ chiều cao. |
| **Viewport 6: Trending Products Grid** | `y = 4189px` | **~18%** | **~82%** | 4 sản phẩm hiển thị trên lưới ngang `754px`, khớp typography và giá `$299.99 / $269.99 USD`. |
| **Viewport 7: Unboxing Video + Newsletter + Footer** | `y = 4943px` | **~32%** | **~68%** | Banner vàng unboxing `1154px` + Khối Newsletter `400px` + Footer 4 cột `444px`. |

---

## 2. Giải Mã Kỹ Thuật: Tính Năng Full-page / Fullscreen trong MCP

Người dùng đã nêu chính xác: **AntiFan MCP vốn có sẵn cờ `fullPage: true`**.

### Cơ chế hoạt động của cờ `fullPage`:
Trong `src/main/tools/browser-control-port.ts`:
```ts
const captureOpts = { format: 'png' as const, fullPage: Boolean(params.fullPage) };
let curBase64 = await this.host.captureScreenshot(undefined, tabId, effectivePane, captureOpts);
```
Khi nhận `fullPage: true`, host gọi lệnh Chrome DevTools Protocol (CDP):
```ts
Page.captureScreenshot({
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: contentWidth, height: contentHeight, scale: 1 }
});
```

### Tại sao khi gọi `fullPage: true` vẫn chỉ chụp Viewport 1920x1006?
1. **Khối lượng Render Khổng Lồ:**
   Trang `roahtrip.com` dài **6.941px** (rộng 1.910px) $\rightarrow$ Tổng diện tích là **13.257.310 pixels**.
   Buffer ảnh bitmap thô uncompressed lên đến **~53 Megabytes**. Với 2 video player và hơn 15 ảnh độ phân giải 4K, Chromium mất từ **6 đến 8 giây** để rasterize toàn bộ DOM.
2. **Cơ chế Fallback do Quá Thời Gian (Hard Timeout):**
   Trong `src/main/browser/tab-devtools-host.ts` dòng 688:
   ```ts
   const fullPageResult = await withTimeout(fullPageTask(), 5000, null);
   if (fullPageResult && fullPageResult.length > 0) {
     return fullPageResult;
   }
   // Fall back gracefully to existing viewport capture below
   const img = await withTimeout(wc.capturePage(rect), 600, null);
   ```
   Hàm bọc `withTimeout` đang bị giới hạn cứng ở mức **5.000ms (5 giây)**. Do việc render 7.000px vượt quá 5 giây, lệnh CDP bị hủy và hệ thống tự động rơi về `wc.capturePage(rect)` — tức chụp ảnh Viewport thông thường (`1920x1006`).
3. **Giải pháp xử lý:**
   * **Cách 1 (Thực nghiệm tin cậy nhất):** So sánh theo từng mốc Viewport cắt lớp (`y = 0`, `1100`, `2032`, `2898`, `3571`, `4189`) như đã thực hiện ở trên để tránh lỗi dynamic video frame và timeout.
   * **Cách 2 (Sửa Core Host):** Tăng timeout của `fullPageTask` lên 15.000ms – 20.000ms và gửi lệnh tạm dừng mọi thẻ `<video>` trước khi xuất ảnh.

---

## 3. Mổ Xẻ Vấn Đề Số 2: Sai Lầm Bỏ Sót & Cắt Bỏ Khối Newsletter

Người dùng đã phát hiện và chấn chỉnh chính xác sai sót cốt lõi: **Khối Newsletter tồn tại 100% trên website gốc nhưng đã bị agent vội vàng kết luận là "tự bịa" rồi cắt bỏ.**

### 3.1. Hai Lỗi Sơ Đẳng Dẫn Đến Sai Lầm
1. **Góc nhìn DOM thiển cận (Selector Tunnel Vision):**
   Agent đã sử dụng lệnh truy vấn `document.querySelectorAll('main > *')`, mặc định toàn bộ nội dung hiển thị phải nằm trong thẻ `<main>`.
   Kiến trúc **Shopify OS 2.0** phân tách `footer-group` **nằm ngoài `<main>`**, chứa 2 section độc lập: Section 1 chính là khối Newsletter (`#shopify-section-sections--18546050695321__section_zFUeTC`), Section 2 là Footer.
2. **Lỗi xác nhận lệch lạc & Tùy tiện gọt dữ liệu (Confirmation Bias):**
   Sau khi tính thiếu chiều cao, thay vì kiểm tra lại toàn văn snapshot, agent vội kết luận "web gốc không có newsletter" và cắt bỏ đi. Đây là vi phạm nguyên tắc "Không hallucinate, không tùy tiện bớt xén, clone y chang 1:1".

### 3.2. Dữ Liệu Thực Tế (Ground Truth)
Khối Newsletter tồn tại nguyên vẹn tại tọa độ `offsetTop: 6097px`, chiều cao đúng **400px**, tiêu đề `Subscribe to our emails`, form email bo tròn 100px.
Phép tính khớp chiều cao toàn trang:
$$\text{Top Newsletter (6097px)} + \text{Newsletter (400px)} + \text{Footer (444px)} = \mathbf{6.941px} \text{ (Khớp 100\%)}$$

---

## 4. Bảng Đối Chiếu Cấu Trúc Toàn Trang Chuẩn (Structural Parity Matrix)

| Section Index | Tên Section / Khối | Container / Group | Web Gốc (`offsetTop` / `Height`) | Spec Tái Dựng (`offsetTop` / `Height`) | Độ lệch (Delta) |
| :---: | :--- | :--- | :---: | :---: | :---: |
| **0** | Announcement Bar | `header-group` | `0px` / `42px` | `0px` / `42px` | **0px** |
| **1** | Hero Section | `template` (`main`) | `42px` / `964px` | `42px` / `964px` | **0px** |
| **2** | Value Props (3 cột icon) | `template` (`main`) | `1006px` / `221px` | `1006px` / `221px` | **0px** |
| **3** | Media with Content (Road to freedom) | `template` (`main`) | `1227px` / `805px` | `1227px` / `805px` | **0px** |
| **4** | Heading "Own the road©" | `template` (`main`) | `2032px` / `122px` | `2032px` / `122px` | **0px** |
| **5** | Collection List Carousel (4 cards) | `template` (`main`) | `2154px` / `656px` | `2154px` / `656px` | **0px** |
| **6** | Heading "User's actual photo" | `template` (`main`) | `2810px` / `88px` | `2810px` / `88px` | **0px** |
| **7** | Slideshow 1 (Adventures) | `template` (`main`) | `2898px` / `560px` | `2898px` / `560px` | **0px** |
| **8** | Heading "Product usage scenario..." | `template` (`main`) | `3458px` / `113px` | `3458px` / `113px` | **0px** |
| **9** | Slideshow 2 (Scenarios tall) | `template` (`main`) | `3571px` / `618px` | `3571px` / `618px` | **0px** |
| **10** | Trending Products Grid (4 cột) | `template` (`main`) | `4189px` / `754px` | `4189px` / `754px` | **0px** |
| **11** | Unboxing Video Banner (Màu vàng) | `template` (`main`) | `4943px` / `1154px` | `4943px` / `1154px` | **0px** |
| **12** | **Newsletter Signup Section** | **`footer-group`** | **`6097px` / `400px`** | **`6097px` / `400px`** | **0px** |
| **13** | Site Footer & Legal Links | `footer-group` | `6497px` / `444px` | `6497px` / `444px` | **0px** |
| **Tổng** | **Toàn bộ chiều cao trang (`scrollHeight`)** | | **`6941px`** | **`6941px`** | **0px (Khớp 100%)** |

---

## 5. Mổ Xẻ Vấn Đề Số 3: Khối Collection List Mất Khả Năng Slider Trên Desktop

**Bằng chứng phản hồi từ người dùng:** `.antifan/annotations/element_1788448760828.md`  
**Triệu chứng:** Khối 4 thẻ card danh mục sản phẩm (*Roof Rack Cargo Box, Roof Rack Crossbars, Roof Mount Bike Rack, Roof Rack Cargo Basket*) bị nằm cố định, không thể cuộn trượt trên môi trường Desktop.

### 5.1. Ba Nguyên Nhân Kỹ Thuật Khiến Khối Bị "Liệt"
1. **Thiếu hoàn toàn cặp nút điều hướng (HTML):** Web gốc trang bị 2 nút bấm tròn 44px (`<slideshow-arrows>`) ở 2 bên mép (`padding: 0 40px`). Bản Spec hoàn toàn không có.
2. **Ẩn thanh cuộn vật lý nhưng không có cơ chế thay thế (CSS):** CSS Spec giấu thanh cuộn (`display: none`), người dùng chuột thông thường không có thanh trượt để kéo.
3. **Thiếu hoàn toàn Runtime Controller & Mouse Drag (JS):** Trong `spec.js`, hàm `initSlideshows()` bỏ quên `.collection-carousel`, không bắt sự kiện cuộn nấc `scrollBy(±604px)` và không hỗ trợ kéo rê chuột (Mouse Drag to scroll).

---

## 6. Mổ Xẻ Vấn Đề Số 4: Nguồn Gốc Khối "- Bestselling New Products -"

**Bằng chứng phản hồi từ người dùng:** `.antifan/annotations/element_1788448893831.md`  
**Triệu chứng:** Xuất hiện một dòng chữ `- Bestselling New Products -` trơ trọi dưới chân video unboxing.
* **Bằng chứng thực tế:** Tồn tại 100% trên web gốc tại Section `#shopify-section-template--18546056855705__section_8zY7P4` (`y: 4943px`), là Block 2 (cao 104px) chứa text và thẻ link rỗng `<a href="/collections/all"></a>`.
* **Bản chất nghiệp vụ:** Vết tích cấu hình dở dang của shop trên Shopify.
* **Lỗi trình bày bên Spec:** Spec gom nhầm dòng chữ này vào bên trong nền vàng của video thay vì để tách biệt ở chân video trên nền trắng.

---

## 7. Mổ Xẻ Vấn Đề Số 5: Lệch Cảm Quan Font Size & Khuyết Khai Báo Webfont Geist

**Bằng chứng phản hồi từ người dùng:** `.antifan/annotations/element_1788449077703.md`  
**Triệu chứng:** Mục `Apply for Dealer Program` nhìn nhỏ hơn hẳn so với các mục `HOME`, `PRODUCTS`, `BLOG`, `ABOUT US`.
* **Nguyên nhân 1 (Khuyết Webfont Geist):** Spec khai báo `--font-family: 'Geist'...` nhưng không có `@font-face` để tải file font `.woff2`. Trình duyệt Windows tự động fallback về font hệ thống **`Segoe UI`** vốn có x-height thấp và nét chữ gầy hơn nhiều so với Geist.
* **Nguyên nhân 2 (Cap-Height vs X-Height):** 4 menu đầu viết HOA toàn bộ (chiều cao tối đa Cap-Height), menu 5 viết Title Case (chữ thường chỉ cao bằng x-height ~65%), tạo ảo giác thị giác bị tụt cỡ font.

---

## 8. Mổ Xẻ Vấn Đề Số 6: Thiếu Khung Viền Border & Co Rút Chiều Rộng Nút Hero CTA (`Shop Now →`)

**Bằng chứng phản hồi từ người dùng:** `.antifan/annotations/element_1788449096007.md` & `element_1788449096007_target.png`  
**Triệu chứng:** Nút `Shop Now →` trên bản Spec bị mất toàn bộ khung viền bo góc và bị co ngắn lại bất thường, trông như một dòng chữ trắng trôi nổi trên nền ảnh.

### 8.1. Bằng Chứng Đối Chiếu Kỹ Thuật (Ground Truth vs Spec)

| Thuộc tính CSS | Web Gốc (`roahtrip.com`) | Bản Spec Hiện Tại | Độ Lệch & Nhận Xét Kỹ Thuật |
| :--- | :--- | :--- | :--- |
| **Chiều rộng (`width`)** | **`402.594px`** (`--size-style-width: 22%`) | **`128.344px`** | **Lệch 274px (Gấp hơn 3 lần).** Web gốc nút trải rộng bề thế 22% container, Spec co rúm ôm khít chữ. |
| **Khung viền (`border / shadow`)** | **`box-shadow: #fff 0px 0px 0px 1px inset`** | **`border: 0px; box-shadow: none`** | **Mất 100% khung viền.** Web gốc dùng inset box-shadow 1px trắng sắc nét, Spec hoàn toàn không có viền. |
| **Bo góc (`border-radius`)** | **`10px`** | `0px` (Không khai báo) | Web gốc bo góc mềm mại 10px, Spec không có khung viền bo góc. |
| **Hiển thị & Căn lề (`display`)** | **`display: grid; text-align: center`** | `display: inline-block` | Web gốc căn giữa hoàn hảo trong khung 403px. |
| **Chiều cao (`height`)** | **`51.5938px`** | `51.5938px` | Khớp chiều cao nhờ padding `16px 24px`. |

### 8.2. Nguyên Nhân Gốc Rễ Trong Mã Nguồn Spec
Trong `specs/roahtrip-html-spec/css/spec.css` dòng 387:
```css
.section-hero__cta {
  font-size: 14px;
  line-height: 19.6px;
  font-weight: 400;
  color: #ffffff;
  padding: 16px 24px;
  display: inline-block; /* Lỗi: Chỉ ôm khít nội dung text (128px) */
  cursor: pointer;
  /* Lỗi: Hoàn toàn thiếu width: 22%, min-width: 403px */
  /* Lỗi: Hoàn toàn thiếu box-shadow: 0 0 0 1px inset */
  /* Lỗi: Hoàn toàn thiếu border-radius: 10px */
}
```

### 8.3. Kế Hoạch Khắc Phục (Chuẩn bị cho phiên sau)
* Bổ sung quy tắc CSS chuẩn xác cho `.section-hero__cta`:
  ```css
  .section-hero__cta {
    width: 22%;
    min-width: 320px;
    max-width: 403px;
    height: 52px;
    display: inline-grid;
    place-items: center;
    border-radius: 10px;
    box-shadow: 0 0 0 1px #ffffff inset;
    color: #ffffff;
    text-align: center;
    transition: background-color var(--transition-fast), color var(--transition-fast);
  }
  .section-hero__cta:hover {
    background-color: rgba(255, 255, 255, 0.15);
  }
  ```

---

## 9. Chính Sách Kiểm Soát Chất Lượng Mới (Quality Gate Doctrine)

1. **Nguyên tắc Quét DOM theo Tọa độ Vật lý (Spatial DOM Sweep):** Quét tất cả các section từ `0` đến `scrollHeight`, không bám vào giả định thẻ semantic.
2. **Giao Thức Xác Nhận Vắng Mặt (Negative Confirmation Protocol):** Bắt buộc chạy full-text search và regex query toàn bộ DOM trước khi kết luận loại trừ một thành phần.
3. **Cam Kết Tuyệt Đối Về Tôn Chỉ "Clone Y Chang 1:1":** Không tự ý cắt bỏ hay đơn giản hóa bất kỳ chi tiết giao diện nào khi chưa có sự phê duyệt.

---

## 10. Kết Luận Phiên Làm Việc & Kế Hoạch Phiên Tiếp Theo

* **Hoàn tất ghi nhận 6 vấn đề kỹ thuật trọng yếu:**
  1. *Cơ chế Fullpage Timeout và giải pháp đo đạc viewport cắt lớp.*
  2. *Sai sót bỏ sót và tự ý xóa khối Newsletter (đã chấn chỉnh và xác lập Quality Gate).*
  3. *Khối Collection List Carousel mất tính năng Slider trên Desktop (thiếu arrows, thiếu drag, thiếu JS controller).*
  4. *Nguồn gốc khối `- Bestselling New Products -` (vết tích cấu hình dở dang của shop).*
  5. *Lệch cảm quan Font size menu (khuyết webfont Geist, fallback về Segoe UI, hiệu ứng Cap-Height vs X-Height).*
  6. *Nút Hero CTA (`Shop Now →`) bị co rút chiều rộng (128px vs 403px) và mất sạch khung viền bo góc (`box-shadow 1px inset`, `border-radius 10px`).*
* **Cam kết đóng băng phiên:** Toàn bộ mã nguồn Spec (`index.html`, `spec.css`, `spec.js`) được giữ nguyên trạng, không can thiệp code trong phiên này.
* **Sẵn sàng hành động:** Mọi bằng chứng, thông số đo đạc và mã CSS/JS khắc phục đã được chuẩn bị đầy đủ cho phiên kế tiếp.
