# AntiFan — Báo cáo phân tích các điểm cải thiện đáng giá nhất

**Phiên bản phân tích:** nhánh `main`, trạng thái repo quan sát ngày 25/08/2026  
**Phạm vi:** tập trung vào source code và kiến trúc hiện tại; không dùng README làm cơ sở chính để kết luận kiến trúc.  
**Mục tiêu:** tìm các cải thiện có tỷ lệ **Impact / Effort** cao nhất, tránh biến AntiFan thành một sản phẩm quá rộng trước khi phần lõi trở nên thật sự mạnh.

---

# Executive Summary

AntiFan hiện đã vượt qua giai đoạn “Electron browser có thêm terminal”. Cấu trúc source cho thấy hệ thống đang có các subsystem riêng cho:

- Agent
- Browser
- Chat
- Control Plane
- MCP
- Project / Workspace
- Run
- Session
- Security
- Tools / Capabilities
- Workflow
- QA

Đây là một nền tảng tốt để AntiFan trở thành **local AI workbench / agent harness**. Điểm mạnh nhất hiện tại không phải từng tính năng riêng lẻ mà là hướng kiến trúc đang hội tụ vào một lớp điều phối chung: **Control Plane + Capability Layer + Run/Session lifecycle**.

Tuy nhiên, rủi ro lớn nhất cũng xuất hiện từ chính sự phát triển này: AntiFan đang có rất nhiều subsystem trước khi “contract trung tâm” giữa Agent → Intent → Run → Capability → Verification được chuẩn hóa hoàn toàn.

## Cảnh báo quan trọng về đường thực thi Workflow

Source hiện có hai đường mang tên Workflow nhưng không có cùng độ tin cậy. Workflow Hub gọi các handler IPC legacy trong `src/main/browser/native-tab-host.ts`: `antifan:workflow:run` chỉ tìm definition rồi trả về `status: 'passed'`, còn `antifan:workflow:abort` luôn trả về `true`; không có bước nào được thực thi. Vì vậy, Workflow Hub hiện là **stub / false-positive verification path**, không phải bằng chứng workflow đã chạy thành công.

Đường thực thi thật nằm ở capability runtime: `ControlPlaneRuntime` khởi tạo `WorkflowEngine`, đăng ký capability `workflow.execute`, và `CapabilityTransportAdapter` chuyển request vào `CapabilityCatalogue`. Đường này mới kiểm tra execution context và gọi engine để chạy các step, tạo artifact và trả execution result. Hai đường này không được gộp trong báo cáo thành một Workflow subsystem đã hoạt động end-to-end.

Hệ quả ưu tiên: phải đóng false-positive path trước khi xây dashboard hoặc timeline. Khi triển khai, handler UI chỉ nên là adapter gọi application-level workflow/run service; không đặt execution trực tiếp vào `NativeTabHost`. Service đó phải nhận và giữ runtime lease, authoritative browser target, workspace root, capability grant, artifact store và abort lifecycle rồi ủy quyền xuống capability runtime.


## Kết luận ưu tiên

Nếu chỉ chọn **5 việc đáng làm nhất tiếp theo**, tôi ưu tiên:

1. **Đóng Workflow Hub false-positive path qua application-level workflow/run service** — thay handler IPC stub bằng adapter có context, run identity, artifact correlation và abort thật; không đưa execution trực tiếp vào `NativeTabHost`.
2. **Chuẩn hóa Agent Task Contract và Run Lifecycle**
3. **Biến Capability Catalogue thành API duy nhất cho mọi action**
4. **Xây Verification / Evidence Loop first-class**
5. **Tạo một Execution Timeline / Debugger cho toàn bộ agent run**

Agent Adapter Layer vẫn là hướng cần thiết khi bắt đầu hỗ trợ nhiều CLI, nhưng chưa nên đứng trước việc làm cho đường Workflow Hub hiện tại không còn báo thành công giả.

Đây là các cải thiện có thể nâng AntiFan từ “nhiều feature tốt” thành “một harness có hệ điều hành rõ ràng”.

---

# 1. Bức tranh kiến trúc hiện tại

Có thể mô hình hóa AntiFan hiện tại như sau:

```mermaid
flowchart TB
    U[User]

    U --> UI[AntiFan Workbench]
    UI --> WUI[Workflow Hub legacy IPC]
    UI --> CP[Control Plane]

    WUI --> STUB[Workflow run stub\nfalse-positive passed]

    CP --> PR[Project / Workspace]
    CP --> RUN[Run Service]
    CP --> EVT[Event Store]
    CP --> REC[Receipt / Artifact]
    CP --> CAP[Capability Catalogue]

    CAP --> BR[Browser]
    CAP --> TR[Terminal]
    CAP --> MCP[MCP]
    CAP --> WF[WorkflowEngine\nreal capability path]

    AG[CLI / AI Agents] --> MCP
    AG --> TR
    AG --> CP

    WF --> CAP
```

