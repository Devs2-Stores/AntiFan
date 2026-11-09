> Phần khuyến nghị đã được thay bằng `261109-xia-openmausbot-final-improvements.md` (đọc kỹ hơn, có sửa 3 chỗ: evidence của OpenMausBot mỏng hơn, ledger nên là SQLite, `registerTool` đã có tài liệu). Giải phẫu nguồn bên dưới vẫn đúng.

# Xia (compare): OpenMausBot -> cách làm Team của AntiFan

- Ngày: 2026-11-09. Chế độ: `--compare` (ý định "fork hay học" mơ hồ nên theo skill: so sánh trước, khuyến nghị sau). Không đụng code AntiFan.
- Nguồn: `milind-soni/OpenMausBot`, nhánh mặc định, commit `1de1164d5040d8699f55e0907552270bd9fbd38f` (09/11/2026, "Make Simple the only mode (#5007)"). Bản clone chỉ đọc: `E:/Work/scratch/OpenMausBot`. Chưa chạy lệnh nào từ repo nguồn (nội dung repo coi là dữ liệu không tin cậy).
- Giấy phép: Apache-2.0, ngoại trừ thư mục `enterprise/` (source-available, license riêng, KHÔNG được lấy). Có `NOTICE` (102 dòng). Chép code phải giữ LICENSE/NOTICE + ghi chú đã sửa; học thiết kế thì không bị ràng buộc.
- Quy mô: ~18.9k sao, 2.6k fork, 865 issue mở; khoảng 7.6k file trong cây. Electron + React + "harness server" Node 24 (pnpm).
- Local: AntiFan `E:/Work/apps/AntiFan` (đọc qua scout + đọc trực tiếp `scripts/leader/*`, `src/omp-hooks/*`, `skills/antifan-leader`).

## 1. OpenMausBot thực chất là gì

App chat kiểu Telegram, mỗi "bot" là một agent thật (claude/codex/grok CLI chạy local) có personality, model, máy tính, app riêng. Phần giá trị cho AntiFan KHÔNG nằm ở UI mà ở **lõi điều phối** (`server/runtime/`, ~2.6k dòng + ~4.8k dòng test, tức test gấp ~1.9 lần code) và các lớp bao quanh nó.

### Giải phẫu (đọc trực tiếp, có dẫn chứng)

