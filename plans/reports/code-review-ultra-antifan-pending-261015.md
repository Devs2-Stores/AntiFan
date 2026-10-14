# Code review (ultra) + Full E2E: pending theme-workflow changes

**Ngày:** 2026-10-15 · **Base:** `HEAD 045f6d72` · **Phạm vi:** 34 file tracked sửa đổi + `test/main/tree-walker-sanitizer.test.ts` (vòng sửa theo `plans/reports/problem-solving-ultra-antifan-fix-bundle-261014.md`).
**Chế độ:** `ak:code-review --pending --ultra` (5 reviewer `scout` cùng tier, 1 verifier `kongming`, union finalizer) → `ak:test` Full E2E → `ak:ship`.

## Kết quả review

Verifier giữ 17 finding (4 P1, 11 P2, 2 P3), loại 4. Cả 17 đã sửa trong cùng vòng, mỗi finding có test hồi quy.

| ID | Mức | Vấn đề | Sửa |
|---|---|---|---|
| F-01 | P1 | `BrokenAssetScanner` báo giả ảnh chỉ có `srcset`, ảnh lazy đã nạp qua `currentSrc`, slide ngoài viewport ngang, ảnh `visibility:hidden` | `srcset`/`currentSrc` là nguồn thật; kiểm `naturalWidth`, biên ngang, `visibility` |
| F-02 | P1 | Edit-guard: retry ghi `settings_data.json` sau `REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP` không bắt đọc lại | Chặn tới khi đọc lại; sao lưu bản trước fetch vào `.antifan/edit-guard/`; so sánh chuẩn hoá BOM/CRLF/JSON |
| F-03 | P1 | Picker gắn `liquid-section` nên `AnnotationManager` bỏ qua `ThemeSourceMapper` trên section thật | Mapper chạy khi hint không có file; picker gửi `attributes` (`id`/`class`/`data-*`) |
| F-04 | P1 | `settings_check`: bỏ `.bwt` Sapo, không báo schema Haravan hỏng, `SETTING_UNDECLARED` thiếu `file` | `theme-checks.mjs` quét `.bwt`; Haravan chạy `validateThemeSchemas`; finding có `file` |
| F-05 | P2 | `await_sync_and_reload` đọc terminal của agent khác | Qua `assertTerminalOwnership` → `TERMINAL_FORBIDDEN` |
| F-06 | P2 | `cockpit_scan` bỏ qua `url` khi thiếu `page` | Route theo `url` cùng origin |
| F-07 | P2 | `responsive_matrix` trùng id khi 2 breakpoint cùng width | Id riêng; width ngoài 240–3840 bị từ chối |
| F-08 | P2 | `file.write` lộ `activeSessionId` của project khác | Chỉ lộ cho đúng chủ phiên |
| F-09 | P2 | Phiên mồ côi ở workspace cha khoá vĩnh viễn project con | `rollback`/`resolve_hold` từ workspace chồng lấn xoá được phiên mồ côi |
| F-10 | P2 | Nhắc nhở QA gate không cắt 5 finding; nhánh bypass không xoá pending | Cắt 5 kèm tổng số; bypass xoá pending |
| F-11 | P2 | Turn-end scoped đọc receipt cũ hơn lần sửa | Lọc `rec.time >= editTs`; nhãn đúng chế độ |
| F-12 | P2 | `write_cas` probe shop identity trước khi kiểm chủ; `settings_check` không neo root người gọi | `assertSessionOwner` trước probe; root tương đối tính từ workspace người gọi |
| F-13 | P2 | Chip `fast`/`direct` không tag sinh chỉ thị mâu thuẫn | Chip được coi là cho phép sửa tường minh |
| F-14 | P2 | Gợi ý file khi chỉ khớp tên thẻ/render edge | Không promote; ghi "No single owner file" |
| F-15 | P2 | `normalizeThrown` đè `ErrorEvent.message`, gắn nhãn `Event` cho object có `.type` | Chỉ `Event` thật; giữ `message`; timeout kèm 80 ký tự biểu thức |
| F-16 | P3 | Test không khôi phục singleton, import jsdom tĩnh, rò thư mục tạm | Khôi phục trong `finally`; dùng `loadJsdom()`; dọn tmp |
| F-17 | P3 | Nhánh `isSimulatedPageUrl` chỉ để chiều mock | Xoá nhánh; mock có `window.location` |

Bị loại (đã kiểm bằng nguồn): `specKey` trong `check-mcp-budget-dominance.mjs` là mã có sẵn và schema hiện khớp; remap `WORKSPACE_MISMATCH`→`WORKSPACE_UNBOUND` là hợp đồng có chủ đích; containment junction/UNC đã có test unit; cổng `hasCloneParityMarkers` của `export_clean` là chủ đích.

Sửa thêm ở controller: test mới của picker thiếu terminal nhận (nút Send bị vô hiệu → treo), jsdom thiếu `CSS.escape` (picker rơi về payload rút gọn), so sánh `attributes` khác realm; ứng viên chỉ khớp thẻ được đánh dấu `ambiguous`.

## Full E2E

| Lần chạy | Kết quả |
|---|---|
| Pipeline đầy đủ trên tree trước review | 4 lane đỏ: `test:main`, `test:e2e:strict`, `smoke:site-mute`, `test:terminal-transport` |
| A/B trên worktree `HEAD` sạch | `test:main`, `test:e2e:strict`, `test:terminal-transport` đỏ sẵn từ `HEAD`; `smoke:site-mute` xanh (flake) |
| Sau khi sửa 3 lane đỏ sẵn | 4 lane xanh |
| Pipeline đầy đủ sau khi sửa 17 finding | 19/20 lane xanh; `test:main` 2517/2518, 1 timeout stdio 10 s ở `omp-mcp-adapter` |
| `omp-mcp-adapter` chạy riêng ×3, rồi lane `test:main` chạy lại | 31/31 ×3; lane xanh |

Nguyên nhân 3 lane đỏ sẵn: `buildTerminalEnv` lấy data root từ tiến trình Main thay vì môi trường được truyền (`test:main`); smoke đọc `content[0]` trong khi proxy đặt khối metadata ArtifactRef trước ảnh từ `dc7f0d42` (`test:e2e:strict`); chứng nhận transport còn chờ banner trong khi `6e445052` đã chuyển sang tự resync (`test:terminal-transport`).

ultra: union=17/21 single_candidate_only=4 · same-tier best-of-5 (verifier `kongming`)
