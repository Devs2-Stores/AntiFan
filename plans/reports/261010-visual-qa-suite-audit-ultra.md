# Báo cáo test - 2026-10-10 - Audit bộ test Visual QA (`ak:test audit --ultra --advice`)

**Kết quả:** đã quan sát thấy vi phạm hợp đồng. Bộ test hiện chỉ ghim được một phần hợp đồng Visual QA:
engine diệt 16/20 mutant, workflow adjudication diệt 6/17 mutant, chiều false-positive của overflow engine 0/1.
Có 1 lỗ hổng mức Critical, nằm ở workflow (F1: storefront chưa được đo vẫn nhận PASS). Audit chỉ báo cáo: **không sửa file nào trong repo**.

**Thẩm quyền:** quy tắc fail-closed trong `src/main/qa/theme-qa-workflow.ts`:
khoảng trống đo lường thì INCONCLUSIVE, lỗi quan sát được thì FAIL, warning không bao giờ đánh rớt run.
Thêm vào đó là các kind của detector trong `src/main/qa/scanners/layout-integrity-engine.ts`
và kỳ vọng `expect.*` của từng fixture trong `test/fixtures/visual-qa/fixtures.cjs`.

| Hợp đồng | Check / lệnh | Kết quả quan sát | Gap / việc cần làm |
|---|---|---|---|
| Detector của engine bắt đúng kind trên corpus | 20 mutant engine qua `test/e2e/visual-qa-fixtures-probe.cjs --scan-file=` | 16/20 bị diệt; M02, M07, M10, M16 sống 50/50 | F4, F5, F6, F9 |
| Workflow fail-closed và quyền ưu tiên của verdict | 17 mutant `theme-qa-workflow.ts` × 11 file test chạm tới workflow (126 test) | 6/17 bị diệt; 11 mutant sống 126/126 | F1, F2, F7, F10 |
| Overflow engine không báo overflow trên trang sạch | Mutant OV1 `hasOverflow: measured` (L154) | Sống cả unit `test/main/layout-overflow-engine.test.ts` lẫn lane 50/50 | F12 |
| Lane harness chỉ đếm hàng có assert là pass | `SUMMARY` của identity | `pass=50` nhưng 18/50 hàng không assert gì (16 `info` + 2 hàng PASS ở desktop) | F3 |

**Nguồn:** HEAD `920dd0f` cộng working tree chưa commit (17 dòng status: 8 file sửa, 9 file mới; đây là bản nâng cấp geometry của Visual QA).
Fingerprint sha256 (16 ký tự), đo sau khi chạy hết mutant. Bản sao trong sandbox trùng byte với repo, và repo không có file probe nào sót lại:

| File | sha256 (16 ký tự) |
|---|---|
| `layout-integrity-engine.ts` | `d6b217572cf7733c` |
| `theme-qa-workflow.ts` | `136703212cc48842` |
| `visual-qa-fixtures-probe.cjs` | `152cde01c5a4073d` |
| `fixtures.cjs` | `ca9d5d4df740260a` |
| `theme-qa-fail-closed-adjudication.test.ts` | `4d2f6b4971d725de` |
| `layout-integrity-engine.test.mjs` | `a62d6dc24f586d0b` |

**Thực thi:**
- Môi trường: Windows 11, Git Bash, Node 24.13, Electron 43.7.9, tsx 4.23, esbuild 0.28.2.
- Lane: `node scripts/run-electron.cjs test/e2e/visual-qa-fixtures-probe.cjs` (`npm run test:visual-qa`), corpus mặc định gồm 25 fixture × 2 viewport (mobile 375×667, desktop 1440×900).
- Mutant workflow chạy trong bản sao sandbox `E:/Work/scratch/visual-qa-probe/wf-sandbox` qua `npx tsx --test`.
- `node_modules` của sandbox là junction, đã gỡ sau khi chạy (`node_modules/electron/dist/electron.exe` của repo vẫn còn, 164 mục).

**Bằng chứng:** `E:/Work/scratch/visual-qa-probe/` (34 MB) gồm:
- `mutants/`, `wf-mutants/`, `ov-mutants/`
- `mut-out/`, `wf-mutants*.json`, `identity-full/results.json`
- `repair-corpus.cjs`, `repair-out/`, `carousel-corpus.cjs`, `ov-out/` (gồm `ov-out/repair-sim.json`)
- `verifier-output.txt`

**Gate bắt buộc:** baseline identity xanh. Engine M00 pass 50/50, workflow W00 126/126, overflow OV0 unit exit 0 + lane 50/50.

**Lỗi quan sát được:** không có trên mã thật. Mọi FAIL bên dưới đều là cố ý, xuất hiện khi chạy mutant hoặc probe sửa chữa.

## Điểm mutation

### Engine (`layout-integrity-engine.ts`, lane harness, corpus mặc định)

