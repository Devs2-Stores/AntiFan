/**
 * AntiFan Browser Desktop — Toolbar Client Script
 * Classic Antigravity Browser UI Logic (Original VS Code Dark Theme).
 */

interface AntiFanTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  devicePresetId?: string;
  crashed?: boolean;
  isAudible?: boolean;
  isMuted?: boolean;
  scrollX?: number;
  scrollY?: number;
  aiState?: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working';
  isAgentControlled?: boolean;
  themeError?: string | null;
  terminalSessionId?: string;
  ephemeral?: boolean;
  splitMode?: boolean;
  splitDesktopPresetId?: string;
  splitMobilePresetId?: string;
  splitFocusedPane?: 'desktop' | 'mobile';
  splitError?: string;
  alias?: string;
  role?: string;
  aliasColor?: string;
}
interface ThemeQaState { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: Record<string, unknown>; error?: string; updatedAt: number; }
interface ToolbarPhoneStatus {
  state: 'connected' | 'disconnected' | 'unknown';
  name?: string;
  model?: string;
  osVersion?: string;
  deviceId?: string;
  connection?: string;
  detail?: string;
  lastChecked?: number;
}
interface AntiFanToolbarApi {
  getInitialState: () => Promise<any>;
  createTab: (url?: string) => Promise<string>;
  switchTab: (tabId: string) => Promise<boolean>;
  setTabAlias: (tabId: string, alias?: string, role?: string, aliasColor?: string) => Promise<boolean>;
  closeTab: (tabId: string) => Promise<boolean>;
  moveTab: (tabId: string, toIndex: number) => Promise<boolean>;
  duplicateTab: (tabId: string) => Promise<string>;
  closeOtherTabs: (tabId: string) => Promise<void>;
  closeTabsToRight: (tabId: string) => Promise<void>;
  setTabTerminalSession: (tabId: string, terminalSessionId: string) => Promise<boolean>;
  rebindTerminalAffinity: (tabId?: string, terminalId?: string) => Promise<boolean>;
  navigate: (url: string, tabId?: string) => Promise<boolean>;
  reload: (tabId?: string) => Promise<boolean>;
  reloadWindow: () => Promise<boolean>;
  stopLoading: (tabId?: string) => Promise<boolean>;
  goBack: (tabId?: string) => Promise<boolean>;
  goForward: (tabId?: string) => Promise<boolean>;
  toggleInspect: () => Promise<boolean>;
  toggleFontFinder: () => Promise<boolean>;
  toggleLens: () => Promise<boolean>;
  toggleRuler: () => Promise<boolean>;
  toggleDevTools: () => Promise<void>;
  toggleSidebar: () => Promise<boolean>;
  setDevicePreset: (presetId: string, tabId?: string) => Promise<boolean>;
  setZoom: (zoom: number, tabId?: string) => Promise<boolean>;
  toggleMute: (tabId?: string) => Promise<boolean>;
  captureFullPage: () => Promise<string>;
  captureViewport: () => Promise<string>;
  openExternal: (url?: string) => Promise<boolean>;
  openInVSCode: () => Promise<{ ok: boolean; error?: string; workspacePath?: string }>;
  getBookmarks: () => Promise<any>;
  findInPage: (text: string, forward?: boolean, findNext?: boolean) => Promise<void>;
  stopFindInPage: () => Promise<void>;
  showMenu: () => Promise<void>;
  setOverlay: (active: boolean, customHeight?: number) => Promise<void>;
  getWorkflowState: () => Promise<{ tools: any[]; workflows: any[] }>;
  runWorkflow: (payload: { workflowId?: string; workflowDef?: any }) => Promise<any>;
  abortWorkflow: () => Promise<boolean>;
  saveWorkflow: (item: { id?: string; name: string; description?: string; steps: any[] }) => Promise<any>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  getWorkflowArtifact: (artifactId: string) => Promise<any>;
  onWorkflowEvent: (callback: (event: any) => void) => () => void;
  getCoreHealthState?: () => Promise<any>;
  getMcpDispatchState?: () => Promise<any>;
  getCoreTaskRunTrace?: (id: string) => Promise<any>;
  clearStorage: () => Promise<{ success: boolean; cleared: boolean; reason?: string; origin?: string }>;
  getChromeProfiles: () => Promise<any>;
  syncChromeProfile: (profileId: string) => Promise<any>;
  toggleBookmarkBar: () => Promise<boolean>;
  addBookmark: (title: string, url: string) => Promise<any>;
  removeBookmark: (url: string) => Promise<any>;
  exportSessionVault?: (customPath?: string) => Promise<{ success: boolean; count: number; filePath: string; error?: string }>;
  importSessionVault?: (customPath?: string) => Promise<{ success: boolean; importedCount: number; failedCount: number; error?: string }>;
  importSessionVaultJson?: (json: string) => Promise<{ success: boolean; importedCount: number; failedCount: number; error?: string }>;
  getVaultStats?: (customPath?: string) => Promise<{ exists: boolean; count: number; lastModified?: number; filePath: string }>;
  checkUpdates?: () => Promise<void>;
  isChromeRunning?: () => Promise<boolean>;
  popoutTerminal?: () => Promise<boolean>;
  getSuggestions: (query: string) => Promise<{ suggestions: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> }>;
  toggleSplitReview: (tabId?: string, enabled?: boolean) => Promise<boolean>;
  setSplitPreset: (paneId: 'desktop' | 'mobile', presetId: string, tabId?: string) => Promise<boolean>;
  setSplitFocusedPane: (paneId: 'desktop' | 'mobile', tabId?: string) => Promise<boolean>;
  onStateUpdated: (callback: (state: any) => void) => () => void;
  onElementPicked: (callback: (element: any) => void) => () => void;
  onFocusFind: (callback: () => void) => () => void;
  onFocusOmnibox: (callback: () => void) => () => void;
  onShowShortcuts: (callback: () => void) => () => void;
  onFindResult: (callback: (result: any) => void) => () => void;
  onScreenshotCaptured?: (callback: () => void) => () => void;
  runThemeQa: (options?: { workspaceRoot?: string }) => Promise<{ ok: boolean; report?: any; error?: string }>;
  /** Workspace the active storefront belongs to; read-only, no side effects. */
  identifyWorkspace?: () => Promise<{ workspacePath?: string }>;
  onThemeQaState: (callback: (state: ThemeQaState) => void) => () => void;
  getPhoneStatus?: (forceRefresh?: boolean) => Promise<ToolbarPhoneStatus>;
  onPhoneStatusChanged?: (callback: (status: ToolbarPhoneStatus) => void) => () => void;
}

declare global {
  interface Window {
    antifanToolbar?: AntiFanToolbarApi;
  }
}

function getApi(): AntiFanToolbarApi | undefined {
  return window.antifanToolbar;
}

/**
 * Overlay ownership: the toolbar WebContentsView is clipped to the strip height
 * unless the main process expands it via setOverlay. A single global boolean
 * meant any popup closing re-clipped every other open popup (last-closer-wins).
 * Tokens fix that: each popup acquires a token on open and releases it on
 * close; the view collapses only when the last token is released. Tokens carry
 * an optional customHeight — the active overlay height is the max requested.
 */
const overlayTokens = new Map<string, number | undefined>();
let overlaySyncQueued = false;

function acquireOverlay(token: string, customHeight?: number): void {
  overlayTokens.set(token, customHeight);
  syncOverlayState();
}

function releaseOverlay(token: string): void {
  if (!overlayTokens.delete(token)) return;
  syncOverlayState();
}

function syncOverlayState(): void {
  if (overlaySyncQueued) return;
  overlaySyncQueued = true;
  queueMicrotask(() => {
    overlaySyncQueued = false;
    if (overlayTokens.size === 0) {
      getApi()?.setOverlay(false);
      return;
    }
    let height: number | undefined;
    for (const h of overlayTokens.values()) {
      if (h === undefined) {
        height = undefined;
        break;
      }
      height = Math.max(height ?? 0, h);
    }
    getApi()?.setOverlay(true, height);
  });
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToolbarToast(message: string, duration = 2500) {
  const toast = document.getElementById('toolbarToast');
  if (!toast) return;
  toast.innerHTML = message;
  toast.style.display = 'flex';
  // Toast renders below the strip (top:76px) — it needs the view expanded or it
  // paints over toolbar buttons inside the 74px clip.
  acquireOverlay('toast', 40);
  if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
    releaseOverlay('toast');
    toastTimer = null;
  }, duration);
}

/**
 * Electron renderer has no window.prompt — this modal replaces it.
 * Resolves null on cancel/backdrop/Escape, string on OK/Enter.
 */
function showPromptDialog(title: string, initial = ''): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const overlay = document.getElementById('promptOverlay') as HTMLElement | null;
  const titleEl = document.getElementById('promptTitle');
  const input = document.getElementById('promptInput') as HTMLInputElement | null;
  const btnOk = document.getElementById('promptOk');
  const btnCancel = document.getElementById('promptCancel');
  if (!overlay || !input || !btnOk || !btnCancel) {
    resolve(null);
    return promise;
  }
  if (titleEl) titleEl.textContent = title;
  input.value = initial;
  overlay.style.display = 'flex';
  acquireOverlay('prompt');
  const done = (value: string | null) => {
    overlay.style.display = 'none';
    releaseOverlay('prompt');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
    // Clear handlers so the dismissed invocation's closures aren't retained on
    // the shared DOM buttons until the next prompt opens.
    btnOk.onclick = null;
    btnCancel.onclick = null;
    resolve(value);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
  };
  const onBackdrop = (e: MouseEvent) => { if (e.target === overlay) done(null); };
  btnOk.onclick = () => done(input.value);
  btnCancel.onclick = () => done(null);
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
  input.focus();
  input.select();
  return promise;
}
function renderThemeQa(state: ThemeQaState, report?: Record<string, unknown>) {
  themeQaState = state;
  if (report) {
    lastThemeQaReport = report;
  } else if (state.report) {
    lastThemeQaReport = state.report;
  }
  if (!btnThemeQa || !themeQaText) return;
  btnThemeQa.classList.remove('status-pass', 'status-fail');
  if (state.status === 'running') {
    themeQaText.textContent = 'Checking…';
    btnThemeQa.disabled = true;
  } else if (state.status === 'pass') {
    themeQaText.textContent = 'QA Clean';
    btnThemeQa.classList.add('status-pass');
    btnThemeQa.disabled = false;
  } else if (state.status === 'fail') {
    themeQaText.textContent = `${state.issueCount} Issues`;
    btnThemeQa.classList.add('status-fail');
    btnThemeQa.disabled = false;
  } else if (state.status === 'error') {
    themeQaText.textContent = 'QA Error';
    btnThemeQa.classList.add('status-fail');
    btnThemeQa.disabled = false;
  } else {
    themeQaText.textContent = 'QA';
    btnThemeQa.disabled = false;
  }
}
interface ThemeChecklistItem {
  id: string;
  code: string;
  name: string;
  desc: string;
  qaPoint: string;
  page: 'home' | 'collection' | 'product' | 'cart' | 'blog' | 'account' | 'pages' | 'qa-gate';
  pathHint?: string;
  done: boolean;
}

interface ThemePageDef {
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
const QA_GATE_DISCLAIMER =
  'Checklist là trạng thái dev tự khai; quét QA chỉ đo các trang tĩnh tại route đang mở — chưa chứng minh viewport mobile 375px, drawer trượt hay luồng AJAX/thêm giỏ động.';

const PAGE_DEFS: Record<string, ThemePageDef> = {
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

const DEFAULT_THEME_CHECKLIST: ThemeChecklistItem[] = [
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

const THEME_CHECKLIST_STORAGE_PREFIX = 'antifan_theme_checklist_state_v3';
let themeChecklist: ThemeChecklistItem[] = [];
let activePhaseFilter: string = 'all';
let checklistSearchQuery: string = '';
let activeThemeStudioTab: 'checklist' | 'findings' = 'checklist';
let activeChecklistScope: string = 'unbound';
/**
 * Scope marker for a storefront whose workspace could not be resolved. Kept
 * distinct from a resolved scope so a bare-origin key never silently mixes two
 * projects, and so the report states which storefront was actually measured.
 */
const UNKNOWN_WORKSPACE_TAG = 'unknown-workspace';
/** How long the checklist waits for the workspace identity before giving up on it. */
const WORKSPACE_IDENTIFY_TIMEOUT_MS = 1500;
/** Workspace tag for the storefront in front of the user; empty until it is known. */
let checklistWorkspaceTag = '';
/** Origin the current tag was resolved for, so a tab switch re-resolves it. */
let checklistWorkspaceResolvedFor = '';
let checklistWorkspacePending: Promise<void> | null = null;

/**
 * The storefront whose checklist is on screen. Progress is keyed by origin and by
 * the workspace that origin belongs to, so a second shop — or a second theme
 * project served on the same local port — never inherits the first one's ticks.
 */
function checklistOrigin(): string {
  const ordered = [currentTabs.find((tab) => tab.id === activeTabId), ...currentTabs];
  for (const tab of ordered) {
    if (!tab?.url) continue;
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch {
      // not a navigable origin — keep looking
    }
  }
  return 'unbound';
}

function checklistScope(): string {
  const origin = checklistOrigin();
  return `${origin}@${checklistWorkspaceTag || UNKNOWN_WORKSPACE_TAG}`;
}

/**
 * Storage-safe identity for a theme workspace: readable leaf plus a stable path
 * hash. The path is normalized first — Windows reports the same project as
 * `E:\Work\Themes\Shop` or `e:/work/themes/shop`, and a case-split hash would file
 * two scopes for one project.
 */
function workspaceTag(workspacePath?: string): string {
  const normalized = (workspacePath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalized) return '';
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  const leaf = normalized.split('/').pop() ?? '';
  const slug = leaf.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `${slug || 'workspace'}-${hash.toString(36)}`;
}

/**
 * Learn which workspace the open storefront belongs to, once per origin. Every
 * theme project locally is served from a fixed port (`127.0.0.1:9292`), so two
 * projects on that port resolve to one origin and would otherwise share progress.
 */
function resolveChecklistWorkspace(origin: string, force = false): Promise<void> {
  if (!force && origin === checklistWorkspaceResolvedFor) return Promise.resolve();
  if (checklistWorkspacePending) return checklistWorkspacePending;
  const identify = getApi()?.identifyWorkspace;
  if (!identify) {
    checklistWorkspaceTag = '';
    checklistWorkspaceResolvedFor = origin;
    return Promise.resolve();
  }
  checklistWorkspacePending = (async () => {
    try {
      // Bounded: a main process that never answers must not leave the panel
      // pending forever. Falling back to the unknown-workspace scope keeps the
      // checklist usable and honest about what it measured.
      const res = await Promise.race([
        identify(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), WORKSPACE_IDENTIFY_TIMEOUT_MS);
        }),
      ]);
      checklistWorkspaceTag = workspaceTag(res?.workspacePath);
    } catch (err) {
      console.warn('[ThemeStudio] Workspace identity unavailable; scoping the checklist to the unknown-workspace scope:', err);
      checklistWorkspaceTag = '';
    }
    checklistWorkspaceResolvedFor = origin;
    checklistWorkspacePending = null;
  })();
  return checklistWorkspacePending;
}

function checklistStorageKey(scope: string): string {
  return `${THEME_CHECKLIST_STORAGE_PREFIX}:${scope}`;
}

/** Move `themeChecklist` onto the active scope, persisting the previous one first. */
function applyChecklistScope(): boolean {
  const next = checklistScope();
  if (next === activeChecklistScope) return false;
  if (themeChecklist.length > 0) saveThemeChecklist(themeChecklist, activeChecklistScope);
  activeChecklistScope = next;
  themeChecklist = loadThemeChecklist(next);
  return true;
}

/**
 * Bind the checklist to the active storefront. Returns false while the storefront's
 * workspace is still unknown: committing a scope in that window would file one
 * project's ticks under a key another project may resolve to. `force` re-reads the
 * workspace, since switching projects does not change the storefront origin when
 * both are served from the same local port.
 */
function ensureChecklistScope(force = false): boolean {
  const origin = checklistOrigin();
  if (force || origin !== checklistWorkspaceResolvedFor) {
    const tagAlreadyKnown = origin === checklistWorkspaceResolvedFor;
    void resolveChecklistWorkspace(origin, force).then(() => {
      const scopeChanged = applyChecklistScope();
      // A forced re-read renders a frozen panel until it lands, so it must repaint
      // even when the workspace (and therefore the scope) turns out unchanged.
      if (scopeChanged || force) renderThemeStudioChecklist();
    });
    if (!tagAlreadyKnown) return false;
  }
  applyChecklistScope();
  return true;
}

function loadThemeChecklist(scope: string): ThemeChecklistItem[] {
  try {
    const raw = localStorage.getItem(checklistStorageKey(scope));
    if (!raw) return DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
    const saved = JSON.parse(raw) as Record<string, boolean>;
    return DEFAULT_THEME_CHECKLIST.map((item) => ({
      ...item,
      done: Boolean(saved[item.id]),
    }));
  } catch {
    return DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
  }
}

function saveThemeChecklist(items: ThemeChecklistItem[], scope: string) {
  try {
    const record: Record<string, boolean> = {};
    for (const item of items) {
      if (item.done) record[item.id] = true;
    }
    localStorage.setItem(checklistStorageKey(scope), JSON.stringify(record));
  } catch (err) {
    console.warn('[ThemeStudio] Failed to save checklist state:', err);
  }
}

/**
 * A live product page. Haravan/Sapo/Shopify serve PDPs only at `/products/<handle>`,
 * so this is the sole route that can be trusted as "the product page".
 */
