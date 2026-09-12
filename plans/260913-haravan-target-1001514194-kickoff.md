# Kickoff — đích mới theme `1001514194` (org 200001207485, store phukienmaymoc.com)

Ghi lại bằng chứng đã đo read-only ngày 2026-09-13, để session mới bắt đầu từ dữ kiện chứ không phải phỏng đoán.

## 1. Vai trò theme (đo bằng API, không phải suy luận)

```
GET https://apis.haravan.com/web/themes.json   (Bearer token của org 200001207485)
→ 200, 3 theme:
   1001514194 | role: unpublished | Phụ kiện máy móc - 15/09/2026   <-- ĐÍCH MỚI
   1001512581 | role: unpublished | Bản sao chép của clothing       (đích cũ)
   1001510509 | role: main        | Phụ Kiện Máy Móc New Version    (BẢO VỆ - không đụng)
```

Token đọc từ `HARAVAN_CLI_CONFIG` (mặc định `~/.haravan-cli.json`), khoá `["200001207485"].access_token`. Không in token ra log.

## 2. Bản pull ở `15092026/` (gốc repo)

- Bind: `{"org_id":"200001207485","theme_id":"1001514194","theme_name":"Phụ kiện máy móc - 15/09/2026"}`.
- 43 template / 65 snippet / 1 layout / 129 asset; `.haravan-cli_remote.json` 241 mục.
- **Độ trung thực của bản pull (đo 2026-09-13)**: 241/241 khoá khớp; 0 thiếu, 0 thừa. Với **143 tệp văn bản**: không tệp nào lệch kích thước so với `size` remote (0/143) và mẫu sha256 khớp. Với **ảnh nhị phân**: 5 tệp có kích thước local **khác** `size` mà API khai — không phải tệp hỏng, mà là **khác phiên bản CDN**: trang render của theme phát ra `.../hera_index_hero_1_mobile.jpg?v=2` (→ 45.507 byte, sha256 `cd5d8c93…`) trong khi `?v=3` trả 55.681 byte **đúng bằng `size` API khai**. Vì trang render là nguồn sự thật, bản local đang giữ **đúng biến thể được phục vụ**; 5 tệp đó là: `assets/hera_index_hero_1_mobile.jpg` (45.507 vs 55.681), `assets/hera_index_hero_2_mobile.jpg` (98.904 vs 120.262), `assets/shop_coupon_item_image_2.png` (1.653 vs 2.140), `assets/shop_social_sidebar_item_image_1.png` (1.288 vs 1.542), `assets/shop_social_sidebar_item_image_5.png` (4.736 vs 5.091). ⇒ Đừng dùng `size` API làm tiêu chí "đủ/thiếu" cho ảnh; phải đối chiếu với URL mà trang render phát ra.
- **Rác còn lại của CLI pull**: `15092026/.hrv_tmp_pull-<pid>-<ts>/assets/` chứa 6 tệp (5 bản `?v=3` của nhóm trên + 1 tệp **0 byte**) — thư mục tạm, không phải nội dung theme; xoá được.
- `config/settings_schema.json` = `[{}]`, còn `config/settings.html` = 138 KB ⇒ theme dùng cơ chế settings kiểu F1GENZ (legacy HTML), linter phải chạy `--settings-mode f1genz`/`auto` mới đọc đúng.
- **Trạng thái git**: `15092026/` là untracked và **đã được thêm vào `.gitignore`** (dòng `/15092026/`), nên `git add -A` sẽ bỏ qua cây này (12 MB, gồm cả ảnh nhị phân). Muốn commit thì `git add` theo đường dẫn cụ thể.

## 3. Việc phải sửa khi đổi đích (nếu tái dùng bộ kiểm chứng cũ)

