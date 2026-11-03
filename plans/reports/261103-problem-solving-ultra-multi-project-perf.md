# Problem-solving --ultra: chọn tập sửa hiệu năng đa dự án (2026-11-03)

Packet: local://ultra-ps-evidence-packet.md. Nguồn: plans/reports/261103-scout-ultra-multi-project-perf.md.
Nhãn: {"A": "PsC3", "B": "PsC5", "C": "PsC1", "D": "PsC2", "E": "PsC4"}. Same-tier best-of-5 (5/5 usable).

## Winner (E = PsC4), nguyên văn

# Quyết định: tập sửa cho lần chạy này (Ứng viên 4)

## 1. Kỹ thuật: Scale Game, kèm Inversion cho ranh giới bảo mật
- **Scale Game.** Đẩy tải lên cực đại là 16 PTY, 42 client MCP và 410–669 frame/s. Khi đó chỉ chi phí kiểu `frame × client × lookup` mới tăng tuyến tính ngoài kiểm soát. Điều này khớp với số đo: `broadcastEvent` chiếm 16,6% và 17k–28k lần resolve mỗi giây.
- **Inversion.** Hỏi ngược "sửa thế nào để gây ra lỗi bảo mật hoặc mất dữ liệu". Câu trả lời là index `webContents.id` cũ (U03) và persist trễ (U10). Hai mục này chỉ được làm khi giữ được fail-closed.
- **Áp vào bài này.** Sau khi U01 gỡ khoảng 16,6%, mọi mục còn lại đều nhỏ (≤2,35%) hoặc phụ thuộc workload. Các mục "c" chưa có nguyên nhân, nên không được sửa theo suy đoán. Vì thế chọn ít mục, lợi ích lớn, dễ hoàn tác.

## 2. Tập sửa cuối

| U-id | Quyết định | Lý do một dòng | Thay đổi tối thiểu | File | Rủi ro | Cách kiểm chứng |
|---|---|---|---|---|---|---|
| **U01** | **IMPLEMENT** (commit bản đã có) | Điểm nóng 16,6% duy nhất; đã sửa trong working tree. | Giữ `terminalFrameGate`. Thêm 1 test hồi quy: base terminal từ chối mọi attachment mà không gọi `attachmentHomeTerminal`; split chỉ cho đúng home; mobile cần scope `terminal.sync`; client user-plane bị chặn khi agent giữ terminal. | `src/main/bridge/bridge-server.ts` (đã sửa, +71/−29), test mới cạnh `test/main/bridge-terminal-gate-multiwindow.test.ts` | Thấp–TB. Mỗi frame chỉ probe session 1 lần, nên trạng thái đổi giữa chừng không ảnh hưởng. Kết quả vẫn fail-closed khi probe trả `undefined`. | Chạy test gate hiện có và test mới. Chạy lại differential 28.220 ca (script ở `E:/Work/scratch/perf-261103`), kỳ vọng 0 mismatch. |
| **U10** | **IMPLEMENT** (commit bản đã có, chỉ hiệu lực ở lần daemon restart tự nhiên) | Giảm ghi đĩa 4,09 MB/s xuống khoảng 0,35 MB/s. | Giữ `TRANSCRIPT_PERSIST_DELAY_MS = 60_000` cho dirty chỉ có output. Thay đổi cấu trúc vẫn 5 s. Thêm 1 test: `appendData` không kéo timer sớm hơn 60 s, nhưng `persist()` structural thì kéo về 5 s. | `src/main/browser/terminal-manager.ts` (đã sửa, +31) | Thấp. Crash daemon mất tối đa 60 s transcript trên đĩa; graceful shutdown vẫn `persistSync`. | Test đơn vị timer. Không kiểm chứng live được trong lần chạy này (không restart daemon). |
| U03 | **DEFER** | Chỉ ~2%. Code ghi rõ resolve từ cửa sổ sống để không bao giờ phục vụ id cũ (`tab-authority-directory.ts:107-111`). Index là cache có thể sai về bảo mật, người dùng không có mặt để duyệt. | Chưa đổi. | | | Làm sau khi U01 live nếu `authorize` vẫn >2%. |
| U02 | **DEFER** | Không biết số run (R) và attachment (A). Độ lớn chưa đo. | | | | Đếm R và A trước. |
| U04 | **DEFER** | 0,28–1,72%, chênh 10× giữa hai profile. Cần sửa `index.ts` (dirty do người khác) và rà ~20 call site có thể mutate. | Khi làm: `projectTerminalStates` gọi `list()` một lần. | | | Đo lại sau U01 live. |
| U05 | **DROP** | Bridge chỉ gọi 1 lần/frame, nên hoist không giảm số lần gọi. Cách duy nhất là cache env, mà contract cấm (`telemetry.ts:29-33`). Các lần gọi ở `terminal-manager.ts` chạy trong daemon, không phải main. | | | | |
| U06 | **DEFER** | ≤0,58%, chỉ có ở profile 180 s. | | | | |
| U08 | **DEFER** | 0% CPU, cần sửa test và `workspace-capsule.ts`; không cần cho việc này. | | | | |
| U11, U12 | **DEFER** | Cần đo trước và cần restart daemon. | | | | |
| U13, U14, U15, U07, U09, U16, U17 | **DEFER (đo trước)** | Rank "c", chưa có nguyên nhân. Riêng U13 là flow control: coalesce sai sẽ làm PTY pause. | | | | |