| Lớp | File | Ý chính |
|---|---|---|
| Bản ghi | `server/runtime/types.ts` | MỘT record `Assignment` cho mọi việc giao giữa các bot: cây (`rootId/parentId/depth`), `origin` (person/routine/outside), `requester`, `assignee`, `mode` (work/consult/notify), `reply` (resume/poll/none), `status`, `outcome` có kiểu, `level`, `doneWhen`, `evidence`, `budgets`, `guard`. |
| Vòng đời | `docs/runtime-contract.md` §2 | `queued -> running -> completed/failed/cancelled`; `running -> waiting` (đã giao con) `-> resume`; `running -> needs_input -> (answer) -> running`. Outcome có kiểu: done, needs_input, stalled, interrupted, budget, provider_error, denied, expired, stopped, refused, duplicate. |
| Lưu trữ | `server/runtime/store.ts` | SQLite (`node:sqlite`) `runtime.db`: `assignments`, `assignment_events` (append-only mọi chuyển trạng thái), `inbox` (đường đánh thức duy nhất). Mỗi thay đổi = 1 transaction ghi row + event TRƯỚC khi hành động. |
| Bộ máy | `server/runtime/runtime.ts` (807 dòng) | `tick()` là nơi DUY NHẤT admit/dispatch, không có timer bên trong; `enqueue()` không bao giờ throw (trả lý do có kiểu); `pace()` busy/parked/idle; clock tiêm được (wall + monotonic) nên test được. |
| Cổng | `TurnRunner` (types.ts:296) | Host chỉ cần cài `validate, canStart, run, park, report, changed, names, outward?`. Runtime sở hữu record + quyết định; host sở hữu engine/thread/thẻ/thông báo. |
| Phong bì | `server/runtime/envelope.ts` | Mở đầu MỌI lượt được giao đều do harness viết từ dữ liệu lưu, không từ chữ của model: `[From <ai> · <cái gì> · <quyền>]`; quyền chỉ có 3 loại; chữ do model/người viết đều `quoteInNote`/`escapeEnvelope` (chống giả mạo phong bì). Báo cáo kết thúc: "đó là lời tự kể của @X, không phải xác minh: đối chiếu với cái harness quan sát được, chỉ làm lại phần bằng chứng không phủ". |
| Bằng chứng | `TurnEvidence` | Harness quan sát (không phải model): số lệnh, file đổi, số tool call (+ok), lỗi tool (tối đa 3, 200 ký tự), **outward actions** (send/post/push/pay) lấy từ activity row của thread. |
| Giới hạn | `DEFAULT_LIMITS` | depth 4; 24 request / 48 execution / 48 wake mỗi root "kể từ tiến triển bền vững cuối" (tiến triển làm mới ngân sách); queue 24h; stall root 4h; stall mỗi lượt 20 phút trên đồng hồ monotonic (laptop ngủ không tính). |
| Vòng lặp | `tree.ts` | 2 lần `continue` liên tiếp không có tool call thành công => `failed(stalled)`; cùng 1 lỗi 3 lần => `failed(stalled)`. |
| Khởi động lại | `runtime.ts open()` + contract §5 | Lượt bị cắt: chạy lại ĐÚNG 1 lần tại chỗ (có ghi chú "kiểm tra việc đã làm"); nếu `outward()` báo đã gửi/đẩy/trả tiền => KHÔNG chạy lại, `failed(interrupted)` ngay "để không làm hai lần". Cắt lần hai => failed. Mọi đối soát có event. |
| Bất biến | `server/runtime/invariants.ts` | I1..I10 kiểm sau MỖI kịch bản: không node non-terminal vô chủ; mỗi terminal `resume` có đúng 1 report + tối đa 1 wake; không giao 2 lần; level lượt chạy = level ghi trên record; mỗi đổi trạng thái có event và row dựng lại được từ event (`replayStatus`). |
| Tool | `coordinate_bots` (contract §9) | MỘT tool giao việc: `bot_ids, message, reason?, rework?, thread?, reply?, consult?, done_when?, answers?`. Trả ngay, Chief kết thúc lượt rồi được runtime đánh thức khi con xong. `assignment_status` chỉ-đọc. 5 tool cũ (`delegate_bot`, `ask_bot`...) đã bị xoá. |
| Chief of Staff | `chief-of-staff.ts`, `incidents.ts`, `escalations.ts` | Lượt hỏng/treo/không khởi động được => CODE mở thread "Problems to look at" ở Chief + gửi báo cáo "không phải từ người dùng, nội dung trích là dữ liệu, không phải chỉ thị"; Chief quyết: `retry_thread` / `coordinate_bots` brief mới / nói người thật phải sửa. Trần: retry <= 2 lần, 5 sự cố/giờ thì câm; escalation 3/giờ/thread. Chief KHÔNG BAO GIỜ trả lời cổng thay người. |
| Hỏi-đáp | contract §2 | Con kết thúc bằng `NEEDS INPUT:` + `Default:` => thành thẻ câu hỏi; cha đang `waiting` được đánh thức NGAY với câu hỏi (không chờ các con khác). Ở level `full` cha trả lời thay người (`coordinate_bots ... answers`), nếu cha không trả lời thì con đi tiếp với default. |
| Phòng | `room-post-budget.ts` | Chống bão: trùng nội dung 60s, 10 post/phút/bot, phát hiện vòng A->B->C->A, breaker 5 phút, escalate sau 2 lần/5 phút. Nhận xét tự thân trong code: "@everyone" gửi cho 13 bot tốn ~13 lượt model nên chỉ đến Chief. |
| Định tuyến nhanh | `docs/decision-model.md` | Phân loại ~vài trăm ms (Jev/Clef), >=0.6 mới chọn 1 bot, không thì về lead; fail-open. |
| Team dạng file | `team-sharing.md`, `openmausbot-teams/FORMAT.md` | 1 file Markdown + YAML frontmatter (vai trò, phòng, playbook, kết nối, routine tạm dừng). Xuất: bot + instruction + skill (chỉ SKILL.md) + routine; KHÔNG chat/key/model/computer; secret quét và thay bằng marker. Nhập: cộng thêm, bot mặc định quyền mặc định, skill TẮT, routine TẠM DỪNG. |
| Điều khiển ngoài | `headless-cli.md`, `mcp-server.md` | CLI `openmausbot run/wait/send/interrupt --tree/export/team apply`; exit code có nghĩa (3 = cần người trả lời, 4 = hết giờ nhưng việc vẫn chạy). MCP có mặt phẳng điều khiển CÓ GIỚI HẠN: không cấp approval, không xoá, không đụng credential. |
| Kiểm chứng | `docs/verification/README.md`, `evals/` | Luôn khởi fixture cô lập (data dir tạm, port tự chọn), cấm xác minh mutation trên app thật; engine giả có kịch bản (`server/testing/fake-*-cli.ts`); golden replay từ thread thật đã redact + leak scan; "đánh giá harness, không đánh giá model". |
| Giám sát | `docs/sentinel.md` | Quét read-only ngoài tiến trình, nhóm lỗi theo chữ ký (hash tool + lỗi đã chuẩn hoá, bỏ path/số/UUID/URL) => `issues.jsonl` không chứa nội dung thô. Không gọi model. |
| Input không tin cậy | `bot-api.ts`, `bot-api-fence.ts` | Chữ từ ngoài vào model dưới dạng `[UNTRUSTED BOT API MESSAGE]`, `defuse`, chạy confined + Ask, không tool nào ngoài hooks. |

