# Ultra Brainstorm — Phân tích sâu: AntiFan × OMP AI Agency / Subagent Workflow Report

- Date: 2026-09-11 · Mode: `ak:brainstorm --ultra` (best-of-5 verifier)
- Target: `E:\Download\AntiFan_OMP_AI_Agency_Subagent_Workflow_Report.md` (966 lines, 23 sections)
- Winner: Candidate E — materialized UNCHANGED below (controller does not blend).

---

# Deep analysis — `AntiFan_OMP_AI_Agency_Subagent_Workflow_Report.md` (966 dòng, 23 mục)

## 0. Nguồn bằng chứng đã đọc trực tiếp (read-only)

- Packet: `local://ultra-evidence-packet.md` (mục 1–8).
- Report: đọc toàn bộ (`:1-333`, `:330-663`, `:661-966`).
- Harness thật: `omp://hooks.md`, `omp://task-agent-discovery.md`, `omp://skills.md`, `omp://context-files.md`.
- Workspace: `package.json`, `README.md`, `docs/{security-model,ui-architecture,research-browser-agent-seamless-execution}.md`, `ANTIFAN_IMPROVEMENTS.md`, `plans/bottlenecks.json`, `plans/reports/260911-1310-theme-fidelity-run4-verdicts.md`, `15-PAGE-HOPLONGTECH-CLONE-CANARY.md`, `plans/260908-1223*/plan.md` + `phase-04`, `plans/260909-0032*/plan.md`, `plans/260910-2008*/phase-01`, `plans/260911-0133*/plan.md`, cây `src/main/**`, `packages/site-clone/src/**`, `scripts/antifan-omp-mcp.cjs`.
- Grep có định vị: `INCONCLUSIVE|STRUCTURAL|GEOMETRY` trong `src/`; `HTML_SPEC_READY`; `AgentManager|Swarm|orchestrat`; `BUNDLE_IDENTITY_MISMATCH|NOT_MEASURABLE|…` trong `scripts/` + `.canary/tools/`.
- Xác nhận vắng mặt: `glob .omp/**` → *skipped missing paths*. `.omp/` chưa tồn tại.

---

## 1. Verdict tổng thể

Report **đúng về kiến trúc phân vai** (Main trung tâm + subagent chuyên môn + AntiFan là Judge) và **đúng về 4 nguyên tắc bất biến** (HTML trước Liquid, QA độc lập Builder, reference đổi ⇒ INCONCLUSIVE, production cần quyền user). Đây không phải một đề xuất sai hướng.

Nhưng report **lạc hậu khoảng 2–3 tuần so với chính source của AntiFan**, và lạc hậu ở đúng chỗ nguy hiểm: nó mô tả một pipeline agent (Design → Builder → QA → Liquid) mà **~60–70% năng lực đã tồn tại dưới dạng engine tất định** trong `packages/site-clone` và `src/main/**`; đồng thời nó **không nhắc tới nghẽn thật đang mở (P1) của chính workspace** — nghẽn nằm ở *khả năng đo và ra phán quyết*, không nằm ở khả năng sinh code. Vì vậy nếu adopt nguyên trạng §8/§12, hệ quả xấu nhất không phải "chậm" mà là **pipeline đứng ở cổng gate vĩnh viễn, rồi agent dùng văn xuôi để lấp chỗ trống — tái tạo đúng cái self-evaluation bias mà §2 dựng ra để chống**.

Ba mệnh đề chịu lực nhất của report, đối chiếu bằng chứng:

| # | Mệnh đề report | Verdict | Bằng chứng sắc nhất |
|---|---|---|---|
| A | Verdict chỉ có `PASS/FAIL/INCONCLUSIVE` (§6, §14, §21.5) | **SAI (vocabulary)** | `src/main/verification/verification-contract.ts`: `VerificationVerdict = VERIFIED|PARTIAL|REJECTED|INCONCLUSIVE|UNVERIFIED`; `InconclusiveReason = RESAMPLE|NEED_INPUT|UNOBSERVABLE|UNSUPPORTED`; `StalemateState = ACTIVE|STALEMATE|EXEMPTION_WAIVED`. Compare còn trả `verdict: 'STRUCTURAL_TRUNCATION_DETECTED'` / `'STRUCTURAL_PARITY_MISMATCH'` (`browser-control-port.ts:5103,5228`) |
| B | Failure taxonomy 10 loại `STRUCTURAL…SCHEMA` (§6) | **KHÔNG TỒN TẠI / trùng lặp nguy hiểm** | Grep `'(STRUCTURAL|GEOMETRY|…|SCHEMA)'` trong `src/` **không có** enum 10 nhóm. Thứ đang có là `ClaimCategory = INTERACTION|LAYOUT|RESPONSIVE|VISUAL|CUSTOM` (`proof-templates.ts:12`, `browser-capabilities.ts:2800`) và các cause code vận hành (`BUNDLE_IDENTITY_MISMATCH`, `NOT_MEASURABLE`, `EXECUTION_TIMEOUT`, `IDENTITY_DRIFT`, `SESSION_RENEWAL_FAILED`, `CAPTURE_INVALID`, `content-changed-between-passes`). Áp §6 nguyên văn = tạo convention thứ hai song song |
| C | Fix-loop `FAIL → Builder sửa → QA lại → PASS` là cơ chế chính (§8, §12) | **ĐÚNG MỘT PHẦN — loop không hội tụ vì lý do khác** | `ANTIFAN_IMPROVEMENTS.md`: 7 vòng compare toàn trang 53.35% → … → 17.00% → **24.11% (rebound)**. Run4: **1 PASS / 40 INCONCLUSIVE / 1 EXECUTION_TIMEOUT** trên 42 verdict document. Canary 15 trang: **8 PASS / 17 FAIL / 20 INCONCLUSIVE** (45 case) |

---

## 2. Đối chiếu từng mục §1–§23

### §1–§3 — Mô hình và ranh giới

- **§1 ĐÚNG.** "Main mạnh + subagent chuyên môn + AntiFan Control Plane/Judge" khớp cả harness (packet §5) lẫn kiến trúc AntiFan (`docs/security-model.md`: "Main is the sole authority"; `docs/ui-architecture.md`: "Runs bind exact immutable targets").
- **§2 ĐÚNG, và đã được luật hoá trong code mạnh hơn report viết.** `src/main/verification/visual-capture.ts:13-16` ghi thẳng: *"this module produces mechanical geometry and receipts only. It never issues business verdicts (VERIFIED/REJECTED/INCONCLUSIVE belong to VerificationEvaluator)"*. Đó chính là separation-of-responsibility ở tầng module, không chỉ ở tầng agent. Hệ quả: luận điểm §2 không cần bảo vệ thêm; nó đã là invariant.
- **§3 ĐÚNG về chủ trương, nhưng lưu ý: harness KHÔNG cưỡng chế "cấm ngang hàng".** OMP có `hub` peer-messaging (send/wait/inbox, `send to="all"`) và `spawns` policy (`*` cho phép mọi agent). Mặc định `task.maxRecursionDepth = 2` và subagent chỉ spawn con, nên *hình dạng* parent→child là mặc định — nhưng "không swarm" là **policy phải viết vào `.omp/agents/*.md` + skill**, không phải thuộc tính sẵn có. Report không nói ai thi hành Rule này.

### §4–§7 — Bốn subagent

- **§4 Design Analyst: ĐÚNG MỘT PHẦN; thiếu artifact contract.** Input mà report liệt kê đều có đường vào thật: annotation user → `.antifan/annotations` + `.antifan/snapshots` theo project (`README.md`), skill `figma-mcp-analyze`/`wireframe-roadmap`/`site-clone` có trong catalog. Nhưng report quên rằng **spec đã có schema**: `packages/site-clone/src/schemas/clone-ir.schema.json` (9.9KB), `clone-spec.schema.json`, `qa-matrix.schema.json`, producer `models/blueprint-extractor.ts` (19.9KB), `dom-tree-parser.ts`, `responsive-scanner.ts`, `state-synthesizer.ts`, `ecommerce-data-modeler.ts`, và cổng `anti.spec.validate_gate` ("certify HTML_SPEC_READY before theme compilation", `browser-capabilities.ts:2575`). Nếu Design Analyst xuất prose spec mà không bind vào IR này, ta có một spec thứ hai không ai kiểm được — vi phạm chính nguyên tắc "Annotation của user là instruction" mà §4 đề ra (instruction thì phải kiểm chứng được).
- **§5 Builder HTML độc lập: ĐÚNG MỘT PHẦN, và đã có bản tất định.** `plans/260908-1223-independent-html-clone-and-fidelity-pipeline/plan.md` đã chốt đúng pivot này (`Reference → Asset Localization → Independent HTML Clone → Visual Compare (<2%) → Liquid Lowering`), với Phase 2 (AssetLocalizer, 0 hotlink) và Phase 3 (Independent HTML Clone Generator) **Complete**; code: `packages/site-clone/src/generators/independent-html-clone-generator.ts` (14KB), `models/asset-localizer.ts` (57KB), `asset-harvester.ts`. Nghĩa là "Builder viết HTML" của report **trùng chức năng với một generator tất định đã chạy**, và generator có lợi thế report không nhắc: nó giữ raw DOM nesting/styles nên không sinh drift. **Kết luận vận hành: Builder phải là đường *dự phòng/ngoại lệ* (trang không có reference, hoặc yêu cầu redesign), không phải đường mặc định.** Report đảo ngược thứ tự này.
- **§6 QA: ĐÚNG MỘT PHẦN về pipeline, SAI về vocabulary, THIẾU về tính khả thi.** Pipeline Browser→Capture→Reference Identity→Geometry→Compare→Responsive→Runtime→Liquid→Schema có thật: `src/main/qa/scanners/{platform-detector,liquid-error-scanner,server-crash-scanner,broken-asset-scanner,layout-overflow-engine}`, `qa/rules/hs-gate-rules.ts`, `verification/{visual-capture,capture-settle,baseline-authority,circuit-breaker,modular-gates}`, `tools/theme-transaction-capabilities.ts`. Nhưng: (a) vocabulary sai (mệnh đề A); (b) taxonomy 10 nhóm không tồn tại (mệnh đề B); (c) report giả định QA "phân loại failure" như một bước mô tả — thực tế failure **được máy phân loại thành cause code có kiểu**, và đó là điều kiện để loop hành động được; (d) `visual.critical_regions_pass` bị đánh dấu `// Deferred: producer not yet wired` (`verification-contract.ts:180`) — tức có metric trong hợp đồng chưa có producer, report không thể biết.
- **§7 Liquid sau HTML PASS: ĐÚNG nguyên tắc, nhưng là điều kiện gây deadlock nếu không có policy thoát.** Liquid lowering cũng đã có bản tất định: `packages/site-clone/src/generators/{theme-compiler,haravan-section-generator,haravan-layout-generator,haravan-schema-generator,haravan-snippet-generator}.ts` + `plans/260908-1223/phase-05` (Pending). Vấn đề: nếu "HTML PASS" là cổng cứng, mà PASS hiện **không đạt được ở quy mô** (run4: 1 PASS/42; canary: 8/45), thì cổng này khoá toàn bộ nhánh Liquid. Report không định nghĩa: PASS ở viewport nào, bao nhiêu surface, hay có cho phép `INCONCLUSIVE` tiến tiếp với cờ rủi ro hay không.

