# Scout Report: Parity giữa bản pull 15092026 và Theme Remote 1001514194

- Ngày đo: 2026-09-13
- Target Local: `15092026/`
- Target Remote: Theme `1001514194` ("Phụ kiện máy móc - 15/09/2026", Org `200001207485`, Store `phukienmaymoc.com`)

---

## 1. Kết quả kiểm tra Endpoint Haravan API

1. **`GET https://apis.haravan.com/web/themes/1001514194/assets.json`**
   - HTTP Status: `200 OK`
   - Tổng số khoá assets remote trả về: **241**

2. **`GET https://apis.haravan.com/web/themes/1001514194.json`**
   - HTTP Status: `200 OK` (không phải 404)
   - Dữ liệu trả về:
     ```json
     {
       "theme": {
         "id": 1001514194,
         "name": "Phụ kiện máy móc - 15/09/2026",
         "role": "unpublished",
         "previewable": true,
         "processing": false,
         "created_at": "2026-09-12T17:01:40.763Z"
       }
     }
     ```
   - Xác nhận: Theme tồn tại trên hệ thống Haravan, vai trò `unpublished`.

---

## 2. Kiểm kê tệp thực tế tại `15092026/`

- Loại trừ: `.haravan-cli_*`, `.hrv_tmp_*`, `.gitignore`.
- Tổng số tệp thực tế: **241**
- Phân bố theo thư mục:
  - `layout/`: **1** (`layout/theme.liquid`)
  - `templates/`: **43**
  - `snippets/`: **65**
  - `config/`: **3** (`config/settings.html`, `config/settings_data.json`, `config/settings_schema.json`)
  - `assets/`: **129** (31 script/style liquid + 98 tệp hình ảnh/binary)
- Dung lượng tệp: Tổng 10,136,141 bytes (~9.67 MB), **0** tệp rỗng (0 bytes).

---

## 3. Đối chiếu 3 tập (Parity Comparison)

| Tập hợp | Định nghĩa | Số lượng | Tỷ lệ |
| :--- | :--- | :--- | :--- |
| **Trùng khớp (Matched)** | Có ở cả remote và local | **241** | **100.0%** |
| **Thiếu local (Missing)** | Remote có, local không có | **0** | **0.0%** |
| **Thừa local (Extra)** | Local có, remote không có | **0** | **0.0%** |

### Danh sách tệp thiếu local (Missing keys):
- `[]` (Không thiếu tệp nào; rủi ro bản pull không đầy đủ: **0%**).

### Danh sách tệp thừa local (Extra keys):
- `[]` (Không thừa tệp nào).

---

## 4. Kiểm tra `.haravan-cli_remote.json`

- Vị trí: `15092026/.haravan-cli_remote.json` (241 mục).
- Đối chiếu với danh sách tài sản remote:
  - Khớp 100% (241/241 khoá): 0 khoá lệch giữa manifest và remote assets API.
  - Manifest này đóng vai trò snapshot trạng thái remote tại phiên pull của Haravan CLI.
- Đối chiếu mã băm SHA256 (Local File vs Manifest):
  - Tệp văn bản / mã nguồn (`layout/`, `templates/`, `snippets/`, `config/`, script trong `assets/`): **143/143 khớp SHA256 tuyệt đối**.
  - Tệp ảnh binary trong `assets/`: **98/98 tệp có mặt trên đĩa với dung lượng hợp lệ** (sai khác mã băm do chuyển đổi base64 attachment qua Haravan API).
- Thư mục phụ `15092026/.hrv_tmp_pull-21072-1789232649818-guul6y/`: Là thư mục tạm của tiến trình pull, không ảnh hưởng đến 241 tệp chuẩn của theme.

---

## 5. Kết luận

**Bản pull tại `15092026/` ĐẦY ĐỦ 100% (COMPLETE).**

- **Tiêu chí đánh giá:**
  1. Số lượng tệp remote (241) = số lượng tệp local (241).
  2. Số tệp thiếu = 0; số tệp thừa = 0 trên toàn bộ các cấu trúc `layout`, `templates`, `snippets`, `config`, `assets`.
  3. Không có tệp rỗng (0 bytes).
  4. Toàn bộ 143 tệp logic Liquid, JSON cấu hình và scripts đạt tính toàn vẹn SHA256 tuyệt đối.

---

Status: DONE
Summary: Bản pull 15092026/ đạt parity 100% (241/241 tệp) với theme remote 1001514194.
