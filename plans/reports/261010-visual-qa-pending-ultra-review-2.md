# Review lần 2: pending Visual QA geometry upgrade (`ak:code-review --pending --ultra`, 2026-10-10)

**Phạm vi:** working tree chưa commit trên `main` HEAD `920dd0fc`, byte-identical với commit snapshot `a23a96ae` (`git diff --diff-filter=AMRT a23a96ae` rỗng). Diff được review: `git diff 920dd0fc a23a96ae -- . ':!plans'` (engine `src/main/qa/scanners/layout-integrity-engine.ts`, `src/main/qa/theme-qa-workflow.ts`, unit test, lane harness `test/e2e/visual-qa-fixtures-probe.cjs`, fixtures, `scripts/probe-visual-qa-live-sites.cjs`, `package.json`, `scripts/run-test-pipeline.mjs`, docs, CHANGELOG). Số dòng bên dưới là của snapshot `a23a96ae`, cũng là của working tree hiện tại.

**Plan:** `plans/261009-1609-visual-qa-geometry-upgrade/plan.md`.

**Verdict: REQUEST_CHANGES.** 4 lỗi false PASS mức High và 1 lỗi false FAIL mức High trong engine mới, tất cả tái hiện được trên Chromium thật bằng cặp control/bug. Không có lỗi nào làm crash `qa_validate` trong luồng thật.

## Stage 1: tuân thủ spec

Các acceptance có thể đo đều đạt trên snapshot (controller, env sạch):

- `tsc -p ./`: exit 2, chỉ ở `scripts/probes/sapo-boundary-probe.ts` (TS2307 `../../packages/site-clone/dist/index.js` + 2× TS7006): do `dist/` bị gitignore, file không nằm trong diff. Không có lỗi ở file nào được sửa.
- `node --test test/unit/layout-integrity-engine.test.mjs .compiled/test/unit/theme-qa-fail-closed-adjudication.test.js`: 38/38 pass.
- `npm run -s test:visual-qa` (corpus mặc định, 375 + 1440): `SUMMARY pass=50 fail=0`, mọi dòng `restored=true`, chậm nhất `ms=528` (acceptance 4 của plan: ≤ 1200 ms).

Outcome của plan (`plan.md:55-60`) đang bị vi phạm ở hai chỗ. Câu "covered text / covered CTA (anywhere on the page, not only the first viewport)" sai ở U1-U4 và U8. Câu "does not FAIL healthy pages that use ... carousels, ... read-more boxes" sai ở U5 và U6. K1 (sticky subtree dưới viewport đầu, `:698`) và K2 của review trước vẫn còn nguyên.

## Stage 2: findings

| # | Mức | Loại | Vị trí | Tóm tắt |
|---|---|---|---|---|
| U1 | High | false PASS | engine `:676-677`, `:701-703` | Target cao hơn 0.2·vh vắt qua đường nối hai bước cuộn không bao giờ được lấy mẫu |
| U2 | High | false PASS | engine `:719` | Mọi phần tử nằm trong dialog đều được miễn trừ, kể cả khi che CTA trong cùng dialog |
| U3 | High | false PASS | engine `:706`, `:720` | Phần tử che nút trong cùng một slide carousel được miễn trừ |
| U4 | High | false PASS (im lặng) | engine `:191-192` | Animation vô hạn trên ancestor (vd. `body`) tắt toàn bộ detector che phủ cho cả cây con, không ghi truncation |
| U5 | High | false FAIL | engine `:262-281` | Nút "Xem thêm" và gradient nằm *bên trong* khối rút gọn → 4 critical sai |
| U6 | Medium | false FAIL | engine `:260` | Nút disclosure chỉ có icon (`aria-label`) không được nhận diện |
| U8 | Medium | false PASS | engine `:159`, `:169`, `:343`, `:442-452` | Transform tĩnh (`translateX(-50%)`) bị coi là "đang chuyển động" → bỏ qua offscreen/clipping |
| U9 | Low | telemetry | engine `:411` | Lỗi thu thập text run bị gắn nhãn `clipping` |
| U11 | Low | test hygiene | `test/unit/layout-integrity-engine.test.mjs:25-27` | Mỗi lần chạy để lại một thư mục `%TEMP%/antifan-integrity-test-*` |
| U12 | Low | probe | `scripts/probe-visual-qa-live-sites.cjs:119`, `:128-129` | `restored` chỉ so `window.scroll*`, bỏ qua `document.body.scroll*` |
| U14 | Low | robustness | `src/main/qa/theme-qa-workflow.ts:910` | `integrityResult.viewport.width` nằm ngoài try |