### §8–§12 — Workflow

- **§8 Sơ đồ A→Z: CHƯA KIỂM CHỨNG và thiếu điều kiện dừng.** Sơ đồ có nhánh `FAIL → BUILDER → QA` nhưng **không có exit condition** (số vòng tối đa, ngân sách thời gian, hay escalation). Với dữ liệu thật (B30: normalization apply vượt bound 15s ⇒ `CAPTURE_INVALID`; B19: settle gate bị carousel giết; run4: 40/42 `INCONCLUSIVE`), nhánh FAIL sẽ chạy vô hạn trên một tín hiệu không tồn tại. Đây là mâu thuẫn nội tại nặng nhất của report: §6 cấm biến vấn đề measurement thành PASS, nhưng §8 lại không cho Main một hành vi hợp lệ khi *mọi* vòng đều INCONCLUSIVE.
- **§9–§11 Prompt template: ĐÚNG như template, SAI như hợp đồng.** Prompt §9 viết "chỉ báo hoàn thành khi QA PASS" — bất khả thi falsify với dữ liệu hiện tại. Phải là "báo hoàn thành khi có verdict có provenance (`PASS` | `FAIL`+cause | `INCONCLUSIVE`+cause) và nêu rõ cause", nếu không agent sẽ tự nâng INCONCLUSIVE thành "xong".
- **§12 Batch 15 trang: SAI MỘT PHẦN về song song, THIẾU về state.** AntiFan **cố tình serialize**: `260910-2008/phase-01` yêu cầu *"One campaign lock serializes invocations"* (`.canary/15-pages/.campaign.lock`, `RUN_IN_PROGRESS`), vì `_verdicts.json`, per-page evidence và aggregate là shared writers. "Những phần độc lập có thể chạy song song" của report đúng ở tầng *agent*, sai ở tầng *artifact*. Ngoài ra report không nói ai giữ `FAILURE QUEUE`: AntiFan đã có hai sổ — `anti.diagnostics.record_issue`/`IssueRegister` (OPEN/RESOLVED/BYPASSED, P0–P3, có `workaroundApplied ⇒ BYPASSED`) và `plans/bottlenecks.json` (35 dòng: 23 closed / 6 open / 6 refuted, mỗi dòng có `predicate` kiểm được; `npm run audit` fail build khi REOPENED / FIXED_UNRECORDED). Tạo queue thứ ba trong context của Main là tái tạo đúng nguy cơ "context phình" mà §3 cảnh báo.
- **Bằng chứng về tính bất ổn của aggregate (report không biết):** cùng một campaign, `phase-01` ghi *"the same artifacts report 12 FAIL / 32 INCONCLUSIVE by `visual.verdict` and 20 FAIL / 23 INCONCLUSIVE by `run-<vp>.overall`"*; B23 dẫn một trạng thái `executiveVerdict INCONCLUSIVE, tally all zero, cases empty`; canary công bố 8/17/20. Ba cách đếm khác nhau trên cùng một hệ. Đây là lý do canonical index (`_verdicts.json`, một verdict + một cause code cho mỗi case) được đưa vào. Report nói "AntiFan trả PASS/FAIL/INCONCLUSIVE" như thể việc tổng hợp là hiển nhiên.

### §13–§18 — Ranh giới thực thi

- **§13 ĐÚNG về hướng, LẠC HẬU về hiện trạng.** AntiFan đã có: `control-plane/control-plane-runtime.ts`, `run/{run-service,attachment-registry}`, `workflow/{workflow-engine,workflow-registry,workflow-schema}`, `session/{invocation-ledger,receipt-store,event-store,run-recovery}`, `chat/chat-store`, `project/{project-registry,workspace-registry}`, `agent/{execution-backend,codex-execution-backend,deepseek-harness-adapter,session-resume-controller}`, `mcp/mcp-server.ts` (41.7KB), và UI Harness dock có conversation + run/tool timeline (`docs/ui-architecture.md`). Cộng thêm plan `260820-1301-build-antifan-standalone-control-plane` (phases: project/workspace/chat/run ownership, execution backend contract, persist/recover runs, ship standalone theme QA MVP). Vậy "AntiFan chỉ cần expose capability" **không còn đúng như một mô tả trạng thái**; Rule 8 phải được re-scope thành *"không dựng orchestrator đa-agent thứ hai"*, không phải *"AntiFan không có orchestration"*.
- **§14 ĐÚNG và phần lớn đã có** — mỗi mục trong sơ đồ ánh xạ được vào tool thật (packet §4): Browser/CDP → `anti.browser.*`; Capture → `anti.screenshot.*`, `anti.reference.capture`; Compare → `anti.visual.compare`; Geometry → `anti.inspect.styles|region|responsive_matrix`; Structural → `theme.debug_bundle`, `theme.qa_validate`, `anti.spec.validate_gate`; Evidence → `anti.verification.*`, `anti.artifact.*`; Verdict → verification evaluator + `stalemateState`; Safety → authority layer. **Nhưng "Agent không được tự override verdict" (§14 + §21 Rule 5) KHÔNG được cưỡng chế bởi công cụ**: `anti.visual.compare` phơi ra `tolerance`, `heightTolerance`, `allowHeightDrift` như **tham số do agent truyền** (`browser-capabilities.ts:2363-2365, 2421-2423`). Cơ chế bảo vệ thật là (i) kỷ luật của caller (campaign truyền `allowHeightDrift:false`, `useDefaultWidgetMasks:false`), (ii) `stalemateState`/`EXEMPTION_WAIVED`, (iii) `verification record` có `actor: 'agent' | 'user'`. Nghĩa là Rule 5 hiện là **quy ước + sổ sách**, chưa phải cổng. Muốn thành cổng thì phải ghim tham số ở tầng nền tảng — xem §15 dưới đây.
- **§15 Hook: ĐÚNG và khả thi — nhưng KHÔNG đủ làm safety boundary.** OMP thật có hook subsystem: `pi.on('tool_call')` trả `{block, reason}` **hoặc `{input}` để thay tham số thực thi**; `tool_result` override `content/details`; `context`, `before_agent_start`, `session_before_*`; discovery qua `hookCapability` với ví dụ `.omp/hooks/pre/*.ts`; file nạp qua extension runner. Ba lỗ hổng report không thấy:
  1. **Bypass tầng tool**: doc ghi rõ *"Eval prelude invocations such as `browser.open(...)`, direct `BrowserTab` helpers, `tab.run(...)`, direct `computer` helpers, and `computer.run(...)` are host bridge calls, not AgentTool calls, so they do not emit `tool_call` or `tool_result`"*. Bất kỳ đường nào không đi qua AgentTool đều không bị hook thấy.
  2. **Bypass tầng CLI**: agent vẫn có `bash`; `node scripts/antifan-agent.cjs` hay `hrv theme push` không phải tool AntiFan nào để block trừ khi hook viết regex — mà regex là bề mặt mong manh.
  3. **State xuyên tiến trình**: hook chạy trong tiến trình OMP, còn "theme live?" là state của AntiFan (`ThemeTransactionRegistry`, `theme-mutation-session`, `haravan-sync-barrier`). Hook muốn hỏi phải round-trip MCP/bridge — tức một cổng fail-closed biến thành một truy vấn có thể timeout.
  → **Kết luận: safety phải ở AntiFan authority layer (đã có: `CapabilityRisk = read|write|execute|eval`, `allowEval` opt-in, `issueRuntimeLease`, `assertExactBrowserTarget`, `RuntimeFeatureSwitch`, `MCP_BRIDGE_OFFLINE`, `TARGET_STALE/TARGET_REQUIRED`, attachment-scoped dual-plane theo `260909-0032`), hook chỉ là lớp *nhắc + ghim tham số*.** Điểm này củng cố hướng của report nhưng đảo ngược trọng số mà report đặt.
  → **Ý tưởng dùng hook đúng chỗ (grounded, chưa ai làm):** `tool_call` trả `input` sẽ *thay* tham số tool thực thi, nên một hook ở `.omp/hooks/` có thể **ghim cứng** `allowHeightDrift:false`, `useDefaultWidgetMasks:false`, `tolerance` trần cho mọi lời gọi `anti.visual.compare`/`theme.qa_validate`, đồng thời `block` mọi lệnh `hrv|haravan theme push|deploy|publish` không có `--only` trong scope cho phép. Đây là cách biến Rule 5 từ quy ước thành cổng mà không cần sửa AntiFan.
