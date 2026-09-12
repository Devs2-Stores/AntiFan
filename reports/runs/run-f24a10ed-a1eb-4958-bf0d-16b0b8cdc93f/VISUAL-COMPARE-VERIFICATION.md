# BÁO CÁO ĐỐI CHUẨN HIỂN THỊ VISUAL COMPARE STOREFRONT vs REFERENCE

**Mã lần chạy (Run ID):** `run-f24a10ed-a1eb-4958-bf0d-16b0b8cdc93f`
**Thời điểm kiểm định:** 2026-09-12T11:46:19.490Z
**Tổng số ca kiểm thử:** 45 ca (15 trang $\times$ 3 viewports: 1440 / 768 / 390)
**Tiêu chí nghiệm thu:** Sai số hiển thị điểm ảnh (Visual Mismatch) $< 2.0\%$, kích thước DOM khớp hoàn toàn, không blank-vs-blank.
**Nguồn dữ liệu:** Fresh pixel-diff từ Canary Attempt Captures (Archived)
**Chứng nhận chiến dịch:** ⚠️ BÁO CÁO CHẨN ĐOÁN (KHÔNG CẤP FINAL_PASS DO THIẾU CHỨNG THỰC ĐỊNH DANH VÀ BIÊN NHẬN LIVE BROWSER)
**Kết quả tổng hợp:** **17 PASS | 11 FAIL | 17 INCONCLUSIVE** / 45 ca

