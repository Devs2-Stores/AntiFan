/**
 * Theme Studio checklist domain — the shared half of the QA cockpit bridge.
 *
 * Moved verbatim from `src/renderer/toolbar.ts` so the toolbar renderer and the
 * main-process checklist store derive byte-identical scopes from the same
 * origin + workspace tag, and the export/report text is built once instead of
 * being re-implemented per surface.
 */
export interface ThemeChecklistItem {
  id: string;
  code: string;
  name: string;
  desc: string;
  qaPoint: string;
  page: 'home' | 'collection' | 'product' | 'cart' | 'blog' | 'account' | 'pages' | 'qa-gate' | string;
  pathHint?: string;
  done: boolean;
  /**
   * Per-item note (QA remark an agent or the developer attached to the tick).
   * Absent means "no note"; the field survives a save/load round-trip.
   */
  note?: string;
  /** Optional action linking directly to capability (e.g. 'theme.settings_check') */
  action?: string;
  /** Capability that measures this item; persisted scopes get it backfilled by id on read. */
  measuredBy?: string;
  /** Extended / platform-adaptive description */
  description?: string;
}

export interface ThemePageDef {
  title: string;
  badge: string;
  icon: string;
  path: string;
  /**
   * `handle-required` marks a page that has no index route on any supported
   * platform — Haravan/Sapo/Shopify all serve PDPs only at `/products/<handle>`.
   * Those cards refuse to navigate/scan until a real product page is open, so a
   * scan can never report findings for an unrelated 404 page.
   */
  routeKind?: 'index' | 'handle-required';
  routeNote?: string;
  /** Limitation of what this card's items and scan actually prove. */
  note?: string;
}

/**
 * A route scan loads one page at one viewport, so it cannot certify mobile
 * behaviour or the dynamic storefront mechanics (drawer, AJAX cart, sticky bars).
 * Every completion claim carries this, so a fully ticked checklist never reads as more
 * than it is.
 */
export const QA_GATE_DISCLAIMER =
  'Checklist là trạng thái dev tự khai; quét QA chỉ đo các trang tĩnh tại route đang mở — chưa chứng minh viewport mobile 375px, drawer trượt hay luồng AJAX/thêm giỏ động.';

export const PAGE_DEFS: Record<string, ThemePageDef> = {
  home: {
    title: 'Trang Chủ (Home - Banner, Danh Mục, Flash Sale, Tabs SP, Tin Tức, Footer)',
    badge: 'HOME',
    icon: '🏠',
    path: '/',
  },
  collection: {
    title: 'Trang Danh Mục Sản Phẩm (Collection - Bộ Lọc Filter, Sắp Xếp Sort, Grid SP, Phân Trang)',
    badge: 'COLLECTION',
    icon: '🛍️',
    path: '/collections/all',
  },
  product: {
    title: 'Trang Chi Tiết Sản Phẩm (Product / PDP - Gallery Ảnh, Variant Swatch, Mua Hàng, Sticky ATC, Tabs)',
    badge: 'PRODUCT',
    icon: '📦',
    path: '/products/<handle>',
    routeKind: 'handle-required',
    routeNote: 'Chưa có trang sản phẩm nào đang mở: mở một PDP thật (/products/<handle>) trên storefront rồi bấm lại — không có route /products để mở hộ.',
  },
  cart: {
    title: 'Trang Giỏ Hàng & Mini Cart (Cart - AJAX Drawer, Bảng Giỏ Hàng, Note, Checkout, Empty State)',
    badge: 'CART',
    icon: '🛒',
    path: '/cart',
  },
  blog: {
    title: 'Trang Tin Tức & Bài Viết (Blog / Article - Danh Sách Bài, Nội Dung Chi Tiết, Bình Luận)',
    badge: 'BLOG',
    icon: '📰',
    path: '/blogs/news',
  },
  account: {
    title: 'Trang Khách Hàng / Tài Khoản (Customer - Đăng Nhập, Đăng Ký, Đơn Hàng, Sổ Địa Chỉ)',
    badge: 'ACCOUNT',
    icon: '👤',
    path: '/account/login',
  },
  pages: {
    title: 'Trang Phụ & Hệ Thống (Pages, Liên Hệ, Giới Thiệu, Tìm Kiếm, Quickview, 404)',
    badge: 'PAGES',
    icon: '📄',
    path: '/pages/lien-he',
  },
  article: {
    title: 'Trang Chi Tiết Bài Viết (Article - Tiêu Đề, Tác Giả, Nội Dung, Bình Luận)',
    badge: 'ARTICLE',
    icon: '📝',
    path: '/blogs/news/<handle>',
    routeKind: 'handle-required',
    routeNote: 'Mở một bài viết thật (/blogs/<blog>/<handle>) trên storefront hoặc truyền url trực tiếp.',
  },
  search: {
    title: 'Trang Tìm Kiếm Sản Phẩm (/search?q=a)',
    badge: 'SEARCH',
    icon: '🔍',
    path: '/search?q=a',
  },
  'page-about': {
    title: 'Trang Giới Thiệu (/pages/about-us)',
    badge: 'ABOUT',
    icon: 'ℹ️',
    path: '/pages/about-us',
  },
  'not-found': {
    title: 'Trang Lỗi 404 (/404)',
    badge: '404',
    icon: '🚫',
    path: '/404',
  },
  'qa-gate': {
    title: 'Nghiệm Thu Cổng Chất Lượng & QA Storefront (Responsive 375px, 0 Lỗi Console, Empty State, Settings)',
    badge: 'QA GATE',
    icon: '🎯',
    path: '/',
    note: QA_GATE_DISCLAIMER,
  },
};
export type ThemeSettingsMode = 'legacy' | 'f1genz' | string;

export function getQag04Description(mode?: ThemeSettingsMode): string {
  return (mode === 'legacy')
    ? 'Validate settings.html controls, duplicate names, and upload asset_url references via theme.settings_check.'
    : 'Validate settings_schema.json definitions and Liquid bindings via theme.settings_check.';
}

let themeMode: ThemeSettingsMode = 'f1genz';

