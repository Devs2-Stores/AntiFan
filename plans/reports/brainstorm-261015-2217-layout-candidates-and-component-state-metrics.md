# Brainstorm tổng hợp: Theme A–Z automation, layout đẹp, thang đo vỡ, 5 candidates

- Ngày: 2026-10-15 · Trạng thái: chờ user chốt các quyết định ở §11 rồi mới lập plan · **Chưa sửa code**
- Gộp: báo cáo candidates + state matrix (cùng file, bản trước) với audit toàn codebase. Đọc kèm `brainstorm-261015-1228-claude-desktop-antifan-integration.md` (track tích hợp Claude Desktop).
- Phương pháp: 4 agent scout song song (catalogue MCP, engine layout, pipeline QA, build/knowledge), mỗi agent đọc 97–125 lần tool có trích file:line; cộng probe live trên theme F1GENZ PC (`f1genz-pc.myharavan.com?themeid=1001506727`) qua MCP antifan từ Claude Desktop.
- Phạm vi đã đọc: `scripts/antifan-omp-mcp.cjs` (155 tool), `src/main/tools/*`, `src/main/qa/**` (đọc hết `layout-integrity-engine.ts` 1.699 dòng), `src/main/verification/*`, `src/shared/theme-checklist.ts` (78 mục), `scripts/lib/theme-checks.mjs`, `packages/site-clone`, `packages/super-core` (`.super-core/core.db` read-only), cùng các MCP khác và probe trong skill `theme-qa-az`.

## 0. TL;DR

1. **QA đang PASS những theme vừa vỡ vừa xấu.** Live trên F1GENZ PC: `theme.qa_validate` trả `verdict: PASS, 0 issue`. Ma trận QA của chính nó thì ghi `INCONCLUSIVE`, chỉ đo được **3/8 chiều, 0/3 viewport**. Cùng lúc đó probe tay tìm ra: Esc không đóng cart drawer, nút chuông nổi đè chữ trên CTA banner, thanh preview đè nút thanh toán trong drawer, thanh freeship nghi thiếu contrast.
2. Nguyên nhân gốc có 6 nhóm (§5): không đo state tương tác; không có metric thẩm mỹ; warning không bao giờ đánh rớt run; checklist 78 mục mà 0 mục được máy kiểm chứng; không có đích (token/reference/rubric); sync, verdict QA và settle không gắn với nhau.
3. **Nguyên liệu có sẵn để tái dùng:** skill `theme-qa-az` đã có `qa-interactive-probes.js` (586 dòng, vòng đời overlay) và `qa-hover-contrast.js` (153 dòng, contrast WCAG) nhưng AntiFan không gọi tới. `trace.interaction` đã nhận ra `DRAWER_EXPANDED`. Super-core có 345 principle về hình ảnh/layout. `style_override` chạy theo từng tab.
4. **Lộ trình 7 pha (§9)**: P0 vệ sinh MCP → P1 thang đo vỡ (state matrix) → P2 thang đo đẹp (metric + token + rubric) → P3 so 5 candidates → P4 khép vòng (sync↔QA↔settle, checklist bằng bằng chứng) → P5 phía build → P6 perf/a11y/SEO + bàn giao. Song song: track Claude Desktop (P1 bind theo cwd, failover, gói hook).
5. Jev vision: **chưa xác nhận** (docs chính thức hôm nay ghi Jev 1.14 Input = Text). Giám khảo mặc định là Claude vision trong session, có adapter để cắm thêm.

## 1. Quyết định của user (Tier 0)

1. Chọn hướng candidates: **5 phương án so cùng lúc**, mục tiêu là layout đẹp nhất khi build theme.
2. Layout hay vỡ ở form, nút, modal, drawer…, thang đo đang thiếu trầm trọng.
3. Yêu cầu: audit sâu toàn codebase và toàn bộ MCP, duyệt từng element, đưa ra cách tự động hoá theme A–Z.

## 2. Bằng chứng live: F1GENZ PC, trang chủ, viewport 949×928

