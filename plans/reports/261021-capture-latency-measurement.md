# Đo độ trễ capture (mục 12) — 21/10/2026

Phạm vi: đường capture của `anti.screenshot.full_page`, `anti.visual.compare`, `anti.inspect.responsive_matrix`. Không chạm app sống, không cổng 20130, không data root sống. Mọi số liệu dưới đây đo bằng mô phỏng trên module đã compile (CDP và trang giả), không phải số đo trên trang thật.

## Kết luận

**Chưa quy được nguyên nhân đơn lẻ nếu không chạy A/B trực tiếp.** Không có sửa mã hành vi. Lý do:

1. Diff cho thấy 4 thay đổi thật làm capture chậm hơn, nhưng cả 4 đều là tính năng đúng đắn. Mỗi cái chỉ tốn thêm trên một lớp trang hẹp, và gỡ bất kỳ cái nào sẽ đổi ngữ nghĩa bằng chứng (bỏ vật chất hóa phần đuôi, hoặc từ chối trang cao).
2. Phần chi phí cộng thêm ước lượng được (≤ vài giây, tuyến tính theo chiều cao trang) không giải thích được mức tăng p50 chung của mọi tool (15,1 s → 28,5 s). Mức tăng đó cũng xảy ra ở các tool không đi qua capture.
3. Timer pha đã được gắn vĩnh viễn. Từ nay một lần gọi chậm tự nêu tên pha, nên A/B trực tiếp có thể đọc thẳng pha thay vì suy luận.

## Timer đã thêm (chỉ đo, không đổi luồng)

`CapturePhaseTimings` trong `visual-capture.ts`, đi theo envelope và receipt (`timings`), kèm sự kiện lifecycle `capture.timings` trong `main.log` (có cả khi capture lỗi, với `outcome` là mã lỗi):

| Field | Pha |
|---|---|
| `probeMs` | probe render surface + đọc chiều cao tài liệu trước walk |
| `prewarmMs` | walk vật chất hóa full-page (phía host; `prewarm.elapsedMs` là phía trang, hiệu hai số là overhead eval) |
| `settleMs` | toàn bộ cổng settle, gồm fonts retry và lần chạy lại sau slider-hold |
| `fontsRetryMs` | phần của settle dành cho fonts retry (`capture-settle.ts` cũng trả `measurements.fontsRetryMs`) |
| `activationMs` | lift lease + cổng frame-liveness + kích hoạt tab nền nếu cần |
| `rasterMs` | `Page.captureScreenshot` cộng dồn mọi tile |
| `encodeMs` | ghép tile, encode lại, validate byte |
| `restoreMs` | khôi phục viewport sau raster |
| `totalMs` | từ lúc vào đến lúc trả về |

`totalMs` trừ tổng các pha là thời gian ở giữa các pha (attach tab nền: 60 ms rAF + 120 ms cố định, guard overlay). Sự kiện lifecycle còn mang `prewarmSteps`, `prewarmInPageMs`, `prewarmStopped`, `prewarmEndHeight`.

Walk tham chiếu (`buildReferenceMaterializationScript`, dùng bởi `reference.capture`, `dump_dom`, `promote_baseline`, `screenshot.full_page` với `materializeDataSrc`) giờ trả thêm `steps` và `elapsedMs`.

Lưu ý: `anti.screenshot.full_page` với `materializeDataSrc:true` chạy walk tham chiếu trước, rồi `captureVerificationScreenshot` chạy tiếp walk staircase. Trang đi qua hai walk liên tiếp (`browser-control-port.ts:3575` rồi `tab-devtools-host.ts`). Đó là thiết kế sẵn có từ `0014b948` (08/10), không phải thay đổi mới; ghi lại để người đọc timer không ngạc nhiên.

## Bằng chứng diff (09/10 → 20/10)

Trạng thái 09/10 là `c0d89a96^`. Các commit đụng đường capture, theo thứ tự:

| Commit | Ngày | Thay đổi liên quan độ trễ |
|---|---|---|
| `c0d89a96` | 16/10 | walk mặc định `maxSteps` 12 → 20, `maxDocumentHeight` 10 000 → 16 384; cắt lát raster > 12 000 device px |
| `6d1d2e2f` | 16/10 | thêm chờ sự kiện scroll khi về đầu trang (`returnSettleBudgetMs` 1 500 ms trần; bình thường 16–700 ms) |
| `311e39a7` | 16/10 | `prewarmOptionsForDocument`: `maxSteps` tối đa 160, trần chiều cao tới `fullPageMaxCssHeight` (≈104 166 CSS px ở 1440 px, dpr 1); ghép tile qua `finalizeFullPageTiles`; fonts retry `FONTS_RETRY_WAIT_MS` = 1 500 ms; bậc kích hoạt tab nền trong thang repair frame |
| `20dafbef` | 12/10 | `runResponsiveCheck` poll mỗi breakpoint tới 2 500 ms cho tới khi `innerWidth` khớp (không thuộc lane này) |

Không có pass thêm, dwell tăng hay vòng retry vô hạn trong walk. `311e39a7` thêm một retry (fonts, một lần) và một bậc repair (kích hoạt tab nền, chỉ chạy khi các bậc trước không phục hồi được frame; tối đa 5 probe × 300 ms + 120 ms).

