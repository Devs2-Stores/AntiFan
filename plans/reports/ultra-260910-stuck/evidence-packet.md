# EVIDENCE PACKET — AntiFan "audit → không closure" (problem-solving `--ultra`)

## 0. Verbatim request
`"--ultra Chốt phương án rồi cook lun nhé"`

Ngữ cảnh cùng phiên: người dùng (Solo Developer Local, app riêng, chạy local, **không bao giờ public**) yêu cầu phân tích sâu các điểm nghẽn. Một báo cáo ultra-scout cùng ngày đã tồn tại (`plans/reports/ultra-260910-bottleneck-scout-final.md`); một lượt phản biện sau đó đã triage và phát hiện lỗi provenance. Người dùng giờ muốn: **chốt phương án rồi triển khai**.

---

## 1. Hai khung diễn giải cạnh tranh (KHÔNG phải kết luận — candidate phải chọn hoặc bác)

- **F1 — "Danh sách điểm nghẽn sai."** Các audit không chính xác/quá đà, nên phương án không đáng tin.
- **F2 — "Danh sách đúng nhưng lặp vô hạn."** Nhiều báo cáo audit tồn tại qua nhiều phiên và cùng một tập phát hiện tái xuất; thất bại nằm ở **closure**, không ở chẩn đoán.

Candidate phải nói rõ bằng chứng nghiêng về khung nào, hoặc đưa ra khung thứ ba.

---

## 2. Ràng buộc đã xác nhận (không được vi phạm khi khuyến nghị)

- Một lập trình viên, một máy, Windows 11 Pro x64, i5-9300H (4C/8T), repo `E:/Work/apps/AntiFan`.
- App Electron + TypeScript, dùng cho theme QA (Haravan/Sapo/Shopify) và điều khiển browser qua MCP/agent.
- **Ranh giới an ninh KHÔNG nằm trong phạm vi gỡ bỏ**: app render nội dung storefront bên thứ ba và mở RPC local (bridge server, terminal/PTY). Sandbox / `webSecurity` / auth / ACL **giữ nguyên**, trừ khi chứng minh được chi phí đo được lên vòng lặp dev.
- Ngoài phạm vi: phân phối public, code signing, auto-update, multi-tenant hardening.

---

## 3. Sự kiện OBSERVED (đã kiểm trực tiếp trong phiên này)

| # | Sự kiện | Nguồn |
|---|---|---|
| O1 | `tsconfig.json` **không** có `incremental`, **không** có `tsBuildInfoFile`; `include` = `src/**/*.ts`, `scripts/**/*.ts`, `test/**/*.ts`; `exclude` = `node_modules`, `.compiled`, `packages`; `strict: true`, `noUncheckedIndexedAccess: true`, `skipLibCheck: true` | đọc `tsconfig.json` |
| O2 | `.gitignore` chứa `.canary/` **và** `*.tsbuildinfo` (ý định bật incremental đã có trong ignore rules nhưng tsconfig chưa bật) | đọc `.gitignore` |
| O3 | `package.json:18` `clean` = `fs.rmSync('.compiled',{recursive:true,force:true})`; `:21` `compile` **bắt đầu bằng** `npm run clean`; `:37` `test` bắt đầu bằng `npm run clean && npm run compile` | đọc `package.json` |
| O4 | **13** script `smoke:*` (`:40-47`, `:50-51`, `:53-55`) và `test:terminal-transport` (`:56`) đều gọi `npm run compile` ⇒ kéo theo `clean` | đọc `package.json` |
| O5 | Không tồn tại script chạy một file test. Glob phủ test: `test:fast` = `.compiled/test/*.test.js` + `test/unit/**` + `test/benchmark/**`; `test:main` = `.compiled/test/main/**`; `test:e2e` = `.compiled/test/e2e/**/*.test.js`. **Không** có glob nào phủ `.compiled/src/**` | đọc `package.json` |
| O6 | `artifact-store.ts:70` constructor gọi `this.rehydrateIndex()`; `:71` `if (options.enableRetentionCleaner)`; khai báo `:48`. grep `enableRetentionCleaner` trên `src` + `scripts` chỉ trả về **chính file đó** (2 hit) ⇒ **không caller nào truyền `true`** | grep + đọc |
| O7 | `bridge-server.ts:245` `this.port = isDev && port === 20129 ? 20130 : port;`; `scripts/antifan-omp-mcp.cjs:80,168` default `20129`; **`scripts/antifan-agent.cjs:463` inject `ANTIFAN_MCP_PORT`, `:473-476` inject `ANTIFAN_MCP_BOOTSTRAP`** | grep |
| O8 | `browser-control-port.ts:2058-2063` quota tab `>= 10` **chỉ khi** `boundTabId` tồn tại (session-bound); `:2074-2079` đóng tab rồi throw khi `adoptChildTab` fail | đọc |
| O9 | `scripts/kill-all.mjs:5` = `execSync('taskkill /F /IM electron.exe')` — diệt **mọi** Electron trên máy | đọc |
| O10 | `.canary/tools/` tồn tại, 45 file, gồm `canary-settle.mjs`. `SETTLE_DOM_EXPR` đếm `addedNodes+removedNodes` qua MutationObserver, đòi `quietFor >= 1500ms` trong ngân sách `9000ms`, reset về 0 mỗi khi có mutation. `SETTLE_VISUAL_EXPR` pause SVG animation và so chữ ký geometry 4000 phần tử | đọc `.canary/tools/canary-settle.mjs` |
| O11 | **`scripts/run-electron.cjs:119-120` (file được track) `await import('../.canary/tools/atomic-record.mjs')` và `process-identity.mjs`** ⇒ file tracked phụ thuộc thư mục gitignored | grep |
| O12 | `test/main/ipc-audit.test.ts:10-12,52,66` đọc `src/main/browser/native-tab-host.ts` dạng text và assert substring (`content.includes('ipcMain.handle(' + channel)`) | đọc |
| O13 | `dev-watcher-helpers.mjs:39-45` `isHotSwappable` chỉ khớp `^scripts/cdp/([^/]+)\.source\.js$`; `:229-235` `isUiHotSwappable` chỉ khớp `^src/renderer/[^/]+\.(css|html|js|ts)$`; `dev.mjs:192-198` dispatcher; `dev.mjs:95-118` relaunch (killTree + delay); `dev.mjs:39-51` dev lock | grep |
| O14 | Trong listing thư mục gốc chạy phiên này chỉ thấy **2** file `.md` ở root (`README.md`, `15-PAGE-HOPLONGTECH-CLONE-CANARY.md`), **không phải 14** | glob `*` (listing có thể bị cắt) |