| # | Quan sát | Tool | Ý nghĩa |
|---|---|---|---|
| L1 | `summary.verdict = PASS`, `verification: PASS`, nhưng `qaMatrix.verdict = INCONCLUSIVE`, `measuredDimensions 3/8`, `measuredViewports 0/3`. Chưa đo: visualFidelity, cssModularity, **interactiveOperability**, responsiveParity, **performanceCWV** | `theme.qa_validate` | Lớp trên báo PASS trong khi lớp dưới thừa nhận không đủ bằng chứng |
| L2 | Ở 320px mọi giá trị là `null`, vậy mà `responsive: true` | idem | `checklist.responsive/layout/overflow` mặc định `true` khi chưa đo (`theme-qa-workflow.ts:2209-2211`) |
| L3 | `page_inventory` gom cả drawer, cart sidebar, modal wishlist đang đóng thành "section". `div.pc-home` cao 7.979px chỉ tách được 1 section con | `anti.inspect.page_inventory` | Không dùng được để duyệt từng element; lẫn overlay đóng với section thật |
| L4 | `inspect.snapshot {selector:"header.pc-header"}` trả cả trang (@e68…@e217) | `anti.inspect.snapshot` | Lỗi: filter selector không giới hạn subtree |
| L5 | Click "Giỏ hàng" → `DRAWER_EXPANDED` (aside 420×928, role dialog, body khoá scroll). Mất 7,2s; dump 2 lần bộ biến CSS giống hệt nhau (~15k ký tự) | `anti.trace.interaction` | Nhận ra được state, nhưng **không đo layout bên trong drawer**, không có ảnh, không kiểm tra đóng/focus |
| L6 | **Esc không đóng cart drawer.** Đo 2 lần cách vài giây, body vẫn `open-cart`, `overflow: hidden` | `agent.sequence pressKey` + `inspect.layout` | Vi phạm QAG-23. QA vẫn PASS |
| L7 | Nút X đóng được; scroll-lock được nhả; focus trả về nút giỏ hàng (vision thấy focus ring) | idem + screenshot | Đạt. Nhưng `inspect.layout` vẫn báo rect drawer nằm trong viewport, vì nó **không trả opacity, visibility, transform** |
| L8 | Thanh preview Haravan đè footer của drawer, che CTA thanh toán | screenshot + vision | QA không biết che chrome preview đi, nên đo sai ở môi trường preview |
| L9 | Nút chuông nổi (trái dưới) **đè chữ "TẦN SỐ QUÉT CAO"** trên CTA banner Màn hình | screenshot + vision | Detector occlusion bỏ qua widget nổi hẹp (`layout-integrity-engine.ts:1452,1475,1499-1514`) |
| L10 | Chữ xanh trên nền hồng ở thanh freeship; giá `48,490,000₫` dùng dấu phẩy | vision | Không có tool đo contrast; không có luật định dạng tiền VN |
| L11 | Nút "Xóa" 35,6×32px | `inspect.layout` | Dưới 44×44 (detector chỉ đo dưới 24px, chỉ khi viewport <768) |
| L12 | Step `wait` của `agent.sequence` dùng `waitMs`; schema MCP chỉ khai `items:{type:object}` nên agent đoán sai tên và bị rơi về 100ms | `agent.sequence` | Schema drift (`antifan-omp-mcp.cjs:107`) |
| L13 | Token theme `--pc-*` có hệ thống rõ ràng (màu, bán kính, `--pc-container 1200px`, `--pc-gutter 16px`, font Be Vietnam Pro / Chakra Petch) nhưng lẫn biến Bootstrap thừa (`--blue`, `--indigo`…) | `trace.interaction` cssVariables | Đủ dữ liệu để kiểm tra tuân thủ token; hiện chưa có tool nào làm việc đó |

## 3. Kiểm kê MCP

### 3.1 AntiFan: 155 tool advertise, cộng 83 tool đã đăng ký nhưng không advertise (vẫn gọi được)

