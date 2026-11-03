# Scout Report

## Summary

- **Điểm nóng lớn nhất đã được vá nhưng chưa live.** `BridgeServer.broadcastEvent` → cổng `isClientAuthorizedForTerminal` chiếm 16,61% (profile 25 s) và 16,54% (profile 180 s) thời gian CPU của main trước vá. `terminalFrameGate` đã nằm trong working tree, chưa commit; muốn đo hiệu quả thì phải restart GUI.
- **Sau khi bỏ cổng, các mục đo được lớn nhất trên main là:** resolve sender cho IPC chrome (`authorize` 2,01–2,35%), tra cứu run-state theo từng run (`sweepInBackground` 1,89–2,05%), clone capsule (0,28–1,72%, phụ thuộc workload), đọc env benchmark (0,81–0,86%), serialize history (0,58%, chỉ có ở profile 180 s).
- **Daemon:** trước vá, ghi nguyên file `terminal-sessions.json` với tốc độ 4,09 MB/s (packet). Bản vá 60 s cho output-only đã có trong source nhưng chỉ có hiệu lực sau restart daemon, và restart daemon sẽ kill mọi PTY. Bộ nhớ daemon 956 MB chưa được giải thích.
- **Bốn dòng bị loại:** C:F4 (batch 4 ms trên main), A:F2 và D:F9 (“21% là JSON encode/parse”), C:F12 (“≥3 lần copy/encode”). Chi tiết ở mục Dropped.
- **Chưa kết luận nhưng có thể là thứ người dùng cảm nhận:** heartbeat stall (p99 2.131 ms, max 8.479 ms) chưa rõ nguyên nhân. Renderer ~20% và GPU ~21,5% chưa có profile. Phải đo trước khi sửa hai mục này.
- Hợp nhất 45 dòng thô thành 17 mục, giữ 41 dòng thô. Không build, test, restart hay attach gì.

## Phương pháp

- Tính lại chia sẻ thời gian từ hai `.cpuprofile`: `main-1` (25 s, 24.674 mẫu) và `stall-1` (180 s, 99.393 mẫu). Cả hai đều là build `.compiled` cũ (trước vá). Mỗi mẫu được quy cho entry gần nhất trong danh sách hàm được chọn.
- Đối chiếu trên 30 anchor trong `src/` bằng đọc hoặc grep trực tiếp (ví dụ: `bridge-server.ts:4440-4442`, `terminal-manager.ts:537-538, 2075, 2173`, `native-tab-host.ts:13112-13114, 2369-2372, 15054-15058`, `index.ts:3973-3974`, `run-state-service.ts:252-255, 459-473`, `workspace-capsule.ts:377-379, 645-647`, `daemon-entry.ts:127-131, 148-154`, `history-manager.ts:99-179`).
- Liệt kê 45 dòng finding thô bằng grep trên file ứng viên. Ứng viên thứ 5 không trả kết quả, được ghi nhận và không tính.

## Điểm ứng viên (mỗi tiêu chí 1–4, tổng 5–20)

| Ứng viên | Anchor | Trung thực bằng chứng | Phủ T1–T5 | Khả thi hành động | Thứ tự ưu tiên | Tổng |
|---|---|---|---|---|---|---|
| A | 4 | 3 | 4 | 3 | 2 | **16** |
| B | 3 | 4 | 3 | 4 | 3 | **17** |
| C | 4 | 3 | 3 | 3 | 2 | **15** |
| D | 3 | 4 | 3 | 4 | 4 | **18** |