Đây là sơ đồ **hiện trạng**, không phải kiến trúc đích. `Workflow Hub legacy IPC` hiện không nối vào `WorkflowEngine`; nó kết thúc ở handler stub trả thành công giả. Đường `workflow.execute` trong Capability Catalogue mới là đường thực thi thật.

Kiến trúc này có tiềm năng tốt vì nó đang phân biệt tương đối rõ:

- **Surface**: UI, browser, terminal
- **Execution**: run, workflow, agent
- **Capabilities**: các hành động hệ thống có thể thực thi
- **State / Evidence**: events, receipts, artifacts
- **Scope**: project, workspace, session

Điểm cần làm tiếp theo không phải thêm thêm một surface mới. AntiFan nên đầu tư vào **hợp nhất execution semantics** giữa các surface hiện có, bắt đầu bằng việc thay đường UI stub bằng application-level workflow/run service.

---

# 2. Ưu tiên #1 — Chuẩn hóa “Task → Run → Result” thành hợp đồng trung tâm

## Hiện trạng

AntiFan đã có Run, Session, Event Store, Receipt Store, Workflow và Agent subsystem. Đây là các mảnh tốt, nhưng hiện chưa thể coi mọi Workflow execution là đáng tin: Workflow Hub UI vẫn đi qua legacy IPC stub, trong khi `WorkflowEngine` thật chỉ được gọi bởi capability `workflow.execute`.

Hiện tại có nhiều đường thực thi với độ tin cậy khác nhau:

```text
User → Workflow Hub legacy IPC → status='passed' giả, không chạy step

Capability / MCP / workflow caller → workflow.execute → WorkflowEngine thật

User → Terminal → CLI agent → kết quả

User → MCP → Browser → capability result
```

Nếu mỗi đường có cách biểu diễn trạng thái khác nhau, sau này sẽ rất khó:

- quan sát
- retry
- resume
- audit
- debug
- orchestration giữa nhiều agent

## Đề xuất

Định nghĩa một contract cấp lõi:

```ts
TaskIntent
  ↓
ExecutionPlan
  ↓
Run
  ↓
RunStep[]
  ↓
CapabilityCall[]
  ↓
Evidence / Artifact
  ↓
Verification
  ↓
FinalResult
```

Ví dụ:

```mermaid
stateDiagram-v2
    [*] --> Queued
    Queued --> Planning
    Planning --> Running
    Running --> WaitingForInput
    WaitingForInput --> Running
    Running --> Verifying
    Verifying --> Completed
    Verifying --> Failed
    Running --> Failed
    Running --> Cancelled
```

## Vì sao đây là ưu tiên số 1?

Vì sau này dù bạn thay:

- OMP
- Codex CLI
- Claude Code
- DeepSeek
- agent nội bộ

thì **Run Contract vẫn không thay đổi**.

AntiFan sẽ sở hữu execution model thay vì phụ thuộc vào model/agent nào.

### Impact: 10/10  
### Effort: 7/10  
### ROI: Rất cao

---

# 3. Ưu tiên #2 — Capability Catalogue phải trở thành “Single Execution API”

## Vấn đề cần tránh

Nếu một agent có thể gọi trực tiếp:

- browser manager
- terminal manager
- filesystem
- Electron APIs
- workflow internals

thì capability abstraction sẽ bị bypass.

Điều đó làm:

- permission khó kiểm soát
- audit không đầy đủ
- retry khó chuẩn hóa
- workflow không thể tái sử dụng action của agent
- plugin khó phát triển

## Kiến trúc nên hướng tới

```mermaid
flowchart LR
    A[Agent]
    W[Workflow]
    U[UI Command]
    M[MCP]

    A --> C[Capability Runtime]
    W --> C
    U --> C
    M --> C

    C --> P[Policy / Permission]
    P --> E[Executor]
    E --> R[Receipt + Event]
```

Tất cả action quan trọng nên có cùng cấu trúc:

```ts
interface CapabilityCall {
  capability: string;
  input: unknown;
  target?: ExecutionTarget;
  projectId?: string;
  workspaceId?: string;
  runId?: string;
  idempotencyKey?: string;
}
```

Kết quả:

```ts
interface CapabilityResult {
  status: "success" | "failed" | "cancelled";
  output?: unknown;
  artifacts?: ArtifactRef[];
  receiptId: string;
}
```

## Giá trị lớn nhất

Sau này bạn có thể làm:

> “Replay chính xác những gì agent đã làm.”

Hoặc:

> “Agent A lên plan, Agent B execute, Agent C verify.”

Tất cả dùng chung capability contract.

### Impact: 10/10  
### Effort: 8/10  
### ROI: Rất cao

---

# 4. Ưu tiên #3 — Verification / Evidence Loop

Đây theo tôi là **feature có thể tạo khác biệt thực tế lớn nhất cho workflow của bạn**.

Bạn đang dùng AntiFan để làm những việc liên quan:

- browser
- UI
- theme
- web development
- responsive review
- DOM inspection

Các agent coding thường mạnh ở “thay đổi code” nhưng yếu ở “chứng minh rằng thay đổi đó đúng”.

