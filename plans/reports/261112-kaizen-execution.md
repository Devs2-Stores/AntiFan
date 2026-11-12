# Kaizen — báo cáo thực thi (12/11/2026)

Nguồn kế hoạch: `plans/reports/261111-scout-ultra-kaizen-upgrade.md` (66 mục). Chuỗi chạy: `ak-problem-solving --ultra` → `ak-fix --ultra` → `ak-code-review --pending --ultra` → `ak-test --audit --ultra` → `ak-ship`. Ứng viên và verifier cùng bậc model (best-of-5 cùng bậc).

## Kết quả

- `main` và `origin/main`: `b3864f6d` → `26a6f35d`, 44 commit, fast-forward. Không có CI workflow trong repo.
- Cây của `main` sau khi land trùng hash cây đã test (`7ba0e811…`).
- Các thay đổi chưa commit của phiên khác (`CHANGELOG.md`, `src/main/index.ts`, xoá `idle-terminal-sleep`) giữ nguyên, không bị stage.
- App live đã restart (Main-only, `scripts/antifan-restart.ps1 -Force` sau khi quit sạch bị từ chối vì `busy`): main `37276` → `14984`. daemon-host giữ nguyên và đã kết nối lại lúc 20:25:53Z.

## Phạm vi

- Sửa thêm sau review muộn (`26a6f35d` → `f29077bc`, đã push):
  - Danh sách quyền `[""]` nay không cho phép tool nào. Có hiệu lực ngay với phiên agent mới.
  - `stageAsync` không còn làm mất số byte của một `stage()` đồng bộ chạy xen vào. Thay đổi này chỉ có hiệu lực từ lần restart Main tiếp theo; build đang chạy chưa có nó.
  - Dọn thư mục tạm của test cache hash proxy giờ chỉ là best-effort, retry tối đa 0,5 giây.
  - Hai test mới đều đỏ trước khi sửa. 111/111 test liên quan xanh; budget gate OK.
- Chủ duyệt áp dụng toàn bộ (12/11):
  - Đã build lại super-core dist; `core.db` đã có `idx_packs_task` và `idx_conflicts_state_platform`.
  - Đã cài 5 hook OMP, `--check` báo IN_SYNC.
  - Bản dependency mới được thay vào bằng runner tách rời (Scheduled Task `AntiFanDepsSwap`, log `E:/Work/scratch/wt-kaizen-logs/deps-swap-2026-11-12T03-42-33-202Z.log`). Runner dừng Main và daemon-host, đổi `node_modules`, compile rồi mở lại app.
  - Kết quả swap: `DONE_SWAP`, daemon-host mới 35624, Electron 43.8.8. Bản `node_modules` cũ đã xoá sau khi app chạy ổn; muốn quay lại thì checkout lockfile `b3864f6d` rồi `npm ci`.
  - Lỗi mới do Electron 43.8.8: canvas bỏ qua font shorthand có khoảng trắng đầu (`" normal 12px …"` → giữ `10px sans-serif`). Atlas WebGL của xterm luôn set chuỗi đó nên chữ terminal bị vẽ sai font. Sửa ở `5e7b27ac`; shim nay nằm ở `src/renderer/canvas-font-shim.js` và chỉ bật khi runtime có lỗi. So pixel bằng Electron thật: 43.8.8 + shim trùng hoàn toàn với 43.7.9. Đã kiểm trên cửa sổ thật sau khi restart Main (38476).
  - Test cố định `test/e2e/terminal-glyph-atlas-font.test.ts` (`f924b992`): chạy xterm + WebGL thật trên Electron của checkout, ghi mọi font atlas đặt cùng font canvas giữ lại. Đỏ khi bỏ shim, xanh khi có shim. Lần nâng Electron/xterm sau sẽ bị test này chặn nếu lỗi quay lại.
- Đo hiệu năng trước/sau (12/11, cùng máy, cùng `node_modules` mới; baseline là worktree `b3864f6d` chỉ vá `z.record` cho zod 4):
  - MCP benchmark cô lập (`benchmark-mcp-electron.cjs`), chạy xen kẽ base/head 2 lần cho nhóm `anti.inspect`, `anti.agent.cursor`, `anti.qa`: tổng trung bình base 5939 ms, head 5931 ms. Không có thay đổi đáng kể; vài tool `anti.inspect.*` chậm hơn 2–6 ms (+20–30 %) nhưng chỉ 2 lần đo, chưa đủ để kết luận.
  - Lần chạy đầy đủ một lượt (base trước, head sau) cho head chậm hơn ở nhiều tool, nhưng bị nhiễu tải máy và lệch Core store (xem dưới), nên không dùng.
  - Core CLI trên hai bản copy của `core.db` thật (211 MB), mỗi lệnh 6 lần xen kẽ, median: `health` 297 → 311 ms, `query` 112 → 111, `pack` 133 → 131, `decay` 96 → 108. K13/K14/K20/K53 không tạo khác biệt đo được ở kích thước store này.
  - Tạo/đóng tab trong lượt chạy đầy đủ: create 54 → 30 ms, close 33 → 22 ms (một lượt, chưa xác nhận lại).
  - Lỗi harness tìm thấy khi đo: proxy mở Core theo đường dẫn repo nếu không có `SUPER_CORE_DB`, nên benchmark chạy từ cây chính đo (và ghi context pack vào) store thật, còn từ worktree thì đo store rỗng. Sửa ở `8d1dcd78`; đã kiểm số pack trong store thật không đổi sau khi chạy lại.