- **A.** Anchor gần như chính xác (F4, F7, F12 khớp dòng). Trừ điểm: số “3,2%” cho capsule clone không tái lập được (clone self là 1,72% và 0,28%). Gọi 21% là “data plane JSON” là sai khung. Xếp F2 hạng 2 và F11 (956 MB) hạng 11, nên thứ tự ưu tiên lệch.
- **B.** Số liệu 180 s khớp chính xác với profile (16.437, 15.032, 14.889, 11.984, 5.208, 2.331, 572). Lỗi anchor F8: `workspace-capsule.ts:372-374` là `create()`, còn `list()` nằm ở 377-379. Phủ T2/T3 còn mỏng.
- **C.** Anchor tốt, nhưng F4 là nhận định sai: `native-tab-host.ts:13113-13114` ghi rõ luồng daemon đã gộp, nên batch 4 ms bị bypass. F12 không có số đo. Thiếu hẳn IPC và run-state (T1), là hai mục ~2% trên main.
- **D.** Đo đúng (`isBenchmarkEnabled` 0,81%, onMessage 21%, 4,09 MB/s). Nhãn [ĐO]/[MÃ]/[SUY LUẬN] nhất quán. Kiểm tương đương gate theo từng nhánh, đề xuất đo đếm cụ thể, cảnh báo không cache env. Trừ điểm: `native-tab-host.ts:3212` thực ra là `terminal-manager.ts:3212`, và `lifecycle-log.ts` không tồn tại (D tự đánh dấu chưa xác nhận).

## Findings (đã hợp nhất, 17 mục)

Nguồn ghi dạng `ứng viên:Fn`. Rank: a = chỉ cần restart GUI, b = cần restart daemon, c = cần đo trước.