Tất cả đều mới trong diff này: `animating`, `CAROUSEL_SLIDE`, `collapsedByDesign`, `isDisclosure`, `isMovingStyle` và `stride` đều không tồn tại trong engine ở `920dd0fc`. Bản base của unit test dùng `node_modules/.tmp-integrity.mjs` chứ không dùng `mkdtemp`.

### U1. Đường nối bước cuộn (High)

```js
// :676-677
const stride = Math.max(1, Math.floor(vh * 0.8));
for (let y = stride; y < maxScroll + stride; y += stride) steps.push(Math.min(y, maxScroll));
// :699-703
const top = tg.fixed ? tg.vis.top : tg.vis.top - got;
const bottom = tg.fixed ? tg.vis.bottom : tg.vis.bottom - got;
if (top < 0 || bottom > vh) {
  if (bottom - top <= vh) continue;
}
```

Ở viewport 375×667, stride là 533. Mỗi cửa sổ là `[533k, 533k+667]`, hai cửa sổ liền kề chỉ chồng nhau 134 px. Một target cao h chỉ được lấy mẫu khi `y mod 533 ≤ 667 − h`. Theo công thức này, target 180 px bị bỏ sót ở khoảng 8% vị trí, 400 px ở khoảng 50%, 667 px ở gần như mọi vị trí. Đây là suy luận từ code `[INFERENCE]`; hai điểm đo bên dưới khớp với nó.

Bằng chứng mới: cùng một banner ảnh 180 px bị che bởi khối đỏ đục.

```
mobile  u1-ctl-img-in-step  PASS crit=1   (top=200, nằm gọn trong bước 0)
mobile  u1-bug-img-on-seam  FAIL crit=0 warn=0 sweep=6 truncated=false   expected one of occlusion at mobile
desktop u1-bug-img-on-seam  info crit=1
```

Phạm vi hẹp hơn mức các candidate tuyên bố: một nút 180 px có nhãn chữ ở cùng vị trí vẫn bị bắt (`u1-bug-cta-on-seam PASS crit=1`), vì text run "Mua ngay" (~20 px) là một target riêng và vừa trong một bước. Lỗ hổng rơi vào control không có text run nhỏ hơn, như banner ảnh, nút chỉ có icon, ô video. Vì vậy controller hạ mức từ Critical (verifier) xuống High.

Hướng sửa: lấy mẫu mọi target có giao với viewport, tại điểm giữa phần nhìn thấy (`cy` ở `:704` đã tính sẵn như vậy). Chỉ `continue` khi `bottom <= 0 || top >= vh`.

### U2. Miễn trừ dialog vô điều kiện (High)

`:719` `if (e.closest(PLATFORM_PREVIEW_CHROME) || e.closest('dialog, [role="dialog"], [aria-modal="true"]')) continue;` không so sánh với dialog chứa target.

```
mobile  u2-ctl-modal-plain   PASS crit=1   (panel fixed, không có role)
mobile  u2-bug-modal-dialog  FAIL crit=0 warn=0 truncated=false   expected one of occlusion at mobile
```

Hướng sửa: chỉ bỏ qua `e` khi dialog của nó khác dialog của `tg.owner` (hoặc target không ở trong dialog nào).

### U3. Miễn trừ carousel cùng slide (High)

`:706` `const inSlide = Boolean(tg.owner.closest(CAROUSEL_SLIDE));`, `:720` `if (inSlide && e.closest(CAROUSEL_SLIDE)) continue;` không so sánh danh tính slide.

```
mobile  u3-ctl-slide-plain   PASS crit=1   (cùng markup, class không phải carousel)
mobile  u3-bug-slide-swiper  FAIL crit=0 warn=0 truncated=false   expected one of occlusion at mobile
```

Hướng sửa: chỉ miễn trừ khi `e.closest(CAROUSEL_SLIDE) !== tg.owner.closest(CAROUSEL_SLIDE)`.

### U4. `animating` lan xuống toàn bộ cây con (High)

`:191` `const animating = memo(false, (el) => animTargets.has(el) || animating(parentOf(el)));`, `:192` `const unsettled = (el) => in3d(el) || animating(el);`. Một animation vô hạn chỉ đổi `background-color` trên `body` đủ để mọi phần tử trên trang thành `unsettled`.

