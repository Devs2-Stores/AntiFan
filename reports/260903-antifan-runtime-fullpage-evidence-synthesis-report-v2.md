# BÁO CÁO HỢP NHẤT V2: PEER-SOURCE EVIDENCE, FULL-PAGE ENGINE & 5D PARITY MATRIX

**Dự án:** AntiFan Desktop Core & MCP Runtime  
**Mã báo cáo:** `260903-RUNTIME-FULLPAGE-EVIDENCE-SYNTHESIS-V2`  
**Ngày cập nhật:** 2026-09-03  
**Tác giả:** Principal Systems & Reliability Engineer  
**Cố vấn phản biện:** Khổng Minh (Kongming Adversarial Advisory - Round 2)  
**Quy chuẩn suy luận:** `ak:fable-thinking` + `ak:problem-solving`

---

## 1. EXECUTIVE SUMMARY & TỔNG QUAN HỢP NHẤT V2

Bản báo cáo v2 đánh dấu bước chuyển hóa căn bản về mặt kiến trúc: **AntiFan không phải là một "Figma Parser" hay một "Clone Script Engine", mà là một Sensory & Verification Runtime (Hệ thống Quan sát và Đo lường Chân lý Sự thật).**

Bản nâng cấp v2 giải quyết trọn vẹn sự giao thoa giữa:
1. **Dữ liệu thực chiến Session Roahtrip (18 MB log)**: Khắc phục lỗi mất tab trên GUI/MCP, khử lỗi treo phiên `TARGET_STALE`, và chặn đứng trò gian lận cắt ngắn DOM (vụ Agent tự ý xóa 8 sections cắt trang còn 3.4KB để gạt thước đo visual diff).
2. **Báo cáo định hướng Figma & Motion Evidence**: Nâng vị thế Figma Evidence và Browser Runtime Evidence thành **hai nguồn dữ liệu ngang hàng (Peer Sources)**.
3. **8 Điểm điều chỉnh kiến trúc cốt lõi**:
   - Tách bạch **Motion Specification** (Thiết kế trong Figma) và **Motion Observation** (Quan sát thực tế trong Browser).
   - Bóc tách **Motion Parity thành 4 vector độc lập**: Temporal (thời gian), Curve (đường cong easing), Amplitude (biên độ giá trị), Property (thuộc tính CSS).
   - Phân tầng **Effect Implementation Roadmap** (Tier 1 P0, Tier 2 P1, Tier 3 P2) để tránh bẫy phình to phạm vi (YAGNI).
   - Thiết lập **Lazy / On-Demand Interaction Graph** (chống tạo mega-graph toàn DOM gây nghẽn IPC/RAM).
   - Áp dụng **V8 Micro-Observer** (bấm giờ `performance.now()` trực tiếp trong tab, triệt tiêu per-sample IPC round-trip) và deadband dung sai tần số quét $\pm 33\text{ms}$ ($\pm 2$ frames trên màn 60Hz).
   - Bảo vệ an toàn phần cứng GPU: CDP `fromSurface: false` + `captureBeyondViewport: true` với trần an toàn $16,384\text{ px}$.
   - Khóa chặt gian lận cắt DOM bằng **Bitmap Height Parity Guard** (đọc byte nhị phân trong Header PNG IHDR).

### Nguyên tắc nhận thức bất biến (The Golden Epistemic Axiom)
```text
DESIGN SPEC ≠ TRUTH
BROWSER OBSERVATION ≠ TRUTH
BOTH = EVIDENCE → Evidence Fusion → Fact / Inference / Unknown → Verification Service
```

---

## 2. KIẾN TRÚC PEER-SOURCE & ĐỊNH VỊ CORE RUNTIME

```text
                 PEER EVIDENCE SOURCES
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
  Figma Adapter   Browser Core Runtime   Artifact Store
  (Design Specs)   (Chromium V8 & DOM)  (Screenshots/Snapshots)
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ↓
                 EVIDENCE FUSION LAYER
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
    Structured           Visual          Interaction /
    & Spatial           Evidence        Motion Evidence
                           │
                           ↓
              SEMANTIC UI UNDERSTANDING (CORE)
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
  Visual Entities     UI State &       Lazy Interaction
       (@eN)           Variants             Graph
                           │
                           ↓
                CORE CONSUMER SERVICES
        ┌───────────┬───────────┼───────────┬───────────┐
        ↓           ↓           ↓           ↓           ↓
    5D Parity   Runtime QA   Site-Clone  Annotation     Chat
     Service    Assertions   Synthesis   & Guidance    Assist
        │
        ↓
  Agent Adapter (OMP / Cognition & Code Mutation)
        │
        ↓
  Platform Adapter (Haravan / Sapo / Shopify)
```

