# HOPLONGTECH.VN - DISCOVERY REPORT

## 1. Overview & General Information
- **Target URL**: `https://hoplongtech.vn/` (resolves to `https://hoplongtech.com/`)
- **Industry**: Industrial Automation, Robotics, Electrical Equipment & Smart Home Devices.
- **Page Type**: E-commerce / Industrial Mall B2B & B2C Storefront.
- **Tech Stack Observed**:
  - Backend: Laravel / Livewire (SSR + dynamic components)
  - CSS Architecture: Modular CSS with Bootstrap-compatible grid (`container`, `container-fuild`, flex utilities).
  - Typography: Google Font `Roboto` (weights: 300, 400, 500, 600, 700).
  - Primary Color Tokens:
    - Primary Blue: `#3590CE` / `#0961ca` / `#003f8a`
    - Dark Text: `#22343E` / `#202F36` / `#212529`
    - Secondary/Muted Text: `#68767B` / `#747474` / `#9090A7`
    - Backgrounds: `#FFFFFF`, `#F8F9FA`, `#F2F4F7`, `#EBF5FB`
    - Borders: `#DEE2E6`, `#D9D9D9`, `#E2E8F0`
    - Accent / Badges: `#E53935` (Sale/Badge), `#12B886` (Green status)

---

## 2. Page Section Hierarchy & Component Decomposition

### 2.1 Header Component (`header.site-header`)
- **Top Header Bar (`.site-header__top`)**:
  - Logo (`img/logo-hlt-2024.png` - 243x55px)
  - Search Form with live search input, submit button, and trending keywords ("Cảm biến áp suất", "Cảm biến tiệm cận", "Biến tần", "Nút nhấn")
  - Quick CTA utilities:
    - Hotline 1900 6536
    - National Branch Locator (interactive modal with 15+ branches in Hanoi, HCMC, Da Nang, Hai Phong, etc.)
    - Notification indicator with badge counter
    - Shopping Cart with item counter badge
    - User Account / Login trigger modal
- **Bottom Navigation Bar (`.site-header__bottom`)**:
  - Mega Menu toggle: "Danh mục sản phẩm" with 9-dot grid icon
  - Main navigation links:
    - Các thương hiệu
    - Đặt hàng nhanh
    - Yêu cầu báo giá
    - Tracking Order
    - Check bảo hành
    - Tài liệu kỹ thuật
    - Tin tức
    - Flash Sale (accent badge)

### 2.2 Main Content Sections (`main`)
1. **SEO H1 Title**: "Công ty Cổ phần Công nghệ Hợp Long"
2. **Hero / Slider Section (`section.slide`)**:
   - Left Sidebar: Category Mega Menu (10 primary categories with icons and nested sub-categories)
   - Center: Hero Banner Carousel (promotional brand banners: Schneider, Autonics, Omron, Veichi)
   - Bottom Mini-Banners: 4 product showcase banners (Schneider, Giga Electric, Siemens, Smart Home)
3. **Category Icons Bar (`section.category-list`)**:
   - Quick access icon grid for key product lines (Biến tần hạ thế, Nút nhấn, MCB, Công tắc ổ cắm, Contactor...)
4. **Featured Product Collections**:
   - Contactor Schneider (Tesys LC1D Series, Acti 9 iCT)
   - Biến tần NiSTRO (GA27, GA20 Series)
   - Biến tần VEICHI (AC310, AC10, VI20 HMI Series)
   - Biến áp Giga Electric (GGK series)
   - Cảm biến Autonics & Omron (BRQM400, E3Z, BUP, PR12, BEN5M)
5. **Distribution & Consultation Form (`section.home-form`)**:
   - "Nhà phân phối chính hãng" banner
   - B2B lead generation consultation form (Name, Phone, Email, Product requirement, Submit)
   - Value propositions / Milestones (VNR500, Fast500, Best Workplace in Asia)
6. **Accessories Showcase (`section.accessory`)**:
   - "Phụ kiện chính hãng" section
   - Left vertical list: Phụ kiện tủ điện, Cầu đấu khối, Din Ray, Điện trở sấy, Quạt thông gió, Vỏ cầu chì, Điều hòa tủ điện, Máng nhựa
   - Right product showcase cards with technical specs
7. **Brand Partners Section (`section.partner`)**:
   - "Đối tác của chúng tôi"
   - Logo grid of 20+ authorized brand partners (Schneider, Autonics, Omron, Siemens, ABB, Delta, Mitsubishi, LS, Fuji, Veichi, NiSTRO, Giga Electric, Aqara, Lumias...)

### 2.3 Footer Component (`div.site-footer`)
- **Footer Columns (`.container`)**:
  - Column 1: Giới thiệu (Về Hợp Long, Lịch sử phát triển, Tuyển dụng, Tin tức khuyến mại, Liên hệ)
  - Column 2: Hỗ trợ khách hàng (Dành cho đại lý, Hình thức thanh toán, Hướng dẫn mua hàng, Quy định điểm thưởng)
  - Column 3: Chính sách (Chính sách bảo mật, Chính sách bảo hành, Chính sách vận chuyển, Chính sách đổi trả)
  - Column 4: Thông tin liên hệ & Hệ thống chi nhánh (Hotlines, Email info@hoplong.com, Danh sách chi nhánh)
  - Ecosystem Links: Giga.vn, Lumias.vn, GigaElectric.vn, GigaRobotics.vn, AqaraSmartHome.vn...
- **Copyright Bar (`.copyright`)**:
  - Legal business info: Công ty Cổ phần Công nghệ Hợp Long, MST 0104509916, Social icons (Facebook, Youtube, TikTok, Zalo).

---

## 3. Haravan-Ready Component Architecture Mapping

| Section / Component | Haravan Liquid Target | Liquid Scope / Settings |
|---|---|---|
| Header Top Bar | `sections/header.liquid` | Logo setting, hotline, branch data, menu settings |
| Main Navigation | `snippets/header-nav.liquid` | Linklist menu settings |
| Category Mega Menu | `snippets/mega-menu.liquid` | Nested linklist + collection links |
| Hero Banner Carousel | `sections/hero-slider.liquid` | Slides block settings (image, url, title) |
| Category Icons Grid | `sections/category-icons.liquid` | Collection blocks (icon, label, collection picker) |
| Featured Products Tabs | `sections/product-tabs.liquid` | Collection picker, product cards, limit |
| Product Card | `snippets/product-card.liquid` | Reusable product snippet (image, vendor, title, price) |
| Lead Form Section | `sections/consultation-form.liquid` | Page form with contact endpoint |
| Accessories Section | `sections/accessories-showcase.liquid` | Tabbed collection blocks |
| Brand Partners Grid | `sections/brand-partners.liquid` | Logo blocks (image, link, alt text) |
| Footer | `sections/footer.liquid` | Multi-column menus, contact settings, copyright |
