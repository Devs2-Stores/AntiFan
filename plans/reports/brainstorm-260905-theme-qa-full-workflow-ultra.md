# BÁO CÁO KẾT QUẢ ULTRA BRAINSTORM: WORKFLOW TEST FULL THEME MỚI
**Trạng thái artifact:** Kiến trúc/phương pháp được chọn để lập kế hoạch — **chưa triển khai, chưa benchmark và chưa được chứng nhận runtime**  
**Đối tượng:** Theme Haravan, Sapo (Bizweb), Shopify  
**Nền tảng tri thức:** Kế thừa `/skill:theme-qa-az` (524 feedback review Sapo, HS1–HS26 gates) & Hạ tầng MCP AntiFan  
**Chế độ lịch sử:** Best-of-5 candidate run; verifier được chạy bằng generic `task` agent đặt tên `Kongming`, không phải installed `kongming` agent  
**Tính hợp lệ:** Giữ ranking như hồ sơ lịch sử; không tuyên bố Fable/Kongming supervision hoặc Ultra verifier identity đầy đủ  
**Ghi chú phân tầng mô hình:** *Same-tier independent samples + rubric selection; không phải thẩm định bất đối xứng.*


## QUYẾT ĐỊNH KIẾN TRÚC SAU KHI ĐỐI CHIẾU SOURCE

Candidate D bên dưới được giữ nguyên như **lựa chọn lịch sử** của lượt Best-of-5. Lean OMP contract trong phần này là **refinement tiếp theo dựa trên source evidence**, không phải materialization nguyên vẹn của Candidate D. Controller không bê ATV-OMR thành subsystem và không xem các số `~28–60 giây`, `100% coverage`, `490 -> 8 reload` hay `zero pollution` là sự thật hiện tại; chúng chỉ là giả thuyết/benchmark cần đo.

### Outcome đã chốt

Xây một **Theme QA workflow/skill phía OMP** để quyết định test cái gì, áp platform profile nào, phân loại surface nào và yêu cầu bằng chứng nào. Workflow điều phối các primitive AntiFan hiện có theo chuỗi:

```text
OMP Theme QA Skill
  -> platform profile + discovered surface classes + selected contracts
  -> AntiFan OBSERVE / CONTROL / RECORD / COMPARE / VERIFY
  -> coverage ledger + evidence dossier
  -> OMP quyết định fix gì
```

AntiFan Core tiếp tục đóng vai trò generic evidence/control plane. Core Freeze không bị mở lại để xây crawler, AST engine, cart tester, search tester, platform rules hoặc `ATV-OMR Engine` nguyên khối.

### Constraints đã chốt

1. **Evidence classes không được trộn:**
   - Static/AST = `STRUCTURAL_EVIDENCE`; chứng minh cấu trúc code, không chứng minh nhánh đã render đúng.
   - Runtime trên storefront nguyên bản = `NATIVE_RUNTIME_EVIDENCE`.
   - DOM/CSS injection = `SYNTHETIC_STRESS_EVIDENCE`; chỉ chứng minh container chịu một stress cụ thể, không chứng minh production state PASS.
   - `theme.assert_cart` = `PASSIVE_TELEMETRY`; chỉ chứng minh request/form đã quan sát được, không chứng minh add/change/remove end-to-end.
2. **Mutation probes là opt-in:** Chỉ chạy add/change/remove cart hoặc submit form trên disposable/test storefront có quyền sở hữu rõ ràng, baseline state, contract cleanup riêng theo platform và hậu kiểm state. Không dùng `/cart/clear.js` như cleanup contract phổ quát; `cart.item_count === 0` không chứng minh không có side effect inventory/customer/order.
3. **State-sensitive flows cần điều hướng/reload thật:** Empty state, server-rendered variant, auth/order/address và trạng thái phụ thuộc Liquid không được thay bằng sửa DOM. Nếu fixture/route thật không tồn tại, ghi `UNSUPPORTED` hoặc `BLOCKED`, không suy ra PASS.
4. **Surface tiers là heuristic:** `interactive-core`, `contract/form`, `passive-content` được suy ra từ inventory và theme manifest; không hard-code một danh sách 14 surface làm chân lý phổ quát.
5. **Không có evidence không phải PASS:** Mỗi contract phải có trạng thái `VERIFIED | FAILED | UNVERIFIED | UNSUPPORTED | SKIPPED_APPROVED | BLOCKED`. Contract bắt buộc ở trạng thái `UNVERIFIED` hoặc `BLOCKED` làm verdict fail-closed; `UNSUPPORTED` và `SKIPPED_APPROVED` phải xuất hiện trong coverage ledger cùng lý do.
6. **Coverage trung thực:** Báo `verifiedContracts: n/m` trong tập hợp contract đã chọn, kèm unsupported/skipped; không gọi đó là `100% storefront behavior coverage`.