**Nhận xét về phần nên commit.** U01 và U10 đều đã nằm trong working tree, nên chỉ cần stage đúng hai hunk đó cộng hai test mới. Không đụng `index.ts`, `native-tab-host.ts` hay `terminal-capabilities.ts` (đang dirty do người khác).

## 3. Cần đo live sau khi restart GUI
Dùng `scripts/bench-smoothness.mjs` và cùng quy trình đo như trước. Trong lúc đo, tải phải tương đương (16 PTY, 42 client).
1. **CPU profile main 25 s và 180 s.** `broadcastEvent` incl phải giảm từ 16,6% về dưới ~2%. Đồng thời ghi lại phần còn lại của `onMessage` (trước vá là ~4,4%, mục U17).
2. **`terminal.write → terminal.wait output-match`**: 12 vòng, bỏ 2 vòng đầu. Trước vá p50 là 1.335 ms, p95 là 4.389 ms (mốc 30/10 là ~54 ms). Ghi số tiến trình chạy kèm để phân biệt nhiễu.
3. **MCP `anti.browser.tabs.list`**: trước vá p50 187 ms, p95 692 ms.
4. **Heartbeat**: p99 và max từ `main.log`, lọc theo pid. Chỉ kết luận về stall khi cửa sổ có beat ≥1000 ms. Ghi cùng lúc `\Memory\Pages/sec` và `Available MBytes`.
5. **Sau đó mới đo cho các mục DEFER**: tần suất event 'session', số R/A của run-state, tỷ trọng `authorize` và `clone`.

## 4. Còn chưa biết
- **Nguyên nhân stall heartbeat.** Chưa có bằng chứng; nghi vấn chính là áp lực bộ nhớ hệ thống (~1 GB RAM trống, commit 47,9/58,6 GB). Đây là [INFERENCE].
- **Renderer ~20% và GPU ~21,5%.** Chưa profile, nên chưa rõ có phải nguồn thật của độ trễ người dùng thấy hay không.
- **U10 chưa có số đo live.** Chỉ có hiệu lực khi daemon restart tự nhiên. Mức ~0,35 MB/s là suy luận.
- **Bộ nhớ daemon 956 MB** chưa giải thích được, vì trần theo hằng số chỉ ~120 MiB.
- **Differential test 28.220 ca** chưa chạy lại và hiện nằm ngoài repo (scratch).
- **Anchor chưa đọc trực tiếp** ở phía renderer: `standalone.js`, `toolbar.ts`, `frame-backdrop.ts`, `preview-watcher-pool.ts`.

Tôi đã đọc lại trực tiếp `terminalFrameGate` (`bridge-server.ts:4440-4473`), `resolveSender` và `list()`, hành vi cache env, và tình trạng dirty của các file. Chỉ `bridge-server.ts` và `terminal-manager.ts` là phần của chúng ta. Trong repo cũng chưa có test nào cho `terminalFrameGate` hay `TRANSCRIPT_PERSIST_DELAY_MS`.

## Verifier

Điểm scout (A:16, B:17, C:15, D:18) dùng nhãn ScoutC1–C5, thiếu C3, không ánh xạ được vào file này, nên tôi chấm lại độc lập. Core context hết thời gian chờ, nên kết luận chỉ dựa trên mã và artifact.