## Số đo 1 — walk staircase (script thật trong vm, đồng hồ ảo)

Cách đo: `l10-walk-sim.cjs` (tạm, ở `E:/Work/scratch`) nạp đúng `buildStaircasePrewarmScript` của ba revision và chạy trong vm với `window/document` giả, trang tĩnh (không tăng chiều cao khi cuộn), viewport 1440×900, sự kiện scroll đến sau 16 ms. Đồng hồ ảo nên kết quả xác định; sàn timer 1 ms và 4 ms cho cùng kết quả (mọi chờ ≥ 40 ms).

| Chiều cao trang (CSS px) | 09/10: ms (bước) | trước `311e39a7`: ms (bước) | HEAD: ms (bước) |
|---|---|---|---|
| 4 000 | 752 (5) | 768 (5) | 768 (5) |
| 8 000 | 952 (10) | 968 (10) | 968 (10) |
| 16 000 | 32 (0, bị chặn `MAX_DOCUMENT_HEIGHT`) | 1 368 (20) | 1 368 (20) |
| 24 000 | 32 (0) | 32 (0) | 1 808 (31) |
| 40 000 | 32 (0) | 32 (0) | 2 648 (52) |
| 60 000 | 32 (0) | 32 (0) | 3 688 (78) |
| 100 000 | 32 (0) | 32 (0) | 5 768 (130) |

Đọc số:

- Trang ≤ 8 000 px: cộng thêm **16 ms** (chờ sự kiện scroll lúc về đầu trang). Không phải nguyên nhân tăng gấp 3–9 lần.
- Trang ≥ 10 000 px: ở 09/10 walk **không chạy** (chạm trần chiều cao ngay bước 0, 32 ms) nên nhanh nhưng phần đuôi trang không được vật chất hóa. HEAD đi hết trang: +1,3 s đến +5,7 s. Đây là chi phí của việc làm đúng, không phải lỗi.
- Walk tham chiếu (trang tĩnh, 1 pass): 200 ms ở 4 000 px, 500 ms ở 16 000 px, 2 700 ms ở 100 000 px. Với trang tăng chiều cao, mỗi pass thêm đi lại từ `lastH − step`, tối đa 6 pass, mỗi pass cộng 80 ms dwell đáy.

Giới hạn của số đo: trang thật cộng thêm chi phí layout, tải ảnh lazy do cuộn kích hoạt và throttle timer. Không mô phỏng được; số trên là cận dưới.

## Số đo 2 — cổng settle (module thật, evalJs giả trả tức thì)

Mọi mili giây đo được là lịch dwell/quan sát của chính cổng (`l10-settle-sim.cjs`, trung vị 5 lần):

- Trang ổn định, dwell mặc định 250 ms: **259–267 ms**, 2 lần lấy mẫu.
- Fonts-only fail rồi load xong sau retry: **520 ms**, trong đó `fontsRetryMs` = 262 ms với wait giả trả tức thì. Thực tế cộng thêm tối đa `FONTS_RETRY_WAIT_MS` = 1 500 ms chờ `document.fonts.ready` trong trang. Trước `311e39a7` trường hợp này là lỗi `CAPTURE_NOT_READY`; giờ là thành công chậm hơn ≤ ~1,8 s.

## Số đo 3 — ghép và encode tile (Node thuần, không Electron)

Chỉ chạy khi chiều cao × dpr > 12 000 device px. Tile 1440 px rộng, ảnh tổng hợp "gần ảnh chụp" (gradient + 6% pixel nhiễu, zlib mặc định), `finalizeFullPageTiles` (`l10-encode-sim.cjs`, 3 lần/mẫu):

| Tile | Tổng cao (device px) | Byte tile | Ghép + encode (min / trung vị / max) |
|---|---|---|---|
| 1 (chỉ decode, 8 000 px) | 8 000 | 3,3 MB | 1 031 / 1 044 / 1 217 ms |
| 2 | 16 384 | 6,8 MB | 6 385 / 8 897 / 10 916 ms |
| 4 | 32 768 | 13,6 MB | 11 294 / 11 800 / 12 649 ms |
| 8 | 65 536 | 27,2 MB | 23 452 / 24 358 / 25 007 ms |

Phân rã (`l10-deflate-sim.cjs`, 1 ảnh 1440×16384 RGBA = 94 MB): filter hàng 50–84 ms; deflate mức 6: 0,8 s (gradient phẳng) đến 2,5 s (có nhiễu); decode một tile 8 192 hàng: 1,2–1,5 s. Độ lệch giữa các lần lớn (2 tile: 6,4–10,9 s) vì tải máy. Ảnh trang cửa hàng thật nén tốt hơn ảnh nhiễu của tôi, nên số này nghiêng về phía xấu; lấy bậc độ lớn ~ **vài giây mỗi 16 000 device px** làm kết luận, không lấy con số chính xác.

