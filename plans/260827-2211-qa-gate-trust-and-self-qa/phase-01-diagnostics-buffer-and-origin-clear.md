---
phase: 1
title: "Diagnostics Buffer Clear + Origin-Scoped Capture"
status: done
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Diagnostics Buffer Clear + Origin-Scoped Capture

## Overview

`TabDiagnosticsManager` (tab-diagnostics.ts) giữ ring buffer console/network theo tab và **không clear khi navigate** — lỗi cũ từ trang trước làm sai kết quả QA của trang mới. Phase này: (1) clear buffer trên navigation, (2) gắn origin vào từng entry (first-party vs third-party) để phase 2 filter được.

## Requirements

- Functional:
  - Khi tab navigate, buffer console+network của tab đó được clear **TẠI `did-start-navigation` (đồng bộ)**, trước khi trang mới parse — không deferred tới `did-finish-load` (xem Risk, Red Team Finding 2).
  - Clear chỉ áp dụng cho main-frame navigation KHÔNG in-place VÀ pane có quyền điều hướng (`authorityPane === paneId`) — tái dùng chính xác gate tại native-tab-host.ts:1721-1725 (Red Team Finding 3: split-mode desktop/mobile share tabId; bỏ gate này → mobile mirror navigation xóa nhầm diag của desktop pane).
  - Mỗi `ConsoleDiagnosticEntry` và `NetworkFailureDiagnosticEntry` mang thông tin origin: URL/domain của nguồn, và cờ `isFirstParty` được tính so với URL hiện tại của tab.
  - Không clear buffer trên các navigation phụ (subframe, hash, HMR websocket) — chỉ main-frame navigation.
- Non-functional:
  - Không đổi contract công khai của `getDiagnostics` (thêm field optional, không xóa field).
  - Không thêm allocation/lặp vô ích trên hot path (mỗi console event 1 lần tính origin).
  - `computeOrigin` KHÔNG bao giờ throw trên source bất thường (`""`, `"eval at <anonymous>"`, `blob:`, `javascript:`, `data:`) — try/catch + fallback về origin của tab (Red Team Finding 7).

## Architecture

```text
webContents did-start-navigation (main frame, !isInPlace, authorityPane === paneId)
  → NativeTabHost handler (native-tab-host.ts:1721-1725 — gate ĐÃ tồn tại cho documentGenerations)
    → diagnosticsManager.clear(tabId)           // method ĐÃ tồn tại, tab-diagnostics.ts:88-92
      // CLEAR ĐỒNG BỘ TẠI ĐÂY — không chờ did-finish-load:
      // lỗi console phát trong lúc parse (trước finish-load) phải được GIỮ LẠI cho QA
  → 'console-message' / 'did-fail-load' events  (native-tab-host.ts)
    → recordConsole/recordFailure với entry mới có { origin, isFirstParty }
```

Origin tính: `computeOrigin(sourceUrl, baseUrl)` — parse hostname an toàn; source không parse được (`""`, `eval at ...`, `blob:`, `javascript:`, `data:`) → dùng origin của tab làm fallback + đánh dấu `isFirstParty` theo tab. So sánh hostname đã strip `www.` + lowercase. Asset third-party trong theme CDN (hstatic.net, shopifycdn...) nằm ngoài phạm vi phase này — phase 2 xử lý danh sách.

## Related Code Files

- Modify: `src/main/browser/tab-diagnostics.ts` (interface entry + helper `computeOrigin`)
- Modify: `src/main/browser/native-tab-host.ts` (navigation handler — xem vùng `wc.on('did-start-navigation')` ~line 1721 và handler console/failure nơi `recordConsole`/`recordFailure` được gọi)

## Implementation Steps

