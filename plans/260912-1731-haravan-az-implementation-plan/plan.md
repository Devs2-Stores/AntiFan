# Kế hoạch triển khai Haravan A–Z

**Trạng thái: kế hoạch đã soạn và kiểm tra liên kết; chưa triển khai.** Kiểm tra Node: 11 tài liệu, 0 liên kết nội bộ hỏng. Hai reviewer đã nêu các mâu thuẫn; controller sửa scoring chung Liquid, dependency 08A, settings mode, historical immutability và rollback. Không có build/test ứng dụng hoặc storefront campaign trong bước lập kế hoạch này.
Mục tiêu đầy đủ: tri thức nền tảng Haravan → Universal Base Theme → theme dự án → cải tiến AntiFan Core → kiểm chứng storefront thật → tài liệu vận hành và bàn giao. Không tự loại wiki, accessibility, performance hoặc chức năng thương mại khỏi phạm vi.

## 1. Nguyên tắc và độ tin cậy

- Haravan-only cho đầu ra theme; không phá khả năng Shopify/Sapo của các module AntiFan dùng chung.
- Tách ba đầu ra: HTML/CSS/JS standalone độc lập nền tảng; Base Theme trung tính thương hiệu; Project Theme hiện thực thiết kế của dự án. **Không so Base Theme chưa có styling thương hiệu với Hoplong để đòi pixel parity.**
- Nhãn bằng chứng: `OBSERVED | VERIFIED | DERIVED | INFERRED | UNKNOWN | CONFLICT`. Báo cáo/source không tương đương kiểm chứng runtime.
- Store được ghi nhận: `phukienmaymoc.com`, org `200001207485`; bản staging `1001512581`; main `1001510509` cấm ghi. Phải đọc lại role và binding trước mỗi đợt ghi. Kế hoạch này không cho phép publish, xóa theme hoặc push remote.
- Viewport bắt buộc: 390, 768, 1440 CSS px; 1024 chỉ là coverage bổ sung. Chụp toàn trang sau khi materialize lazy content, không dùng top viewport thay cho full-page.
- Tái sử dụng dữ liệu trước; tạo tối thiểu theo semantic state còn thiếu. Dữ liệu catalog dùng chung toàn store: unpublished theme **không** cô lập sản phẩm/pages khỏi production.
- Tài liệu chính thức > Admin > API > CLI > source theme > storefront theo quy tắc nghiên cứu của chương trình. Corpus là quan sát, không chứng minh tính bất khả dụng của toàn nền tảng.

## 2. Kết luận đã có và giới hạn

| Finding | Bằng chứng | Kết luận được phép |
|---|---|---|
| D1–D2 | `src/main/qa/theme-qa-workflow.ts:725–792` | Unmeasured được `passed:true` và score mặc định 100; chuỗi compliance tự nhận OS 2.0. Cần sửa verdict; không thay bằng một chuỗi tự chứng nhận khác. |
| D3 | `reports/visual-compare-45-cases.json` và campaign report | Artifact pixel ghi 29 PASS/16 REVIEW, headline ghi 45/45. Không có binding đủ để khẳng định cùng run. |
| D4–D5 | detector `:78–88`; `packages/site-clone/src/generators/` | Detector cộng điểm Haravan cho `sections/`; compiler phát `index.json` và schema sections. Đầu ra Haravan phải sửa theo capability contract. |
| D6–D7 | `scripts/verify-all-visual-compare.mjs:190–225` | Chọn số tốt hơn giữa fresh/recorded; bộ đếm có coercion `null < 2`. Đây là lỗi source xác định. |
| D8 | `src/main/browser/theme-source-mapper.ts:222–267,346,386` | Mapper hỗ trợ section và cả render/include. **Không tự thân là bug** trong module đa nền tảng; kiểm tra áp dụng policy Haravan trước khi sửa. |
| D9 | HTTP probe đã chạy; Chromium artifact dùng `preview_theme_id` query | Trong các GET không cookie đã đo, query này giống bare HTML; `themeid` tạo response khác và preview cookie. Không suy ra chính xác theme của browser run lịch sử vì thiếu cookie/identity receipts. |
| D10 | `reports/chromium-verification/chromium-45-cases-results.json` | `docWidth=1905`, footer flag false trên 45 records; content metrics giống nhau theo viewport. Chứng minh overflow được ghi nhận và viewport attestation thiếu; **không chứng minh emulation chưa áp dụng**. |
| D11 | `.canary/state/subset-r2.json:39–120` | Historical allowlist có `-1`. Cần xác định semantics/producer và policy của run; không sửa lịch sử để giả lập fix. |