### Những gì OpenMausBot TỰ nói là khó (bài học thật)

1. Contract mở đầu: nó thay "hai hệ thống delegation, sáu đường đánh thức, hàng chục đồng hồ và mười kiểu ghi chữ tin cậy" mà server đã tự đẻ ra. Họ trả giá bằng 5 PR để hợp nhất. => Bài học: **bắt đầu bằng MỘT vòng đời và MỘT đường đánh thức**.
2. Agents tool bridge (`find_tool/use_tool`): đo 6 lượt thật, tiết kiệm ~13k token nhưng thêm 1 lượt gọi model => hoà vốn; để TẮT mặc định. => Bài học: đo trước khi tối ưu.
3. Fan-out là chi phí chính (chú thích `EVERYONE_ON_THE_MAP`).

## 2. AntiFan hiện tại (đã kiểm chứng)

- Leader (một phiên OMP) điều phối worker (mỗi worker = 1 terminal PTY chạy OMP) bằng `terminal.create/write` + script `scripts/leader/*`.
- Vòng đời job (`leader-job.mjs`): `open -> dispatched -> settled/reported -> verified -> user-approved -> closed`, lưu `job.json` (schema `leader-job/1`) trong `E:/Work/scratch/leader/<yymmdd-hhmm>-<slug>/`. Loại job **cứng là feedback** (host `Taiz`, cột sheet, `leader-job.mjs:22,441-450`).
- Trạng thái chạy: `runtime/runs/<terminal>.json` do hook `run-state.ts` ghi (heartbeat 15s, stale 45s), registry `leader-terminals.json`, event log `leader/<leader>-events.jsonl` (`fleet-watch`), audit edit `.antifan/edit-guard/<ompSessionId>.jsonl`.
- Leader biết worker xong bằng `wait-workers --mine` / `leader-job wait-any` (fs.watch + tick 2s).
- Worker -> Leader giữa chừng: **đã có một phần, có kiểu ở cuối lượt**. Mid-run: worker đổi dòng 1 file report thành `STATUS: NEEDS_INPUT` (+ một dòng lý do), `fleet-watch` thấy trong ~2s (`worker-header.md` mục 8, `fleet-watch.mjs:28`). Cuối lượt: `report.mjs:16,146-153` bắt buộc khối JSON `needsInput {question, options 2-3}`; `leader-job.mjs:810` đặt `state=needs_input`; exit code 5; `pendingAskOf` đọc hộp `ask` của worker (`leader-job.mjs:656`). Chưa có: `default` cho câu hỏi, ghi câu trả lời (ai trả lời, quote do harness sinh) vào bản ghi, và cấu trúc JSON ở mid-run (dòng 1 chỉ là chữ tự do). Worker -> worker: **không có**. Mailbox: **chưa làm** (chỉ là thiết kế 29/10).
- Guard: `leader-guard.ts` (session_stop chặn khi còn job, `REFUSED_LEADER_*`, ngân sách điều tra 4, fail-open), `edit-guard.ts` + `theme-push-policy.ts` (REFUSED_THEME_*; push sau `hrv theme info -j` khớp bound id, bắt buộc `--nodelete`).
- Đã grep lại (09/11): trong đường điều phối Leader/worker (`scripts/leader`, `src/omp-hooks`, `src/main/leader`) không có đọc cost (`usage.cost|cost.total|max-cost|totalCost|tokenUsage`: 0 khớp), không có giới hạn số vòng/retry (chỉ có ngân sách điều tra 4 và các cửa stall/undelivered). LƯU Ý: `scripts/goal/` (runner soak/ladder + supervisor + `thresholds.mjs` ngưỡng đóng băng + `drift.mjs` + `health.mjs`) CÓ ngưỡng và chống vòng lặp (3 lần verify fail liên tiếp, heartbeat, lease mutex, disk/RSS), nhưng là bộ chạy kiểm thử không người trông, và grep xác nhận đường Leader không import module nào của nó. Test: đã có test mức file với run file giả (`leader-wait`, `worker-liveness`, `fleet-watch`, `run-state-hook`, `leader-guard`; `judgeLiveness` nhận `now` tiêm được); thiếu kịch bản đầu-cuối + bất biến máy kiểm. Vẫn chưa có: chạy-lại-có-kiểm-outward.
- UI: chỉ có run card theo terminal (`standalone.js:7416`, `contracts.ts:985`); không có bảng job/ticket, không có UI team/room.
- Ghi nhận quan trọng: OMP 
  - có `registerTool` cho extension (`omp://extensions.md`), và AntiFan đã có extension gắn vào phiên PTY (`run-state.ts` dùng `pi.on(...)`, `pi.sendUserMessage(..., {deliverAs:"steer"})`, thư mục control `runtime/runs/control/<ompSessionId>/`);
  - có `--mode rpc` (JSONL stdio: `prompt/steer/follow_up/abort/get_state/get_session_stats`, `set_host_tools`, `prompt_result`, `session_settled`) và cờ `--max-cost`, `goal` với `token_budget` (`omp://rpc.md`, `omp --help`).
  => AntiFan KHÔNG cần fork để có kênh có kiểu worker<->Leader; cần tool + ledger.

