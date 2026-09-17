# AntiFan Browser Desktop — Báo cáo tổng hợp 7 điểm nghiên cứu + 4 defect mới

- Ngày: 2026-09-18 (giờ VN), phiên làm việc bắt đầu 2026-09-17
- Phạm vi: read-only. Trong toàn bộ quá trình điều tra **không file nào bị sửa**, không cookie/token nào bị đọc giá trị, không app nào bị restart.
- Quy ước mức bằng chứng: **[T1]** = đo live trong phiên này · **[T2]** = đọc từ đĩa/HEAD · **[INFERENCE]** = suy luận, chưa chứng minh.
- Kế hoạch gate-calibration (S1–S5) vẫn đang **TẠM GIỮ** theo yêu cầu; báo cáo này không khôi phục nó, chỉ ghi chỗ trùng lặp ở §7.4.

---

## 1. Kết luận điều hành

Nếu chỉ đọc một mục: **AntiFan không yếu vì thiếu năng lực, mà vì ba cơ chế chặn sai chỗ (định danh target, quyền ghi bằng chứng, và transport)**. Đo trên 2 phiên thật (71,5 MB, 18.828 record, 6.536 tool call): **605 lỗi = 9,3%**, trong đó nhóm lỗi chiếm nhiều nhất **không phải** lỗi tính năng mà là lỗi *định danh target* và *transport*.

Năm việc có tỉ lệ ăn tiền cao nhất, theo thứ tự:

1. **`anti.browser.tabs.list` nói dối ở nhánh mặc định.** Mô tả tool hứa tab đang bound được đánh dấu `isBoundTab: true`, nhưng nhánh `all:true` (mặc định) trả strip thô **không có field đó**; chỉ nhánh `all:false` mới có. **[T1] đã chứng minh cả hai nhánh.** Trong khi đó mọi capability khác **từ chối cứng** mọi `tabId` khác tab bound, và bị enforce **3 lần** trên cùng một call. Đây là gốc cơ học của **91 TARGET_MISMATCH + 21 TARGET_STALE**, và của đúng triệu chứng anh gặp: *agent liên tục mất tab, phải tự dán tab ID*.
2. **Lease 10 s bóp nghẹt policy 30 s và cả capture 60 s.** `anti.agent.sequence` mở `viewportGate.withLock` **không truyền `timeoutMs`** → mặc định 10 s, trong khi policy của chính nó là 30 s và một bước bên trong có thể là capture với trần CDP 60 s. Việc này **vi phạm bất biến mà repo tự tuyên bố** ở `src/shared/deadline-chain.ts:15-17` và được `assertDeadlineChain` (`:120-127`) thi hành. Bước `wait` còn bị kẹp đúng 10000 ms, nên `[wait 10000, click]` **chết chắc**.
3. **Register bằng chứng chỉ đọc từ RAM, nạp một lần lúc khởi tạo.** `anti.verification.list` trả `totalCount: 0` **[T1] hai lần** trong khi đĩa có **1.000 record hợp lệ** (1.831.100 B). Đã loại trừ hết giả thuyết đường dẫn/khoá (§4.4). Nghĩa là **agent không nhìn thấy phán quyết cũ**, còn panel và agent bất đồng vĩnh viễn.
4. **Đường capture không bao giờ freeze, và một lần timeout lại bị dán nhãn sai thành lỗi "không có surface".** Full-page **không hề gọi** `acquireMediaFreeze` (hàm chỉ có **một** call site, ở đường viewport). Tệ hơn, `browser-control-port.ts:1933-1940` kiểm tra `err.code` trong khi drain-guard ném `Error` thường chỉ mang token **trong message** → một drain bị **báo nhầm thành `NO_RENDER_SURFACE`**, làm hỏng cả histogram mà anh đang đọc.
5. **MCP surface thiếu đúng những tool cần để phục hồi.** `browser.wait` (primitive ổn định định danh duy nhất, đã đăng ký, lane `event-wait`, 30 s) **vắng** khỏi `scripts/antifan-omp-mcp.cjs`; toàn bộ `terminal.*` cũng vắng. Nên agent không có cách chờ target ổn định, và **không có mặt tiền nào cho terminal** — trùng khớp với phàn nàn "main terminal vs split terminal không nối nhau".

---

## 🔴 1.b CẢNH BÁO BẢO MẬT — CREDENTIAL SỐNG NẰM PLAINTEXT TRÊN ĐĨA

Đây là việc **khẩn** và **độc lập với mọi thứ khác** trong báo cáo:

- Trong `C:\Users\Admin\.omp\agent\sessions\--E--Work-apps-F1GENZ_Review--\2026-09-17T03-29-59-591Z_01a0ad69-fd27-74f1-9490-753534569350.jsonl`, **dòng 2555** chứa **`access_token` và `refresh_token` Haravan CÒN SỐNG, dạng plaintext**, cho `orgid 200001195350`. Thêm nữa, material dạng `client_secret` xuất hiện trong output `bash` quanh **dòng 1442/1454**.
- Subagent điều tra **không sao chép giá trị nào** — nó chỉ báo vị trí. Nên tôi cũng không trích ở đây.
- **Đề xuất (theo thứ tự):** (1) **rotate** credential cho **orgid 200001195350** và **orgid 200001195767**; (2) **scrub** dòng 2555 (và 1442/1454) khỏi transcript; (3) xem lại vì sao output `bash`/tool có thể rơi token vào transcript — đây là rủi ro **cấu trúc** của việc log toàn bộ tool output, không phải sự cố một lần.
- **Tôi không tự sửa transcript này**: nó là file phiên của anh, việc scrub/xoá là thao tác phá huỷ dữ liệu, cần anh cho phép. Nếu anh muốn, tôi có thể chỉ ra chính xác dòng và phạm vi cần xoá, hoặc viết một script scrub có kiểm chứng.

Sự cố này **không** do AntiFan gây ra (nó xảy ra ở tầng agent/harness ghi log), nhưng nó là **mức ưu tiên cao nhất** trong toàn bộ báo cáo vì hậu quả là chiếm tài khoản.

---

## 2. Defect theo tần suất đo được

Nguồn: 2 phiên OMP thật (quét chuỗi toàn bộ record) + ledger `control-plane-v2/invocations` + báo cáo kế toán MCP nội bộ. Hai phép đếm khác phương pháp nên chênh nhau; cả hai đều ghi rõ.

| Hạng | Defect | Bằng chứng tần suất | Mức |
|---|---|---|---|
| 1 | Định danh target: `tabs.list` không nêu tab bound + từ chối cứng tab khác | TARGET_MISMATCH **91** (+119 trên riêng `browser.evaluate` theo sổ kế toán), TARGET_STALE 21, TARGET_BUSY_DRAINING 34 | P0 |
| 2 | Capture: không freeze + dán nhãn sai drain→NO_RENDER_SURFACE | CAPTURE_TIMEOUT 91 · EXECUTION_TIMEOUT 107 · NO_RENDER_SURFACE 85 (+111 riêng `browser.evaluate`) · CAPTURE_NOT_READY 14 | P0 |
| 3 | `theme.qa_validate` — cổng app tự bắt buộc — lỗi **45,7%** (32/70) bằng đúng lỗi capture mà nó tồn tại để phát hiện | footer "QA GATE PENDING" còn bị gắn vào cả kết quả read/write/edit không liên quan | P0 |
| 4 | MCP surface không phải tool hạng nhất: mọi call đi qua `write` với `xd://mcp__antifan_*`, args là chuỗi JSON | **49** lỗi parse args (19 `Expected '}'`, 18 `Unterminated string`, 4 `Invalid escape`), **25** lỗi `No such tool` (tiền tố `mcp__mcp__` nhân đôi) | P0 |
| 5 | Lease 10 s bóp policy 30 s / capture 60 s | LEASE_EXPIRED 9, tất cả đúng dạng này; `[wait 10000, click]` chết tất định | P0 |
| 6 | `CAPABILITY_ERROR: [object Object]` + rò rỉ lỗi interpreter | 14 lần `[object Object]`; lỗi JS thô (`borderTopLeftRadius is not defined`, `missing ) after argument list`) trả về như lỗi tool | P1 |
| 7 | `anti.verification.list` = 0 so với 1.000 record | T1, tái lập 2 lần | P1 |
| 8 | Quota tab chặn oan dù đã đóng hết tab | 2 cổng trong `browser-control-port.ts:2992-2993` và `:3007-3013`; message sai ngữ nghĩa; không surface nào liệt kê tab session đang giữ | P1 |
| 9 | Terminal không scroll lên được | alt-screen là inherent; AntiFan: hydration replay `1049`, auto-scroll pin, thiếu transcript view | P1 |
| 10 | Bridge master-token vẫn tới RPC trực tiếp có side-effect, vòng qua CapabilityCatalogue | 4 báo cáo độc lập, P0, chưa đóng | P0 (kiến trúc) |
| 11 | Cookie: 41 namespace chết do migration 2026-09-05 | 12.890 cookie (marker tự khai) · 41 jar **3.649.536 B** đóng băng 11 giây ngày 05-09 | P1 |
| 12 | Haravan CLI: AntiFan **chưa từng** spawn `hrv`; uploader là no-op giả lập | 0 exec site; `haravan-uploader.ts:583-598` trả `success:false, predicted:true` | P1 |
| 13 | Split terminal: 3 khoảng trống M1/M2/M3 | split bytes tới nơi (transport không hỏng) nhưng projection/base-only + không resolver nào chấp nhận split | P1 |
| 14 | Core Health: 11 defect D1–D11 + 3 việc ghi store cần approval | panel không bao giờ HEALTHY; 108 candidate PENDING; regression chưa replay | P2 |

---

## 3. Bảy điểm theo yêu cầu

### 3.1 — Hooks OMP gắn chặt AntiFan

Cơ chế đã xác minh: hook là **module TS in-process** (`HookFactory = (pi: HookAPI) => void`, `types.ts:599`), nạp bằng `import()` + `module.default` (`loader.ts:151-154,166`), auto-discovery `~/.omp/agent/hooks/{pre,post}` (`builtin.ts:676,687`), hoặc `--hook=<file>` (có trong `omp --help`, omp/18.2.3). **25 event** đăng ký được (không phải 24 — verifier bắt được 1 overload nhiều dòng `session_before_compact`). `tool_call` **chặn được thật** (`tool-wrapper.ts:57-59`), `tool_result` **viết lại được content** (`:98`).