## AntiFan có lợi thế sẵn có

- Chromium thật
- DOM inspection
- Screenshot
- Desktop/Mobile split review
- Terminal
- Artifact store
- WorkflowEngine capability path
- Workflow Hub UI surface (hiện còn stub, chưa phải evidence)

Nên AntiFan có thể đóng vòng:

```mermaid
flowchart LR
    A[Agent sửa code]
    A --> B[Start dev server]
    B --> C[Open Browser]
    C --> D[Inspect DOM]
    D --> E[Capture Screenshot]
    E --> F[Run checks]
    F --> G{Pass?}
    G -->|No| A
    G -->|Yes| H[Evidence attached to Run]
```


## Đề xuất

Tạo `VerificationPolicy` cho mỗi loại task:

### UI task

- page load thành công
- console không có lỗi nghiêm trọng
- target selector tồn tại
- screenshot evidence
- desktop/mobile verification

### Code task

- typecheck
- test
- build
- targeted runtime check

### Browser task

- navigation committed
- expected DOM state
- screenshot
- optional network check

## Tại sao quan trọng?

Nó biến AntiFan từ:

> “Agent có tool để làm”

thành:

> “Agent phải tạo evidence rằng nó đã làm đúng.”

Đây là điểm rất hợp với một AI harness.

### Impact: 10/10  
### Effort: 6/10  
### ROI: Cực cao

---

# 5. Ưu tiên #4 — Agent Adapter Layer

Hiện tại AntiFan có thể làm việc với các CLI agent khác nhau. Nhưng đừng để từng agent trở thành một integration đặc biệt.

## Kiến trúc đề xuất

```mermaid
flowchart TB
    CP[Control Plane]

    CP --> AD[Agent Adapter Interface]

    AD --> OMP[OMP Adapter]
    AD --> CODEX[Codex Adapter]
    AD --> CLAUDE[Claude Adapter]
    AD --> FUTURE[Future Agent Adapter]

    OMP --> RT[PTY / Process]
    CODEX --> RT
    CLAUDE --> RT
```

Một interface tối thiểu:

```ts
interface AgentAdapter {
  id: string;

  start(request: AgentStartRequest): Promise<AgentRun>;
  sendInput(runId: string, input: AgentInput): Promise<void>;
  interrupt(runId: string): Promise<void>;
  getStatus(runId: string): Promise<AgentStatus>;
}
```

## Điều quan trọng

Không nên cố ép mọi agent phải có cùng feature.

Nên dùng capability discovery:

```text
OMP:
  supportsSteering = true
  supportsStructuredEvents = false

Codex:
  supportsPlan = true
  supportsReview = true

Claude:
  supportsSubagents = true
```

Control Plane chọn workflow dựa trên capability của agent.

### Impact: 9/10  
### Effort: 6/10  
### ROI: Rất cao

---

# 6. Ưu tiên #5 — Execution Timeline / Agent Debugger

Hiện tại hệ thống có Event Store và Receipt Store. Đây là cơ hội lớn.

Tôi nghĩ AntiFan nên có một UI dạng:

```text
RUN #481  ───────────────────────────────────
10:02:11  Intent created
10:02:13  OMP started
10:02:20  Agent inspected project
10:02:42  Terminal command executed
10:02:58  Browser navigated
10:03:04  DOM inspected
10:03:09  Screenshot captured
10:03:14  Verification failed
10:03:20  Agent corrected code
10:03:39  Verification passed
10:03:40  Run completed
```

Mỗi event có thể expand để xem:

- input
- output
- target
- artifact
- error
- receipt

## Đây là “debugger cho agent”

Khi agent làm sai, thay vì hỏi:

> “Sao nó lại làm vậy?”

Bạn có thể nhìn:

```text
Intent → Decision → Tool call → Observation → Next decision
```

Điều này cực kỳ có giá trị khi AntiFan ngày càng autonomous.

### Impact: 9/10  
### Effort: 5/10  
### ROI: Rất cao

---

# 7. Ưu tiên #6 — Context phải trở thành một subsystem rõ ràng

Đây là điểm tôi thấy chưa nên để agent tự giải quyết hoàn toàn.

Hiện nay context có thể đến từ:

- terminal session
- project
- workspace
- annotation
- artifact
- browser state
- chat
- run history

Nếu cứ gửi tất cả vào agent, context sẽ:

- phình to
- duplicate
- mâu thuẫn
- tốn token
- làm agent mất focus

## Đề xuất: Context Pack

Trước khi gọi agent, Control Plane tạo:

```text
Context Pack
├── Task intent
├── Project summary
├── Relevant files
├── Relevant browser state
├── Selected artifacts
├── Current run state
└── Constraints
```

Agent không cần biết tất cả state nội bộ AntiFan.

Nó nhận đúng “working set” cho task.

### Impact: 9/10  
### Effort: 7/10  
### ROI: Cao

---

# 8. Durable Long-Running Runs — tách P0 và P1

Task dùng CLI agent có thể chạy:

- 30 phút
- vài giờ
- qua nhiều bước
- cần user approval

Nếu AntiFan bị restart hoặc Electron crash, run không nên biến mất. Nhưng “không biến mất” có hai mức acceptance khác nhau.

## P0 — Minimum Run Recovery

P0 chỉ bảo đảm dữ liệu execution tối thiểu còn nguyên sau restart:

- persist `runId`, `attemptId`, lifecycle status, checkpoint hoặc last durable event
- startup hydrate các run/attempt chưa terminal thành trạng thái recoverable/unknown rõ ràng; không tự coi process vẫn đang chạy
- giữ terminal lineage, receipts và artifacts cùng correlation với run/attempt gốc
- không tuyên bố reattach hoặc resume khi chưa kiểm tra process và execution target

Đây là phần cần có ngay sau Run Contract để dashboard, evidence và timeline không đọc state mất dữ liệu.

## P1 / Phase 4 — Full Crash Recovery

```mermaid
flowchart LR
    A[Hydrated Run / Attempt]
    A --> B[Check process and target liveness]
    B --> C{Recoverable?}
    C -->|Yes| D[Reattach or resume guarded step]
    C -->|No| E[Mark Unknown / Failed]
    E --> F[User decision or replay diagnostics]
```

Full recovery phải phân biệt:

- process còn sống và có thể reattach
- process chết
- state không xác định
- step có thể resume an toàn theo idempotency contract
- cần user quyết định trước khi tiếp tục

Full recovery là Phase 4, sau Run/Capability/Agent foundations; không phải acceptance của P0 hydration.

### Impact: 8/10  
### Effort: 8/10  
### ROI: Cao, nhưng phần full chỉ làm sau Run Contract

---

# 9. Ưu tiên #8 — Project Intelligence, nhưng đừng vội dùng LLM everywhere

AntiFan của bạn làm việc theo project/workspace. Đây là lợi thế.

Tôi đề xuất xây một `Project Snapshot` có cấu trúc:

```text
.antifan/
├── project.json
├── architecture.md
├── conventions.md
├── commands.json
└── context/
    ├── recent-summary.md
    └── known-issues.json
```

Agent khi vào project có thể biết:

- tech stack
- package manager
- test command
- build command
- architecture summary
- coding conventions
- important files

## Nhưng không cần vector database ngay

Giai đoạn đầu:

1. deterministic discovery
2. generated project summary
3. explicit artifacts
4. selective file context

là đủ.

Chỉ thêm retrieval phức tạp khi thật sự cần.

### Impact: 8/10  
### Effort: 5/10  
### ROI: Rất tốt

---

# 10. Ưu tiên #9 — Policy & Approval Layer

AntiFan hiện có browser, terminal, workflow và agent. Khi agent ngày càng autonomous, một số action cần phân cấp:

```text
Tier 0 — Safe
  read files
  inspect DOM

Tier 1 — Reversible
  edit workspace
  navigate browser

Tier 2 — Significant
  git commit
  delete files

Tier 3 — External
  publish
  deploy
  send data outside machine
```

Capability call có thể yêu cầu:

```ts
approval: "never" | "ask" | "always"
```

Điểm này không cần UI quá phức tạp. Một approval gate tốt sẽ giúp bạn tin tưởng agent hơn.

### Impact: 7/10  
### Effort: 5/10  
### ROI: Cao khi bắt đầu autonomous

---

# 11. Ưu tiên #10 — Plugin System phải bám vào Capability, không phải UI

Repo đã có `packages/plugin-sdk` và plugin riêng. Đây là hướng tốt, nhưng cần tránh plugin can thiệp tùy tiện vào Electron internals.

Plugin lý tưởng nên có:

```mermaid
flowchart LR
    Plugin --> SDK
    SDK --> CapabilityAPI
    SDK --> EventAPI
    SDK --> ArtifactAPI

    Plugin -.not direct.-> ElectronInternals
    Plugin -.not direct.-> BrowserInternals
```

Plugin nên:

- đăng ký capability
- subscribe event
- tạo artifact
- đóng góp workflow step
- thêm UI extension theo contract

Điều này giúp AntiFan mở rộng mà core không thành “plugin spaghetti”.

### Impact: 7/10  
### Effort: 7/10  
### ROI: Trung bình hiện tại, cao về dài hạn

---

# 12. Browser Split Review nên đi xa hơn “2 màn hình”

Split desktop/mobile hiện rất hợp với workflow theme/web.

Bước tiếp theo tôi không khuyên thêm ngay 5–10 device presets.

Thứ đáng làm hơn:

## Review Session

```text
Review Session
├── Desktop target
├── Mobile target
├── synchronized route
├── captured screenshots
├── annotations
├── detected differences
└── final verdict
```

Tức là Split Review trở thành **artifact của một verification run**, không chỉ là UI layout.

Sau này agent có thể nhận:

> “Verify trang này trên Desktop + Mobile và trả evidence.”

### Impact: 8/10  
### Effort: 5/10  
### ROI: Rất cao cho use case của AntiFan

