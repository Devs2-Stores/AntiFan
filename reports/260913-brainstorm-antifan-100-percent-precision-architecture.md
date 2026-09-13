# Brainstorm Contract: AntiFan 100% Precision Architecture
## Đạo luật 100% Chính xác: Nền tảng Đo lường, Tương tác và Xác minh Tuyệt đối cho Theme Engineering

- **Tác giả:** Candidate 5 (AntiFan Ultra-Verifier Wave)
- **Ngày:** 2026-09-13
- **Chỉ thị Tối thượng của Người dùng (Absolute Ground Truth):**  
  > *"Cái tôi cần là độ chính xác 100% chứ ko phải tiết kiệm tiền hay thời gian"*  
  *(Chi phí token LLM, hóa đơn API, thời gian phát triển và tài nguyên CPU là thứ yếu; Độ chính xác, độ trung thực cơ học và tính tất định tuyệt đối là tiêu chí duy nhất.)*
- **Đối tượng áp dụng:** Kiến trúc AntiFan Core (`src/main/browser/*`, `src/main/verification/*`, `src/main/tools/*`)
- **Tình trạng văn bản:** Khế ước Brainstorm Cố định (Bounded Brainstorm Contract)

---

## Executive Framing

Trong phát triển phần mềm thông thường, các kỹ sư thường thỏa hiệp: giảm độ sâu kiểm thử, làm tròn số đo subpixel, cắt bớt watchdog hoặc dùng event giả lập (synthetic events) để tiết kiệm vài mili-giây và vài token ngữ cảnh. Nhưng đối với **AntiFan — Engine tự động hóa và đồng hành kỹ thuật cho Storefront Liquid Theme Engineering (Haravan, Shopify, Sapo)** — sự thỏa hiệp đó là một **sai lầm chí mạng (fatal fallacy)**.

1. **Hiệu ứng lũy thừa của sai số trong Theme QA:**  
   Một chiến dịch Theme QA (như `.canary/theme-fidelity-run4/`) bao gồm 42 legs kiểm tra độc lập kết hợp logic AND. Nếu mỗi leg chỉ có độ chính xác 99% (tức 1% flake/nhiễu), xác suất toàn bộ chiến dịch vượt qua là $0.99^{42} \approx 65.4\%$. Điều này đồng nghĩa với **34.6% kết quả là báo động giả (false alarm)**! Khi đó, AI Agent sẽ bị cuốn vào vòng lặp hallucination: sửa những đoạn code Liquid hoàn toàn đúng, phá vỡ cấu trúc theme đang chạy tốt, tiêu tốn gấp 10x chi phí và thời gian của lập trình viên để truy vết.
2. **Cái giá của tương tác giả (Synthetic Dispatches):**  
   Khi `semantic-ref-executor.ts` bắn `new MouseEvent('click')` với `isTrusted: false`, các hệ thống giỏ hàng Ajax hiện đại (như Shopify Dawn Ajax Drawer, Haravan QuickView, Vue/React-hydrated buttons, Cloudflare Turnstile, reCAPTCHA v3) sẽ âm thầm drop sự kiện. AntiFan sẽ kết luận sai lệch: *"Theme bị hỏng nút Add to Cart"*, trong khi thực tế chỉ vì automation engine không mô phỏng đúng cấp độ phần cứng.
3. **Sự sụp đổ của Renderer khi thiếu Watchdog:**  
   Khi theme chứa một vòng lặp đồng bộ vô hạn (`while(true)` do lỗi Liquid render vòng lặp biến thể) hoặc đệ quy DOM sâu, việc AntiFan dùng `Promise.race` trong in-page context (`tab-devtools-host.ts:2169`) khiến toàn bộ renderer process của Chromium bị treo cứng ở 100% CPU. Mọi cơ chế timeout phía Node.js bị vô hiệu hóa vì renderer thread không thể nhả event loop.

Do đó, **100% Precision không phải là một tùy chọn cao cấp (luxury feature), mà là điều kiện tiên quyết duy nhất để AntiFan có giá trị tồn tại**. Báo cáo này từ bỏ hoàn toàn tư duy "tiết kiệm chi phí", thiết lập một kiến trúc tất định, fail-closed, trung thực ở cấp độ byte và pixel.

---

## 1. The Four Pillars of 100% Precision in AntiFan

Kiến trúc 100% Precision của AntiFan được xây dựng trên 4 trụ cột cơ học không thể bị phá vỡ:

```
+---------------------------------------------------------------------------------------+
|                               ANTIFAN 100% PRECISION ENGINE                           |
+---------------------------+---------------------------+-------------------------------+
| 1. CAPTURE PLANE          | 2. INTERACTION PLANE      | 3. INSPECTION PLANE           |
| - 8 Invariant Controls    | - 100% Trusted CDP Input  | - Full Box-Model & Typography |
| - 3-Pass Settle Stability | - Zero Synthetic Fallback | - Active vs Overridden CSS    |
| - Non-Blank Verification  | - Strict Preflight Occlude| - Cyclic DOM Sanitization     |
+---------------------------+---------------------------+-------------------------------+
|                                4. ENGINE & EXECUTION PLANE                            |
| - Out-of-Band CDP Watchdog (Runtime.terminateExecution)                               |
| - WebContents Lifecycle & Memory Quiescence                                           |
| - Split-Review Desktop/Mobile Physical Parity                                         |
+---------------------------------------------------------------------------------------+
```

### Pillar 1: Capture Plane (Visual Fidelity & Zero-Flake Measurement)
Mục tiêu: Đảm bảo hai ảnh chụp của cùng một trạng thái giao diện phải đồng nhất 100% ở mức pixel diff ($0.00\%$ sai số giả định), loại bỏ hoàn toàn hiện tượng layout shift, font flash, và trôi nhịp render.