const PRODUCT_PAGE_PATH = /\/products\/[^/?#]+/;

/**
 * Origin every storefront route is resolved against: the tab in front of the user
 * first, then any other browsing tab, then the local storefront dev server.
 */
function storefrontOrigin(): string {
  const ordered = [currentTabs.find((tab) => tab.id === activeTabId), ...currentTabs];
  for (const tab of ordered) {
    if (!tab?.url) continue;
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch {
      // not a navigable origin — keep looking
    }
  }
  return 'http://127.0.0.1:9292';
}

/**
 * The absolute route a checklist action should open, or `null` when the page has
 * no index route and no matching storefront page is open. Callers must refuse
 * rather than navigate: opening a made-up route would scan a 404 while claiming a
 * product page.
 */
function resolveChecklistRoute(pageDef: ThemePageDef, itemPath?: string): string | null {
  if (pageDef.routeKind === 'handle-required') {
    const openUrl = currentTabs.find((tab) => tab.id === activeTabId)?.url;
    if (!openUrl) return null;
    try {
      return PRODUCT_PAGE_PATH.test(new URL(openUrl).pathname) ? openUrl : null;
    } catch {
      return null;
    }
  }
  try {
    return new URL(itemPath || pageDef.path, storefrontOrigin()).href;
  } catch {
    return null;
  }
}

function navigatePreview(pathHint: string) {
  const resolvedOrigin = storefrontOrigin();
  let targetUrl = pathHint;
  const activeTab = currentTabs.find((t) => t.id === activeTabId);

  try {
    targetUrl = new URL(pathHint, resolvedOrigin).href;
  } catch {
    targetUrl = `${resolvedOrigin}${pathHint.startsWith('/') ? pathHint : '/' + pathHint}`;
  }

  // 1. Navigate active tab
  getApi()?.navigate(targetUrl, activeTabId);

  // 2. Update Omnibox input
  if (urlInput) {
    urlInput.value = targetUrl;
  }

  // 3. Automatically close modal so storefront is visible immediately!
  if (themeQaOverlay) {
    themeQaOverlay.style.display = 'none';
    releaseOverlay('theme-qa');
  }

  showToolbarToast(`Đang mở Storefront: ${targetUrl}`);
}

function renderThemeStudioChecklist(refreshWorkspace = false) {
  const container = document.getElementById('themeChecklistList');
  const progressVal = document.getElementById('themeChecklistProgressVal');
  const progressBar = document.getElementById('themeChecklistProgressBar') as HTMLElement | null;
  const badgeNav = document.getElementById('badgeThemeChecklist');
  if (!container) return;

  if (!ensureChecklistScope(refreshWorkspace)) {
    container.innerHTML = '';
    const pending = document.createElement('div');
    pending.className = 'theme-checklist-pending';
    pending.textContent = 'Đang xác định storefront và workspace để mở đúng checklist…';
    container.appendChild(pending);
    if (progressVal) progressVal.textContent = '--';
    if (progressBar) progressBar.style.width = '0%';
    if (badgeNav) badgeNav.textContent = '--';
    return;
  }

  // A forced re-read (opening the panel after switching projects) renders the
  // committed scope until the new one lands. Editing is held off for that one
  // round-trip so a tick cannot be filed under the project being left behind.
  const verifyingWorkspace = checklistWorkspacePending !== null;

  if (themeChecklist.length === 0) {
    themeChecklist = loadThemeChecklist(activeChecklistScope);
  }

  const total = themeChecklist.length;
  const doneCount = themeChecklist.filter((it) => it.done).length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  if (progressVal) progressVal.textContent = `${doneCount}/${total} (${percent}%)`;
  if (progressBar) progressBar.style.width = `${percent}%`;
  if (badgeNav) badgeNav.textContent = `${doneCount}/${total}`;

  // Group items by page
  const pageKeys = ['home', 'collection', 'product', 'cart', 'blog', 'account', 'pages', 'qa-gate'];
  container.innerHTML = '';

  const q = checklistSearchQuery.trim().toLowerCase();

  pageKeys.forEach((pageKey) => {
    if (activePhaseFilter !== 'all' && activePhaseFilter !== 'uncompleted' && activePhaseFilter !== pageKey) return;

    let pageItems = themeChecklist.filter((it) => it.page === pageKey);
    if (activePhaseFilter === 'uncompleted') {
      pageItems = pageItems.filter((it) => !it.done);
    }
    if (pageItems.length === 0 && activePhaseFilter === 'uncompleted') return;

    if (q) {
      pageItems = pageItems.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.code.toLowerCase().includes(q) ||
          it.desc.toLowerCase().includes(q) ||
          it.qaPoint.toLowerCase().includes(q)
      );
    }
    if (pageItems.length === 0 && q) return;

    const pageDone = pageItems.filter((it) => it.done).length;
    const pageTotal = pageItems.length;
    const pageDef = PAGE_DEFS[pageKey] || { title: pageKey, badge: pageKey.toUpperCase(), icon: '📄', path: '/' };

    const card = document.createElement('div');
    card.className = 'theme-phase-card';

    const header = document.createElement('div');
    header.className = 'theme-phase-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'theme-phase-header-title';
    headerLeft.innerHTML = `
      <span class="theme-phase-badge">${pageDef.icon} ${pageDef.badge}</span>
      <span>${pageDef.title}</span>
    `;

    const headerRight = document.createElement('div');
    headerRight.style.display = 'flex';
    headerRight.style.alignItems = 'center';

    const btnOpenPage = document.createElement('button');
    btnOpenPage.className = 'theme-btn-open-page';
    btnOpenPage.title = `Mở đường dẫn storefront: ${pageDef.path}`;
    btnOpenPage.textContent = `↗ Mở trang`;
    btnOpenPage.addEventListener('click', (e) => {
      e.stopPropagation();
      const route = resolveChecklistRoute(pageDef);
      if (!route) {
        showToolbarToast(pageDef.routeNote ?? `Không mở được ${pageDef.title}: chưa có trang tương ứng đang mở.`);
        return;
      }
      navigatePreview(route);
    });

    const btnScanPage = document.createElement('button');
    btnScanPage.className = 'theme-btn-scan-page';
    btnScanPage.title = `Mở và quét QA storefront cho trang: ${pageDef.title}`;
    btnScanPage.textContent = `🔍 Quét QA`;
    btnScanPage.addEventListener('click', async (e) => {
      e.stopPropagation();
      const route = resolveChecklistRoute(pageDef);
      if (!route) {
        showToolbarToast(pageDef.routeNote ?? `Không quét được ${pageDef.title}: chưa có trang tương ứng đang mở.`);
        return;
      }
      // Already on the resolved route: the QA run reloads the page itself, so a
      // pre-navigation would only add a second full load.
      if (route !== currentTabs.find((tab) => tab.id === activeTabId)?.url) {
        navigatePreview(route);
        showToolbarToast(`Đang chuyển đến ${pageDef.title} và chuẩn bị chạy QA…`);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 800);
        await promise;
      } else {
        showToolbarToast(`Đang quét QA trên ${pageDef.title}…`);
      }
      const res = await getApi()?.runThemeQa();
      if (res?.report) {
        lastThemeQaReport = res.report;
        renderThemeQa({ ...themeQaState, report: res.report }, res.report);
        tabNavThemeFindings?.classList.add('active');
        tabNavThemeChecklist?.classList.remove('active');
        if (themeTabFindings) themeTabFindings.style.display = 'flex';
        if (themeTabChecklist) themeTabChecklist.style.display = 'none';
        renderThemeStudioFindings();
        openThemeQaSummary();
      }
    });

    const allDone = pageItems.length > 0 && pageItems.every((it) => it.done);
    const btnToggleAll = document.createElement('button');
    btnToggleAll.className = 'theme-btn-toggle-all';
    btnToggleAll.textContent = allDone ? '↺ Bỏ xong' : '✓ Xong cả trang';
    btnToggleAll.title = allDone ? 'Đánh dấu chưa hoàn thành toàn bộ mục trang này' : 'Đánh dấu đã hoàn thành toàn bộ mục trang này';
    btnToggleAll.disabled = verifyingWorkspace;
    btnToggleAll.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checklistWorkspacePending) return;
      const newStatus = !allDone;
      pageItems.forEach((it) => {
        it.done = newStatus;
        const found = themeChecklist.find((m) => m.id === it.id);
        if (found) found.done = newStatus;
      });
      saveThemeChecklist(themeChecklist, activeChecklistScope);
      renderThemeStudioChecklist();
      showToolbarToast(`${newStatus ? 'Đã hoàn thành' : 'Đã bỏ hoàn thành'} toàn bộ ${pageDef.title}`);
    });

    const progressPill = document.createElement('div');
    progressPill.className = 'theme-phase-progress-pill';
    progressPill.textContent = `${pageDone}/${pageTotal} Xong`;

    headerRight.append(btnOpenPage, btnScanPage, btnToggleAll, progressPill);
    header.append(headerLeft, headerRight);
    card.append(header);

    if (pageDef.note) {
      const note = document.createElement('div');
      note.className = 'theme-phase-note';
      note.textContent = pageDef.note;
      card.append(note);
    }

    const itemsBox = document.createElement('div');
    itemsBox.className = 'theme-phase-items';

    pageItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = `theme-item-row${item.done ? ' is-done' : ''}`;

      const left = document.createElement('div');
      left.className = 'theme-item-left';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'theme-item-checkbox';
      cb.checked = item.done;
      cb.disabled = verifyingWorkspace;
      cb.addEventListener('change', () => {
        if (checklistWorkspacePending) return;
        item.done = cb.checked;
        saveThemeChecklist(themeChecklist, activeChecklistScope);
        renderThemeStudioChecklist();
      });

      const codeTag = document.createElement('span');
      codeTag.className = 'theme-item-code';
      codeTag.textContent = item.code;

      const info = document.createElement('div');
      info.className = 'theme-item-info';
      info.innerHTML = `
        <div class="theme-item-name">${item.name}</div>
        <div class="theme-item-desc">${item.desc}</div>
        <div class="theme-item-qa-point">🔍 QA: ${item.qaPoint}</div>
      `;

      left.append(cb, codeTag, info);

      const right = document.createElement('div');
      right.className = 'theme-item-right';

      const statusTag = document.createElement('span');
      statusTag.className = `theme-status-tag ${item.done ? 'done' : 'backlog'}`;
      statusTag.textContent = item.done ? '✓ Xong' : 'Chưa làm';
      right.appendChild(statusTag);

      const targetPath = resolveChecklistRoute(pageDef, item.pathHint);
      const btnNav = document.createElement('button');
      btnNav.className = 'theme-btn-nav';
      btnNav.title = targetPath ? `Mở đường dẫn storefront: ${targetPath}` : (pageDef.routeNote ?? 'Chưa có trang tương ứng đang mở');
      btnNav.textContent = '↗ Xem';
      btnNav.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!targetPath) {
          showToolbarToast(pageDef.routeNote ?? 'Chưa có trang tương ứng đang mở');
          return;
        }
        navigatePreview(targetPath);
      });
      right.appendChild(btnNav);

      row.append(left, right);
      itemsBox.appendChild(row);
    });

    card.append(itemsBox);
    container.appendChild(card);
  });
}

function renderThemeStudioFindings(report?: Record<string, unknown>) {
  const listEl = document.getElementById('themeQaFindingsList');
  const overallStatusPill = document.getElementById('themeQaOverallStatus');
  const overallStatusText = document.getElementById('themeQaOverallStatusText');
  const badgeFindings = document.getElementById('badgeThemeFindings');
  const platformBadge = document.getElementById('themePlatformBadge');
  const healthPill = document.getElementById('themeHealthPill');

  const statLiquid = document.getElementById('statCountLiquid');
  const statOverflow = document.getElementById('statCountOverflow');
  const statAssets = document.getElementById('statCountAssets');
  const statHs = document.getElementById('statCountHs');
  const statDiag = document.getElementById('statCountDiagnostics');

  if (!listEl) return;

  const rep = report || (lastThemeQaReport || themeQaState.report) as Record<string, unknown> | undefined;
  const findings = rep?.findings as Record<string, unknown> | undefined;
  const summary = rep?.summary as Record<string, unknown> | undefined;
  const platform = findings?.platform as Record<string, unknown> | undefined;

  const liquid = findings?.liquid as { errors?: Array<{ message?: string }> } | undefined;
  const overflow = findings?.overflow as { culprits?: Array<{ selector?: string }> } | undefined;
  const assets = findings?.assets as { brokenAssets?: Array<{ url?: string; src?: string }> } | undefined;
  const hsRules = findings?.hsRules as { totalViolations?: number; violations?: Array<{ ruleId?: string; message?: string }> } | undefined;
  const diagnosticIssues = findings?.diagnosticIssues as Array<{ kind?: string; message?: string; origin?: string }> | undefined;
  const diagnosticWarnings = findings?.diagnosticWarnings as Array<{ kind?: string; message?: string; origin?: string }> | undefined;

  const liquidCount = liquid?.errors?.length || 0;
  const overflowCount = overflow?.culprits?.length || 0;
  const assetsCount = assets?.brokenAssets?.length || 0;
  const hsCount = hsRules?.totalViolations || 0;
  const diagCount = (diagnosticIssues?.length || 0) + (diagnosticWarnings?.length || 0);
  const totalIssues = summary?.totalIssues ?? (liquidCount + overflowCount + assetsCount + hsCount + diagCount);

  if (platformBadge) platformBadge.textContent = typeof platform?.platform === 'string' ? platform.platform.toUpperCase() : 'THEME';
  if (statLiquid) statLiquid.textContent = String(liquidCount);
  if (statOverflow) statOverflow.textContent = String(overflowCount);
  if (statAssets) statAssets.textContent = String(assetsCount);
  if (statHs) statHs.textContent = String(hsCount);
  if (statDiag) statDiag.textContent = String(diagCount);

  if (badgeFindings) badgeFindings.textContent = `${totalIssues} Issues`;

  if (summary) {
    const passed = Boolean(summary.passed);
    if (healthPill) {
      healthPill.textContent = passed ? 'PASSED' : 'FAILED';
      healthPill.classList.toggle('fail', !passed);
    }
    if (overallStatusPill && overallStatusText) {
      overallStatusPill.classList.toggle('pass', passed);
      overallStatusPill.classList.toggle('fail', !passed);
      overallStatusText.textContent = passed
        ? 'STOREFRONT SẠCH (0 Critical Issues)'
        : `PHÁT HIỆN ${totalIssues} LỖI CẦN XỬ LÝ`;
    }
  }

  listEl.innerHTML = '';

  const allCards: Array<{ category: 'critical' | 'warning' | 'info'; title: string; desc: string; selector?: string }> = [];

  (liquid?.errors || []).forEach((item) => {
    allCards.push({ category: 'critical', title: 'LIQUID SYNTAX ERROR', desc: item.message || 'Lỗi cú pháp Liquid' });
  });
  (overflow?.culprits || []).forEach((item) => {
    allCards.push({
      category: 'warning',
      title: 'LAYOUT OVERFLOW (TRÀN CHIỀU NGANG)',
      desc: `Phần tử gây tràn màn hình: ${item.selector || 'Chưa rõ selector'}`,
      selector: item.selector,
    });
  });
  (assets?.brokenAssets || []).forEach((item) => {
    allCards.push({ category: 'warning', title: 'BROKEN ASSET (404)', desc: item.url || item.src || 'Tài nguyên ảnh/script bị hỏng' });
  });
  (hsRules?.violations || []).forEach((item) => {
    allCards.push({ category: 'info', title: `HS RULE [${item.ruleId || 'RULE'}]`, desc: item.message || '' });
  });
  (diagnosticIssues || []).forEach((item) => {
    allCards.push({
      category: 'critical',
      title: `CONSOLE ERROR [${item.kind || 'issue'}]`,
      desc: `${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`,
    });
  });
  (diagnosticWarnings || []).forEach((item) => {
    allCards.push({
      category: 'info',
      title: `DIAGNOSTIC WARNING [${item.kind || 'warning'}]`,
      desc: `${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`,
    });
  });

  if (allCards.length === 0) {
    listEl.innerHTML = `
      <div class="qa-empty-state">
        <div class="qa-empty-icon">${summary?.passed ? '✅' : '🧪'}</div>
        <div>${summary?.passed ? 'Tuyệt vời! Không phát hiện lỗi Liquid, lỗi tràn viền hay tài nguyên hỏng trên trang này.' : 'Bấm <strong>"Scan Live"</strong> để bắt đầu kiểm tra giao diện Storefront.'}</div>
      </div>
    `;
    return;
  }

  allCards.forEach((cardData) => {
    const card = document.createElement('div');
    card.className = `qa-finding-card ${cardData.category}`;

    const content = document.createElement('div');
    content.className = 'qa-finding-content';

    const titleRow = document.createElement('div');
    titleRow.className = 'qa-finding-title-row';
    titleRow.innerHTML = `
      <span class="qa-finding-badge ${cardData.category}">${cardData.category}</span>
      <span class="qa-finding-signature">${cardData.title}</span>
    `;

    const msg = document.createElement('div');
    msg.className = 'qa-finding-msg';
    msg.textContent = cardData.desc;

    content.append(titleRow, msg);

    if (cardData.selector) {
      const target = document.createElement('div');
      target.className = 'qa-finding-target';
      target.textContent = cardData.selector;
      content.appendChild(target);
    }

    card.appendChild(content);

    if (cardData.selector) {
      const btnInspect = document.createElement('button');
      btnInspect.className = 'btn-highlight-dom';
      btnInspect.title = 'Sao chép selector và soi phần tử';
      btnInspect.textContent = '🎯 Soi DOM';
      btnInspect.addEventListener('click', () => {
        navigator.clipboard?.writeText(cardData.selector!);
        showToolbarToast(`Đã sao chép selector: <code>${cardData.selector}</code>`);
      });
      card.appendChild(btnInspect);
    }

    listEl.appendChild(card);
  });
}

function openThemeQaSummary() {
  if (!themeQaOverlay || !themeQaSummary) return;
  const report = (lastThemeQaReport || themeQaState.report) as Record<string, unknown> | undefined;
  const findings = report?.findings as Record<string, unknown> | undefined;
  const summary = report?.summary as Record<string, unknown> | undefined;
  const platform = findings?.platform as Record<string, unknown> | undefined;
  const liquid = findings?.liquid as { errors?: Array<{ message?: string }> } | undefined;
  const overflow = findings?.overflow as { culprits?: Array<{ selector?: string }> } | undefined;
  const assets = findings?.assets as { brokenAssets?: Array<{ url?: string; src?: string }> } | undefined;
  const hsRules = findings?.hsRules as { totalViolations?: number; violations?: Array<{ ruleId?: string; message?: string }> } | undefined;
  const diagnosticIssues = findings?.diagnosticIssues as Array<{ kind?: string; message?: string; origin?: string }> | undefined;
  const diagnosticWarnings = findings?.diagnosticWarnings as Array<{ kind?: string; message?: string; origin?: string }> | undefined;

  const lines = findings ? [
    `Platform: ${platform?.platform || 'unknown'}`,
    `Result: ${summary?.passed ? 'PASSED' : 'FAILED'} (Critical: ${summary?.criticalCount ?? liquid?.errors?.length ?? 0}, Total: ${summary?.totalIssues ?? 0})`,
    `Liquid errors: ${liquid?.errors?.length || 0}`,
    `Layout overflow culprits: ${overflow?.culprits?.length || 0}`,
    `Broken assets: ${assets?.brokenAssets?.length || 0}`,
    `HS violations: ${hsRules?.totalViolations || 0}`,
    `Diagnostic issues (critical): ${diagnosticIssues?.length || 0}`,
    `Diagnostic warnings: ${diagnosticWarnings?.length || 0}`,
    '',
    ...(liquid?.errors || []).map((item) => `[Liquid] ${item.message || 'unknown error'}`),
    ...(overflow?.culprits || []).map((item) => `[Overflow] ${item.selector || 'unknown element'}`),
    ...(assets?.brokenAssets || []).map((item) => `[Asset] ${item.url || item.src || 'unknown asset'}`),
    ...(hsRules?.violations || []).map((item) => `[HS] ${item.ruleId || 'rule'}: ${item.message || ''}`),
    ...(diagnosticIssues || []).map((item) => `[Diagnostics Critical] [${item.kind || 'issue'}] ${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`),
    ...(diagnosticWarnings || []).map((item) => `[Diagnostics Warning] [${item.kind || 'warning'}] ${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`),
  ] : [themeQaState.error || 'No validation has been run.'];

  // Keep hidden raw text updated for automated test suites
  themeQaSummary.textContent = lines.join('\n');

  // Render rich Cockpit UI
  renderThemeStudioChecklist();
  renderThemeStudioFindings(report);

  themeQaOverlay.style.display = 'flex';
  acquireOverlay('theme-qa');
}

let currentTabs: AntiFanTab[] = [];
let currentBookmarks: Array<{ id: string; title: string; url: string }> = [];
let activeTabId: string = '';
let isInspecting = false;
let isFontFinderActive = false;
let isLensActive = false;
let isRulerActive = false;
let isBookmarkBarVisible = false;
let themeQaState: ThemeQaState = { status: 'idle', issueCount: 0, updatedAt: Date.now() };
let lastThemeQaReport: any = null;
const btnPopoutTerminal = document.getElementById('btnPopoutTerminal') as HTMLButtonElement | null;

// DOM Elements
const tabList = document.getElementById('tabList')!;
// The strip scrolls but hides its scrollbar, and nothing mapped wheel input onto it, so
// a tab past the right edge was present in the DOM and impossible for the user to see or
// click — it read as "lost". Map vertical wheel to horizontal scroll so every tab stays
// reachable. (Tabs the agent plane creates are a separate case: getTabList excludes them
// by design, native-tab-host.ts:2791-2806.)
const tabStrip = document.getElementById('tabStrip') as HTMLElement | null;
if (tabStrip) {
  tabStrip.addEventListener('wheel', (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    const before = tabStrip.scrollLeft;
    tabStrip.scrollLeft = before + event.deltaY;
    if (tabStrip.scrollLeft !== before) event.preventDefault();
  }, { passive: false });
}
const btnNewTab = document.getElementById('btnNewTab')!;
const btnBack = document.getElementById('btnBack') as HTMLButtonElement;
const btnForward = document.getElementById('btnForward') as HTMLButtonElement;
const btnReload = document.getElementById('btnReload') as HTMLButtonElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const btnClearOmnibox = document.getElementById('btnClearOmnibox') as HTMLButtonElement;
const deviceSelect = document.getElementById('deviceSelect') as HTMLSelectElement;
const btnToggleSplit = document.getElementById('btnToggleSplit') as HTMLButtonElement | null;
const splitControlsContainer = document.getElementById('splitControlsContainer') as HTMLElement | null;
const splitDesktopSelect = document.getElementById('splitDesktopSelect') as HTMLSelectElement | null;
const splitMobileSelect = document.getElementById('splitMobileSelect') as HTMLSelectElement | null;
const btnSplitFocusDesktop = document.getElementById('btnSplitFocusDesktop') as HTMLButtonElement | null;
const btnSplitFocusMobile = document.getElementById('btnSplitFocusMobile') as HTMLButtonElement | null;
const agentActiveBadge = document.getElementById('agentActiveBadge') as HTMLElement | null;

// Zoom Stepper Elements
const zoomLabel = document.getElementById('zoomLabel')!;
const btnZoomOutPop = document.getElementById('btnZoomOutPop') as HTMLButtonElement;
const btnZoomInPop = document.getElementById('btnZoomInPop') as HTMLButtonElement;

// Tool Buttons
const btnThemeQa = document.getElementById('btnThemeQa') as HTMLButtonElement | null;
const btnQuickInspect = document.getElementById('btnQuickInspect') as HTMLButtonElement;
const themeQaText = document.getElementById('themeQaText') as HTMLElement | null;
const themeQaOverlay = document.getElementById('themeQaOverlay') as HTMLElement | null;
const themeQaClose = document.getElementById('themeQaClose') as HTMLButtonElement | null;
const themeQaSummary = document.getElementById('themeQaSummary') as HTMLElement | null;
const btnPhoneStatus = document.getElementById('btnPhoneStatus') as HTMLButtonElement | null;
const phoneStatusText = document.getElementById('phoneStatusText') as HTMLElement | null;
const phoneStatusOverlay = document.getElementById('phoneStatusOverlay') as HTMLElement | null;
const phoneStatusBody = document.getElementById('phoneStatusBody') as HTMLElement | null;
const phoneStatusClose = document.getElementById('phoneStatusClose') as HTMLButtonElement | null;
const btnPhoneStatusRefresh = document.getElementById('btnPhoneStatusRefresh') as HTMLButtonElement | null;
let lastPhoneStatus: ToolbarPhoneStatus | null = null;
const btnFontFinder = document.getElementById('btnFontFinder') as HTMLButtonElement;
const mobileRemoteOverlay = document.getElementById('mobileRemoteOverlay')!;
const mobileRemoteClose = document.getElementById('mobileRemoteClose') as HTMLButtonElement;
const mobileRemoteQrContainer = document.getElementById('mobileRemoteQrContainer')!;
const mobileRemoteUrlsList = document.getElementById('mobileRemoteUrlsList')!;
const btnToggleSidebar = document.getElementById('btnToggleSidebar') as HTMLButtonElement;
const btnChromeProfile = document.getElementById('btnChromeProfile') as HTMLButtonElement;
const profileAvatar = document.getElementById('profileAvatar')!;
const profileName = document.getElementById('profileName')!;
const profileDropdownMenu = document.getElementById('profileDropdownMenu')!;
const profileDropdownList = document.getElementById('profileDropdownList')!;
const btnMenu = document.getElementById('btnMenu') as HTMLButtonElement | null;
// (Dead ids removed: btnRuler, btnCaptureFullPage, btnMobileRemote, btnDevTools, codexMainMenu —
//  none exist in toolbar.html.)

let activeProfileInfo: any = null;
let availableChromeProfiles: any[] = [];

