---
title: AntiFan MASTER UPGRADE REPORT — độc lập thẩm định & hướng đúng
date: 2026-09-15T22:59
status: accepted
mode: ak:brainstorm --advice
auditTarget: 43ffb89f11ceb8ef56970c873403f2a2ec22cb5a
scope: read-only analysis + bounded delivery contract
decisions:
  p0_scope: re-sequenced — Retrieval Integrity → Context Bridge → MCP parity; Core Health UI deferred to P1
  reuse_metric: found + injected + outcome-linked
  pack_abstain_threshold: abstain (UNKNOWN + reasonCode) when < 2 quality claims survive platform filter; never inject cross-platform
advisory: same-model counsel — host is single-model (aibox/ds/deepseek-flash); Fable/Sol could not be pinned
handoff: ak:plan, then /ak:cook
---

# Brainstorm — Hướng đúng cho MASTER UPGRADE REPORT

## Summary

Báo cáo MASTER UPGRADE chẩn đoán **đúng** ở phần cốt lõi: AntiFan đã mạnh về capability
nhưng thiếu **identity spine** nối `OMP turn → Core query → Context Pack → injection →
execution → QA → evidence → outcome → learning`. Tôi đã kiểm chứng bằng nguồn: spine đó
thực sự **không tồn tại** (0 kết quả grep cho `taskRunId|task_run|bridge_events|context_bindings|ompSessionId|ompTurnId`).

Nhưng báo cáo **sai 3 điểm kỹ thuật** và **đảo thứ tự ưu tiên**. Hướng đúng: sửa **retrieval
integrity trước**, rồi mới bắc **Context Bridge**, và làm **MCP parity gate rẻ** thay vì
conformance matrix.

---

## Hợp đồng (bounded contract)

**Outcome**
AntiFan trở thành một control plane trong đó: mỗi OMP turn có identity truy được, Core context
được inject tự động và **đúng platform**, sống qua compaction, và **mọi trạng thái hỏng đều có
reason code + trace**. Đo được bằng "historical reuse" thật (tìm thấy → inject → agent dùng →
QA pass → outcome link).

**Constraints**
- Không thêm Workspace / Work Unit / Task Manager / Agent Session Manager / Agent IDE.
- OMP giữ quyền sở hữu session; AntiFan chỉ giữ `ompSessionId`/`ompTurnId` để trace.
- Hook chạy **in-process trong OMP**, AntiFan là **process Electron riêng** → mọi call từ hook
  phải **fail-open** với timeout cứng, không bao giờ làm treo turn.
- Giữ nguyên nguyên tắc: `ingestOutcome` tạo `PENDING`, không auto-promote.
- Giữ nguyên: không chạy `git reset --hard`; rollback là byte-level R0.
- Storage hiện tại: Super Core SQLite WAL, `SCHEMA_VERSION = 5`.

**Non-goals**
- Không thêm MCP tool chỉ để nhiều.
- Không thay vector DB.
- Không thêm terminal feature.
- Không tự động promote knowledge.
- Không đồng bộ conversation history / agent state của OMP.

**Acceptance criteria** (đo được, không cảm tính)
1. Một task Sapo nhận pack **chỉ có rule Sapo** — 0 conflict/claim của Haravan/Shopify lọt vào.
2. Pack sống qua compaction: `packId` không đổi sau `session.compacting`, và trace chứng minh.
3. AntiFan tắt → OMP turn vẫn chạy bình thường, có đúng 1 event `BRIDGE_CONTEXT_FAILED` ghi lại.
4. Mọi capability advertised có `inputSchema` **bằng** schema trong catalogue (gate fail khi lệch).
5. Một incident bất kỳ truy được: symptom → claim/pack → root cause → regression id.

---

## Đối chiếu báo cáo với nguồn (kiểm chứng)

