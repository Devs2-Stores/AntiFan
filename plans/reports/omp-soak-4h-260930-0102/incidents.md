# Sự cố — omp-soak-4h-260930-0102

## INC-1: Lần chạy list-antifan.ps1 đầu trả rỗng
- 01:03 liệt kê được 0 process dù sau đó thấy electron 4076 + tsc chạy.
- Nguyên nhân: khi chạy lần đầu (00:5x–01:03) các process đó chưa tồn tại; app được explorer launch 01:04:18 và compile chain do app tự spawn khi khởi động. Không phải bug của script — rerun 01:05 liệt kê đủ (procs-precleanup.json).

## INC-2: Session khác vừa chạy app trước goal
- Explorer spawn `electron.exe E:\Work\apps\AntiFan --allow-eval` lúc 01:01–01:04, cùng `npm run compile`/`tsc` (PID 4008/18880, ppid→npm run compile→cmd, đã thoát 01:05).
- Working tree có 43 file sửa + 24 untracked không thuộc goal này (git-before.txt). Goal KHÔNG chạm vào WIP đó.
- Đã đóng app theo scope (a): killed.log ghi từng PID (6136 crashpad FORCE, 5080 terminal-daemon FORCE; root 4076, 7088, 3676, 7056, 4852 tự thoát trước khi kiểm tra lại).

## INC-3 (BLOCKER): Electron smoke harness không vượt qua startup — 2 lần runner timeout + 1 single-shot exit, không chạy được giai đoạn A
- `node scripts/run-omp-soak.cjs --minutes 2` (bg_8, logs-probe.txt:16–20): timeout 600s, stdout dừng ở dòng `run-electron` + `chrome_100_percent.pak` error.
- Lặp lại (bg_11, logs-probe2.txt:16–20): timeout 300s, cùng điểm dừng.
- Chẩn đoán bổ sung `node scripts/run-electron.cjs scripts/smoke-omp-closed-loop.cjs --iterations 1 --quiet --headless` (bg_15, logs-single.txt): thoát với exit=255 sau 81s nhưng log vẫn chỉ tới pak error — không tới `runElectronWorkload`.
- Electron desktop (PID 4076) khởi chạy qua explorer ngay trước đó → binary không hỏng. `chrome_100_percent.pak` cũng xuất hiện trong debug.log mọi launch (7136–7165); `[INFERENCE]` không đủ chứng minh nó vô hại — root cause UNKNOWN.
- Giả thuyết `[INFERENCE]` (không chứng minh được trong giới hạn retry): Electron spawn từ shell OMP không vượt qua `app.whenReady`/module init trong môi trường phi-interactive — cần session debug có chủ đích.
- Kết luận: đã hết số lần chạy lại cho phép (tối đa 2) → giai đoạn A BLOCKED. Không có samples-A.jsonl/summary-A.json (không tạo được — không ghi null-giả). Không sang B/C.
- Dọn: 13116/8544/3312 killed (FORCE sau stop nhẹ 10s), 11172/16672/18564/11352 đã tự thoát. Inventory cuối: 0 process AntiFan còn lại.

## INC-4: Chuyển sang đường soak non-OMP (user directive) — smoke-omp guard revert
- User chỉ đạo: "Qua OMP, chạy Soak do lai tat ca cai còn lai theo Goal cu di" → hiểu là bỏ đường OMP (`run-omp-soak`/`smoke-omp-closed-loop`) và chạy lại soak.
- Chọn `scripts/benchmark-real-soak-8h.cjs` (runner non-OMP, spawn app thật, đo RAM/CPU/GPU/switch latency, có `--minutes`).
- Sửa guard `require.main===module` của smoke-omp (đã commit TDZ fix trước đó) đã REVERT về HEAD theo directive (guard vẫn là bug đã chứng minh: `require.main` là module electron nội bộ → `runElectronWorkload` không bao giờ được gọi; probe .tmp/elec-main.cjs: `require.main === module: false`).

## INC-5: 2 lần chạy 240m fail sớm
- Lần 1 (bg_21+bg_22): mình launch trùng 2 run (timeout cap 3600s < 4h, định relaunch timeout 0). bg_21 kill → app tree chết; bg_22 attach vào bridge cũ trên port 20129 (`E:\Work\.antifan-soak-8h/config/bridge.json` shared root), openTab timeout → FAILED (logs-soak-A.txt lần 1).
- Lần 2 (bg_27/bù trừ): bundle bị refuse "stale" vì session ambient tiếp tục sửa src → `inspectCompiledBundle` thấy input mới hơn emit. Compile xong → `inspectCompiledBundle` xác nhận `state:'fresh'` (reason 'compiled bundle is current') mới relaunch.
- Lần 3 (bg_30): warmup bắt đầu 2:00:22, keep-awake PID 8712, bridge 20129, 6 tabs mở. Bundle md5 97f68fa252c03ef393e39f038d61cb95 (probe trước: 68bb8f88 → drift do ambient compile; rủi ro drift trong run vẫn tồn tại — sẽ đọc `bundleDrift` trong report cuối).

## INC-6: Run A lần 3 (bg_30) chết lúc warmup — Electron exit code 1 + bundle drift
- App exit 1 ~02:1x; report FAILED (6 tabs/terminal không đóng được). `bundleDrift`: md5 97f68fa→ed86b429 do session ambient chạy `tsc -p .` (PID 12220 lúc 02:03) trong lúc soak → app tự compile giữa run.
- Root cause exit 1 `[INFERENCE]`: child crash khi .compiled bị ghi đè giữa run.
- Fix: clone đóng băng `E:\Work\.soak-iso` (cp src/.compiled/scripts/test/package.json/tsconfig/main.cjs + junction node_modules). Lần launch đầu fail "Bridge server failed to initialize" vì thiếu `main.cjs` trong iso (child exit ngay, stdout/stderr rỗng). Copy main.cjs xong probe trực tiếp OK (bridge started, tabs/layout, terminal PTY).
- Lần 4 (bg_43): warmup bắt đầu ~02:17, bundle ed86b429 (đóng băng — ambient compile không ảnh hưởng iso), keep-awake 4212. Sampler đã widen scope `.soak-iso` và xác nhận bắt cây runner 19136/electron 11088.