export function setChecklistThemeMode(mode: ThemeSettingsMode): void {
  themeMode = mode;
  const qag = DEFAULT_THEME_CHECKLIST.find((it) => it.id === 'qag-04');
  if (qag) {
    const desc = getQag04Description(themeMode);
    qag.desc = desc;
    qag.description = desc;
    qag.action = 'theme.settings_check';
  }
}

/**
 * Items a capability measures. `action` mirrors `measuredBy` so a client can
 * offer the run directly; persisted scopes predate the field, so
 * `adaptChecklistItems` backfills it by id.
 */
const MEASURED_BY: Record<string, { measuredBy: string; action: string }> = Object.fromEntries(
  ([
    ['hom-01', 'anti.qa.menu_depth'],
    ['hom-02', 'anti.qa.page_structure'],
    ['hom-03', 'anti.qa.page_structure'],
    ['hom-05', 'anti.qa.page_structure'],
    ['hom-06', 'anti.qa.page_structure'],
    ['hom-07', 'anti.qa.page_structure'],
    ['hom-08', 'anti.qa.page_structure'],
    ['hom-09', 'anti.qa.menu_depth'],
    ['pdp-01', 'anti.qa.variant_image_probe'],
    ['pdp-04', 'anti.qa.variant_image_probe'],
    ['pdp-11', 'anti.qa.pdp_contract'],
    ['sys-04', 'anti.qa.state_matrix'],
    ['qag-07', 'theme.qa_validate'],
    ['qag-20', 'anti.qa.page_structure'],
    ['qag-23', 'anti.qa.state_matrix'],
    ['qag-25', 'theme.qa_validate'],
    ['qag-29', 'theme.qa_validate'],
    ['qag-34', 'anti.qa.variant_image_probe'],
    ['qag-36', 'anti.qa.state_matrix'],
  ] as const).map(([id, tool]) => [id, { measuredBy: tool, action: tool }])
);

export function adaptChecklistItems(items: ThemeChecklistItem[], mode?: ThemeSettingsMode): ThemeChecklistItem[] {
  return items.map((it) => {
    if (it.id === 'qag-04') {
      const desc = getQag04Description(mode);
      return {
        ...it,
        desc,
        description: desc,
        action: 'theme.settings_check',
      };
    }
    const measured = MEASURED_BY[it.id];
    return measured ? { ...it, measuredBy: it.measuredBy ?? measured.measuredBy, action: it.action ?? measured.action } : it;
  });
}