---

# 13. Test Strategy cần theo invariant thay vì chỉ feature

Với AntiFan, nhiều bug nguy hiểm là bug lifecycle.

Ví dụ:

- split navigation loop
- tab đóng nhưng listener còn tồn tại
- target cũ vẫn được agent dùng
- receipt không thuộc đúng workspace
- artifact bị ghi nhầm project
- retry thực thi duplicate action

Nên có test theo invariant:

```text
Invariant:
Một logical navigation chỉ tạo tối đa một mirror navigation.

Invariant:
Capability execution luôn có project/workspace scope hợp lệ.

Invariant:
Không receipt nào thuộc hai run.

Invariant:
Cancelled run không thể tiếp tục gọi capability.
Invariant:
Workflow Hub không thể trả `passed` nếu chưa chạy đầy đủ step qua application-level workflow/run service và nhận kết quả từ `WorkflowEngine`.

Invariant:
Abort từ Workflow Hub phải tác động đến run/attempt đang chạy và kết thúc bằng trạng thái `interrupted` hoặc lỗi thật; trả `true` không đủ.

```

Đây là kiểu test rất đáng đầu tư cho Control Plane.

### Impact: 9/10  
### Effort: 6/10  
### ROI: Rất cao

---

# Những thứ tôi KHÔNG khuyên ưu tiên ngay

## 1. Multi-agent swarm

Chưa cần.

Trước khi nhiều agent làm việc song song, một agent cần:

- run lifecycle tốt
- evidence tốt
- context tốt
- capability boundary tốt

Một agent đáng tin thường giá trị hơn 5 agent không quan sát được.

## 2. Vector database / RAG lớn

Chưa thấy cần.

Project context có thể giải quyết bằng deterministic discovery + summaries trước.

## 3. Thêm thêm AI chat UI

AntiFan đã có đủ surface. Giá trị tiếp theo nằm ở orchestration.

## 4. Tự viết model router quá sớm

Ban đầu nên để routing theo:

- task type
- agent capabilities
- cost preference
- verification requirement

Đừng biến routing thành một “AI quyết định AI” quá sớm.

## 5. Quá nhiều plugin

Plugin SDK nên được ổn định contract trước.

---

# Roadmap đề xuất

## Phase 1 — Harden the Core

**Mục tiêu:** một execution model thống nhất, durable ở mức tối thiểu và không có trạng thái thành công giả.

- [ ] Đưa Workflow Hub legacy IPC qua application-level workflow/run service
- [ ] Bắt buộc runtime lease, authoritative browser target, workspace root, capability grant và artifact store trên đường UI workflow
- [ ] Thay `workflow:abort` stub bằng abort lifecycle gắn với run/attempt
- [ ] Chuẩn hóa Task / Run / Attempt / Step lifecycle
- [ ] Persist run/attempt identity, checkpoint hoặc last durable event
- [ ] Hydrate non-terminal run/attempt sau application restart mà không giả định process còn sống
- [ ] Giữ terminal lineage, receipt và artifact correlation sau restart
- [ ] Capability API thống nhất
- [ ] Idempotency + cancellation semantics
- [ ] Event + Receipt correlation
- [ ] Invariant tests cho `passed`/`failed`/`interrupted` và artifact evidence

**Kết quả:** AntiFan biết chính xác một task đang ở đâu, hydrate được execution state tối thiểu sau restart, và không báo `passed` khi Workflow Hub chưa thực thi step.
---

## Phase 2 — Close the Loop

**Mục tiêu:** agent không chỉ làm, mà còn chứng minh.

- [ ] Verification policies
- [ ] Browser evidence
- [ ] Screenshot artifacts
- [ ] Terminal/build evidence
- [ ] Review sessions
- [ ] Final verification verdict

**Kết quả:** AntiFan có feedback loop thực sự.

---

## Phase 3 — Agent Interoperability

**Mục tiêu:** thay agent không đổi kiến trúc.

- [ ] Agent Adapter contract
- [ ] Capability discovery
- [ ] Normalized status/events
- [ ] OMP adapter
- [ ] Các adapter khác khi thật sự cần

**Kết quả:** AntiFan sở hữu orchestration, không phụ thuộc một agent.

---

## Phase 4 — Full Crash Recovery & Reattach

**Mục tiêu:** có thể tin cậy task dài sau crash, nhưng chỉ resume khi execution target và step contract cho phép.

- [ ] Recovery timeline và restart lineage diagnostics
- [ ] Recovery probe receipts và replay context
- [ ] Crash detection và recovery states
- [ ] Process/target liveness probes
- [ ] Reattach khi process còn sống và target còn hợp lệ
- [ ] Resume/retry có điều kiện theo idempotency và checkpoint contract
- [ ] Unknown-state và user-decision flow
- [ ] Replay diagnostics

P0 chỉ hydrate run/attempt và bảo toàn terminal lineage; mọi reattach/resume thuộc Phase 4.

---

## Phase 5 — Extensibility