7. **`theme.qa_validate` không phải zero-side-effect read:** Capability được đăng ký `risk: read`, nhưng implementation reload tab và có thể tạo `workspaceRoot/specs/`, rồi ghi đè `specs/qa-matrix.json`. Lean workflow được gọi là **non-source-mutating**, không phải read-only tuyệt đối. Manifest/planning phải cho phép rõ hai bounded effects này khi gọi capability: `reload-current-tab` và `write-workspace-report`. Nếu target hoặc workspace không cho phép, workflow không được gọi capability này và phải dùng các primitive passive riêng lẻ hoặc trả `BLOCKED`.

### Hiện trạng AntiFan đã xác nhận

| Năng lực | Hiện có | Chưa có / không được suy diễn |
|---|---|---|
| `theme.qa_validate` | Validate **một bound tab**: debounce 150ms, reload thật, font + double-rAF settle, DOM/screenshot, Liquid/overflow/assets/HS/server/diagnostics, staged JSON artifact; đồng thời có thể tạo/ghi đè `workspaceRoot/specs/qa-matrix.json` | Không phải read-only tuyệt đối; không crawl route, không phân loại nhiều surface, không quản lý data-state coverage |
| `anti.inspect.responsive_matrix` | Passive geometry trên 5 mặc định: `320, 375, 768, 1024, 1440`; đổi emulation, chờ 60ms rồi đo overflow | Không có 1920 mặc định; không dispatch `resize`; không reload; không chứng minh slider/component state-sensitive đã re-init |
| `theme.assert_cart` | Passive telemetry từ resource timing và form contract | Không tự add/change/remove; không có rollback hoặc zero-pollution guarantee |
| Differential attribution | Đã có cho diagnostics, Liquid, overflow, broken assets và HS findings | Chưa phải cross-route/surface workflow ledger |
| `page_inventory` | Passive inventory của trang hiện tại | Không phải universal surface crawler/classifier |

### Hai prerequisite Core hẹp trước verdict responsive có thẩm quyền

1. **Fail closed khi responsive evidence thiếu:** `ThemeQaWorkflow.validate` hiện giữ clean fallback khi `responsiveCheck` lỗi hoặc trả `{ ok: false }`. Phải truyền trạng thái `UNVERIFIED/BLOCKED` vào report; không được ánh xạ lỗi probe thành PASS. Chỉ cho phép bỏ qua qua policy `SKIPPED_APPROVED` rõ ràng.
2. **Viewport transition semantics:** Sau thay đổi viewport, cần dispatch semantics tương đương resize và chạy bounded font/layout settle trước khi đo. Với flow nhạy trạng thái, phải reload/navigate thật rồi verify fresh document; 60ms chờ cố định không đủ làm bằng chứng phổ quát.

### Integration boundary cho `/ak:plan`

- Public MCP schema của `theme.qa_validate` hiện chỉ nhận `tabId`, `workspaceRoot`, `multiBreakpoint`. Nó không nhận selected-contract manifest, surface registry hoặc baseline ledger.
- `baselineFindings` tồn tại trong `ThemeQaWorkflow.validate()` nội bộ nhưng không được expose qua public capability. Không được ngầm coi public MCP đã hỗ trợ cross-route differential orchestration.
- Hướng mặc định/YAGNI: OMP Theme QA Skill giữ manifest, surface classification, coverage ledger và baseline so sánh; gọi `theme.qa_validate` riêng cho từng bound route bằng schema hiện có và tổng hợp **returned reports/artifacts**, không dựa vào file `specs/qa-matrix.json` vốn có thể bị ghi đè giữa các route.
- Mỗi lần gọi `theme.qa_validate` phải khai báo/cho phép browser reload và bounded report write. Nếu cần strict read-only execution, OMP dùng `theme.debug_bundle`, `page_inventory`, `responsive_matrix` và các primitive passive khác thay vì `theme.qa_validate`.
- Chỉ lập kế hoạch thay public schema/adapter khi workflow thật sự cần Core nhận baseline/manifest hoặc cần tắt workspace persistence. Đây là một integration decision riêng, không phải capability hiện có.