| Nhóm | n | Ghi chú |
|---|---|---|
| Nav/tabs | 9 | session cap 10 tab (`browser-control-port.ts:1249,4103`) |
| Viewport/preset | 6 | 51 device preset; alias trùng `set_viewport`/`browser.set-viewport` |
| Input/agent/interaction | 12 | input trusted CDP; sequence tối đa 30 action; **không ép pseudo-state** (`CSS.forcePseudoState` 0 hit); `trace` không có bấm phím |
| Wait/eval | 3 | tối đa 30s; eval cần grant + `--allow-eval` |
| Inspect | 11 | `layout` tối đa 5 node/selector, quảng cáo flex/grid/visibility nhưng không trả; `styles` đầy đủ hơn (có `cssVariables`) |
| Screenshot/visual/export | 9 | **không chụp clip theo element**; compare 1 cặp/lần, ngưỡng 5% toàn cục; `inline:true` mặc định, không giới hạn kích thước |
| Theme QA | 12 | sweep cố định 320/375/768/1024/1440; `batch_matrix` 20 route, không trả ảnh |
| Theme transaction | 6 | lock + R0 + CAS + rollback; settle không gắn verdict QA |
| Cockpit | 8 | `mark` nhận `done=true` không cần bằng chứng |
| Device iOS | 10 | WDA; không hỗ trợ Android |
| Core knowledge | 52 | chạy in-process, offline |
| File/artifact, terminal, telemetry, sheet/spec, storefront | 17 | `file.write` ẩn `expectedSha256`, không có guard settings_data như `write_cas` |

**Drift/bug đã xác minh:** `style_override` (proxy chặn clear-all, `:88-89,2520-2535`); `theme.resolve_element` bỏ qua `ref` (`browser-capabilities.ts:2944-3013`); `inspect.layout` nói nhiều hơn khả năng thật (`browser-control-port.ts:5131-5180`); `agent.sequence` schema không typed (thiếu `focus`, `awaitNetwork`, `dismissModals`); `trace.interaction` thiếu `motionSpec`; `file.write` thiếu `expectedSha256`; map `anti.browser.promote_baseline` chết (`:607`); có 2 bề mặt advertise lệch nhau (proxy vs `src/main/mcp/mcp-tool-list.ts`); live thấy thêm L4, L5 (dump trùng), L12.

**Rủi ro token:** screenshot inline không giới hạn (full-page tới 32 MiB); `inspect.dom` không có selector thì trả nguyên `outerHTML`; `tabs.list all` 55.917 ký tự (favicon `data:` chiếm 32%); `matched_styles` không có trần.

### 3.2 MCP khác trong máy

| Server | Dùng cho theme | Trạng thái |
|---|---|---|
| `chrome-devtools` (`lighthouse_audit`, `performance_*`, `emulate`) | Lighthouse/CWV, thứ AntiFan đang thiếu | Chạy trên Chrome thật của user, không phải tab AntiFan; session này timeout |
| `playwright` | fallback theo AGENTS §3.1 | session này timeout |
| `figma` / `figma-desktop` | reference thiết kế | cần auth / ECONNREFUSED |
| `stitch` (project F1GENZ GenZ) | sinh thiết kế | chỉ scope project đó |
| Skill `theme-qa-az` scripts | `qa-probes.js` 605, `qa-interactive-probes.js` 586, `qa-hover-contrast.js` 153 dòng | Có sẵn, **chưa được AntiFan dùng**. Hiện phải chạy qua `browser.evaluate` (cần grant eval) |
| Skill `pagespeed`, `web-perf`, `haravan-preview-screenshot`, `haravan-settings-schema` | perf, ảnh bàn giao, schema | ngoài AntiFan |

## 4. Ma trận element × đo lường (tóm tắt)

Cột "Tĩnh" = engine đo ở trạng thái nghỉ, sweep 5 width. Cột "State" = đo ở trạng thái tương tác: **toàn bộ là N** vì không caller nào set `checklist.interactions` (`theme-qa-workflow.ts:2238-2241,2570-2577`).

