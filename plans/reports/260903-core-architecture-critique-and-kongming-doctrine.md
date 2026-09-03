# BÁO CÁO KIẾN TRÚC ĐÓNG BĂNG ANTIFAN (BẢN ĐẠO LÝ KHỔNG MINH v3.0 - FINAL SEALED DOCTRINE)
## Định hình Ranh giới Nền tảng, Tối giản Tầng trừu tượng & Lộ trình Thực thi Chuẩn xác
**Ngày phê chuẩn:** 2026-09-03  
**Vị trí HEAD kiểm chứng:** `e65af478` (Nhánh `main`)  
**Hội đồng Kiến trúc:** Khổng Minh (`kongming` / Principal Systems Architect) & Ban Kỹ thuật AntiFan  
**Trạng thái:** **ARCHITECTURE FROZEN (ĐÓNG BĂNG TRANH LUẬN — CHUYỂN SANG THỰC THI)**

---

## 1. Tuyên ngôn Kiến trúc Tối thượng (Core Architecture Axiom)

AntiFan chính thức xác lập định vị công nghệ:
$$\mathbf{AntiFan\ Core} \equiv \mathbf{Tập\ hợp\ Năng\ lực\ Tái\ sử\ dụng\ về\ Quan\ sát,\ Hiểu\ và\ Xác\ minh\ Web/UI}$$

### 3 Định lý Kiến trúc đã được Chuẩn hóa:
1. **Ranh giới khóa ngay, Mô hình tiến hóa dần:** Không vội vã xây dựng một tầng "Semantic Substrate" cồng kềnh ngay lúc này. Ranh giới (Boundary) giữa Core và Platform phải được thiết lập sạch sẽ ngay hôm nay; còn hợp đồng dữ liệu ngữ nghĩa (Semantic Information/Model) sẽ tiến hóa từng bước theo bằng chứng thực tế.
2. **Sapo Canary $\equiv$ Stress-Test Ranh giới (Boundary Proof):** Không mở rộng thành việc hỗ trợ Sapo (Sapo Support/Theme System). Mục tiêu duy nhất của Sapo Canary là bài kiểm tra độ dẻo của ranh giới (Architectural Stress Test) nhằm triệt tiêu hoàn toàn nguy cơ khóa chặt (lock-in) vào Shopify/Haravan.
3. **Core phi thực thi runtime (Zero Codegen in Core):** Tầng Core Understanding chỉ chịu trách nhiệm nhận diện biến thiên ngữ nghĩa (Trigger $\to$ State Delta $\to$ Effect Model $\to$ ARIA change). Tuyệt đối không nhúng logic sinh mã runtime (như `data-antifan-*`, Alpine, jQuery) vào Core. Sinh mã thuộc 100% trách nhiệm của Platform Adapter.

---

## 2. Cấu trúc Tô-pô Chuẩn hóa (The Final Sealed Topology)

```text
                                ANTIFAN
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
           CORE CAPABILITIES                   CONTROL PLANE
                 │                     (Tab Registry, Native Input,
         ┌───────┼───────┐              Workspaces, Telemetry, RPC)
         │       │       │
      OBSERVE UNDERSTAND VERIFY
         │       │       │
         └───────┼───────┘
                 │
                 ▼
         Semantic Information
     (Page, Component, Constraints,
      Content, State Model, Evidence)
                 │
         ┌───────┼───────────────────┐
         │       │                   │
      [Clone] [Figma Parity]    [Annotation Guide]
         │       │                   │
         └───────┼───────────────────┘
                 │
                 ▼
          Platform Adapters
         ┌───────┼───────┐
         │       │       │
      Haravan   Sapo   Shopify
     (10/10)   (Probe) (Future)
```

---

## 3. Bản Hợp chuẩn 4 Trụ cột Kỹ thuật

### Trụ cột 1: Core Capabilities (Năng lực lõi tái sử dụng)
- **OBSERVE (Quan sát):** DOM Token AST, Render Tree, Computed CSS, Geometry Bounding Box, Responsive Viewport Presets (1440/768/390), Asset Harvester (Fonts tiếng Việt, Media, Stylesheets).
- **UNDERSTAND (Hiểu):** Cấu trúc phân cấp Component, Layout Constraints (Grid, Flexbox, Positioning), Ecommerce Data Entities (Sản phẩm, Biến thể, Giá dạng range, Danh mục), Interaction & State Transition Model.
- **VERIFY (Xác minh):** CleanTabProtocol (Snapshot & Restore hoàn nguyên), Mutation QA Harness (Stress-test 5 chiều: Cardinality, Long text, Image ratio, Viewport leak, Residual DOM), Visual Pixel Compare.

