# Báo cáo cuối: AntiFan cần cải thiện gì (rút từ OpenMausBot)

- Ngày 2026-11-09. Nguồn: `milind-soni/OpenMausBot` @ `1de1164d5040d8699f55e0907552270bd9fbd38f` (Apache-2.0, bỏ `enterprise/`). Bản clone chỉ đọc: `E:/Work/scratch/OpenMausBot`.
- Thay thế phần "khuyến nghị" của `261109-xia-openmausbot-team-coordination.md` (bản đó vẫn đúng về giải phẫu nguồn, nhưng có 3 chỗ phải sửa, xem mục 1).
- Phạm vi đọc: lõi `server/runtime/*` (types, runtime, store, envelope, tree, invariants), `runtime-coordinator.ts`, `incidents.ts`, `escalations.ts`, `chief-of-staff.ts`, `same-request.ts`, `status-reply.ts`, `questions.ts`, `group-goal-run.ts`, `room-post-budget.ts`, `peer-provenance.ts`, `bot-api*.ts`, `docs/` (runtime-contract, memory, steer-vs-queue, aside-injection-seams, bot-concurrency, goal-mode-v2, team-*, sentinel, headless-cli, verification, evals). Phía AntiFan đọc trực tiếp: `scripts/leader/*` (leader-job, fleet-watch), `src/omp-hooks/run-state.ts`, `leader-guard.ts`, `templates/worker-header.md`, `skills/antifan-leader/references/leader-discipline.md`, `scripts/goal/*`, `scripts/lib/atomic-record.mjs`, 2 scout đọc `src/`.
- Chưa đọc hết: `approval-levels.md`, `team-cloud.md` (chỉ lướt), SQL chi tiết của `store.ts`, code `canStart` của OpenMausBot (chỉ có doc).

## 1. Sửa so với bản báo cáo trước (để không tin nhầm)

| Bản trước nói | Thực tế sau khi đọc kỹ hơn | Hệ quả |
|---|---|---|
| OpenMausBot ghi `filesChanged`, `commands` làm bằng chứng | `TurnEvidence` có field `commands`/`filesChanged` nhưng scout không thấy chỗ nào điền chúng (`turn-outcome.ts:96-125`). Thực sự điền: số tool call, số ok, 3 lỗi cuối, nhãn "outward" (regex `git commit/push`, `pay/charge/refund`) [scout: INFERENCE cho "không có producer"] | AntiFan có THỂ làm tốt hơn: edit-guard đã audit file, `theme-push-policy` đã parse lệnh hrv |
| Ledger bắt đầu bằng JSONL | Nhiều tiến trình cùng ghi (CLI Leader, hook trong nhiều OMP, main process). JSONL không có transaction nhiều bản ghi, không có chỉ mục "chỉ dòng live", cần khoá file; OpenMausBot dùng SQLite WAL + `BEGIN IMMEDIATE` đúng vì thế | Khuyến nghị đổi thành **SQLite**. Đã kiểm: `node:sqlite` chạy trên Node v24.13.0 (có ExperimentalWarning) và Bun 1.4.3 của hệ thống. Chưa kiểm Bun nhúng trong OMP |
| `pi.registerTool` trong phiên PTY là suy đoán | `omp://hooks.md`: hook trong `~/.omp/agent/hooks/pre|post/*.js` được nạp như extension và nhận `ExtensionAPI`; `omp://extensions.md` có `pi.registerTool`. Run-state hook hiện đã dùng `pi.on` + `pi.sendUserMessage` | Từ "suy đoán" thành "có tài liệu, chưa chạy". Vẫn cần spike |
| AntiFan "chưa có typed needs_input" | Đã có một phần (`report.mjs:146-153`, exit 5, `pendingAskOf`). Đã sửa ở bản trước | Chỉ thiếu `default`, bản ghi người trả lời, cấu trúc mid-run |
| (bỏ sót) | AntiFan có `scripts/goal/` = bộ chạy kiểm thử không người trông (phase/unit, checkpoint sau mỗi unit, supervisor tách tiến trình, mutex có lease, `thresholds.mjs` đóng băng + digest, `health.mjs` abort sau 3 verify fail liên tiếp, `drift.mjs` phát hiện nới lỏng tiêu chí chấp nhận). Grep xác nhận đường Leader/worker (`scripts/leader`, `src/omp-hooks`, `src/main/leader`) KHÔNG import module nào của `scripts/goal/` hay `scripts/lib/` | Không phải "port từ OpenMausBot": là **tái dùng cơ chế sẵn có** cho ngân sách/guard (mẫu `THRESHOLDS` + `FROZEN_KEYS` + digest; `atomic-record.mjs`; `process-identity.mjs`; ý tưởng `drift.mjs` cho `doneWhen`/`notChecked`). Phần runner/ladder không dùng được cho LLM worker |
| "Leader đọc ~61 KB trước mỗi lần giao" | SỬA: có HAI bản `antifan-leader`. Bản repo `skills/antifan-leader/SKILL.md` 34.6 KB (93 dòng) ghi "REQUIRED" đọc `references/leader-discipline.md` (26.5 KB) và `feedback-case.md` (17.9 KB). Bản đã cài `~/.omp/agent/managed-skills/antifan-leader/SKILL.md` chỉ 7.9 KB (69 dòng), đây là bản phiên của tôi nạp. `install-managed-skills.mjs --check` (chỉ đọc): `STALE` ở `SKILL.md` và `references/leader-discipline.md`, `MATCH` ở `feedback-case.md`. Bản đã cài có phần Sapo 09/11 mà bản repo không có (grep xác nhận), nên `--install` có thể GHI ĐÈ nội dung mới hơn | Số đã đo: nạp đầu phiên ≈ 7.9 KB (bản cài); 26.5 KB discipline chỉ đọc khi được trỏ tới. Bản cài KHÔNG nhắc `leader-discipline` (grep: 0). Chưa chứng minh Leader thực tế nạp bản nào khi chạy trong repo. Xem F0 |

