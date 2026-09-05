# IMMUTABLE EVIDENCE PACKET: WORKFLOW TEST FULL THEME MỚI (ULTRA BRAINSTORM)

## 1. User Request & Intent
- **User Prompt:** `--ultra Tôi đang suy nghĩ về một Workflow test full theme mới. Ví dụ với skill tôi có /skill:theme-qa-az`
- **Objective:** Brainstorm một quy trình/kiến trúc Workflow kiểm thử toàn diện (Full Theme Test Workflow) cho các theme storefront E-commerce (đặc biệt là Haravan, Sapo, Shopify), lấy nền tảng và bài học thực chiến từ skill hiện có `/skill:theme-qa-az`.
- **Mode:** Best-of-5 Ultra Verifier (ak:brainstorm --ultra).

---

## 2. Ground Truth & Hiện Trạng Kiến Trúc Hiện Tại

### 2.1. Skill `theme-qa-az` (v2.3)
- **Nguồn gốc:** Đúc kết từ 524 feedback review thực tế của đội ngũ duyệt theme Sapo (`assets/feedback-dataset.jsonl`) và 26 cổng kiểm soát chuyển đổi Haravan -> Sapo (`references/h2s-convert-gates.md`, HS1-HS26).
- **Quy trình 4 Pass hiện tại:**
  - **Pass 1 — Static code checks:** Dùng regex grep quét các mẫu anti-pattern, lỗi cú pháp, thẻ deprecated, platform leakage (`references/qa-checklist-a-to-z.md`).
  - **Pass 2 — Empty-state template scan:** Đọc code template (`.liquid` / `.bwt`) kiểm tra nhánh rỗng (Nhóm B) và settings coverage (Nhóm H).
  - **Pass 3 — Live surface checks:** Quét theo ma trận bề mặt (`references/qa-surface-matrix.md`): 14+ surfaces (Header, Home, Collection, Product, Cart, Quickview, Search, Smart-search, Blog, Contact, Account, Orders, Addresses, 404, Settings) × 5 trạng thái dữ liệu (Demo chuẩn, Dữ liệu rỗng, Dữ liệu dài, Dữ liệu biên/đặc biệt, Sau thao tác F5/toggle) × 7 breakpoints (1920, 1440, 1024, 768, 480, 375, 320).
  - **Pass 4 — Cổng chất lượng Phần 0:** 0A (mọi platform), 0B (luật kho Sapo: footer sapo.vn, load time, snippet), 0D (Sapo convert HS1-HS26).
- **Hạn chế cố hữu của `theme-qa-az`:**
  1. **Bế tắc ở Pass 3 (Live checks):** Ma trận 14 surfaces × 5 states × 7 breakpoints = 490 permutations! LLM không thể test thủ công bằng mắt. Trong 90% phiên làm việc thực tế, Pass 3 bị bỏ qua hoặc chỉ click 1-2 trang hời hợt.
  2. **Thiếu cơ chế Dynamic Crawler:** Không tự động phát hiện sitemap hoặc route các trang storefront thật để đo console errors, 404 assets, horizontal overflow.
  3. **Thiếu Interactive State Probing:** Không tự động thực thi các chuỗi tương tác phức tạp (chuyển đổi variant ma trận 3 thuộc tính, thêm giỏ hàng AJAX, cập nhật số lượng, xóa item giỏ hàng, search autocomplete debounce, mở drawer/modal).
  4. **Không có Differential Regression Testing:** Khi fix 1 bug ở product page, không biết có làm vỡ mobile menu hay cart drawer ở trang khác không. Thiếu baseline snapshot.
  5. **Nguy cơ rò rỉ platform (Platform Leakage):** Luật review của Sapo (như thẻ sapo.vn UTM nofollow, form Gold) bị lẫn sang theme Haravan hoặc Shopify nếu không có cơ chế cô lập ngữ cảnh cứng.

### 2.2. Hạ tầng Browser MCP & QA Engine hiện có (AntiFan Browser Desktop)
Codebase `antifan-browser-desktop` (`src/main/qa/` và `src/main/tools/`):
- `theme.qa_validate` / `antifan_theme_qa_validate`: Điều phối QA tự động gồm:
  - `PlatformDetector`: Nhận diện Haravan (`settings_schema.json`, `.liquid`, `hstatic.net`), Sapo (`.bwt`, `bizweb.dktcdn.net`), Shopify.
  - `LiquidErrorScanner`: Quét lỗi render Liquid/BWT.
  - `BrokenAssetScanner`: Bắt asset 404/500 từ CSS/JS/Image.
  - `LayoutOverflowEngine`: Quét ngang tìm phần tử tràn viewport (horizontal scrollbar) tại Desktop (1920), Tablet (768), Mobile (375).
  - `HsGateRules`: Quét 26 vi phạm HS1-HS26.
  - `DifferentialAttribution`: Phân loại lỗi cũ (`preExistingIssues`), lỗi đã sửa (`resolvedIssues`), lỗi mới phát sinh (`introducedRegressions`).
