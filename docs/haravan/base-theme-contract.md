# Bản Đặc tả Hợp đồng Universal Haravan Base Theme (Universal Base Theme Contract Specification)

> **Tài liệu thuộc Phase 08A — Universal Base Theme Program**  
> **Tài liệu máy tương ứng (Machine-Readable Contract):** `specs/base-theme-contract.json`  
> **Phiên bản:** 1.0.0  
> **Ngày phê duyệt:** 2026-09-12  
> **Nguyên tắc định danh:** *Mọi khẳng định đều tuân theo thứ bậc chân lý: Official Haravan Docs > Real Haravan Admin > Real Haravan API > Real Haravan CLI > Theme Source Corpus > Live Storefront.*

---

## 1. Triết lý Kiến trúc & Bản chất Base Theme

Universal Haravan Base Theme được thiết kế như một **nền móng kỹ thuật trung tính, sạch và tối giản** cho toàn bộ quy trình phát triển giao diện thương mại điện tử trên Haravan.

### 1.1 Nguyên tắc "Anti-UI Monster"
Base Theme **tuyệt đối không phải là một thư viện giao diện khổng lồ (UI monster)** chứa 50 biến thể hero banner, 30 kiểu card sản phẩm, hay 20 kiểu mega menu chuyên biệt. Thay vào đó, Base Theme tuân thủ công thức:
$$\text{Base Theme} = \text{Canonical Primitives} + \text{Extension Points}$$
- **Canonical Primitives:** Tập hợp tối giản các thành phần khung sườn tiêu chuẩn bắt buộc của thương mại điện tử (Header, Navigation, Breadcrumbs, Product Card, Swatch, Mini-Cart, Pagination, SEO Tags).
- **Extension Points:** Các điểm móc nối ngữ nghĩa (hook points) được quy định rõ ràng trong mã nguồn Liquid để Project Theme sau đó có thể chèn các tính năng đặc thù mà không phá vỡ cấu trúc nền tảng.
- **Brand Neutrality:** Base Theme không chứa logo, màu sắc, phông chữ, hay dữ liệu riêng của bất kỳ khách hàng nào. Việc hiện thực hóa thiết kế dự án (Hoplong, Phụ Kiện Máy Móc, Toda...) thuộc về **Project Theme** ở Phase 08B.

---

## 2. Cấu trúc Thư mục Phẳng Chuẩn Haravan (Flat Directory Structure)

Mọi mã nguồn của Universal Haravan Base Theme bắt buộc phải tuân theo cấu trúc phẳng Haravan 1.0 đã được kiểm chứng 100% trên 30 theme khách hàng thực tế tại `E:/Work/customizes`:

```text
themes/universal-haravan-base/
├── layout/
│   └── theme.liquid                  # Khung HTML gốc duy nhất (layout số ít)
├── templates/
│   ├── index.liquid                  # Trang chủ
│   ├── product.liquid                # Chi tiết sản phẩm
│   ├── collection.liquid             # Danh mục sản phẩm
│   ├── cart.liquid                   # Giỏ hàng
│   ├── search.liquid                 # Kết quả tìm kiếm
│   ├── page.liquid                   # Trang nội dung tĩnh
│   ├── page.contact.liquid           # Trang liên hệ
│   ├── blog.liquid                   # Danh sách bài viết blog
│   ├── article.liquid                # Chi tiết bài viết
│   ├── 404.liquid                    # Trang báo lỗi 404
│   ├── list-collections.liquid        # Chỉ mục toàn bộ danh mục (route /collections)
│   ├── product.quickview.liquid      # Fragment xem nhanh (layout none, phục vụ ?view=quickview)
│   └── customers[*.liquid]           # 7 template tài khoản khách hàng chuẩn
├── snippets/
│   ├── header.liquid                 # Đầu trang
│   ├── footer.liquid                 # Chân trang
│   ├── menu.liquid                   # Menu desktop
│   ├── menu-mobile.liquid            # Menu drawer mobile
│   ├── breadcrumb.liquid             # Đường dẫn phân cấp
│   ├── product-loop.liquid           # Thẻ sản phẩm chuẩn
│   ├── collection-card.liquid        # Thẻ danh mục (ảnh bìa, tên, số sản phẩm), dùng bởi list-collections
│   ├── swatch.liquid                 # Liên kết chọn biến thể (?variant=)
│   ├── quickview.liquid              # Modal xem nhanh sản phẩm
│   ├── mini-cart.liquid              # Ngăn trượt giỏ hàng Ajax
│   ├── cart-table.liquid             # Bảng giỏ hàng trang /cart
│   ├── pagination-default.liquid     # Phân trang chuẩn
│   ├── seo_head.liquid               # Metadata SEO
│   ├── fb-open-graph-tags.liquid     # Open Graph + Twitter Card
│   ├── hrvproducttabs.liquid         # Tabs metafield sản phẩm
│   └── footer-scripts.liquid         # Tải script bất đồng bộ
├── assets/
│   ├── theme.css                     # Toàn bộ CSS nền tảng, gồm token :root đứng đầu file
│   ├── theme.js                      # Vanilla JS điều khiển drawer, tab, gallery, modal
│   ├── favicon.png                   # Biểu tượng site mặc định
│   └── no-image.png                  # Ảnh giữ chỗ khi thiếu media
└── config/
    ├── settings.html                 # Giao diện cấu hình theme kinh điển
    ├── settings_schema.json          # Schema Visual Theme Editor F1GENZ
    └── settings_data.json            # Lưu trữ giá trị cấu hình merchant
```