### Non-goals

- Không thêm `ThemeQaEngine2`, route crawler Core, platform rule engine Core hoặc một catalog tool mới khi primitive hiện tại đã biểu đạt được phép quan sát.
- Không tự sửa source, commit, push theme hay biến QA workflow thành coding agent.
- Không dùng synthetic DOM mutation để cấp chứng nhận production-state.
- Không cam kết SLA `28 giây` hoặc coverage `100%` trước benchmark trên corpus theme thật.

### Acceptance criteria cho workflow/skill phía OMP

1. Input manifest ghi platform profile, discovered surfaces, selected contracts, evidence class và mutation policy.
2. Mỗi selected contract kết thúc bằng một trong sáu trạng thái coverage; không có kết quả ngầm định.
3. Verdict `PASS` chỉ khi mọi contract bắt buộc là `VERIFIED`, không có `FAILED`, `UNVERIFIED` hoặc `BLOCKED`; approved skips được liệt kê riêng.
4. Structural, native runtime, synthetic stress và passive telemetry có nhãn riêng trong dossier; loại bằng chứng này không được nâng cấp thành loại khác.
5. Responsive coverage chỉ được ghi `VERIFIED` khi mọi breakpoint bắt buộc trả evidence thành công sau viewport transition + settle; probe error trả `UNVERIFIED/BLOCKED`.
6. Live mutation mặc định tắt. Khi bật, target phải được khai báo disposable/test, baseline và post-state evidence phải tồn tại; nếu cleanup không được chứng minh, run là `BLOCKED/FAILED`, không phải PASS.
7. Báo cáo coverage dạng `verified/selected`, kèm `failed`, `unverified`, `unsupported`, `skippedApproved`; thời gian chạy là measurement của từng run, không phải architectural guarantee.

### Trạng thái checkpoint `--advice`

Runtime từ chối `agent='kongming'` với lỗi `Unknown agent "kongming"`; agent khả dụng chỉ gồm `scout`, `reviewer`, `security-reviewer`, `librarian`, `task`, `sonic`. Vì vậy **Kongming/Fable advisory supervision không khả dụng trong phiên này**. Một generic `task` agent đặt tên `Kongming-2` sau đó trả input `GO_WITH_CONCERNS`; đây chỉ là same-tier task-agent counsel, không phải Kongming verdict. Quyết định lean OMP được controller chốt từ source evidence; task counsel chỉ củng cố ba điều kiện: orchestration ở OMP, thiếu evidence = `UNVERIFIED`, và hai responsive prerequisites phải hoàn tất trước authoritative verdict.

### Planning-only handoff

`GO` trong tài liệu này chỉ có nghĩa **đủ cơ sở để lập implementation plan**, không có nghĩa workflow đã được ship. Plan kế tiếp phải giữ hai gate bắt buộc:

1. Sửa responsive probe để error/missing evidence thành `UNVERIFIED/BLOCKED`, không thành PASS.
2. Bổ sung viewport transition semantics (`resize` + bounded settle; navigation/reload thật cho state-sensitive flows) trước khi phát hành responsive coverage có thẩm quyền.

Plan phải giữ bốn evidence class hiện tại: `STRUCTURAL_EVIDENCE`, `NATIVE_RUNTIME_EVIDENCE`, `SYNTHETIC_STRESS_EVIDENCE`, `PASSIVE_TELEMETRY`. Chưa được claim route crawling, Markdown dossier generation, mutation safety, benchmark thời gian hoặc coverage toàn diện cho tới khi implementation và runtime proof tương ứng tồn tại.
---

## I. BẢNG XẾP HẠNG LỊCH SỬ CỦA GENERIC TASK-AGENT VERIFIER

### 1. Bảng điểm Rubric (Thang 1.0 – 20.0 mỗi tiêu chí, Trọng số 25%)