```
mobile  u4-ctl-no-anim          PASS crit=1   (fixture 09 nguyên bản)
mobile  u4-ctl-body-transition  PASS crit=1   (transition khai báo nhưng không chạy: không ảnh hưởng)
mobile  u4-bug-body-anim        FAIL crit=0 warn=0 truncated=false failedDetectors=[]
```

Trang trả về PASS mà không có evidence gap. Hướng sửa: chỉ coi là "unsettled" khi animation đổi hình học (transform, vị trí, kích thước) và nằm ở chính phần tử hoặc container di chuyển gần nhất. Nếu một tỷ lệ lớn target bị bỏ qua vì unsettled, ghi `truncated` kèm lý do.

### U5. Read-more nằm bên trong khối rút gọn (High)

`collapsedByDesign` (`:262-281`) chỉ duyệt anh em liền sau của `a` và của tối đa 2 ancestor (`:272-279`), không tìm trong chính `a`. Lớp gradient của khối cũng bị tính là phần tử che phủ.

```
mobile  u5-bug-readmore-inside FAIL crit=4   control has 4 critical finding(s)
  C clipping: Text "Nhẫn cưới đôi được cá nhân hoá với hì..." line sliced vertically: 12/17px visible by div > div.desc
  C occlusion: Text "Xem" is covered by div > div.desc > div.fade at page y=107
desktop u5-bug-readmore-inside FAIL crit=4
```

Hướng sửa: tìm thêm disclosure trong `a.querySelectorAll(ACTIONABLE)`. Miễn trừ che phủ cho overlay tuyệt đối của chính khối đã được xác định là `collapsedByDesign`.

### U6. Disclosure chỉ có icon (Medium)

`:260` `const isDisclosure = (el) => el.hasAttribute('aria-expanded') || (el.textContent.length <= 40 && DISCLOSURE_TEXT.test(el.textContent));`. Fixture 17 với link "Xem thêm" đổi thành `<button aria-label="Xem thêm"><svg …></button>`:

```
mobile  u6-bug-icon-toggle FAIL crit=1
  C clipping: Text "Xem" is entirely hidden below the bottom edge of div.row > div.col > div.desc-wrap > div.desc, which is too short for its content
desktop u6-bug-icon-toggle PASS crit=0
```

Verifier xếp Low khi chưa có repro. Bằng chứng mới cho thấy đây là false FAIL thật trên trang khỏe, nên controller nâng lên Medium. Hướng sửa: kiểm tra thêm `aria-label` và `title`.

### U8. Transform tĩnh bị coi là chuyển động (Medium)

`:159` `hasRealTransform = (s) => s.transform !== 'none' && s.transform !== IDENTITY`; `:169` `isMovingStyle = (s) => hasRealTransform(s) || …`. Hệ quả: `movingBetween` đưa control vào `parked` (`:343`) và tắt clipping (`:442`, `:449`, `:452`, `:465`). Fixture 20 với `.card{position:relative;left:50%;transform:translateX(-50%)}`:

```
mobile  u8-ctl-offscreen           PASS crit=1   (fixture 20 nguyên bản)
mobile  u8-bug-offscreen-centered  FAIL crit=0 warn=0   expected one of offscreen|clipping at mobile
```

Hướng sửa: chỉ coi transform là "đang chuyển động" khi phần tử nằm trong `animTargets` hoặc có animation/transition đang chạy. Một phép tịnh tiến tĩnh vẫn phải đo bằng rect thật, vốn đã bao gồm transform.

### U9, U11, U12, U14 (Low)

- **U9** `:411`: `detectorFailed('clipping', err)` nằm trong catch của bước thu thập text run (`mark('runs')` ở `:414`). Text run là đầu vào chung của các detector văn bản, kể cả occlusion sweep (`:649`), nên nhãn `clipping` sai. Hệ thống vẫn fail-closed vì đây vẫn là một evidence gap.
- **U11** `test/unit/layout-integrity-engine.test.mjs:25` tạo `fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-integrity-test-'))` mà không có `after()` dọn dẹp. Đo được: `before=0 after=1`, thư mục chứa `layout-integrity-engine.mjs`. Đây là file khác với mục F12 "harness never deletes temp dirs" của audit trước.
- **U12** `scripts/probe-visual-qa-live-sites.cjs:119` và `:128` dùng `'[window.scrollX, window.scrollY]'`, còn lane harness dùng `SCROLL_STATE` có `document.body.scrollLeft/Top`. Trên theme cuộn bằng `body`, `restored` luôn đúng một cách hình thức. Chỉ có bằng chứng từ source.
- **U14** `src/main/qa/theme-qa-workflow.ts:910` `integrityResult?.measured === true ? integrityResult.viewport.width : undefined` nằm ngoài try `:853-880`, và `:858` nhận mọi payload có `findings` là mảng. Script thật chỉ có một chỗ trả `measured: true` (`:785`) và luôn kèm `viewport`, nên lỗi chỉ xảy ra với stub hoặc host cũ trả payload thiếu `viewport`. Hướng sửa: `integrityResult.viewport?.width`.