### Các điều cấm kỵ nền tảng (Negative Invariants):
1. **CẤM thư mục `sections/`:** Haravan runtime không hỗ trợ Dynamic Sections như Shopify OS 2.0. Toàn bộ logic giao diện được chia sẻ qua `snippets/*.liquid`.
2. **CẤM template JSON (`templates/*.json`):** 100% template Haravan là file `.liquid`.
3. **CẤM thẻ Liquid `{% schema %}` và `{% render %}`:** Chỉ dùng `{% include 'snippet-name' %}`. Thẻ `render` không được DotLiquid Haravan hỗ trợ.
4. **CẤM `layouts/` số nhiều:** Thư mục layout bắt buộc là `layout/` số ít.

---

## 3. Bản đồ Route & Mapping Đối tượng Liquid (Route & Liquid Object Map)

Base Theme ánh xạ đầy đủ 17 route giao diện của Haravan với các đối tượng dữ liệu bắt buộc:

| Route ID | URL Pattern | Template Liquid | Đối tượng Liquid Bắt buộc | Tham số Truy vấn Hỗ trợ |
|---|---|---|---|---|
| `ROUTE_INDEX` | `/` | `templates/index.liquid` | `shop`, `settings`, `collections`, `blogs`, `pages` | `themeid`, `view` |
| `ROUTE_PRODUCT` | `/products/{handle}` | `templates/product.liquid` | `product`, `product.variants`, `product.options`, `product.images`, `product.selected_or_first_available_variant`, `product.metafields` | `variant`, `themeid` |
| `ROUTE_COLLECTION` | `/collections/{handle}` | `templates/collection.liquid` | `collection`, `collection.products` (max 50), `collection.all_tags`, `collection.all_vendors`, `paginate` | `page`, `sort_by`, `view`, `themeid` |
| `ROUTE_LIST_COLLECTIONS` | `/collections` | `templates/list-collections.liquid` | `collections`, `paginate` | `page`, `themeid` |
| `ROUTE_CART` | `/cart` | `templates/cart.liquid` | `cart`, `cart.items`, `cart.total_price`, `cart.item_count`, `cart.note` | `themeid` |
| `ROUTE_SEARCH` | `/search` | `templates/search.liquid` | `search`, `search.performed`, `search.terms`, `search.results`, `paginate` | `q`, `type`, `page`, `themeid` |
| `ROUTE_PAGE` | `/pages/{handle}` | `templates/page.liquid` | `page`, `page.title`, `page.content` | `themeid` |
| `ROUTE_PAGE_CONTACT` | `/pages/contact` | `templates/page.contact.liquid` | `page`, `page.title`, `page.content`, `form` | `themeid` |
| `ROUTE_BLOG` | `/blogs/{handle}` | `templates/blog.liquid` | `blog`, `blog.articles`, `blog.articles_count`, `paginate` | `page`, `themeid` |
| `ROUTE_ARTICLE` | `/blogs/{blog_handle}/{article_handle}` | `templates/article.liquid` | `blog`, `article`, `article.title`, `article.content`, `article.author`, `article.published_at`, `article.comments`, `form` | `themeid` |
| `ROUTE_ACCOUNT` | `/account` | `templates/customers[account].liquid` | `customer`, `customer.orders`, `customer.default_address` | `themeid` |
| `ROUTE_ACCOUNT_LOGIN` | `/account/login` | `templates/customers[login].liquid` | `form` | `return_to`, `themeid` |
| `ROUTE_ACCOUNT_REGISTER` | `/account/register` | `templates/customers[register].liquid` | `form` | `themeid` |
| `ROUTE_ACCOUNT_ADDRESSES` | `/account/addresses` | `templates/customers[addresses].liquid` | `customer`, `customer.addresses`, `form` | `themeid` |
| `ROUTE_ACCOUNT_ORDER` | `/account/orders/{id}` | `templates/customers[order].liquid` | `order`, `order.line_items`, `order.shipping_address`, `order.billing_address` | `themeid` |
| `ROUTE_ACCOUNT_RESET` | `/account/reset/{id}/{token}` | `templates/customers[reset_password].liquid` | `form` | `themeid` |
| `ROUTE_NOT_FOUND` | `/*` (404) | `templates/404.liquid` | `shop`, `settings` | `themeid` |

