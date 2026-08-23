# Feature Comparison: Orca Reliability Patterns for AntiFan

---
date: 2026-08-20
mode: compare
source: stablyai/orca
source-commit: d7a23c84a9f68c88167bc68736562686fa2a53b0
local-project: antifan-browser-desktop
verdict: adapt-patterns-only
---

## Tóm tắt quyết định

Orca đáng tham khảo như một thư viện pattern reliability/UX cho AntiFan, không
đáng được clone hoặc dùng làm nền tảng thứ hai. Orca có bằng chứng code/test rõ
cho hook lifecycle đa agent, cache replay, authority/observation, endpoint file
nguyên tử, heartbeat reconnect, terminal recovery và browser annotation. Những
pattern này khớp với các điểm yếu đã ghi nhận trong AntiFan.

Orca không giải quyết được blocker quan trọng nhất của AntiFan: Antigravity
Conversation/AgentAPI private routing. README chỉ nói Orca chạy được
Antigravity như một CLI agent; source có adapter hook `antigravity`, nhưng không
có bằng chứng về API để chọn một conversation riêng trong IDE hoặc đẩy tin vào
tab không active. Vì vậy Orca không thể biến active-panel fallback thành exact
routing.

**Kết luận:** giữ AntiFan làm sản phẩm/harness chính; lấy có chọn lọc 5 pattern
(bound identity, authenticated receipt, durable reconciliation, terminal tree
lifecycle, evidence budget). Không thêm Electron/React/Zustand/worktree layer
của Orca vào AntiFan.

## Mục lục

