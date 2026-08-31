# AntiFan — Deep Codebase Audit Report
## HEAD `9e06cc4d547daf0312da6d1eeb6f1b201f2f7432`

**Ngày audit:** 31/08/2026  
**Phạm vi:** toàn bộ source/runtime hiện tại, ưu tiên Chromium, Terminal, Semantic Ref, Theme QA, MCP/Bridge, Native Messaging, storage, performance, tests và maintainability.  
**Mục tiêu:** xác định những gì thật sự cần để AntiFan trở thành công cụ ổn định cho workflow frontend/theme developer dùng Terminal + OMP.

## 1. Executive verdict

AntiFan hiện đã ở mức **Final Candidate về kiến trúc và product workflow**.

Các commit mới nhất đã giải quyết phần lớn những vấn đề từng là blocker:

- Main-owned semantic reference authority.
- Isolated World 1004 executor.
- Stale target/document generation protection.
- Async Theme QA.
- Terminal buffer/IPC budgeting.
- Terminal split routing và focus.
- Bridge attachment self-healing.
- CLI bridge discovery.
- Annotation hover/submit performance.
- Native Messaging security path.
- TabHost modularization.

**Không cần thêm feature lớn.**

Từ đây chỉ nên làm:
- Correctness
- Reliability
- Performance proof
- Security regression
- UX friction thật

Không nên tiếp tục mở rộng AntiFan thành Agent IDE tổng quát.

## 2. Core product boundary

Workflow mục tiêu:

```text
Storefront / Theme
        ↓
Chromium
        ↓
Pick element
        ↓
Semantic context
        ↓
OMP / Agent CLI
        ↓
Edit theme
        ↓
Reload
        ↓
Fresh Theme QA
        ↓
QA #1
   ┌────┴────┐
 PASS       FAIL
   │          ↓
  Done     AI fix once
              ↓
           QA #2
          ┌───┴───┐
        PASS     FAIL
          │         │
         Done      Stop + Report
```

## 3. Chromium

### 3.1 Main-owned semantic refs

HEAD có:
```text
semantic-ref-types.ts
semantic-ref-registry.ts
semantic-ref-executor.ts
tab-automation-host.ts
```

Renderer trả raw descriptors; Main validate, cấp ref và lưu authority. Đây là boundary đúng.

### 3.2 Registry

Registry kiểm tra:
```text
browserEpoch
documentGeneration
documentUrl
sequence
nonce
snapshot limits
serialized byte limits
descriptor limits
expiry
```

Ref cũ bị reject khi generation/URL/epoch thay đổi.

**Verdict: Final-quality. Không redesign.**

### 3.3 Isolated World action executor

Agent action chạy qua World 1004 và resolve descriptor ở Main trước khi execute. URL được kiểm tra trước action và trước event dispatch.

Điểm cần kiểm chứng: `click` dispatch mouse events và `type` gán `.value` + `input/change`, có thể khác native interaction của một số framework controlled input.

**P1:** integration tests cho button, anchor, input, select, checkbox, custom clickable và controlled input.

### 3.4 Semantic snapshot

Collector lấy:
```text
ref
role
label
type
id
rect
sectionId
productId
blockId
framePath
```
và hỗ trợ Shadow DOM + nested iframe + global coordinate.

Đây là lợi thế rõ cho theme/storefront.

**P2:** nếu còn polish, thêm accessible name và state như disabled/checked/expanded; không cần full AX framework.

## 4. Theme QA

Fresh-state blocker cũ đã được giải quyết. QA hiện reload trước, lấy target/generation mới, rồi capture evidence mới; pre-reload diagnostics không dùng làm verdict chính.

### Async QA invariant

```text
generation N
→ async QA
→ navigation
→ generation N+1
→ result N không được publish
```

`AbortController` chỉ là cơ chế abort; downstream operation phải tôn trọng signal/generation.

**P1:** thêm regression cho stale-result publish.

### Two-round QA

Final:
```text
Edit → QA #1
FAIL → một corrective pass
→ QA #2
PASS → Done
FAIL → Stop + Report
```

Không round 3.

## 5. Terminal

Current runtime có:
```text
node-pty
512KB memory transcript
256KB persisted transcript
40KB global JSON wire budget
sequence/watermark
atomic hydration
dispatcher
process-tree cleanup
split routing/focus
```

Đây là architecture tốt cho local OMP workflow.

### So với Orca

Orca mạnh hơn ở:
```text
reattach
cold restore
PTY snapshot
agent resume
remote/SSH
multi-worktree runtime
```

AntiFan không cần copy phần remote/multi-host.

### P1 đáng học

- Snapshot-first renderer reconnect.
- True OMP session reattach/resume nếu sau này cần.
- Không nhồi resume state vào một `Session` object nếu complexity tăng.

**True seamless OMP resume không phải blocker cho v1.**

## 6. Bridge / CLI

Recent work đã làm:
```text
bounded congestion
attachment auto-rebind
TARGET_MISMATCH self-heal
multi-candidate bridge discovery
cross-spawn isolation
```