| Mã ứng viên | Định danh gốc | 1. Faithfulness (25%) | 2. Evidence Grounding (25%) | 3. Sharpness of AC (25%) | 4. Honesty / Unknowns (25%) | Tổng điểm (/80.0) | Chuẩn hóa (/100) | Xếp hạng | Trạng thái |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Candidate D** | **Candidate 1-3** | **19.8** | **19.8** | **19.7** | **19.8** | **79.1** | **98.88%** | **1st** | **WINNER (Thắng tuyệt đối)** |
| **Candidate B** | Candidate 2-3 | 18.5 | 18.5 | 18.0 | 18.0 | 73.0 | 91.25% | 2nd | Runner-up |
| **Candidate E** | Candidate 3-3 | 18.2 | 18.0 | 17.8 | 17.5 | 71.5 | 89.38% | 3rd | Bị loại |
| **Candidate C** | Candidate 5-3 | 17.5 | 17.0 | 17.0 | 17.5 | 69.0 | 86.25% | 4th | Bị loại |
| **Candidate A** | Candidate 4-3 | 17.0 | 16.5 | 16.5 | 16.0 | 66.0 | 82.50% | 5th | Bị loại |

---

### 2. Lựa chọn lịch sử của generic task-agent verifier
> **Lựa chọn lịch sử:** **Candidate D (ATV-OMR)** được xếp hạng cao nhất trong lượt Best-of-5; phần refinement phía trên thay thế nó làm handoff cho planning.
> **Lý do quyết định:**
> 1. **Khắc phục triệt để điểm nghẽn 490 permutations:** Phân rã trực giao (ODF-BVS) nén toàn bộ thời gian chạy từ 40.8 phút xuống còn **~28 giây** bằng cách tách biệt hình học layout (quét in-memory qua CDP), server template logic (quét tĩnh AST cho empty states), và tương tác JS (chỉ test trên route hạt nhân).
> 2. **Cô lập ranh giới nền tảng tuyệt đối:** Nghiêm cấm hoàn toàn việc rò rỉ các luật 0D (HS1–HS26) và 0.11 (Sapo UTM footer) sang theme Haravan hay Shopify.
> 3. **Tiêu chuẩn nghiệm thu sắc bén, có thể kiểm chứng:** Bắt buộc báo cáo tỷ lệ tương tác dạng phân số (`87/87 clickable passed`), đo tràn ngang `deltaX > 1px` kèm selector và bounding box chính xác, cam kết giỏ hàng sạch rác sau test (`item_count === 0`).
> 4. **Thấu hiểu sâu sắc các bẫy runtime thực tế:** Là ứng viên duy nhất chỉ ra được việc thư viện slider cũ (Slick/Owl) không chịu co giãn khi đổi viewport qua CDP nếu thiếu lệnh `window.dispatchEvent(new Event('resize'))`, đồng thời cảnh báo bẫy Chromium background tab throttling và font layout shift (FOUT).

---

## II. NỘI DUNG NGUYÊN VẸN CỦA ỨNG VIÊN CHIẾN THẮNG (CANDIDATE D)

### Tên hướng tiếp cận:
**Autonomous Tiered Verification & Orthogonal Matrix Reduction Pipeline (ATV-OMR)**  
*(Quy trình Thẩm định Đa tầng Tự động hóa & Giảm chiều Ma trận Trực giao)*

---

### 1. BRAINSTORM CONTRACT

#### 1.1. Outcome (Trạng thái vận hành đích)
Một quy trình thẩm định storefront đa tầng tự động hóa hoàn toàn, chuyển hóa toàn bộ việc kiểm thử theme từ một danh mục 490 tổ hợp dễ bị bỏ qua thành một pipeline tự động chạy trong **dưới 5 phút (thực tế ~28 đến 60 giây)**.  
Hệ thống cung cấp một Hồ sơ Thẩm định chuẩn mực (**Review Dossier** gồm `qa-matrix.json` và báo cáo Markdown) chứa 100% bằng chứng viễn trắc runtime kiểm chứng được (biên nhận CDP, DOM culprit selector, vết mạng, phân tích sai khác hồi quy) cho các theme Haravan, Sapo và Shopify mà **không xảy ra bất kỳ sự rò rỉ luật chéo nền tảng nào**.

