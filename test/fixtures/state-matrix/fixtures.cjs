'use strict';
// Corpus for src/main/qa/state-matrix.ts, run by test/e2e/state-matrix-fixtures-probe.cjs with
// trusted CDP input at 1280x800 (desktop) and 390x844 (mobile).
//
// expect.status:   { <triggerIndex>: 'PASS' | 'WARN' | 'FAIL' | 'NOT_RUN' }
// expect.codes:    { <triggerIndex>: [failure codes that must be present] }
// expect.noCodes:  { <triggerIndex>: [failure codes that must be absent] }
// expect.triggers: exact number of exercised triggers
// expect.skipped:  reasons that must appear in skippedTriggers
// expect.measured: expected top-level `measured`
// expect.closeSkipped: { <triggerIndex>: { <close method>: 'skip reason prefix' } }
// expect.closeClosed:  { <triggerIndex>: [close methods that must have closed the panel] }
const fs = require('node:fs');
const path = require('node:path');
const kit = (name) => fs.readFileSync(path.join(__dirname, '..', 'visual-qa', 'kit', `${name}.html`), 'utf8');

const BASE_CSS = `
html,body{margin:0;font:16px/1.5 Arial,sans-serif;color:#111;background:#fff}
header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #ddd}
.btn{min-width:48px;min-height:48px;border:1px solid #333;background:#fff;color:#111;font:inherit}
.drawer{position:fixed;top:0;right:0;width:360px;max-width:88vw;height:100%;background:#fff;box-shadow:-4px 0 16px rgba(0,0,0,.25);transform:translateX(105%);transition:transform .15s;z-index:100;padding:16px;box-sizing:border-box;overflow-y:auto}
.drawer.is-open{transform:none}
.modal{position:fixed;top:50%;left:50%;width:480px;max-width:90vw;min-height:240px;transform:translate(-50%,-50%);background:#fff;z-index:100;padding:16px;box-sizing:border-box;display:none;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.modal.is-open{display:block}
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:99}
.backdrop.is-open{display:block}
.close{position:absolute;top:8px;right:8px;width:44px;height:44px;border:0;background:#eee;color:#111;font-size:20px}
body.lock{overflow:hidden}
main{padding:16px;min-height:1600px}
`;

// One overlay wired with toggles for each defect the corpus pins.
function overlayPage(opts = {}) {
  const o = {
    kind: 'drawer', escape: true, closeButton: true, backdrop: true, lockLeak: false, transparent: false,
    spill: false, offscreen: false, stuck: false, focus: true, ...opts,
  };
  const panelClass = o.kind === 'modal' ? 'modal' : 'drawer';
  const panelStyle = [
    o.transparent ? 'opacity:.6' : '',
    o.offscreen ? 'left:auto;right:-35vw;transform:translate(0,-50%)' : '',
  ].filter(Boolean).join(';');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_CSS}</style></head><body>
<header><strong>Shop</strong><button class="btn cart-toggle" aria-controls="panel" aria-label="Giỏ hàng" aria-expanded="false">Giỏ</button></header>
<main><p>Nội dung trang chủ.</p></main>
<div class="backdrop" id="backdrop"></div>
<aside id="panel" class="${panelClass}" role="dialog" aria-modal="true" aria-label="Giỏ hàng" style="${panelStyle}">
  ${o.closeButton ? '<button class="close" aria-label="Đóng">×</button>' : ''}
  <h2 style="margin:0 0 12px">Giỏ hàng (1)</h2>
  <p>Dell XPS 8960 Desktop — 48.490.000₫</p>
  ${o.spill ? '<div style="width:560px;background:#f3f3f3">Dòng khuyến mãi quá rộng tràn ra ngoài panel</div>' : ''}
  <a class="btn" href="/checkout" style="display:inline-flex;align-items:center;padding:0 16px">Thanh toán</a>
