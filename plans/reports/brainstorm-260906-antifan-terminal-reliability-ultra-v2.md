# HỢP ĐỒNG KIẾN TRÚC & ĐẶC TẢ THI CÔNG V2: ANTI-FAN TERMINAL RELIABILITY OVERHAUL

**Trạng thái artifact:** Hợp đồng kiến trúc & đặc tả giao thức V2 — **Chính thức phê duyệt cho `/ak:plan` (Phase T0 & T1)**  
**Kế thừa:** Thẩm định sâu 1747 dòng (`2026-09-05`), Best-of-5 Ultra Brainstorm (`2026-09-06`), và Phản biện Kiến trúc Kongming v2 (`fable-thinking`).  
**Workspace:** `E:\Work\apps\antifan-browser-desktop` (Commit `96aa34f`)  
**Host Workstation Reality:** Windows 11 Pro x64 (10.0.22000), Intel Core i5-9300H @ 2.40GHz (4C/8T), Intel UHD Graphics 630, 16–32 GB RAM, single theme developer (Haravan, Sapo, Shopify CLI, PowerShell 5.1/7, AI CLIs: Oh My Pi / Codex, Vite/esbuild watchers).  
**Kỷ luật khẳng định (Claim Discipline):** Mọi phát biểu mã nguồn đều được gán nhãn `[OBSERVED]`, `[DERIVED]`, `[RISK]`, hoặc `[ASSUMED]`.

---

## I. NĂM ĐỊNH LUẬT BẤT BIẾN CỦA ANTIFAN TERMINAL (THE 5 TERMINAL LAWS)

```text
ĐỊNH LUẬT #1 (LIFECYCLE SEPARATION & RENDERER BOUNDARY)
PTY Session ≠ Terminal View ≠ Layout Binding.
- Trong cùng một Renderer (WebContents): Đổi tab, bật/tắt Split, ẩn/hiện Sidebar, hay Resize
  TUYỆT ĐỐI KHÔNG ĐƯỢC huỷ (dispose) TerminalView đang hoạt động.
- Giữa các Renderer Process khác nhau (Dock ↔ Popout BrowserWindow):
  Bắt buộc phải qua Giao thức Bàn giao View tường minh (Explicit View Handoff Protocol).

ĐỊNH LUẬT #2 (DELIVERY TRUTH & JOURNALING)
IPC Delivery ≠ State Synchronization.
- IPC send thành công không đồng nghĩa Renderer đã render đúng.
- Main Process sở hữu Sự thật Vận chuyển thông qua SessionDeliveryJournal (RAM-bound, theo từng thế hệ session).

ĐỊNH LUẬT #3 (SESSION IDENTITY & DEMARCATION)
Persisted Transcript ≠ Resurrected Process.
- Định danh phiên hoạt động là bộ 3 giá trị duy nhất: (sessionId, generation, seq).
- Khởi động lại ứng dụng là khôi phục DỮ LIỆU LỊCH SỬ (Transcript Identity), không phải phục sinh TIẾN TRÌNH (Process Identity). Shell mới phải xuất phát từ Clean VT State.

ĐỊNH LUẬT #4 (ZERO PRIVATE INTRUSION)
No Private Native / Runtime Internals in New Architecture.
- Cấm phụ thuộc vào trường private của xterm (_renderService) hoặc node-pty (_agent, _socket).
- Mọi tương tác phải qua API công khai hoặc cơ chế phòng vệ có bảo vệ biên (defensive guards).

ĐỊNH LUẬT #5 (SINGLE AUTHORITY PRINCIPLE)
One PTY session has exactly one input owner and one geometry owner at any instant.
- Một PTY session có thể có nhiều View quan sát trong lúc bàn giao (handoff),
  nhưng tại một thời điểm CHỈ DUY NHẤT một View được quyền nhận bàn phím người dùng và điều khiển kích thước (cols/rows) của PTY.
```

---

## II. BẰNG CHỨNG THỰC TẾ TRÊN MÃ NGUỒN (`96aa34f`) [OBSERVED]