| id (nguồn) | target | anchor (src/) | scaling | evidence | fix | risk | rank |
|---|---|---|---|---|---|---|---|
| U01 (A:F1, B:F1, B:F9, D:F1) | T1/T4 cổng broadcast | `bridge-server.ts:4440-4442` (wrapper), `4456-4473` (`terminalFrameGate`), `4542`; `tools/terminal-capabilities.ts:290-304` | Trước vá: O(frame×client×lookup). Sau vá: 1 probe/frame + O(client) tra Map | `broadcastEvent` incl 16,61% / 16,54%; ≈99,6–99,8% `getSession` self và ≈82% `getRecord` self nằm dưới broadcast | ĐÃ VÁ, chưa commit, chưa live. Còn 1 copy `getSession`/frame (`daemon-client.ts:669-681`) | Thấp–TB. Differential test 28.220 ca chưa chạy lại | a1 |
| U03 (A:F4, B:F2, D:F5) | T1/T2 IPC sender | `index.ts:3973-3974`; `ipc-router.ts:150-172`; `tab-authority-directory.ts:108-122`; `native-tab-host.ts:5436-5478` | O(H×S) mỗi IPC chrome, kèm `new URL` mỗi lần | `authorize` incl 2,01% / 2,35%; `resolveSender` 1,78% / 2,16%; `surfaceForWebContents` self 0,58% / 0,78%; URL parse ~0,1% | Chỉ mục `webContents.id → (host, surface)`, kiểm lại `isDestroyed` và id khi tra, xóa khi destroy, giữ fail-closed | TB: mapping cũ là authorize sai (ranh giới bảo mật) | a2 |
| U02 (A:F5, B:F5, D:F6) | T1 run-state | `run-state-service.ts:14-15, 252-255, 288-299, 338-361, 459-473, 591-653`; `index.ts:4167-4200` (`lookupAttachment`); `attachment-registry.ts:1648-1662` | Mỗi `getRunsSync`: O(R×A) copy (mỗi run tạo Set attachment mới). Mỗi 5 s: đọc và parse mọi run file | `sweepInBackground` incl 2,05% / 1,89%; `emitIfChanged` 1,95% / 1,79%; `getRecord` dưới `lookupAttachment` 191 / 701 mẫu | Lấy snapshot attachment một lần mỗi `getRunsSync`. Bỏ đọc file không đổi (mtime,size). Prune async | TB: giữ đúng ngữ nghĩa prune/stale | a3 |
| U04 (A:F3, B:F8, C:F2, D:F4, D:F11) | T5 capsule clone | `workspace-capsule.ts:377-379` (`list`), `645-647` (`clone`); gọi từ `index.ts:647, 722, 732, 2941-2944`, `native-tab-host.ts:7495-7496`, `preview-protocol-handler.ts:18` | Mỗi `list()` clone toàn bộ C capsule bằng JSON. O(P×C) mỗi evaluate, O(W×C) mỗi projection | `clone` self 1,72% (25 s, chủ yếu dưới `projectTerminalStates`) / 0,28% (180 s); `evaluate` 1,49% / 0,15%; `stampFolderProjection` 0,36% / 0,04% | `find(predicate)` chỉ clone bản khớp. Đường đọc không clone. Snapshot theo version | TB: caller có thể mutate, cần rà ~20 call site | a4 |
| U05 (D:F7) | T1 env benchmark | `benchmark/telemetry.ts:30-37`; `terminal-manager.ts:2174, 3212`; `native-tab-host.ts:13436`; `tools/capability-transport.ts:344` | Một lần đọc env mỗi chunk, frame và ack | `isBenchmarkEnabled` incl 0,81% / 0,86%; leaf chủ yếu từ `dispatchTerminalData` và `broadcastEvent` | Hoist một lần mỗi dispatch hoặc batch. KHÔNG cache env (contract và test đặt env giữa tiến trình) | Thấp | a5 |
| U06 (B:F7) | T5 history | `browser/history-manager.ts:99-112, 114-133, 142-179` | Serialize và sort mỗi lần persist (quiet 3 s, trần 30 s) | `serializeHistory` 0,58% (180 s; 0 ở 25 s); `writeFile` 0,38% (180 s) | Bỏ `indent`. Bỏ serialize khi `mutationVersion` không đổi | Thấp | a6 |
| U08 (C:C1, C:C2) | cleanup | `bridge-server.ts:4440-4442`; `workspace-capsule.ts:418-430` | 0 CPU | Wrapper: không caller trong `src/`, test còn gọi (`test/main/bridge-terminal-gate-multiwindow.test.ts:86-88`). `updateActiveState`: không caller. `updateState`: chỉ test gọi (`workspace-capsule.test.ts:24, 48`) | Xóa `updateActiveState`. Chuyển test khỏi wrapper rồi xóa wrapper. `updateState` chỉ bỏ khi đổi test | Thấp | a7 |
| U10 (A:F6, B:F4, C:F3, C:F9, D:F2) | T3 persist daemon | `terminal-manager.ts:537-538` (5 s / 60 s), `1512-1523` (chỉ kéo sớm), `2075` (onData → 60 s), `2101` (mặc định 5 s), `2173`; `persistAsync` ≈1399-1437; `assemblePersistPayload` ≈1337-1376 | Mỗi lần ghi là cả file (~20,7 MB, ≤1 MiB tail/phiên) | 4,09 MB/s trước vá (packet). ≈0,35 MB/s khi chỉ có output [SUY LUẬN]. Structural vẫn 5 s | ĐÃ VÁ một phần, chưa live. Còn lại: file theo phiên hoặc append-only | Restart daemon kill PTY. Crash daemon mất ≤60 s transcript trên đĩa (C:F9) | b1 |
| U11 (C:F11) | T3 broadcast daemon | `daemon-entry.ts:148-154` | Bytes × client vào hàng đợi ws khi client chậm. Không kiểm `bufferedAmount` | Đã đọc code, chưa đo | Đo `bufferedAmount` lúc main stall. Sau đó đặt ngưỡng và resync (`generation`/`DELTA_EXPIRED`) | Cao: restart daemon, đổi ngữ nghĩa | b2 (sau đo) |
| U12 (A:F11, C:F5) | T3 bộ nhớ daemon | `terminal-manager.ts:186-262` (journal), `193-194`, `527-528`; `daemon-entry.ts:127-131` (log RSS/heap mỗi 60 s) | Trần ≈6 MiB/phiên ≈120 MiB ở 20 phiên [SUY LUẬN] | 956 MB private (packet); phần chênh chưa giải thích | Đo bằng log 60 s có sẵn, đếm theo phiên, không dùng inspector. Sau đó mới đổi cấu trúc | TB | b3 (sau đo) |
| U15 (A:F8, B:F6, C:F7, C:F8, D:F10) | T2/T5 timer và animation theo cửa sổ | Renderer: `frame-backdrop.ts:113-116`, `toolbar.ts:5544-5545`, `standalone.js:9899-9902`, `frame-backdrop.css:56-63, 164-166`, `toolbar.css:385-401` (chưa đọc lại, 3 ứng viên khớp). Main: `native-tab-host.ts` ≈10084-10087 (chưa đọc) | Timer và animation × cửa sổ (~15) × badge. 33 UI webContents trong một renderer | GPU 21,5%, renderer 20% (packet). Chưa gán nguyên nhân | Profile renderer và Chromium tracing trước. Sau đó giảm blur/box-shadow vô hạn, đồng hồ căn theo phút | Thấp–TB: thay đổi thị giác | c2 |
| U17 (mới, suy ra từ profile) | T2 dispatch residual | `daemon-client.ts:240-262`; `native-tab-host.ts:13111-13131`, `13381-13440` | Mỗi frame từ daemon | `onMessage` incl 21,03% / 19,86% = broadcast 16,61% / 16,54% + ~4,4% / 3,3% (self 1,29% / 1,01%) | Tách theo hàm sau khi U01 live | — | c3 |
| U07 (A:F7) | T5/T2 sự kiện session | `native-tab-host.ts:2369-2372, 2387-2388`; `terminal-manager.ts:3035-3134` (`listSessions`), `3496-3498` (`emitSession`); `index.ts:1782-1793` (debounce 600 ms) | Mỗi 'session': O(S) + O(W) projection + O(W×C) (→ U04) | `sendTerminalProjections` 0,45% / 0,04%. Tần suất 'session' chưa đo, quyết định mức ưu tiên của U04 | Một projection cho mỗi event. Memo theo fingerprint. Đo tần suất trước | TB | c4 |
| U14 (B:F3, D:F3) | T2 activity fan-out | `native-tab-host.ts:7675-7705` (managerAll), `13263-13312` (`emitTerminalActivity`, throttle 100 ms, tail ≤4096), `13381-13440` | O(surface × session × 10/s) envelope | `emitTerminalActivity` 0,36% / 0,32%. Renderer chưa đo. [SUY LUẬN] ~160 envelope/s ở 16 phiên | Giới hạn tốc độ cho manager, hoặc chỉ gửi khi trạng thái đổi. Không đổi tail trước khi kiểm bộ phân loại | TB: mất chỉ báo ở cửa sổ khác | c5 |
| U13 (A:F9, C:F1, D:F8) | T2 chuỗi ack | `native-tab-host.ts:3341-3345`; `terminal-manager.ts:3171-3173`; `daemon-client.ts:727-731`; renderer `standalone.js` ≈2486-2545 (chưa đọc lại) | 1 RPC mỗi ack. Tốc độ ack × session × surface | `recordSubscriberAck` incl 0,03% / 0,02% (main thấp). Tốc độ RPC [INFERENCE] 200–400/s | Coalesce thưa hơn (250 ms hoặc theo byte) | TB–cao: ack là flow control, `unackedBytes` > 256 KiB làm PTY pause | c6 |
| U09 (A:F12) | T5 saved tabs | `native-tab-host.ts:15054-15058` (timer 400 ms), `15214` (`persistTabsAsync`) | Mỗi host ghi cùng một file ≤1 lần/400 ms | File ~61 KB (1 lần đo). Tần suất chưa đo | Gộp ghi qua một writer | Thấp–TB: rủi ro khi cửa sổ crash | c7 |
| U16 (A:F10, C:F6) | T5 preview watcher | `preview-watcher-pool.ts` ≈80–105 (chưa đọc); `native-tab-host.ts:9029-9033`, `15534-15538` | 1 watcher đệ quy mỗi workspace preview | [INFERENCE], chưa đo | Đo tần suất sự kiện. Lọc sớm nếu API cho phép | TB: mất sự kiện | c8 |

