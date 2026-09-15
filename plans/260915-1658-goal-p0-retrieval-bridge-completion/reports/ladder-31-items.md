# Ladder — 31 hạng mục P0-A → P1 (mẫu số của "100%")

Artifact này định nghĩa **cái gì được đếm**. Không có nó thì "100%" không có mẫu số, và một goal 100% sẽ kết thúc bằng một tuyên bố không kiểm được.

Nguồn: MASTER UPGRADE REPORT — P0-A (10) + P0-B (7) + P0-C (8) + P1 (6) = **31**.

| # | Nhóm | Hạng mục | Phase sở hữu | Trạng thái khởi điểm (đo được) |
|---|------|----------|--------------|-------------------------------|
| 1 | P0-A | TaskRun identity | 3 | Chưa có — grep `taskRunId\|task_run` trên `src/ scripts/ packages/` = 0 hit |
| 2 | P0-A | OMP Extension | 3 | Chưa có — `.omp/hooks/` không tồn tại |
| 3 | P0-A | `before_agent_start` hook | 3 | Chưa có; hợp đồng event đã xác minh trong `omp://docs/hooks.md` |
| 4 | P0-A | Core retrieval | 2 | **Có nhưng lỗi** — `query()` `:220` cho claim untagged đi qua; **2.905/20.832 (13,9%)** claim chưa gắn platform |
| 5 | P0-A | Context Pack | 2 | **Có nhưng lỗi** — `contextPack()` `:248` conflicts không scope; `:251` pack id mới mỗi call |
| 6 | P0-A | OMP injection | 3 | Chưa có — `contextPack` chỉ được gọi trong `scripts/clone-site.mjs` |
| 7 | P0-A | context reattach | 3 | Chưa có — cần `session.compacting` + `preserveData` |
| 8 | P0-A | bridge telemetry | 3 | Chưa có — `BRIDGE_CONTEXT_FAILED` chưa tồn tại |
| 9 | P0-A | pack binding | 3 | Chưa có — không có `(taskHash, platform, sessionId)` |
| 10 | P0-A | end-to-end trace | 3, 8 | Chưa có |
| 11 | P0-B | Core Health service | 6 | Chưa có |
| 12 | P0-B | Health snapshot | 6 | Chưa có — `stats()`/`corpusAudit()` có dữ liệu thô, chưa có snapshot có `reasonCode` |
| 13 | P0-B | Health UI | 6 | Chưa có — `src/renderer/toolbar.html` không có panel markup |
| 14 | P0-B | Bridge UI | 6 | Chưa có |
| 15 | P0-B | Task Run trace (view) | 6 | Chưa có |
| 16 | P0-B | Issue model | 6 | **Một phần** — `IssueRegister` đang chạy, cần mở rộng taxonomy |
| 17 | P0-B | Report Issue | 6 | **Một phần** — `anti.diagnostics.record_issue`/`list_issues` đã phơi |
| 18 | P0-C | Canonical capability manifest | 5 | **Có** — `CapabilityDefinition.inputSchema` (`src/shared/control-plane-contracts.ts`) |
| 19 | P0-C | Remove schema duplication | 5 | Chưa — còn khai báo chéo giữa catalogue / `scripts/antifan-omp-mcp.cjs` / proxy |
| 20 | P0-C | MCP conformance runner | 5 | **Một phần** — `test/main/mcp-industrial-e2e.test.ts`, `scripts/smoke-mcp-industrial-e2e.cjs` |
| 21 | P0-C | Schema parity test | 5 | Chưa — gate hiện chỉ kiểm budget/ceiling, không kiểm parity |
| 22 | P0-C | Transport test | 5 | **Một phần** — có test transport persistent |
| 23 | P0-C | Failure/retry test | 5 | **Một phần** — transport có phân loại retry |
| 24 | P0-C | Idempotency test | 5 | **Một phần** — transport có idempotency |
| 25 | P0-C | Health metrics (MCP) | 5 | Chưa |
| 26 | P1 | Retrieval precision | 2 | **Yếu** — journal tự khai: ranking là **lexical FTS5, chưa semantic** |
| 27 | P1 | Historical reuse | 2, 8 | Chưa — chưa có metric `found + injected + outcome-linked` |
| 28 | P1 | Root cause UI | 6 | Chưa có |
| 29 | P1 | Core regression UI | 6 | **Một phần** — `regressions` table có, **replay engine không** |
| 30 | P1 | Knowledge gap detection | 2 | **Một phần** — `decayCheck()` (`:557`) và `corpusAudit()` (`:572`) đã có |
| 31 | P1 | Learning trace | 4 | **Một phần** — `ingestOutcome` (`:286`) chạy nhưng `observations` = 0, không gắn link |

## Phân bổ theo phase

| Phase | Hạng mục sở hữu | Số |
|---|---|---|
| 1 Safety substrate | — (hạ tầng, không thuộc ladder) | 0 |
| 2 Retrieval integrity | 4, 5, 26, 27, 30 | 5 |
| 3 Context Bridge | 1, 2, 3, 6, 7, 8, 9, 10 | 8 |
| 4 Verified learning | 31 | 1 |
| 5 MCP reliability | 18, 19, 20, 21, 22, 23, 24, 25 | 8 |
| 6 Core Health + 5 surface | 11, 12, 13, 14, 15, 16, 17, **28, 29** | 9 |
| 7 Measurement layer | — (mở khoá phán quyết, không thuộc ladder) | 0 |
| 8 Re-acceptance | 10, 27 (verify) + toàn bộ ladder | — |

**Kiểm mẫu số: 5 + 8 + 1 + 9 + 8 = 31.** ✔ Khớp đúng 31.

## Ghi chú về các mục "một phần"

Các mục đánh dấu **một phần** là nguy hiểm nhất, vì chúng dễ bị tính là "gần xong" và bị đánh `PASS` bằng suy luận. Luật áp dụng:

- `PASS` chỉ khi acceptance signal của mục đó được chứng minh bằng runtime thật, revision-bound.
- Nếu chưa có acceptance signal tương ứng được chứng minh → `FAIL` hoặc `NOT_IMPLEMENTED`, **không** `PASS` với lý do "đã có code".
- Nếu có code nhưng không chạy được trong môi trường → `BLOCKED` + blocker nêu tên.

## Điều kiện để đếm là 100%

```
PASS == 31  AND  SKIP == 0  AND  TIMEOUT == 0
```

`NOT_IMPLEMENTED` và `BLOCKED` **không** cộng vào 100%. Vì vậy một run kết thúc với `NOT_IMPLEMENTED > 0` là **chưa đạt Final**, phải báo đúng như vậy.