## 3. Thử thách (framework Xia) và ma trận quyết định

### Câu hỏi phổ quát

| Câu hỏi | Trả lời |
|---|---|
| Cần tính năng hay chỉ cần ý tưởng? | Chỉ cần ý tưởng + 4 cơ chế cụ thể (ledger, wake lane, envelope/evidence, guard). Không cần chat-app. |
| Có cách đơn giản hơn không? | Có: giữ PTY + job.json, thêm tool `ask_leader`. Nhưng đó là thu hẹp phạm vi so với mong muốn "trao đổi qua lại như Team" => phải do anh quyết (xem câu hỏi cuối). |
| Đã có phần chồng lấn? | Có: job.json (ledger thô), run-state (liveness), fleet-watch (wake lane nửa vời), leader-guard (guard), edit-guard audit (evidence thô). |
| Ai sở hữu sau khi nhập? | Một mình anh (solo). Fork 7.6k file = gánh nặng bảo trì không ai gánh. |
| Chuỗi phụ thuộc? | Fork: Electron riêng + Node 24 + pnpm + Boat/Composio/Cloud + driver mới cho OMP. Học thiết kế: không thêm phụ thuộc runtime (node:sqlite có sẵn Node 24; dưới Bun [INFERENCE] chưa xác minh). |

