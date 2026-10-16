# Brainstorm: dùng Claude Desktop với AntiFan, bỏ qua Terminal Manager

- Ngày: 2026-10-15 · Phạm vi: chỉ nghiên cứu, chưa sửa code · Trạng thái: chờ user chọn phương án
- Nguồn: 3 agent scout (transport MCP, coupling terminal, docs/plans), cộng probe live trong session Claude Desktop (tab Code) hiện tại

## TL;DR

**Dùng được, và đang chạy thật.** Session Claude Desktop (tab Code) này đã kết nối MCP `antifan` qua `E:\Work\.mcp.json` (stdio `node scripts/antifan-agent.cjs mcp`). Probe live đã chạy được tabs.list → tabs.create → rebind → snapshot → screenshot inline, không hề dùng terminal.

Bỏ Terminal Manager sẽ mất 4 thứ. Chỉ một thứ là blocker thật: **rào sync theme (`theme.transaction.await_sync_and_reload` / `settle("VERIFIED")`) bắt buộc phải đọc output PTY của watcher `hrv` chạy trong AntiFan.**

Thay hẳn Terminal Manager: **được, nhưng phải vá 3 chỗ phía AntiFan (P1 gắn project theo cwd, P2 sync không cần PTY, P3 brief theo thư mục)**, xem mục ngay dưới. P1 là lỗi đã tái hiện live: agent chạy ngoài AntiFan bị gắn nhầm vào project ambient.

Khuyến nghị: **Phương án A (tab Code của Claude Desktop + MCP hiện có) dùng ngay; Phương án B (gói vá tách terminal) làm dần theo ưu tiên.** Tab Chat/Cowork chỉ hợp cho QA đọc/kiểm tra, và cần spike trước.

## Câu hỏi chính: Claude Desktop có thay được Terminal Manager không?

**Thay được phần "nơi chạy và quản lý agent". Chưa thay 1:1 được ngay hôm nay**, vì AntiFan đang lấy terminal làm nguồn sự thật cho 3 việc: gắn project, xác nhận sync theme và brief của capsule. Cả 3 vá được phía AntiFan, khối lượng nhỏ và khoanh vùng rõ.

Probe quyết định (2026-10-15): spawn MCP với cwd `E:/Work/apps/F1GENZ Wheel` (project `12f81249`), không có env PTY. Kết quả: session vẫn bị gắn vào `project-2787bbbd` (S2 Sky Fashion, project ambient). Nguyên nhân là `evidenceTabId = suppliedTabId || binding?.browserTarget?.tabId` (`src/main/bridge/bridge-server.ts:1234`): tab của binding ambient thắng cwd, nên nhánh cwd trong `resolveWorkspaceForSession` không bao giờ được chạy tới. Trong terminal AntiFan, `terminalSessionId` cho scope đo được nên mới đúng.

| Vai trò của Terminal Manager | Thay bằng Claude Desktop | Trạng thái |
|---|---|---|
| Chạy agent (Claude Code/OMP trong PTY) | Session Code (chọn model, permission UI, worktree) | ✅ thay được ngay |
| Hub chung `Ctrl+Shift+M`, nhóm theo thư mục | Sidebar session: group/section, pin, unread, trạng thái chạy/chờ/xong | ✅ |
| Run card, Cancel/Steer, chỉ báo chờ duyệt | Nút Stop, nhắn giữa lượt, notification, Remote Control | ✅ |
| Nhiều agent song song | Worktree mỗi session, split view | ✅ (va chạm theme remote vẫn phải tuần tự upload) |
| Shell thường để chạy lệnh tay | Terminal panel của Claude Desktop | ✅ |
| `terminal.*` MCP để agent tự mở shell | Bash tool của Claude Code (có chạy nền + Monitor) | ✅ |
| **Gắn agent ↔ project/workspace** | Hiện rơi về project ambient (probe trên) | ❌ → 🟡 sau vá P1 |
| **Watcher `hrv` (role sync, không sleep, mỗi store+theme một watcher)** | Chạy trong Terminal panel/Bash nền, nhưng AntiFan không đọc được output | ❌ → 🟡 sau vá P2 |
| **Brief capsule ghim (URL, theme id, rule) vào mọi prompt** | Hook `UserPromptSubmit`/`SessionStart` của Claude Code; hiện brief chỉ mirror theo `terminalSessionId` (`src/main/run/run-state-service.ts:597`), không có tool MCP nào | ❌ → 🟡 sau vá P3 |
| Annotation "gửi cho agent" | Clipboard đã có prompt `@md @png`, dán vào là xong; hoặc hook tự đính kèm | 🟡 thủ công dùng được |
| Guard edit / QA gate (hook OMP) | Hook `PreToolUse`/`PostToolUse` | 🟡 cần port |
| `.antifan/space.json` (mở bộ terminal + tab) | Phần tab vẫn do AntiFan mở; phần terminal không có tương đương 1:1 | 🟡 một phần |
| Link trong terminal mở đúng cửa sổ owner | Link mở bằng browser mặc định | ❌ nhỏ (agent tự `tabs.create`) |
| PTY daemon sống qua restart AntiFan | Agent sống độc lập với AntiFan; proxy MCP reconnect sau restart [chưa kiểm chứng] | 🟡 |