export const DEFAULT_THEME_CHECKLIST: ThemeChecklistItem[] = [
  // 1. TRANG CHỦ (HOME)
  { id: 'hom-01', code: 'HOM-01', name: 'Header & Sticky Mega Menu', desc: 'Logo, menu đa cấp 1-2-3, sticky khi cuộn, bubble count giỏ hàng', qaPoint: 'Menu mobile không tràn màn hình, không giật lag khi cuộn sticky', page: 'home', pathHint: '/', done: false },
  { id: 'hom-02', code: 'HOM-02', name: 'Hero Banner Slider', desc: 'Slider ảnh/video banner chính, chuyển slide 2 chiều mượt mà', qaPoint: 'Ảnh responsive không méo, không vỡ layout trước khi init Swiper/Slick', page: 'home', pathHint: '/', done: false },
  { id: 'hom-03', code: 'HOM-03', name: 'Danh Mục Nổi Bật (Categories)', desc: 'Lưới icon/ảnh danh mục dẫn đến từng collection', qaPoint: 'Tỷ lệ ảnh đồng đều, không co giật layout khi tải trang', page: 'home', pathHint: '/', done: false },
  { id: 'hom-04', code: 'HOM-04', name: 'Flash Sale Deal Đếm Ngược', desc: 'Đồng hồ đếm ngược ngày:giờ:phút:giây, thanh tiến độ đã bán', qaPoint: 'Hết hạn tự động ẩn hoặc đổi trạng thái, không hiện NaN', page: 'home', pathHint: '/', done: false },
  { id: 'hom-05', code: 'HOM-05', name: 'Tabs Sản Phẩm Trang Chủ', desc: 'Chuyển tab danh mục mượt mà, tải đúng sản phẩm theo tab', qaPoint: 'Bỏ chọn danh mục trong settings không làm sập layout trang', page: 'home', pathHint: '/', done: false },
  { id: 'hom-06', code: 'HOM-06', name: 'Banner Quảng Cáo Đôi / Video', desc: 'Banner phụ 2 bên hoặc video tự động phát (muted)', qaPoint: 'Video có playsinline trên mobile, banner không lệch chiều cao', page: 'home', pathHint: '/', done: false },
  { id: 'hom-07', code: 'HOM-07', name: 'Tin Tức Mới Nhất (Blog Carousel)', desc: 'Lưới 3-4 bài viết mới nhất, tiêu đề, ngày đăng, tóm tắt', qaPoint: 'Tiêu đề dài tự cắt dòng line-clamp, thẻ tin đều nhau', page: 'home', pathHint: '/', done: false },
  { id: 'hom-08', code: 'HOM-08', name: 'Chân Trang (Footer) & Newsletter', desc: 'Cột thông tin shop, chính sách, form đăng ký email, BCT', qaPoint: 'Form email validate chuẩn AJAX, 375px không vỡ footer', page: 'home', pathHint: '/', done: false },
  { id: 'hom-09', code: 'HOM-09', name: 'Menu Mobile Đa Cấp (Cấp 2-3)', desc: 'Drawer menu mobile: nút Quay lại, tiêu đề submenu, link cấp 3', qaPoint: 'Ở 320-412px tiêu đề submenu và nút Quay lại không xuống dòng, link cấp 3 có padding không dính mép trái', page: 'home', pathHint: '/', done: false },
  { id: 'hom-10', code: 'HOM-10', name: 'Ảnh LCP Hero & Cấu Hình Slider', desc: 'Slide 1 không lazy, có fetchpriority="high"; slide 2+ mới lazy; img có width/height', qaPoint: 'Không CLS khi slider init; loop chỉ dùng slidesPerView nguyên, autoplay không kẹt ở slide cuối', page: 'home', pathHint: '/', done: false },

  // 2. TRANG DANH MỤC (COLLECTION)
  { id: 'col-01', code: 'COL-01', name: 'Banner Đầu Trang & Breadcrumb', desc: 'Thanh điều hướng Trang chủ > Danh mục, ảnh cover danh mục', qaPoint: 'Breadcrumb có cấu trúc schema, không lặp tiêu đề', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-02', code: 'COL-02', name: 'Bộ Lọc Sản Phẩm Đa Năng (Filter)', desc: 'Lọc theo giá, màu sắc, kích thước, thương hiệu, tag', qaPoint: 'Lọc AJAX không reload trang, URL cập nhật query param', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-03', code: 'COL-03', name: 'Bộ Sắp Xếp Sản Phẩm (Sort)', desc: 'Xếp theo: Giá tăng/giảm, Mới nhất, Bán chạy, Tên A-Z', qaPoint: 'Đổi sắp xếp giữ nguyên điều kiện bộ lọc đang chọn', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-04', code: 'COL-04', name: 'Lưới Sản Phẩm Đều Khung (Grid)', desc: 'Hiển thị 2 cột (mobile), 3-4 cột (desktop), nút mua thẳng hàng', qaPoint: 'Thẻ sản phẩm cao bằng nhau, nút mua không bị thụt thò', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-05', code: 'COL-05', name: 'Phân Trang & Nút Xem Thêm', desc: 'Phân trang 1, 2, 3... hoặc nút Xem thêm / Cuộn vô tận', qaPoint: 'Trang cuối cùng không lặp sản phẩm, cuộn mượt không giật', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-06', code: 'COL-06', name: 'Trạng Thái Bộ Lọc Trống (Empty Filter)', desc: 'Thông báo "Không tìm thấy sản phẩm" + nút Xóa bộ lọc', qaPoint: 'Bấm Xóa bộ lọc khôi phục lại danh mục bình thường', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-07', code: 'COL-07', name: 'Link Tag & Thương Hiệu Trong Menu', desc: 'Link tag dùng /collections/all/<tag>, thương hiệu dùng /collections/vendors?q=', qaPoint: 'Mở từng link: lưới có đúng sản phẩm, không ra 0 kết quả hay đếm phồng', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-08', code: 'COL-08', name: 'Lọc Trong Danh Mục Đúng Phạm Vi', desc: 'Lọc AJAX trong /collections/<handle> chỉ trả sản phẩm của danh mục đó; view filter trả cùng card/grid với collection', qaPoint: 'Danh mục con không ra sản phẩm toàn shop; 1-2 kết quả vẫn giữ bề rộng cột; F5 hoặc chia sẻ link giữ bộ lọc qua URL', page: 'collection', pathHint: '/collections/all', done: false },

  // 3. TRANG CHI TIẾT SẢN PHẨM (PRODUCT / PDP)
  { id: 'pdp-01', code: 'PDP-01', name: 'Thư Viện Ảnh & Phóng To (Gallery & Zoom)', desc: 'Slider ảnh to + thumbnail nhỏ, zoom hover, lightbox', qaPoint: 'Đổi màu swatch thì ảnh to tự nhảy sang đúng màu tương ứng', page: 'product', done: false },
  { id: 'pdp-02', code: 'PDP-02', name: 'Tiêu Đề, Mã SKU & Đánh Giá Sao', desc: 'Tên sản phẩm H1, SKU, tình trạng kho, đánh giá sao', qaPoint: 'Đổi biến thể cập nhật đúng SKU và trạng thái còn hàng', page: 'product', done: false },
  { id: 'pdp-03', code: 'PDP-03', name: 'Khối Giá Bán, Giá Gạch & % Giảm', desc: 'Giá bán, giá so sánh gạch ngang, % tiết kiệm, sale badge', qaPoint: 'Định dạng tiền VNĐ chuẩn (100.000₫), không lỗi NaN', page: 'product', done: false },
  { id: 'pdp-04', code: 'PDP-04', name: 'Bộ Chọn Biến Thể (Variant Swatch)', desc: 'Swatch màu sắc (có ảnh/màu hex), kích thước (S/M/L)', qaPoint: 'Biến thể hết hàng bị gạch mờ, chặn bấm mua biến thể lỗi', page: 'product', done: false },
  { id: 'pdp-05', code: 'PDP-05', name: 'Số Lượng & Nút Thêm Giỏ / Mua Ngay', desc: 'Nút +/- số lượng, Thêm vào giỏ, Mua ngay chuyển checkout', qaPoint: 'Thêm giỏ AJAX không reload, cập nhật số lượng tức thì', page: 'product', done: false },
  { id: 'pdp-06', code: 'PDP-06', name: 'Thanh Mua Hàng Dính Đáy (Sticky ATC)', desc: 'Thanh dính đáy màn hình khi cuộn qua nút mua chính', qaPoint: 'Hiển thị mượt mà trên mobile & desktop, không che nội dung', page: 'product', done: false },
  { id: 'pdp-07', code: 'PDP-07', name: 'Tabs Chi Tiết Mô Tả & Thông Số', desc: 'Tab Mô tả chi tiết, Thông số kỹ thuật, Chính sách đổi trả', qaPoint: 'Bảng biểu không gây tràn ngang (overflow) trên mobile 375px', page: 'product', done: false },
  { id: 'pdp-08', code: 'PDP-08', name: 'Sản Phẩm Gợi Ý / Cùng Chuyên Mục', desc: 'Lưới sản phẩm liên quan hoặc sản phẩm vừa xem', qaPoint: 'Không gợi ý trùng chính sản phẩm đang xem', page: 'product', done: false },
  { id: 'pdp-09', code: 'PDP-09', name: 'Nút Thao Tác Trên Ảnh Sản Phẩm (Cảm Ứng)', desc: 'Nút giỏ, yêu thích, xem nhanh, so sánh trên thẻ và ảnh sản phẩm', qaPoint: 'Trên thiết bị cảm ứng (hover: none) các nút không che ảnh sản phẩm', page: 'product', done: false },
  { id: 'pdp-10', code: 'PDP-10', name: 'Combo / Mua Kèm Thêm Nhiều Biến Thể', desc: 'Nút thêm combo, mua kèm, bundle gửi nhiều variant vào giỏ một lần bấm', qaPoint: 'Bấm thêm combo: mọi variant đều vào giỏ và badge tăng đúng. Haravan /cart/add.js trả 404 "The product not found." với payload {items:[...]} nên phải gửi tuần tự từng {id, quantity}; npm run lint:haravan không còn HARAVAN_CART_ADD_ITEMS_ARRAY', page: 'product', done: false },
  { id: 'pdp-11', code: 'PDP-11', name: 'Size Guide Cho Sản Phẩm Có Kích Cỡ', desc: 'Nút/link mở bảng size guide ngay cạnh bộ chọn kích cỡ khi sản phẩm có option kích cỡ', qaPoint: 'Sản phẩm có option size/kích thước thì có nút mở size guide, mở ra đúng nội dung và đóng lại được; sản phẩm không có size thì không hiện', page: 'product', done: false },

  // 4. TRANG GIỎ HÀNG (CART)
  { id: 'crt-01', code: 'CRT-01', name: 'Mini Cart Drawer Trượt Phải (AJAX)', desc: 'Ngăn kéo giỏ hàng trượt từ phải sang khi thêm sản phẩm', qaPoint: 'Mở/đóng mượt mà, bấm backdrop mờ tự đóng', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-02', code: 'CRT-02', name: 'Trang Giỏ Hàng Đầy Đủ (/cart)', desc: 'Bảng sản phẩm, ảnh, tên, đơn giá, số lượng, thành tiền, nút xóa', qaPoint: 'Tăng giảm số lượng tính lại tổng tiền AJAX, không reload', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-03', code: 'CRT-03', name: 'Ghi Chú Đơn Hàng & Mã Khuyến Mãi', desc: 'Khung nhập ghi chú gửi shop, nhập voucher giảm giá', qaPoint: 'Ghi chú lưu đúng vào thuộc tính note của đơn hàng', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-04', code: 'CRT-04', name: 'Nút Tiến Hành Thanh Toán (Checkout)', desc: 'Nút nổi bật chuyển khách sang trang thanh toán bảo mật', qaPoint: 'Không bị disabled khi giỏ hàng có sản phẩm hợp lệ', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-05', code: 'CRT-05', name: 'Trạng Thái Giỏ Hàng Trống (Empty Cart)', desc: 'Icon giỏ rỗng + câu thông báo + nút Tiếp tục mua sắm', qaPoint: 'Xóa hết món chuyển ngay sang Empty Cart không sót bảng cũ', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-06', code: 'CRT-06', name: 'Thanh Miễn Phí Vận Chuyển (Freeship)', desc: 'Thanh tiến độ freeship trong cart drawer và trang giỏ', qaPoint: 'Cập nhật ngay sau thêm/xoá sản phẩm, số tiền VNĐ không bị nhân hoặc chia 100', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-07', code: 'CRT-07', name: 'Badge Số Lượng Giỏ Đồng Bộ', desc: 'Badge header, mobile dock và cart drawer cùng đổi sau thêm/sửa/xoá', qaPoint: 'Thêm 3 món: mọi badge hiện 3 ngay, không reload; body /cart/*.js khớp Content-Type', page: 'cart', pathHint: '/cart', done: false },

  // 5. TRANG BÀI VIẾT & BLOG (BLOG)
  { id: 'blg-01', code: 'BLG-01', name: 'Danh Sách Bài Viết (Blog Listing)', desc: 'Lưới bài viết, ảnh cover, tiêu đề, ngày đăng, phân trang', qaPoint: 'Ảnh bài viết đồng bộ tỷ lệ, không bị méo lệch khung', page: 'blog', pathHint: '/blogs/news', done: false },
  { id: 'blg-02', code: 'BLG-02', name: 'Chi Tiết Bài Viết (Article Detail)', desc: 'Tiêu đề H1, tác giả, ngày đăng, tags, nội dung bài viết', qaPoint: 'Typography chuẩn, ảnh trong bài tự co giãn 100%', page: 'blog', pathHint: '/blogs/news', done: false },
  { id: 'blg-03', code: 'BLG-03', name: 'Khung Bình Luận Bài Viết (Comments)', desc: 'Danh sách bình luận + form gửi bình luận (Tên, Email, Lời nhắn)', qaPoint: 'Form gửi bình luận có thông báo thành công / chờ duyệt', page: 'blog', pathHint: '/blogs/news', done: false },
  { id: 'blg-04', code: 'BLG-04', name: 'Sidebar Chuyên Mục & Top Bài Viết', desc: 'Danh mục tin, bài viết xem nhiều, bài liên quan', qaPoint: 'Link chính xác, mobile ẩn sidebar gọn gàng cuối bài', page: 'blog', pathHint: '/blogs/news', done: false },

  // 6. TRANG TÀI KHOẢN (ACCOUNT)
  { id: 'acc-01', code: 'ACC-01', name: 'Form Đăng Nhập & Quên Mật Khẩu', desc: 'Form email/mật khẩu, link chuyển sang khung Quên MK tức thì', qaPoint: 'Báo lỗi rõ ràng khi sai thông tin, gửi mail khôi phục OK', page: 'account', pathHint: '/account/login', done: false },
  { id: 'acc-02', code: 'ACC-02', name: 'Form Đăng Ký Tài Khoản Mới', desc: 'Form đăng ký: Họ tên, Email, SĐT, Mật khẩu', qaPoint: 'Validate định dạng email và độ dài mật khẩu trước submit', page: 'account', pathHint: '/account/register', done: false },
  { id: 'acc-03', code: 'ACC-03', name: 'Bảng Điều Khiển & Lịch Sử Đơn Hàng', desc: 'Thông tin cá nhân, danh sách đơn hàng, trạng thái giao', qaPoint: 'Khách chưa đăng nhập vào /account tự chuyển về /account/login', page: 'account', pathHint: '/account', done: false },
  { id: 'acc-04', code: 'ACC-04', name: 'Sổ Địa Chỉ Giao Hàng (Addresses)', desc: 'Danh sách địa chỉ, form Thêm/Sửa/Xóa địa chỉ', qaPoint: 'Xóa địa chỉ có popup xác nhận, cascade Tỉnh->Huyện', page: 'account', pathHint: '/account/addresses', done: false },

  // 7. TRANG PHỤ & HỆ THỐNG (PAGES)
  { id: 'sys-01', code: 'SYS-01', name: 'Trang Liên Hệ & Bản Đồ Showroom', desc: 'Form gửi liên hệ (Tên, Email, SĐT, Lời nhắn) + bản đồ Map', qaPoint: 'Form submit thành công có toast, SĐT bấm gọi được ngay', page: 'pages', pathHint: '/pages/lien-he', done: false },
  { id: 'sys-02', code: 'SYS-02', name: 'Trang Giới Thiệu & Chính Sách Shop', desc: 'Trang nội dung tĩnh, quy định đổi trả, bảo hành', qaPoint: 'Trình bày sạch sẽ, bảng biểu responsive không vỡ khung', page: 'pages', pathHint: '/pages/gioi-thieu', done: false },
  { id: 'sys-03', code: 'SYS-03', name: 'Trang Tìm Kiếm Sản Phẩm (/search)', desc: 'Thanh tìm kiếm, đếm số kết quả tìm thấy, lưới sản phẩm', qaPoint: 'Tìm không ra kết quả có gợi ý từ khóa hoặc SP nổi bật', page: 'pages', pathHint: '/search', done: false },
  { id: 'sys-04', code: 'SYS-04', name: 'Popup Xem Nhanh Sản Phẩm (Quickview)', desc: 'Modal xem nhanh ảnh, swatch, giá, nút mua từ danh mục', qaPoint: 'Nút ESC / dấu x đóng mượt, chọn biến thể chuẩn xác', page: 'pages', pathHint: '/collections/all', done: false },
  { id: 'sys-05', code: 'SYS-05', name: 'Trang Lỗi 404 Không Tìm Thấy', desc: 'Giao diện 404 thân thiện, nút Quay lại trang chủ, thanh tìm kiếm', qaPoint: 'Không để trang trắng trơn, không lỗi vỡ header/footer', page: 'pages', pathHint: '/antifan-404-probe', done: false },
  { id: 'sys-06', code: 'SYS-06', name: 'Form Liên Hệ / Đặt Lịch Gửi Đủ Dữ Liệu', desc: 'Form chỉ dùng field backend nhận (Haravan: contact[name|email|phone|body]); field thêm như dịch vụ, ngày hẹn gộp vào nội dung', qaPoint: 'Gửi thử thấy đủ thông tin trong email shop; tải lại trang không tự bung modal lỗi cũ; trang nhiều form không lỗi recaptchaElm', page: 'pages', pathHint: '/pages/lien-he', done: false },
  { id: 'sys-07', code: 'SYS-07', name: 'Canonical & Breadcrumb Mọi Route', desc: 'Phân trang ?page=N, tìm kiếm, tag, 404, trang tài khoản con', qaPoint: 'Canonical trỏ đúng trang N; breadcrumb đủ cấp (search có từ khoá, tag có danh mục cha); link nội bộ không ra 404', page: 'pages', pathHint: '/search', done: false },

  // 8. NGHIỆM THU & QA (QA GATE)
  { id: 'qag-01', code: 'QAG-01', name: 'Responsive 375px Không Tràn Ngang', desc: 'Dùng thanh Thử Viewport 375px duyệt toàn bộ các trang', qaPoint: 'Tuyệt đối không có phần tử nào gây scrollbar ngang', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-02', code: 'QAG-02', name: 'Kiểm Tra Trạng Thái Trống (Empty State)', desc: 'Test danh mục không có SP, giỏ rỗng, tìm kiếm không ra', qaPoint: 'Layout không bị sập hay méo khung khi dữ liệu trống', page: 'qa-gate', pathHint: '/collections/all', done: false },
  { id: 'qag-03', code: 'QAG-03', name: '0 Lỗi Đỏ Console JS & 0 Ảnh Hỏng 404', desc: 'Mở DevTools Console kiểm tra toàn bộ các trang', qaPoint: 'Không có Uncaught TypeError, không có tài nguyên 404', page: 'qa-gate', pathHint: '/', done: false },
  {
    id: 'qag-04',
    code: 'QAG-04',
    name: 'Kiểm Tra Cấu Hình Theme Settings',
    desc: (themeMode === 'legacy')
      ? 'Validate settings.html controls, duplicate names, and upload asset_url references via theme.settings_check.'
      : 'Validate settings_schema.json definitions and Liquid bindings via theme.settings_check.',
    description: (themeMode === 'legacy')
      ? 'Validate settings.html controls, duplicate names, and upload asset_url references via theme.settings_check.'
      : 'Validate settings_schema.json definitions and Liquid bindings via theme.settings_check.',
    action: 'theme.settings_check',
    qaPoint: 'Mọi setting đều có tác dụng ngoài storefront, không setting rác',
    page: 'qa-gate',
    pathHint: '/',
    done: false,
  },
  { id: 'qag-05', code: 'QAG-05', name: 'Không Sót Thương Hiệu Theme Base', desc: 'Quét tên, slug, email, URL ảnh của shop cũ trong code, settings_data và ZIP export', qaPoint: 'npm run residue:scan -- --brand <base> ra 0 finding (không phân biệt hoa thường, quét cả ZIP)', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-06', code: 'QAG-06', name: 'Cú Pháp Liquid Đúng Nền Tảng', desc: 'Haravan: include thay render, không schema trong section, img_url thay image_url, không continue', qaPoint: 'npm run lint:haravan không còn blocker (hit nào giữ lại phải có bằng chứng render live), không trang nào lỗi Liquid/500', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-07', code: 'QAG-07', name: 'Responsive Đo Thật 7 Mốc 320-2560', desc: 'theme.qa_validate với multiBreakpoint: true và anti.inspect.responsive_matrix', qaPoint: 'summary.responsive không phải UNMEASURED, 320/375/768/1024/1440/1920/2560 không tràn ngang', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-08', code: 'QAG-08', name: 'Tiếng Việt Không Bị Cắt Dấu', desc: 'Tiêu đề serif/display, giá tiền, nút, menu', qaPoint: 'Line-height tiêu đề tối thiểu 1.18, dấu tiếng Việt không bị cắt ở dòng đầu/cuối', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-09', code: 'QAG-09', name: 'Bẫy Focus Modal, Drawer & Cổng Tuổi', desc: 'Cart drawer, menu mobile, tìm kiếm, xem nhanh, cổng xác nhận 18+', qaPoint: 'Mở: focus vào trong, Tab không thoát ra nền (inert). Đóng hoặc ESC: focus trả về nút mở', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-10', code: 'QAG-10', name: 'SEO & A11y Cơ Bản', desc: 'Một H1, heading không nhảy cấp, alt, label, accessible name, canonical, OG, JSON-LD, html lang', qaPoint: 'summary.domSemantics không critical, aria-label và placeholder viết tiếng Việt', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-11', code: 'QAG-11', name: 'Hover & Motion Đo Thật', desc: 'Hover thẻ, nút, menu; reveal khi cuộn; slider', qaPoint: 'Hover đo bằng anti.trace.interaction (CDP thật, :hover bật), CLS dưới 0.1 khi cuộn từ đầu trang', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-12', code: 'QAG-12', name: 'Đồng Bộ Giá Trị Customizer', desc: 'Nội dung merchant thấy lấy từ settings, không fallback cứng, không entity thô (&bull;)', qaPoint: 'Sửa trong Customizer hiện đúng ngoài storefront; chưa lên live thì ghi QA_PENDING_SYNC, không tự sửa settings_data.json', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-13', code: 'QAG-13', name: 'Header Dải Laptop 1200-1399', desc: 'Đo bounding box menu và cụm action ở 1200, 1280, 1366', qaPoint: 'Menu không đè tìm kiếm/giỏ/CTA, không rớt dòng; dropdown trong header sticky có backdrop-filter vẫn đúng vị trí', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-14', code: 'QAG-14', name: 'Phần Tử Cố Định Đáy Không Va Chạm', desc: 'Sticky ATC, mobile dock, float social, back-to-top; reveal khi cuộn', qaPoint: 'Khi sticky ATC hiện, float social/back-to-top đẩy lên trên; hiệu ứng trượt từ phải không làm tràn ngang 375px lúc vừa tải', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-15', code: 'QAG-15', name: 'Focus Bàn Phím Nhìn Thấy', desc: 'Tab qua link, nút, input, swatch trên mọi trang', qaPoint: 'Luôn thấy chỉ báo focus; outline: none chỉ hợp lệ khi cùng rule có box-shadow hoặc border thay thế', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-16', code: 'QAG-16', name: 'Gói Bàn Giao Không Lộ Bí Mật', desc: 'Quét assets/ và ZIP: token, API key, manifest có OSSAccessKeyId, đường dẫn máy local', qaPoint: '0 hit; assets/ public trên CDN nên file nhạy cảm phải xoá khỏi theme, không chỉ khỏi ZIP', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-17', code: 'QAG-17', name: 'Đo Trên Bản Đã Đồng Bộ', desc: 'Asset trong DOM thuộc /themes/<shop>/<theme_id>/ của theme đang sửa (?themeid=)', qaPoint: 'Sửa trên disk chưa sync lên theme thì ghi QA_PENDING_SYNC, không tick; không tự chạy lệnh haravan', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-18', code: 'QAG-18', name: 'Handle Trong Settings Resolve Thật', desc: 'Mọi setting page/collection/blog/link_list trong settings_schema.json: lấy handle đang lưu trong settings_data.json rồi mở trên storefront', qaPoint: '/pages/<handle> trả 200 và có nội dung, collection có sản phẩm, blog có bài, menu có link; handle rỗng hoặc 404 làm theme ẩn khối im lặng nên phải ghi rõ chủ đích hay thiếu. Thiếu page thì tạo trong Admin, không sửa code', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-19', code: 'QAG-19', name: 'Thuộc Tính hidden Ẩn Thật', desc: 'Phần tử mang [hidden] (nút Nhận thông báo, badge, panel trạng thái) không bị class display: flex/inline-flex/grid làm hiện lại', qaPoint: 'qa-probes.js (skill theme-qa-az) trả hiddenViolations rỗng; component tự đặt display phải có rule [hidden] { display: none }; npm run lint:haravan không còn MISSING_HIDDEN_ATTRIBUTE_OVERRIDE', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-20', code: 'QAG-20', name: 'Section Trong Hợp Đồng Hiển Thị Thật', desc: 'Mọi section trong FULL_REMAKE_CONTRACT/thiết kế có mặt và có kích thước ở 375px và 1440px (Flash Sale, deal, rails, banner)', qaPoint: 'qa-probes.js: sections không có mục failed (width/height > 0, display khác none). Section ẩn vì collection rỗng hoặc đếm ngược hết hạn thì trỏ setting sang nguồn có dữ liệu; theme.qa_validate PASS không thay được bước này', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-21', code: 'QAG-21', name: 'Control Bấm Được Bằng Click Thật', desc: 'Cart drawer, menu mobile, xem nhanh, sticky ATC và nút trong modal thao tác bằng anti.agent.cursor.click theo toạ độ getBoundingClientRect sau scrollIntoView', qaPoint: 'qa-probes.js: occluded và zeroBox rỗng (elementFromPoint tại tâm trúng chính control, icon SVG không co về 0x0); overlay không đè panel cùng wrapper; grid chứa Swiper dùng minmax(0, 1fr). .click() bằng JS không tính là bằng chứng', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-22', code: 'QAG-22', name: 'Schema Settings Sạch', desc: 'Chạy audit-settings-schema.mjs (skill haravan-settings-schema) trên config/settings_schema.json', qaPoint: '0 error: đúng 2 setting màu (primary/secondary), nhóm Thiết lập chung chỉ chứa thiết lập hệ thống, không setting chết hay chuỗi SEO/aria/JS thừa, image_picker không trỏ CDN của theme id khác', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-23', code: 'QAG-23', name: 'Vòng Đời Overlay Toàn Cục (OPEN -> INTERACT -> CLOSE)', desc: 'Mở/đóng thật mọi modal, drawer, dropdown: Quickview, Cart Drawer, Search Modal, Mobile Menu, Megamenu, Filter Drawer, Sort Dropdown, Share/Size Guide Modal', qaPoint: 'Khi mở: opacity >= 0.95, visibility: visible, pointer-events: auto, rect >= 200x120. Khi đóng (nút X, backdrop, Escape): body overflow != hidden và phần tử nền bấm lại được', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-24', code: 'QAG-24', name: 'Header Khi Cuộn & Cụm Nút Nổi Đáy (scrollY = 600)', desc: 'Cuộn trang xuống scrollY = 600 tại 375px, 1024px, 1280px, 1440px để kích hoạt .is-scrolled và sticky ATC', qaPoint: 'Header .is-scrolled không rớt dòng/tràn chữ (scrollWidth <= clientWidth + 2); nút nổi đáy (.fab-chat, .back-to-top) không đè lên .sticky-atc, .compare-bar hay .mobile-bottom-nav', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-25', code: 'QAG-25', name: 'Căn Lề Trái Container & Custom Element Block', desc: 'Đo toạ độ left của .container giữa header, breadcrumb, product main và các section cùng trang; kiểm tra custom element có child block', qaPoint: 'Độ lệch left giữa các .container <= 2px ở 1024px và 1440px (không trộn vw và %); ở 1920px và 2560px tiêu đề, đoạn chữ và CTA của section không lệch trái khỏi hộp nội dung của container (finding content-drift); custom element có con block phải khai báo display: block/flex/grid (getBoundingClientRect().height > 0)', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-26', code: 'QAG-26', name: 'Không Rớt Chữ Mồ Côi & Dải Metadata Cân Đối', desc: 'Kiểm tra nút CTA, pill/tab, nav link, form submit và các dải USP/trust-badge/spec-bar/countdown tại 375px, 768px, 1024px, 1440px', qaPoint: 'Nút/tab/link không bị bẻ xuống dòng 1 từ ngắn mồ côi (<= 5 ký tự ở dòng cuối, WARN); dải metadata cùng hàng chênh cao <= 1.8x và không tràn chữ qua overflow-x: hidden', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-27', code: 'QAG-27', name: 'Mật Độ Thẻ Ngang Mobile (Scroll-Snap Peek 375px)', desc: 'Kiểm tra các dải cuộn ngang trên mobile 375px (tabs sản phẩm, danh mục, flash sale, sản phẩm liên quan)', qaPoint: 'Tại 375px hiện từ 1.15 đến 2.2 thẻ mỗi hàng (rộng ~160px-280px) để lộ mép thẻ kế tiếp gợi ý vuốt ngang; tránh thẻ full-width 100% bắt cuộn dọc dài hoặc nhồi >= 3 thẻ quá hẹp (< 130px)', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-28', code: 'QAG-28', name: 'Độ Toàn Vẹn Giá Trị Settings Data & Image Picker URL', desc: 'Kiểm tra mọi image_picker, select/radio default & value trong settings_schema.json + settings_data.json và fallback cứng trong Liquid', qaPoint: 'Mọi image_picker khác rỗng là full https:// URL (không phải tên file trần), có default hợp lệ trong schema, select value khớp options[].value, và Liquid không chứa | default: hay {% else %} chữ/link cứng', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-29', code: 'QAG-29', name: 'Thang Chữ & Vùng Bấm Mobile (<= 768px)', desc: 'Đo font-size thật của mọi chữ hiển thị, vùng bấm thật (tính cả pseudo-element) và chiều cao của control cùng vai trò (nút, input, select, tab, pill) tại 320px, 375px và 768px', qaPoint: 'Chữ >= 12px (rem quy ra px theo root font thật của mobile), vùng bấm >= 24px (WCAG 2.2 SC 2.5.8), control cùng vai trò trong một hàng cao bằng nhau; không ép chiều cao tối thiểu; ngưỡng đọc từ hợp đồng typeScale, ngoại lệ phải có trong QA_WAIVERS.json', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-30', code: 'QAG-30', name: 'Root Font Không Co Nhỏ Trên Mobile', desc: 'Đọc html { font-size } ở mọi breakpoint và mọi giá trị rem/em đang dùng trong CSS theme', qaPoint: 'Root font mobile không nhỏ hơn mobileRootFontPx của hợp đồng; không ép html font-size bằng % hay vw; mỗi rem quy ra px thật vẫn >= 12px (npm run lint:haravan không còn CSS_ROOT_FONT_SHRINK)', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-31', code: 'QAG-31', name: 'Hệ Icon Thống Nhất Một Nét Một viewBox', desc: 'Mọi SVG icon ở header, thẻ sản phẩm, drawer, footer, trạng thái rỗng', qaPoint: 'Cùng stroke-width và cùng viewBox gốc trong một họ icon, stroke/fill dùng currentColor, icon không co về 0x0; không trộn icon font, emoji và SVG trong cùng một cụm nút', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-32', code: 'QAG-32', name: 'Nội Dung Rich Text Từ Admin (RTE)', desc: 'Mô tả sản phẩm, bài viết, trang chính sách có bảng, ảnh, iframe, danh sách, heading do merchant soạn trong Admin', qaPoint: 'Bảng cuộn ngang trong khung riêng, ảnh/iframe không vượt 100% bề rộng khung, danh sách giữ marker và thụt lề, không có phần tử nào gây scrollbar ngang ở 375px, link trong nội dung nhìn phân biệt được', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-33', code: 'QAG-33', name: 'Phạm Vi Biến Của include/snippet', desc: 'Haravan include dùng chung scope với template gọi: kiểm mọi snippet nhận tham số (product-card, swatch, quickview, vòng lặp sản phẩm)', qaPoint: 'Snippet chỉ đọc biến được truyền vào, không fallback ngầm sang product/collection của trang cha; assign trong snippet không trùng tên biến trang cha; sau include biến của trang cha giữ nguyên giá trị; cùng thẻ render giống nhau trong vòng lặp, quickview và trang riêng', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-34', code: 'QAG-34', name: 'Biến Thể Đổi Ảnh Đúng (Variant -> Image)', desc: 'Chọn lần lượt từng màu/biến thể trên PDP, quickview và thẻ sản phẩm; đọc /products/<handle>.js', qaPoint: 'Mỗi biến thể màu có featured_image riêng và gallery nhảy đúng ảnh đó; 0 biến thể màu thiếu featured_image; tên màu resolve được trong settings, không rơi im lặng về ảnh đầu hay ô màu mặc định', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-35', code: 'QAG-35', name: 'Trạng Thái Tắt (OFF) Của Toggle Settings', desc: 'Với mọi checkbox/toggle trong settings_schema.json: đặt OFF rồi tải lại storefront', qaPoint: 'Tắt toggle cha thì setting con phụ thuộc bị ẩn hoặc vô hiệu trong Customizer và khối ngoài storefront biến mất hẳn (không DOM rỗng, không khoảng trống, không CSS mồ côi); không lỗi console ở trạng thái OFF', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-36', code: 'QAG-36', name: 'Overlay Vừa Khung Nhìn', desc: 'Modal, drawer, dropdown, megamenu, popup tại 320x568, 375x667, 768x1024 và khi bàn phím ảo mở', qaPoint: 'Panel có max-height theo viewport (dvh/vh) và cuộn bên trong; nút đóng và CTA chính luôn nằm trong khung nhìn, không bị cắt đáy hoặc đỉnh, không làm body tràn ngang hay cuộn nền', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-37', code: 'QAG-37', name: 'Link Xếp Chồng Không Đè Vùng Bấm', desc: 'Danh sách link menu, footer, thẻ, breadcrumb xếp dọc: đo getBoundingClientRect từng link rồi elementFromPoint tại tâm', qaPoint: 'Vùng bấm của hai link liền kề không chồng nhau (line-height hay margin âm, ::before/::after phóng to); tâm mỗi link trúng đúng link đó; khoảng cách giữa các tâm >= 24px', page: 'qa-gate', pathHint: '/', done: false },
].map((item) => ({ ...item, ...MEASURED_BY[item.id] }));

/**
 * Scope marker for a storefront whose workspace could not be resolved. Kept
 * distinct from a resolved scope so a bare-origin key never silently mixes two
 * projects, and so the report states which storefront was actually measured.
 */
export const UNKNOWN_WORKSPACE_TAG = 'unknown-workspace';
/** How long the checklist waits for the workspace identity before giving up on it. */
export const WORKSPACE_IDENTIFY_TIMEOUT_MS = 1500;

/**
 * A live product page. Haravan/Sapo/Shopify serve PDPs only at `/products/<handle>`,
 * so this is the sole route that can be trusted as "the product page".
 */
export const PRODUCT_PAGE_PATH = /\/products\/[^/?#]+/;
export const ARTICLE_PAGE_PATH = /\/(?:blogs\/[^/?#]+\/|articles\/)[^/?#]+/;
/**
 * Storage-safe identity for a theme workspace: readable leaf plus a stable path
 * hash. The path is normalized first — Windows reports the same project as
 * `E:\Work\Themes\Shop` or `e:/work/themes/shop`, and a case-split hash would file
 * two scopes for one project.
 */
export function workspaceTag(workspacePath?: string): string {
  const normalized = (workspacePath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalized) return '';
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  const leaf = normalized.split('/').pop() ?? '';
  const slug = leaf.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `${slug || 'workspace'}-${hash.toString(36)}`;
}

/**
 * Checklist scope for one storefront origin inside one workspace. `tag` may be
 * empty — that yields the unknown-workspace scope, which the store treats as
 * provisional (in-memory only, never persisted).
 */
export function checklistScope(origin: string, tag?: string): string {
  return `${origin || 'unbound'}@${tag || UNKNOWN_WORKSPACE_TAG}`;
}

/**
 * The progress report both the toolbar export button and `theme.cockpit_report`
 * render: identical structure so a diff between surfaces is impossible.
 */
export function buildChecklistReport(
  scope: string,
  items: ThemeChecklistItem[],
  settingsSummary?: {
    ok: boolean;
    newFailures: number;
    legacyDebt: number;
    topViolations?: Array<{ rule: string; id?: string; file: string; line?: number; message?: string }>;
  }
): string {
  const total = items.length;
  const doneCount = items.filter((it) => it.done).length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const standardPages = ['home', 'collection', 'product', 'cart', 'blog', 'account', 'pages', 'qa-gate'];
  const customPages = Array.from(new Set(items.map((it) => it.page).filter((p) => !standardPages.includes(p))));
  const pageKeys = [...standardPages, ...customPages];
  const lines: string[] = [];
  lines.push(`# BÁO CÁO TIẾN ĐỘ THEME & QA STOREFRONT (AntiFan Theme Studio)`);
  lines.push(`- **Thời gian xuất:** ${new Date().toLocaleString('vi-VN')}`);
  lines.push(`- **Storefront đang đo:** ${scope}`);
  lines.push(`- **Tổng tiến độ:** ${doneCount}/${total} mục (${percent}%)`);
  lines.push(`- **Đánh giá tổng thể:** ${percent === 100 ? '✅ SẴN SÀNG NGHIỆM THU / HANDOFF' : percent >= 80 ? '🟡 ĐANG HOÀN THIỆN (GẦN XONG)' : '🔴 ĐANG PHÁT TRIỂN'}`);
  lines.push(`- **Phạm vi bằng chứng:** ${QA_GATE_DISCLAIMER}`);
  if (settingsSummary) {
    lines.push(`- **Cấu hình Theme Settings:** ${settingsSummary.ok ? '✅ Hợp lệ' : '❌ Có lỗi mới'} (Lỗi mới: ${settingsSummary.newFailures}, Nợ cũ: ${settingsSummary.legacyDebt})`);
  }
  lines.push('');

  pageKeys.forEach((key) => {
    const pItems = items.filter((it) => it.page === key);
    const pDef = PAGE_DEFS[key] || { title: key, badge: key.toUpperCase(), icon: '📄', path: '/' };
    const pDone = pItems.filter((it) => it.done).length;
    const pTotal = pItems.length;
    const pPct = pTotal > 0 ? Math.round((pDone / pTotal) * 100) : 0;

    lines.push(`### ${pDef.icon} ${pDef.title} (${pDone}/${pTotal} - ${pPct}%)`);
    pItems.forEach((it) => {
      lines.push(`- [${it.done ? 'x' : ' '}] **[${it.code}]** ${it.name} - *${it.desc}* (🎯 QA: ${it.qaPoint})`);
    });
    lines.push('');
  });

  return lines.join('\n');
}
