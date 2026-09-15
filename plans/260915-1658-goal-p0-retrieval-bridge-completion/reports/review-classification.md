# Contract-Preserving Review — phân loại finding

Plan: `plans/260915-1658-goal-p0-retrieval-bridge-completion/`
Phương pháp: **classify-first**, không chạy `ak:plan red-team` apply pipeline. Hai reviewer độc lập chạy song song (`AdversarialReview` = lens đối kháng, `FactCheck` = lens kiểm chứng thực tế); controller phân loại và tự áp mọi sửa đổi.

## Taxonomy áp dụng

| Class | Được sửa plan? | Cần user? |
|---|---|---|
| `mitigation-within-contract` | Có — chỉ implementation | Báo cáo |
| `preflight-required` | Chỉ chú thích | Vào matrix |
| `blocker` | Chú thích; chưa Ready | Cổng readiness |
| `outcome-change-request` | **Không** sửa im lặng | **Có** — Decision required |

## Findings đã phân loại

| # | Finding | Nguồn | Class | Đã áp gì |
|---|---|---|---|---|
| 1 | **False PASS do DB rỗng**: test "Sapo trả 0 claim Haravan" tự động pass trên DB chưa nạp, và migration v6 chạy trên DB rỗng. Kèm `importScout()` (`index.ts:114`) không ghi platform cho conflicts → rebuild sau migration sẽ mất/sai dữ liệu | AdversarialReview (P0, conf 0.98) | `mitigation-within-contract` | Phase 2 thêm **R0**; precondition khẳng định baseline khác rỗng (`haravan >= 13.000`, `claims >= 20.000`); migration **chỉ** trên DB đã populate + `snapshot()` trước; bắt buộc xử lý `importScout` trong cùng thay đổi |
| 2 | **Phép thử một chiều**: assertion phủ định pass cả khi search hỏng hoàn toàn (trả mảng rỗng) → mất recall toàn phần trông giống cách ly thành công | AdversarialReview (P1, conf 0.93) | `mitigation-within-contract` | Phase 2 **R0** bắt buộc **positive control** cho mọi test phủ định; thêm hàng test "suite phải fail khi search trả rỗng" |
| 3 | **Bootstrap deadlock**: runner tự viết watchdog rồi tự dựa vào nó; không có supervisor bên ngoài. Deadlock trước khi watchdog armed → treo máy | AdversarialReview (P1, conf 0.92) | `mitigation-within-contract` | Phase 1 yêu cầu **giám sát ngoài runner** (tiến trình khác, OS-level) + **trần wall-clock riêng cho cửa sổ bootstrap** + test deadlock cố ý phải chứng minh lớp ngoài kill |
| 4 | **Mâu thuẫn `NOT_IMPLEMENTED` vs `PASS == 31`**: áp lực 100% có thể đẩy agent tạo `replayResult` giả cho hạng mục 29 | AdversarialReview (P0, conf 0.95) | `mitigation-within-contract` | plan.md thêm mục **"Ngữ nghĩa của `NOT_IMPLEMENTED` và `BLOCKED`"**: hai verdict này hợp lệ để báo cáo nhưng nghĩa là **goal CHƯA đạt**; chế tạo kết quả = **vi phạm contract → abort**; hạng mục 29 phải **xây engine** hoặc trả `NOT_IMPLEMENTED` + blocker, không có đường thứ ba |
| 5 | **Đảo thứ tự phase**: dựng 5 surface trước khi retire 21 shadow row → UI bind vào `anti.*` alias rồi vỡ ở phase sau | AdversarialReview (P2, conf 0.90) | `mitigation-within-contract` | **Đổi số phase**: MCP reliability thành **5**, Core Health thành **6**; chuỗi dep `1→2→3→4→5→6→7→8`; ghi rõ lý do và cấm đảo lại nếu không có quyết định user |
| 6 | **Dependency storefront ngoài**: B23 cần storefront thật; mạng đổi/timeout → phase 7 `BLOCKED` → 100% không đạt | AdversarialReview (P1, conf 0.88) | `preflight-required` | Phase 7 thêm **R0**: khai báo dependency, `BLOCKED` nêu tên nếu thiếu target, snapshot offline chỉ hợp lệ khi revision-bound **và dán nhãn offline**, retry có ngân sách chốt trước. Vào preflight matrix mục blocking cho block 3 |
| 7 | **`toolbar.html` ĐÃ CÓ hub markup** — plan nói "không có" là **sai** | FactCheck (đã kiểm chứng độc lập bằng grep) | `mitigation-within-contract` | Phase 6 + plan.md sửa: `toolbar.html:442-559` có modal "Workflow & MCP Hub"; **tích hợp vào Hub sẵn có**, không dựng overlay thứ hai; thêm rủi ro xung đột DOM/CSS |
| 8 | **Sai đường dẫn consumer**: plan ghi `src/main/browser/browser-capabilities.ts` và `src/main/session/circuit-breaker.ts` | FactCheck (kiểm chứng độc lập) | `mitigation-within-contract` | Sửa thành `src/main/tools/browser-capabilities.ts:14` và `src/main/verification/circuit-breaker.ts:46` |
| 9 | **"100%" không có mẫu số** — plan không liệt kê 31 hạng mục | Controller (tự soát) | `mitigation-within-contract` | Tạo `reports/ladder-31-items.md`: 31 dòng, mỗi hạng mục có phase sở hữu + trạng thái khởi điểm + điều kiện đếm |
| 10 | **Anchor dòng sai** và **số liệu stale** (224/250/787/812; "1.911/3.322 claim") | Controller (tự soát + FactCheck) | `mitigation-within-contract` | Đo lại trên repo thật: anchor đúng `220/248/251/516/527/529/784/809`; tỉ lệ thật **2.905/20.832 = 13,9%** |

## Disposition

- **`outcome-change-request`: KHÔNG có.** Không finding nào đòi đổi outcome hay scope đã khoá. Contract v6 giữ nguyên.
- **`blocker`: KHÔNG có** cho block 1.
- **`preflight-required`: 1** (finding 6) — đã vào preflight matrix, chặn **block 3**, không chặn block 1.

## Ghi chú về độ tin của hai reviewer

**FactCheck có một thất bại phương pháp đáng ghi lại.** Với các mục 1, 4, 5 của prompt, tôi đã **đưa sẵn con số ước lượng** ("~dòng 224", "~dòng 787", "~dòng 812"), và nó trả về đúng các con số đó với kết luận "ĐÚNG" — trong khi grep trực tiếp trên cả hai bản cho **220/784/809**. Đó là **echo, không phải kiểm chứng**. Ba mục đó bị loại khỏi bằng chứng; kết luận về *bản chất* defect vẫn đứng vì controller tự grep (Tier-1).

Bài học áp dụng cho lần sau: **không đưa con số dòng vào prompt fact-check** — chỉ đưa khẳng định, để reviewer tự tìm số.

Ngược lại, hai finding **mới** của FactCheck (hub markup, đường dẫn consumer) đều đã được controller kiểm chứng độc lập bằng grep và đều **đúng**. AdversarialReview cũng đưa ra bốn finding độc lập có giá trị thật, trong đó hai finding P0 về false-PASS là đóng góp lớn nhất của vòng review này.
