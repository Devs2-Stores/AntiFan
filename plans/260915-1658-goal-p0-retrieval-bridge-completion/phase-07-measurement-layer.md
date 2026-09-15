---
phase: 7
title: "Measurement layer — mở khoá khả năng phán quyết (B23/B30/B32)"
status: in_progress
priority: P1
effort: ""
dependencies: [6]
---

# Phase 7: Measurement layer — mở khoá khả năng phán quyết (B23/B30/B32)

## Overview
Locked contract item: P1 của MASTER UPGRADE. Block 3. Ba bottleneck đang mở, và chúng **chặn định nghĩa của 100%**: chừng nào lớp đo còn hỏng thì case QA/visual **không thể** đạt PASS có xác minh — 100% bất khả thi về mặt định nghĩa, không phải về mặt thời gian.

Đây là lý do ba mục này nằm trong scope dù chúng không phải "feature".

## Requirements

### R0 — Target đã xác định, và có đường offline
Review đối kháng cảnh báo đây là **điểm nghẽn không tự chủ** (storefront bên thứ ba + mạng). Kiểm tra thực tế cho thấy repo **đã có** cả target lẫn đường lui — nhưng chúng chưa được dùng, và đó là việc của phase này.

**Target do user chỉ định**: `E:/Work/apps/AntiFan/Storefront`
- Theme Haravan thật: 236 file, 5,0 MB, `layout/theme.liquid` + **43 template** + `assets/` + `snippets/` + `config/{settings.html,settings_data.json,settings_schema.json}`.
- Link remote qua Haravan CLI: `.haravan-cli_local.json` → `org_id 1000405253`, `theme_id 1001357480`, `theme_name "Hrv Glasses"`. Cả hai file CLI config bị `.gitignore` — là state local, **không** commit, **không** đưa vào artifact.
- **`settings.html` là marker của Haravan legacy** — phải xử lý đúng theo hệ đó, không giả định `settings_schema.json`-only.

**ĐÍNH CHÍNH + GIẢI QUYẾT — đường render cho theme đích đã TÌM ĐƯỢC:**

Bản trước của phase này có hai lỗi liên tiếp. Lỗi 1: trích hai script không render `Storefront`. Lỗi 2: sau khi sửa, kết luận "không có đường render". **Cả hai đều sai.** Đường render **có sẵn và đang sống**:

> **`https://hangquoctai.myharavan.com/`** — store của org `1000405253`, **đang phục vụ theme `1001357480` ("Hrv Glasses")**.

**Chuỗi bằng chứng** (đo được, từng bước, không suy đoán):
1. `haravan whoiam` → org `1000405253` tồn tại và có theme đích. *(Không chép danh sách org khác vào artifact — xem luật hygiene bên dưới.)*
2. `haravan theme list` → trong org đó có `1001357480 Hrv Glasses`, cùng anh em `1001357481 Hrv Glasses - Order`. Không có theme nào tên "hoplong".
3. Store của org: **`https://hangquoctai.myharavan.com/`** → **200**, 283.726 byte, title `HangQuocTai` (`*.myharavan.com` suy từ tên org). `hrvglasses.myharavan.com` / `hrv-glasses.myharavan.com` → **404 "Không tìm thấy shop"** (loại giả thuyết).
4. **Phân biệt được theme nào đang publish** — đây là bước chứng minh thật, không phải suy từ tên:

| URL | sha256[:14] | Byte |
|---|---|---|
| `/` (plain) | `b95ac59f3fad98` | 283.726 |
| `/?theme_id=1001357480` **Hrv Glasses** | **`b95ac59f3fad98`** ← **trùng khít** | 283.726 |
| `/?theme_id=1001357481` Hrv-Order | `8bb8908ce43b7b` | 167.277 |
| `/?theme_id=1001199960` The Swan | `1bb5ba346d84a2` | 776.185 |
| `/?theme_id=1000698070` Developer | `bb6dc41cb9cec4` | 220.399 |

