// Controller fresh-evidence corpus for the Stage 2 union (paired: -ctl must hold, -bug shows the defect).
const base = require('./fixtures.cjs');
const html = (id) => base.find((f) => f.id === id).html;
const withCss = (h, css) => h.replace('</style>', css + '</style>');
const page = (body, css = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{margin:0;font:16px/1.4 Arial,sans-serif;color:#111}${css}</style></head><body>${body}</body></html>`;

// U1: a 180px CTA covered by an empty opaque badge (no text, so only the sweep can catch it).
const tallCta = (top) => page(
  `<div style="height:${top - 20}px"></div><div class="pro-form"><button class="buy">Mua ngay</button><div class="badge"></div></div><div style="height:2500px"></div>`,
  '.pro-form{position:relative;padding:20px 12px}.buy{display:block;width:100%;height:180px}.badge{position:absolute;left:0;top:20px;width:100%;height:180px;background:#c00}');

// U2/U3: a checkout button covered by an opaque block that lives in the same container.
const IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="350" height="180"><rect width="350" height="180" fill="#2a6"/></svg>');
const imgCta = (top) => page(
  `<div style="height:${top - 20}px"></div><div class="pro-form"><a class="banner" href="/sale"><img src="${IMG}" width="350" height="180" alt="Mua ngay giảm 50%"></a><div class="badge"></div></div><div style="height:2500px"></div>`,
  '.pro-form{position:relative;padding:20px 12px}.banner{display:block;height:180px}.banner img{display:block;width:100%;height:180px}.badge{position:absolute;left:0;top:20px;width:100%;height:180px;background:#c00}');
const covered = '<button class="pay">Thanh toán ngay</button><div class="sticker"></div>';
const coverCss = '.box{position:relative;padding:20px}.pay{display:block;width:100%;height:48px}.sticker{position:absolute;left:0;top:20px;width:100%;height:48px;background:#c00}';
const modal = (attrs) => page(`<p>Trang sản phẩm</p><div class="modal box" ${attrs}><h2>Xác nhận đơn hàng</h2>${covered}</div>`,
  coverCss + '.modal{position:fixed;left:16px;right:16px;top:120px;background:#fff;border:1px solid #ccc}');
const slide = (cls) => page(`<div class="swiper"><div class="${cls === 'swiper-slide' ? 'swiper-wrapper' : 'track'}"><div class="${cls} box"><h2>Bộ sưu tập mới</h2>${covered}</div></div></div>`, coverCss);

// U4: fixture 09 under an infinite background animation on body (and a finished transition as a control).
const bodyAnim = 'body{animation:bg 15s ease infinite}@keyframes bg{0%{background-color:#fff}50%{background-color:#fafafa}100%{background-color:#fff}}';

// U5: read-more control and gradient overlay inside the collapsed block itself.
const PARA = 'Nhẫn cưới đôi được cá nhân hoá với hình trái tim từ dấu vân tay tuyệt đẹp của bạn. Thiết kế này được chế tác riêng cho từng cặp đôi với tất cả các kiểu dáng và chất liệu có thể đeo lâu bền.';
const inside = page(`<div style="padding:0 12px"><div class="desc"><p>${PARA}</p><p>Xem <a href="/size">bảng size</a> chi tiết bên dưới.</p><p>${PARA}</p><div class="fade"></div><button class="more">Xem thêm</button></div></div>`,
  '.desc{position:relative;max-height:140px;overflow:hidden;line-height:22px}.desc p{margin:0 0 8px}.fade{position:absolute;left:0;right:0;bottom:0;height:60px;background:linear-gradient(rgba(255,255,255,0),#fff)}.more{position:absolute;left:50%;bottom:4px;margin-left:-50px;width:100px;height:32px;background:#fff;border:1px solid #111}');

// U6: fixture 17 with an icon-only toggle (aria-label, no text, no aria-expanded).
const icon = html('17-readmore-collapsed').replace(/<a href="#" class="more">Xem thêm<\/a>/,
  '<button class="more" aria-label="Xem thêm"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 5l6 6 6-6" stroke="#111" fill="none"/></svg></button>');

module.exports = [
  { id: 'u1-ctl-cta-in-step', defect: 'U1 control: same CTA fully inside step 0', html: tallCta(200), expect: { kinds: ['occlusion'] } },
  { id: 'u1-bug-cta-on-seam', defect: 'U1: CTA 500..680 straddles the 533px seam at 375x667', html: tallCta(500), expect: { kinds: ['occlusion'] } },
  { id: 'u2-ctl-modal-plain', defect: 'U2 control: fixed panel without dialog role', html: modal(''), expect: { kinds: ['occlusion'] } },
  { id: 'u2-bug-modal-dialog', defect: 'U2: same panel with role=dialog aria-modal', html: modal('role="dialog" aria-modal="true"'), expect: { kinds: ['occlusion'] } },
  { id: 'u3-ctl-slide-plain', defect: 'U3 control: same markup, non-carousel class', html: slide('slide-box'), expect: { kinds: ['occlusion'] } },
  { id: 'u3-bug-slide-swiper', defect: 'U3: cover in the same .swiper-slide', html: slide('swiper-slide'), expect: { kinds: ['occlusion'] } },
  { id: 'u4-ctl-no-anim', defect: 'U4 control: fixture 09 as is', html: html('09-cta-occluded-in-viewport'), expect: { kinds: ['occlusion'] } },
  { id: 'u4-ctl-body-transition', defect: 'U4: body transition declared but not running', html: withCss(html('09-cta-occluded-in-viewport'), 'body{transition:background-color .3s}'), expect: { kinds: ['occlusion'] } },
  { id: 'u4-bug-body-anim', defect: 'U4: infinite background animation on body', html: withCss(html('09-cta-occluded-in-viewport'), bodyAnim), expect: { kinds: ['occlusion'] } },
  { id: 'u5-bug-readmore-inside', defect: 'U5: toggle + gradient inside the collapsed block (healthy page)', html: inside, expect: { control: true } },
  { id: 'u1-ctl-img-in-step', defect: 'U1 control: image CTA (no text run) fully inside step 0', html: imgCta(200), expect: { kinds: ['occlusion'] } },
  { id: 'u1-bug-img-on-seam', defect: 'U1: image CTA 500..680 on the seam', html: imgCta(500), expect: { kinds: ['occlusion'] } },
  { id: 'u6-bug-icon-toggle', defect: 'U6: fixture 17 with icon-only toggle (healthy page)', html: icon, expect: { control: true } },
  { id: 'u8-ctl-offscreen', defect: 'U8 control: fixture 20 as is', html: html('20-offscreen-cta-clipped-card'), expect: { kinds: ['offscreen', 'clipping'] } },
  { id: 'u8-bug-offscreen-centered', defect: 'U8: fixture 20 with the card centered by translateX(-50%)', html: withCss(html('20-offscreen-cta-clipped-card'), '.card{position:relative;left:50%;transform:translateX(-50%)}'), expect: { kinds: ['offscreen', 'clipping'] } },
];