> **Quy tắc Định danh Preview Bắt buộc:**  
> Mọi yêu cầu điều hướng xem trước theme trên môi trường kiểm chứng storefront bắt buộc phải sử dụng tham số `?themeid={themeId}` (được xác thực bởi mã nguồn Haravan CLI tại `theme-dev.ts:70`). Tham số `?preview_theme_id=` của Shopify là hoàn toàn trơ trên các yêu cầu GET không kèm cookie của Haravan (Defect D9).

---

## 4. Hợp đồng Snippets & Ranh giới Ngữ nghĩa (Snippet Contracts & Landmarks)

### 4.1 Ranh giới Ngữ nghĩa HTML (Semantic Landmarks)
Base Theme chuẩn hóa cây phân cấp DOM theo WCAG 2.2:
- **Skip Link:** `a.skip-to-content[href='#main']` đặt ngay sau thẻ `<body>`.
- **Banner Header:** `<header class="site-header" role="banner">`
- **Main Navigation:** `<nav class="site-navigation" role="navigation" aria-label="Main Navigation">`
- **Main Content:** `<main id="main" class="main-content" role="main">`
- **Search Form:** `<form class="search-form" role="search">`
- **Contentinfo Footer:** `<footer class="site-footer" role="contentinfo">`
- **Modal Dialogs:** `<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">`

### 4.2 Hợp đồng Input / Output của Snippets Chính
- `snippets/header.liquid`: Nhận diện thương hiệu (`settings.header_logo`), hỗ trợ menu cố định (`header_sticky_enable`), thanh tìm kiếm (`header_search_enable`), nút mở ngăn trượt giỏ hàng với huy hiệu đếm số lượng `cart.item_count`.
- `snippets/product-loop.liquid`: Nhận đầu vào bắt buộc là đối tượng `product`, hiển thị ảnh thumbnail lazy-load, nhãn giảm giá tính theo phần trăm so sánh `compare_at_price`, tiêu đề kèm liên kết, giá định dạng tiền tệ `money`, liên kết chi tiết và nút mở xem nhanh khi bật đồng thời `product_grid_show_quickview` và `product_quickview_enable`.
- `snippets/swatch.liquid`: Phân tích `product.options`, render mỗi giá trị thành một liên kết `/products/{handle}?variant={id}` (ưu tiên biến thể còn hàng; giá trị hết hàng ghi chú trong `title`). Nhờ vậy server render đúng biến thể được chọn — không cần JS và không có giá trị giá/ảnh lệch pha.
- `snippets/mini-cart.liquid`: Ngăn trượt chỉ đọc danh sách `cart.items` (ảnh, tiêu đề, phân loại, số lượng, thành tiền), trạng thái giỏ trống, tổng tiền và liên kết thanh toán/trang giỏ. Không gọi Ajax API; thao tác số lượng nằm ở trang `/cart` qua `cart-table.liquid`.
- `snippets/hrvproducttabs.liquid`: Phân tách chuỗi metafield `product.metafields.hrvptabs.tabs` bằng cặp delimiter `@@###@@` (giữa các tab) và `@@##@@` (giữa tiêu đề và nội dung) để render tablist chuẩn WCAG.

---

## 5. Quy tắc Thoát Ký & An toàn Bảo mật (Escaping & Security)

Hệ thống theme Haravan chạy trên engine DotLiquid (.NET), đòi hỏi sự phân định nghiêm ngặt giữa dữ liệu merchant không tin cậy và nội dung định dạng HTML tin cậy:

### 5.1 Thoát ký Bắt buộc (Mandatory Escaping)
- **Tiêu đề thực thể & text settings:** Bắt buộc dùng filter `escape`:
  ```liquid
  <h1 class="product-title">{{ product.title | escape }}</h1>
  <p setting-id="home_hero_title" setting-type="text">{{ settings.home_hero_title | escape }}</p>
  ```
- **Giá trị thuộc tính HTML (alt, title, value):**
  ```liquid
  <img src="{{ image | product_img_url: 'grande' }}" alt="{{ product.title | escape }}">
  <input type="hidden" name="id" value="{{ variant.id | escape }}">
  ```
- **URLs trong thuộc tính href/src:**
  ```liquid
  <a href="{{ product.url | escape }}">{{ product.title | escape }}</a>
  ```
- **Trích đoạn nội dung bị cắt ngắn:** Bắt buộc phải loại bỏ thẻ HTML trước khi cắt chữ và thoát ký:
  ```liquid
  <p>{{ article.content | strip_html | truncatewords: 25 | escape }}</p>
  ```