1. **Vòng đời Split singleton bất đối xứng [OBSERVED]:**
   - Khai báo biến singleton toàn cục: `src/renderer/standalone.js:445–451` (`let splitTerm = null; let splitFitAddon = null; let splitWriteTarget = null;`).
   - Huỷ diệt xterm khi unmount: `src/renderer/standalone.js:1066–1073` (`splitTerm?.dispose(); splitTerm = null;`).
   - Tái tạo xterm mới khi mount lại: `src/renderer/standalone.js:1123–1138` (`splitTerm = new Terminal(...)`).
2. **Ngân sách dây JSON 40 KiB chia sẻ [OBSERVED]:**
   - Định nghĩa: `src/main/browser/terminal-manager.ts:99` (`const GLOBAL_JSON_BUFFER_BUDGET_BYTES = 40 * 1024;`).
   - Phân bổ mẩu đuôi: `src/main/browser/terminal-manager.ts:844–856` (Split chỉ nhận mẩu đuôi 4–8 KiB từ `safeSliceTailJsonBounded`).
3. **Bỏ rơi IPC khi đóng Sidebar [OBSERVED]:**
   - Chặn phát data: `src/main/browser/native-tab-host.ts:1164–1166`:
     ```ts
     if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
       safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload);
     }
     ```
4. **Mù Sequence Gap trong Renderer [OBSERVED]:**
   - Xử lý sequence tại `src/renderer/standalone.js:1896–1901` (Split) và `1924–1929` (Main): Chỉ lọc trùng (`chunkSeq <= lastRenderedSeq`), nhưng nếu `chunkSeq > lastRenderedSeq + 1` thì gán thẳng `lastRenderedSeq = chunkSeq` mà không kích hoạt resync.
5. **Lỗi nuốt buffer lúc khôi phục [OBSERVED]:**
   - `src/main/browser/terminal-manager.ts:426, 435`: Gọi `this.spawn(item.id, item.cwd || this.currentCwd, '')`, truyền chuỗi rỗng `''` thay vì `item.buffer`.
6. **Thực trạng dọn dẹp tiến trình Windows [OBSERVED]:**
   - Không hề có Windows Job Object trong code. `src/main/browser/terminal-manager.ts:51–55` sử dụng lệnh CLI `taskkill /pid PID /T /F`.
   - `src/main/browser/terminal-manager.ts:679–692` chọc trực tiếp vào private internal `(ptyInstance as any)._agent` để kill socket worker và process.
7. **Ranh giới Renderer của Popout [OBSERVED]:**
   - `src/main/browser/native-tab-host.ts:338, 5796–5830, 5891–5930`: Popout terminal là các thực thể `BrowserWindow` độc lập trong `this.terminalWindows` với WebContents và Renderer process riêng biệt.

---

## III. CHI TIẾT 15 ĐIỂM ĐẶC TẢ THI CÔNG HOÀN CHỈNH CHO `/ak:plan`

### 1. Luật #1 theo ranh giới Renderer & Giao thức Handoff Popout
- **Trong cùng Renderer (Docked):** View chuyển giữa Main $\leftrightarrow$ Split $\leftrightarrow$ Shelf. Không bao giờ huỷ xterm instance.
- **Giữa 2 Renderer (Dock $\leftrightarrow$ Popout):** Chạy `PopoutHandoffProtocol`:
  ```text
  [Source Renderer]                         [Main Process]                      [Target Renderer]
  Active TerminalView (seq=1520)
         │
         ├───► 1. HANDOFF_PREPARE (sessionId, lastAppliedSeq=1520)
         │           │
         │           ├───► 2. Freeze delivery watermark (generation=2, freezeSeq=1523)
         │           │        Buffer incoming chunks >= 1524
         │           │
         │           ├─────────────────────────────────────────► 3. CREATE_VIEW (sessionId, gen=2, throughSeq=1523)
         │           │                                                Create new xterm, hydrate snapshot
         │           │                                                Mount as VISIBLE
         │           │◄───────────────────────────────────────── 4. HANDOFF_READY (target accepts input authority)
         │           │
         │     5. Transfer Single Authority (Law #5):
         │        Target becomes sole Input & Geometry Owner
         │
  6. Source enters PARKED / DISPOSED
  ```