#### 1.2. Constraints (Ranh giới & Ràng buộc cứng)
1. **Safety & Data Hygiene (Vệ sinh dữ liệu an toàn):** Quá trình kiểm thử tuyệt đối KHÔNG làm biến động dữ liệu sản xuất của merchant. Không tạo đơn hàng giả, không ghi vĩnh viễn dữ liệu khách hàng, không để lại sản phẩm tồn đọng trong giỏ hàng (`item_count === 0`).
2. **Platform Sandboxing (Cách ly nền tảng nghiêm ngặt):** Phải thực thi ranh giới kiến trúc cứng giữa các nền tảng (Haravan Liquid/F1GENZ vs Sapo DotLiquid/.bwt/HS gates vs Shopify OS 2.0). Nghiêm cấm rò rỉ luật Sapo (0.11 footer sapo.vn UTM, HS1–HS26) sang Haravan/Shopify.
3. **Execution Time Ceiling (Trần thời gian thực thi):** Toàn bộ quy trình không được vượt quá 5 phút (300 giây) trên môi trường phát triển tiêu chuẩn (4 cores, 8GB RAM).
4. **Non-Stealing Headless Control (Kiểm soát không chiếm dụng):** Vận hành hoàn toàn thông qua các tab CDP nền của AntiFan Browser Desktop mà không chiếm focus cửa sổ hệ điều hành, không giật chuột và không làm gián đoạn việc gõ phím của lập trình viên.
5. **Zero Source Mutation (Không tự ý sửa mã nguồn):** Workflow là cơ quan thẩm định chỉ đọc (read-only verification); tuyệt đối không tự động sửa code theme, không xóa template, không tự kích hoạt lệnh commit VCS hoặc lệnh đẩy code lên live CDN (`haravan theme push`, `shopify theme push`, `sapo theme push`).

#### 1.3. Non-Goals (Phạm vi từ chối ôm đồm)
1. **Không tự động tái cấu trúc/sửa code (No Automated Code Refactoring):** Workflow định vị lỗi, chỉ rõ selector gây lỗi và đưa ra hướng xử lý, nhưng KHÔNG tự ý ghi đè mã nguồn đa file.
2. **Không thực hiện giao dịch thanh toán thật (No Payment Gateway Clearing):** Quá trình kiểm thử dừng lại ở cổng vào thanh toán (`/checkout`); không mô phỏng OTP ngân hàng, thử thách 3D Secure hay thanh toán trừ tiền thẻ tín dụng thật.
3. **Không kiểm thử tải hạ tầng Cloud (No Cloud Infrastructure Auditing):** Workflow kiểm tra mã nguồn theme, DOM và client-side script; không benchmark năng lực chịu tải server Haravan/Sapo/Shopify, độ trễ database đa vùng hay tốc độ DNS propagation.
4. **Không dựng ma trận trình duyệt đa engine (No Multi-Engine Grid):** Tập trung tối đa vào độ trung thực cao của Chromium CDP qua AntiFan Desktop; không khởi động Selenium grid từ xa cho Safari WebKit hay Firefox.

#### 1.4. Acceptance Criteria (Tiêu chuẩn nghiệm thu nhị phân & kiểm chứng được)
- **AC-1 (Phán quyết thực thi nhị phân):** Mỗi lượt chạy phải sinh ra trạng thái kết thúc xác định (`PASS` hoặc `FAIL`), artifact `qa-matrix.json` có cấu trúc và một bản Review Dossier định dạng Markdown hoàn chỉnh trong thời gian dưới 5 phút.
- **AC-2 (Độ tinh khiết ranh giới nền tảng 100%):** Báo cáo đúng `0` vi phạm luật đặc thù Sapo (HS1–HS26, UTM nofollow, form Gold) đối với theme Haravan hoặc Shopify; `0` vi phạm Haravan schema được áp đặt lên file Sapo `.bwt`.
- **AC-3 (Định lượng độ bao phủ tương tác):** 100% các luồng tương tác (Chuyển đổi Variant, AJAX Cart Add/Change/Clear, Debounce tìm kiếm thông minh, Drawer menu mobile) phải báo cáo bằng chứng dạng phân số cụ thể (ví dụ: `32/32 variant combinations verified`, `14/14 surfaces crawled with 0 uncaught exceptions`).
- **AC-4 (Không bỏ sót tràn ngang viewport):** Phát hiện chính xác 100% hiện tượng tràn ngang màn hình (`deltaX > 1px`) trên desktop (1920, 1440), tablet (1024, 768), và mobile (480, 375, 320) kèm theo đúng CSS selector của phần tử vi phạm và tọa độ bounding rect.
- **AC-5 (Phân loại sai khác hồi quy tất định):** 100% các lỗi phát hiện được phải được phân loại chính xác vào `preExistingIssues`, `resolvedIssues`, hoặc `introducedRegressions` dựa trên mã băm tất định `category:signature`.
- **AC-6 (Không ô nhiễm trạng thái live):** Trạng thái giỏ hàng sau khi kết thúc chu trình test phải được xác nhận hoàn toàn sạch sẽ (`cart.item_count === 0`), không sinh đơn hàng rác và không tạo tài khoản ảo trong cơ sở dữ liệu live của merchant.

