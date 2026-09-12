# Gói bằng chứng bất biến — Audit suite `ak:test audit --ultra --advice` (12/09/2026)

Mục tiêu: tìm test **nói dối** (deceptive), test bị vô hiệu, test kém hiệu lực, test lỗi thời,
thiếu ca biên, trùng lặp, rò rỉ bí mật trong fixture, và điểm mù của gate — rồi sửa một lần trên
hợp nhất đã được verifier xác thực.

## 1. Trạng thái đóng băng

- Repo `<repo>`, nhánh `main`, HEAD `6fcb9f3` (đã push, cây làm việc sạch).
- Package `antifan-browser-desktop@1.3.6`.
- Ba commit gần nhất đều là sửa base theme Haravan: `6fcb9f3`, `7f0f6b7`, `fee8255`.

## 2. Quy mô suite (đo bằng `fs` walk trên `test/`, `packages/site-clone/src`, `src`, `.canary`)

| Khu vực | Số file | Số dòng |
| --- | --- | --- |
| `test/main` | 129 | 42 034 |
| `test/unit` | 51 | 15 955 |
| `packages/site-clone/src` (+ `src/**/*.test.ts`) | 23 | 9 476 |
| `test/integration` | 5 | 1 445 |
| `test/e2e` | 5 | 711 |
| `test/benchmark` | 2 | 315 |
| `test/workflow-and-artifact-security.test.ts` | 1 | 300 |
| `test/renderer` | 1 | 214 |
| `test/golden-slice-e2e.test.ts` | 1 | 495 |
| `src/main` | 3 | 568 |
| **Tổng** | **221** | **71 513** |

## 3. Telemetry đo tại HEAD (chính xác, không suy diễn)

| Lệnh | Kết quả |
| --- | --- |
| `npm run test:canary` (`.canary` + `test/unit/*.test.mjs`) | tests **227**, pass **221**, fail **6**, skipped 0, todo 0 |
| `npm run test:fast` | tests **491**, pass **491**, fail **0** |
| `npm run test:site-clone` | tests **361**, pass **361**, fail **0** |
| `npm run test:integration` | tests **13**, pass **13**, fail **0** |
| `npm run test:main` | đang chạy khi đóng băng gói; lần đo trước trong ngày tại `999b86a`: **1079/1092**, 12 suite fail (được xác nhận tồn tại từ trước, không do đợt sửa nào) |
| `npm run test:e2e` | chưa chạy được qua gate mặc định (xem §4) |
| `node plans/reports/_render-base-theme.mjs` | **38/38** |
| `node --test test/unit/theme-checks.test.mjs test/unit/lint-haravan-theme.test.mjs` | **47/47** |

Sáu test canary đỏ tại HEAD (tên nguyên văn):

1. `AntiFanMcpClient connects and lists 52 MCP tools` — `AssertionError: tabs must be an array`
2. `desktop telemetry verifies against the desktop bundle when the mobile bundle sorts first` — `generation must succeed, got status 1`
3. `desktop telemetry verifies against the desktop bundle when the desktop bundle sorts first` — `generation must succeed, got status 1`
4. `build-report embedded selfDrift handling` → subtest `does not crash when selfDrift is embedded without an external drift document and exceeds limit`
5. `build-report next action interpolation and gating` → subtest `interpolates real metrics for viewports with compare blockers and does not throw on m.viewport.width`
6. `build-report next action interpolation and gating` → subtest `emits no mobile defect claim in Section 16 when mobile model has no compare blockers`

## 4. Cấu trúc gate (đo được, không suy diễn)

- `.github/` **không tồn tại** — repo không có CI nào; suite chỉ chạy khi có người chạy tay.
- `npm test` = `compile && test:canary && test:fast && test:site-clone && test:integration && test:main && test:e2e`.
  Vì `test:canary` đỏ 6 test, **mọi stage sau nó không bao giờ chạy** trong gate mặc định: đo được
  `npm test` dừng ngay sau `test:canary` (đầu ra kết thúc ở `ℹ fail 6`).
- `npm run verify` = `audit && plans:check && npm test` → cũng dừng ở canary.
- `test:canary` chỉ quét `test/unit/*.test.mjs`; `test:canary` **không** quét `test/main`, `test/e2e`,
  `packages/site-clone`.
- `test:main`, `test:e2e`, `test:integration` phụ thuộc `.compiled/` do `compile` sinh ra, nên chạy
  lẻ các lệnh này mà chưa `compile` sẽ dùng bundle cũ.

## 5. Census test bị vô hiệu (đo trên 221 file)

| Mẫu | Số file | Ghi chú |
| --- | --- | --- |
| `.skip(` | 3 | cả 3 đều có lý do kèm theo (đã đọc, xem §6) |
| `.todo(` | 0 | — |
| `.only(` | 0 | — |
| `xit(` / `xdescribe(` | 0 | — |
| test bị comment-out | 0 | — |
| thân test rỗng `() => {}` | 0 | — |
| `// TODO` | 0 | — |

## 6. Đã loại trừ trước (đừng báo lại nếu không có bằng chứng mới)

- **`process.exit(0)` trong `packages/site-clone/src/platform/haravan/haravan-adapter.test.ts:859`**
  là chuỗi lệnh truyền cho tiến trình con `node -e` để kiểm tra việc bắt exit code — hợp lệ, không
  phải test tự thoát.