Bốn điều chỉnh quan trọng so với giả định ban đầu:
- **HookAPI *có* đường tới MCP**: `pi.pi.discoverMCPServers` (`types.ts:592 pi: typeof PiCodingAgent` + `index.ts:40 export * from "./sdk"` + `sdk.ts:831`). Khẳng định "chỉ có `pi.exec`" là **sai**.
- **⚠️ TỰ SỬA SAI NGHIÊM TRỌNG CỦA CHÍNH BÁO CÁO NÀY.** Bản đầu tôi viết *"chỉ có MỘT hook tồn tại"* và *"`hooks/pre/` rỗng 0 file"*. **Sai** — tôi đã khái quát hoá từ **user scope** sang toàn bộ. Kiểm chứng lại trực tiếp **[T2]**:
  - **Project scope CÓ hook thật và nó ĐANG CHẠY:** `E:\Work\apps\AntiFan\.omp\hooks\pre\antifan-core-bridge.ts` — **820 dòng**, bind `pi.on("session_start")` (`:656`), `before_agent_start` (`:669`), `session.compacting` (`:779`), `tool_call` (`:800`). Nó spawn `antifan-core pack` qua `runCoreCli` (`:694-699`) với **dedupe theo task hash** (`:674-681`: cùng prompt thì tái dùng pack, **không spawn lại**) — tức **đúng mẫu "tần số thấp, không spawn mỗi event"** mà tôi định khuyến nghị xây mới. Bằng chứng nó chạy: `.canary/core-bridge/events.jsonl` có row `BRIDGE_CONTEXT_SEEDED` với packId thật tới `2026-09-17T06:05:46Z`; `.canary/hook-probe/default-hook.jsonl` là log quyết định `tool_call` live.
  - **Project scope còn có một extension guard:** `.omp/extensions/antifan-fix-guard/` (gồm `hooks/pre/tool-guard.ts`), được đăng ký ở `.omp/config.yml:4-5` (`extensions: ["./.omp/extensions/antifan-fix-guard"]`).
  - Phát biểu **đúng** phải là: **user scope** (`C:\Users\Admin\.omp\agent\hooks\`) có **đúng một** hook post (`theme-qa-gate.ts`, 378 dòng, dùng `node:fs` chứ không `exec`/MCP) và `hooks/pre/` của **user scope** rỗng; **project scope** thì có bridge + guard ở trên. `config.yml` không có key `hooks` ở **user scope** — cũng đúng.
  - **Hệ quả cho khuyến nghị:** việc cần làm **không phải** "xây hook mới ở `session_start`" (đã có, và có dedupe tử tế) mà là **mở rộng chính `antifan-core-bridge.ts`** — thêm `agent_end`/`turn_end`/`session_shutdown` nếu muốn đóng vòng, và inject thêm trạng thái `core.health` reasonCode + `knowledge_gaps` vào pack đã seed. Khoảng trống thật sự còn lại chỉ là **không hook nào bind `agent_end`/`turn_end`/`session_shutdown`**.
- Nó **không phải** security boundary: chỉ chặn write-tool khi path khớp `THEME_PATH_RE` **và** nằm trong workspace có `.antifan/`; enforcement là nhắc nhở/rewrite content, có TTL 10 phút và **token bypass** trong assistant message. Nên mô tả đúng là "advisory có răng".
- Bẫy thật: `session_stop` và `goal_updated` **có trong union** nhưng **không có overload trên `HookAPI.on`**; emitter chỉ hỏi extension runner (`agent-session.ts:3401`). Vì Bun bỏ type không check, `pi.on("session_stop", h)` **đăng ký im lặng và không bao giờ cháy**. **Xác nhận độc lập bởi candidate 3** từ source đã cài (17.3.4): union ở `types.ts:399-405` vs danh sách overload `:483-512` ⇒ **25 overload `on()`** (khớp "25, không phải 24"). Lưu ý: runtime đang chạy là `omp/18.2.3` nên con số từ source 17.3.4 **không** có thẩm quyền — muốn chắc thì dùng hook ghi log sự kiện.
- **⚠️ GIỚI HẠN PHẠM VI QUAN TRỌNG: hook `tool_call` KHÔNG THỂ sửa lớp 41 lỗi transport.** `ToolCallEvent.input` là `Record<string, unknown>` (`types.ts:313`) — tức **sau khi đã parse**. Lỗi 41 xảy ra **trước khi** bất kỳ event nào tồn tại (nó ở tầng `write`-content của OMP). Nên đừng thiết kế hook để "vá" nó; chỉ `tools.xdev:false` (§4.3) chạm được.
- **Defect thật trong chính hook duy nhất đó** (verifier tự đọc, không lấy từ packet): `latestReceiptTime()` (`:144-165`) chấp nhận **bất kỳ** file `.json` mới hơn trong `.antifan/qa-receipts/`, và `reconcileReceipts()` (`:168-172`) xoá pending edit khi `latestReceiptTime(root) >= editTs` → **receipt của một trang KHÁC xoá được cổng**. Thêm nữa `pendingEdits` là **bộ nhớ in-process** (`:169`) → **restart agent là bypass cổng im lặng**. Fix đúng: receipt phải **nêu tên (các) file nó chứng nhận**, và cổng không được phụ thuộc trạng thái chỉ sống trong RAM. *Probe*: ghi 1 file theme với một receipt **mới hơn nhưng của file khác** → cổng vẫn chặn và lý do phải trích `createdAt` + đường dẫn file bị sửa.

**Hướng đúng:** hook không phải chỗ để thêm "AI cho AntiFan" (kiến trúc cấm daemon AI). Chỗ dùng đúng là **cưỡng chế quy trình ở tần số thấp**: `session_start`/`before_agent_start` để nạp trạng thái evidence hiện có, `tool_result` để chèn acceptance probe, và **tuyệt đối không spawn mỗi event** — `CLAUDE-PARITY.md:11` ghi spawn-per-event đã **timeout 30 s và bị gỡ**. Hook nên đọc/ghi file local (như hook hiện có) thay vì gọi MCP.

### 3.2 — Cookie "mất rất nhanh": chẩn đoán đã hiệu chỉnh

Verifier đối kháng **CONFIRMED** nguyên nhân namespace, kèm 3 hiệu chỉnh và **bác bỏ** một nửa tiêu đề gốc:

- **SỬA SỐ LIỆU (candidate 5 đo lại, tôi ghi nhận):** namespace chết là **84**, không phải 41 — `Partitions` có **85 thư mục**: 1 live `profile-profile-2` (được ghi `2026-09-18T00:12:38`) + **43 `capsule-capsule-*`** + **41 `profile-capsule-*`**, và **cả hai họ chết đều đóng băng ở `2026-09-05T19:37:17`**. Báo cáo này và candidate 1/4 trước đó đều nói 41.
- **ĐƯỜNG MẤT COOKIE IM LẶNG ĐÃ ĐỊNH VỊ ĐƯỢC (đây mới là defect item-2 sửa được, không phải "cookie mất"):** `isValidCapsulePartition` chấp nhận **mọi** `persist:capsule-*` (`native-tab-host.ts:3370`) và resolver trả thẳng `session.fromPartition` (`:1285-1288`), trong khi `getSharedProfilePartition` (`:3398-3411`) **sanitise `profileId` rồi mới prefix `profile-`**. Nên `profileId:'capsule-<uuid>'` cho ra `persist:profile-capsule-<uuid>` — **đúng cái namespace chết**. Hydration **"thành công"**, không tab nào đọc nó. Phải guard **cả hai** đầu (validator + resolver). Đây là cơ chế cụ thể hơn phần "partition không được persist" tôi viết trước đó.
- **Đã chứng minh**: migration 2026-09-05 ghi vào `persist:profile-capsule-<uuid>`, tất cả mtime rơi vào **một cửa sổ 11 giây** `19:27:34–19:27:45` và **đóng băng từ đó**; jar sống `profile-profile-2` được ghi **trong phiên này**.
- **Loại trừ**: không có code nào tự xoá cookie. Chỉ **một** `clearStorageData` trong `src/main` (`:3180`), origin-scoped, fail-closed, chỉ do người/agent gọi. Bridge **từ chối** xoá (`bridge-server.ts:1362-1370` `REMOVALS_UNSUPPORTED`).
- **Bị bác bỏ**: "flush chỉ xảy ra khi tắt app graceful" là **sai** — `native-tab-host.ts:3685` flush ở **mỗi `did-finish-load`**. Phần còn đứng vững là `app.exit(0)` bỏ qua `before-quit` (`index.ts:91-92`, `:229`, `:633`, và **`app-menu.ts:81/113` sau `app.relaunch()` chỉ gọi `persistSync()`, không `flushAllSessions`**).
- **Kiểm chứng live quyết định [T1]**: tab Haravan admin **đang đăng nhập** — dashboard load, `hasPasswordField:false`, `hasLoginForm:false`, không redirect SSO, 14 cookie hiển thị. **Vậy cookie KHÔNG mất chung.**

**Kết luận hiệu chỉnh:** triệu chứng "mất rất nhanh" **không** phải mất jar. Ảnh anh gửi là form login tại `accounts.haravan.com` trong một luồng OAuth install cho app bên thứ ba (`redirect_uri=api-haravan-reviews.f1genz.dev/api/oauth/install/grandservice`). Đăng nhập `*.myharavan.com` **không** tạo session trên miền khác `accounts.haravan.com` — nên mỗi lần authorize/install buộc login lại, và cảm giác là "cookie bay liên tục". Cộng thêm một lần mất **thật** ngày 05-09 do migration. [INFERENCE] ở phần SSO: tôi chưa đọc được jar `accounts.haravan.com` (HttpOnly) và chưa đo chính sách session phía Haravan.

### 3.3 — Haravan CLI gắn chặt AntiFan

- **AntiFan chưa từng spawn `hrv`**: 0 exec site trên toàn `src/` + `scripts/`; `package.json` không có dependency haravan/shopify.
- **Uploader là no-op giả lập [T2]**: `haravan-uploader.ts:571-572,583-586,598` — không gửi request nào, chỉ ghi **URL dự kiến** vào clipboard và trả `{success:false, predicted:true}`. **Không được nói AntiFan upload được file.**
- **Nhưng phụ thuộc artifact của hrv thì rất sâu**: `working-tree.mjs:34` `.hrv-sync-state.json`, `binding.mjs:20` `.haravan-cli_local.json`, `create-haravan-page-fixtures.mjs:5` đọc `C:/Users/Admin/.haravan-cli.json`, `.gitignore:37-39`. Mô tả đúng: **không spawn, nhưng sống nhờ state file của hrv**.
- **Cơ chế coupling sâu nhất đã có sẵn**: `haravan-sync-barrier.ts` — chỉ đánh dấu synced khi watcher phát ack **sau** `baselineSeq` **trong cùng `sessionGeneration`**, fail-closed (`DURABILITY_FAILED` `:170-173`, `WATCHER_SLEEPING` `:217`), và **bắt buộc** (`theme-mutation-session.ts:176-181` ném nếu thiếu). Rủi ro thật: ack là **regex trên text terminal** (`DEFAULT_SYNC_PATTERN :102`) → mọi dòng chứa "Uploaded:"/"Synced:"/"Pushed:"/"Finished:" sau baseline đều thoả. Đó là **chứng thực văn bản, không phải biên nhận transport** — có đường false-positive trên terminal ồn.
- **Thiếu để "gắn chặt"**: (a) chưa có launch `hrv`; (b) chưa bắt URL preview từ PTY; (c) chưa nhận diện **lệnh** trong terminal ("user gõ `hrv theme dev` → bind watcher → lấy themeid → arm QA"); (d) chưa có tool `anti.haravan.*`; (e) upload thật; (f) map CDN lưu lại.
- **Đặc tả detector đã đủ chính xác [T2]**: dòng PTY là `   Preview:    ${base}?themeid=${themeId}` (`Haravan CLI/src/commands/theme/theme-dev.ts:70`), và luật chỉ nhận `themeid` **dạng số** đã tồn tại (`dod-validator.ts:auditHaravanPreview`). Detector phải strip ANSI trước khi match.
- Adjacent, ngoài phạm vi (cần approval vì là app khác): trong CLI đang ship, `-n/--nodelete` là **no-op**, và bulk-delete confirm của `hrv theme dev` **luôn trả false**, nên batch 1–2 file xoá đi chỉ còn allowlist 19 extension làm cổng. AntiFan **không được giả định** hrv tự bảo vệ key cấu trúc.

### 3.4 — Main terminal vs Split terminal

**Transport KHÔNG hỏng** — byte của split tới Main và tới renderer. Ba khoảng trống thật:

- **M1 (triệu chứng nhìn thấy)**: tab strip dựng từ danh sách **base-only** (`terminal-manager.ts:1879` lọc `!s.splitOf`; wrap đánh khoá theo base id ở `standalone.js:3285`, list ở `:3871`). Activity **có** được tính cho split (`standalone.js:4050`) nhưng khi trình bày thì tra theo id thô và **return im lặng** (`:3216-3217`). Nên `hrv theme dev` stream nhiều phút mà tab chính **không sáng**.
- **M2 (thiếu nguồn dữ liệu)**: `SessionSummary` không có `splitCwd`, không có `state`/`exitCode` cho split; cwd của split cố định lúc tạo; không có kênh cwd từ shell (OSC 7/1337 chỉ xuất hiện như bộ **strip** phía renderer); không trích command/pid/port/URL ở đâu cả.
- **M3 (authority)**: **mọi** resolver từ chối split (`terminal-manager.ts:2240`; `native-tab-host.ts:5870-5871` ghi thẳng *"Split panes are not claimable targets"*, `:6642`, `:6661-6662`, `:6688-6692`), nên QA/Haravan cursor rơi vào shell **không** chạy dev server → `DURABILITY_FAILED`.
- **Với agent bên ngoài, hai mặt tiền này không nối nhau về mặt cấu trúc**: browser dùng attachment tuple, terminal dùng `terminalId@generation` + `sessionTabPools`; hai registry **không bao giờ hỏi nhau**.
- **⚠️ ĐÂY LÀ GAP QUẢNG CÁO, KHÔNG PHẢI GAP TỪ CHỐI — và nó là TIỀN ĐỀ CỨNG của item 4/8/9 (candidate 5 bắt được, packet bỏ sót):** `registerTerminalCapabilities` wire vô điều kiện (`control-plane-runtime.ts:215`), nhưng **`scripts/antifan-omp-mcp.cjs` có ZERO dòng `terminal.`**, và `reports/antifan-mcp-capability-map.json` = 52 tool, `termNames=0`. Lý do nó **lọt qua `npm run compile` im lặng**: `check-mcp-budget-dominance.mjs:259-268` **chỉ** thi hành luật completeness cho **`core.*`**. Hệ quả cứng: **sửa mỗi projection của split-pane thì agent KHÔNG thấy gì thay đổi**, vì agent không gọi được tool terminal nào. Nên **quảng cáo `terminal.*` (có gate `accounting:mcp-dispatch`) là bước RIÊNG và phải đi TRƯỚC** item 4/8/9.
- **Tin tốt cho fix item 4**: `splitOf` **đã tồn tại** trong `TerminalSessionDiagnostics` (`terminal-manager.ts:435`) nhưng **thiếu** trong `SessionSummary` (`:399-421`). Nên đây là fix **projection**, không phải thêm nguồn dữ liệu mới.
- **⚠️ Bẫy của fix item 4 (candidate 1 bắt được):** `listSessions` **chỉ giữ split ĐẦU TIÊN cho mỗi parent** (`terminal-manager.ts:1881-1886`: `if (!splitByParent.has(s.splitOf))`). Nên **split thứ hai vốn đã vô hình theo cấu trúc** — fix projection **không được thừa hưởng im lặng** giới hạn đó, nếu không thì "sửa xong vẫn thiếu".
- **Đo rẻ nhất để tách nguyên nhân**: khi `hrv theme dev` đang chạy, đọc `dumpTerminalDiagnostics()` và xem dòng `split-N` có `lastSeq` tăng không. Tăng ⇒ transport sạch, lỗi nằm ở M1/M3.
- **ĐÃ CHỐT (anh xác nhận kèm ảnh chụp):** split là **terminal ĐỘC LẬP**, không phải view của base. Ảnh cho thấy pane dưới nhãn *"❯ Terminal (Split)"* chứa **Windows PowerShell** với prompt riêng `PS E:\Work\apps\F1genz_review>`, tách hẳn khỏi pane trên. ⇒ **Cả M1, M2, M3 đều trong phạm vi**, và hệ quả quan trọng: vì đây là shell thứ hai thật, `hrv theme dev` chạy ở đây **phải được đặt tên như một session riêng** thì QA cursor mới trỏ tới đúng shell — nếu không sẽ mãi rơi vào shell không chạy dev server → `DURABILITY_FAILED`.

### 3.5 — `Page.captureScreenshot` vẫn lỗi

Ba đường, có trần rõ ràng; **nguyên nhân xếp hạng**:

1. **ĐÃ CHỨNG MINH — compositor không bao giờ settle.** Đường viewport **có** freeze nhưng là race best-effort **4.000 ms**: hết hạn thì **đi tiếp** (`browser-control-port.ts:2129-2131`) hoặc trả null (`:2121-2124`), chỉ `console.warn`. Đường **full-page không hề freeze** — `acquireMediaFreeze` chỉ có **một** call site trong toàn cây. `DEFAULT_STABILITY_POLICY.requireMediaFreeze: true` (`stability-policy.ts:22`) **không có consumer runtime nào** — chỉ một unit test đọc nó. Đó là **policy chết**.

   **⚠️ TỰ BÁC BỎ MỘT PHẦN + SỬA SAI FILE (đã tự grep kiểm chứng lại):** hai candidate nói chuỗi này phát ra từ `tab-devtools-host.ts:2211`. **Sai file.** Grep của tôi xác nhận nó ở **`browser-control-port.ts:2211`** — `const message = \`${original} | CAPTURE_TIMEOUT: capture did not settle: ${observedClause}${locationClause}. Remedy: anti.media.freeze(tabId) then retry.\`` — với census `CAPTURE_TIMEOUT_PROBE_EXPRESSION` ở **`:1124-1151`**, số đếm ở **`:2198`**, `diagnosis.remedy` ở **`:2226`**, và call site duy nhất của `captureFailureWithDiagnosis` là **`:2270`** — tức **đường VIEWPORT, nơi freeze ĐÃ chạy rồi** (freeze ở `:2255`). Census **bỏ qua** `playState==='paused'`.

   **ĐÃ GIẢI ĐƯỢC UNKNOWN #2 TỪ CẤU TRÚC CODE (không cần probe live) — và nó chứng minh message lỗi có thể NÓI DỐI:** tôi grep `injected-script-store.ts` và xác nhận freeze chỉ chạm **đúng ba thứ** — `el.pause()` (`:104`), SVG `pauseAnimations()` (`:109/:114`), và một rule CSS `*, *::before, *::after { animation-play-state: paused !important; }` (`:192`). File đó **KHÔNG hề có `getAnimations`** và **không hề gọi `Animation.pause()`**. Nghĩa là: **freeze KHÔNG THỂ dừng animation WAAPI/JS.** Một animation vô hạn vẫn `running` **sau khi** `animation-play-state: paused` đã áp **không phải** CSS animation — nó là WAAPI. Vậy lời khuyên *"Remedy: anti.media.freeze(tabId) then retry"* **là bất khả thi** cho đúng lớp lỗi mà nó xuất hiện, và code **có thể tự biết** (chỉ cần đọc `animation.constructor.name`) nhưng không đọc.
   **Fix đúng vì vậy phải làm CẢ HAI NỬA trong cùng một thay đổi:** (a) phân loại animation theo `constructor.name` trong census `:1124-1151` để receipt chứng minh được cái gì đã bị freeze; (b) **pause WAAPI** trong chính freeze (`injected-script-store.ts:185-196`); (c) **rồi mới** thêm freeze vào `screenshotFullPage` (`:2315` → `captureFullPageEnvelope` `:2342`) với kỷ luật `finally` như `:2272-2284`. Thứ tự (a)→(b)→(c) quan trọng: census trước, call site full-page sau.
   **Làm cả hai nửa khiến unknown #2 hết chặn** — không còn phải chọn "thêm freeze" hay "mask preview bar" dựa trên một cuộc đặt cược.
   **Test quyết định (chạy trên đúng trang storefront có `#haravan-notification`):**
   `document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming?.().iterations===Infinity).map(a=>({ctor:a.constructor.name, cls:String(a.effect?.target?.className||'')}))`
   → `CSSAnimation` = freeze hỏng, thêm freeze là đúng. → `Animation` = **WAAPI**, message lỗi nói dối, phải pause bằng JS.
   **Thứ tự đúng vì vậy phải là: chạy probe TRƯỚC, rồi mới sửa.** Không được thêm freeze theo đức tin.
   **⚠️ Hệ quả lên chính substrate kiểm chứng (candidate 1 bắt được, quan trọng):** freeze **đổi pixel** của artifact. Một PNG full-page chụp **sau** fix **không còn so byte được** với PNG chụp **trước** fix — mà cả nền tảng AntiFan dựa trên so sánh ổn định. Nên freeze phải được coi là **một phần của capture contract**: **bump policy identity của capture receipt**, và **tuyệt đối không** so sánh baseline xuyên qua ranh giới đó. Nếu không, mọi `visual.compare` cũ sẽ báo khác biệt giả.
   **Kèm một discriminator rẻ để biết "sửa dán nhãn" có thật sự chạm đúng lỗi không** (verifier đề xuất, rất đáng làm): tái tạo **một** `NO_RENDER_SURFACE` live rồi đọc xem message của nó chứa *"the render surface could not be measured"* (`browser-control-port.ts:1938`) hay *"reports no laid-out surface"* (`:1950`). **Chỉ dạng thứ nhất là bug dán nhãn**; dạng thứ hai là thiếu surface **thật**. Nếu không tách hai dạng này thì không được tuyên bố đã xoá lớp 85.
2. **ĐÃ CHỨNG MINH (khuếch đại) — một timeout làm nhiễm cả tab lẫn cặp tool.** Sau timeout, target bị đăng ký draining (`tab-devtools-host.ts:744-750`) → chặn mọi lệnh sau tới 5.000 ms (`:678-684`) và quarantine tới khi có receipt. Và **drain bị báo nhầm**: `browser-control-port.ts:1933-1940` soi `err.code`, còn guard ở `tab-devtools-host.ts:683` ném `Error` thường mang token **trong message** → ra `NO_RENDER_SURFACE`. Đây là cách **một** timeout thành cơn bão 85 + 34 mà anh đọc thấy.
   **Tin tốt — fix này AN TOÀN (đã kiểm):** matcher duy nhất đang tồn tại, `isTargetDrainFailure` (`browser-control-port.ts:1062-1068`), **đã chấp nhận cả `code` LẪN message**. Nên việc gắn `.code` ở throw site **không** phá consumer nào, và file đã có sẵn mẫu gắn code ở `:1045-1056`. Gắn code ở throw site sửa **mọi** consumer `.code`, không chỉ chỗ này.
3. **CHỨNG MINH ĐƯỢC (thiết kế)** — thiếu surface là **từ chối cứng**: hidden/minimised/detached/offscreen đều bị chặn; không có đường full-page offscreen hoạt động. Có chủ ý: comment `:2093-2099` ghi rõ một view không được window present sẽ làm `Page.captureScreenshot` treo hết trần **và** đầu độc CDP queue.
4. **CHƯA CHỨNG MINH** — bỏ rơi do budget ngoài (`deadline-chain.ts:35-38` nêu một giá trị 30.000 ms phía client).

**Điểm quan trọng về lịch sử fix**: các vòng trước đều là việc ở **biên/refusal/quarantine**; **chưa vòng nào đóng hai điều kiện mà chính code gọi tên** — không có surface được present, và compositor không settle. `CAPTURE_EMPTY_PAYLOAD` trong ledger = **0**, nên lịch sử fix *có* hiệu quả trên trục của nó; nó chỉ không chạm trục gây lỗi.
`RESOURCE_FAILURE` trên ảnh vỡ **không phải** lỗi screenshot: nó ở `capture-settle.ts:216-223` qua `browser-control-port.ts:4863` trong `settleCapture`, chỉ gọi từ theme QA và compare — và **hard-fail**, trong khi cổng quiescence canonical coi ảnh vỡ là **warning**. Hai cổng settle ngược chính sách nhau.

**Thứ tự fix ĐÃ CHẤM (verifier bác bỏ thứ tự cũ của tôi):** (1) **census đặt tên class + rẽ nhánh remedy** (bước E(a)) — trước tiên, vì receipt phải chứng minh được cái gì đã bị freeze; (2) **pause WAAPI trong freeze** (E(b)); (3) **rồi mới** thêm freeze vào full-page (E(c)); (4) **chỉ sau (1)+(2) mới** cho `requireMediaFreeze` thành gate; (5) chỉ khi đó mới bàn tới tăng trần.
**🚨 HAI KHUYẾN NGHỊ TRƯỚC ĐÓ CỦA TÔI VÀ CỦA 2 CANDIDATE LÀ SAI VÀ CÓ HẠI — verifier bác bỏ:**
- **"Biến `requireMediaFreeze` thành gate thật" KHÔNG phải cải thiện — nó có thể PHÁ capture đang chạy được.** `StabilityPolicyEvaluator` **chỉ** xuất hiện trong `stability-policy.ts` (0 consumer production), và `:91-98` trả `ready:false/MEDIA_ACTIVE` khi chưa freeze. Nối nó thành gate cứng **trên một cơ chế không có khả năng thoả nó** (vì freeze không dừng được WAAPI) sẽ biến các capture **đang thành công** thành lỗi `MEDIA_ACTIVE` vĩnh viễn. Nên: **gate chỉ được bật SAU khi WAAPI pause hoạt động**, không phải trước.
- **"Thêm freeze vào full-page sẽ sửa được" cũng sai tiền đề:** call site freeze **duy nhất** nằm ở đường VIEWPORT nơi freeze **ĐÃ chạy**, mà 16 lỗi settle **vẫn sinh ra** → **thiếu freeze KHÔNG thể giải thích** chúng. A là **tập con của E** và nằm ở phía sai của một dữ kiện đã chốt.
**Ghi chú làm E(a) nhẹ hơn tưởng tượng:** census **đã** tính `infiniteAnimations` và **đã** bỏ qua paused/idle (`:1146`), nên (a) chỉ là **đặt tên class** (`constructor.name`) + **rẽ nhánh remedy** ở `:2226`. Và **bộ phân loại WAAPI-vô-hạn để copy ĐÃ CÓ trong repo** ở `browser-control-port.ts:339-352`.

### 3.6 — Session hôm nay nói gì

Định lượng (2 phiên, 71,5 MB, 18.828 record, 6.536 tool execution): **605 lỗi = 9,3%**. Tỉ lệ lỗi theo tool AntiFan (đếm trong tool_result):

| Tool | Chạy | Lỗi | % |
|---|---|---|---|
| `anti.screenshot.full_page` | 14 | 11 | **78,6%** |
| `anti.screenshot.viewport` | 80 | 62 | **77,5%** |
| `anti.reference_capture` | 12 | 8 | 66,7% |
| `anti.theme.qa_validate` | 70 | 32 | **45,7%** |
| `anti.theme.export_clean` | 18 | 8 | 44,4% |
| `anti.visual.compare` | 32 | 8 | 25,0% |
| `anti.media.freeze` | 53 | 11 | 20,8% |
| `anti.inspect.snapshot` | 37 | 6 | 16,2% |
| `anti.browser.evaluate` | 880 | 121 | 13,8% |
| `anti.inspect.dom` | 98 | 11 | 11,2% |

**Tier 0 — đọc hết 84 tin nhắn người dùng** (53 + 35, trừ trùng). Điều đáng chú ý nhất: **không một tin nào phàn nàn về tốc độ** — nên **không** được gán nỗi đau hiệu năng cho anh. Nỗi đau thật, theo lời anh:
- Capture: *"Vẫn lỗi Page.captureScreenshoot Là có fix chưa?"*, *"Full page chạy được chưa?"*, *"tôi thấy Ful page hình như vẫn ko hoạt động"*.
- **QA báo xanh trong khi trang vỡ, hai lần, kèm bực**: *"Vẫn ko scroll dduioocj, m ko QA à?"* và *"trang bị vỡ, mày ko QA lại à?"*.
- **Cùng một yêu cầu QA phải lặp 4 lần** (*"QA lại toàn bộ action/motion/state/ux/ui của Web nhé"*).
- **Agent dừng giữa việc, anh phải gõ "Tiếp đi" 5–7 lần.**
- **Ma sát bàn giao tab**: *"Tự mở Tab mà QA lại 7d7531fe-…, rất nhiều thông tin bị thiếu"*, *"Mở sẵn tab rồi, tự nhập đi 348ca77d-…"* — anh phải dán tab ID thủ công.
- **4 lần dạy agent về hrv CLI** (*"trong hrv cli có lệnh dùng api đó, check lại đi"*).
- **Không tắt được tiếng riêng từng tab** (*"tắt Tiếng của tab comthienly nhé, tôi đang nghe nhạc"*).
- **Vòng annotation là tài sản được dùng nhiều nhất**: ~25/84 tin nhắn đính kèm `.antifan/annotations/*.md` + `.antifan/snapshots/*_target.png`.
- Chỉ thị meta của chính anh: *"Tạm ngưng, tìm hướng fix các MCP trên cho hoàn thiện vào AntiFan Core đi đã"*.

**Áp lực context là vấn đề cấu trúc, không phải ngẫu nhiên**: 27 + 36 = **63 lần compaction**; phiên 1 đã ở **203.491 token sau 14 phút**; một lần nén 240.792 ký tự; có lần nén cháy **19 giây sau** đúng lượt anh hỏi về captureScreenshot — tức lượt phàn nàn quan trọng bị đẩy vào archive ngay.
**Work loss có thật**: app tự quit sau một case BLOCKED và **mất 16/18 case** của matrix.
**Workaround agent tự nghĩ ra (8)**: bỏ full-page hạ xuống crop header; đổi sang compare viewport; bỏ screenshot, dùng `evaluate` làm bằng chứng; tự dựng probe Electron/CDP ngoài app; thay primitive drain bằng `sleep 12/15/30`; và **gọi vòng rebind/retarget như chiến lược retry** (225 call định danh: set_automation_target 77, tabs_list 65, tabs_create 50, rebind_target 19, tabs_activate 14).

### 3.7 — Core Health: danh sách khắc phục

Live: status `DEGRADED`, reasonCode `GATE_PROMOTION_FAILED`. Gate hỏng: **promotion** (108 candidate PENDING) và **regression** (`replayResult` bị migration 7→8 null hoá). 5 gate còn lại PASS. `coveragePct 20,4` **là by design**, không phải lỗi.

**11 defect (không cần ghi store):**
- **D1** `core.corpus_audit` khai read-only nhưng **INSERT mỗi lần gọi** (`index.ts:950-953`, `recorded = opts.record !== false`).
- **D2** `core.check_phase_gate` y hệt (`index.ts:1047-1051`); CLI tự chặn (`antifan-core.cjs:76-82`) nhưng đường MCP **không** truyền `{record:false}`.
- **D3** `reasonsJson` chứa **số đếm disposition**, không phải histogram lý do (`index.ts:947`) → lý do của **38 artifact bị block** được ghi nhưng **không surface nào in ra được**.
- **D4** không có `core.candidates` → 108 dòng PENDING không có đường đọc.
- **D5** nhánh `REPLAY_ENGINE_NOT_IMPLEMENTED` **không thể tới được** (engine có thật, `index.ts:1210`) — `core-health.ts:731-734,749-754`.
- **D6/D7** cùng một hỏng mang **hai** reasonCode, và reasonCode tổng chỉ nêu gate **đầu tiên** hỏng (`index.ts:1079-1081`) → che mất regression hỏng đồng thời.
- **D8** `connected` (8.876) được tính, **không gate nào dùng, không surface nào hiện**; bằng chứng adjudication có `entryId=null` nên claim được promote **không bao giờ** đếm được.
- **D9** panel **không bao giờ** báo HEALTHY: uncertainty hardcode `UNKNOWN` (`index.ts:1089-1092`) + `worstOf` → hai mặt tiền, hai câu trả lời.
  **⚠️ NHƯNG ĐỪNG SỬA SAI CHỖ (candidate 3 bắt được):** phần **lý luận** ở `index.ts:1089-1092` là **ĐÚNG** — uncertainty ở mức toàn corpus thì thật sự chưa xác định được. Bug **không phải** ở giá trị hardcode, mà ở chỗ `worstOf` (`core-health.ts:181-186`) **xếp `UNKNOWN` (hạng 1) CAO HƠN `HEALTHY` (hạng 0)** và render nó như một *check* → trần của panel là UNKNOWN. Fix đúng: **ngừng render uncertainty như một gate chặn trần** (hoặc cho nó scope hẹp), **không** phải bịa ra uncertainty toàn corpus.
  Thêm một defect nhỏ nhưng thật: **hai mặt tiền đánh vần trạng thái "mọi gate pass" KHÁC NHAU** — `ALL_GATES_PASS` (`index.ts:1081`) vs `ALL_GATES_PASSED` (`core-health.ts:194`). Drift cấp typo giữa hai consumer của cùng một sự thật.
  Và cơ chế che gate: `index.ts:1079-1081` dùng `Object.entries(gates).find(g => !g.passed)` trên đúng thứ tự literal coverage→evidence→conflict→temporal→promotion→regression, nên `GATE_PROMOTION_FAILED` **luôn** che regression hỏng đồng thời.
- **D10** `knowledgeGaps` có và được expose nhưng **không ai tiêu thụ** trong `src/` → tín hiệu to nhất của store (**"AntiFan Desktop" = 0 claim**, **"omp agent harness" = 0 claim**, trong khi generic-liquid 2.191) không tới được check nào.
- **D11** `principles` 10.275 so với 774 unit, **không có bất biến dedupe/anchor** (claim thì có evidence gate, principle thì không).

**Housekeeping (mỗi việc là WRITE bền vững, phải có approval):** H1 adjudicate 108 candidate qua `core.adjudicate` (id chỉ lấy được ngoài băng — đó chính là D4); H2 replay regression mới nhất; H3 cấp bằng chứng thật cho 2 platform 0 claim.

---

## 4. Bốn defect mới phát sinh trong phiên này

### 4.1 — Terminal không scroll lên được (anh báo)

Nguyên nhân chính: **alternate screen buffer**. xterm.js **không giữ scrollback** ở buffer alternate (`baseY === 0`) — không scroll lên được bất kể cấu hình. Cấu hình AntiFan **không sai**: hai pane đã set `scrollback: 10000` (`standalone.js:1827`, `:2388`; mặc định xterm 1000).

Phần **AntiFan tự gây**:
- **Hydration replay nguyên chuỗi byte thô** vào terminal vừa `reset()` (`standalone.js:1558-1561`), và snapshot là byte stream thô tail 1 MiB (`:1508-1511`) → nếu slice bắt đầu trước `ESC[?1049h` và kết thúc trong TUI thì **chính hydration tạo ra** trạng thái zero-scrollback.
- **Auto-scroll pin**: `scrollToBottom()` chạy trong mọi write callback, gate bằng cờ cached (`:1716-1781`, `:2025-2033`) → TUI redraw kéo viewport về đáy nhanh hơn người scroll.
- **Không có affordance đọc transcript** dù server đã giữ sẵn: `MAX_TRANSCRIPT_BYTES = 4 MiB` (`terminal-manager.ts:354`), `getFullBuffer` trả nguyên vẹn (`:1978-1985`), IPC `native-tab-host.ts:1624-1628`. Server **có** track `altScreen` (`:215`, `:1343-1347`) nhưng không đưa vào `SessionSummary`/diagnostics, và renderer grep `1049` = **0 hit**.
- **Test 1 phút**: trong DevTools cửa sổ terminal, `const p=[...window.__antifanTerminalPool.values()].find(i=>i.paneEl?.classList.contains('active')); const b=p.term.buffer.active; ({type:b.type, baseY:b.baseY})` → `type:'alternate'` là chứng minh.
- **Chưa chứng minh cho đúng ảnh anh gửi**: tôi không có byte capture của phiên đó. Không gán bừa.
- **Fix**: (a) strip `1049` khỏi stream replay/hydrate — nhưng **phải đi kèm** (b), vì không emulate alt-screen thì frame của TUI xếp thành scrollback rác; (b) **transcript view dựa trên `getFullBuffer`** (tái dùng `transcriptToPlainText :496-521` + mẫu `<pre>` của `renderSleepPreview :534-575`, bỏ gate sleeping-only ở `:2052`) — phải ghi nhãn "lossy"; (c) đưa `altScreen` vào diagnostics (1 dòng); (d) giảm auto-scroll pin.

### 4.2 — Quota khi Create Tab (anh báo)

Hai cổng trong `browser-control-port.ts`:
- `:2992-2993` — `getManagedTabIds(boundTabId).size >= 10` → `POLICY_DENIED` *"Terminal tab limit reached (maximum 10 tabs per session). Please close unused tabs."*
- `:3007-3013` — `adoptChildTab` trả false → **đóng luôn tab vừa tạo** và báo *"session tab quota reached; the tab was closed instead of leaking outside the session"*.

Ba điều chứng minh được:
- **Giả thuyết "rò rỉ slot" KHÔNG đứng vững**: đường đóng tab prune đầy đủ (`native-tab-host.ts:4508-4527` xoá khỏi **mọi** `sessionTabPools`, `removeManagedTab:6344-6359` xoá cả hai nơi, `tombstoneTerminalAgentAffinity:6518`).
- **Bất đối xứng thật**: hàm dùng cho cổng chặn (`getManagedTabIds:6093-6124`) trả **bản sao thô, không prune**, còn hàm adopt (`:6032-6036`) **có** prune. Hai cổng đếm khác nhau.
- **Message sai ngữ nghĩa + không có đường tự chẩn đoán**: tạo *browser tab* nhưng báo "**Terminal** tab limit"; và **không surface nào liệt kê session đang giữ tab nào**. Nên "đã tắt hết tab" (đúng những gì anh thấy) vẫn có thể có ≥10 tab session-owned mà anh **không thấy** — `offscreen`/`ephemeral` (tuỳ chọn ở `:2999-3000`), và `getTabList` **ẩn** chúng theo thiết kế (`native-tab-host.ts:3208`) trong khi `hasTab` vẫn thấy.
- **ĐÃ XÁC ĐỊNH ĐƯỢC (forensic trên đúng file log anh gửi, 6.880.089 B, 2.670 dòng) — và nó LẬT NGƯỢC giả thuyết "cap trên số tab đang mở" của tôi:**
  Quota này **KHÔNG** đếm tab đang mở. Nó là **quota ADOPTION theo phiên** (per-session tab-adoption): tab mới tạo **thành công**, nhưng bị **từ chối adopt vào session** rồi **bị huỷ**. Đây đúng là cổng 2, **không phải** cổng 1.
  Bốn dẫn chứng quyết định, trích theo số dòng JSONL:
  1. `tabs_list {all:false}` → `[]` (**0 tab thuộc session**) ở dòng 2509 @16:52:25.915Z — tức **12 giây TRƯỚC lần từ chối thứ 2**. Vậy bộ đếm **không** tính từ số tab session đang giữ.
  2. Cửa sổ chỉ có **đúng 2 tab** ở dòng 2493 @16:52:06.991Z — **10 giây trước lần từ chối thứ 1**. Vậy **không phải** cap nhỏ trên tổng số tab mở.
  3. Mỗi lần từ chối mang một **tab id MỚI** (`d33c6142` / `00f77a93` / `78b740a0`) kèm câu *"the tab was closed instead of leaking outside the session"* → **tạo thì được, ADOPT mới là bước bị chặn**.
  4. Session id `533cc1a3-eb28-4408-a361-cb97b5da8100` **trùng byte-for-byte với một tab id từng tồn tại** (từng là `@admin` F1GENZ Thủy Sinh, dòng 905 và 1568) và **vắng mặt** trong danh sách lúc 16:52 → **session sống lâu hơn tab neo của nó** `[INFERENCE]`.
  **Nghi can tiêu slot số 1:** **7 lần `anti.browser.rebind_target` thành công** (dòng 977, 1295, 1304, 1433, 1574, 1649 + 1) cộng 1 lần create = **≥8 lần adopt vào cùng một session trong ngày, và KHÔNG có lần nào giải phóng**. `[INFERENCE]` Nghĩa là **chỉ cần attach vào tab của chính anh cũng tiêu slot**, và bộ đếm **không bao giờ trả lại**.
  **Không hồi phục:** bộ đếm đứng yên suốt **4 phút 23,8 giây** (16:52:16.679Z → 16:56:40.514Z) trong khi cửa sổ co từ **9 tab → 2 tab**. Đó là lý do **đóng tab không giúp gì** — đúng như anh báo.
  **Điều này sửa lại kết luận trước của tôi:** tôi từng nói "rò rỉ slot KHÔNG đứng vững vì đường đóng tab prune đầy đủ". Sai ở chỗ: prune `sessionTabPools` **không phải** cùng một bộ đếm với **bộ đếm adoption theo phiên**. Hai thứ khác nhau; cái bị rò là cái thứ hai.
  **Hướng fix:** (a) **giải phóng slot khi tab đóng/rebind** (và khi session kết thúc) — hoặc không tính `rebind_target` là một adoption; (b) trả **số đã dùng / giới hạn** trong payload lỗi để không còn phải đoán; (c) đọc thẳng site tăng/giảm của chuỗi `"session tab quota reached"` trong source là kiểm tra không-hộp-đen dứt điểm.
  **Phép đo rẻ nhất còn lại:** giữ nguyên cửa sổ 2 tab, chạy **một** `tabs.create` từ một **session attachment HOÀN TOÀN MỚI**. Thành công ⇒ cap là **state dính theo session** (rò/không reset) và fix là release-on-close/reset session; thất bại ⇒ đây là **cap toàn cục**, câu chữ "session" chỉ là mỹ phẩm.
  **Ghi chú phụ quan trọng:** trong log này agent **không hề gọi tool `mcp__antifan_*` trực tiếp** — cả **135** call MCP đều qua `write` với `path:"xd://mcp__antifan_browser_anti_browser_tabs_create"` và `content` là chuỗi JSON. Xác nhận độc lập phát hiện của candidate 4 từ một log khác. Và **0 lần `tabs.close`** được thực thi trong cả file — nên retry 2 và 3 **không hề kiểm tra** được gì về việc giảm đếm.

### 4.3 — MCP surface: không phải tool hạng nhất, và args đi bằng chuỗi

**Phát hiện cấu trúc lớn nhất của item 6**: trên OMP, **mọi** call AntiFan đi qua tool `write` dưới dạng `path:"xd://mcp__antifan_browser_anti_*"` với **JSON args là string content**. Hệ quả đo được: **2.037 call AntiFan bị đội lốt `write`** (write 2.373 call / 343 lỗi = 14,5%), **49 lỗi parse args** (19 `Expected '}'`, 18 `Unterminated string`, 4 `Invalid escape character`), và **25 lỗi `No such tool`** với tiền tố **`mcp__mcp__` bị nhân đôi** (error body còn inline toàn bộ danh sách device đã mount).
**⚠️ Thủ phạm đã được ĐỊNH VỊ (không phải trong repo AntiFan):** `C:\Users\Admin\AppData\Roaming\npm\node_modules\@oh-my-pi\pi-coding-agent\src\tools\xdev.ts:147-160`. OMP **tháo** các tool discoverable khỏi mảng tools của request và expose chúng thành thiết bị ảo `xd://`, thực thi bằng `write xd://<tool>` với **`content` là chuỗi JSON args** (`xdev.ts:1-15`). `parseDeviceArgs` gọi thẳng `JSON.parse(content)` và ném **đúng chuỗi** đã thấy trong session: `` `${XD_URL_PREFIX}${device.name} expects a JSON args object as content (${error.message})` `` → chính là 19× `Expected '}'`, 18× `Unterminated string`, 4× `Invalid escape character`. Biểu thức bị **escape lần thứ hai** qua kênh write-content, nên chỉ JS nhiều ngoặc/quote mới vỡ.
**Hệ quả: KHÔNG vá phần xử lý expression của AntiFan, và KHÔNG thêm cờ base64.** Fix đúng và rẻ: thêm tham số **`expressionFile`** (đường dẫn workspace-relative, loại trừ lẫn nhau với `expression`) để content JSON chỉ còn là một token đường dẫn — đủ nhỏ để `JSON.parse` của OMP không thể vỡ. Xoá 41/41 chữ ký lỗi này. Cần `npm run accounting:mcp-dispatch` (thêm param trên capability sẵn có, **không** thêm tên tool mới).
**⚠️ RÀNG BUỘC TRIỂN KHAI BẮT BUỘC (candidate 1 bắt được, tôi và candidate 4 đều sót):** `required-args.ts:33-48` chỉ hiểu một mảng `required` phẳng, và `mcp-server.ts:719-735` **gate MỌI call** trên đó. Nên nếu chỉ đổi capability mà không đổi gate, `required:['expression']` sẽ **từ chối** call dạng file với lý do *"missing `expression`"* — và fix sẽ **trông như không hoạt động**. Phải sửa `required-args.ts` + `mcp-server.ts:719-735` sang kiểm tra **one-of** (`expression` HOẶC `expressionFile`) **trong CÙNG commit**, kèm test `required-args.test.ts` mới (không xoá/nới case cũ).
Thêm: cùng param này cần áp cho `anti.browser.evaluate_frame` (`browser-capabilities.ts:897-905`) và `anti.inspect.eval` (`:907-915`), nếu không thì đường frame vẫn vỡ.

**🥇 CÒN MỘT FIX RẺ HƠN CẢ FIX TRÊN — và nó nằm NGOÀI repo, một key cấu hình (candidate 3 chứng minh):** `tools.xdev` **mặc định TRUE** (`@oh-my-pi/pi-coding-agent/src/config/settings-schema.ts:4286-4288`) và `~/.omp/agent/settings.json` **không tồn tại** → default đang sống. Chuỗi nhân quả đã đọc: mọi MCP tool không nằm trong `ESSENTIAL_BUILTIN_TOOL_NAMES` bị gán `loadMode:"discoverable"` (`essential-tools.ts:23-35,43-46`) → `isMountableUnderXdev` mount **mọi** tool discoverable (`xdev.ts:81-84`) → AntiFan chỉ còn tới được bằng `write` tới `xd://mcp__antifan_browser_<tool>` (`write.ts:512-545,1154-1175`) → args bị `JSON.parse` nghiêm ngặt và ném ở `xdev.ts:155-159`.
**Quy mô mà packet bỏ sót:** `xd://mcp__antifan` xuất hiện **2.257 lần** chỉ trong phiên Bagamuioto, và **mọi** call AntiFan đều là `toolName:"write"` với `xdev.tier:"write"` — tức **mọi thao tác ĐỌC của AntiFan bị xếp nhầm vào tầng ghi**. Đó là lý do tỉ lệ lỗi của tool `write` bị thổi lên 17,5% và lỗi AntiFan bị chôn bên trong nó.
**Fix:** đặt **`tools.xdev: false`** — **một key, đảo ngược được, không đổi code, không cần `accounting:mcp-dispatch`, không có gate Level-0**. Xoá cả lớp lỗi. *Nghiệm thu*: phiên mới có **0** `xd://mcp__antifan` (hôm nay 2.257) và **0** `expects a JSON args object as content` (hôm nay 41). **Rủi ro đo được, không phải ước lượng:** prompt phải chứa thêm ~52 tool AntiFan + built-ins + figma → **theo dõi số record `compaction`** (hôm nay 63), không ước lượng token.
**🚨 NHƯNG ĐỪNG SHIP NÓ MÙ — verifier nâng mức rủi ro và đây là điều tôi đã bỏ sót:** tiền đề *"tắt xdev sẽ khôi phục một đường `mcp__antifan` native tương đương"* là **CHƯA ĐƯỢC CHỨNG MINH**. Nếu **sai**, nó **cắt đứt toàn bộ control plane** — **2.257 lời gọi AntiFan mỗi phiên** — để đổi lấy **41 lỗi**: **lợi ích có chặn, thiệt hại không chặn**. Thêm nữa nó phụ thuộc unknown chưa giải (OMP có đọc đúng `~/.omp/agent/settings.json` không; có cần restart runtime mà tôi không được phép làm không). **Nên bắt buộc:** (a) **precheck routing trên profile nháp** trước; (b) **revert ngay** nếu call native thất bại; (c) và vì lỗi sinh ra **ngoài** AntiFan nên **không thể nghiệm thu nó trong sản phẩm** — chỉ nghiệm thu được bằng log phiên. Đó là lý do C xếp **bước 4**, không phải bước 1.
Cũng phải nói cho đúng: con số **2.257** là **tần suất**, **không** tự nó là bằng chứng của việc "xếp nhầm tầng ghi" — liên kết nhân quả đó **chưa được kiểm chứng**.
**Số 41 không chỉ là `evaluate` (candidate 3 đếm lại):** Bagamuioto 18 `Expected '}'` + 15 `Unterminated string` + 2 `Unable to parse JSON string` + 4 `Invalid escape character`, nhắm vào 33 `evaluate` + 4 `inspect_styles` + 2 `set_automation_target`. Nên fix `expressionFile` **một mình không đủ** — phải hoặc là `xdev:false`, hoặc áp cho cả 3 capability.

**⚠️ HIỆU CHỈNH PHẠM VI QUAN TRỌNG — đa số `CAPABILITY_ERROR` KHÔNG phải defect của AntiFan:** chúng là **relay ĐÚNG** lỗi JS của chính trang/biểu thức agent viết — verbatim `getEventListeners is not defined`, `borderTopLeftRadius is not defined`, `missing ) after argument list`, `Unexpected token ')'`, `Failed to fetch`, `Evaluation timed out after 15000ms`. Đó là **bug code do agent tự viết**, không phải lỗi AntiFan. **Không được "sửa" chúng trong AntiFan.** Defect thật chỉ là việc **`[object Object]` làm mất thông tin** ở `capability-transport.ts:1086` (+ 5 site anh em `:246,:361,:380,:456,:495`) — tức là **cách relay**, không phải việc relay.
Ngược lại, nửa `[object Object]` **hoàn toàn nằm trong repo** và fix chỉ ~5 dòng: `capability-transport.ts:1086` → `message: typed?.message || (err instanceof Error ? err.message : String(err))`; repo **đã có** mẫu đúng ở `browser-capabilities.ts:209-215` (`safeErrorText`) và `:238`.
Kèm theo: **`CAPABILITY_ERROR: [object Object]` ×14** và **rò rỉ lỗi interpreter** (`borderTopLeftRadius is not defined`, `missing ) after argument list`, `Invalid or unexpected token`) trả về như lỗi tool — agent phải tốn lượt để phân biệt lỗi biểu thức của chính nó với lỗi tool.
Ngoài ra, **transport timeout có outcome không xác định**: `Request timeout after 30000ms next: … the request outcome is unknown` trên `export_clean`, `screenshot.full_page`, `visual.compare` (4 lần), với `retryable: no` — trong khi cách duy nhất chữa được trong thực tế lại là **retry**.

### 4.4 — `anti.verification.list` = 0 so với 1.000 record trên đĩa

**[T1] tái lập 2 lần**: `{"totalCount":0,"verifications":[]}` trong khi `E:\Work\.antifan-data\issues\verification-register.jsonl` = **1.831.100 B, 1.000 record JSON hợp lệ**, mtime `2026-09-17T13:22:53`.
Đã **loại trừ** toàn bộ giả thuyết đường dẫn/khoá:
- Writer **có** set `id` (`issue-register.ts:800-803`), loader yêu cầu `rec.id` (`:337`) → không phải lệch khoá.
- `IssueRegister` đọc `path.join(getDataRoot(), 'issues', 'verification-register.jsonl')` (`:296-302`) = **đúng** file đó.
- `ANTIFAN_DATA_ROOT=E:\Work\.antifan-data` **đã set** trong env (pwsh xác nhận).
- `E:\Work\apps\AntiFan\Work\.antifan-data`, `E:\.antifan-data`, `D:\Work\.antifan-data`, `%APPDATA%\AntiFan\data` — **tất cả không tồn tại**. Trên `E:\Work\.antifan-data` chỉ có **đúng hai** file register.

Cơ chế duy nhất còn đứng vững: **hai instance `IssueRegister` ở hai process, mỗi cái giữ mảng RAM riêng**; `listVerifications` chỉ đọc mảng đó (`:843`), nạp **một lần** lúc khởi tạo (`:329-343`), **không reload theo mtime**. Có **2 mốc electron** đang chạy (12:46 và 23:54). Kết luận kỹ thuật không phụ thuộc process nào: **đọc register qua mảng in-memory là defect**; sửa bằng đọc từ đĩa/reload theo mtime xoá cả lớp lỗi. Discriminator cần restart app — tôi **không tự restart** vì anh đang làm việc.

**🚨 NÂNG MỨC ĐỘ — đây không chỉ là lỗi đọc, mà là vector MẤT DỮ LIỆU SỐNG:** `rewriteVerificationsFile` (`issue-register.ts:945-952`) ghi `this.verifications` **nguyên khối** xuống file (temp + `renameSync`). Nghĩa là một process có mảng RAM **rỗng** có thể **thay thế nguyên tử 1.000 record thật bằng file rỗng**. Vì vậy fix bắt buộc phải làm **cùng lúc với** đường đọc: reconcile với đĩa (merge theo `id`/tail) **trước khi** mọi lần rewrite, và **tuyệt đối không** ghi khối khi mảng chưa được xác nhận là đã nạp từ đĩa. Đây là lý do item này phải lên **đợt 1**, không phải đợt 4.

**Discriminator đã có số liệu (verifier đếm live):** có **6 instance `antifan-agent.cjs mcp` đang sống** trên máy này và **3 trong số đó khởi động TRƯỚC mtime 13:22:53** của register (PID 27828 @12:47:11, 15076 @12:49:15, 26428 @14:10:28, 34192 @14:20:56, 8908 @14:34:32, 3288 @13:37:02; cộng 2 instance lúc 23:11:47 và 23:41:32, và ~10 instance khác). Nên **process trả lời không nhất thiết là process đã ghi file** — đúng như giả thuyết, và giờ đã có bằng chứng process-level.
**Fix fail-closed cho đường ghi (1 unit test, KHÔNG cần ghi live):** `rewriteVerificationsFile` phải **từ chối** khi `this.verifications.length === 0` mà file trên đĩa **không** rỗng, và ném đúng lỗi typed `DURABILITY_FAILED` mà chính method đã dựng sẵn ở `:955-957`. *Nghiệm thu*: mảng RAM rỗng + file không rỗng → rewrite ném lỗi và **kích thước byte của file không đổi**.

**☠️ CẢNH BÁO AN TOÀN — một bài test tưởng rẻ nhưng CÓ THỂ XOÁ 1.000 RECORD.** Một candidate đề xuất phép thử phân biệt writer/reader rất rẻ: *gọi `anti.verification.record_claim` một lần trong cùng session rồi gọi `list`; nếu record mới hiện (count 1) mà 1.000 record cũ không hiện thì writer≠reader đã được xác nhận.* **Bài test này độc hại khi ghép với phát hiện rewrite-wholesale ở trên:** gọi `record_claim` trên process đang giữ mảng rỗng sẽ làm mảng thành `[1 record mới]`; **nếu sau đó có bất kỳ lời gọi nào chạm `rewriteVerificationsFile`, 1.000 record thật bị thay bằng 1.** Nên:
- **KHÔNG chạy bài test đó trước khi** fix fail-closed ở trên landed. Tôi **đã không** chạy nó.
- Thứ tự bắt buộc: **fix fail-closed + đọc-từ-đĩa TRƯỚC**, khi đó phép thử writer/reader mới an toàn và không cần thiết nữa (vì đọc từ đĩa là đúng bất kể process nào trả lời).
- Bài học chung: với store có đường ghi nguyên khối, **mọi phép "thử ghi một cái rồi xem" đều là phép thử phá huỷ**. Phải đọc code đường ghi trước khi thiết kế thí nghiệm.

### 4.5 — Bridge master-token vẫn có đường RPC trực tiếp (từ re-audit 45 finding cũ)

`bridge-server.ts:1896-1909` chỉ gate socket **attachment-bound** (`boundAttachmentId`); socket dùng **master token** rơi thẳng xuống `case 'navigate'` (`:2331-2336`), `tabHost.evalJs` (`:2590`), `agentClick` (`:2676`) — **vòng qua CapabilityCatalogue**. Đây là finding **P0 lặp lại ở 4 báo cáo độc lập** và là mục "chưa đóng" giá trị nhất của re-audit. Chỉ là biên tin cậy local (loopback + bearer file), nhưng artifact "không có kênh side-effect thứ hai" **chưa đạt**. Fix bounded: ép mọi method có side-effect đi qua `antifan.capability.dispatch` kể cả master token, hoặc xoá các case đó.
Kèm: `tab-automation-host.ts:348` inject `AGENT_BROWSER_SCRIPT` bằng `executeJavaScript` (**main world**) trong khi đường semantic đúng dùng isolated world 1004 (`:361`), để lộ `window.__antifanRefMap` (`agent-browser.ts:252-253`) cho trang storefront. Và `codex-execution-backend.ts:114-122` drain stderr **sau** vòng stdout → nguy cơ deadlock backpressure.

---

## 5. Những thứ KHÔNG phải defect (để khỏi sửa nhầm)

- `coveragePct 20,4` — by design (yield claim; coverage gate pass theo disposition completeness).
- "Flush cookie chỉ khi tắt app graceful" — **sai**; flush xảy ra mỗi `did-finish-load`.
- "Jar cookie sống đang rỗng" — **sai**; jar sống 524.288 B, ghi liên tục.
- "Lease 10 s vs capture 60 s là nguyên nhân capture treo" — **không**; đường capture **không** lấy ViewportGate. Nhưng xung đột 10 s vs 30 s/60 s **có thật** ở tầng `anti.agent.sequence`.
- `RESOURCE_FAILURE` ảnh vỡ — không phải lỗi screenshot (chỉ ở `settleCapture`).
- `ANTIFAN_SINGLE_INSTANCE_LOCK` (18) — **không tồn tại trong repo**; 6/6 lần xuất hiện là text do agent tự viết (nó tự khám phá phải set env `ANTIFAN_SINGLE_INSTANCE_LOCK=1` để spawn instance thứ hai). Cơ chế thật: `index.ts:226-243` `requestSingleInstanceLock()` → `app.exit(0)` **im lặng, exit 0** → không phân biệt được với thoát sạch.
- `SURFACE_DEAD` (13) — chỉ có trong harness `scripts/test-clone-features.cjs:254`, không phải mã production.
- `attached:false` **không** có nghĩa là không có surface: live, `anti.browser.get_viewport` trên một tab `attached:false` trả về viewport khoẻ mạnh **2742×1437**. Nên `attached` (nghĩa là "view đang được window present") **không** dùng được làm tiêu chí "tab có render được hay không".
- `anti.verification.list` không phải lỗi khoá/đường dẫn (§4.4 đã loại trừ).
- 34 record INCONCLUSIVE — là lớp `completeness=EMPTY` của STALE barrier, **không** phải theme fail ẩn.
- `Workflow Hub false-positive passed` — **ĐÃ FIX** (`native-tab-host.ts:2185-2229`); phải ngừng báo lại trong mọi audit sau.
- Theme QA fresh-state, stale async publish, `openTab` retarget, workflow retry taxonomy — **đã fix** (xem re-audit).

---

## 6. Chương trình sửa — ĐÃ CHẤM best-of-5 (verifier độc lập)

**PHÁN QUYẾT: bước 1 không phải đề xuất nào trong 5 đề xuất "rẻ nhất", mà là (D) — cứu register trước.** Tiêu chí quyết định: **không thể đảo ngược × là tiền đề**. `listVerifications` **không lọc** khi options undefined (`issue-register.ts:843`), nên `totalCount:0` **CHỨNG MINH** mảng RAM đang rỗng trong khi đĩa có 1.000 record. `:737/:892/:928` đều đổ về `rewriteVerificationsFile` (`:945-958`), ghi nguyên khối qua temp + `renameSync` **không có guard rỗng**. **Súng đã lên đạn: lời gọi `record_claim`/`verify_claim`/`update_verdict` TIẾP THEO sẽ thay nguyên tử 1.000 phán quyết / 1,83 MB bằng file rỗng.** Xác suất ≈ 1. Và **mọi thay đổi khác được nghiệm thu qua chính subsystem này** → D là tiền đề của tất cả, không chỉ là "việc rẻ".

**THỨ TỰ ĐÃ CHẤM (mỗi bước 1 probe nhị phân):**
1. **D — register đọc từ đĩa + guard fail-closed** (`:836-861` đọc đĩa; `:945-958` từ chối khi RAM rỗng MÀ file không rỗng). *Probe*: `list` không lọc trả `>0` **bằng đúng** số record trên đĩa VÀ **độ dài byte của file y hệt trước/sau lời gọi**; guard được chứng minh trên **bản sao fixture trong temp** (KHÔNG BAO GIỜ trên register sống).
2. **`tabs.list` đánh dấu `isBoundTab` trên nhánh MẶC ĐỊNH** — đây là **lớp lỗi đo được LỚN NHẤT mà KHÔNG candidate nào đề xuất**: TARGET_MISMATCH 91 + tối đa TARGET_STALE 21 = **112** > 41 của C. *Probe*: MỘT lời gọi `tabs.list` **không tham số** trả N tab với **đúng MỘT** `isBoundTab:true`, và id đó **bằng** id từ lời gọi `all:false`. (Phát hiện thêm: `:269`/`:1106` dùng default **ngược lại** (session-scoped) → **ba tool list, hai ngữ nghĩa**.)
3. **B — typed `CaptureError('TARGET_BUSY_DRAINING')`** ở `tab-devtools-host.ts:683` + match token ở `:1933-1934`. *Probe*: ép drain → **CODE** trả về là `TARGET_BUSY_DRAINING`, và không bao giờ có message `TARGET_BUSY_DRAINING` đi kèm code `NO_RENDER_SURFACE` (assert **code**, không assert message).
4. **C — `tools.xdev:false` NHƯNG có precheck routing trên profile nháp.** *Probe*: với xdev off, **một** call `mcp__antifan` native phải **thành công** VÀ log phiên có **0** `expects a JSON args object as content`; **revert ngay nếu call native thất bại**.
5. **E(a) — census đặt tên class + rẽ nhánh `diagnosis.remedy`** (`:1124-1151`, `:2226`). *Probe*: trên fixture WAAPI-vô-hạn, diagnosis báo class `Animation` (không phải `CSSAnimation`) và remedy **KHÔNG** chứa "media.freeze".
6. **E(b) — pause WAAPI bên trong freeze**, giới hạn trong cửa sổ capture, nhả bằng `finally` đã có (`:2277-2283`); không bypass `force`. *Probe*: sau freeze, census `infiniteAnimations:0` nhưng object animation **vẫn tồn tại ở trạng thái paused**, và chạy lại sau khi nhả.
7. **E(c) — freeze đường full-page** + chỉ **sau** bước 5 và 6 mới cho `requireMediaFreeze` thành gate. *Probe*: một `anti.screenshot.full_page` trên fixture WAAPI thành công, artifact khác rỗng, telemetry ghi `isMediaFrozen:true` **tại thời điểm raster**.
8. **Hoàn tất hook (đúng khoảng trống thật của item 1):** bind `agent_end`/`turn_end`/`session_shutdown` trong **chính** `.omp/hooks/pre/antifan-core-bridge.ts`. *Probe*: sau một turn hoàn tất, `.canary/core-bridge/events.jsonl` tăng **đúng MỘT** row cho mỗi event mới bind và **0** trùng khi vào lại.

**HOÃN / CHẶN:** cookie SSO + 84 namespace chết — probe duy nhất của nó (một luồng OAuth bên thứ ba hoàn tất mà không hiện card `accounts.haravan.com`) cần **ghi remote sống**, còn dọn namespace là **ghi phá huỷ** store local ⇒ **cần anh phê duyệt rõ ràng**. Và không thêm tên tool MCP nào mà không chạy `npm run accounting:mcp-dispatch`.

---

Nguyên tắc: **ưu tiên thay đổi nhỏ nhất xoá được số lỗi đo được lớn nhất**; không thêm bề mặt MCP mới mà không chạy `npm run accounting:mcp-dispatch`; không nới test/obligation; mọi thao tác ghi vào store bằng chứng phải có approval.

**Đợt 0 — sửa chẩn đoán trước (rẻ, không đổi hành vi)**
1. `tabs.list` nhánh mặc định **annotate `isBoundTab`** (bỏ gate `params?.all === false` ở `browser-capabilities.ts:1953`, hoặc annotate ngay trong nhánh `:1517`). *Probe*: gọi `tabs.list` mặc định → mọi tab có field, đúng 1 tab `isBoundTab:true`.
2. Ghi **kết quả freeze + trạng thái surface** vào receipt per-invocation đã tồn tại; thêm test `/TARGET_BUSY_DRAINING/` trên **message** ở `browser-control-port.ts:1933-1934`. *Probe*: ép một drain → histogram ghi `TARGET_BUSY_DRAINING`, không còn `NO_RENDER_SURFACE`.
3. Đưa `altScreen` vào `TerminalSessionDiagnostics` (1 dòng). *Probe*: chạy TUI → diagnostics có `altScreen:true`.
4. Sửa **message sai ngữ nghĩa** của quota tab + trả về **danh sách id đang giữ** trong payload lỗi. *Probe*: chạm quota → lỗi liệt kê đủ id.

**Đợt 1 — xoá lớp lỗi lớn nhất (định danh + lease)**
5. Mở rộng `agentTabSwitch` adoption (`capability-catalogue.ts:612-634`) cho **mọi** capability khi tab yêu cầu **còn sống và thuộc session này**, adopt y như đường switch (port đã re-stamp `browserTarget` ở `:643-650`). *Probe*: gọi `evaluate {tabId: <session-owned>}` → thành công, không TARGET_MISMATCH.
6. Truyền `timeoutMs` tường minh vào `viewportGate.withLock` cho `anti.agent.sequence` (`:3396`) và `anti.trace.interaction` (`:3953`) — **ít nhất** bằng policy 30 s của chúng, **không bao giờ** thấp hơn trần trong cùng của bước bên trong (`tab-devtools-host.ts:736`). *Probe*: chạy `[wait 10000, click]` → hoàn tất; `assertDeadlineChain` không còn bị vi phạm.
7. Expose `browser.wait` (đã đăng ký) và **quyết định dứt điểm** về `terminal.*` trên MCP surface. *Probe*: `accounting:mcp-dispatch` pass.
8. Register bằng chứng: `listVerifications` đọc **từ đĩa** hoặc reload theo mtime. *Probe*: gọi `anti.verification.list` → `totalCount > 0`.
9. Drain guard ném **typed error có `code`** thay vì `Error` thường. *Probe*: drain → code `TARGET_BUSY_DRAINING` ở mọi tầng.

**Đợt 2 — capture và quyền**
10. Gọi `acquireMediaFreeze` cho đường **full-page**; biến `requireMediaFreeze` từ policy chết thành gate thật (hoặc xoá nó đi cho trung thực). *Probe*: full-page trên trang có animation vô hạn → settle hoặc fail có lý do tên rõ.
11. Ép master token đi qua `capability.dispatch`; chuyển `AGENT_BROWSER_SCRIPT` sang isolated world. *Probe*: `bridge` test + grep `window.__antifanRefMap` = 0 trong main world.
12. Transport: **ngừng route call AntiFan qua `write` + chuỗi JSON** (phía cấu hình OMP) và/hoặc làm AntiFan chịu được args dạng chuỗi. *Probe*: 49 lỗi parse args về 0 trên một phiên mới.
13. `CAPABILITY_ERROR` serialize thật (type + message + stack), không `[object Object]`. *Probe*: ép lỗi → payload có message đọc được.

**Đợt 3 — coupling (Haravan CLI + terminal + hooks)**
14. Bắt dòng preview từ PTY bằng regex strip-ANSI `Preview:\s*(https?://\S+\?themeid=\d+)`; lưu `themeid` vào trạng thái watcher; thêm tool đọc trạng thái (`anti.haravan.*`). *Probe*: chạy `hrv theme dev` → themeid xuất hiện trong trạng thái AntiFan.
15. **Chốt câu hỏi kiến trúc: split là view của base hay terminal độc lập?** Chỉ sau đó sửa M1 (projection nhận split), M2 (nguồn cwd/command/pid), M3 (resolver chấp nhận split).
16. Siết `haravan-sync-barrier`: ack phải kèm căn cứ ngoài text (pid/seq/đường dẫn file) để không false-positive trên terminal ồn.
17. Hook: thêm **tối đa** 1–2 hook tần số thấp (`session_start` nạp trạng thái evidence; `tool_result` chèn acceptance probe), dùng `node:fs` hoặc `pi.pi.discoverMCPServers`, **không** spawn per-event. *Probe*: hook cháy đúng 1 lần/phiên, không timeout.

**Đợt 4 — Core Health (cần approval vì ghi store)**
18. `core.candidates` (đọc 108 id) → adjudicate từng lô; replay regression; cấp evidence cho 2 platform 0 claim.
19. D1/D2 (read-only mà INSERT), D3 (`reasonsJson`), D5 (nhánh chết), D6/D7 (hai reasonCode), D8 (`connected`/`entryId=null`), D9 (không bao giờ HEALTHY), D10 (`knowledgeGaps` không ai dùng), D11 (principle không dedupe).

**Tiêu chí nghiệm thu toàn chương trình (nhị phân):**
- `anti.verification.list` trả `totalCount ≥ 1000`.
- Một phiên mới: **0** lỗi `Expects a JSON args object`, **0** `No such tool`, **0** `[object Object]`.
- `tabs.list` mặc định có `isBoundTab` trên đúng 1 tab.
- `[wait 10000, click]` hoàn tất; `assertDeadlineChain` pass.
- Full-page trên trang có animation vô hạn: settle, hoặc fail với lý do **đúng tên**.
- Tổng tỉ lệ lỗi tool trên một phiên so sánh được: **< 9,3%** (mốc hiện tại), riêng nhóm capture **< 20%** (từ 77–79%).
- `npm run audit`, `npm run accounting:mcp-dispatch`, và unit test hiện có **không bị nới**.

---

## 7. Điều chưa chứng minh được, và câu hỏi cần anh quyết

**Chưa chứng minh (không được coi là fact):**
1. Ảnh terminal của anh có thật sự ở alternate buffer không (không có byte capture của phiên đó). Cần test DevTools ở §4.1.
2. `anti.verification.list` = 0 là do **process nào** — cần restart app để tách.
3. Quota tab: chuỗi lỗi **thật** trong log anh gửi (subagent đang đào) → chưa biết là cổng 1 hay cổng 2.
4. Vì sao bound tab báo `cause:"probe-unavailable"` chứ không `zero-viewport`: `catch {}` ở `browser-control-port.ts:3646` **nuốt mất** nguyên nhân — bản thân việc nuốt là một defect chẩn đoán.
5. Tỉ lệ chia của 91 TARGET_MISMATCH giữa gate catalogue và gate attachment (message không phân biệt được).
6. `[INFERENCE]` Electron map `persist:X` → `Partitions\X` (suy từ tương quan 41↔41↔41, không đọc source Electron).
7. `[INFERENCE]` SSO `accounts.haravan.com` không được cấp bởi session `*.myharavan.com` — chưa đọc jar HttpOnly, chưa đo chính sách phía Haravan.

**ĐÃ ĐƯỢC ANH TRẢ LỜI (2026-09-18):**
- **A. Split = terminal độc lập** — xác nhận kèm ảnh (pane dưới, nhãn "Terminal (Split)", PowerShell riêng). ⇒ cả M1/M2/M3 trong phạm vi.
- **B. Không expose thêm `terminal.*`/`browser.wait` hay không** — anh đã duyệt (mục 5 dưới), tức **có**, kèm gate `accounting:mcp-dispatch`.
- **C. Restart app: ĐỒNG Ý.** ⚠️ Nhưng phải làm **sau** bước 1 (guard), vì restart tạo process mới nạp 1.000 record từ đĩa → **làm rỗng mất "khẩu súng"**. Nếu restart trước khi có guard, một process cũ vẫn giữ mảng rỗng và vẫn có thể ghi đè.
- **D. Ghi store bằng chứng: ĐÃ DUYỆT** (H1/H2/H3). ⚠️ Vẫn phải **sau bước 1**: `:737/:892/:928` đều đổ về `rewriteVerificationsFile`, nên **chính lệnh ghi được duyệt có thể là cò súng**. Duyệt của anh không miễn được bất biến an toàn (AGENTS.md Level 0).
- **E. Sửa cấu hình OMP: ĐÃ DUYỆT** (`tools.xdev:false`). Vẫn giữ **precheck + revert ngay** vì downside là mất toàn bộ control plane.
- **Rotate credential: anh quyết KHÔNG cần.** Ghi nhận — nhưng token vẫn nằm plaintext trên đĩa; đề xuất scrub vẫn để mở.

**ĐÃ LÀM ĐƯỢC NGAY (bảo hiểm, trước mọi thay đổi):** sao lưu register → `E:\Work\.antifan-data\issues\verification-register.jsonl.bak-260918-guard-pending`, **1.831.100 B / 1.000 dòng**, byte-identical với bản gốc. Đây là lưới an toàn nếu khẩu súng bắn trước khi guard landed.

**7.4 — Chỗ trùng với kế hoạch đang TẠM GIỮ:** họ fail-open `targetOverflowX`/`NO_RENDER_SURFACE` có giao với §3.5 mục 2 (dán nhãn sai drain) và §6 đợt 0 mục 2. Tôi **không** khôi phục S1–S5; chỉ ghi nhận để khi anh mở lại thì hai việc này nên gộp.

---

## 8. Nguồn bằng chứng chính

- Live [T1]: `anti.browser.tabs.list` (cả hai nhánh), `anti.browser.evaluate` (probe Haravan admin), `anti.browser.rebind_target`, `core.health`, `core.knowledge_gaps`, `anti.verification.list` ×2, `Get-Process electron`, `Test-Path`/`Get-ChildItem` trên `E:\Work\.antifan-data`.
- Đĩa [T2]: `src/main/tools/capability-catalogue.ts`, `browser-control-port.ts`, `capability-transport.ts`, `src/main/run/attachment-registry.ts`, `src/main/browser/native-tab-host.ts`, `tab-devtools-host.ts`, `tab-automation-host.ts`, `terminal-manager.ts`, `src/renderer/standalone.js`, `src/main/session/issue-register.ts`, `src/main/diagnostics/core-health.ts`, `packages/super-core/src/index.ts`, `scripts/antifan-omp-mcp.cjs`, `src/shared/deadline-chain.ts`, `docs/haravan/cli-operations-and-guards.md`.
- Log phiên [T2]: 2 file OMP (71,5 MB, 18.828 record) + file phiên `F1GENZ_Review`; `control-plane-v2/invocations` (1.046 file); `plans/260917-0341-mcp-dispatch-accounting/reports/acceptance-mcp-dispatch-accounting.md`.
- Đối kháng độc lập: 3 verifier (cookie, hooks/hrv, target cluster) + 1 re-audit 45 finding cũ + 1 điều tra scrollback + 1 điều tra quota tab.
