---
title: Đếm số lần sử dụng từng MCP trong Core Health UI — hợp đồng & hướng đúng
date: 2026-09-17T23:02
status: accepted
mode: ak:brainstorm --advice
scope: read-only điều tra + bounded delivery contract (không implement)
trigger: "Công cụ đo số lần sử dụng từng MCP một trong Core Health UI không?"
answer_to_trigger: KHÔNG có — chưa tồn tại counter per-MCP ở bất kỳ đâu, Core Health UI cũng không hiển thị
decisions:
  surface: tách đôi — row `mcp.proxy_calls` trong tab Sức khỏe Core + bảng per-tool trong detail pane của MCP tab
  aggregate_semantics: thêm `gating?: boolean` (mặc định true) vào `CoreHealthCheck`; `worstOf` chỉ gộp check gating
  choke_point: đầu `invoke()` trong scripts/antifan-omp-mcp.cjs
  sink: bảng `mcp_usage` trong super-core SQLite (WAL, dùng chung .super-core/core.db)
advisory: kongming subagent (4m22s) — verdict GO + 2 correction, cả hai đã kiểm chứng độc lập bằng source (xem §Advisory)
handoff: ak:plan, rồi /ak:cook
---

# Brainstorm — Counter per-MCP cho Core Health UI

## Summary

Câu hỏi gốc ("có công cụ đo số lần dùng từng MCP trong Core Health UI không?") trả lời là **không**.
Điều tra live cho thấy *nguyên liệu thô đã tồn tại* nhưng **sai chỗ và thiếu một nửa bề mặt**:

- `InvocationLedger` đã ghi mọi capability được dispatch: `E:\Work\.antifan-data\control-plane-v2\invocations\`
  = 1039 partition, **232 MB**, **18 592 frame**, **83 name** khác nhau, states
  {completed 16 884, failed 1 520, interrupted 74, in_progress 62, unknown 61}.
- Nhưng **0 frame `core.*`** (`select(.name|startswith("core."))` → 0), vì `core.*` được phục vụ
  trong proxy, không bao giờ tới bridge. Ledger còn **trộn caller nội bộ** (workflow engine, theme QA)
  và dùng **namespace hỗn hợp** (alias `anti.browser.evaluate` 8 891 lẫn canonical `browser.navigate` 862).
- Vì vậy đọc ledger trực tiếp **không** dùng được để ra quyết định retire alias (blocker **B29**:
  "retire 20 routing row = breaking wire-name change, cần user quyết" — `plans/260915-1658-goal-p0-retrieval-bridge-completion/phase-08-reacceptance.md:84`).
- `core.tool_intel` (700 dòng) là *kiến thức về tool* với `usageFrequency` dạng text tự khai — **không phải bộ đếm**.
  Benchmark telemetry (`src/main/benchmark/telemetry.ts`) opt-in qua `ANTIFAN_BENCHMARK=1` và chỉ ghi stdout.

**Hướng đúng:** đếm ở **đầu `invoke()` của proxy** (cửa MCP duy nhất, thấy đúng wire name client gửi,
bao gồm `core.*` và cả các call bị từ chối), ghi vào một bảng đếm bounded trong super-core SQLite,
đọc qua một lệnh CLI read-only mới, rồi hiển thị ở **hai chỗ đã có sẵn** trong hub.

---

## Hợp đồng (bounded contract)

**Outcome**
Mỗi MCP tool mà client thật sự gọi có một dòng số liệu luỹ kế đọc được trong Core Health UI: **tên wire client gửi**,
số lần gọi, số thành công/lỗi, lần dùng cuối — đủ để kết luận tool/alias nào đã chết (phục vụ quyết định B29)
mà không phải suy đoán.

**Constraints**
- Choke point duy nhất: `invoke()` — `scripts/antifan-omp-mcp.cjs:1505`. Electron `--mcp-server` đã khai tử
  (`src/main/index.ts:150`), `AntiFanMcpServer` chỉ còn dùng trong smoke test ⇒ proxy là cửa MCP duy nhất.
- Đếm ở **đầu** `invoke()` (trước cả permission check) để bắt được cả call bị từ chối.
  Retry transport nằm *bên trong* `invoke` (`sendDispatch` gọi lại, dòng 1620-1680) ⇒ một `invoke()` = một logical call,
  không cần xử lý trùng.
- Sink dùng chung `.super-core/core.db`: `scripts/antifan-core.cjs:28` (cwd = repoRoot),
  `src/main/tools/core-capabilities.ts:85`, proxy `:451` — cùng một file; DB **đã WAL**
  (`packages/super-core/src/schema.ts:130`) + `PRAGMA busy_timeout = 5000` ⇒ đa tiến trình đã là hiện trạng.
- Không quét 232 MB ledger trên main thread (đúng defect đã đăng ký trong `plans/bottlenecks.json` về scan
  đồng bộ không giới hạn). `CoreHealthService.cli()` spawn async, timeout 15 s, cache 5 s, dedupe in-flight
  (`src/main/diagnostics/core-health.ts:265-333`) ⇒ đi qua CLI là an toàn cho main thread.
- Bảng đếm phải **bounded keyspace** (unknown wire name gom vào một bucket) — client có thể gửi tên tuỳ ý.
- Không được bóp méo status tổng: `worstOf` hiện gộp **mọi** check (`core-health.ts:188-203`) và **không có**
  cờ `gating` (grep = 0 hit) ⇒ phải thêm tường minh (đã chốt, xem §Quyết định).

**Non-goals**
- Không đếm call nội bộ (workflow engine, theme QA) — đó không phải MCP.
- Không ghi log tham số per-call (ledger đã làm việc đó; sai mục đích).
- Không retire alias/routing row trong cùng hạng mục này (B29 vẫn là quyết định riêng của user).
- Không đổi format ledger, không đổi hợp đồng schema của capability catalogue.

**Acceptance criteria** (proof sống, fixture không tính)
1. **Delta chính xác:** ghi số trước → gọi thật K call, gồm 1 alias (`anti.screenshot.viewport`),
   1 canonical (`browser.inspect_styles`), 1 `core.*` (`core.health`) → `antifan-core.cjs usage` tăng đúng
   **+1** cho mỗi tên **theo wire name**, `lastUsedAt` mới; snapshot hiển thị đúng.
2. **Không quyết định status tổng:** row usage xuất hiện trong tab Sức khỏe Core mà `snapshot.status` không đổi.
3. **Trung thực khi hỏng:** ép lỗi ghi DB → `droppedWrites` tăng và detail nói rõ số liệu chưa đầy đủ
   (không được trả số 0 tự tin sai).
4. **Chi phí bounded:** 1 000 call không sinh scan/đọc file nặng; mỗi call = 1 upsert.

---

## Bằng chứng đã kiểm chứng

| Sự kiện | Nguồn |
|---|---|
| Proxy là cửa MCP duy nhất | `src/main/index.ts:150-153`; `scripts/antifan-agent.cjs:843-846`; `package.json:12,17` |
| Choke point + retry trong cùng hàm | `scripts/antifan-omp-mcp.cjs:1505`, `:1553-1680` |
| Proxy không ghi file nào (hiện tại) | grep `appendFile\|writeFileSync\|createWriteStream\|jsonl` trong proxy → 0 hit |
| DB chung + WAL | `packages/super-core/src/schema.ts:130` (`PRAGMA journal_mode = WAL`), `:5` (SCHEMA_VERSION=10), `:559` (MIGRATIONS) |
| Tiền lệ "read-only list surface cho Core Health UI" | `scripts/antifan-core.cjs` case `regressions` / `task-runs` / `health` |
| UI: checks → list row | `src/renderer/toolbar.ts:709-729`; detail body JSON: `renderCoreDetail` (tab core-health) |
| UI: MCP tab + detail pane đã có | `toolbar.ts:957-983` (`selectMcpTool`), badge = tool count `:499` |
| Không có cờ gating | grep `gating` trong `src/main/diagnostics/core-health.ts` → 0 hit; `worstOf` `:188-203` |
| Ledger live | `.antifan-data/control-plane-v2/invocations/`: 1039 file, 232 MB, 18 592 frame, 83 name, 0 `core.*` |

Phân bố hiện tại (đọc ledger, chỉ để tham chiếu — **thiếu toàn bộ `core.*`**):
`anti.browser.evaluate` 8 891 · `browser.navigate` 862 · `browser.switch-tab` 782 ·
`browser.set-automation-target` 764 · `browser.inspect_styles` 691 · `browser.list-tabs` 687 ·
`browser.set-viewport` 610 · `browser.screenshot` 564 · `browser.reload` 475 · `browser.visual_compare` 418.

---

## Options đã cân nhắc

### Option A — Instrument đầu `invoke()` + bảng đếm trong super-core (**chốt**)
Đếm ở đầu `invoke()` theo **raw method client gửi**, upsert vào bảng `mcp_usage` trong `.super-core/core.db`,
đọc qua lệnh `usage` mới của `antifan-core.cjs`, `CoreHealthService` gọi qua `cli()` sẵn có.
- **Giả định chịu lực:** proxy là cửa MCP duy nhất (đã xác minh) và các bên dùng chung một DB (đã xác minh).
- **Fail đầu tiên (worst case):** ghi DB fail âm thầm trong khi call vẫn chạy → bảng "chứng minh" một alias không dùng
  → B29 retire nhầm → client thật vỡ. **Guard bắt buộc:** try/catch quanh ghi + `droppedWrites` + `since`
  hiển thị trong detail, kèm luật quyết định: *zero count chỉ nghĩa "chưa dùng" khi `droppedWrites === 0`
  trong cửa sổ thời gian nêu rõ*.

### Option B — Suy ra từ `InvocationLedger` (counter tăng dần lúc `settle()`)
Không thêm writer mới, không thêm hợp đồng liên tiến trình.
- **Giả định chịu lực:** "bridge-dispatched" = "MCP usage" — **sai trên dữ liệu thật**: 0 frame `core.*`,
  lại trộn caller nội bộ.
- **Fail đầu tiên:** người đọc coi 83 name là danh sách MCP usage đầy đủ → quyết định retirement sai. Bị loại.

### Option C — Proxy ghi jsonl, app đọc và gộp
- **Giả định chịu lực:** app và proxy đồng thuận được data root — proxy **không có** resolver data root
  (chỉ biết `SUPER_CORE_DB` hoặc `<repo>/.super-core`).
- **Fail đầu tiên:** hai bản cài (dev/prod) ghi hai gốc khác nhau → path drift. Bị loại.

### Option D — Không làm gì (steelman)
Đo tạm bằng `jq` trên ledger là đủ cho câu hỏi "tool nào hot".
**Phản biện:** đúng cho câu hỏi hot/cold của bề mặt bridge, nhưng (a) mù hoàn toàn `core.*`,
(b) không tách được call MCP khỏi call nội bộ, (c) không có lịch sử theo thời gian/`lastUsedAt`,
(d) vẫn phải chạy tay 232 MB mỗi lần hỏi. Không đủ làm bằng chứng cho quyết định retire.

---

## Hướng đúng (chốt)

1. **Đếm tại đầu `invoke()`** (`scripts/antifan-omp-mcp.cjs`), key = **raw method client gửi**, cộng
   `ok`/`failed`/`lastUsedAt`; unknown name gom vào bucket bounded; mọi lỗi ghi chỉ tăng `droppedWrites`,
   không bao giờ làm hỏng call.
2. **Lưu trong super-core SQLite:** bảng `mcp_usage` — bump `SCHEMA_VERSION` 10 → 11 + thêm entry
   `{from:10,to:11}` trong `MIGRATIONS` và thêm bảng vào DDL cho DB mới.
3. **Đọc qua CLI:** thêm case `usage` vào `scripts/antifan-core.cjs` (đúng tiền lệ `regressions`/`task-runs`:
   đọc bằng `core.db.prepare(...)`, không dựng authority thứ hai, không thêm method vào store nếu không cần).
4. **Snapshot:** thêm check tên **`mcp.proxy_calls`** (không đặt là `mcp.usage` — tránh bị đọc nhầm thành
   "usage phía server"), detail nêu rõ *"external MCP client calls via stdio proxy, cumulative since {firstUsedAt}"*
   và nói rõ vắng mặt KHÔNG nói gì về caller nội bộ.
5. **`gating?: boolean` (mặc định `true`)** cho `CoreHealthCheck`; `worstOf` chỉ gộp check gating.
   Row usage luôn được báo cáo nhưng không quyết định HEALTHY/DEGRADED.
6. **UI tách đôi:** row trong tab Sức khỏe Core (điểm vào) + bảng per-tool (calls / ok / failed / lastUsedAt)
   trong detail pane của MCP tab — nơi quyết định retire alias thực sự diễn ra (`selectMcpTool` đã có sẵn).

---

## Rủi ro

1. **Zero tự tin sai** — ghi fail im lặng ⇒ chính là kịch bản dẫn tới retire nhầm. Guard ở Option A là bắt buộc, không phải tuỳ chọn.
2. **Đọc nhầm ngữ nghĩa** — proxy counts ≠ capability usage phía server (call nội bộ không đi qua proxy;
   `tools/list` không đi qua `invoke`). Phải thể hiện trong tên check + detail, không chỉ trong tài liệu.
3. **Đa writer SQLite** — nhiều proxy process (nhiều session harness) + app + CLI cùng mở một DB.
   WAL + `busy_timeout 5000` đã là hiện trạng chấp nhận được, nhưng đây là lý do **không** dùng file riêng
   và **không** dùng counter in-memory.
4. **Nhiễu từ tooling** — `scripts/audit-capability-reachability.mjs`, `generate-mcp-capability-map.mjs`,
   smoke test cũng spawn proxy; chúng gọi `tools/list` (không vào `invoke`) nhưng nếu có gọi tool thì sẽ được đếm.
   Cần nêu trong detail nếu muốn phân biệt.
5. **Bounded keyspace** — không cap thì một client gửi tên rác sẽ làm bảng phình; cap + bucket unknown là bắt buộc.

---

## Quyết định đã chốt (2026-09-17)

| Hạng mục | Quyết định |
|---|---|
| **Surface** | **Tách đôi:** row `mcp.proxy_calls` trong tab Sức khỏe Core + bảng per-tool trong detail pane của MCP tab |
| **Aggregate semantics** | **Thêm `gating?: boolean` (mặc định true)** vào `CoreHealthCheck`; `worstOf` chỉ gộp check gating |
| **Choke point** | Đầu `invoke()` của `scripts/antifan-omp-mcp.cjs` |
| **Sink** | Bảng `mcp_usage` trong super-core SQLite (WAL, dùng chung `.super-core/core.db`) |
| **Tên check** | `mcp.proxy_calls` (không phải `mcp.usage`) |

## Advisory (--advice)

`kongming` subagent, 4m22s, verdict **GO** trên Option A kèm 2 correction. Host là single-model
(`aibox/ds/deepseek-flash`) nên đây là counsel cùng họ model, không pin được Fable/Sol — ghi rõ để không thổi phồng.
Hai correction đã được kiểm chứng độc lập bằng source trước khi nhận:

1. "super-core DB vốn đã WAL" — **đúng**, `packages/super-core/src/schema.ts:130` (`PRAGMA journal_mode = WAL`)
   ⇒ lo ngại 2 writer nhẹ hơn mô tả ban đầu trong evidence packet (đã sửa lại ở §Constraints).
2. "`CoreHealthCheck` không có cờ `gating`, `worstOf` gộp mọi check" — **đúng**, grep = 0 hit
   ⇒ cơ chế "non-gating check" phải được hiện thực tường minh, không được giả định là có sẵn.

Điểm kongming thêm mà tôi giữ: đếm ở `invoke()` cho ngữ nghĩa "logical call" miễn phí (retry nằm trong cùng hàm);
bảng bounded keyspace; và acceptance phải là **delta chính xác trên live data** — fixture DB không tính.

## Bàn giao

Giao cho `ak:plan` (rồi `/ak:cook`) với 4 field hợp đồng + hướng đã chọn + bằng chứng + rủi ro ở trên.
Không truyền `--yagni` (user không yêu cầu).