| Element | Tĩnh | State | Gap chính |
|---|---|---|---|
| Header/logo, sticky bar | overlap, sticky-obstruction, scrolled-header | N | logo méo; bar hiện khi cuộn bị loại (`:1173-1181`) |
| Nav desktop + megamenu | panel đóng bị bỏ qua (`:151`) | N | không bao giờ mở hover menu; `nav` bị loại khỏi sibling-gap |
| Menu mobile, filter drawer, mini-cart, quickview, search modal | đóng = "parked" | N | **nội dung khi mở chưa hề được đo** (L6) |
| Hero/slider | slide bị loại (`:72`) | N | chỉ thấy slide 1 |
| Banner grid, product grid | overlap (warning) | N | không đo gutter, căn lề, số cột theo breakpoint, card cao bằng nhau |
| Product card | title-clamp, sibling-gap | N | hàng giá/badge lệch giữa các card; crop ảnh |
| PDP gallery, swatch, giá, ATC, sticky ATC | pending-image, overlap, occlusion | N | đổi variant, zoom, trạng thái loading/disabled/error; sticky ATC hiện sau khi cuộn |
| Form (mọi loại) | label (DOM), value overlay, stacked | N | thông báo lỗi, focus ring; text input bị loại khỏi check touch (`dom-semantics-scanner.ts:165`) |
| Nút | zero-size, offscreen, stacked, <24px (mobile) | N | **không có contrast, không có 44/48px**, nhãn bị cắt |
| Modal/popup, toast | occlusion "trapped" khi ≥90% màn hình | N | modal nhỏ không bao giờ bị coi là trapped |
| Widget nổi | fixed occlusion | N | widget hẹp che chữ bị bỏ qua (L9) |
| Icon/SVG | bị loại (`:480,568`) | N | kích thước, méo viewBox |
| Ảnh | broken, pending, CLS | N | tỷ lệ, kéo giãn, object-fit, background, `<picture>`, dung lượng |
| Typography | wrap-quality (warning) | N | thang cỡ chữ, độ dài dòng; dấu tiếng Việt bị `overflow:hidden` cắt [INFERENCE] |
| Spacing, alignment, màu | edge/sibling (warning) | N | thang spacing, lệch cạnh, **contrast hoàn toàn vắng mặt** |
| Shadow DOM, iframe | không duyệt (`:465,477,563`) | N | widget review/chat vô hình với engine |

Detector hiện có: 8 kind, khoảng 22 nhánh luật. Critical gồm offscreen, overlap text/control, clipping, occlusion, sticky-obstruction, scrolled-header. Warning gồm zero-size, sibling overlap, spacing, wrap, layout-shift. **Warning không bao giờ đánh rớt run** (`theme-qa-workflow.ts:1700-1703,2209`). Có trần ẩn: 10 finding mỗi kind và 50 tổng (`:67,115-119,1637-1640`), không ghi vào `stats`. Ngưỡng tự ghi là "uncalibrated" (`:599-601`). `modular-gates.ts` (LAYOUT_READY/INTERACTION_READY/MOTION_READY) không có caller nào.

Capture/compare: settle tối đa 6s, không chờ animation (`getAnimations` 0 hit); freeze dừng animation giữa chừng (`injected-script-store.ts:137,269`); pixel diff bỏ qua thay đổi cạnh tương phản thấp (`browser-control-port.ts:8920-8977`); pass ở 5–10% mismatch (`:7732`, `theme-qa-workflow.ts:995`).

## 5. Sáu nguyên nhân gốc

