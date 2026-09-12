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
- `config/settings_schema.json` = `[{}]`, còn `config/settings.html` = 138 KB ⇒ theme dùng cơ chế settings kiểu F1GENZ (legacy HTML), linter phải chạy `--settings-mode f1genz`/`auto` mới đọc đúng.
- **Chưa được thêm vào git**: `15092026/` đang untracked và không nằm trong `.gitignore` gốc. Nếu commit, phải `git add` theo đường dẫn cụ thể — `git add -A` sẽ nuốt cả cây này (12 MB, gồm cả ảnh nhị phân).

## 3. Việc phải sửa khi đổi đích (nếu tái dùng bộ kiểm chứng cũ)

- `scripts/run-haravan-verification-loop.mjs` — các hằng `TARGET_STAGING_THEME_ID=1001512581`, `PROTECTED_LIVE_THEME_ID=1001510509`, `EXPECTED_THEME_ROLE='unpublished'` và `assertStagingContainment()` chỉ cho phép **một** id staging. Với đích mới, guard phải nhận id từ manifest/config và **luôn** từ chối `role === "main"` (đọc vai trò qua `/web/themes.json`, không hardcode id).
- `reports/haravan-project-route-manifest.json` (9 route) + `reports/15-page-data-mapping.json` gắn store/theme cũ.
- `themes/phukienmaymoc-copy/` (53 MB) là bản sao của theme 1001512581.

## 4. Kết luận đã có bằng chứng (dùng lại được cho theme mới)

- 5 vi phạm `HARAVAN_INCLUDE_TARGET_MISSING` ở `themes/phukienmaymoc-copy` **không phải** do pull thiếu: `GET /web/themes/1001512581/assets.json` (617 khoá) xác nhận `snippets/product-loop.liquid`, `snippets/product-loop-no.liquid`, `snippets/product-loop-loadding.liquid` **không tồn tại trên remote**, trong khi `home-collection-tabs.liquid` và `homepage-collection.liquid` có. Hai snippet mồ côi này không được include ở đâu và trang chủ staging không render chúng ⇒ cách xử lý chỉ có: xoá 2 file mồ côi, hoặc ghi nhận ngoại lệ. **Không tạo snippet giả để linter xanh.**
- Lỗi đã sửa và có test đột biến: cổng "chứng thực đồng bộ" từng mặc định `VERIFIED` (fail-open) khi thiếu barrier; và `isUniformImage` chỉ phát hiện khung trắng **xám**, nên cặp khung trắng **có màu** bị chấm `PASS 0.00%`. Bản dùng chung: `scripts/lib/png-raster.mjs`.

## 6. Nếu khôi phục `stash@{0}` để tái dùng bộ kiểm chứng — các lỗ hổng fail-open phải sửa trước

Công việc của phiên trước (vòng kiểm chứng, chứng thực danh tính, png-raster, test PTY…) đã được cất vào `stash@{0}` ("haravan-az-old-target-1001512581"). Nếu pop lại, **không dùng nguyên trạng** — còn 4 chỗ cho phép chứng nhận mà không có bằng chứng:

1. `evaluateVerificationCase`: `hasHeader/hasMain/hasFooter ?? true`, `hoplongLeaks/liquidErrors ?? 0`, và `layout` mặc định bằng chính bề rộng viewport. Hệ quả: evidence tối thiểu `{ mismatchPercentage: 0 }` đạt `PASS` cả bốn cổng; 27 mục như vậy ⇒ `FINAL_PASS`. Sửa: thiếu `layout`/`landmarks`/`functional` ⇒ `INCONCLUSIVE` (nêu tên trường thiếu), không suy diễn mặc định.
2. `performApprovedTeardown` khi không truyền `entityDeleter`: mọi id được ghi như đã xoá và trả `clean: true` ⇒ biên bản `CLEAN` cho một lần dọn chưa từng xảy ra. Sửa: danh sách id không rỗng mà thiếu deleter ⇒ `UNVERIFIED`/không sạch.
3. Dây nối danh tính trong `runVerificationLoop` **tự sinh** `assetCdnUrls` từ chính manifest (`https://cdn.hstatic.net/themes/<orgId>/<themeId>/assets/theme.css`) — URL chưa từng được tải, khớp do được dựng ra ⇒ yếu tố CDN tautology. Sửa: trích `cdn.hstatic.net/themes/<orgId>/<themeId>/` từ **bytes thật** của tài liệu đã tải (probe đang chỉ giữ `sha256`/`bytes`, cần giữ thêm bằng chứng trích ra), rồi so với kỳ vọng.
4. `adjudicateVerificationCase` trong module chứng thực dùng `if (x && !x.verified)` nên khi tham số là `null` thì cổng bị **bỏ qua** và vẫn có thể ra `VERIFIED_PASS`. Sửa: thiếu bằng chứng ⇒ `INCONCLUSIVE`, chỉ được bỏ cổng khi có tín hiệu "không áp dụng" tường minh (module đã có `applicable: false` cho URL không phải storefront).

Hai điểm còn lại cần quyết khi tái dùng:

- Vai trò theme **đo được** qua `GET /web/themes.json` (`role`: `main`/`unpublished`) ⇒ nên truyền vào như bằng chứng quan sát, thay vì để người gọi tự khai (`manifest.store.themeRole`) hoặc hardcode. Guard containment phải từ chối mọi `role === "main"` và nhận id đích từ manifest, không hardcode `1001512581`.
- `scripts/fetch-haravan-theme-safe.mjs:8` hardcode đường dẫn cấu hình CLI cá nhân (repo PUBLIC) ⇒ đọc `HARAVAN_CLI_CONFIG` với mặc định tương đương; đồng thời hàm này đang `failCount++` rồi vẫn in `[DONE]` và thoát 0, không lưu danh sách key lỗi ⇒ bản sao local có thể thiếu file mà không ai biết. Ghi lại key lỗi và thoát khác 0.
- `.canary/tools/lib-png.mjs` vẫn giữ decoder PNG riêng (có hỗ trợ palette, ném lỗi thay vì trả `null`) — hợp nhất vào `scripts/lib/png-raster.mjs` chỉ khi chấp nhận đổi hành vi đó.

## 7. Chặn hạ tầng đang có

- Cầu MCP của AntiFan Desktop trả `REVISION_STALE` (authority revision không còn hiệu lực) và autoheal thất bại ⇒ mọi lệnh chụp/đo DOM trên storefront đều không chạy được cho tới khi app được khởi động lại để cấp revision mới. `scripts/verify-storefront-chromium*.mjs` và vòng kiểm chứng phụ thuộc cầu này.
- Chưa có quyền ghi/push theme (kế hoạch cũ ghi rõ ở `plan.md:11`); không có pha ghi thì không có chứng thực đồng bộ ⇒ vòng kiểm chứng dừng ở `INCONCLUSIVE` theo đúng luật fail-closed.