## Details (các mục cần ngữ cảnh)

- **U01.** Trước vá, mỗi frame × mỗi client gọi `attachmentHomeTerminal` → `hostForRpcTab` → `hasTab` → `resolveTargetTabId`, cộng copy `getRecord` và `getSession`. Dưới broadcast (180 s): `getSession` 5.187 mẫu, `resolveTargetTabId` 2.149, `hostForTab` 1.490, `getRecord` 3.474. Sau vá vẫn còn một probe `liveSplitParentOf` mỗi frame, và probe này gọi `getSession` một lần. Đối chiếu nhánh: agent-split, user-plane và mobile đều tương đương (D kiểm chi tiết; C xác nhận wrapper còn test).
- **U03.** Chỉ mục phải fail-closed: thiếu hoặc lệch thì từ chối, không fallback sang cache cũ. Sau sửa cần chạy test `ipc-router` và `tab-authority-directory`. Chưa chạy ở đây.
- **U02.** Đường nóng: timer 5 s hoặc watch debounce 100 ms → `sweepInBackground` → `emitIfChanged` → `getRunsSync` → `lookupAttachment` (copy mỗi run) và `readChanges`. Fingerprint đổi thường xuyên vì heartbeat của run file (ghi chú bộ nhớ) [INFERENCE]. `RUN_CHANGES_MAX_FILES = 24` chỉ giới hạn output, không giới hạn lượng đọc.
- **U04.** Đường định kỳ là `evaluate` (sau mỗi 'session', debounce 600 ms) và `stampFolderProjection` (mỗi cửa sổ mỗi event). Hai profile chênh nhau ~10× ở mục này, nên phụ thuộc số event 'session'. Đo U07 trước khi xếp ưu tiên.
- **U10 (đã vá một phần).** Output-only dùng 60 s (`2075`), structural dùng 5 s (`persist()` mặc định; ví dụ 2810, 3315, 3350, 3378 theo ứng viên A). Vẫn ghi cả file. `schedulePersist` chỉ kéo sớm hơn, không đẩy muộn hơn (đúng). Graceful shutdown có `persistSync` flush (comment ở 536). Rủi ro crash daemon cần người dùng xác nhận chấp nhận.
- **U12 và U11 (daemon, sau đo).** Không gắn inspector vào daemon. Dùng `memoryWatch` log mỗi 60 s (`daemon-entry.ts:127-131`) theo số phiên, `io.ps1` WriteTransferCount, và `bufferedAmount` của client daemon lúc main stall.
- **Stall và áp lực bộ nhớ (c1, không tính vào 17 mục).** Packet: heartbeat p50 2 ms, p95 120 ms, p99 2.131 ms, max 8.479 ms, 40 beat > 300 ms. Profile 180 s không có stall (ghi chú bộ nhớ: max beatLag 62 ms), nên chưa có kết luận. Để phân loại một stall: lấy cửa sổ profile có beatLagMs ≥1000 (lọc main.log theo pid và timestamp), rồi so sampler gap trong timeDeltas với `\Memory\Pages/sec` và `Available MBytes` cùng cửa sổ. Máy đang có ~1 GB RAM trống và commit 47,9/58,6 GB (packet). Ghi chú bộ nhớ nêu ~35 omp.exe ≈20 GB private (cần xác minh lại). Đây là nghi vấn chính [INFERENCE].
- **U14 (trả lời T2).** Dữ liệu đầy đủ chỉ tới surface đang hiển thị session (`native-tab-host.ts:13376-13380`). Các surface khác được admit nhận envelope activity. `managerAll` được admit mọi session (`7675-7705`), nên cửa sổ manager nhận activity của mọi session.
- **U13.** Ack là flow control: daemon theo dõi `unackedBytes` và pause PTY khi vượt `BACKPRESSURE_HIGH_WATERMARK_BYTES` (256 KiB, `terminal-manager.ts` ~50–56 và ~3446). Coalesce ack quá thưa có thể làm PTY pause. Chi phí main hiện thấp (0,02–0,03%).