---

### 2. KIẾN TRÚC PIPELINE VÀ CHIẾN LƯỢC PHÂN RÃ TRỰC GIAO (ODF-BVS)

#### 2.1. Bản chất điểm nghẽn & Cơ sở toán học
Ma trận cũ của `theme-qa-az` v2.3:
$$\text{Tổng số hoán vị} = 14 \text{ surfaces} \times 5 \text{ data states} \times 7 \text{ breakpoints} = 490 \text{ tổ hợp}$$
Nếu chạy tuần tự trên trình duyệt với thời gian tải trang trung bình 5 giây:
$$490 \times 5\text{s} = 2.450\text{ giây} \approx 40.8\text{ phút!}$$
Đây là lý do 90% kỹ sư buộc phải bỏ qua Pass 3 trong thực tế.

**Nguyên lý phân rã trực giao (Orthogonal Decoupling):**
3 chiều kiểm thử này trên thực tế độc lập về mặt vật lý:
1. **Responsive Layout (Breakpoints):** Chi phối bởi CSS Media Queries và hình học box-model. Một phần tử bị tràn ngang do gán cứng `min-width: 500px` sẽ bị tràn ngang trên bất kỳ trạng thái dữ liệu nào (dù collection có 10 hay 100 sản phẩm).
2. **Template Logic (Data States):** Chi phối bởi server-side Liquid/BWT (danh mục rỗng, ảnh thiếu, null pointer). Lỗi crash Liquid xảy ra giống hệt nhau ở cả 1920px và 320px.
3. **Interactive Components (Surfaces):** Chi phối bởi JavaScript client-side (variant picker, AJAX cart, debounce search). Logic JS này đóng gói theo component và hoạt động đồng nhất trên các route dùng chung component đó.

Do đó, tích Descartes $S \times D \times B$ được phân rã thành **3 phép chiếu trực giao**:

```
+----------------------------------------------------------------------------------------------------+
| TẦNG 1: Rút gọn Breakpoint theo Giá trị Biên (7 -> 3 Viewports vật lý)                             |
| Thay vì nạp lại trang 7 lần, tập trung vào 3 giá trị biên tới hạn:                                 |
| 1. Wide Desktop Boundary: 1440px (Neo khung lưới desktop & mega-menu)                              |
| 2. Tablet Collapse Boundary: 768px (Điểm gãy responsive chuyển sang giao diện mobile)              |
| 3. Minimum Mobile Stress Boundary: 320px (Điểm ép hình học nhỏ nhất - iPhone SE)                   |
| Các kích thước phụ (1920, 1024, 480, 375): Quét in-memory qua CDP trong 50ms mà không reload trang.|
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| TẦNG 2: Tách đôi Trạng thái Dữ liệu (Static AST vs In-Memory Injection)                            |
| - State 1 (Demo chuẩn): Kiểm tra trực tiếp trên route storefront thật.                             |
| - State 2 (Dữ liệu rỗng): Chuyển 100% sang phân tích AST Liquid ở Pass 2 (kiểm tra các nhánh       |
|   {% if collection.products.size == 0 %} và {% for ... else %}) + 1 route search rỗng live.        |
| - State 3 & 4 (Dữ liệu dài & Ký tự đặc biệt): Tiêm trực tiếp chuỗi text 200 ký tự vào DOM qua      |
|   anti.browser.evaluate trong RAM tab, đo layout và hoàn nguyên trong 150ms mà không cần reload.   |
| - State 5 (Sau thao tác): Tích hợp trực tiếp vào chuỗi tương tác (Add to cart -> Clear cart).      |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| TẦNG 3: Phân loại Độ nhạy của Bề mặt (14 -> 4 Core + 3 Contract + 7 Passive Inventory)             |
| - Nhóm A (Interactive Core - 4 surfaces: Header, Product, Collection, Cart): Chạy full state test. |
| - Nhóm B (Form & Contract - 3 surfaces: Account, Contact, Orders): Quét form action và Gold fields.|
| - Nhóm C (Content & Static - 7 surfaces: Home, Blog, Article, Search, 404...): Quét thụ động.     |
+----------------------------------------------------------------------------------------------------+
```