1. **Khóa 8 Tham số Bất biến (Paired Invariant Controls - Kế thừa từ Obscura & Kitesurf):**
   - **Viewport Geometry:** Cố định viewport chính xác tuyệt đối (ví dụ Desktop 1440x900 @ DPR=1.000, Mobile 375x667 @ DPR=2.000 hoặc DPR=3.000). Vô hiệu hóa tính năng dynamic DPI scaling của Windows (`--high-dpi-support=1 --force-device-scale-factor=1`).
   - **DPR Hardening:** Chặn đứng hiện tượng subpixel rounding bằng cách ép kích thước render về số nguyên vật lý (`Math.round` / physical pixel mapping).
   - **Identity & Session Vault:** Cô lập cookies, LocalStorage, SessionStorage qua `browser-session-partition.ts` để trạng thái theme không bị ô nhiễm chéo.
   - **Network Input Quiescence:** Tích hợp `first-party-network-tracker.ts` và `zero-network-interceptor.ts`. Đóng băng toàn bộ request bên thứ 3 (analytics, tracking pixels, marketing scripts) vốn luôn gây biến thiên DOM ngẫu nhiên.
   - **Multi-Pass Settle Barrier:** Không tin tưởng một lần `double-rAF` đơn lẻ. Áp dụng quy tắc **3-Pass Settle**: Lấy mẫu trạng thái visual DOM tại 3 mốc (ví dụ: $T_0$, $T_0 + 400\text{ms}$, $T_0 + 800\text{ms}$). Nếu và chỉ nếu độ trôi fingerprint (`churn == 0`) trên cả 3 lần lấy mẫu thì mới công nhận trạng thái đã `SETTLED`.
   - **Scroll Integer Alignment:** Khắc phục lỗi scroll fractional pixel trong `scroll-prewarm.ts` và `visual-capture.ts`. Cố định `scrollX` và `scrollY` về số nguyên tuyệt đối trước khi gọi raster clip.
   - **Animation & Dynamic Media Freezing:** Thực thi đóng băng toàn diện qua CDP:
     - Gọi `Animation.setPlaybackRate({ playbackRate: 0 })` qua CDP.
     - Ép CSS `* { animation-play-state: paused !important; transition: none !important; }`.
     - Tạm dừng `<video>`, `<audio>`, GIF animations và canvas requestAnimationFrame qua `anti.media.freeze`.
   - **Capture Boundary & Non-Blank Gate:** Trước khi đưa ảnh raster vào `computePixelDiff`, hệ thống bắt buộc chạy thuật toán kiểm tra tính hợp lệ: tính toán histogram độ sáng (luminance variance). Nếu ảnh có độ biến thiên màu sắc $< 0.001$ (màn hình trắng xóa hoặc đen kịt do crash renderer), lập tức fail-closed với mã lỗi `CAPTURE_DEGRADED_BLANK`, từ chối so sánh visual diff.

### Pillar 2: Interaction Plane (100% Trusted & Faithful User Simulation)
Mục tiêu: Mọi tương tác của Agent với storefront phải mang đầy đủ đặc tính cơ học của người dùng thực, kích hoạt chính xác mọi handler của trình duyệt và theme framework.

