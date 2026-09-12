# Báo cáo Chất lượng Tĩnh: Theme 1001514194 (15092026/)

- Thời điểm khảo sát: 2026-09-13
- Đối tượng: `15092026/` (theme `1001514194`, store `phukienmaymoc.com`)
- Chế độ: READ-ONLY tĩnh (Liquid, HTML, JS, CSS)
- Nguồn: scout `StaticQuality` (read-only). Controller đã kiểm lại một phần — xem mục "Controller kiểm chứng" ở cuối.

---

## 1. Phân tích Hình ảnh
- **Tổng thẻ `<img`**: 89 thẻ trên 49 tệp (34 trong `templates/`, 55 trong `snippets/`).
- **Thiếu thuộc tính `alt`**: 1 thẻ (1.1%).
  - `templates/search.smart.liquid:11`: `<img title="{{ product.title }}" src="...">` không có thuộc tính `alt`.
- **Thiếu `width` và/hoặc `height` (nguy cơ CLS)**: 21 thẻ (23.6%).
  - `templates/cart.item.liquid:6`, `templates/cart.liquid:27`: ảnh sản phẩm trong giỏ hàng không có width/height.
  - `templates/page.contact.liquid:12`: banner giới thiệu không có width/height.
  - `templates/page.gallery.liquid:19`, `templates/page.instruct.liquid:311`: logo/gallery không có width/height.
  - `templates/product.article.liquid:4`, `templates/search.liquid:25, 51`: ảnh rỗng/sản phẩm không có width/height.
  - `snippets/article-item.liquid:18, 20`, `snippets/blog-item.liquid:16, 18`: fallback ảnh blog không có width/height.
  - `snippets/footer_s1.liquid:71`, `snippets/footer_s2.liquid:99`, `snippets/footer_s3.liquid:37`: logo Bộ Công Thương thiếu width/height.
  - `snippets/home-store.liquid:14`, `snippets/product-snippet.liquid:51`, `snippets/shop-coupon.liquid:15`, `snippets/shop-modal-account.liquid:10`, `snippets/snowflakes-effect.liquid:59`.
- **Ảnh có `loading="lazy"`**: 57 thẻ (20 trong templates, 37 trong snippets).
- **Ảnh đầu trang (hero/banner)**:
  - `templates/index.liquid:22`: Hero slider có `{% if forloop.first %}loading="eager" fetchpriority="high"{% else %}loading="lazy"{% endif %}` (chuẩn).
  - `templates/article.liquid:53, 58`: Banner bài viết có `loading="eager" decoding="sync" fetchpriority="high"` (chuẩn).
  - `snippets/collection-snippet.liquid:16`: Banner danh mục có `loading="eager" decoding="sync" fetchpriority="high"` (chuẩn).
  - `templates/page.contact.liquid:12`: Lỗi chính tả cú pháp: `fetchpriotrity="high"` (sai thuộc tính HTML).
  - `snippets/header_1.liquid:7`..`header_5.liquid:7`: Logo header không khai báo `loading` (mặc định eager) nhưng thiếu `fetchpriority="high"`.
- **Anti-pattern phát hiện**: `snippets/footer-scripts.liquid:50-52` chứa đoạn script xoá bỏ `loading="lazy"` của mọi thẻ `<img>` sau khi trang tải (`$('img[loading="lazy"]').each(function(){ $(this).removeAttr('loading'); })`).

---

## 2. Landmark & Cấu trúc Heading
- **Landmark ở `layout/theme.liquid`**:
  - `<main class="main-layout">` có mặt tại dòng 35-37.
  - `<header>` và `<footer>` không nằm trực tiếp tại `layout/theme.liquid`, mà được nạp qua snippet:
    - `layout/theme.liquid:34`: `{%- include 'header' -%}` → `snippets/header_1.liquid`..`header_5.liquid` (đều có thẻ `<header class="...">`).
    - `layout/theme.liquid:38`: `{%- include 'footer' -%}` → `snippets/footer_s1.liquid`..`footer_s3.liquid` (đều có thẻ `<footer class="...">`).
  - Không có thuộc tính `role="banner"`, `role="main"`, `role="contentinfo"`.