Các vá cần làm để thay hẳn (theo thứ tự):
- **P1, gắn project theo cwd (bắt buộc):** khi pairing không có tab/terminal, cwd khớp workspace root của project đang mở thì cwd phải thắng tab ambient (`bridge-server.ts:1234-1264`). Kèm test: cwd thuộc project A trong khi ambient là B → bind A; cwd lạ → giữ hành vi cũ.
- **P2, sync không cần PTY (bắt buộc cho luồng theme):** thêm một `TerminalSyncPort` đọc log file cho `HaravanSyncBarrier`, kèm script bọc `hrv theme watch` (tee ra `<data-root>/runtime/watchers/<store>-<theme>.log` + lock file chống trùng watcher). Lệnh `hrv` vẫn phải được duyệt từng lần.
- **P3, brief theo thư mục (nên làm):** Main mirror brief theo folder key, hoặc thêm tool MCP đọc brief theo project đang bind; hook `UserPromptSubmit` chèn vào context.
- Sau đó: B2 failover an toàn, B3 payload gọn, B4 port hook, B5 dọn tab mồ côi (đã tả ở dưới).

## Vá được toàn bộ không? (phân tích 2026-10-15)

**Không được 100%. Ở tab Code vá được khoảng 17/19 gap. Còn lại 2 gap là giới hạn của host Claude Desktop, AntiFan không sửa được.** Tab Chat/Cowork không có hook nên chỉ vá được nhóm 1.

Nguồn năng lực hook: tài liệu Claude Code (`code.claude.com/docs/en/hooks`, `channels`, `channels-reference`, `desktop`, `env-vars`, `mcp`), đọc ngày 2026-10-15. Hook chạy trong Desktop giống CLI vì Desktop đọc cùng file settings. Session này cũng đang chạy hook SessionStart và UserPromptSubmit.

Khác biệt gốc: hook OMP chạy **trong cùng process** với agent. Nó poll file control mỗi 1 giây (`src/omp-hooks/run-state.ts:27,471-473`), gọi `ctx.abort()` và `pi.sendUserMessage({deliverAs:'steer'})` ngay tức thì (`:424-432`). Hook Claude Code thì là process ngắn, chỉ chạy khi có event, và không có API để app ngoài ngắt hay chèn message bất đồng bộ.

### Nhóm 1: vá hoàn toàn, chỉ sửa AntiFan (áp dụng cho cả tab Code và Chat)