// (Dead menu ids removed: menuFind, menuQuickAnnotate, menuFontFinder, menuLens,
//  menuOpenBrowser, menuShortcuts — none exist in toolbar.html.)

// Find Bar
const findBar = document.getElementById('findBar') as HTMLElement | null;
const findInput = document.getElementById('findInput') as HTMLInputElement | null;
const findCount = document.getElementById('findCount') as HTMLElement | null;
const findPrev = (document.getElementById('btnFindPrev') || document.getElementById('findPrev')) as HTMLButtonElement | null;
const findNext = (document.getElementById('btnFindNext') || document.getElementById('findNext')) as HTMLButtonElement | null;
const findClose = (document.getElementById('btnFindClose') || document.getElementById('findClose')) as HTMLButtonElement | null;

// Shortcuts Overlay
const shortcutsOverlay = document.getElementById('shortcutsOverlay') as HTMLElement | null;
const shortcutsClose = document.getElementById('shortcutsClose') as HTMLButtonElement | null;
// Workflow & MCP Hub Elements
const btnWorkflowHub = document.getElementById('btnWorkflowHub') as HTMLButtonElement | null;
const workflowHubOverlay = document.getElementById('workflowHubOverlay') as HTMLElement | null;
const btnWorkflowHubClose = document.getElementById('btnWorkflowHubClose') as HTMLButtonElement | null;
const tabNavWorkflows = document.getElementById('tabNavWorkflows') as HTMLButtonElement | null;
const tabNavMcp = document.getElementById('tabNavMcp') as HTMLButtonElement | null;
const badgeWorkflowCount = document.getElementById('badgeWorkflowCount') as HTMLElement | null;
const badgeMcpCount = document.getElementById('badgeMcpCount') as HTMLElement | null;
const hubSearchInput = document.getElementById('hubSearchInput') as HTMLInputElement | null;
const hubSearchClear = document.getElementById('hubSearchClear') as HTMLButtonElement | null;
const btnHubNewWorkflow = document.getElementById('btnHubNewWorkflow') as HTMLButtonElement | null;
const hubItemsList = document.getElementById('hubItemsList') as HTMLElement | null;
// Static provenance disclosure, declared in toolbar.html and only ever shown or
// hidden here. It is deliberately NOT built from the payload: the panel reports
// dispatches the ledger recorded, which is a proxy for effectiveness rather than
// a measurement of it, so the sentence must stay identical for every payload
// (including no payload at all) instead of tracking the data it qualifies.
const hubMcpDispatchProvenance = document.getElementById('mcpDispatchProvenance') as HTMLElement | null;
const hubDetailEmpty = document.getElementById('hubDetailEmpty') as HTMLElement | null;
const hubWfDetail = document.getElementById('hubWfDetail') as HTMLElement | null;
const hubMcpDetail = document.getElementById('hubMcpDetail') as HTMLElement | null;

const wfDetailCategory = document.getElementById('wfDetailCategory') as HTMLElement | null;
const wfDetailName = document.getElementById('wfDetailName') as HTMLElement | null;
const wfDetailDesc = document.getElementById('wfDetailDesc') as HTMLElement | null;
const btnRunWorkflow = document.getElementById('btnRunWorkflow') as HTMLButtonElement | null;
const btnStopWorkflow = document.getElementById('btnStopWorkflow') as HTMLButtonElement | null;
const btnCopyWorkflowJson = document.getElementById('btnCopyWorkflowJson') as HTMLButtonElement | null;
const btnDeleteCustomWf = document.getElementById('btnDeleteCustomWf') as HTMLButtonElement | null;

const hubRunStatusBar = document.getElementById('hubRunStatusBar') as HTMLElement | null;
const runStatusPill = document.getElementById('runStatusPill') as HTMLElement | null;
const runCurrentStepText = document.getElementById('runCurrentStepText') as HTMLElement | null;
const runTimerText = document.getElementById('runTimerText') as HTMLElement | null;
const hubProgressBar = document.getElementById('hubProgressBar') as HTMLElement | null;
const wfStepsCount = document.getElementById('wfStepsCount') as HTMLElement | null;
const wfStepsContainer = document.getElementById('wfStepsContainer') as HTMLElement | null;
const wfArtifactsSection = document.getElementById('wfArtifactsSection') as HTMLElement | null;
const wfArtifactsGrid = document.getElementById('wfArtifactsGrid') as HTMLElement | null;

const mcpDetailCategory = document.getElementById('mcpDetailCategory') as HTMLElement | null;
const mcpDetailName = document.getElementById('mcpDetailName') as HTMLElement | null;
const mcpDetailDesc = document.getElementById('mcpDetailDesc') as HTMLElement | null;
const mcpDetailPermission = document.getElementById('mcpDetailPermission') as HTMLElement | null;
const mcpSchemaCode = document.getElementById('mcpSchemaCode') as HTMLElement | null;
const tabNavCoreHealth = document.getElementById('tabNavCoreHealth') as HTMLButtonElement | null;
const tabNavBridge = document.getElementById('tabNavBridge') as HTMLButtonElement | null;
const tabNavTaskRuns = document.getElementById('tabNavTaskRuns') as HTMLButtonElement | null;
const tabNavRootCauses = document.getElementById('tabNavRootCauses') as HTMLButtonElement | null;
const tabNavRegressions = document.getElementById('tabNavRegressions') as HTMLButtonElement | null;
const tabNavMcpDispatch = document.getElementById('tabNavMcpDispatch') as HTMLButtonElement | null;
const badgeCoreHealth = document.getElementById('badgeCoreHealth') as HTMLElement | null;
const badgeBridge = document.getElementById('badgeBridge') as HTMLElement | null;
const badgeTaskRuns = document.getElementById('badgeTaskRuns') as HTMLElement | null;
const badgeRootCauses = document.getElementById('badgeRootCauses') as HTMLElement | null;
const badgeRegressions = document.getElementById('badgeRegressions') as HTMLElement | null;
const badgeMcpDispatch = document.getElementById('badgeMcpDispatch') as HTMLElement | null;
const hubCoreDetail = document.getElementById('hubCoreDetail') as HTMLElement | null;
const coreDetailCategory = document.getElementById('coreDetailCategory') as HTMLElement | null;
const coreDetailName = document.getElementById('coreDetailName') as HTMLElement | null;
const coreDetailDesc = document.getElementById('coreDetailDesc') as HTMLElement | null;
const coreStatusPill = document.getElementById('coreStatusPill') as HTMLElement | null;
const coreDetailCode = document.getElementById('coreDetailCode') as HTMLElement | null;
const btnCoreRefresh = document.getElementById('btnCoreRefresh') as HTMLButtonElement | null;

type HubTab = 'workflows' | 'mcp' | 'core-health' | 'bridge' | 'task-runs' | 'root-causes' | 'regressions' | 'mcp-dispatch';
const HUB_CORE_TABS: HubTab[] = ['core-health', 'bridge', 'task-runs', 'root-causes', 'regressions'];
const HUB_NAV_BUTTONS: Record<HubTab, HTMLButtonElement | null> = {
  'workflows': tabNavWorkflows,
  'mcp': tabNavMcp,
  'core-health': tabNavCoreHealth,
  'bridge': tabNavBridge,
  'task-runs': tabNavTaskRuns,
  'root-causes': tabNavRootCauses,
  'regressions': tabNavRegressions,
  'mcp-dispatch': tabNavMcpDispatch,
};
let hubCoreState: any = null;
let hubCoreSelected: { tab: HubTab; id: string } | null = null;

let hubActiveTab: HubTab = 'workflows';
let hubWorkflows: any[] = [];
let hubMcpTools: any[] = [];
let hubSelectedWorkflow: any = null;
let hubSelectedMcpTool: any = null;
let hubMcpDispatch: any = null;
let hubMcpDispatchSelected: { id: string } | null = null;
let isWorkflowRunning = false;
let runStartTime = 0;
let runTimerInterval: any = null;

function getStepIcon(type: string): string {
  if (type.startsWith('browser.navigate')) return '🌐';
  if (type.startsWith('browser.click')) return '👆';
  if (type.startsWith('browser.type')) return '✍️';
  if (type.startsWith('browser.scroll')) return '📜';
  if (type.startsWith('browser.hover')) return '🎯';
  if (type.startsWith('browser.highlight')) return '✨';
  if (type.startsWith('browser.wait')) return '⏳';
  if (type.startsWith('browser.screenshot')) return '📸';
  if (type.startsWith('browser.extract')) return '🔍';
  if (type.startsWith('browser.set_')) return '📱';
  if (type.startsWith('qa.')) return '🛡️';
  if (type.startsWith('file.')) return '📄';
  if (type.startsWith('report.')) return '📊';
  return '⚡';
}

async function openWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'flex';
  acquireOverlay('workflow-hub');

  try {
    const res = await getApi()?.getWorkflowState();
    if (res) {
      hubWorkflows = res.workflows || [];
      hubMcpTools = res.tools || [];
      if (badgeWorkflowCount) badgeWorkflowCount.textContent = String(hubWorkflows.length);
      if (badgeMcpCount) badgeMcpCount.textContent = String(hubMcpTools.length);
    }
  } catch (err) {
    console.error('[workflow hub] Failed to fetch state:', err);
  }

  await refreshCoreHealthState();
  await refreshMcpDispatchState();

  renderHubList();
  if (hubActiveTab === 'workflows' && hubWorkflows.length > 0 && !hubSelectedWorkflow) {
    selectWorkflow(hubWorkflows[0]);
  } else if (hubActiveTab === 'mcp' && hubMcpTools.length > 0 && !hubSelectedMcpTool) {
    selectMcpTool(hubMcpTools[0]);
  } else if (hubActiveTab === 'mcp-dispatch') {
    renderMcpDispatchSelection();
  } else if (HUB_CORE_TABS.includes(hubActiveTab)) {
    renderCoreListSelection();
  }
}

async function refreshCoreHealthState() {
  try {
    const res = await getApi()?.getCoreHealthState?.();
    if (res) {
      hubCoreState = res;
      updateCoreBadges();
    }
  } catch (err) {
    console.error('[core health] Failed to fetch state:', err);
    hubCoreState = {
      snapshot: { status: 'UNAVAILABLE', reasonCode: 'IPC_FAILED', affected: [String(err)], evidenceRefs: [], checks: [] },
    };
    updateCoreBadges();
  }
}

function updateCoreBadges() {
  const snap = hubCoreState?.snapshot;
  if (badgeCoreHealth) {
    // The badge carries the crash count instead of the status when there is one: a
    // browser-process death outranks every other condition this tab reports, and the
    // count is what decides whether the session is still safe to work in.
    const crashes = Number(snap?.crashes?.total || 0);
    const latest = snap?.crashes?.records?.[0];
    badgeCoreHealth.textContent = crashes > 0 ? `CRASH ×${crashes}` : (snap?.status ?? '–');
    badgeCoreHealth.classList.toggle('crash', crashes > 0);
    badgeCoreHealth.title = crashes > 0
      ? `${crashes} browser-process crash(es); latest ${String(latest?.time || '')}${latest?.reasonCode ? ` (${String(latest.reasonCode)})` : ''}${latest?.dump ? ` · ${String(latest.dump)}` : ''}`
      : `Core Health: ${String(snap?.status ?? 'UNKNOWN')}`;
  }
  const bridge = hubCoreState?.bridge;
  if (badgeBridge) badgeBridge.textContent = bridge?.status ?? '–';
  const tr = hubCoreState?.taskRuns;
  if (badgeTaskRuns) badgeTaskRuns.textContent = String((tr?.taskRuns?.length || 0) + (tr?.packs?.length || 0) + (tr?.cases?.length || 0));
  const rc = hubCoreState?.rootCauses;
  if (badgeRootCauses) badgeRootCauses.textContent = String(rc?.openTotal ?? 0);
  const reg = hubCoreState?.regressions;
  if (badgeRegressions) badgeRegressions.textContent = String(reg?.rows?.length ?? 0);
}

function closeWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'none';
  releaseOverlay('workflow-hub');
}

function renderHubList() {
  if (!hubItemsList) return;
  hubItemsList.innerHTML = '';
  const search = (hubSearchInput?.value || '').toLowerCase().trim();

  if (hubActiveTab === 'workflows') {
    const filtered = hubWorkflows.filter((w) =>
      w.name.toLowerCase().includes(search) ||
      (w.description && w.description.toLowerCase().includes(search)) ||
      (w.category && w.category.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Không tìm thấy kịch bản nào.</div>';
      return;
    }

    filtered.forEach((wf) => {
      const item = document.createElement('div');
      item.className = `hub-list-item ${hubSelectedWorkflow?.id === wf.id ? 'selected' : ''}`;
      const catClass = `pill-${wf.category || 'qa'}`;
      const stepsCount = wf.definition?.steps?.length || 0;

      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(wf.name)}</span>
          <span class="hub-item-pill ${catClass}">${escapeHtml(wf.category || 'QA')}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(wf.description || 'Chưa có mô tả')}</div>
        <div class="hub-item-meta">
          <span>📑 ${stepsCount} bước</span>
          <span>•</span>
          <span>${wf.isBuiltIn ? '🔒 Mặc định' : '✏️ Tùy chỉnh'}</span>
        </div>
      `;
      item.onclick = () => selectWorkflow(wf);
      hubItemsList.appendChild(item);
    });
  } else if (hubActiveTab === 'mcp-dispatch') {
    renderMcpDispatchList(search);
    return;
  } else if (HUB_CORE_TABS.includes(hubActiveTab)) {
    renderCoreHubList(search);
    return;
  } else {
    const filtered = hubMcpTools.filter((t) =>
      t.name.toLowerCase().includes(search) ||
      (t.description && t.description.toLowerCase().includes(search)) ||
      (t.category && t.category.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Không tìm thấy MCP Tool nào.</div>';
      return;
    }

    filtered.forEach((tool) => {
      const item = document.createElement('div');
      item.className = `hub-list-item ${hubSelectedMcpTool?.id === tool.id ? 'selected' : ''}`;
      const catClass = `pill-${tool.category || 'browser'}`;

      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(tool.name)}</span>
          <span class="hub-item-pill ${catClass}">${escapeHtml(tool.category || 'tool')}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(tool.description || 'Không có mô tả')}</div>
        <div class="hub-item-meta">
          <span>Quyền: ${(tool.permissions || ['read']).join(', ')}</span>
        </div>
      `;
      item.onclick = () => selectMcpTool(tool);
      hubItemsList.appendChild(item);
    });
  }
}

function selectWorkflow(wf: any) {
  hubSelectedWorkflow = wf;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'flex';

  if (wfDetailCategory) {
    wfDetailCategory.textContent = (wf.category || 'QA').toUpperCase();
    wfDetailCategory.className = `hub-cat-pill pill-${wf.category || 'qa'}`;
  }
  if (wfDetailName) wfDetailName.textContent = wf.name;
  if (wfDetailDesc) wfDetailDesc.textContent = wf.description || '';
  if (btnDeleteCustomWf) {
    btnDeleteCustomWf.style.display = wf.isBuiltIn ? 'none' : 'inline-block';
  }

  const steps = wf.definition?.steps || [];
  if (wfStepsCount) wfStepsCount.textContent = `${steps.length} Bước`;
  if (wfStepsContainer) {
    wfStepsContainer.innerHTML = '';
    steps.forEach((step: any, idx: number) => {
      const card = document.createElement('div');
      card.className = 'hub-step-card';
      card.id = `step-card-${step.id || idx}`;

      const icon = getStepIcon(step.type);
      const paramsSummary = Object.entries(step.params || {})
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' | ');

      card.innerHTML = `
        <div class="hub-step-idx">${idx + 1}</div>
        <div class="hub-step-icon">${icon}</div>
        <div class="hub-step-info">
          <div class="hub-step-title">${escapeHtml(step.name)}</div>
          <div class="hub-step-meta">
            <span class="hub-step-tag">${escapeHtml(step.type)}</span>
            ${paramsSummary ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(paramsSummary)}</span>` : ''}
          </div>
        </div>
        <div class="hub-step-status step-status-pending" id="step-status-${step.id || idx}">PENDING</div>
      `;
      wfStepsContainer.appendChild(card);
    });
  }

  if (hubRunStatusBar) hubRunStatusBar.style.display = 'none';
  if (wfArtifactsSection) wfArtifactsSection.style.display = 'none';
  if (wfArtifactsGrid) wfArtifactsGrid.innerHTML = '';
}


// ---- Core Health surfaces (Phase 6: items 13, 14, 15, 28, 29) --------------
// Every status carries reasonCode + affected; degraded never shows a bare %.

function coreStatusPillClass(status: string): string {
  if (status === 'HEALTHY' || status === 'PASS') return 'pill-passed';
  if (status === 'DEGRADED' || status === 'UNAVAILABLE' || status === 'FAIL') return 'pill-failed';
  return 'pill-ready';
}

interface CoreListItem { id: string; title: string; desc: string; status: string; meta: string }

function coreListItems(): CoreListItem[] {
  const s = hubCoreState;
  if (!s) return [];
  if (hubActiveTab === 'core-health') {
    const snap = s.snapshot || {};
    const checks = (snap.checks || []) as Array<{ name: string; status: string; reasonCode: string; detail?: string }>;
    const items: CoreListItem[] = [{
      id: '__snapshot__', title: 'Overall Core Health',
      desc: String(snap.reasonCode || ''), status: String(snap.status || 'UNKNOWN'),
      meta: String(snap.checkedAt || ''),
    }];
    for (const c of checks) {
      items.push({
        id: c.name, title: c.name, desc: c.detail || c.reasonCode, status: c.status,
        meta: `reasonCode: ${c.reasonCode}`,
      });
    }
    return items;
  }
  if (hubActiveTab === 'bridge') {
    const b = s.bridge || {};
    const items: CoreListItem[] = [{
      id: '__bridge__', title: 'Bridge status', desc: b.reasonCode || '', status: b.status || 'UNKNOWN',
      meta: `coreReachable: ${Boolean(b.coreReachable)}`,
    }];
    for (const p of (b.recentPacks || []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(p.packId), title: String(p.task || p.packId), desc: `context pack ${p.packId}`,
        status: 'INFO', meta: String(p.createdAt || ''),
      });
    }
    return items;
  }
  if (hubActiveTab === 'task-runs') {
    const t = s.taskRuns || {};
    const items: CoreListItem[] = [{
      id: '__task_runs__', title: 'Task runs',
      desc: t.taskRunsTable ? 'task_runs table present' : 'task_runs table absent — no producer writes it',
      status: t.status || 'UNKNOWN', meta: t.reasonCode || '',
    }];
    for (const r of (t.taskRuns || []) as Array<Record<string, unknown>>) {
      const rid = String(r.runId || r.taskRunId || r.id || '');
      items.push({ id: rid, title: String(r.task || rid || 'task run'), desc: 'task_runs row', status: 'INFO', meta: String(r.createdAt || '') });
    }
    for (const p of (t.packs || []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(p.packId), title: String(p.task || p.packId),
        desc: `context pack${p.platform ? ` · ${p.platform}` : ''}${p.taskHash ? ` · taskHash ${String(p.taskHash).slice(0, 12)}` : ''}`,
        status: 'INFO', meta: String(p.createdAt || ''),
      });
    }
    for (const c of (t.cases || []) as Array<Record<string, unknown>>) {
      items.push({ id: String(c.caseId), title: String(c.task || c.caseId), desc: 'verified outcome case', status: 'INFO', meta: String(c.createdAt || '') });
    }
    return items;
  }
  if (hubActiveTab === 'root-causes') {
    const groups = (s.rootCauses?.groups || []) as Array<{ key: string; count: number; issueClass: string; worstSeverity: string; latestMessage?: string }>;
    return groups.map((g) => ({
      id: g.key, title: g.key, desc: g.latestMessage || '',
      status: g.worstSeverity === 'P0' || g.worstSeverity === 'P1' ? 'DEGRADED' : 'UNKNOWN',
      meta: `×${g.count} · ${g.issueClass}`,
    }));
  }
  if (hubActiveTab === 'regressions') {
    const r = s.regressions || {};
    const items: CoreListItem[] = [{
      id: '__regressions__', title: 'Replay engine',
      desc: r.replayEngineAvailable ? 'available' : 'unavailable',
      status: r.status || 'UNKNOWN', meta: r.reasonCode || '',
    }];
    for (const row of (r.rows || []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(row.regressionId), title: String(row.newKnowledge || row.regressionId),
        desc: `replayResult: ${row.replayResult || 'n/a'}`,
        status: row.replayResult === 'PASS' ? 'HEALTHY' : 'DEGRADED',
        meta: String(row.createdAt || ''),
      });
    }
    return items;
  }
  return [];
}

function renderCoreHubList(search: string) {
  if (!hubItemsList) return;
  const items = coreListItems().filter((it) =>
    it.title.toLowerCase().includes(search) || it.desc.toLowerCase().includes(search) || it.id.toLowerCase().includes(search));
  if (items.length === 0) {
    hubItemsList.innerHTML = `<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">${hubCoreState ? 'Không có mục nào.' : 'Đang tải dữ liệu Core…'}</div>`;
    return;
  }
  items.forEach((it) => {
    const item = document.createElement('div');
    item.className = `hub-list-item ${hubCoreSelected?.id === it.id ? 'selected' : ''}`;
    // The selection key is mirrored on the DOM so a row can be addressed by
    // identity: the auto-selected surface row is always index 0, which makes
    // positional selection silently point at the wrong row.
    item.setAttribute('data-item-id', it.id);
    item.innerHTML = `
      <div class="hub-item-top">
        <span class="hub-item-title">${escapeHtml(it.title)}</span>
        <span class="hub-item-pill">${escapeHtml(it.status)}</span>
      </div>
      <div class="hub-item-desc">${escapeHtml(it.desc)}</div>
      <div class="hub-item-meta"><span>${escapeHtml(it.meta)}</span></div>`;
    item.onclick = () => { void selectCoreItem(it.id); };
    hubItemsList.appendChild(item);
  });
}