- **Số lượng thẻ `<h1>` trên các template chính**:
  - `index` (`templates/index.liquid:1`): **1** thẻ `<h1>` ẩn (`<h1 hidden>{{ settings.hera_home_hidden_title | escape }}</h1>`).
  - `product`: **2** thẻ `<h1>` (LỖI CẤU TRÚC: `snippets/product-snippet.liquid:16` có `<div hidden class="section-title-all"><h1>{{ product.title }}</h1></div>` VÀ dòng 85 có `<h1 class="main-product-title ...">{{ product.title }}</h1>`).
  - `collection` (`snippets/collection-snippet.liquid:33`): **1** thẻ `<h1>` (dòng 5 đã bị comment HTML `<!--<h1>...</h1>-->`).
  - `blog` (`templates/blog.liquid:5`): **1** thẻ `<h1>` ẩn.
  - `article` (`templates/article.liquid:61`): **1** thẻ `<h1>` (dòng 40 đã bị comment `<!--<h1>...</h1>-->`).
  - `page` (`templates/page.liquid:5`): **1** thẻ `<h1>` ẩn.

---

## 3. Render-blocking & Phân tích Kích thước Script/CSS
- **Thẻ `<script>` render-blocking**:
  - Trực tiếp trong `layout/theme.liquid`: 1 thẻ inline (`layout/theme.liquid:20`: `<script>var f1genzPS = true;</script>`).
  - Trong `<head>` qua snippet:
    - `snippets/optimize_head.liquid:1`: 1 thẻ inline định nghĩa `buildForScript`.
    - `snippets/optimize_head.liquid:8`: 1 thẻ inline nạp FontAwesome/Google Fonts qua JS DOM.
    - `snippets/plugin_jquery.liquid:1`: 1 thẻ inline chứa toàn bộ mã nguồn minified của jQuery v3.6.1 nhúng cứng trong `<head>` không defer/async, render-blocking nghiêm trọng. **Controller đo lại: file này 89.684 byte** (scout ghi 69,1 KB).
  - Các script ngoài tại `snippets/master-include.liquid:178-194` đều có `defer` và `fetchpriority="low"`.
  - Trước `</body>`: `snippets/footer-scripts.liquid:1, 9` có 2 thẻ inline script.
- **Top 10 assets CSS/JS lớn nhất từ `assets/`** (số của scout): `plugin.js.liquid` 188.2 KB, `plugin.css.liquid` 169.5 KB, `main.scss.liquid` 132.1 KB, `swiper-gl.js.liquid` 100.8 KB, `main.js.liquid` 50.5 KB, `product.scss.liquid` 30.0 KB, `index.scss.liquid` 24.5 KB, `article.scss.liquid` 24.3 KB, `product.js.liquid` 21.1 KB, `collection.scss.liquid` 17.6 KB.

---

## 4. Biểu mẫu & Khả năng Tiếp cận (A11y Form Controls)
- **Tổng số vị trí `<form>` / `{% form %}`**: 23 vị trí (13 trong `templates/`, 10 trong `snippets/`).
- **Hành vi thêm giỏ hàng**: `snippets/product-snippet.liquid:166` không dùng thẻ `<form>` chuẩn; kích hoạt hoàn toàn qua AJAX click (`data-type="main-product-add"`).
- **Tổng số input/textarea thiếu `<label for="...">` khớp `id`**: **29 trường**.
- **Ví dụ tiêu biểu**:
  - `templates/404.liquid:19-21`: 3 input `name`, `email`, `phone` không có `id` và không có `<label>`.
  - `templates/article.liquid:30-31`: input chia sẻ có `<label>` nhưng thiếu thuộc tính `for`.
  - `templates/article.liquid:97-99`: Form comment bài viết có 2 input + 1 textarea không có `id` và không có `<label>`.
  - `templates/page.contact.liquid:35-38`: Form liên hệ có 3 input + 1 textarea có `id` (`contactFormName`, v.v.) nhưng **0 thẻ `<label>`**.
  - `snippets/header_1.liquid:16`..`header_5.liquid:18`: Ô tìm kiếm `<input name="q">` không có `id` và `<label>`.
  - `snippets/footer_s2.liquid:12`: Ô email newsletter `mc-form4` không có `id` và `<label for>` (chỉ có `aria-label`).
  - `snippets/home-newletter.liquid:17`: Form đăng ký nhận tin không có `id` và `<label>`.
  - `snippets/product-snippet.liquid:296-298`: Form liên hệ tư vấn sản phẩm có 3 input không có `id` và `<label>`.
  - `snippets/shop-modal-phone.liquid:12`: Input số điện thoại có `id` nhưng không có `<label>`.

---

