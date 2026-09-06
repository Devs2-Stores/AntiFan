---
title: "Phase 2: Capture coherence transaction"
status: todo
---

# Phase 2: Capture coherence transaction

## Overview

Lắp giao dịch chụp gắn kết hai nguồn (Audit v5 §9-10): rào cản
`{browserEpoch, documentGeneration, mutationRevision}` trước/sau mỗi phiên chụp
trên từng bên (ngang `observe()` tại `browser-control-port.ts:726-800`), và khoá
tài nguyên chung cho `compTabId` (P1-1) — hiện chỉ `tabId` qua
`passivePool.execute` (~2393).

## Requirements

- [ ] R1. `TwoSourceCoherenceGuard` TRONG `visual-capture.ts` (3-module cap cố định:
  visual-capture.ts, capture-settle.ts, baseline-authority.ts — không module thứ 4):
  snapshot identity per side trước mask-resolve; re-check sau capture xong;
  đột biến DOM → `RESAMPLE`; navigation/`documentGeneration` tăng → `TARGET_STALE`;
  lỗi bất đối xứng normalization một bên → hủy pixel diff với trạng thái `INCONCLUSIVE`
  (không so sánh tiếp).
- [ ] R2. Joint resource acquisition: dùng mutex khoá theo key (FIFO per-key promise
  queue) — `MultiKeyLock`, export từ `visual-capture.ts` — acquire nhiều key theo
  thứ tự định danh sắp xếp tất định `[tabId, compTabId]` để tránh race/deadlock.
  `PassiveExecutionPool` GIỮ vai trò capacity accounting cho primary tab như hiện
  hữu (đã xác minh `execute()` chỉ đếm 4/tab, 16/global, không xếp hàng/loại trừ —
  không dùng nó làm mutex).
- [ ] R3. Coherence trả về receipt `identityCoherent`, và kết quả visualCompare bổ
  sung trường `coherence`/`captureStateCompatible` (mở đường Phase 3).
- [ ] R4. Không đổi public IPC/MCP input schema của `browser.visual_compare`.

## Implementation Steps

1. Triển khai `TwoSourceCoherenceGuard` (pure, test được).
2. Triển khai `MultiKeyLock` trong `visual-capture.ts` (pure): per-key FIFO queue,
   acquire nhiều key theo thứ tự sắp xếp tất định, release trong finally; unit test
   thứ tự khoá + không deadlock + release khi throw.
3. Đọc identity từ host (`getDocumentGeneration`, `getBrowserEpoch`, mutationRevision
   — kiểm tra API hiện hữu ở `native-tab-host`/`tab-devtools-host`).
4. Nối vào visualCompare: snapshot → mask/rect resolve → capture → re-check.
5. Coverage thực thi: `passivePool.execute(tabId)` (capacity) bọc ngoài +
   `MultiKeyLock.acquire([tabId, compTabId])` bọc trong.
6. Tests Tier 2 (mock host) cho V-13, V-14, V-15 + race test 2 capture đồng thời.

## Todo

- [ ] `TwoSourceCoherenceGuard` pure implementation
- [ ] Host identity APIs trả về per-side (documentGeneration, browserEpoch, mutationRevision)
- [ ] Pre/post check trong visualCompare (RESAMPLE / TARGET_STALE)
- [ ] Asymmetric normalization → INCONCLUSIVE (hủy diff)
- [ ] `MultiKeyLock` (keyed FIFO, sorted multi-key acquire, release trong finally)
- [ ] Unit tests lock: serial hơn trên cùng key, song song trên key khác, không deadlock
- [ ] Joint lock: `passivePool` (capacity) + `MultiKeyLock` (loại trừ) phối hợp
- [ ] Tier 2 tests: V-13, V-14, V-15

## Success Criteria

- V-14 mutation giữa mask-resolve và capture → `RESAMPLE` (Tier 2) — freeze #7
- V-15 documentGeneration advance giữa chừng → `TARGET_STALE / INCONCLUSIVE` (Tier 2) — freeze #7
- V-13 normalization thất bại trên comp tab → `INCONCLUSIVE`, không pixel diff (Tier 2) — freeze #9
- `identityCoherent` receipt từ R3 → chứng #7 (Tier 2)
- P1-1 hết hở: comp tab nằm trong joint mutex — race test: 2 visualCompare đồng thời
  trên cùng cặp tab phải tuần tự hoá capture (Tier 2, mock host lưu vết thứ tự)
- MultiKeyLock unit: release khi action throw, entry thứ tự sắp xếp (Tier 1)
- Không regress suite hiện hữu; `tsc --noEmit` sạch