- **§16 `.omp/` — KHẢ THI, và packet §5 nói THIẾU.** `omp://task-agent-discovery.md` xác nhận: OMP discover project agents tại **`.omp/agents/*.md`** (frontmatter `name`, `description` bắt buộc; body = `systemPrompt`; tùy chọn `tools` CSV/array, `spawns`, `model` (list ưu tiên), `thinkingLevel`, `output`, `autoloadSkills`, `prewalk`, `advisor`, `blocking`); precedence **project `.omp` > user `.omp` > extension roots > Claude plugins > bundled**; rediscover ở **mỗi lần dispatch**, nên file thêm giữa session vẫn resolve. Skill `omp://skills.md`: native provider priority 100, layout **một cấp** `<root>/skills/<name>/SKILL.md` — đúng y `.omp/skills/antifan-theme/SKILL.md` của report. `.omp/AGENTS.md` cũng là dạng native project context. Vậy **packet §5 ("custom agents không khai báo được") chỉ đúng ở vế *từ trong session*, sai ở vế *khai báo được***. Ba cảnh báo vận hành report bỏ sót:
  1. **Shadowing**: `.omp/AGENTS.md` là provider `native` priority 100; `E:\\Work\\apps\\AntiFan\\AGENTS.md` là provider `agents-md` priority 10 **cùng depth 0** ⇒ thêm `.omp/AGENTS.md` sẽ **che file Level-0 contract hiện tại** (trừ khi byte-identical). Đây là sự cố governance im lặng, không phải chi tiết nhỏ.
  2. **Nearest-non-empty**: native project context chỉ đọc từ `.omp/` **non-empty gần nhất**; nếu tổ tiên gần hơn có `.omp/` mà thiếu file thì discovery **không đi tiếp lên trên**.
  3. **Skill layout không đệ quy**: `skills/group/sub/SKILL.md` **không được discover**.
- **§17 ĐÚNG, khớp từng chữ với doc harness**: skill = passive content; hook = event-driven interceptor; custom tool = executable API; context file = instruction. Report không sai gì ở mục này.
- **§18 ĐÚNG MỘT PHẦN; packet lại thiếu.** Packet §5 khẳng định *"KHÔNG có per-subagent model-tier routing"* — sai theo `omp://task-agent-discovery.md`: routing có thật qua (1) `task.agentModelOverrides[agentName]`, (2) frontmatter `model` (list ưu tiên, hỗ trợ alias `@role`), (3) `modelRoles` trong `~/.omp/agent/config.yml` hoặc `.omp/config.yml`, (4) `eval` bridge có invocation-local override. **Giới hạn thật**: *task wire schema không phơi* model per-item, nên không thể đổi model cho từng item trong một `tasks[]` — phải qua config/frontmatter. Ngoài ra "bỏ quota/pricing" không miễn nhiễm **latency và context window**: OMP có auto-compaction (`session_before_compact`, `session.compacting`), nên một campaign nhiều surface sẽ **mất context giữa chừng**. Hệ quả thiết kế: *durable memory của agency phải là artifact AntiFan (`_verdicts.json`, attempt dirs, `IssueRegister`), không phải trí nhớ agent* — report không nói điều này ở bất kỳ đâu, dù đó là điều kiện sống còn của §12.

### §19–§23 — Heuristic và kết luận

- **§19 ĐÚNG về tinh thần; ràng buộc thật nằm ở harness** (`task.maxRecursionDepth=2`, `spawns` policy, `task.disabledAgents`). Report cho heuristic định tính, không cho ngưỡng — chấp nhận được vì ngưỡng phụ thuộc người dùng.
- **§20 Sơ đồ cuối: nhất quán** với §1/§3/§14.
- **§21 Rule 1–8: 6/8 ĐÚNG, 2 cần hiệu chỉnh.** Rule 5 cần cơ chế ghim (mục §14/§15 trên). Rule 7 ("production luôn cần authority của user") **đúng nhưng under-specified tới mức nguy hiểm**: `260911-0133/plan.md` ghi fact 6 — Haravan **im lặng fallback về live production**: `?themeid=999999` trả **HTTP 200** và phục vụ asset của theme live `1001510509`. Nghĩa là câu hỏi "theme live?" của §15 **không thể trả lời bằng themeid đã yêu cầu**; phải assert *theme được phục vụ thật* (`cdn.hstatic.net/themes/<org>/<themeid>/`) sau mỗi capture. Report mô tả một cổng safety mà chính nó sẽ bị platform lừa.
- **§22 ĐÚNG như khung giá trị, CHƯA THÀNH HIỆN THỰC.** B23 (open, P1): *"No live-storefront gate: every claim about rendered fidelity still rests on a human reading a report"*. Giá trị report hứa ("biến workflow cá nhân thành pipeline tự kiểm chứng") **đúng là thứ đang thiếu**, và nó thiếu ở tầng *gate*, không ở tầng agent.
- **§23 ĐÚNG về hướng**, với cùng hiệu chỉnh như §13 (không dựng orchestrator thứ hai; nhưng đừng phủ nhận run-lifecycle + execution-backend seam đã có).

---

## 3. Nghẽn thật đang mở (report không nhắc — đây là phần quan trọng nhất)

Ba dòng P1 **open** trong `plans/bottlenecks.json` (cập nhật 2026-09-10) mô tả chính xác cái mà agency sẽ đâm vào:

| ID | Nghẽn | Ý nghĩa cho report |
|---|---|---|
| **B30** | `anti.visual.compare`'s normalization apply vượt bound 15s ⇒ `capture.valid=false` ⇒ mọi case 1440/1024 thành `CAPTURE_INVALID`/`INCONCLUSIVE` mismatch=100, dù structure khớp tuyệt đối (5546/5546, 5422/5422, 15/15 sections, 83/83 cards) và PNG **có tồn tại trên disk** (1.76–2.62 MB) | Đây là lý do **QA không thể sinh tín hiệu** — nghẽn là *raster verdict*, không phải *fix*. Mọi vòng lặp §8/§12 sẽ quay trên tín hiệu rỗng |
| **B19** | settle gate cộng `addedNodes+removedNodes`, đòi quiet window 1500ms trong budget 9000ms; carousel mỗi-giây không bao giờ đạt | Report §6 xếp MOTION là một category *của QA*; thực tế motion **giết settle** trước khi compare chạy. Taxonomy report không có ô nào cho "không settle được" |
| **B23** | Chưa có cổng live-storefront; mọi claim fidelity phải có người đọc report | §22 hứa đúng thứ này; nó là P1 đang mở, không phải thứ đã xong |

Cộng thêm bằng chứng non-convergence trực tiếp: `ANTIFAN_IMPROVEMENTS.md` vòng 7 làm mismatch **tăng** từ 17.00% lên 24.11% sau khi "khớp ContainerX/SlideContentX"; run4 `subject` capture đã COMPLETE 21/21 sau khi sửa CLI nhưng compare vẫn 1 PASS/40 INCONCLUSIVE vì 28 cặp `content-changed-between-passes` (chỉ `textHash`/`textLength` đổi, geometry/image set/counts y hệt — widget đổi text tại chỗ, và doctrine **từ chối mask**). Đây là nghẽn *doctrine + đo lường*, không phải nghẽn *sinh code*. **Report định vị giải pháp ở đúng nửa không có vấn đề.**

---

## 4. Gaps, risks, mâu thuẫn nội tại

**Mâu thuẫn nội tại của report**
1. §2 chống self-evaluation bias, nhưng §8 không cho Main hành vi hợp lệ khi mọi vòng INCONCLUSIVE ⇒ Main buộc phải tự phán ⇒ tái tạo đúng bias cần chống.
2. §6 cấm biến vấn đề measurement thành PASS, nhưng §9/§10 prompt yêu cầu "chỉ báo hoàn thành khi QA PASS" ⇒ prompt không thể tuân thủ.
3. §12 cho phép chạy song song phần độc lập, nhưng hạ tầng AntiFan serialize bằng một campaign lock vì shared writers (§12 không có mô hình state).
4. §18 bỏ quota nhưng không bỏ **latency/context/compaction** — hai chi phí này không biến mất khi bỏ pricing, và chúng quyết định §12 có khả thi không.
5. §14 "Agent không được override verdict" vs thực tế tham số `tolerance`/`allowHeightDrift` do agent truyền — Rule hô hào mà không có cổng.

**Gap vận hành còn thiếu (không có trong report)**
6. **Chính sách hội tụ/termination**: max iterations, ngân sách wall-clock, ai quyết escalate, escalation đi đâu.
7. **Hợp đồng FAILURE QUEUE**: schema, owner, vòng đời (OPEN→FIXED→RE-VERIFIED), chống ghi lại cùng lỗi. (AntiFan đã có `IssueRegister` + `bottlenecks.json`; report không biết.)
8. **Ghim tham số compare**: chưa ai chặn agent truyền `allowHeightDrift:true`.
9. **Identity của "reference"**: report nói "reference thay đổi → INCONCLUSIVE" nhưng không định nghĩa identity. AntiFan đã có (`bundle identity` mint lúc build, `BUNDLE_IDENTITY_MISMATCH`, `BUNDLE_DRIFT_AFTER_BUILD`, `pinned reference identity`, `instance pid + processStartToken`). Đây là chỗ report nên *trích dẫn và tái dùng*, không nên tự định nghĩa lại.
10. **Mapping về IR tồn tại**: `clone-ir.schema.json`, `qa-matrix.schema.json`, `clone-spec.schema.json` — Design/Builder output phải validate được.
11. **Secret/credential & quyền ghi**: report nói production cần user authority nhưng không nói token nằm đâu, ai phát, thu hồi thế nào; AntiFan đã có vault + Windows DACL + pairing (`docs/security-model.md`).
12. **Multi-project/multi-tenant**: report im lặng; AntiFan có `project/workspace` registry + partition per project — sẽ va chạm nếu hai Project chạy campaign cùng lúc (campaign lock là per-artifact, không per-project).

**Risk nếu adopt §16 nguyên trạng**
13. Che `AGENTS.md` Level-0 (mục §16.1) — rủi ro governance, im lặng.
14. Skill một cấp — đặt sai layout là skill "không tồn tại" mà không có lỗi rõ ràng.
15. `.omp/agents/*.md` thiếu `description` ⇒ file bị **skip kèm warning**, không abort — agent "không tồn tại" trong im lặng (đúng loại lỗi mà grounding axiom của workspace cấm).

---

## 5. Gì nên GIỮ / SỬA / BỎ

