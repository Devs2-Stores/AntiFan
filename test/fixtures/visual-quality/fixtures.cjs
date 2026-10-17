'use strict';
// Corpus for src/main/qa/scanners/visual-quality-scanner.ts, run by
// test/e2e/visual-quality-fixtures-probe.cjs at 375x667 (mobile) and 1440x900 (desktop).
//
// expect.rules:   every listed ruleId must be reported on expect.viewports (default: both).
// scanner:        'image-frame' runs src/main/qa/scanners/image-frame-scanner.ts instead of the visual-quality scanner.
// thresholds:     true uses thresholds.json; an object is merged over it (for example a titleScale range).
// expect.absent:  none of these ruleIds may be reported on any viewport.
// expect.control: no finding at all on any viewport.
// expect.absentBy: { <viewport>: [ruleIds] } that viewport must not report.
// expect.indeterminateAtLeast: stats.contrastIndeterminate floor (text over imagery).

const page = (body, head = '') => `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;font:16px/1.5 Arial,sans-serif;color:#111;background:#fff}${head}</style></head>
<body>${body}</body></html>`;

// 2x2 PNG used as a photographic backdrop.
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPhfz8DAwMDAxMDAAAAWBAIBAo5o2gAAAABJRU5ErkJggg==';

// Page content shared with the layout-integrity corpus (test/fixtures/visual-qa/kit).
const kit = (name) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'visual-qa', 'kit', `${name}.html`), 'utf8');
// Fixtures flagged `thresholds: true` are scanned with test/fixtures/visual-quality/thresholds.json.
const OPEN_PANEL = '<script>document.querySelector("[data-action=open-panel]").click()</script>';