## Dropped (claim bị loại)

1. **C:F4, batch 4 ms phía main còn gộp output (bị bác).** `native-tab-host.ts:13112-13114`: khi `payload.throughSeq` là số thì đi thẳng, comment ghi daemon đã gộp. `output-batcher.ts:119` luôn đặt `throughSeq`. Batch chỉ được tạo ở nhánh không có `throughSeq` (`13131-13136`). Vì vậy `flushAllTerminalDataBatches()` trên sự kiện 'session' (`2370`) là no-op ở chế độ daemon. Batch 4 ms chỉ còn ở fallback in-process (`index.ts:4001-4003`). Bỏ đề xuất 4→16 ms.
2. **A:F2 và D:F9, “data plane 21% là JSON encode/parse” (sai khung).** `onMessage` 21,03% (25 s) / 19,86% (180 s) gồm `broadcastEvent` 16,61% / 16,54%. Self của `onMessage` là 1,29% / 1,01%. Không có khung `JSON.parse` hay `JSON.stringify` đáng kể: khung tên `parse` có cha là `URL` (nằm trong `resolveSender`), còn `stringify` có 0 mẫu. Phần còn lại (~4%) được tách thành U17, cần đo.
3. **C:F12, “≥3 lần copy/encode mỗi byte, đổi sang frame nhị phân” (không được hỗ trợ).** Cùng lý do mục 2. Đề xuất đổi giao thức không có số đo.
4. **D Unverified #9, “`lifecycle-log.ts` ghi `appendFileSync` mỗi 5 s”.** Không có file này trong `src/` (glob không trả kết quả).
5. **A (summary), “clone capsule ~3,2% đo được”.** Không tái lập: `clone` self là 1,72% / 0,28%. Sửa số, giữ U04.
6. **A:F7, tiền đề “activity cũng phát 'session'”.** Không có `markActivity`, `setActivityState` hay `scheduleProjection*` trong `src/` (grep: 0 kết quả). Chỉ giữ fan-out theo 'session' (U07).
7. **A:F11 và C:F5, “heap snapshot” để gán 956 MB.** Không hợp lệ trên daemon (không gắn inspector). Thay bằng log 60 s có sẵn và đếm theo phiên (U12).
8. **C:C2, “xóa `updateActiveState` và `updateState` vì không có caller” (đúng một nửa).** `updateActiveState` không có caller, xóa được. `updateState` không có caller trong `src/` nhưng test dùng, nên không phải dead code thuần.
9. **C:C1, “wrapper không còn caller”.** Đúng với `src/`, sai với test: `bridge-terminal-gate-multiwindow.test.ts:86-88` gọi wrapper. Giữ U08 với điều kiện đổi test.