- `scripts/run-haravan-verification-loop.mjs` — các hằng `TARGET_STAGING_THEME_ID=1001512581`, `PROTECTED_LIVE_THEME_ID=1001510509`, `EXPECTED_THEME_ROLE='unpublished'` và `assertStagingContainment()` chỉ cho phép **một** id staging. Với đích mới, guard phải nhận id từ manifest/config và **luôn** từ chối `role === "main"` (đọc vai trò qua `/web/themes.json`, không hardcode id).
- `reports/haravan-project-route-manifest.json` (9 route) + `reports/15-page-data-mapping.json` gắn store/theme cũ.
- `themes/phukienmaymoc-copy/` (53 MB) là bản sao của theme 1001512581.
- `scripts/fetch-haravan-theme-safe.mjs` **đã đổi sang tham số môi trường** (2026-09-13): `HARAVAN_ORG_ID`, `HARAVAN_THEME_ID` (mặc định `1001514194`), `HARAVAN_THEME_DIR` (mặc định `themes/haravan-<id>`), `HARAVAN_CLI_CONFIG` (mặc định `~/.haravan-cli.json`). Lỗi từng asset được ghi vào `.haravan-cli_fetch-failures.json` và tiến trình thoát mã 1 (trước đây in `[DONE]` rồi thoát 0). Thêm: **bỏ qua tệp cũ chỉ khi kích thước byte khớp `size` remote** (tệp tải dở cũng có size > 0 nên luật "size > 0 ⇒ skip" cũ che mất lệch nội dung), và in `[INFO]` danh sách tệp lệch `size` API thay vì báo MISMATCH giả. Đã chạy thật vào chính cây: `HARAVAN_THEME_DIR=15092026` → `fetched 5, refreshed 5, skipped 236, failed 0`, exit 0.
- **Nhóm script còn hardcode đích cũ `1001512581`** (quét `scripts/` + `test/`): `audit-theme-templates.mjs` (`themeDir`, `copyThemeId`), `sanitize-theme-snippets.mjs` (`SNIPPETS_DIR`), `deploy-copy-theme.mjs` (`TARGET_THEME_ID`, `THEME_DIR`, guard `!== 1001512581`), `probe-theme-identity.mjs` (ví dụ trong docstring), `verify-storefront-chromium.mjs` + `verify-storefront-chromium-direct.mjs` (15 route `?themeid=1001512581` + `themeId` trong report), `verify-storefront-routes.mjs` (15 route), `test-single-visual-compare.mjs` (`?themeid=`). Trong `test/unit/`: `route-identity-gate`, `theme-fidelity`, `theme-fidelity-run` dùng id cũ làm **fixture** — đó là bản ghi hợp lệ, không phải cấu hình. Hai script `verify-storefront-chromium*.mjs` **đang được sửa trong `stash@{0}`** ⇒ sửa chúng trước khi pop sẽ xung đột.
- **Cảnh báo cho quyết định xoá mirror**: `docs/haravan/routes-and-handles.md:49` và `docs/haravan/data-lifecycle-and-storefront-behavior.md:163` đang **cite `themes/phukienmaymoc-copy/...` làm nguồn kiểm chứng** cho các claim đã đánh `VERIFIED`. Xoá mirror thì các claim đó mất nguồn đối chiếu, và **không thể repoint sang `15092026/`** vì đây là theme khác (nội dung/asset khác) ⇒ phải hạ cấp thành "không kiểm chứng lại được".
- `scripts/deploy-copy-theme.mjs` (đường **ghi**) vẫn hardcode `TARGET_THEME_ID = 1001512581` và `THEME_DIR = themes/phukienmaymoc-copy`. Chưa sửa. Nếu tái dùng cho đích mới: nhận id từ tham số và **từ chối mọi `role === "main"`**; nếu không dùng nữa thì xoá cùng mirror.

## 4. Kết luận đã có bằng chứng (dùng lại được cho theme mới)

- 5 vi phạm `HARAVAN_INCLUDE_TARGET_MISSING` ở `themes/phukienmaymoc-copy` **không phải** do pull thiếu: `GET /web/themes/1001512581/assets.json` (617 khoá) xác nhận `snippets/product-loop.liquid`, `snippets/product-loop-no.liquid`, `snippets/product-loop-loadding.liquid` **không tồn tại trên remote**, trong khi `home-collection-tabs.liquid` và `homepage-collection.liquid` có. Hai snippet mồ côi này không được include ở đâu và trang chủ staging không render chúng ⇒ cách xử lý chỉ có: xoá 2 file mồ côi, hoặc ghi nhận ngoại lệ. **Không tạo snippet giả để linter xanh.**
- Lỗi đã sửa và có test đột biến: cổng "chứng thực đồng bộ" từng mặc định `VERIFIED` (fail-open) khi thiếu barrier; và `isUniformImage` chỉ phát hiện khung trắng **xám**, nên cặp khung trắng **có màu** bị chấm `PASS 0.00%`. Bản dùng chung `scripts/lib/png-raster.mjs` **hiện không có trên cây** (nằm trong `stash@{0}`, file untracked); `scripts/verify-all-visual-compare.mjs` ở HEAD vẫn giữ decoder nội bộ của nó.

## 5. Nếu khôi phục `stash@{0}` để tái dùng bộ kiểm chứng — các lỗ hổng fail-open phải sửa trước