## 5. Rò rỉ Tài nguyên Ngoại miền (Third-party Leaks)
- **Số lượng miền ngoại lệ không thuộc danh mục cho phép**: 15 miền bên thứ ba.
- **Danh sách 20 URL/tài nguyên rò rỉ tiêu biểu**:
  1. `templates/page.instruct.liquid:223, 236, 532, 544`: `https://themes.sapo.vn/Themes/Portal/Default/Styles/images/detail/new/...` (rò rỉ CDN của Sapo trong theme Haravan).
  2. `templates/password.liquid:217`: `//www.sapo.vn` (liên kết "Cung cấp bởi Sapo").
  3. `assets/product.scss.liquid:639, 759, 764, 769`: class CSS của app Sapo (`.sapo-product-reviews-badge`, `.sapo-buyxgety-module-detail-v2`, `#sapo-product-reviews`).
  4. `snippets/product-item-compare.liquid:17`: div chứa class `sapo-product-reviews-badge`.
  5. `assets/main.js.liquid:345`: `https://opensheet.elk.sh/1rwM7cgI6248O8gCGsqHjTYa_Yq6f-8A3DlbPn5O1iHI/1` (proxy Google Sheet bên thứ ba, hardcode).
  6. `snippets/home-store.liquid:1`: `https://opensheet.elk.sh/...`.
  7. `templates/article.liquid:120` và `snippets/shop-account-sidebar.liquid:1`: `https://ui-avatars.com/api/?name=...`.
  8. `snippets/optimize_head.liquid:16`: FontAwesome Pro 5.12.1.
  9. `snippets/master-include.liquid:72, 73, 131, 179, 181, 190, 191`: jsDelivr/cdnjs (bootstrap 4.0.0, swiper 11, plyr 3.7.8, fancybox 4.0, elevatezoom 2.2.3).
  10. `templates/page.gallery.liquid:12, 13`: pagination.js.org / cdnjs paginationjs 2.0.8.
  11. `templates/page.instruct.liquid:331`: `https://code.jquery.com/jquery-3.7.0.min.js`.
  12. `snippets/footer-scripts.liquid:5`: `https://www.tiktok.com/embed.js`.

---

## 6. Nguồn sự thật Core Web Vitals (CWV)
- **Rà soát `reports/`, `plans/reports/`**: **CHƯA CÓ SỐ ĐO** (LCP, CLS, INP, FCP, TTFB, TBT) cho theme `1001514194`.
- Nguyên tắc biên nhận: không tự cấp điểm; mọi chỉ số CWV phải đo trực tiếp qua Lighthouse CLI hoặc CDP probe khi có phiên duyệt thật. Chưa đo được ⇒ `INCONCLUSIVE`.

---

## Controller kiểm chứng (đọc lại trực tiếp trên đĩa)

| Khẳng định của scout | Kết quả |
|---|---|
| `layout/theme.liquid:34/35-37/38` include header, `<main class="main-layout">`, include footer; không có `<header>`/`<footer>` ở layout | **ĐÚNG** (đọc `layout/theme.liquid:33-40`) |
| `snippets/footer-scripts.liquid` xoá `loading="lazy"` toàn trang | **ĐÚNG** (đọc `snippets/footer-scripts.liquid:46-48`) |
| `snippets/product-snippet.liquid` có 2 `<h1>` (dòng 16, 85) | **ĐÚNG** |
| `templates/page.contact.liquid:12` sai `fetchpriotrity` | **ĐÚNG** |
| Rò rỉ `themes.sapo.vn`×4, `sapo.vn`×1, `opensheet.elk.sh`×2, `sapo-product-reviews`×4 | **ĐÚNG** (grep đếm lại) |
| Script ngoài trong `master-include.liquid` đều `defer` + `fetchpriority="low"` | **ĐÚNG** (đọc `:176-196`) |
| `templates/404.liquid:19-21` input không `id`, không `<label>` | **ĐÚNG** (chỉ có `placeholder`) |
| `plugin_jquery.liquid` "69,1 KB" | **SAI số** — đo lại **89.684 byte** |
| 29 trường thiếu `<label for>` khớp `id` | Chưa dựng lại đúng phép đếm này; đo thô: **53 thẻ `<input>` không có thuộc tính `id`** (nên không thể có `<label for>` trỏ tới) |
| Top 10 kích thước asset | Chưa kiểm lại (lỗi lệnh `stat` trên Windows) — coi là số của scout |