### 5.2 Ngoại lệ Nội dung Phong phú Tin cậy (Trusted Rich Text Exemption)
Các trường nội dung WYSIWYG do merchant biên soạn đã được Haravan Core lọc mã độc ở tầng lưu trữ. Tuyệt đối **không** dùng filter `escape` trên các trường này (vì sẽ làm lộ mã HTML thô ra giao diện người dùng):
- `{{ product.description }}`
- `{{ page.content }}`
- `{{ article.content }}`
- Nội dung chi tiết tab sản phẩm: `{{ tabContent }}`

### 5.3 Tuân thủ Hạn chế DotLiquid .NET
- **CẤM sử dụng các filter không tồn tại:** `reject`, `compact`, `where`, `concat`, `at_most`, `at_least`, `image_url`.
- Lọc điều kiện mảng phải thực hiện bằng vòng lặp thủ công `for` + `if` / `unless`.
- Lấy ảnh phải dùng filter `img_url` hoặc `product_img_url`, kèm theo preset kích thước hữu hạn (`small`, `medium`, `large`, `grande`, `1024x1024`, `2048x2048`). Tránh sử dụng preset `master` để ngăn ngừa tình trạng tải ảnh gốc dung lượng khổng lồ.

---

## 6. Chính sách Tài nguyên & Xử lý Phụ thuộc (Assets & Dependencies)

### 6.1 Zero-Dependency Core
- Lõi Universal Base Theme được xây dựng 100% bằng **CSS hiện đại và Vanilla JavaScript**.
- Tuyệt đối không có phụ thuộc cứng vào jQuery, Bootstrap JS, hoặc Tailwind runtime.

### 6.2 Giải pháp Carousel / Slider
Khảo sát trên 30 theme khách hàng chứng minh các thư viện carousel bị phân mảnh sâu sắc: Slick (19 theme), Swiper (9 theme), Owl (6 theme), Flickity (5 theme).  
Do đó:
1. Base Theme Core tích hợp **Native CSS Scroll-Snap** với thanh điều hướng Vanilla JS siêu nhẹ (<2KB JS, 0 dependencies).
2. Các thư viện nặng của bên thứ ba (Slick, Swiper) được coi là **Project Theme Extensions** khi dự án cụ thể có đòi hỏi hiệu ứng đặc biệt.

### 6.3 Quy tắc Tải Script & CSS
- File CSS duy nhất `theme.css` (mở đầu bằng khối token `:root`) được nhúng ở thẻ `<head>` qua `{{ 'theme.css' | asset_url | stylesheet_tag }}`.
- File JavaScript duy nhất `theme.js` được tải kèm thuộc tính `defer` ở cuối `snippets/footer-scripts.liquid` trước thẻ đóng `</body>`.
- Script phân tích / đo lường của bên thứ ba tải bằng `async`.

---

## 7. Cấu hình Theme & Ràng buộc Visual Editor (Settings Contract)

Base Theme hỗ trợ hoàn hảo chế độ **Dual Config** (vốn hiện diện ở 80% theme trong corpus):
1. `config/settings.html`: Giao diện cấu hình theme kinh điển dành cho Haravan Admin. Viết bằng HTML thuần túy (không chứa Liquid), sử dụng thẻ `<table>` và `<fieldset>`. Các trường lồng nhau được bọc trong `<div class="ml-5">` do Haravan strips thuộc tính class trên `<fieldset>`.
2. `config/settings_schema.json`: Schema cấu hình dành cho Visual Theme Editor F1GENZ.

### Ràng buộc DOM của Visual Editor (Attribute Binding Contract):
Mọi trường thiết lập cấu hình của merchant xuất hiện trong `settings_schema.json` khi được render ra giao diện HTML **bắt buộc phải gắn kèm cả hai thuộc tính**:
- `setting-id`: Khớp chính xác với `id` trong schema.
- `setting-type`: Khớp với kiểu dữ liệu trong schema (`text`, `textarea`, `color`, `checkbox`, riêng `image_picker` map thành `image`).

Ví dụ:
```liquid
<h2 setting-id="home_hero_title" setting-type="text">
  {{ settings.home_hero_title | escape }}
</h2>
<img src="{{ hero_image_url }}" setting-id="home_hero_image" setting-type="image" alt="">
```

---

## 8. Hợp đồng Trạng thái Rỗng & Báo lỗi (Empty & Error States)

Base Theme định nghĩa rõ ràng trải nghiệm người dùng khi dữ liệu trống hoặc xảy ra lỗi:

