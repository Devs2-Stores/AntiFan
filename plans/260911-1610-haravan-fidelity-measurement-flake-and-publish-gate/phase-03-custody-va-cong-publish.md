---
title: "Phase 3: Custody và cổng publish (V5, V6, epoch)"
status: complete
---

# Phase 3: Custody và cổng publish (V5, V6, epoch)

## Overview

Ba việc không đụng tới flake nhưng quyết định kết quả publish có *nghĩa* hay không: cổng publish phải chặn `REFUSED` cấu trúc, artifact phải khai được thế hệ instrument, và hash ghim phải verify lại được trên Windows.

## Owner Receipt (V6 — bắt buộc)

Việc này đổi thứ mà campaign tuyên bố là publishable; nó có thể biến một cấu hình đang-publish-thành-công thành refusing, nên cần owner ký.

- Receipt: owner ra lệnh `--auto --parallel --advice Triển khai hết những gì cần làm đi` (uỷ quyền toàn phần cho work list đã chốt, 2026-09-11), ghi trong plan này.
- Giới hạn receipt: chỉ áp cho `.canary/**` + `scripts/lib/**`; **không** chạm theme live `1001510509`, không `hrv theme push/publish`.

## Requirements

- [x] V6: `checks.status === 'REFUSED'` ⇒ `complete === false` và `status` cuối không phải `COMPLETE`/`INCOMPLETE` trơ (dùng `REFUSED_STRUCTURAL` hoặc tương đương).
- [x] V6: `gaps` không còn rỗng khi có refusal cấu trúc.
- [x] Epoch: `report.json.instrument = { revision, epoch, files[] }`; `revision` là hash của tập hash các file instrument; file thiếu ⇒ `sha256: null`, không throw.
- [x] Epoch: khối instrument có mặt ở mọi artifact JSON run tự sinh (tối thiểu `report.json`, `compare-index.json`, `compare/*/index.json`).
- [x] V5: `sha256Text` chuẩn hoá CRLF→LF, dùng ở các chỗ ghim sha256 artifact JSON; `sha256Buffer`/`sha256File` giữ nguyên cho consumer khác.
- [x] V5: không thêm `.gitattributes`, không renormalize `.canary/**`.

## Implementation Steps

1. (đã giao `V6PublishGate`) Tách vị từ thuần `isPublishComplete({...})`; `complete` gọi nó với `structuralFindings.refused`.
2. `gaps.push` khi refusal cấu trúc tồn tại.
3. Thêm khối `instrument` + ghi vào các artifact.
4. Thêm `sha256Text` và dùng ở các điểm ghim.

## Evidence (đo trên run4, 2026-09-11)

Quét **toàn bộ** pin `sha256` trong `.canary/theme-fidelity-run4/report.json` (không chỉ 6 file như bảng của winner), đối chiếu lại bằng hash thô và hash sau khi chuẩn hoá CRLF→LF:

| Kết quả | Số pin | Ghi chú |
|---|---|---|
| RAW-MATCH | 7 | khớp ngay cả khi chưa chuẩn hoá |
| **LF-MATCH** | **42** | khớp sau khi đưa CRLF→LF; file có 458–481 dòng CRLF |
| MISMATCH cứng | 1 | `commands.jsonl`: `crlf=0`, pin ghi `{bytes: 31440, lines: 12}` nhưng file trên đĩa đã 38253 bytes |

⇒ Chuẩn hoá LF là đúng và phạm vi ảnh hưởng rộng hơn "2 file". Pin của `commands.jsonl` lệch **theo thiết kế** vì file append-only sau thời điểm ghim ⇒ artifact phải tự khai báo: `hashContract: 'lf-normalized'` + `appendOnly: true` + `bytes`/`lines` + `pinnedPrefix`.

Cổng publish: `report.json` của run4 có `structuralFindings.refused = true` (`settings-binding` 95 setting chưa khai + `assets` 6 file thiếu) nhưng `gaps = []` và status `COMPLETE`-nhánh cũ. Sau khi vá, cùng input đó cho `status = REFUSED_STRUCTURAL`, `gaps` khác rỗng, `current.json` không được publish, exit 3 — chứng minh bằng smoke thật ở `test/unit/theme-fidelity-publish-gate.test.mjs` + báo cáo của agent.

## Todo

- [x] Vị từ `isPublishComplete` + test lật (`V6PublishGate`)
- [x] `gaps` phản ánh refusal (`V6PublishGate`)
- [x] Khối `instrument` + test (`V6PublishGate`)
- [x] `sha256Text` + test CRLF/LF (`V6PublishGate`)

## Success Criteria

- `node --test --test-force-exit test/unit/theme-fidelity-publish-gate.test.mjs` xanh, gồm case `REFUSED ⇒ false` và `sha256Text('a\r\nb') === sha256Text('a\nb')` trong khi `sha256Buffer` khác.
- `node -e` re-hash 6 artifact `report.json` ghim ⇒ 6/6 khớp bằng hàm chuẩn hoá LF (chạy lại sau Phase 4 khi có run mới).
- Báo cáo nêu `file:line` chỗ ghi `status` cuối và giá trị mới khi refusal cấu trúc.
