# Rà soát chéo `--ultra` — đợt sửa Base Theme Haravan (12/09/2026)

Phạm vi: `4fb1330..999b86a` (ba commit `54bfa9c`, `7509727`, `999b86a`) cộng phần diff chưa commit ở
`specs/base-theme-contract.json` và `docs/haravan/base-theme-contract.md`.
Gói bằng chứng: `plans/reports/ultra-review-packet-260912-haravan-base-theme.md`.

Cơ chế: 5 ứng viên read-only chạy song song trên cùng một gói bằng chứng (nhãn A–E, ẩn danh), sau đó
1 verifier đối chứng độc lập từng phát hiện với mã nguồn và trả về hợp nhất đã khử trùng lặp. Verifier
KHÔNG sửa file; mọi thay đổi do phiên điều phối áp dụng và tự kiểm chứng lại.

Giới hạn đã biết: verifier chạy trên cùng tầng model với các ứng viên (agent `kongming` của tổ chức không
đăng ký trong runtime này — chỉ có `scout`, `reviewer`, `security-reviewer`, `task`, `sonic`), nên đây là
best-of-5 đồng tầng chứ không phải đối chứng bất đối xứng. Bù lại, người điều phối đã tự đọc lại mã nguồn
cho từng phát hiện trước khi sửa.

## 1. Điểm rubric từng ứng viên (verifier chấm, thang 1–20 × 5 tiêu chí)

| Nhãn | Đúng đắn Liquid | Rủi ro hồi quy | Toàn vẹn bằng chứng | Chất lượng harness | A11y & an toàn nền tảng | Tổng |
| --- | --- | --- | --- | --- | --- | --- |
| A | 19 | 18 | 18 | 20 | 17 | 92 |
| B | 16 | 16 | 19 | 18 | 14 | 83 |
| C | 14 | 17 | 15 | 17 | 16 | 79 |
| D | 18 | 17 | 19 | 16 | 16 | 86 |
| E | 17 | 17 | 18 | 17 | 16 | 85 |

## 2. Hợp nhất đã xác thực (đã áp dụng)

| # | Mức | Vị trí | Bằng chứng | Cách sửa | Nhãn báo |
| --- | --- | --- | --- | --- | --- |
| 1 | Important | `plans/reports/_render-base-theme.mjs` | Fixture cũ còn biến thể 4 nên pass 1 khớp trước; pass 3 không bao giờ chạy, và assertion không kiểm tra `href`. Kèm `.slice(0, 0)` rỗng chi tiết lỗi. | `removeVariants: [4]` + `availability: { 2: false }`; thêm `swatch_all_unavailable_targets_real_variant` kiểm `?variant=2`; sửa chi tiết lỗi | A,B |
| 2 | Important | `snippets/footer.liquid` | `div.form-error` + vòng lặp `form.errors.messages[field]`; không có CSS `.form-error` (`theme.css` chỉ có `.form-errors.alert-danger`), lệch `§states.formErrors` và 7 form còn lại | Dùng `div.form-errors.alert.alert-danger[role="alert"]` + `{{ form.errors | default_errors }}`, khối thành công `alert alert-success` | A |
| 3 | Important | `plans/reports/_render-base-theme.mjs` | `footer.liquid` không hề được render dù stub `form` đã đăng ký | Thêm `renderFooter` và 6 kiểm tra (mặc định, thành công, lỗi, không fixture, tắt newsletter, spy form tag) | A,B,C,E |
| 4 | Important | `plans/reports/_render-base-theme.mjs` | Stub `paginate` cứng `pages: 1`, không cắt mảng ⇒ `pagination-default.liquid` bị bỏ qua hoàn toàn | Stub đọc `by`/`per_page`, cắt mảng, dựng `parts`/`previous`/`next`; thêm 7 kiểm tra phân trang | A,C,D,E |
| 5 | Important | `specs/base-theme-contract.json`, `docs/haravan/base-theme-contract.md` | `§states.variantUnavailable` + `SCENARIO_03` đòi nhãn "Không khả dụng" qua `selected_variant == nil`; `product.liquid:1` luôn có `current_variant`, `:122-127` chỉ có hai nhãn | Viết lại theo kiến trúc zero-JS: chip trỏ biến thể thật, combo không tồn tại rơi về biến thể còn hàng, nhãn chỉ có "Hết hàng" | B,D |
| 6 | Minor | `docs/haravan/base-theme-contract.md`, `specs/base-theme-contract.json` | Mục 9 ghi 12 kịch bản trong khi có 13; mục 10 chỉ 5 dòng trong khi JSON định nghĩa 6 | 12 → 13; thêm dòng `UNRESOLVED_06_NEWSLETTER_FORM_MECHANISM` | A,C,D,E |

Thay đổi kèm theo do người điều phối quyết định, cùng hướng với kết luận của verifier:
`ROUTE_LIST_COLLECTIONS.requiredLiquidObjects` bổ sung `paginate` để khớp quy ước của `ROUTE_COLLECTION`,
`ROUTE_SEARCH`, `ROUTE_BLOG` (verifier bác đề nghị gỡ `paginate` khỏi tài liệu), và gỡ hàm chết `hrefs()`.

## 3. Bị bác (không áp dụng)