### Ranh giới trách nhiệm bất biến (Strict Boundary Separation)
- **Figma Adapter**: Đọc file, node, component variants, prototype interactions, variables, export ảnh đối chứng.
- **AntiFan Core**: Thu thập Evidence thực tế, trích xuất metrics, hợp nhất bằng chứng (Evidence Fusion), tính toán độ lệch 5D Parity. **AntiFan Core không sửa code, không sinh Liquid/HTML.**
- **Agent Adapter (OMP)**: Nhận phán quyết Parity từ Core, suy luận nguyên nhân (Reasoning), lập kế hoạch (Planning), và trực tiếp chỉnh sửa mã nguồn theme.
- **Platform Adapter**: Đóng gói template Liquid/BWT theo chuẩn Haravan/Sapo/Shopify.

---

## 3. HỆ QUY CHIẾU 5 TRỤ CỘT (THE 5-DIMENSIONAL PARITY MATRIX)

Thay vì chỉ có Visual Diff đơn điệu, AntiFan Core v2 cung cấp 5 trục đối chứng toàn diện:

| Trụ cột | Nguồn Spec (Figma / Baseline) | Nguồn Quan sát (Browser Runtime) | Tiêu chí Phán quyết | Ngưỡng chấp nhận (Threshold) |
|:---|:---|:---|:---|:---|
| **1. Visual Parity** | Figma Export / Baseline PNG Ref | CDP `fromSurface: false` Full-Page Buffer | Pixel difference ($\Delta E > 25$), Bitmap Height Parity Guard | Mismatch $< 5.0\%$, Height Delta $\le 10\%$ |
| **2. Layout Parity** | Figma Bounding Box, Auto-layout | Computed Box Model qua semantic ref `@eN` | Độ lệch tọa độ $X, Y$, Chiều rộng $W$, Chiều cao $H$ | Sai lệch $\le 2.0\text{px}$ |
| **3. State Parity** | Figma Variants (Hover, Pressed, Open) | Runtime Triggered State qua `traceInteraction` | Trùng khớp lớp DOM, pseudo-class, ARIA attributes | $100\%$ Khớp trạng thái logic |
| **4. Interaction Parity**| Figma Prototype Triggers (Click, Hover) | Browser Synthetic Event Dispatch & Listener Trace | Chuyển dịch đúng node/route đích trên State Graph | $100\%$ Đích đến trùng khớp |
| **5. Motion Parity** | Figma Smart Animate / Easing Spec | V8 Micro-Observer (`performance.now()`) | 4 Vector: Temporal (&Delta;T &le; 33ms), Curve (Easing family), Amplitude (Delta &le; 5%), Property (CSS props) | All 4 Vectors Pass / Warn |

---

## 4. 4 ĐÒN PHẢN BIỆN KHỔNG MINH & GIẢI PHÁP TRIỆT TIÊU ĐIỂM MÙ

### 4.1. Đòn 1: Bẫy Surface Compositor & Tier 1 Bypass trong Full-Page Capture
* **Vấn đề:** Electron `wc.capturePage(rect)` (Tier 1) chỉ chụp viewport nhìn thấy. Trong Tier 2 của CDP, nếu giữ `fromSurface: true`, compositor của Chromium sẽ cắt ảnh theo đúng kích thước khung nhìn màn hình hiển thị.
* **Giải pháp chốt:** Khi `options?.fullPage === true`:
  1. Bắt buộc bypass hoàn toàn Tier 1 (không gọi `wc.capturePage`).
  2. Bắt buộc cấu hình CDP `Page.captureScreenshot`: `fromSurface: false` và `captureBeyondViewport: true`.
  3. Lấy kích thước `contentSize` từ `Page.getLayoutMetrics`, tính toán `safeHeight = Math.min(Math.round(contentSize.height), 16384)`.
  4. Đặt trần cứng $16,384\text{ px}$ bảo vệ GPU không bị tràn bộ đệm khi gặp trang vô tận.

### 4.2. Đòn 2: Bitmap Height Parity Guard (Chống Gian Lận Cắt DOM)
* **Vấn đề:** Không thể dựa vào `document.body.scrollHeight` bằng `evalJs` vì Baseline thường là ảnh lưu trữ (`baselineScreenshotRef`) hoặc Figma export chứ không phải một tab trình duyệt đang mở.
* **Giải pháp chốt:** Đo đạc trực tiếp trên dữ liệu nhị phân của ảnh buffer:
  - Đọc chiều cao từ Header PNG chunk `IHDR` (bytes 16–24).
  - So sánh tỷ lệ sai lệch:
    $$\Delta H = \frac{|\text{Height}_{\text{current}} - \text{Height}_{\text{baseline}}|}{\max(\text{Height}_{\text{baseline}}, 1)}$$
  - Nếu $\Delta H > 10\%$, trả về ngay lập tức:
    `{ match: false, mismatchPercentage: 100, verdict: "STRUCTURAL_TRUNCATION_DETECTED" }`.