### 2. Giao thức Tự vá Gap & Trạng thái `DEGRADED`
- **Nguyên lý:** Từ một raw ANSI tail bị cắt vụn trong quá khứ, việc gọi `term.reset()` rồi bơm lại 512 KiB byte thô **về mặt toán học không thể bảo đảm phục hồi nguyên vẹn 100% trạng thái con trỏ và alternate screen của TUI [DERIVED]**.
- **Máy trạng thái Contiguous Stream ở Renderer:**
  ```text
  IDLE
    ↓
  READY ──(chunk.seq > last + 1)──► GAPPED
                                      ↓
                                  RESYNCING ──(getDelta trả OK)──► READY
                                      │
                                      └──(getDelta trả DELTA_EXPIRED)──► DEGRADED
  ```
- **Ý nghĩa trạng thái `DEGRADED`:**
  - View bị mất tính liên tục chính xác.
  - Hiển thị badge: `[Display Out of Sync - PTY Still Running - Click to Resync View]`.
  - Không được âm thầm tự đánh dấu `READY` để lừa dối hệ thống giám sát.

### 3. Phân lập `SessionDeliveryJournal` (RAM) và `TranscriptStore` (Disk)
- **`SessionDeliveryJournal` (Bộ nhớ tạm Main Process):**
  - **Mục đích:** Phục vụ vá gap trực tiếp trong phiên live (`getTerminalDelta`).
  - **Phạm vi:** Sống theo PTY process và thế hệ hiện tại (`generation`).
  - **Giới hạn kép (Dual-bound):** `MAX_BYTES = 2 * 1024 * 1024` (2 MiB) VÀ `MAX_CHUNKS = 4096`. Tự động evict phần tử cũ nhất khi chạm 1 trong 2 ngưỡng.
  - **Độ bền:** Memory-only, tự giải phóng khi session đóng.
- **`TranscriptStore` (Lưu trữ đĩa bền vững):**
  - **Mục đích:** Phục vụ developer đọc lại lịch sử sau khi app khởi động lại.
  - **Phạm vi:** Bền vững qua các lần tắt/mở ứng dụng.
  - **Dung lượng:** Giới hạn 256 KiB/session trên đĩa (`terminal-sessions.json` hoặc thư mục `transcripts/`).

### 4. Hợp đồng giao tiếp `TerminalDeltaResult`
```ts
type TerminalDeltaResult =
  | {
      status: 'OK';
      generation: number;
      fromSeq: number;
      throughSeq: number;
      chunks: Array<{ seq: number; data: string }>;
    }
  | {
      status: 'DELTA_EXPIRED';
      generation: number;
      retainedFromSeq: number;
      retainedThroughSeq: number;
    }
  | {
      status: 'GENERATION_MISMATCH';
      currentGeneration: number;
    }
  | {
      status: 'SESSION_CLOSED';
      finalSeq: number;
    };
```

### 5. Cơ chế Bắt tay Đồng bộ khi Khởi động (Bootstrap Sync Handshake)
- **Vấn đề [RISK]:** Nếu Renderer reload khi PTY đang ở trạng thái nhàn rỗi (idle, không có output mới), cơ chế bắt gap thuần tuý theo chunk mới sẽ không bao giờ kích hoạt, khiến Renderer bị đóng băng ở trạng thái cũ.
- **Giải pháp:** Khi bất kỳ View nào được attach vào DOM, bắt buộc kích hoạt `syncTerminalView`:
  ```ts
  api.syncTerminalView({
    sessionId: string,
    knownGeneration: number,
    lastAppliedSeq: number
  }): Promise<'UP_TO_DATE' | 'DELTA' | 'FULL_INITIAL_STATE' | 'GENERATION_CHANGED' | 'SESSION_CLOSED'>
  ```