| # | Gap | Cách vá | Lưu ý |
|---|---|---|---|
| 1 | Gắn project theo cwd (P1) | Khi không có anchor tab/terminal, cwd khớp workspace root thì thắng tab ambient (`bridge-server.ts:1234`) | Khớp theo tiền tố dài nhất (root lồng nhau); cwd là worktree (map qua `git --git-common-dir`); project chưa mở cửa sổ; thư mục chưa đăng ký thì trả cảnh báo thay vì im lặng dùng ambient |
| 2 | Failover sang tab user (B2) | Mint tab agent mới hoặc trả `TARGET_REQUIRED` | `browser-control-port.ts:4357-4368`, `antifan-omp-mcp.cjs:2213-2217,2731-2741` |
| 3 | Payload `tabs.list` quá ngưỡng (B3) | Bỏ favicon `data:`, hoặc đặt `_meta["anthropic/maxResultSizeChars"]` | Ngưỡng Claude Code: 25.000 token / 50.000 ký tự |
| 4 | Tab agent mồ côi (B5) | Đóng tab khi revoke attachment | |
| 5 | `set_automation_target` ghi biến toàn cục | Chuyển sang lưu theo attachment | |
| 6 | Pair không cần bearer, grant mặc định `eval` | Pin grant theo client, xác nhận client mới | |
| 7 | Tên tool chứa dấu chấm (cho tab Chat) | Chế độ alias `.`→`_` sau env flag | Claude Code đã tự đổi |
| 8 | Failure journal | Set `ANTIFAN_DATA_ROOT` trong `env` | Chỉ sửa cấu hình |

### Nhóm 2: vá hoàn toàn nhờ hook Claude Code (chỉ tab Code)

| # | Gap | Hook | Mức đạt |
|---|---|---|---|
| 9 | edit-guard | `PreToolUse` → `permissionDecision:"deny"` + lý do cho model | Ngang OMP |
| 10 | theme-qa-gate | `PostToolUse` `additionalContext`, cộng `Stop` `decision:"block"` để bắt chạy QA trước khi kết thúc | **Hơn** OMP (OMP chỉ nhắc, không chặn) |
| 11 | Brief capsule (P3) | Main mirror brief theo project/folder; `SessionStart` + `UserPromptSubmit` chèn `additionalContext` | Ngang OMP; tối đa 10.000 ký tự |
| 12 | Run card trong AntiFan | Hook các event SessionStart/UserPromptSubmit/Pre/PostToolUse/Stop/SessionEnd ghi `runtime/runs/<session_id>.json`; `RunStateService` nhận id không phải terminal (hiện bị chặn `SESSION_NOT_VISIBLE`, `native-tab-host.ts:4980`) | Ngang (chỉ hiển thị) |
| 13 | Chỉ báo chờ duyệt / chờ user | `Notification` (`permission_prompt` sau ~6 s, `idle_prompt` sau ~60 s) | Gần ngang, trễ 6–60 s |

### Nhóm 3: vá được nhưng ngữ nghĩa yếu hơn OMP

| # | Gap | Cách vá | Thiếu gì so với OMP |
|---|---|---|---|
| 14 | Cancel từ UI AntiFan | Hook Pre/PostToolUse đọc file control → `{"continue":false,"stopReason":…}` | Chỉ dừng được ở ranh giới tool, không ngắt khi model đang sinh chữ. Bù lại: nút Stop của Claude Desktop ngắt tức thì |
| 15 | Steer từ UI AntiFan | `PostToolUse` `additionalContext` ở lần gọi tool kế tiếp | Session đang idle thì không giao được cho tới khi user gửi prompt |
| 16 | Annotation "gửi cho agent" | Pull khi user gửi prompt: `UserPromptSubmit` tự đính kèm annotation mới trong cwd; hoặc dán từ clipboard | Không tự đẩy vào session. Push thật chỉ có qua **Channels** (`notifications/claude/channel`): proxy antifan đã là stdio server do Claude Code spawn nên về kỹ thuật có thể khai `claude/channel`, nhưng tính năng đang research preview và tài liệu chỉ ghi CLI |
| 17 | Xác nhận sync theme (P2) | Thêm một `TerminalSyncPort` không cần PTY (`haravan-sync-barrier.ts:39-48`) | **Độ tin cậy phụ thuộc người sở hữu process**: AntiFan tự spawn watcher headless (giữ stdout) thì ngang PTY hiện tại; đọc log file do process ngoài ghi thì yếu hơn, vì agent có quyền ghi file nên giả được dòng `Uploaded`. Vậy muốn ngang thì phải giữ một supervisor process **không UI** trong AntiFan, kèm hộp thoại xác nhận mỗi lần chạy `hrv` (session đang ở chế độ bypass permissions nên prompt của Claude không đủ) |