| Mutant (dòng nguồn) | Kết quả |
|---|---|
| M02: tắt overlap control-stack (L603) | **SỐNG** 50/50 |
| M07: tắt zero-size (L337) | **SỐNG** 50/50 |
| M10: sticky bị báo thành `occlusion` (L746) | **SỐNG** 50/50 |
| M16: `CAROUSEL_SLIDE` không còn khớp gì (L58) | **SỐNG** 50/50 |
| 16 mutant còn lại (M01, M03-M06, M08, M09, M11-M15, M17-M20) | bị diệt |

### Workflow (`theme-qa-workflow.ts`, 11 file, 126 test)

| Mutant | Kết quả |
|---|---|
| W01, W03, W05, W06, W08, W09 | bị diệt |
| W02: integrity bị bỏ khỏi `hasObservedFailure` (L1273) | **SỐNG** |
| W04: `measured:false` không ghi gap (L863) | **SỐNG** |
| W07: eval throw không ghi gap (L879) | **SỐNG** |
| W10, W11, W12, W13, W15, W16: report / count / differential bỏ integrity | **SỐNG** |
| W14: warning bị nâng thành critical | **SỐNG** |
| W17: nhánh `measured === false` thành `if (false)` (L861) | **SỐNG** |

### Overflow engine

| Mutant | Kết quả |
|---|---|
| OV1 `hasOverflow: measured` | **SỐNG** ở cả unit lẫn lane |

## Findings (kiểm chứng bởi verifier kongming, controller kiểm lại)

| ID | Lớp | Mức | file:line | Bằng chứng | Sửa đề xuất (đã chạy thử, không áp dụng) |
|---|---|---|---|---|---|
| F1 | mutant sống | **Critical** | `theme-qa-workflow.ts:861-879`; `theme-qa-fail-closed-adjudication.test.ts:822-873` | W04, W07, W17 sống 126/126: scan không đo được hoặc eval throw, nhưng workflow vẫn cấp **PASS** | Test: eval trả `{measured:false}` → có gap + `INCONCLUSIVE`; eval throw → có gap + `INCONCLUSIVE`. Probe R1 diệt W04 và W17, R2 diệt W07. |
| F2 | mutant sống | Important *(hạ từ Critical)* | `theme-qa-workflow.ts:1273`; test 10b `:802-820` | W02 sống: có integrity critical kèm gap thì verdict thành `INCONCLUSIVE` thay vì `FAIL`. Kết quả vẫn không phải PASS, nên theo rubric không tính là false PASS. | Test: critical kèm `stats.truncated:true` → `FAIL`. Probe R3 diệt W02. |
| F3 | lừa dối | Important | `test/e2e/visual-qa-fixtures-probe.cjs:125-135,151-152` | 16 hàng desktop gán `info` + 2 hàng desktop `documentOverflow` (01, 23) không assert gì, vẫn đếm vào `pass=50`. Ở 1440px chỉ 9/16 fixture defect có finding đúng kind (thiếu 02, 03, 07, 08, 14, 20, 21) | In `pass/info/fail` riêng, thêm `expect.viewports` cho từng fixture. **Không** assert đồng loạt desktop (7/16 sẽ đỏ). |
| F4 | mutant sống | Important | engine `:603`; `fixtures.cjs` | M02 sống vì detector text-on-text che mất detector control-stack | Fixture 2 icon-button chồng ≥50%, không có text, `kinds:['overlap']`. M02 → `r-icon-controls-stacked` FAIL, identity PASS. |
| F5 | lừa dối | Important | `fixtures.cjs:27` (fixture 11); engine `:746` | M10 sống vì kỳ vọng là `sticky-obstruction\|occlusion` | Siết lại thành `['sticky-obstruction']`. Identity mobile đang phát đúng `c:sticky-obstruction` ×3. Một fixture riêng `r-sticky-pinned` cũng diệt M10. |
| F6 | thiếu edge case | Important | engine `:58`; `fixtures.cjs` | M16 sống: corpus không có markup carousel (grep swiper/slick/splide/flickity/glide/owl → 0) | Control peek carousel. M16 → `r-peek-carousel-control` FAIL với `c:offscreen×2, c:clipping×2`, identity PASS. |
| F7 | mutant sống | Important | `theme-qa-workflow.ts:1167,1259,1293,1340`; test 10b | W10-W13, W15, W16 sống: report bỏ integrity khỏi `issues`, `criticalCount`, `totalIssues`, `layoutIntegrity`, `visualAmbiguities`, `responsive` | Assert integrity critical có mặt ở mọi trường của report (R5), warning nằm trong `visualAmbiguities` (R4). R4/R5 diệt cả 6. |
| F12 | thiếu edge case (controller tự tìm) | Important | `layout-overflow-engine.ts:154`; `test/main/layout-overflow-engine.test.ts` | OV1 sống: không test nào assert `hasOverflow === false` trên trang **đã đo và sạch**. Ở production, mọi storefront đều bị FAIL giả: lỗi ồn ào, lộ ngay ở lần chạy thật, không bị giấu, nên giữ mức Important. | Control (trừ 24) assert `overflow.hasOverflow === false`. Mô phỏng trên các hàng lane đã ghi: identity 0 fail, OV1 12 fail (`ov-out/repair-sim.json`). Fixture 24 có overflow ngang thật 40px nên cần cờ cho phép tường minh. `[INFERENCE]`: chưa sửa harness thật. |
| F8 | lừa dối | Minor | `visual-qa-fixtures-probe.cjs:130-131` | Control chỉ check `crit !== 0`, warning trên trang sạch không bị kiểm | `warn !== 0 && !allowWarning` → FAIL. Identity hiện có 0 control mang warning nên xanh. `[INFERENCE]`: chưa có mutant nào chứng minh check này diệt được. |
| F9 | mutant sống | Minor | engine `:337` | M07 sống: không fixture nào kỳ vọng `zero-size` | Fixture link 0×0, `kinds:['zero-size'], allowWarning:true`. M07 → `r-zero-size-link` FAIL. |
| F10 | thiếu edge case | Minor | `theme-qa-workflow.ts:882`; test `:877-885` | W14 sống: suite không có run nào chỉ toàn warning | Probe R4: chỉ có warning → `checklist.layout === true`, `PASS`. Diệt W14. |
| F11 | vệ sinh | Minor | `visual-qa-fixtures-probe.cjs:10,22,86`; `layout-integrity-engine.test.mjs:25` | `mkdtempSync` không `rmSync`. Đo trong `%TEMP%` hôm nay: `antifan-visual-qa-userdata-` 79 dir / 136,5 MB (~1,7 MB/run), `antifan-visual-qa-*` 126 dir / 328 MB, `antifan-integrity-test-` 16 dir / 0,6 MB | Dọn userData + bundleDir trong `finally`. Giữ `outDir` khi in `out=`. |