- 49 mục trong phạm vi (P0: 9, P1: 13, P2: 27). Tất cả đã land: K01 K02 K03 K04 K05 K06 K07 K08 K09 K10 K11 K12 K13 K14 K15 K16 K19 K20 K21 K22 K23 K24 K28 K29 K30 K31 K32 K33 K34 K35 K37 K38 K39 K40 K41 K42 K43 K44 K45 K46 K47 K48 K53 (thu gọn) K55 K56 K58 (thu gọn) CO-1 CO-2.
- Ngoài phạm vi, theo quyết định của verifier: K17 K25 K26 K27 K36 K49 K50 K51 K52 K54 K57 K59–K64. Đây là các mục lớn nhiều ngày (Electron 45, TypeScript 7, tách class 15k dòng), các mục sửa vào cấu hình dùng chung có hiệu lực ngay với mọi phiên agent, và các mục chỉ có đề xuất chưa được kiểm chứng.
- Code review: 31 phát hiện, giữ 10 (U1–U10). Đã sửa U1–U5, U7–U9.
  - U6 không sửa: runtime không có registry trả `rootPath: ''` có chủ đích (`capability-catalogue.ts:602`), nên ném lỗi sẽ làm hỏng chế độ đó.
  - U10 không sửa: `audit:deps` là lệnh chạy tay, cần mạng.
- Audit test: 73 phát hiện, giữ 22. Hai mục bắt buộc đã sửa: A1 (Host guard/LAN opt-in) và A2 (cache hash proxy). Cũng đã sửa A9 (route challenge) và test ghi ngay khi trả lời ask (K22). A3–A8, A10–A22 là việc làm tiếp, mức medium/low.

## Kiểm chứng

- Pipeline đầy đủ trên commit cuối:
  - Xanh: `audit`, `plans:check`, `typecheck`, `check:rpc-surface`, `test:site-clone` 485/485, `test:integration` 14/14, `test:main` 4211/4211.
  - `test:fast` 3543/3547 (2 skip).
  - Đỏ: chỉ 4 test đã đỏ sẵn ở `b3864f6d` trong worktree: canary-fifteen-pages, `core available: the pack leads…`, `checkAssetReferences…`, `populated core.db`. Không có đỏ mới.
- E2E 10/10 file xanh. Chạy trên source cuối; sau đó chỉ có file test thay đổi.
- Các test hồi quy của bản sửa review đã được chứng minh đỏ trước khi sửa và xanh sau khi sửa. Hai mutant check (K22, K41) đều bị test bắt.
- Bản dependency mới được chạy trong một `node_modules` riêng:
  - Electron 43.8.8 (Node 24.22.1), MCP SDK 1.32.2, ws 8.22.2, koffi 3.3.7, tldts 7.4.22, zod 4.6.7, `@types/node` 24.
  - `npm audit` giảm từ 18 xuống 5 lỗ hổng (còn lại là moderate trong chuỗi dev `@electron/packager`). `audit:deps` báo 0.
  - `node-pty` và koffi load được dưới Electron 43.8.8.
- Kiểm tra trên app live sau restart:
  - `boot.start`, `terminal-manager-open`, heartbeat; không có `app.exit`/crash/`startup.failed`.
  - MCP `tabs.list` chạy được.
  - Bridge: Host lạ → 421, `/status` loopback → 401, `GET /api/pairing/challenge` → 404.

## Chưa áp dụng vào runtime (cần chủ quyết)

1. Dependency: `package.json`/lock đã lên floor mới, nhưng `node_modules` của app live vẫn là bản cũ (Electron 43.7.9).
   - Cần cold stop (cả daemon-host, mất các terminal), rồi `npm ci`, `npm run compile`, khởi động lại. Xem skill `antifan-electron-upgrade`.
   - Đã có sẵn một bản cài đã kiểm ở `E:/Work/scratch/deps-probe/node_modules`.
2. Hook OMP (K22, K32, K33, K34, K35): source đã land nhưng chưa cài. Cài bằng `node scripts/install-omp-hooks.mjs --install`; phiên đang mở giữ hook cũ đến khi mở lại.
3. Super-core (K13, K14, K20, K37, K38, K53): source đã land nhưng `packages/super-core/dist` chưa build lại. Build bằng `npm run build --prefix packages/super-core`; lần mở `core.db` đầu tiên sẽ tạo thêm 2 index.
4. Proxy MCP (K03 và bản sửa argv): có hiệu lực ngay với phiên agent mới vì proxy chạy trực tiếp từ `scripts/`.