1. **Danh mục rỗng (`emptyCollection`):** Khi `collection.products.size == 0`, ẩn lưới sản phẩm, hiển thị hộp thông báo `div.collection-empty-state` với tiêu đề "Danh mục đang cập nhật sản phẩm" và nút bấm dẫn đến `/collections/all`.
2. **Tìm kiếm không có kết quả (`emptySearch`):** Khi `search.performed` là `true` nhưng `search.results_count == 0`, hiển thị `div.search-empty-state` thông báo không tìm thấy kết quả cho từ khóa `{search.terms}`, giữ lại từ khóa trong ô nhập liệu để người dùng sửa đổi.
3. **Giỏ hàng rỗng (`emptyCart`):** Khi `cart.item_count == 0`, ẩn bảng sản phẩm, hiển thị thông báo "Giỏ hàng của bạn đang trống" kèm liên kết "Tiếp tục mua sắm".
4. **Biến thể hết hàng (`productSoldOut`):** Khi `variant.available == false`, vô hiệu hóa nút Submit (`disabled`), đổi nhãn thành "Hết hàng", hiển thị badge "Hết hàng" trên thẻ sản phẩm.
5. **Biến thể không tồn tại (`variantUnavailable`):** Kiến trúc swatch zero-JS chỉ liên kết tới `?variant={id}` thật, nên tổ hợp không tồn tại không bao giờ được trỏ tới; một biến thể hết hàng render trang của chính nó với nút Submit `disabled` và nhãn "Hết hàng". Theme không có trạng thái "Không khả dụng".
6. **Lỗi xác thực form (`formErrors`):** Khi `form.errors` có giá trị, render khối `div.form-errors.alert.alert-danger[role="alert"]` sử dụng filter chuẩn `{{ form.errors | default_errors }}`.
7. **Trang 404 (`notFound404`):** Hiển thị khối thông báo rõ ràng kèm thanh tìm kiếm và nút "Quay về trang chủ".

---

## 9. 13 Kịch bản Nghiệm thu Khách hàng (Consumer-Visible Acceptance Scenarios)

Mọi thay đổi trên Base Theme và Project Theme bắt buộc phải vượt qua 13 kịch bản nghiệm thu chức năng:

### Kịch bản 01: Simple Product (Single Default Variant)
- **Route:** `/products/{handle}`
- **Điều kiện tiên quyết:** Sản phẩm có đúng 1 biến thể duy nhất ("Default Title") và tồn kho > 0.
- **Hành động:** Truy cập trang sản phẩm với `?themeid={id}`; quan sát giá tiền; nhấn nút "Thêm vào giỏ hàng".
- **Kết quả kỳ vọng:** Giá hiển thị chuẩn định dạng tiền tệ; nút Thêm vào giỏ hàng ở trạng thái kích hoạt; form POST `id` biến thể tới `/cart/add` và trang giỏ cập nhật sau khi tải lại (chưa có cập nhật huy hiệu giỏ bằng Ajax).

### Kịch bản 02: Complex Product with Multi-Option Variants
- **Route:** `/products/{handle}`
- **Điều kiện tiên quyết:** Sản phẩm có ≥2 nhóm tuỳ chọn (Màu sắc, Kích thước) và ≥3 biến thể.
- **Hành động:** Theo liên kết swatch của một màu phụ, sau khi trang tải lại thì theo tiếp một liên kết kích thước khác.
- **Kết quả kỳ vọng:** `href` của swatch là `/products/{handle}?variant={id}`; server render đúng biến thể đó qua `product.selected_or_first_available_variant`, nên giá, giá so sánh và tình trạng còn hàng luôn khớp giá trị vừa chọn; ảnh đại diện dùng ảnh biến thể nếu biến thể có ảnh, ngược lại dùng ảnh đầu tiên của sản phẩm; `<select>` trên cùng trang đánh dấu `selected` đúng biến thể. Liên kết ở nhóm tuỳ chọn thứ hai giữ nguyên giá trị đang render của nhóm thứ nhất: biến thể đích là biến thể khớp mọi tuỳ chọn còn lại (lượt 1, **không xét tồn kho** — combo hết hàng vẫn được trỏ đúng và gắn nhãn `(Hết hàng)`); chỉ khi tổ hợp đó không tồn tại mới rơi về một biến thể còn hàng mang giá trị đó (lượt 2), rồi tới biến thể bất kỳ (lượt 3).

### Kịch bản 03: Multi-Option Unavailable & Out-of-Stock Variants
- **Route:** `/products/{handle}`
- **Điều kiện tiên quyết:** Sản phẩm có ít nhất 1 biến thể tồn kho = 0.
- **Hành động:** Từ một biến thể đang render, theo liên kết swatch của một giá trị mà tổ hợp với các tuỳ chọn còn lại đang hết hàng; sau đó theo liên kết của một giá trị mà tổ hợp đó không tồn tại.
- **Kết quả kỳ vọng:** Liên kết đó trỏ tới biến thể giữ nguyên các tuỳ chọn còn lại đang render (chỉ rơi về biến thể đầu tiên mang giá trị đó khi tổ hợp không tồn tại), gắn `is-unavailable` và ghi chú "(Hết hàng)" trong thuộc tính `title`; trang render đúng biến thể đó với nút "Hết hàng" ở trạng thái `disabled`. Giá trị mà tổ hợp với tuỳ chọn hiện tại không tồn tại thì được trỏ sang một biến thể mang giá trị đó — còn hàng nếu có, ngược lại là biến thể đã hết hàng và trang render "Hết hàng" với nút Submit `disabled` — nên yêu cầu luôn phân giải về biến thể thật; theme không có trạng thái "Không khả dụng". Không phát sinh lỗi JavaScript console vì chọn tuỳ chọn là điều hướng trang, không phải vá state phía client.

