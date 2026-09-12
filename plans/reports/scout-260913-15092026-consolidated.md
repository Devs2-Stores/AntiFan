# Hiện trạng đích mới `1001514194` — tổng hợp đo được (2026-09-13)

Nguồn: 3 scout read-only + tự kiểm lại ở controller. Số nào do scout đo thì ghi `[scout]`; số còn lại tôi chạy lại và xác nhận trực tiếp.

## 1. Đích & an toàn

| Theme | Vai trò | Tên | Ghi chú |
|---|---|---|---|
| `1001514194` | `unpublished` | Phụ kiện máy móc - 15/09/2026 | **ĐÍCH MỚI**, `previewable: true`, `processing: false` |
| `1001512581` | `unpublished` | Bản sao chép của clothing | đích cũ |
| `1001510509` | `main` | Phụ Kiện Máy Móc New Version | **bảo vệ** |

Đo bằng `GET https://apis.haravan.com/web/themes.json` và `/web/themes/1001514194.json` (Bearer, token không in ra log).

## 2. Bản pull `15092026/` — khớp khoá 100%, đối chiếu theo `size` bản gốc (không theo byte CDN)

- 241 tệp / 241 khoá remote: khớp 241, thiếu 0, thừa 0. `.haravan-cli_remote.json` khớp 241/241.
- Controller tự kiểm lại: 241 khoá manifest ↔ 241 tệp local, 0 lệch; sha256 của `templates/index.liquid`, `layout/theme.liquid`, `snippets/footer.liquid` khớp manifest 3/3.
- **Đối chiếu byte với remote (đo lại 2026-09-13 sau khi làm mới toàn bộ)**: 143 tệp văn bản — độ dài byte bằng `size` API.
- **Byte của ảnh nhị phân không phải tiêu chí ổn định**: cùng một `public_url`, CDN trả kết quả khác nhau ở các thời điểm (`hera_index_hero_1_mobile.jpg`: 45.507 B rồi 55.681 B) và theo `Accept` (`Vary: accept, accept-encoding`; `hera_index_hero_2_mobile.jpg` với `Accept: image/webp` → 76.840 B webp, không gửi `Accept` → 98.904 B jpeg). `size` API là **kích thước bản gốc lưu trữ**; thứ CDN trả có thể là bản biến thể. Sau khi làm mới, bản local còn lệch `size` ở **2 tệp** (`hera_index_hero_1_mobile.jpg` 45.507/55.681, `shop_coupon_item_image_2.png` 1.653/2.140); các ảnh còn lại khớp bản gốc. Mọi ảnh có marker kết thúc hợp lệ (JPEG `ffd9` / PNG `IEND`) ⇒ **không tệp nào bị cắt**.
- **Drift remote giữa phiên**: `updated_at` của `hera_index_hero_2_mobile.jpg` `17:02:03Z → 17:35:29Z`, `shop_social_sidebar_item_image_1.png` → `17:35:42Z`, `shop_social_sidebar_item_image_5.png` → `17:35:47Z`. Script pull hiện so `updated_at` (ảnh) và độ dài byte (văn bản) nên tự tải lại đúng các khoá này; hai lần chạy liên tiếp sau đó: `fetched 0, refreshed 0, skipped 241`.
- Kết luận dùng được: **không lấy khớp byte với CDN làm tiêu chí kiểm chứng**, **không dùng `size` API làm tiêu chí đủ/thiếu cho ảnh**, **không khoá giả định theo `?v=`**.
- Rác CLI `15092026/.hrv_tmp_pull-<pid>-<ts>/assets/` (6 tệp: 4 bản gốc lưu trữ 55.681 / 120.262 / 2.140 / 1.542, 1 tệp 0 byte, 1 tệp trùng bản trong `assets/`) — **đã xoá 2026-09-13**.
- Phân bố: `templates/` 43, `snippets/` 65, `assets/` 129, `layout/` 1, `config/` 3.

## 3. Hình dạng nền tảng: sạch kiểu Haravan phẳng

- `sections/`: **không có**; `{% schema %}` 0; `{% render %}` 0; `{% section %}` 0; filter Shopify-only (`where`, `concat`, `at_most`, `at_least`, `image_url`, `media_tag`, `reject`) 0.
- Cấu hình: `config/settings_schema.json` = `[{}]` (rỗng), `config/settings.html` 138 KB / 711 control ⇒ chế độ legacy HTML là bề mặt thật; phân giải 287/288 setting id (523 lần đọc).

## 4. Hai lỗi lint (đã tự kiểm lại `file:line`)