- [ ] Stable Plugin SDK
- [ ] Capability extensions
- [ ] Workflow extensions
- [ ] Event subscriptions
- [ ] Project intelligence extensions

---

# Thứ tự đầu tư tôi khuyến nghị

| Rank | Hạng mục | Impact | Effort | Khuyến nghị |
|---|---|---:|---:|---|
| 1 | Workflow Hub execution path | 10 | 4 | Làm ngay; loại bỏ false-positive stub |
| 2 | Unified Run Lifecycle | 10 | 7 | Làm ngay sau application service boundary |
| 3 | Minimum Run Recovery (hydrate + terminal lineage) | 8 | 3 | Làm trong P0; không hứa reattach/resume |
| 4 | Unified Capability API | 10 | 8 | Làm song song với #2 |
| 5 | Verification / Evidence Loop | 10 | 6 | Làm ngay sau core |
| 6 | Execution Timeline | 9 | 5 | Sau khi event/result đáng tin |
| 7 | Agent Adapter Layer | 9 | 6 | Làm khi bắt đầu đa agent |
| 8 | Invariant Testing | 9 | 6 | Làm xuyên suốt |
| 9 | Context Pack | 9 | 7 | Sau khi lifecycle ổn định |
| 10 | Full Crash Recovery / Reattach / Resume | 8 | 8 | P1 / Phase 4, sau agent foundations |
| 11 | Project Intelligence | 8 | 5 | ROI tốt |
| 12 | Policy / Approval | 7 | 5 | Khi autonomy tăng |
| 13 | Plugin Hardening | 7 | 7 | Chưa cần ưu tiên |


---

# Đề xuất kiến trúc đích

```mermaid
flowchart TB
    USER[User]

    USER --> INTENT[Intent]
    INTENT --> PLAN[Plan / Task Contract]
    PLAN --> RUN[Durable Run]

    RUN --> CTX[Context Pack]
    RUN --> ROUTER[Agent / Workflow Router]
    USER --> UI[Workflow Hub UI]
    UI --> CMD[Application workflow/run service]
    CMD --> ROUTER

    ROUTER --> AGENT[Agent Adapter]
    ROUTER --> WF[WorkflowEngine]

    AGENT --> CAP[Capability Runtime]
    WF --> CAP

    CAP --> POLICY[Policy / Approval]
    POLICY --> EXEC[Executor]

    EXEC --> BROWSER[Browser]
    EXEC --> TERMINAL[Terminal]
    EXEC --> MCP[MCP / External Tools]

    EXEC --> EVENTS[Event Store]
    EXEC --> RECEIPTS[Receipts]
    EXEC --> ARTIFACTS[Artifacts]

    ARTIFACTS --> VERIFY[Verification]
    VERIFY --> RUN

    RUN --> RESULT[Final Result + Evidence]
```

`NativeTabHost` chỉ nên giữ vai trò legacy UI IPC adapter. Nó không được tự sở hữu execution lifecycle hoặc gọi `WorkflowEngine` trực tiếp. Application workflow/run service là nơi gắn UI request với run/attempt, runtime lease, authoritative browser target, workspace root, capability grant, artifact store và abort signal trước khi ủy quyền cho capability runtime.

---

# Kết luận cuối cùng

AntiFan hiện có một điều rất đáng giá: **nó đã sở hữu nhiều primitive mà một AI harness nghiêm túc cần**.

- Browser thật
- Terminal thật
- MCP
- Project / Workspace scope
- WorkflowEngine capability path
- Workflow Hub UI surface (chưa phải execution evidence)
- Event / Receipt
- Artifact
- Capability abstraction
- Split responsive review
- Plugin foundation

Vì vậy, chiến lược tốt nhất không phải tiếp tục thêm “feature”.

Chiến lược tốt nhất là:

> **Biến các primitive hiện có thành một execution system thống nhất, observable, verifiable và agent-agnostic.**

Nếu làm tốt 5 ưu tiên đầu tiên, AntiFan sẽ khác biệt ở chỗ:

> Agent có thể thay đổi, model có thể thay đổi, tool có thể thay đổi — nhưng AntiFan vẫn là nơi định nghĩa task, scope, execution, evidence và lifecycle.

Đó mới là phần “moat” đáng đầu tư nhất cho AntiFan.

---

# 14. Đối chiếu Onorca.dev — Những gì AntiFan nên học

Onorca nên được xem như benchmark về **agent-first UX, orchestration và workflow ergonomics**, không phải danh sách feature cần sao chép.

## 14.1 Worktree-first Agent Isolation — P1 sau khi Run durable

Mỗi agent task nên có execution/workspace/worktree riêng:

```mermaid
flowchart LR
    T[Task] --> R[Run]
    R --> W[Isolated Worktree]
    W --> A[Agent]
    A --> V[Verification]
    V --> D[Diff]
    D --> M[Merge / Reject]
```

Worktree nên trở thành primitive của Run: `projectId`, `workspaceId`, `worktreeId`, `agentId`, `verification`, `artifacts`.

