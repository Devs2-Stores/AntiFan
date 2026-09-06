---
title: "Phase 4: Composed settle barrier"
status: todo
---

# Phase 4: Composed settle barrier

## Overview

Thay logic settle ad-hoc (P1-4, Audit v5 §14 — `theme-qa-workflow.ts:200-240`
dùng race 400ms font + rAF 150ms) bằng `CaptureSettleGate` tổ hợp: mạng first-party
yên lặng + font ready + ảnh hiển thị decode + DOM quiet, có trần thời gian cứng và
`VisualSettleReceipt` tường minh.

## Requirements

- [ ] R1. `src/main/verification/capture-settle.ts`: `CaptureSettleGate` nhận các
  predicate inject được (test thuần): firstPartyNetworkIdle (giới hạn critical
  first-party, loại WebSocket/third-party), fontsReady (bounded),
  relevantImagesDecoded (chỉ ảnh trong viewport/chạm capture region, bỏ lazy-load
  xa), domQuiet (double-rAF ổn định). Mỗi cổng có timeout trần (vd 5s) → receipt
  ghi cổng nào vượt/mở.
- [ ] R2. `VisualSettleReceipt` `{ settleComplete, gates: {network, fonts, images,
  dom}, timingsMs, brokenImages: string[] }`.
- [ ] R3. V-18: ảnh vỡ (404/0×0) → `RESOURCE_FAILURE` tường minh, không che bằng
  mask, không pass ngầm.
- [ ] R4. Nối vào visualCompare trước capture (verification path) + thay thế wait
  ad-hoc trong `theme-qa-workflow.ts` (dùng gate với predicate mạng font ảnh DOM).
- [ ] R5. Not-ready → `INCONCLUSIVE / SETTLE_INCOMPLETE` (operational), không chụp.

## Implementation Steps

1. Module `capture-settle.ts` (pure, predicate-injected).
2. Adapter thật: network (FirstPartyNetworkTracker — check API), fonts
   (`document.fonts.ready` via evalJs), images decode (`img.decode()` trong
   capture region), DOM quiet.
3. Wire vào visualCompare + theme-qa-workflow.
4. Tests: Tier 1 (gate logic), Tier 2 (V-16/17/18 với mock host).

## Todo

- [ ] CaptureSettleGate pure implementation + receipts
- [ ] Network idle adapter (first-party critical, bounded)
- [ ] Fonts ready adapter (bounded)
- [ ] Relevant-image decode adapter (viewport/capture region, phát hiện broken)
- [ ] DOM quiet double-rAF adapter
- [ ] Wire visualCompare (SETTLE_INCOMPLETE gate)
- [ ] Thay settle ad-hoc theme-qa-workflow bằng gate
- [ ] Tier 1: gate tests; Tier 2: V-16, V-17, V-18

## Success Criteria

- V-16 font swap chậm → chờ/receipt settle, không false diff (Tier 2) — freeze #12
- V-17 ảnh decode trễ → gate đợi/resample (Tier 2) — freeze #12
- V-18 ảnh vỡ → `RESOURCE_FAILURE` tường minh (Tier 2) — freeze #12
- Không còn `setTimeout` settle ad-hoc trong theme-qa-workflow
- Suite hiện hữu không regress; `tsc --noEmit` sạch