Sửa anchor (không bỏ claim): B:F8, `workspace-capsule.ts:372-374` là `create()`, còn `list()` ở 377-379. D:F7, `native-tab-host.ts:3212` là `terminal-manager.ts:3212` (`recordSubscriberAck`). A:F5, run-state ở dòng 14-15, không phải 13-14. C:F11, `daemon-entry.ts:148-154`, không phải 147-156.

## Xếp hạng hiệu chỉnh

Restart GUI reset mọi tab nhưng không mất PTY. Restart daemon kill mọi PTY, nên phải có người dùng duyệt trước.

**(a) Main process, chỉ cần restart GUI**
1. U01, gate broadcast. ĐÃ VÁ. Restart GUI rồi đo lại `broadcastEvent`, kỳ vọng giảm mạnh so với 16,6%.
2. U03, IPC sender index. 2,0–2,35%.
3. U02, run-state per-run lookup. 1,9–2,05%.
4. U04, capsule clone. 0,3–1,7%, phụ thuộc workload.
5. U05, env benchmark. 0,8–0,9%.
6. U06, history JSON. ≤0,9%.
7. U08, dọn dead code. 0% CPU, phải sửa test trước.

**(b) Daemon, cần restart daemon (kill PTY)**
1. U10, persist. ĐÃ VÁ một phần (60 s output-only), chưa live. Sau restart, đo lại: kỳ vọng ~0,35 MB/s khi chỉ có output, structural vẫn 5 s. Bước tiếp theo là file theo phiên hoặc append-only, cần thiết kế và migration.
2. U11, backpressure. Chỉ làm sau khi đo `bufferedAmount`.
3. U12, bộ nhớ. Chỉ làm sau khi đo phân bổ.

**(c) Cần đo trước**
1. Heartbeat stall và áp lực bộ nhớ hệ thống (triệu chứng, không phải dòng finding).
2. U15, renderer và GPU (GPU 21,5%, renderer 20%).
3. U17, dispatch residual ~4%, đo sau khi U01 live.
4. U07, tần suất 'session' (quyết định ưu tiên U04).
5. U14, activity fan-out.
6. U13, ack chain (rủi ro flow control).
7. U09, saved tabs.
8. U16, preview watcher.

## Unresolved (chưa giải quyết)

