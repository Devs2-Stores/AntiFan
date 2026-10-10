/**
 * Test corpus of visual QA fixtures (holdout-2).
 * Viewport target: 375x667 (mobile phone).
 */
module.exports = [
  {
    id: 'h01-overlap-price',
    defect: 'Giá khuyến mãi và giá gốc bị đè chồng lên nhau do định vị tuyệt đối không có khoảng cách.',
    expect: { kinds: ['overlap'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Áo Sơ Mi Lụa Cổ Vest Pháp - Thời Trang Nữ</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 24px; }
    .site-header { background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .brand-logo { font-size: 18px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px; }
    .header-icons { display: flex; gap: 12px; font-size: 14px; font-weight: 600; color: #64748b; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 12px 16px; }
    .product-single-card { background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .product-media { width: 100%; height: 260px; background: linear-gradient(135deg, #fce7f3, #fed7aa); display: flex; align-items: center; justify-content: center; position: relative; }
    .product-media-icon { font-size: 64px; }
    .product-content { padding: 16px; }
    .product-vendor { font-size: 12px; font-weight: 700; text-transform: uppercase; color: #6366f1; margin-bottom: 4px; }
    .product-title { font-size: 17px; font-weight: 700; line-height: 1.3; color: #0f172a; margin-bottom: 12px; }
    
    /* DEFECT: Overlapping prices due to identical absolute coordinates */
    .price-container-defect { position: relative; height: 32px; margin-bottom: 14px; }
    .price-original { position: absolute; top: 0; left: 0; font-size: 22px; font-weight: 700; color: #94a3b8; text-decoration: line-through; }
    .price-sale { position: absolute; top: 0; left: 0; font-size: 24px; font-weight: 800; color: #e11d48; }

    .btn-buy { display: block; width: 100%; height: 46px; background: #0f172a; color: #ffffff; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="brand-logo">LUMIA STUDIO</div>
    <div class="header-icons"><span>🔍</span><span>🛒 (1)</span></div>
  </header>
  <main class="shopify-section section-featured-product">
    <div class="container">
      <div class="row">
        <div class="col-12">
          <div class="card product-single-card">
            <div class="product-media">
              <span class="product-media-icon">👗</span>
            </div>
            <div class="product-content">
              <div class="product-vendor">LUMIA EXCLUSIVE</div>
              <h1 class="product-title">Áo Sơ Mi Lụa Cổ Vest Pháp Dáng Rộng Phong Cách Công Sở</h1>
              <div class="price-container-defect">
                <span class="price-original">450.000₫</span>
                <span class="price-sale">299.000₫</span>
              </div>
              <button class="btn-buy" type="button">THÊM VÀO GIỎ HÀNG</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`
  },
  {
    id: 'h02-clipping-btn-cart',
    defect: 'Nút thêm vào giỏ hàng bị cắt mất một nửa chữ do phần tử cha đặt chiều cao cố định và overflow hidden.',
    expect: { kinds: ['clipping'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flash Sale Giày Thể Thao Nam</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f1f5f9; color: #1e293b; padding-bottom: 24px; }
    .flash-header { background: #ef4444; color: #fff; padding: 12px 16px; text-align: center; font-weight: 800; font-size: 14px; letter-spacing: 0.5px; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 12px 16px; }
    .flash-product-card { background: #ffffff; border-radius: 12px; border: 1px solid #cbd5e1; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .card-thumb { height: 200px; background: linear-gradient(135deg, #e0f2fe, #bae6fd); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 54px; margin-bottom: 12px; }
    .product-name { font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 8px; line-height: 1.3; }
    .price-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
    .current-price { font-size: 20px; font-weight: 800; color: #ef4444; }
    .compare-price { font-size: 14px; color: #94a3b8; text-decoration: line-through; }
    
    /* DEFECT: Container clips button text horizontally in half */
    .button-clipper-box {
      height: 20px;
      overflow: hidden;
      margin-top: 10px;
      border-radius: 6px;
    }
    .btn-clipped-cart {
      display: block;
      width: 100%;
      height: 48px;
      line-height: 48px;
      background: #f97316;
      color: #ffffff;
      font-size: 15px;
      font-weight: 800;
      text-align: center;
      border: none;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="flash-header">⚡ FLASH SALE GIỜ VÀNG - KẾT THÚC TRONG 02:45:10</div>
  <main class="shopify-section section-flash-sale">
    <div class="container">
      <div class="row">
        <div class="col-12">
          <div class="card flash-product-card">
            <div class="card-thumb">👟</div>
            <h2 class="product-name">Giày Sneaker Nam Phối Lưới Thoáng Khí Phong Cách Năng Động</h2>
            <div class="price-row">
              <span class="current-price">389.000₫</span>
              <span class="compare-price">650.000₫</span>
            </div>
            <div class="button-clipper-box">
              <button class="btn-clipped-cart" type="button">THÊM VÀO GIỎ HÀNG</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`
  },
  {
    id: 'h03-sticky-obstruction-footer',
    defect: 'Thanh đặt hàng dính ở đáy màn hình che khuất nút xem đánh giá và mã giảm giá ở cuối trang.',
    expect: { kinds: ['sticky-obstruction', 'occlusion'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chi Tiết Váy Công Chúa Ren Hoa Cao Cấp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #ffffff; color: #1e293b; }
    .top-bar { background: #0f172a; color: #fff; padding: 10px 16px; font-size: 15px; font-weight: 700; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 16px; }
    .hero-banner { height: 180px; background: linear-gradient(135deg, #fed7aa, #f472b6); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 48px; margin-bottom: 16px; }
    .item-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    .item-price { font-size: 20px; font-weight: 800; color: #e11d48; margin-bottom: 12px; }
    .item-desc { font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 16px; }
    .detail-specs { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 20px; font-size: 13px; line-height: 1.6; }
    
    /* Target elements at bottom of page with zero margin-bottom, covered by sticky bar */
    .bottom-voucher-box { background: #f1f5f9; border: 1px dashed #64748b; border-radius: 8px; padding: 10px 12px; display: flex; gap: 8px; margin-bottom: 8px; }
    .voucher-input { flex: 1; height: 36px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0 8px; font-size: 13px; }
    .voucher-btn { height: 36px; padding: 0 12px; background: #6366f1; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; }
    .reviews-trigger-btn { display: block; width: 100%; height: 42px; background: #e0e7ff; color: #4338ca; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; text-align: center; line-height: 42px; }

    /* DEFECT: Sticky fixed footer with no body padding-bottom, obstructing bottom buttons */
    .sticky-bottom-action {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      width: 100%;
      height: 72px;
      background: #1e293b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      z-index: 999;
      box-shadow: 0 -4px 12px rgba(0,0,0,0.15);
    }
    .sticky-price-info { color: #fff; }
    .sticky-price-val { font-size: 18px; font-weight: 800; color: #38bdf8; }
    .sticky-order-btn { height: 44px; padding: 0 20px; background: #e11d48; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; }
  </style>
</head>
<body>
  <div class="top-bar">ANNA CLOTHING STORE</div>
  <main class="shopify-section section-product-details">
    <div class="container">
      <div class="hero-banner">👗</div>
      <h1 class="item-title">Váy Công Chúa Ren Hoa Cao Cấp Dự Tiệc Thanh Lịch</h1>
      <div class="item-price">520.000₫</div>
      <p class="item-desc">Thiết kế dáng dài xòe nhẹ tôn dáng, chất liệu ren hoa nhập khẩu mềm mại, lớp lót lụa habutai thoáng mát thấm hút mồ hôi cực tốt.</p>
      
      <div class="detail-specs">
        <div>• Xuất xứ: Việt Nam thiết kế</div>
        <div>• Chất liệu: Ren hoa chỉ cao cấp kèm lót lụa</div>
        <div>• Màu sắc: Trắng kem, Hồng phấn, Be tây</div>
        <div>• Kích cỡ: Size S (40-48kg), Size M (49-55kg)</div>
      </div>

      <div class="bottom-voucher-box">
        <input class="voucher-input" type="text" placeholder="Nhập mã voucher giảm 30k...">
        <button class="voucher-btn" type="button">ÁP DỤNG</button>
      </div>
      <button class="reviews-trigger-btn" type="button">★ Xem 156 đánh giá của khách hàng (4.9/5)</button>
    </div>
  </main>
  
  <div class="sticky-bottom-action">
    <div class="sticky-price-info">
      <div style="font-size: 11px; color: #94a3b8;">TỔNG THANH TOÁN</div>
      <div class="sticky-price-val">520.000₫</div>
    </div>
    <button class="sticky-order-btn" type="button">ĐẶT HÀNG NGAY</button>
  </div>
</body>
</html>`
  },
  {
    id: 'h04-document-overflow-banner',
    defect: 'Banner khuyến mãi có chiều rộng cố định 480px khiến toàn bộ trang web bị tràn ngang trên màn hình điện thoại.',
    expect: { documentOverflow: true },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khuyến Mãi Siêu Tiệc Mua Sắm Cuối Tuần</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #0f172a; }
    .site-nav { background: #1e1b4b; color: #ffffff; padding: 14px 16px; font-weight: 700; font-size: 16px; display: flex; justify-content: space-between; }
    
    /* DEFECT: Fixed width 480px exceeds mobile screen width 375px without overflow-hidden, causing document overflow */
    .overflow-promo-banner {
      width: 480px;
      min-width: 480px;
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: #ffffff;
      padding: 24px 20px;
      margin: 16px 0;
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
    }
    .promo-badge { display: inline-block; background: #fbbf24; color: #1e1b4b; font-size: 12px; font-weight: 800; padding: 4px 8px; border-radius: 4px; margin-bottom: 8px; }
    .promo-heading { font-size: 20px; font-weight: 800; line-height: 1.3; margin-bottom: 8px; }
    .promo-subtext { font-size: 13px; opacity: 0.9; }

    .main-container { width: 100%; max-width: 375px; padding: 0 16px; margin: 0 auto; }
    .product-list-title { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
    .simple-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
    .simple-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .simple-price { font-size: 15px; font-weight: 700; color: #e11d48; }
  </style>
</head>
<body>
  <nav class="site-nav">
    <span>MEGA STORE VN</span>
    <span>🔔</span>
  </nav>

  <div class="overflow-promo-banner">
    <div class="promo-badge">ƯU ĐÃI VIP 48H</div>
    <div class="promo-heading">SIÊU HỘI GIẢM GIÁ ĐỒNG GIÁ 99K - SỐ LƯỢNG CÓ HẠN</div>
    <div class="promo-subtext">Áp dụng cho toàn bộ danh mục đồ thu đông cao cấp từ hôm nay</div>
  </div>

  <div class="main-container">
    <div class="product-list-title">Sản Phẩm Đang Bán Chạy</div>
    <div class="simple-card">
      <div class="simple-title">Áo Len Cổ Lọ Dệt Kim Nữ Form Rộng Hàn Quốc</div>
      <div class="simple-price">189.000₫</div>
    </div>
    <div class="simple-card">
      <div class="simple-title">Quần Baggy Kaki Cạp Cao Co Giãn Tôn Dáng</div>
      <div class="simple-price">220.000₫</div>
    </div>
  </div>
</body>
</html>`
  },
  {
    id: 'h05-occlusion-floating-widget',
    defect: 'Huy hiệu ưu đãi dạng nổi che lấp hoàn toàn nút xác nhận đặt hàng trong bảng thanh toán dưới chân trang.',
    expect: { kinds: ['occlusion', 'overlap'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thanh Toán Đơn Hàng - Minori Mart</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 30px; }
    .checkout-nav { background: #047857; color: #fff; padding: 14px 16px; font-weight: 700; text-align: center; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 14px 16px; }
    .order-step { font-size: 13px; font-weight: 600; color: #047857; margin-bottom: 12px; }
    .cart-summary { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
    .item-row { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 8px; }
    .shipping-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 13px; line-height: 1.5; }
    .payment-options { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 20px; font-size: 13px; }

    /* Nested 9 levels deep */
    .level-7-btn-box { position: relative; margin-top: 14px; }
    .level-8-btn-slot { width: 100%; height: 50px; }
    .btn-checkout-confirm {
      display: block;
      width: 100%;
      height: 50px;
      background: #047857;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
    }

    /* DEFECT: Misplaced floating promotion badge positioned absolutely over the checkout button, occluding it */
    .occlusion-overlay-badge {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 50px;
      background: #dc2626;
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 12px;
      border-radius: 8px;
      z-index: 10;
      box-shadow: 0 4px 10px rgba(220, 38, 38, 0.4);
    }
  </style>
</head>
<body>
  <div class="checkout-nav">XÁC NHẬN VÀ THANH TOÁN</div>
  <!-- 1: section -->
  <section class="shopify-section section-checkout-page">
    <!-- 2: container -->
    <div class="container checkout-container">
      <div class="order-step">Bước 3: Hoàn tất đặt hàng trực tuyến</div>
      <div class="cart-summary">
        <div class="item-row"><span>Áo Khoác Gió Nam 2 Lớp (Đen/L)</span><strong>350.000₫</strong></div>
        <div class="item-row"><span>Phí vận chuyển giao nhanh</span><strong>30.000₫</strong></div>
        <div class="item-row" style="border-top: 1px dashed #cbd5e1; padding-top: 8px;"><span>TỔNG CỘNG</span><strong style="color: #dc2626; font-size: 16px;">380.000₫</strong></div>
      </div>

      <div class="shipping-box">
        <strong>Địa chỉ nhận hàng:</strong><br>
        Nguyễn Quốc Hùng - 0988.123.456<br>
        Số 45 Đường Trần Hưng Đạo, Phường 1, TP. Vũng Tàu
      </div>

      <div class="payment-options">
        <strong>Phương thức:</strong> Thanh toán tiền mặt khi nhận hàng (COD)
      </div>

      <!-- 3: wrapper -->
      <div class="checkout-footer-block">
        <!-- 4: row -->
        <div class="row footer-row">
          <!-- 5: col -->
          <div class="col-12 col-summary">
            <!-- 6: card -->
            <div class="card card-action-gate">
              <!-- 7: level-7-btn-box -->
              <div class="level-7-btn-box">
                <!-- 8: level-8-btn-slot -->
                <div class="level-8-btn-slot">
                  <!-- 9: button -->
                  <button class="btn-checkout-confirm" type="button">XÁC NHẬN ĐẶT HÀNG (380.000₫)</button>
                </div>
                <!-- Occlusion element directly covering the button -->
                <div class="occlusion-overlay-badge">
                  TẶNG VOUCHER 50.000₫ KHI HOÀN TẤT ĐƠN HÀNG NGAY BÂY GIỜ
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</body>
</html>`
  },
  {
    id: 'h06-offscreen-action-btn',
    defect: 'Nút hoàn tất đơn hàng bị đẩy lệch ra ngoài mép phải màn hình điện thoại do toạ độ đặt sai không thể bấm được.',
    expect: { kinds: ['offscreen'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Đặt Hàng Nhanh 1 Bước</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #ffffff; color: #0f172a; padding: 16px; }
    .header-quick { border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 16px; font-size: 16px; font-weight: 800; }
    .form-group { margin-bottom: 12px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #334155; }
    .form-input { width: 100%; height: 42px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0 12px; font-size: 14px; }
    
    /* DEFECT: Action button pushed beyond 375px mobile viewport to left: 395px inside overflow:hidden */
    .action-gate-overflow-hidden {
      position: relative;
      width: 100%;
      height: 52px;
      overflow: hidden;
      margin-top: 20px;
      background: #f8fafc;
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
    }
    .btn-offscreen-submit {
      position: absolute;
      top: 3px;
      left: 395px; /* Pushed offscreen to the right on a 375px wide viewport */
      width: 280px;
      height: 44px;
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="header-quick">⚡ ĐIỀN THÔNG TIN ĐẶT HÀNG NHANH</div>
  <form class="shopify-section quick-order-form">
    <div class="form-group">
      <label class="form-label">Họ và tên người nhận</label>
      <input class="form-input" type="text" value="Phạm Minh Tuấn">
    </div>
    <div class="form-group">
      <label class="form-label">Số điện thoại liên hệ</label>
      <input class="form-input" type="tel" value="0912.345.678">
    </div>
    <div class="form-group">
      <label class="form-label">Địa chỉ giao hàng (số nhà, ngõ, đường)</label>
      <input class="form-input" type="text" value="12 ngõ 98 Thái Hà, Đống Đa, Hà Nội">
    </div>

    <!-- The button is pushed offscreen into the right margin -->
    <div class="action-gate-overflow-hidden">
      <button class="btn-offscreen-submit" type="button">XÁC NHẬN MUA NGAY (FREESHIP)</button>
    </div>
  </form>
</body>
</html>`
  },
  {
    id: 'h07-clipping-deep-description',
    defect: 'Đoạn văn bản chính sách bảo hành bị cắt cụt một nửa dòng chữ do thẻ cha giới hạn chiều cao và ẩn phần tràn.',
    expect: { kinds: ['clipping'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chính Sách Bảo Hành & Đổi Trả Sản Phẩm</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 24px; }
    .store-bar { background: #0284c7; color: #fff; padding: 12px 16px; font-weight: 700; text-align: center; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 14px 16px; }
    .product-header-stub { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
    .prod-stub-name { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .prod-stub-price { font-size: 16px; font-weight: 800; color: #0284c7; }

    /* Nested 9 levels deep */
    .policy-inner-box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; }
    .policy-tag { font-size: 12px; font-weight: 700; color: #0284c7; text-transform: uppercase; margin-bottom: 6px; }
    .policy-title { font-size: 16px; font-weight: 700; margin-bottom: 10px; color: #0f172a; }

    /* DEFECT: Container height 42px cuts off the second line of text horizontally in half */
    .policy-clipper-limiter {
      height: 42px;
      overflow: hidden;
      background: #f0f9ff;
      border-left: 4px solid #0284c7;
      padding: 6px 10px;
      border-radius: 4px;
    }
    .policy-clipped-text {
      font-size: 15px;
      line-height: 26px;
      color: #0369a1;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="store-bar">TRUNG TÂM BẢO HÀNH CHÍNH HÃNG</div>
  <!-- 1: section -->
  <section class="shopify-section section-warranty-policy">
    <!-- 2: container -->
    <div class="container policy-container">
      <div class="product-header-stub">
        <div class="prod-stub-name">Đồng Hồ Thông Minh Sport Watch Series 8 Pro</div>
        <div class="prod-stub-price">1.250.000₫</div>
      </div>
      <!-- 3: row -->
      <div class="row policy-row">
        <!-- 4: col -->
        <div class="col-12 policy-col">
          <!-- 5: card-wrapper -->
          <div class="card-wrapper policy-wrapper">
            <!-- 6: card-body -->
            <div class="card-body policy-card-body">
              <!-- 7: content-box -->
              <div class="content-box policy-inner-box">
                <div class="policy-tag">QUY ĐỊNH CAM KẾT</div>
                <h3 class="policy-title">Điều Kiện Áp Dụng Đổi Trả Miễn Phí</h3>
                <!-- 8: clipper -->
                <div class="policy-clipper-limiter">
                  <!-- 9: text element -->
                  <p class="policy-clipped-text">
                    Cam kết bảo hành chính hãng 12 tháng, 1 đổi 1 tận nơi nếu phát sinh lỗi từ nhà sản xuất trong 30 ngày đầu tiên mua sắm.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</body>
</html>`
  },
  {
    id: 'h08-overlap-nested-review',
    defect: 'Tên khách hàng và ngày đánh giá bị đè chồng lộn xộn lên nội dung bình luận do định vị tuyệt đối đặt sai vị trí.',
    expect: { kinds: ['overlap'], allowWarning: false },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Đánh Giá Khách Hàng - F1GENZ Fashion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 24px; }
    .header-bar { background: #1e293b; color: #ffffff; padding: 12px 16px; font-weight: 700; text-align: center; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 14px 16px; }
    .product-summary-bar { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
    .summary-name { font-size: 15px; font-weight: 700; }
    .rating-stars { color: #f59e0b; font-size: 14px; margin-top: 4px; }

    /* Nested 8 levels deep */
    .review-card-shell { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; }
    
    /* DEFECT: Both author name and review text positioned absolutely at top: 0, causing overlap */
    .overlap-review-stack {
      position: relative;
      height: 70px;
      margin-top: 8px;
    }
    .author-name-defect {
      position: absolute;
      top: 0;
      left: 0;
      font-size: 16px;
      font-weight: 800;
      color: #0f172a;
      z-index: 2;
    }
    .comment-text-defect {
      position: absolute;
      top: 2px;
      left: 0;
      font-size: 15px;
      line-height: 22px;
      color: #64748b;
      z-index: 1;
    }
  </style>
</head>
<body>
  <div class="header-bar">NHẬN XÉT TỪ KHÁCH HÀNG (4.9/5 ★)</div>
  <!-- 1: section -->
  <section class="shopify-section section-customer-reviews">
    <!-- 2: container -->
    <div class="container reviews-container">
      <div class="product-summary-bar">
        <div class="summary-name">Đầm Xòe Nữ Voan Tơ Hoa Nhí Vintage</div>
        <div class="rating-stars">★★★★★ (184 lượt đánh giá)</div>
      </div>
      <!-- 3: list-wrapper -->
      <div class="review-list-wrapper">
        <!-- 4: row -->
        <div class="row review-row">
          <!-- 5: col -->
          <div class="col-12 review-col">
            <!-- 6: card -->
            <div class="card review-card-shell">
              <!-- 7: review-body -->
              <div class="review-body-box">
                <!-- 8: overlap stack -->
                <div class="overlap-review-stack">
                  <div class="author-name-defect">Trần Thị Thu Thảo (Size M - Đã Mua)</div>
                  <p class="comment-text-defect">Váy mặc lên form rất xinh xắn, vải tơ mềm nhẹ không ngứa, giao hàng siêu nhanh đóng gói cẩn thận 5 sao!</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</body>
</html>`
  },
  {
    id: 'h09-control-sale-badge',
    defect: 'Huy hiệu giảm giá hiển thị gọn gàng trên góc ảnh sản phẩm theo đúng quy chuẩn thiết kế giao diện.',
    expect: { control: true },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sản Phẩm Khuyến Mãi - Yody Fashion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 24px; }
    .nav-bar { background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 12px 16px; font-weight: 800; font-size: 16px; color: #0f172a; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 14px 16px; }
    .product-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    
    /* CONTROL: Clean, legitimate sale badge over product photo */
    .product-photo-box {
      position: relative;
      width: 100%;
      height: 240px;
      background: linear-gradient(135deg, #fef3c7, #fed7aa);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 64px;
    }
    .legit-sale-badge {
      position: absolute;
      top: 12px;
      left: 12px;
      background: #e11d48;
      color: #ffffff;
      font-size: 12px;
      font-weight: 800;
      padding: 4px 8px;
      border-radius: 6px;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 6px rgba(225, 29, 72, 0.3);
      z-index: 2;
    }

    .card-info { padding: 16px; }
    .item-brand { font-size: 12px; font-weight: 700; color: #6366f1; text-transform: uppercase; margin-bottom: 4px; }
    .item-name { font-size: 16px; font-weight: 700; color: #0f172a; line-height: 1.3; margin-bottom: 10px; }
    .price-group { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
    .now-price { font-size: 20px; font-weight: 800; color: #e11d48; }
    .was-price { font-size: 14px; color: #94a3b8; text-decoration: line-through; }
    .btn-cart-act { display: block; width: 100%; height: 44px; background: #0f172a; color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <div class="nav-bar">FASHION BRAND STORE</div>
  <main class="shopify-section section-product-showcase">
    <div class="container">
      <div class="card product-card">
        <div class="product-photo-box">
          <span class="legit-sale-badge">-35% GIẢM</span>
          <span>🧥</span>
        </div>
        <div class="card-info">
          <div class="item-brand">COLLECTION 2026</div>
          <h2 class="item-name">Áo Khoác Blazer Nữ 2 Lớp Dáng Rộng Phong Cách Hàn Quốc</h2>
          <div class="price-group">
            <span class="now-price">485.000₫</span>
            <span class="was-price">750.000₫</span>
          </div>
          <button class="btn-cart-act" type="button">THÊM VÀO GIỎ HÀNG</button>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`
  },
  {
    id: 'h10-control-multiline-clamp',
    defect: 'Đoạn văn bản mô tả sản phẩm được rút gọn bằng kỹ thuật giới hạn số dòng hiển thị kèm dấu ba chấm hợp lệ.',
    expect: { control: true },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tin Tức & Xu Hướng Thời Trang</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 24px; }
    .blog-header { background: #0f172a; color: #fff; padding: 12px 16px; font-weight: 700; text-align: center; font-size: 15px; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 14px 16px; }
    .blog-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; margin-bottom: 14px; }
    .blog-thumb { height: 160px; background: linear-gradient(135deg, #ccfbf1, #99f6e4); display: flex; align-items: center; justify-content: center; font-size: 48px; }
    .blog-body { padding: 14px; }
    .blog-title { font-size: 16px; font-weight: 700; color: #0f172a; line-height: 1.3; margin-bottom: 8px; }

    /* CONTROL: Multi-line clamp using standard -webkit-line-clamp with ellipsis */
    .blog-clamped-desc {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 14px;
      line-height: 1.5;
      color: #64748b;
      margin-bottom: 10px;
    }
    .read-more-link { font-size: 13px; font-weight: 700; color: #0d9488; text-decoration: none; }
  </style>
</head>
<body>
  <div class="blog-header">GÓC PHONG CÁCH & XU HƯỚNG</div>
  <main class="shopify-section section-blog-posts">
    <div class="container">
      <div class="card blog-card">
        <div class="blog-thumb">📰</div>
        <div class="blog-body">
          <h2 class="blog-title">Bí Quyết Phối Đồ Tone-sur-Tone Cho Nàng Công Sở Hiện Đại</h2>
          <p class="blog-clamped-desc">
            Phối trang phục đồng màu tone-sur-tone không chỉ giúp bạn trông cao ráo, thanh thoát hơn mà còn tạo ấn tượng vô cùng chỉn chu và chuyên nghiệp trong mọi cuộc họp hay gặp gỡ đối tác quan trọng.
          </p>
          <a class="read-more-link" href="#!">Xem chi tiết bài viết →</a>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`
  },
  {
    id: 'h11-control-horizontal-chips',
    defect: 'Thanh danh mục sản phẩm dạng thẻ có thể cuộn ngang mượt mà mà không làm tràn khung hình trang web.',
    expect: { control: true },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khám Phá Bộ Sưu Tập Thời Trang Nam</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; overflow-x: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; }
    .store-navbar { background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 12px 16px; font-weight: 800; font-size: 16px; color: #0f172a; }
    
    /* CONTROL: Horizontally scrolling chips within a contained viewport */
    .chip-scroll-wrapper {
      width: 100%;
      background: #ffffff;
      border-bottom: 1px solid #e2e8f0;
      padding: 10px 0;
    }
    .chip-scroll-container {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      padding: 0 16px;
      scrollbar-width: none;
    }
    .chip-scroll-container::-webkit-scrollbar { display: none; }
    .filter-chip {
      flex: 0 0 auto;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      background: #f1f5f9;
      color: #475569;
      border: 1px solid #cbd5e1;
    }
    .filter-chip.active {
      background: #0f172a;
      color: #ffffff;
      border-color: #0f172a;
    }

    .content-area { width: 100%; max-width: 375px; margin: 0 auto; padding: 16px; }
    .feed-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
    .feed-name { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .feed-price { font-size: 16px; font-weight: 800; color: #e11d48; }
  </style>
</head>
<body>
  <div class="store-navbar">THỜI TRANG CÔNG SỞ 2026</div>
  
  <div class="chip-scroll-wrapper">
    <div class="chip-scroll-container">
      <div class="filter-chip active">Tất cả sản phẩm</div>
      <div class="filter-chip">Áo sơ mi lụa</div>
      <div class="filter-chip">Quần tây âu ống đứng</div>
      <div class="filter-chip">Áo vest blazer</div>
      <div class="filter-chip">Phụ kiện cà vạt da</div>
      <div class="filter-chip">Giày da tây cao cấp</div>
    </div>
  </div>

  <div class="content-area">
    <div class="feed-card">
      <div class="feed-name">Áo Polo Nam Phối Cổ Dệt Bo Viền Tinh Tế</div>
      <div class="feed-price">299.000₫</div>
    </div>
    <div class="feed-card">
      <div class="feed-name">Quần Khaki Nam Slimfit Co Giãn Cao Cấp</div>
      <div class="feed-price">350.000₫</div>
    </div>
  </div>
</body>
</html>`
  },
  {
    id: 'h12-control-collapsed-accordion',
    defect: 'Các mục câu hỏi thường gặp được thu gọn gọn gàng trong các ngăn xếp mở rộng theo đúng chuẩn tương tác.',
    expect: { control: true },
    html: `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Câu Hỏi Thường Gặp & Trợ Giúp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding-bottom: 24px; }
    .faq-header { background: #4338ca; color: #ffffff; padding: 14px 16px; font-weight: 700; text-align: center; font-size: 15px; }
    .container { width: 100%; max-width: 375px; margin: 0 auto; padding: 16px; }
    .faq-title { font-size: 17px; font-weight: 800; color: #0f172a; margin-bottom: 12px; }

    /* CONTROL: Collapsed accordion items */
    .faq-item { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
    .faq-question {
      padding: 12px 14px;
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    .faq-answer-open {
      padding: 0 14px 12px 14px;
      font-size: 13px;
      line-height: 1.6;
      color: #475569;
      border-top: 1px solid #f1f5f9;
      margin-top: 6px;
      padding-top: 8px;
    }
    .faq-answer-collapsed {
      display: none;
    }
  </style>
</head>
<body>
  <div class="faq-header">TRUNG TÂM HỖ TRỢ KHÁCH HÀNG</div>
  <main class="shopify-section section-faq">
    <div class="container">
      <h2 class="faq-title">Câu Hỏi Thường Gặp</h2>
      
      <div class="faq-item">
        <div class="faq-question">
          <span>1. Thời gian giao hàng mất bao lâu?</span>
          <span>▲</span>
        </div>
        <div class="faq-answer-open">
          Đơn hàng nội thành Hà Nội và TP.HCM sẽ được giao trong 1-2 ngày làm việc. Các tỉnh thành khác nhận hàng sau 2-4 ngày.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question">
          <span>2. Chính sách đổi size thế nào?</span>
          <span>▼</span>
        </div>
        <div class="faq-answer-collapsed">
          Hỗ trợ đổi size miễn phí trong vòng 7 ngày kể từ ngày nhận hàng với điều kiện sản phẩm còn nguyên tem mác.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question">
          <span>3. Tôi có được kiểm tra hàng trước không?</span>
          <span>▼</span>
        </div>
        <div class="faq-answer-collapsed">
          Quý khách hoàn toàn được đồng kiểm hàng với nhân viên giao hàng trước khi thanh toán tiền.
        </div>
      </div>
    </div>
  </main>
</body>
</html>`
  }
];