Công việc của phiên trước (vòng kiểm chứng, chứng thực danh tính, `png-raster`, 2 test unit kèm theo, `execution-status.md`) đã được cất vào `stash@{0}` ("haravan-az-old-target-1001512581"); test PTY vẫn nằm trên cây vì nó canh một lỗi đã commit ở `e4511ce`, không gắn với đích cũ. Nếu pop lại, **không dùng nguyên trạng** — còn 4 chỗ cho phép chứng nhận mà không có bằng chứng:

1. `evaluateVerificationCase`: `hasHeader/hasMain/hasFooter ?? true`, `hoplongLeaks/liquidErrors ?? 0`, và `layout` mặc định bằng chính bề rộng viewport. Hệ quả: evidence tối thiểu `{ mismatchPercentage: 0 }` đạt `PASS` cả bốn cổng; 27 mục như vậy ⇒ `FINAL_PASS`. Sửa: thiếu `layout`/`landmarks`/`functional` ⇒ `INCONCLUSIVE` (nêu tên trường thiếu), không suy diễn mặc định.
2. `performApprovedTeardown` khi không truyền `entityDeleter`: mọi id được ghi như đã xoá và trả `clean: true` ⇒ biên bản `CLEAN` cho một lần dọn chưa từng xảy ra. Sửa: danh sách id không rỗng mà thiếu deleter ⇒ `UNVERIFIED`/không sạch.
3. Dây nối danh tính trong `runVerificationLoop` **tự sinh** `assetCdnUrls` từ chính manifest (`https://cdn.hstatic.net/themes/<orgId>/<themeId>/assets/theme.css`) — URL chưa từng được tải, khớp do được dựng ra ⇒ yếu tố CDN tautology. Sửa: trích `cdn.hstatic.net/themes/<orgId>/<themeId>/` từ **bytes thật** của tài liệu đã tải (probe đang chỉ giữ `sha256`/`bytes`, cần giữ thêm bằng chứng trích ra), rồi so với kỳ vọng.
4. `adjudicateVerificationCase` trong module chứng thực dùng `if (x && !x.verified)` nên khi tham số là `null` thì cổng bị **bỏ qua** và vẫn có thể ra `VERIFIED_PASS`. Sửa: thiếu bằng chứng ⇒ `INCONCLUSIVE`, chỉ được bỏ cổng khi có tín hiệu "không áp dụng" tường minh (module đã có `applicable: false` cho URL không phải storefront).

Hai bản ghi output của lần chạy cũ (`reports/storefront-verification-verdict.json`, `reports/fixture-teardown-receipt.json`) đã bị xoá **trước** khi stash và **không** nằm trong `stash@{0}`; chúng là output sinh lại được bằng cách chạy lại vòng kiểm chứng, không phải mã nguồn.

Hai điểm còn lại cần quyết khi tái dùng:

- Vai trò theme **đo được** qua `GET /web/themes.json` (`role`: `main`/`unpublished`) ⇒ nên truyền vào như bằng chứng quan sát, thay vì để người gọi tự khai (`manifest.store.themeRole`) hoặc hardcode. Guard containment phải từ chối mọi `role === "main"` và nhận id đích từ manifest, không hardcode `1001512581`.
- ~~`scripts/fetch-haravan-theme-safe.mjs` hardcode đường dẫn cấu hình CLI cá nhân~~ **đã sửa 2026-09-13** (xem §3): đọc `HARAVAN_CLI_CONFIG`, ghi `.haravan-cli_fetch-failures.json` và thoát mã 1 khi có asset lỗi. Phần còn lại: chưa có test tự động cho script này (đã kiểm bằng chạy thật read-only).
- `.canary/tools/lib-png.mjs` vẫn giữ decoder PNG riêng (có hỗ trợ palette, ném lỗi thay vì trả `null`) — hợp nhất vào `scripts/lib/png-raster.mjs` chỉ khi chấp nhận đổi hành vi đó.

## 6. Chặn hạ tầng đang có

- Cầu MCP của AntiFan Desktop trả `REVISION_STALE` (authority revision không còn hiệu lực) và autoheal thất bại ⇒ mọi lệnh chụp/đo DOM trên storefront đều không chạy được cho tới khi app được khởi động lại để cấp revision mới. `scripts/verify-storefront-chromium*.mjs` và vòng kiểm chứng phụ thuộc cầu này.
- Chưa có quyền ghi/push theme (kế hoạch cũ ghi rõ ở `plan.md:11`); không có pha ghi thì không có chứng thực đồng bộ ⇒ vòng kiểm chứng dừng ở `INCONCLUSIVE` theo đúng luật fail-closed.