Kết quả probe sửa chữa:
- Workflow: test throwaway `zz-probe-repairs.test.ts` gồm R0-R5. Identity 6/6. Cả 11 mutant workflow sống sót đều bị diệt.
- Engine: `repair-corpus.cjs` gồm 4 fixture. Identity 8/8 hàng không FAIL. Cả M02, M07, M10, M16 đều bị diệt.

## Đã loại (DROP)

| Cụm | Lý do |
|---|---|
| D8 | Sticky dưới màn hình đầu (U1) là giới hạn đã biết của engine, không phải lỗi suite. |
| D9 | Hằng `BREAKPOINTS` mồ côi đã được phân xử trước đó. Ghi chú: `test/main/layout-overflow-engine.test.ts:7-13` cũng ghim một hằng không ai dùng, nên không bảo vệ gì. |
| D11 | Không có CI là chủ đích: gate chỉ chạy local (`docs/operations.md:144`). |
| F_holdout | `holdout.cjs` / `holdout-2.cjs` không nằm trong lane, script hay doc nào. Có 5 gap engine đã biết (h02, h03, h04, h06, h07): holdout pass 21 / fail 3, holdout-2 pass 22 / fail 2. Nối vào lane chính sẽ làm đỏ. |

## Mức hợp đồng được ghim

| Mặt | Hiện tại | Sau khi có repair đã chạy thử |
|---|---|---|
| Engine detector | 16/20 (80%) | 20/20 |
| Workflow adjudication | 6/17 (35%) | 17/17 |
| Overflow false-positive | 0/1 | 1/1 (mô phỏng) |
| Hàng lane có assert | 32/50 | — |

Chi phí bảo vệ đề xuất:
- 6 unit test, mỗi test vài ms.
- 4 fixture × 2 viewport, khoảng +10 s cho lane `test:visual-qa`. Lane hiện chạy khoảng 60 s. `[INFERENCE]` ước theo 7-14 ms scan và khoảng 1 s mỗi hàng.

## Nhật ký verifier

- Verifier (kongming) gộp 58 finding thô từ 5 auditor độc lập thành 15 cụm: giữ 11, loại 4.
- Phần chữ của verifier ghi "9 KEEP / 3 DROP", mâu thuẫn với chính bảng của nó. Bảng là nguồn có thẩm quyền.
- Controller bổ sung F12. F12 không đến từ fan-out.
- Checkpoint Close (kongming): GO. Hạ F2 xuống Important đã được chấp nhận. Đề xuất nâng F12 lên Critical bị bác, vì rubric dành Critical cho false PASS bị giấu. Mô phỏng F12 trước đó không có artifact, nay đã lưu vào `ov-out/repair-sim.json`.

```
ultra: union=11/15 single_candidate_only=0
```

## Câu hỏi còn mở

1. Có áp dụng các repair không? Audit này chỉ báo cáo.
2. Fixture 24 (body là khung cuộn, đã cuộn ngang sẵn 40px): coi là overflow được phép tường minh, hay đổi fixture cho hết overflow?
3. Holdout corpora: nối vào một lane benchmark không chặn, hay để nguyên?
4. `%TEMP%` đang có khoảng 465 MB residue với các prefix `antifan-visual-qa-*` và `antifan-integrity-test-*`. Phần lớn do chính các lượt mutant của audit này tạo ra, nhưng không chứng minh được toàn bộ là của audit. Có xoá không?