1. **100% CDP Native Hardware Input (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`):**
   - Loại bỏ hoàn toàn fallback nguy hại tại `src/main/browser/tab-automation-host.ts:862` và `src/main/browser/semantic-ref-executor.ts:610-613`. Khi CDP gặp lỗi hoặc kênh debugger bận, hệ thống **tuyệt đối không âm thầm fallback sang synthetic dispatch** (`dispatchEvent(new MouseEvent(...))`).
   - Mọi sự kiện phát ra phải mang `event.isTrusted === true`, có `buttons`, `clientX`, `clientY`, `screenX`, `screenY` và chuỗi sự kiện phần cứng đầy đủ: `pointerover` $\rightarrow$ `pointerenter` $\rightarrow$ `mousemove` $\rightarrow$ `pointerdown` $\rightarrow$ `mousedown` $\rightarrow$ `focus` $\rightarrow$ `pointerup` $\rightarrow$ `mouseup` $\rightarrow$ `click`.
   - Đối với bàn phím: Bắt buộc dispatch đầy đủ `rawKeyDown`, `keyDown`, `char`, `keyUp` thông qua `Input.dispatchKeyEvent` kèm theo mã `windowsVirtualKeyCode`, `code`, và `key` chuẩn xác (`keyboard-normalizer.ts`).
2. **Pre-flight Occlusion & Hit-Test Gate Không Thể Khoan Thủng:**
   - Trước khi click, thực hiện hit-test tại điểm mục tiêu (`samplePoints(computedRect)` trong `semantic-ref-executor.ts:566`). Nếu mục tiêu bị che khuất bởi Modal, Newsletter Popup, hoặc Sticky Header (`TARGET_OBSCURED`), hệ thống từ chối hành động ngay lập tức, trả về thông tin chi tiết về phần tử che khuất (`obscuredBy`, `z-index`, `rect`).
   - Tuyệt đối không cho phép synthetic click "xuyên thấu" qua lớp overlay, vì điều đó làm sai lệch hoàn toàn trải nghiệm người dùng thực.
3. **Drag & Drop / Trajectory Chuẩn Xác Vật Lý:**
   - Sử dụng `Input.dispatchDragEvent` kết hợp `Input.dispatchMouseEvent` với quỹ đạo Bézier mượt mà (`DRAG_STEP_BOUNDS`), đảm bảo các widget phức tạp như Price Range Slider, Image Gallery Carousel, và Color Swatch Swiper nhận diện được các frame kéo thả liên tục.

### Pillar 3: Inspection Plane (Deep Semantic, Style, and Box-Model Grounding)
Mục tiêu: Cung cấp bức tranh toàn diện, trung thực và đầy đủ nhất về trạng thái DOM, CSS Cascade, và Geometry; loại bỏ việc cắt xén thông tin làm mù Agent.

1. **Khảo sát CSS Chuyên sâu (Computed vs Matched Cascade):**
   - Không chỉ đọc `getComputedStyle`, AntiFan khai thác giao thức CDP `CSS.getMatchedStylesForNode` (`css-cascade-analyzer.ts`). Agent phải thấy được: Rule nào đang áp dụng, Rule nào bị ghi đè (overridden), CSS Variable nào đang kế thừa từ `:root`, và Media Query nào đang kích hoạt.
   - Trích xuất toàn vẹn Box Model: Content box, Padding box, Border box, Margin box kèm tọa độ subpixel dạng `DOMRect` thực tế.
2. **Ngăn chặn Chu kỳ DOM và Bảo vệ Bộ nhớ (Cyclic & Depth Bounded Sanitization):**
   - Kế thừa cơ chế phòng thủ `tree.rs` của Obscura: Khi quét DOM (`tree-walker-sanitizer.ts`), áp dụng cơ chế phát hiện chu kỳ (cycle detection qua `WeakSet`) và giới hạn độ sâu tối đa (max depth = 32), ngăn chặn DOM recursive loops trong các ứng dụng SPA phức tạp.
3. **Bảo tồn Định danh Theme Liquid:**
   - Ánh xạ trực tiếp từ node DOM trên trình duyệt về mã nguồn Liquid cục bộ qua `theme-source-mapper.ts`, trích xuất các thuộc tính đặc trưng của nền tảng: `data-section-id`, `data-section-type`, `data-product-id`, `data-variant-id`. Agent có thể định vị chính xác dòng code Liquid nào sinh ra element bị lỗi hiển thị.

### Pillar 4: Engine & Execution Plane (Watchdog, Process Resilience & Leak Containment)
Mục tiêu: Đảm bảo trình duyệt và môi trường thực thi của AntiFan không bao giờ bị treo cứng, không bị rò rỉ bộ nhớ, và duy trì tính toàn vẹn 24/7.

1. **V8 Out-of-Band Watchdog (`Runtime.terminateExecution`):**
   - Giải quyết triệt để lỗ hổng chí mạng tại `src/main/browser/tab-devtools-host.ts:2169`: Thay thế cơ chế `Promise.race` nội hàm trang (vốn vô dụng trước các vòng lặp đồng bộ vô hạn) bằng một **Watchdog giám sát ngoài luồng (Out-of-Band Watchdog)** chạy tại tiến trình chính (Main Process).
   - Nếu một lệnh thực thi script qua CDP hoặc DevTools vượt quá ngân sách thời gian (`execBudgetMs`, mặc định 3,000ms), Watchdog sẽ độc lập gửi lệnh CDP `Runtime.terminateExecution` trực tiếp tới V8 Isolate của tab đó.
   - Thao tác này ngắt cưỡng bức luồng JavaScript của renderer mà không làm sập process trình duyệt, trả về lỗi `EXECUTION_TERMINATED_BY_WATCHDOG` rõ ràng cho Agent.
2. **Khôi phục Sập Renderer Tự động (Crash Resilience & Zero-State Recovery):**
   - Lắng nghe sự kiện `webContents.on('render-process-gone')`. Nếu renderer bị sập do OOM (Out of Memory) hoặc crash nội bộ Chromium, hệ thống tự động dọn sạch state cũ, tái khởi tạo WebContents trong vòng < 500ms, phục hồi lại URL và session partition tương ứng.
3. **Đồng bộ Đối xứng Desktop/Mobile (Split-Review Physical Parity):**
   - `split-review-coordinator.ts` quản lý song song hai `WebContentsView` (Desktop và Mobile).
   - Đảm bảo tính độc lập hoàn toàn về layout viewport và touch emulation: Tab Mobile phải được cấu hình chính xác `Emulation.setTouchEmulationEnabled({ enabled: true })` và `Emulation.setUserAgentOverride` với mobile user-agent, trong khi Desktop giữ nguyên pointer mouse chuẩn. Không để cấu hình của pane này rò rỉ sang pane kia.

---

## 2. Bounded Delivery Contract

### Outcome
AntiFan đạt trạng thái **Zero-Flake, 100% Deterministic Theme Engineering Engine**:
- Mọi tương tác đều là native trusted hardware events (`event.isTrusted: true`).
- Mọi phép đo thị giác (visual capture) đều có độ biến thiên ngẫu nhiên (measurement flake) $\le 1/1,000$ runs.
- Mọi kịch bản đóng băng script hoặc vòng lặp vô hạn đều được chặn đứng trong vòng 1,500ms bởi Out-of-Band Watchdog.
- Toàn bộ 42/42 legs của chiến dịch Theme Fidelity QA chạy ổn định, không có bất kỳ false-positive nào do lỗi công cụ.

### Constraints
1. **Zero Synthetic Compromise:** Tuyệt đối cấm phát sinh sự kiện qua `dispatchEvent(new Event(...))` trong mọi luồng kiểm thử nghiệp vụ. Nếu CDP Input thất bại, báo cáo lỗi rõ ràng (`CDP_INPUT_FAILED`), không giả vờ thành công.
2. **Fail-Closed Gatekeeper:** Khi bất kỳ điều kiện settle nào (mạng, font, ảnh, DOM quiet) chưa thỏa mãn sau thời gian timeout, kết quả kiểm tra phải trả về `INCONCLUSIVE` hoặc `SETTLE_TIMEOUT`, không bao giờ được phép chụp ảnh vội vã để rồi kết luận theme lỗi.
3. **No Live Store Mutation:** Không bao giờ ghi đè hoặc đẩy code lên live production theme ID (`1001510509`). Mọi thao tác chỉ diễn ra trên development theme copy (`1001512581`) hoặc môi trường preview cục bộ.
4. **Binary Receipt Integrity:** Mọi kết quả kiểm tra thị giác và tương tác đều phải xuất ra biên nhận điện tử bất biến (Auditable Receipt) kèm chữ ký băm SHA-256 đã chuẩn hóa LF (`report.json`).

### Non-goals
1. **Không tối ưu hóa số lượng token LLM:** Không thu gọn DOM thành Markdown sơ sài nếu việc đó làm mất đi các thuộc tính CSS, Box-model, hoặc Liquid metadata quan trọng.
2. **Không tối ưu hóa tốc độ thực thi bằng cách bỏ qua giai đoạn Settle:** Sẵn sàng chờ 800ms – 1,500ms để trang đạt trạng thái tĩnh tuyệt đối (quiescence), kiên quyết không chụp ảnh sớm để tiết kiệm thời gian.
3. **Không xây dựng một browser engine mới:** Khai thác tối đa sức mạnh sẵn có của Chromium CDP và Electron WebContents, không viết lại rendering engine từ đầu.

### Acceptance Criteria
Các tiêu chí nghiệm thu cơ học, định lượng và có thể phản nghiệm (falsifiable):

| # | Tiêu chí | Ngưỡng định lượng | Phương pháp kiểm chứng |
|---|----------|-------------------|------------------------|
| **AC-1** | **Visual Diff False-Positive Rate** | **0.00%** trên 50 lần đo liên tiếp | Chạy 50 lượt chụp lặp lại trên cùng một trang sản phẩm phức tạp có Sticky Header và Slider Carousel mà không đổi code; số pixel diff khác biệt phải bằng 0 ($diff = 0$). |
| **AC-2** | **Trusted Interaction Fidelity** | **100.0%** `event.isTrusted === true` | Lắng nghe event trên 10 theme Shopify/Haravan hàng đầu; 100% các cú click/type vào nút "Add to Cart" và Ajax Drawer phải được kích hoạt thành công, 0 sự kiện bị drop. |
| **AC-3** | **Out-of-Band Watchdog Latency** | **$\le 1,500\text{ms}$** ngắt vòng lặp vô hạn | Chạy đoạn script `while(true){}` thông qua `anti.browser.evaluate`; Watchdog phải gửi `Runtime.terminateExecution` ngắt script trong $\le 1,500\text{ms}$, process Electron chính không bị lag. |
| **AC-4** | **Blank Screenshot Rejection** | **100% Fail-Closed** | Cố tình kích hoạt chụp ảnh khi renderer chưa sẵn sàng (màn hình trắng 0 variance); hệ thống phải ném lỗi `CAPTURE_DEGRADED_BLANK`, không đưa vào so sánh diff. |
| **AC-5** | **Split Review Pane Isolation** | **0 Leakage** | Kiểm tra tương tác touch trên Mobile pane không làm ảnh hưởng tới Desktop mouse state; DPR và User-Agent được cách ly 100% giữa hai WebContentsView. |
| **AC-6** | **Receipt Hash Reproducibility** | **100.0%** match SHA-256 | 6/6 file `report.json` sau khi chạy phải tính lại được đúng mã băm sha256 bất kể môi trường chạy trên Windows (CRLF) hay Linux (LF). |

---

## 3. Option Exploration (3 Architectural Approaches)

Để đạt được mục tiêu 100% Precision, chúng tôi tiến hành mổ xẻ 3 hướng tiếp cận kiến trúc khả thi, phân tích sâu về chi phí kỹ thuật, giả định chịu tải (load-bearing assumptions), và chế độ sụp đổ xấu nhất (worst-case failure mode):

```
                        BA HƯỚNG TIẾP CẬN KIẾN TRÚC
                                     |
    +--------------------------------+--------------------------------+
    |                                |                                |
    v                                v                                v
[Approach A]                     [Approach B]                     [Approach C]
Engine-Level CDP Hardening       Dual-Plane Shadow                Phased Precision Architecture
(Maximalist Direct)              Verification Harness             (Surgical Triad & Gates)
- Can thiệp trực tiếp lõi CDP   - Chạy song song 2 browser       - Nâng cấp chính xác 3 module lõi
- Xóa bỏ mọi fallback cũ         - Đối soát chéo từng frame       - Tối ưu hóa pipeline hiện hữu
- Viết Watchdog native C++/CDP   - Cực kỳ tốn kém tài nguyên      - Tận dụng tối đa code sẵn có
```

---

### Approach A: Engine-Level CDP Hardening & Invariant Capture Suite (Maximalist Direct)

#### Mô tả & Kiến trúc Cốt lõi
Tiến hành tái cấu trúc toàn diện tầng tự động hóa trình duyệt của AntiFan. Loại bỏ hoàn toàn script `semantic-ref-executor.ts` trong World 1004 khỏi vai trò dispatch action; chuyển 100% sang điều khiển bằng các lệnh giao thức CDP trực tiếp từ tiến trình Node.js:
- Mọi thao tác chuột/phím đều được gửi qua `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.
- Tích hợp một Worker Thread chuyên dụng trong tiến trình Node.js để làm Out-of-Band Watchdog, liên tục theo dõi heartbeat của Chromium renderer và phát lệnh `Runtime.terminateExecution` ngay khi phát hiện renderer nghẽn quá $1,000\text{ms}$.
- Triển khai bộ điều khiển Paired Invariant Capture Suite chặt chẽ: tự động cấu hình CDP Network Interception để chặn mọi request quảng cáo, dùng CDP `Emulation.setDeviceMetricsOverride` khóa chết DPR và Viewport, và dùng CDP `Animation.setPlaybackRate(0)` để đóng băng thời gian của trang web.

#### Đánh đổi & Chi phí (Trade-offs & Costs)
- **Ưu điểm:** Độ trễ thấp, can thiệp sâu nhất vào Chromium, loại bỏ hoàn toàn các lớp trung gian (zero-overhead execution), đạt độ trung thực cấp độ giao thức (protocol-level fidelity).
- **Chi phí:** Khối lượng công việc refactor rất lớn; phải viết lại nhiều logic xử lý hit-test tọa độ vốn đang chạy tốt trong World 1004 sang tính toán từ CDP layout tree; phụ thuộc sâu vào tính ổn định của giao thức CDP nội bộ của Electron.

#### Giả định Chịu tải & Chế độ Sụp đổ Xấu nhất (Load-bearing Assumption & Worst-case Failure Mode)
- **Giả định chịu tải:** Electron DevTools Protocol luôn giữ kết nối thông suốt và không bị crash socket khi renderer chịu tải nặng.
- **Worst-case failure mode:** Nếu kết nối CDP socket giữa Electron main process và renderer bị nghẽn (do IPC message buffer bị đầy khi trang phát sinh quá nhiều log/network events), các lệnh `Input.dispatchMouseEvent` có thể bị xếp hàng (queued) hoặc rớt, dẫn tới việc chuỗi hành vi bị lệch nhịp (desynchronization), khiến toàn bộ kịch bản kiểm thử bị dừng đột ngột mà không có cơ chế tự phục hồi.

---

### Approach B: Dual-Plane Shadow Verification Harness (Dual-Check Assurance)

#### Mô tả & Kiến trúc Cốt lõi
Xây dựng mô hình "Trọng tài kép" (Dual-Plane Shadow Comparator):
- Khi thực hiện kiểm thử Theme QA hoặc đo lường Visual Fidelity, AntiFan khởi chạy đồng thời hai môi trường độc lập:
  1. **Primary Plane:** AntiFan Desktop GUI (Electron WebContents) nơi người dùng và Agent tương tác trực tiếp.
  2. **Shadow Plane:** Một instance Chromium Headless tách biệt hoàn toàn (được điều khiển qua Playwright/CDP độc lập) tải cùng một URL và nhận cùng một chuỗi sự kiện được mirror trực tiếp.
- Mọi quyết định xác minh (Verification Claim) chỉ được công nhận là `VERIFIED` khi và chỉ khi: Kết quả raster image, DOM snapshot, và biến đổi giỏ hàng tại Primary Plane khớp $100\%$ với kết quả tại Shadow Plane (sai số diff = 0 giữa hai engine).

#### Đánh đổi & Chi phí (Trade-offs & Costs)
- **Ưu điểm:** Khả năng phát hiện sai số tuyệt đối; loại trừ hoàn toàn các lỗi đặc thù của Electron GUI hoặc lỗi do can thiệp của người dùng lên màn hình; cung cấp bằng chứng kép có độ tin cậy không thể chối cãi.
- **Chi phí:** Tăng gấp đôi mức tiêu thụ RAM và CPU của máy trạm; thời gian thiết lập phiên kiểm thử tăng gấp đôi; logic điều phối (orchestration) giữa hai instance cực kỳ phức tạp (phải đồng bộ hóa cookie, storage, và random nonces).

#### Giả định Chịu tải & Chế độ Sụp đổ Xấu nhất (Load-bearing Assumption & Worst-case Failure Mode)
- **Giả định chịu tải:** Cả hai môi trường (Electron WebContents và Playwright Chromium) phải có hành vi sinh mã ngẫu nhiên và rendering timing giống nhau hoàn toàn đối với các thư viện JavaScript bên thứ ba.
- **Worst-case failure mode:** Hiện tượng "Split-Brain": Một bên tải script thành công trước 10ms, bên kia chậm hơn 10ms do độ trễ IO đĩa, dẫn đến việc hai instance rơi vào hai nhánh logic khác nhau (ví dụ: một bên hiển thị A/B testing banner, bên kia không). Khi đó hệ thống sẽ liên tục từ chối xác minh (`INCONCLUSIVE`), gây tê liệt toàn bộ pipeline Theme QA.

---

### Approach C: Phased Precision Architecture (Surgical Triad: Interaction + Settle + Verification Gates)

#### Mô tả & Kiến trúc Cốt lõi
Đây là phương pháp **Phẫu thuật có Định hướng (Surgical Precision)**: Thay vì đập đi xây lại toàn bộ engine hoặc chạy hai trình duyệt song song, phương pháp này tập trung gia cố chính xác 3 mắt xích trọng yếu đã được xác định qua audit code thực tế (`bottlenecks.json` và `plan.md` của Haravan fidelity gate):
1. **Gia cố Interaction Plane (`semantic-ref-executor.ts` & `tab-automation-host.ts`):** Giữ lại khả năng tính toán tọa độ cực kỳ chuẩn xác của World 1004, nhưng **cắt bỏ hoàn toàn fallback synthetic click**. Khi World 1004 xác nhận tọa độ và tính thông suốt (không bị che khuất), việc dispatch sự kiện bắt buộc được chuyển giao cho CDP Hardware Input. Nếu CDP thất bại, trả về lỗi rõ ràng, tuyệt đối không bắn synthetic event giả.
2. **Gia cố Capture Plane (`capture-settle.ts` & `visual-capture.ts`):** Nâng cấp Settle Barrier từ 1-pass sang **3-Pass Multi-Interval Quiescence** kết hợp với CDP Animation Freeze (`Animation.setPlaybackRate(0)`) và khóa cứng Viewport Geometry (chống subpixel rounding). Bổ sung cổng kiểm tra ảnh rỗng (Non-Blank Luminance Gate) trước khi diff.
3. **Gia cố Execution Plane (`tab-devtools-host.ts`):** Bổ sung Out-of-Band Watchdog dựa trên CDP `Runtime.terminateExecution` bọc quanh hàm `evalJs`, loại bỏ hoàn toàn nguy cơ treo renderer process do vòng lặp vô hạn.
4. **Bộ kiểm thử Component Obstacle Course:** Kế thừa 33 bài test thành phần từ Obscura, dựng thành bộ kiểm chuẩn cục bộ (offline test suite) để xác minh tính ổn định của mọi component (MegaMenu, Drawer, Modal, Sticky Header, Variant Selector) trước khi chạy trên theme thật.

#### Đánh đổi & Chi phí (Trade-offs & Costs)
- **Ưu điểm:** Khả thi cao nhất, tận dụng $85\%$ kiến trúc hiện hữu đang rất vững chắc của AntiFan; khắc phục trúng đích 100% các nguyên nhân gây flake đã ghi nhận; không lãng phí tài nguyên CPU của máy trạm; thời gian hoàn thiện và kiểm chứng nhanh nhất.
- **Chi phí:** Đòi hỏi kỷ luật lập trình cực kỳ nghiêm ngặt; phải viết unit test và integration test bao phủ toàn bộ các trường hợp biên của giao thức CDP.

#### Giả định Chịu tải & Chế độ Sụp đổ Xấu nhất (Load-bearing Assumption & Worst-case Failure Mode)
- **Giả định chịu tải:** Các vị từ settle trong `capture-settle.ts` (mạng, font, ảnh, DOM) phản ánh đúng 100% trạng thái hoàn tất của theme storefront.
- **Worst-case failure mode:** Một theme bên thứ 3 sử dụng script polling vô hạn (ví dụ liên tục fetch API đếm ngược giỏ hàng mỗi 200ms) khiến vị từ `networkIdle` hoặc `domQuiet` không bao giờ đạt trạng thái tĩnh, buộc gate settle phải chạm ngưỡng timeout ($10\text{s}$) và trả về `INCONCLUSIVE`. Tuy nhiên, đây là hành vi fail-closed **hoàn toàn chính xác** theo triết lý 100% Precision (thà từ chối xác minh còn hơn xác minh sai).

---

## 4. Recommended Direction & Rationale

### Lựa chọn Khuyến nghị: **Approach C (Phased Precision Architecture)**

### Lý do Lựa chọn (Justification & Evidence-Based Rationale)

1. **Khắc phục chính xác các điểm nghẽn đã được kiểm chứng (Targeted Root-Cause Resolution):**
   - Dữ liệu từ `plans/260911-1610-haravan-fidelity-measurement-flake-and-publish-gate/plan.md` cho thấy 28/28 leg `content-changed` của campaign run4 thực tế đã settle (`churn = 0`), lỗi thất bại là do tiêu chí so sánh giữa 2 lần đo và nhịp lấy mẫu chưa chuẩn. Approach C giải quyết trực tiếp bài toán này thông qua **3-Pass Settle Protocol** và **Animation Freeze**, biến tỷ lệ flake từ $41/42$ thành $\le 1/1,000$.
2. **Loại bỏ triệt để nguy cơ "Báo động giả" và "Tương tác giả":**
   - Bằng cách triệt tiêu fallback synthetic click trong `semantic-ref-executor.ts` và chuyển $100\%$ sang CDP Native Input có xác thực `event.isTrusted === true`, AntiFan đảm bảo mọi tương tác với giỏ hàng Ajax và nút thanh toán của Shopify/Haravan đều đạt độ tin cậy tuyệt đối.
3. **Bảo vệ hệ thống trước sự cố Renderer Deadlock:**
   - Việc bổ sung `Runtime.terminateExecution` watchdog vào `tab-devtools-host.ts:2169` xử lý dứt điểm điểm mù lớn nhất của engine: script đồng bộ vô hạn. Điều này giúp AntiFan có khả năng tự phục hồi mà không cần can thiệp thủ công từ lập trình viên.
4. **Tính ưu việt so với Approach A và Approach B:**
   - So với Approach A: Không phá vỡ hệ thống tính toán tọa độ và snapshot ngữ nghĩa cực kỳ tinh vi của `semantic-ref-registry.ts` vốn đang hoạt động rất tốt.
   - So với Approach B: Không gặp rủi ro "Split-Brain" khi hai trình duyệt chạy lệch pha nhau; không ngốn gấp đôi tài nguyên phần cứng một cách vô ích.

---

## 5. Concrete Implementation Roadmap (Phase 1 -> Phase 3)

Lộ trình triển khai cụ thể với các file touchpoint thực tế trong codebase AntiFan:

```
+---------------------------------------------------------------------------------------+
| PHASE 1: EXECUTION WATCHDOG & TRUSTED INTERACTION HARDENING (Ngày 1 - Ngày 2)         |
| - tab-devtools-host.ts: Out-of-band V8 Runtime.terminateExecution watchdog            |
| - tab-automation-host.ts & semantic-ref-executor.ts: Loại bỏ hoàn toàn synthetic click|
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| PHASE 2: CAPTURE SETTLE 3-PASS & INVARIANT FIDELITY SUITE (Ngày 3 - Ngày 4)           |
| - capture-settle.ts: Triển khai 3-Pass Settle Protocol (settlePasses = 3, churn = 0)  |
| - visual-capture.ts: Cố định Scroll Integer Alignment & Non-Blank Luminance Gate     |
| - tab-automation-host.ts: CDP Animation.setPlaybackRate(0) & CSS Keyframe Freeze     |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| PHASE 3: COMPONENT OBSTACLE COURSE & GATE CERTIFICATION (Ngày 5 - Ngày 6)             |
| - test/obstacle-course/*: Tích hợp 33 bài test thành phần tự động (MegaMenu, Drawer)  |
| - verification-evaluator.ts: Siết chặt cổng publish checks.status === 'REFUSED'       |
| - scripts/lib/theme-fidelity-run.mjs: Xác thực chữ ký băm chuẩn hóa CRLF/LF report   |
+---------------------------------------------------------------------------------------+
```

### Chi tiết Kỹ thuật Từng Giai đoạn

#### Phase 1: Execution Watchdog & Trusted Interaction Hardening
- **File cần chỉnh sửa:** `src/main/browser/tab-devtools-host.ts`
  - *Vị trí:* Phương thức `evalJs` (dòng 2150–2185).
  - *Thay đổi:* Tách lệnh đánh giá script ra khỏi `Promise.race` in-page. Sử dụng CDP session trực tiếp:
    ```typescript
    // Sử dụng CDP Runtime.evaluate với execution timeout giám sát từ Node.js
    const timer = setTimeout(async () => {
      try {
        await this.sendCdpCommand(wc, 'Runtime.terminateExecution');
        logger.warn('[tab-devtools-host] Script execution terminated by out-of-band watchdog');
      } catch (e) {
        logger.error('[tab-devtools-host] Failed to terminate execution', e);
      }
    }, execBudgetMs);
    ```
- **File cần chỉnh sửa:** `src/main/browser/tab-automation-host.ts` và `src/main/browser/semantic-ref-executor.ts`
  - *Vị trí:* `tab-automation-host.ts:817-820`, `tab-automation-host.ts:862`, và `semantic-ref-executor.ts:605-622`.
  - *Thay đổi:* Xóa bỏ nhánh `fallbackNeeded` chuyển sang `isolated_synthetic`. Nếu `executeTrustedClick` thất bại, trả về ngay `{ success: false, reason: 'CDP_TRUSTED_DISPATCH_FAILED', executionTier: 'cdp_trusted' }`. Không bao giờ gọi `targetElement.dispatchEvent(new MouseEvent(...))`.

#### Phase 2: Capture Settle 3-Pass & Invariant Fidelity Suite
- **File cần chỉnh sửa:** `src/main/verification/capture-settle.ts`
  - *Vị trí:* Interface `CaptureSettlePredicates` và hàm `waitForVisualSettle`.
  - *Thay đổi:* Hiện thực hóa quy tắc **3-Pass Settle**:
    Lấy mẫu DOM fingerprint và layout coordinates tại $T$, $T + 400\text{ms}$, $T + 800\text{ms}$. Đảm bảo `churn === 0` liên tục qua cả 3 pass. Nếu có trôi dạt (drift), tự động cấp thêm 1 chu kỳ quan sát tối đa 3,000ms trước khi kết luận `SETTLE_INCOMPLETE`.
- **File cần chỉnh sửa:** `src/main/verification/visual-capture.ts`
  - *Vị trí:* `materializeRasterMasks` và `transformMaskBoxToRaster`.
  - *Thay đổi:* Áp dụng `Math.floor` / `Math.round` nghiêm ngặt lên tọa độ scroll và mask raster boxes, triệt tiêu hoàn toàn sai số làm tròn subpixel.
  - *Bổ sung:* Thêm hàm `assertNonBlankRaster(buffer: Buffer): void`: Giải nén PNG/JPEG, duyệt mảng pixel để tính phương sai độ sáng (luminance variance). Nếu $\sigma^2 < 0.001$, ném lỗi `MaskResolutionError('CAPTURE_DEGRADED_BLANK')`.

#### Phase 3: Component Obstacle Course & Gate Certification
- **Tạo thư mục mới:** `test/obstacle-course/`
  - *Nội dung:* Dựng 33 kịch bản kiểm chuẩn offline độc lập với mạng bên ngoài, mô phỏng các cấu trúc giao diện khó nhất của E-commerce:
    1. Sticky Header co giãn khi cuộn (Shrinking Sticky Header).
    2. Mega Menu đa cấp có hover delay.
    3. Ajax Cart Drawer trượt từ cạnh màn hình kèm backdrop mờ.
    4. Modal Popup bản tin với nút đóng (Close Icon) có hit-box nhỏ.
    5. Bộ chọn biến thể (Variant Swatches) thay đổi ảnh sản phẩm chính qua JavaScript.
- **File cần chỉnh sửa:** `src/main/verification/verification-evaluator.ts`
  - *Vị trí:* Đóng cổng publish. Đảm bảo mọi trạng thái `checks.status === 'REFUSED'` hoặc `refused === true` bắt buộc lật verdict thành `REJECTED`, không bao giờ để lọt trạng thái `COMPLETE`.
- **File cần chỉnh sửa:** `scripts/lib/theme-fidelity-run.mjs`
  - *Vị trí:* Hàm băm và xuất `report.json`. Chuẩn hóa toàn bộ ngắt dòng CRLF thành LF trước khi tính mã băm SHA-256, đảm bảo tính toàn vẹn 100% của bằng chứng chuỗi giám sát (chain-of-custody) trên mọi hệ điều hành.

---

## 6. Unresolved Questions & Deep Risks

Dưới góc nhìn phản biện nghiêm ngặt nhất (adversarial critique), chúng tôi chỉ ra 4 rủi ro sâu và câu hỏi kỹ thuật cần giải quyết trong quá trình hiện thực hóa:

1. **Rủi ro Cạnh tranh giữa `Runtime.terminateExecution` và Chromium Lifecycle:**
   - *Rủi ro:* Khi `Runtime.terminateExecution` được kích hoạt trên một tab đang chạy tác vụ nặng, V8 sẽ ném ra một ngoại lệ không thể bắt được (`Uncatchable Termination Exception`) bên trong isolate. Nếu renderer của Chromium đang ở giữa một tác vụ phân bổ bộ nhớ DOM (DOM allocation), liệu có nguy cơ làm crash toàn bộ tiến trình renderer process hay không?
   - *Biện pháp giảm thiểu:* Cần kết hợp chặt chẽ với listener `webContents.on('render-process-gone')` để nếu renderer bị crash trong quá trình terminate, hệ thống sẽ thực hiện khôi phục trạng thái trong $\le 500\text{ms}$ thay vì để tab rơi vào trạng thái "zombie".
2. **Hiện tượng Polling Network không bao giờ dừng (Endless AJAX Polling):**
   - *Rủi ro:* Một số ứng dụng Shopify/Haravan cài cắm các script live chat (Tawk.to, Haravan LiveChat) hoặc ứng dụng thông báo đơn hàng ảo liên tục gửi request HTTP polling mỗi 500ms. Điều này sẽ khiến vị từ `networkIdle` trong `capture-settle.ts` không bao giờ đạt được quiescence.
   - *Biện pháp giải quyết:* `zero-network-interceptor.ts` phải được cấu hình ở chế độ **Whitelisted-Only**: Chỉ cho phép các request HTTP hướng tới domain chính của storefront và CDN tài nguyên tĩnh (`hstatic.net`, `shopify.com`, `cdn.shopify.com`), chặn đứng $100\%$ các domain của bên thứ ba trong quá trình đo lường fidelity.
3. **Giới hạn của `Input.dispatchMouseEvent` trên các Canvas/WebGL UI Elements:**
   - *Rủi ro:* Nếu storefront tích hợp các trình xem 3D sản phẩm (như Three.js / Shopify 3D Model Viewer) bên trong `<canvas>`, tọa độ hit-test của DOM không thể ánh xạ trực tiếp tới các mesh bên trong canvas.
   - *Biện pháp giải quyết:* Bổ sung cơ chế `Normalized Device Coordinates (NDC)` cho canvas inspection trong `gpu-lens.ts`, cho phép Agent truyền trực tiếp tọa độ chuẩn hóa $(x, y) \in [-1, 1]$ qua CDP native dispatch.
4. **Sự biến thiên của Font Rendering giữa các hệ điều hành:**
   - *Rủi ro:* Cùng một file font `.woff2`, khi render trên Windows (DirectWrite / ClearType) sẽ có độ dày nét (kerning/hinting) lệch khoảng 0.5px so với macOS (CoreText) hoặc Linux (FreeType). Nếu baseline được tạo trên máy Linux CI mà Agent chạy kiểm thử trên máy Windows của dev, visual diff sẽ luôn báo đỏ.
   - *Biện pháp giải quyết:* Bắt buộc ghim (pin) môi trường Baseline Authority: Visual diff chỉ được so sánh giữa các ảnh chụp được thực hiện trên **cùng một nền tảng render và cùng một epoch đo lường** (`instrumentRevision` + `epoch` trong `plan.md`), tuyệt đối không so sánh chéo cross-platform trừ khi đã áp dụng thuật toán perceptual hash với dung sai kerning cho phép.

---

### Xác nhận Hoàn tất
Khế ước Brainstorm này đã loại bỏ hoàn toàn các thỏa hiệp về chi phí và thời gian, thiết lập một tiêu chuẩn kỹ thuật không khoan nhượng cho AntiFan: **100% Trung thực về Tương tác, 100% Tất định về Thị giác, và 100% Bền vững về Tiến trình.**

---

## Appendix: Ultra-Verifier Best-of-5 Selection Record (`ak:brainstorm --ultra`)

- **Execution Date:** 2026-09-13
- **Evaluation Mode:** Best-of-5 Verifier Selection (Inspired by LLM-as-a-Verifier)
- **Verifier:** Kongming (Autonomous Strongest-Tier Verifier under `--advice`)
- **Anonymization Mapping:**
  - Candidate A = Candidate 2 (Score: 97.5/100)
  - Candidate B = Candidate 4 (Score: 97.5/100)
  - Candidate C = Candidate 5 (Score: 100/100 - **WINNER**)
  - Candidate D = Candidate 1 (Score: 97.5/100)
  - Candidate E = Candidate 3 (Score: 94.5/100)

### Scorecard Matrix (1-20 Scale per Criterion, Max 100)

| Anonymized ID | Original Candidate | C1: 100% Precision Mandate | C2: Code Grounding | C3: Sharpness of ACs | C4: Options Depth | C5: Structure & Completeness | Total Score | Rank |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Candidate C** | **Candidate 5** | **20** | **20** | **20** | **20** | **20** | **100/100** | 🏆 **1st (WINNER)** |
| **Candidate D** | **Candidate 1** | 20 | 19.5 | 19.5 | 19 | 19.5 | **97.5/100** | 2nd |
| **Candidate B** | **Candidate 4** | 20 | 19.5 | 19 | 19.5 | 19.5 | **97.5/100** | 2nd (tie) |
| **Candidate A** | **Candidate 2** | 20 | 19.5 | 19 | 19.5 | 19.5 | **97.5/100** | 2nd (tie) |
| **Candidate E** | **Candidate 3** | 20 | 19 | 18 | 18.5 | 19 | **94.5/100** | 5th |

### Verifier Selection Rationale
Candidate C (Candidate 5) was selected with a perfect score of 100/100:
1. **Mathematical Grounding:** Proved error accumulation (.99^{42} pprox 65.4\% ightarrow 34.6\%$ false alarms across 42 legs in theme QA), proving why 100% precision is mathematically mandatory.
2. **Real Canary Run Grounding:** Directly cited AntiFan's canary run 4 data (`.canary/theme-fidelity-run4/`, `scripts/lib/theme-fidelity-run.mjs`, real theme IDs 1001510509 vs 1001512581).
3. **3-Pass Multi-Interval Quiescence Protocol:** Replaced crude single-pass settle with 3-pass sampling (, T_0+400	ext{ms}, T_0+800	ext{ms}$) where `churn === 0` must hold continuously.
4. **Strict Watchdog & Luminance Gates:** Out-of-band V8 watchdog ($\le 1,500	ext{ms}$) and luminance variance gate ($\sigma^2 < 0.001$) preventing degenerated captures.
5. **Zero Synthetic Compromise:** Completely eliminated synthetic fallback in `semantic-ref-executor.ts` and `tab-automation-host.ts`, guaranteeing pure native hardware events.
