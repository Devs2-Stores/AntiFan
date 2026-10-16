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