| Phát hiện | Lý do bác |
| --- | --- |
| `list-collections.liquid` dùng `grid-cols-3` không có media query → chật trên mobile | Mẫu có sẵn toàn theme: `blog.liquid:19`, `index.liquid:81`, `collection.liquid:35`, `product.liquid:147`, và `theme.css:121-125` không có media query cho `.grid-cols-*`. Không do đợt sửa này tạo ra; thêm quy ước lưới thứ hai là trái luật repo. |
| Chip swatch hết hàng chỉ truyền trạng thái qua `title` | Markup này nằm ở commit nền `4fb1330`, không bị diff `4fb1330..999b86a` chạm tới; `theme.css` không có tiện ích `sr-only`/`visually-hidden` để dùng lại. Ghi nhận là tồn đọng, không sửa trong đợt này. |
| Dòng route `/collections` liệt kê `paginate` là mâu thuẫn hợp đồng | Ngược lại: đúng quy ước của mọi route phân trang khác. Sửa theo hướng đồng bộ JSON, không gỡ khỏi tài liệu. |

## 4. Rủi ro còn lại (do verifier bổ sung, chưa xử lý)

- Harness vẫn không dựng lại hành vi Haravan thật: `form`/`paginate` là stub của chính harness, nên nó xác
  nhận cấu trúc và ràng buộc biến, không xác nhận renderer của nền tảng. Chỉ round-trip trên theme staging
  chưa publish `1001512581` mới trả lời được câu hỏi đó (đang chờ quyền push).
- `templates/product.quickview.liquid` và `assets/theme.js` (đường nạp fragment `?view=quickview`) chưa
  được harness chạm tới; cơ chế này vẫn chỉ có bằng chứng corpus + smoke test cũ.

## 5. Xác nhận sau khi sửa

- `node plans/reports/_render-base-theme.mjs` → **37/37** (trước đợt này 19/19).
- Đột biến xác nhận từng kiểm tra mới đều bắt được lỗi thật: đổi `default_errors` → đỏ `footer_newsletter_error_state`;
  đổi `form 'customer'` → đỏ `footer_newsletter_form_mechanism`; ép `(1..2)` → đỏ hai kiểm tra pass 3;
  bỏ `include 'pagination-default'` → đỏ hai kiểm tra nav; thêm prefill `search.terms` → đỏ `notfound_search_not_prefilled`.
  Tất cả tệp được khôi phục nguyên trạng sau khi đột biến (`git diff` không còn dòng nào cho ba tệp đó).
- Lint base theme (auto + legacy) sạch; theme dự án giữ 5 vi phạm `HARAVAN_INCLUDE_TARGET_MISSING` đã biết;
  parity settings 38/38/38; `specs/base-theme-contract.json` parse hợp lệ với 13 kịch bản và 6 mục tồn đọng.

Kết luận verifier: `REQUEST_CHANGES` tại thời điểm rà soát; toàn bộ 6 phát hiện Important/Minor đã được áp dụng
và kiểm chứng lại ở trên.

## 6. Vòng soát advisory sau khi push (đợt sửa tiếp theo)

| Vấn đề | Kết luận | Hành động |
| --- | --- | --- |
| Tài liệu thiếu Kịch bản 13 (advisory) | **Sai** — `docs/haravan/base-theme-contract.md:300` đã có `### Kịch bản 13`, và 13 tiêu đề khớp đúng 13 id trong spec | Không đổi; ghi nhận là advisory lỗi thời |
| Gỡ `paginate` khỏi dòng route (advisory lặp lại) | **Ngược hướng** — đã bổ sung `paginate` vào `ROUTE_LIST_COLLECTIONS` cho khớp quy ước route phân trang | Đã làm ở commit trước |
| "`posted_successfully` = 0 trong corpus" | **Số sai do lệnh đo của tôi**; đo lại: 264 file / 279 lần, và 3 template của chính base theme đã dùng | Không có con số sai nào được ghi vào tài liệu/hợp đồng; lý do sửa footer dựa trên CSS thiếu + `§states.formErrors` + 7 form cùng theme |
| Chuỗi "Không khả dụng" còn sót | **Sai** — 5 lần xuất hiện còn lại đều là câu phủ định ("theme không có trạng thái ...") | Không đổi |
| `color-swatch` là affordance rỗng | **Đúng** — cờ `is_color` chỉ phát ra lớp không có rule nào trong theme | Đã gỡ cờ và lớp khỏi `swatch.liquid` |
| `form-success` không có CSS | **Đã hết** — khối đó bị thay bằng `alert alert-success` ở commit trước | Không còn chuỗi nào trong theme |
| `paginate.current_page` chưa được harness cấp nên nhánh `is-current`/`aria-current` không bao giờ render | **Đúng** — snippet so `part.title == paginate.current_page`, nhưng stub chỉ đặt `current_page` ở cấp ngoài | Stub đặt `current_page` trong drop `paginate`; `pagination-default.liquid` ép kiểu `part.title | times: 1`; kiểm tra mới assert `aria-current="page"`; đột biến bỏ ép kiểu làm harness đỏ |
| `SCENARIO_04` đòi "4 cột desktop, 2 cột mobile" | **Đúng là drift** — `collection.liquid:35` dùng setting và `theme.css:121-125` không có media query nào cho `.grid-cols-*` | Sửa câu chữ theo thực tế đã ship (số cột theo setting ở mọi viewport), không thêm breakpoint mới |
| `SCENARIO_03` nói quá về tồn kho | **Đúng** — pass 2 mới đòi `candidate.available`, pass 3 không điều kiện | Siết lại câu chữ theo đúng thứ tự pass (còn hàng nếu có, ngược lại render "Hết hàng") |
