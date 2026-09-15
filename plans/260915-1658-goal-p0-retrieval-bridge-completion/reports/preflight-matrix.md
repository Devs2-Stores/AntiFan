# Whole-Plan Preflight Matrix

Plan: `plans/260915-1658-goal-p0-retrieval-bridge-completion/`
Đo lúc: 2026-09-15. Phương pháp: chỉ probe **non-mutating**, không tạo/xoá/ghi dữ liệu, không gọi tính phí. Env chỉ ghi **presence**, không in giá trị.

## 0. Chọn gốc chạy: E: thay cho C:

Bản plan đầu tiên được soạn trong một bản copy tạm trên C: (`…\Temp\antifan-head`). Đo lại cho thấy đó **không** phải repo thật.

| | C: `…\Temp\antifan-head` | **E: `E:/Work/apps/AntiFan`** |
|---|---|---|
| Dung lượng trống | **24,0 GB / 278,5 GB (8,6%)** | **127,5 GB / 232,8 GB (55%)** |
| git HEAD | `36fb497` (**tổ tiên** của HEAD thật) | **`43ffb89`** — đúng SHA audit target |
| Branch | — | `main`, cây làm việc sạch (2 file html untracked) |
| `packages/super-core/dist/` | **KHÔNG có** | **đã build** |
| `.super-core/core.db` | **KHÔNG có** | **180 MB** + WAL 174 MB — **đã populate** |
| `claims` | (không có DB) | **20.832** |
| `platformSemantics` | — | **63.654** |
| `principles` | — | **10.275** |

**Kết luận: chạy trên E:.** Lý do không chỉ là dung lượng: hai prerequisite "blocking" biến mất, và revision binding trỏ đúng SHA mục tiêu.

**Kiểm nội dung nguồn**: `packages/super-core/src/index.ts` giữa hai bản **giống hệt sau khi bỏ CRLF** (md5 `52a6a713…` cho cả hai, 814 dòng). Khác biệt duy nhất là line ending (bản tạm CRLF, repo thật LF). Vậy anchor dòng **không** bị ảnh hưởng — nhưng con số thống kê DB thì **có**, vì DB chỉ tồn tại trên E:.

## 1. Runtime (đo trên E:)

