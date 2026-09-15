---
phase: 6
title: "ConPTY flip + full verification"
status: pending
priority: P1
effort: "4h"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: ConPTY flip + full verification

## Overview
Thực hiện lật cờ mặc định ConPTY trên Windows (để hỗ trợ chuẩn các giao diện TUI như htop, progress bar, omp subagent view không bị duplicate dòng). Phase này bị chặn (gated) bởi kết quả kiểm tra A4.3 từ Phase 1: nếu teardown hang được khắc phục sạch sẽ (thông qua bản vá unref worker/timer hoặc quit watchdog), lật `DEFAULT_USE_CONPTY = true`. Tiến hành chạy toàn bộ test suite và benchmark so sánh A/B trước và sau toàn bộ quá trình tối ưu.

## Requirements
- Functional:
  - Kiểm tra cổng Phase 1: `scripts/repro-conpty-hang.cjs` phải thoát sạch sẽ (exit code 0) trong ≤ 5s mà không bị treo bởi event-loop ref.
  - Nếu cần: Áp dụng bản vá cho teardown trong `terminal-manager.ts` (unref worker socket / drain timer hoặc bổ sung watchdog forceExit tại `src/main/index.ts:before-quit`). **Lưu ý**: Tránh hủy socket `_outSocket` quá sớm khi `ClosePseudoConsole` đang chờ xử lý để ngăn deadlock luồng native; watchdog không được phép hủy các stream đang hoạt động (builds, DB transactions).
  - Đổi `DEFAULT_USE_CONPTY = true` trong `src/main/browser/terminal-manager.ts:215`.
  - Giữ nguyên cờ ghi đè khẩn cấp: `ANTIFAN_USE_CONPTY=0` vẫn bắt buộc fallback về winpty hoàn hảo.
  - Giữ nguyên cơ chế chốt tự động `conptyFailed`: nếu spawn ConPTY ném lỗi, tự động lùi về winpty cho các lần spawn tiếp theo.
- Non-functional:
  - Đáp ứng toàn bộ các tiêu chí chấp nhận A4.1 đến A4.6 trong contract.
  - Không có tiến trình `OpenConsole.exe`, `powershell.exe`, hay `conhost.exe` nào bị mồ côi sau khi đóng ứng dụng.
  - Đáp ứng các tiêu chí định lượng tuyệt đối kế thừa từ plan 260830: CPU khi idle < 3%, RAM renderer cơ sở < 450MB.

## Architecture
```
                   [A4.3 Teardown Repro Check]
                                │
                 Is exit clean in <= 5s?
                                │
                 ┌──────────────┴──────────────┐
               [YES]                          [NO]
                 │                              │
DEFAULT_USE_CONPTY = true          Apply watchdog / unref patch
(Full VT in-place redraw!)                      │
                                   Does it exit clean now?
                                        ┌───────┴───────┐
                                      [YES]            [NO]
                                        │                │
                         DEFAULT_USE_CONPTY = true    Keep winpty default
                                                      (Documented opt-in)
```

## Related Code Files
- Modify:
  - `src/main/browser/terminal-manager.ts` (lật DEFAULT_USE_CONPTY, hoàn thiện teardown hardening)
  - `src/main/index.ts` (bảo đảm quit watchdog không bị chặn bởi background workers)
- Benchmarks & Verifications:
  - `scripts/repro-conpty-hang.cjs`
  - `test/e2e/terminal-paint-bench.cjs`
  - `scripts/benchmark-electron-performance.mjs`
  - `npm run smoke:terminal`
  - `npm run test:terminal-transport`

## Implementation Steps
1. Chạy lại kịch bản kiểm tra teardown `scripts/repro-conpty-hang.cjs` với `ANTIFAN_USE_CONPTY=1`.
2. Nếu phát hiện hang:
   - Trong `terminal-manager.ts:safelyKillSession`: unref các timer còn sót và ngắt kết nối socket của conout worker một cách cưỡng bức trước khi kill process tree. **Lưu ý**: Tránh hủy socket `_outSocket` quá sớm khi `ClosePseudoConsole` đang chờ xử lý để ngăn deadlock luồng native.
   - Trong `src/main/index.ts`: thêm watchdog an toàn cho sự kiện `before-quit`/`will-quit` để đảm bảo app luôn terminate sau tối đa 5s. **Lưu ý**: Watchdog không được phép hủy các stream đang hoạt động (builds, DB transactions).
3. Chuyển `DEFAULT_USE_CONPTY = true`.
4. Chạy kiểm thử tương tác TUI: cho chạy một script sinh mã `\x1b[2K\r` liên tục trong 60 giây và quan sát xem màn hình có bị lặp dòng hay không.
5. Chạy test regression với `ANTIFAN_USE_CONPTY=0` để đảm bảo fallback winpty vẫn hoạt động chuẩn xác.
6. Chạy toàn bộ benchmark suite (`terminal-paint-bench.cjs` và `benchmark-electron-performance.mjs`). Xuất file báo cáo so sánh A/B `final-perf-comparison.json`.
7. Chạy test suite tích hợp `smoke:terminal` và `test:terminal-transport` đảm bảo 100% pass.

## Success Criteria
- [ ] `DEFAULT_USE_CONPTY = true` được bật an toàn mà không làm treo app khi thoát (Electron process thoát hoàn toàn trong ≤ 5s).
- [ ] Khi chạy TUI view hoặc bộ đếm thời gian, dòng được cập nhật tại chỗ mượt mà, không sinh thêm dòng rác.
- [ ] Cờ `ANTIFAN_USE_CONPTY=0` vẫn kích hoạt winpty thành công khi cần.
- [ ] Báo cáo benchmark chứng minh:
  - Độ trễ gõ phím không bị tăng.
  - Số tin nhắn IPC giảm đáng kể nhờ coalescing.
  - Chi phí parse/paint của tab ẩn giảm về xấp xỉ 0.
  - Persist stringify trên main-thread không còn gây đơ giao diện.
- [ ] `smoke:terminal` và `test:terminal-transport` pass toàn bộ.

## Risk Assessment
- Rủi ro: Một số phiên bản Windows 10 cũ hơn build 18309 không hỗ trợ ConPTY.
- Giảm thiểu: Hàm `supportsConpty()` đã có sẵn kiểm tra build OS ≥ 18309; nếu không thỏa mãn hoặc spawn ném lỗi, app tự động chuyển sang winpty.