| # | Báo cáo nói | Kiểm chứng | Kết luận |
|---|---|---|---|
| §8 | `contextPack()` nhét mọi unresolved conflict + unknown artifact toàn cục | `packages/super-core/src/index.ts:248-249` — `SELECT * FROM conflicts WHERE state='UNRESOLVED' LIMIT 50` + rollup artifacts `BLOCKED/PENDING` không scope | ✅ **ĐÚNG** |
| §9 | `findSimilar()` chưa platform-aware | `index.ts:516-535` — query `claims` **không có filter platform**; `cases`/`decisions`/`fixPatterns` cũng không; anti-pattern/workaround dùng `LIKE %platform%` | ✅ **ĐÚNG, còn nặng hơn** |
| §9 | — | `schema.ts:113` bảng `cases` **không có cột platform**; `conflicts` cũng không | ⚠️ **Báo cáo bỏ sót**: phải migrate schema mới cô lập được |
| §10 | confidence = đếm claim | `index.ts:784` — `claims.length >= 5 ? 'HIGH' : >= 2 ? 'MEDIUM' : >= 1 ? 'LOW' : 'UNKNOWN'` | ✅ **ĐÚNG** |
| §11 | Pack persistence thiếu field enriched | `index.ts:253` — `INSERT INTO packs(packId,task,platform,claimIdsJson,createdAt)`; `contextPackV2` thêm rules/cases/pitfalls/workarounds/pattern/uncertainty/confidence nhưng **không persist** | ✅ **ĐÚNG** |
| §11 | — | `contextPack()` tạo **pack mới mỗi lần gọi**: `pack-${uuid()}` | ⚠️ **Báo cáo bỏ sót**: pack spam |
| §42 | `ingestOutcome` thiếu link | `index.ts:288-291` — `cases(caseId,task,context,outcome,verificationRef,unitId,createdAt)` | ✅ **ĐÚNG** |
| §51 | MCP ≠ Context Bridge | MCP surface đầy đủ (`core.context_pack*`), spine 0 hit | ✅ **ĐÚNG — insight sắc nhất báo cáo** |
| §33-36 | 8 bảng mới | 0 hit trên toàn `src/scripts/packages` | ✅ **ĐÚNG (greenfield)** |
| §28-29 | Cần "Canonical Tool Manifest" mới | `src/shared/control-plane-contracts.ts:618` — `CapabilityDefinition` **đã có `inputSchema`** | ❌ **SAI**: catalogue đã là canonical; thêm manifest = lớp thứ 3 dư thừa |
| §26 | "Tools discovered 74" | Gate thật: **237 capability**, **116 tool advertised**, **21 row shadow** | ❌ **SAI số** |
| §5-6 | Dùng `before_agent_start` + re-inject mỗi turn | `omp://docs/hooks.md`: `before_agent_start` **chỉ giữ message ĐẦU TIÊN**, các message sau bị bỏ; lever per-call là `context` (chuỗi thay `messages`); lever cho compaction là `session.compacting` / `session_before_compact` | ⚠️ **Cơ chế sai**: báo cáo **không hề nhắc `session.compacting`** — đúng thứ nó cần cho "Tầng C" |
| §21 | Đề xuất "Core Incident System" mới | `src/main/session/issue-register.ts` **đã tồn tại và đang chạy** (`browser-capabilities.ts:14`, `circuit-breaker.ts:46`), expose `anti.diagnostics.record_issue` / `list_issues`, có severity P0-P3 / toolName / errorCode / workaroundApplied / status OPEN-RESOLVED-BYPASSED | ❌ **Báo cáo bỏ sót hoàn toàn** — phải **mở rộng**, không tạo register song song |
| §44 | Chỉ cần UI cho Core Regression | `schema.ts:310` bảng `regressions` + `index.ts:657 recordRegression()` **chỉ nhận `replayResult` như input** — không có replay engine | ⚠️ **Sai mức độ**: thiếu engine, không phải thiếu UI |

**Đo trực tiếp** (`node scripts/check-mcp-budget-dominance.mjs`):
```
[budget-dominance] routing rows that shadow a catalogue registration (21)
[budget-dominance] catalogue: 237 capabilities, largest policy 180000 ms (browser.visual_compare)
[budget-dominance] proxy ceiling: 240000 ms
[budget-dominance] OK: one ceiling dominates every server policy
```
→ Gate **đã** fail khi: row no-op, target không phải registration, tool advertised không resolve,
bảng timeout per-tool tái xuất, ceiling không dominate. **Chưa** kiểm: `inputSchema` equality.

---

## Options đã cân nhắc

### Option A — Làm đúng thứ tự báo cáo (Bridge → Health → MCP)
- **Giả định chính:** pack hiện tại đủ tốt để inject tự động.
- **Fail đầu tiên tại:** pack chứa conflict toàn cục + rule khác platform → LLM nhận constraint sai.
- **Worst case:** công nghiệp hoá nhiễu vào **mọi** turn; agent từ chối đúng, gọi sai tool; chi phí
  token tăng do phá prompt cache.

### Option B — Retrieval integrity trước, rồi Bridge tối thiểu, MCP parity rẻ, Health UI sau
- **Giả định chính:** giá trị của Bridge nằm ở chất lượng pack; sửa pack rẻ hơn nhiều so với sửa UI sau.
- **Fail đầu tiên tại:** nếu Super Core corpus quá mỏng, "platform filter" chỉ làm pack rỗng → cần
  ngưỡng `UNKNOWN` trung thực thay vì abstain im lặng.
- **Worst case:** chậm thấy UI — nhưng không tạo debt.

### Option C — Không làm gì (steelman)
- **Giả định chính:** domain skills (`sapo-liquid`, `haravan-theme`, `theme-qa-az`) đã phủ gotcha tốt
  hơn retrieval keyword chưa curate; context window đã lớn.
- **Fail đầu tiên tại:** khi cần trả lời "task này trước đây đã fix thế nào, bằng chứng đâu".
- **Worst case:** bỏ phí phần Core đã xây; mất khả năng trace.

**Khuyến nghị: Option B.** Theo tiêu chí "chọn cách rẻ nhất để bỏ nếu giả định sai": Option B rẻ
hơn A (migrate + filter là việc nhỏ, có test ngay), và trả hoãn được toàn bộ UI.