**GIỮ (làm ngay được, có giá trị cao)**
- Kiến trúc phân vai §1–§3, §17; bốn agent ở tầng *định nghĩa* (`.omp/agents/*.md`).
- Boundary §13/§14/§23 (OMP orchestration, AntiFan control plane) — nhưng re-scope Rule 8.
- HTML-trước-Liquid (§7) như **thứ tự**, không phải **cổng cứng**.
- Rule 6 (reference drift ⇒ INCONCLUSIVE) và Rule 7 (production cần user authority).

**SỬA (bắt buộc trước khi dùng)**
- §6 verdict: dùng đúng `VerificationVerdict` + `InconclusiveReason` + cause code; bỏ `PASS/FAIL` như vocabulary duy nhất (ánh xạ: report-PASS → `VERIFIED`, report-FAIL → `REJECTED`/sub-verdict, report-INCONCLUSIVE → `INCONCLUSIVE`+reason).
- §6 taxonomy: **hoặc** ánh xạ 1-1 vào cause code thật, **hoặc** bỏ.
- §8/§9: prompt phải chấp nhận terminal state `INCONCLUSIVE` và yêu cầu nêu cause + provenance.
- §15: hook chỉ ghim tham số + chặn typed command; safety thật ở AntiFan authority layer.
- §16: chưa tạo `.omp/AGENTS.md` cho tới khi giải quyết shadowing (hoặc migrate contract vào `.omp/AGENTS.md` + `.omp/RULES.md` trong **một** cutover).
- §18: routing qua `modelRoles`/frontmatter, không kỳ vọng per-item model.

**BỎ**
- Taxonomy 10 nhóm như một hệ độc lập.
- "FAILURE QUEUE" như artifact mới.
- Kỳ vọng Builder/Liquid/Design là đường mặc định sinh code.
- Ngụ ý rằng verdict ở quy mô là chuyện đã xong.

---

## 6. Trả lời trực tiếp acceptance criteria §7 của packet

1. **Phân tích sâu thật**: có — bám 23 mục, mỗi mục có verdict + file/tool + hệ quả (mục 2).
2. **Đối chiếu bằng chứng**: có — ĐÚNG/ĐÚNG MỘT PHẦN/SAI/CHƯA KIỂM CHỨNG, kèm đường dẫn và tên tool.
3. **Gaps/risks/mâu thuẫn**: có — 15 mục ở phần 4, gồm đúng các ví dụ packet nêu (khoảng cách §16 vs khả năng khai báo custom agent — hoá ra KHẢ THI; chi phí/latency coordination; fix-loop không hội tụ; ai giữ state giữa batch; §15 hook — hoá ra CÓ THẬT nhưng không đủ).
4. **Contract 4 field** — ở dưới, acceptance criteria quan sát được.
5. **Khuyến nghị ≤3 approach** — ở dưới, có assumption + điều kiện fail + worst plausible case.
6. **Unknowns tách 2 loại** — ở dưới.


---

# Bounded Contract (winner)

## Outcome

Một delivery nhỏ, chạy được: dựng tầng agency OMP tối thiểu (`.omp/agents/{design,builder,liquid,qa}.md` + `.omp/skills/antifan-theme/SKILL.md` + mapping bảng `modelRoles`) và chứng minh trên ĐÚNG MỘT surface storefront đã biết là adjudicable rằng vòng `design → build → AntiFan verdict → fix → verdict` chạy hết với terminal state có provenance (`PASS` | `FAIL`+cause | `INCONCLUSIVE`+cause), tham số strict compare bị ghim cứng, không có ghi nào chạm theme khác theme được phép, và không tạo vocabulary verdict/taxonomy thứ hai song song với AntiFan.

## Constraints

- Read-only với production: không push/publish/deploy theme live; mọi lệnh có resolved theme id khác theme được phép phải bị từ chối và ghi lại; capture phải assert theme ĐƯỢC PHỤC VỤ (cdn.hstatic.net/themes/<org>/<themeid>/), không tin themeid đã yêu cầu (Haravan fallback HTTP 200 về live theme — 260911-0133 fact 6).
- Không tạo vocabulary mới: mọi verdict/category trong agent output phải ánh xạ 1-1 vào `VerificationVerdict` + `InconclusiveReason` + cause code hiện có (verification-contract.ts; browser-control-port.ts:5103/5228; scripts/lib/evidence-provenance.mjs). Bảng mapping nằm trong SKILL.md, không có mục nào không ánh xạ được.
- Không viết lại engine: không sửa/tái tạo `independent-html-clone-generator`, `asset-localizer`, `theme-compiler`, `visual-capture`, `browser-control-port`, campaign harness; delivery chỉ thêm config + knowledge + (tùy chọn) hook.
- `.omp/agents/*.md` phải có `name` + `description` (thiếu ⇒ file bị skip im lặng); model routing chỉ qua frontmatter `model`/`modelRoles`/`task.agentModelOverrides` (task wire schema không có model per-item).
- Chưa tạo `.omp/AGENTS.md` trong delivery này — vì native priority 100 sẽ che `E:\\Work\\apps\\AntiFan\\AGENTS.md` cùng depth 0; nếu buộc phải có thì migrate contract Level-0 vào `.omp/AGENTS.md` + `.omp/RULES.md` trong một cutover duy nhất, không song song.
- Safety nằm ở AntiFan authority layer (attachment-scoped, fail-closed: `assertExactBrowserTarget`, `issueRuntimeLease`, `CapabilityRisk`, `allowEval` opt-in, `TARGET_STALE`/`TARGET_REQUIRED`/`MCP_BRIDGE_OFFLINE`); hook OMP chỉ là lớp ghim tham số + chặn typed command, không phải cổng duy nhất.
- Ngân sách bị chặn: mỗi vòng lặp tối đa N vòng và có wall-clock budget; hết ngân sách ⇒ kết thúc bằng `INCONCLUSIVE` + cause + số vòng, không được chuyển thành PASS hay 'đã xong'.
- State giữa các bước nằm ở artifact AntiFan (`_verdicts.json`, attempt dirs, `IssueRegister`), không ở context agent; không tạo failure-queue thứ ba.
- Ngôn ngữ tài liệu tiếng Việt, thuật ngữ kỹ thuật giữ tiếng Anh; không tạo file docs ngoài `.omp/` khi chưa được yêu cầu.

## Non-goals

- Không dựng Agent Manager/Scheduler/Swarm/Memory/Router hay bất kỳ orchestrator đa-agent thứ hai trong AntiFan.
- Không sửa các nghẽn đo lường đang mở B30 (normalization apply >15s), B19 (settle gate vs carousel), B23 (live-storefront gate) — đó là workstream riêng có predicate riêng trong `plans/bottlenecks.json`.
- Không chạy campaign 15 trang song song trong delivery đầu; không đụng `.canary/15-pages/**` hay `packages/site-clone/**`.
- Không hứa `PASS`; `INCONCLUSIVE` có cause là kết quả hợp lệ của delivery.
- Không thay thế generator tất định bằng LLM Builder/Liquid ở đường mặc định; không chuyển Liquid lowering thành công việc của agent.
- Không đổi `useDefaultWidgetMasks:false` / `allowHeightDrift:false` / không nới tolerance / không thêm mask / không thêm timeout.
- Không xây dashboard/UI, không đụng renderer AntiFan.

## Acceptance criteria

- `.omp/agents/design.md|builder.md|liquid.md|qa.md` và `.omp/skills/antifan-theme/SKILL.md` tồn tại; một session OMP tại repo root dispatch được từng agent bằng đúng tên (không có lỗi `Unknown agent "..."`), và transcript của child nêu đúng role — quan sát được từ `task` dispatch + `agent://<id>`.
- Session khởi động tại `E:\\Work\\apps\\AntiFan` vẫn inject contract Level-0 hiện có trong block `<repo-rules>` (kiểm bằng nội dung context, không bằng suy luận) — tức không có shadowing im lặng.
- Chạy end-to-end bị chặn trên MỘT surface: QA agent tiêu thụ một verdict document thật của AntiFan có `verdict` + cause code + provenance (store, theme id, instance/run/attempt id, hình học hai phía), và hành động kế tiếp của Builder được suy ra từ cause code đã nêu, không từ văn xuôi mô tả — quan sát được bằng artifact id trong transcript.
- Vòng lặp kết thúc trong ngân sách đã khai: run kết thúc bằng terminal state có provenance, hoặc escalation có kiểu nêu rõ số vòng đã chạy + cause code cuối cùng; không tồn tại run kết thúc ở trạng thái 'đang sửa' không nhãn.
- Trên mọi lời gọi compare/QA trong run, tham số strict bị ghim cứng (`allowHeightDrift:false`, `useDefaultWidgetMasks:false`, tolerance trong trần): truyền tham số nới lỏng từ agent bị hook ghi đè/chặn, và có ít nhất 1 test âm chứng minh điều đó.
- Safety audit của run báo 0 lệnh có resolved theme id khác theme được phép, `publishDeployPush.absent` true, `foreignThemeIds.count` 0 — theo đúng các field audit đang dùng (`report.json` safetyAudit).
- Mọi category/taxonomy xuất hiện trong output của agent (skill, agent prompt, báo cáo) ánh xạ 1-1 vào verdict enum + cause code hiện có, asserted bằng bảng mapping trong SKILL.md không có mục nào bỏ trống.

---

# Recommendation (winner)

Ba approach, so theo worst plausible case, chọn cái nhỏ nhất thỏa contract và rẻ nhất để abandon.

**A — Adopt nguyên trạng (§16 + §8/§12 như viết).** Assumption chịu lực: AntiFan đã cho verdict adjudicable ở quy mô flow cần, và nghẽn là việc sinh code. Điều kiện fail đầu tiên: run thật đầu tiên gặp `INCONCLUSIVE`/`NOT_MEASURABLE` — đã là lớp trội (run4: 40/42 INCONCLUSIVE + 1 timeout; canary: 20/45 INCONCLUSIVE; B30 làm mọi case 1440/1024 `CAPTURE_INVALID`). Worst plausible case: agent đốt vòng lặp trên tín hiệu rỗng rồi chuyển sang văn xuôi mô tả "trông ổn" — đảo ngược Rule 5 ngay trong hệ thống dựng ra để chống nó — đồng thời tạo taxonomy 10 nhóm thứ hai phải đối chiếu về sau. Chi phí abandon: thấp về file, nhưng đã tạo nợ convention.

