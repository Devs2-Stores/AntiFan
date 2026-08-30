---
phase: 4
title: "Automated 4-Stage Endurance Soak Test Suite & Process Lifecycle Verification"
status: completed
priority: P1
effort: "2-3d"
dependencies: ["phase-03-agent-session-resume-and-memory-defense"]
---

# Phase 4: Automated 4-Stage Endurance Soak Test Suite & Process Lifecycle Verification

<!-- Updated: Validation Session 1 - Default short run + --endurance flag confirmed -->

## Overview
Xây dựng và tự động hóa bộ kiểm thử ngâm tải 4 giai đoạn (Automated 4-Stage Soak Test Suite) để đo lường độ dốc tăng bộ nhớ thực tế, độ trễ tương tác khi stream dữ liệu lớn, và kiểm chứng việc dọn sạch $100\%$ các tiến trình PTY con trên cả Windows và POSIX. Mặc định chạy ở chế độ rút gọn (15–30 phút cho dev/CI) và hỗ trợ cờ `--endurance` cho bài ngâm tải dài 2–4 giờ khi chuẩn bị release.

---

## Requirements

### Functional:
1. Xây dựng kịch bản kiểm thử E2E `test/e2e/soak-test.test.ts` (và lệnh CLI `npm run benchmark:soak`):
   - **Chế độ mặc định (Rút gọn 15–30m cho CI/Local dev):** Chạy kiểm tra nhanh 4 giai đoạn với tần suất cao.
   - **Chế độ Endurance (`--endurance` - 2–4h cho Release Gate):**
     - **Giai đoạn 1 (Idle Baseline - 15m):** Mở 5 tab storefront (desktop/mobile split), đo mức RAM tĩnh của Main và Renderer.
     - **Giai đoạn 2 (Streaming Stress - 30m):** Bơm stream log liên tục $100\text{ KB/s}$ vào PTY, đo độ trễ phím và hàng đợi của dispatcher.
     - **Giai đoạn 3 (Mixed Stress - 45m):** Vừa stream log, vừa chuyển tab mỗi 15s, vừa kích hoạt Theme QA ngầm.
     - **Giai đoạn 4 (Endurance Soak - 2–4h):** Chạy lặp 50 lần reload trang, 30 lần quét QA, 100 lần pick phần tử; lấy mẫu RAM định kỳ và tính độ dốc hồi quy tuyến tính bộ nhớ ($\beta$).
2. Kiểm tra dọn sạch tiến trình:
   - Sau khi kết thúc test, kiểm tra danh sách tiến trình hệ điều hành: Đảm bảo $0$ tiến trình `node-pty`, `conpty`, `taskkill` hoặc shell con bị bỏ rơi.
3. Xuất báo cáo tự động:
   - Tạo file báo cáo JSON `soak-benchmark-report.json` ghi nhận p50, p95 độ trễ, RAM delta, và độ dốc $\beta$.

### Non-Functional:
- Test runner có thể chạy được ở chế độ headless hoặc CI-safe.

---

## Architecture & Telemetry Formulas

```
+---------------------------------------------------------------------------------+
|                         4-STAGE SOAK TEST SUITE RUNNER                          |
|                                                                                 |
|  [Stage 1: Idle 15m]        ---> Record Baseline RAM (Main RSS, Renderer RSS)   |
|  [Stage 2: Stream 30m]      ---> 100 KB/s PTY Stream -> Measure Keystroke Lag   |
|  [Stage 3: Mixed 45m]       ---> Stream + Tab Thrash + Background QA Scans      |
|  [Stage 4: Long Soak 2-4h]  ---> 50 Reloads, 30 QA Runs, 100 Element Picks      |
|                                                                                 |
|                         [Linear Memory Slope Analysis]                          |
|                         Slope Beta = Cov(t, RAM) / Var(t)                       |
|                         Target: Beta <= 0.05 MB/min [MỤC TIÊU ĐỀ XUẤT]          |
|                                                                                 |
|                         [Zombie Process Verification]                           |
|                         tasklist / ps aux -> 0 Orphan PTY Children              |
+---------------------------------------------------------------------------------+
```

---

## Related Code Files
- Create: `test/e2e/soak-test.test.ts` (Kịch bản kiểm thử E2E tự động)
- Modify: `scripts/benchmark-electron-performance.mjs` (Bổ sung kịch bản chạy soak test)
- Modify: `package.json` (Thêm script `benchmark:soak`)
- Test: `test/main/performance-benchmark-contract.test.ts` (Kiểm chứng hợp đồng đo đạc)

---

## Implementation Steps

1. **Xây dựng bộ đo Memory Slope (`test/e2e/soak-test.test.ts`)**:
   ```typescript
   function calculateMemorySlope(samples: Array<{ timestamp: number; rssBytes: number }>): number {
     const n = samples.length;
     if (n < 2) return 0;
     const meanT = samples.reduce((acc, s) => acc + s.timestamp, 0) / n;
     const meanM = samples.reduce((acc, s) => acc + (s.rssBytes / (1024 * 1024)), 0) / n;
     let num = 0, den = 0;
     for (const s of samples) {
       const dt = (s.timestamp - meanT) / 60000; // minutes
       const dm = (s.rssBytes / (1024 * 1024)) - meanM; // MB
       num += dt * dm;
       den += dt * dt;
     }
     return den === 0 ? 0 : num / den; // MB/min
   }
   ```
2. **Hiện thực hóa 4 giai đoạn tải trong test**:
   - Sử dụng `ElectronApplication` hoặc mock harness để điều khiển app thực tế.
   - Ghi nhận `process.memoryUsage().rss` mỗi 60 giây.
3. **Kiểm tra tiến trình mồ côi (Process Tree Verification)**:
   - Trên Windows: chạy `tasklist /FO CSV` và lọc theo PID của shell con.
   - Trên POSIX: chạy `ps -ef` và xác nhận không còn zombie process.
4. **Tích hợp vào package.json**:
   - Thêm `"benchmark:soak": "node scripts/benchmark-electron-performance.mjs --soak"`.

---

## Success Criteria
- [ ] Chạy hoàn tất 4 giai đoạn ngâm tải (mặc định rút gọn hoặc `--endurance`) mà không bị crash.
- [ ] Báo cáo đo lường xuất ra file JSON với đầy đủ số liệu thực tế đo được.
- [ ] Độ dốc tăng RAM `[MỤC TIÊU ĐỀ XUẤT — CHƯA ĐO: Beta <= 0.05 MB/min]`.
- [ ] Sau khi runner kết thúc, số lượng tiến trình PTY zombie bằng 0.

---

## Risk Assessment
- **Rủi ro:** Chạy bài test 4 giờ trong môi trường CI có thể gây timeout.
- **Biện pháp:** Hỗ trợ cờ `--short` (mặc định cho CI) và cờ `--endurance` (cho local release benchmark).