1. Trong `tab-diagnostics.ts`: thêm field optional vào cả 2 interface:
   - `ConsoleDiagnosticEntry`: `origin?: string; isFirstParty?: boolean`
   - `NetworkFailureDiagnosticEntry`: `origin?: string; isFirstParty?: boolean`
   - Thêm export `computeOrigin(sourceUrl: string, baseUrl: string): { origin: string; isFirstParty: boolean }` — try/catch quanh `new URL()`; non-parseable source → fallback `baseUrl` + `isFirstParty: true`; parse được → so sánh hostname (strip `www.`, lowercase, suffix-match `hostname === base || hostname.endsWith('.' + base)` — base LUÔN là hostname cụ thể của storefront tab, KHÔNG phải apex platform).
2. `grep` tìm toàn bộ call sites `recordConsole`/`recordFailure` trong `native-tab-host.ts` — mỗi call site truyền thêm `origin`/`isFirstParty` tính từ URL active tab tại thời điểm đó.
3. TRONG navigation handler `did-start-navigation` (~1721): ngay trong block `if (isMainFrame && !isInPlace && authorityPane === paneId)` hiện có (nơi đang tăng `documentGenerations`), thêm `this.diagnosticsManager.clear(tabId)` — cùng điều kiện, cùng vị trí. KHÔNG clear tại `did-finish-load`; KHÔNG clear trên `did-navigate-in-page` (hash) hoặc subframe; KHÔNG clear khi pane khác mirror navigation (split-mode).
4. Xác minh ring buffer không bị xóa khi clear giữa chừng ghi (clear đồng bộ tại start, các record sau đó ghi vào buffer mới — thứ tự event đảm bảo).

## Success Criteria

- [ ] Navigate A→B trên 1 tab: `getDiagnostics(tabId)` sau khi B load xong không chứa entry nào của A.
- [ ] Lỗi console phát trong lúc B parse (trước `did-finish-load`) vẫn còn trong buffer khi QA chạy.
- [ ] Hash navigation / subframe load không clear buffer.
- [ ] Split-mode: mirror navigation ở mobile pane KHÔNG clear diag desktop pane (gate `authorityPane`).
- [ ] Entry mới có `origin` + `isFirstParty` đúng (test đơn vị với URL mẫu: `https://store.example.com` vs `https://www.google-analytics.com`; entry với source `""` / `"eval at <anonymous>"` không throw).
- [ ] `npm run typecheck` xanh.

## Risk Assessment

- **Clear đồng bộ tại start (Red Team Finding 2 — đã đảo thiết kế)**: phương án cũ (pendingClear tại did-finish-load) XÓA lỗi bootstrap — console error phát trong lúc parse trước finish-load bị wipe → fail chính xác là thứ QA phải bắt. Đổi: clear đồng bộ tại start. Trang mới fail-load hoàn toàn (network die) → `did-fail-load` ghi `recordFailure` (native-tab-host.ts:1738) — không mất dấu vết.
- **Split-mode share tabId (Red Team Finding 3)**: desktop/mobile pane ghi chung bucket `tabId` (native-tab-host.ts:1713,1738). Bỏ gate `authorityPane === paneId` → mobile mirror navigation xóa diag desktop. Đã fix bằng cùng gate với `documentGenerations`.
- **`computeOrigin` throw (Red Team Finding 7)**: `new URL('')` / `new URL('eval at ...')` ném TypeError trong event handler main process → crash listener. Fix: try/catch toàn bộ; source không parse được → fallback origin tab + `isFirstParty: true` (inline script thuộc trang).
- **Rủi ro origin tính sai với `www.`/subdomain**: dùng quy tắc suffix-match đơn giản (hostname == base || hostname.endsWith('.' + base)) với base = hostname storefront tab — đủ cho Haravan/Sapo/Shopify, không cần eTLD+1. KHÔNG dùng apex platform (myharavan.com/myshopify.com) làm base → tránh tenant khác bị tính là first-party.

<!-- Updated: Red Team Session 1 - Findings 2, 3, 7 (clear-at-start sync, authorityPane gate, computeOrigin try/catch) -->