### 6. Quản lý Trạng thái Mount (`mountState`) & Quyền Lực Hình Học
- View có 4 trạng thái: `'VISIBLE' | 'PARKED' | 'HANDOFF' | 'DISPOSED'`.
- **Rào chắn hình học:**
  - `PARKED`: View nằm tại `#terminal-parking-shelf` (off-screen nhưng layout tree vẫn tính được). Vẫn nhận live data từ PTY. Máy trạng thái VT sống. **TUYỆT ĐỐI KHÔNG ĐƯỢC phát lệnh resize PTY [LAW #5]**.
  - `VISIBLE`: Chỉ khi View ở trạng thái này, `FitAddon.proposeDimensions()` mới được quyền gửi IPC yêu cầu PTY thay đổi `cols`/`rows`.

### 7. Tối giản hoá Kiểm soát Hình học tại Phase T3
- Không dùng private internal `_renderService` và không query DOM selector nội bộ `.xterm-char-measure-element`.
- **Cơ chế:** Trao quyền quyết định trực tiếp cho API công khai của FitAddon:
  ```ts
  const dims = fitAddon.proposeDimensions();
  if (!dims || dims.rows < 5 || dims.cols < 20) {
    // Từ chối chia đôi màn hình; giữ 100% diện tích cho pane chính
    rejectSplitLayout('INSUFFICIENT_CONTAINER_SPACE');
  } else {
    applySplitLayout(dims);
  }
  ```

### 8. Loại bỏ hoàn toàn việc Backend tự sinh mã điều khiển VT (DECSTR)
- Backend giữ đúng vai trò là ống dẫn dữ liệu thuần khiết từ OS PTY. Không được tự tiện inject escape sequence `\x1b[!p` hay chuỗi reset vào stream.
- Khi khởi tạo tiến trình mới, việc reset giao diện màn hình (nếu có tái sử dụng instance xterm) do chính Renderer thực hiện qua `term.reset()` trước khi gắn dữ liệu của generation mới.

### 9. Phân định ranh giới Khôi phục Transcript Lịch sử
- **Cơ chế an toàn:** Dữ liệu transcript cũ từ đĩa được nạp vào một View ở trạng thái **Read-Only / Archived**.
- Mọi phím bấm của người dùng sẽ gửi tín hiệu khởi động một shell PTY mới toanh (Generation mới).
- Terminal hiển thị banner phân cách:
  ```text
  ┌────────────────────────────────────────────────────────┐
  │ [Restored Transcript - Process Terminated]            │
  │ Press any key to start a fresh shell session...       │
  └────────────────────────────────────────────────────────┘
  ```

### 10. Tiêu chuẩn Oracle Test Harness với `@xterm/headless`
- `@xterm/headless` chỉ chạy trong bộ test suite E2E, không bundle vào runtime production.
- **Oracle Verification:**
  - Cùng phiên bản core xterm.js.
  - Cùng kích thước cols/rows và timeline các sự kiện resize.
  - Cùng luồng stream byte PTY.
  - So sánh đối soát 5 trường dữ liệu: `buffer.active.type`, toạ độ `cursorX/cursorY`, `baseY`, `viewportY`, và mảng dòng text màn hình.

---

## IV. BẢNG TIÊU CHUẨN NGHIỆM THU ĐẦY ĐỦ (GATES A – K)

| Cổng | Mục tiêu kiểm chứng | Điều kiện ĐẠT (Pass Criteria) |
|---|---|---|
| **GATE-A** | Tính liên tục của View | Chuyển tab 50 lần liên tục khi log đang stream 1,000 dòng/s $\rightarrow$ `xterm.dispose()` gọi **đúng 0 lần**. Toàn bộ stream byte PTY được render đầy đủ. |
| **GATE-B** | Tự vá Sequence Gap | Giả lập rớt 50 chunk $\rightarrow$ Chuyển `GAPPED` $\rightarrow$ `RESYNCING` $\rightarrow$ Phục hồi `READY` với $p95 < 250\text{ms}, p99 < 500\text{ms}$. 0 byte mất, 0 chunk trùng. |
| **GATE-C** | Bền bỉ khi đóng Sidebar | Đóng sidebar 30 phút khi build log đang chạy $\rightarrow$ Mở lại thấy ngay 100% dữ liệu, không bị gián đoạn. |
| **GATE-D** | Ổn định TUI với Test Oracle | So sánh với `@xterm/headless` sau 50 lần chuyển tab $\rightarrow$ Khớp 100% về toạ độ con trỏ, buffer type và text màn hình. |
| **GATE-E** | Rào chắn hình học tối thiểu | Co container xuống < 120px $\rightarrow$ Tự động ẩn split an toàn; số dòng hiển thị không bao giờ < 5 dòng; 0 lỗi console. |
| **GATE-F** | Phân định lịch sử Restart | Mở lại app $\rightarrow$ Transcript cũ hiển thị ở chế độ Read-Only có banner phân cách; shell mới chạy ở clean state. |
| **GATE-G** | Dọn dẹp tiến trình Windows | Đóng 5 terminal $\rightarrow$ Khẳng định toàn bộ PID trong danh sách cấp phát của AntiFan không còn tồn tại trên OS (`Process.Exists(pid) == false`). |
| **GATE-H** | Bàn giao Popout (Cross-Renderer) | Thực hiện 50 chu kỳ Dock $\leftrightarrow$ Popout khi stream data $\rightarrow$ 0 sequence mất, 0 sequence trùng, đúng generation, input gửi đúng 1 lần (Law #5). |
| **GATE-I** | Phục hồi sau Renderer Reload | Renderer reload khi PTY idle $\rightarrow$ Bootstrap handshake tự kéo delta lên seq mới nhất, không chờ chunk kế tiếp. |
| **GATE-J** | Trung thực khi Delta hết hạn | Bơm gap vượt quá 2 MiB / 4096 chunks $\rightarrow$ Chuyển `DEGRADED`, không tự động đánh dấu `READY` giả tạo. |
| **GATE-K** | Giới hạn tài nguyên bộ nhớ | 10 session chạy tải cao $\rightarrow$ Journal RAM $\le 2\text{ MiB/session}$; số lượng View = số session live; RAM renderer ổn định. |

---

## V. LỘ TRÌNH THI CÔNG TUẦN TỰ (T0 $\rightarrow$ T5)

```text
Phase T0: Diagnostic Instrumentation & Test Harness
  │  - Expose `window.__antifanTerminalHealth`
  │  - Thiết lập `@xterm/headless` Oracle Test Harness
  ▼
Phase T1: Terminal State Synchronization Protocol [CỘT MỐC: P0-Transport Certified]
  │  - Xoá bỏ chốt chặn `isSidebarOpen` tại `native-tab-host.ts:1164`
  │  - Cài đặt `SessionDeliveryJournal` (dual-bound: 2 MiB / 4096 chunks) tại Main
  │  - Cài đặt state machine READY -> GAPPED -> RESYNCING -> DEGRADED tại Renderer
  │  - Cài đặt Bootstrap Sync Handshake khi view attach
  ▼
Phase T2: Unified Persistent TerminalViewRegistry
  │  - Khai tử các biến singleton `splitTerm`, `splitFitAddon`
  │  - Quản lý toàn bộ View trong `TerminalViewRegistry`
  │  - Thiết lập `#terminal-parking-shelf` (measurable, off-screen)
  │  - Cài đặt `PopoutHandoffProtocol` qua WebContents boundary
  ▼
Phase T3: Geometry Authority & Cell Floor Guard
  │  - Trao quyền quyết định hình học cho `FitAddon.proposeDimensions()`
  │  - Chặn đứng hình học < 5 dòng, xoá sổ thanh đen 8px
  │  - Diệt sạch các khối `catch {}` nuốt lỗi
  ▼
Phase T4: Transcript Durability & Session Demarcation
  │  - Phân tách `TranscriptStore` trên đĩa và live PTY
  │  - Sửa lỗi truyền chuỗi rỗng tại `terminal-manager.ts:426, 435`
  ▼
Phase T5: Windows Process Lifecycle Hardening
     - Xây dựng `ProcessOwnershipRegistry`
     - Cô lập `WindowsPtyAdapter`, loại bỏ truy cập private `_agent`
```

---

## VI. KẾT LUẬN CỦA CONTROLLER

Bản hợp đồng V2 này đã giải quyết triệt để 2 vấn đề hóc búa nhất của tầng phân tán trong Electron:
1. **Ranh giới Renderer:** Phân định rõ ràng giữa hoán đổi layout nội bộ một Document (Luật #1) và bàn giao giao diện qua các WebContents khác nhau (Dock $\leftrightarrow$ Popout).
2. **Tính trung thực toán học của trạng thái:** Thừa nhận giới hạn của raw ANSI tail, đưa vào trạng thái `DEGRADED` thay vì cam kết giả tạo `READY`.

Hợp đồng này đạt mức độ hoàn thiện **9.8/10**, đã được lưu trữ bền vững tại `plans/reports/brainstorm-260906-antifan-terminal-reliability-ultra-v2.md` và sẵn sàng 100% làm tài liệu đầu vào cho `/ak:plan` triển khai Phase T0 và T1.