### Đã loại

- **U7** (lấy mẫu x=0.5 rồi đánh dấu clear): đúng thiết kế. `:732-742` lấy mẫu tại 50%, rồi tại 20% hoặc 80%, và cần ≥ 2 điểm bị che. Một vật che lệch tâm, không phủ điểm 50%, chỉ trúng tối đa một điểm phụ nên vẫn không đủ ngưỡng dù không có early-exit. Early-exit chỉ làm mất đúng trường hợp phủ cả 20% và 80% nhưng hở 50%. Verifier dẫn h04 làm lý do, nhưng h04 (`plan.md:132`, "partial cover by a fixed bar") nói về layer fixed. Lý do đúng là ngưỡng 2/3 điểm có chủ đích.
- **U10** (`probe:visual-qa-live` không có trong `KNOWN_LANES`): đúng là thiếu (`scripts/run-test-pipeline.mjs:64-74` chỉ có `probe:windows-matrix` và `probe:headless-full-page`). Tuy vậy, `docs/operations.md` hướng dẫn chạy trực tiếp `npm run probe:visual-qa-live`, và base `920dd0fc` cũng có `probe:device` ngoài pipeline. Đây là tiền lệ, không phải lỗi.
- **U13** (O(N²) ở detector 6): chưa có repro. Lane đo chậm nhất 528 ms trên 50 trang.
- **U15** (CLS observer ném lỗi): chỉ chạy trong Electron 43 / Chrome 150, vốn hỗ trợ `layout-shift`, và đã nằm trong `try` `:760-778`.

## Kiểm chứng của controller

Corpus ghép cặp 15 mục (control phải giữ nguyên kết quả, bug cho thấy lỗi), chạy bằng lane Chromium thật trên snapshot:

```
for v in $(compgen -v ANTIFAN_); do unset "$v"; done; unset ELECTRON_RUN_AS_NODE
npm run -s test:visual-qa -- --corpus=<repro.cjs> --out=<dir>
SUMMARY pass=22 fail=8 failed=mobile:u2-bug-modal-dialog,mobile:u3-bug-slide-swiper,mobile:u4-bug-body-anim,mobile:u5-bug-readmore-inside,mobile:u1-bug-img-on-seam,mobile:u6-bug-icon-toggle,mobile:u8-bug-offscreen-centered,desktop:u5-bug-readmore-inside
```

Mọi control đều PASS với `crit=1`, nên mỗi lần FAIL ở mục bug là do đúng thuộc tính được thay đổi. Các dòng bug đều `measured=true`, `truncated=false`, `failedDetectors=[]`: engine báo trang đã được đo đầy đủ.

Để tái hiện: tạo worktree tại `a23a96ae`, sửa đường dẫn `require` ở dòng 2 của corpus trong phụ lục, rồi chạy lệnh trên.

## Ultra appendix

- Stage 2: 5 candidate độc lập (code-reviewer), cả 5 dùng được, union 15 mục (U1-U15), được ẩn danh A-E trước khi gửi verifier.
- Finalizer: kongming verifier giữ 11 mục, loại 4 (U7, U10, U13, U15), verdict REQUEST_CHANGES.
- Controller kiểm chứng lại bằng bằng chứng mới. Có ba điều chỉnh: U1 hạ Critical → High (text CTA vẫn bị bắt), U6 nâng Low → Medium (false FAIL tái hiện được), lý do loại U7 được sửa (ngưỡng 2/3 điểm; h04 là trường hợp layer fixed).

```
ultra: union=11/15 single_candidate=8
```

## Phụ lục: corpus tái hiện (nguyên văn `E:/Work/scratch/cr2-controller/repro.cjs`)

```js
// Controller fresh-evidence corpus for the Stage 2 union (paired: -ctl must hold, -bug shows the defect).
const base = require('E:/Work/scratch/cr-pending-261010/test/fixtures/visual-qa/fixtures.cjs');
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
```