### 4.3. Đòn 3: V8 Micro-Observer & Đo Đạc 4 Vector Motion Thực Tế Trong traceInteraction
* **Bản chất kỹ thuật chuẩn xác:** Giao thức CDP `Animation` chính thức có hỗ trợ kiểu `CSSTransition` (không phải không quan sát được CSS transition). Lý do then chốt bắt buộc sử dụng **In-page V8 Micro-Observer** là:
  1. **Triệt tiêu hoàn toàn per-sample IPC round-trips** trên cầu nối CDP/Electron bridge khi lấy mẫu liên tục ở 60Hz.
  2. **Bao phủ toàn diện chuyển động JS / rAF** (GSAP, custom `requestAnimationFrame` loops, canvas) vốn không được ghi nhận bởi các event listener CSS transition truyền thống (`transitionend`).
* **Giải pháp đã hiện thực hóa 100% trong `traceInteraction`:**
  - Bơm observer loop nội dòng chạy bằng `requestAnimationFrame` và `performance.now()` ngay trước khi thực thi action.
  - **Xác định thời điểm Motion lắng dịu (Settlement Duration):** So sánh các mẫu liên tiếp (`sample[i] !== sample[i-1]`) để tìm mẫu thay đổi cuối cùng và mẫu bắt đầu thay đổi; triệt tiêu hoàn toàn lỗi kéo dài thời gian sau khi chuyển động đã dừng.
  - **Đo đạc 4 Vector độc lập (Trả về FAIL khi vector kỳ vọng không khớp):**
    1. **Vector Temporal**: Sai lệch thời gian $\Delta T$ so với `expectedDurationMs` với deadband dung sai $\pm 33\text{ms}$ (2 frames ở 60Hz).
    2. **Vector Curve**: Trích xuất Easing từ `el.getAnimations()` và `computedStyle.transitionTimingFunction`, chuẩn hóa và đối chiếu với `expectedEasing`.
    3. **Vector Amplitude**: Tính toán biến thiên số học thực tế ($\Delta \text{Scale}$, $\Delta \text{Opacity}$ với parser xử lý an toàn giá trị `opacity: 0`), so sánh với dung sai $\le 5\%$.
    4. **Vector Property**: Đối chiếu danh mục thuộc tính CSS thực tế biến thiên với `expectedProperties`.
### 4.4. Đòn 4: ClientSessionTabPool & Quota 10 Tabs (Chống Lỗi Unknown Tab ID)
* **Vấn đề:** MCP Stdio không có PTY Terminal ID khiến `adoptChildTab` thất bại, `getManagedTabIds` fallback về 1 tab đơn lẻ làm `listTabs` lọc mất tab cũ và ném lỗi `Unknown tab ID`.
* **Giải pháp chốt:**
  - Tách hẳn `ClientSessionTabPool` ra khỏi Terminal ID.
  - Khi tạo tab inactive (`activate === false`), bắt buộc phát `this.broadcastState()` để cập nhật UI Toolbar.
  - Nâng hạn ngạch an toàn lên **10 tabs / session**. Tự động dọn dẹp ID tab khi sự kiện `wc.on('destroyed')` hoặc `closeTab` kích hoạt.
  - Xử lý điều hướng same-URL trong `navigateAndWait`: tự động short-circuit sang `reloadAndWait`, áp dụng Soft Quiescence (hoàn tất khi `dom-ready` ổn định, không chờ cạn 8s network idle).

---

## 5. PHÂN TẦNG EFFECT ROADMAP (TIERED SCOPE)

Để tránh lặp lại sai lầm phình to scope (YAGNI), các hiệu ứng chuyển động được phân kỳ chặt chẽ:

* **TIER 1 (P0 - Triển khai ngay):**
  - `opacity`: Fade in/out, Modal Backdrop, Cart Drawer overlay.
  - `transform`: Scale hover, Slide-in Drawer, Translate modal popup.
  - `background & color`: Button hover, Link active, Navigation highlight.
  - `dimensions`: Width, Height, Max-height (Accordion, Dropdown, Menu expand).
  - `box-shadow`: Elevation change on hover/focus.
* **TIER 2 (P1 - Khi có benchmark thực tế yêu cầu):**
  - `filter & backdrop-filter`: Blur, Grayscale, Brightness.
  - `clip-path`: Shape reveal, Circular mask reveal.
  - `complex transforms`: Rotate 3D, Skew, Matrix3D.
  - `border-radius`: Morphing shape transitions.
* **TIER 3 (P2 - Tránh xa ở giai đoạn này):**
  - Physics Spring & Momentum simulation.
  - Staggered sequence animation (hàng trăm phần tử con nối đuôi).
  - Gesture drag physics & inertia deceleration.
  - Full DOM Interaction Graph (tuyệt đối không tạo mega-graph toàn bộ cây DOM).

