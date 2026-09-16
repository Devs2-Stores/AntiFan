---
title: "Goal P0 — Retrieval → Bridge completion to 100%"
description: "Long-run goal: hoàn thiện 100% các hạng mục P0-A→P1 của MASTER UPGRADE trên nền plan 260914-1248 (C1-C8). Test + fix, không đồng hồ, biên = phase gate."
status: done
priority: P1
effort: ""
tags: []
created: 2026-09-15
---

# Goal P0 — Retrieval → Bridge completion to 100%

## Overview

Outcome: **100% hạng mục P0-A→P1** của MASTER UPGRADE đạt `PASS` có receipt, kế thừa contract **C1–C8** đã được user duyệt trong plan `260914-1248-work-root-sequential-evidence-scout`. Đây là phần còn lại sau khi phases 1–10 của plan đó đã chạy xong.

Chế độ: **test + fix**. Mỗi hạng mục đi theo vòng: chứng minh trạng thái hiện tại (test) → fix/xây → verify lại. Test phải **fail trước fix, pass sau fix**.

Biên tiến độ: **phase gate**. **Không có mốc đồng hồ** — 8h đã bị user bỏ khỏi mô hình.

Non-goals: nới/làm yếu bất kỳ tiêu chí nào để đạt 100%; sửa test để ép verdict; auto-promote candidate; git phá hoại; theme push; feature ngoài plan.

## Locked Contract (v6, user-approved)

```markdown
- Intended result: 100% hạng mục P0-A→P1 đạt PASS có receipt, revision-bound
- In scope: phase 11-15 của plan 260914-1248 + Core Health UI + MCP Reliability + lớp đo B23/B30/B32
- Out of scope: hạ tiêu chí để đạt 100%; sửa test để ép verdict; auto-promote; git destructive; theme push
- Acceptance signals: mỗi hạng mục có receipt PASS; test fail-trước/pass-sau; 0 skip; 0 timeout
- Constraints: unattended; ANTIFAN_BRIDGE_TOKEN qua env, fail-closed; runner deterministic là xương sống;
  checkpoint atomic tại mỗi phase gate; watchdog + health abort; single-runner; không secret trong artifact
- Allowed substitutions: retire shadow row bằng derive HOẶC reconcile kèm proof;
  Health UI tái dùng pattern panel/IPC sẵn có; hạng mục không kịp -> NOT_VERIFIED + blocker nêu tên
- Decision owner: user
```

**Bất biến:** contract bất động sau khi duyệt. Thay đổi outcome/scope → dừng, trình user quyết.

## Trạng thái khởi điểm (đo được, không suy đoán)

**Repo chuẩn: `E:/Work/apps/AntiFan`** — branch `main`, HEAD **`43ffb89`**, cây làm việc sạch (chỉ 2 file html untracked). Drive E: còn **127,5 GB / 232,8 GB (55%)**.

Nguồn: `probe sống trên DB thật` + `plans/260914-1248-.../reports/{final-scout-report,journal-260915-0317-core-deepening}.md` + git log.

| Hạng mục | Số thật (đo trên E:) |
|---|---|
| Corpus | 1.063.814 entries inventory · 177.009/177.009 eligible analyzed (100%) · 246 units DONE |
| **Core DB** | `.super-core/core.db` **180 MB** (+ WAL 174 MB, chưa checkpoint) — **đã populate** |
| `claims` | **20.832** — `haravan 13.378` · `generic-liquid 2.191` · `sapo 1.368` · `shopify 990` · **`NULL 2.905` (13,9%)** |
| `artifacts` / `evidence` | 184.835 / 44.712 |
| `platformSemantics` | **63.654** ← dữ liệu platform thật, đủ để scope nghiêm túc |
| `principles` | **10.275** |
| `antiPatterns` / `workarounds` / `fixPatterns` | 531 / 113 / 738 |
| `experienceNodes` / `Edges` | 2.333 / 3.112 |
| `archetypes` / `toolIntel` / `commercialIntel` | 784 / 700 / 206 |
| `conflicts` / `cases` / `candidates` / `adjudications` | **5** / 8 / 8 / 8 |
| `packs` / `receipts` / `releases` | 14 / 10 / 1 |
| `phaseGates` / `regressions` / `corpusAudits` | 46 / 2 / 8 |
| Core build | `packages/super-core/dist/` **đã build** |
| Test | super-core 6/6 · site-clone 465/465 |
| Residual tự khai | `observations` = 0 · experience/temporal chỉ là query shape · ranking lexical FTS5 · `recommend` chưa semantic |