### Nhóm 4: không vá được (giới hạn host)

| # | Gap | Lý do |
|---|---|---|
| 18 | Đẩy message hoặc ngắt session Claude Desktop **tức thì** từ app ngoài | Không có API được tài liệu hoá. Channels chưa có tài liệu cho Desktop. Remote Control chỉ dành cho claude.ai và mobile |
| 19 | AntiFan tự mở/khởi chạy session agent (role `agent` trong `space.json`, "mở agent ở thư mục X") | Không có API được tài liệu hoá để tạo session Desktop từ ngoài; phải mở tay |

Không còn cần (vì terminal đã bị bỏ): link trong terminal mở đúng cửa sổ owner; PTY daemon sống qua restart.

### Lộ trình nếu làm

1. **Bắt buộc:** P1 (#1), P2 dùng supervisor headless (#17), B2 (#2).
2. **Gói hook cho tab Code:** #9–#13, đặt trong `.claude/settings.json` của workspace theme. Hook chỉ đọc/ghi file trong data root nên không mở thêm bề mặt mạng.
3. **Hợp tác:** #14–#16 (pull annotation).
4. **Spike tuỳ chọn:** Channels trên Desktop (#16/#18), tab Chat (#7).

## Contract

| Trường | Nội dung |
|---|---|
| Outcome | Agent chạy trong Claude Desktop điều khiển browser/QA/theme của AntiFan qua MCP, không cần agent sống trong terminal AntiFan |
| Constraints | AntiFan Electron phải đang chạy (không auto-launch). Bridge chỉ loopback. Tuân AGENTS.md §3.1 (AntiFan là primary, Playwright fallback có telemetry). Không chạy `hrv`/`haravan` khi chưa được duyệt |
| Non-goals | Không xoá/refactor Terminal Manager. Không dựng Agent Session Manager (đúng quyết định 2026-09-15). Không viết lại run card/steer cho Claude |
| Acceptance | (1) Session Code mới, không có biến `ANTIFAN_*`, làm trọn create→rebind→inspect→screenshot. (2) Luồng theme: sửa file → push ngoài AntiFan → xác nhận sync → `theme.qa_validate` PASS, không gọi `terminal.*`. (3) Chặn `terminal.*` bằng `ANTIFAN_FORBIDDEN_CAPABILITY_NAMES` mà luồng (2) vẫn xanh |

## Bằng chứng live (2026-10-15, session này)

| Probe | Kết quả |
|---|---|
| `core.health` | HEALTHY, ALL_GATES_PASSED (core chạy in-process) |
| `tabs.list` (mặc định) | Session được bind vào `project-2787bbbd…`, có tab agent riêng (`isBoundTab`) |
| `tabs.list all:true` | 55.917 ký tự cho 47 tab → **vượt giới hạn output tool của Claude Code** (bị đẩy ra file). 17.906 ký tự (~32%) là favicon `data:` URI |
| `get_viewport` trên tab agent detached | `probe-unavailable` (CDP timeout 3s) |
| `navigate` sau vài phút | `TARGET_STALE`: tab agent cũ đã biến mất |
| `tabs.create(anchorTabId, activate:false)` + `rebind_target` | OK, tab nền, không cướp focus |
| `inspect.snapshot`, `screenshot_viewport` inline | OK. JPEG q50 1920×933 ≈ 43 KB, trả về image block |
| `tabs.close` tab của session khác | `TARGET_MISMATCH`: cách ly session hoạt động đúng |
| `tabs.close` tab agent của chính mình | OK, nhưng **`failoverTabId` = tab admin Haravan của user** (Sky Fashion settings) |
| Spawn stdio từ cwd `C:\Users\Admin`, không có `ANTIFAN_*` | Pair xong trong 1,5 s, `initialize` OK (protocol 2025-06-18), 155 tool, schema 63 KB, stdout sạch, 69 B stderr |
| Tên tool | **155/155 chứa dấu chấm** (`anti.browser.tabs.list`), không khớp `^[a-zA-Z0-9_-]{1,64}$`. Claude Code tự đổi `.`→`_` (`mcp__antifan__anti_browser_tabs_list`) |
| Project khi cwd lạ | Probe vẫn rơi vào cùng `project-2787bbbd` (binding ambient), tức cwd không chọn được project |
| Sau khi probe thoát | Còn sót tab `about:blank` detached `e0870188…`; session này không đóng được (bị cách ly) |

## Kiến trúc tóm tắt (đã đối chiếu code)

```
Claude Desktop ──stdio──> antifan-agent.cjs mcp ──HTTP pair + WS (127.0.0.1:20129/20130)──> AntiFan Electron bridge
                           │ discovery: <data-root>/config/bridge(.json|-dev.json) (port/pid, không chứa token)
                           └─ spawn antifan-omp-mcp.cjs (stdio inherit, bootstrap qua env)
```

- Pairing: `POST /api/pairing/challenge|exchange`, `clientClass:'mcp'`, sau đó `antifan.cli.startSession` (TTL 1 giờ, renew mỗi 30 s) (`scripts/antifan-agent.cjs:337-388,528,849-861`).
- Payload pairing gửi `terminalSessionId` (chỉ khi có env PTY) và `cwd: process.cwd()` (`scripts/antifan-omp-mcp.cjs:1832-1842`).
- Project: `measuredWorkspace (tab/terminal/cwd) || binding ambient || 'default-project'` (`src/main/bridge/bridge-server.ts:1264`). Cwd chỉ khớp khi trùng workspace root của một project đang mở (`src/main/control-plane/control-plane-runtime.ts:434-475`).
- Grant mặc định là `eval` (`scripts/antifan-omp-mcp.cjs:1303-1311`). Tool eval-risk còn cần app chạy với `--allow-eval`/`ANTIFAN_ALLOW_EVAL`.
- App tắt: route `mcp` in `MCP_BRIDGE_OFFLINE` rồi exit 1, không advertise tool nào. Không có auto-launch.
- Client timeout phải > 250.000 ms (`src/shared/deadline-chain.ts:76`); proxy timeout là 240 s.

## Bỏ Terminal Manager thì mất gì

| Tính năng | Cơ chế hiện tại | Phụ thuộc terminal | Thay thế khi dùng Claude Desktop |
|---|---|---|---|
| Bind tab ↔ agent | Affinity theo env PTY (`bridge-server.ts:2676-2740`) | Chỉ là affinity | Mỗi attachment tự mint tab agent riêng (`:2743-2770`). Đã chạy |
| **Sync attestation theme** | `HaravanSyncBarrier` chờ regex `Uploaded/Synced/Pushed/Finished` trên PTY watcher (`src/main/qa/haravan-sync-barrier.ts:102,148-156`). Bắt buộc cho `settle("VERIFIED")` | **Cứng** | Một phần: `anti.theme.await_cdn_sync` so SHA-256 asset CDN với file local (chỉ asset CSS/JS, không áp cho Liquid, không thỏa `settle VERIFIED`) |
| Annotation "send to agent" | Ghi `prompt @md @png\r` vào stdin PTY (`annotation-dispatch.ts:28-35`) | Có (khâu giao) | File đã nằm ở `.antifan/annotations/`, prompt đã được copy vào clipboard (`tab-devtools-host.ts:943`). Dán vào Claude Desktop |
| Run card, Cancel/Steer, chỉ báo chờ duyệt | Hook OMP ghi `runtime/runs/*.json` và file control | Có, chỉ OMP | Dùng UI của Claude Desktop (stop, permission prompt) |
| Hook edit-guard / theme-qa-gate | Hook OMP `pi.on(...)` tại `~/.omp/agent/hooks` | Chỉ OMP | Chưa có bản cho Claude Code. Tab Code hỗ trợ hook nên port được; tab Chat không có hook |
| Failure journal của proxy | Chỉ ghi khi có env `ANTIFAN_DATA_ROOT` | Một phần | Set `ANTIFAN_DATA_ROOT` trong `env` của cấu hình MCP |
| Cockpit, QA receipt, transaction hold | Pull qua MCP + file | Không | Dùng thẳng |

Hiện không có cờ "browser-only": `TerminalManager` luôn được khởi tạo (`src/main/index.ts:4144`). Muốn chặn agent đụng terminal thì dùng `ANTIFAN_FORBIDDEN_CAPABILITY_NAMES=terminal.*`, nhưng cách này làm hỏng `await_sync_and_reload`.

## Bề mặt Claude Desktop

| Tiêu chí | Tab Code (= Claude Code) | Tab Chat / Cowork (`claude_desktop_config.json`) |
|---|---|---|
| Cấu hình | `.mcp.json` / `~/.claude.json`. **Đã chạy** | `%APPDATA%\Claude\claude_desktop_config.json`, `mcpServers` hiện đang rỗng. Đổi cấu hình phải restart toàn bộ app |
| Tên tool có dấu chấm | Tự đổi `.`→`_`. Đã kiểm chứng | **Chưa kiểm chứng.** API yêu cầu `^[a-zA-Z0-9_-]{1,64}$` |
| 155 tool / 63 KB schema | Deferred qua ToolSearch, rẻ | [INFERENCE] có thể nạp hết vào context. Nên lọc bằng `ANTIFAN_ALLOWED_CAPABILITY_NAMES` |
| Output lớn | Quá ngưỡng thì đẩy ra file (`tabs.list all`) | [INFERENCE] không có file fallback. Theo nguồn bên thứ ba, giới hạn khoảng 1 MB/response |
| Cwd → project | Cwd của session là thư mục project (nhưng hiện vẫn rơi về ambient) | Không có trường `cwd` trong tài liệu chính thức → luôn ambient/default |
| Hook (guard, QA gate) | Có (PreToolUse/PostToolUse) | Không |
| Quy tắc AGENTS.md/CLAUDE.md | Tự nạp | Không nạp. Phải đưa vào Project instructions |
| Chạy `hrv` / sửa file | Có Bash, Edit | Không (trừ khi thêm MCP filesystem) |
| Restart server MCP | Session mới thì có process mới | Phải restart app |

## Phương án

### A. Tab Code + MCP hiện có, không đổi code (khuyến nghị dùng ngay)

- Làm: giữ `E:\Work\.mcp.json`. Mở session Claude Desktop Code ngay trong thư mục theme. Chạy `hrv theme watch` ngoài AntiFan (bằng Bash nền của Claude Code hoặc Windows Terminal, theo luật duyệt từng lần). Xác nhận sync bằng `anti.theme.await_cdn_sync` cho asset, còn Liquid thì reload rồi `theme.qa_validate`.
- Cứng hoá cấu hình (chỉ sửa config, không sửa code):
  ```json
  "antifan": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["E:/Work/apps/AntiFan/scripts/antifan-agent.cjs", "mcp"],
    "env": { "ANTIFAN_DATA_ROOT": "E:/Work/.antifan-data", "ANTIFAN_FORBIDDEN_CAPABILITY_NAMES": "terminal.create,terminal.write,terminal.resize,terminal.close,terminal.wait,terminal.list" }
  }
  ```
  (Bỏ dòng FORBIDDEN nếu vẫn cần `await_sync_and_reload`.)
- Ưu: không tốn công, đã kiểm chứng live, có hook/Bash/Edit, tool deferred.
- Nhược: mất `settle VERIFIED` của transaction, mất guard của OMP. Có rủi ro failover sang tab user (xem mục Rủi ro).

### B. Gói vá "tách terminal" (làm dần trên A)

Theo thứ tự ưu tiên, mỗi mục nhỏ và độc lập:
1. **Sync port không cần terminal** cho `HaravanSyncBarrier`: thêm `TerminalSyncPort` thứ hai đọc log file của watcher (tee stdout `hrv` ra file), hoặc kết hợp hash CDN. Mở khoá `settle("VERIFIED")` khi không có PTY. Đây là gap duy nhất có tính blocker.
2. **Failover an toàn**: khi tab bound chết/bị đóng thì không chuyển authority sang tab user, mà mint tab agent mới hoặc trả `TARGET_REQUIRED`. Có 2 đường cần sửa: `closeTab` trả `failoverTabId` (`src/main/tools/browser-control-port.ts:4357-4368`) và proxy ghi nó thành bound tab (`scripts/antifan-omp-mcp.cjs:2731-2741`); autoheal chọn tab `attached:true` đầu tiên (`scripts/antifan-omp-mcp.cjs:2213-2217`).
3. **Payload gọn**: bỏ favicon `data:` URI khỏi `tabs.list` (giảm ~32%), để `tabs.list all` lọt ngưỡng output.
4. **Port 2 hook OMP sang Claude Code hooks** (edit-guard dạng PreToolUse block, theme-qa-gate dạng PostToolUse nhắc nhở; `theme-qa-gate.ts:132` đã match `mcp__antifan`).
5. **Dọn tab agent mồ côi** khi attachment bị revoke (đã thấy `e0870188…` sót lại sau khi probe thoát).
- Ưu: giữ nguyên kiến trúc, đúng hướng D-01 (2026-10-08: "terminal context is an affinity hint").
- Nhược: mục 1 và 4 cần test e2e. Mục 2 đổi hành vi autoheal.

### C. Tab Chat/Cowork qua `claude_desktop_config.json` (chỉ cho QA nhẹ, cần spike)

- Cấu hình: như snippet ở A, cộng `ANTIFAN_ALLOWED_CAPABILITY_NAMES` (khoảng 25–35 tool đọc/inspect/screenshot) và `ANTIFAN_SESSION_GRANT=write` nếu không cần eval.
- Spike bắt buộc trước: (1) Desktop Chat có chấp nhận tên tool chứa dấu chấm không; (2) ảnh inline và output lớn hiển thị thế nào; (3) Cowork có thấy MCP local không. Cần restart Claude Desktop (sẽ ngắt các session đang chạy).
- Nếu tên có dấu chấm bị từ chối: thêm chế độ alias `.`→`_` trong `listTools`/dispatch (thay đổi nhỏ, sau env flag).
- Ưu: giao diện chat, có Projects/knowledge.
- Nhược: không hook, không Bash/Edit, project luôn ambient, không nạp AGENTS.md, đổi cấu hình phải restart app. Không phù hợp để sửa theme.

## Rủi ro bảo mật và vận hành

- Pairing challenge chỉ chạy trên loopback và không cần bearer, nên mọi process local đều pair được, mặc định với grant `eval`. Nên pin `ANTIFAN_SESSION_GRANT` cho từng client.
- Đã thấy live: failover rơi vào tab admin Haravan của user. Agent có thể thao tác trên tab admin mà không có ý định đó. Mục B2 xử lý việc này.
- `set_automation_target` ghi vào `automationTabId` toàn cục, nên nhiều client có thể giẫm lên nhau [INFERENCE, chưa đo].
- `docs/security-model.md:73-105` và `README.md:27,101-120` đã lỗi thời (còn tả `--mcp-server`, alias `antifan_*`).
- Vault cookie là JSON plaintext ở `E:\Work\.antifan-data\config\session-vault.json`.

## Câu hỏi còn mở

1. Có bắt buộc `settle("VERIFIED")` của transaction không, hay hash CDN + `qa_validate` là đủ? Câu trả lời quyết định B1 có cần làm hay không.
2. Sau khi bỏ terminal AntiFan, ai chạy `hrv theme watch`: Bash nền của Claude Code hay Windows Terminal?
3. Có thật sự cần tab Chat/Cowork không, hay tab Code là đủ? Nếu cần thì phải spike C (có restart app).
4. Tab `about:blank` mồ côi `e0870188…` (project `2787bbbd`) do probe để lại: user tự đóng, hoặc chờ B5.