</aside>
<script>
  const btn = document.querySelector('.cart-toggle');
  const panel = document.getElementById('panel');
  const backdrop = document.getElementById('backdrop');
  const close = panel.querySelector('.close');
  const STUCK = ${o.stuck};
  function open() {
    panel.classList.add('is-open'); backdrop.classList.add('is-open'); document.body.classList.add('lock');
    btn.setAttribute('aria-expanded', 'true');
    if (${o.focus}) (close || panel.querySelector('a, button') || panel).focus();
  }
  function shut() {
    if (STUCK) return;
    panel.classList.remove('is-open'); backdrop.classList.remove('is-open');
    if (!${o.lockLeak}) document.body.classList.remove('lock');
    btn.setAttribute('aria-expanded', 'false'); btn.focus();
  }
  btn.addEventListener('click', () => (panel.classList.contains('is-open') ? shut() : open()));
  if (close) close.addEventListener('click', shut);
  if (${o.backdrop}) backdrop.addEventListener('click', shut);
  if (${o.escape}) document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('is-open')) shut(); });
</script></body></html>`;
}

module.exports = [
  { id: 'drawer-healthy', html: overlayPage(), expect: { triggers: 1, status: { 0: 'PASS' }, measured: true } },
  {
    // Lux Shoes mobile menu at 375px: an opaque drawer as wide as the viewport with a painted head
    // and foot. It is a full-screen sheet with no backdrop, so the backdrop close is not graded.
    id: 'full-screen-sheet-has-no-backdrop',
    html: overlayPage({ backdrop: false })
      .replace('.drawer{position:fixed;top:0;right:0;width:360px;max-width:88vw;', '.drawer{position:fixed;top:0;right:0;width:100vw;max-width:none;padding:0;')
      .replace('<h2 style="margin:0 0 12px">', '<div style="background:#f7f4ef;height:64px">Menu</div><h2 style="margin:0 0 12px">')
      .replace('</aside>', '<div style="position:absolute;left:0;right:0;bottom:0;height:84px;background:#ece9e4">Tài khoản</div></aside>'),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['CLOSE_BACKDROP_FAILED'] } },
  },
  {
    // Mirrors S2 Sky Fashion under ?themeid=: the Haravan preview bar (#haravan-notification with
    // ul.preview-cta) sits over the bottom mobile dock. A shopper never sees that bar, so the dock
    // trigger must still be driven.
    id: 'dock-under-platform-preview-bar',
    html: overlayPage()
      .replace('</style>', '.cart-toggle{position:fixed;left:0;right:0;bottom:0;width:100%;height:56px;z-index:50}</style>')
      .replace('<script>', '<div id="haravan-notification" style="position:fixed;left:0;right:0;bottom:0;height:64px;z-index:999;background:#222"><ul class="preview-cta" style="margin:0;height:100%"><li><a href="#publish" style="color:#fff">Xuất bản</a></li></ul></div>\n<script>'),
    expect: { triggers: 1, status: { 0: 'PASS' }, measured: true, noCodes: { 0: ['TRIGGER_NOT_ACTIONABLE'] } },
  },
  {
    // The slide takes 600ms, longer than the 250ms settle the lane passes: the run must wait for
    // the transition instead of measuring the drawer mid-slide (half off-screen).
    id: 'drawer-slow-slide-is-measured-where-it-lands',
    html: overlayPage().replace('transition:transform .15s', 'transition:transform .6s'),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['OVERLAY_OFFSCREEN', 'CLOSE_ESCAPE_FAILED', 'CLOSE_BACKDROP_FAILED'] } },
  },
  { id: 'drawer-escape-does-not-close', html: overlayPage({ escape: false }), expect: { status: { 0: 'FAIL' }, codes: { 0: ['CLOSE_ESCAPE_FAILED'] }, noCodes: { 0: ['CLOSE_BUTTON_FAILED', 'STATE_STUCK_OPEN'] } } },
  { id: 'drawer-scroll-lock-leaks-after-close', html: overlayPage({ lockLeak: true }), expect: { status: { 0: 'FAIL' }, codes: { 0: ['BODY_NOT_RESTORED'] } } },
  { id: 'modal-without-close-control', html: overlayPage({ kind: 'modal', closeButton: false }), expect: { status: { 0: 'FAIL' }, codes: { 0: ['CLOSE_CONTROL_MISSING'] }, noCodes: { 0: ['CLOSE_ESCAPE_FAILED'] } } },
  { id: 'drawer-renders-semi-transparent', html: overlayPage({ transparent: true }), expect: { status: { 0: 'FAIL' }, codes: { 0: ['OVERLAY_TRANSPARENT'] } } },
  { id: 'drawer-content-spills-out', html: overlayPage({ spill: true }), expect: { status: { 0: 'FAIL' }, codes: { 0: ['CONTENT_OVERFLOWS_PANEL'] } } },
  {
    // Mobile-menu pattern: a sub-level parked beside the panel, which clips its own overflow.
    id: 'drawer-parks-a-submenu-outside-its-clipped-box',
    html: overlayPage().replace('style=""', 'style="overflow:hidden"').replace('<h2 style="margin:0 0 12px">Giỏ hàng (1)</h2>', '<h2 style="margin:0 0 12px">Giỏ hàng (1)</h2><div class="submenu-panel" style="position:absolute;top:0;left:100%;width:100%;height:100%;background:#fafafa">Danh mục con</div>'),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['CONTENT_OVERFLOWS_PANEL'] } },
  },
  { id: 'modal-hangs-off-the-right-edge', html: overlayPage({ kind: 'modal', offscreen: true }), expect: { status: { 0: 'FAIL' }, codes: { 0: ['OVERLAY_OFFSCREEN'] } } },
  {
    // Sapo logged-in admin session: content_for_header's admin-bar script pushes every fixed element
    // 40px down on window.onload. Shoppers never run it, so the drawer is not off-screen.
    id: 'drawer-shifted-by-sapo-admin-bar-script',
    html: overlayPage().replace('<script>', '<script>(function(){function getStyle(el,p){return getComputedStyle(el).getPropertyValue(p)}function doShift(down){var a=document.getElementsByTagName("*");for(var i=0;i<a.length;i++){if(a[i].id!="admin_bar_iframe"&&getStyle(a[i],"position")=="fixed")a[i].style.top=parseInt(getStyle(a[i],"top"),10)+(down?40:-40)+"px"}}window.onload=function(){doShift(true)}}())</script>\n<script>'),
    expect: { triggers: 1, noCodes: { 0: ['OVERLAY_OFFSCREEN'] } },
  },
  {
    // Same 40px push from the theme itself (no admin-bar script): the drawer really hangs off the bottom.
    id: 'drawer-pushed-below-the-fold-by-theme',
    html: overlayPage().replace('style=""', 'style="top:40px"'),
    expect: { triggers: 1, status: { 0: 'FAIL' }, codes: { 0: ['OVERLAY_OFFSCREEN'] } },
  },
  { id: 'drawer-focus-stays-behind', html: overlayPage({ focus: false }), expect: { status: { 0: 'WARN' }, codes: { 0: ['FOCUS_NOT_MOVED'] } } },
  {
    id: 'stuck-overlay-stops-the-run',
    html: overlayPage({ stuck: true }).replace('</header>', '<button class="btn" aria-haspopup="dialog" aria-controls="other">Khác</button></header><div id="other" class="modal" role="dialog"></div>'),
    expect: { status: { 0: 'FAIL', 1: 'NOT_RUN' }, codes: { 0: ['STATE_STUCK_OPEN'] }, measured: false },
  },
  {
    // No backdrop layer: the uncovered strip beside the drawer is a product tile. The outside
    // click must be refused, and the drawer closed by the method that already worked.
    id: 'backdrop-point-over-a-buy-tile-is-never-clicked',
    html: overlayPage({ backdrop: false })
      .replace('<div class="backdrop" id="backdrop"></div>', '<div id="backdrop"></div>')
      .replace('<main><p>Nội dung trang chủ.</p></main>', '<main><button class="buy-tile" style="display:block;width:100%;height:1400px;border:0;background:#f6f6f6" onclick="document.body.dataset.added=String(Number(document.body.dataset.added||0)+1)">Sản phẩm</button></main>'),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['STATE_STUCK_OPEN', 'CLOSE_BACKDROP_FAILED'] }, closeSkipped: { 0: { backdrop: 'POINT_UNSAFE: INTERACTIVE_TARGET' } }, bodyUntouched: 'added' },
  },
  {
    // Live Haravan pattern: a first-visit popup locks scrolling at rest and closes on any outside
    // click, so the cart click dismisses it. Closing the cart leaves the page unlocked, which is
    // better than the rest state, not a leak.
    id: 'first-visit-popup-locks-the-page-at-rest',
    html: overlayPage()
      .replace('body.lock{overflow:hidden}', 'body.lock,body.popup-lock{overflow:hidden}')
      .replace('<body>', '<body class="popup-lock">')
      .replace('<main>', '<div class="welcome-popup" role="dialog" aria-label="Chào mừng" style="position:fixed;left:50%;top:60%;width:300px;height:160px;margin-left:-150px;background:#fff;border:1px solid #999;z-index:50;padding:12px;box-sizing:border-box">Đăng ký nhận tin</div><main>')
      .replace('</script>', "document.addEventListener('click', (e) => { const p = document.querySelector('.welcome-popup'); if (p && !p.contains(e.target)) { p.remove(); document.body.classList.remove('popup-lock'); } }, true);</script>"),
    expect: { triggers: 1, status: { 0: 'PASS' }, panelMatches: { 0: '#panel' }, noCodes: { 0: ['BODY_NOT_RESTORED', 'STATE_STUCK_OPEN', 'OVERLAY_NOT_OPENED'] } },
  },
  {
    // Live Haravan pattern: the backdrop is a full-screen <button class="overplay-all">.
    id: 'button-backdrop-closes-the-drawer',
    html: overlayPage().replace('<div class="backdrop" id="backdrop"></div>', '<button class="backdrop overplay-all" id="backdrop" aria-label="Đóng giỏ hàng" style="border:0;padding:0"></button>'),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['CLOSE_BACKDROP_FAILED'] } },
  },
  {
    // A full-screen layer whose surface is product buttons: geometry says "backdrop", but the
    // point lands on a control inside it, which must never be clicked.
    id: 'product-inside-a-full-screen-layer-is-never-clicked',
    html: overlayPage({ backdrop: false }).replace('<div class="backdrop" id="backdrop"></div>', `<div class="backdrop" id="backdrop" style="background:#fff"><div style="display:flex;flex-wrap:wrap;width:100%;height:100%">${Array.from({ length: 4 }, (_, i) => `<button class="tile" style="flex:0 0 50%;height:50%;border:0;background:#f4f4f4" onclick="document.body.dataset.added=String(Number(document.body.dataset.added||0)+1)">Sản phẩm ${i + 1}</button>`).join('')}</div></div>`),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['STATE_STUCK_OPEN', 'CLOSE_BACKDROP_FAILED'] }, closeSkipped: { 0: { backdrop: 'POINT_UNSAFE: INTERACTIVE_TARGET' } }, bodyUntouched: 'added' },
  },
  {
    // Bootstrap modal as Haravan themes ship it: a full-viewport ".modal" wrapper (data-target)
    // around a smaller ".modal-dialog"; a click on the wrapper outside the dialog dismisses it.
    id: 'full-viewport-modal-wrapper-is-its-own-backdrop',
    html: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}
.modal{position:fixed;inset:0;z-index:1050;display:none;overflow-y:auto;background:rgba(0,0,0,.4);transform:none;width:auto;max-width:none;min-height:0;padding:0;box-shadow:none}
.modal.show{display:block}
.modal-dialog{position:relative;width:320px;max-width:84vw;margin:120px auto;background:#fff;padding:16px;box-sizing:border-box;min-height:220px}
</style></head><body class="">
<header><strong>Shop</strong><button class="btn pc-hd__tool--account" type="button" data-toggle="modal" data-target="#accountModal" aria-label="Đăng nhập">Tài khoản</button></header>
<main><p>Nội dung.</p></main>
<div class="modal fade pc-account-modal" id="accountModal" tabindex="-1" role="dialog"><div class="modal-dialog" role="document">
<button class="close" aria-label="Đóng">×</button><h2 style="margin:0 0 12px">Đăng nhập</h2><p>Email và mật khẩu.</p></div></div>
<script>
  const btn = document.querySelector('.pc-hd__tool--account');
  const modal = document.getElementById('accountModal');
  function open() { modal.classList.add('show'); document.body.classList.add('lock'); modal.querySelector('.close').focus(); }
  function shut() { modal.classList.remove('show'); document.body.classList.remove('lock'); btn.focus(); }
  btn.addEventListener('click', open);
  modal.querySelector('.close').addEventListener('click', shut);
  modal.addEventListener('click', (e) => { if (e.target === modal) shut(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('show')) shut(); });
</script></body></html>`,
    expect: { triggers: 1, status: { 0: 'PASS' }, panelMatches: { 0: '#accountModal' }, closeClosed: { 0: ['backdrop'] }, noCodes: { 0: ['CLOSE_BACKDROP_FAILED'] } },
  },
  {
    id: 'add-to-cart-is-never-a-trigger',
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>
<form action="/cart/add" method="post"><button class="btn add-to-cart" type="button" aria-controls="mini" aria-haspopup="dialog">Thêm vào giỏ</button></form>
<div id="mini" class="drawer" role="dialog"></div><main></main></body></html>`,
    expect: { triggers: 0, skipped: ['UNSAFE_TRIGGER'] },
  },
  {
    // Mirrors a live Haravan theme: a notification popup is already open, the cart button has no
    // ARIA wiring (JS click handler only), and an add-to-cart button is only identifiable by text.
    id: 'aria-less-cart-with-resident-popup',
    html: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${BASE_CSS}
.popup-noti{position:fixed;left:16px;bottom:16px;width:300px;height:200px;background:#fff;border:1px solid #ccc;z-index:60;padding:12px;box-sizing:border-box}
</style></head><body>
<header><strong>Shop</strong><button class="btn sticky-atc">Thêm vào giỏ hàng</button><button class="btn pc-hd__tool pc-hd__tool--cart">Giỏ hàng</button></header>
<main><button class="btn product-buy" data-variant="123">Thêm Laptop vào giỏ hàng</button></main>
<div class="popup-noti" role="dialog" aria-label="Thông báo"><p>Khách hàng vừa mua sản phẩm</p></div>
<div class="backdrop" id="backdrop"></div>
<aside class="shop-cart-sidebar drawer" role="dialog" aria-label="Giỏ hàng"><button class="close drawer__close" aria-label="Đóng">×</button><h2>Giỏ hàng</h2><p>Chưa có sản phẩm.</p></aside>
<script>
  const btn = document.querySelector('.pc-hd__tool--cart');
  const panel = document.querySelector('.shop-cart-sidebar');
  const backdrop = document.getElementById('backdrop');
  const close = panel.querySelector('.close');
  let added = 0;
  document.querySelectorAll('.product-buy, .sticky-atc').forEach((b) => b.addEventListener('click', () => { added++; document.body.dataset.added = String(added); }));
  function open() { panel.classList.add('is-open'); backdrop.classList.add('is-open'); document.body.classList.add('lock'); close.focus(); }
  function shut() { panel.classList.remove('is-open'); backdrop.classList.remove('is-open'); document.body.classList.remove('lock'); btn.focus(); }
  btn.addEventListener('click', () => (panel.classList.contains('is-open') ? shut() : open()));
  close.addEventListener('click', shut);
  backdrop.addEventListener('click', shut);
</script><main style="min-height:1200px"></main></body></html>`,
    // Escape is not wired (like the live theme): the drawer, not the resident popup, must be measured.
    expect: { triggers: 1, status: { 0: 'FAIL' }, codes: { 0: ['CLOSE_ESCAPE_FAILED'] }, noCodes: { 0: ['STATE_STUCK_OPEN', 'CLOSE_CONTROL_MISSING', 'OVERLAY_NOT_OPENED'] }, skipped: ['UNSAFE_TRIGGER'], panelMatches: { 0: 'shop-cart-sidebar' }, bodyUntouched: 'added' },
  },
  {
    id: 'hover-dropdown-closes-on-pointer-leave',
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
nav ul{list-style:none;margin:0;padding:0;display:flex;gap:16px}
nav li{position:relative}
nav li > a{display:inline-flex;min-height:48px;align-items:center;padding:0 12px;color:#111}
.sub{position:absolute;top:100%;left:0;min-width:220px;min-height:120px;background:#fff;border:1px solid #ccc;display:none;z-index:50;padding:8px}
nav li:hover .sub{display:block}
</style></head><body><header><nav><ul><li><a href="#" aria-haspopup="true" class="has-dropdown">Danh mục</a><div class="sub dropdown" role="menu"><a href="#a" style="display:block;min-height:44px;color:#111">Laptop</a><a href="#b" style="display:block;min-height:44px;color:#111">Màn hình</a></div></li></ul></nav></header><main></main></body></html>`,
    expect: { triggers: 1, noCodes: { 0: ['STATE_STUCK_OPEN', 'OVERLAY_NOT_OPENED'] } },
  },
  {
    // Mirrors S2 Sky Fashion: the trigger holds its own ".megamenu__label", the panel opens on a
    // JS hover class, and a sale popup slides in on a timer once the pointer first moves.
    id: 'megamenu-with-label-span-and-timed-popup',
    html: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${BASE_CSS}
nav ul{list-style:none;margin:0;padding:0;display:flex;gap:16px}
.megamenu__item > a{display:inline-flex;min-height:48px;align-items:center;padding:0 12px;color:#111}
.megamenu__panel{position:absolute;left:0;right:0;top:48px;min-height:240px;background:#fff;border-top:1px solid #ccc;padding:16px;opacity:0;visibility:hidden;z-index:50}
.megamenu__item.is-open .megamenu__panel{opacity:1;visibility:visible}
.sale-popup{position:fixed;left:16px;bottom:16px;width:320px;height:300px;background:#fff;border:1px solid #ccc;z-index:70;padding:12px;display:none}
.sale-popup.is-visible{display:block}
</style></head><body><header style="position:relative"><nav><ul class="megamenu__list"><li class="megamenu__item megamenu__item--has-mega"><a href="#nu" class="megamenu__link megamenu__trigger" aria-haspopup="true"><span class="megamenu__label">Nữ</span></a><div class="megamenu__panel"><a href="#ao" style="display:block;min-height:44px;color:#111">Áo</a><a href="#quan" style="display:block;min-height:44px;color:#111">Quần</a></div></li></ul></nav></header>
<div class="sale-popup" id="sale-popup"><button class="sale-popup__close" aria-label="Đóng">×</button><p>Flash sale</p></div><main style="min-height:1200px"></main>
<script>
  const item = document.querySelector('.megamenu__item');
  item.addEventListener('mouseenter', () => item.classList.add('is-open'));
  item.addEventListener('mouseleave', () => item.classList.remove('is-open'));
  let armed = false;
  document.addEventListener('mousemove', () => { if (armed) return; armed = true; setTimeout(() => document.getElementById('sale-popup').classList.add('is-visible'), 50); });
</script></body></html>`,
    expect: { triggers: 1, panelMatches: { 0: 'megamenu__panel' }, noCodes: { 0: ['STATE_STUCK_OPEN', 'OVERLAY_NOT_OPENED'] }, closeClosed: { 0: ['pointer-leave'] } },
  },
  {
    // The menu panel sets its headings in the theme's own display face, loaded through @font-face.
    id: 'megamenu-in-the-theme-display-face',
    html: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${BASE_CSS}
@font-face{font-family:"Theme Display";src:local("Georgia")}
nav ul{list-style:none;margin:0;padding:0;display:flex;gap:16px}
.megamenu__item > a{display:inline-flex;min-height:48px;align-items:center;padding:0 12px;color:#111}
.megamenu__panel{position:absolute;left:0;right:0;top:48px;min-height:240px;background:#fff;border-top:1px solid #ccc;padding:16px;display:none;z-index:50}
.megamenu__item:hover .megamenu__panel{display:block}
.megamenu__title{font-family:"Theme Display",serif;font-size:20px;margin:0 0 8px}
</style></head><body><header style="position:relative"><nav><ul><li class="megamenu__item"><a href="#nu" class="megamenu__trigger" aria-haspopup="true">Nữ</a><div class="megamenu__panel"><p class="megamenu__title">Bộ sưu tập mới</p><a href="#ao" style="display:block;min-height:44px;color:#111">Áo</a></div></li></ul></nav></header><main style="min-height:1200px"></main></body></html>`,
    expect: { triggers: 1, panelMatches: { 0: 'megamenu__panel' }, noCodes: { 0: ['MODAL_UNSTYLED', 'STATE_STUCK_OPEN'] } },
  },
  {
    // Mirrors S2 Sky Fashion: the dialog wrapper is named ".sky-modal-overlay" and holds a backdrop
    // button, an unnamed card and an absolutely positioned close button; the card holds an unpadded
    // tab pane named "__panel".
    id: 'dialog-wrapper-named-overlay',
    html: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${BASE_CSS}
.modal-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;transform:none;width:auto;max-width:none;min-height:0;padding:0;background:transparent;box-shadow:none}
.modal-overlay.hidden{display:none}
.modal-backdrop{position:absolute;inset:0;border:0;background:rgba(0,0,0,.45);padding:0}
.modal-card{position:relative;width:360px;max-width:90vw;min-height:240px;background:#fff;padding:24px;box-sizing:border-box}
.modal-close{position:absolute;top:8px;right:8px;width:36px;height:36px;border:1px solid #333;background:#fff;color:#111;font:inherit}
</style></head><body>
<header><strong>Shop</strong><button class="btn header__action" type="button" data-action="open-account-modal" aria-label="Tài khoản">Tài khoản</button></header><main style="min-height:1200px"><p>Nội dung.</p></main>
<div id="account-modal" class="modal-overlay hidden" role="dialog" aria-modal="true"><button class="modal-backdrop" type="button" aria-label="Đóng hộp thoại" data-action="close-modal"></button><div class="modal-card"><button class="modal-close" type="button" aria-label="Đóng">×</button><h2 style="margin:0 0 12px">Đăng nhập</h2><div class="account-modal__panel"><p style="margin:0">Email và mật khẩu.</p></div></div></div>
<script>
  const btn = document.querySelector('[data-action="open-account-modal"]');
  const modal = document.getElementById('account-modal');
  function open() { modal.classList.remove('hidden'); document.body.classList.add('lock'); modal.querySelector('.modal-close').focus(); }
  function shut() { modal.classList.add('hidden'); document.body.classList.remove('lock'); btn.focus(); }
  btn.addEventListener('click', open);
  modal.querySelectorAll('.modal-close, .modal-backdrop').forEach((b) => b.addEventListener('click', shut));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) shut(); });
</script></body></html>`,
    expect: { triggers: 1, panelMatches: { 0: 'account-modal' }, closeClosed: { 0: ['escape', 'close-button', 'backdrop'] }, noCodes: { 0: ['OVERLAY_TOO_SMALL', 'CLOSE_CONTROL_MISSING', 'STATE_STUCK_OPEN', 'MODAL_UNSTYLED'] } },
  },
  {
    // The theme never styled the dialog: serif default font, default blue link, grey native button
    // face and text flush against the unpadded panel edge.
    id: 'modal-with-browser-default-styling',
    html: kit('modal-unstyled-bad'),
    expect: { triggers: 1, status: { 0: 'FAIL' }, codes: { 0: ['MODAL_UNSTYLED'] } },
  },
  {
    id: 'modal-styled-like-the-page',
    html: kit('modal-unstyled-good'),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['MODAL_UNSTYLED'] } },
  },
  {
    // A full-screen scrim button labelled "Đóng" is the backdrop, not the panel's close control.
    id: 'full-screen-scrim-button-is-not-the-close-control',
    html: overlayPage({ closeButton: false }).replace('<div class="backdrop" id="backdrop"></div>', '<button class="backdrop overplay-all" id="backdrop" aria-label="Đóng giỏ hàng" style="border:0;padding:0"></button>'),
    expect: { triggers: 1, codes: { 0: ['CLOSE_CONTROL_MISSING'] }, closeClosed: { 0: ['escape'] } },
  },
  {
    id: 'density-toggles-in-a-toolbar-are-not-openers',
    html: overlayPage().replace('<main><p>Nội dung trang chủ.</p></main>', '<main><div class="search-toolbar"><button type="button" class="btn search-density__btn is-active" aria-pressed="true" aria-label="Hiển thị 3 cột">3</button><button type="button" class="btn search-density__btn" aria-pressed="false" aria-label="Hiển thị 4 cột">4</button></div><p>Nội dung trang chủ.</p></main>'),
    expect: { triggers: 1, status: { 0: 'PASS' }, panelMatches: { 0: '#panel' } },
  },
  {
    id: 'repeated-card-openers-without-a-panel-run-once',
    html: overlayPage().replace('<main><p>Nội dung trang chủ.</p></main>', `<main>${[1, 2, 3].map((n) => `<article class="card"><h3>Áo ${n}</h3><button type="button" class="btn card__tool" data-action="open-quickview" data-handle="ao-${n}" aria-label="Xem nhanh Áo ${n}">Xem</button></article>`).join('')}</main>
<div class="backdrop" id="qv-backdrop"></div>
<div id="qv" class="modal" role="dialog" aria-modal="true" aria-label="Xem nhanh"><button class="close" aria-label="Đóng">×</button><h2 style="margin:0">Xem nhanh</h2><p class="qv-body"></p></div>
<script>
  (() => {
    const modal = document.getElementById('qv');
    const scrim = document.getElementById('qv-backdrop');
    let last = null;
    const shut = () => { modal.classList.remove('is-open'); scrim.classList.remove('is-open'); document.body.classList.remove('lock'); if (last) last.focus(); };
    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-action="open-quickview"]');
      if (opener) { last = opener; modal.querySelector('.qv-body').textContent = opener.dataset.handle; modal.classList.add('is-open'); scrim.classList.add('is-open'); document.body.classList.add('lock'); modal.querySelector('.close').focus(); return; }
      if (e.target.closest('#qv .close') || e.target === scrim) shut();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('is-open')) shut(); });
  })();
</script>`),
    expect: { triggers: 2, status: { 0: 'PASS', 1: 'PASS' }, skipped: ['DUPLICATE_ACTION'] },
  },
];

// Script-driven opening: the dialog appears 700ms after the click (a theme timer or a Bootstrap
// transitionend callback), well after the lane's 250ms settle. It must still be measured open.
{
  const base = module.exports.find((f) => f.id === 'full-viewport-modal-wrapper-is-its-own-backdrop');
  const from = "function open() { modal.classList.add('show'); document.body.classList.add('lock'); modal.querySelector('.close').focus(); }";
  const to = "function open() { document.body.classList.add('lock'); setTimeout(() => { modal.classList.add('show'); modal.querySelector('.close').focus(); }, 700); }";
  if (!base || !base.html.includes(from)) throw new Error('script-driven modal fixture: base markup changed');
  module.exports.push({
    id: 'script-driven-modal-shows-after-a-timer',
    html: base.html.replace(from, to),
    expect: { triggers: 1, status: { 0: 'PASS' }, noCodes: { 0: ['OVERLAY_NOT_OPENED', 'STATE_STUCK_OPEN'] }, closeClosed: { 0: ['escape', 'close-button', 'backdrop'] } },
  });
}