**Định lượng thời gian thực thi:**
- 4 surfaces Nhóm A $\times$ 2 viewports (1440, 375) $\times$ 1 live state = **12.0s**
- 14 surfaces $\times$ 3 viewports quét in-memory qua CDP = **8.4s**
- 14 file template phân tích cú pháp AST tĩnh = **1.2s**
- 6 container chính tiêm thử nghiệm chuỗi dài trong RAM = **0.8s**
- Settle gate & xuất báo cáo = **5.0s**  
$$\mathbf{Tổng\ thời\ gian:\ \approx 27.4\ giây!}\ (\text{Nhanh hơn 87 lần so với 40 phút})$$

---

#### 2.2. Pipeline thực thi 5 giai đoạn chi tiết

```
[ Stage 0: Pre-Flight Static Sandboxing & Platform Identity Gate ] (~800ms)
                        │
                        ▼ (Fail-Fast nếu xung đột nền tảng hoặc lỗi cú pháp)
[ Stage 1: Dynamic Route Crawling & Baseline Health Telemetry ] (~2.5s)
                        │
                        ▼ (Thu thập sitemap, bắt lỗi 404/500, snapshot baseline)
[ Stage 2: Stateful Interaction Probing & Contract Verification ] (~12 - 15s)
                        │
                        ▼ (Variant swatch, AJAX Cart Lifecycle, Search debounce)
[ Stage 3: Orthogonal Multi-Breakpoint Sweeper & Layout Overflow ] (~8s)
                        │
                        ▼ (Đo deltaX > 1px, sub-pixel deadband, tìm DOM culprit)
[ Stage 4: Differential Attribution, Scoring & Review Dossier ] (~2s)
```

- **Stage 0:** Phân tích dấu hiệu platform, khóa cứng quy tắc (Haravan tắt 0B/0D; Sapo bật HS1–HS26 khi convert). Quét cú pháp Liquid/BWT trước khi mở trình duyệt.
- **Stage 1:** Khám phá sitemap tự động trích xuất canonical routes cho 14 surfaces. Thiết lập cổng ổn định 2 nhịp (Font readiness 400ms race + Double rAF 150ms race). Bắt lỗi console, 404 assets và server crash 500.
- **Stage 2:** Tự động hóa tương tác qua `anti.agent.sequence` và `theme.assert_cart`:
  - Chọn đổi variant -> kiểm tra giá, SKU, ảnh và nút mua đồng bộ.
  - Gửi request `/cart/add.js` -> kiểm tra đúng chuẩn platform (`variantId` cho Sapo theo HS4, `id` cho Haravan) -> bắt sự kiện mở Cart Drawer -> kiểm tra badge số lượng -> dọn dẹp giỏ hàng về 0 bằng `/cart/clear.js`.
  - Thử nghiệm tìm kiếm thông minh: kiểm tra debounce $\ge 300\text{ms}$, phím `Escape` đóng popup.
- **Stage 3:** Co giãn màn hình in-memory qua CDP tại các ngưỡng 1440px, 768px, 320px. Chạy `LayoutOverflowEngine` bắt lỗi `deltaX > 1.0px` (loại bỏ sai số làm tròn float $\le 1.0\text{px}$). **Đặc biệt:** Bắn sự kiện `window.dispatchEvent(new Event('resize'))` sau mỗi lần đổi viewport để kích hoạt lại các slider cũ (Slick/Owl).
- **Stage 4:** Áp dụng `DifferentialAttribution` bóc tách `preExistingIssues`, `resolvedIssues`, `introducedRegressions`. Tính điểm 8 chiều QA Matrix và xuất file báo cáo Markdown chuẩn reviewer tại `plans/reports/`.

---

### 3. SO SÁNH CÁC HƯỚNG TIẾP CẬN (TRADE-OFF ANALYSIS)