**Đã xong:** upstream phases 1–10 (scout + corpus + Core + populate + clone integration).
**Còn lại:** upstream phases 11–15 + 2 workstream additive của report + lớp đo.

> **Đính chính số liệu**: bản plan đầu tiên ghi `3.322 claims · 1.911 untagged (57,5%)`, lấy từ một journal ngày 2026-09-15 03:17. DB thật hiện có **20.832 claim**, và tỉ lệ untagged thật là **2.905/20.832 = 13,9%**. Số cũ là **stale**; mọi con số trong plan này đã được đo lại trên DB thật. Lỗ hổng `IS NULL` vẫn là lỗi thật, nhưng quy mô nhỏ hơn 4 lần so với ước lượng ban đầu — và điều đó **không** làm nó bớt nghiêm trọng, vì 2.905 claim vẫn rò vào mọi query có platform filter.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Substrate an toàn: checkpoint/resume + watchdog + health abort, chứng minh bằng kill test | P0 |
| 2 | Retrieval Integrity: cách ly platform ở mọi đường truy hồi, hết pack spam, confidence thật | P0 |
| 3 | Context Bridge: Core pack vào OMP agent turn, sống qua compaction, fail-open | P0 |
| 4 | Verified Learning: `observations` producer + liên kết outcome→case→candidate | P0 |
| 5 | MCP Reliability: catalogue là nguồn duy nhất + parity gate + retire 21 shadow row | P1 |
| 6 | Core Health surface: snapshot có reasonCode, mở rộng `IssueRegister` sẵn có | P1 |
| 7 | Lớp đo B23/B30/B32: mở khoá khả năng phán quyết QA/visual | P1 |
| 8 | Re-acceptance toàn hệ, revision-bound | P0 |

## Phases

| # | Phase | Block | Status |
|---|-------|-------|--------|
| 1 | [Phase 1: Safety substrate](./phase-01-safety-substrate.md) | 1 | Done |
| 2 | [Phase 2: Retrieval integrity](./phase-02-retrieval-integrity.md) | 1 | Done |
| 3 | [Phase 3: Context Bridge](./phase-03-context-bridge.md) | 1 | Done |
| 4 | [Phase 4: Verified learning](./phase-04-verified-learning.md) | 2 | Done |
| 5 | [Phase 5: MCP reliability](./phase-05-mcp-reliability.md) | 2 | Done |
| 6 | [Phase 6: Core Health + 5 surface](./phase-06-core-health-surface.md) | 2 | Done |
| 7 | [Phase 7: Measurement layer](./phase-07-measurement-layer.md) | 3 | Done |
| 8 | [Phase 8: Re-acceptance](./phase-08-reacceptance.md) | 3 | Done |

Execution order: 1 → 2 → 3 (block 1) → 4 → **5 → 6** (block 2) → 7 → 8 (block 3). Thứ tự là dependency thật, không phải sở thích: phase 1 là điều kiện để chạy unattended; **MCP reliability (5) phải xong trước Core Health surface (6)** vì 5 surface đọc trạng thái MCP, và build UI trên các `anti.*` alias sẽ bị phase 5 retire/reconcile là tự tạo refactor bắt buộc; phase 7 là điều kiện để phase 8 phán quyết được.

**Block 1 (user chốt)** = phase 1 + 2 + 3. Phase 1 nằm trong block 1 vì bỏ trần thời gian khiến substrate an toàn trở thành bắt buộc, không còn optional.

## Traceability