| Hạng mục | Giá trị |
|---|---|
| Node / npm | v24.13.0 / 11.6.2 |
| TypeScript | 5.9.3 |
| git HEAD | `43ffb89` (branch `main`) |
| Đĩa E: | 232,8 GB tổng · **127,5 GB trống (55%)** |
| `run-electron.cjs` | present |
| `node-pty` | resolvable |
| Core DB | 180 MB + WAL 174 MB (**WAL chưa checkpoint** — xem mục 2 #6) |

## 2. Phase Matrix

| Phase | Requirement | Check method / evidence | Status | Owner / unblock | Blocking? |
|---|---|---|---|---|---|
| 1 | Node runtime | `node --version` = v24.13.0 | available | — | no |
| 1 | Electron runner | `scripts/run-electron.cjs` present | available | — | no |
| 1 | Keep-awake kế thừa được | `scripts/benchmark-real-soak-8h.cjs:43-61` P/Invoke `SetThreadExecutionState` (`ES_CONTINUOUS\|ES_SYSTEM_REQUIRED\|ES_AWAYMODE_REQUIRED`) | available | — | no |
| 1 | Cờ chống throttle | Chỉ có ở `scripts/test-clone-features.cjs:64`. `src/main/index.ts:167-182` set nhiều switch nhưng **KHÔNG** có `disable-background-timer-throttling` | **pending** | Phase 1 phải set; main app thiếu | **yes (mềm)** |
| 1 | Đĩa cho run dài | E: còn 127,5 GB. DB 180 MB + WAL 174 MB. B20: trang >16384px ghép tile → ảnh lớn | available | Vẫn phải prune; WAL chưa checkpoint | no |
| 1 | `node-pty` ABI khớp Node 24 | `require.resolve('node-pty')` OK | available | — | no |
| 1 | `/goal` executor gốc | Không có trên runtime này | n/a | Runner tự làm checkpoint/watchdog/abort | no (ràng buộc thiết kế) |
| 2 | Nguồn super-core | `index.ts` 814 · `schema.ts` 524 · `core.test.ts` 116 dòng | available | — | no |
| 2 | **`packages/super-core/dist/` đã build** | **CÓ** trên E: (`index.js`, `schema.js`, `.d.ts`, maps) | **available** | ~~`npm --prefix packages/super-core run build`~~ không còn cần | **no — đã gỡ** |
| 2 | **Core DB đã populate** | **CÓ**: 20.832 claims · 184.835 artifacts · 63.654 platformSemantics · 10.275 principles | **available** | ~~`antifan-core.cjs import`~~ không còn cần | **no — đã gỡ** |
| 2 | Ledger để dựng lại DB nếu cần | 19 `.jsonl` + 14 `.json` trong `plans/260914-1248-…/reports` | available | Đường phục hồi: rebuild được, coi DB là suy ra được | no |
| 2 | `tsc` | 5.9.3 | available | — | no |
| 2 | Idiom migration | `MIGRATIONS: Array<{from,to,sql}>` (`schema.ts:410`) | available | — | no |
| 2 | Backup/rollback | `snapshot()` / `rollback()` trong `Core` | available | Dùng trước migration schema v6 | no |
| 3 | `.omp/hooks/` | **KHÔNG tồn tại** | pending | Tạo `.omp/hooks/pre/` (additive) | no |
| 3 | `.omp/config.yml` | Nạp `./.omp/extensions/antifan-fix-guard` | available | — | no |
| 3 | CLI Core làm transport | `scripts/antifan-core.cjs` (92 dòng) phơi `pack`/`query`/`receipt`/`similar` | available | Đường không cần token | no |
| 3 | Hợp đồng event hook | `omp://docs/hooks.md`: `before_agent_start` giữ **message đầu tiên**; `context` là lever mỗi call; `session.compacting` trả `preserveData`; hook phải ở `hooks/pre\|post/` | available | — | no |
| 3 | **`ANTIFAN_BRIDGE_TOKEN`** | **missing** | **pending** | **Quyết định**: transport CLI (không cần token) hoặc user cấp token | **yes (nếu dùng bridge HTTP)** |
| 3 | Ai thắng khi nhiều handler cùng trả message ở `before_agent_start` | Chưa probe | **unknown** | Probe thứ tự nạp trước khi tin bridge | no (phải probe) |
| 4 | Bảng `observations` | `schema.ts:209` | available | — | no |
| 4 | Producer ghi observation | **Không tồn tại** (đây là việc của phase) | pending | — | no |
| 4 | Luật `adjudications.scope` | Có trong schema + `adjudicate()` | available | Không được hạ | no |
| 5 | `IssueRegister` | `src/main/session/issue-register.ts` | available | Mở rộng, không dựng mới | no |
| 5 | Consumer hiện có | `src/main/tools/browser-capabilities.ts:14` · `src/main/verification/circuit-breaker.ts:46` | available | **Sửa lại đường dẫn** — bản plan đầu ghi sai (`main/browser/`, `main/session/`) | no |
| 5 | Markup surface trong renderer | **Hub modal ĐÃ CÓ** ở `toolbar.html:442-559` (`#workflowHubOverlay`, `.hub-nav-strip`, `#hubListPane`, `#hubDetailPane`). Chưa có panel Health/Bridge | available | **Mở rộng Hub**, không dựng overlay thứ hai | no |
| 5 | IPC channel | `antifan:toolbar:*`, `antifan:tab:*`, `antifan:terminal:*`, `antifan:tabs:*` | available | — | no |
| 6 | Gate tồn tại và pass | `node scripts/check-mcp-budget-dominance.mjs` → **21** shadow row · 237 capabilities · ceiling 240000ms > max policy 180000ms (`browser.visual_compare`) · OK | available | — | no |
| 6 | Nguồn schema canonical | `src/shared/control-plane-contracts.ts:618` `inputSchema: Record<string, unknown>` | available | — | no |
| 6 | Gate **có** kiểm schema parity? | **KHÔNG**. Script chỉ kiểm budget dominance, bảng cấm, no-op routing, tên tool tồn tại. Không validate `inputSchema`/type/required | **pending** | Đây là việc mới thật của phase 6 | no |
| 6 | Gate nằm trong `npm run compile` | `package.json` script `compile` có `check-mcp-budget-dominance.mjs` | available | Check quá chặt sẽ chặn mọi build — chốt ngưỡng trước | no |
| 7 | Bottleneck checker | `node scripts/check-bottlenecks.mjs` → 36 row: CLOSED=23 REFUTED_OK=4 **MANUAL=9**; 7 row stale (B19,B20,B21,B23,B29,B30,B32) | available | Chuyển predicate sang kiểm máy | no |
| 7 | Artifact verdict | `.canary/15-pages/_verdicts.json` present | available | — | no |
| 7 | Writer verdict | `scripts/lib/campaign-verdicts.mjs` (`:241`, `:272`) | available | — | no |
| 7 | **Target storefront** | **CÓ** — user chỉ định `E:/Work/apps/AntiFan/Storefront`: theme Haravan 236 file / 5,0 MB, `layout/theme.liquid` + 43 template + `config/{settings.html,settings_data.json,settings_schema.json}`. Link remote: org `1000405253`, theme `1001357480` ("Hrv Glasses") | **available** | Campaign phải được **tham số hoá theo target** — hiện hardcode `hoplongtech.com` ở `fifteen-pages-run.mjs:52+` | no |
| 7 | **Đường render cho theme `Storefront`** | **CÓ SẴN VÀ ĐANG SỐNG** — `https://hangquoctai.myharavan.com/` (store org `1000405253`) đang phục vụ theme `1001357480`. **Chứng minh phân biệt được**: plain `/` byte-identical (`sha256 b95ac59f3fad98`, 283.726 B) với `/?theme_id=1001357480`; **khác** theme anh em `/?theme_id=1001357481` (`8bb8908c…`, 167.277 B). `theme_id` được tôn trọng (5 URL → 4 hash) | **resolved** | Đo ở chế độ **published** thì **không cần push, không cần approve** | no |
| 7 | Theme `Storefront` là theme nào của org? | `1001357480` "Hrv Glasses" (`theme list`). Có anh em **cùng codebase** `1001357481` "Hrv Glasses - Order" | resolved | Vì chung codebase nên **không** dùng marker asset để phân biệt — phải so hash theo `theme_id` | no |
| 7 | `hoplongtech.com` có phải chủ thể của theme? | **KHÔNG** — thuộc **org khác** (Hợp Long). Campaign cũ hardcode `hoplongtech.com` → **đang đo sai chủ thể** | **defect** | **Re-target** `TARGET_PAGES` (`fifteen-pages-run.mjs:52+`) sang `hangquoctai.myharavan.com` | no |
| 7 | Route identity trên target đúng | `/` 283.726 · `/cart` **164.531** ("Giỏ hàng của bạn") · `/collections/all` 280.700 · `/search?q=a` 228.935 — **tất cả khác nhau** | clean | Nghi vấn `/cart` trùng byte là **đặc thù hoplongtech** → B32 là **defect writer** (`campaign-verdicts.mjs:272`), không phải lỗi site | no |
| 7 | Render Liquid **tại máy** | **KHÔNG CÓ** — CLI v1.1.3 không có `serve`/`preview`; `theme dev` **push lên remote** | không tồn tại | Không cần cho chế độ published | no |
| 7 | Push để đo sửa đổi local chưa publish | `theme push-only` / `theme dev` **có** | available | **Cần user phê duyệt** — nhưng đây là **lựa chọn phạm vi**, không chặn phase 7 ở chế độ published | no (gate nếu muốn đo local edits) |
| 7 | Reachability live | `hoplong.com` 200 (654/46ms) · `hoplongtech.com` 200 (642/810/2583ms) | available | Chỉ dùng để đối chiếu, không phải đường chính | no |
| 7 | Nghi vấn route `/cart` | `/` và `/cart` cùng 338.594 byte và **cùng `<title>`** nhưng hash khác; `/brands` và `/tin-tuc` khác hẳn | **unknown** | Điều tra trước khi tin verdict cũ — liên quan trực tiếp B32 (`routeIdentity` null ở 24/45 case) | no (phải điều tra trong phase) |
| 8 | Template acceptance | `plans/260914-1248-…/reports/{acceptance-matrix,goal-acceptance-v2}.md` | available | — | no |
| 8 | Regression chạy được | Cần `npm run compile` | pending | — | no |
| 8 | Revision binding | HEAD `43ffb89` | available | — | no |

## 3. Must provide before long-run (blocking)

| # | Việc | Unblock action | Chặn block nào |
|---|---|---|---|
| 1 | Quyết định transport bridge → có cần `ANTIFAN_BRIDGE_TOKEN` hay không | Mặc định: transport CLI (`scripts/antifan-core.cjs`), **không cần token**. Nếu chọn bridge HTTP thì user cấp token qua env. Không in giá trị | Block 1 (phase 3) |
| 2 | Set cờ chống throttle (main app thiếu) | Phase 1 tự set; không cần user | Block 1 (phase 1) |
| 3 | ~~Đường render cho theme `Storefront`~~ | **ĐÃ GIẢI QUYẾT** — `https://hangquoctai.myharavan.com/` đang phục vụ theme `1001357480`. Đo chế độ **published** không cần push, không cần approve | **không còn chặn** |

**Đã gỡ khỏi danh sách blocking sau khi chuyển sang E:** build `super-core/dist` và populate Core DB — cả hai đã có sẵn.

**Đã gỡ sau khi truy ra org/store:** đường render của theme `Storefront` — có sẵn và đang sống ở `hangquoctai.myharavan.com`.

**Lịch sử đính chính (giữ lại để không lặp lỗi):** tôi đã sai **hai lần liên tiếp** ở đúng chỗ này. Lần 1: trích hai script không hề render `Storefront`. Lần 2: sửa thành "không có đường render" — cũng sai, vì tôi bỏ qua khả năng store của org **đã** phục vụ theme đó. Đáp án đúng nằm ở `haravan whoiam` + `theme list` + một lần probe store.

**Không mục nào đang chặn.** Mục #1 (transport bridge) là quyết định kỹ thuật executor tự chốt được (mặc định CLI). Mục #2 (cờ chống throttle) phase 1 tự set.

**Cổng user duy nhất còn lại — không chặn, chỉ là lựa chọn phạm vi:** nếu muốn đo **sửa đổi local chưa publish** trong `Storefront/` thì phải `theme push-only`/`theme dev` → cần phê duyệt. Đo theme **như đang publish** thì không cần.

## 4. Should decide before long-run (drift risk)

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | Transport bridge: CLI spawn hay thêm route read-only | CLI không cần token, là boundary đã có. Ảnh hưởng prerequisite của phase 3 |
| 2 | Ngưỡng health abort (RSS drift/giờ, heap trần, N verify fail, headroom đĩa) | Bỏ trần thời gian khiến đây là bound **duy nhất** — phải chốt trước |
| 3 | Ngưỡng xếp hạng tổ hợp ở phase 2 | Chốt trước khi đo, nếu không thành tuỳ biến cảm tính |
| 4 | 21 shadow row: derive hay reconcile | Bỏ row là **đổi hành vi** (B29); mỗi dòng cần proof riêng |
| 5 | `core.db-wal` 174 MB chưa checkpoint | Chốt chiến lược WAL/checkpoint trước khi thêm writer |
| 6 | Chính sách cho 2.905 claim untagged | Loại hoàn toàn (mặc định đề xuất) hay backfill platform từ `units.markers` |

## 5. Can be deferred

| # | Việc | Vì sao hoãn được |
|---|---|---|
| 1 | B19 (settle gate đếm childList) | P1 theme-qa; không chặn retrieval/bridge |
| 2 | B20 (cap 16384px, composite tiled) | P2; liên quan đĩa nhưng E: còn 127 GB |
| 3 | B21 (repo root là bãi rác) | P3 hygiene |

## Redaction

- Env chỉ ghi `present`/`missing`. Không giá trị nào bị in hay lưu.
- Không probe tạo/xoá dữ liệu, không gọi tính phí, không đẩy remote.
- Toàn bộ stdout được soi trước khi đưa vào matrix; không có secret xuất hiện.