| Ứng viên | Khớp triệu chứng | Độ sâu | Khả thi | Trung thực | Ràng buộc | Tổng |
|---|---|---|---|---|---|---|
| A | 4 | 4 | 2 | 2 | 2 | 14 |
| B | 3 | 3 | 2 | 3 | 2 | 13 |
| C | 4 | 4 | 3 | 2 | 3 | 16 |
| D | 3 | 3 | 2 | 3 | 3 | 14 |
| E | 4 | 4 | 3 | 3 | 3 | 17 |

Đã đối chiếu mã: index.ts:630–689 và 2942–2945; workspace-capsule.ts:377–379 và 645–647; telemetry.ts:29–33; tab-authority-directory.ts:107–121; bridge-server.ts:4440–4542; daemon-spawner.ts:147–155 và 377–398.

**Người thắng: E.** E giữ đúng hai thay đổi đã đo và đã viết sẵn (U01 gỡ 16,6% CPU main; U10 giảm ghi daemon), hoãn mọi mục chưa đo hoặc chạm ranh giới bảo mật, và là bản duy nhất đề xuất test tự động cho từng nhánh của cổng fail-closed, cùng test chu kỳ 60 s/5 s. A bị loại vì U04-lite chỉ tiết kiệm 0,3–1,7%, phải sửa `index.ts` đang có 94 dòng thêm của phiên khác, và kéo `daemon-entry.ts` vào commit. C có cùng bộ thay đổi nhưng khẳng định sai rằng U01 giảm số lần gọi `isBenchmarkEnabled` (lời gọi đã chỉ có một lần mỗi broadcast ở bridge-server.ts:~4615) và không đề xuất test hồi quy cho cổng. Số liệu sai của E không ảnh hưởng hành động.

**Phải sửa khi thực thi (E):**
1. **Chí mạng, cả 5 ứng viên đều bỏ sót:** `liveSplitParentOf` chỉ có trong working tree; HEAD không có. Commit chỉ `bridge-server.ts` sẽ làm HEAD import một export không tồn tại. Stage thêm hunk `@@ -277,14 +281,26 @@` của `terminal-capabilities.ts` (hàm mới và thân `isLiveSplitOf`), loại các hunk Leader cùng file. Câu "chỉ bridge-server.ts và terminal-manager.ts là của chúng ta" là sai.
2. Diffstat đúng: bridge-server.ts +48/−23 (71 dòng); terminal-manager.ts +25/−6 (31 dòng).
3. "Không có test cho terminalFrameGate" là sai một phần: gate được phủ gián tiếp qua wrapper ở test:86–88. Test mới phải gọi trực tiếp các nhánh đã nêu. `TRANSCRIPT_PERSIST_DELAY_MS` đúng là chưa có test.
4. Kiểm chứng trên worktree sạch từ HEAD cộng đúng hunk của mình: typecheck, build `.compiled`, rồi chạy `E:/Work/scratch/perf-261103/proof-gate-diff.cjs` trên bản build đó. Stage bằng `git apply --cached` với patch đã lọc, không dùng `git add -p` tương tác. Harness so với `attachmentMayReachTerminal`, hàm này đã gọi `isLiveSplitOf` đã refactor, nên không tự chứng minh phần refactor; tôi đã đối chiếu bằng đọc mã và thấy tương đương.
5. Không stage `src/main/terminal-daemon/daemon-entry.ts`: +15 dòng `memoryWatch` từ điều tra OOM 02/11, không thuộc U10.
6. Commit U10 phải ghi giới hạn mất tối đa 60 s transcript khi daemon crash, và báo để người dùng chấp nhận; E xếp "Thấp" và bỏ sót điều này. Thay đổi chỉ có hiệu lực khi daemon restart tự nhiên. GUI restart không thay daemon khi daemon còn khỏe: `ensureDaemon` tái gắn host đang sống, `daemonVersionStatus` chỉ báo cáo.
7. Lưu ý hành vi: gate được dựng trước vòng lặp client (bridge-server.ts:4542), nên vẫn probe mỗi frame khi không có client; trường `bytes` của benchmark `broadcast` thành 0 khi không client nhận frame, cần tính khi so A/B.

ultra: winner=E scores=A:14,B:13,C:16,D:14,E:17

## Controller notes
- Bước chọn giải pháp của `/ak-fix --ultra` (Step 3, best-of-5 fix plan) dùng chính winner này: cùng packet chẩn đoán, rubric bao trùm cause-alignment/blast-radius/minimality/verifiability.
- Correction 7 của verifier được áp: gate tạo lười trong vòng lặp client, không probe khi frame không có client nhận.
