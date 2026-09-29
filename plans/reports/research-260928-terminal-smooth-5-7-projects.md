# Research Report: AntiFan mượt với 5–7 dự án (terminal + Chrome)

Timestamp: 2026-09-28. Mode: ak:research + kongming advice (same-model, omp không pin Fable).

## Executive Summary
Phương án trước (giữ multi-window + sửa nghẽn main thread) **đúng hướng nhưng chưa đủ** để "thật trơn tru". Thiếu 3 thứ: (1) routing O(1) sessionId→window thay vì fan-out mọi chunk tới mọi window, (2) backpressure đầu-cuối (hiện là dead code), (3) hibernate tab Chrome nền để giới hạn RAM ở 7 dự án.
Loại bỏ: gộp 1 cửa sổ (không chữa lag, user dùng 3 màn hình sẽ tách lại), và data plane trực tiếp daemon→renderer qua MessagePort (daemon là tiến trình detached `ELECTRON_RUN_AS_NODE`, không phải `utilityProcess`; MessagePort cần broker cùng vòng đời GUI).

## Research Methodology
- Nguồn: Electron docs (process-model, utility-process, message-channel-main), xterm.js flow-control guide, VS Code terminal docs/blog, repo AntiFan (scout + grep).
- Search: 4 web queries. Evidence code đánh dấu path:line.

## Key Findings
1. **Electron:** main process phải không bao giờ chạy sync I/O; batch IPC; giới hạn payload. MessageChannelMain cho phép renderer↔utilityProcess bỏ qua main sau khi main brokers port. [electronjs.org/docs/latest/api/message-channel-main]
2. **VS Code:** PTY ở pty host riêng; lỗi "pty host unresponsive" xảy ra khi một terminal ồn chiếm event loop → cần flow control. [code.visualstudio.com/docs/terminal/advanced]
3. **xterm.js:** `write(data, cb)` + watermark high/low để backpressure; buffer cứng ~50MB rồi drop; không nên đổ dữ liệu vào terminal ẩn. [xtermjs.org/docs/guides/flowcontrol]
4. **AntiFan code (verified):**
   - `fs.statSync` mỗi chunk × mỗi window: `native-tab-host.ts:1699-1734, 5332-5595`.
   - Daemon `ws.send` từng chunk, không gộp: `daemon-entry.ts:129-134`.
   - Backpressure chết: `terminal-manager.ts:2668-2669` `pauseSession` chỉ chạy khi `BRIDGE_PTY_BACKPRESSURE=1`, không có caller trong `src/`.
   - Renderer tạo xterm cho session ẩn: `standalone.js:6056-6062`.
   - Capture nền độc lập với multi-window: `native-tab-host.ts:4897-4951`.

## Comparative Analysis
| Phương án | Chữa lag? | RAM 7 dự án | Rủi ro | Kết luận |
|---|---|---|---|---|
| A. Multi-window + vá nghẽn (plan cũ) | Phần lớn | Cao | Thấp | Thiếu |
| **A+. A + routing O(1) + backpressure + hibernate** | Có | Giới hạn | Trung bình | **Chọn** |
| B. 1 cửa sổ + tear-off | Không (nghẽn vẫn còn) | Thấp hơn | Cao, đảo spec 3 màn hình | Loại |
| C. Daemon→renderer trực tiếp (WS/MessagePort) | Có | — | Cao: phá kiểm tra quyền ở main, MessagePort không dùng được với daemon detached | Loại |

**Trade-off MessagePort (không phải fix rẻ):** mọi nguồn lập port qua `utilityProcess.fork` + `child.postMessage(..., [port])`. Daemon AntiFan detached, nối WS; main không thể chuyển MessagePort vào tiến trình nó không fork. Muốn dùng phải respawn daemon thành `utilityProcess` → mất thuộc tính sống sót qua restart GUI.

Keystroke giữ đi qua main: main kiểm `assertManagerMayOperate`, admission, ownership. [INFERENCE] Hết `statSync` thì RTT IPC+WS chỉ vài ms.

## Implementation Recommendations (phases + gate)
0. **Đo baseline:** 3 và 7 dự án, 1 session burst ~1MB/s: event-loop p99 main, statSync/s, WS frames/s, RSS theo pid, keystroke→echo.
1. **Zero I/O + routing O(1):** cache affiliation root; map `sessionId → host` ở main, chỉ gửi chunk tới window sở hữu. Gate: 0 statSync trên data path; main p99 < 50ms khi burst.
2. **Daemon batching + wire pruning:** gộp 8–16ms/≤64KiB; bỏ tail 160KiB khỏi broadcast (audit consumer trước). Gate: WS frames ≥10× ít hơn cùng throughput.
3. **Renderer lazy + backpressure:** không tạo xterm cho session ẩn (hydrate khi mở); watermark 256KB/64KB điều khiển ở mức socket daemon (không dùng `pty.pause` native trên winpty — [INFERENCE] kongming nêu nguy cơ deadlock, chưa kiểm); tab ẩn fast-ack. Gate: keystroke p95 ≤ 100ms khi có build nền; journal seq liên tục (0 mất output).
4. **Hibernate tab Chrome nền:** destroy WebContentsView tab idle > 15–20 phút, tái tạo khi click (tái dùng đường recreate có sẵn `native-tab-host.ts:6864-6903`, cần kiểm). Loại trừ: tab active, đang phát âm, đang load, offscreen/ephemeral agent, `automationTabId`, tab có binding MCP. Gate: RSS tổng đo trước/sau; `window.background-surface-and-capture-ready` pass.
5. **Project manager UI + CRUD** (song song): modal trong app thay native dialog; rename, remove (đóng window + bỏ khỏi danh sách, không xoá file, confirm nếu terminal sống). Không duplicate.

## Common Pitfalls
- Cache affiliation sai invalidation → terminal hiện sai window.
- Bỏ tail broadcast → consumer ngầm mất nội dung.
- Hibernate tab đang có form chưa lưu / đang bị agent bind.
- Số liệu kongming (">500ms", ">4.5GB", "3500 statSync/s") **chưa đo** — chỉ dùng phase 0 làm căn cứ.

## Resources
- https://electronjs.org/docs/latest/tutorial/process-model
- https://electronjs.org/docs/latest/api/message-channel-main
- https://xtermjs.org/docs/guides/flowcontrol/
- https://code.visualstudio.com/docs/terminal/advanced

## Next Steps
1. Chạy phase 0 đo baseline.
2. `ak:plan --advice` theo phases 1–5.

## Unresolved Questions
- Ảnh chụp là native dialog hay modal? (repro: đóng sidebar → Ctrl+Shift+O).
- Ngưỡng idle hibernate: 15 hay 20 phút?
- winpty vs ConPTY hiện dùng mặc định là gì — ảnh hưởng thiết kế backpressure.