- `theme.debug_bundle`: Xuất bundle chẩn đoán nhanh (platform, liquid, overflow, HS).
- `theme.assert_cart`: Kiểm tra hợp đồng giỏ hàng storefront ở chế độ thụ động (không ghi dữ liệu rác).
- `anti.inspect.page_inventory`: Quét toàn bộ cây cấu trúc trang từ y=0 đến scrollHeight.
- `anti.inspect.responsive_matrix`: Kiểm tra overflow tại các breakpoint chuẩn.
- `anti.verification.record_claim` & `verify_claim`: Khung kiểm chứng bằng chứng dựa trên CDP và runtime receipt.

---

## 3. Nhiệm Vụ Của Ứng Viên (Candidate Task)
Mỗi ứng viên độc lập cần đề xuất một bản thiết kế toàn diện cho **"Workflow Test Full Theme Mới"**:
1. **Brainstorm Contract hoàn chỉnh:**
   - **Outcome:** Trạng thái vận hành cuối cùng, giá trị cụ thể mang lại cho kỹ sư theme & reviewer.
   - **Constraints:** Ranh giới kỹ thuật, an toàn dữ liệu khách, tương thích nền tảng (Haravan, Sapo, Shopify), chi phí runtime.
   - **Non-goals:** Những việc workflow này KHÔNG ôm đồm (ví dụ: không tự ý sửa code theme, không can thiệp backend server Haravan/Sapo...).
   - **Acceptance Criteria:** Các tiêu chí nghiệm thu nhị phân (Pass/Fail rõ ràng), có thể đo lường và kiểm chứng được.
2. **Kiến Trúc Workflow Đa Tầng (Phased Pipeline Architecture):**
   - Phân tầng luồng test rõ ràng (ví dụ: Tầng 1: Static Pre-flight & Platform Sandboxing -> Tầng 2: Dynamic Route Crawl & Health Baseline -> Tầng 3: Stateful Interaction & Contract Verification -> Tầng 4: Multi-Breakpoint & Visual Regression -> Tầng 5: Review Dossier & Triage Report).
   - Cơ chế giải quyết bài toán 490 permutations của Pass 3: Làm thế nào để test đủ mà không nổ thời gian/chi phí?
   - Cơ chế xử lý 5 trạng thái dữ liệu (Demo, Empty, Long, Edge, Post-action).
3. **So Sánh Ít Nhất 2-3 Hướng Tiếp Cận Khả Thi (Viable Directions with Trade-offs):**
   - Nêu rõ giả định cốt lõi của từng hướng.
   - Phân tích kịch bản tồi tệ nhất (worst plausible case) và điều kiện khiến hướng đó sụp đổ đầu tiên.
4. **Khuyến Nghị Lựa Chọn & Kế Hoạch Triển Khai Cụ Thể.**
5. **Trung Thực Về Rủi Ro & Vùng Tối Chưa Biết (Honesty about Unknowns):**
   - Ranh giới giữa kiểm thử tự động (headless/CDP) và kiểm thử yêu cầu mắt người/auth thật.
   - Rủi ro flaky test, rate limit API, hoặc xung đột session.

---

## 4. Rubric Chấm Điểm Của Verifier (Thang điểm 1-20 mỗi tiêu chí)
- **Criterion 1: Faithfulness to the Request (25%)** — Đề xuất có thực sự giải quyết bài toán "Workflow test full theme mới" có tính kế thừa và nâng tầm từ `theme-qa-az` hay không?
- **Criterion 2: Evidence Grounding (25%)** — Kiến trúc có cắm rễ vào thực tế kỹ thuật theme (Liquid/BWT, DOM storefront, 524 feedback review Sapo, hạn chế CDP/browser) hay chỉ là văn mẫu chung chung?
- **Criterion 3: Sharpness of Acceptance Criteria (25%)** — Tiêu chuẩn nghiệm thu có sắc bén, nhị phân, kiểm chứng được bằng dữ liệu cụ thể, không dùng từ ngữ mập mờ cảm tính không?
- **Criterion 4: Honesty about Unknowns & Failure Modes (25%)** — Có thẳng thắn chỉ ra các điểm nghẽn kỹ thuật, giới hạn tự động hóa, kịch bản thất bại tồi tệ nhất không?