1. `templates/cart.liquid:160` — `{%- include 'buyxgety-module-cart' -%}` nhưng **không có** snippet này trong theme (bản pull đầy đủ 100%, nên không phải thiếu file). Vết tích app Buy-X-Get-Y thời Sapo; Haravan render include thiếu thành rỗng.
2. `templates/index.liquid:5` — `<section class="hera-hero" aria-label="{{ settings.hera_home_hero_aria | escape }}">` nhưng `hera_home_hero_aria` **không được định nghĩa ở đâu** (không có trong `settings.html`, không có trong `settings_data.json`) ⇒ `aria-label` rỗng. Lỗi khả năng tiếp cận thật.

## 5. Chất lượng tĩnh (đo được, chưa có số CWV)

- jQuery 3.6.1 nhúng **cứng trong `<head>`**: `snippets/plugin_jquery.liquid` = **89.684 byte** (scout ghi 69,1 KB — số đúng là 89.684 B), include từ `snippets/master-include.liquid:176`, mà `master-include` được include ở `layout/theme.liquid:30` (trong `<head>`).
- `snippets/footer-scripts.liquid:46-48`: `$('img[loading="lazy"]').each(... removeAttr('loading'))` — **xoá lazy toàn trang** sau khi tải ⇒ vô hiệu hoá lazy loading.
- Trùng `<h1>`: `snippets/product-snippet.liquid:16` và `:85` ⇒ trang sản phẩm có 2 `<h1>`.
- Lỗi chính tả thuộc tính: `templates/page.contact.liquid:12` dùng `fetchpriotrity` (sai) thay `fetchpriority`.
- Thêm vào giỏ hàng chỉ qua JS AJAX: `assets/main.js.liquid:133` gọi `/cart/add.js`; không có `<form>` add-to-cart trong `templates/product.liquid`/`snippets/product-snippet.liquid` ⇒ không có đường dự phòng khi tắt JS.
- Rò rỉ bên thứ ba: `themes.sapo.vn` ×4, `sapo-product-reviews` ×4, `opensheet.elk.sh` ×2, `sapo.vn` ×1 (`templates/page.instruct.liquid`, `templates/password.liquid`, `assets/product.scss.liquid`, `assets/main.js.liquid`).
- `[scout]` 89 thẻ `<img>` trên 49 tệp: 21 thiếu `width`/`height` (CLS), 1 thiếu `alt` (`templates/search.smart.liquid:11`), 57 có `loading="lazy"`; hero `templates/index.liquid:22` và banner `templates/article.liquid:53,58`, `snippets/collection-snippet.liquid:16` dùng đúng `eager`/`fetchpriority="high"`.
- `[scout]` 29 input thiếu `<label for>` khớp `id`; 15 miền bên thứ ba ngoài danh sách cho phép.
- **Chưa có số đo LCP/CLS/INP nào** cho theme này trong repo ⇒ mọi phát biểu về CWV phải để `INCONCLUSIVE` cho tới khi có phiên đo thật.

## 6. Dấu vết nền tảng khác (quan trọng cho kế hoạch)

- **Chỉ ghi nhận dấu vết chuỗi, không kết luận nguồn gốc**: `sapo` 12 lần / `bizweb` 1 lần (đếm không phân biệt hoa thường trên `*.liquid` + `*.json`), toàn bộ là tên class CSS / khoá setting (`assets/product.scss.liquid:759` còn `.sapo-buyxgety-module-detail-v2`; `snippets/product-item-compare.liquid:17` có `sapo-product-reviews-badge`), không có nhánh logic Sapo nào. Tên theme trong `settings_data.json` là "Hera Jewelry". Danh sách bẫy convert Shopify→Haravan đã quét đều **0 hit**: `| slice`, `line_item.product.url`, `article_comments`, `/postcontact`, `.bwt`. ⇒ Bằng chứng chỉ đủ để nói "còn vài dấu vết chuỗi gốc Sapo trong CSS/template"; session mới tự kiểm danh sách bẫy trên theme thay vì thừa hưởng kết luận.
- Theme **đã có sẵn cơ chế noPS/StartOptimize**: `var f1genzPS = true;` trong `layout/theme.liquid:20`, `snippets/optimize_head.liquid` hoãn `data-src` → `src`, `nosrc` xuất hiện trong `assets/*.js.liquid` (`main`, `cart`, `product`, `article`, `blog`, `404`, `page`) và `snippets/shop-modal-required.liquid`, `snippets/footer-scripts.liquid`. Không thấy `ps.f1genz.dev` trong snippet.

## 7. Báo cáo chi tiết

- `plans/reports/scout-260913-15092026-pull-parity.md` — parity bản pull vs remote.
- `plans/reports/scout-260913-15092026-lint.md` — lint + hình dạng nền tảng + settings.
- `plans/reports/scout-260913-15092026-static-quality.md` — chất lượng tĩnh (ảnh, landmark/H1, render-blocking, form a11y, rò rỉ miền, CWV) kèm bảng controller kiểm chứng.
