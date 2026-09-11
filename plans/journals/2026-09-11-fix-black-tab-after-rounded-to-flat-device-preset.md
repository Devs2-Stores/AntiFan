---
title: Fix black tab after rounded-to-flat device preset
date: 2026-09-11
---

# Fix black tab after rounded-to-flat device preset

# Fix: tab Chromium toàn đen sau khi chuyển preset bo góc → preset phẳng

## Symptom
- Tab hiển thị toàn màu đen (đôi khi trắng); F5 mới hết.

## Root cause (tái hiện được ở mức pixel)
- `src/main/browser/native-tab-host.ts` → `applyTabDeviceEmulation` Case B chỉ gọi
  `tab.view.setBackgroundColor("#00000000")` khi `getPresetCornerRadius(preset) > 0`
  và không có nhánh khôi phục. Mọi preset desktop/responsive có radius 0, nên sau khi
  dùng preset mobile/tablet rồi chuyển sang preset phẳng (MacBook 13/14, Full HD,
  Surface Pro, iPhone SE, mobile-320…) view giữ nguyên trạng thái trong suốt.
  Mọi khoảnh khắc chưa được vẽ của tab khi đó lộ nền cửa sổ `#080c14` = tab đen.
  19/47 preset nằm trong nhánh Case B; 27/47 preset có radius > 0 để kích hoạt rò.

## Fix
- Case B: đặt màu nền vô điều kiện theo bán kính bo góc:
  `clipRadius > 0 ? "#00000000" : "#ffffff"`.
- Sửa comment sai ở nhánh split mode (code đặt `#ffffff`, comment cũ nói "transparent").
- Thêm unit test khoá hợp đồng trên toàn bộ `DEVICE_PRESETS`.

## Evidence
- Test mới FAIL trước fix (`actual "#00000000"`, `expected "#ffffff"` sau `laptop-macbook13`),
  PASS sau fix (12/12 `native-tab-host-viewport`).
- Probe pixel thật (Electron 43, `desktopCapturer`): trước fix preset phẳng + trang trong suốt
  = `{16,16,16}` (đen); sau fix = `{240,240,240}` (trắng); nhánh `responsive` không đổi.
- `npm run compile` sạch; `test:fast` 466/466; `test:integration` 13/13;
  `test:main` 1065/1086 và `test:canary` 154/159 — toàn bộ 20+5 lỗi còn lại là pre-existing,
  chứng minh bằng A/B trên module đã emit (43 failure trước fix == 43 sau fix, byte-identical).
  Independent reviewer: correct, confidence 1.0, 0 findings.

## Files
- `src/main/browser/native-tab-host.ts` (2 hunk: Case A comment, Case B background invariant)
- `test/unit/native-tab-host-viewport.test.ts` (harness records setBackgroundColor + test mới)
- `CHANGELOG.md` (mục v1.3.6 Unreleased)

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