function renderCoreListSelection() {
  const items = coreListItems();
  if (items.length > 0 && items[0]) {
    void selectCoreItem(items[0].id);
  } else {
    showCoreDetailEmpty();
  }
}

function showCoreDetailEmpty() {
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubDetailEmpty) hubDetailEmpty.style.display = 'flex';
}

// ---- MCP Dispatch accounting (ledger population, not the capability catalogue) ----
// This tab renders `antifan:mcp-dispatch:get-state`, whose rows come from the
// control-plane invocation ledger. Every string it shows is either persisted
// (`frame.name`, the `frame.error.code` histogram keys) or injected (`reasonCode`,
// `affected[]`, `storePath`), so each interpolation passes escapeHtml (:1542) and
// every non-template assignment uses textContent (plan.md constraint E). Nothing
// here re-derives a payload value: the covered window is read from Phase 1's
// `census.limits.windowNewestMtimeMs`/`windowOldestMtimeMs` and the margin label is
// printed verbatim.

interface McpDispatchListItem {
  id: string;
  kind: 'notice' | 'overview' | 'name' | 'margin' | 'truncation' | 'core-hole';
  title: string;
  desc: string;
  status: string;
  meta: string;
  category: string;
  row: any;
}

// The two GENERAL reconciliation forms are printed verbatim (plan.md Success
// Criteria). Phase 3's `reconciliation.lines` carry the same two forms with the
// numbers filled in and are printed beside them, so the invariant cannot be
// restated as the `keylessFrames === 0` special case that is false by construction
// whenever a frame reaches admission without a validated composite.
const MCP_DISPATCH_KEYS_INVARIANT = 'classifiedKeys + unattributedKeys == compositeKeys';
const MCP_DISPATCH_FRAMES_INVARIANT = 'frames == compositeKeys + superseded + keylessFrames';

// The launch paths that cannot carry the proxy store's environment variable
// (phase-05-core-proxy-emitter.md "Coverage is disclosed per launch path"). The
// two package.json anchors and the Codex child-env anchor were re-read live; the
// "no AntiFan MCP server in ~/.codex/config.toml" half is phase-05's measurement,
// cited rather than re-asserted here.
const MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS = [
  'bin.antifan-mcp (package.json:12) — spawned directly, never receives ANTIFAN_PROXY_TELEMETRY_DIR',
  'npm run mcp (package.json:17) — same proxy, same missing variable',
  'Codex — src/main/agent/codex-execution-backend.ts:81-100 builds the child env and injects no proxy telemetry path',
];

/**
 * The renderer-local UNMEASURED envelope. Used when the bridge method is absent or
 * its promise rejects: the tab must render a well-formed UNMEASURED notice rather
 * than a blank pane, and `IPC_FAILED`/`NO_DATA` are renderer-local codes, not
 * members of the service's UnmeasuredReason enum.
 */
function unmeasuredRendererFallback(reasonCode: string, affected: string[] = []): any {
  return {
    status: 'UNMEASURED',
    reasonCode,
    affected,
    evidenceRefs: [],
    asOf: new Date().toISOString(),
    storePath: '—',
    census: null,
    fileRollups: [],
    rows: [],
    totals: null,
    reconciliation: null,
  };
}

/**
 * `storePath` is a display label or null. Null is the NO_DATA_ROOT_RESOLVED case —
 * a first-class state with its own copy — so it renders the reasonCode, never the
 * text "null" and never an invented placeholder path (constraint D).
 */
function mcpDispatchStoreLabel(payload: any): string {
  if (payload && typeof payload.storePath === 'string' && payload.storePath.length > 0) return payload.storePath;
  return String(payload?.reasonCode ?? 'NO_DATA');
}

/** A count is only a count when the payload carries a number; otherwise UNMEASURED. */
function mcpDispatchCount(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'UNMEASURED';
}

function mcpDispatchHistogram(map: unknown, limit: number): string {
  if (!map || typeof map !== 'object') return 'UNMEASURED';
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length === 0) return 'UNMEASURED';
  const sorted = entries.slice().sort((a, b) => {
    const an = typeof a[1] === 'number' ? a[1] : -1;
    const bn = typeof b[1] === 'number' ? b[1] : -1;
    if (an !== bn) return bn - an;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return sorted.slice(0, limit).map(([key, value]) => `${key}×${mcpDispatchCount(value)}`).join(' · ');
}

function mcpDispatchMs(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}ms` : 'UNMEASURED';
}

/** `count === 0` is not a measurement: an empty latency sample renders UNMEASURED. */
function mcpDispatchLatency(latency: unknown): string {
  if (!latency || typeof latency !== 'object') return 'UNMEASURED';
  const sample = latency as { count?: unknown; p50Ms?: unknown; p95Ms?: unknown };
  if (typeof sample.count !== 'number' || !Number.isFinite(sample.count) || sample.count === 0) return 'UNMEASURED';
  return `p50 ${mcpDispatchMs(sample.p50Ms)} · p95 ${mcpDispatchMs(sample.p95Ms)} (n=${sample.count})`;
}

/**
 * The covered window of a truncated read. Phase 1 owns these two fields; deriving
 * the window from `census.files` or from row timestamps would be a second source
 * of truth for the same fact.
 */
function mcpDispatchWindow(census: any): string {
  const limits = census?.limits;
  const stamp = (value: unknown) => (typeof value === 'number' && Number.isFinite(value)
    ? `${new Date(value).toISOString()} (${value})`
    : 'UNMEASURED');
  return `newest ${stamp(limits?.windowNewestMtimeMs)} → oldest ${stamp(limits?.windowOldestMtimeMs)}`;
}

/**
 * The read facts an UNMEASURED payload may still carry. An UNMEASURED status with a
 * non-null `census` means the store WAS read and yielded nothing admissible (census
 * drift, a degenerate ceiling with `filesRead === 0`, or a partition that vanished
 * between census and read) — which must not read as "nothing was read at all".
 * Every value is read verbatim from `census.limits`; a field the payload does not
 * carry renders nothing rather than a fabricated count, and `census === null` yields
 * '' so that case keeps the reasonCode-only copy.
 */
function mcpDispatchReadFacts(payload: any): string {
  const limits = payload?.census?.limits;
  if (!limits || typeof limits !== 'object') return '';
  const facts: string[] = [];
  // Both counts print when the payload carries both: the degenerate-ceiling case is
  // exactly `observedFiles` large with `filesRead` 0, and printing only the first
  // would hide the state this line exists to disclose.
  if (typeof limits.observedFiles === 'number' && Number.isFinite(limits.observedFiles)) {
    facts.push(`census.limits.observedFiles: ${limits.observedFiles}`);
  }
  if (typeof limits.filesRead === 'number' && Number.isFinite(limits.filesRead)) {
    facts.push(`census.limits.filesRead: ${limits.filesRead}`);
  }
  facts.push(`census.limits.outcome: ${typeof limits.outcome === 'string' && limits.outcome.length > 0 ? limits.outcome : 'UNMEASURED'}`);
  if (limits.ceiling !== null && limits.ceiling !== undefined) {
    facts.push(`census.limits.ceiling: ${String(limits.ceiling)}`);
  }
  return facts.join(' · ');
}

function mcpDispatchListItems(): McpDispatchListItem[] {
  const payload = hubMcpDispatch;
  if (!payload) return [];
  const rows: any[] = Array.isArray(payload.rows) ? payload.rows : [];

  if (payload.status !== 'MEASURED' && rows.length === 0) {
    const status = String(payload.status ?? 'UNMEASURED');
    const reasonCode = String(payload.reasonCode ?? 'NO_DATA');
    const affected = Array.isArray(payload.affected) ? payload.affected.map((a: unknown) => String(a)).join(' · ') : '';
    const readFacts = mcpDispatchReadFacts(payload);
    return [{
      id: 'mcpDispatchNotice', kind: 'notice', title: status,
      // The read facts are repeated here so the auto-selected detail pane cannot
      // contradict the notice beside it (both print the same helper's output).
      desc: `${reasonCode} · ${mcpDispatchStoreLabel(payload)}${readFacts ? ` · read: ${readFacts}` : ''}`,
      status, meta: affected, category: reasonCode, row: null,
    }];
  }

  const items: McpDispatchListItem[] = [];
  const reconciliation = payload.reconciliation || null;
  const invariantLines: string[] = Array.isArray(reconciliation?.lines)
    ? (reconciliation.lines as unknown[]).map((line) => String(line))
    : [];
  items.push({
    id: 'mcpDispatchReconciliation',
    kind: 'overview',
    title: 'Đối soát (Reconciliation)',
    desc: [MCP_DISPATCH_KEYS_INVARIANT, MCP_DISPATCH_FRAMES_INVARIANT, ...invariantLines].join('\n'),
    status: String(payload.status ?? 'UNMEASURED'),
    meta: `asOf ${String(payload.asOf ?? 'UNMEASURED')} · ${mcpDispatchStoreLabel(payload)}`,
    category: 'RECONCILIATION',
    row: null,
  });

  rows.forEach((row, index) => {
    // Rows describe RETAINED frames only, and a short read or an input ceiling
    // makes every count a floor: the marker is rendered, never rounded away.
    const lowerBound = row?.lowerBound === true;
    items.push({
      id: `mcpDispatchRow:${index}`,
      kind: 'name',
      title: String(row?.name ?? ''),
      desc: `states: ${mcpDispatchHistogram(row?.states, 8)} · errors: ${mcpDispatchHistogram(row?.errors, 6)}`
        + ` · latency: ${mcpDispatchLatency(row?.latency)} · excluded: ${mcpDispatchLatency(row?.excludedLatency)}`
        + (lowerBound ? ' · sàn (lowerBound): đây là sàn, không phải tổng lịch sử' : ''),
      status: lowerBound ? '≥ LOWER BOUND' : 'RETAINED',
      meta: `${lowerBound ? '≥ ' : ''}calls ${mcpDispatchCount(row?.calls)} · frames ${mcpDispatchCount(row?.frames)}`
        + ` · superseded ${mcpDispatchCount(row?.superseded)}`
        + ` · window ${String(row?.firstSeen ?? 'UNMEASURED')} → ${String(row?.lastSeen ?? 'UNMEASURED')}`,
      category: 'DISPATCH NAME',
      row,
    });
  });

  const totals = payload.totals || null;
  const margin = totals?.quarantineMargin || null;
  if (margin) {
    items.push({
      id: 'mcpDispatchQuarantineMargin', kind: 'margin',
      title: 'Chuẩn cách ly (quarantine margin)',
      desc: String(margin.label ?? 'UNMEASURED'),
      status: 'MARGIN', meta: '', category: 'QUARANTINE_MARGIN', row: null,
    });
  }

  const truncation = totals?.truncation || null;
  if (truncation) {
    const filesRead = truncation.filesRead;
    const filesSkipped = truncation.filesSkipped;
    // The label is built from the payload's own integers; a missing field renders
    // UNMEASURED rather than a fabricated 0.
    const partial = (typeof filesRead === 'number' && typeof filesSkipped === 'number')
      ? `partial: ${filesRead} of ${filesRead + filesSkipped} files`
      : 'partial: UNMEASURED of UNMEASURED files';
    items.push({
      id: 'mcpDispatchTruncation', kind: 'truncation',
      title: 'Đọc một phần (truncation)',
      desc: partial,
      status: 'PARTIAL', meta: '', category: 'POPULATION_TRUNCATED', row: null,
    });
  }

  // Unconditional in this phase: Phase 5 either fills this hole with measured
  // proxy attempts or leaves it named. A store nothing reads is not telemetry.
  items.push({
    id: 'mcpDispatchCoreHole', kind: 'core-hole',
    title: 'Lỗ core.* (chưa đo được)',
    desc: 'core.* không có frame nào trong ledger: lệnh trả về trong tiến trình trước khi định danh invocation được cấp'
      + ' (scripts/antifan-omp-mcp.cjs: nhánh core.* trả về trước cổng bootstrap). Đơn vị: proxy-attempt · nguồn: omp-proxy.'
      + ' 0 lần thử nghĩa là CHƯA ĐƯỢC GHI NHẬN, không phải "không dùng".',
    status: 'UNMEASURED',
    meta: MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS.join(' · '),
    category: 'CORE_HOLE',
    row: null,
  });

  return items;
}

/** The one non-metric notice: UNMEASURED + reasonCode + storePath label, no rows. */
function renderMcpDispatchNotice() {
  if (!hubItemsList) return;
  const payload = hubMcpDispatch;
  const status = String(payload?.status ?? 'UNMEASURED');
  const reasonCode = String(payload?.reasonCode ?? 'NO_DATA');
  const affected = Array.isArray(payload?.affected)
    ? (payload.affected as unknown[]).map((entry) => String(entry)).join(' · ')
    : '';
  const readFacts = mcpDispatchReadFacts(payload);
  const notice = document.createElement('div');
  notice.id = 'mcpDispatchNotice';
  notice.setAttribute('style', 'color:#64748b;font-size:12px;padding:20px;text-align:center;white-space:pre-line;');
  // textContent, not a template: reasonCode / storePath / affected and every
  // census-derived read fact are injected or persisted strings.
  notice.textContent = `${status}\n${reasonCode} · ${mcpDispatchStoreLabel(payload)}`
    + `${readFacts ? `\nread: ${readFacts}` : ''}`
    + `${affected ? `\naffected: ${affected}` : ''}`;
  hubItemsList.innerHTML = '';
  hubItemsList.appendChild(notice);
}

function renderMcpDispatchList(search: string) {
  if (!hubItemsList) return;
  if (!hubMcpDispatch) {
    hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Đang tải dữ liệu MCP Dispatch…</div>';
    return;
  }
  const rows: any[] = Array.isArray(hubMcpDispatch.rows) ? hubMcpDispatch.rows : [];
  if (hubMcpDispatch.status !== 'MEASURED' && rows.length === 0) {
    renderMcpDispatchNotice();
    return;
  }

  const needle = (search || '').toLowerCase().trim();
  const items = mcpDispatchListItems().filter((it) => {
    // The search box filters per-name rows ONLY: an UNMEASURED notice, the
    // quarantine margin, the truncation label and the core.* hole are disclosures
    // and must never be hideable by a search box.
    if (it.kind !== 'name') return true;
    if (!needle) return true;
    return it.title.toLowerCase().includes(needle);
  });

  hubItemsList.innerHTML = '';
  for (const it of items) {
    const item = document.createElement('div');
    item.className = `hub-list-item ${hubMcpDispatchSelected?.id === it.id ? 'selected' : ''}`;
    // Assigned as a DOM property, so a row value can never be parsed as markup.
    item.id = it.id;
    if (it.kind === 'margin' || it.kind === 'truncation') {
      // These two rows carry their labelled line and nothing else, so the element's
      // text is exactly the label the envelope published.
      item.innerHTML = `<div class="hub-item-desc">${escapeHtml(it.desc)}</div>`;
    } else {
      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(it.title)}</span>
          <span class="hub-item-pill">${escapeHtml(it.status)}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(it.desc)}</div>
        <div class="hub-item-meta"><span>${escapeHtml(it.meta)}</span></div>`;
    }
    item.onclick = () => { void selectMcpDispatchRow(it.id); };
    hubItemsList.appendChild(item);
  }
}

function renderMcpDispatchSelection() {
  const items = mcpDispatchListItems();
  const first = items[0];
  if (first) {
    void selectMcpDispatchRow(first.id);
  } else {
    showCoreDetailEmpty();
  }
}

function mcpDispatchDetailBody(item: McpDispatchListItem | null): unknown {
  const payload = hubMcpDispatch;
  if (!item) {
    return {
      status: String(payload?.status ?? 'UNMEASURED'),
      reasonCode: String(payload?.reasonCode ?? 'NO_DATA'),
      storePath: payload?.storePath ?? null,
      storeLabel: mcpDispatchStoreLabel(payload),
      affected: Array.isArray(payload?.affected) ? payload.affected : [],
      asOf: payload?.asOf ?? null,
      evidenceRefs: Array.isArray(payload?.evidenceRefs) ? payload.evidenceRefs : [],
    };
  }
  if (item.kind === 'name') {
    const row = item.row;
    return {
      name: row?.name, calls: row?.calls, frames: row?.frames, superseded: row?.superseded,
      lowerBound: row?.lowerBound === true,
      firstSeen: row?.firstSeen ?? null, lastSeen: row?.lastSeen ?? null,
      states: row?.states ?? null, errors: row?.errors ?? null,
      latency: row?.latency ?? null, excludedLatency: row?.excludedLatency ?? null,
    };
  }
  if (item.kind === 'overview') {
    const reconciliation = payload?.reconciliation || null;
    return {
      status: payload?.status ?? null,
      reasonCode: payload?.reasonCode ?? null,
      asOf: payload?.asOf ?? null,
      storeLabel: mcpDispatchStoreLabel(payload),
      invariants: [MCP_DISPATCH_KEYS_INVARIANT, MCP_DISPATCH_FRAMES_INVARIANT],
      reconciliation,
      reconciliationLines: Array.isArray(reconciliation?.lines) ? reconciliation.lines : [],
    };
  }
  if (item.kind === 'margin') {
    const margin = payload?.totals?.quarantineMargin || null;
    return {
      label: margin?.label ?? 'UNMEASURED',
      files: margin?.files ?? null,
      framesPresent: margin?.framesPresent ?? null,
      framesAdmitted: margin?.framesAdmitted ?? null,
      framesNamedInvalid: margin?.framesNamedInvalid ?? null,
      reasons: margin?.reasons ?? [],
    };
  }
  if (item.kind === 'truncation') {
    const truncation = payload?.totals?.truncation || null;
    return {
      label: item.desc,
      ceiling: truncation?.ceiling ?? null,
      filesRead: truncation?.filesRead ?? null,
      filesSkipped: truncation?.filesSkipped ?? null,
      order: truncation?.order ?? null,
      // Phase 1's own fields — never re-derived from census.files or row timestamps.
      coveredWindow: mcpDispatchWindow(payload?.census),
      windowNewestMtimeMs: payload?.census?.limits?.windowNewestMtimeMs ?? null,
      windowOldestMtimeMs: payload?.census?.limits?.windowOldestMtimeMs ?? null,
    };
  }
  if (item.kind === 'core-hole') {
    return {
      unit: 'proxy-attempt',
      provenance: 'omp-proxy',
      launchPathsThatCannotCarryTheEnvironmentVariable: MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS,
      zeroAttemptsMeans: 'not yet instrumented — never "unused"',
    };
  }
  return {
    status: String(payload?.status ?? 'UNMEASURED'),
    reasonCode: String(payload?.reasonCode ?? 'NO_DATA'),
    storePath: payload?.storePath ?? null,
    storeLabel: mcpDispatchStoreLabel(payload),
    affected: Array.isArray(payload?.affected) ? payload.affected : [],
    // Present only when the payload carries a census: an UNMEASURED payload that was
    // read and admitted nothing still publishes what the read observed.
    censusReadFacts: mcpDispatchReadFacts(payload),
    asOf: payload?.asOf ?? null,
    evidenceRefs: Array.isArray(payload?.evidenceRefs) ? payload.evidenceRefs : [],
  };
}

async function selectMcpDispatchRow(id: string) {
  hubMcpDispatchSelected = { id };
  hubSelectedWorkflow = null;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'flex';

  const item = mcpDispatchListItems().find((it) => it.id === id) || null;
  const status = item ? item.status : 'UNMEASURED';
  // textContent only: these values are persisted or injected strings.
  if (coreDetailName) coreDetailName.textContent = item ? item.title : 'MCP Dispatch';
  if (coreDetailDesc) coreDetailDesc.textContent = item ? item.desc : '';
  if (coreStatusPill) {
    coreStatusPill.textContent = status;
    coreStatusPill.className = `hub-status-pill ${coreStatusPillClass(status)}`;
  }
  if (coreDetailCategory) coreDetailCategory.textContent = item ? item.category : 'NO_DATA';
  if (coreDetailCode) coreDetailCode.textContent = JSON.stringify(mcpDispatchDetailBody(item), null, 2);
}

/**
 * Failure-tolerant refresh, mirroring refreshCoreHealthState (:526-540): a host
 * that loads the real preload without the new handler makes `ipcRenderer.invoke`
 * reject, and the tab must degrade to a well-formed UNMEASURED notice.
 */
async function refreshMcpDispatchState() {
  try {
    const res = await getApi()?.getMcpDispatchState?.();
    hubMcpDispatch = res ?? unmeasuredRendererFallback('NO_DATA');
  } catch (err) {
    hubMcpDispatch = unmeasuredRendererFallback('IPC_FAILED', [String(err)]);
  }
  if (badgeMcpDispatch) {
    const rows: any[] = Array.isArray(hubMcpDispatch?.rows) ? hubMcpDispatch.rows : [];
    // `–` while the truth is unknown: a `0` badge would claim "never dispatched".
    badgeMcpDispatch.textContent = hubMcpDispatch?.status === 'MEASURED' ? String(rows.length) : '–';
  }
  renderMcpDispatchList(hubSearchInput?.value || '');
}

async function selectCoreItem(id: string) {
  hubCoreSelected = { tab: hubActiveTab, id };
  hubSelectedWorkflow = null;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'flex';
  await renderCoreDetail(id);
}

