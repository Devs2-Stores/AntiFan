---
phase: 4
title: "Phase 4: O(1) Session Routing"
status: done
priority: P1
effort: "2d"
dependencies: [3]
---

# Phase 4: O(1) Session Routing

## Overview
Main giữ map `sessionId → Set<NativeTabHost>` hiển thị; chunk chỉ giao cho host liên quan thay vì mọi host tự lọc.

## Requirements
- Functional: router trung tâm đăng ký 1 listener `data` duy nhất trên `DaemonTerminalProxy`; host đăng ký/huỷ theo visibility; popout/terminal window (theo lifecycle `terminalWindowMeta`) và Unassigned/manager host (`managerAll`) luôn nằm trong route của session phù hợp.
- Non-functional: giữ coalescing 4ms và bypass ≤256B hiện có (`native-tab-host.ts:118-120, 9596-9618`).

## Architecture
Hiện mỗi host `setupTerminalSubscriptions` (:1688-1790) nghe mọi chunk. Router mới: `src/main/browser/terminal-output-router.ts` cập nhật map khi session event/affiliation đổi.

## Related Code Files
- Create: `src/main/browser/terminal-output-router.ts`
- Modify: `native-tab-host.ts` (:1688-1790), `src/main/index.ts` (khởi tạo router cạnh daemon proxy :2315-2337)

## Implementation Steps
1. Test đỏ: 7 host, 1 session → chỉ host sở hữu nhận chunk.
2. Implement router; host bỏ listener `data` global.
3. Dispose khi host đóng (không leak listener).

## Success Criteria
- [ ] Số lần `isSessionVisibleToWindow` gọi mỗi chunk = 0 (tra map)
- [ ] N=7 main p99 < 50ms khi burst
- [ ] Popout và Unassigned window vẫn nhận output (test riêng)
- [ ] Không leak listener sau đóng/mở 20 lần (`emitter.listenerCount`)

## Risk Assessment
Session chưa có owner (Unassigned) phải vẫn tới window Unassigned. Tín hiệu: session mất output. Phản ứng: map fallback theo quy tắc cũ, có test.
