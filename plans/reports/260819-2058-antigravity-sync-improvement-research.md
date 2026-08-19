---
type: researcher
date: 2026-08-19
scope: personal-tool
status: complete
---

# Research Report: Cải thiện đồng bộ AntiFan Desktop với Antigravity

## Mục lục

1. [Tóm tắt](#tóm-tắt)
2. [Phạm vi và phương pháp](#phạm-vi-và-phương-pháp)
3. [Luồng hiện tại](#luồng-hiện-tại)
4. [Các phát hiện chính](#các-phát-hiện-chính)
5. [Kiến trúc phù hợp dự án cá nhân](#kiến-trúc-phù-hợp-dự-án-cá-nhân)
6. [Đề xuất triển khai](#đề-xuất-triển-khai)
7. [Kiểm thử và tiêu chí hoàn tất](#kiểm-thử-và-tiêu-chí-hoàn-tất)
8. [Không nên làm](#không-nên-làm)
9. [Nguồn và giới hạn](#nguồn-và-giới-hạn)
10. [Câu hỏi còn mở](#câu-hỏi-còn-mở)

## Tóm tắt

Cơ chế hiện tại không cần bị thay thế hoàn toàn. Filesystem bridge là lựa chọn hợp lý cho công cụ cá nhân trên Windows: dễ quan sát, dễ sửa, không cần service riêng. Vấn đề nằm ở contract và ownership, không nằm ở transport.

Ba thiếu sót quan trọng nhất:

1. Desktop báo thành công ngay sau khi ghi command, dù extension đã có `*.res.json` chứa kết quả thật.
2. Mỗi Extension Host scan cả global bridge và bridge của nhiều project. Host sai workspace có thể lấy command trước, trả lỗi rồi xóa command trước khi host đúng xử lý.
3. `sendToAgentPanel()` trả `Thenable<void>`. Extension đang đổi Promise resolution thành `submitted: true`, trong khi module `DesktopBridge` cùng repo ghi rõ Promise resolution không phải bằng chứng submit + acknowledgement.

Khuyến nghị: giữ bridge file, hội tụ hai contract hiện có thành một protocol nhỏ, versioned, có host heartbeat, atomic claim, result receipt, idempotency và trạng thái delivery trung thực. Không xây named pipe, message broker, database, consent framework hoặc agent engine riêng ở giai đoạn này.

## Phạm vi và phương pháp

### Mục tiêu

Làm cho luồng Browser -> Antigravity đáng tin cậy đủ để dùng hàng ngày khi QA theme/web:

- Không gửi nhầm workspace hoặc session.
- Không báo thành công giả.
- Không gửi trùng khi extension hoặc desktop restart.
- Lỗi phải nhìn thấy và có thể retry thủ công.
- Giữ workflow nhanh, không biến dự án cá nhân thành platform enterprise.

### Nguồn đã kiểm tra

- Working tree mới nhất của `antifan-browser-desktop`.
- Consumer extension tại `E:/Work/apps/antigravity-browser`.
- Receipt files đang tồn tại trong các `.antigravity/mcp-bridge` thật.
- Unit/static tests của cả desktop và extension.
- README và security/design comments của extension.
- Tìm kiếm công khai exact symbol `sendToAgentPanel` / `antigravityExtensibility`; không tìm được tài liệu API công khai có thể dùng để xác nhận semantics.

### Kiểm chứng

- `antifan-browser-desktop`: `npm run typecheck` pass.
- `antigravity-browser`: `npx tsc -p . --noEmit` pass.
- Receipt thực quan sát được:
  - `{ "ok": true, "submitted": true }`
  - `{ "ok": false, "error": "No active browser tab. Open one first." }`

Receipt lỗi đang nằm trên đĩa nhưng desktop không đọc, nên người dùng không thấy lỗi đó trong UI.

## Luồng hiện tại

```text
AntiFan Desktop
  1. Suy ra session + workspace
  2. Ghi cmd-<id>.tmp
  3. Rename thành cmd-<id>.json
  4. Thêm user message vào sidebar
  5. Trả ok:true ngay

Mỗi Antigravity Extension Host
  6. Scan global dir + workspace dirs + mọi project trong E:\Work
  7. Host đầu tiên đọc command
  8. Kiểm tra targetWorkspace
  9. Gọi sendToAgentPanel hoặc trả lỗi
 10. Ghi cmd-<id>.res.json
 11. Xóa command

AntiFan Desktop
 12. Không đọc result
 13. Poll transcript và suy đoán running/done từ JSONL + mtime
```

### Owner hiện tại

| Trách nhiệm | Owner thực tế | Vấn đề |
|---|---|---|
| Chọn workspace | Desktop heuristic | Có fallback rộng và hard-code |
| Claim command | Extension Host nhanh nhất | Không đảm bảo đúng workspace |
| Handoff tới Chat | Extension | Promise resolution bị gọi là submitted |
| Receipt | Extension | Desktop bỏ qua |
| Trạng thái agent | Desktop transcript parser | Heuristic, không phải authority |
| Cleanup result | Không có owner | `*.res.json` tích lũy |

## Các phát hiện chính

### 1. Receipt đã tồn tại nhưng bị bỏ phí

Extension ghi result tại `antigravity-browser/src/runtime.ts:222-224`:

```ts
writeJsonAtomic(path.join(bridgeDir, `${cmd.id}.res.json`), {
  id: cmd.id,
  ...result,
});
```

Desktop `handleSendPrompt()` ghi command rồi luôn trả `ok: true` tại `src/main/browser/native-tab-host.ts:1966`. Không có code đọc `.res.json` trong desktop.

Hệ quả:

- Extension reject sai workspace nhưng UI vẫn báo đã chuyển tiếp.
- `sendToAgentPanel` throw nhưng UI vẫn báo đã chuyển tiếp.
- Extension chưa active hoặc không scan dir nhưng UI vẫn báo đã chuyển tiếp.
- Result lỗi nằm trên đĩa không có người xử lý.

Đây là cải tiến có effort thấp nhất và impact cao nhất.

### 2. Có race giữa nhiều Extension Host

`getPossibleBridgeDirs()` trong extension thêm:

- `E:\Work\.antigravity\mcp-bridge`.
- Bridge dir của workspace đang mở.
- Bridge dir của mọi thư mục dưới `customizes`, `apps`, `themes`.

Mỗi cửa sổ Antigravity chạy một Extension Host và cùng poll danh sách này mỗi 250 ms. `targetWorkspace` chỉ được kiểm tra sau khi command đã được chọn. Dù mismatch, host vẫn ghi result và xóa command trong `finally`.

Kịch bản cụ thể:

```text
Command target = Project B
Extension Host A và B cùng thấy file
Host A đọc trước
Host A phát hiện mismatch
Host A ghi error result và xóa command
Host B không còn command để xử lý
```

Đây không phải rủi ro lý thuyết. Máy hiện đang chạy nhiều process Antigravity IDE và bridge dirs có result từ nhiều project.

Sửa đúng:

- Extension chỉ scan bridge dir của workspace mà nó sở hữu.
- Nếu vẫn dùng shared dir, host mismatch phải bỏ qua file, tuyệt đối không xóa hoặc trả result cuối.
- Claim chỉ xảy ra sau khi xác nhận target workspace.

### 3. `submitted: true` đang mạnh hơn bằng chứng

`sendToAgentPanel()` được type là `Thenable<void>`. Runtime đổi Promise resolve thành `{ status: 'accepted' }`, sau đó trả `{ ok, submitted: ok }`.

Nhưng `antigravity-browser/src/desktopBridge.ts` ghi rõ:

> Promise resolution alone is NOT delivery proof.

Module này mặc định `submitAndAck: false`, từ chối Send Now và chỉ cho Queue. Tests cũng khóa invariant này.

Hai contract đang mâu thuẫn:

| Đường | Semantics |
|---|---|
| File bridge `sendToAgentPanel` | Promise resolve => `submitted: true` |
| `DesktopBridge` versioned | Promise resolve không chứng minh submit; Queue-only |

Cho công cụ cá nhân, không cần consent phức tạp. Tuy nhiên UI phải dùng từ đúng:

- `queued`: command đã ghi.
- `extension-accepted`: extension gọi API và Promise resolve.
- `failed`: extension trả lỗi rõ ràng.
- `unknown`: timeout, crash hoặc reset khi API vẫn có thể hoàn tất sau đó.
- `observed-in-transcript`: optional, prompt đã xuất hiện trong đúng raw transcript.

Không dùng từ `submitted` nếu chưa có bằng chứng mạnh hơn Promise resolution.

### 4. Workspace authority chưa đủ chặt

Desktop suy workspace qua session transcript, URL hostname, tên project và cuối cùng fallback `E:\Work`. Hard-code `E:\Work` phù hợp máy cá nhân để discovery, nhưng không phù hợp làm authority gửi mutation.

Nguyên tắc nên dùng:

- Discovery có thể heuristic.
- Mutation phải cần exact binding.

Nếu không xác định chính xác workspace:

- Hiện chooser một lần.
- Lưu `sessionId -> workspacePath` vào state desktop.
- Không gửi khi mapping chưa tồn tại hoặc path không còn hợp lệ.
- Không fallback `E:\Work` cho `sendToAgentPanel` và `abortTurn`.

### 5. Session targeting chưa được xác nhận end-to-end

Desktop gửi cả `sessionId` và `conversationId`. Extension truyền chúng vào API nội bộ. Không có tài liệu công khai hoặc response chứa session thực tế đã nhận prompt.

Vì vậy:

- Việc truyền ID là cải thiện đúng.
- Việc prompt chắc chắn vào đúng conversation vẫn chưa được chứng minh từ API response.
- Transcript correlation là cách kiểm chứng thực dụng nhất nếu cần độ chắc cao hơn.

Cho cá nhân, chỉ cần correlation nhẹ:

1. Lưu `promptSha256`, session target và `issuedAt` trong delivery record.
2. Sau extension receipt, quan sát raw transcript của đúng session.
3. Khi có `USER_INPUT` mới sau `issuedAt` và normalized prompt hash khớp, chuyển trạng thái thành `observed-in-transcript`.
4. Nếu không thấy sau 10-20 giây, giữ `extension-accepted`, không đổi thành failed.

Không auto retry trong trạng thái không xác định vì prompt cũ có thể vẫn xuất hiện sau đó.

### 6. Không có idempotency

Extension bỏ qua `.res.json`, nhưng nếu cùng command ID được ghi lại thành `.json`, command sẽ chạy lại. Không có seen-ID journal hoặc check existing result trước execute.

Fix tối thiểu:

```text
Nếu <id>.res.json đã tồn tại:
  không execute lại
  xóa command duplicate hoặc giữ result cũ
```

Desktop cũng không được tự retry khi timeout. Chỉ retry bằng command ID mới sau khi người dùng xác nhận.

### 7. Handoff treo có thể chặn toàn bộ bridge

Extension đặt `bridgeInFlight = true` và await `sendToAgentPanel`. Sau 15 giây chỉ hiện nút Reset Handoff. Nếu không reset và API không settle, mọi command sau bị chặn.

Không nên timeout rồi tự gửi lại. Cách phù hợp:

- Sau deadline 30 giây, trả result `delivery: unknown`.
- Release bridge queue để command khác có thể chạy.
- Giữ promise cũ detached và log nếu nó settle muộn.
- Không retry command unknown tự động.

### 8. Transcript sync đang bị dùng như authority

TranscriptSyncer hữu ích để hiển thị chat, nhưng trạng thái `running/done` được suy từ record cuối và mtime. Parser phụ thuộc các type nội bộ như `USER_INPUT`, `PLANNER_RESPONSE`, `tool_calls`.

Các điểm yếu:

- Antigravity đổi schema có thể làm parser im lặng bỏ message.
- Timestamp của message dùng `Date.now()`, không phải timestamp gốc.
- Tool calls được đánh `done` dù chưa nối đầy đủ tool result.
- Sequential queue có thể gửi sớm hoặc chờ lâu vì `isRunning` là heuristic.
- Auto-follow có thể đổi session theo file mới nhất do background activity.

Khuyến nghị:

- Transcript là projection/read-only.
- Delivery state lấy từ command result, không lấy từ transcript.
- Sequential queue mặc định chỉ dispatch khi user bấm hoặc khi điều kiện idle bảo thủ đạt; không coi nó là exactly-once automation.
- Parser lỗi phải có diagnostic counter/log, không `catch {}` hoàn toàn.

### 9. Result và artifact không có lifecycle rõ ràng

Result files đang tích lũy trong bridge dirs. Snapshot desktop vẫn có các candidate global/process-relative thay vì luôn thuộc target workspace.

Cho cá nhân, chỉ cần rule đơn giản:

- Desktop xóa result sau khi consume và persist delivery summary.
- Extension dọn result/cmd/temp quá 24 giờ.
- Artifact mới lưu dưới `<targetWorkspace>/.antigravity/snapshots`.
- Giới hạn mỗi ảnh và tổng attachment để tránh vô tình ghi file rất lớn.

### 10. Hai protocol nên hội tụ, không phát triển song song

Extension đã có `DesktopHandoff` versioned với:

- `transportVersion`.
- `clientInstanceId`.
- `hostEpoch`.
- `folderUri`.
- `annotationId`.
- Artifact hash/size/mime.
- Queue authority.

File bridge cũ lại có các khả năng live cần thiết:

- Poll command.
- Workspace match.
- `sendToAgentPanel`.
- Result file.

Không cần giữ hai stack. Lấy schema tối giản từ `DesktopHandoff` và dùng transport file hiện tại.

## Kiến trúc phù hợp dự án cá nhân

### Quyết định

Giữ filesystem bridge. Thêm một `BridgeCommandClient` nhỏ ở desktop và thu hẹp consumer extension theo workspace.

```text
Desktop BridgeCommandClient
  -> workspace/.antigravity/mcp-bridge/cmd-<id>.json
  <- workspace/.antigravity/mcp-bridge/cmd-<id>.res.json

Antigravity Extension Host của đúng workspace
  -> heartbeat/capabilities
  -> validate target
  -> atomic claim
  -> execute once
  -> result
```

### Host status tối thiểu

Extension ghi `host.json` mỗi 2-5 giây:

```json
{
  "protocolVersion": 2,
  "hostId": "host-...",
  "hostEpoch": 1787147000000,
  "workspace": "E:/Work/customizes/Mnbakery",
  "extensionVersion": "2.0.0",
  "lastSeenAt": 1787147449000,
  "capabilities": ["send-to-agent", "abort-turn", "draft", "auto"]
}
```

Desktop chỉ bật Auto/Draft send khi host heartbeat còn mới và workspace khớp.

### Command contract tối thiểu

```json
{
  "protocolVersion": 2,
  "id": "cmd-...",
  "createdAt": 1787147449000,
  "expiresAt": 1787147509000,
  "senderId": "desktop-...",
  "target": {
    "workspace": "E:/Work/customizes/Mnbakery",
    "sessionId": "..."
  },
  "action": "sendToAgentPanel",
  "mode": "auto",
  "promptSha256": "...",
  "params": {
    "prompt": "...",
    "files": []
  }
}
```

### Result contract tối thiểu

```json
{
  "protocolVersion": 2,
  "id": "cmd-...",
  "hostId": "host-...",
  "hostEpoch": 1787147000000,
  "workspace": "E:/Work/customizes/Mnbakery",
  "ok": true,
  "delivery": "extension-accepted",
  "finishedAt": 1787147450200
}
```

Giá trị `delivery`:

- `extension-accepted`.
- `draft-filled` nếu API phân biệt được.
- `failed`.
- `unknown`.
- `observed-in-transcript` do desktop nâng cấp sau correlation.

### State machine desktop

```text
prepared
  -> queued
  -> extension-accepted
  -> observed-in-transcript (optional)

queued -> failed
queued -> unknown
extension-accepted -> unknown (chỉ khi cần xác nhận transcript)
```

UI cần hiển thị trạng thái trên chính user bubble. Không thêm system message giả.

## Đề xuất triển khai

### P0 - Làm trước, hiệu quả cao

#### 1. Desktop consume result

- `handleSendPrompt()` trả delivery ID và trạng thái `queued`, không trả `ok:true` mang nghĩa submitted.
- Watch/poll `<id>.res.json` trong 20-30 giây.
- Cập nhật bubble thành accepted/failed/unknown.
- Xóa result sau khi đọc.
- Áp dụng cùng cơ chế cho `abortTurn`.

#### 2. Extension không scan project không sở hữu

- Bỏ enumeration mọi project trong `getPossibleBridgeDirs()`.
- Chỉ scan bridge dir của `vscode.workspace.workspaceFolders` hiện tại.
- Global bridge chỉ giữ nếu thực sự cần; nếu giữ, mismatch phải skip, không consume.

#### 3. Fail closed khi workspace không rõ

- `resolveTargetWorkspace()` có thể dùng heuristic để đề xuất.
- `handleSendPrompt()` yêu cầu exact path đã xác nhận.
- Không fallback `E:\Work` cho mutation.
- Lưu mapping session -> workspace.

### P1 - Làm ngay sau P0

#### 4. Thêm host heartbeat và protocol version

- `host.json` theo workspace.
- Desktop kiểm tra version/capability/liveness.
- Hiện trạng thái `Antigravity offline`, `wrong workspace`, `compatible`.

#### 5. Idempotency và cleanup

- Existing result => không execute duplicate command.
- Cleanup temp/command/result cũ hơn 24 giờ.
- Không auto retry `unknown`.

#### 6. Sửa từ ngữ và semantics

- Promise resolve => `extension-accepted`, không phải submitted.
- Chỉ ghi `observed-in-transcript` sau correlation.
- Draft và Auto có status khác nhau.

### P2 - Chỉ làm nếu P0/P1 chưa đủ

#### 7. Transcript correlation

- Prompt hash + issuedAt + exact session.
- Optional marker HTML comment nếu duplicate prompt thường xuyên gây ambiguity.
- Không dùng transcript làm delivery authority trước extension receipt.

#### 8. Artifact integrity/budget

- Target-workspace staging.
- Size budget.
- Hash của bytes đã copy.
- Chỉ cần nếu attachment stale/sai file xảy ra thực tế.

#### 9. Local bridge authentication

- Bắt buộc WebSocket token.
- Command token/nonce có thể thêm để chống stale/accidental writers.
- Không cần cryptographic enterprise protocol nếu threat model chỉ là một user trên máy cá nhân.

## Kiểm thử và tiêu chí hoàn tất

### Tests cần có

1. Desktop nhận success receipt và cập nhật đúng message.
2. Desktop nhận failure receipt và không báo success.
3. Không có receipt trước deadline => `unknown`, không retry.
4. Host sai workspace nhìn thấy command nhưng không xóa.
5. Host đúng workspace xử lý command đúng một lần.
6. Duplicate command ID không gọi `sendToAgentPanel` lần hai.
7. Extension restart giữa command tạo result `unknown` hoặc command còn để retry thủ công.
8. `sendToAgentPanel` reject => failure receipt.
9. `sendToAgentPanel` treo => queue được release sau deadline mà không resend.
10. Draft và Auto có status text khác nhau.
11. Abort chỉ báo accepted sau result.
12. Stale result/temp được cleanup; result mới không bị xóa.

### Success metrics

- 0 trường hợp UI báo submitted khi không có extension receipt.
- 0 command bị host sai workspace xóa trong test hai Extension Host.
- Failure receipt hiển thị trong UI dưới 2 giây sau khi extension ghi file.
- Duplicate command ID tạo tối đa một call tới `sendToAgentPanel`.
- Không còn `.res.json` đã consume; orphan quá 24 giờ được cleanup.
- Không mutation nào fallback sang `E:\Work` khi workspace chưa xác định.
- Typecheck và full tests của hai repo pass.

## Không nên làm

- Không thay filesystem bridge bằng named pipe/WebSocket chỉ để giải quyết receipt; result file đã tồn tại.
- Không xây database delivery ledger; JSON nhỏ trong app state đủ cho cá nhân.
- Không implement distributed lease phức tạp; chỉ cần host sở hữu exact workspace và atomic claim.
- Không auto retry delivery unknown.
- Không cố parse toàn bộ Antigravity transcript thành canonical chat model.
- Không giữ đồng thời legacy file bridge và `DesktopBridge` versioned lâu dài.
- Không xây consent framework nhiều bước nếu chỉ một người dùng; giữ confirmation cho Auto Send là đủ.
- Không ưu tiên plugin SDK, model providers hoặc chat UI polish trước P0.

## Nguồn và giới hạn

### Local primary sources

- `src/main/browser/native-tab-host.ts`.
- `src/main/bridge/transcript-syncer.ts`.
- `src/main/bridge/bridge-server.ts`.
- `E:/Work/apps/antigravity-browser/src/runtime.ts`.
- `E:/Work/apps/antigravity-browser/src/desktopBridge.ts`.
- `E:/Work/apps/antigravity-browser/src/extension.ts`.
- Tests trong cả hai repo.
- Live `.res.json` files tại `E:/Work/.antigravity/mcp-bridge` và workspace dirs.

### External research

- Exact-symbol web search không trả tài liệu công khai hữu ích.
- GitHub code search không dùng được do local `gh` credentials trả HTTP 401.
- Vì vậy semantics của API nội bộ được đánh giá từ type declaration và behavior/comment/tests trong extension local.

### Weakest link

`sendToAgentPanel` có thể có guarantee nội bộ mạnh hơn Promise type thể hiện. Tuy nhiên code và tests của extension hiện chủ động coi submit+ack là chưa được chứng minh. Khuyến nghị giữ semantics bảo thủ cho đến khi có API documentation hoặc probe end-to-end xác nhận khác.

## Câu hỏi còn mở

- `conversationId` có được Antigravity đảm bảo route chính xác hay chỉ là best-effort hint?
- Promise của `sendToAgentPanel` resolve ở lúc composer nhận payload, lúc queue nhận, hay sau submit?
- Raw transcript có giữ nguyên HTML comment/marker để correlation ổn định không?
- Có thể lấy agent busy/idle state qua API chính thức thay vì mtime heuristic không?