### Trụ cột 2: Semantic Information Boundary (Hợp đồng thông tin ngữ nghĩa)
Không dựng một package/schema đồ sộ. Hiện tại trong `packages/site-clone`, ta chuẩn hóa ranh giới nội bộ:
```text
packages/site-clone/src/models/
  ├── dom-tree-parser.ts         [CORE CAPABILITY]: 0% Liquid, 0% Platform Schema
  ├── asset-harvester.ts         [CORE CAPABILITY]: Thu hoạch tài nguyên thuần túy
  ├── responsive-scanner.ts      [CORE CAPABILITY]: Nhận diện layout & viewports
  ├── ecommerce-data-modeler.ts  [CORE CAPABILITY]: Trích xuất thực thể thương mại
  └── clone-ir.ts                [SEMANTIC INFORMATION CONTRACT]:
                                 Bổ sung alias 'components', 'children'
                                 chuẩn bị cho sự tiến hóa độc lập.
```

### Trụ cột 3: The 5-Case Sapo Canary Probe (Thử nghiệm 5 ca phá vỡ giả định)
Thay vì làm 10–15 case gây loãng nguồn lực, thu hẹp thành đúng **5 ca phá vỡ ranh giới** trong một script kiểm thử độc lập (`scripts/probes/sapo-boundary-probe.ts`):
- **Ca 1 (Layout):** Khung layout phức tạp (Flex wrap + nested grid + sticky navigation).
- **Ca 2 (Component Hierarchy):** Cấu trúc menu đa cấp không phụ thuộc vào Shopify blocks.
- **Ca 3 (Data Diversity):** Sản phẩm có giá dạng khoảng (range), giảm giá, hết hàng, không có trường giả định của Haravan.
- **Ca 4 (Interaction / State):** Modal video/drawer với backdrop click, Escape key, ARIA expanded mà không dùng `data-antifan-*`.
- **Ca 5 (Template Divergence):** Cấu trúc output phẳng dạng BWT của Sapo (cấm string slice filter).

*Nếu 5 ca này chạy trơn tru qua Semantic Information $\to$ Sapo Adapter stub: DỪNG LẠI NGAY. Đóng kết quả, không viết tiếp compiler Sapo.*

### Trụ cột 4: Dọn dẹp rò rỉ tại Core Browser Tools
- Sửa dứt điểm file `src/main/tools/browser-capabilities.ts`:
  - **Loại bỏ:** Các chuỗi selector hardcode `shopify-section-`, `haravan-section-`.
  - **Loại bỏ:** Đoạn fetch trực tiếp `/products/${handle}.js`.
  - **Thay thế:** Sử dụng `PlatformDetector` đã có sẵn tại `src/main/qa/scanners/platform-detector.ts` để phân nhánh hợp lý, giữ Browser Core 100% trung lập.

---

## 4. Bảng Quy tắc Đóng băng (Architecture Freeze Rules)

| Phân vùng | Được phép làm | Nghiêm cấm tuyệt đối |
|---|---|---|
| **Core Models** | Đọc DOM, trích xuất token hình học, đo đạc layout, phát hiện sự kiện và trạng thái UI. | Không chứa 1 dòng mã Liquid, không chứa JSON schema của Shopify/Haravan, không sinh mã JS runtime. |
| **Semantic Contract** | Cung cấp thông tin trung lập về Component, Bounding Box, Content, State Transitions. | Không tạo package riêng cồng kềnh khi chưa có Consumer thứ 2 chạy thực tế; không tạo Universal Mega IR. |
| **Platform Adapters** | Chứa logic riêng của Haravan (Liquid, settings_schema, micro-runtime), Sapo (BWT). | Không kéo ngược quy ước của platform vào tầng Core Models. |
| **Sapo Probe** | Viết test assertion cho 5 ca phá vỡ ranh giới (Timebox $\le 2$ ngày). | Không mở rộng thành việc hỗ trợ Sapo, không viết Sapo Theme Compiler lúc này. |

---

## 5. Kết luận & Mệnh lệnh Hành động (Action Order)

Cuộc tranh luận kiến trúc qua 4 vòng đối thoại tri thức đã đạt được **sự đồng thuận tuyệt đối (100% Convergence)**:
- **Tư tưởng lớn:** AntiFan là Web/UI Understanding Runtime.
- **Thực tế sắc bén:** Giữ boundary sạch ngay bây giờ, mô hình tiến hóa dần theo bằng chứng, dồn toàn lực đưa Haravan OS 2.0 đạt độ hoàn thiện sản phẩm thương phẩm 10/10.

**Chính thức đóng lại phiên thảo luận kiến trúc. Mọi nỗ lực kỹ thuật từ thời điểm này tập trung 100% vào việc thực thi và hoàn thiện mã nguồn.**