**B — Adopt có hiệu chỉnh, bị chặn bởi một surface đã adjudicable (KHUYẾN NGHỊ).** Dựng `.omp/agents/*.md` + skill + mapping `modelRoles`, bind output agent vào IR/cause code sẵn có, chạy đúng một surface có verdict adjudicable đã quan sát được, có chính sách termination + hook ghim tham số, terminal state là `PASS | FAIL(cause) | INCONCLUSIVE(cause)`. Assumption chịu lực: tồn tại ít nhất một surface cho verdict adjudicable hôm nay — grounded: run4 `r2-vs-subject` có 1 PASS (`home__1440x900`, mismatch 0), canary page-01 desktop PASS 1.81%, run3/attempt evidence có structure khớp tuyệt đối. Điều kiện fail đầu tiên: surface được chọn cũng rơi vào `CAPTURE_INVALID`/`content-changed-between-passes` (B30/B19 chưa đóng) ⇒ delivery degrade thành "chứng minh plumbing + refusal path", vẫn quan sát được và vẫn trung thực. Worst plausible case: harness agent tốt lên nhưng metric layer vẫn từ chối ⇒ kết thúc với một agency harness đúng và KHÔNG có claim fidelity — bounded, không có false PASS, và phần đã làm vẫn là điều kiện cần cho mọi bước sau. Rẻ nhất để abandon: toàn bộ là config-as-files trong `.omp/`; xoá `.omp/` là revert sạch, không đụng engine.

**C — Chỉ dùng làm reference, không build.** Assumption chịu lực: vòng lặp ad-hoc hiện tại đủ tốt. Điều kiện fail đầu tiên: B23 (P1, open) đã nói ngược lại — "every claim about rendered fidelity still rests on a human reading a report"; mỗi project mới lại tái diễn giải workflow bằng văn xuôi. Worst plausible case: không mất gì, nhưng không tiến được trên một P1 đã được thừa nhận, và report sẽ được "phát hiện lại" lần nữa.

**Chọn B.** Đây là approach nhỏ nhất thỏa contract (4 file agent + 1 skill + 1 bảng mapping + tùy chọn 1 hook), rẻ nhất để abandon (xoá `.omp/`), và — quan trọng nhất — nó **không đòi hỏi đóng B30/B19/B23 trước**. Nó tiêu thụ đúng phần report đúng (phân vai, thứ tự HTML→Liquid, kỷ luật INCONCLUSIVE) và bỏ đúng phần report sai/lạc hậu (vocabulary, taxonomy, queue mới, builder-as-default, hook-as-safety-boundary duy nhất). Hai thứ gần như miễn phí nên làm kèm bất kể chọn gì: (1) bảng ánh xạ report-taxonomy → cause code thật; (2) hook `tool_call` trả `input` để ghim `allowHeightDrift:false` + `useDefaultWidgetMasks:false` cho mọi lời gọi compare — biến Rule 5 từ khẩu hiệu thành cổng chỉ bằng config, không sửa AntiFan.

---

# Unknowns (winner)

- DISCOVERABLE — Trong frontmatter `tools:` của `.omp/agents/*.md`, tên tool MCP dạng `anti.visual.compare` có khớp để giới hạn quyền không, và tên không tồn tại thì bị bỏ qua hay làm hỏng spawn (đọc `packages/coding-agent/src/task/{discovery,executor,spawn-policy}.ts`, hoặc thử một dispatch rồi đọc lỗi).
- DISCOVERABLE — `~/.omp/agent/config.yml` trên máy này có `modelRoles` nào đã map sẵn (`review`, `fast`, `good`, `slow`, `advisor`), và alias nào resolve được cho 4 agent mới (đọc file config + `/model` Roles view).
- DISCOVERABLE — Việc thêm `.omp/AGENTS.md` trên repo này có thật sự che `AGENTS.md` gốc ở depth 0 hay không (kiểm bằng block `<repo-rules>` của một session mới, hoặc `/extensions`).
- DISCOVERABLE — Danh sách cause code đầy đủ và ổn định mà harness đo lường phát ra (`viewport-run.mjs`, `theme-fidelity.mjs`, `scripts/lib/evidence-provenance.mjs`) để lập bảng mapping 1-1 không sót.
- DISCOVERABLE — Surface nào hiện cho verdict adjudicable: đọc lại `.canary/15-pages/_verdicts.json`, `compare/r1-vs-subject|r2-vs-subject/index.json` của `.canary/theme-fidelity-run4`, và attempt evidence mới nhất; xác định mặt nào có `PASS`/`FAIL` thật thay vì `INCONCLUSIVE`.
- DISCOVERABLE — Campaign lock (`.canary/15-pages/.campaign.lock`, `RUN_IN_PROGRESS`) có chặn hai Project/Workspace chạy song song hay chỉ chặn trong cùng artifact root (đọc `phase-01` của 260910-2008 + code acquire/reclaim).
- DISCOVERABLE — `anti.spec.validate_gate` / `HTML_SPEC_READY` chấp nhận spec ở định dạng nào (clone-ir vs clone-spec vs HTML) và có ràng buộc gì với `clone-ir.schema.json` (đọc `browser.validateSpecGate` trong `browser-control-port.ts`).
- UNKNOWABLE tại thời điểm quyết định — Wall-clock latency và trần context/compaction của 4 agent × N surface × M vòng dưới provider hiện tại; chỉ đo được bằng cách chạy, và report đã loại quota/pricing nhưng không loại hai chi phí này.
- UNKNOWABLE tại thời điểm quyết định — Có thể khử non-determinism của reference (widget đổi text tại chỗ; docHeight 5426 vs 5546 ở cùng URL) mà KHÔNG dùng mask hay pin phase hay không — đây là quyết định doctrine của owner (campaign đã từ chối mask một lần), không suy ra được từ code.
- UNKNOWABLE tại thời điểm quyết định — Owner có muốn migrate contract Level-0 từ `AGENTS.md` gốc vào `.omp/AGENTS.md` + `.omp/RULES.md` hay không (quyết định governance, không phải kỹ thuật).
- UNKNOWABLE tại thời điểm quyết định — Ngưỡng termination nào owner thấy chấp nhận được (số vòng, thời gian, chi phí cơ hội) cho một surface và cho 15 surface; đây là khẩu vị vận hành của solo dev.

---

# Ranking Appendix (controller-recorded, ultra best-of-5)

- Mode: `ak:brainstorm --ultra` — 5 read-only candidates dispatched in one parallel wave (5/5 usable, no re-dispatch), anonymized A–E, verifier on strongest available model (`completion(model="slow")`); candidates share the session tier (runtime has no per-subagent model-tier routing) — asymmetric at the verifier only.
- Ranking: **E > B > C > A > D** · Winner: **E** (materialized unchanged above; no blending) · Hard constraints: all 5 passed · Verifier confidence: **HIGH**

| Candidate | C1 Faithfulness | C2 Evidence | C3 Criteria sharpness | C4 Unknowns honesty | C5 Recommendation | Hard |
|---|---|---|---|---|---|---|
| A | 19 | 19 | 18 | 19 | 19 | PASS |
| B | 19 | 20 | 19 | 19 | 19 | PASS |
| C | 19 | 20 | 19 | 19 | 19 | PASS |
| D | 18 | 19 | 18 | 18 | 18 | PASS |
| E | 20 | 20 | 19 | 19 | 20 | PASS |

## Verifier rationale (verbatim)

Cả 5 candidate đều có chất lượng xuất sắc, vượt xa mức thông thường, bám sát live codebase và đọc trực tiếp doc của OMP harness.

Candidate E xếp hạng 1 (Winner) vì đưa ra giải pháp kiến trúc và chẩn đoán sắc bén nhất:
1. Phát hiện insight giá trị nhất về OMP hook: handler 'tool_call' có khả năng trả về '{input}' để ghi đè tham số thực thi, giúp ghim cứng 'allowHeightDrift:false', 'useDefaultWidgetMasks:false' và trần tolerance từ tầng '.omp/hooks' mà không cần sửa core AntiFan — biến Rule 5 từ 'quy ước trên giấy' thành 'cổng cưỡng chế máy móc'.
2. Chỉ ra nút thắt gốc khiến vòng lặp Builder↔QA không thể hội tụ: nằm ở 3 bottleneck P1 đang mở trong 'plans/bottlenecks.json' (B30 normalization apply >15s làm mọi case 1440/1024 thành CAPTURE_INVALID; B19 carousel triệt tiêu settle gate; B23 thiếu live-storefront gate), chứng minh report đang cố giải quyết bài toán sinh code trong khi hệ thống thực tế đang nghẽn ở tầng đo lường raster.
3. Điểm yếu lớn nhất của E: Contract vẫn đề xuất dựng đủ 4 agent thay vì thu nhỏ xuống 2 agent (builder + qa), có thể tạo thêm coordination overhead nếu surface được chọn gặp sự cố harness ngoài dự kiến.

Candidate B xếp hạng 2: Forensics xuất sắc khi phát hiện lỗi alias artifact cực kỳ nghiêm trọng trong live data '.canary/15-pages/_verdicts.json' (page-01-home @390 và page-06-cart @390 dùng chung đúng một cặp hash referencePng/clonePng dù bundle sha256 khác nhau).
Candidate C xếp hạng 3: Bảng 23 section chi tiết, kiểm chứng chính xác modelRoles trong config.yml, phân tích thiếu producer cho failure queue và cơ chế differential attribution.
Candidate A xếp hạng 4: Khảo sát 23 section chặt chẽ, phát hiện Rule 5 bị bypass qua tham số caller, nhưng ít đào sâu vào các bottleneck P1 hơn E và B.
Candidate D xếp hạng 5: Bắt được lỗi lệch tên tool giữa README (snake_case) và runtime MCP (dotted), nhưng scope contract bị co hẹp xuống chỉ 1 agent QA, phân tích section theo nhóm gộp.

## Verifier notes per candidate (verbatim)