async function renderCoreDetail(id: string) {
  const s = hubCoreState;
  const setHeader = (name: string, desc: string, status: string, reasonCode: string) => {
    if (coreDetailName) coreDetailName.textContent = name;
    if (coreDetailDesc) coreDetailDesc.textContent = desc;
    if (coreStatusPill) {
      coreStatusPill.textContent = status;
      coreStatusPill.className = `hub-status-pill ${coreStatusPillClass(status)}`;
    }
    if (coreDetailCategory) coreDetailCategory.textContent = reasonCode;
  };
  const setBody = (obj: unknown) => {
    if (coreDetailCode) coreDetailCode.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  };
  if (!s) {
    setHeader('Core', 'no data loaded', 'UNKNOWN', 'NO_DATA');
    setBody('Core state not loaded.');
    return;
  }

  if (hubActiveTab === 'core-health') {
    const checks = (s.snapshot?.checks || []) as Array<{ name: string; status: string; reasonCode: string; detail?: string; affected?: string[]; evidenceRefs?: string[] }>;
    const check = checks.find((c) => c.name === id);
    const snap = s.snapshot || {};
    // The crash check answers a different question from the gate checks: not "is the Core
    // healthy" but "has this runtime died, and against what evidence". Its body therefore
    // leads with the crash records — process, dump, pid — so the next action is obvious.
    if (id === 'runtime.crash') {
      const crash = (snap.crashes || { total: 0, latestAt: '', latestId: '', records: [] }) as {
        total: number; latestAt: string; latestId: string; records: unknown[];
      };
      setHeader(
        'runtime.crash',
        String(check?.detail || `${crash.total} browser-process crash(es)`),
        String(check?.status || (crash.total > 0 ? 'DEGRADED' : 'UNKNOWN')),
        String(check?.reasonCode || 'NO_CRASH_RECORDED'),
      );
      setBody({
        total: crash.total,
        latestAt: crash.latestAt,
        latestId: crash.latestId,
        records: crash.records,
        affected: check?.affected || [],
        evidenceRefs: check?.evidenceRefs || [],
        snapshotStats: snap.stats,
        openIssues: snap.openIssues,
      });
      return;
    }
    if (check) {
      setHeader(check.name, check.detail || '', check.status, check.reasonCode);
      setBody({ ...check, snapshotStats: snap.stats, audit: snap.audit, decay: snap.decay, uncertainty: snap.uncertainty, openIssues: snap.openIssues });
    } else {
      setHeader('Core Health', String(snap.checkedAt || ''), String(snap.status || 'UNKNOWN'), String(snap.reasonCode || 'NO_DATA'));
      setBody(snap);
    }
    return;
  }
  if (hubActiveTab === 'bridge') {
    const b = s.bridge || {};
    if (id === '__bridge__') {
      setHeader('Core Bridge', b.telemetryFound ? 'telemetry file found' : 'no telemetry file', String(b.status || 'UNKNOWN'), String(b.reasonCode || ''));
      setBody({ coreReachable: b.coreReachable, telemetryPaths: b.telemetryPaths, failures: b.failures, unknowns: b.unknowns });
    } else {
      const pack = ((b.recentPacks || []) as Array<Record<string, unknown>>).find((p) => p.packId === id);
      setHeader(id, String(pack?.task || ''), 'INFO', 'PACK');
      setBody(pack || 'pack not found');
    }
    return;
  }
  if (hubActiveTab === 'task-runs') {
    const t = s.taskRuns || {};
    if (id === '__task_runs__') {
      setHeader('Task runs', t.taskRunsTable ? 'task_runs table present' : 'task_runs table absent — no producer writes it', String(t.status || 'UNKNOWN'), String(t.reasonCode || ''));
      setBody({ taskRunsTable: t.taskRunsTable, affected: t.affected, taskRuns: t.taskRuns });
      return;
    }
    if (coreDetailCode) coreDetailCode.textContent = 'Đang tải trace…';
    try {
      const trace = await getApi()?.getCoreTaskRunTrace?.(id);
      setHeader(id, String(trace?.kind || ''), String(trace?.status || 'UNKNOWN'), String(trace?.reasonCode || ''));
      setBody(trace || 'trace unavailable');
    } catch (err) {
      setHeader(id, '', 'UNAVAILABLE', 'IPC_FAILED');
      setBody(String(err));
    }
    return;
  }
  if (hubActiveTab === 'root-causes') {
    const groups = (s.rootCauses?.groups || []) as Array<{ key: string; worstSeverity: string; issueClass: string; latestMessage?: string }>;
    const g = groups.find((x) => x.key === id);
    if (g) {
      setHeader(g.key, g.latestMessage || '', g.worstSeverity === 'P0' || g.worstSeverity === 'P1' ? 'DEGRADED' : 'UNKNOWN', g.issueClass);
      setBody(g);
    }
    return;
  }
  if (hubActiveTab === 'regressions') {
    const r = s.regressions || {};
    if (id === '__regressions__') {
      setHeader('Core Regression', r.replayEngineAvailable ? 'replay engine available' : 'replay engine unavailable', String(r.status || 'UNKNOWN'), String(r.reasonCode || ''));
      setBody({ replayEngineAvailable: r.replayEngineAvailable, rows: r.rows });
    } else {
      const row = ((r.rows || []) as Array<Record<string, unknown>>).find((x) => x.regressionId === id);
      setHeader(id, String(row?.newKnowledge || ''), row?.replayResult === 'PASS' ? 'HEALTHY' : 'DEGRADED', String(row?.replayResult || 'NO_RESULT'));
      setBody(row || 'row not found');
    }
    return;
  }
}

function setHubTab(tab: HubTab) {
  hubActiveTab = tab;
  for (const t of Object.keys(HUB_NAV_BUTTONS) as HubTab[]) {
    const btn = HUB_NAV_BUTTONS[t];
    if (btn) btn.classList.toggle('active', t === tab);
  }
  hubCoreSelected = null;
  // The provenance line belongs to the MCP Dispatch tab's counts, so it is shown
  // exactly with that tab. Visibility only — its text never depends on the data.
  if (hubMcpDispatchProvenance) {
    hubMcpDispatchProvenance.style.display = tab === 'mcp-dispatch' ? 'block' : 'none';
  }
  renderHubList();
  if (tab === 'workflows') {
    if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
  } else if (tab === 'mcp') {
    if (hubMcpTools.length > 0) selectMcpTool(hubMcpTools[0]);
  } else if (tab === 'mcp-dispatch') {
    renderMcpDispatchSelection();
  } else {
    renderCoreListSelection();
  }
}
function selectMcpTool(tool: any) {
  hubSelectedMcpTool = tool;
  hubSelectedWorkflow = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'flex';

  if (mcpDetailCategory) {
    mcpDetailCategory.textContent = (tool.category || 'BROWSER').toUpperCase();
    mcpDetailCategory.className = `hub-cat-pill pill-${tool.category || 'browser'}`;
  }
  if (mcpDetailName) mcpDetailName.textContent = tool.name;
  if (mcpDetailDesc) mcpDetailDesc.textContent = tool.description || 'Không có mô tả chi tiết.';
  if (mcpDetailPermission) {
    mcpDetailPermission.textContent = `Quyền Yêu Cầu: ${(tool.permissions || ['read']).join(', ')}`;
  }
  if (mcpSchemaCode) {
    try {
      mcpSchemaCode.textContent = JSON.stringify(tool.inputSchema || {}, null, 2);
    } catch {
      mcpSchemaCode.textContent = String(tool.inputSchema);
    }
  }
}

async function runActiveWorkflow() {
  if (!hubSelectedWorkflow || isWorkflowRunning) return;
  isWorkflowRunning = true;

  if (btnRunWorkflow) btnRunWorkflow.style.display = 'none';
  if (btnStopWorkflow) btnStopWorkflow.style.display = 'flex';
  if (hubRunStatusBar) hubRunStatusBar.style.display = 'flex';
  if (runStatusPill) {
    runStatusPill.className = 'hub-status-pill pill-running';
    runStatusPill.textContent = 'RUNNING';
  }
  if (runCurrentStepText) runCurrentStepText.textContent = 'Bắt đầu khởi chạy workflow...';
  if (hubProgressBar) hubProgressBar.style.width = '5%';

  const steps = hubSelectedWorkflow.definition?.steps || [];
  steps.forEach((s: any, idx: number) => {
    const pill = document.getElementById(`step-status-${s.id || idx}`);
    if (pill) {
      pill.className = 'hub-step-status step-status-pending';
      pill.textContent = 'PENDING';
    }
    const card = document.getElementById(`step-card-${s.id || idx}`);
    if (card) {
      card.className = 'hub-step-card';
    }
  });

  runStartTime = Date.now();
  if (runTimerInterval) clearInterval(runTimerInterval);
  runTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
    if (runTimerText) runTimerText.textContent = `${elapsed}s`;
  }, 100);

  try {
    const res = await getApi()?.runWorkflow({ workflowId: hubSelectedWorkflow.id, workflowDef: hubSelectedWorkflow.definition });
    if (res) {
      const isPassed = res.status === 'passed';
      // `completed_with_errors` means every step ran and the failures were handled by
      // `continueOnError`; it is not a failed run. A precondition refusal is a blocked run, not a
      // failed one — the main process reports it as FORBIDDEN_SENDER or an explicit `blocked`.
      const isCompletedWithErrors = res.status === 'completed_with_errors';
      const isBlocked = res.status === 'blocked' || (res.ok === false && res.error === 'FORBIDDEN_SENDER');
      if (runStatusPill) {
        if (isPassed) {
          runStatusPill.className = 'hub-status-pill pill-passed';
          runStatusPill.textContent = 'PASSED (100%)';
        } else if (isCompletedWithErrors) {
          runStatusPill.className = 'hub-status-pill pill-interrupted';
          runStatusPill.textContent = 'COMPLETED WITH ERRORS';
        } else if (isBlocked) {
          runStatusPill.className = 'hub-status-pill step-blocked';
          runStatusPill.textContent = 'BLOCKED';
        } else {
          runStatusPill.className = 'hub-status-pill pill-failed';
          runStatusPill.textContent = (res.status || 'FAILED').toUpperCase();
        }
      }
      if (runCurrentStepText) {
        if (isBlocked) {
          runCurrentStepText.textContent = `Bị chặn: ${res.error || 'Precondition refused'}`;
        } else {
          runCurrentStepText.textContent = `Hoàn thành: ${res.passedSteps || 0}/${steps.length} bước thành công (${((res.totalDurationMs || 0) / 1000).toFixed(2)}s)`;
        }
      }
      if (hubProgressBar) {
        hubProgressBar.style.width = '100%';
        if (isBlocked) {
          hubProgressBar.style.backgroundColor = '#f59e0b';
        }
      }

      if (res.artifacts && res.artifacts.length > 0 && wfArtifactsSection && wfArtifactsGrid) {
        wfArtifactsSection.style.display = 'flex';
        wfArtifactsGrid.innerHTML = '';
        for (const art of res.artifacts) {
          const card = document.createElement('div');
          card.className = 'hub-artifact-card';
          card.innerHTML = `
            <div class="hub-artifact-preview">
              <span style="font-size:32px;">📸</span>
            </div>
            <div class="hub-artifact-meta">
              <div class="hub-artifact-title">${escapeHtml(art.name || art.id)}</div>
              <div class="hub-artifact-desc">${escapeHtml(art.mimeType || 'artifact')} (${Math.round((art.sizeBytes || 0) / 1024)} KB)</div>
            </div>
          `;
          try {
            getApi()?.getWorkflowArtifact(art.id).then((fullArt) => {
              if (fullArt && fullArt.data && fullArt.mimeType.startsWith('image/')) {
                const preview = card.querySelector('.hub-artifact-preview');
                if (preview) {
                  preview.innerHTML = `<img src="${fullArt.data}" alt="${escapeHtml(art.name || '')}" />`;
                }
              }
            }).catch(() => null);
          } catch {}
          wfArtifactsGrid.appendChild(card);
        }
      }
      showToolbarToast(isPassed ? '✅ Workflow chạy hoàn tất thành công!' : '⚠️ Workflow kết thúc có lỗi.');
    }
  } catch (err: any) {
    console.error('[workflow] Run failed:', err);
    if (runStatusPill) {
      runStatusPill.className = 'hub-status-pill pill-failed';
      runStatusPill.textContent = 'ERROR';
    }
    if (runCurrentStepText) runCurrentStepText.textContent = `Lỗi: ${err.message || String(err)}`;
    showToolbarToast(`❌ Lỗi chạy workflow: ${err.message || String(err)}`);
  } finally {
    isWorkflowRunning = false;
    if (runTimerInterval) {
      clearInterval(runTimerInterval);
      runTimerInterval = null;
    }
    if (btnRunWorkflow) btnRunWorkflow.style.display = 'flex';
    if (btnStopWorkflow) btnStopWorkflow.style.display = 'none';
  }
}

async function stopActiveWorkflow() {
  try {
    await getApi()?.abortWorkflow();
    showToolbarToast('⏹ Đã yêu cầu dừng Workflow.');
  } catch (err) {
    console.error('[workflow] Failed to abort:', err);
  }
}
function hostname(u: string): string {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let draggedTabId: string | null = null;
let lastTabsSignature = '';
let lastBookmarksSignature = '';
let lastChromeProfileName = '';
let lastAppliedDevicePresetId: string | null = null;
let lastAppliedSplitMode: boolean | null = null;
let lastAppliedSplitDesktopPresetId: string | null = null;
let lastAppliedSplitMobilePresetId: string | null = null;
let lastAppliedSplitFocusedPane: string | null = null;
let lastAppliedZoomText = '';
let lastAppliedBackDisabled: boolean | null = null;
let lastAppliedForwardDisabled: boolean | null = null;
let lastAppliedAgentControlled: boolean | null = null;

function computeTabsSignature(tabs: AntiFanTab[], activeId: string): string {
  let sig = activeId + ':' + tabs.length;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (!t) continue;
    sig += `;${t.id},${t.title || ''},${t.url || ''},${t.favicon || ''},${t.isLoading ? 1 : 0},${t.themeError || ''},${t.isAudible ? 1 : 0},${t.isMuted ? 1 : 0},${t.aiState || ''},${t.isAgentControlled ? 1 : 0}`;
  }
  return sig;
}

function computeBookmarksSignature(bookmarks: Array<{ id?: string; title?: string; url: string }>, activeTab: AntiFanTab | undefined): string {
  const activeUrl = activeTab ? (activeTab.url || '') : '';
  // isBookmarkBarVisible must be part of the signature: toggling the bar changes
  // neither bookmarks nor activeTab, so without it renderBookmarks() is skipped
  // and the bar stays hidden while the host expands the strip by 28px.
  let sig = `${activeUrl}:${isBookmarkBarVisible ? 1 : 0}:${bookmarks.length}`;
  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i];
    if (b) sig += `;${b.url}`;
  }
  return sig;
}

/**
 * Child refs of one tab element, resolved once per element.
 *
 * The strip re-renders on every state broadcast and its signature includes `title`,
 * so a retitling page drives this at up to 5 Hz; before the cache, each pass re-queried
 * seven children per tab with attribute/class selectors (~210 DOM queries/s on a six-tab
 * strip). A WeakMap keeps the refs with the element, so a closed tab's entry dies with it.
 */
interface TabElementRefs {
  indexBadge: HTMLElement | null;
  spinner: HTMLElement | null;
  icon: HTMLImageElement | null;
  statusDot: HTMLElement | null;
  titleSpan: HTMLElement | null;
  audioBtn: HTMLElement | null;
  agentBadge: HTMLElement | null;
}

const tabRefsCache = new WeakMap<HTMLElement, TabElementRefs>();

function cacheTabRefs(tabEl: HTMLElement): TabElementRefs {
  const refs: TabElementRefs = {
    indexBadge: tabEl.querySelector<HTMLElement>('.tab-index-badge'),
    spinner: tabEl.querySelector<HTMLElement>('.tab-spinner'),
    icon: tabEl.querySelector<HTMLImageElement>('.tab-icon'),
    statusDot: tabEl.querySelector<HTMLElement>('.tab-status-dot'),
    titleSpan: tabEl.querySelector<HTMLElement>('.tab-title'),
    audioBtn: tabEl.querySelector<HTMLElement>('.tab-audio-btn'),
    agentBadge: tabEl.querySelector<HTMLElement>('.tab-agent-badge'),
  };
  tabRefsCache.set(tabEl, refs);
  return refs;
}

function renderTabs() {
  if (!tabList) return;
  lastTabsSignature = computeTabsSignature(currentTabs, activeTabId);

  const currentTabIds = new Set(currentTabs.map((t) => t.id));
  
  // 1. Remove closed tabs
  Array.from(tabList.children).forEach((child) => {
    const tabId = child.getAttribute('data-tab-id');
    if (tabId && !currentTabIds.has(tabId)) {
      child.remove();
    }
  });

  // One pass over the surviving children replaces a per-tab attribute query: the
  // strip re-renders on every broadcast, so that lookup ran for every tab each time.
  const tabElById = new Map<string, HTMLElement>();
  for (const child of Array.from(tabList.children)) {
    const tabId = child.getAttribute('data-tab-id');
    if (tabId) tabElById.set(tabId, child as HTMLElement);
  }

  // 2. Update or insert tabs
  currentTabs.forEach((tab, index) => {
    // The condition below guarantees an element: every current tab is either already in
    // the map or created and appended in this iteration. The assertion keeps the type
    // the previous per-tab `querySelector(...) as HTMLElement` gave its closures.
    let tabEl = tabElById.get(tab.id) as HTMLElement;
    const isActive = tab.id === activeTabId;

    if (!tabEl) {
      tabEl = document.createElement('div');
      tabEl.setAttribute('data-tab-id', tab.id);
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('draggable', 'true');
      
      tabEl.innerHTML = `
        <span class="tab-index-badge">#${index + 1}</span>
        <span class="tab-spinner" style="display:none;"></span>
        <img class="tab-icon" src="" alt=""/>
        <span class="tab-title"></span>
        <span class="tab-agent-badge" style="display:none;">🤖 AGENT</span>
        <span class="tab-audio-btn" style="display:none;" title="Tắt tiếng tab"></span>
        <span class="tab-status-dot done" title="Ready"></span>
        <span class="tab-close" title="Close Tab"></span>
      `;

      const closeBtn = tabEl.querySelector('.tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        });
        closeBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
      }

      tabEl.querySelector('.tab-audio-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        getApi()?.toggleMute(tab.id);
      });

      tabEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.tab-close, .tab-audio-btn')) return;
        hideTabContextMenu();
        getApi()?.switchTab(tab.id);
      });
      tabEl.addEventListener('keydown', (e) => {
        const tabs = Array.from(tabList.querySelectorAll<HTMLElement>('.tab'));
        const currIdx = tabs.indexOf(tabEl);
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          const nextTab = tabs[(currIdx + 1) % tabs.length];
          nextTab?.focus();
          const nextId = nextTab?.getAttribute('data-tab-id');
          if (nextId) getApi()?.switchTab(nextId);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevTab = tabs[(currIdx - 1 + tabs.length) % tabs.length];
          prevTab?.focus();
          const prevId = prevTab?.getAttribute('data-tab-id');
          if (prevId) getApi()?.switchTab(prevId);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          getApi()?.switchTab(tab.id);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        }
      });

      tabEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        }
      });

      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, tab.id);
      });

      // Drag and Drop Tab Reordering
      tabEl.addEventListener('dragstart', (e) => {
        draggedTabId = tab.id;
        tabEl.classList.add('tab-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', tab.id);
        }
      });

      tabEl.addEventListener('dragend', () => {
        draggedTabId = null;
        document.querySelectorAll('.tab').forEach((el) => {
          el.classList.remove('tab-dragging', 'drag-over');
        });
      });

      tabEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        if (draggedTabId && draggedTabId !== tab.id) {
          tabEl.classList.add('drag-over');
        }
      });

      tabEl.addEventListener('dragleave', () => {
        tabEl.classList.remove('drag-over');
      });

      tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        tabEl.classList.remove('drag-over');
        if (!draggedTabId || draggedTabId === tab.id) return;
        
        const toIndex = currentTabs.findIndex((t) => t.id === tab.id);
        if (toIndex !== -1) {
          getApi()?.moveTab(draggedTabId, toIndex);
        }
      });

      tabList.appendChild(tabEl);
    }

    // Sync tab position if reordered
    if (tabList.children[index] !== tabEl) {
      tabList.insertBefore(tabEl, tabList.children[index] || null);
    }
    // Update classes & aria
    const isAiStreaming = tab.aiState === 'streaming' || tab.aiState === 'thinking';
    const isAiCompleted = tab.aiState === 'completed';
    const isAgentWorking = tab.aiState === 'agent_working';
    const isAgentControlled = tab.isAgentControlled === true;
    const hasThemeError = Boolean(tab.themeError);

    tabEl.className = `tab ${isActive ? 'active' : ''} ${isAgentControlled ? 'agent-controlled' : ''} ${isAgentWorking ? 'agent-working' : isAiStreaming ? 'ai-streaming' : ''} ${hasThemeError ? 'tab-has-error' : ''}`;
    tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) {
      // Keep the active tab on screen: with a hidden scrollbar an off-screen active tab
      // is invisible, which makes switching to a later tab look like it did nothing.
      requestAnimationFrame(() => {
        try { tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
      });
    }
    tabEl.setAttribute('tabindex', isActive ? '0' : '-1');
    // Update Spinner & Icon
    const refs = tabRefsCache.get(tabEl) || cacheTabRefs(tabEl);
    const indexBadge = refs.indexBadge;
    if (indexBadge) {
      indexBadge.textContent = `#${index + 1}`;
      indexBadge.title = `Tab #${index + 1} (ID: ${tab.id}) - Nhấp chuột phải để sao chép cho Agent`;
    }
    const spinner = refs.spinner;
    const icon = refs.icon;
    const statusDot = refs.statusDot;
    const titleSpan = refs.titleSpan;
    const audioBtn = refs.audioBtn;
    const agentBadge = refs.agentBadge;
    if (agentBadge) {
      agentBadge.style.display = isAgentControlled ? 'inline-flex' : 'none';
      if (isAgentWorking) {
        agentBadge.className = 'tab-agent-badge working';
        agentBadge.textContent = '⚡ AGENT';
      } else {
        agentBadge.className = 'tab-agent-badge';
        agentBadge.textContent = '🤖 AGENT';
      }
    }
    // Update Audio & Mute State
    if (audioBtn) {
      if (tab.isAudible || tab.isMuted) {
        audioBtn.style.display = 'inline-flex';
        if (tab.isMuted) {
          audioBtn.className = 'tab-audio-btn muted';
          audioBtn.title = 'Bật tiếng tab (Muted)';
          audioBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
        } else {
          audioBtn.className = 'tab-audio-btn playing';
          audioBtn.title = 'Tắt tiếng tab (Đang phát âm thanh)';
          audioBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
        }
      } else {
        audioBtn.style.display = 'none';
      }
    }


    if (hasThemeError) {
      if (spinner) spinner.style.display = 'none';
      if (icon) icon.style.display = 'inline-block';
      if (statusDot) {
        statusDot.style.display = 'inline-block';
        statusDot.className = 'tab-status-dot theme-error';
        statusDot.title = `⚠️ Lỗi Theme: ${tab.themeError}`;
      }
    } else if (tab.isLoading) {
      if (spinner) spinner.style.display = 'inline-block';
      if (icon) icon.style.display = 'none';
      if (statusDot) {
        statusDot.style.display = 'inline-block';
        statusDot.className = 'tab-status-dot loading';
        statusDot.title = 'Đang tải trang...';
      }
    } else {
      if (spinner) spinner.style.display = 'none';
      if (icon) {
        icon.style.display = 'inline-block';
        icon.src = tab.favicon || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
      }
      if (statusDot) {
        if (isAgentWorking) {
          statusDot.style.display = 'inline-block';
          statusDot.className = 'tab-status-dot agent-working';
          statusDot.title = '🤖 AI Agent đang điều phối tab này!';
        } else if (isAiStreaming) {
          statusDot.style.display = 'inline-block';
          statusDot.className = 'tab-status-dot ai-streaming';
          statusDot.title = '⚡ AI đang phản hồi...';
        } else if (isAiCompleted) {
          statusDot.style.display = 'inline-block';
          statusDot.className = 'tab-status-dot ai-completed';
          statusDot.title = '✓ AI đã phản hồi xong!';
        } else {
          statusDot.style.display = 'none';
          statusDot.className = 'tab-status-dot';
          statusDot.title = '';
        }
      }
    }
    const baseTitle = tab.title || hostname(tab.url) || 'New Tab';
    if (titleSpan && titleSpan.textContent !== baseTitle) {
      titleSpan.textContent = baseTitle;
    }
  });
}