Đây là chi phí **mới hoàn toàn so với 09/10**: ở 09/10 trang > 16 384 px bị từ chối `FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY`, còn trang giữa 12 000 và 16 384 device px chụp một raster (phần dưới có thể trắng, đó là lý do cắt tile). Với dpr 2 ngưỡng 12 000 device px tương ứng chỉ 6 000 CSS px, nên nhiều trang cửa hàng thông thường đã rơi vào đường tile trên màn hình HiDPI.

Hướng giảm đã đo nhưng **chưa áp dụng** (nằm ngoài các file của lane này, và đổi kích thước byte nên có thể kéo thêm các PNG qua trần artifact sang JPEG): deflate mức 1 nhanh hơn 2,4–2,7 lần nhưng PNG to 1,9–3,9 lần. Lưu ý đường 1 tile: host chỉ gọi `finalizeFullPageTiles` với 1 tile khi PNG vượt `maxBytes`; hàm vẫn decode tile đó (~1 s ở 8 000 hàng) trước khi quyết định trả lại PNG gốc hay encode JPEG, nên một trang cao nhưng vừa một raster, vừa vượt trần byte, trả giá decode cộng encode JPEG.

## Phần chưa chứng minh

- Không có số đo nào trên Electron thật, GPU thật, trang thật. Mức tăng p50 chung (15,1 → 28,5 s) còn các giả thuyết ngoài đường capture: tải máy khi phân tích (ổ C: gần đầy ngày 21/10, pagefile tăng thêm ~6 GB), số terminal/cửa sổ song song, và fixture benchmark cũ báo `WORKSPACE_NOT_THEME` làm sai số liệu `theme.qa_validate`.
- `responsive_matrix` có ứng viên cụ thể ngoài lane này: `20dafbef` thêm vòng poll tới 2 500 ms mỗi breakpoint (5 breakpoint → tới 12,5 s) khi `innerWidth` không bao giờ khớp. `06adcdd6` (16/10) đổi cách emulation tác động lên kích thước pane, nên có khả năng `innerWidth` không còn khớp và mỗi breakpoint đốt hết 2 500 ms. Đây là **giả thuyết từ diff, chưa đo**. Kiểm tra rẻ: trong kết quả `responsive_matrix`, đếm breakpoint có `emulationApplied:false`. Nếu có, đó là nguyên nhân độc lập với capture.
- `visual.compare` dùng đường capture trên; chưa có số đo riêng.
- Fixture benchmark mặc định (120 thẻ) có thể thấp hơn 10 000 px, tức không chạm vào vùng mà diff đã đổi. Đọc `prewarm.endHeight` trong receipt của lần chạy để biết.

## A/B trực tiếp cần chạy

`npm run benchmark:mcp` mở cửa sổ Electron riêng (userData tạm, `ANTIFAN_*` bị xóa, không đụng app sống). Cờ `--only` chỉ nhận **một** chuỗi con, nên chạy riêng từng tool (lệnh `--only` lặp trong kế hoạch ban đầu sẽ chỉ lấy một giá trị).

```
git worktree add E:/Work/scratch/ab-pre   c0d89a96^     # trạng thái 09/10
git worktree add E:/Work/scratch/ab-311   311e39a7
git worktree add E:/Work/scratch/ab-head  HEAD          # chỉ có timer sau khi đã commit timer; hoặc chạy thẳng cây làm việc hiện tại
# trong từng worktree: npm ci (hoặc junction node_modules), rồi:
for tool in screenshot.full_page responsive_matrix visual.compare; do
  npm run benchmark:mcp -- --only $tool --samples 5 --out plans/reports/ab-<tag>-$tool.json
done
```

Chạy xen kẽ pre / 311 / head hai vòng để tách nhiễu tải. Bốn điểm cần đọc:

1. `p50`/`p95` mỗi tool theo từng revision. Nếu pre ≈ 311 ≈ head thì độ trễ không đến từ mã capture.
2. Với revision có timer: `receipt.timings` của `screenshot.full_page` hoặc dòng `capture.timings` trong `main.log` của lần chạy. Pha chiếm phần lớn nói thẳng chỗ tốn: `prewarmMs` (walk), `settleMs`/`fontsRetryMs`, `activationMs` (kích hoạt tab), `encodeMs` (ghép tile).
3. `responsive_matrix`: số breakpoint có `emulationApplied:false`.
4. `prewarm.endHeight` và `tiles.count` trong receipt: cho biết fixture có chạm vùng tall/tile hay không. Nếu không, lặp lại một lần với trang cao thật bằng `npm run benchmark:mcp:live -- --tab <tabId> --only screenshot.full_page` (cần terminal AntiFan gán vào project; lệnh này dùng app sống, người dùng tự quyết).

Quy tắc sửa theo kết quả (giữ nguyên từ kế hoạch): `fontsRetryMs` chiếm phần lớn → chỉ retry khi `document.fonts.status === 'loading'` và còn ngân sách; `activationMs` chiếm phần lớn → bỏ kích hoạt tab nền khi tab đã có frame; `encodeMs` chiếm phần lớn → cân nhắc encode tile ngoài luồng chính hoặc nén nhanh hơn kèm kiểm tra trần artifact; không khớp pha nào → kết luận do tải/thiết lập đo, không sửa mã.
