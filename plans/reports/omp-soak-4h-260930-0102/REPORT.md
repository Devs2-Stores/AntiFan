# REPORT — Soak AntiFan 4h (nhánh soak/overnight-260930)

Trạng thái: **A hoàn thành theo đường KHÔNG-OMP** (theo chỉ đạo user "Bỏ qua OMP, chạy Soak đo lại"). B/C: **không sửa** (xem lý do). Đây là soak app thật qua bridge WS (`scripts/benchmark-real-soak-8h.cjs`), KHÔNG phải `run-omp-soak.cjs`, nên **không có** bảng theo nhóm tool MCP/OMP (callOk / mã lỗi / heavy_*): CHƯA ĐO ĐƯỢC. Cần sửa `smoke-omp-closed-loop.cjs` để chạy dưới Electron (xem INC-3) trước khi đo.
## Phần A — Soak mốc chuẩn (240 phút, run `a260930f`)

Nguồn: `summary-A.json` (= report của harness), `logs-soak-A3.txt:43-58`, `samples-A-checkpoint.json`, `machine-A.jsonl` + `machine-A-tail.jsonl`.


**Giới hạn phủ giám sát (công khai):** death-watcher (bg_54) chỉ chạy tối đa 200 phút (mặc định `MaxMinutes`), KHÔNG phủ ~40 phút cuối của soak 240 phút → không khẳng định "không có death" cho cả run; bằng chứng sống sót cuối run là harness exit 0 + verdict PASSED. Sampler máy bị tách 2 file (`machine-A.jsonl` + `machine-A-tail.jsonl`, gộp theo epochMs, 237 mẫu ≈ 240 phút, có thể có khoảng hở quanh lúc đổi sampler ~07:00). Đây là soak thật **phụ trợ, cô lập** (`.soak-iso`, tag `a260930f`), KHÔNG phải baseline OMP đã yêu cầu. Guard `SOAK_DATA_ROOT` (leaf `.antifan-soak-*` và phải chưa tồn tại) được thêm SAU khi A3 khởi chạy; A3 chạy với bản chưa có guard (root `.antifan-soak-a260930f` là thư mục mới nên không xoá gì).
Chạy trong bản clone đóng băng `E:\Work\.soak-iso` (bundle md5 ed86b429…, không đổi trong run) với data root riêng `E:\Work\.antifan-soak-a260930f`. Root PID app 19828 (`logs-soak-A3.txt:52`). Điều kiện: 6 tab, 1 terminal session, warmup 5m / workload 229.21m / recovery 5m. **Verdict: PASSED, exit 0.**

| Gate | Đo được | SLO |
|---|---|---|
| Overall slope (heap/RSS tổng) | 0.216 MB/min | ≤ 0.35 |
| Renderer slope | −0.021 MB/min | ≤ 0.15 |
| App-owned private max slope | 0.1055 MB/min (pid 19828 Browser) | ≤ 0.15 |
| Final active p50 / peak | 1246 / 1274 MB | ≤ 1600 |
| Recovered sau teardown | 754.5 MB | — |
| Tab switch workload (n=4354) | p50 6.76ms, p95 9.12ms, max 291ms | ≤12 / ≤18 |
| Orphan processes | 0 | 0 |

- Vòng lỗi / flight treo: harness này không có khái niệm inFlight; không đọc được → null.
- CPU app (workload): 4362s tổng = 19.0 s/min; consumer lớn nhất GPU process pid 8516: 1376s (31.5%) (`logs-soak-A3.txt:56-57`). Đây là cận dưới (2 pid không có mặt ở cả hai đầu).
- Switch chậm nhất: `/store-home` max 3437ms — thuộc warmup (`logs-soak-A3.txt:51`), không được chấm.
- Process tăng nhanh nhất: Browser pid 19828, 0.108 MB/min (WS). Tăng WS đầu→cuối: renderer 7956 +25MB, GPU 8516 +23.5MB, 19828 +22.8MB; handles của 19828 giảm 115 → không có dấu hiệu leak handle.
- GPU/RAM/CPU máy (`machine-A*.jsonl`, 237 mẫu, 60s/mẫu, 03:54–07:53 +07): CPU tổng p50 45.8%, p95 85.7%, max 100%; **8 mẫu >90% (nhiễu do máy bận, không dùng làm bằng chứng)**. RAM trống min 7087MB, p50 8088MB (không đổi giữa đầu/giữa/cuối: 8078/8024/8128). GPU 3d max/engine: p50 11.6%, p95 14.5%, max 18.5%. Tổng WS của cây process giảm dần 1237 → 1157 → 1032MB (đầu/giữa/cuối). Lưu ý: cột CPU máy gồm cả tiến trình ngoài soak.
- Tool có trong tools/list mà chưa gọi: không đo được (không đi qua MCP).