function updateControls() {
  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  if (activeTab) {
    if (document.activeElement !== urlInput && urlInput) {
      const targetUrl = activeTab.url === 'about:blank' ? '' : activeTab.url;
      if (urlInput.value !== targetUrl) {
        urlInput.value = targetUrl;
      }
    }
    const canGoBack = !activeTab.canGoBack;
    if (btnBack && lastAppliedBackDisabled !== canGoBack) {
      lastAppliedBackDisabled = canGoBack;
      btnBack.disabled = canGoBack;
    }
    const canGoForward = !activeTab.canGoForward;
    if (btnForward && lastAppliedForwardDisabled !== canGoForward) {
      lastAppliedForwardDisabled = canGoForward;
      btnForward.disabled = canGoForward;
    }
    
    const pct = `${Math.round(activeTab.zoomFactor * 100)}%`;
    if (zoomLabel && pct !== lastAppliedZoomText) {
      lastAppliedZoomText = pct;
      zoomLabel.textContent = pct;
    }

    if (deviceSelect) {
      const presetId = activeTab.devicePresetId || '';
      if (presetId !== lastAppliedDevicePresetId) {
        lastAppliedDevicePresetId = presetId;
        deviceSelect.querySelectorAll('option[value^="custom-"]').forEach((o) => o.remove());
        if (presetId && /^custom-\d+x\d+$/i.test(presetId)) {
          const m = /^custom-(\d+)x(\d+)$/i.exec(presetId);
          const opt = document.createElement('option');
          opt.value = presetId;
          opt.disabled = true;
          opt.textContent = m ? `Custom (${m[1]}×${m[2]})` : presetId;
          deviceSelect.appendChild(opt);
        }
        if (presetId) {
          deviceSelect.value = presetId;
        }
      }
    }
    const isSplit = !!activeTab.splitMode;
    if (isSplit !== lastAppliedSplitMode) {
      lastAppliedSplitMode = isSplit;
      if (isSplit) {
        if (btnToggleSplit) btnToggleSplit.classList.add('mode-active');
        if (splitControlsContainer) splitControlsContainer.style.display = 'flex';
        if (deviceSelect) deviceSelect.style.display = 'none';
      } else {
        if (btnToggleSplit) btnToggleSplit.classList.remove('mode-active');
        if (splitControlsContainer) splitControlsContainer.style.display = 'none';
        if (deviceSelect) deviceSelect.style.display = 'inline-block';
      }
    }
    if (isSplit) {
      if (splitDesktopSelect && activeTab.splitDesktopPresetId && activeTab.splitDesktopPresetId !== lastAppliedSplitDesktopPresetId) {
        lastAppliedSplitDesktopPresetId = activeTab.splitDesktopPresetId;
        splitDesktopSelect.value = activeTab.splitDesktopPresetId;
      }
      if (splitMobileSelect && activeTab.splitMobilePresetId && activeTab.splitMobilePresetId !== lastAppliedSplitMobilePresetId) {
        lastAppliedSplitMobilePresetId = activeTab.splitMobilePresetId;
        splitMobileSelect.value = activeTab.splitMobilePresetId;
      }
      const focusedPane = activeTab.splitFocusedPane || 'desktop';
      if (focusedPane !== lastAppliedSplitFocusedPane) {
        lastAppliedSplitFocusedPane = focusedPane;
        if (btnSplitFocusDesktop) btnSplitFocusDesktop.classList.toggle('active', focusedPane === 'desktop');
        if (btnSplitFocusMobile) btnSplitFocusMobile.classList.toggle('active', focusedPane === 'mobile');
      }
    }

    const isAgent = !!activeTab.isAgentControlled;
    if (agentActiveBadge && isAgent !== lastAppliedAgentControlled) {
      lastAppliedAgentControlled = isAgent;
      agentActiveBadge.style.display = isAgent ? 'inline-flex' : 'none';
    }
  }
  if (btnClearOmnibox && urlInput) {
    btnClearOmnibox.style.display = urlInput.value ? 'block' : 'none';
  }

  if (btnQuickInspect) {
    if (isInspecting) btnQuickInspect.classList.add('mode-active');
    else btnQuickInspect.classList.remove('mode-active');
  }

  if (btnFontFinder) {
    if (isFontFinderActive) btnFontFinder.classList.add('mode-active');
    else btnFontFinder.classList.remove('mode-active');
  }
}

const bookmarkBar = document.getElementById('bookmarkBar') as HTMLElement | null;
const bookmarkItems = document.getElementById('bookmarkItems') as HTMLElement | null;
const btnStarBookmark = document.getElementById('btnStarBookmark') as HTMLButtonElement | null;

function renderBookmarks() {
  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  lastBookmarksSignature = computeBookmarksSignature(currentBookmarks, activeTab);
  const isBookmarked = activeTab && currentBookmarks.some((b) => b.url === activeTab.url);
  if (btnStarBookmark) {
    btnStarBookmark.classList.toggle('active', !!isBookmarked);
    if (isBookmarked) {
      btnStarBookmark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>`;
    } else {
      btnStarBookmark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.565.565 0 0 0-.163-.505L1.71 6.745l4.052-.576a.525.525 0 0 0 .393-.288L8 2.223l1.847 3.658a.525.525 0 0 0 .393.288l4.052.575-2.906 2.77a.565.565 0 0 0-.163.506l.694 3.957-3.686-1.895a.5.5 0 0 0-.461 0z"/></svg>`;
    }
  }
  // Mirror main-side rule: bar shows only when toggled on AND bookmarks exist
  // (toolbarHeight already accounts for it — native-tab-host.ts toolbarHeight).
  const showBar = isBookmarkBarVisible && currentBookmarks.length > 0;
  if (bookmarkBar) {
    bookmarkBar.style.display = showBar ? 'flex' : 'none';
  }
  document.documentElement.style.setProperty('--bookmark-bar-offset', showBar ? '28px' : '0px');
  if (bookmarkItems) {
    bookmarkItems.innerHTML = '';
    for (const b of currentBookmarks) {
      const el = document.createElement('button');
      el.className = 'bookmark-item';
      el.textContent = b.title || b.url;
      el.title = b.url;
      el.addEventListener('click', () => getApi()?.navigate?.(b.url));
      bookmarkItems.appendChild(el);
    }
  }
}


// Navigation Listeners
if (btnNewTab) btnNewTab.addEventListener('click', () => getApi()?.createTab());
if (btnBack) btnBack.addEventListener('click', () => getApi()?.goBack());
if (btnForward) btnForward.addEventListener('click', () => getApi()?.goForward());
if (btnReload) {
  btnReload.title = 'Reload page (Ctrl+R) • Right-click or Ctrl+Alt+R for Reload Window';
  btnReload.addEventListener('click', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      getApi()?.reloadWindow();
    } else {
      getApi()?.reload();
    }
  });
  btnReload.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    getApi()?.reloadWindow();
  });
}

if (btnStarBookmark) {
  btnStarBookmark.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (!activeTab || !activeTab.url || activeTab.url === 'about:blank') return;
    const isBookmarked = currentBookmarks.some((b) => b.url === activeTab.url);
    if (isBookmarked) {
      getApi()?.removeBookmark(activeTab.url);
      showToolbarToast('⭐ Đã xóa dấu trang');
    } else {
      getApi()?.addBookmark(activeTab.title || activeTab.url, activeTab.url);
      showToolbarToast('⭐ Đã lưu dấu trang thành công');
    }
  });
}

// Device Viewport
if (deviceSelect) {
  deviceSelect.addEventListener('change', () => {
    getApi()?.setDevicePreset(deviceSelect.value);
  });
}
// Split Review Controls
if (btnToggleSplit) {
  btnToggleSplit.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    const nextEnabled = !(activeTab && activeTab.splitMode);
    getApi()?.toggleSplitReview(activeTabId, nextEnabled);
  });
}
if (splitDesktopSelect) {
  splitDesktopSelect.addEventListener('change', () => {
    getApi()?.setSplitPreset('desktop', splitDesktopSelect.value, activeTabId);
  });
}
if (splitMobileSelect) {
  splitMobileSelect.addEventListener('change', () => {
    getApi()?.setSplitPreset('mobile', splitMobileSelect.value, activeTabId);
  });
}
if (btnSplitFocusDesktop) {
  btnSplitFocusDesktop.addEventListener('click', () => {
    getApi()?.setSplitFocusedPane('desktop', activeTabId);
  });
}
if (btnSplitFocusMobile) {
  btnSplitFocusMobile.addEventListener('click', () => {
    getApi()?.setSplitFocusedPane('mobile', activeTabId);
  });
}

// Zoom Stepper Controls
if (zoomLabel) {
  zoomLabel.addEventListener('click', () => {
    getApi()?.setZoom(1.0);
  });
}

if (btnZoomInPop) {
  btnZoomInPop.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      getApi()?.setZoom(Math.min(activeTab.zoomFactor + 0.1, 3.0));
    }
  });
}

if (btnZoomOutPop) {
  btnZoomOutPop.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      getApi()?.setZoom(Math.max(activeTab.zoomFactor - 0.1, 0.5));
    }
  });
}

// Tools
if (btnThemeQa) {
  btnThemeQa.addEventListener('click', async () => {
    const report = lastThemeQaReport || themeQaState.report;
    if (report && (themeQaState.status === 'pass' || themeQaState.status === 'fail' || themeQaState.status === 'error')) {
      openThemeQaSummary();
      return;
    }
    showToolbarToast('Theme QA: Validating Storefront…');
    const result = await getApi()?.runThemeQa();
    if (result?.report) {
      lastThemeQaReport = result.report;
      renderThemeQa({ ...themeQaState, report: result.report }, result.report);
      openThemeQaSummary();
    } else if (result && !result.ok) {
      themeQaState = { ...themeQaState, status: 'error', error: result.error || 'validation failed' };
      openThemeQaSummary();
    }
  });
}
const btnThemeQaRerun = document.getElementById('btnThemeQaRerun') as HTMLButtonElement | null;
btnThemeQaRerun?.addEventListener('click', async () => {
  showToolbarToast('Theme QA: Re-validating Storefront…');
  const result = await getApi()?.runThemeQa();
  if (result?.report) {
    lastThemeQaReport = result.report;
    renderThemeQa({ ...themeQaState, report: result.report }, result.report);
    openThemeQaSummary();
  } else if (result && !result.ok) {
    themeQaState = { ...themeQaState, status: 'error', error: result.error || 'validation failed' };
    openThemeQaSummary();
  }
});
themeQaClose?.addEventListener('click', () => { if (themeQaOverlay) themeQaOverlay.style.display = 'none'; releaseOverlay('theme-qa'); });
themeQaOverlay?.addEventListener('click', (event) => { if (event.target === themeQaOverlay) { themeQaOverlay.style.display = 'none'; releaseOverlay('theme-qa'); } });

// Theme Studio Cockpit Event Listeners
const tabNavThemeChecklist = document.getElementById('tabNavThemeChecklist');
const tabNavThemeFindings = document.getElementById('tabNavThemeFindings');
const themeTabChecklist = document.getElementById('themeTabChecklist');
const themeTabFindings = document.getElementById('themeTabFindings');

tabNavThemeChecklist?.addEventListener('click', () => {
  tabNavThemeChecklist.classList.add('active');
  tabNavThemeFindings?.classList.remove('active');
  if (themeTabChecklist) themeTabChecklist.style.display = 'flex';
  if (themeTabFindings) themeTabFindings.style.display = 'none';
  // Opening the panel is the moment the user may have switched theme projects
  // behind the same local port, so re-read the workspace instead of trusting the
  // identity cached when the storefront origin was first seen.
  renderThemeStudioChecklist(true);
});

tabNavThemeFindings?.addEventListener('click', () => {
  tabNavThemeFindings.classList.add('active');
  tabNavThemeChecklist?.classList.remove('active');
  if (themeTabFindings) themeTabFindings.style.display = 'flex';
  if (themeTabChecklist) themeTabChecklist.style.display = 'none';
  renderThemeStudioFindings();
});

const phaseFilterBtns = document.querySelectorAll('.phase-filter-btn');
phaseFilterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    phaseFilterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activePhaseFilter = btn.getAttribute('data-page') || btn.getAttribute('data-phase') || 'all';
    renderThemeStudioChecklist();
  });
});

const themeChecklistSearch = document.getElementById('themeChecklistSearch') as HTMLInputElement | null;
themeChecklistSearch?.addEventListener('input', () => {
  checklistSearchQuery = themeChecklistSearch.value;
  renderThemeStudioChecklist();
});

const btnThemeChecklistReset = document.getElementById('btnThemeChecklistReset');
btnThemeChecklistReset?.addEventListener('click', () => {
  if (confirm('Bạn có chắc muốn đặt lại toàn bộ checklist về trạng thái chưa làm?')) {
    localStorage.removeItem(checklistStorageKey(activeChecklistScope));
    themeChecklist = DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
    renderThemeStudioChecklist();
    showToolbarToast('Đã đặt lại checklist');
  }
});

const btnThemeExportReport = document.getElementById('btnThemeExportReport');
btnThemeExportReport?.addEventListener('click', () => {
  if (!ensureChecklistScope()) {
    showToolbarToast('Đang xác định storefront và workspace, thử xuất lại sau một nhịp…');
    return;
  }
  if (themeChecklist.length === 0) {
    themeChecklist = loadThemeChecklist(activeChecklistScope);
  }
  const total = themeChecklist.length;
  const doneCount = themeChecklist.filter((it) => it.done).length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const pageKeys = ['home', 'collection', 'product', 'cart', 'blog', 'account', 'pages', 'qa-gate'];
  const lines: string[] = [];
  lines.push(`# BÁO CÁO TIẾN ĐỘ THEME & QA STOREFRONT (AntiFan Theme Studio)`);
  lines.push(`- **Thời gian xuất:** ${new Date().toLocaleString('vi-VN')}`);
  lines.push(`- **Storefront đang đo:** ${activeChecklistScope}`);
  lines.push(`- **Tổng tiến độ:** ${doneCount}/${total} mục (${percent}%)`);
  lines.push(`- **Đánh giá tổng thể:** ${percent === 100 ? '✅ SẴN SÀNG NGHIỆM THU / HANDOFF' : percent >= 80 ? '🟡 ĐANG HOÀN THIỆN (GẦN XONG)' : '🔴 ĐANG PHÁT TRIỂN'}`);
  lines.push(`- **Phạm vi bằng chứng:** ${QA_GATE_DISCLAIMER}`);
  lines.push('');

  pageKeys.forEach((key) => {
    const pItems = themeChecklist.filter((it) => it.page === key);
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

  const reportText = lines.join('\n');
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    clipboard.writeText(reportText).then(() => {
      showToolbarToast('📋 Đã sao chép Báo cáo Tiến độ Markdown vào Clipboard!');
    }).catch(() => {
      console.log(reportText);
      showToolbarToast('📋 Đã in báo cáo Markdown vào Console F12');
    });
  } else {
    console.log(reportText);
    showToolbarToast('📋 Đã in báo cáo Markdown vào Console F12');
  }
});

const btnVpQuicks = document.querySelectorAll('.btn-vp-quick');
btnVpQuicks.forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.getAttribute('data-preset');
    if (preset) {
      getApi()?.setDevicePreset(preset);
      showToolbarToast(`Chuyển Viewport: ${preset}`);
    }
  });
});

/**
 * True once this renderer session has actually seen an attached phone.
 *
 * It is the difference between "the phone was here and something broke" (worth an amber badge) and
 * "this host has no phone" (worth nothing at all). An unanswered usbmuxd is indistinguishable from an
 * absent phone, so the badge only appears once attachment has been observed for real.
 */
let sawPhoneConnected = false;

function renderPhoneStatus(status: ToolbarPhoneStatus | null | undefined) {
  if (!btnPhoneStatus || !phoneStatusText) return;
  lastPhoneStatus = status || null;
  const connected = status?.state === 'connected';
  if (connected) sawPhoneConnected = true;

  if (!status || status.state === 'disconnected') {
    btnPhoneStatus.style.display = 'none';
    btnPhoneStatus.classList.remove('phone-wda-offline', 'phone-offline');
  } else if (connected) {
    const displayName = status.name || status.model || 'iPhone';
    btnPhoneStatus.style.display = 'inline-flex';
    btnPhoneStatus.classList.remove('phone-wda-offline', 'phone-offline');
    btnPhoneStatus.title = [`${displayName} Connected`, status.osVersion ? `iOS ${status.osVersion}` : undefined, 'USB']
      .filter(Boolean)
      .join(' • ');
    phoneStatusText.textContent = `${displayName} Connected`;
  } else {
    const displayName = status.name || status.model || 'iPhone';
    btnPhoneStatus.style.display = sawPhoneConnected ? 'inline-flex' : 'none';
    btnPhoneStatus.classList.remove('phone-offline');
    btnPhoneStatus.classList.toggle('phone-wda-offline', sawPhoneConnected);
    btnPhoneStatus.title = `${displayName} • usbmuxd chưa phản hồi (bấm để xem chi tiết)`;
    phoneStatusText.textContent = `${displayName} (Muxer Offline)`;
  }

  // The badge above is cheap and always applies. The panel body is a full HTML
  // parse plus a subtree rebuild, and the state broadcast calls this on every push:
  // while the panel is closed that parse was invisible work five times a second. A
  // panel that IS on screen still re-renders, including on disconnect, so an open
  // panel can never keep showing "🟢 Đã kết nối" for a phone that was unplugged —
  // and openPhoneStatusModal() renders once more before it shows.
  if (phoneStatusOverlay?.style.display === 'flex') {
    renderPhoneModalContent(status || null);
  }
}

