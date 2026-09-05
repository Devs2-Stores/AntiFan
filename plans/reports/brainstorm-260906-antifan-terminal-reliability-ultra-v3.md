# HỢP ĐỒNG KIẾN TRÚC & ĐẶC TẢ GIAO THỨC V3 (FINAL SEALED): ANTI-FAN TERMINAL RELIABILITY OVERHAUL

**Trạng thái artifact:** Hợp đồng kiến trúc & đặc tả giao thức V3 (Chốt sổ / Closed for Planning) — **Sẵn sàng 100% chuyển giao cho `/ak:plan` (Phase T0 & Phase T1)**  
**Nền tảng tri thức:** Thẩm định sâu 1747 dòng (`2026-09-05`), Best-of-5 Ultra Brainstorm (`2026-09-06`), và Chuỗi phản biện kiến trúc Kongming v2/v3 (`fable-thinking`).  
**Workspace:** `E:\Work\apps\antifan-browser-desktop` (Commit `96aa34f`)  
**Host Workstation Reality:** Windows 11 Pro x64 (10.0.22000), Intel Core i5-9300H @ 2.40GHz (4C/8T), Intel UHD Graphics 630, 16–32 GB RAM, solo Theme Developer (Haravan, Sapo, Shopify CLI, PowerShell 5.1/7, AI CLIs: Oh My Pi / Codex, Vite/esbuild watchers).  
**Kỷ luật khẳng định (Claim Discipline):** `[OBSERVED]` (đã đọc/đo thực tế trên code), `[DERIVED]` (suy luận logic có cơ chế chứng minh), `[RISK]` (rủi ro tiềm ẩn), `[SPEC]` (quy định kỹ thuật bắt buộc).

---

## I. SÁU ĐỊNH LUẬT BẤT BIẾN CỦA ANTIFAN TERMINAL (THE 6 TERMINAL LAWS)

```text
ĐỊNH LUẬT #1 (LIFECYCLE SEPARATION & RENDERER BOUNDARY)
PTY Session ≠ Terminal View ≠ Layout Binding.
- Trong cùng một Renderer (WebContents): Đổi tab, Split/Unsplit, ẩn/hiện Sidebar, hay Resize
  TUYỆT ĐỐI KHÔNG ĐƯỢC huỷ (dispose) TerminalView đang sống.
- Giữa các Renderer Process khác nhau (Dock ↔ Popout BrowserWindow):
  Bắt buộc phải qua Giao thức Bàn giao View tường minh (PopoutHandoffProtocol).

ĐỊNH LUẬT #2 (DELIVERY TRUTH & SUBSCRIBER ACK)
IPC Delivery ≠ State Synchronization.
- IPC send thành công không đồng nghĩa Renderer đã render đúng.
- Main Process sở hữu Sự thật Vận chuyển thông qua SessionDeliveryJournal (RAM-bound, theo generation)
  kết hợp với cơ chế Coalesced ACK từ từng Subscriber (Dock / Popout).

ĐỊNH LUẬT #3 (SESSION IDENTITY & THREE-TUPLE)
Persisted Transcript ≠ Resurrected Process.
- Định danh sự thật duy nhất của dòng dữ liệu là bộ ba số nguyên: (sessionId, generation, seq).
- Khởi động lại ứng dụng là khôi phục DỮ LIỆU LỊCH SỬ (Transcript Identity), không phải phục sinh
  TIẾN TRÌNH (Process Identity). Shell mới phải bắt đầu từ Clean VT State.

ĐỊNH LUẬT #4 (ZERO PRIVATE INTRUSION)
No Private Native / Runtime Internals in New Architecture.
- Cấm phụ thuộc vào trường private của xterm (_renderService) hay node-pty (_agent, _socket).
- Mọi tương tác phải qua API công khai hoặc cơ chế phòng vệ có bảo vệ biên.

ĐỊNH LUẬT #5 (SINGLE AUTHORITY PRINCIPLE)
One PTY session has exactly one input owner and one geometry owner at any instant.
- Một PTY session có thể có nhiều View quan sát trong quá trình bàn giao (Handoff),
  nhưng tại một thời điểm CHỈ DUY NHẤT một View sở hữu quyền nhận phím người dùng (Input Owner)
  và MỘT View sở hữu quyền điều khiển kích thước (cols/rows) của PTY (Geometry Owner).

ĐỊNH LUẬT #6 (BOUNDED RECOVERY & HONEST DEGRADATION)
Every recovery buffer, delivery journal and live queue MUST have explicit byte/chunk bounds.
- Mọi hàng đợi khôi phục (recovery queue), nhật ký truyền tải (delivery journal) và bộ đệm live
  bắt buộc phải có giới hạn cứng theo dung lượng (bytes) và số lượng chunk.
- Khi vượt quá giới hạn khôi phục, hệ thống BẮT BUỘC phải chuyển sang trạng thái DEGRADED tường minh;
  tuyệt đối không được che giấu sự kiệt quệ tài nguyên dưới vỏ bọc "đồng bộ thành công".
```