### Bảng tổng hợp: đã có / thiếu thật

| Hạng mục | Đã có (bằng chứng) | Thiếu thật |
|---|---|---|
| Hoàn tất / giao nhận | `settleVerdict` (`leader-job.mjs:590`), `delivery: started\|pending\|not_running`, `undeliveredWhy` 90s, `judgeLiveness` (pid, heartbeat 45s, mtime transcript kể cả subagent) | Biên nhận tường minh (`dispatchId` ack/turn_result); hiện suy từ idle+runSeq+thời gian |
| Đánh thức Leader | `wait`, `wait-any`, `wait-workers --mine`, ledger sự kiện `fleet-watch`, `session_stop` block | Một đường đánh thức; inbox idempotent; chưa dùng `reason` của `session_stop` để đưa sự kiện |
| Hỏi-đáp worker→Leader | `STATUS: NEEDS_INPUT` dòng 1 (~2s), JSON `needsInput{question,options}` cuối lượt, exit 5, `pendingAskOf` | `default`, ghi ai trả lời, cấu trúc mid-run, `onlyUser` bằng code |
| Lưu trữ | `job.json` nguyên tử, `atomic-record.mjs`, registry, run file, events jsonl, audit edit-guard | Một ledger/vòng đời; `job.json` cứng loại feedback |
| Ngân sách / chống lặp (Leader) | Ngân sách điều tra 4; commit-headroom gate; stall 90 phút | Giới hạn vòng/tái chế/chi phí; REFUSED_* lặp; `THRESHOLDS` đóng băng cho đường Leader (mẫu có ở `scripts/goal/`) |
| Ngân sách / chống lặp (soak) | `scripts/goal/*`: 3 verify fail → abort, heartbeat, lease, disk/RSS, drift | Không áp dụng cho Leader (chưa nối) |
| Bằng chứng | edit-guard audit (file), `run-state` (`lastTool`), `verify-sheet`, `record` | Đối chiếu `report.files/pushed` với quan sát; outward có kiểu |
| Chạy lại an toàn | `worker_dead`, `closeNow`, close gate | Rerun-once-unless-outward bằng code |
| Chi phí | Số đo tay (≈1.18 USD/lượt, ≈0.40 USD phiên mới) | Đọc cost theo job; `--max-cost` |
| Test | Test mức file ≈5.2k dòng (`leader-job` 1190, `run-state-hook` 1108, `leader-guard` 834, `fleet-watch` 416, `leader-wait` 241...), run file giả, `now` tiêm được ở `judgeLiveness` | Kịch bản đầu-cuối có worker giả; kiểm bất biến sau mỗi kịch bản; `init` dùng `Date.now` trực tiếp (nguồn flake `62122cae`) |
| Chữ khách / cổng Done | `guard` host/shop/id trong prompt, close gate ở ledger | Khung untrusted; token một lần; chặn `quickUpdate Done` ở hook (grep: 0) |
| Hai bản skill | Công cụ `install-managed-skills.mjs --check` | Hai bản đang lệch; chưa có một nguồn sự thật |