function renderPhoneModalContent(status: ToolbarPhoneStatus | null) {
  if (!phoneStatusBody) return;
  const detail = status?.detail ? escapeHtml(status.detail) : '';
  if (!status || status.state === 'disconnected') {
    phoneStatusBody.innerHTML = `
      <div style="text-align:center;padding:24px 0;color:#94a3b8;">
        <div style="font-size:32px;margin-bottom:8px;">🔌</div>
        <div>Không phát hiện thiết bị iPhone nào cắm qua USB.</div>
        <div style="font-size:11px;margin-top:6px;color:#64748b;">Hãy cắm cáp USB và mở khóa màn hình iPhone.</div>
      </div>
    `;
    return;
  }
  if (status.state === 'unknown') {
    phoneStatusBody.innerHTML = `
      <div style="text-align:center;padding:24px 0;color:#eab308;">
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;font-size:14px;color:#facc15;">Chưa đọc được trạng thái thiết bị</div>
        <div style="font-size:12px;margin-top:8px;color:#94a3b8;line-height:1.5;">
          ${detail || 'Cổng kết nối usbmuxd (tcp:27015) chưa phản hồi.'}
        </div>
        <div style="font-size:11px;margin-top:12px;color:#64748b;">
          Hãy đảm bảo iTunes đang chạy ngầm hoặc bấm <strong>"🔄 Làm mới"</strong> ở góc trên.
        </div>
      </div>
    `;
    return;
  }
  // Every value below is device-reported. When the device did not report one, the panel says so rather
  // than substituting a default that would read as an observation.
  const name = status.name ? escapeHtml(status.name) : 'Chưa xác định';
  const model = status.model ? escapeHtml(status.model) : 'Chưa xác định';
  const osVersion = status.osVersion ? `iOS ${escapeHtml(status.osVersion)}` : 'Chưa xác định';
  const connection = status.connection
    ? (status.connection === 'usb' ? 'Cáp USB vật lý (usbmuxd)' : escapeHtml(status.connection))
    : 'Chưa xác định';

  phoneStatusBody.innerHTML = `
    <div style="margin-bottom:14px;">
      <div class="phone-card-row">
        <span class="phone-card-label">Tên thiết bị</span>
        <span class="phone-card-value">${name}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Model phần cứng</span>
        <span class="phone-card-value">${model}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Phiên bản iOS</span>
        <span class="phone-card-value">${osVersion}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Giao tiếp</span>
        <span class="phone-card-value">${connection}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Trạng thái</span>
        <span class="phone-card-value"><span style="color:#4ade80;font-weight:600;">🟢 Đã kết nối</span></span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">UDID</span>
        <span class="phone-card-value" style="font-size:11px;">${status.deviceId ? escapeHtml(status.deviceId) : 'Chưa cung cấp'}</span>
      </div>
      ${detail ? `
      <div class="phone-card-row" style="margin-top:6px;">
        <span class="phone-card-label">Chi tiết</span>
        <span class="phone-card-value" style="font-size:11px;color:#94a3b8;">${detail}</span>
      </div>` : ''}
    </div>
  `;
}
function openPhoneStatusModal() {
  if (!phoneStatusOverlay) return;
  renderPhoneModalContent(lastPhoneStatus);
  phoneStatusOverlay.style.display = 'flex';
  acquireOverlay('phone-status');
}

function closePhoneStatusModal() {
  if (!phoneStatusOverlay) return;
  phoneStatusOverlay.style.display = 'none';
  releaseOverlay('phone-status');
}

if (btnPhoneStatus) {
  btnPhoneStatus.addEventListener('click', () => {
    openPhoneStatusModal();
  });
}
btnPhoneStatusRefresh?.addEventListener('click', async () => {
  showToolbarToast('Đang kiểm tra kết nối thiết bị...');
  const res = await getApi()?.getPhoneStatus?.(true);
  if (res) renderPhoneStatus(res);
});
phoneStatusClose?.addEventListener('click', () => closePhoneStatusModal());
phoneStatusOverlay?.addEventListener('click', (e) => {
  if (e.target === phoneStatusOverlay) closePhoneStatusModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (phoneStatusOverlay?.style.display === 'flex') { closePhoneStatusModal(); return; }
  if (tabContextMenu?.classList.contains('active')) { hideTabContextMenu(); return; }
  if (appDropdownMenu?.style.display !== 'none' && appDropdownMenu) { closeAppMenu(); return; }
  if (profileDropdownMenu?.style.display !== 'none' && profileDropdownMenu) { profileDropdownMenu.style.display = 'none'; releaseOverlay('profile-dropdown'); return; }
  if (shortcutsOverlay?.style.display === 'flex') { closeShortcutsOverlay(); return; }
  if (workflowHubOverlay?.style.display === 'flex') { closeWorkflowHub(); return; }
  if (mobileRemoteOverlay?.style.display === 'flex') { closeMobileRemoteModal(); return; }
  if (themeQaOverlay?.style.display === 'flex') { themeQaOverlay.style.display = 'none'; releaseOverlay('theme-qa'); return; }
  if (findBar?.style.display === 'flex') { hideFindBar(); return; }
  if (omniboxSuggestDropdown?.style.display === 'block') { hideSuggestDropdown(); return; }
});
if (btnQuickInspect) btnQuickInspect.addEventListener('click', () => getApi()?.toggleInspect());
if (btnFontFinder) btnFontFinder.addEventListener('click', () => getApi()?.toggleFontFinder());
if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', () => getApi()?.toggleSidebar());
if (btnPopoutTerminal) btnPopoutTerminal.addEventListener('click', () => getApi()?.popoutTerminal?.());
// (btnRuler/btnDevTools/btnCaptureFullPage listeners removed — elements never existed.)

let lastChromeProfilesSignature = '';

/**
 * The dropdown is rebuilt from `availableChromeProfiles` plus the active profile,
 * and those two are its whole input. The state broadcast calls this on every push
 * (up to 5 Hz), so without a value signature the same subtree and its handlers were
 * reparsed and replaced while the dropdown was closed — thousands of throwaway
 * nodes and closures per hour for a menu nobody had opened.
 */
function computeChromeProfilesSignature(profiles: any[], activeId: string): string {
  let sig = `${activeId}:${profiles.length}`;
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    if (p) sig += `;${p.id || ''},${p.name || ''}`;
  }
  return sig;
}

function renderChromeProfiles() {
  if (profileName) {
    const nextProfileName = activeProfileInfo?.name || 'Default';
    if (profileName.textContent !== nextProfileName) profileName.textContent = nextProfileName;
  }
  if (profileAvatar && profileAvatar.textContent !== '👤') {
    profileAvatar.textContent = '👤';
  }
  if (!profileDropdownList) return;
  const signature = computeChromeProfilesSignature(availableChromeProfiles || [], activeProfileInfo?.id || '');
  if (signature === lastChromeProfilesSignature) return;
  lastChromeProfilesSignature = signature;
  profileDropdownList.innerHTML = '';

  availableChromeProfiles.forEach((p) => {
    const item = document.createElement('div');
    const isActive = activeProfileInfo && activeProfileInfo.id === p.id;
    item.className = `profile-dropdown-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span>👤 ${escapeHtml(p.name || p.id)}</span>
      ${isActive ? '<span style="color:#22c55e;font-size:11px;">● Active</span>' : '<span style="font-size:10px;color:#94a3b8;">Sync</span>'}
    `;
    item.onclick = async () => {
      profileDropdownMenu.style.display = 'none';
      releaseOverlay('profile-dropdown');
      showToolbarToast(`🔄 Đang đồng bộ Chrome Profile: ${p.name || p.id}...`);
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res && res.success !== false) {
        activeProfileInfo = p;
        renderChromeProfiles();
        renderAppMenuProfiles();
        if (res.hasLiveCookies === false && (!res.cookiesCount || res.cookiesCount === 0)) {
          showToolbarToast(`ℹ️ Đã nạp ${res.bookmarksCount || 0} dấu trang, chưa nạp được cookies: ${res?.message || 'Chrome đang bảo vệ cookies (App-Bound Encryption) hoặc đang mở. Hãy đóng hẳn Chrome rồi thử lại, hoặc dùng 💾 Sao lưu / 📥 Khôi phục Session Vault.'}`, 9000);
        } else {
          const cookieNote = res.cookiesCount > 0 ? ` (${res.cookiesCount} cookies, ${res.bookmarksCount || 0} bookmarks)` : '';
          showToolbarToast(`✅ Đã đồng bộ Chrome Profile: ${p.name || p.id}${cookieNote}`, 4000);
        }
      } else {
        showToolbarToast(`⚠️ Không thể đồng bộ: ${res?.message || 'Lỗi profile'}`, 4000);
      }
    };
    profileDropdownList.appendChild(item);
  });
  // Append Session Vault actions to the dropdown
  const divider = document.createElement('div');
  divider.style.height = '1px';
  divider.style.background = 'rgba(255, 255, 255, 0.1)';
  divider.style.margin = '4px 0';
  profileDropdownList.appendChild(divider);

  // Backup Vault Item
  const backupItem = document.createElement('div');
  backupItem.className = 'profile-dropdown-item';
  backupItem.innerHTML = '<span>💾 Sao lưu Session Vault</span><span style="font-size:10px;color:#38bdf8;">Export</span>';
  backupItem.onclick = async () => {
    profileDropdownMenu.style.display = 'none';
    releaseOverlay('profile-dropdown');
    showToolbarToast('🔄 Đang sao lưu session cookies...');
    const res = await getApi()?.exportSessionVault?.();
    if (res?.success) {
      showToolbarToast(`✅ Đã sao lưu ${res.count} cookies vào session-vault.json`, 4000);
    } else {
      showToolbarToast(`⚠️ Lỗi sao lưu: ${res?.error || 'Thất bại'}`, 4000);
    }
  };
  profileDropdownList.appendChild(backupItem);

  // Restore Vault Item
  const restoreItem = document.createElement('div');
  restoreItem.className = 'profile-dropdown-item';
  restoreItem.innerHTML = '<span>📥 Khôi phục Session Vault</span><span style="font-size:10px;color:#4ade80;">Import</span>';
  restoreItem.onclick = async () => {
    profileDropdownMenu.style.display = 'none';
    releaseOverlay('profile-dropdown');
    showToolbarToast('🔄 Đang nạp cookies từ session-vault.json...');
    const res = await getApi()?.importSessionVault?.();
    if (res?.success) {
      showToolbarToast(`✅ Đã khôi phục ${res.importedCount} cookies thành công!`, 4000);
    } else {
      showToolbarToast(`⚠️ Lỗi nạp: ${res?.error || 'Chưa có file session-vault.json'}`, 4000);
    }
  };
  profileDropdownList.appendChild(restoreItem);

}

if (btnChromeProfile) {
  btnChromeProfile.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isHidden = profileDropdownMenu.style.display === 'none';
    if (isHidden) {
      if (appDropdownMenu) { appDropdownMenu.style.display = 'none'; releaseOverlay('app-menu'); }
      // Acquire before the async IPC round-trip: releasing 'app-menu' above can
      // empty the token set, and the queued microtask would collapse the view
      // to strip height only to re-expand when profiles resolve (visible flicker).
      acquireOverlay('profile-dropdown');
      const profiles = await getApi()?.getChromeProfiles();
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
      }
      renderChromeProfiles();
      profileDropdownMenu.style.display = 'flex';
    } else {
      profileDropdownMenu.style.display = 'none';
      releaseOverlay('profile-dropdown');
    }
  });
}

document.addEventListener('click', (e) => {
  if (profileDropdownMenu && profileDropdownMenu.style.display !== 'none') {
    if (!profileDropdownMenu.contains(e.target as Node) && !btnChromeProfile.contains(e.target as Node)) {
      profileDropdownMenu.style.display = 'none';
      releaseOverlay('profile-dropdown');
    }
  }
});

// Modern App Dropdown Menu (Three-dot ⋮)
const appDropdownMenu = document.getElementById('appDropdownMenu') as HTMLElement | null;
const menuProfileSubList = document.getElementById('menuProfileSubList') as HTMLElement | null;
const menuItemSyncProfile = document.getElementById('menuItemSyncProfile') as HTMLElement | null;
const menuProfileContainer = document.getElementById('menuProfileContainer') as HTMLElement | null;

function renderAppMenuProfiles() {
  if (!menuProfileSubList) return;
  if (!availableChromeProfiles || availableChromeProfiles.length === 0) {
    menuProfileSubList.innerHTML = '<div class="profile-sub-item disabled">Không tìm thấy Chrome Profile</div>';
    return;
  }
  menuProfileSubList.innerHTML = '';
  availableChromeProfiles.forEach((p) => {
    const item = document.createElement('div');
    const isActive = activeProfileInfo && activeProfileInfo.id === p.id;
    item.className = `profile-sub-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span>👤 ${escapeHtml(p.name || p.id)}</span>
      ${isActive ? '<span style="font-size:10px;color:#4ade80;">● Đang dùng</span>' : '<span style="font-size:10px;color:#38bdf8;">Đồng bộ</span>'}
    `;
    item.onclick = async (e) => {
      e.stopPropagation();
      closeAppMenu();
      showToolbarToast(`🔄 Đang đồng bộ Chrome Profile: ${p.name || p.id}...`);
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res && res.success !== false) {
        activeProfileInfo = p;
        renderChromeProfiles();
        if (res.hasLiveCookies === false && (!res.cookiesCount || res.cookiesCount === 0)) {
          showToolbarToast(`ℹ️ Đã nạp ${res.bookmarksCount || 0} dấu trang, chưa nạp được cookies: ${res?.message || 'Chrome đang bảo vệ cookies (App-Bound Encryption) hoặc đang mở. Hãy đóng hẳn Chrome rồi thử lại, hoặc dùng 💾 Sao lưu / 📥 Khôi phục Session Vault.'}`, 9000);
        } else {
          const cookieNote = res.cookiesCount > 0 ? ` (${res.cookiesCount} cookies, ${res.bookmarksCount || 0} bookmarks)` : '';
          showToolbarToast(`✅ Đã đồng bộ Chrome Profile: ${p.name || p.id}${cookieNote}`, 4000);
        }
      } else {
        showToolbarToast(`⚠️ Không thể đồng bộ: ${res?.message || 'Lỗi profile'}`, 4000);
      }
    };
    menuProfileSubList.appendChild(item);
  });
  // Divider
  const appMenuDivider = document.createElement('div');
  appMenuDivider.style.height = '1px';
  appMenuDivider.style.background = 'rgba(255, 255, 255, 0.1)';
  appMenuDivider.style.margin = '4px 0';
  menuProfileSubList.appendChild(appMenuDivider);

}

function closeAppMenu() {
  if (appDropdownMenu && appDropdownMenu.style.display !== 'none') {
    appDropdownMenu.style.display = 'none';
    if (menuProfileContainer) {
      menuProfileContainer.style.display = 'none';
    }
    menuItemSyncProfile?.classList.remove('expanded');
    releaseOverlay('app-menu');
  }
}

async function toggleAppMenu() {
  if (!appDropdownMenu) return;
  const isHidden = appDropdownMenu.style.display === 'none';
  if (isHidden) {
    if (profileDropdownMenu) { profileDropdownMenu.style.display = 'none'; releaseOverlay('profile-dropdown'); }
    
    // Pre-fetch Chrome profiles asynchronously
    getApi()?.getChromeProfiles().then((profiles) => {
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
        renderChromeProfiles();
        renderAppMenuProfiles();
      }
    }).catch(() => {});

    renderAppMenuProfiles();
    appDropdownMenu.style.display = 'flex';
    acquireOverlay('app-menu');
  } else {
    closeAppMenu();
  }
}

if (btnMenu && appDropdownMenu) {
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAppMenu();
  });
}

if (menuItemSyncProfile) {
  menuItemSyncProfile.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menuProfileContainer) return;
    const isExpanded = menuProfileContainer.style.display !== 'none';
    if (isExpanded) {
      menuProfileContainer.style.display = 'none';
      menuItemSyncProfile.classList.remove('expanded');
    } else {
      if (!availableChromeProfiles || availableChromeProfiles.length === 0) {
        const profiles = await getApi()?.getChromeProfiles();
        if (profiles && Array.isArray(profiles)) {
          availableChromeProfiles = profiles;
          renderChromeProfiles();
        }
      }
      renderAppMenuProfiles();
      menuProfileContainer.style.display = 'block';
      menuItemSyncProfile.classList.add('expanded');
    }
  });
}

// App Menu Items Clicks
document.getElementById('menuItemCheckUpdates')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.checkUpdates?.();
});
document.getElementById('menuItemBookmarkTab')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  const star = document.getElementById('btnStarBookmark');
  if (star) star.click();
});

document.getElementById('menuItemToggleBookmarksBar')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleBookmarkBar();
});

document.getElementById('menuItemFindInPage')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  showFindBar();
});

document.getElementById('menuItemQuickInspect')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleInspect();
});

document.getElementById('menuItemFontFinder')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleFontFinder();
});

document.getElementById('menuItemGpuLens')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleLens();
});

document.getElementById('menuItemScreenshot')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.captureViewport().then(async (dataUrl) => {
    if (!dataUrl) {
      showToolbarToast('⚠️ Chụp màn hình thất bại');
      return;
    }
    // captureViewport returns a base64 data URL — write the decoded PNG binary
    // to the clipboard so paste targets receive an image, not raw base64 text.
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      showToolbarToast('📸 Đã sao chép ảnh chụp màn hình vào Clipboard!');
    } catch {
      // ClipboardItem/image write unsupported (e.g. permission or platform) —
      // fall back to text so the capture is still retrievable.
      try {
        await navigator.clipboard.writeText(dataUrl);
        showToolbarToast('📸 Đã sao chép ảnh (dạng text base64)');
      } catch {
        showToolbarToast('📸 Đã chụp màn hình (clipboard không khả dụng)');
      }
    }
  }).catch(() => {
    showToolbarToast('⚠️ Chụp màn hình thất bại');
  });
});

document.getElementById('menuItemOpenSystemBrowser')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.openExternal();
});

document.getElementById('menuItemDevTools')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleDevTools();
});

document.getElementById('menuItemClearStorage')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  closeAppMenu();
  const clearRes = await getApi()?.clearStorage();
  if (clearRes && clearRes.success !== false) {
    showToolbarToast('Đã xóa Cookies & Cache của trang này');
  } else {
    showToolbarToast(`⚠️ Không thể xóa: chỉ hỗ trợ trang http(s). ${clearRes?.reason || ''}`, 5000);
  }
});

document.getElementById('menuItemShortcuts')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  openShortcutsOverlay();
});
function openShortcutsOverlay() {
  if (!shortcutsOverlay) return;
  acquireOverlay('shortcuts');
  shortcutsOverlay.style.display = 'flex';
}

function closeShortcutsOverlay() {
  if (!shortcutsOverlay) return;
  shortcutsOverlay.style.display = 'none';
  releaseOverlay('shortcuts');
}

if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcutsOverlay);
if (shortcutsOverlay) {
  shortcutsOverlay.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) closeShortcutsOverlay();
  });
}

async function openMobileRemoteModal() {
  if (!mobileRemoteOverlay) return;
  acquireOverlay('mobile-remote');
  mobileRemoteOverlay.style.display = 'flex';

  try {
    const info = await (getApi() as any)?.getMobileRemoteInfo?.();
    if (info) {
      if (mobileRemoteQrContainer && info.qrSvg) {
        mobileRemoteQrContainer.innerHTML = info.qrSvg;
      }
      if (mobileRemoteUrlsList && Array.isArray(info.urls)) {
        mobileRemoteUrlsList.innerHTML = '';
        info.urls.forEach((url: string) => {
          const item = document.createElement('div');
          item.className = 'mobile-url-item';
          item.innerHTML = `
            <span class="mobile-url-text">${escapeHtml(url)}</span>
            <button class="btn-copy-url">Sao chép</button>
          `;
          item.querySelector('.btn-copy-url')?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(url);
            showToolbarToast('📋 Đã sao chép liên kết Mobile Remote!');
          });
          mobileRemoteUrlsList.appendChild(item);
        });
      }
    }
  } catch (e) {
    console.error('Failed to load mobile remote info', e);
  }
}

function closeMobileRemoteModal() {
  if (!mobileRemoteOverlay) return;
  mobileRemoteOverlay.style.display = 'none';
  releaseOverlay('mobile-remote');
}

// menuItemMobileRemote (app menu) is the opener — btnMobileRemote never existed in toolbar.html.
document.getElementById('menuItemMobileRemote')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  openMobileRemoteModal();
});
if (mobileRemoteClose) {
  mobileRemoteClose.addEventListener('click', closeMobileRemoteModal);
}
if (mobileRemoteOverlay) {
  mobileRemoteOverlay.addEventListener('click', (e) => {
    if (e.target === mobileRemoteOverlay) closeMobileRemoteModal();
  });
}

// (Legacy menu* ids — menuFind/menuQuickAnnotate/menuFontFinder/menuLens/menuOpenBrowser/menuShortcuts —
//  do not exist in toolbar.html; their listeners were dead code and have been removed.)

// Close menus when clicking outside
// TAB CONTEXT MENU
const tabContextMenu = document.getElementById('tabContextMenu') as HTMLDivElement | null;
const menuItemNewTabRight = document.getElementById('menuItemNewTabRight');
const menuItemDuplicateTab = document.getElementById('menuItemDuplicateTab');
const menuItemReloadTab = document.getElementById('menuItemReloadTab');
const menuItemCopyUrl = document.getElementById('menuItemCopyUrl');
const menuItemCopyTabId = document.getElementById('menuItemCopyTabId');
const menuItemCloseTab = document.getElementById('menuItemCloseTab');
const menuItemCloseOtherTabs = document.getElementById('menuItemCloseOtherTabs');
const menuItemCloseTabsToRight = document.getElementById('menuItemCloseTabsToRight');

let contextMenuTargetTabId: string | null = null;

function hideTabContextMenu() {
  if (!tabContextMenu) return;
  tabContextMenu.classList.remove('active');
  tabContextMenu.style.display = 'none';
  contextMenuTargetTabId = null;
  releaseOverlay('tab-context');
}

function showTabContextMenu(x: number, y: number, tabId: string) {
  if (!tabContextMenu) return;
  contextMenuTargetTabId = tabId;

  const tabIndex = currentTabs.findIndex((t) => t.id === tabId);
  const totalTabs = currentTabs.length;

  if (menuItemCloseOtherTabs) {
    if (totalTabs <= 1) {
      menuItemCloseOtherTabs.classList.add('disabled');
    } else {
      menuItemCloseOtherTabs.classList.remove('disabled');
    }
  }

  if (menuItemCloseTabsToRight) {
    if (tabIndex === -1 || tabIndex >= totalTabs - 1) {
      menuItemCloseTabsToRight.classList.add('disabled');
    } else {
      menuItemCloseTabsToRight.classList.remove('disabled');
    }
  }

  acquireOverlay('tab-context');
  tabContextMenu.style.display = 'flex';
  tabContextMenu.classList.add('active');

  const menuWidth = 210;
  const maxX = window.innerWidth - menuWidth - 8;
  const targetX = Math.max(8, Math.min(x, maxX));
  const targetY = Math.max(4, y);

  tabContextMenu.style.left = `${targetX}px`;
  tabContextMenu.style.top = `${targetY}px`;
}