### Sự cố (chi tiết `incidents.md`)
- INC-3: smoke OMP không khởi động dưới Electron (`require.main === module` false, nên `runElectronWorkload()` không bao giờ chạy). Sửa thử bị user chỉ đạo bỏ (revert); chưa sửa.
- INC-5/6: 3 lần soak đầu hỏng: trùng launch, bundle "stale" do compile ngầm của session khác (WIP), và **app bị giết lúc ~81 phút** ở run dùng data root chung (`real-soak-A-part1.json`): 5 renderer `killed` cùng ms, không có shutdown/crash dump. **Nguyên nhân KHÔNG xác định**; KHÔNG chứng minh được giết bởi OS (PID của Win32k mitigation event 10 không khớp root 11088). Run cô lập sau đó sống qua 240 phút (harness exit 0); watcher không ghi sự cố trong 200 phút đầu nó phủ, không phủ ~40 phút cuối.
- Sampler cũ chạm giới hạn 280 phút giữa run; đã bật `machine-A-tail.jsonl` nối tiếp (chồng thời gian được sắp xếp/loc theo epochMs).
- `part2` 155 phút đã bị huỷ (không hợp lệ để nối); không ghép với run hỏng.

## Phần B/C
**Không có bản sửa perf.** Tất cả SLO đạt; không có điểm nghẽn có bằng chứng số + dòng code + sửa nhỏ. Đề xuất (chưa sửa):
1. GPU process chiếm 31.5% CPU app — cần đo với GPU bật/tắt và xem nguồn compositing (cần harness có điều kiện GPU).
2. Warmup switch 3.4s tới `/store-home` — 1 mẫu; cần lặp lại mới kết luận.
3. Sửa `smoke-omp-closed-loop.cjs` guard dưới Electron để đo nhóm heavy_*/theme_qa (cần storefront/theme hợp lệ cho QA).
4. `SOAK_DATA_ROOT` có guard (leaf `.antifan-soak-*` VÀ phải chưa tồn tại) — chỉ trong bản clone `.soak-iso`, không nằm trong repo. Đã kiểm chứng đường từ chối: `node --check` OK; đường dẫn đã tồn tại (`.antifan-soak-guardtest` có file sentinel) và tên sai (`badname`) đều exit 1 với "Refusing", sentinel còn nguyên, `badname` không được tạo. Đường chạy thành công của bản đã guard CHƯA chạy lại (A3 chạy bản trước guard).
C (soak lại) không chạy vì B không có commit sửa.

## Test
- Mốc: `tests-baseline.txt` — typecheck 0, test:fast 1726/1726, selfcheck 12/12.
- Cuối: `tests-final.txt` — typecheck OK, test:fast 1726/1726 pass, fail 0, selfcheck 12/12. **Không FAIL mới.**

## Process / dọn dẹp
- `killed.log`: các process AntiFan cũ đã đóng ở đầu goal. Cuối: chạy lại `list-antifan.ps1` sau khi sampler (bg_55) và watcher (bg_54) đã thoát — không liệt kê process AntiFan/electron nào của goal. Dòng `chain=`/`protectedRoots=` là tổ tiên của shell hiện tại, đã xác minh bằng `tools/who.ps1`: omp.exe 14856 → powershell 7560 → Orca.exe 16396 → Orca.exe 9368 → explorer.exe 11112 (được bảo vệ, không thuộc AntiFan, không kill). PID 2508 (powershell) trong truy vấn CIM là chính lệnh truy vấn — đã thoát khi kiểm tra lại. Leftover do goal tạo: không còn; process môi trường/được bảo vệ: các PID trên. App không được mở lại.

## Commit trên nhánh (`git log --oneline main..HEAD`)
```
f4105923 chore(reports): refresh verification telemetry from full-suite run   <- KHÔNG phải của goal (session khác commit lên nhánh này)
8ccc3ec4 feat(project): one Project model ...                                  <- KHÔNG phải của goal
568d9dc8 fix(soak): declare rpcId before tools/list call
13f9144a test(soak): measure heavy MCP families in OMP closed loop
```
**Lưu ý:** working tree còn WIP của session khác nên `git status` không sạch; goal không đụng vào. 568d9dc8 (hoist rpcId) chưa được chạy runtime vì harness OMP chưa khởi động được.

Bỏ toàn bộ: `git switch main && git branch -D soak/overnight-260930` (nhưng 2 commit không phải của goal cũng nằm trên nhánh này — kiểm tra trước khi xoá).
Artifact OUT untracked; bản clone `E:\Work\.soak-iso` và `E:\Work\.antifan-soak-*` xoá tay khi không cần.
