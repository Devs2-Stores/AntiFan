// Throwaway fixtures: each page carries ONE known, visually real layout defect
// (or a false-positive control). Markup depth mimics Haravan theme nesting.
const BASE_CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.4 Arial,sans-serif;color:#111}
.wrapper,.section,.container,.row,.col{display:block}.container{padding:0 12px}`;

const page = (body, css = '', head = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_CSS}${css}</style>${head}</head><body>${body}</body></html>`;

// inner root lands at depth 7 below <body> (wrapper=1 ... col=6)
const deep = (inner) =>
  `<div class="wrapper"><main id="main"><div class="section"><div class="container"><div class="row"><div class="col">${inner}</div></div></div></div></main></div>`;

const card = (title, i) => `<div class="product-card"><div class="thumb-box"></div><div class="info">
<h3 class="pro-name"><a href="/products/p${i}">${title}</a></h3><div class="pro-price">199.000₫</div></div></div>`;

const LONG_TITLE = 'Áo thun nam cổ tròn basic cotton 100% co giãn 4 chiều thoáng mát form rộng phiên bản giới hạn';
const FOOTER = '<footer><a class="f1" href="/policy">Chính sách đổi trả</a><a class="f2" href="/contact">Liên hệ</a></footer>';
const FOOTER_CSS = 'footer a{display:block;height:24px}.f2{margin-top:-24px;background:rgba(255,255,255,.6)}';
const STICKER_CSS = '.pro-form{position:relative;padding:20px 0}.btn-addtocart{width:100%;height:48px}.promo-sticker{position:absolute;left:0;top:10px;width:100%;height:70px;background:rgba(220,0,0,.9);color:#fff}';
const PARA = 'Nhẫn cưới đôi được cá nhân hoá với hình trái tim từ dấu vân tay tuyệt đẹp của bạn. Thiết kế này được chế tác riêng cho từng cặp đôi với tất cả các kiểu dáng và chất liệu có thể đeo lâu bền.';
module.exports = [
  {
    id: '01-overflow-plain',
    defect: 'Banner 520px rộng hơn viewport 375 → thanh cuộn ngang (positive control)',
    html: page(deep('<div class="banner">Banner khuyến mãi</div>'), '.banner{width:520px;height:80px;background:#fc0}'),
  },
  {
    id: '02-overflow-masked-body',
    defect: 'Banner 520px bị cắt vì html,body{overflow-x:hidden} (nội dung mất bên phải)',
    html: page(deep('<div class="banner">Banner khuyến mãi — phần chữ bên phải bị cắt mất</div>'), 'html,body{overflow-x:hidden}.banner{width:520px;height:80px;background:#fc0}'),
  },
  {
    id: '03-overflow-masked-wrapper',
    defect: 'Banner 520px bị cắt vì .wrapper{overflow:hidden} (pattern phổ biến của theme)',
    html: page(deep('<div class="banner">Banner khuyến mãi — phần chữ bên phải bị cắt mất</div>'), '.wrapper{overflow:hidden}.banner{width:520px;height:80px;background:#fc0}'),
  },
  {
    id: '04-text-on-text-deep',
    defect: 'Giá đè lên tên sản phẩm trong product card (độ sâu DOM ~9)',
    html: page(deep('<div class="product-card"><div class="info"><h3 class="title">Áo thun nam basic</h3><div class="price">199.000₫ giá sốc</div></div></div>'),
      '.title{margin:0;font-size:18px}.price{margin-top:-20px;font-size:18px;color:#c00}'),
  },
  {
    id: '05-text-on-text-shallow',
    defect: 'Cùng lỗi giá đè tên nhưng ở độ sâu 1 (body > h2 + p)',
    html: page('<h2 class="title">Áo thun nam basic</h2><p class="price">199.000₫ giá sốc</p>',
      'h2{margin:0;font-size:18px}p{margin:-20px 0 0;font-size:18px;color:#c00}'),
  },
  {
    id: '06-partial-overlap-30pct',
    defect: 'Hai khối chữ chồng nhau 30% chiều cao (margin âm)',
    html: page('<div class="a">Khối A: tiêu đề section ưu đãi tháng mười dành cho khách hàng thân thiết</div><div class="b">Khối B: mô tả chương trình bị kéo lên đè vào khối A</div>',
      '.a,.b{height:100px;padding:8px}.a{background:#def}.b{margin-top:-30px;background:rgba(255,220,220,.85)}'),
  },
  {
    id: '07-text-spill-collision',
    defect: 'Mô tả cao cố định 40px, overflow visible → chữ tràn đè lên đoạn kế tiếp',
    html: page(deep('<div class="desc">Chất liệu cotton 100% co giãn bốn chiều, thấm hút mồ hôi tốt, phù hợp đi làm, đi chơi, dạo phố và cả tập thể thao nhẹ nhàng mỗi ngày.</div><div class="next">Hướng dẫn bảo quản: giặt tay nhẹ nhàng</div>'),
      '.desc{height:40px;overflow:visible}.next{color:#c00}'),
  },
  {
    id: '08-text-cut-by-ancestor',
    defect: 'Card cao cố định overflow:hidden → tên/giá sản phẩm bị cắt cụt',
    html: page(deep(`<div class="card"><div class="thumb"></div><h3 class="t">${LONG_TITLE}</h3><p class="p">199.000₫</p></div>`),
      '.card{height:150px;overflow:hidden;border:1px solid #ccc}.thumb{height:100px;background:#ddd}.t{margin:0;font-size:16px}.p{margin:0}'),
  },
  {
    id: '09-cta-occluded-in-viewport',
    defect: 'Nút Thêm vào giỏ bị khối sticker absolute che (trong viewport) — positive control',
    html: page(deep('<div class="pro-form"><button class="btn-addtocart">Thêm vào giỏ</button><div class="promo-sticker">Giảm 50%</div></div>'), STICKER_CSS),
  },
  {
    id: '10-cta-occluded-below-fold',
    defect: 'Cùng lỗi nút bị che nhưng nằm dưới màn hình đầu (y≈1500)',
    html: page(deep('<div class="spacer">Nội dung dài</div><div class="pro-form"><button class="btn-addtocart">Thêm vào giỏ</button><div class="promo-sticker">Giảm 50%</div></div>'),
      '.spacer{height:1500px}' + STICKER_CSS),
  },
  {
    id: '11-fixed-header-covers-hero-text',
    defect: 'Header fixed 110px không chừa padding → che mất tiêu đề hero (chữ, không phải link)',
    html: page('<header class="site-header"><span class="logo">LOGO SHOP</span><nav><a href="/">Trang chủ</a> <a href="/collections/all">Sản phẩm</a></nav></header>' + deep('<section class="hero"><h1>Bộ sưu tập mùa thu 2026</h1><p>Giảm đến 50% toàn bộ sản phẩm</p></section><p class="body-copy">Nội dung tiếp theo của trang chủ.</p>'),
      '.site-header{position:fixed;top:0;left:0;right:0;height:110px;z-index:10;background:#fff;border-bottom:1px solid #ccc}.hero h1{margin:0;font-size:24px}.hero p{margin:0}'),
  },
  {
    id: '12-line-clamp-intended',
    defect: 'KHÔNG lỗi: tên SP line-clamp 2 dòng + menu ellipsis có chủ đích (false-positive control)',
    html: page(deep(`<nav class="menu"><a href="/a">Thời trang nam cao cấp nhập khẩu</a><a href="/b">Phụ kiện thời trang</a></nav><div class="grid">${Array.from({ length: 6 }, (_, i) => card(LONG_TITLE, i)).join('')}</div>`),
      '.menu{display:flex;gap:8px}.menu a{max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.thumb-box{height:120px;background:#eee}.pro-name{margin:0;font-size:14px}.pro-name a{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'),
  },
  {
    id: '13a-footer-overlap-small-dom',
    defect: 'Hai link footer chồng 100% (DOM nhỏ, 100 phần tử filler) — positive control cho cap',
    html: page(`<div class="filler">${'<i>x</i> '.repeat(100)}</div>${FOOTER}`, FOOTER_CSS),
  },
  {
    id: '13b-footer-overlap-large-dom',
    defect: 'Cùng lỗi footer nhưng DOM có 2.500 phần tử phía trước (trang thật thường 3–8k)',
    html: page(`<div class="filler">${'<i>x</i> '.repeat(2500)}</div>${FOOTER}`, FOOTER_CSS),
  },
  {
    id: '14-cls-shift',
    defect: 'Banner 400px chèn lên đầu trang sau 1000ms → layout shift lớn (CLS thật đo bằng observer riêng)',
    // 1000ms, not 300ms: mobile CDP emulation registers an input ~235ms after load, and Chromium
    // marks shifts within 500ms of input as hadRecentInput (excluded from CLS by definition).
    settleMs: 2000,
    html: page(deep('<div id="slot"></div><h2>Sản phẩm nổi bật</h2><p>Đoạn nội dung bị đẩy xuống khi banner chèn vào.</p><p>Đoạn nội dung thứ hai.</p><p>Đoạn nội dung thứ ba.</p>'),
      'h2{margin:0}',
      `<script>window.__truth={cls:0};new PerformanceObserver(l=>{for(const e of l.getEntries()){if(!e.hadRecentInput)window.__truth.cls+=e.value}}).observe({type:'layout-shift',buffered:true});
addEventListener('load',()=>setTimeout(()=>{const d=document.createElement('div');d.style.cssText='height:400px;background:#09f';document.getElementById('slot').appendChild(d)},1000));</script>`),
  },
  {
    id: '15-image-over-text-deep',
    defect: 'Ảnh/khối absolute đè lên đoạn mô tả trong card (độ sâu ~9)',
    html: page(deep('<div class="product-card"><div class="info" style="position:relative"><p class="desc">Mô tả ngắn sản phẩm: chất liệu cotton, form rộng, màu đen.</p><div class="thumb"></div></div></div>'),
      '.desc{margin:0}.thumb{position:absolute;left:0;top:0;width:100%;height:40px;background:#888}'),
  },
  {
    id: '16-slider-intended',
    defect: 'KHÔNG lỗi: slider ngang overflow-x:auto có chủ đích (false-positive control)',
    html: page(deep(`<div class="slider">${Array.from({ length: 6 }, (_, i) => `<div class="slide"><a href="/p${i}">Sản phẩm ${i + 1}</a></div>`).join('')}</div>`),
      '.slider{display:flex;overflow-x:auto;gap:8px}.slide{flex:0 0 250px;height:120px;background:#eee}'),
  },
  {
    id: '17-readmore-collapsed',
    defect: 'KHÔNG lỗi: mô tả SP thu gọn max-height + link "Xem thêm"; dòng cuối bị cắt và link trong phần ẩn là chủ đích (false-positive control)',
    html: page(deep(`<div class="desc-wrap"><div class="desc"><p>${PARA}</p><p>Xem <a href="/size">bảng size</a> chi tiết bên dưới.</p><p>${PARA}</p></div><a href="#" class="more">Xem thêm</a></div>`),
      '.desc{max-height:100px;overflow:hidden;line-height:22px}.desc p{margin:0 0 8px}.more{display:inline-block;padding:8px 0}'),
  },
  {
    id: '18-tabs-x-scroller',
    defect: 'KHÔNG lỗi: thanh tab cuộn ngang overflow-x:auto, tab cuối bị mép cắt có chủ đích (false-positive control)',
    html: page(deep(`<ul class="tabs">${['Nhẫn cưới', 'Nhẫn cầu hôn giảm ngay 5%', 'Dây chuyền bạc', 'Bông tai'].map((t, i) => `<li><a href="/c${i}">${t}</a></li>`).join('')}</ul>`),
      '.tabs{display:flex;overflow-x:auto;overflow-y:hidden;white-space:nowrap;list-style:none;margin:0;padding:0;gap:16px}.tabs li{flex:0 0 auto}.tabs a{display:inline-block;padding:10px 0}'),
  },
  {
    id: '19-hero-crossfade',
    defect: 'KHÔNG lỗi: hero slider crossfade opacity, scan rơi giữa transition nên 2 slide cùng hiện mờ (false-positive control)',
    html: page(deep(`<section class="hero"><div class="slide s1"><h2>Thiết bị bếp nóng chuyên nghiệp</h2><a href="/shop">Khám phá ngay</a></div><div class="slide s2"><h2>Đỉnh cao nghệ thuật ẩm thực</h2><a href="/class">Khám phá lớp học</a></div></section>`),
      '.hero{position:relative;height:300px}.slide{position:absolute;inset:0;padding:40px;transition:opacity 20s linear}.s1{opacity:1}.s2{opacity:0}.hero.go .s1{opacity:0}.hero.go .s2{opacity:1}.slide a{display:inline-block;padding:10px 16px;background:#09f;color:#fff}',
      `<script>addEventListener('load',()=>requestAnimationFrame(()=>requestAnimationFrame(()=>document.querySelector('.hero').classList.add('go'))))</script>`),
  },
];