- **A:** Khảo sát có hệ thống cả 23 section. Bóc tách chuẩn xác mâu thuẫn giữa Rule 5 và việc browser-control-port cho phép caller truyền tolerance/allowHeightDrift. Contract và unknowns rất trung thực.
- **B:** Phát hiện bằng chứng thực nghiệm xuất sắc: lỗi hash alias giữa page-01 và page-06 ở viewport 390 trong _verdicts.json. Phân tích bất đối xứng phi đơn điệu của verdict cực kỳ sắc sảo.
- **C:** Bảng đối chiếu 23 section toàn diện, số liệu live chính xác (runId, timestamp, modelRoles trong config.yml). Phân tích sâu về việc thiếu producer cho failure queue và hazard Haravan live fallback HTTP 200.
- **D:** Bắt được điểm lệch rất hay giữa README (antifan_*) và live MCP tools (anti.*). Theo dõi được canary session sống lúc 09:41–10:17. Điểm trừ: gộp nhóm section và thu hẹp scope contract xuống chỉ 1 agent QA.
- **E:** Chẩn đoán sâu sắc nhất: nhận diện đúng các bottleneck cốt lõi B19/B23/B30 và đề xuất giải pháp đột phá dùng hook OMP {input} để ghim cứng tham số strict compare, bảo vệ Rule 5 hoàn toàn từ cấu hình.


---

# Advisory Addendum — `--advice` checkpoint (kongming protocol, 2026-09-11)

Routing disclosure: kit agent `kongming` not discovered on this runtime (available: scout/reviewer/security-reviewer/task/sonic). Counsel ran per the "Other host" row on the strongest tier reachable from this session — `completion(model="slow")`, which resolves on this machine to `google-antigravity/gemini-3.8-flash:high` per `~/.omp/agent/config.yml`. Correction of record: the earlier ultra-verifier tier claim ("strongest available") resolves to the same role; the config's strongest selector (`plan: 9router/cx/gpt-5.6-sol:high`) is reachable only via `.omp/agents/*.md` frontmatter `model: "@plan"`, not via `completion()`.

## Counsel verdict

**CONDITIONAL GO — bác Direction B nguyên bản (4 agents); thay bằng "B-Lite": Main + đúng 1 subagent `builder-fixer` (exception path), sau khi đóng Gate P0.**

Phản biện chính (lăng kính solo local, i5-9300H):
1. Design Analyst thừa — `blueprint-extractor`/`dom-tree-parser`/`responsive-scanner` + `clone-ir.schema.json` tất định đã làm việc này chính xác hơn prose LLM.
2. Liquid Agent thừa ở pha đầu — `theme-compiler` + haravan generators là transpilation tất định, không phải bài toán sáng tạo.
3. Builder sai vị trí — phải là Exception Handler, không bao giờ là default path (generator tất định đã Complete).
4. QA Agent bị hiểu sai — AntiFan mới là Judge; QA agent thực chất là report reader. Main đọc thẳng verdict JSON qua MCP là đủ; independence đạt được bằng DATA CONTRACT (Main trích `{causeCode, selector, expectedBox, actualBox}` → fixer chỉ sửa, không phán xét metric) + HOOK, không cần LLM QA riêng.
5. Verifier's "shrink to 2" đúng một nửa — 2 vẫn cồng kềnh; mỗi spawn là context fork tốn CPU/RAM trên 4 core/8 thread.
6. Bẫy cherry-picking: prove trên 1 surface adjudicable trong khi B30/B19 + hash aliasing chưa đóng = 80% thời gian debug tầng đo lường qua triệu chứng agent timeout.

## Gates trước khi viết bất kỳ file nào

- **Gate 1 (P0)**: điều tra artifact aliasing — `page-01-home` @390 và `page-06-cart` @390 trùng cặp hash `referencePng`/`clonePng` dù bundle sha256 khác (`.canary/15-pages/_verdicts.json`). Không đo agent trên thước bẩn.
- **Gate 2**: KHÔNG tạo `.omp/AGENTS.md` (native priority 100 shadow root `AGENTS.md` priority 10 cùng depth 0 — đã verify từ `omp://context-files.md`). Luật agency → SKILL.md / `.omp/RULES.md` / system prompt subagent.
- **Gate 3**: SKILL.md dùng trực tiếp `VerificationVerdict` + cause code từ `verification-contract.ts` / `browser-control-port.ts`; vứt taxonomy 10 nhóm.
- **Next risk**: chọn surface test đầu TIỆT ĐỐI TĨNH (không carousel/lazyload — né B19/B30) [INFERENCE]; circuit breaker tối đa 2 vòng fix, mismatch không giảm → `INCONCLUSIVE: NEED_HUMAN_TRIAGE` (dữ liệu rebound 17.00%→24.11% biện minh).

## Controller corrections (caller-owned, đã verify primary sources)

1. **Hook interception target**: trên deployment OMP này, AntiFan MCP tools được gọi qua `write` JSON vào `xd://mcp__antifan_browser_*` (MCP Tool Routes của session). Hook `tool_call` match `event.toolName === "anti.visual.compare"` SẼ KHÔNG BAO GIỜ FIRE — tool name là `write`. Hook đúng phải match `toolName === "write"` + path prefix `xd://mcp__antifan_browser_anti_visual_compare`/`theme_qa_validate`, parse `content` JSON, ghim `allowHeightDrift:false`/`useDefaultWidgetMasks:false`/trần tolerance, re-serialize trả `{input}` (cơ chế `{input}` replaces execution args — verified `omp://hooks.md`; last-wins; handler throw = fail-closed block). Bypass đã documented: host-bridge calls (eval prelude browser/computer) không emit `tool_call`; bash CLI chỉ chặn được bằng regex mong manh → safety thật vẫn ở AntiFan authority layer.
2. **RULES.md lever**: `.omp/RULES.md` là sticky always-apply, tái gắn gần turn hiện tại, sống sót qua compaction (threshold 200k tokens, `midTurnEnabled: true` trong config.yml máy này) — đúng chỗ cho 4 invariants (INCONCLUSIVE discipline, không override verdict, production authority, không vocabulary thứ hai). Điều kiện: user-scope `~/.omp/agent/RULES.md` shadow project RULES.md (name-based dedup, không concatenate).
3. **Model routing thực tế máy này** (`~/.omp/agent/config.yml`): default/task/smol/slow/tiny/commit = `google-antigravity/gemini-3.8-flash:high`; vision = `gemini-3.8-flash-high:high`; advisor = `aibox/ds/deepseek-flash:xhigh`; plan = `9router/cx/gpt-5.6-sol:high`. Frontmatter `model: "@plan"` là đường duy nhất với tới selector mạnh nhất. `prewalk` vô nghĩa trên máy này (smol = task = cùng selector). `task.agentModelOverrides[agentName]` precedence cao hơn frontmatter.
4. **Frontmatter levers đã verify** (`omp://task-agent-discovery.md`): `name`+`description` bắt buộc (thiếu → warn + skip im lặng); `tools` CSV (auto-add `yield`; restricted list vẫn giữ `hub` trừ khi chặn đích danh; khai `spawns` thì auto-add `task`); `readSummarize: false` = đọc verbatim (mặc định là structural summary — fixer đọc evidence/verdict cần verbatim); `output` = structured schema ngay frontmatter; `autoloadSkills` inject skill từ parent session; `blocking: true` buộc parent chờ; `advisor: true` cặp advisor role; invalid file không abort discovery các file khác; rediscovery mỗi lần dispatch; `.claude/agents` KHÔNG được đọc (chỉ `.omp`).

## Direction sau checkpoint