### Kịch bản 04: Populated Collection with Filter, Sort, and Pagination
- **Route:** `/collections/{handle}`
- **Điều kiện tiên quyết:** Danh mục có ≥17 sản phẩm (vượt ngưỡng phân trang 16 sản phẩm/trang).
- **Hành động:** Kiểm tra lưới sản phẩm (số cột lấy từ setting `collection_grid_columns` của merchant, áp dụng ở mọi viewport — theme không có breakpoint đổi số cột trên mobile); chọn sắp xếp giá tăng dần; nhấn chuyển sang trang 2.
- **Kết quả kỳ vọng:** Trang 1 hiển thị đúng 16 thẻ sản phẩm; thanh phân trang hiển thị trang 1 active; sau khi chuyển trang, URL cập nhật `?page=2`, hiển thị các sản phẩm tiếp theo kèm thuộc tính `aria-current="page"`.

### Kịch bản 05: Empty Collection Handling
- **Route:** `/collections/{handle}`
- **Điều kiện tiên quyết:** Danh mục rỗng (chứa 0 sản phẩm).
- **Hành động:** Truy cập URL danh mục rỗng.
- **Kết quả kỳ vọng:** Lưới sản phẩm không render phần tử rác; hiển thị khối thông báo `div.collection-empty-state` với lời nhắn rõ ràng và nút bấm hoạt động dẫn về `/collections/all`.

### Kịch bản 06: Search with Zero Results and Re-query
- **Route:** `/search?q=xyznonexistentterm`
- **Điều kiện tiên quyết:** Từ khóa tìm kiếm không khớp với bất kỳ sản phẩm, bài viết hay trang nào.
- **Hành động:** Truy cập route tìm kiếm; kiểm tra giao diện; nhập từ khóa hợp lệ mới vào ô tìm kiếm và submit.
- **Kết quả kỳ vọng:** Biến `search.performed` bằng true; `search.results_count` bằng 0; ô tìm kiếm giữ nguyên từ khóa đã nhập; thông báo không tìm thấy kết quả hiển thị; tìm kiếm lại chuyển hướng đúng đến danh sách kết quả mới.

### Kịch bản 07: Empty Shopping Cart State
- **Route:** `/cart`
- **Điều kiện tiên quyết:** Giỏ hàng có 0 sản phẩm.
- **Hành động:** Truy cập trực tiếp đường dẫn `/cart`.
- **Kết quả kỳ vọng:** `cart.item_count` bằng 0; ẩn bảng giỏ hàng; hiển thị khối `div.cart-empty-state` với thông báo "Giỏ hàng của bạn đang trống" và nút "Tiếp tục mua sắm".

### Kịch bản 08: Populated Cart Line Items, Quantity Adjustment, and Subtotal
- **Route:** `/cart`
- **Điều kiện tiên quyết:** Giỏ hàng có ít nhất 1 mặt hàng với số lượng 2.
- **Hành động:** Nhấn nút tăng số lượng lên 3; sau đó nhấn nút xóa sản phẩm.
- **Kết quả kỳ vọng:** Khi tăng số lượng, gửi request POST `/cart/change.js`, tổng tiền cập nhật tự động; khi xóa sản phẩm cuối cùng, giao diện giỏ hàng mượt mà chuyển sang trạng thái Giỏ hàng rỗng.

### Kịch bản 09: Customer Account and Address Book Management
- **Route:** `/account/addresses`
- **Điều kiện tiên quyết:** Phiên đăng nhập khách hàng hợp lệ.
- **Hành động:** Mở form thêm địa chỉ mới; điền họ tên, số điện thoại, địa chỉ, tỉnh thành; tích chọn "Đặt làm địa chỉ mặc định" và submit.
- **Kết quả kỳ vọng:** Form submit thành công; địa chỉ mới xuất hiện trong danh sách địa chỉ với nhãn "Mặc định"; các thao tác sửa/xóa địa chỉ hoạt động không lỗi.

### Kịch bản 10: Standard Content Page and Contact Form Submission
- **Route:** `/pages/contact`
- **Điều kiện tiên quyết:** Trang tồn tại với handle 'contact' sử dụng template `page.contact.liquid`.
- **Hành động:** Kiểm tra nội dung bài viết tĩnh; điền form liên hệ (Tên, Email, Điện thoại, Nội dung) và nhấn gửi.
- **Kết quả kỳ vọng:** Form submit đến bộ xử lý liên hệ của Haravan; khi thành công (`form.posted_successfully?`), hiển thị thông báo cảm ơn và reset các trường nhập liệu.