| Phase | Contract items | Acceptance signals | Facts / assumptions / prereqs / user decisions |
|---|---|---|---|
| 1 Safety substrate | C8 | Kill giữa run → resume sạch từ checkpoint, không mất > 1 đơn vị việc; watchdog thoát khi heartbeat stale; health abort kích hoạt đúng ngưỡng | FACT: runtime không có `/goal` executor gốc → runner phải tự làm. FACT: `benchmark-real-soak-8h.cjs:49-61` đã có `SetThreadExecutionState` để kế thừa. FACT: main app **thiếu** `--disable-background-timer-throttling` (chỉ có ở `scripts/test-clone-features.cjs:63-65`). USER DECISION: bỏ mốc 8h → health bound thành bắt buộc |
| 2 Retrieval integrity | C3, C5 | **Cặp âm/dương**: query Sapo trả **0** claim/conflict Haravan/Shopify **và** trả **> 0** claim Sapo; query lặp cùng input **không** thêm row pack; abstain khi < 2 claim chất lượng; precondition DB đã nạp với baseline khác rỗng; test fail trước fix | FACT (anchor đã grep trên HEAD `43ffb89`): `index.ts:220` `(c.contextPlatform = ? OR c.contextPlatform IS NULL)`; `:248` conflicts không scope; `:251` `pack-${uuid()}` mỗi call; `:516` `findSimilar` bỏ qua `opts.platform` (`:527`/`:529` dùng `LIKE ?` với fallback `''` → khớp mọi row); `:784` confidence = đếm claim; `:809` = đếm revision; `:114` `importScout` không ghi platform cho conflicts. FACT: `schema.ts:103` `conflicts` không có platform lẫn unitId; `:113` `cases` có unitId, không platform; `:36` `units` chỉ có `markers`. FACT (đo trên DB thật): **2.905/20.832 = 13,9%** claim chưa gắn platform → vẫn rò vào mọi query có filter |
| 3 Context Bridge | C5, C6 | Session OMP thật nhận pack; `packId` bất biến qua compaction; AntiFan tắt → session chạy tiếp + đúng 1 `BRIDGE_CONTEXT_FAILED`; receipt-required action từ chối khi Core unavailable | FACT (`omp://docs/hooks.md`): `before_agent_start` **chỉ giữ message đầu tiên**; `context` là lever mỗi call (chuỗi thay thế `messages`); `session.compacting` trả `preserveData`. FACT: hook phải nằm ở `.omp/hooks/pre|post/*.ts` — đặt trực tiếp trong `hooks/` **không** được nạp. FACT: `.omp/hooks/` chưa tồn tại; `.omp/config.yml` đang nạp `./.omp/extensions/antifan-fix-guard`. FACT: `ExtensionAPI` đã có overload `on?(event: string, …)` nên nhận event mới không cần sửa core. ASSUMPTION: chưa probe ai thắng khi nhiều handler cùng trả message ở `before_agent_start` |
| 4 Verified learning | C7 | `observations` > 0 có producer thật; outcome → case → candidate có liên kết evidence; không self-promote; rollback chứng minh được | FACT: `index.ts:286` `ingestOutcome` ghi `cases` + `candidates`, **không** ghi `observations`, không gắn experience node/edge; `evidenceJson` chỉ chứa `verificationRef`. FACT: journal tự khai `observations` = 0. FACT: luật `adjudications.scope` đã được sửa ở session trước — phải giữ |
| 5 MCP reliability | report §P0-C | Gate **fail** khi schema bị cố ý làm lệch; **0** shadow row còn lại, mỗi dòng có proof | FACT: `CapabilityDefinition.inputSchema` (`src/shared/control-plane-contracts.ts:618`) đã là nguồn schema. FACT: đo được 237 capabilities, **21 shadow row** tại HEAD (`node scripts/check-mcp-budget-dominance.mjs`); ledger B29 ghi **23** tại thời điểm nó được viết và nêu `anti.browser.tabs.list` đã sửa → lấy số từ gate, không từ ledger. FACT: gate **không** kiểm schema parity — chỉ budget/ceiling/bảng cấm/tên tool → parity là việc mới thật. FACT: gate nằm trong `npm run compile` nên check quá chặt sẽ chặn mọi build. FACT: bỏ một row là **đổi hành vi** (B29) vì một số alias `anti.*` là bản cài lại độc lập |
| 6 Core Health surface | C4, report §P0-B | Mọi status có `reasonCode` + `affected`; gieo tình huống degraded → ra `DEGRADED`, không ra % | FACT (đã grep): `src/renderer/toolbar.html:442-559` **đã có** modal "Workflow & MCP Hub" (`#workflowHubOverlay`, `.hub-nav-strip`, `#hubListPane`, `#hubDetailPane`) → **không** phải greenfield hoàn toàn; phải **tích hợp vào Hub sẵn có**, tránh xung đột UI. FACT: chưa có panel Core Health / Bridge. FACT: `IssueRegister` ở `src/main/session/issue-register.ts` đang chạy, tiêu thụ bởi `src/main/tools/browser-capabilities.ts:14` và `src/main/verification/circuit-breaker.ts:46` → mở rộng, không dựng register thứ hai. FACT: IPC `antifan:toolbar:*`, `antifan:tab:*`, `antifan:terminal:*`, `antifan:tabs:*` đã có |
| 7 Measurement layer | report §B23/B30/B32 | Case QA/visual có verdict thật thay vì `BLOCKED` | FACT (`plans/bottlenecks.json`, 36 row / **7 open**: B19,B20,B21,B23,B29,B30,B32): B23 không có live-storefront gate; B30 `anti.visual.compare` vượt bound 15s → `captureValid=false`; B32 verdict không revision-bound (`exit`/`finishedAt`/`routeIdentity` = null). LOGIC: 100% bất khả thi về định nghĩa khi lớp đo còn hỏng |
| 8 Re-acceptance | C1, C8 | Toàn bộ receipt pass; không `milestone-only DONE`; artifact revision-bound | FACT: upstream phase 14-15 chưa chạy lại sau phases 11-13. PREREQ: phase 7 phải xong trước để phán quyết được QA/visual |