Tham số `theme_id` **được platform tôn trọng** (5 URL → 4 hash khác nhau). Plain render **byte-identical** với `theme_id=1001357480` và **khác** theme anh em `1001357481`.

**Vì sao bước 4 là bắt buộc, không thừa:** `1001357480` và `1001357481` là **hai theme cùng codebase** ("Hrv Glasses" và "Hrv Glasses - Order"), nên chúng **chia sẻ asset** — kiểm marker như `effect-material.js`/`fancy.css` **không phân biệt được** hai theme đó. Nếu chỉ dựa vào marker thì có thể đã đổi "sai site" lấy "sai theme". So hash theo `theme_id` mới là bằng chứng quyết định. *(Cả hai theme đều render title `HangQuocTai`, nên so title cũng vô dụng — phải so hash.)*

**Luật hygiene cho artifact**: chỉ ghi `org 1000405253` + theme id + domain store. **Không** chép danh sách org/tài khoản khác từ `whoiam` vào plan, preflight, packet hay báo cáo — chúng không cần cho công việc.

**Hệ quả thứ nhất — campaign hiện tại đang đo SAI CHỦ THỂ.** `hoplongtech.com` thuộc một **org khác** (thương hiệu Hợp Long), không phải `1000405253`. Đây là phát hiện quan trọng nhất của phase này: mọi verdict hiện có trong `.canary/15-pages/` nói về **site của người khác**, không nói gì về theme đội đang build. `TARGET_PAGES` (`fifteen-pages-run.mjs:52+`) hardcode 15 URL `hoplongtech.com` → **phải re-target** sang `hangquoctai.myharavan.com`.

**Hệ quả thứ hai — `/cart` anomaly là đặc thù target cũ, KHÔNG phải lỗi tầng đo.** Trên target đúng, 4 route đều **phân biệt rõ**:

| Route | Byte | Title |
|---|---|---|
| `/` | 283.726 | `HangQuocTai` |
| `/cart` | **164.531** | **`Giỏ hàng của bạn`** |
| `/collections/all` | 280.700 | `Tất cả sản phẩm` |
| `/search?q=a` | 228.935 | `Kết quả tìm kiếm` |

Không route nào trùng byte hay trùng title. Suy ra (`[INFERENCE]`): B32 (`routeIdentity` null ở **24/45 case**) là **defect ở writer** (`scripts/lib/campaign-verdicts.mjs:272`, `exit`/`finishedAt`/`instance` null), **không** phải do site trả nội dung mơ hồ. Điều này **củng cố** cách xử lý B32 — sửa writer, không đi tìm lỗi ở storefront.

**Ranh giới còn lại — chính xác, không phải blocker:**

- Đo **theme như đang publish** → dùng `hangquoctai.myharavan.com`. **Không cần push, không cần approve.** Đây là chế độ mặc định của phase.
- Đo **sửa đổi local chưa publish** trong `Storefront/` → **phải** `theme push-only` / `theme dev` để đẩy lên remote. Đó là **sửa đổi remote thật** → cần user phê duyệt tường minh. Đây là **lựa chọn phạm vi**, không phải điều kiện chặn: phase 7 chạy được ngay ở chế độ publish.

**Vẫn không có render Liquid tại máy** — đã kiểm bằng CLI: `haravan` v1.1.3 chỉ có `login|logout|select|theme list|theme fetch|theme export|theme push-only|theme dev|whoiam`; **không có `serve`/`preview`**; `theme dev` *"Watch theme files and **push each change to the remote theme**"* (khác `shopify theme dev`).

**Luật chống mock vẫn giữ**: một Liquid engine tự dựng (vd `liquidjs` + object model tự chế) **không** phải storefront thật → verdict sinh ra từ đó là **giả**, không được tính `PASS`.