| # | Nguyên nhân | Bằng chứng |
|---|---|---|
| R1 | Không đo trạng thái tương tác | §4 cột State; L5–L7; `interactiveOperability` luôn null |
| R2 | Không có metric thẩm mỹ: contrast, tap 44, type scale, line length, spacing scale, căn lề, ảnh | grep 0 hit; L9–L11 |
| R3 | Chính sách: warning không đánh rớt; checklist mặc định true khi chưa đo; verdict trên PASS trong khi matrix INCONCLUSIVE | L1–L2; `theme-qa-workflow.ts:1700,2209-2211` |
| R4 | Checklist 78 mục: **0 mục máy kiểm chứng end-to-end**; 27 mục tự động hoá được bằng primitive sẵn có nhưng chưa nối; 21 mục tương tác đang tự khai; 14 mục thuần phán đoán | `theme-checklist.ts:176-285`; `cockpit-capabilities.ts:385-408` |
| R5 | Không có đích: không có design token (compiler hard-code `#005baa`, container 1280, gap 20); 784 archetype của super-core **không cái nào là thị giác**, và không bước QA nào đọc super-core; `validate_gate` không có kiểm tra thiết kế | build agent §2–4 |
| R6 | Vòng sửa hở: `qa_repair.verify` không chờ sync (PASS có thể là của theme cũ); `settle(VERIFIED)` không gắn verdict QA; mỗi vòng chỉ có 1 phương án; gate chấp nhận token bypass tự khai | `theme-qa-repair-coordinator.ts:173-179`; `theme-mutation-session.ts:284-297`; `theme-qa-gate.ts:135-144,186-190` |

## 6. Kiến trúc mục tiêu: theme A–Z

Phân vai bất biến: **Claude sinh** (Liquid/CSS/phương án), **AntiFan đo** (tất định, có receipt), **Claude vision chấm** theo rubric (chỉ tư vấn), **user quyết** các điểm rủi ro (push, ghi dữ liệu store, chọn phương án).

| Bước | Việc | Tool hiện có | Cần thêm/sửa |
|---|---|---|---|
| 1 Intake | brief, sheet feedback, site mẫu | `anti.sheet.extract`, `reference.capture` | bridge sheet→spec |
| 2 Đích thiết kế | token + rubric + reference | `inspect.styles.cssVariables` | **`anti.design.tokens`** (dump `:root` + kiểm tra tuân thủ), **rubric JSON** (khoảng 50 luật lọc từ 345 principle), reference theo project |
| 3 Khung | base theme / compiler | site-clone ThemeCompiler (Haravan phẳng) | đủ 17 template; IR có `designTokens`; layout đo thật thay cho hằng số |
| 4 Dựng section | Claude viết Liquid; mỗi section quan trọng chạy **5 candidates** | `style_override` | **`anti.layout.compare_candidates`** (§7A), **chụp clip theo element**, ảnh ghép |
| 5 Settings | schema + settings_data | `settings_check`, `write_cas` (có guard) | sinh schema từ section |
| 6 Dữ liệu demo | sản phẩm/trang | script fixture (ghi store live, hard-code) | chỉ chạy khi có duyệt; tham số hoá |
| 7 Sync | `hrv theme watch` (duyệt từng lần) | sync barrier PTY | barrier không cần PTY (track Desktop) |
| 8 QA máy | static + runtime + state + đẹp | `theme-checks.mjs` (37+16 luật), QA workflow | **state matrix (§7B)**, **họ metric chất lượng (§7C)**, mask chrome preview |
| 9 Vòng sửa | sửa → sync → QA → settle | repair coordinator, three-axis stop | verify chờ sync; settle cần QA PASS; sửa bằng candidates |
| 10 Perf/a11y/SEO | LCP/CLS/INP, dung lượng ảnh, focus/keyboard, JSON-LD | CLS witness, dom-semantics | PerformanceObserver LCP/INP + đo dung lượng ảnh; Lighthouse qua skill `pagespeed` |
| 11 Bàn giao | báo cáo + ảnh | `cockpit_report`, skill preview-screenshot | checklist tick bằng bằng chứng; mẫu bàn giao |

## 7. Thiết kế chi tiết các khối mới

### 7A. `anti.layout.compare_candidates` (5 phương án + baseline)

