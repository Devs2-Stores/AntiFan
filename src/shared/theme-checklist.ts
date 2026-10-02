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
 * Every completion claim carries this, so a 44/44 checklist never reads as more
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
  'qa-gate': {
    title: 'Nghiệm Thu Cổng Chất Lượng & QA Storefront (Responsive 375px, 0 Lỗi Console, Empty State, Settings)',
    badge: 'QA GATE',
    icon: '🎯',
    path: '/',
    note: QA_GATE_DISCLAIMER,
  },
};

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

  // 2. TRANG DANH MỤC (COLLECTION)
  { id: 'col-01', code: 'COL-01', name: 'Banner Đầu Trang & Breadcrumb', desc: 'Thanh điều hướng Trang chủ > Danh mục, ảnh cover danh mục', qaPoint: 'Breadcrumb có cấu trúc schema, không lặp tiêu đề', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-02', code: 'COL-02', name: 'Bộ Lọc Sản Phẩm Đa Năng (Filter)', desc: 'Lọc theo giá, màu sắc, kích thước, thương hiệu, tag', qaPoint: 'Lọc AJAX không reload trang, URL cập nhật query param', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-03', code: 'COL-03', name: 'Bộ Sắp Xếp Sản Phẩm (Sort)', desc: 'Xếp theo: Giá tăng/giảm, Mới nhất, Bán chạy, Tên A-Z', qaPoint: 'Đổi sắp xếp giữ nguyên điều kiện bộ lọc đang chọn', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-04', code: 'COL-04', name: 'Lưới Sản Phẩm Đều Khung (Grid)', desc: 'Hiển thị 2 cột (mobile), 3-4 cột (desktop), nút mua thẳng hàng', qaPoint: 'Thẻ sản phẩm cao bằng nhau, nút mua không bị thụt thò', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-05', code: 'COL-05', name: 'Phân Trang & Nút Xem Thêm', desc: 'Phân trang 1, 2, 3... hoặc nút Xem thêm / Cuộn vô tận', qaPoint: 'Trang cuối cùng không lặp sản phẩm, cuộn mượt không giật', page: 'collection', pathHint: '/collections/all', done: false },
  { id: 'col-06', code: 'COL-06', name: 'Trạng Thái Bộ Lọc Trống (Empty Filter)', desc: 'Thông báo "Không tìm thấy sản phẩm" + nút Xóa bộ lọc', qaPoint: 'Bấm Xóa bộ lọc khôi phục lại danh mục bình thường', page: 'collection', pathHint: '/collections/all', done: false },

  // 3. TRANG CHI TIẾT SẢN PHẨM (PRODUCT / PDP)
  { id: 'pdp-01', code: 'PDP-01', name: 'Thư Viện Ảnh & Phóng To (Gallery & Zoom)', desc: 'Slider ảnh to + thumbnail nhỏ, zoom hover, lightbox', qaPoint: 'Đổi màu swatch thì ảnh to tự nhảy sang đúng màu tương ứng', page: 'product', done: false },
  { id: 'pdp-02', code: 'PDP-02', name: 'Tiêu Đề, Mã SKU & Đánh Giá Sao', desc: 'Tên sản phẩm H1, SKU, tình trạng kho, đánh giá sao', qaPoint: 'Đổi biến thể cập nhật đúng SKU và trạng thái còn hàng', page: 'product', done: false },
  { id: 'pdp-03', code: 'PDP-03', name: 'Khối Giá Bán, Giá Gạch & % Giảm', desc: 'Giá bán, giá so sánh gạch ngang, % tiết kiệm, sale badge', qaPoint: 'Định dạng tiền VNĐ chuẩn (100.000₫), không lỗi NaN', page: 'product', done: false },
  { id: 'pdp-04', code: 'PDP-04', name: 'Bộ Chọn Biến Thể (Variant Swatch)', desc: 'Swatch màu sắc (có ảnh/màu hex), kích thước (S/M/L)', qaPoint: 'Biến thể hết hàng bị gạch mờ, chặn bấm mua biến thể lỗi', page: 'product', done: false },
  { id: 'pdp-05', code: 'PDP-05', name: 'Số Lượng & Nút Thêm Giỏ / Mua Ngay', desc: 'Nút +/- số lượng, Thêm vào giỏ, Mua ngay chuyển checkout', qaPoint: 'Thêm giỏ AJAX không reload, cập nhật số lượng tức thì', page: 'product', done: false },
  { id: 'pdp-06', code: 'PDP-06', name: 'Thanh Mua Hàng Dính Đáy (Sticky ATC)', desc: 'Thanh dính đáy màn hình khi cuộn qua nút mua chính', qaPoint: 'Hiển thị mượt mà trên mobile & desktop, không che nội dung', page: 'product', done: false },
  { id: 'pdp-07', code: 'PDP-07', name: 'Tabs Chi Tiết Mô Tả & Thông Số', desc: 'Tab Mô tả chi tiết, Thông số kỹ thuật, Chính sách đổi trả', qaPoint: 'Bảng biểu không gây tràn ngang (overflow) trên mobile 375px', page: 'product', done: false },
  { id: 'pdp-08', code: 'PDP-08', name: 'Sản Phẩm Gợi Ý / Cùng Chuyên Mục', desc: 'Lưới sản phẩm liên quan hoặc sản phẩm vừa xem', qaPoint: 'Không gợi ý trùng chính sản phẩm đang xem', page: 'product', done: false },

  // 4. TRANG GIỎ HÀNG (CART)
  { id: 'crt-01', code: 'CRT-01', name: 'Mini Cart Drawer Trượt Phải (AJAX)', desc: 'Ngăn kéo giỏ hàng trượt từ phải sang khi thêm sản phẩm', qaPoint: 'Mở/đóng mượt mà, bấm backdrop mờ tự đóng', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-02', code: 'CRT-02', name: 'Trang Giỏ Hàng Đầy Đủ (/cart)', desc: 'Bảng sản phẩm, ảnh, tên, đơn giá, số lượng, thành tiền, nút xóa', qaPoint: 'Tăng giảm số lượng tính lại tổng tiền AJAX, không reload', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-03', code: 'CRT-03', name: 'Ghi Chú Đơn Hàng & Mã Khuyến Mãi', desc: 'Khung nhập ghi chú gửi shop, nhập voucher giảm giá', qaPoint: 'Ghi chú lưu đúng vào thuộc tính note của đơn hàng', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-04', code: 'CRT-04', name: 'Nút Tiến Hành Thanh Toán (Checkout)', desc: 'Nút nổi bật chuyển khách sang trang thanh toán bảo mật', qaPoint: 'Không bị disabled khi giỏ hàng có sản phẩm hợp lệ', page: 'cart', pathHint: '/cart', done: false },
  { id: 'crt-05', code: 'CRT-05', name: 'Trạng Thái Giỏ Hàng Trống (Empty Cart)', desc: 'Icon giỏ rỗng + câu thông báo + nút Tiếp tục mua sắm', qaPoint: 'Xóa hết món chuyển ngay sang Empty Cart không sót bảng cũ', page: 'cart', pathHint: '/cart', done: false },

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

  // 8. NGHIỆM THU & QA (QA GATE)
  { id: 'qag-01', code: 'QAG-01', name: 'Responsive 375px Không Tràn Ngang', desc: 'Dùng thanh Thử Viewport 375px duyệt toàn bộ các trang', qaPoint: 'Tuyệt đối không có phần tử nào gây scrollbar ngang', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-02', code: 'QAG-02', name: 'Kiểm Tra Trạng Thái Trống (Empty State)', desc: 'Test danh mục không có SP, giỏ rỗng, tìm kiếm không ra', qaPoint: 'Layout không bị sập hay méo khung khi dữ liệu trống', page: 'qa-gate', pathHint: '/collections/all', done: false },
  { id: 'qag-03', code: 'QAG-03', name: '0 Lỗi Đỏ Console JS & 0 Ảnh Hỏng 404', desc: 'Mở DevTools Console kiểm tra toàn bộ các trang', qaPoint: 'Không có Uncaught TypeError, không có tài nguyên 404', page: 'qa-gate', pathHint: '/', done: false },
  { id: 'qag-04', code: 'QAG-04', name: 'Kiểm Tra Cấu Hình Theme Settings', desc: 'Bật/tắt các setting trong theme admin (settings_schema.json)', qaPoint: 'Mọi setting đều có tác dụng ngoài storefront, không setting rác', page: 'qa-gate', pathHint: '/', done: false },
];

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
export function buildChecklistReport(scope: string, items: ThemeChecklistItem[]): string {
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
