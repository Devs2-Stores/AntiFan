---
title: "Phase 1: Mask space & fail-closed"
status: todo
---

# Phase 1: Mask space & fail-closed

## Overview

Khắc phục 4 lỗi P0 đầu của Audit v5 tại `browser-control-port.visualCompare`:
lệch không gian toạ độ mask, mask resolution fail-open, mask đơn phương áp đặt lên
tab so sánh, và rò rỉ `normalizeScroll`. Nền tảng cho mọi phase sau.

## Requirements

- [ ] R1. Module thuần tuý mới `src/main/verification/visual-capture.ts`:
  - `VisualCaptureSpace` — ánh xạ affine CSS Viewport → Document/Clip → Raster:
    bù gốc crop (`selector`/`clipRect`), `scrollY` (`fullPage`), `deviceScaleFactor`,
    `zoom`; dùng đúng nguyên tắc `scaleX/scaleY` đã có ở
    `tab-devtools-host.ts` crop path.
  - `MaskLedger` — phân giải fail-closed, phân biệt required/optional:
    mọi entry trong `maskSelectors` là BẮT BUỘC — zero-match hoặc cú pháp lỗi hoặc
    evalJs lỗi → `MaskResolutionError` (không bao giờ giữ `[]` âm thầm);
    `maskOptionalSelectors` (param additive mới, mặc định `[]`) cho entry có thể
    vắng mặt hợp lệ — zero-match ghi receipt `optionalUnmatched`, KHÔNG lỗi;
    receipt ghi trạng thái TỪNG entry `{selector, required, status}`;
    `maskedAreaRatio ≤ 0.70` (hằng số chính sách mặc định 0.70).
  - Chính sách đã chọn: chiến lược A — loại trừ pixel che khỏi tử/mẫu số trong
    `computePixelDiff` (không tô màu trung tính); trần 0.70 chống lạm dụng; tradeoff
    coverage ghi vào receipt. Audit §19 ưu tiên B (tô màu trung tính tất định); A được
    chọn vì computePixelDiff là đường raster có sẵn, không thêm ngưỡng màu mới, và
    mọi diện tích che đều bị hạch toán (ratio + coverage receipt); structural
    primacy Phase 5 (V-09/V-10) giữ vai trò chống lạm dụng mask — divergence khai
    báo tường minh, theo dõi được.
  - `NormalizationTransaction` — inject `<style id="__antifan_normalize_scroll">`
    + restore trong `finally` cho cả target và comparison.
  - `MultiKeyLock` — mutex keyed FIFO (per-key promise queue), acquire nhiều key theo
    thứ tự sắp xếp tất định, release trong finally; dự trù cho joint lock Phase 2
    (pure, không phụ thuộc Electron).
- [ ] R2. Tích hợp `BrowserControlPort.visualCompare` (`browser-control-port.ts`
  ~2385-2603): thay khối `try/catch {}` hiện hữu (~2411-2436) bằng `MaskLedger`
  fail-closed; phân giải mask ĐỘC LẬP trên `tabId` và `compTabId`; bọc normalizeScroll
  (2 chỗ inject ~2395-2406 và ~2500-2514) bằng `NormalizationTransaction`.
- [ ] R3. Không đổi contract tham số hiện hữu; thêm additive `maskOptionalSelectors?:
  string[]`; kết quả thêm trường hạch toán operational: `maskResolution` (entries,
  status, ratio, optionalUnmatched). Param additive PHẢI thấu xuống capability layer:
  cập nhật `browser-capabilities.ts` (inputSchema + execute type của cả
  `browser.visual_compare` lẫn alias `anti.visual.compare`) + contract test
  capability-catalogue giữ nguyên không regress. Result bổ sung nhóm hạch toán
  normalize: `normalizeInjected`/`normalizeRestored` (per side) từ
  `NormalizationTransaction` outcome — injected-mà-không-restored là cờ
  operational, không bao giờ tính là chạy sạch.
- [ ] R4. Không chạm `ArtifactStore`, không chạm `VerificationEvaluator`.

## Implementation Steps

1. Tạo `src/main/verification/visual-capture.ts` (pure, không phụ thuộc Electron).
2. Tích hợp vào `browser-control-port.ts` (target + comparison path).
3. Thêm unit tests Tier 1 + integration Tier 2 (mock host).

## Todo

- [x] `VisualCaptureSpace.transformMaskBoxToRaster` cho crop offset khác 0 (V-03/V-04)
- [x] `VisualCaptureSpace` cho fullPage + scrollY (document-relative) (V-05)
- [x] `VisualCaptureSpace` cho DPR 2 và zoom 1.25 (V-06/V-07, per-axis scaleX/scaleY)
- [x] `MaskLedger` fail-closed (missing selector, cú pháp lỗi, lỗi evalJs) (V-01/V-02)
- [x] `MaskLedger` trần diện tích che > 70% → policy violation (V-23; union clipped coverage)
- [x] `NormalizationTransaction` restore trong finally (cả khi throw) (V-11/V-12)
- [x] `MultiKeyLock` — keyed FIFO, sorted acquire, release trong finally
- [x] Tích hợp visualCompare: mask độc lập hai tab + receipt hạch toán (additive param + capability schema)
- [x] Tier 1 unit tests: V-01..V-08, V-23 (+ boundary/overlap/clip) (31 tests, 0 fail)
- [x] Tier 2 integration tests: V-11, V-12 (+ computePixelDiff bounds) (8 tests, 0 fail)

## Success Criteria

- V-01 mask bắt buộc thiếu → `MASK_RESOLUTION_FAILED` (không bao giờ `match: true`
  âm thầm) — freeze #1 (Tier 1)
- V-02 cú pháp `div[` → lỗi mask tường minh — freeze #1 (Tier 1)
- V-03 crop selector origin ≠ 0 → raster đúng pixel — freeze #2/#3 (Tier 1)
- V-04 `clipRect` offset → raster đúng pixel — freeze #2/#3 (Tier 1)
- V-05 fullPage + `scrollY > 0` → document-relative — freeze #2/#4 (Tier 1)
- V-06 DPR 2 → transform chính xác — freeze #2/#5 (Tier 1)
- V-07 zoom 1.25 → transform tất định — freeze #2/#5 (Tier 1)
- V-08 cùng selector khác toạ độ A/B → hai bên chuẩn hoá độc lập — freeze #6 (Tier 1)
- V-11 style biến mất sau chạy thành công — freeze #8 (Tier 2)
- V-12 cleanup chạy khi capture ném lỗi — freeze #8 (Tier 2)
- V-23 mask > 70% → từ chối (Tier 1)
- Optional zero-match → receipt ghi, không lỗi (Tier 1)
- `tsc --noEmit` sạch; suite hiện hữu (runtime-fullpage-evidence, browser-control-port,
  capability-catalogue) không regress