- **Input:** `url|tabId`, `scopeSelector`, `candidates[2..5]: {id,label,css}`, `breakpoints` (mặc định 375/768/1440), `states?` (lấy từ 7B, vd. `cart-drawer:open`), `referenceRef?`, `mode: parallel|sequential`.
- **Chạy:** mở 6 tab nền (nằm trong cap 10 tab của session) → `media.freeze` + mask chrome preview → mỗi tab `style_override` riêng → mỗi breakpoint: set viewport → settle (thêm cổng chờ animation) → **chụp clip element** → integrity scope section + metric 7C + probe 7B nếu có `states` → dựng **3 ảnh ghép** (6 cột có nhãn, render bằng chính Chromium, không thêm dependency) → đóng toàn bộ tab và override.
- **Xếp hạng:** (1) gate cứng: có finding FAIL thì loại; (2) điểm tất định theo 7C, cộng độ lệch reference nếu có; (3) Claude vision chấm rubric trên ảnh ghép, top-2 sát điểm thì so cặp. Adapter để cắm giám khảo ngoài (Clef 27B vision, hoặc Jev nếu có vision), chỉ tư vấn và phải qua gate 200 mẫu VN.
- **Output:** ảnh ghép, bảng điểm, danh sách bị loại kèm bằng chứng, khuyến nghị, `receiptId` (`anti.verification.record_claim`).
- **Tiền đề:** sửa drift `style_override` (clear-all), thêm chụp clip element.
- **Acceptance:** 5 + baseline × 3 breakpoint trên một section thật; chạy 2 lần cùng input thì điểm trùng; phương án cố ý làm vỡ bị loại; 0 file theme bị ghi; 0 tab/override mồ côi; mục tiêu ≤ 60s [INFERENCE, cần đo].

### 7B. `anti.qa.state_matrix` (thang đo vỡ theo state), nối vào `theme.qa_validate`

- **Driver:** port `qa-interactive-probes.js` thành script inject chính chủ (không cần grant eval). Tìm trigger theo heuristic + bảng selector đã biết của Haravan/Sapo/Shopify + danh sách tường minh. Click thật theo QAG-21. Thêm `pressKey` vào trace. Thêm `CSS.forcePseudoState` cho hover/focus. Chờ settle thay vì 100ms cố định (`browser-control-port.ts:5707`).
- **Mỗi overlay:** mở → **chạy integrity engine scope trong overlay** + luật QAG-23 (rect ≥ 200×120, trong viewport, opacity ≥ 0,95, visible, pointer-events, không bị che, backdrop phủ kín, panel cuộn được, khoá scroll) → focus trap QAG-09 → đóng bằng X, backdrop, **Esc** (L6) → nhả scroll, nền bấm được, focus trả về.
- **Form:** mặc định, focus, chữ dài, submit rỗng (invalid), có lỗi. Luật: không tràn ở 320px, input cùng hàng cao bằng nhau, lỗi không đè label, input ≥ 16px trên mobile, nút submit tối đa 2 dòng. Submit thật tạo bản ghi trên store nên **chỉ chạy invalid-submit, hoặc có duyệt**.
- **Nút:** mặc định, hover, focus-visible, disabled, nhãn dài ở 320px. Luật: không bị cắt chữ, icon khác 0×0, tap ≥ 44×44 trên mobile (áp cho cả input, loại phần tử ẩn), nhóm nút cao bằng nhau, focus ring nhìn thấy.
- **Mức:** vỡ = FAIL; không đo được = INCONCLUSIVE. `interactiveOperability` có điểm thật. Các mục QAG-09/21/23 và 21 mục tương tác đang tự khai được tick bằng receipt.
- **Acceptance:** corpus mutant component (drawer bị header che, modal tràn 320, icon 0×0, input 14px, lỗi đè label, Esc không đóng, scroll-lock không nhả) diệt ≥ 90%; 0 false-positive trên fixture sạch; chạy trên F1GENZ PC thì **bắt được L6**.

### 7C. Họ metric chất lượng (thang đo "đẹp"), là detector mới trong `layout-integrity-engine.ts` sau §3a, tái dùng `runs`