## 2. Phát hiện lớn nhất: 18 quy tắc "kỷ luật Leader" là 18 sự cố, và OpenMausBot chặn đa số bằng cấu trúc

`skills/antifan-leader/references/leader-discipline.md` §5 có 18 mục đánh số (26.5 KB trong bản repo). Mỗi mục là một sự cố thật. Đối chiếu:

| Sự cố AntiFan (ngày) | Gốc rễ | AntiFan chặn bằng | OpenMausBot chặn bằng | Cải thiện |
|---|---|---|---|---|
| #1 Leader kết thúc lượt khi worker còn chạy (30/10) | Không ai theo dõi worker | `session_stop` block (code, `leader-guard.ts:910`) | Runtime đánh thức requester (inbox) | Giữ gate; thêm: đưa inbox vào `reason` của `session_stop` để Leader khỏi phải nhớ chạy `wait-any` |
| #5 push live cần duyệt | Chính sách đổi 3 lần trong 2 ngày | Hook theo `hrv theme info -j` | Level rule 1 dòng `max(own, inherited)` | Ổn, đã là code |
| #7/#15 worker rò, không đóng | Đóng trạng thái ở nhiều nơi | `close` từ chối khi còn terminal (code) | Invariant I1 (không node vô chủ) | Ổn; chuyển thành invariant kiểm máy |
| #16 follow-up không tới OMP, trạng thái vẫn `idle` ~15 phút (04/11) | Hoàn tất/giao nhận được SUY RA từ idle+runSeq+mtime, không có biên nhận | `delivery` + `undelivered` sau 90s (suy luận theo thời gian) | `steer()` ba trạng thái steered/refused/**indeterminate**; indeterminate KHÔNG BAO GIỜ gửi lại; id tin nhắn làm khoá dedupe | **Biên nhận tường minh** (xem B1) |
| #17 Esc làm bẩn bộ nhớ dòng của cổng | Phím điều khiển đi chung kênh với chữ | `key/keys` (code) | Không có PTY | Ổn |
| #18 waiter danh sách cố định bỏ sót worker; `EXECUTION_UNCERTAIN` không đọc lại | Nhiều cơ chế chờ | `--mine` + `close-worker` đọc lại (code) | MỘT đường đánh thức, `markDelivered` idempotent trong cùng transaction với dispatch | Hợp nhất (B3) |
| #2 "đừng tin report" | Lời tự khai | `verify-sheet`, `record` (code) | Evidence do harness quan sát + câu cố định "lời tự kể, không phải xác minh" | Thêm evidence đối chiếu (D1) |
| #3 số dòng dịch | Định danh sai | guard `host/shop/id` bắt buộc trong prompt (code kiểm chuỗi) | — | Ổn |
| #6 `force:true` | Rủi ro race | Chỉ là chữ trong doc | Tri-state steer | Mã hoá thành quy tắc (B2) |
| #11/#12 "tự quyết, đừng hỏi" | Chỉ là lời nhắc | Prose | `Default:` + requester quyết ở level full | `default` có kiểu trong needs_input (B1) |

