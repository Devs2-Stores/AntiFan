# Soak 2h post-fix — verdict và bằng chứng (2026-09-19)

Run: `scripts/benchmark-real-soak-8h.cjs`, `SOAK_DURATION_MINUTES=120` (warmup 30 / workload 60 / recovery 30)
Cửa sổ: 08:24:24 → 10:24:24 (local), profile `.antifan-soak-8h`, token bridge inject qua `ANTIFAN_BENCHMARK=1`, 6 tab + 1 terminal thật, 122 mẫu, 0 phút máy sleep.
Nguồn số: `real-soak-2h.json` (final payload của harness) + `real-soak-2h-checkpoint.json` (mẫu từng phút).

## 1. Verdict

**`FAILED`** (`status: failed`, process exit 1). Hai gate đỏ:

| Gate | Ngưỡng | Đo được | Kết quả |
|---|---|---|---|
| `slopeOk` (renderer) | ≤ 0.15 MB/min | **0.208** | ✗ |
| `slopeOk` (overall) | ≤ 0.35 MB/min | 0.124 | ✓ |
| `latencyOk` (switch max) | ≤ 35 ms | **42.112** | ✗ |
| `latencyOk` (p50 / p95) | ≤ 12 / ≤ 18 ms | 4.972 / 6.821 | ✓ |
| `memoryOk` (peak active) | ≤ 1600 MB | 1549.71 | ✓ |
| `processOk` (orphan) | 0 | 0 | ✓ |
| `executionOk` | không lỗi | không lỗi | ✓ |
| `teardownOk` | không degraded | 6/6 tab + terminal đóng | ✓ |

## 2. Số đo chính

- RAM active: min 1511.75 / p50 1529.57 / p95 1542.78 / max 1549.71 MB — postWarmup 1535.29, finalActive 1541.09, recovered 1026.71 MB.
- Bộ đếm workload: switches 1756 · bursts 180 · reloads 40 · terminalEvents 784 · openedTabs 6.
- Teardown telemetry: `tabsToClose 6 / tabsClosedSuccess 6 / tabsClosedFailed 0`, `terminalClosedSuccess true`, `teardownDegraded false`.

## 3. Renderer creep: tăng liên tục, không phải nhiễu đầu cửa sổ

OLS trên các cửa sổ trượt của 60 mẫu `workload` (đơn vị MB/phút):

| Cửa sổ | Total | Renderer |
|---|---|---|
| Last 60 (toàn workload) | 0.125 | **0.208** |
| Last 40 | 0.324 | **0.235** |
| Last 20 | 0.501 | **0.194** |

Renderer không phẳng lại khi bỏ 20 phút đầu (0.208 → 0.235 → 0.194) ⇒ không phải hiện tượng ramp/cache ấm dần. Phân rã theo lớp trên toàn workload: renderer +0.208, gpu +0.019, other +0.009, utility −0.001, browser −0.110 — toàn bộ creep nằm ở renderer (5 tiến trình), biên độ tuyệt đối nhỏ: 717.16 → 727.28 MB (+10.12 MB/60 phút). Lưu ý total slope của cửa sổ ngắn lại cao hơn cửa sổ dài (browser giảm sớm bù trừ cho renderer tăng đều).

## 4. Đối chiếu pre-fix / post-fix

| Chỉ số | Partial 4h pre-fix (40 mẫu workload) | Run 2h post-fix (60 mẫu workload) |
|---|---|---|
| `bursts` | 0 trên toàn bộ 71 mẫu | 180 (2/phút, cả warmup lẫn workload) |
| `terminalEvents` | 3 | 784 |
| Total slope | 0.349 | 0.125 |
| Renderer slope | 0.263 | 0.208 |
| Renderer cuối | 758.74 MB | 727.28 MB |

⇒ Đường RPC terminal của harness đã sống lại sau fix bridge (`9134ed37`), và cả hai lần đo đều trượt gate renderer (0.263 / 0.208) ⇒ đặc tính tái lập được, không phải hệ quả của fix.

## 5. Hiệu lực phép đo (phủ định giả thuyết "đo nhầm app")

PID 40468 (`electron.exe --production`, tạo 08:24:13) là **main process của app soak**: con trực tiếp của harness PID 32524, và là tiến trình duy nhất LISTEN `127.0.0.1:20129` với cặp `ESTABLISHED 20129 ↔ 56292 (harness)`. App nhận `ANTIFAN_USER_DATA` qua env nên main process không mang cờ `--user-data-dir` (các con renderer/gpu/utility mang `--user-data-dir=E:\Work\.antifan-soak-8h\Profile`). Instance dev của máy (PID 42724 `--allow-eval` + nhóm profile `.antifan-data`) không giữ port này và không nằm trong cây được lấy mẫu. ⇒ Workload chạy đúng trên app được đo.

## 6. Nhánh `fix/mobile-terminal-plane-gates` (verify hậu soak)

Base `9134ed37` → `080c9cba` (gate 4 handler lifecycle/resize/restart) → `f4e78ae0` (gate input/sendKey khi thiếu `sessionId`, align thứ tự `p.id || p.sessionId` ở dispatch, test fail-closed).

- `node --test .compiled/test/main/bridge-server.test.js` → **29/29 pass** (block `Bridge terminal write planes`: 3/3, gồm ca "refuses every terminal method for a grant with no terminal session bound (fail-closed)").
- `npm run compile` trả exit 2 **không liên quan nhánh**: lỗi ở `scripts/probes/sapo-boundary-probe.ts` thiếu `packages/site-clone/dist/index.js` — thư mục `dist` là build output không được track, có trong cây chính (`true`) nhưng không có trong worktree mới checkout (`false`); tsc vẫn emit và toàn bộ test chạy được.
- Nhánh chưa merge; worktree review: `E:/Work/apps/AntiFan-wt-mobile-plane-gates`.

## 7. Việc còn lại (đề xuất, chưa làm)

1. Điều tra renderer creep (tái lập 2/2 run, ~+0.2 MB/phút, chỉ renderer) — cần tìm điểm giữ heap trong renderer trước khi kết luận "leak".
2. Spike switch max 42.1 ms (1/1756 lần vượt 35 ms, p95 chỉ 6.8 ms) — xác định outlier đơn lẻ hay có điều kiện lặp.
3. Quyết định (a) giữ mobile plane fail-closed (hiện trạng, `grant.sessionId` là control-plane id không nối session) hay (b) nối grant → terminal session thật cho companion mobile.
