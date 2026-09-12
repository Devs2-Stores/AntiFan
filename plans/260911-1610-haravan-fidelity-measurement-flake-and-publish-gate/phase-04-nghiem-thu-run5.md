---
title: "Phase 4: Nghiệm thu campaign run5"
status: complete
---

# Phase 4: Nghiệm thu campaign run5

## Overview

Chạy lại campaign vào **thư mục mới** (`run5`) với instrument đã vá, rồi đối chiếu từng dự đoán định lượng đã ghi ở Phase 1–2. Không trộn thế hệ: nếu artifact cũ và mới nằm cùng thư mục thì kết quả không đọc được (đúng lỗi đã đo ở run4: ba giá trị `indexSha256` cho hai file, tổng PASS 0/1/5 theo ba thế hệ).

## Requirements

- [x] Run mới ghi vào `.canary/theme-fidelity-run5/` (hoặc thư mục riêng tương đương), không ghi đè run4.
- [x] Mọi artifact mang `instrument.revision` + `epoch`; hai thế hệ không thể lẫn mà không lộ.
- [x] Mỗi leg có `settlePasses` (khi rớt settle) với đủ 3 pass và `fingerprintFields` thật.
- [x] Số leg theo `mechanism` được đối chiếu với dự đoán của Phase 1–2; mọi lệch phải giải thích được.
- [x] Không có hành động nào chạm theme live `1001510509`.

## Implementation Steps

1. Xác nhận bridge + session còn hiệu lực; serve fixture/replay đúng cổng.
2. Chạy campaign với `--out .canary/theme-fidelity-run5` (hoặc cờ tương đương trong `theme-fidelity-run.mjs`), giữ nguyên theme copy `1001512581`.
3. Thu: histogram `mechanism` trên 42 leg; `totals` từng set; `passes[].fingerprintFields` của các leg từng rớt.
4. Đối chiếu: `content-changed-between-passes` r2 (dự đoán 13 → 0 nếu V2b), `notMeasurable`, `inconclusive`, `IDENTITY_DRIFT` (dự đoán 12 → 0).
5. Tính **flake/leg** thực đo và khoảng cách tới ngưỡng ≤ 1/400.

## Todo

- [x] Chạy campaign run5 (bridge + session + serve)
- [x] Histogram mechanism + totals từng set
- [x] Đối chiếu dự đoán Phase 1–2, ghi lệch
- [x] Tính flake/leg và ghi khoảng cách tới mục tiêu

## Falsifiers

- Nếu `content-changed-between-passes` không giảm như dự đoán ⇒ nhánh V2 đã chọn sai; quay lại Phase 2 với nhánh kia **kèm số đo mới**, không sửa mò.
- Nếu leg vẫn rớt với mechanism mới chưa từng thấy ⇒ dừng, nêu mechanism + artifact, không tự diễn giải.

## Success Criteria

- Có `report.json` của run5 với `status` phản ánh đúng refusal cấu trúc (kỳ vọng: `REFUSED_STRUCTURAL` khi theme copy còn 95 setting chưa khai).
- Bảng đối chiếu dự đoán/kết quả được ghi vào báo cáo phase, kèm số leg và flake/leg.
- Kết luận rõ: phần nào của mục tiêu "publish được kết quả đáng tin" đã đạt, phần nào còn phụ thuộc workstream theme (95 setting + 6 asset) nằm ngoài plan này.