| Chiều đánh giá | Hướng 1: Exhaustive Brute-Force (Chạy đủ 490 lần) | Hướng 2: Static-Heavy Shift-Left (Chỉ quét regex/AST) | Hướng 3: ATV-OMR (Đề xuất chiến thắng) |
|---|---|---|---|
| **Giả định cốt lõi** | Phải tải lại trang trên trình duyệt cho từng tổ hợp thì mới tin cậy. | 95% lỗi có thể bắt bằng phân tích tĩnh mã nguồn mà không cần mở trình duyệt. | Hình học layout, template logic và tương tác JS có tính trực giao; có thể phân tách thành các phép quét biên và micro-injection. |
| **Thời gian chạy** | 35 – 45 phút. | Dưới 10 giây. | **25 – 30 giây.** |
| **Tài nguyên hệ thống** | Rất nặng, dễ rò rỉ RAM, sập tiến trình Chromium. | Cực nhẹ, chỉ tốn CPU xử lý regex/AST. | **Tối ưu: 1 tab CDP chạy nền trong RAM.** |
| **Độ phủ tương tác JS** | Cao trên lý thuyết nhưng thực tế thường bị abort giữa chừng. | Bằng 0 (Mù hoàn toàn trước lỗi runtime JS, AJAX cart). | **Cao & Trúng đích: 100% luồng Variant, Cart, Search, Drawer.** |
| **Độ chính xác Layout** | Đầy đủ 7 viewports. | Bằng 0 (Không render được layout DOM thật). | **Chính xác tuyệt đối (Đo deltaX > 1px bằng CDP thật).** |
| **Kịch bản tồi tệ nhất** | Bị Cloudflare rate-limit 429, trình duyệt crash, kỹ sư bỏ dùng. | Theme pass kiểm thử tĩnh nhưng bị Reviewer Sapo từ chối ngay vì vỡ layout mobile. | Bỏ lọt một lỗi CSS dị biệt chỉ xuất hiện ở đúng 480px mà không có ở 375px hay 768px. |
| **Điều kiện sụp đổ đầu tiên** | Trình duyệt crash vì cạn bộ nhớ sau 50 lần tải trang liên tục. | Gặp lỗi JS runtime (`TypeError: Cannot read properties of undefined`) trong bundle. | Gặp theme dùng cross-origin iframe sandbox chặn truy cập DOM của CDP. |

---

### 4. TRUNG THỰC VỀ RỦI RO & VÙNG TỐI KỸ THUẬT (HONESTY ABOUT UNKNOWNS)

1. **Ranh giới Tự động hóa vs Thẩm mỹ của Reviewer:**
   - CDP đo đạc chính xác 100% kích thước hình học, diện tích bấm phím và mã lỗi cú pháp. Tuy nhiên, **gu thẩm mỹ thiết kế** (hình ảnh banner bị giãn tỷ lệ, màu sắc tương phản khó nhìn, bố cục thô) vẫn phụ thuộc vào cảm quan của Reviewer. Workflow giải quyết bằng cách đính kèm ảnh chụp màn hình độ nét cao vào Dossier để mắt người xác nhận nhanh.
2. **Các trang yêu cầu Mật khẩu & Đăng nhập (Auth Gates):**
   - Các trang `/account/orders` và `/account/addresses` yêu cầu session khách hàng. Trên store demo trắng, direct URL sẽ bị redirect về `/account/login`.
   - *Giải pháp:* Nếu có session cookie, chạy test live. Nếu không, chuyển sang quét tĩnh AST template (bắt lỗi HS9–HS11 `line_item.product.url`) và kiểm tra form đăng nhập/đăng ký, không cố tạo tài khoản rác.
3. **Hiện tượng Throttling khi tab chạy nền (Background Tab Throttling):**
   - Chromium tự động kẹp timer `setTimeout` xuống 1000ms và ngừng `requestAnimationFrame` khi tab không hiển thị.
   - *Giải pháp:* Sử dụng kịch bản settle gate có timeout dự phòng (racing 150ms fallback) đã tích hợp trong `theme-qa-workflow.ts`.
4. **Nhiễu từ Ứng dụng Bên thứ ba (Third-Party Noise):**
   - Các script tracking (Facebook Pixel, TikTok Pixel, Chat widget) thường ném lỗi console 404/CORS ngoài tầm kiểm soát của theme.
   - *Giải pháp:* Module `diagnostics-filter.ts` lọc triệt để theo nguồn gốc (origin). Lỗi từ domain bên thứ ba chỉ phân loại thành `diagnosticWarnings`, không bao giờ làm fail gate của theme.
5. **Rủi ro Rate-Limit & Bot Protection của Cloudflare/Haravan WAF:**
   - *Giải pháp:* Nhờ ODF-BVS giảm số lượt load trang từ 490 xuống ~8 lượt load thật, giãn cách 150ms giữa các thao tác nên hoàn toàn triệt tiêu nguy cơ bị WAF chặn IP.