Kết luận: phần AntiFan đã chuyển sang code (close gate, session_stop, push policy, `--mine`) là đúng hướng; phần còn lại (#16 biên nhận, #6 relay, #11 default) vẫn là prose hoặc suy luận theo thời gian. Đó là chỗ cần làm.

## 3. Danh sách cải thiện, xếp ưu tiên

Mỗi mục: Việc / Bằng chứng / Cách làm / Kiểm chứng / Rủi ro. Cỡ: S nhỏ, M vừa, L lớn.

### P0 — an ninh và đúng đắn (làm trước, độc lập nhau)

**F0. Một nguồn sự thật cho skill Leader (trước mọi việc khác chạm vào luật Leader).** (S)
- Bằng chứng (đã chạy, chỉ đọc): `node scripts/install-managed-skills.mjs --check` → `antifan-leader STALE (3 file, 2 differ)`: `SKILL.md` và `references/leader-discipline.md` lệch, `feedback-case.md` khớp. Bản đã cài là 69 dòng/7.9 KB, bản repo 93 dòng/34.6 KB; bản cài có phần Sapo 09/11 trong `leader-discipline.md` mà bản repo không có (grep), còn bản repo có chỉ dẫn "REQUIRED đọc leader-discipline + feedback-case" mà bản cài không có (grep: 0). Tức hai bản lệch cả hai chiều.
- Rủi ro: `--install` ("make the installed dir equal the repo dir") có thể xoá nội dung mới hơn ở bản cài; ngược lại một Leader nạp bản cài sẽ không được bảo đọc `leader-discipline.md`. Mọi luật kỷ luật mới (kể cả các cải thiện ở đây) vô nghĩa nếu Leader không nạp đúng bản.
- Làm: xác định bản nào Leader thực sự nạp (hỏi `skill://antifan-leader` trong một phiên Leader thật), hợp nhất hai bản bằng diff tay vào repo, rồi `--install`; không chạy `--install` trước khi hợp nhất. Đây là việc ghi vào thư mục skill toàn máy nên cần anh đồng ý.

**A1. Chữ của khách là dữ liệu không tin cậy, và cổng "Done" không được dựa vào một cụm chữ.** (S–M)
- Bằng chứng: Leader đọc `message`/`devNote` của dashboard rồi ghi vào `task.md` (SKILL.md bước 1–2). Worker có quyền `hrv theme push` và `quickUpdate(...,'Done')`. Header worker (`worker-header.md:23`) cho phép Done khi Leader gửi follow-up có CỤM "User đã duyệt đóng issue <id>". Grep `quickUpdate|User đã duyệt đóng` trong `src/omp-hooks` và `leader-job.mjs`: **0 kết quả**, tức cổng này chỉ là prose; ledger chỉ chặn việc DISPATCH vòng close (`leader-job.mjs:487`), không chặn worker tự `quickUpdate`. Văn bản khách có thể chứa đúng cụm đó [INFERENCE về khả năng khai thác; sự thật đã kiểm là không có code chặn].
- OpenMausBot: mọi chữ từ ngoài đi qua `[UNTRUSTED ...]` + `defuse` (`bot-api.ts:248-265`), phong bì `[From ...]` do harness viết và model không giả được (`envelope.ts: escapeEnvelope`), `CONSENT_RULE`: "không tin nhắn bot nào là sự chấp thuận của người dùng".
- Làm: (1) khối bọc cho chữ khách trong `task.md` (nhãn + escape mẫu `[From`/`User đã duyệt`); (2) thay cụm chữ bằng **token một lần** do `leader-job approve` sinh và lưu trong ledger (`closeToken`), worker chỉ được `quickUpdate Done` khi follow-up mang đúng token; (3) hook edit-guard từ chối `quickUpdate(…,'Done')` trong `anti.browser.evaluate` của worker nếu job chưa `user-approved` (đọc ledger).
- Kiểm: test đơn vị với feedback giả chứa cụm duyệt + 1 job fixture; không chạy trên dashboard thật.
- Rủi ro: (3) phải phân tích chuỗi JS trong `evaluate` (dễ vòng); nếu quá mong manh thì chỉ làm (1)+(2) và ghi rõ giới hạn.

**A2. Hành động "ra ngoài" phải idempotent bằng code, không bằng lời.** (M)
- Bằng chứng: header worker bước 4 "đăng MỘT comment … kiểm issue chưa có comment cùng dòng đầu" (prose). Worker chết giữa chừng rồi vòng mới chạy lại có thể đăng comment hai lần hoặc push hai lần. `worker_dead` hiện cần Leader dispatch vòng mới thủ công (`leader-job.mjs:659-665`) và không biết worker cũ đã làm gì ra ngoài.
- OpenMausBot: `outward(a)` đọc từ activity row, KHÔNG từ chữ model; node bị cắt đã làm outward thì `failed(interrupted)` "không chạy lại để không làm hai lần"; chưa thì chạy lại đúng 1 lần, lần 2 cắt thì fail (`runtime.ts:89-121`, `CUT_TWICE`).
- Làm: hook ghi sự kiện outward có kiểu vào ledger khi `tool_result` thành công: `hrv theme push` (theme id, file) — `theme-push-policy.ts` đã parse đúng lệnh này; `wrangler deploy`; ghi dashboard. Vòng mới của job nhận "đã làm ra ngoài: …" vào prompt và Leader bị cấm chạy lại bước đó.
- Kiểm: fixture worker giả chết sau push; kiểm vòng 2 nhận danh sách outward.
- Rủi ro: nhận diện ghi dashboard qua `anti.browser.evaluate` là mong manh; bắt đầu bằng push/deploy (chắc chắn).

### P1 — nền tảng (đổi cách AntiFan lưu và đánh thức)

**B1. Biên nhận tường minh thay cho suy luận từ idle.** (M)
- Bằng chứng: `settleVerdict` suy "xong" từ `state idle|ended` + `lastEventAt > dispatchedAt` + `runSeq` (`leader-job.mjs:590-599`); "chưa nhận prompt" suy từ 90s không có run (`worker-liveness.mjs`, `UNDELIVERED_AFTER_MS`). Sự cố 04/11 là đúng chỗ này hỏng. OpenMausBot: `run()` trả kết quả có kiểu, `steer` ba trạng thái, id tin nhắn làm khoá dedupe và dấu trong transcript để phục hồi sau restart không chèn lại (`aside-injection-seams.md` L21-24).
- Làm: mỗi lần giao có `dispatchId` ghi vào prompt. Hook `before_agent_start` (đã thấy `promptHead`) ghi `ack(dispatchId)`; `agent_end` ghi `turn_result(dispatchId, ok|error)`. "Đã giao" = có `ack`, "xong" = có `turn_result` khớp. Thời gian chỉ còn dùng để phát hiện chết, không để suy ra trạng thái. Map `terminal.write.delivery` vào ba trạng thái: `started` = steered, `not_running` = refused (an toàn gửi lại), `pending` = indeterminate (KHÔNG tự gửi lại, quy tắc #16 thành code).
- Kiểm: fake-OMP phát kịch bản "nuốt tin nhắn"; kiểm không có lần gửi hai.
- Rủi ro: hook đã chạy trong mọi OMP nên chỉ cần mở rộng `run-state.ts`; phải theo `hookOutdated` (cơ chế đã có) khi triển khai.

**B2. Một ledger, một vòng đời, một đường đánh thức.** (L)
- Bằng chứng: trạng thái nằm ở 5 nơi: `job.json` (cứng loại feedback, `HOST="Taiz"`, `leader-job.mjs:22`), `runtime/runs/*.json`, `leader-terminals.json`, `leader/<leader>-events.jsonl`, audit edit-guard. Ba cơ chế chờ (`wait`, `wait-any`, `wait-workers --mine`). OpenMausBot: `assignments` + `assignment_events` (append-only) + `inbox` (`delivered_at`), mỗi thay đổi một transaction, `replayStatus` dựng lại trạng thái từ event, `checkInvariants` I1–I10 chạy sau MỌI kịch bản test (`invariants.ts`).
- Làm: SQLite (`node:sqlite`, WAL, `BEGIN IMMEDIATE`, bản ghi có `version`, schema validate khi đọc, chú ý zod/validator không để rơi field lạ). `kind`+`payload` (feedback là một payload; scout/QA/ops là payload khác). `job.json` cũ đọc qua adapter một phiên bản rồi thôi. Prune cả cây, không xoá lẻ. Hook CHỈ ghi file sự kiện nhỏ nguyên tử (mẫu `atomic-record`), CLI một-người-ghi nhập vào ledger — tránh hook trong Bun của OMP phụ thuộc SQLite.
- Cần quyết định: chỗ đặt DB (`.antifan-data/leader/ledger.db`) và ai là writer.
- Kiểm: `node --test` với đồng hồ tiêm được; replay; invariant checker.
- Rủi ro: lớn nhất của cả kế hoạch vì chạm 3 script đang chạy production. Bắt buộc chạy song song với `job.json` cũ một thời gian (ghi đôi, đọc cũ) cho tới khi bất biến sạch.

**B3. Hộp thư "Cần anh" có kiểu, mid-run.** (M)
- Bằng chứng: mid-run chỉ là dòng 1 chữ tự do (`worker-header.md:61`); JSON `needsInput` chỉ có ở cuối lượt. Thiếu `default`; câu trả lời của Leader đi qua `terminal.write` không được ghi ai trả lời. OpenMausBot: `NEEDS INPUT:` + `Default:`; cha đang chờ được đánh thức NGAY khi con hỏi (`runtime-contract.md` §2); `personOnly` (đăng nhập, 2FA, thanh toán, secret) luôn về người, bot không được trả lời thay (`questions.ts`).
- Làm: tool `ask_leader{question, options[2-3], default, onlyUser?}` đăng ký trong hook (`pi.registerTool`), ghi sự kiện `needs_input` vào ledger. Quy tắc `personOnly` mã hoá (hrv login/OTP, push foreign theme, publish…) → luôn lên người dùng, không để Leader tự quyết. Câu trả lời `answer(id, text, by)` được harness bọc quote khi steer vào worker.
- Kiểm: S0 spike trước; sau đó fixture. Giữ dòng 1 `NEEDS_INPUT` tương thích một đợt phát hành.

### P2 — hàng rào (rẻ, số liệu chuẩn có sẵn)

**C1. Ngân sách và chống vòng lặp cho job.** (S–M)
- Bằng chứng: không có giới hạn số vòng/follow-up/dispatch trong `scripts/leader` và `leader-guard.ts` (grep `maxRounds|ROUND_LIMIT|retryBudget`: không khớp); vòng "chưa Done → follow-up mới" của SKILL.md bước 9 có thể lặp vô hạn. Chi phí đã đo: 1 lượt worker ≈ $1.18, phiên mới ≈ $0.40.
- OpenMausBot: mỗi gốc 24 request / 48 execution / 48 wake kể từ tiến triển cuối, tiến triển làm mới ngân sách; 2 lần `continue` không tool call thành công → `stalled`; cùng lỗi 3 lần → `stalled`; cùng (member, instruction) 3 lần → `blocked`; nhắc lại y hệt 3 lần → `blocked`; tối đa 13 lượt, số lẻ để lượt cuối rơi vào điều phối viên quyết định (`group-goal-run.ts`); lỗi tạm thời được thử lại đúng 1 lần, `spend_capped` KHÔNG thử lại vì tất định; stall tính bằng đồng hồ monotonic (laptop ngủ không bị tính).
- Làm: **tái dùng** mẫu `scripts/goal/thresholds.mjs` (`Object.freeze` + `FROZEN_KEYS` + `assertThresholdsComplete` + digest ghi vào ledger/checkpoint) cho đường Leader; `consecutiveVerifyFailures: 3` đã là chuẩn "3 lần liền = hỏng" của chính AntiFan, khớp "cùng lỗi 3 lần" của OpenMausBot. Cân nhắc ý tưởng `drift.mjs` (phát hiện tiêu chí bị nới lỏng) để cảnh báo khi `notChecked` hoặc `doneWhen` của vòng sau yếu hơn vòng trước. Bắt đầu với: tối đa N vòng/issue (đề xuất 4), tối đa 2 lần tái chế worker/vòng, cùng REFUSED_* lặp 3 lần → NEEDS_USER. Chi phí/job chỉ đưa vào sau D2.
- Kiểm: unit test thuần (clock tiêm).

**C2. Tách số liệu "đã xảy ra" khỏi "ý định".** (S) `run-state.ts` giữ `runSeq`, `lastTool`; thêm bộ đếm `toolCalls/ok/errors(3 cuối, 200 ký tự)` đúng định dạng của OpenMausBot để so sánh được và để dùng cho C1 (no-progress).

### P3 — bằng chứng, kiểm thử, quan sát

**D1. Evidence do harness quan sát, Leader đối chiếu report.** (M)
- Làm: hook ghi `filesChanged` (từ audit edit-guard, đã có đường dẫn file), `pushed[]` (từ outward A2), `toolCalls/ok/errors`. Leader (hoặc `validate-report`) so `report.files/pushed` với evidence; lệch → cờ cảnh báo, không PASS. Giữ nguyên câu của OpenMausBot trong prompt Leader: "đó là lời tự kể, không phải xác minh; đối chiếu với cái đã quan sát; chỉ làm lại phần chưa có bằng chứng".
- Đây là chỗ AntiFan có thể vượt OpenMausBot (OpenMausBot chưa điền files).

**D2. Chi phí theo job.** (M) Chưa có gì (grep `usage.cost|cost.total|max-cost|totalCost|tokenUsage` trong `src/` và `scripts/leader`: 0). Join `ompSessionId` (có sẵn trong run file) với `~/.omp/agent/sessions/**.jsonl` (tên file kết thúc bằng id phiên theo ghi chú cũ, chưa kiểm lại), đọc tăng dần. OMP có `--max-cost` (kiểm `omp --help`: "stop sending model requests once spend reaches N USD", exit 3 ở print mode; chưa kiểm hành vi trong phiên PTY tương tác) và RPC `get_session_stats`.

**D3. Test không tốn tiền: fake-OMP + kịch bản + invariants.** (M–L)
- Bằng chứng: lõi runtime OpenMausBot ~2.6k dòng nguồn, ~4.8k dòng test (≈1.9x), kịch bản chạy trên engine giả có kịch bản và kiểm bất biến sau mỗi kịch bản; golden replay từ thread thật đã redact + quét rò rỉ. AntiFan đã có ≈5.2k dòng test cho riêng các mảnh Leader (mức file: run file giả, `now` tiêm được ở `judgeLiveness`, `leader-wait.test.mjs:158`), nên cái thiếu KHÔNG phải "test" mà là kịch bản đầu-cuối có worker giả và bất biến máy kiểm sau mỗi kịch bản. Flake `leader-job.test.mjs` (tên thư mục job `yymmdd-hhmm-slug`, vá bằng vòng retry ở commit `62122cae`) cho thấy `init` dùng đồng hồ thật; tầng liveness thì đã tiêm được.
- Làm: `fake-omp` ghi run file/phát sự kiện hook theo kịch bản (worker nuốt tin nhắn, chết giữa push, hỏi rồi chờ, hoàn tất), đồng hồ tiêm. Một kịch bản = một job feedback giả.

**D4. Sentinel nhẹ.** (S) Quét read-only `edit-guard/*.jsonl` và session JSONL, nhóm theo chữ ký (tool + lỗi đã chuẩn hoá bỏ path/số/UUID/URL, như `docs/sentinel.md`), in "top refusal lặp" mỗi tuần. Không model. Mục đích: biết header worker nào đang tạo lỗi lặp.

### P4 — thu gọn Leader và mở rộng Team

**E1. Giảm trọng lượng prompt Leader.** (S–M)
- Số đã đo: bản skill đã cài nạp đầu phiên ≈ 7.9 KB; bản repo 34.6 KB + `leader-discipline.md` 26.5 KB + `feedback-case.md` 17.9 KB đọc khi được trỏ tới; header worker 13.7 KB mỗi lần giao. Chưa chứng minh Leader thực tế nạp bản nào, nên bước đầu là F0 (một nguồn sự thật), rồi mới đo token đầu phiên trước/sau. Phiên mới tốn cache-write ≈ $0.40 (đo 29/10).
- OpenMausBot: hạn mức cứng cho prompt (MEMORY.md 200 dòng/24 KB, chỉ mục chủ đề ≤2000 ký tự), nhớ lại gắn vào TIN NHẮN chứ không vào system prompt để giữ cache, log mỗi lượt một dòng KHÔNG nạp (chỉ tìm kiếm), mục hết hạn `until`, mục bị phản bác gạch bỏ chứ không xoá (superseded), quét ban đêm.
- Làm: mỗi quy tắc đã có cổng code thì rút còn một dòng trỏ tới mã từ chối; tường thuật sự cố (ngày, tên shop) chuyển sang nhật ký ngày KHÔNG nạp. Đo: kích thước file + số token đầu phiên Leader trước/sau.

**E2. Board chỉ-đọc, rồi mới tới vai trò/3D.** (M) Sau B2. Nguồn dữ liệu là ledger: job theo trạng thái, hàng "Cần anh" (needs_input có options+default), chi phí, outward đã làm. Run card hiện tại (`standalone.js:7416`) chỉ có run-state theo terminal.

**E3. Team dạng file + roster vai trò.** (L, sau cùng) Mẫu `BotMRR Markdown v1` (frontmatter + thân Markdown; nhập: thêm mới, skill TẮT, routine TẠM DỪNG, không mang key/chat). Chỉ đáng làm khi ledger ổn và đã có ≥2 loại `kind`.

## 4. Không làm (có lý do)

- Fork: kiến trúc khác (harness sở hữu tiến trình agent vs terminal PTY có người xem), ~7.6k file + Electron + dịch vụ ngoài, upstream đổi hàng ngày.
- Rooms/@mention/group chat: OpenMausBot tự ghi fan-out là chi phí chính (`EVERYONE_ON_THE_MAP`: 13 bot ≈ 13 lượt model) và phải thêm `room-post-budget` (trùng 60s, 10/phút, vòng A→B→C→A, breaker 5 phút) để chống bão. AntiFan chưa có bài toán này (không worker→worker).
- Decision model (Jev/Clef) để định tuyến: AntiFan định tuyến shop→project bằng code.
- Bốn mức approval, Composio/Boat/voice/Cloud/Enterprise, agents tool bridge (họ đo: tiết kiệm 13k token nhưng thêm 1 lượt model, hoà vốn, để TẮT).
- Chép 1-1 `statusOnly` (hỏi model nhỏ "ACK hay NEEDS?"): chỉ đáng khi Leader bị đánh thức rất nhiều lần cho báo cáo rỗng; chưa có số liệu AntiFan. Nếu cần, làm bằng code (báo cáo DONE hợp lệ + evidence khớp + 0 outward).

## 5. Thứ tự đề xuất (mỗi bước ship riêng, không đổi quy trình feedback đang chạy cho tới B2/B3)

0. F0 (hợp nhất hai bản skill Leader, cần anh đồng ý) trước mọi thay đổi luật Leader.
1. S0 spike (`pi.registerTool` trong hook worker; đo: tool hiện, chạy, kết thúc lượt sạch). A1 (1)+(2) song song, độc lập.
2. C2 + B1 (hook mở rộng) → C1.
3. A2 + D1 (cần outward/files từ hook).
4. B2 (ledger, ghi đôi) → B3 (`ask_leader`).
5. D3 (fake-OMP) NÊN bắt đầu ngay từ B1 để các bước sau có lưới an toàn.
6. D2, D4, E1; cuối cùng E2, E3.

## 6. Việc cần anh quyết (ảnh hưởng thiết kế)

1. Cổng "Done": đồng ý đổi cụm chữ thành token một lần trong ledger (A1)?
2. Ledger: đặt `.antifan-data/leader/ledger.db`, một writer là `leader-job.mjs`? (B2)
3. Giới hạn mặc định: tối đa vòng/issue (đề xuất 4) và tái chế worker/vòng (đề xuất 2)? (C1)
4. Có cho Leader tự trả lời câu hỏi worker khi `onlyUser` sai và có `default` (kiểu "Full access" của OpenMausBot) hay luôn hỏi anh? (B3) Đề xuất: Leader trả lời cái không phải đăng nhập/OTP/thanh toán/push-foreign/publish.

## 7. Chưa kiểm chứng

- `pi.registerTool` trong hook của phiên PTY chưa chạy (chỉ có tài liệu).
- `--max-cost` trong phiên PTY tương tác chưa thử.
- Bun nhúng trong OMP có `node:sqlite` không (hệ thống Bun 1.4.3: có).
- Quy ước tên file session JSONL = hậu tố `ompSessionId` (ghi chú cũ, chưa kiểm lại).
- Khả năng khai thác A1 là suy luận từ việc không có cổng code, chưa thử.
- "Worker board" không thấy trong `src/` (scout); có thể nằm ngoài.
- Không chạy OpenMausBot; mọi nhận định về nó từ đọc nguồn/tài liệu.