## Success Criteria

- [ ] 100% hạng mục P0-A→P1 có verdict terminal `{PASS|FAIL|NOT_IMPLEMENTED|BLOCKED}`, 0 `SKIP`, 0 `TIMEOUT`.
- [ ] Mọi mục `PASS` có receipt revision-bound (git SHA + `exit` + `finishedAt` + `routeIdentity` khác null).
- [ ] Mọi fix có test **fail trước fix, pass sau fix**; không test nào bị nới để đạt gate.
- [ ] Vòng lặp outcome→case→candidate không self-promote; mọi adjudication giữ đúng `scope`.
- [ ] Lớp đo phán quyết được case QA/visual (B23/B30/B32 đóng) — hoặc các case đó được ghi `BLOCKED` kèm blocker nêu tên, không giả PASS.
- [ ] Không artifact nào chứa secret; chỉ ghi presence/absence của env var.

## Bất biến phủ test (chống false PASS)

Đây là hàng rào quan trọng nhất của plan. Rủi ro lớn nhất của một goal 100% không phải là làm không kịp, mà là **đánh `PASS` cho một hạng mục chưa từng được test**.

1. **Mỗi phase phải có ít nhất một hàng test cho MỖI hạng mục ladder mà nó sở hữu.** Không có hàng test ⇒ hạng mục đó **không** được đánh `PASS`. Ví dụ: phase 5 sở hữu 8 hạng mục (18-25, MCP) nên phải có ≥ 8 hàng test; phase 6 sở hữu 9 hạng mục (11-17, 28, 29 — Health + 5 surface) nên phải có ≥ 9 hàng.
2. **Hàng test phải nêu hành vi quan sát được**, không phải wiring, không phải nội dung source, không phải "module tồn tại".
3. **Mọi fix phải có test fail-trước / pass-sau.** Một hạng mục `PASS` mà không có cặp fail→pass là chưa được chứng minh.
4. **Test bị nới để qua gate = abort**, không phải điều chỉnh hợp lệ. Health abort ở phase 1 phải bắt được diff làm yếu assertion.
5. **`NOT_IMPLEMENTED` phải kèm bằng chứng vắng mặt** (grep/path/probe), không phải một dòng "chưa làm".
6. **Không gộp nhóm để trông đủ.** 31 hạng mục là 31 dòng trong ladder artifact, không phải 6 nhóm.