module.exports = [
  {
    id: 'contrast-low-gray-text',
    html: page('<main style="padding:24px"><p style="color:#b5b5b5">Phí vận chuyển và thuế được xác nhận tại bước thanh toán.</p></main>'),
    expect: { rules: ['contrast-low'] },
  },
  {
    id: 'contrast-freeship-green-on-pink',
    html: page('<main style="padding:24px"><div style="background:#fde8e8;padding:12px"><strong style="color:#16a34a;font-size:13px;font-weight:700">Chúc mừng bạn! Đơn hàng đã được miễn phí vận chuyển</strong></div></main>'),
    expect: { rules: ['contrast-low'] },
  },
  {
    id: 'contrast-large-text-uses-3to1',
    // #767676 on white is 4.54:1 (passes normal); #949494 is 3.03:1: fails normal, passes large.
    html: page('<main style="padding:24px"><h1 style="font-size:32px;color:#949494">Tiêu đề lớn</h1></main>'),
    expect: { control: true },
  },
  {
    id: 'contrast-dark-on-white-control',
    html: page('<main style="padding:24px"><h2>Sản phẩm nổi bật</h2><p>Chữ đen trên nền trắng đạt chuẩn tương phản.</p><a href="#x" style="color:#0b57d0">Xem thêm</a></main>'),
    expect: { control: true },
  },
  {
    id: 'contrast-text-over-image-is-indeterminate',
    html: page(`<section style="position:relative;height:320px;overflow:hidden">
  <img src="${IMG}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
  <h2 style="position:absolute;left:24px;bottom:24px;margin:0;color:#fff">BUILD PC &amp; LAPTOP CHÍNH HÃNG</h2>
</section>`),
    expect: { absent: ['contrast-low'], indeterminateAtLeast: 1 },
  },
  {
    id: 'contrast-text-on-gradient-is-indeterminate',
    html: page('<div style="padding:32px;background:linear-gradient(90deg,#000,#fff)"><p style="color:#777">Chữ trên nền gradient</p></div>'),
    expect: { absent: ['contrast-low'], indeterminateAtLeast: 1 },
  },
  {
    // Gradient headline: the glyphs paint the background through a transparent fill.
    id: 'contrast-gradient-clipped-text-is-indeterminate',
    html: page('<main style="padding:24px"><h2 style="font-size:28px;background:linear-gradient(90deg,#e11d48,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent">Siêu sale cuối tuần</h2></main>'),
    expect: { absent: ['contrast-low'], indeterminateAtLeast: 1 },
  },
  {
    // Fill colour wins over color: grey fill on white fails even though color is black.
    id: 'contrast-uses-the-text-fill-colour',
    html: page('<main style="padding:24px"><p style="color:#000;-webkit-text-fill-color:#c4c4c4">Giao hàng miễn phí cho đơn từ 500.000₫</p></main>'),
    expect: { rules: ['contrast-low'] },
  },
  {
    id: 'contrast-text-mid-fade-in-is-indeterminate',
    html: page('<main style="padding:24px"><div class="fx"><p style="color:#4d657a">Bộ sưu tập tuyển chọn • Xuân hè</p></div></main>', '@keyframes fx-in{from{opacity:.2}to{opacity:1}}.fx{animation:fx-in 30s linear both}'),
    expect: { absent: ['contrast-low'], indeterminateAtLeast: 1 },
  },
  {
    id: 'contrast-static-low-opacity-text-is-flagged',
    html: page('<main style="padding:24px"><div style="opacity:.2"><p style="color:#4d657a">Bộ sưu tập tuyển chọn • Xuân hè</p></div></main>'),
    expect: { rules: ['contrast-low'] },
  },
  {
    id: 'contrast-static-low-opacity-under-a-transform-animation-is-flagged',
    html: page('<main style="padding:24px"><div class="mq" style="opacity:.2"><p style="color:#4d657a">Bộ sưu tập tuyển chọn • Xuân hè</p></div></main>', '@keyframes mq-run{from{transform:translateX(0)}to{transform:translateX(-10px)}}.mq{animation:mq-run 4s linear infinite}'),
    expect: { rules: ['contrast-low'] },
  },
  {
    id: 'contrast-disabled-control-exempt',
    html: page('<main style="padding:24px"><button disabled style="color:#c8c8c8;background:#fff;border:1px solid #ddd;min-width:48px;min-height:48px">Hết hàng</button></main>'),
    expect: { control: true },
  },
  {
    id: 'tap-small-icon-button',
    html: page('<header style="display:flex;justify-content:flex-end;padding:16px"><button aria-label="Xóa" style="width:34px;height:32px;border:0;background:#eee">×</button></header>'),
    expect: { rules: ['tap-target-small'], viewports: ['mobile'], absent: ['tap-target-tiny'] },
  },
  {
    id: 'tap-tiny-icon-button',
    html: page('<header style="padding:16px"><button aria-label="Đóng" style="width:16px;height:16px;padding:0;border:0;background:#eee"></button></header>'),
    expect: { rules: ['tap-target-tiny'], viewports: ['mobile'] },
  },
  {
    id: 'tap-small-not-reported-on-desktop',
    html: page('<header style="padding:16px"><a href="#cart" style="display:inline-block;width:30px;height:30px;background:#eee" aria-label="Giỏ hàng"></a></header>'),
    expect: { rules: ['tap-target-small'], viewports: ['mobile'], absentBy: { desktop: ['tap-target-small', 'tap-target-tiny'] } },
  },
  {
    id: 'tap-inline-link-exempt',
    html: page('<main style="padding:24px"><p>Vui lòng đọc <a href="#policy">chính sách đổi trả</a> trước khi đặt hàng để tránh nhầm lẫn khi nhận sản phẩm.</p></main>'),
    expect: { control: true },
  },
  {
    id: 'tap-large-controls-control',
    html: page('<main style="padding:24px;display:flex;gap:12px"><button style="min-width:48px;min-height:48px">Mua</button><a href="#c" style="display:inline-flex;min-width:48px;min-height:48px;align-items:center">Giỏ</a></main>'),
    expect: { control: true },
  },
  {
    id: 'floating-bell-covers-banner-cta',
    html: page(`<section style="position:relative;height:100vh;background:#1b1d22">
  <a href="#monitors" style="position:absolute;left:16px;bottom:72px;display:inline-block;padding:14px 18px;background:#fff;color:#111;font-weight:700">TẦN SỐ QUÉT CAO · XEM NGAY</a>
</section>
<div style="height:600px"></div>
<button aria-label="Thông báo" style="position:fixed;left:12px;bottom:64px;width:48px;height:48px;border:0;background:#c00;color:#fff;z-index:50">!</button>`),
    expect: { rules: ['floating-widget-overlap'] },
  },
  {
    id: 'floating-widget-covers-footer-link-at-end',
    html: page(`<main style="height:1400px;padding:24px"><p>Nội dung</p></main>
<footer style="padding:8px 16px 20px"><a href="#hotline" style="display:inline-block;padding:14px 0">Hotline 1900 1234</a></footer>
<div role="complementary" style="position:fixed;right:auto;left:8px;bottom:8px;width:56px;height:56px;border-radius:50%;background:#0a7;z-index:20"></div>`),
    expect: { rules: ['floating-widget-overlap'] },
  },
  {
    id: 'floating-widget-clear-of-content-control',
    html: page(`<main style="padding:24px 96px 24px 24px;height:1200px"><p>Nội dung có lề phải rộng để bong bóng chat không che chữ.</p></main>
<footer style="padding:24px 96px 120px 24px"><a href="#a" style="display:inline-block;min-height:48px">Liên hệ</a></footer>
<div style="position:fixed;right:16px;bottom:16px;width:56px;height:56px;border-radius:50%;background:#0a7"></div>`),
    expect: { absent: ['floating-widget-overlap'] },
  },
  {
    id: 'floating-modal-dialog-is-not-a-widget',
    html: page(`<main style="padding:24px"><p>Nội dung trang</p></main>
<div role="dialog" aria-modal="true" style="position:fixed;left:16px;top:16px;width:200px;height:120px;background:#fff;border:1px solid #333"><button style="min-width:48px;min-height:48px">Đóng</button></div>`),
    expect: { absent: ['floating-widget-overlap'] },
  },
  {
    id: 'sr-only-text-is-not-graded',
    html: page('<main style="padding:24px"><label for="q" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;color:#fff">Tìm kiếm sản phẩm</label><input id="q" style="min-height:48px;width:240px"></main>'),
    expect: { control: true },
  },
  {
    id: 'off-canvas-drawer-is-not-graded',
    html: page(`<main style="padding:24px"><p>Trang chủ</p></main>
<aside style="position:fixed;top:0;right:0;width:320px;height:100%;background:#fff;transform:translateX(100%)">
  <button aria-label="Đóng" style="width:24px;height:24px;padding:0;border:0;background:#eee"></button>
  <p style="color:#c4c4c4">Giỏ hàng trống</p>
</aside>`),
    expect: { control: true },
  },
  {
    id: 'skip-link-parked-above-page-is-not-graded',
    html: page('<a href="#main" style="position:absolute;left:8px;top:-60px;padding:4px 8px">Bỏ qua đến nội dung chính</a><main id="main" style="padding:24px"><p>Nội dung</p></main>'),
    expect: { control: true },
  },
  {
    id: 'transparent-fixed-wrapper-blocks-clicks',
    html: page(`<section style="position:relative;height:100vh;background:#1b1d22">
  <a href="#cat" style="position:absolute;left:24px;bottom:150px;display:inline-block;padding:14px 18px;background:#fff;color:#111;font-weight:700">MUA SẮM THEO DANH MỤC</a>
</section>
<div style="height:600px"></div>
<div class="popup-noti" style="position:fixed;left:0;bottom:0;width:300px;height:240px;z-index:60">
  <button aria-label="Thông báo" style="position:absolute;left:12px;bottom:12px;width:48px;height:48px;border:0;background:#c00"></button>
</div>`),
    // 300x240 is > 15% of a 375x667 viewport, so on mobile it is not treated as a widget.
    expect: { rules: ['invisible-click-blocker'], viewports: ['desktop'], absent: ['floating-widget-overlap'] },
  },
  {
    id: 'preview-chrome-is-ignored',
    html: page(`<main style="padding:24px;height:900px"><p>Nội dung</p></main>
<footer style="padding:0 16px 16px"><a href="#f" style="display:inline-block;min-height:48px;padding-top:12px">Chính sách</a></footer>
<div id="preview-bar-iframe" style="position:fixed;left:0;bottom:0;width:40%;height:60px;background:#39c"><a href="#rm" style="color:#9cf;font-size:12px">Remove preview</a></div>`),
    expect: { absent: ['floating-widget-overlap', 'contrast-low'] },
  },
  { id: 'font-below-min-bad', thresholds: true, html: kit('min-font-size-bad'), expect: { rules: ['font-below-min'] } },
  { id: 'font-below-min-good', thresholds: true, html: kit('min-font-size-good'), expect: { control: true } },
  { id: 'control-height-band-bad', thresholds: true, html: kit('control-height-band-bad'), expect: { rules: ['control-height-band'], viewports: ['mobile'], absentBy: { desktop: ['control-height-band'] } } },
  { id: 'control-height-band-good', thresholds: true, html: kit('control-height-band-good'), expect: { control: true } },
  { id: 'control-height-band-sibling-mismatch-bad', thresholds: true, html: kit('control-height-band-mismatch-bad'), expect: { rules: ['control-height-band'] } },
  { id: 'wrapped-label-bad', thresholds: true, html: kit('wrapped-label-bad'), expect: { rules: ['wrapped-label'] } },
  { id: 'wrapped-label-good', thresholds: true, html: kit('wrapped-label-good'), expect: { control: true } },
  { id: 'tap-target-hit-area-bad', thresholds: true, html: kit('tap-target-hit-area-bad'), expect: { rules: ['tap-target-tiny'], viewports: ['mobile'], absentBy: { desktop: ['tap-target-tiny', 'tap-target-small'] } } },
  { id: 'tap-target-hit-area-good', thresholds: true, html: kit('tap-target-hit-area-good'), expect: { control: true } },
  { id: 'tap-target-hit-area-crowded', thresholds: true, html: kit('tap-target-hit-area-good').replace('gap:24px', 'gap:4px'), expect: { rules: ['tap-target-small'], viewports: ['mobile'], absent: ['tap-target-tiny'] } },
  { id: 'icon-stroke-mismatch-bad', thresholds: true, html: kit('icon-stroke-bad'), expect: { rules: ['icon-stroke-mismatch'] } },
  { id: 'icon-stroke-mismatch-good', thresholds: true, html: kit('icon-stroke-good'), expect: { control: true } },
  { id: 'overlay-fit-bad', thresholds: true, html: kit('overlay-fit-bad') + OPEN_PANEL, expect: { rules: ['overlay-fit'] } },
  { id: 'overlay-fit-good', thresholds: true, html: kit('overlay-fit-good') + OPEN_PANEL, expect: { control: true } },
  { id: 'title-scale-bad', thresholds: true, html: kit('title-scale-bad'), expect: { rules: ['title-scale'], viewports: ['mobile'], absentBy: { desktop: ['title-scale'] } } },
  { id: 'title-scale-good', thresholds: true, html: kit('title-scale-good'), expect: { control: true } },
  { id: 'title-scale-range-bad', thresholds: { titleScale: { h1: [28, 40], h2: [28, 32], h3: [20, 26], h4: [16, 20] } }, html: kit('title-scale-good'), expect: { rules: ['title-scale'], viewports: ['mobile'], absentBy: { desktop: ['title-scale'] } } },
  { id: 'title-scale-range-good', thresholds: { titleScale: { h1: [28, 40], h2: [20, 28], h3: [18, 22], h4: [16, 18] } }, html: kit('title-scale-good'), expect: { control: true } },
  { id: 'title-scale-chrome-good', thresholds: true, html: kit('title-scale-chrome-good'), expect: { absent: ['title-scale'] } },
  { id: 'title-scale-chrome-range-bad', thresholds: { titleScale: { h1: [28, 40], h2: [20, 28], h3: [18, 22], h4: [16, 18] } }, html: kit('title-scale-chrome-good'), expect: { rules: ['title-scale'], viewports: ['mobile'], absentBy: { desktop: ['title-scale'] } } },
  { id: 'title-scale-section-header-bad', thresholds: true, html: kit('title-scale-section-header-bad'), expect: { rules: ['title-scale'], viewports: ['mobile'] } },
  { id: 'input-height-band-bad', thresholds: true, html: kit('input-height-band-bad'), expect: { rules: ['input-height-band'] } },
  { id: 'input-height-band-good', thresholds: true, html: kit('input-height-band-good'), expect: { control: true } },
  { id: 'input-height-band-custom-band-good', thresholds: { inputHeightBandPx: 16 }, html: kit('input-height-band-bad'), expect: { absent: ['input-height-band'] } },
  { id: 'image-crop-bad', scanner: 'image-frame', html: kit('image-crop-bad'), expect: { rules: ['image-crop'], absent: ['image-low-res'] } },
  { id: 'image-crop-good', scanner: 'image-frame', html: kit('image-crop-good'), expect: { control: true } },
  { id: 'image-low-res-bad', scanner: 'image-frame', html: kit('image-crop-good').replace('width:240px;height:120px', 'width:320px;height:160px'), expect: { rules: ['image-low-res'], absent: ['image-crop'] } },
  { id: 'registry-rules-unmeasured-without-thresholds', html: kit('min-font-size-bad'), expect: { absent: ['font-below-min', 'title-scale', 'input-height-band'], measuredRules: ['contrast-low'], unmeasuredRules: ['font-below-min', 'control-height-band', 'wrapped-label', 'icon-stroke-mismatch', 'overlay-fit', 'title-scale', 'input-height-band'] } },
  { id: 'registry-rules-measured-with-thresholds', thresholds: true, html: kit('page-good'), expect: { control: true, measuredRules: ['contrast-low', 'font-below-min', 'control-height-band', 'wrapped-label', 'icon-stroke-mismatch', 'overlay-fit', 'title-scale', 'input-height-band'] } },
];