**Luật áp dụng**:
- **`haravan theme push*` bị CẤM** trừ khi user phê duyệt tường minh. Nếu đường render bắt buộc phải push theme lên store, đó là **gate cần user quyết**, không phải bước tự động.
- **Campaign phải được tham số hoá theo target.** Hiện `TARGET_PAGES` trong `.canary/tools/fifteen-pages-run.mjs:52+` **hardcode** 15 URL `https://hoplongtech.com/...`. Đó là target cũ, **không** phải `Storefront`. Phải parameter hoá, và cấu hình target phải revision-bound.
- **Snapshot offline chỉ hợp lệ khi revision-bound VÀ được dán nhãn offline** trong verdict. Không được để snapshot trông giống phán quyết live.
- **Retry có ngân sách chốt trước**; cạn ngân sách → `BLOCKED`, không retry vô hạn (sẽ treo runner). Ghi lại số lần thử + mã lỗi để phân biệt "storefront hỏng" với "code hỏng".

**Bằng chứng reachability (đo lúc preflight)**: `hoplong.com` 200 (654ms / 46ms); `hoplongtech.com` 200 (642ms / 810ms / 2583ms) — cả hai đều sống, nên đường live cũng khả dụng nếu cần đối chiếu.

**Phát hiện kèm theo cần điều tra**: `https://hoplongtech.com/` và `https://hoplongtech.com/cart` trả **cùng độ dài 338.594 byte** và **cùng `<title>`** ("Hoplongtech.com | Công ty Cổ phần Công nghệ Hợp Long") nhưng **hash khác nhau**. Trang `/brands` và `/tin-tuc` thì khác hẳn (272.734 / 329.628 byte, title riêng). Nghĩa là route `/cart` **có thể không render đúng trang giỏ hàng**. Đây là nghi vấn trực tiếp liên quan **B32** (`routeIdentity` null ở 24/45 case) — một case được phán `PASS`/`FAIL` trên route không xác định. Phải kiểm tra trước khi tin bất kỳ verdict nào từ campaign cũ.

### R1 — B23: có cổng live-storefront thật
- Hiện `.canary/15-pages/_verdicts.json` báo `executiveVerdict INCONCLUSIVE`, tally toàn số 0, `cases` rỗng → mọi tuyên bố về fidelity render vẫn dựa vào người đọc báo cáo.
- Yêu cầu: chạy lại campaign 15 trang và **bắt buộc** có `executiveVerdict` khác `INCONCLUSIVE` cùng tally case **không rỗng**.

### R2 — B30: phán quyết viewport phải adjudicable
- `anti.visual.compare` có bước normalization vượt bound **15 s** → `capture.valid = false` → mọi case desktop/tablet thành `CAPTURE_INVALID`.
- Bằng chứng đo được: run `campaign-e2214e66` (2026-09-10T16:52:04Z) — 390 `REFUSED/MOBILE_BUNDLE_ABSENT`; 1440 và 1024 `COMPLETED/INCONCLUSIVE/CAPTURE_INVALID` với `captureValid=false`, `mismatchPercentage=100`, `artifacts.referencePng`/`clonePng` = `null`.
- Yêu cầu: hoặc đưa normalization về trong bound, hoặc tách normalization khỏi đường đo. **Không** nới bound để che.
- Hệ quả kèm theo: `mismatchPercentage=100` khi artifact null là **số vô nghĩa** — phải ngừng phát ra số khi không có artifact.

### R3 — B32: verdict phải revision-bound
- `.canary/15-pages/_verdicts.json` (runId `aggregate-1cce3d25c1614b30`, generatedAt 2026-09-12T06:55:20Z) có `exit` null, `finishedAt` null, `scope.excluded` [], `routeRefusals` [], và **24/45 case có `routeIdentity` null** mà vẫn được phán `PASS`/`FAIL`.
- Writer: `scripts/lib/campaign-verdicts.mjs:272` ghi `exit: runSummary.exit ?? null`.
- Yêu cầu: không phán `PASS`/`FAIL` cho case thiếu `routeIdentity`; `exit`/`finishedAt` phải có thật. Verdict không revision-bound thì **không được** trích dẫn như bằng chứng về hành vi hiện tại.