---

## 4. Sự kiện PRIOR (kế thừa, **CHƯA** tái đo trong phiên này)

Các số dưới đây **không được** dùng làm bằng chứng OBSERVED:

- Thời gian: typecheck 12.9s · compile 18.4s · `test:fast` 10.4s · `test:main` **340s** (128 file).
- Dung lượng: working tree ~4.6 GB · `appdata/` 1,885 MB · `.canary/` 955 MB · `out/` 699 MB · `plans/` 486 MB.
- `E:/Work/.antifan-data/control-plane-v2/artifacts/` = 176 run dir · `.antifan/annotations/` 1,428 file · 57 PNG root (43 MB).
- Trần CDP `16384` px tại `visual-capture.ts:700` + `tab-devtools-host.ts:1515-1519`.
- `computePixelDiff` vòng lặp pixel JS trên main thread tại `browser-control-port.ts:5855-5965`.
- ~25 file test `test/main` dùng `readFileSync` trên source.
- Số test `.cjs`/`test/renderer/**` bị glob bỏ sót.

**Xung đột đã biết:** O14 mâu thuẫn với con số "14 file .md root" ở mục này ⇒ mọi số về "rác root" phải được đo lại trước khi dùng.

---

## 5. Câu hỏi mở (candidate phải trả lời hoặc nêu rõ là chưa giải quyết)

1. Bỏ `clean` khỏi `compile` khiến `tsc` không prune output cũ ⇒ module mồ côi trong `.compiled` có thể bị resolve. Bù trừ thế nào cho đúng?
2. `tsc --watch` có tự hồi phục khi `.compiled` bị xoá từ ngoài trên Windows?
3. 10 điểm nghẽn đã biết có thực sự là 10 vấn đề, hay là 1–2 nguyên nhân gốc?
4. Số lượng báo cáo/plan audit đã tích lũy là bao nhiêu, và tập phát hiện có hội tụ không?
5. Fix nào đóng được nhiều mục nhất với rủi ro thấp nhất, và verify bằng gì?
6. Đâu là ranh giới giữa "đo được" và "chưa đo" cho mỗi khuyến nghị?

---

## 6. Rubric (verifier chấm 1–20 mỗi tiêu chí)

1. **Symptom→technique fit** — kỹ thuật chọn có khớp đúng loại stuck-ness không.
2. **Depth of application** — áp dụng cụ thể vào repo này, không generic.
3. **Actionability** — unblock path có next action cụ thể (file + thay đổi + cách verify) không.
4. **Honesty about residual unknowns** — có phân biệt rõ đo được / chưa đo không.

---

## 7. Hình dạng output bắt buộc

```markdown
# Reframing — Candidate <N>
## Stuck-type Diagnosis        (khớp triệu chứng → kỹ thuật nào, vì sao)
## Khung được chọn             (F1 | F2 | khung thứ ba, kèm bằng chứng)
## Áp dụng kỹ thuật            (cụ thể vào repo)
## Unblock path                (bước 1..N, mỗi bước: file + thay đổi + verify)
## Residual unknowns
```