### Kịch bản 11: Blog Listing and Article Details with Comments
- **Route:** `/blogs/{blog_handle}/{article_handle}`
- **Điều kiện tiên quyết:** Blog có bài viết cho phép gửi bình luận.
- **Hành động:** Đọc bài viết; kiểm tra định dạng ngày tháng (%d/%m/%Y); điền form gửi bình luận và submit.
- **Kết quả kỳ vọng:** Nội dung bài viết render đầy đủ định dạng rich text; form bình luận gửi thành công và hiển thị thông báo ghi nhận bình luận.

### Kịch bản 12: Customer Registration Form Validation Errors
- **Route:** `/account/register`
- **Điều kiện tiên quyết:** Khách truy cập chưa đăng nhập.
- **Hành động:** Điền email sai định dạng và mật khẩu ngắn hơn 6 ký tự; nhấn Đăng ký.
- **Kết quả kỳ vọng:** Server Haravan từ chối đăng ký; trang tải lại với `form.errors`; hiển thị hộp thông báo lỗi màu đỏ liệt kê chi tiết các lỗi cần khắc phục; các trường dữ liệu người dùng đã nhập (ngoại trừ mật khẩu) được giữ lại.

### Kịch bản 13: Catalog Index Listing All Collections
- **Route:** `/collections`
- **Điều kiện tiên quyết:** Cửa hàng có ít nhất một danh mục hiển thị và ít hơn 12 danh mục để vừa một trang phân trang.
- **Hành động:** Mở `/collections`; kiểm tra lưới thẻ danh mục; theo liên kết tiêu đề của một thẻ.
- **Kết quả kỳ vọng:** Trang render qua `templates/list-collections.liquid` (không rơi vào trạng thái rỗng của trang danh mục đơn); mỗi thẻ hiển thị ảnh bìa (`collection.image`, ngược lại ảnh sản phẩm đầu tiên, ngược lại `assets/no-image.png`), tiêu đề có liên kết và `all_products_count`; theo liên kết tới đúng `/collections/{handle}`; khi không có danh mục nào thì hiện khối thông báo thay vì lưới rỗng.

---

## 10. Sổ Đăng Ký Vấn Đề Chưa Giải Quyết (Unresolved Blockers Register)

Mọi vấn đề chưa thể chứng minh chắc chắn từ tài liệu chính thức đều được giữ ở trạng thái `UNKNOWN` hoặc `CONFLICT`. Mỗi mục **bắt buộc phải nêu rõ đầu ra Base Theme / Compiler bị chặn**:

| ID Vấn đề | Trạng thái Bằng chứng | Mô tả Hiện tượng | Đầu ra Base Theme / Compiler bị Chặn (Blocking) | Kế hoạch Kiểm chứng Thực tế |
|---|---|---|---|---|
| `UNRESOLVED_01_ADMIN_SETTINGS_PRECEDENCE` | **CONFLICT** | 24/30 theme duy trì đồng thời `settings.html` và `settings_schema.json`. Thứ tự ưu tiên ghi đè của Haravan Admin khi 2 file trùng key chưa có tài liệu chính thức. | **Chặn Phase 05 & 06:** Chặn quyết định compiler có sinh dual config hay chỉ sinh schema đơn lẻ cho theme thử nghiệm. | Đẩy theme thử nghiệm lên staging theme `1001512581` với 2 giá trị khác nhau giữa 2 file, lưu qua Admin GUI và đối chiếu file `settings_data.json`. |
| `UNRESOLVED_02_STOREFRONT_IDENTITY_ATTESTATION` | **CONFLICT** | Tham số `?themeid=` kích hoạt render theme và set cookie `preview_theme_id`, nhưng cookie HTTP đơn lẻ không cung cấp chữ ký chứng minh DOM được render từ theme nào. | **Chặn Phase 03 & 07:** Chặn Verifier tự động cấp phán quyết `VERIFIED_PASS` mà không có bằng chứng attestation định danh theme. | Chèn thẻ meta watermark `<meta name="haravan-theme-identity" content="{theme_id}:{git_sha}">` vào `layout/theme.liquid` để Playwright đối soát trực tiếp trên DOM. |
| `UNRESOLVED_03_MENU_REST_API_LIMITATION` | **VERIFIED** | Endpoint REST `/web/link_lists.json` trả về 404 trên Omni API, không thể tự động tạo hoặc kiểm tra menu qua REST scripts. | **Chặn Phase 08B:** Chặn module tạo menu demo tự động; bắt buộc phải cấu hình menu thủ công trên Admin hoặc fallback qua setting theme. | Khảo sát Haravan Commerce GraphQL API để tìm kiếm mutation quản lý navigation linklists. |
| `UNRESOLVED_04_PRODUCT_MEDIA_AVAILABILITY` | **UNKNOWN** | Chuẩn Haravan 1.0 dùng `product.images`. Một số theme mới dùng `product.media` (video/3D), nhưng tính khả dụng trên toàn bộ gói cửa hàng Haravan chưa được xác thực. | **Chặn Phase 06:** Chặn quyết định viết gallery sản phẩm theo chuẩn phổ quát `product.images` hay nâng cao `product.media`. | Thử nghiệm đối tượng `product.media` trên store `phukienmaymoc.com` với sản phẩm có gắn video. |
| `UNRESOLVED_05_SENTINEL_MINUS_ONE_SEMANTICS` | **VERIFIED** | Tệp lịch sử `.canary/state/subset-r2.json` chứa allowlist `-1` dẫn tới việc đo nhầm live theme (Defect D11). Ý nghĩa nguồn gốc của giá trị `-1` chưa rõ. | **Chặn Phase 01:** Chặn bộ phân tích kết quả cũ không được công nhận các record mang themeId `-1`. | Khóa regex kiểm tra `themeId` trong mọi verifier, chỉ chấp nhận số nguyên dương hợp lệ, fail-closed khi gặp `-1`. |
| `UNRESOLVED_06_NEWSLETTER_FORM_MECHANISM` | **OBSERVED (cơ chế) — UNVERIFIED (đích lưu)** | `{% form 'customer' %}` là cơ chế newsletter chuẩn của corpus (79 file thuộc 40/45 root đo được), nhưng form type `customer` không có trong danh sách form type được tài liệu hoá và không đo được nơi Haravan lưu địa chỉ đã gửi. | **Chặn Phase 06:** Không được giới thiệu khối newsletter như tính năng đăng ký đã kiểm chứng cho tới khi có round-trip thật. | Gửi form một lần trên theme staging chưa publish `1001512581` với địa chỉ kiểm soát, quan sát HTTP response và bản ghi customer/contact tương ứng. |

