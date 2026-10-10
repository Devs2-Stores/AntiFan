module.exports = [
  {
    id: 'h01-title-price-overlap',
    defect: 'Tiêu đề sản phẩm đè lên giá bán khiến khách khó đọc thông tin giá.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Áo sơ mi linen</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column}.col{width:100%}.card{border:1px solid #ddd;border-radius:12px;overflow:hidden}.photo{height:210px;background:linear-gradient(135deg,#eadfc9,#b7c9b2);display:grid;place-items:center;font-size:64px}.body{padding:16px;position:relative;height:145px}.title{position:absolute;top:16px;left:16px;right:16px;font-size:22px;line-height:28px;font-weight:bold}.price{position:absolute;top:39px;left:16px;font-size:21px;color:#b21f2d;font-weight:bold}.button{display:block;margin-top:85px;background:#222;color:white;text-align:center;padding:13px;border-radius:6px}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="photo">👔</div><div class="body"><h1 class="title">Áo sơ mi linen cổ tàu cao cấp</h1><div class="price">₫590.000</div><a class="button">Thêm vào giỏ hàng</a></div></article></div></div></div></section></body></html>`,
    expect: { kinds: ['overlap'], allowWarning: false }
  },
  {
    id: 'h02-nested-copy-clipped',
    defect: 'Phần mô tả sản phẩm bị cắt cụt trong khung nội dung nên khách không đọc hết hướng dẫn chọn size.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chi tiết sản phẩm</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:16px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column;gap:16px}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;padding:14px}.hero{height:175px;background:#e7d6c2;display:grid;place-items:center;font-size:55px}.description{height:42px;overflow:hidden;line-height:22px}.spacer{height:480px}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">🧥</div><h1>Áo khoác gió chống nước</h1></article></div></div></div></section><div class="spacer"></div><section class="section"><div class="container"><div class="row"><div class="col"><div class="card"><div><div><div><div><div><div><div><div><div class="description">Chất liệu polyester nhẹ, chống thấm tốt và thoáng khí. Vui lòng đo vòng ngực, vòng eo trước khi chọn size; sản phẩm có phom rộng, nếu thích mặc vừa hãy chọn lùi một size.</div></div></div></div></div></div></div></div></div></div></div></section></body></html>`,
    expect: { kinds: ['clipping'], allowWarning: false }
  },
  {
    id: 'h03-nested-cta-covered',
    defect: 'Nút chọn màu ở phần lựa chọn bên dưới bị lớp thông báo nổi che kín.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chọn màu</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column;gap:14px}.col{width:100%}.card{padding:16px;border:1px solid #ddd;border-radius:10px}.hero{height:190px;background:#edd8c5;display:grid;place-items:center;font-size:58px}.spacer{height:520px}.choices{position:relative;padding:18px;background:#fafafa;border-radius:8px}.swatch{display:inline-block;background:#eee;padding:12px;margin:4px;border:1px solid #aaa;border-radius:6px}.toast{position:absolute;top:10px;left:10px;right:10px;height:94px;background:#242424;color:#fff;border-radius:8px;z-index:4;padding:20px;display:grid;place-items:center;text-align:center}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">👜</div><h1>Túi đeo chéo da mềm</h1><strong>₫790.000</strong></article></div></div></div></section><div class="spacer"></div><section class="section"><div class="container"><div class="row"><div class="col"><div class="card"><div><div><div><div><div><div><div><div><div class="choices"><h2>Chọn màu sắc</h2><button class="swatch">Nâu bò</button><button class="swatch">Đen</button><div class="toast">Mã ưu đãi của bạn đã được áp dụng</div></div></div></div></div></div></div></div></div></div></div></div></section></body></html>`,
    expect: { kinds: ['occlusion'], allowWarning: false }
  },
  {
    id: 'h04-sticky-buy-bar-covers-copy',
    defect: 'Thanh mua hàng cố định che mất dòng thông tin giao hàng khi khách cuộn xuống cuối trang.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Giao hàng</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column;gap:14px}.col{width:100%}.card{padding:16px;border:1px solid #ddd;border-radius:10px}.hero{height:230px;background:#d7e5da;display:grid;place-items:center;font-size:62px}.spacer{height:520px}.delivery{height:86px;padding:28px 12px;background:#f5f5f5}.buybar{position:fixed;bottom:0;left:0;right:0;background:#fff;box-shadow:0 -3px 10px #0003;padding:13px 16px;display:flex;justify-content:space-between;align-items:center;z-index:5}.buybar button{background:#b3212d;color:#fff;border:0;border-radius:6px;padding:12px 20px}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">🪴</div><h1>Bình gốm men thủ công</h1><strong>₫420.000</strong></article></div></div></div></section><div class="spacer"></div><section class="section"><div class="container"><div class="row"><div class="col"><div class="card"><h2>Giao hàng toàn quốc</h2><div class="delivery">Phí vận chuyển được tính ở bước thanh toán.</div></div></div></div></div></section><div class="buybar"><strong>₫420.000</strong><button>Mua ngay</button></div></body></html>`,
    expect: { kinds: ['occlusion', 'sticky-obstruction'], allowWarning: false }
  },
  {
    id: 'h05-buy-button-offscreen',
    defect: 'Nút mua ngay bị đẩy hẳn ra ngoài mép phải màn hình điện thoại.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chậu cây</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222;overflow-x:hidden}.section{padding:18px}.container{width:100%;max-width:480px;margin:auto}.row{display:flex}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;overflow:hidden}.hero{height:220px;background:#d8e5ce;display:grid;place-items:center;font-size:64px}.body{padding:16px}.buy{position:relative;left:510px;background:#28633d;color:white;border:0;padding:14px 30px;border-radius:6px;font-size:16px}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">🌱</div><div class="body"><h1>Chậu cây để bàn men ngọc</h1><p>Thủ công tại Bát Tràng</p><strong>₫185.000</strong><p><button class="buy">Mua ngay</button></p></div></article></div></div></div></section></body></html>`,
    expect: { kinds: ['offscreen'], allowWarning: false }
  },
  {
    id: 'h06-horizontal-product-strip',
    defect: 'Trang sản phẩm tràn ngang khiến khách phải kéo màn hình sang bên mới xem hết nội dung.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sản phẩm mới</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column;gap:12px}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;padding:14px}.product-row{display:flex;width:535px;gap:12px}.product{flex:0 0 165px;background:#f2eee8;border-radius:8px;padding:12px}.image{height:92px;background:#d7c9b7;display:grid;place-items:center;font-size:42px}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><h1>Bộ sưu tập mới</h1><div class="card"><div class="product-row"><article class="product"><div class="image">👞</div><h2>Giày da thủ công</h2><strong>₫1.290.000</strong></article><article class="product"><div class="image">🧢</div><h2>Nón cotton</h2><strong>₫250.000</strong></article><article class="product"><div class="image">🧣</div><h2>Khăn lụa tơ tằm</h2><strong>₫480.000</strong></article></div></div></div></div></div></section></body></html>`,
    expect: { documentOverflow: true }
  },
  {
    id: 'h07-deep-controls-overlap',
    defect: 'Hai nút chọn kích cỡ ở phần chi tiết phía dưới chồng lên nhau, khách khó bấm đúng lựa chọn.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chọn kích cỡ</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column;gap:12px}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;padding:16px}.hero{height:180px;background:#d9dfe8;display:grid;place-items:center;font-size:60px}.spacer{height:500px}.size-area{position:relative;height:110px;background:#fafafa;padding:16px}.size{position:absolute;top:46px;width:92px;height:44px;border:1px solid #777;border-radius:6px;background:white}.size.one{left:18px}.size.two{left:72px;background:#eee}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">👖</div><h1>Quần kaki dáng suông</h1><strong>₫650.000</strong></article></div></div></div></section><div class="spacer"></div><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div><div><div><div><div><div><div><div><div><div class="size-area"><h2>Chọn kích cỡ</h2><button class="size one">M</button><button class="size two">L</button></div></div></div></div></div></div></div></div></div></div></article></div></div></div></section></body></html>`,
    expect: { kinds: ['overlap'], allowWarning: false }
  },
  {
    id: 'h08-product-name-clipped',
    defect: 'Tên sản phẩm bị cắt giữa dòng trong thẻ sản phẩm khiến khách không nhận ra đầy đủ mẫu hàng.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Áo thun cotton</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;overflow:hidden}.hero{height:220px;background:#e5e1d8;display:grid;place-items:center;font-size:65px}.body{padding:16px}.title{height:22px;overflow:hidden;white-space:nowrap;line-height:22px;font-size:20px}.price{color:#b3212d;font-weight:bold;font-size:19px}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">👕</div><div class="body"><h1 class="title">Áo thun cotton hữu cơ cổ tròn phiên bản mùa hè</h1><div class="price">₫299.000</div><p>Mềm mại, thoáng mát, phù hợp mặc hằng ngày.</p></div></article></div></div></div></section></body></html>`,
    expect: { kinds: ['clipping'], allowWarning: false }
  },
  {
    id: 'h09-ellipsis-product-title',
    defect: 'Tiêu đề sản phẩm hiển thị đầy đủ trong một dòng rút gọn, không che giá hay nút mua.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trang bộ sưu tập</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;gap:12px}.col{flex:1;min-width:0}.card{border:1px solid #ddd;border-radius:10px;overflow:hidden}.image{height:145px;background:#e2d9ca;display:grid;place-items:center;font-size:54px}.body{padding:12px}.title{margin:0 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:16px}.price{color:#b3212d;font-weight:bold}
</style></head><body><section class="section"><div class="container"><h1>Áo nữ bán chạy</h1><div class="row"><div class="col"><article class="card"><div class="image">👚</div><div class="body"><h2 class="title">Áo kiểu linen thêu hoa cổ vuông tay phồng</h2><div class="price">₫490.000</div></div></article></div><div class="col"><article class="card"><div class="image">👜</div><div class="body"><h2 class="title">Túi cói đi biển thủ công</h2><div class="price">₫350.000</div></div></article></div></div></div></section></body></html>`,
    expect: { control: true }
  },
  {
    id: 'h10-closed-cart-drawer',
    defect: 'Ngăn giỏ hàng đang đóng và nằm ngoài khung nhìn, nội dung trang vẫn đọc và thao tác bình thường.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Giỏ hàng</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;overflow:hidden}.image{height:205px;background:#d9e4e2;display:grid;place-items:center;font-size:64px}.body{padding:16px}.drawer{position:fixed;top:0;right:0;width:310px;height:100vh;background:white;box-shadow:-4px 0 18px #0003;transform:translateX(105%);visibility:hidden;padding:20px;z-index:4}
</style></head><body><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="image">🧴</div><div class="body"><h1>Sữa dưỡng thể hương sen</h1><p>Dưỡng ẩm dịu nhẹ từ thành phần thiên nhiên.</p><strong>₫320.000</strong><p><button>Thêm vào giỏ hàng</button></p></div></article></div></div></div></section><aside class="drawer"><h2>Giỏ hàng của bạn</h2></aside></body></html>`,
    expect: { control: true }
  },
  {
    id: 'h11-carousel-offscreen-slides',
    defect: 'Các ảnh sản phẩm kế tiếp nằm ngoài khung carousel, ảnh hiện tại và thông tin giá vẫn hiển thị rõ.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Carousel sản phẩm</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;overflow:hidden}.track{display:flex;width:300%;transform:translateX(0)}.slide{width:33.333%;height:230px;flex:none;display:grid;place-items:center;font-size:72px;background:#eee}.slide:nth-child(2){background:#dbe5d9}.slide:nth-child(3){background:#e9d9d2}.body{padding:16px}.dots{text-align:center;letter-spacing:8px;color:#777}
</style></head><body><section class="section"><div class="container"><h1>Được yêu thích</h1><div class="row"><div class="col"><article class="card"><div class="track"><div class="slide">👟</div><div class="slide">🥿</div><div class="slide">🥾</div></div><div class="body"><h2>Giày sneaker vải canvas</h2><strong>₫690.000</strong><div class="dots">● ○ ○</div></div></article></div></div></div></section></body></html>`,
    expect: { control: true }
  },
  {
    id: 'h12-padded-sticky-header',
    defect: 'Đầu trang cố định nằm trên vùng đệm trống, không che nội dung sản phẩm khi khách cuộn.',
    html: `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trang chủ cửa hàng</title><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;color:#222}.header{position:sticky;top:0;height:56px;background:#fff;box-shadow:0 2px 7px #0002;z-index:3;display:flex;align-items:center;padding:0 18px;font-weight:bold}.section{padding:18px}.container{max-width:480px;margin:auto}.row{display:flex;flex-direction:column;gap:14px}.col{width:100%}.card{border:1px solid #ddd;border-radius:10px;overflow:hidden}.hero{height:210px;background:#e7decf;display:grid;place-items:center;font-size:62px}.body{padding:15px}.topspace{height:28px}
</style></head><body><header class="header">NHÀ MÂY　　☰</header><div class="topspace"></div><section class="section"><div class="container"><div class="row"><div class="col"><article class="card"><div class="hero">🪑</div><div class="body"><h1>Ghế mây đan thủ công</h1><p>Thiết kế nhẹ nhàng cho góc thư giãn của bạn.</p><strong>₫2.450.000</strong></div></article></div></div></div></section></body></html>`,
    expect: { control: true }
  }
];