`settleCapture` hiện được gọi có điều kiện khi method tồn tại; receipt không hoàn chỉnh ném `SETTLE_INCOMPLETE`. `checkAborted` có generation guard. Reuse các primitive hiện hữu; baseline terminal cursor phải lấy **trước mutation**, không lấy ở cuối rồi chờ acknowledgment đã qua.

Chi tiết nghiên cứu: [scout union](../reports/scout-union-260912-1731-haravan-base-theme.md), [platform claims](../reports/platform-claims-verification-260912-1731.md), [adjudication](adjudication-record.md). Các báo cáo nghiên cứu cũ có overclaim; phần hiệu chỉnh trong kế hoạch này là authority cho triển khai, không dùng ranking của agent như bằng chứng đúng.

## 3. Các phase và phụ thuộc

| Phase | Đầu ra | Phụ thuộc |
|---|---|---|
| [00 — Baseline và guards](phase-00-baseline-freeze-and-guards.md) | Inventory read-only, ownership, source-of-truth, safety policy, identity contract | Không |
| [01 — Adjudication](phase-01-fail-closed-adjudication.md) | Missing evidence không thể PASS; receipts sync/settle đúng lifecycle | 00 |
| [02 — Verifier](phase-02-verifier-and-breakpoints.md) | Fresh-only scoring, 390/768/1440, manifest theo run | 00 |
| [03 — Capture identity](phase-03-identity-and-safety-enforcement.md) | Theme attestation, measured viewport, full-page coverage | 00 |
| [04 — Platform policy](phase-04-platform-shape-remediation.md) | Haravan contract đúng, shared platforms không hồi quy | 00 |
| [05 — Compiler cutover](phase-05-generator-clean-cutover.md) | Haravan flat templates/snippets/settings; callers đồng bộ | 04, 08A |
| [06 — Base Theme](phase-06-universal-base-theme-assembly.md) | Foundation không brand, đầy đủ commerce và merchant settings | 05, 08A |
| [08A/08B — Knowledge, Project Theme, quality](phase-08-knowledge-project-quality-and-handoff.md) | 08A: wiki và contract; 08B: project adaptation, quality, vận hành | 08A sau 00; 08B sau 06 |
| [07 — Live verification](phase-07-verification-loop-and-verdicts.md) | Functional + visual campaign trên Project Theme, receipts, terminal verdict | 01,02,03,06,08B |

01–04 có thể song song theo ownership sau 00. 08A khóa knowledge/contract trước 05/06; 08B chờ 06. 07 chờ 08B và các gate kỹ thuật; bàn giao cuối cùng sau 07. Không có vòng phụ thuộc.

## 4. Acceptance gates toàn chương trình