- **3 `.skip`** đều hợp lệ theo tiêu chí "có lý do":
  - `test/main/phase-02-agent-plane-authority.test.ts:578` — hoãn sang "Phase 6 Windows runtime certification" (nêu rõ chủ sở hữu).
  - `test/main/windows-acl.test.ts:253` — theo nền tảng (`process.platform !== 'win32'`); trên Windows test chạy thật.
  - `test/unit/canary-evidence-provenance.test.mjs:303` — phụ thuộc host (PID bị OS tái sử dụng), có lý do động.
- **Không có tautology** dạng `assert(true)` / `assert.ok(true, true)` và **không có** assertion chỉ
  kiểm mock (`toHaveBeenCalled*`) trong toàn bộ 221 file.

## 7. Tín hiệu cần đào (do phiên điều phối đo, chưa kết luận)

| Tín hiệu | Số file | Ví dụ nhiều nhất |
| --- | --- | --- |
| `catch { }` rỗng (có thể nuốt lỗi assertion nếu nằm trong test) | 48 | `test/main/omp-mcp-adapter.test.ts` (16), `test/main/bridge-server.test.ts` (14), `test/e2e/semantic-ref-trusted-cdp.test.ts` (8) |
| catch kèm chú thích kiểu "ignore/swallow/pass" | 3 | `test/main/baseline-authority-integration.test.ts`, `test/unit/baseline-authority.test.ts`, `test/unit/route-identity-gate.test.mjs` |
| `console.log(` trong test (nhiễu/che dấu) | 11 | `test/e2e/terminal-rename-space.test.cjs` (6), `test/main/cli-agent-launcher.test.ts` (4), `packages/site-clone/src/qa/final-provenance-ledger.test.ts` (4) |
| Commit chạm test trong 3 tháng | 290 | — |
| File test từng bị xoá trong 6 tháng (một số sau đó được chuyển tên) | 11 | `test/main/native-messaging-*.test.ts`, `test/main/domain-scoper.test.ts`, `test/main/cookie-*.test.ts` |

## 8. Tiêu chí phát hiện (bám sát `references/audit-suite-workflow.md`)

1. **Deceptive** — assert luôn đúng; assert lên stub/mock thay vì hành vi; snapshot hoá đúng thứ code
   đang làm; bắt lỗi rồi nuốt; mock quá rộng tới mức không chạm code cần kiểm.
2. **Disabled** — skip/todo/comment-out không kèm lý do hoặc issue.
3. **Unfinished** — thân rỗng, `TODO: implement`, setup mà không assert.
4. **Ineffective** — vẫn pass khi có bug (phải chứng minh bằng đột biến), assert chi tiết cài đặt thay
   vì hợp đồng, hoặc trùng phạm vi với test khác.
5. **Missing edge cases** — biên, rỗng/null, lỗi, quyền, bất đồng bộ.
6. **Redundant** — trùng lặp giá trị thấp (chỉ kết luận khi chứng minh được không mất coverage).
7. **Outdated** — bám tính năng/API đã bị gỡ hoặc đổi tên.
8. **Security gaps** — credential/token thật trong fixture, in secret, thiếu ca thất bại authn/authz.
9. **CI blind spots** — làn không bao giờ chạy, exit code bị che (`|| true`), file kết quả bị gate bỏ qua.

## 9. Phân công lát cắt cho 5 ứng viên (đọc-only, độc lập)

| Nhãn | Lát cắt chính |
| --- | --- |
| C1 | `test/unit/**` (51 file) + `.canary` test — kể cả 6 test canary đỏ ở §3 |
| C2 | `test/main/**` theo bảng chữ cái `a`–`m` |
| C3 | `test/main/**` phần còn lại `n`–`z` |
| C4 | `packages/site-clone/src/**` + `test/integration` + `test/e2e` + `test/benchmark` + `test/renderer` + `test/golden-slice-e2e.test.ts` + `test/workflow-and-artifact-security.test.ts` |
| C5 | Tính toàn vẹn của gate: `package.json` script, `scripts/check-*.mjs`, `scripts/*.cjs` dùng trong test, lịch sử git của test (thêm skip/xoá test/đổi assert), và census trùng lặp tiêu đề test |

Mọi ứng viên **được phép** báo bất kỳ phát hiện Critical nào ngoài lát cắt của mình, nhưng phải nói rõ
là ngoài lát cắt.

## 10. Yêu cầu đầu ra cho mỗi ứng viên

Mỗi phát hiện phải có: `id`, mức (`Critical`/`Important`/`Minor`), `file:line`, bằng chứng đọc được
(trích nguyên văn ngắn), **cách sửa tối thiểu**, và với nhóm "ineffective" thì nêu **đột biến cụ thể**
sẽ làm test đỏ nếu sửa đúng. Nêu cả phát hiện mình **đã cân nhắc rồi loại** và lý do, để verifier khỏi
đếm trùng. Không báo lại các mục ở §6 nếu không có bằng chứng mới.

## 11. Ràng buộc

- Read-only tuyệt đối: không sửa file, không chạy build/test, không lệnh git thay đổi trạng thái.
- Corpus theme Haravan ngoài repo (`<work>/customizes/**`, `<work>/themes/**`) là read-only.
- Không in giá trị giống secret; nếu phát hiện secret thật trong fixture, chỉ nêu `file:line` và loại
  secret, không trích giá trị.
- Từ vựng bằng chứng: `OBSERVED | VERIFIED | DERIVED | INFERRED | UNKNOWN | CONFLICT`.
- Nền tảng Haravan, không áp giả định Shopify.