- [Phạm vi và nguồn](#phạm-vi-và-nguồn)
- [Orca thực sự làm gì](#orca-thực-sự-làm-gì)
- [Đối chiếu với AntiFan](#đối-chiếu-với-antifan)
- [Dependency matrix](#dependency-matrix)
- [Xia challenge](#xia-challenge)
- [Decision matrix](#decision-matrix)
- [Khuyến nghị thực dụng](#khuyến-nghị-thực-dụng)
- [Rủi ro và câu hỏi còn mở](#rủi-ro-và-câu-hỏi-còn-mở)

## Phạm vi và nguồn

- GitHub: [stablyai/orca](https://github.com/stablyai/orca), MIT, commit
  `d7a23c84a9f68c88167bc68736562686fa2a53b0`, cập nhật ngày 2026-08-20.
- Snapshot local: `C:/Users/Admin/AppData/Local/Temp/antifan-orca-research-9ed373b6a9614876be0ed0c016ef0161`.
- Repomix scoped snapshot: `C:/Users/Admin/AppData/Local/Temp/antifan-orca-relevant-repomix-260820.md`
  (17 files, 96,181 tokens).
- Đã đọc README, package metadata, hook server/listener, relay publication,
  observation sequencer, heartbeat tests, terminal E2E, browser-grab types và
  remote-wire docs.
- Đối chiếu AntiFan với `plans/reports/260820-1052-antifan-antigravity-post-cook-code-review.md`
  và các bridge/transcript/terminal contracts hiện tại.

## Orca thực sự làm gì

### 1. Agent hook lifecycle là một status pipeline, không phải conversation router

Orca có adapter cho nhiều provider. Với Antigravity, `isNewTurnEvent()` xem
`PreInvocation` là boundary; listener đọc `transcriptPath` để lấy user request
hoặc assistant result khi hook body thiếu dữ liệu; tool fields được normalize
từ `toolCall.name` và `toolCall.args`.

Điểm quan trọng là đây là **quan sát trạng thái của pane/PTY**. Nó không chứng
minh khả năng gửi prompt vào conversation ID riêng của Antigravity IDE.

### 2. Endpoint file và local hook server có các invariant tốt

`writeEndpointFile()`:

- bind loopback;
- phát token riêng cho runtime;
- ghi file tạm rồi `rename` nguyên tử;
- giới hạn giá trị shell-safe;
- owner-only directory/file trên POSIX;
- sweep `.endpoint-*.tmp` stale nhưng giữ file đang được writer khác dùng.

`RelayAgentHookServer` giới hạn replay cache 256 pane, giữ metadata source/env/version
cùng status, và có `replayCachedPayloadsForPanes()` khi reattach. Đây là pattern
phù hợp cho Desktop-Extension-Sidecar, nhưng AntiFan phải bind thêm command,
workspace, route, host epoch và auth tag.

### 3. Orca phân biệt authority, observation và replay

`AgentStatusObservationSequencer` đóng dấu:

- `authorityId` theo runtime;
- `incarnation` khi pane/PTY được rebind;
- monotonic `revision`;
- `origin` (`hook`, `osc`, `title`, `process`, ...);
- `kind` (`transition`, `snapshot`, `identity-only`).

Replay được đánh dấu `snapshot`, không được hiểu là transition mới. Authority
được retire/rebind khi pane đổi owner. Observation không được persisted như thể
nó là bằng chứng sống của runtime cũ; dữ liệu durable chỉ giữ commitment/hash.

Đây là ý tưởng rất gần với lỗi AntiFan hiện tại: một receipt/transcript snapshot
không được tự động nâng thành bằng chứng delivery mới.

### 4. Relay publication có backpressure và shedding có chủ đích

`publishAgentHookEnvelope()` đo frame budget, shed các field tái dựng được trước,
giữ `state`/`paneKey` và interactive prompt, rồi retry ngắn khi queue đầy. Cache
replay là đường phục hồi thứ hai.

AntiFan đã có giới hạn attachment 8 file/10 MiB, nhưng chưa có cùng mô hình
artifact budget/receipt budget cho mọi tầng. Có thể lấy nguyên tắc budget + reason
code, không lấy nguyên protocol.

### 5. Heartbeat chủ động, không tin `WebSocket.OPEN`

Orca heartbeat chạy mỗi 10 giây, probe sau khoảng lặng, chờ grace rồi đóng socket;
timer tắt khi document hidden và re-arm khi visible nhưng giữ baseline inbound để
phát hiện socket nửa mở. Tests bao phủ hidden/resume, silence và cleanup.

AntiFan `host.json` heartbeat hiện kiểm tra bằng polling file; có thể bổ sung
lease/epoch và probe tương tự cho Sidecar, nhưng đây không thay thế receipt auth.

### 6. Terminal recovery được chứng minh bằng failure-injection E2E

Các test Orca cố ý làm hỏng push delivery, xterm write pipeline, PTY descendant
tree và quit/resume. Recovery dựa trên main-owned buffer/replay, kill descendant
process, daemon persistence và provider session identity. Đây là bằng chứng về
cách kiểm thử, không phải module để chép.

### 7. Browser Design Mode có evidence budget tốt, nhưng AntiFan đã có phần lớn

Orca `browser-grab-types.ts` giới hạn HTML/text/nearby elements, allowlist
attributes, redact secret-like values, giới hạn 20 annotations/page và bỏ
screenshot khi persist. AntiFan đã có annotation/capture và budget 8 attachments /
10 MiB; nên so sánh schema/budget, không thay thế bằng Orca browser stack.

## Đối chiếu với AntiFan

### Luồng hiện tại của AntiFan

```text
Desktop sidebar
  -> AntigravityCommandClient
  -> workspace/.antigravity/mcp-bridge/<command>.json
  -> Extension/Sidecar
  -> <command>.res.json
  -> Desktop poll + TranscriptSyncer late observation
```

Các review gần nhất đã xác nhận:

- Desktop vẫn có thể chấp nhận receipt không bind đầy đủ request/host/route.
- Extension/Sidecar từng cho phép unsigned hoặc mismatched receipt.
- `pendingDeliveries` late reconciliation ở `NativeTabHost` vẫn memory-only;
  ledger mới tồn tại nhưng chưa thay thế đầy đủ pending/restart flow.
- abort exact có nguy cơ rơi về global active conversation nếu target top-level
  không được truyền/kiểm chứng.
- AgentAPI Windows `.bat` launcher còn là blocker live.
- Terminal manager của AntiFan dùng `child_process.spawn` đơn giản và kill tree;
  chưa có PTY/daemon/replay semantics như Orca.

### Orca có thể giúp gì

| Vấn đề AntiFan | Pattern Orca | Giá trị |
| --- | --- | --- |
| Receipt/snapshot bị lẫn với authority | `authorityId` + `incarnation` + `kind` | Cao |
| Late status sau restart | Durable status + hydrated commitment, không hydrate authority sống | Cao |
| Hook endpoint stale/tamper | Token, shell-safe, atomic rename, temp sweep | Cao |
| Relay reconnect | One-entry-per-pane replay + metadata retention | Cao |
| Sidecar liveness | Active heartbeat/probe/grace | Trung bình-cao |
| Terminal orphan/freeze | Failure-injection E2E + process/replay recovery | Cao |
| Browser evidence | Redaction + bounded payload | Trung bình |
| Exact Antigravity conversation routing | Không có implementation tương ứng | Không giải quyết |

## Dependency matrix

| Source component | AntiFan equivalent | Status | Cách dùng |
| --- | --- | --- | --- |
| Hook normalizer/listener | `TranscriptSyncer`, bridge client | EXISTS + CONFLICT | Mượn provenance/state model; không thay TranscriptSyncer bằng hook listener |
| Endpoint file writer | `.antigravity/mcp-bridge` files | EXISTS + CONFLICT | NEW: shared authenticated endpoint/lease contract |
| `AgentStatusObservationSequencer` | Delivery states/ledger | NEW | Thêm `authority`, `incarnation`, `evidenceKind`; không dùng làm auth thay HMAC |
| Replay cache | `pendingDeliveries` + late poll | EXISTS + CONFLICT | Đổi sang durable receipt index + request-bound replay |
| Envelope shedding/budget | attachment limits | EXISTS | Mở rộng thành byte budget cho command/receipt/transcript evidence |
| Web heartbeat | `host.json` heartbeat | EXISTS + CONFLICT | Hybrid lease/epoch/probe cho Sidecar |
| PTY daemon/recovery E2E | `TerminalManager` | CONFLICT | Viết test failure-injection trước; chưa port daemon |
| Worktree orchestration | AntiFan workspace resolver | NEW, scope lớn | Không port ở giai đoạn này |
| Browser grab/design mode | `annotation-manager`, captures | EXISTS | Chỉ port redaction/budget cases nếu test thiếu |
| Mobile/SSH/GitHub/Linear | Không có nhu cầu P0 | NEW, YAGNI | Không đưa vào scope |

## Xia challenge

### Câu hỏi 1 — Có cần Orca feature hay chỉ cần invariant?

- **Orca:** giải quyết bằng nhiều module và test quanh hook/PTY/worktree.
- **AntiFan:** cần invariant receipt không thể bị nhầm request, workspace,
  conversation, host epoch, route và instance; không cần Orca UI/worktree.
- **Nếu sai:** port cả kiến trúc sẽ tăng blast radius nhưng vẫn không exact-route.

### Câu hỏi 2 — Có cùng authority model không?

- **Orca:** pane/PTY là đơn vị authority; replay là snapshot và authority runtime
  có ID/sequence riêng.
- **AntiFan:** command/receipt là đơn vị authority; transcript là observation,
  Sidecar/Extension là producer; mỗi request cần binding riêng.
- **Nếu sai:** dùng `incarnation` của pane thay cho request binding sẽ cho false
  positive delivery.

### Câu hỏi 3 — Replay có được coi là delivery proof không?

- **Orca:** replay chỉ tái hiện status cache; test gắn `kind: snapshot`.
- **AntiFan:** late receipt/transcript chỉ được nâng trạng thái khi chứng minh
  `commandId + promptDigest + workspace + targetConversationId + hostEpoch`.
- **Nếu sai:** restart/replay có thể nâng một prompt khác thành `ide-api-accepted`.

### Câu hỏi 4 — File endpoint có đủ trust boundary không?

- **Orca:** loopback + token + owner-only atomic endpoint file.
- **AntiFan:** workspace bridge file hiện vẫn có thể bị pre-seed bởi process có
  quyền ghi workspace; cần auth tag/request nonce và reject unsigned/mismatch.
- **Nếu sai:** local workspace malware/extension khác có thể invoke active-panel.

### Câu hỏi 5 — Heartbeat có giải quyết liveness hay correctness?

- **Orca:** heartbeat phát hiện half-open transport và kích hoạt reconnect.
- **AntiFan:** heartbeat chỉ nói Sidecar còn sống; không chứng minh prompt đã
  vào đúng conversation.
- **Nếu sai:** host “healthy” có thể khiến UI báo gửi thành công dù route sai.

### Câu hỏi 6 — Terminal recovery có nên port trước routing không?

- **Orca:** có E2E rộng vì terminal là nền tảng của mọi agent.
- **AntiFan:** terminal orphan/freeze là vấn đề thật, nhưng Exact Auto/receipt
  auth vẫn là release gate cấp cao hơn.
- **Nếu sai:** đầu tư PTY daemon trước sẽ trì hoãn đường đi tới exact correctness.

### Câu hỏi 7 — Browser Design Mode có phải khác biệt sản phẩm?

- **Orca:** grab payload có redaction, bounded HTML/CSS/screenshot và persist
  annotation không giữ ảnh.
- **AntiFan:** đã có picker/annotation/snapshot và 10 MiB attachment budget.
- **Nếu sai:** thêm một schema browser thứ hai sẽ tạo duplicate contracts và UX lệch.

## Decision matrix

| Quyết định | Cách Orca | Cách AntiFan hiện tại | Hybrid đề xuất | Rủi ro | Chọn |
| --- | --- | --- | --- | --- | --- |
| Request identity | pane/worktree + provider session | command ID + target session rời rạc | immutable command envelope + pane/session evidence | Cao | Hybrid |
| Receipt trust | hook token + authority provenance | shape validation, binding còn thiếu | HMAC/auth tag bắt buộc + exact field comparison | Critical | AntiFan contract mới |
| Late reconciliation | cache replay/status hydrate | memory pending + receipt scan | durable ledger là source UI, receipt retained/acknowledged | Cao | Hybrid |
| Endpoint publication | atomic temp + rename + safe values | atomic command write, endpoint trust yếu | adopt Orca file lifecycle, add lease/epoch | Trung bình | Adapt |
| Liveness | active WS heartbeat/probe | host.json timestamp | heartbeat + epoch + probe, fail closed khi stale | Trung bình | Adapt |
| Backpressure | shed optional fields, bounded retry | attachment cap, no generic envelope budget | preserve required identity; shed evidence only | Trung bình | Adapt |
| Terminal lifecycle | daemon PTY, replay, kill descendant tests | simple child process + taskkill | first add failure-injection tests, then scoped tree cleanup | Cao | Defer port |
| Browser evidence | bounded/redacted grab model | existing annotation manager | copy redaction/budget test cases only | Thấp | Adapt tests |
| Worktrees/mobile/SSH | core product model | out of current personal-tool scope | no import | Cao | Reject |
| Antigravity exact routing | no private conversation sender found | current blocker | research/verify AgentAPI separately | Critical | Not solved by Orca |

Risk score for **selective pattern adaptation**: 3 critical assumptions
(receipt binding, durable late reconciliation, exact abort target) => **Medium**;
resolve these before implementation. Risk for **full Orca transplant**: 5+
critical assumptions => **High**, reject.

## Khuyến nghị thực dụng

### P0 — không lấy Orca làm lý do trì hoãn

1. Hoàn tất request-bound receipt contract: bắt buộc so khớp command ID,
   workspace canonical identity, prompt/attachment digest, target conversation,
   host epoch, Sidecar instance và auth tag. Unsigned/mismatch phải bị reject.
2. Sửa exact abort fail-closed: thiếu target conversation hoặc receipt bind sai
   thì không được gọi global abort.
3. Làm live AgentAPI launcher chạy được trên Windows (`.bat` qua shell/command
   resolution phù hợp), rồi mới đo exact send.

### P1 — lấy các pattern Orca có tỷ lệ lợi ích/chi phí tốt nhất

1. **Durable delivery state machine:** giữ ledger là source của UI; pending record
   phải chứa deadline tuyệt đối, target identity, auth context và reconciliation
   proof. Receipt không bị xóa trước khi ledger acknowledge.
2. **Authority/evidence facet:** thêm `authorityId`, `instanceId`, `epoch`,
   `evidenceKind: transition|snapshot|transcript`, `observedAt` và `receivedAt`;
   transcript chỉ là observation.
3. **Endpoint lifecycle:** học `endpoint.env/cmd`, atomic publish, stale temp
   sweep, owner-only permissions và per-instance namespace.
4. **Liveness:** heartbeat Sidecar chủ động với probe/grace, tránh chỉ tin file
   `host.json` hoặc socket open.

### P2 — test/reliability, không port kiến trúc

- Thêm failure-injection tests tương đương Orca cho receipt mất/đến muộn, file
  partial write, restart giữa claim/result, terminal child survives kill,
  transcript replay không tạo message duplicate.
- So sánh Browser grab redaction/budget; bổ sung test cho secret attributes,
  screenshot omission và per-turn 10 MiB budget nếu còn thiếu.
- Nếu sau này AntiFan thành multi-agent harness, đánh giá riêng worktree/CLI
  orchestration trong một plan mới; không trộn với exact routing.

### Không nên làm

- Không import Orca dependencies hoặc Zustand/Electron architecture.
- Không xây mobile companion, SSH runtime, GitHub/Linear integration chỉ vì Orca
  có chúng.
- Không coi Antigravity adapter trong Orca là bằng chứng Orca gửi được vào tab/
  conversation không active.

## Rủi ro và câu hỏi còn mở

- Orca source có adapter Antigravity hook nhưng không expose private IDE sender;
  cần một probe AgentAPI độc lập để xác định API surface thật.
- AntiFan ledger đã tồn tại và persist 200 records, nhưng cần kiểm tra/hoàn thiện
  wiring restart + UI overlay trước khi xem là durable reconciliation hoàn chỉnh.
- Chưa có benchmark thực nghiệm kích thước receipt/attachment trên IPC của
  AntiFan; giữ ngân sách 10 MiB/turn và đo heap/latency trước khi tăng.
- Orca có terminal descendant test POSIX-only; Windows tree-kill vẫn cần test
  riêng, không suy luận từ POSIX.
- Snapshot repomix là nghiên cứu tại commit nêu trên; source Orca cập nhật rất
  thường xuyên, nên mọi port tương lai phải pin commit và re-run comparison.

## Tài liệu tham khảo chính

- [Orca README](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/README.md)
- [Remote wire compatibility](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/docs/reference/remote-wire-compatibility.md)
- [Orca agent hook server](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/src/relay/agent-hook-server.ts)
- [Orca agent status observation](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/src/shared/agent-status-observation.ts)
- [Orca endpoint writer](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/src/shared/agent-hook-listener.ts#L4683)
- [Orca heartbeat tests](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/src/renderer/src/web/web-runtime-client-heartbeat.test.ts)
- [Orca terminal push recovery test](https://github.com/stablyai/orca/blob/d7a23c84a9f68c88167bc68736562686fa2a53b0/tests/e2e/terminal-push-delivery-loss-recovery.spec.ts)
- [AntiFan post-cook review](plans/reports/260820-1052-antifan-antigravity-post-cook-code-review.md)