---

## Hướng đúng (chốt)

### 1. Đảo thứ tự: Retrieval Integrity là P0 thật
- **Schema v6:** thêm cột `platform` cho `cases` và `conflicts`.
- Scope hoá conflict/unknown theo `platform` + `unitId` trong `contextPack()`.
- Thêm filter platform cho `claims` / `cases` / `decisions` / `fixPatterns` trong `findSimilar()`,
  với ranking: `platform exact > family > generic > unknown`.
- **Chống pack spam:** dedupe theo `(taskHash, platform, sessionId)`; chỉ tạo row khi chưa có.
- **Confidence thật:** thay đếm claim bằng tổ hợp evidence strength + status + platform match +
  recency + conflict state.

### 2. Context Bridge tối thiểu, đúng lever của harness
- `before_agent_start` → seed **một** message (nhớ: chỉ message đầu được giữ).
- `session.compacting` / `session_before_compact` → **giữ pack qua compaction** bằng `preserveData`,
  chỉ re-fetch khi session thực sự compact. **Không** re-inject mỗi turn.
- Fail-open timeout cứng (< 50 ms) + một event `BRIDGE_CONTEXT_FAILED` khi AntiFan vắng.
- Hook client dùng discovery/lease sẵn có (`scripts/antifan-agent.cjs`) + `/status` để probe.
  **Chú ý:** HTTP hiện **không có route RPC tổng quát** (chỉ `/status`, `/api/*` cụ thể) — nên
  dùng WebSocket, hoặc thêm một route read-only hẹp.

### 3. MCP Reliability: parity gate, không phải matrix
- Derive `definitions` của proxy + `inputSchema` của `mcp-server.ts` từ catalogue
  (`CapabilityDefinition.inputSchema` đã tồn tại) **hoặc** thêm check equality vào
  `check-mcp-budget-dominance.mjs`.
- Giữ `test/main/mcp-industrial-e2e.test.ts` làm characterization cho các tool trọng yếu.
- Xử lý 21 shadow row như một sweep có proof từng dòng (đúng như ledger B29 yêu cầu).

### 4. Health + Issues: mở rộng cái đã có, không dựng song song
- Issue: thêm `domain`/`kind` vào `IssueRegister` hiện có (bridge/retrieval/knowledge/mcp), giữ
  `anti.diagnostics.*` là surface.
- Core Regression: viết **replay engine** (hiện chỉ có slot `replayResult`), chạy trước promotion.
- Health snapshot: chỉ dựng **sau** khi spine phát ra dữ liệu thật; UI đọc snapshot, mỗi status có
  `reasonCode` + `affected`.

---

## Rủi ro chưa nêu trong báo cáo

1. **Prompt cache eviction** — chèn pack động vào turn sớm phá prefix cache của provider, chi phí token tăng mạnh.
2. **Attention dilution** — 30+ claim ở đầu turn làm loãng prompt chính ("lost in the middle").
3. **Coupling vòng đời process** — hook in-process nối vào Electron: Electron treo → cả session OMP treo.
4. **SQLite WAL contention** — nhiều subagent song song cùng ghi `packs`/`receipts` → `SQLITE_BUSY`.
5. **Prompt injection gián tiếp** — nội dung web đã scrape lọt vào `cases/claims` rồi được format
   vào system prompt của harness.
6. **Register trùng lặp** — tạo "Core Incident System" mới bên cạnh `IssueRegister` đang chạy.

---

## Quyết định đã chốt (2026-09-15)

| Hạng mục | Quyết định |
|---|---|
| **Phạm vi P0** | **Re-sequence.** P0 = *(1)* Retrieval Integrity → *(2)* Context Bridge tối thiểu → *(3)* MCP parity gate. **Core Health Master UI + 8 bảng đầy đủ chuyển sang P1**, dựng sau khi spine phát ra dữ liệu thật. |
| **Reuse metric** | **`found + injected + outcome-linked`.** Không quy công cho LLM reasoning (bất khả chứng minh); không phụ thuộc QA gate đang có B23/B30/B32 mở. |
| **Ngưỡng platform isolation** | **Abstain.** Khi pack sau filter còn < 2 claim chất lượng → trả `UNKNOWN` + `reasonCode`, **không bao giờ** inject cross-platform. |

### Hệ quả lên kế hoạch

- Acceptance criterion #1 (force Sapo pack, 0 bleed Haravan/Shopify) và #4 (`inputSchema` parity) giữ nguyên.
- Acceptance criterion #3 (fail-open khi AntiFan tắt) giữ nguyên.
- Metric "historical reuse" đổi định nghĩa: đếm được ngay sau P0-1+P0-2, **không** chờ UI.
- Core Health UI trở thành consumer của spine, không phải hạng mục song song.

### Bàn giao

Giao cho `ak:plan` (rồi `/ak:cook`) với 4 field hợp đồng + hướng đã chọn + bằng chứng + rủi ro ở trên.
Không truyền `--yagni` (user không yêu cầu).