**Impact: 10/10 — Effort: 7/10**

## 14.2 Agent Dashboard — P0/P1

Với Run + Event Store + Session hiện có, AntiFan có thể dựng dashboard theo trạng thái:

```text
Needs You
Working
Waiting
Verifying
Blocked
Done
Failed
```

Đây phải là **operational dashboard của Run**, không chỉ là danh sách chat.

**Impact: 9/10 — Effort: 4/10**

## 14.3 Agent Status là first-class state

Không nên chỉ biết PTY/process đang `running`. Nên chuẩn hóa các trạng thái `starting`, `working`, `waiting`, `needs_input`, `blocked`, `verifying`, `completed`, `failed`, `hibernated`.

Đây là nền cho dashboard, orchestration, notification, handoff và recovery.

**Impact: 9/10 — Effort: 5/10**

---

# 15. Orchestration nhiều Agent — học ý tưởng, không copy cơ chế

```mermaid
flowchart TB
    I[Intent] --> P[Planner]
    P --> O[Orchestrator]
    O --> A[Worker A]
    O --> B[Worker B]
    O --> C[Worker C]
    A --> E[Evidence]
    B --> E
    C --> E
    E --> V[Reviewer / Verification]
    V --> O
    V --> F[Final Result]
```

Mọi worker vẫn phải là `Agent Run + Workspace + Worktree + Capability scope + Evidence + Verification`. Không nên tạo một swarm layer nằm ngoài execution model.

**Impact: 9/10 — Effort: 8/10**

# 16. Session Handoff / AI Vault

Session nên chứa:

```text
Session
├── Intent
├── Run history
├── Agent
├── Worktree
├── Events
├── Receipts
├── Artifacts
├── Verification
└── Handoff Summary
```

Các thao tác đáng có: `Continue Run`, `Retry Run`, `Hand Off to Agent`, `Clone Run`, `Open Worktree`, `Inspect Evidence`.

**Impact: 8/10 — Effort: 5/10**

# 17. Task → Worktree → Run → PR

Nên có `TaskSource` cho Manual, GitHub Issue, GitHub PR, Linear và các integration tương lai.

```mermaid
flowchart LR
    T[Task / Issue] --> W[Worktree]
    W --> R[Agent Run]
    R --> V[Verification]
    V --> D[Diff]
    D --> P[PR / Merge]
```

**Impact: 8/10 — Effort: 7/10**

# 18. Inline Diff Review / Annotation

Review comment nên gắn trực tiếp với execution context:

```text
ReviewComment
├── runId
├── worktreeId
├── file
├── line
├── message
└── status
```

Feedback trở thành `ReviewTask` của cùng Run hoặc child Run.

**Impact: 8/10 — Effort: 5/10**

# 19. Workspace Layout Presets

Split Browser mở ra một hướng tốt hơn: layout theo loại task.

```text
UI Review
├── Agent
├── Terminal
├── Desktop Browser
├── Mobile Browser
└── Diff

Backend
├── Agent
├── Terminal
├── Logs
└── Tests
```

**Impact: 8/10 — Effort: 5/10**

# 20. Remote Execution Target

Nên chừa abstraction:

```ts
type ExecutionTarget =
  | { type: "local" }
  | { type: "ssh"; hostId: string }
  | { type: "container"; id: string }
  | { type: "vm"; id: string };
```

Triển khai remote có thể để P2 nhưng abstraction nên xuất hiện sớm trong design.

**Impact hiện tại: 6/10 — Giá trị dài hạn: 10/10**

# 21. Mobile Companion — chỉ nên làm Control Console

Không cần copy nguyên IDE lên mobile. Chỉ cần remote run dashboard với Working, Needs You, Verification Failed, Approve, Stop và Resume.

**Impact: 6/10 — Effort: 7/10**

# 22. Usage / Account Management

Khi hỗ trợ nhiều CLI agent, usage/account có thể thành capability để router biết provider/account nào đang rate-limited hoặc còn quota. Đây là P2.

**Impact: 6/10 — Effort: 6/10**

# 23. Unified Search / Command Surface

Một search spine nên tìm được Files, Runs, Agents, Worktrees, Tasks, Artifacts, Events, Browser Tabs và Commands.

**Impact: 7/10 — Effort: 4/10**

# 24. AntiFan không nên copy Onorca theo feature count

Onorca đang tối ưu cho: `One place to manage many agents.`

AntiFan nên tối ưu cho: `One execution/control plane for any agent, tool and surface.`

Không nên ưu tiên sớm hàng chục agent integrations, mobile IDE đầy đủ, emulator support, nhiều Git providers hay quá nhiều native integrations. Nên học **object model**, không sao chép feature list.

# 25. Roadmap AntiFan sau khi đối chiếu Onorca

## P0 — Harden the Execution Core

```text
1. Workflow Hub Execution Path / false-positive fix
2. Unified Run Lifecycle
3. Minimum Run Recovery (hydrate + terminal lineage)
4. Unified Capability Runtime
5. Verification / Evidence Loop
6. Invariant Tests
7. Execution Timeline
```