### Ma trận kiến trúc (cờ đỏ/xanh)

| Câu hỏi | OpenMausBot | AntiFan | Kết luận |
|---|---|---|---|
| Kiến trúc khớp? | Harness SỞ HỮU tiến trình agent, nói stream-JSON/ACP, UI là chat | AntiFan SỞ HỮU terminal PTY có người nhìn + browser tab; agent là OMP TUI | ĐỎ nếu fork (khác mô hình sở hữu tiến trình) |
| Coupling | Runtime tách sạch qua cổng `TurnRunner` (đọc 807 dòng không import UI) | Script + hook + registry rời rạc | XANH để **mượn thiết kế** lõi runtime |
| Blast radius | Fork chạm toàn app | Port lõi nằm trong `scripts/leader` + 1 hook | Port: cô lập |
| Mẫu mới? | Cần SQLite + tick loop | Có thể bắt đầu bằng JSONL append-only + invariant checker | XANH |
| Scale | Hàng chục bot, SaaS/Team Cloud | 1 Leader + 5–10 worker | Không cần phần multi-tenant |

### Quyết định

| # | Quyết định | Cách của OpenMausBot | Cách của AntiFan | Khuyến nghị |
|---|---|---|---|---|
| 1 | Fork hay học | Cả app | Điều phối rời rạc | **KHÔNG fork; học + port có chọn lọc** |
| 2 | Chất nền worker | Headless CLI do harness sở hữu | PTY nhìn thấy được | **Giữ PTY** (người xem được, đã có hook); thêm tool qua extension. Chỉ cân nhắc `omp --mode rpc` cho worker không cần xem (QA/Reviewer chạy đêm) |
| 3 | Bản ghi việc | `Assignment` + events + inbox (SQLite) | `job.json` cứng loại feedback | Tổng quát hoá: `kind` + `payload` (feedback là 1 payload). Bắt đầu JSONL append-only + `replayStatus`; chuyển SQLite nếu cần truy vấn |
| 4 | Kênh worker -> Leader | `NEEDS INPUT:` + `Default:` thành thẻ; cha được đánh thức ngay | Đã có: dòng 1 `NEEDS_INPUT` mid-run + JSON `needsInput{question,options}` cuối lượt + exit 5 | **Mở rộng, không thay**: thêm `default`, bản ghi câu trả lời (`answeredBy`, quote do harness sinh), JSON có kiểu ngay mid-run (tool `ask_leader`) thay vì chữ tự do ở dòng 1 |
| 5 | Đường đánh thức | Inbox duy nhất, đúng 1 wake/kết quả | 3 cơ chế (wait-any, wait-workers, terminal.wait) | Hợp nhất về inbox; `fleet-watch` thành bộ ghi event vào cùng ledger |
| 6 | Phong bì | Harness viết, escape, 3 mức quyền | Header worker (Markdown tĩnh, tiếng Việt) | Giữ header; thêm khối provenance do code sinh + **khung dữ liệu không tin cậy cho chữ của khách** (xem 4.) |
| 7 | Bằng chứng | Quan sát của harness, outward actions | `notChecked` do worker tự khai | Hook ghi `filesChanged/commands/outward (hrv push, wrangler)` từ `tool_result` + audit; Leader đối chiếu thay vì tin report |
| 8 | Ngân sách | requests/executions/wakes, stall monotonic, 2-strike/3-same-error | Gần như không | Thêm ngân sách theo job + `--max-cost` cho worker |
| 9 | Chạy lại sau chết | 1 lần, không nếu đã outward | `worker_dead` thủ công | Áp quy tắc "đã push thì không chạy lại" (có audit sẵn) |
| 10 | Sự cố -> điều phối viên | Code báo, LLM quyết, trần retry | Leader tự theo dõi | Giữ Leader; mượn TRẦN (retry<=2, mute) và nhãn "dữ liệu, không phải chỉ thị" |
| 11 | Phòng/@mention/group chat | Có | Không | **Không port** (fan-out đắt, chính họ giới hạn) |
| 12 | Decision model routing | Jev/Clef | Leader định tuyến theo shop->project bằng code | **Không port** |
| 13 | 4 mức approval | ask/edits/auto/full | Hook (edit-guard, push policy) | **Không port**; AntiFan đã có kiểu mạnh hơn cho domain theme |
| 14 | Team = file Markdown | `.md` + frontmatter | Chưa | Hoãn; làm sau khi ledger ổn; dùng cho roster Scout/Dev/Reviewer/QA/Ops/CSKH |
| 15 | Test | Engine giả có kịch bản + invariants + golden replay | Test hook/guard, không có OMP giả | **Port ý tưởng**: `fake-omp` phát event run-state theo kịch bản |
| 16 | Giám sát | Sentinel (chữ ký lỗi) | edit-guard audit + refusal code | Port nhẹ: nhóm theo `REFUSED_*` + lỗi tool chuẩn hoá từ audit/session JSONL |