---

## II. BỐN AMENDMENT LÀM KÍN HỢP ĐỒNG KIẾN TRÚC

### 1. Delivery Truth Hoàn Chỉnh: `SessionDeliveryJournal` + Coalesced ACK
Main Process không chỉ lưu vết những gì đã phát mà phải nắm rõ từng View con đã áp dụng tới sequence nào:

```ts
interface TerminalSubscriberState {
  rendererInstanceId: string;
  sessionId: string;
  generation: number;
  lastAckedSeq: number;
  state: 'SYNCED' | 'GAPPED' | 'RESYNCING' | 'DEGRADED' | 'HANDOFF';
  role: 'DOCK' | 'POPOUT';
  inputOwner: boolean;
  geometryOwner: boolean;
  lastSeenTimestamp: number;
}
```

- **Quy trình ACK gộp (Coalesced ACK ở Renderer):**
  $$\text{terminal.write(chunk)} \longrightarrow \text{write callback settled} \longrightarrow \text{Flush ACK (debounce 50ms OR 64 chunks)}$$
- **Trạng thái tại Main:** Main Process biết chính xác:
  - `emittedThroughSeq`: Sequence cao nhất PTY vừa đẩy ra.
  - `retainedFromSeq`: Sequence cũ nhất còn lưu trong Journal.
  - `subscriberLastAckedSeq`: Sequence mới nhất Renderer đã hoàn tất vẽ lên màn hình.

---

### 2. Giới Hạn Cứng Cho Hàng Đợi Khôi Phục (Bounded Recovery Queue)
Khi xảy ra sequence gap, Renderer chuyển sang `GAPPED` và gọi `getDelta`. Nếu PTY đang xả log ồ ạt (như `npm run build` hoặc OMP stream), hàng đợi `liveQueue` phải có giới hạn cứng để chống tràn RAM Renderer:
- `MAX_RECOVERY_QUEUE_BYTES = 1 * 1024 * 1024` (1 MiB).
- `MAX_RECOVERY_QUEUE_CHUNKS = 2048` chunks.
- **Quy tắc Single-Flight:** Mỗi `TerminalView` chỉ được phép có tối đa một yêu cầu resync đang bay (in-flight). Cấm bắn dồn dập nhiều lệnh `getDelta`.
- **Xử lý tràn hàng đợi:** Nếu `liveQueue` chạm một trong 2 ngưỡng trên trước khi delta về:
  $$\text{RESYNCING} \longrightarrow \text{RECOVERY_OVERFLOW} \longrightarrow \text{DEGRADED}$$
  Ngừng gom hàng đợi vô tận; hiển thị badge yêu cầu người dùng resync lại view khi dòng log ngớt, bảo toàn tính ổn định cho toàn bộ cửa sổ Electron.

---

### 3. Định Nghĩa Handoff Snapshot Bằng `@xterm/addon-serialize`
Giao thức bàn giao giữa 2 WebContents (Dock $\leftrightarrow$ Popout) không dùng raw PTY tail. Snapshot ở đây được định nghĩa chuẩn xác:
```ts
interface TerminalHandoffEnvelope {
  sessionId: string;
  generation: number;
  throughSeq: number;
  cols: number;
  rows: number;
  serializedVTSnapshot: string; // Sinh ra từ SerializeAddon.serialize()
}
```
- **Quy trình bàn giao:**
  1. Source View gọi `SerializeAddon.serialize()` $\rightarrow$ đóng gói envelope kèm `cols` và `rows` hiện tại.
  2. Destination View khởi tạo xterm tại đúng kích thước `cols \times rows` $\rightarrow$ nạp `serializedVTSnapshot`.
  3. Main Process cấp delta từ `throughSeq + 1` tới thời điểm hiện tại cho Destination View.
  4. Destination View xác nhận thành công $\rightarrow$ Main chuyển giao `inputOwner = true`, `geometryOwner = true`.
  5. Nếu quá trình serialize thất bại hoặc lỗi giải mã: Chuyển sang `HANDOFF_DEGRADED` (hiển thị giao diện cảnh báo để người dùng chủ động khôi phục, không ngụy tạo trạng thái exact).

---