if (menuItemNewTabRight) {
  menuItemNewTabRight.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const idx = currentTabs.findIndex((t) => t.id === contextMenuTargetTabId);
      getApi()?.createTab('https://www.google.com').then((newId: string) => {
        if (newId && idx !== -1) {
          getApi()?.moveTab(newId, idx + 1);
        }
      });
    }
    hideTabContextMenu();
  });
}

if (menuItemDuplicateTab) {
  menuItemDuplicateTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.duplicateTab(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemReloadTab) {
  menuItemReloadTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.reload(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCopyUrl) {
  menuItemCopyUrl.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const targetTab = currentTabs.find((t) => t.id === contextMenuTargetTabId);
      if (targetTab && targetTab.url) {
        navigator.clipboard.writeText(targetTab.url).then(() => {
          showToolbarToast('Đã sao chép liên kết tab');
        }).catch(() => {});
      }
    }
    hideTabContextMenu();
  });
}
if (menuItemCopyTabId) {
  menuItemCopyTabId.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const targetTab = currentTabs.find((t) => t.id === contextMenuTargetTabId);
      const tabIdx = currentTabs.findIndex((t) => t.id === contextMenuTargetTabId);
      const tabNum = tabIdx !== -1 ? `#${tabIdx + 1}` : '';
      if (targetTab && targetTab.id) {
        navigator.clipboard.writeText(targetTab.id).then(() => {
          showToolbarToast(`📋 Đã chép Tab ID (${tabNum}): ${targetTab.id}`);
        }).catch(() => {
          showToolbarToast(`📋 Tab ID (${tabNum}): ${targetTab.id}`);
        });
      }
    }
    hideTabContextMenu();
  });
}


const menuItemBindTerminal = document.getElementById('menuItemBindTerminal');
if (menuItemBindTerminal) {
  menuItemBindTerminal.addEventListener('click', async () => {
    if (contextMenuTargetTabId) {
      const ok = await getApi()?.rebindTerminalAffinity(contextMenuTargetTabId);
      if (ok) {
        showToolbarToast('🎯 Đã gán tab vào Terminal hoạt động');
      } else {
        showToolbarToast('Không thể gán tab vào Terminal');
      }
    }
    hideTabContextMenu();
  });
}
const menuItemSetAlias = document.getElementById('menuItemSetAlias');
if (menuItemSetAlias) {
  menuItemSetAlias.addEventListener('click', async () => {
    if (contextMenuTargetTabId) {
      const currentTab = currentTabs.find(t => t.id === contextMenuTargetTabId);
      const alias = await showPromptDialog('Đặt Alias cho tab (ví dụ: @admin, @feedback, @storefront):', currentTab?.alias || '@');
      if (alias !== null) {
        const trimmed = alias.trim();
        const role = trimmed.startsWith('@') ? trimmed.slice(1).toLowerCase() : undefined;
        await getApi()?.setTabAlias(contextMenuTargetTabId, trimmed || undefined, role);
        showToolbarToast(trimmed ? `🏷️ Đã gán alias: ${trimmed}` : 'Đã xóa alias của tab');
      }
    }
    hideTabContextMenu();
  });
}
if (menuItemCloseTab) {
  menuItemCloseTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeTab(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseOtherTabs) {
  menuItemCloseOtherTabs.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeOtherTabs(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseTabsToRight) {
  menuItemCloseTabsToRight.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeTabsToRight(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (appDropdownMenu && appDropdownMenu.style.display !== 'none') {
    const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
    const isInsideMenu = path.includes(appDropdownMenu) || appDropdownMenu.contains(e.target as Node);
    const isMenuButton = (btnMenu && path.includes(btnMenu)) || e.target === btnMenu;
    if (!isInsideMenu && !isMenuButton) {
      closeAppMenu();
    }
  }

  if (tabContextMenu && !tabContextMenu.contains(e.target as Node)) {
    hideTabContextMenu();
  }
});

// Google Omnibox Suggest Dropdown
const omniboxSuggestDropdown = document.getElementById('omniboxSuggestDropdown') as HTMLDivElement | null;
const omniboxSuggestList = document.getElementById('omniboxSuggestList') as HTMLDivElement | null;

let suggestItems: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> = [];
let selectedSuggestIndex = -1;
let suggestDebounceTimer: any = null;

function hideSuggestDropdown() {
  if (!omniboxSuggestDropdown) return;
  omniboxSuggestDropdown.style.display = 'none';
  selectedSuggestIndex = -1;
  suggestItems = [];
  releaseOverlay('suggest');
}

async function updateSuggestDropdown(query: string) {
  if (!omniboxSuggestDropdown || !omniboxSuggestList) return;
  const q = (query || '').trim();
  try {
    const res = await getApi()?.getSuggestions(q);
    if (res && Array.isArray(res.suggestions) && res.suggestions.length > 0) {
      suggestItems = res.suggestions;
      selectedSuggestIndex = -1;
      renderSuggestItems(q);
      omniboxSuggestDropdown.style.display = 'block';
      acquireOverlay('suggest', 420);
    } else {
      hideSuggestDropdown();
    }
  } catch {
    hideSuggestDropdown();
  }
}

function renderSuggestItems(query: string) {
  if (!omniboxSuggestList) return;
  omniboxSuggestList.innerHTML = '';
  const lowerQ = (query || '').toLowerCase();

  suggestItems.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = `suggest-item ${idx === selectedSuggestIndex ? 'selected' : ''}`;

    let iconSvg = '';
    if (item.type === 'tab') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="2" y1="7" x2="14" y2="7"/></svg>';
    } else if (item.type === 'bookmark') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#f59e0b"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>';
    } else if (item.type === 'history') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#60a5fa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 5 8 8 10.5 9.5"/></svg>';
    } else if (item.type === 'url') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#a78bfa"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/><path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/></svg>';
    } else {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#9ca3af"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';
    }

    let matchHtml = escapeHtml(item.text);
    if (lowerQ && item.text.toLowerCase().includes(lowerQ)) {
      const startIdx = item.text.toLowerCase().indexOf(lowerQ);
      const before = item.text.slice(0, startIdx);
      const match = item.text.slice(startIdx, startIdx + lowerQ.length);
      const after = item.text.slice(startIdx + lowerQ.length);
      matchHtml = `${escapeHtml(before)}<b>${escapeHtml(match)}</b>${escapeHtml(after)}`;
    }

    const subText = item.subText || (item.type === 'search' ? 'Google Search' : (item.url ? hostname(item.url) : ''));

    el.innerHTML = `
      <span class="suggest-icon">${iconSvg}</span>
      <div class="suggest-content">
        <span class="suggest-text">${matchHtml}</span>
        ${subText ? `<span class="suggest-subtext">${escapeHtml(subText)}</span>` : ''}
      </div>
    `;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (item.type === 'tab' && item.tabId) {
        getApi()?.switchTab(item.tabId);
        hideSuggestDropdown();
        return;
      }
      const targetNav = item.url || item.text;
      if (targetNav === 'antifan:command:reload-window') {
        getApi()?.reloadWindow();
        hideSuggestDropdown();
        return;
      }
      if (urlInput) urlInput.value = targetNav;
      getApi()?.navigate(targetNav);
      hideSuggestDropdown();
    });
    omniboxSuggestList.appendChild(el);
  });
}

// Omnibox Event Listeners
if (urlInput) {
  urlInput.addEventListener('input', () => {
    const val = urlInput.value;
    if (btnClearOmnibox) btnClearOmnibox.style.display = val ? 'block' : 'none';
    clearTimeout(suggestDebounceTimer);
    suggestDebounceTimer = setTimeout(() => {
      updateSuggestDropdown(val);
    }, 120);
  });

  urlInput.addEventListener('focus', () => {
    urlInput.select();
    updateSuggestDropdown(urlInput.value);
  });
  urlInput.addEventListener('click', () => {
    if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display === 'none') {
      updateSuggestDropdown(urlInput.value);
    }
  });
  urlInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== urlInput) {
        hideSuggestDropdown();
      }
    }, 200);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display !== 'none' && suggestItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex + 1) % suggestItems.length;
        renderSuggestItems(urlInput.value);
        const sel = suggestItems[selectedSuggestIndex];
        if (sel) {
          urlInput.value = sel.url || sel.text;
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex - 1 + suggestItems.length) % suggestItems.length;
        renderSuggestItems(urlInput.value);
        const sel = suggestItems[selectedSuggestIndex];
        if (sel) {
          urlInput.value = sel.url || sel.text;
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSuggestDropdown();
        return;
      }
    }

    if (e.key === 'Enter') {
      const val = urlInput.value.trim();
      if (val === 'antifan:command:reload-window' || val.toLowerCase() === '> reload window' || val.toLowerCase() === '> reload' || val.toLowerCase() === '> developer: reload window') {
        getApi()?.reloadWindow();
        hideSuggestDropdown();
        urlInput.blur();
        return;
      }
      if (val) {
        if (selectedSuggestIndex >= 0 && selectedSuggestIndex < suggestItems.length) {
          const item = suggestItems[selectedSuggestIndex];
          if (item && item.type === 'tab' && item.tabId) {
            getApi()?.switchTab(item.tabId);
            hideSuggestDropdown();
            urlInput.blur();
            return;
          }
        }
        getApi()?.navigate(val);
        hideSuggestDropdown();
        urlInput.blur();
      }
    }
  });
}

const omniboxEl = document.querySelector('.omnibox') as HTMLDivElement | null;
if (omniboxEl && urlInput) {
  omniboxEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('#btnStarBookmark, #btnClearOmnibox')) return;
    if (document.activeElement !== urlInput) {
      urlInput.focus();
      urlInput.select();
    } else if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display === 'none') {
      updateSuggestDropdown(urlInput.value);
    }
  });
}

document.addEventListener('click', (e) => {
  if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display !== 'none') {
    if (!omniboxSuggestDropdown.contains(e.target as Node) && e.target !== urlInput) {
      hideSuggestDropdown();
    }
  }
});

if (btnClearOmnibox && urlInput) {
  btnClearOmnibox.addEventListener('click', () => {
    urlInput.value = '';
    urlInput.focus();
    btnClearOmnibox.style.display = 'none';
    hideSuggestDropdown();
  });
}

// Find In Page
function showFindBar() {
  if (!findBar || !findInput) return;
  findBar.style.display = 'flex';
  acquireOverlay('find-bar', 50);
  findInput.focus();
  findInput.select();
  const q = findInput.value.trim();
  if (q) {
    getApi()?.findInPage(q, true, false);
  }
}

function hideFindBar() {
  if (!findBar) return;
  findBar.style.display = 'none';
  if (findCount) findCount.textContent = '0/0';
  getApi()?.stopFindInPage();
  releaseOverlay('find-bar');
}

if (findInput) {
  findInput.addEventListener('input', () => {
    const q = findInput.value.trim();
    if (q) {
      getApi()?.findInPage(q, true, false);
    } else {
      if (findCount) findCount.textContent = '0/0';
      getApi()?.stopFindInPage();
    }
  });

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = findInput.value.trim();
      if (q) {
        getApi()?.findInPage(q, !e.shiftKey, true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideFindBar();
    }
  });
}

if (findNext && findInput) {
  findNext.addEventListener('click', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, true, true);
  });
}
if (findPrev && findInput) {
  findPrev.addEventListener('click', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, false, true);
  });
}
if (findClose) {
  findClose.addEventListener('click', hideFindBar);
}

// (Duplicate shortcuts-close listeners removed — the primary pair at ~line 1730
//  already handles close + releaseOverlay('shortcuts').)


async function initToolbar() {
  const api = getApi();
  if (!api) return;

  // Registered before the first `await`: the main process pushes the phone state during bootstrap, and a
  // listener attached after `getInitialState()` resolves can miss that push entirely.
  api.onPhoneStatusChanged?.((status) => {
    renderPhoneStatus(status);
  });

  try {
    const state = await api.getInitialState();
    if (state) {
      currentTabs = state.tabs || [];
      activeTabId = state.activeTabId || '';
      // Kick off the identity read without blocking the toolbar: a main process
      // that stalls here would freeze tabs, profiles and bookmarks. The checklist
      // paints its pending state until the answer lands.
      void resolveChecklistWorkspace(checklistOrigin());
      if (state.bookmarks) currentBookmarks = state.bookmarks;
      if (state.activeChromeProfile) activeProfileInfo = state.activeChromeProfile;
      if (state.chromeProfiles) availableChromeProfiles = state.chromeProfiles;
      isInspecting = !!state.isInspecting;
      isFontFinderActive = !!state.isFontFinderActive;
      isLensActive = !!state.isLensActive;
      isRulerActive = !!state.isRulerActive;
      isBookmarkBarVisible = !!state.isBookmarkBarVisible;
      if (state.themeQa) renderThemeQa(state.themeQa);
      if ('phoneStatus' in state) renderPhoneStatus(state.phoneStatus as ToolbarPhoneStatus);
      renderTabs();
      renderBookmarks();
      renderChromeProfiles();
      updateControls();
    }
  } catch (err) {
    console.error('[antifan toolbar] Failed to load initial state:', err);
  }
  api.onStateUpdated((state: unknown) => {
    if (state && typeof state === 'object') {
      const s = state as Record<string, unknown>;
      currentTabs = (s.tabs as unknown as AntiFanTab[]) || [];
      activeTabId = (s.activeTabId as string) || '';
      if (s.bookmarks) currentBookmarks = s.bookmarks as unknown as Array<{ id: string; title: string; url: string }>;
      if (s.activeChromeProfile) activeProfileInfo = s.activeChromeProfile;
      if (s.chromeProfiles) availableChromeProfiles = s.chromeProfiles as unknown as unknown[];
      isInspecting = !!s.isInspecting;
      isFontFinderActive = !!s.isFontFinderActive;
      isLensActive = !!s.isLensActive;
      isRulerActive = !!s.isRulerActive;
      isBookmarkBarVisible = !!s.isBookmarkBarVisible;
      if (s.themeQa) renderThemeQa(s.themeQa as unknown as ThemeQaState);
      if ('phoneStatus' in s) renderPhoneStatus(s.phoneStatus as ToolbarPhoneStatus);
      const newTabsSig = computeTabsSignature(currentTabs, activeTabId);
      if (newTabsSig !== lastTabsSignature) {
        renderTabs();
      }

      const activeTab = currentTabs.find((t) => t.id === activeTabId);
      const newBookmarksSig = computeBookmarksSignature(currentBookmarks, activeTab);
      if (newBookmarksSig !== lastBookmarksSignature) {
        renderBookmarks();
      }

      renderChromeProfiles();
      updateControls();
    }
  });
  api.onThemeQaState((state) => renderThemeQa(state));

  api.onFocusFind(() => {
    showFindBar();
  });

  api.onFocusOmnibox(() => {
    urlInput.focus();
    urlInput.select();
  });

  api.onShowShortcuts(() => {
    openShortcutsOverlay();
  });

  api.onFindResult((result: any) => {
    if (result && result.matches !== undefined && findCount) {
      findCount.textContent = `${result.activeMatchOrdinal || 0}/${result.matches}`;
    }
  });
  if (api.onScreenshotCaptured) {
    api.onScreenshotCaptured(() => {
      showToolbarToast('📸 Đã sao chép ảnh chụp màn hình vào Clipboard!');
    });
  }

  // Wire Workflow & MCP Hub Events
  btnWorkflowHub?.addEventListener('click', openWorkflowHub);
  btnWorkflowHubClose?.addEventListener('click', closeWorkflowHub);
  workflowHubOverlay?.addEventListener('click', (e) => {
    if (e.target === workflowHubOverlay) closeWorkflowHub();
  });
  tabNavWorkflows?.addEventListener('click', () => setHubTab('workflows'));
  tabNavMcp?.addEventListener('click', () => setHubTab('mcp'));
  tabNavCoreHealth?.addEventListener('click', () => setHubTab('core-health'));
  tabNavBridge?.addEventListener('click', () => setHubTab('bridge'));
  tabNavTaskRuns?.addEventListener('click', () => setHubTab('task-runs'));
  tabNavRootCauses?.addEventListener('click', () => setHubTab('root-causes'));
  tabNavRegressions?.addEventListener('click', () => setHubTab('regressions'));
  tabNavMcpDispatch?.addEventListener('click', () => { setHubTab('mcp-dispatch'); void refreshMcpDispatchState(); });
  btnCoreRefresh?.addEventListener('click', async () => {
    await refreshCoreHealthState();
    renderHubList();
    if (hubCoreSelected) await renderCoreDetail(hubCoreSelected.id);
  });
  hubSearchInput?.addEventListener('input', () => {
    if (hubSearchClear && hubSearchInput) {
      hubSearchClear.style.display = hubSearchInput.value ? 'inline-block' : 'none';
    }
    renderHubList();
  });
  hubSearchClear?.addEventListener('click', () => {
    if (hubSearchInput) hubSearchInput.value = '';
    if (hubSearchClear) hubSearchClear.style.display = 'none';
    renderHubList();
  });
  btnRunWorkflow?.addEventListener('click', runActiveWorkflow);
  btnStopWorkflow?.addEventListener('click', stopActiveWorkflow);
  btnCopyWorkflowJson?.addEventListener('click', () => {
    if (hubSelectedWorkflow) {
      navigator.clipboard.writeText(JSON.stringify(hubSelectedWorkflow.definition, null, 2));
      showToolbarToast('📋 Đã sao chép kịch bản JSON vào Clipboard!');
    }
  });
  btnDeleteCustomWf?.addEventListener('click', async () => {
    if (hubSelectedWorkflow && !hubSelectedWorkflow.isBuiltIn) {
      await getApi()?.deleteWorkflow(hubSelectedWorkflow.id);
      const res = await getApi()?.getWorkflowState();
      hubWorkflows = res?.workflows || [];
      renderHubList();
      if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
      showToolbarToast('🗑️ Đã xóa kịch bản custom.');
    }
  });
  btnHubNewWorkflow?.addEventListener('click', async () => {
    const name = await showPromptDialog('Nhập tên Workflow mới:');
    if (!name || !name.trim()) return;
    const description = (await showPromptDialog('Nhập mô tả kịch bản (tùy chọn):')) || '';
    const newWf = {
      name: name.trim(),
      description: description.trim(),
      steps: [
        {
          id: 'step-navigate',
          name: 'Mở trang web mục tiêu',
          type: 'browser.navigate' as const,
          params: { url: 'https://example.com' },
          timeoutMs: 8000,
          retryCount: 0,
          continueOnError: false,
        },
        {
          id: 'step-screenshot',
          name: 'Chụp ảnh màn hình kiểm thử',
          type: 'browser.screenshot' as const,
          params: { format: 'png' },
          timeoutMs: 10000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    };
    try {
      await getApi()?.saveWorkflow(newWf);
      const res = await getApi()?.getWorkflowState();
      hubWorkflows = res?.workflows || [];
      renderHubList();
      const created = hubWorkflows.find((w) => w.name === newWf.name);
      if (created) selectWorkflow(created);
      showToolbarToast('✅ Đã tạo kịch bản Workflow mới!');
    } catch (err: any) {
      alert(`Lỗi tạo workflow: ${err.message || String(err)}`);
    }
  });

  if (api.onWorkflowEvent) {
    api.onWorkflowEvent((event: any) => {
      if (!event) return;
      if (event.type === 'step:start' && event.stepId) {
        const card = document.getElementById(`step-card-${event.stepId}`);
        if (card) card.className = 'hub-step-card step-running';
        const pill = document.getElementById(`step-status-${event.stepId}`);
        if (pill) {
          pill.className = 'hub-step-status step-status-running';
          pill.textContent = 'RUNNING';
        }
        if (runCurrentStepText) {
          runCurrentStepText.textContent = `Đang chạy: ${event.stepName || event.stepId}...`;
        }
      } else if (event.type === 'step:end' && event.stepId) {
        const isPassed = event.status === 'passed';
        // `skipped` (abort rollback) and `blocked` (precondition refusal) are distinct from a
        // failure: an aborted run must not paint its remaining steps red.
        const isSkipped = event.status === 'skipped';
        const isBlocked = event.status === 'blocked';
        const card = document.getElementById(`step-card-${event.stepId}`);
        if (card) card.className = `hub-step-card ${isPassed ? 'step-passed' : isSkipped ? 'step-skipped' : isBlocked ? 'step-blocked' : 'step-failed'}`;
        const pill = document.getElementById(`step-status-${event.stepId}`);
        if (pill) {
          pill.className = `hub-step-status ${isPassed ? 'step-status-passed' : isSkipped ? 'step-status-skipped' : isBlocked ? 'step-status-blocked' : 'step-status-failed'}`;
          pill.textContent = (event.status || 'DONE').toUpperCase();
        }
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault();
      if (workflowHubOverlay && workflowHubOverlay.style.display === 'flex') {
        closeWorkflowHub();
      } else {
        openWorkflowHub();
      }
    } else if (e.key === 'Escape' && workflowHubOverlay && workflowHubOverlay.style.display === 'flex') {
      closeWorkflowHub();
    }
  });

  let phonePollInFlight = false;
  async function pollPhoneStatus() {
    // The 10s tick, a window focus and a manual refresh coincide routinely; one query at a time keeps a
    // single enumeration per burst instead of three overlapping walks of the USB bus.
    if (phonePollInFlight) return;
    phonePollInFlight = true;
    try {
      const currentApi = getApi();
      const st = await currentApi?.getPhoneStatus?.();
      if (st) renderPhoneStatus(st);
    } catch {
      // The badge is decorative: a failed poll leaves the previous state on screen and the next tick
      // retries. It must never surface as a toolbar error.
    } finally {
      phonePollInFlight = false;
    }
  }
  void pollPhoneStatus();
  setInterval(pollPhoneStatus, 10000);
  window.addEventListener('focus', () => void pollPhoneStatus());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToolbar);
} else {
  initToolbar();
}