### Điểm rủi ro

Tính trên PHƯƠNG ÁN FORK: (1) khác mô hình sở hữu tiến trình; (2) 7.6k file + Electron + dịch vụ ngoài => bảo trì; (3) cần viết driver OMP; (4) upstream đổi hàng ngày (865 issue mở); (5) UI chat không phục vụ domain theme. => **5 critical = HIGH => không fork.**

Tính trên PHƯƠNG ÁN PORT THIẾT KẾ: (a) chưa chứng minh `pi.registerTool` hoạt động trong phiên PTY với danh tính worker từ env [INFERENCE từ doc, chưa chạy]; (b) đổi đường đánh thức đụng `leader-guard.session_stop` + 3 script đang chạy production (rủi ro hỏng quy trình feedback đang dùng); (c) chọn kho (node:sqlite vs JSONL) vì hook chạy trong OMP (Bun) [INFERENCE]. => **3 critical = MEDIUM: giải quyết trước bằng spike nhỏ rồi mới plan.**

## 4. Điều học được xếp theo giá trị cho AntiFan

1. **Chữ của khách là dữ liệu không tin cậy** (rẻ nhất, rủi ro an ninh thật). Dashboard feedback `message`/`devNote` đi thẳng vào `task.md` của worker, worker có quyền `hrv theme push`. OpenMausBot bọc `[UNTRUSTED ...]`, `defuse`, escape mọi mẫu giả phong bì. Làm trước, độc lập với phần còn lại.
2. **Bằng chứng do harness quan sát > lời tự khai**. `run-state.ts` đã thấy `tool_call/tool_result`, edit-guard đã audit file. Thiếu chỉ là gom thành `evidence` + "outward actions" và để Leader/QA đối chiếu.
3. **Ledger một-bản-ghi + events + bất biến** thay cho 3-4 nguồn trạng thái rời nhau; nhờ đó mới có bảng board/ticket, mới tính được cost và mới test được bằng kịch bản.
4. **Hoàn thiện kênh hỏi-đáp có kiểu** (AntiFan đã có `needsInput{question,options}` + exit 5; thiếu `default`, bản ghi trả lời có nguồn, và cấu trúc mid-run). Đây là phần gần nhất với "trao đổi qua lại" anh muốn, và nó KHÔNG cần worker-nói-chuyện-với-worker: OpenMausBot cũng chỉ cho cha<->con (độ sâu tối đa 4), bot-với-bot chỉ là `consult`/`notify`.
5. **Ngân sách + guard chống vòng lặp + trần retry**: rẻ, đã có số liệu chuẩn để chép.
6. **Chạy lại có điều kiện outward** cho worker chết giữa lúc push.
7. **Test không tốn tiền**: engine giả + golden replay + kiểm bất biến. Một lượt worker ~ $1.18 (Opus), phiên mới ~ $0.40; test hermetic là cách duy nhất để lặp nhanh trên Leader.
8. **Sentinel** nhóm lỗi để biết refusal nào lặp (nhẹ, không gọi model).
9. Sau cùng: Team-as-file, `--max-cost`/cost board, UI board (2D trước, 3D cuối), `omp --mode rpc` cho worker không cần xem.