---

## 11. Bảng Khẳng định Chuẩn (Normative Claims Table)

Bảng đối soát chuẩn mực thực nghiệm của Hợp đồng Base Theme: `claim | evidence status | source (path or URL + observed date) | contradiction | next probe`.

| Claim (Khẳng định) | Evidence Status | Source (Nguồn bằng chứng) | Contradiction (Mâu thuẫn) | Next Probe (Bước kiểm chứng tiếp theo) |
|---|---|---|---|---|
| Cấu trúc Universal Base Theme bắt buộc là cấu trúc phẳng Haravan 1.0 | **VERIFIED** | Khảo sát 30 theme tại `E:/Work/customizes`, 2026-09-12 | Module `site-clone` cũ sinh `sections/` và `index.json` (D5) | Xác minh compiler Phase 05 chỉ sinh template phẳng |
| Tham số kích hoạt preview theme trên Haravan là `?themeid=` | **VERIFIED** | CLI `theme-dev.ts:70`, `open-service.ts:80`, Storefront HTTP probe | Historical test artifact dùng `?preview_theme_id=` (D9) | Kiểm tra sự hiện diện của cookie `preview_theme_id` khi request bằng `?themeid=` |
| Thư viện Carousel bị phân mảnh và không phải chuẩn nền tảng | **VERIFIED** | Scout union report & content audit 30 theme, 2026-09-12 | Một số quan điểm cho rằng Slick là bắt buộc | Triển khai CSS scroll-snap native trong Base Core |
| DotLiquid Haravan không hỗ trợ các filter `reject`, `compact`, `where`, `concat` | **VERIFIED** | `haravan-theme/references/liquid-cheatsheet.md:14-23` | Tài liệu Shopify tiêu chuẩn có hỗ trợ | Kiểm tra linter DotLiquid trong pipeline build |
| Tất cả các trường settings hiển thị phải gắn `setting-id` và `setting-type` | **VERIFIED** | `haravan-settings-schema/references/schema-and-editor-contract.md:49` | Một số theme cũ thiếu gắn thẻ thuộc tính | Chạy script audit hai chiều giữa schema và DOM |
| Haravan Omni REST API không có endpoint `/web/link_lists.json` (404) | **VERIFIED** | `reports/haravan-store-inventory.json:101`, 2026-09-12 | API Shopify hỗ trợ `/admin/api/.../link_lists.json` | Thăm dò GraphQL Admin API của Haravan |
| Skip link chỉ hiện diện ở 10.0% theme trong corpus (3/30 theme) | **OBSERVED** | A11y regex telemetry trên 30 theme, 2026-09-12 | Một số đơn vị làm theme tự nhận đạt chuẩn tiếp cận | Đo đạc Playwright axe-core trực tiếp trên Base Theme |
| Định dạng metafield tabs chuẩn Haravan dùng `@@###@@` và `@@##@@` | **OBSERVED** | 21/30 theme trong corpus dùng `hrvproducttabs.liquid` | Một số theme lưu dữ liệu dạng JSON thuần | Kiểm tra parser tab trên store thực tế |