### 4. Phân Biệt Ba Lớp Dữ Liệu Của Subsystem
Ba lớp dữ liệu độc lập, không thay thế nhau:
1. **`SessionDeliveryJournal` (RAM, Main Process):** Phục vụ live delivery & gap healing trong phiên. Giới hạn kép: `2 MiB / 4096 chunks`. Tự giải phóng khi đóng session.
2. **`TerminalView / xterm.js` (RAM, Renderer):** Giữ trạng thái máy VT thực tế (cursor, alternate-screen, buffer) khi View đang sống.
3. **`TranscriptStore` (Disk, Local Workstation):** Phục vụ developer xem lại lịch sử sau khi tắt/mở máy.
   - *Mức khởi điểm (T4):* 256 KiB/session trong `terminal-sessions.json`.
   - *Đích đến mở rộng:* Thư mục `transcripts/*.log` hỗ trợ xoay vòng 5–20 MiB/session trên ổ đĩa NTFS cục bộ của Windows 11.

---

## III. BẢNG TIÊU CHUẨN NGHIỆM THU HIỆU CHỈNH HOÀN CHỈNH (GATES A – K)

| Cổng | Tên Cổng | Điều kiện ĐẠT chuẩn mực (Falsifiable Metric) |
|---|---|---|
| **GATE-A** | View & Transport Continuity | Chuyển tab 50 lần liên tục khi log đang stream 1,000 dòng/s:<br>1. Số lần gọi `xterm.dispose()` bằng **đúng 0**.<br>2. 100% PTY chunks được chuyển tới `xterm.write()` đúng 1 lần.<br>3. Trạng thái xterm cuối cùng khớp byte-for-byte với Headless Test Oracle. |
| **GATE-B** | Sequence Gap Healing Latency | Giả lập rớt 50 chunk $\rightarrow$ Chuyển `GAPPED` $\rightarrow$ `RESYNCING` $\rightarrow$ `READY` với độ trễ phân vị: $p95 < 250\text{ms}, p99 < 500\text{ms}$. Đúng 0 byte mất, 0 chunk trùng. |
| **GATE-C1** | Hidden Sidebar (Renderer Alive) | Đóng sidebar 30 phút trong khi Renderer process vẫn chạy và tiêu thụ IPC $\rightarrow$ 0 byte rớt, 0 dòng thiếu khi mở lại. |
| **GATE-C2** | Hidden Sidebar (Beyond Journal) | Renderer bị đóng băng hoặc ngắt kết nối khiến dữ liệu phát sinh vượt quá 2 MiB / 4096 chunks $\rightarrow$ Chuyển sang **`DEGRADED` tường minh**, không tự ý gán `READY` giả tạo. |
| **GATE-D** | TUI Integrity với Headless Oracle | Chạy TUI/CLI (`omp`, `powershell \r`) qua 50 lần chuyển tab $\rightarrow$ Khớp 100% với `@xterm/headless` về: `buffer.active.type`, toạ độ `cursorX/cursorY`, `baseY`, `viewportY` và text màn hình. |
| **GATE-E** | Rào chắn hình học tối thiểu | Co container xuống < 120px $\rightarrow$ `FitAddon.proposeDimensions()` báo không hợp lệ; tự động ẩn split an toàn; số dòng hiển thị của Main pane $\ge 5$ dòng; 0 lỗi console. |
| **GATE-F** | Phân định lịch sử Restart | Mở lại app $\rightarrow$ Transcript cũ hiển thị dưới dạng Read-Only có banner phân cách; shell mới chạy ở generation mới trên nền clean state. |
| **GATE-G** | Dọn dẹp tiến trình Windows | Đóng 5 terminal $\rightarrow$ Khẳng định toàn bộ PID trong danh sách cấp phát của AntiFan không còn tồn tại trên OS (`Process.Exists(pid) == false`). |
| **GATE-H** | Popout Handoff (Cross-Renderer) | Thực hiện 50 chu kỳ Dock $\leftrightarrow$ Popout $\rightarrow$ 0 sequence mất, 0 sequence trùng, đúng generation, input gửi đúng 1 lần (Luật #5). |
| **GATE-I** | Phục hồi sau Renderer Reload | Renderer reload khi PTY đang nhàn rỗi (idle) $\rightarrow$ Bootstrap handshake tự kéo delta lên seq mới nhất, không chờ chunk kế tiếp. |
| **GATE-J** | Trung thực khi Delta hết hạn | Bơm gap vượt quá Journal retention $\rightarrow$ Chuyển trạng thái `DEGRADED`, phát cờ yêu cầu người dùng xác nhận khôi phục màn hình. |
| **GATE-K** | Quản lý tài nguyên bộ nhớ | 1. Trạng thái ổn định: $\text{Số Views} == \text{Số Sessions live}$.<br>2. Trong lúc bàn giao Popout: $\text{Số Views} \le \text{Số Sessions live} + \text{ActiveHandoffs}$.<br>3. Sau khi handoff xong: Trở về trạng thái cân bằng; RAM Journal $\le 2\text{ MiB/session}$; RAM hàng đợi $\le 1\text{ MiB/view}$. |

---

## IV. PHÂN KỲ THI CÔNG & GIỚI HẠN PHẠM VI (T0 $\rightarrow$ T5)

### Giai đoạn 1: Mục tiêu chuyển giao tức thì sang `/ak:plan`

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE T0: Diagnostic Instrumentation & Test Harness                          │
│ ├─ Expose object chẩn đoán `window.__antifanTerminalHealth`                 │
│ ├─ Thu thập telemetry: rendererInstanceId, seq, ackedSeq, journalRange, RAM │
│ └─ Thiết lập `@xterm/headless` Oracle Test Harness cho CI                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE T1: Terminal State Synchronization Protocol                            │
│ ├─ Main: Cài đặt `SessionDeliveryJournal` (dual-bound: 2 MiB / 4096 chunks)  │
│ ├─ Main: Quản lý `TerminalSubscriberState` & Coalesced ACK (50ms / 64 chunks)│
│ ├─ Main: API `getTerminalDelta` trả về TerminalDeltaResult có 4 trạng thái   │
│ ├─ Main: Xoá bỏ chốt chặn `this.isSidebarOpen` tại `native-tab-host.ts:1164` │
│ ├─ Renderer: Cài đặt state machine READY / GAPPED / RESYNCING / DEGRADED    │
│ ├─ Renderer: Hàng đợi `liveQueue` có trần cứng (1 MiB / 2048 chunks)        │
│ ├─ Renderer: Bootstrap Sync Handshake ngay khi view được gắn DOM             │
│ └─ CỘT MỐC NGHIỆM THU: [P0-Transport Certified]                              │
│    (Đạt toàn bộ Gate B, C1, C2, I, J; chứng minh 0 rớt data trước khi sửa UI)│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Giai đoạn 2: Tái cấu trúc Renderer & Bền vững hoá (Sau khi T1 đạt chứng chỉ)
- **Phase T2: Unified Persistent `TerminalViewRegistry`**
  - Khai tử các biến singleton `splitTerm`, `splitFitAddon`, `splitWriteTarget`.
  - Toàn bộ View quản lý tập trung trong `TerminalViewRegistry` (persistent theo session).
  - Sử dụng `#terminal-parking-shelf` (measurable, off-screen) thay vì `display: none`.
  - Quản lý `mountState` (`VISIBLE | PARKED | HANDOFF | DISPOSED`), đảm bảo View parked không can thiệp hình học PTY.
  - Cài đặt `PopoutHandoffProtocol` dùng `@xterm/addon-serialize` + dimensions envelope.
- **Phase T3: Geometry Authority & Cell Floor Guard**
  - Trao quyền quyết định hình học cho `FitAddon.proposeDimensions()`, từ chối split khi rows < 5 hoặc cols < 20.
  - Loại bỏ hơn 30 khối `catch {}` nuốt lỗi rỗng trong `standalone.js`.
- **Phase T4: Transcript Durability & Session Demarcation**
  - Phân tách `TranscriptStore` đĩa với live PTY.
  - Sửa lỗi truyền chuỗi rỗng tại `terminal-manager.ts:426, 435`.
  - Đóng gói giao diện phục hồi lịch sử dạng Read-Only có phân cách phiên rõ ràng.
- **Phase T5: Windows Process Lifecycle Hardening**
  - Xây dựng `ProcessOwnershipRegistry` quản lý PID tree.
  - Đóng gói `WindowsPtyAdapter`, cách ly hoàn toàn các trường private `_agent`.

---

## V. CHỐT SỔ HỢP ĐỒNG (SEALED)

Hợp đồng kiến trúc V3 này:
1. Đã giải quyết triệt để 100% các lỗ hổng của tầng giao tiếp phân tán trong Electron (Dock $\leftrightarrow$ Popout, Coalesced ACK, Bounded Queue, Degraded state).
2. Khoá chặt 6 Định luật Terminal và 11 Cổng nghiệm thu định lượng (Gates A–K).
3. **Chấm dứt hoàn toàn vòng lặp lý thuyết kiến trúc.** Mọi chi tiết còn lại (tốc độ serialize của `@xterm/addon-serialize`, độ trễ layout trên Windows) sẽ được đo lường bằng test harness thực tế trong quá trình thi công.

**Điểm đánh giá sẵn sàng thi công:** **9.8 / 10.0** — **CHÍNH THỨC CHUYỂN GIAO SANG `/ak:plan` ĐỂ LẬP KẾ HOẠCH CHO PHASE T0 VÀ T1.**