**B-Lite**: `.omp/agents/builder-fixer.md` (1 file) + `.omp/skills/antifan-theme/SKILL.md` (1 file) + `.omp/RULES.md` (4 invariants, sau khi kiểm tra user-scope RULES.md) + 1 hook `.omp/hooks/pre/*.ts` (ghim strict compare qua xd:// write interception + block push commands). Thứ tự: Gate 1 (aliasing P0) → hook → builder-fixer → prove trên 1 surface tĩnh với circuit breaker 2 vòng. Design/Liquid/QA agents: CẮT/HOÃN — năng lực nằm ở engine tất định + Main.

---

# Owner Ruling & Advisory Addendum Round 2 — `--advice` + `ak:fable-thinking` (2026-09-11)

## Tier correction record (probe-verified, đóng câu hỏi "strongest model")

`completion(model=…)` validate nghiêm ngặt `model ∈ {smol, default, slow}` — probe runtime: `"plan"`, `"advisor"`, `"9router/cx/gpt-5.6-sol:high"` đều trả `RuntimeError: model must be "smol", "default" or "slow"`. Kết luận [OBSERVED]: **không có handle programmatic nào mạnh hơn `slow` (gemini-3.8-flash:high) từ session này**; `@plan`/gpt-5.6-sol:high chỉ reachable qua frontmatter `.omp/agents/*.md` (đường subagent). Ultra verifier + cả hai vòng kongming counsel đều chạy trên tier mạnh nhất reachable — disclosure ở Round 1 ("strongest available") nay đã chính xác sau chỉnh sửa, không cần re-run.

## Owner ruling (Tier-0) — B-Lite v2

Owner chấp nhận ~75–80% counsel Round 1, chốt direction với các sửa đổi:

- **Reframe chốt**: KHÔNG phải "subagent = builder-fixer duy nhất" mà là **"subagent là exception worker; builder-fixer là exception worker mặc định duy nhất của workflow website/HTML clone"**.
- **Design Analyst**: thừa với website→clone (extractor tất định đủ); với Screenshot/Figma/Stitch (không DOM) cần **visual interpretation step** — Main reasoning inline, hoặc spawn visual specialist chỉ khi input thực sự visual-only. Đây là production path của nhánh visual-only, không phải exception.
- **Liquid**: không có `liquid.md` mặc định; generator→success→done; exception→Main spawn builder-fixer/liquid-fixer (exception agent, không permanent).
- **QA agent**: cắt (đồng ý mạnh nhất) — AntiFan Judge → VERDICT JSON → Main → causeCode → builder-fixer.
- **FixRequest contract** (mới): input chuẩn hóa cho fixer mỗi vòng, không ném cả project context.
- **Surface ladder**: static surface = bootstrap strategy, không phải policy — P0 tĩnh → P1 medium dynamic → P2 production-like dynamic ("statically prove the loop before dynamically stress the loop").
- **Circuit breaker = policy**: `FixBudgetPolicy {maxRounds, maxRegressionPct, maxScopeExpansion, stopOnRebound}` — rebound (17→12→24) stop ngay không chờ hết round; cải thiện đơn điệu có thể nới vòng.
- **Hook xd://write**: bắt buộc + telemetry (expected route seen? unexpected transport? 10 phút không thấy xd:// surface → warning).
- **RULES.md cực ngắn** (4 invariants); **không tạo `.omp/AGENTS.md`**; Gate P0 hash aliasing đứng TRƯỚC subagent architecture ("bad evidence → good-looking verdict → automation = automated nonsense").

## Advisory Round 2 (kongming, tier gemini-3.8-flash:high) — CONDITIONAL GO, kèm adjudication của controller

**ACCEPT (counsel đúng):**

1. `relevantHtml`/`relevantCss` trong FixRequest **nguy hiểm vì stale** — fixer vòng 1 edit đĩa, vòng 2 Main nhồi snapshot cũ → fixer lệch pha/revert chính code của nó. CẮT 2 field; fixer có `read`/`grep` (`readSummarize:false`) tự đọc trạng thái thật. (Controller độc lập phát hiện cùng điểm — derive-twice hội tụ.)
2. `allowedFiles/forbiddenFiles` chỉ nhét prompt = "bảo mật bằng niềm tin" → enforce máy móc bằng hook `tool_call` throw khi path ngoài whitelist. Thêm field counsel đề xuất: `diffBudget` (trần dòng edit/round, ngừa rewrite cả file) — enforce được bằng cùng hook.
3. **Launcher inconsistency là risk lớn nhất sau P0**: MCP proxy hardcode `grant:'eval'` (`antifan-omp-mcp.cjs:465`), catalogue đòi `allowEval===true` cho eval+write risk (`capability-catalogue.ts:266`), VBS có `--allow-eval` (`run-antifan.vbs:3`), `npm run dev` KHÔNG → fixer tools fail-closed im lặng nếu test sai launcher. Align launchers trước khi prove loop.
4. P0 investigation: counsel đề xuất giả thuyết **render race/stale navigation buffer** (capture trước khi SPA swap xong / buffer tái sử dụng giữa 2 route). Controller giữ **hai giả thuyết** (Move 3): (H1) render race; (H2) artifact-store key collision (hash/keying nhầm buffer). Discriminating test: đọc code keying/hashing của capture harness + re-capture 2 route có instrument logging.

**CORRECT (counsel sai sự thật, controller đã bác bằng observation):**

5. Counsel claim "[OBSERVED] Main session là gemini-3.8-flash:high" — **SAI, projection error, đã pin bằng hard citation**: session JSONL `~/.omp/agent/sessions/--E--Work-apps-AntiFan--/2026-09-11T05-42-49-822Z_01a08efd-72de-75ab-8cd3-18ce361d06cc.jsonl:5` là record `model_change` với `model: "9router/API/qwen3.8-max-0902"`, `resolvedModelIsFallback: false` [OBSERVED]; catalog `~/.omp/agent/models.yml:106-110`: `reasoning: true`, `input: [text, image]`, contextWindow 1.000.000 [OBSERVED]; workstation metadata khớp cùng selector [OBSERVED]. Flash là tier counsel đang chạy — nó tự chiếu tier mình lên Main. **Hệ quả**: session model CÓ native vision → flag (d) RESOLVED; "Main inline visual reasoning" (điểm 2 owner) khả thi trực tiếp trên session model, không bắt buộc qua `read image?q=` delegation (vẫn hữu ích như lựa chọn tiết kiệm context) hay subagent `model:"@vision"`. Cảnh báo cấu trúc của counsel chỉ còn phần discipline, độc lập model identity: precision pixel đến từ đo tất định `anti.inspect.styles/dom/region` chứ không từ eyeballing; Blueprint-Draft gate cho visual-only input GIỮ (tương thích điểm 2 của owner — owner đã có sẵn nhánh "spawn visual specialist khi visual-only").
6. Counsel claim expectedBox/actualBox "bất khả thi vì Judge chỉ so pixel hash" — **quá tay**: contract thật ĐÃ có metric `visual.geometry_within_tolerance` (`verification-contract.ts:167`) và `MetricSample.expected/actual/delta` (120–130). Shape đúng của FixRequest: chở `MetricSample[]` nguyên trạng (nullable khi producer chưa populate — việc producer có fill box geometry hay không là verification item plan-phase), không phát minh field mới.

## Schema-grounded corrections (controller verify trực tiếp `verification-contract.ts` round này)

- **`INCONCLUSIVE: NEED_HUMAN_TRIAGE` KHÔNG tồn tại** — enum thật: `InconclusiveReason = RESAMPLE | NEED_INPUT | UNOBSERVABLE | UNSUPPORTED` (77–81). Dòng "Next risk" của Round 1 addendum dùng vocabulary invention → sửa thành: rebound/stuck → `StalemateState.STALEMATE` (83) + `haltReason` thật (`UNSUPPORTED`/`NEED_INPUT`). Đúng constraint "không vocabulary thứ hai".
- **Engine ĐÃ có repair-round budget**: `VerificationBatchLifecycle {runId, attemptId, resampleAttempts, repairAttempts, maxResamples, maxRepairs, state: ACTIVE|HALTED|STALEMATE|EXEMPTION_WAIVED|VERIFIED, haltReason}` (87–97) + `circuit-breaker.ts` (`DEFAULT_MAX_RESAMPLES=3`). **FixBudgetPolicy của owner = driver/config cho lifecycle này, KHÔNG tạo counter song song** — `maxRounds`↔`maxRepairs`, `stopOnRebound`↔STALEMATE, `maxRegressionPct`↔haltReason logic.
- **FixRequest v2 (grounded)**: `{claimId, runId, attemptId, obligationId, page, viewport, verdict, inconclusiveReason?, violations[].code (từ GateResult — modular-gates.ts:24), metricSamples[] (metric/expected/actual/delta/passed/message), referenceArtifact, subjectArtifact, allowedFiles, forbiddenFiles, diffBudget}`. Bỏ relevantHtml/relevantCss.
- **`semanticWitness {modelConfirmed, confidence, observations}`** (140–144) = slot contract CÓ SẴN cho kết quả visual reasoning của Main/visual specialist — điểm 2 của owner cắm vào đây, không cần vocabulary mới.

## Execution order chốt (vào `ak:plan`, `--advice` forward-carry)

1. **Gate P0**: điều tra hash aliasing (`page-01-home@390 ≡ page-06-cart@390`) — đọc keying/hashing capture harness, phân xử H1 render-race vs H2 key-collision bằng instrumented re-capture.
2. **Align launcher `--allow-eval`** (VBS ↔ `npm run dev`) trước khi test bất kỳ fixer tool nào qua xd://.
3. **Hook** `.omp/hooks/pre/`: ghim strict compare params + allowedFiles/diffBudget enforcement + route telemetry (10-min warning).
4. **`.omp/RULES.md`** — 4 invariants, cực ngắn.
5. **`.omp/agents/builder-fixer.md` + `.omp/skills/antifan-theme/SKILL.md`** (FixRequest v2 làm data contract; `model:["@plan","@task"]`; không compare/push tools).
6. **Bootstrap loop trên static surface**, budget qua `VerificationBatchLifecycle`; ladder P0→P1→P2 theo owner.

**Plan-phase verification flags** (chưa OBSERVED, phải probe trước khi dựa vào): (a) hook `tool_call` của parent session có fire trên tool call của subagent không — nếu không, allowedFiles enforcement cần cơ chế khác; (b) risk classification của `anti.inspect.*` dưới eval-grant không `allowEval` (read-risk có qua không?); (c) producer của `visual.geometry_within_tolerance` có populate expected/actual box không. Flag (d) "session model có native vision không" — **RESOLVED**: `input: [text, image]` (`models.yml:109`) + `model_change` record không fallback (session JSONL:5).

**Trạng thái contract**: ĐÓNG — B-Lite v2 (owner ruling + Round 2 synthesis). Sẵn sàng handoff `ak:plan`.

---

# Owner Final Verdict & Advisory Round 3 — contract ĐÓNG (2026-09-11)

## Owner final verdict: B-Lite v2 GO

1. MAIN + 1 builder-fixer; không permanent design.md/liquid.md/qa.md; builder-fixer xử lý HTML/CSS + Liquid exception qua SKILL.md + cause-code mapping; tách liquid-fixer chỉ khi có cluster lỗi Liquid đủ lớn.
2. Circuit breaker dùng contract thật (InconclusiveReason enum + VerificationBatchLifecycle.repairAttempts/maxRepairs → STALEMATE → haltReason → INCONCLUSIVE); không counter thứ hai.
3. FixRequest v2 = {claimId, runId, attemptId, obligationId, page, viewport, causeCode, metrics: MetricSample[], violations[], referenceArtifact, subjectArtifact, allowedFiles, forbiddenFiles}.
4. CẮT relevantHtml/relevantCss — "evidence mô tả lỗi; workspace hiện tại mới là source để sửa"; fixer tự read/grep trạng thái thật.
5. allowedFiles/forbiddenFiles machine-enforced + diffBudget (chặn rewrite cả file).
6. **Budget resolution**: `maxScopeExpansion` = FILE/SCOPE (số file Main phê duyệt thêm SAU FixRequest; default **0**; CSS visual fix 0, Liquid binding 0, Component fix 1, Theme integration 1–2) song song `diffBudget` = LINE/CHANGE (ví dụ 80 dòng). Expansion flow: fixer kết thúc lượt bằng REQUEST_SCOPE_EXPANSION → Main + AntiFan evidence xác nhận → rewrite allowedFiles → re-dispatch. Fixer KHÔNG tự mở scope.
7. 6 phases: P0 Gate hash/key collision (H1 render-race + H2 key-collision, phân xử bằng inspect keying/hashing + instrumented recapture) → P1 align launcher/eval → P2 contract (RULES + builder-fixer + FixRequest v2) → P3 machine enforcement → P4 proof 1 static surface → P5 circuit breaker/STALEMATE/provenance → P6 visual-only + Liquid exception. Gate P0 = blocker duy nhất.
8. Trichotomy: MAIN (deterministic first, visual reasoning inline, builder-fixer only on exception, owns workflow/scope/loop/decision) / ANTIFAN (evidence, capture, metrics, Judge, lifecycle, rollback, VERIFIED authority) / BUILDER-FIXER (read actual workspace, fix, respect file policy + diff budget, NEVER self-verify).

## Advisory Round 3 (kongming, tier mạnh nhất reachable) — VERDICT: GO cho ak:plan

**Accepted:**

- **Expansion round không tính `repairAttempts`**: lượt chỉ trả REQUEST_SCOPE_EXPANSION = **SCOPE_DISCOVERY class**, không tiêu ngân sách repair (nếu tính sẽ cạn budget trước khi có code thật).
- **PHASE 4 = đúng 1 fix round có người giám sát** (không dựa engine defaults; `repairAttempts` chưa có hard-cap nối vào Main loop — wiring thuộc PHASE 5).
- **Rollback ownership correction** [OBSERVED `verification-contract.ts`]: engine chỉ có lifecycle state, **chưa có filesystem rollback**; trichotomy gán "rollback" cho AntiFan là khát vọng. Sửa: theme-source rollback thuộc **Main layer** (checkpoint/rewind của harness hoặc baseline copy path-scoped); AntiFan "rollback" = capture/artifact/lifecycle state.
- **PHASE 1 bổ sung Visual Quiescence Check** (DOM idle + network idle + font ready trước khi sample metric) — counsel's Runtime Fidelity Gap; hội tụ với evidence B19/B30 đã có (settle gate/carousel/normalization timeout): trôi metric giả → RESAMPLE → STALEMATE giả.
- **Probe flag (a)** (PHASE 3 gate #1): tạo tạm `.omp/hooks/pre/probe-subagent.ts` log mọi tool_call + session identity → dispatch 1 subagent **có `tools` list hạn chế** (đúng hình dạng builder-fixer) đọc 1 file → quan sát log. Rẻ (1 run), phân xử dứt điểm trước khi xây enforcement.

**Rejected / corrected:**

- ❌ **`git checkout -- . && git clean -fd` tự động của counsel** — CẤM: destructive VCS repo-wide, phá WIP/user work ngoài scope (vi phạm Root Contract). Thay bằng **path-scoped restore**: snapshot nội dung các file trong allowedFiles trước dispatch → sau round, diff đúng các path đã chạm → restore **chỉ** file out-of-scope/vượt diffBudget từ baseline copy. Không bao giờ checkout/clean toàn repo.
- ⚠️ **M1 (hook đọc `active-fix-request.json`)**: stale/zombie state (crash → file còn → chặn oan lần sau) + overhead diff đồng bộ mỗi tool_call trên i5. Mitigation: state file mang runId/attemptId + epoch/TTL; hook chỉ tính diff cho `edit`/`write` khi state active; hết dispatch → Main xóa state (và hook ignore state quá hạn).

## Harness-doc corrections (OBSERVED lượt này — đổi CƠ CHẾ PHASE 3 so với chữ "hook THROW")

1. `omp://extensions.md:538-546`: "a subagent spawned with restricted tools **loads no extensions of its own**"; registry file-write/delete fallback là **process-wide** và được thiết kế để broker write **của subagent** (phân biệt bằng `req.sessionId`). `:301`: `session_stop` "**never fires for task/subagent sessions**".
   → `tool_call` hook của parent **không đáng tin** để fire trong session builder-fixer (fixer có `tools` list hạn chế). PHASE 3 phải chọn 1 trong:
   - **A. Isolation-at-merge** (khuyến nghị): fixer chạy `isolated` (worktree) → mọi edit nằm trong bản copy; **Main gate** kiểm patch/touched-paths ∉ allowedFiles trước khi merge vào theme thật. Enforcement ở ranh giới merge — máy móc, không phụ thuộc hook trong subagent.
   - **B. Main post-execution gate**: git `status --porcelain`/`diff --name-only` trước-sau mỗi round + path-scoped restore (KHÔNG repo-wide). Yếu hơn A (damage-then-undo) nhưng chạy được mọi cấu hình.
   - **C. Denied-write brokering** (`registerFileWriteFallback`): chỉ engage khi write bị DENY (sandbox) — "intended for a host that embeds the agent inside a sandbox denying direct filesystem writes but exposing a privileged write channel". Đúng triết lý AntiFan-as-host nhưng cần fixer chạy trong môi trường thật sự bị deny → **defer** sang giai đoạn sau, không dùng cho PHASE 3 trên dev box thường.
2. `approval-mode.md`: subagent headless chạy `tools.approvalMode: yolo`; `tools.approval.<tool>: deny` absolute nhưng không path-scoped. **Invariant mới**: builder-fixer **không nhận exec-tier tools** (không `bash`, không `eval`) → mọi mutation của fixer chỉ qua `edit`/`write` bị kiểm bởi A/B; không side-effect ngoài workspace mà git/checkpoint không phục hồi được (bác đúng kịch bản M5-side-effect của counsel bằng cách giới hạn tool).
3. Doc còn lại (b) risk class `anti.inspect.*` dưới eval-grant không `allowEval`, (c) producer `visual.geometry_within_tolerance` populate expected/actual — giữ nguyên là probe plan-phase.

## Trạng thái

**CONTRACT ĐÓNG — B-Lite v2 (owner final verdict + Round 3 GO).** Sẵn sàng `ak:plan` với `--advice` forward-carry; Gate P0 là phase 0; PHASE 3 mở đầu bằng probe flag (a); budget policy (maxScopeExpansion song song diffBudget) là một phần contract; không có câu hỏi mở nào chặn plan.

---

# Round 3.1 — Enforcement semantics: doc-kill + flag (a) status (2026-09-11)

## Kill: throw-lever CÓ hiệu lực trên extension path (advisory concern)

- `omp://extensions.md:735` [OBSERVED]: "`tool_call` errors block execution (fail-closed)" — thuộc conventions của **extension runtime**, không chỉ `HookToolWrapper` legacy. Advisory nghi ngờ đúng chỗ nhưng evidence bác: lever `throw` = block vẫn đúng trên path hiện tại.
- `:44` + `:420` [OBSERVED]: mọi tool execution được extension interception wrap (`tool_call`/`tool_result`) "including built-ins and extension/custom tools".
- `:307` [OBSERVED]: `tool_call` pre-exec "may block, or revise the tool's execution `input`"; revision được revalidate + approval gate thấy.
- ⇒ Nếu handler fire, cả `{block}` lẫn `throw` đều chặn được. Câu hỏi DUY NHẤT còn lại: handler có fire trong session của fixer không (flag a).

## Flag (a) — trạng thái: KHÔNG kết luận được bằng doc, giữ nguyên là empirical gate

- Phía "không fire" [OBSERVED gián tiếp]: `:538-545` — subagent có runner riêng; "a subagent spawned with **restricted tools** loads no extensions of its own"; path process-wide duy nhất được document hoá là write/delete permission seam. `:301` — `session_stop` "never fires for task/subagent sessions".
- Phía "fire": không có câu nào nói parent handlers KHÔNG thấy child tool calls; `blocking: true` ("runs inline", `task.md:3`) chưa rõ nghĩa là dùng runner của parent hay chỉ sync-wait.
- `[DERIVED]` `runSubprocess` tạo **child agent session cho mọi spawn** (`task.md:97`), kể cả blocking → "inline" khả năng cao = parent chờ sync, không phải parent runner. Vẫn là inference — không đủ để chốt.
- **Probe matrix (PHASE 3 gate #1)** — hook tạm log mọi `tool_call` + session identity ở parent, dispatch 3 biến thể:
  1. subagent restricted-tools (đúng hình dạng builder-fixer) + `blocking: true`;
  2. subagent restricted-tools, không blocking;
  3. subagent default-tools (control).
  Kết quả quyết định cơ chế enforcement — không đoán trước.

## Seam constraint (advisory concern — xác nhận)

Write/delete seam là **denial-diversion broker**, không phải pre-write whitelist: handler chỉ được consult "for a **denied** write or delete"; "the original error is rethrown if none succeed"; không handler → không engage. Trên dev box unsandboxed, write thành công → seam **không bao giờ engage** → không enforce gì. Discriminator rẻ cần ghi: (i) write vào path ngoài whitelist có thực sự bị deny trên máy này không (kỳ vọng: không); (ii) probe matrix ở trên.

## Hệ quả thiết kế — owner's requirement vẫn giữ, không phụ thuộc hook visibility

- **Option A (isolation-at-merge) là PREVENTIVE theo cấu trúc**: fixer chạy worktree `isolated` → mọi edit nằm trong bản copy; **không byte nào chạm theme thật mà không qua Main gate** kiểm touched-paths ⊆ allowedFiles + diffBudget. Yêu cầu "không tin prompt" của owner được thoả **mà không cần** hook nhìn thấy subagent → đây là lý do A là khuyến nghị chính, không chỉ là lựa chọn ngang hàng.
- Option B (post-execution diff + path-scoped restore) = detect-and-revert, yếu hơn (damage-then-undo) — fallback nếu A không khả thi (isolation cần git repo + backend).
- Option C (denial brokering) moot trên dev box unsandboxed — defer.
- Rollback: dùng harness `checkpoint`/`rewind` hoặc path-scoped baseline restore. **CẤM** mọi destructive VCS repo-wide (`git checkout -- .`, `git clean -fd/x`, `git reset --hard`) theo Root Contract §3 (`E:\Work\apps\AntiFan\AGENTS.md`) — chỉ chạy với explicit user approval. (Corrective note đã áp dụng ở §Round 3 "Rejected".)
- **Surfaced to owner**: nếu probe cho thấy hook không fire VÀ isolation không khả thi, enforcement chỉ còn detect-and-revert — mức bảo đảm thấp hơn "prevent" mà owner yêu cầu; khi đó cần owner quyết (chấp nhận B, hay đầu tư backend isolation cho A).