| Gate | Predicate / bằng chứng bắt buộc |
|---|---|
| Verdict integrity | Mỗi required case có valid measurement và receipts mới được PASS. Missing/NaN/infinite/null → INCONCLUSIVE. Tổng PASS bằng số row có verdict PASS. Điểm tổng chỉ diagnostic, không bù một case fail. |
| Freshness | Fresh diff xấu hơn historical vẫn quyết định verdict. Không fallback sang recorded score hoặc PNG của attempt khác. Immutable record riêng từng run; summary dẫn tới chính records đó. |
| Theme identity | Scope đúng store/org/theme, role hiện tại unpublished, approved write binding; attestation từ API theme/asset identity và browser marker đã đối chiếu. Raw HTML hash khác nhau hoặc URL đúng **không đủ**. |
| Query handling | Chỉ sửa query targeting trên storefront document navigation Haravan; giữ cookie `preview_theme_id`, asset/CDN/API/cart URLs và Shopify behavior. Dùng URL/searchParams, không thay chuỗi hàng loạt. |
| Viewport | Ghi actual `innerWidth`, `clientWidth`, visualViewport, DPR và raster dimensions so với requested surface. Overflow là FAIL riêng khi identity hợp lệ. Equal height/text/hash có thể hợp lệ. |
| Capture validity | Hai capture có nguồn/baseline độc lập, provenance/path xác định, successful decode, dimensions hợp lệ, content/landmark expectations. Không lấy threshold entropy/byte size tùy tiện; legitimate identical images được phép PASS. |
| Full-page | Header/main/footer theo template contract, materialization scroll completion và actual document height được ghi. Footer detector phải xác minh markup, không chỉ tin selector cũ. |
| Functional | Product/variant, price/availability, add/update/remove cart, filters/sort/pagination/search, forms, customer flows, blog/article và empty/error states có scenario + expected results. Không tạo order/payment thật. |
| Platform/settings | Capability-based Haravan output; compile/include/setting references resolve. Dual config là quyết định cần Admin round-trip xác minh, không luật suy từ file presence. Giữ F1GENZ scoped rules. |
| Quality | Keyboard/focus/labels/contrast/touch/reduced motion và performance/CWV có method, environment, measured receipts; không tự cấp score. |
| Reference fidelity | Full Project Theme campaign theo route manifest đã duyệt. Ngưỡng pixel <2% là baseline hiện tại, cần lock comparator/masks trước chạy. Reference đổi → INCONCLUSIVE. |
| Data ownership | Reuse inventory; tạo data cần approval riêng vì shared catalog. Ledger chính xác IDs/version tạo trong run. Không xóa theo prefix toàn store; không auto-delete demo data đã duyệt giữ lại. |
| Docs/handoff | Wiki đủ domains của source report; settings guide, commands thật, maintainers, rollback, troubleshooting; links/source dates hợp lệ. |

## 5. Deliverables kế hoạch triển khai

- `specs/base-theme-contract.json` và capability/evidence manifest: **proposed**, chưa tạo trong planning.
- `themes/universal-haravan-base/`: **proposed** reference implementation; Project Theme tách riêng với brand/data binding rõ ràng.
- Bản sửa producer/compiler/scoring và test regression consumer-visible; không chỉnh historical report để đổi PASS.
- Per-run manifests/references/captures/comparison/functional/a11y/performance receipts và summary derive từ đúng run.
- Wiki nền tảng + tài liệu người vận hành + hướng dẫn mở rộng Base Theme + release/rollback checklist.

## 6. Verdict và stop conditions

- `FINAL_PASS`: mọi required gate/case hợp lệ và pass. Tên hiển thị cho người đọc: `FINAL PASS`.
- `FAIL`: có measurement đáng tin và không đạt behavior/fidelity/quality đã khóa; fix đúng owner rồi chạy lại affected cases và final full matrix.
- `INCONCLUSIVE`: identity/reference/capture/sync thiếu hoặc đổi, hay dependency không sẵn có; không biến thành PASS bằng retry lại artifact cũ.
- `SECURITY_ABORT`: attempted unauthorized mutation/publish/destructive operation. Không cấm read-only evidence chỉ vì nó đọc main theme.

Các số lịch sử 8/17/20 và 29/16 không dự đoán pass rate sau sửa. Green run không tự là gian lận; chỉ chấp nhận khi independent receipts đủ.

## 7. Rủi ro, unknowns và rollback

- `UNKNOWN`: Admin precedence settings; exact server acceptance của section paths; semantics sentinel -1; cookie state trong historical captures. Có probe trong phase files, không giả định.
- `UNKNOWN`: cùng những primitive hiện có đã được nối ở paths nào. Dùng LSP references trước thay exported contracts; giữ pure read-only QA path không đòi upload acknowledgment vô lý.
- Rollback source theo change ownership/commit đã tạo; artifact cũ giữ nguyên. Remote rollback chỉ từ verified backup của đúng unpublished theme, cần approval. Không nới gate để phục hồi dashboard xanh.
- Không hardcode ID khách hàng vào Haravan CLI dùng chung; binding allowlist ở campaign/project scope, generic role protection được giữ.