| Metric | Cách đo | Nguồn tái dùng |
|---|---|---|
| Contrast WCAG AA | blend alpha theo chuỗi opacity, so nền hiệu dụng | port `qa-hover-contrast.js` |
| Tap target | ≥ 44×44 (mobile), ≥ 24 (WCAG 2.2 tối thiểu) | sửa `dom-semantics-scanner.ts:165,365-386` |
| Thang cỡ chữ / line-height | số cỡ khác nhau trên mỗi trang, tỷ lệ thang | `runs` |
| Độ dài dòng | 45–75 ký tự cho đoạn văn | `runs` |
| Thang spacing | tỷ lệ gap thuộc thang 4/8 hoặc token `--pc-gutter` | sibling-gap |
| Lệch căn lề | cạnh trái các section lệch nhau (bắt buộc ≤ 2px trong cùng container) | rect section |
| Ảnh | tỷ lệ đồng nhất trong grid, kéo giãn, object-fit, dung lượng so với kích thước hiển thị | broken-asset + resource timing |
| Widget nổi | widget hẹp che chữ hoặc CTA (L9) | sửa nhánh occlusion `:1452,1475,1499-1514` |
| Tuân thủ token | màu/radius/spacing không thuộc token theme (L13) | `anti.design.tokens` |
| Dấu tiếng Việt bị cắt | glyph box vs clip box | `runs` + ink box |
| Định dạng tiền VN | thống nhất phân cách hàng nghìn | text runs (L10) |
| Trần ẩn | ghi `truncatedReasons` khi chạm 10/kind hoặc 50 tổng | `push` `:114-122` |

**Chính sách (user quyết, §11-1):** thêm profile `build-strict` để các metric này có ngưỡng FAIL; profile `audit` vẫn giữ ở mức warning như hiện nay.

### 7D. Khép vòng

- `settle(VERIFIED)` bắt buộc có receipt QA PASS cùng `documentGeneration`; `qa_repair.verify` phải chờ sync.
- Verdict tổng = `min(summary, qaMatrix)`, để không còn PASS khi matrix INCONCLUSIVE (L1). `checklist.*` chưa đo thì là `null`, không phải `true`.
- `cockpit_mark` với mục đo được bằng máy thì yêu cầu `receiptId`.
- Bỏ token bypass tự khai cho profile `build-strict`.

### 7E. Vệ sinh MCP (P0, nhỏ và an toàn)

Sửa: L4 (snapshot selector), `inspect.layout` trả opacity/visibility/transform/flex/grid, `trace.interaction` bỏ dump CSS vars trùng (hoặc chỉ trả diff), schema typed cho `agent.sequence`, `style_override` cho phép clear-all, `resolve_element` nhận `ref`, `file.write` có `expectedSha256`, `tabs.list` bỏ favicon `data:`, giới hạn `inspect.dom` và ảnh inline, gỡ map chết, thống nhất 2 bề mặt advertise, quyết định số phận 83 tool ẩn (advertise các tool lease như `artifact.preflight`).

## 8. Phía build và tri thức

- **Token:** thêm `designTokens` vào `ComponentContractIR` (`clone-ir.ts:88`), lấy từ `:root` + computed style. Thay hằng số `haravan-legacy-settings-generator.ts:101-106` và `clone-ir-builder.ts:40-53` bằng giá trị đo được theo breakpoint.
- **Template:** sinh đủ 17 template theo `haravan-target-contract.ts:21-40` (đang thiếu `page.contact` và 7 template `customers/*`).
- **Spec:** bridge `sheet.extract → spec HTML + clone-spec.json`. Gate compile bằng `validate_gate` có thêm luật thiết kế (rubric). Thống nhất tolerance (2% vs 5%).
- **Tri thức:** thêm cột platform cho `principles` (`schema.ts:461`); cách ly principle "sections/" khỏi Haravan (đang mâu thuẫn); rút gọn rubric 50 luật dạng JSON có version; thêm **archetype thị giác** (hero, card, nav, grid, drawer) dạng thư viện component Liquid có biến thể. Đây là nguồn để Claude sinh 5 candidates có chất lượng.
- **Rủi ro:** `create-haravan-page-fixtures.mjs` ghi store live, hard-code org ID và đường dẫn token. Không chạy khi chưa có duyệt.