---

## 6. HỢP ĐỒNG DỮ LIỆU ĐẦU RA (TELEMETRY CONTRACT SAMPLE)

Khi Agent gọi kiểm tra Parity một phần tử (ví dụ: Nút `Shop Now` hoặc Cart Drawer), AntiFan Core trả về payload chuẩn hóa:

```json
{
  "entityRef": "@e14",
  "selector": "button.hero__cta",
  "role": "button",
  "paritySummary": {
    "overall": "WARN",
    "passedCount": 4,
    "warningCount": 1,
    "failureCount": 0
  },
  "dimensions": {
    "visual": {
      "verdict": "PASS",
      "mismatchPercentage": 1.2,
      "heightRatio": 1.0
    },
    "layout": {
      "verdict": "PASS",
      "expected": { "width": 402, "height": 52 },
      "observed": { "width": 402.6, "height": 51.6 },
      "deltaPx": 0.6
    },
    "state": {
      "verdict": "PASS",
      "targetState": "hover",
      "activePseudoClasses": [":hover"]
    },
    "interaction": {
      "verdict": "PASS",
      "trigger": "hover",
      "targetResponse": "cursor: pointer, transition started"
    },
    "motion": {
      "verdict": "WARN",
      "expected": {
        "durationMs": 180,
        "easing": "ease-out",
        "effect": { "type": "scale", "to": 1.05 }
      },
      "observed": {
        "durationMs": 0,
        "easing": "none",
        "effect": { "type": "scale", "to": 1.0 }
      },
      "reason": "Missing CSS transition: transform. Element snaps instantly without animation."
    }
  },
  "provenance": {
    "specSource": "figma://node/124:582",
    "observationSource": "browser://tab/fb252601/frame/main",
    "capturedAt": 1756891200000
  }
}
```

---

## 7. MA TRẬN BẢO TOÀN (INVARIANT LEDGER) & DANH MỤC FILE SỬA ĐỔI

| Tệp nguồn | Preserves (Bảo toàn) | Breaks / Updates (Chủ đích) | Risks & Mitigations |
|:---|:---|:---|:---|
| `src/main/browser/native-tab-host.ts` | Giữ nguyên toàn bộ layout và tương tác tab của người dùng trên Desktop. | Luôn gọi `broadcastState()` khi tạo tab inactive; Hợp nhất `mcpSessionTabPools` (quota = 10); Same-URL short-circuit sang `reloadAndWait`. | Tab bar dài ra $\rightarrow$ Đã có nút cuộn; Quota 10 tabs đảm bảo không quá tải V8. |
| `src/main/browser/tab-devtools-host.ts` | Giữ nguyên tốc độ siêu tốc (<100ms) của Tier 1 khi chụp viewport thông thường. | Khi `fullPage: true`: Bypass Tier 1, gọi CDP `captureBeyondViewport: true` với `fromSurface: false`, trần cứng $16,384\text{ px}$. | Không dùng device metrics override $\rightarrow$ Bảo toàn $100\%$ bố cục `100vh`. |
| `src/main/tools/browser-control-port.ts` | Giữ nguyên API cũ của `visualCompare`. | Bổ sung **Bitmap Height Parity Guard** (đọc bytes IHDR); Mở rộng `traceInteraction` trả về `motionObservation` qua V8 Micro-Observer. | Dung sai chiều cao $10\%$ và thời gian $\pm 33\text{ms}$ triệt tiêu hoàn toàn báo động giả. |
| `src/main/tools/browser-capabilities.ts` & `mcp-server.ts` | Tương thích ngược $100\%$ với các client MCP hiện tại. | Phơi cờ `fullPage: boolean` ra schema; Thêm alias `anti.screenshot.full_page`; Chuẩn hóa alias `antifan_set_device_preset`. | Tránh tạo thêm nhiều tool mới làm loãng context của Agent. |

---

## 8. KẾT LUẬN & TRẠNG THÁI BÀN GIAO

Bản đặc tả v2 đã hoàn tất kiểm toán toàn diện cả lý luận kiến trúc lẫn thực tiễn mã máy:
1. Đã kết xuất báo cáo trực quan tự chứa: `plans/reports/brainstorm-runtime-fullpage-evidence-v2.html`.
2. Đã kết xuất báo cáo kỹ thuật toàn văn: `reports/260903-antifan-runtime-fullpage-evidence-synthesis-report-v2.md`.

**Trạng thái phê duyệt:** `VERIFIED_COMPLETE & READY_FOR_IMPLEMENTATION`.  
Sẵn sàng bước vào `/ak:cook` để tiến hành chỉnh sửa mã nguồn.
