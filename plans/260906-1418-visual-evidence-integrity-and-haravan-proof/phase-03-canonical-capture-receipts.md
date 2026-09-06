---
title: "Phase 3: Canonical capture receipts"
status: todo
---

# Phase 3: Canonical capture receipts

## Overview

Xử lý P1-2 (Audit v5 §11): backend chụp đa tầng
(`webContents.capturePage` ≈ 600ms race → CDP `Page.captureScreenshot` ≈ 800ms →
offscreen) không ghi nhận identity, khiến hai ảnh từ backend khác nhau bị so sánh
chéo. Phase này lắp receipt chuẩn + rào cản tương thích trạng thái trước pixel diff.

## Requirements

- [ ] R1. Đường verification PINNED một canonical backend duy nhất: CDP
  `Page.captureScreenshot` (foreground lẫn background) — `tab-devtools-host.ts`
  trả envelope kèm metadata `{ backend: 'cdp', dpr, zoom, cssViewport: {w,h},
  rasterSize: {w,h}, timestamp }`. Fallback phân tầng (wc.capturePage → CDP →
  offscreen) CHỈ còn cho đường screenshot thường (không phải xác minh); verify
  path cố định backend, lệch → `CAPTURE_BACKEND_SWITCH` tường minh. Additive:
  không phá callers cũ (giá trị cũ vẫn trả buffer/base64).
- [ ] R2. `BrowserControlPort.visualCompare`: đường so sánh xác minh KHÔNG được
  âm thầm đổi backend giữa baseline/current (V-20); nếu backend lệch → operational
  `CAPTURE_BACKEND_SWITCH`.
- [ ] R3. Compatibility gate trước diff: baseline vs current phải cùng DPR/zoom/
  viewport (fullPage/bán cùng chế độ); lệch → `INCONCLUSIVE / CAPTURE_STATE_MISMATCH`
  (V-21) — trừ khi policy normalize tường minh (không có trong phase này).
- [ ] R4. Receipt xuất vào kết quả visualCompare: `captureReceipts: { target,
  baseline }` + `captureStateCompatible: boolean`.
- [ ] R5. Background tab (V-19): CÙNG canonical backend (CDP) với foreground —
  foreground KHÔNG dùng wc.capturePage trong verify path; tận dụng đánh thức
  compositor hiện hữu (`DOM.getDocument`); receipt tương đương.

## Implementation Steps

1. Thêm `CaptureImageResult`/metadata vào captureScreenshot (additive).
2. Trả metadata qua host bridge tới BrowserControlPort (check interface
   `BrowserHostPort.captureScreenshot`).
3. Compatibility gate pure function (test được) trong `visual-capture.ts`.
4. Tests Tier 1 (compat gate) + Tier 2 (V-19, V-20, V-21 với mock host).

## Todo

- [ ] Capture metadata envelope tại tab-devtools-host (backend, dpr, zoom, viewport, raster)
- [ ] Host bridge truyền metadata (additive)
- [ ] `captureStateCompatible` pure check (DPR/zoom/viewport/backend)
- [ ] visualCompare: backend consistency + state gate trước diff
- [ ] Receipt fields trong kết quả visualCompare
- [ ] Tier 1: compat gate tests
- [ ] Tier 2: V-19, V-20, V-21

## Success Criteria

- V-19 background tab → canonical backend (CDP) + receipt tương đương (Tier 2) — freeze #17
- V-20 không đổi backend giữa baseline/current (Tier 2) — freeze #10
- V-21 DPR 1 vs 2 → `INCONCLUSIVE / CAPTURE_STATE_MISMATCH` (Tier 2) — freeze #11
- Callers cũ của captureScreenshot không đổi hành vi (suite chạy xanh)
- `tsc --noEmit` sạch