1. **Nguyên nhân heartbeat stall.** Chưa có bằng chứng. Cần cửa sổ profile chứa beatLagMs ≥1000 cùng sampler gap, `\Memory\Pages/sec`, `Available MBytes` và WriteTransferCount của daemon.
2. **Áp lực bộ nhớ hệ thống.** ~1 GB RAM trống, commit 47,9/58,6 GB (packet). Ghi chú bộ nhớ nêu ~35 omp.exe ≈20 GB private (cần xác minh lại). Là nghi vấn chính, chưa đo.
3. **Renderer ~20% và GPU ~21,5%.** Chưa profile. Không rõ % là một lõi hay toàn máy (packet).
4. **Bản vá chưa đo lại.** U01 cần GUI restart, U10 cần daemon restart. Differential test 28.220 ca chưa chạy lại (read-only).
5. **Bộ nhớ daemon 956 MB.** Thành phần chưa rõ. Trần theo hằng số ~120 MiB ở 20 phiên [INFERENCE].
6. **Tần suất sự kiện chưa đo.** 'session'/s, schedulePersist/s, ack RPC/s (200–400 [INFERENCE]), activity envelope/s, isBenchmarkEnabled/s, saved-tabs writes/s, preview watcher events/s.
7. **Ghi capsule store.** Persist đồng bộ sau mỗi mutation. `updateState` không có caller production, nên nguồn ghi thực tế chưa truy được.
8. **`terminalWindowCloseSurfaces`** (`index.ts:1189-1204`) quét `getAllWebContents()` × hosts. Caller chưa truy. Theo tên là đường đóng app.
9. **Đã kiểm `getAllWebContents` (T5).** `index.ts:962` chỉ chạy khi benchmark bật (`1004-1007`). `2569` chạy lúc khởi động. `4868` đếm trong heartbeat. Ngoài mục 8, không có vòng nóng theo N.
10. **Chênh lệch 25 s và 180 s** cho capsule/inactivity (1,49% so với 0,15%). Phụ thuộc workload, cần đo với số phiên và cửa sổ biết trước.
11. **Anchor chưa đọc trực tiếp:** `standalone.js` 2486–2545, 9757–9770, 9899–9902; `preview-watcher-pool.ts`; `frame-backdrop.ts`; `toolbar.ts`; `native-tab-host.ts` ≈10084–10087 và 2281; `bridge-server.ts` ≈4615.
12. **Quy mô thực tế chưa đếm:** số run (R), attachment (A) và kích thước log (L). Quyết định độ lớn của U02.
13. **Cây làm việc dirty.** Theo packet có thay đổi của phiên Leader khác. Khi commit U01 và U10, phải stage đúng hunk.
14. **Ứng viên thứ 5** không trả kết quả (đã ghi nhận).


## Controller Corrections (controller-only, sau khi đọc lại mã)

- Đã đọc lại trực tiếp: `tab-authority-directory.ts:112-121` (resolveSender quét mọi shell mỗi IPC — đúng), `workspace-capsule.ts:377-379, 645-647` (list() JSON-clone toàn bộ — đúng), `index.ts:630-689, 2930-2957` (`projectTerminalStates` gọi `resolveWindowRecord` → `capsuleManager.list()` một lần cho MỖI project → O(P×C) clone — đúng), `telemetry.ts:29-37` (env cố ý không cache — đúng, U05 chỉ được hoist).
- Số đo bổ sung của controller (live, trước vá, lúc 5 scout đang chạy thêm tải): round-trip terminal `terminal.write`→`terminal.wait output-match` p50 1.335 ms, p95 4.389 ms (12 vòng, bỏ 2 vòng đầu; mốc 30/10 ≈54 ms); MCP `anti.browser.tabs.list` p50 187 ms, p95 692 ms. Bị nhiễu bởi tải của chính đợt scout → cần đo lại sau restart.
- Ứng viên thứ 5 (C3) hết context, không có báo cáo: union trên 4/5 ứng viên.
- Ứng viên và verifier cùng tier model: same-tier best-of-5 (4 usable).
- Nhãn: A=ScoutC1, B=ScoutC2, C=ScoutC4 (bản sửa sau broadcast), D=ScoutC5.

ultra: union kept=17/proposed=45 candidates=4/5 scores=A:16,B:17,C:15,D:18
