# BÁO CÁO TOÀN DIỆN: THẨM ĐỊNH MÃ NGUỒN, PHẢN BIỆN KIẾN TRÚC & CHẨN ĐOÁN HÀNH VI AGENT (ANTIFAN MCP VS. PYTHON)

- **Đơn vị thẩm định:** AntiFan Engineering & Kongming Adversarial Advisory
- **Phương pháp luận:** Static Code Inspection, Dependency Graph Analysis, Zero-Slop, Fable Thinking Protocol (Claim Discipline & Adversarial Attack)
- **Mã nguồn kiểm toán:** `E:\Work\apps\antifan-browser-desktop` (Git HEAD `90b1c8c` / `feec367`)
- **Tài liệu & Session đối soát:**
  1. `reports/260904-phan-bien-toan-bo-bao-cao-theme-engineering.md` (Bản thẩm định mã nguồn 308 dòng)
  2. `C:\Users\Admin\.omp\agent\sessions\--E--Work-customizes-OwlBrand--\2026-09-04T10-10-45-686Z_01a06be6-3b35-7111-9716-ff34ec26c39b.jsonl` (Session telemetry thực chiến)
- **Ngày hoàn thiện:** 2026-09-04

---

## PHẦN I: NGUYÊN VĂN BẢN THẨM ĐỊNH ĐỐI SOÁT MÃ NGUỒN (308 DÒNG)

*(Dưới đây là nguyên văn báo cáo thẩm định 308 dòng đối chiếu giữa các khẳng định kiến trúc và thực tế codebase `antifan-browser-desktop`)*

