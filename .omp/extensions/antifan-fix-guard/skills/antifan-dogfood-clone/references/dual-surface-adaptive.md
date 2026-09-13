# Dual-Surface Adaptive Architecture & Serving Reference

## 1. Adaptive vs Responsive Architecture Probe
Websites built on modern CMS/frameworks (such as Laravel Livewire, WordPress Mobile Packs, or proprietary storefronts) often deploy an **Adaptive Dual-Surface architecture** rather than a pure single-template Responsive layout.

### Detection Criteria
1. **Body Data-Device Attribute**:
   - Desktop client: `<body data-device="web">` (~400KB+ DOM).
   - Mobile client: `<body data-device="mobile">` (~150KB - 380KB DOM).
2. **User-Agent & Client Hints**:
   - Server returns distinct HTML document trees based on:
     - `User-Agent` containing `Mobile|Android|iPhone|iPad`.
     - `sec-ch-ua-mobile: ?1` header.
3. **Distinct Structural DOM Nodes**:
   - Mobile contains mobile-only drawer `.category-navigation__block` and floating bottom dock `.bottom-navigation`.
   - Desktop contains multi-column hover megamenu `.category-navigation #category-navigation__sub`.

---

## 2. Dual-Surface Collection Strategy
When an Adaptive architecture is detected:
1. **Desktop Reference Surface**:
   - Captured with Desktop UA (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...`).
   - Viewport: 1440 × 900.
   - Target file: `clone/<site>/index.html`.
2. **Mobile Reference Surface**:
   - Captured with Mobile UA (`Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36...`) and `sec-ch-ua-mobile: ?1`.
   - Viewport: 390 × 844 (or 375 × 812).
   - Target file: `clone/<site>/mobile/index.html`.

---

## 3. Adaptive Local Server Contract (`scripts/serve-clone.mjs`)
The local clone server must implement dynamic surface routing:
```javascript
const userAgent = req.headers['user-agent'] || '';
const isMobileUA = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
const isMobileSecCh = req.headers['sec-ch-ua-mobile'] === '?1';
const hasMobileParam = req.url.includes('device=mobile') || req.url.includes('mobile=1');
const isMobilePath = req.url.startsWith('/mobile/') || req.url === '/mobile';
const isMobile = isMobileUA || isMobileSecCh || hasMobileParam || isMobilePath;

let reqPath = req.url.split('?')[0];
if (reqPath === '/' || reqPath === '') {
  reqPath = isMobile ? '/mobile/index.html' : '/index.html';
} else if (reqPath === '/index.html' && isMobile) {
  reqPath = '/mobile/index.html';
}
```

### Universal Fallback Resolution
To prevent broken asset references between `/` and `/mobile/`:
```javascript
if (!fs.existsSync(filePath)) {
  const basename = path.basename(reqPath);
  if (reqPath.endsWith('.css')) {
    const rootCss = path.join(baseDir, 'css', basename);
    if (fs.existsSync(rootCss)) filePath = rootCss;
  } else if (reqPath.startsWith('/assets/')) {
    const rootAsset = path.join(baseDir, 'assets', reqPath.replace('/assets/', ''));
    if (fs.existsSync(rootAsset)) filePath = rootAsset;
  } else if (reqPath.startsWith('/mobile/assets/')) {
    const rootAsset = path.join(baseDir, 'assets', reqPath.replace('/mobile/assets/', ''));
    if (fs.existsSync(rootAsset)) filePath = rootAsset;
  } else if (reqPath.startsWith('/mobile/css/')) {
    const rootCss = path.join(baseDir, 'css', basename);
    if (fs.existsSync(rootCss)) filePath = rootCss;
  }
}
```

---

## 4. Dual-Surface Headless Materializer (Chống Khung Xương Đen / SSR Lazy Hydration)

### Vấn Đề Gốc
Nhiều website (như Hoplongtech) sử dụng cơ chế SSR trả về khung xương SVG (`<svg width="1440" ...>` hoặc `<svg width="100%" height="700">`) và chỉ nạp dữ liệu sản phẩm thật qua AJAX (Livewire / IntersectionObserver) khi có một trình duyệt thực sự cuộn trang xuống.
Nếu chỉ thực hiện `fetch()` HTTP tĩnh, nội dung lấy về sẽ toàn là khung xương SVG chưa hydrate. Kèm theo lỗi cú pháp `@keyframes` từ web gốc, các khung xương này sẽ biến thành các **dải đen sì tuyệt đối (`#000000`)**.

### Giải Pháp Chuẩn Hóa: `materialize-surface.cjs`
Sử dụng Electron ẩn (`show: false`) và session cô lập. Desktop 1440 × 900; Mobile 390 × 844 với Mobile UA/client hints. Thông số và tiêu chí chờ do `scripts/materialize-surface.cjs` sở hữu, không sao chép timeout vào hướng dẫn.

Capture phải chứng minh viewport thực, hội tụ chiều cao/nội dung, ảnh đã decode và không còn placeholder đang tải trước khi ghi DOM. Xuất `<rawPath>.capture.json` chứa URL, device, viewport, thời điểm, SHA-256 và kết quả settlement. Build kiểm receipt cùng hash nội dung; thiếu hoặc sai thì capture lại và truyền lỗi worker lên. Kích thước file không chứng minh hydration. Receipt hợp lệ cũng không thay thế E2E.

---

## 5. Solo Dev Local — xử lý điểm nghẽn

Báo lỗi cùng bằng chứng và tự sửa lỗi kỹ thuật trong phạm vi đã duyệt. Không bắt người dùng chọn lại phương án đã chốt. Chỉ hỏi khi có quyết định thực sự về phạm vi, dữ liệu hoặc hành động bên ngoài không thể hoàn tác. Không dùng workaround làm yếu cổng nghiệm thu. Giữ tab người dùng, tái sử dụng server và dọn tiến trình test do mình tạo.