### R4 — Predicate phải kiểm được bằng máy
- Mỗi bottleneck đóng phải có predicate **chạy được**, không phải "manual". `scripts/check-bottlenecks.mjs` đang kiểm 36 row / 7 open — mở rộng để ba mục này đóng bằng kiểm tra máy.

## Related Code Files
- `plans/bottlenecks.json` — 36 row, 7 open (B19,B20,B21,B23,B29,B30,B32); B23/B30/B32 có `predicate.reVerifyWith`.
- `.canary/15-pages/_verdicts.json` — artifact verdict hiện tại (nguồn bằng chứng cho cả ba).
- `scripts/lib/campaign-verdicts.mjs` — writer (`:241`, `:272`).
- `scripts/check-bottlenecks.mjs` — kiểm bottleneck bằng máy.
- `scripts/check-campaign-verdicts.mjs` (nếu có) — hàng rào campaign.
- `src/main/browser/visual-capture.ts` — `CAPTURE_MAX_DIMENSION = 16384` (`:702`).

## Implementation Steps
1. Đọc lại `.canary/15-pages/_verdicts.json` hiện tại và ghi baseline: tally, số case `INCONCLUSIVE`, số case `routeIdentity` null.
2. Trace `scripts/lib/campaign-verdicts.mjs` để tìm vì sao `exit`/`finishedAt` null.
3. Bắt buộc `routeIdentity` trước khi phán; case thiếu → `BLOCKED`, không `PASS`/`FAIL`.
4. Sửa đường normalization của `anti.visual.compare` cho vừa bound, hoặc tách khỏi đường đo; **không** nới bound.
5. Ngừng phát `mismatchPercentage` khi artifact null.
6. Chạy lại campaign 15 trang; yêu cầu `executiveVerdict` khác `INCONCLUSIVE` + tally khác rỗng.
7. Chuyển predicate ba mục sang kiểm máy trong `scripts/check-bottlenecks.mjs`.

## Contract and Test Matrix
- [ ] Campaign chạy lại cho `executiveVerdict` khác `INCONCLUSIVE` với tally case không rỗng. (fail trước fix)
- [ ] Case desktop/tablet không còn `CAPTURE_INVALID` do vượt bound. (fail trước fix)
- [ ] Case thiếu `routeIdentity` **không** được phán `PASS`/`FAIL`.
- [ ] `exit`/`finishedAt` khác null trong verdict artifact; verdict gắn được với revision HEAD.
- [ ] Không phát `mismatchPercentage` khi `referencePng`/`clonePng` null.
- [ ] `node scripts/check-bottlenecks.mjs` báo ba mục đóng bằng predicate máy, không `manual`.
- [ ] Không test nào assert wiring/source text.

## Success Criteria
- [ ] R1-R4 delivered và evidence linked.
- [ ] Ba bottleneck đóng bằng predicate kiểm được bằng máy.
- [ ] Case QA/visual có verdict thật, **hoặc** được ghi `BLOCKED` kèm blocker nêu tên — không giả PASS.

## Risk Assessment
- Cám dỗ lớn nhất ở đây là **nới bound 15 s** cho campaign xanh. Đó đúng là "hạ tiêu chí để đạt 100%" — health abort ở phase 1 phải bắt được.
- Campaign cần storefront thật; nếu không truy cập được thì `BLOCKED` với blocker nêu tên, không hạ xuống mock.
- B30 và B32 có thể phụ thuộc lẫn nhau (verdict không adjudicable → không revision-bound được). Thứ tự trong phase phải theo dependency thật, không theo số thứ tự.