```markdown
# BÁO CÁO PHẢN BIỆN CÁC ĐIỂM TRỌNG YẾU ĐÃ ĐỐI SOÁT MÃ NGUỒN
## Đối chiếu Báo cáo "AntiFan — Strategic Architecture & Theme Engineering Report (2026-09-04)" với Thực tế Codebase

- **Phương pháp thẩm định:** Static Code Inspection, Dependency Graph Analysis, Zero-Slop
- **Nguyên tắc Claim Discipline (Bắt buộc):**
  - `[OBSERVED]`: Đã đọc, kiểm tra và đối chiếu trực tiếp mã nguồn committed trong phiên làm việc này.
  - `[CLAIM FROM REPORT]`: Số liệu, chỉ số hoặc khẳng định chỉ xuất hiện trong văn bản báo cáo gốc, chưa có benchmark xác thực độc lập.
  - `[DERIVED]`: Kết luận suy luận logic kỹ thuật từ cơ chế đã quan sát.
  - `[NOT INDEPENDENTLY ASSESSED]`: Các mục trong báo cáo gốc chưa được khảo sát mã nguồn chi tiết trong phiên này (từ chối suy diễn kết luận khi thiếu bằng chứng).
- **Mã nguồn thẩm định:** `E:\Work\apps\antifan-browser-desktop` (Thẩm định tĩnh cấu trúc mã nguồn HEAD, không suy diễn kết quả runtime)
- **Ngày thực hiện:** 2026-09-04
---

## MỤC LỤC
1. [Tóm tắt Điều hành (Executive Summary)](#1-tóm-tắt-điều-hành-executive-summary)
2. [Bảng Đối soát Khẳng định Báo cáo vs. Thực tế Mã nguồn](#2-bảng-đối-soát-khẳng-định-báo-cáo-vs-thực-tế-mã-nguồn)
3. [Phản biện Chuyên sâu từng Phần (Sections 1 – 24)](#3-phản-biện-chuyên-sâu-từng-phần)
   - [Trụ cột 1: Ranh giới OMP vs. AntiFan & Bác bỏ Playwright MCP](#trụ-cột-1-ranh-giới-omp-vs-antifan--bác-bỏ-playwright-mcp)
   - [Trụ cột 2: Giải mã Nghịch lý Telemetry (169 Evaluate vs. 1 Inspect Styles)](#trụ-cột-2-giải-mã-nghịch-lý-telemetry-169-evaluate-vs-1-inspect-styles)
   - [Trụ cột 3: Bóc trần Ảo tưởng Kỹ thuật của Bộ P0 Capabilities](#trụ-cột-3-bóc-trần-ảo-tưởng-kỹ-thuật-của-bộ-p0-capabilities)
   - [Trụ cột 4: Device Presets & Lỗi Thực tế của Emulation Engine](#trụ-cột-4-device-presets--lỗi-thực-tế-của-emulation-engine)
   - [Trụ cột 5: Golden Vertical Slice & Verification Invariants](#trụ-cột-5-golden-vertical-slice--verification-invariants)
4. [Kiến trúc Đích Thực tế (Grounded Target Architecture)](#4-kiến-trúc-đích-thực-tế-grounded-target-architecture)
5. [Lộ trình Triển khai 3 Giai đoạn Bắt buộc (Actionable Execution Plan)](#5-lộ-trình-triển-khai-3-giai-đoạn-bắt-buộc-actionable-execution-plan)

---

## 1. Tóm tắt Điều hành (Executive Summary)

Bản báo cáo kiến trúc ngày 2026-09-04 (**Report**) đưa ra một chẩn đoán rất sắc bén về mặt hiện tượng: **"AntiFan hiểu Browser tốt hơn hiểu Theme"**, và quyết định chiến lược bác bỏ Playwright MCP là hoàn toàn đúng đắn.

Tuy nhiên, khi đối soát chi tiết 24 mục của Report với mã nguồn thực tế của `antifan-browser-desktop`, xuất hiện **5 sai lệch kỹ thuật nghiêm trọng** (Technical Distortions):

1. **Ngộ nhận về `inspect_styles`:** Report cho rằng AntiFan chỉ có `getComputedStyle()` đơn sơ. Thực tế, `advanced-inspection-scripts.ts:34-242` đã bóc tách toàn diện Box Model (dạng số thực px), Typography, Layout (flex/grid), Visual, toàn bộ CSS Variables (`--*`), và hỗ trợ xuyên qua cả Shadow DOM / Iframe. Khoảng trống thực sự là **Matched Declarations (Active vs Overridden)** và **Source Provenance (CSS file:line)**, chứ không phải thiếu data hình học/layout.
2. **Ảo tưởng Ánh xạ Liquid (Liquid Abstraction Gap):** Report đề xuất `anti.theme.resolve_element` map thẳng từ DOM $\to$ Liquid file $\to$ Section $\to$ Setting như một pipeline tất định. Đây là điều **bất khả thi về mặt vật lý nếu chỉ dùng CDP**, vì Liquid là server-rendered template; các class và DOM sinh ra từ logic động (loops, filters, dynamic classes). Giải pháp bắt buộc phải là Heuristic có phân cấp độ tin cậy (Confidence Grading), kết hợp giữa thuộc tính theme sẵn có và quét tĩnh Workspace.
3. **Bỏ sót Nền tảng Breakpoint sẵn có & Lỗi Backend Emulation:** Report đề xuất viết mới `anti.inspect.responsive_matrix` mà không nhận ra AntiFan đã có sẵn `DEVICE_PRESETS` (`device-presets.ts`) và `runResponsiveCheck` (`native-tab-host.ts:5185`). Khoảng trống thực tế là `runResponsiveCheck` bị hardcode 3 thiết bị (`393, 820, 1440`), thiếu mốc $320\text{px}$ và $768\text{px}$; đồng thời hàm `setViewportSize` (`:5298`) bị lỗi khi lưu ID `${width}x${height}` không khớp preset, khiến `updateLayout` rơi vào nhánh fluid và **không kích hoạt device emulation**.
4. **Thiếu Method Matched-Styles trên Control Port (Dù CDP Host đã sẵn sàng):** Report mặc định AntiFan có thể gọi ngay `CSS.getMatchedStylesForNode`. Thực tế, `TabDevToolsHost` (`tab-devtools-host.ts:486-612`) **đã có sẵn hạ tầng CDP attach/queue và đã gọi `DOM.enable`/`CSS.enable` cho luồng font**, nhưng **chưa có method `getMatchedStylesForNode`**, đồng thời `BrowserHostPort` (`browser-control-port.ts:17-69`) chưa expose matched-styles gateway này ra tool catalogue.
5. **Ranh giới Kiến trúc & Wiring của Execution Backend cần được Audit:** Report khẳng định *"AntiFan không được là Agent runtime thứ hai"*, nhưng trong mã nguồn, `src/main/agent/` cung cấp `ExecutionBackend` đang là dependency trực tiếp được `RunService` (`run-service.ts:60-61`) tiêu thụ [OBSERVED]. Đây là thành phần wiring phục vụ tiến trình run-service nội bộ của ứng dụng, không phải mã nguồn bỏ hoang. Mọi đề xuất tái cấu trúc ranh giới đều phải bắt đầu từ việc kiểm toán call-graph và bảo đảm tính toàn vẹn của pipeline chạy lệnh.

---

## 2. Ma trận Đối soát 24 Mục của Báo cáo Gốc kèm Nhãn Provenance

| # | Section Báo cáo Gốc | Nội dung Khẳng định của Báo cáo | Bằng chứng Mã nguồn / Tình trạng Thẩm định | Nhãn Provenance & Đánh giá |
|---|---|---|---|---|
| **1** | Executive Decision | Bác bỏ Playwright MCP; OMP lập kế hoạch/suy luận, AntiFan là Control Plane. | `tab-automation-host.ts`, `tab-devtools-host.ts`, `local-ipc-server.ts` đã có sẵn hạ tầng Chromium native. | `[OBSERVED]` ĐỒNG THUẬN TUYỆT ĐỐI. Tránh nhân đôi runtime và xung đột profile. |
| **2** | Scope Phục vụ Công việc gì? | Định vị 10 workflow Theme/UI thực tế; loại bỏ generic agent IDE, swarm. | Đa số workflow thuộc năng lực theme của OMP; AntiFan đóng vai trò execution và telemetry. | `[DERIVED]` ĐỒNG THUẬN CÓ PHÂN TẦNG. AntiFan không gánh phần code generation. |
| **3** | Core Hiện tại Đã Mạnh Ở Đâu? | Chromium, Terminal, Verification chain; nêu số liệu 125/125 tests, 31/31 flows pass. | Chuỗi verification có cấu trúc tốt trong `verification-contract.ts`; số liệu test là số liệu cũ trong báo cáo. | `[CLAIM FROM REPORT]` CẢNH BÁO: Chưa chạy live test suite ở phiên này; ghi nhận kiến trúc verification là đúng hướng. |
| **4** | Vấn Đề Lớn Nhất Hiện Tại | AntiFan hiểu Browser (9/10) hơn hiểu Theme (4/10); thiếu source mapping. | Bản chất là khoảng cách tầng trừu tượng (Liquid compile-time ở server, browser chỉ nhận DOM). | `[DERIVED]` ĐỒNG THUẬN TRIỆU CHỨNG, bổ sung giải thích nguyên nhân kỹ thuật. |
| **5** | Evidence Từ Workflow Thực Tế | 1926 dòng, 609 calls, 169 evaluate, 1 inspect_styles; cho rằng inspect_styles sơ sài. | `advanced-inspection-scripts.ts:34-242` đã bóc tách Box Model px, Typography, Layout, CSS Variables, Shadow DOM. | `[CLAIM FROM REPORT]` cho số liệu log; `[OBSERVED]` BÁC BỎ nhận định tool styles sơ sài. Agent lạm dụng evaluate vì thiếu cascade & batching. |
| **6.1** | P0.1 Theme Source Mapping | `anti.theme.resolve_element` map DOM $\to$ CSS $\to$ Liquid file $\to$ Setting. | `element-picker.ts:1600-1673` (`extractSourceHintsTS`) đã đọc `[data-section-id]`, `data-source-loc`. | `[OBSERVED]` ĐÍNH CHÍNH: Cần expose ra MCP nhưng phải phân tầng Confidence Tier (không thể map tất định 100%). |
| **6.2** | P0.2 Matched Styles | Đề xuất `anti.inspect.matched_styles` dùng `CSS.getMatchedStylesForNode`. | `TabDevToolsHost` (`tab-devtools-host.ts:486-612`) đã có CDP attach/queue và setup CSS domain; `BrowserHostPort` chưa expose method này. | `[OBSERVED]` CẦN NỐI TẦNG PORT: Hạ tầng CDP CSS đã có trong DevTools host; khoảng trống là thêm method vào port và tool catalogue. |
| **6.3** | P0.3 Responsive Matrix | Đề xuất `anti.inspect.responsive_matrix` (320, 375, 768, 1024, 1440). | Codebase đã có `DEVICE_PRESETS` (`device-presets.ts`) và `runResponsiveCheck` (`native-tab-host.ts:5185`). | `[OBSERVED]` TRÁNH LÀM LẠI: Tận dụng `DEVICE_PRESETS`; sửa lỗi hardcode trong `runResponsiveCheck` và sửa bug `setViewportSize`. |
| **6.4** | P0.4 Performance Audit | Đo LCP, CLS, long tasks, render-blocking gắn với theme source. | Cần bám sát Performance Observer nhẹ nhàng, tránh over-engineering thành full Lighthouse clone. | `[DERIVED]` CẦN GIỚI HẠN SCOPE để bảo vệ hiệu năng runtime. |
| **6.5** | P0.5 ThemeTaskContext | Hợp nhất context giữa Chat, Annotation và MCP. | Đã có `annotation-manager.ts`, `IssueRegister`, `VerificationClaim` nhưng chưa liên kết chặt. | `[OBSERVED]` ĐỒNG THUẬN: Cần schema hợp nhất nhẹ, không dựng thêm state engine cồng kềnh. |
| **6.6** | P0.6 Tool Selection Policy | 5 cognitive models thuộc Skill/reasoning layer, không thuộc Core Runtime. | Giữ nguyên tắc AntiFan không chứa prompt/reasoning logic bên trong tiến trình core. | `[DERIVED]` ĐỒNG THUẬN TUYỆT ĐỐI. |
| **7** | P1 Theme Domain Intelligence | Dependency map, settings intelligence, page archetype, reference contract, visual diff... | Các mục này chưa được khảo sát chi tiết trong mã nguồn ở phiên làm việc này. | `[NOT INDEPENDENTLY ASSESSED]` Khuyến nghị: logic phân tích cấu trúc tĩnh nên thuộc về OMP Skill. |
| **8** | P2 Chỉ Làm Khi Có Evidence | Trì hoãn tokens, storage inspection, semantic wait, tracing/video, locators. | Chưa có mã nguồn hay telemetry khảo sát cho các mục này trong phiên hiện tại. | `[NOT INDEPENDENTLY ASSESSED]` Về mặt nguyên tắc đồng thuận với việc hoãn lại (YAGNI). |
| **9** | Học Gì Từ Playwright MCP? | Học semantic interaction refs (`@ref`), vòng lặp observe-act-verify, trace, atomic ops. | Đã đăng ký capability `browser.agent-sequence` (`browser-capabilities.ts:486`) và `@e1..@eN` refs trong `semantic-ref-registry.ts`. | `[OBSERVED CAPABILITY DEFINITION]` Ghi nhận định nghĩa công cụ nguyên tử đã có trong codebase. |
| **10** | Những Gì Không Nên Thêm | Cấm Playwright MCP, second browser runtime, LLM in Core, Swarm, causal graphs. | `src/main/agent/execution-backend.ts` đang là dependency sống của `src/main/run/run-service.ts:60-61`. | `[OBSERVED DEPENDENCY]` CẢNH BÁO RANH GIỚI: Đồng ý cấm LLM in Core; nhưng `ExecutionBackend` là caller của RunService, cần audit wiring, không tự ý xóa. |
| **11** | Golden Vertical Slice | Đề xuất kịch bản "Screenshot $\to$ Header Clone" làm thước đo chuẩn. | Header thực tế quá lớn (Mega menu, localization, currency, cart drawer, sticky JS). | `[DERIVED]` HIỆU CHỈNH: Cần lát cắt nhỏ hơn (Hamburger Menu $\to$ Drawer $\to$ Overflow Check) để làm smoke test đóng băng Core. |
| **12** | Golden Scenarios Để Freeze Core | 5 kịch bản: Disclosure, Cart Drawer, Responsive Header, Annotation, Broken Interaction. | Các kịch bản này chưa được chạy live benchmark trong phiên làm việc này. | `[NOT INDEPENDENTLY ASSESSED]` Về mặt lý thuyết bao phủ tốt các tương tác e-commerce. |
| **13** | Verification Contract | Taxonomy 5 trạng thái (`VERIFIED`, `PARTIAL`, `REJECTED`, `INCONCLUSIVE`, `UNVERIFIED`), fail-closed. | `VerificationEvaluator` (`verification-evaluator.ts:128-258`) chạy máy trạng thái 5 phán quyết dựa trên `critical: boolean` và completeness. | `[OBSERVED IN CODE]` ĐỒNG THUẬN: Sử dụng nguyên bản 5 phán quyết hiện có, không chế thêm verdict engine mới. |
| **14** | Typography Inspection | Phân tách semantic states (NO_TEXT, FONT_FOUND...) thay vì chỉ check `cdpFonts.length > 0`. | `tab-devtools-host.ts:565` gọi trực tiếp CDP `CSS.getPlatformFontsForNode`, trả về `{ familyName, isCustomFont, glyphCount }`. | `[OBSERVED IN CODE]` ĐỒNG THUẬN KỸ THUẬT: Cần enum hóa rõ ràng để OMP không nhầm font fallback. |
| **15** | Mutation Attribution | Giữ attribution thưa (sparse), tất định, conservative; không làm causal graph engine. | Đã triển khai trong `src/main/verification/mutation-attribution.ts`. | `[OBSERVED]` ĐỒNG THUẬN TUYỆT ĐỐI. Tránh over-engineering suy diễn nhân quả. |
| **16** | Generic Interaction Delta | Giữ delta thưa, theo phạm vi, giải thích được (visibility, class, geometry, overlay). | Đã có trong `src/main/verification/interaction-delta.ts`. | `[OBSERVED]` ĐỒNG THUẬN. Giữ telemetry gọn gàng, tiết kiệm context token cho OMP. |
| **17** | Task Contract | Thứ tự: Canonical Task Contract $\to$ Vertical Slice $\to$ Generalize. | Chưa kiểm tra sâu file tài liệu task contract trong phiên này. | `[NOT INDEPENDENTLY ASSESSED]` Nguyên tắc lặp kỹ thuật là chuẩn mực chung. |
| **18** | Artifact / Provenance Lineage | Truy vết chuỗi: Request $\to$ Task $\to$ Evidence $\to$ Action $\to$ Mutation $\to$ Verification $\to$ Artifact. | Các store `receipt-store.ts`, `invocation-ledger.ts` tồn tại trong `src/main/session/`, chưa trace toàn bộ runtime pipeline. | `[PARTIALLY OBSERVED]` ĐỒNG THUẬN VỀ MỤC TIÊU: Cần đảm bảo tuyên bố sửa xong luôn có bằng chứng kèm theo. |
| **19** | Target Architecture | Sơ đồ phân tầng: OMP $\to$ Theme Skill $\to$ Adapter $\to$ AntiFan Control Plane $\to$ Native Engines. | Sơ đồ hợp lý về mặt phân tách vai trò kiến trúc. | `[DERIVED]` ĐỒNG THUẬN KIẾN TRÚC. OMP giữ vai trò reasoner, AntiFan giữ vai trò control plane. |
| **20** | Development Priority | Chia 5 phase: Theme Understanding $\to$ Clone $\to$ Perf $\to$ Quality $\to$ Agent Exp. | 5 phase quá dàn trải; nhiều mục P1 thuộc về OMP. | `[DERIVED]` HIỆU CHỈNH: Thu gọn thành 3 giai đoạn thực tế (Vá Emulation $\to$ Expose Hints $\to$ Audit Wiring & Freeze). |
| **21** | Golden Rejection Rule V2 | Tiêu chí nhận proposal: phục vụ theme thật, loại bỏ failure mode, giảm complexity; proof burden A/B/C. | Là bộ lọc chất lượng chống phình to tính năng. | `[DERIVED]` ĐỒNG THUẬN TUYỆT ĐỐI. Cần áp dụng nghiêm ngặt cho mọi đề xuất tương lai. |
| **22** | Final Capability Matrix | Bảng tổng kết trạng thái & độ ưu tiên của ~30 capabilities. | Chưa chạy benchmark kiểm chứng live cho toàn bộ 30+ capabilities trong phiên này. | `[NOT INDEPENDENTLY ASSESSED]` Nhận định meta-level: đánh giá thấp `advanced-inspection-scripts` và `DEVICE_PRESETS`. |
| **23** | Final Product Definition | "Theme Engineering Control Plane for OMP", không phải Agent IDE hay Browser Swarm. | Khóa chặt định vị, không cạnh tranh chức năng với OMP harness. | `[DERIVED]` ĐỒNG THUẬN TUYỆT ĐỐI. |
| **24** | Kết Luận | Đòn bẩy ROI lớn nhất là Theme Intelligence + Vertical Slice có proof. | Đúc kết chuẩn xác định hướng phát triển. | `[DERIVED]` ĐỒNG THUẬN VỀ ĐỊNH HƯỚNG. |
---

## 3. Phản biện Chuyên sâu từng Phần

### Trụ cột 1: Ranh giới OMP vs. AntiFan & Bác bỏ Playwright MCP

#### 1. Bác bỏ Playwright MCP: Quyết định sống còn
Báo cáo xác định nguyên tắc:
> *"AntiFan không cần tích hợp Playwright MCP... OMP thinks. AntiFan observes. AntiFan executes. AntiFan proves. OMP decides what to do next."*

- **Cơ sở kỹ thuật:** AntiFan đã có native Chromium (`tab-automation-host.ts`), kết nối CDP protocol và quản lý Terminal PTY [OBSERVED]. Nếu nhúng thêm Playwright MCP:
  - Ước tính tiêu tốn thêm tài nguyên bộ nhớ cho một tiến trình Node.js daemon thứ hai [ESTIMATED / UNVERIFIED BENCHMARK].
  - Nguy cơ xung đột khóa thư mục hồ sơ người dùng (Chrome Profile Lock) khi cả AntiFan và Playwright cùng gắn vào một thư mục dữ liệu [DERIVED].
  - Playwright thiết kế cho kiểm thử tự động black-box, mặc định không tích hợp cơ chế Sparse Interaction Delta, Mutation Attribution và Observation Integrity đặc thù của AntiFan [DERIVED FROM SPECS].
- **Ranh giới Kiến trúc giữa Execution Backend và Agent Reasoning (Cần Audit Wiring):**
  Báo cáo nêu nguyên tắc *"AntiFan không được là Agent runtime thứ hai"*. Tuy nhiên, việc tồn tại thư mục `src/main/agent/` (`execution-backend.ts`, `codex-execution-backend.ts`, `deepseek-harness-adapter.ts`) không đồng nghĩa với việc AntiFan đang cố biến thành một Agent Framework đối đầu OMP. Trong thực tế mã nguồn, `src/main/agent/execution-backend.ts` đang định nghĩa interface `ExecutionBackend` mà `src/main/run/run-service.ts:60-61` trực tiếp tiêu thụ trong `start()` và `cancel()` [OBSERVED].
  Vì vậy, kết luận kỹ thuật chính xác không phải là "vô hiệu hóa hay xóa bỏ", mà là **cần thực hiện kiểm toán toàn diện Call-Graph và Wiring**. Cần làm rõ: `ExecutionBackend` đóng vai trò là adapter thực thi lệnh cục bộ (local execution harness) cho các phiên run của desktop app, trong khi OMP đóng vai trò reasoning / decision-maker ở tầng cao hơn. Bất kỳ đề xuất tái cấu trúc hay di chuyển nào đều chỉ là tùy chọn sau khi đã lập bản đồ toàn bộ caller và bảo đảm không làm gãy run-path hiện hành.
---

### Trụ cột 2: Giải mã Nghịch lý Telemetry (169 Evaluate vs. 1 Inspect Styles)

Báo cáo trích dẫn phiên làm việc thực tế với 1926 dòng log, 609 lệnh gọi tool, trong đó:
- `anti_browser_evaluate`: **169 lần** ($27.7\%$).
- `anti_inspect_styles`: **duy nhất 1 lần**.

#### Phản biện nhận định của Báo cáo:
Báo cáo kết luận rằng Agent phải dùng `evaluate()` vì AntiFan chỉ có `getComputedStyle()` sơ sài. **Đây là kết luận chưa đọc kỹ mã nguồn.**

Khi kiểm tra `src/main/browser/scripts/advanced-inspection-scripts.ts:34-242`:
```typescript
// Trích xuất từ buildInspectStylesIsolatedScript thực tế:
return {
  ok: true,
  data: {
    target: { tag, id, className, rect },
    boxModel: { margin, padding, border }, // Đã parse sạch ra số thực px
    typography: { fontFamily, fontSize, fontWeight, lineHeight, ... },
    layout: { display, position, zIndex, flex, grid, gap, ... },
    visual: { backgroundColor, boxShadow, borderRadius, transform },
    cssVariables: { ... }, // Quét sạch toàn bộ custom property --*
    styles: requestedStyles
  }
};
```
Mã nguồn này còn hỗ trợ duyệt đệ quy qua Shadow DOM và Iframe (`resolveTraversalPath`). Nó vượt trội hơn một lệnh `getComputedStyle` thông thường.

#### Nguyên nhân Gốc rễ thực sự khiến Agent gọi `evaluate()` 169 lần:
1. **Thiếu CSS Cascade / Specificity:** Khi một phần tử bị lệch layout, Agent không cần biết `margin-top` hiện tại là bao nhiêu (nó đã thấy số $24\text{px}$), mà nó cần biết: *Quy tắc nào đang áp đặt $24\text{px}$? Quy tắc nào bị ghi đè?* Hiện tại `buildInspectStylesIsolatedScript` không đọc được danh sách matched rules.
2. **Thiếu Batching Viewport:** Để kiểm tra giao diện ở 3 màn hình, Agent không thể gọi 1 tool mà phải tự viết script vòng lặp `window.innerWidth` hoặc tự đổi class responsive trong `evaluate()`.
3. **Mô tả Tool trong MCP Schema chưa định tuyến đúng:** Trong `browser-capabilities.ts`, description của `anti.inspect.styles` chưa làm rõ rằng nó có thể đọc toàn bộ CSS variables và box-model số thực, khiến Agent có xu hướng tự viết JS thô cho an tâm.

---

### Trụ cột 3: Bóc trần Ảo tưởng Kỹ thuật của Bộ P0 Capabilities

#### 1. Phản biện `anti.theme.resolve_element` (Rendered UI $\to$ Source Mapping)
- **Kỳ vọng trong Báo cáo:** Map từ DOM $\to$ CSS selector $\to$ stylesheet $\to$ source location $\to$ Liquid file $\to$ snippet/section $\to$ template $\to$ setting.
- **Thực tế Kỹ thuật (The Liquid Abstraction Gap):**
  - Liquid là ngôn ngữ template render hoàn toàn trên server (DotLiquid của Haravan / Ruby Liquid của Shopify). 
  - Trình duyệt chỉ nhận về HTML thuần. Không có Sourcemap mặc định như Webpack/Vite JS.
  - Các class được nối chuỗi động: `class="product-card product-card--{{ section.settings.layout }}"` $\to$ Trình duyệt chỉ thấy `class="product-card product-card--grid"`. Không có phép màu CDP nào dịch ngược trực tiếp từ `product-card--grid` về chuỗi Liquid nguyên bản.
- **Mã nguồn AntiFan đã có gì?**
  Tại `src/main/browser/element-picker.ts:1600-1673`, hàm `extractSourceHintsTS` đã triển khai bộ nhận diện heuristic:
  - Tìm section gần nhất: `closest('section[id^="shopify-section-"], section[id^="haravan-section-"], [data-section-id], [data-section-type]')`.
  - Đọc thuộc tính build: `data-source-loc`, `data-source-line`, `data-astro-source-file`.
  - Xác định component: `data-component`, `data-react-component`.
- **Giải pháp Khả thi duy nhất:**
  Không được hứa hẹn độ chính xác $100\%$. Phải thiết kế theo **Confidence Tiers**:
  - **Tier 1 (High Confidence - 90-100%):** Dựa trên thuộc tính theme chính thức (`[data-section-id]`, `[data-section-type]`, comment nodes `<!-- BEGIN sections/... -->`).
  - **Tier 2 (Medium Confidence - 60-80%):** Dựa trên thuộc tính build (`data-source-loc`, `data-component`) hoặc khớp selector CSS tĩnh trong thư mục `assets/*.css`.
  - **Tier 3 (Low Confidence / Heuristic - <50%):** Dùng Workspace Grep tìm kiếm class/id trong thư mục `templates/`, `sections/`, `snippets/`.

#### 2. Phản biện `anti.inspect.matched_styles` (CSS Cascade & Specificity)
- **Hiện trạng Mã nguồn Thực tế:**
  Kiểm tra `src/main/browser/tab-devtools-host.ts:486-615`, `TabDevToolsHost` **đã có sẵn hạ tầng CDP hoàn chỉnh** [OBSERVED]:
  - Có cơ chế `sendCdpCommand` tự động gắn `wc.debugger.attach('1.3')` và quản lý hàng đợi serialization.
  - Đã gọi `DOM.enable` và `CSS.enable` trong hàm `getPlatformFontsForNode` (`tab-devtools-host.ts:571-572`).
  - Đã có logic phân giải node mục tiêu qua `DOM.requestNode` và `DOM.querySelector`.
- **Khoảng trống Kiến trúc Thực sự:**
  - `TabDevToolsHost` mới chỉ có hàm `getPlatformFontsForNode` (dùng `CSS.getPlatformFontsForNode`), **chưa bổ sung method `getMatchedStylesForNode`** (để gọi lệnh CDP `CSS.getMatchedStylesForNode`).
  - Interface `BrowserHostPort` (`src/main/tools/browser-control-port.ts:17-69`) **chưa expose matched-styles gateway** này ra tầng capability cho OMP.
- **Cảnh báo Về Tính Bền Vững của Node ID:**
  Trong Chromium CDP, `nodeId` có thể trở nên lỗi thời (stale) sau các đợt navigation hoặc DOM mutation lớn. Vì vậy, API nên nhận diện phần tử qua selector hoặc `@ref` ổn định, phân giải node id động tại thời điểm truy vấn trước khi gọi lệnh CDP.

#### 3. Phản biện `anti.performance.audit` (Theme Performance Profiling)
- **Nguy cơ phình to (Scope Creep):** Báo cáo muốn đo LCP, CLS, long tasks, script cost, network cost, image cost, render blocking. Đây là định nghĩa của toàn bộ Lighthouse!
- **Giải pháp tinh gọn:** Chỉ trích xuất 3 chỉ số then chốt thông qua Performance Timeline của Chromium:
  1. **LCP Candidate:** Định danh selector và URL tài nguyên của phần tử LCP.
  2. **CLS Layout Shift:** Danh sách các node bị dịch chuyển vị trí đột ngột.
  3. **First-party Render Blocking:** Danh sách các thẻ `<link rel="stylesheet">` và `<script>` đồng bộ nằm trong `<head>` thuộc thư mục `assets/` local của theme.

---

### Trụ cột 4: Device Presets & Lỗi Thực tế của Emulation Engine

Phần này phân tích trực tiếp câu hỏi người dùng về dropdown **Responsive Device Presets**:

```text
┌─────────────────────────────────────────────────────────────┐
│                    GUI Toolbar (toolbar.html)               │
│       Dropdown: deviceSelect (Hardcoded <option> IDs)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ Khớp mã định danh với
┌──────────────────────────────▼──────────────────────────────┐
│       DEVICE_PRESETS (src/main/browser/device-presets.ts)    │
│  - 4K, 2K, FHD, MacBook Pro/Air, iPad, Galaxy, iPhone...    │
│  - Metadata: width, height, DPR, mobile, UA, touch...       │
└──────────────────────────────┬──────────────────────────────┘
                               │ Điều khiển
┌──────────────────────────────▼──────────────────────────────┐
│           native-tab-host.ts (Backend Engine)                │
│  1. setDevicePreset(id) ──► updateLayout() ──► EMULATION OK  │
│  2. runResponsiveCheck() ──► Hardcode 3 mốc (393, 820, 1440) │
│  3. setViewportSize() ────► ID="${w}x${h}" ──► EMULATION BUG!│
└─────────────────────────────────────────────────────────────┘
```

#### 1. Codebase đã có sẵn những gì?
- `src/main/browser/device-presets.ts` (ở Main process) định nghĩa mảng `DEVICE_PRESETS` chi tiết (chia 4 nhóm: `responsive`, `desktop`, `tablet`, `mobile`) [OBSERVED].
- `toolbar.html:122-158` (ở Renderer process) chứa danh sách các thẻ `<option>` và `<optgroup>` được hardcode tĩnh. Hai danh sách này có **mã định danh ID dùng chung**, nhưng **chưa phải là một nguồn dữ liệu duy nhất (Single Source of Truth)** tại runtime; nếu bổ sung preset mới vào file TS ở main thì toolbar HTML không tự sinh thêm.
- Khi người dùng thay đổi lựa chọn trên toolbar, `toolbar.ts:903, 1121` dispatch giá trị preset ID đã chọn qua API để backend xử lý.
- `native-tab-host.ts:5185` đã có sẵn hàm `runResponsiveCheck`.

#### 2. Hai lỗi kỹ thuật cốt tử đang tồn tại trong Backend:
1. **Lệch pha Breakpoint:**
   `native-tab-host.ts:5192-5196` gán cứng:
   ```typescript
   const testBreakpoints = [
     { id: 'mobile-iphone15', name: 'Mobile iPhone 15', width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
     { id: 'tablet-ipad-air', name: 'Tablet iPad Air', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
     { id: 'desktop-laptop', name: 'Desktop Laptop 14"', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
   ];
   ```
   Nó bỏ qua mốc $320\text{px}$ (nơi phần lớn giao diện thương mại điện tử bị vỡ layout ngang) và mốc $768\text{px}$ (mốc breakpoint tablet dọc chuẩn của hầu hết theme Liquid).
2. **Bug nghiêm trọng tại `setViewportSize` (`native-tab-host.ts:5298-5304`):**
   ```typescript
   public setViewportSize(options: { width: number; height: number; ... }): boolean {
     const tab = this.tabs.get(targetId);
     if (!tab) return false;
     tab.state.devicePresetId = `${options.width}x${options.height}`;
     this.updateLayout();
     return true;
   }
   ```
   - Khi gán `devicePresetId = "375x667"`, chuỗi này **không tồn tại trong `DEVICE_PRESETS`**.
   - Khi `this.updateLayout()` chạy (`native-tab-host.ts:3901-3940`), nó tìm preset theo ID:
     `const preset = DEVICE_PRESETS.find(p => p.id === tab.state.devicePresetId);`
     $\to$ Kết quả trả về `undefined`!
   - Hệ quả: `updateLayout()` rơi vào nhánh mặc định (fluid desktop), **hoàn toàn không kích hoạt `safeEnableDeviceEmulation`**! Agent tưởng rằng màn hình đã đổi sang mobile, nhưng thực chất trình duyệt vẫn chạy ở chế độ desktop không có mobile user-agent, không có touch emulation.

---

### Trụ cột 5: Golden Vertical Slice & Verification Invariants

#### 1. Phản biện kịch bản "Screenshot $\to$ Header Clone"
- Báo cáo chọn việc clone toàn bộ Header làm Golden Slice.
- **Rủi ro:** Header của một theme thực tế chứa Navigation đa cấp, Search Modal AJAX, Cart Drawer, Localization Currency Form, Mega Menu, sticky header JavaScript... Nếu chọn kịch bản quá lớn này làm gate đóng băng Core, quá trình kiểm thử sẽ liên tục thất bại vì những lỗi không liên quan đến Core (ví dụ: lỗi parse Liquid của OMP).
- **Golden Slice tinh gọn chuẩn xác (Minimal Viable Golden Slice):**
  $$\text{Mobile Hamburger Click} \longrightarrow \text{Drawer Mutation} \longrightarrow \text{Observation Integrity} \longrightarrow \text{Overflow DeltaX Check} \longrightarrow \text{Fail-Closed Verdict}$$
  Kịch bản này kiểm tra đủ $100\%$ các mắt xích: Browser Action $\to$ Sparse Delta $\to$ Viewport Emulation $\to$ Verification Evaluator.

#### 2. Tính toàn vẹn của Verification Contract (Cơ chế Thực tế của `VerificationEvaluator`)
- **Khảo sát mã nguồn thực tế (`src/main/verification/verification-evaluator.ts:128-258`) [OBSERVED]:**
  Bộ máy kiểm chứng hiện hữu không phải là một bộ ba phán quyết (triad) giản lược, mà là một **máy trạng thái fail-closed 5 phán quyết** tích hợp cờ `critical: boolean`:
  1. **`INCONCLUSIVE`:** Trả về khi `completeness === 'EMPTY'` (hoàn toàn không quan sát được bằng chứng hoặc không có obligation nào được đo đạc, `evaluatedCount === 0`).
  2. **`REJECTED`:** Trả về khi có bất kỳ nghĩa vụ nào mang cờ `critical: true` bị thiếu (`missing`) hoặc vi phạm ngưỡng (`failed threshold`), HOẶC phát hiện kiểm tra hình thức trùng lặp (tautological anti-gaming check).
  3. **`PARTIAL`:** Trả về khi thiếu nghĩa vụ không-critical (`completeness === 'PARTIAL'`, `evaluatedCount < obligations.length`), HOẶC có vi phạm nhỏ nhưng các metric khác vẫn pass (`passedMetricsCount > 0`).
  4. **`VERIFIED`:** Trả về khi và chỉ khi $100\%$ nghĩa vụ được đo đầy đủ (`completeness === 'FULL'`), không có bất kỳ vi phạm nào (`violations.length === 0`), và nhân chứng ngữ nghĩa (nếu có) xác nhận đồng thuận.
- **Nguyên tắc Invariant bất biến:** Tuyệt đối không dựng thêm verdict engine mới; toàn bộ Theme Evidence từ P0 sẽ được mô hình hóa trực tiếp thành `ProofObligation` (với cờ `critical` tương ứng) để tận dụng chính xác cỗ máy đánh giá 5 trạng thái này.
---

## 4. Kiến trúc Đích Thực tế (Grounded Target Architecture)

Dựa trên việc tận dụng tối đa mã nguồn hiện có và vá đúng các khoảng trống thực tế:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        OMP (Agent Layer / Reasoner)                    │
│   - Planning, Tool Routing, Liquid/CSS Editing, Workspace AST Search   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ JSON-RPC / MCP Transport
┌───────────────────────────────────▼────────────────────────────────────┐
│                    AntiFan Control Plane (Port & Host)                 │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ [HIỆN HỮU CẦN GIỮ NGUYÊN]                                      │   │
│   │ • Chromium Tab Host & Automation Host                          │   │
│   │ • Terminal PTY Manager & Local IPC                             │   │
│   │ • advanced-inspection-scripts (BoxModel, Typography, Layout)   │   │
│   │ • VerificationEvaluator & IssueRegister (Fail-Closed Engine)   │   │
│   │ • DEVICE_PRESETS (Danh mục chuẩn cho cả GUI & MCP)             │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ [NÂNG CẤP BẮT BUỘC - P0 GAP CLOSURE]                           │   │
│   │ 1. browser.responsive-check (Nâng cấp nhận 5 mốc chuẩn theme)  │   │
│   │ 2. Sửa bug setViewportSize (Kích hoạt đúng Device Emulation)   │   │
│   │ 3. anti.inspect.source_hints (Expose extractSourceHintsTS)     │   │
│   │ 4. anti.inspect.matched_styles (Thêm CDP CSS Session layer)    │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Lộ trình Triển khai 3 Giai đoạn Bắt buộc

Không triển khai dàn trải 5 giai đoạn như báo cáo lý thuyết; tập trung vào 3 giai đoạn tinh gọn có bằng chứng kiểm thử:

### Giai đoạn 1: Vá lỗi Emulation & Chuẩn hóa Responsive Matrix (Ưu tiên cao nhất)
1. **Sửa bug `setViewportSize` (`native-tab-host.ts:5298`):** Đảm bảo khi truyền kích thước tùy ý, hàm tự động tạo cấu hình emulation động và gọi `safeEnableDeviceEmulation` thay vì chỉ lưu ID chuỗi vô nghĩa.
2. **Nâng cấp `runResponsiveCheck` (`native-tab-host.ts:5185`):**
   - Mở rộng danh sách breakpoint mặc định lên 5 mốc chuẩn:
     - `mobile-small`: $320 \times 568$ ($2\times$)
     - `mobile-iphone`: $375 \times 667$ ($2\times$)
     - `tablet-portrait`: $768 \times 1024$ ($2\times$)
     - `tablet-desktop`: $1024 \times 768$ ($2\times$)
     - `desktop-laptop`: $1440 \times 900$ ($1\times$)
   - Cho phép nhận mảng `presetIds?: string[]` lấy trực tiếp từ `DEVICE_PRESETS`.
   - Bổ sung tham số `selectors?: string[]` đo nhanh `visibility`, `display` của các phần tử quan trọng ở từng breakpoint.

### Giai đoạn 2: Expose Source Hints & Matched CSS Rules
1. **Expose `anti.inspect.source_hints`:** Tách hàm `extractSourceHintsTS` từ `element-picker.ts:1600` thành một capability độc lập trong `browser-capabilities.ts`, trả về `sectionId`, `sectionType`, `suggestedFile` kèm `frameworkConfidence`.
2. **Bổ sung CDP CSS Gateway (`anti.inspect.matched_styles`):**
   - Bổ sung vào `BrowserHostPort` khả năng mở CDP session trên tab mục tiêu.
   - Nhận diện phần tử qua `@ref` hoặc selector $\to$ lấy `backendNodeId`.
   - Gọi `CSS.getMatchedStylesForNode`, trích xuất quy tắc active, overridden và specificity.

### Giai đoạn 3: Kiểm toán Ranh giới Wiring & Đóng băng Core
1. **Kiểm toán Ranh giới & Wiring của `ExecutionBackend`:** Tiến hành rà soát toàn diện call-graph giữa `run-service.ts`, các test suite và `execution-backend.ts` [OBSERVED DEPENDENCY]. Xác định chính xác phạm vi của adapter thực thi nội bộ so với ranh giới điều khiển của OMP. Mọi điều chỉnh cấu trúc chỉ được xem xét như một tùy chọn thứ cấp sau khi đã bảo đảm tính tương thích tuyệt đối của pipeline thực thi hiện hành.
2. **Kiểm chứng Kịch bản Golden Scenario:** Chạy kịch bản kiểm chứng đóng mở Mobile Menu Drawer khi có môi trường live browser, ghi nhận toàn bộ log qua `anti.verification.verify_claim` với phán quyết `VERIFIED`.

---
*Báo cáo thẩm định tĩnh cấu trúc mã nguồn (Static Source Inspection) theo Fable Thinking Protocol — Mọi phát hiện đều gắn nhãn Claim Discipline rõ ràng, chưa bao gồm live benchmark trên browser đang chạy.*
```

---

## PHẦN II: PHÂN ĐỊNH RÕ RÀNG HIỆN TRẠNG (ĐÃ CÓ / THIẾU / ĐỀ XUẤT) VỀ TƯƠNG TÁC AGENT & BROWSER

Nhằm bảo đảm tuyệt đối nguyên tắc **Claim Discipline**, tránh việc trình bày các giải pháp kiến trúc như thể đã được code xong, bảng dưới đây phân tách rạch ròi giữa thực tế mã nguồn và kế hoạch đề xuất:

### 1. Phân loại theo 3 nhóm trạng thái

#### Nhóm 1: `ĐÃ CÓ` (Codebase & Capabilities hiện hữu [OBSERVED])
* **Đăng ký Capability & Aliases trong `src/main/tools/browser-capabilities.ts`:**
  - `browser.dom` (dòng 237–245): Bounded DOM evidence capture.
  - `browser.dump_dom` (dòng 246–277): Streaming DOM ra file workspace an toàn trên Windows.
  - `browser.screenshot` (dòng 280–288): Chụp viewport hoặc full-page.
  - `browser.observe` (dòng 289–310): Thu thập đa phương thức (dom, screenshot, snapshot, diagnostics).
  - Hệ thống alias tương thích: `anti.inspect.snapshot` (:572), `anti.inspect.find` (:582), `anti.inspect.observe` (:600), `anti.browser.wait` (:624).
  - Bộ compatibility MCP/Bridge: `antifan_list_tabs` (:790), `antifan_open_tab` (:798), `antifan_navigate` (:826), `antifan_reload` (:836), `antifan_get_dom` (:846).
* **Kiểm tra Box Model & CSS Variables trong `advanced-inspection-scripts.ts:34-242`:** Đã bóc tách số thực px của margin, padding, border, typography, layout, transform và toàn bộ custom properties `--*`.
* **Hạ tầng CDP trong `tab-devtools-host.ts:486-615`:** Có sẵn attach debugger, gọi `DOM.enable`, `CSS.enable`, lấy platform fonts.
* **Bộ máy phán quyết trong `verification-evaluator.ts:128-258`:** Máy trạng thái 5 phán quyết (`VERIFIED`, `PARTIAL`, `REJECTED`, `INCONCLUSIVE`, `UNVERIFIED`) với cờ `critical`.

#### Nhóm 2: `THIẾU` (Chưa có bằng chứng trong mã nguồn / Chưa tích hợp [NOT INDEPENDENTLY ASSESSED])
* **Ambient Prompt Injection trong OMP Harness:** Chưa có mã nguồn nào trong OMP hay AntiFan tự động scan tab live của AntiFan để chèn block `[ACTIVE STOREFRONT TELEMETRY DETECTED]` vào đầu prompt mỗi turn. Agent vẫn phải nhận diện công cụ qua danh mục tĩnh.
* **Hard Verification Lifecycle Gate:** Chưa có cơ chế cơ học nào ở tầng Harness chặn đứng lệnh `done` hoặc tự động từ chối kết quả nếu Agent chỉ dùng script offline mà không gọi lệnh chụp ảnh/kiểm tra browser thật.
* **CDP Matched Styles Gateway trên Control Port:** `TabDevToolsHost` chưa có method `getMatchedStylesForNode`, và `BrowserHostPort` chưa expose gateway này ra công cụ cho Agent.
* **Đồng bộ Breakpoint & Sửa bug `setViewportSize`:** Hàm `runResponsiveCheck` vẫn gán cứng 3 thiết bị; hàm `setViewportSize` vẫn bị lỗi gán ID kích thước không khớp danh mục `DEVICE_PRESETS`.

#### Nhóm 3: `ĐỀ XUẤT` (Giải pháp kiến trúc định hướng — Chưa triển khai)
* **Đề xuất 1 (Hạ tầng Harness):** Xây dựng hook tiêm nhận thức môi trường (Ambient Telemetry Injection) trước mỗi turn để Agent thấy ngay `tabId` đang mở.
* **Đề xuất 2 (Cấu hình Prompt):** Tái cấu trúc độ ưu tiên trong System Prompt, đưa các tool browser hiện hữu (`browser.dom`, `browser.screenshot`, `antifan_*`) lên danh mục khuyến nghị hàng đầu cho workspace theme; không viết thêm wrapper trùng lặp.
* **Đề xuất 3 (Kỷ luật hợp đồng):** Bổ sung điều khoản cứng vào Root Contract (`CLAUDE.md` / `AGENTS.md`) phân định: Cho phép Python làm máy tính giải tích toạ độ, cấm Python `PIL` làm cơ quan nghiệm thu thị giác.

---

## PHẦN III: CHẨN ĐOÁN CA BỆNH THỰC CHIẾN (SESSION OWLBRAND)

Dữ liệu dưới đây được trích xuất từ phiên làm việc thực tế:  
`C:\Users\Admin\.omp\agent\sessions\--E--Work-customizes-OwlBrand--\2026-09-04T10-10-45-686Z_01a06be6-3b35-7111-9716-ff34ec26c39b.jsonl`

- **Tổng số tool calls [CLAIM FROM SESSION]:** 97 lần (`read`: 51, `grep`: 17, `bash`: 12, `write`: 8, `edit`: 5, `glob`: 4).
- **Trước lượt tin nhắn 164 [CLAIM FROM SESSION]:**
  - AntiFan MCP: **0 lần gọi**.
  - `bash` (chạy script Python): **10 lần gọi**.
- **Diễn biến tại điểm bùng phát (Lượt 151–164) [CLAIM FROM SESSION]:**
  - **Lượt 151:** User gửi ảnh phản hồi chữ bị dính sát mép trên.
  - **Lượt 152 & 154:** Agent chạy `python -c "import math..."` tính toạ độ góc xoay $-30^\circ$.
  - **Lượt 156 & 158:** Agent kiểm tra `PIL` và chạy script dùng `ImageDraw`, `ImageFont` sinh file ảnh giả lập `test_badge_preview.png`.
  - **Lượt 162:** Agent sửa `assets/styles.css.liquid` dựa trên ảnh PIL.
  - **Lượt 164:** User ra lệnh tường minh: *"Dùng AntiFan MCP nhé"*.
  - **Lượt 165–184:** Agent gọi `write` tới `xd://mcp__antifan_browser_anti_browser_tabs_list`, phát hiện 3 tab đang mở (`owlbrand.vn`), sau đó dùng `anti_inspect_dom`, `anti_inspect_styles`, `anti_browser_evaluate` và `anti_screenshot_viewport`.
  - **Lượt 190:** Khi được yêu cầu tăng 2px font size, Agent vẫn dùng Python `math` tính trước: $w=92, h=28 \to \text{top} = 56\text{px}$, sau đó mới inject và chụp ảnh bằng AntiFan MCP.

### Đánh giá bản chất kỹ thuật:
1. **Kill-test về tài liệu skill:** Agent **chưa từng đọc file `frontend-verification.md`** trong suốt 202 lượt thoại [CLAIM FROM SESSION]. Do đó, việc đổ lỗi cho tài liệu skill dẫn dắt sai là một kết luận hậu nghiệm (post-hoc rationalization).
2. **Căn bệnh "Tự sướng khép kín" (Closed-World Simulation):** Agent ưu tiên chạy Python trong `bash` vì đây là con đường ít lực cản nhất (0.3s, chạy trong sandbox cục bộ, không lo rớt mạng, không lo DOM timing).
3. **Phân định đúng ranh giới của Python:**
   - Dùng Python `math` tính toán toạ độ giải tích (như lượt 152, 190) là **chính xác và tiết kiệm token**.
   - Dùng Python `PIL` vẽ ảnh giả lập để tự nghiệm thu (như lượt 158) là **sai phạm quy trình**, thay thế trái phép trình duyệt thực tế.

---

## PHẦN IV: DISCLAIMER & CAM KẾT KỶ LUẬT THỰC NGHIỆM

1. **Phạm vi thẩm định:** Toàn bộ các khẳng định trong Phần I và Phần II được xác lập thông qua **kiểm tra tĩnh cấu trúc mã nguồn (Static Source Inspection)** trên commit HEAD tại `E:\Work\apps\antifan-browser-desktop`. Báo cáo **chưa bao gồm số liệu live browser benchmark trên ứng dụng đang chạy thực tế**.
2. **Loại trừ bằng chứng Best-of-5:** Quá trình thử nghiệm chạy 5 subagents (`Candidate_A` .. `Candidate_E`) theo chế độ `--ultra` trong phiên làm việc này đã gặp lỗi runtime cấp harness:
   `TypeError: undefined is not an object (evaluating 'rt.getWorkPoolYieldItems')`
   Do đó, toàn bộ kết quả phân tích Best-of-5 được xếp loại `stale_unverified` / dispatch failure và **tuyệt đối không được sử dụng làm căn cứ kỹ thuật** cho bản báo cáo này.
3. **Tính trung thực của bằng chứng:** Mọi kết luận kỹ thuật chỉ dựa trên những gì đã được đọc trực tiếp từ mã nguồn (`[OBSERVED]`) hoặc trích xuất nguyên văn từ telemetry của session (`[CLAIM FROM SESSION]`). Mọi nội dung chưa được kiểm chứng độc lập đều mang nhãn `[NOT INDEPENDENTLY ASSESSED]`.

---
*Báo cáo được lập theo Fable Thinking Protocol — Tôn trọng sự thật khách quan, phân biệt rạch ròi giữa thực tế mã nguồn và định hướng tương lai.*