## 9. Lộ trình

| Pha | Nội dung | Phụ thuộc | Kích cỡ | Acceptance chính |
|---|---|---|---|---|
| P0 | Vệ sinh MCP (7E) + mask chrome preview + verdict = min (7D phần verdict) | – | S | Hết L1, L2, L4, L5-dump, L12; test hồi quy schema |
| P1 | State matrix (7B): driver, overlay, form, nút | P0 | M | Diệt ≥ 90% mutant; bắt được L6 live |
| P2 | Metric chất lượng (7C) + `design.tokens` + rubric JSON + profile `build-strict` | P0 | M–L | Fixture cho từng metric; bắt được L9–L11 live |
| P3 | `compare_candidates` (7A) + chụp clip element + ảnh ghép + receipt | P0; gate dùng P1/P2 khi có | M | Acceptance 7A |
| P4 | Khép vòng (7D) + checklist tick bằng bằng chứng | P1 | S–M | settle không VERIFIED nếu thiếu QA PASS |
| P5 | Phía build (§8) | P2 (rubric/token) | L | 17 template; token đo được; gate compile |
| P6 | Perf/a11y/SEO + bàn giao | P1 | M | LCP/CLS/INP, dung lượng ảnh, JSON-LD Organization/WebSite, keyboard |
| Song song | Track Claude Desktop: P1 bind theo cwd, failover an toàn, gói hook (xem báo cáo 1228) | – | S–M | – |

P1 và P3 có thể chạy song song: file sở hữu khác nhau (`src/main/qa/scanners/` + workflow, so với `src/main/tools/` + capture).

## 10. Rủi ro

- Đổi chính sách warning→FAIL là quyết định của user. Đổi lặng lẽ sẽ làm vỡ CI và các theme cũ (0/39 theme batch-audit đang ok).
- State matrix click thật trên store live: add-to-cart thay đổi giỏ hàng thật, form submit tạo bản ghi. Cần chế độ an toàn (chỉ mở/đóng overlay, invalid-submit) và duyệt cho phần còn lại.
- 6 tab song song tốn RAM [INFERENCE ~1–1,5 GB]; có chế độ sequential cho máy yếu.
- Giám khảo LLM có thể dao động: dùng rubric cố định, so cặp, và ghi receipt; luôn để metric tất định đi trước.
- Engine scan có mutate DOM (`is-scrolled`, cuộn tới 600px) nên theme có observer có thể phản ứng.

## 11. Quyết định cần user

1. **Chính sách:** thêm profile `build-strict` để metric chất lượng có thể FAIL? Có 3 lựa chọn: (a) bật cho theme mới, giữ `audit` cho theme cũ (khuyến nghị); (b) bật cho tất cả; (c) chỉ báo cáo.
2. Phương án candidates chỉ là CSS, hay gồm cả biến thể `settings_data`?
3. Reference cho từng project: site mẫu, Figma (cần sửa auth), hay chỉ chấm theo rubric?
4. State matrix trên store live: chỉ mở/đóng + invalid-submit (khuyến nghị), hay cho phép add-to-cart thật?
5. Thứ tự: theo P0→P1→P2→P3, hay đẩy P3 (candidates) lên song song ngay sau P0?

## 12. Câu hỏi mở

- Nguồn tin "Jev có vision"? `docs.typesafe.ai/models.md` (15/10) ghi Jev 1.14 Input = Text.
- U1–U8 (pending review 261010) và F1 cần chạy lại fixture để xác nhận (code đã có fail-closed cho F1).
- Kích thước output của `theme.qa_validate` và `debug_bundle` chưa đo (lần probe live: vài KB JSON + artifact ra file).
- Bề mặt advertise nào là chuẩn: proxy hay `mcp-tool-list.ts`?
- Tab agent `2d261d78` (F1GENZ PC) vẫn đang mở storefront; giỏ hàng không bị thay đổi.