Giữ Bridge ở vai trò:
```text
transport
auth
lifecycle
relay/recovery
```

Không thêm business logic mới.

## 7. Native Messaging / Chrome Companion

Flow:
```text
Chrome Extension
→ Native Host
→ Local IPC
→ Bridge
→ AntiFan
```

Local IPC có instance identity, launch nonce, secure runtime auth và framing. Session/domain scoping đã được harden.

Extension có permission footprint lớn, vì vậy Final invariant:
```text
Companion = pairing/session/cookie bridge
Companion ≠ browser-control backdoor
```

**P1:** E2E security test extension → host → IPC → Bridge → capability.

## 8. Storage

`StorageLocations` gom config/sessions/artifacts/runtime/control-plane về một policy thống nhất.

Drive E là phù hợp cho workflow lâu dài.

Điểm cần giữ: nếu fallback storage xảy ra, log/visibility phải rõ; không fallback âm thầm.

## 9. Performance

AntiFan hiện có một strategy nhất quán:
```text
background throttling
+
bounded terminal buffer
+
bounded Bridge queue
+
async QA
+
cooperative yield
+
artifact retention
+
process lifecycle
```

### Điều còn thiếu: runtime proof

Một benchmark helper chưa đủ. Runtime soak phải thật sự drive:
```text
Electron
+ Chromium
+ PTY
+ Bridge
+ Theme QA
+ artifact
```

Nên đo:
```text
main RSS
renderer RSS
GPU RSS
CPU
event-loop delay
PTY process count
active QA jobs
WebSocket clients
artifact size
```

Workload representative:
```text
OMP streaming
→ browser reload
→ semantic snapshot
→ screenshot
→ Theme QA
→ annotation
→ tab switching
→ cleanup
```

Không cần chạy hàng giờ trong mọi CI; có thể là release/benchmark gate.

## 10. TabHost modularization

`TabAutomationHost`, `TabDevToolsHost`, `SemanticRefRegistry` và executor đã làm `NativeTabHost` gọn hơn đáng kể.

Đây là refactor đúng hướng.

Rule từ đây:
```text
NativeTabHost = orchestration/facade
```

Không tiếp tục nhồi business logic vào đó.

## 11. Renderer cleanup

Shim kiểu `var exports = exports || {};` đã giải quyết bootstrap issue, nhưng đây là compatibility workaround.

**P2:** về sau build renderer đúng browser/module target để loại shim.

Không cần chặn Final nếu behavior hiện ổn định.

## 12. Repository hygiene

Có khá nhiều planning/benchmark/report artifacts. Sau Final nên giữ:
```text
source
tests
canonical docs
release evidence
```

và dọn exploratory planner outputs/duplicate reports.

Đây là cleanup, không phải runtime blocker.

## 13. Final priority

### P0
1. **Real runtime soak:** thật sự drive Electron + Chromium + PTY + Bridge + QA và đo process/resource.
2. **Closed-loop E2E:** edit → QA #1 → AI fix → QA #2 trên fresh generation.

### P1
3. Async QA generation/signal publish guard.
4. Framework interaction correctness cho semantic actions.
5. Native Messaging E2E security boundary.

### P2
6. Semantic snapshot role/name/state.
7. True OMP resume/reattach.
8. Renderer build cleanup.
9. Repository artifact cleanup.

## 14. Final acceptance gate

- Semantic refs là Main-owned.
- Stale refs sau navigation/reload bị reject.
- Agent action không bypass main authority.
- Theme QA luôn validate fresh post-reload state.
- Async result cũ không publish vào generation mới.
- QA tối đa 2 rounds.
- Terminal output có bounded memory/IPC.
- OMP/CLI path ổn định.
- Attachment lifecycle fail-closed.
- Native Messaging security path pass E2E.
- Real runtime soak pass.
- Không có memory/process growth bất thường trong long session.
- Split terminal không race/double-trigger.
- Không thêm subsystem mới chỉ để chạy theo Orca.

## 15. Final verdict

AntiFan HEAD `9e06cc4` đã đủ trưởng thành để **đóng feature development và bước vào Final verification**.

Khoảng cách còn lại chủ yếu là bằng chứng runtime, không phải thiếu feature.

Theo đúng workflow của bạn, tiêu chuẩn Final là:

```text
Làm theme Sapo/storefront bằng OMP nhiều giờ
→ Chromium vẫn responsive
→ Terminal vẫn mượt
→ browser target không lệch
→ context đủ giàu nhưng không phình
→ QA luôn kiểm tra đúng state mới
→ AI chỉ tự sửa tối đa một lần sau QA #1
```

Khi **real runtime soak** và **closed-loop E2E** đều pass, nên feature-freeze AntiFan.

Từ đó chỉ nhận:
```text
bug
security
regression
performance regression
real UX friction
```

AntiFan nên tiếp tục được giữ đúng vai trò:

> **Chromium + Terminal + OMP + Theme Context + Theme QA**