| STT | Tên Trang | Khung nhìn | Visual Mismatch (%) | Kích thước DOM | Kết luận |
| :---: | :--- | :---: | :---: | :---: | :---: |
| 1 | TRANG CHỦ (page-01-home) | 1440x900 (Desktop) | **2.31%** | Khớp 100% | ❌ FAIL |
| 2 | TRANG CHỦ (page-01-home) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 3 | TRANG CHỦ (page-01-home) | 390x844 (Mobile) | **0.38%** | Khớp 100% | ✅ PASS (< 2%) |
| 4 | DANH MỤC THƯƠNG HIỆU (page-02-brands) | 1440x900 (Desktop) | **0.06%** | Khớp 100% | ✅ PASS (< 2%) |
| 5 | DANH MỤC THƯƠNG HIỆU (page-02-brands) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 6 | DANH MỤC THƯƠNG HIỆU (page-02-brands) | 390x844 (Mobile) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 7 | NHÓM KHÔNG FILTER (page-03-category-cam-bien) | 1440x900 (Desktop) | **0.1%** | Khớp 100% | ✅ PASS (< 2%) |
| 8 | NHÓM KHÔNG FILTER (page-03-category-cam-bien) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 9 | NHÓM KHÔNG FILTER (page-03-category-cam-bien) | 390x844 (Mobile) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 10 | TRANG NHÓM SẢN PHẨM (page-04-category-contactor) | 1440x900 (Desktop) | **0.09%** | Khớp 100% | ✅ PASS (< 2%) |
| 11 | TRANG NHÓM SẢN PHẨM (page-04-category-contactor) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 12 | TRANG NHÓM SẢN PHẨM (page-04-category-contactor) | 390x844 (Mobile) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 13 | NHÓM SẢN PHẨM BRAND (page-05-brands-ecovacs) | 1440x900 (Desktop) | **0.09%** | Khớp 100% | ✅ PASS (< 2%) |
| 14 | NHÓM SẢN PHẨM BRAND (page-05-brands-ecovacs) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 15 | NHÓM SẢN PHẨM BRAND (page-05-brands-ecovacs) | 390x844 (Mobile) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 16 | GIỎ HÀNG (page-06-cart) | 1440x900 (Desktop) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 17 | GIỎ HÀNG (page-06-cart) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 18 | GIỎ HÀNG (page-06-cart) | 390x844 (Mobile) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 19 | CHI TIẾT SẢN PHẨM (page-07-product-detail) | 1440x900 (Desktop) | **14.73%** | Chênh lệch (1440x3592 vs 1440x3197) | ❌ FAIL (Lệch kích thước) |
| 20 | CHI TIẾT SẢN PHẨM (page-07-product-detail) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 21 | CHI TIẾT SẢN PHẨM (page-07-product-detail) | 390x844 (Mobile) | **20.3%** | Chênh lệch (390x4857 vs 390x4229) | ❌ FAIL (Lệch kích thước) |
| 22 | BÁO GIÁ (page-08-bao-gia) | 1440x900 (Desktop) | **0.17%** | Khớp 100% | ✅ PASS (< 2%) |
| 23 | BÁO GIÁ (page-08-bao-gia) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 24 | BÁO GIÁ (page-08-bao-gia) | 390x844 (Mobile) | **0.02%** | Khớp 100% | ✅ PASS (< 2%) |
| 25 | TÀI LIỆU (page-09-tai-lieu) | 1440x900 (Desktop) | **0.8%** | Chênh lệch (1440x2180 vs 1440x2195) | ❌ FAIL (Lệch kích thước) |
| 26 | TÀI LIỆU (page-09-tai-lieu) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 27 | TÀI LIỆU (page-09-tai-lieu) | 390x844 (Mobile) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 28 | TIN TỨC (page-10-tin-tuc) | 1440x900 (Desktop) | **0.08%** | Khớp 100% | ✅ PASS (< 2%) |
| 29 | TIN TỨC (page-10-tin-tuc) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 30 | TIN TỨC (page-10-tin-tuc) | 390x844 (Mobile) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 31 | CHI TIẾT TIN TỨC (page-11-tin-tuc-detail) | 1440x900 (Desktop) | **27.42%** | Chênh lệch (1440x3837 vs 1440x4045) | ❌ FAIL (Lệch kích thước) |
| 32 | CHI TIẾT TIN TỨC (page-11-tin-tuc-detail) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 33 | CHI TIẾT TIN TỨC (page-11-tin-tuc-detail) | 390x844 (Mobile) | **34.36%** | Chênh lệch (390x5739 vs 390x6019) | ❌ FAIL (Lệch kích thước) |
| 34 | GIỚI THIỆU (page-12-gioi-thieu) | 1440x900 (Desktop) | **0.66%** | Khớp 100% | ✅ PASS (< 2%) |
| 35 | GIỚI THIỆU (page-12-gioi-thieu) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 36 | GIỚI THIỆU (page-12-gioi-thieu) | 390x844 (Mobile) | **49.88%** | Khớp 100% | ❌ FAIL |
| 37 | LỊCH SỬ (page-13-lich-su) | 1440x900 (Desktop) | **1.17%** | Khớp 100% | ✅ PASS (< 2%) |
| 38 | LỊCH SỬ (page-13-lich-su) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 39 | LỊCH SỬ (page-13-lich-su) | 390x844 (Mobile) | **64.35%** | Khớp 100% | ❌ FAIL |
| 40 | TUYỂN DỤNG (page-14-tuyen-dung) | 1440x900 (Desktop) | **11.41%** | Khớp 100% | ❌ FAIL |
| 41 | TUYỂN DỤNG (page-14-tuyen-dung) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 42 | TUYỂN DỤNG (page-14-tuyen-dung) | 390x844 (Mobile) | **47.16%** | Khớp 100% | ❌ FAIL |
| 43 | CHI TIẾT TUYỂN DỤNG (page-15-tuyendung-detail) | 1440x900 (Desktop) | **0.01%** | Khớp 100% | ✅ PASS (< 2%) |
| 44 | CHI TIẾT TUYỂN DỤNG (page-15-tuyendung-detail) | 768x1024 (Tablet) | N/A | Không xác định | ❓ INCONCLUSIVE (MISSING_EVIDENCE) |
| 45 | CHI TIẾT TUYỂN DỤNG (page-15-tuyendung-detail) | 390x844 (Mobile) | **31.73%** | Khớp 100% | ❌ FAIL |