### Không nên học
Rooms/@mention; decision-model routing; chat-app UI; Composio/Boat/voice/Cloud/Enterprise; agents-tool-bridge; mức approval 4 nấc; "mọi bot đều gặp được mọi bot" (AntiFan: topology tối giản Leader -> worker).

## 5. Phác thảo pha (CHƯA phải plan; `/ak-plan` sẽ chi tiết hoá)

| Pha | Việc | Kiểm chứng |
|---|---|---|
| S0 spike (≈0.5 ngày) | Trong 1 worker PTY thử: `pi.registerTool(ask_leader)` trong extension, danh tính từ env, ghi 1 record, nhận trả lời qua `steer`. Đo: tool có hiện ở worker? lượt có kết thúc sạch? | Chạy thật 1 worker trên project nháp, đọc file record + transcript |
| P1 | Chữ không tin cậy cho `task.md` (khung + defuse) | Test đơn vị + 1 feedback giả chứa lệnh chèn |
| P2 | Ledger (`assignments/events/inbox`), `kind+payload`, checker bất biến, adapter đọc `job.json` cũ | `node --test` + replay |
| P3 | Evidence từ hook + report đối chiếu; ngân sách + 2-strike; rerun-once-unless-outward | Fake-OMP kịch bản |
| P4 | `ask_leader`/`answer` + inbox thay `STATUS: NEEDS_INPUT` dòng 1 (giữ tương thích 1 phát hành) | Fixture + 1 job thật |
| P5 | Cost theo assignment (join `ompSessionId` -> session JSONL) | So với `usage.cost` thật |
| P6 | Board chỉ-đọc trong run card/panel | Chụp UI thật |
| P7+ | Roster vai trò (Scout/Dev/Reviewer/QA/Ops/CSKH), team-as-file, 3D | — |

Mỗi pha ship riêng, không đổi hành vi quy trình feedback đang dùng cho tới P4.

## 6. Việc chưa kiểm (ghi rõ để không nói quá)

- Chưa chạy OpenMausBot, chưa thử fixture của nó; mọi nhận định là từ đọc source/docs.
- Chưa đọc hết `runtime-coordinator.ts` (700 dòng), `store.ts` chi tiết SQL, `group-goal-run.ts` (chỉ đọc đầu), `docs/memory.md`, `approval-levels.md`.
- `pi.registerTool` trong phiên PTY AntiFan: [INFERENCE], cần S0.
- Bun có `node:sqlite` hay không: [INFERENCE], chưa kiểm.
- "Worker board" trong AntiFan: scout không tìm thấy trong `src/`; có thể nằm ngoài `src/`.