## Thứ tự và tính độc lập

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8` là thứ tự **dependency thật**:
- 1 trước 2/3 vì bỏ trần thời gian khiến substrate an toàn thành điều kiện tiên quyết.
- 2 trước 3 vì pack còn nhiễu thì bridge sẽ công nghiệp hoá nhiễu vào mọi OMP turn.
- 3 trước 4 vì producer `observations` cần danh tính TaskRun do bridge tạo.
- **5 trước 6** vì UI đọc trạng thái MCP, và phase 5 mới retire/reconcile 21 shadow row.
- 7 trước 8 vì verdict QA/visual chỉ adjudicable sau khi lớp đo đóng.

**Phase 5 (MCP) và 6 (Health) được xếp tuần tự có chủ đích, không phải tuỳ tiện.** Ban đầu tôi coi hai phase này độc lập và cho phép đổi thứ tự. Review đối kháng chỉ ra điều đó sai: 5 surface của phase 6 hiển thị trạng thái MCP, và phase 5 mới là nơi retire/reconcile 21 shadow row. Nếu dựng UI trước, UI sẽ bind vào các `anti.*` alias rồi vỡ khi phase 5 đổi chúng — tự tạo một refactor bắt buộc. Thứ tự đúng là **5 trước 6**. Không được đổi lại mà không có quyết định của user.

## Ngữ nghĩa của `NOT_IMPLEMENTED` và `BLOCKED`

Hai verdict này **hợp lệ để báo cáo** nhưng **không** phải là hoàn thành. Cần nói rõ vì đây là chỗ một agent chạy tự động dưới áp lực "100%" dễ trượt:

- `NOT_IMPLEMENTED` và `BLOCKED` **không** cộng vào 100%. Một hạng mục ở hai trạng thái này nghĩa là **goal CHƯA đạt**.
- Chúng phải được báo như **blocker cần user quyết**, không phải như một kết thúc gọn gàng.
- **Chế tạo kết quả để lấp chỗ trống là vi phạm contract, phải abort.** Cụ thể: giả `replayResult` cho hạng mục 29; đánh `PASS` cho hạng mục 29 chỉ vì UI/bảng tồn tại; đánh `PASS` cho bất kỳ hạng mục nào dựa trên suy luận "đã có code" thay vì hành vi quan sát được.
- Nếu hạng mục 29 cần replay engine mà engine chưa có, thì việc đúng là **xây engine** — hoặc trả `NOT_IMPLEMENTED` + blocker và chấp nhận rằng 100% chưa đạt. Không có đường thứ ba.

## Risk Assessment

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Bỏ trần thời gian mà checkpoint/resume không thật sự chạy | Cao | Phase 1 phải chứng minh bằng **kill test** trước khi phase 2 bắt đầu |
| Thermal throttle / timer throttling trên i5-9300H + Win11 khi chạy dài | Cao | Set `--disable-background-timer-throttling`; health abort theo RSS drift |
| Nhiều extension cùng trả message ở `before_agent_start` → bridge bị shadow | Trung bình | Probe thứ tự load; test khẳng định message của bridge thắng |
| Sửa schema trên DB đã populate (**20.832** claim) | Trung bình | Migration idiom `MIGRATIONS: {from,to,sql}` đã có; backup + rollback đã có (`snapshot`/`rollback`) |
| `isForbiddenTool()` là stub luôn trả `false` → guard hiện không chặn gì | Trung bình | Ghi nhận; không dựa vào nó làm cơ chế an toàn cho run |
| Đạt 100% bằng cách nới tiêu chí | Cao | Health abort + review ở mỗi phase gate; "nới tiêu chí" là trigger abort |

## Review and Validation

Independent review ở mỗi phase gate: đối chiếu việc đã làm với contract đã khoá; phân loại finding theo taxonomy warmup (`mitigation-within-contract` / `preflight-required` / `blocker` / `outcome-change-request`). `outcome-change-request` **không** được sửa plan im lặng — phải dừng và trình user.

## Approved Autonomous Run Amendment

Dùng agent/runtime sẵn có cho suy luận; không giả định entitlement model API riêng. Executor được tự chọn chi tiết kỹ thuật và chốt ngưỡng khách quan trước khi đánh giá. Mutation chỉ trong bản copy local cô lập. Candidate thật giữ PENDING cho user sau run; kiểm chứng promote/reject/rollback bằng acceptance store riêng với authority test tường minh, **không** giả mạo approval production. Dừng khi thiếu quyền, acceptance fail, hoặc scope mismatch. Không tự khởi động goal trong warmup.

<!-- slug: goal-p0-retrieval-bridge-completion -->