P0 bắt đầu bằng việc loại bỏ đường UI báo thành công giả. Minimum Run Recovery chỉ hydrate run/attempt và giữ terminal lineage sau restart; không bao gồm reattach hoặc resume. Worktree không nằm trong P0 vì ownership, recovery và cleanup của worktree chỉ đáng tin sau khi Run/Attempt đã durable.

## P1 — Turn AntiFan into an Agent Operating Environment

```text
8. Worktree Isolation
9. Agent Status Model
10. Agent Dashboard
11. Agent Adapter Layer
12. Orchestration
13. Session Handoff
14. Diff Review / Annotation
15. Task → Worktree → Run → PR
16. Workspace Layout Presets
17. Context Packs
18. Project Intelligence
19. Full Crash Recovery / Reattach / Resume
```

Full Crash Recovery / Reattach / Resume là phần Phase 4: chỉ chạy sau khi có durable run/attempt state, capability/agent foundations và các guard về idempotency.

## P2 — Scale Beyond One Machine

```text
20. Remote Execution
21. Mobile Control Console
22. Usage / Account Management
23. GitHub / Linear integrations
24. Plugin ecosystem hardening
``` 



# 26. Bảng ưu tiên cuối cùng

| Rank | Hạng mục | Impact | Effort | Priority |
|---|---|---:|---:|---|
| 1 | Workflow Hub execution path / false-positive fix | 10 | 4 | P0 |
| 2 | Unified Run Lifecycle | 10 | 7 | P0 |
| 3 | Minimum Run Recovery (hydrate + terminal lineage) | 8 | 3 | P0 |
| 4 | Unified Capability Runtime | 10 | 8 | P0 |
| 5 | Verification / Evidence Loop | 10 | 6 | P0 |
| 6 | Invariant Testing | 9 | 6 | P0 |
| 7 | Execution Timeline | 9 | 5 | P0 |
| 8 | Worktree Isolation | 10 | 7 | P1 |
| 9 | Agent Status Model | 9 | 5 | P1 |
| 10 | Agent Dashboard | 9 | 4 | P1 |
| 11 | Agent Adapter Layer | 9 | 6 | P1 |
| 12 | Orchestration | 9 | 8 | P1 |
| 13 | Session Handoff | 8 | 5 | P1 |
| 14 | Diff Annotation | 8 | 5 | P1 |
| 15 | Task → Worktree → PR | 8 | 7 | P1 |
| 16 | Workspace Layout Presets | 8 | 5 | P1 |
| 17 | Context Pack | 9 | 7 | P1 |
| 18 | Project Intelligence | 8 | 5 | P1 |
| 19 | Full Crash Recovery / Reattach / Resume | 8 | 8 | P1 |
| 20 | Remote Execution | 6 | 8 | P2 |
| 21 | Mobile Control | 6 | 7 | P2 |
| 22 | Usage / Account Manager | 6 | 6 | P2 |
| 23 | GitHub / Linear integrations | 6 | 6 | P2 |
| 24 | Plugin Ecosystem | 7 | 7 | P2 |

# 27. Strategic Direction

```mermaid
flowchart TB
    INTENT[User Intent]
    INTENT --> PLAN[Plan]
    PLAN --> RUN[Durable Run]
    RUN --> WORKTREE[Isolated Worktree]
    RUN --> CONTEXT[Context Pack]
    RUN --> ROUTER[Agent / Workflow Router]
    ROUTER --> AGENT[Agent Adapter]
    ROUTER --> WF[Workflow]
    AGENT --> CAP[Capability Runtime]
    WF --> CAP
    CAP --> POLICY[Policy]
    POLICY --> EXEC[Execution Target]
    EXEC --> LOCAL[Local]
    EXEC --> REMOTE[Remote]
    EXEC --> BROWSER[Browser]
    EXEC --> TERMINAL[Terminal]
    EXEC --> MCP[MCP]
    EXEC --> EVENT[Events]
    EXEC --> RECEIPT[Receipts]
    EXEC --> ARTIFACT[Artifacts]
    ARTIFACT --> VERIFY[Verification]
    VERIFY --> REVIEW[Human / Agent Review]
    REVIEW --> RESULT[Final Result]
```

**Strategic takeaway:** Onorca cho thấy agent-first IDE có thể được làm rất tốt ở tầng UX. AntiFan nên tập trung thắng ở tầng execution architecture.

Nếu AntiFan đạt được **Run + Worktree + Agent + Capability + Evidence + Verification + Handoff** thành một object model thống nhất, thì việc thêm OMP, Codex, Claude, DeepSeek hay agent mới sau này sẽ trở thành adapter problem thay vì architectural rewrite.

---

# Sources / Benchmark Note

Phần Onorca trong báo cáo này được dùng như benchmark kiến trúc và UX, không phải yêu cầu AntiFan phải sao chép feature. Các nhận định về Onorca dựa trên website/docs/changelog công khai tại thời điểm phân tích.
