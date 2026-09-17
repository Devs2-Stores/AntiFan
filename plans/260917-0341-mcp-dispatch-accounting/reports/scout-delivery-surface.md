# Scout: Phases 3–4 Delivery Surface (MCP Dispatch Accounting)

Scope: read-only reconnaissance of `E:\Work\apps\AntiFan` @ HEAD `41d662ee`, measured 2026-09-17T10:47+07:00.
Every claim is labelled **OBSERVED** (read/run this session), **DERIVED** (inferred from observed lines), or **ASSUMED** (unverified). No file was modified except this report.

## 0. Live measurements taken during this scout

| Fact | Value | Label | Evidence |
|---|---|---|---|
| Store path | `E:\Work\.antifan-data\control-plane-v2\invocations` | OBSERVED | dir listing |
| Ledger `partitionsDir` = `<controlPlaneDir>/invocations` | yes | OBSERVED | `invocation-ledger.ts:116`; `<controlPlaneDir>` = `<dataRoot>/control-plane-v2` `storage-locations.ts:101-103`; wired at `src/main/index.ts:322` and `control-plane-runtime.ts:163` |
| Files now | **1,041** = 1,034 `*.jsonl` + 7 `*.jsonl.quarantine-*` | OBSERVED | `Get-ChildItem -File` |
| Bytes now | 240,733,895 (229.6 MiB) | OBSERVED | same |
| Plan's frozen values | 1,040 = 1,033 + 7, 239 MB | OBSERVED (plan text) | `plan.md:49` |
| Drift since plan freeze | **+1 `*.jsonl` file** | OBSERVED | 1,034 vs 1,033 |
| Total newline-delimited lines | 20,145 | OBSERVED | full byte read + split |
| Quarantine frames | **254** (12+203+6+6+6+12+9) | OBSERVED | per-file non-blank line count; matches `plan.md:49` exactly |
| Full byte-read + line-split cost | **4,712 ms** | OBSERVED | `[System.IO.File]::ReadAllText` over all 1,041 files, this host |
| `getStats()` iterates only `hotPartitions` | confirmed | OBSERVED | `invocation-ledger.ts:736` (`for (const [attachmentId, partition] of this.hotPartitions.entries())`); `quarantinedPartitionCount` comes from an in-memory `Set` (`:105`, `:750`) empty after restart |
| `initialize()` filters `endsWith('.jsonl')` | confirmed | OBSERVED | `invocation-ledger.ts:126`; `pruneDeadPartitions` same at `:142` |
| `antifan:workflow:get-state` already reflects `capabilities.listAll()` | confirmed | OBSERVED | `native-tab-host.ts:2059-2067` |
| `antifan:workflow:run` sender-trust gate already present | confirmed | OBSERVED | `native-tab-host.ts:2119-2120` — the master plan's DEF-04 item at its `phase-02:30` appears already satisfied |

Consequence for the planner: all acceptance numbers must be re-derived at run time. The `1033 + 7 == 1040` line in `plan.md:115` is **already stale on this host**.

---

## 1. Hub tab end-to-end wiring — exact edit checklist

### 1.1 Current structure (OBSERVED)

Nav strip markup: `src/renderer/toolbar.html:468-504`, seven `<button class="hub-nav-tab">` each carrying `.hub-tab-icon`, a label `<span>`, and a `.hub-tab-badge` with a unique id.

```
468:        <div class="hub-nav-strip">
469:          <button class="hub-nav-tab active" id="tabNavWorkflows">
470:            <span class="hub-tab-icon">🔄</span>
471:            <span>Kịch bản (Workflows)</span>
472:            <span class="hub-tab-badge" id="badgeWorkflowCount">0</span>
473:          </button>
474:          <button class="hub-nav-tab" id="tabNavMcp">
475:            <span class="hub-tab-icon">📦</span>
476:            <span>Công cụ (MCP Tools)</span>
477:            <span class="hub-tab-badge" id="badgeMcpCount">0</span>
478:          </button>
479:          <button class="hub-nav-tab" id="tabNavCoreHealth">
...
503:          </button>
504:        </div>
```
Anchor to insert an eighth tab: **between `toolbar.html:503` and `:504`** (i.e. after the `tabNavRegressions` button).

Hub body has exactly **two panes**, shared by all tabs:

```
507:        <div class="hub-body">
509:          <div class="hub-list-pane" id="hubListPane">
510:            <div class="hub-items-list" id="hubItemsList"></div>
514:          <div class="hub-detail-pane" id="hubDetailPane">
515:            <div class="hub-detail-empty" id="hubDetailEmpty">
521:            <div class="hub-wf-detail" id="hubWfDetail" style="display:none;">
569:            <div class="hub-mcp-detail" id="hubMcpDetail" style="display:none;">
588:            <div class="hub-mcp-detail" id="hubCoreDetail" style="display:none;">
600:              <div class="hub-schema-view" id="coreDetailBody">
601:                <pre class="hub-schema-code" id="coreDetailCode"></pre>
```

**There is no per-tab content container.** Tabs render into `#hubItemsList` (left) and one of four mutually-exclusive detail containers, shown/hidden by `style.display` inside the `select*` functions:

| Container | shown at | hidden at |
|---|---|---|
| `hubDetailEmpty` | `toolbar.ts:820`, `:962` | `:642`, `:829` |
| `hubWfDetail` | `toolbar.ts:645` | `:817`, `:830`, `:963` |
| `hubMcpDetail` | `toolbar.ts:965` | `:643`, `:818`, `:831` |
| `hubCoreDetail` | `toolbar.ts:832` | `:644`, `:819`, `:964` |

⇒ **A new tab needs no HTML content container.** It reuses `#hubItemsList` + `#hubCoreDetail`/`#coreDetailCode`. The only HTML edit is the nav button.

### 1.2 Type/array/function inventory (OBSERVED)

```
448: type HubTab = 'workflows' | 'mcp' | 'core-health' | 'bridge' | 'task-runs' | 'root-causes' | 'regressions';
449: const HUB_CORE_TABS: HubTab[] = ['core-health', 'bridge', 'task-runs', 'root-causes', 'regressions'];
450: const HUB_NAV_BUTTONS: Record<HubTab, HTMLButtonElement | null> = {
451:   'workflows': tabNavWorkflows,
452:   'mcp': tabNavMcp,
...
458: };
462: let hubActiveTab: HubTab = 'workflows';
```

`HUB_CORE_TABS` has exactly two consumers, both funnelling into `coreListItems()`:
- `toolbar.ts:512` in `openWorkflowHub()` → `renderCoreListSelection()`
- `toolbar.ts:601` in `renderHubList()` → `renderCoreHubList(search)`

`HUB_NAV_BUTTONS` has one consumer, the active-class loop:
```
941: function setHubTab(tab: HubTab) {
943:   for (const t of Object.keys(HUB_NAV_BUTTONS) as HubTab[]) {
945:     if (btn) btn.classList.toggle('active', t === tab);
```

**DERIVED, load-bearing gotcha:** `coreListItems()` early-returns on missing core state —
```
704: function coreListItems(): CoreListItem[] {
705:   const s = hubCoreState;
706:   if (!s) return [];
```
So any new tab added to `HUB_CORE_TABS` renders `"Đang tải dữ liệu Core…"` (`toolbar.ts:789`) unless `hubCoreState` is populated — which only `refreshCoreHealthState()` (`:517-531`, called from `openWorkflowHub():505` and `btnCoreRefresh:2821`) does. An MCP-dispatch tab must **not** be routed through `coreListItems()`, and must **not** piggyback on the `core-health:get-state` payload (that would make the Core-health IPC do the ledger walk).

**DERIVED, load-bearing constraint:** `setHubTab` is **synchronous** (`toolbar.ts:941`) and is called from seven click listeners (`:2813-2819`). A new tab that must fetch before rendering cannot `await` inside `setHubTab` without changing its signature and all seven call sites. The existing precedent for fire-and-forget is `toolbar.ts:802` (`item.onclick = () => { void selectCoreItem(it.id); }`).

### 1.3 How the existing `mcp` tab renders (OBSERVED)

It renders **list rows**, not a table and not cards. Data flow:

| Step | Site | Detail |
|---|---|---|
| fetch | `toolbar.ts:494` | `await getApi()?.getWorkflowState()` |
| shape | `toolbar.ts:497` | `hubMcpTools = res.tools \|\| []` |
| count badge | `toolbar.ts:499` | `badgeMcpCount.textContent = String(hubMcpTools.length)` |
| render | `toolbar.ts:563` `renderHubList()` | dispatch is `if (workflows) … else if (HUB_CORE_TABS.includes(active)) … else { mcp }` |
| mcp branch | `toolbar.ts:604-634` | filters `hubMcpTools` by name/description/category, builds `div.hub-list-item` |
| row markup | `toolbar.ts:621-630` | `.hub-item-top` > `.hub-item-title` + `.hub-item-pill`; `.hub-item-desc`; `.hub-item-meta` |
| detail | `toolbar.ts:957-983` `selectMcpTool()` | fills `#mcpDetailCategory/#mcpDetailName/#mcpDetailDesc/#mcpDetailPermission/#mcpSchemaCode` |

Exact row template and the only place a metric can attach:
```
621:      item.innerHTML = `
622:        <div class="hub-item-top">
623:          <span class="hub-item-title">${escapeHtml(tool.name)}</span>
624:          <span class="hub-item-pill ${catClass}">${escapeHtml(tool.category || 'tool')}</span>
625:        </div>
626:        <div class="hub-item-desc">${escapeHtml(tool.description || 'Không có mô tả')}</div>
627:        <div class="hub-item-meta">
628:          <span>Quyền: ${(tool.permissions || ['read']).join(', ')}</span>
629:        </div>
630:      `;
```
Data shape consumed per tool (`native-tab-host.ts:2060-2067`): `{ id, name, description, category /* = cap.risk */, permissions: [cap.risk], inputSchema }`.

**Column feasibility (OBSERVED CSS):** `.hub-list-pane { width: 340px; flex-shrink: 0 }` (`toolbar.css:2224-2226`); `.hub-item-meta { display:flex; align-items:center; gap:8px; font-size:10.5px }` (`toolbar.css:2307-2314`); `.hub-item-title` is `white-space:nowrap; text-overflow:ellipsis` (`toolbar.css:2271-2278`). Only ~1–2 short tokens fit beside the existing permission string in 340 px. A real metric table must go in `#hubDetailPane` (`flex:1`, `toolbar.css:2317-2323`) — **and no `.hub-*table*` class exists anywhere in `toolbar.css`** (grep for `hub-table` = 0 hits), so a table costs new CSS.

### 1.4 Minimal diff shape

**Option A — extend the existing `mcp` tab.** Required edits:
1. `toolbar.ts:89`-area: add `getMcpDispatchState?: () => Promise<any>;` to `AntiFanToolbarApi`.
2. `toolbar.ts:505`-area: fetch the stats alongside `refreshCoreHealthState()`.
3. `toolbar.ts:627-629`: add one `<span>` to `.hub-item-meta` joining a stats map by `tool.name`.
4. *(blocked)* the reconciliation invariant and the `UNMEASURED` **never-dispatched** population have no honest container: `.hub-item-meta` on a catalogue row is the wrong population, and `#mcpSchemaCode` is per-tool input-schema JSON (`toolbar.ts:976-982`). A synthetic row inside the catalogue list would misrepresent a catalogue as a measurement.
→ 3 code edits, 1 structural dead-end.

**Option B — new tab `mcp-dispatch`.** Required edits:
1. `toolbar.html:503` — insert one `<button class="hub-nav-tab" id="tabNavMcpDispatch">` (+ `.hub-tab-icon`, label `<span>`, `<span class="hub-tab-badge" id="badgeMcpDispatch">–</span>`).
2. `toolbar.ts:430-446`-area — `const tabNavMcpDispatch = document.getElementById('tabNavMcpDispatch') as HTMLButtonElement | null;` and `const badgeMcpDispatch = …`.
3. `toolbar.ts:448` — add `'mcp-dispatch'` to the `HubTab` union. **This is compile-enforced**: missing the `HUB_NAV_BUTTONS` key is a TS2739 error (no build).
4. `toolbar.ts:450-458` — add `'mcp-dispatch': tabNavMcpDispatch,` to `HUB_NAV_BUTTONS` (**do NOT add to `HUB_CORE_TABS`, per §1.2**).
5. `toolbar.ts:459-466`-area — add `let hubMcpDispatch: any = null;` + `let hubMcpDispatchSelected: string | null = null;`.
6. `toolbar.ts:565` — add a new branch at the **top** of `renderHubList()`: `if (hubActiveTab === 'mcp-dispatch') { renderMcpDispatchList(search); return; }`.
7. `toolbar.ts:693`-area — add `refreshMcpDispatchState()`, `renderMcpDispatchList()`, `selectMcpDispatchRow()`.
8. `toolbar.ts:949-955` — add `else if (tab === 'mcp-dispatch') { renderMcpDispatchList(); }` (without this, `setHubTab` falls through to `renderCoreListSelection()` → `showCoreDetailEmpty()`, `toolbar.ts:954`/`:812`).
9. `toolbar.ts:2819` — `tabNavMcpDispatch?.addEventListener('click', () => { setHubTab('mcp-dispatch'); void refreshMcpDispatchState(); });`.
→ 9 edits, no new CSS required (`overflow-x:auto` already handles an 8th tab, `toolbar.css:2142`), no new HTML container.

**Recommendation (DERIVED):** Option B. It costs 9 mechanical edits vs 3, but the extra 6 are the ones that keep the two populations (`advertised` catalogue rows vs `dispatched` ledger rows) structurally separated, which is the plan's own P0 (`plan.md:30` "never as `0`", `plan.md:114`). The 8th tab is CSS-safe: `.hub-nav-strip` already scrolls horizontally and its comment at `toolbar.css:2138-2141` documents the 7-tab pressure explicitly. Option A's 3 edits are cheaper only if the reconciliation line and the UNMEASURED population are dropped — which the success criteria forbid.

---

## 2. IPC + service pattern — exact template

### 2.1 Handler registration site

All toolbar IPC lives in one method: `private setupToolbarIpc(): void` at `native-tab-host.ts:1152`, ending immediately before `private openInVSCode(...)` at `:2309`. 105 `ipcMain.handle(` calls total in the file.

Precedent region:
```
2224:    // Core Health surface (Phase 6): aggregated snapshot + drill-downs, all
2225:    // read through the existing antifan-core CLI surface. Read-only.
2226:    ipcMain.handle('antifan:core-health:get-state', async () => {
2227:      try {
2228:        return await getCoreHealthService().getState();
2229:      } catch (err) {
2230:        return {
2231:          snapshot: {
2232:            status: 'UNAVAILABLE',
2233:            reasonCode: 'CORE_HEALTH_SERVICE_FAILED',
...
2241:    });
2242:    ipcMain.handle('antifan:core-health:get-task-run-trace', (_event, id: unknown) => {
...
2248:    ipcMain.handle('antifan:capsule:list', () => {
```
Import precedent: `native-tab-host.ts:55` — `import { getCoreHealthService } from '../diagnostics/core-health';`.

**Where the new handler belongs:** inside `setupToolbarIpc()`, immediately after `:2247` (the end of the core-health block, before `antifan:capsule:list` at `:2248`). It is a read-only aggregate read-model, exactly the core-health class. Relative to `antifan:workflow:get-state` (`:2057-2070`, workflow/tool catalogue) it is *not* adjacent — that block is workflow-domain.

Note: `getCoreHealthService()` is a module-level singleton (`core-health.ts:791-795`), so the new service should expose the same `getMcpDispatchService()` singleton shape.

### 2.2 Trust-gate rule (OBSERVED)

9 `isTrustedSessionVaultSender(event)` checks against 105 handlers. Gated handlers and their line:

| Line | Handler | Gate |
|---|---|---|
| 1233 | `antifan:copy-bridge-token` | `if (!…) return null` |
| 1245 | `antifan:rotate-bridge-token` | `if (!…) return null` |
| 1258 | `TOOLBAR_CHANNELS.CLEAR_STORAGE` | `if (!…) return { success:false, cleared:false, reason:'UNTRUSTED_SENDER' }` |
| 1295 | session-vault `validateSender` (+ agent-plane escape at `1296-1301`) | `if (!…) { … isAgent … }` |
| 1333 | session-vault `resolveAttachmentBinding` (positive branch) | `if (isTrusted…) return { valid:true }` |
| 1378 | `TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE` | `if (!…) return { success:false … }` |
| 2051 | `antifan:toolbar:get-mobile-remote-info` | `if (!…) return null` |
| 2073 | `antifan:workflow:get-artifact` | `if (!…) return null` |
| 2120 | `antifan:workflow:run` | `if (!…) return false` |

**Ungated** read models include `antifan:workflow:get-state` (`:2057`), `antifan:core-health:get-state` (`:2226`), `antifan:core-health:get-task-run-trace` (`:2242`), `antifan:capsule:list` (`:2248`), all `TERMINAL_CHANNELS` readers.

The rule as observed: the gate is applied to handlers that (a) return a secret/credential (bridge token, chrome profile cookies, storage clearing), (b) execute or mutate (`workflow:run`), or (c) resolve a caller-named artifact id (`workflow:get-artifact`). Read-only aggregate read models are ungated.

`isTrustedSessionVaultSender` itself (`local-session-vault.ts:59-89`): requires **top frame only** (`frame !== sender.mainFrame` ⇒ false, `:73-74`) and an internal origin — `file:` ending `toolbar.html` / `sidebar.html` / containing `/renderer/` (`:78-81`), or the `antifan:` scheme (`:82-84`); everything else false, fail-closed.

**Recommendation (DERIVED):** the new handler takes no sender-named input and returns no secret, so it follows `antifan:core-health:get-state` and is **ungated** — matching 4/4 existing read-only aggregate precedents. If the planner wants defence-in-depth, the gate must still return a well-formed `UNMEASURED` payload rather than `null`, because the renderer must render `UNMEASURED`/`NO_DATA` and never `0` (`plan.md:30`).

### 2.3 Preload / contextBridge

Real file: `src/preload/toolbar-preload.ts`. Bridge exposure exactly once: `:207` — `contextBridge.exposeInMainWorld('antifanToolbar', toolbarApi);` (`:206-210`).

Existing hub-surface block:
```
117:  // Workflow & MCP Hub APIs
118:  getWorkflowState: () => ipcRenderer.invoke('antifan:workflow:get-state'),
...
129:  getWorkflowArtifact: (artifactId: string) => ipcRenderer.invoke('antifan:workflow:get-artifact', artifactId),
130:  getCoreHealthState: () => ipcRenderer.invoke('antifan:core-health:get-state'),
131:  getCoreTaskRunTrace: (id: string) => ipcRenderer.invoke('antifan:core-health:get-task-run-trace', id),
```
Add `getMcpDispatchState: () => ipcRenderer.invoke('antifan:mcp-dispatch:get-state'),` after `:131`. Renderer-side declaration: `toolbar.ts:89` (`getCoreHealthState?: () => Promise<any>;`) — the `?:` optional form is what lets `test/e2e/toolbar-qa-hub-empirical-probe.cjs` (which stubs only `getInitialState`, `theme-qa-run`, `workflow:get-state`, `workflow:run`, `set-overlay`, `tabs:get-list`, `get-mobile-remote-info` — `:41-138`) keep passing. The renderer must call it with `?.()`: precedent `toolbar.ts:519` — `await getApi()?.getCoreHealthState?.();`.

### 2.4 Exact JSON payload the renderer currently expects from `antifan:workflow:get-state`

Producer (`native-tab-host.ts:2057-2070`):
```
2057:    ipcMain.handle('antifan:workflow:get-state', () => {
2058:      const workflows = this.controlPlane ? this.controlPlane.workflowRegistry.getAll() : [];
2059:      const tools = this.controlPlane
2060:        ? this.controlPlane.capabilities.listAll().map((cap) => ({
2061:            id: cap.name,
2062:            name: cap.name,
2063:            description: cap.description,
2064:            category: cap.risk,
2065:            permissions: [cap.risk],
2066:            inputSchema: cap.inputSchema,
2067:          }))
2068:        : [];
2069:      return { workflows, tools };
2070:    });
```
Consumer: `toolbar.ts:82` typestub `getWorkflowState: () => Promise<{ tools: any[]; workflows: any[] }>`; read at `:496-497`.

```jsonc
{
  "workflows": [ /* WorkflowRegistry.getAll() rows */ ],
  "tools":     [ { "id": string, "name": string, "description": string,
                   "category": string /* cap.risk */, "permissions": [string],
                   "inputSchema": object } ]
}
```

**DERIVED:** the dispatch-accounting payload should keep the same envelope discipline. Proposed minimal envelope the renderer consumes (planner may tighten): `{ status: 'MEASURED'|'UNMEASURED', reasonCode: string, affected: string[], evidenceRefs: string[], asOf: string, storePath: string, census: {...}, rows: [...], totals: {...}, reconciliation: { classified: number, unattributed: number, compositeKeys: number, holds: boolean, line: string } }` — `line` is the pre-formatted printed invariant, so the renderer and the CLI can prove they emit the same string.

---

## 3. Renderer test harness

### 3.1 How the sibling tests work (`test/renderer/core-health-hub.test.ts`, OBSERVED)

| Aspect | Implementation | Lines |
|---|---|---|
| Runner | `node:test` — `import { test, describe, after } from 'node:test'` | `:12` |
| DOM | **jsdom over the real compiled files** — not a fixture, not a hand-written DOM | `:140-145` |
| jsdom resolution | `createRequire(__filename).resolve('jsdom', { paths })`; `ANTIFAN_JSDOM` env dir wins, else default lookup; missing jsdom ⇒ `t.skip(reason)` per test | `:21-34`, `:155` |
| Renderer dir | walk up ≤8 levels looking for `<dir>/.compiled/src/renderer/toolbar.html`, then `<dir>/src/renderer/toolbar.html` | `:36-50` |
| Load | `new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' })`, then `win.antifanToolbar = makeApi(state)`, then `win.eval` of `exports-shim.js` **then** `toolbar.js` | `:141-145` |
| Bridge stub | plain object assigned onto `win` before `toolbar.js` eval; only the methods the toolbar actually touches; unary listeners use `const noop = () => () => undefined` | `:105-125` |
| Async wait | **microtask drain only** — `flush(rounds = 8)` yields `queueMicrotask`, no timers | `:127-135` |
| Interaction | real `.click()` on `#btnWorkflowHub`, then `#tabNav*`, then `await flush()` | `:176-179` |
| Cleanup | `after(() => { dom?.window.close(); })` | `:151-152` |
| Cases | **6** `test(` declarations at `:154`, `:171`, `:192`, `:207`, `:225`, `:239` (1 `describe` at `:150`) | OBSERVED |

Sibling counts (OBSERVED, `test/renderer/`): `core-health-hub.test.ts` 6, `terminal-tab-categories-sleep.test.ts` 41, `terminal-gap-state-machine.test.ts` 10, `terminal-split-behaviour.test.ts` 8, `terminal-tab-layout.test.ts` 7, `terminal-tab-activity.test.ts` 5. `standalone-harness.ts` is a helper, not a `.test.ts` (it has no compiled `.test.js`, so no lane runs it).

Related non-renderer counts: `test/unit/core-health-service.test.ts` 17, `test/main/invocation-ledger.test.ts` 15, `test/main/control-plane-runtime.test.ts` 4, `test/main/process-lifecycle.test.ts` 9, `test/e2e/context-bridge-lifecycle.test.ts` 1. Whole `test/` tree: 205 `*.test.ts` files.

### 3.2 Concrete template for `test/renderer/mcp-stats-hub.test.ts`

Copy the harness verbatim from `core-health-hub.test.ts:21-148`, then add to `makeApi()`:
```ts
getMcpDispatchState: () => Promise.resolve(state),
```
and seed a state such as:
```ts
const MEASURED_STATE = {
  status: 'MEASURED', reasonCode: 'ADMITTED_FRAMES_PRESENT', affected: [], evidenceRefs: ['ledger:invocations'],
  asOf: '2026-09-17T10:47:09+07:00', storePath: '<fixture>/control-plane-v2/invocations',
  census: { files: 1041, jsonl: 1034, quarantine: 7 },
  rows: [{ name: 'browser.dom', calls: 189, states: { completed: 187, failed: 2 }, errors: { TIMEOUT: 2 }, latency: { p50Ms: 41, p95Ms: 380 } }],
  totals: { admitted: 247, residue: 7, quarantineFrames: 254 },
  reconciliation: { classified: 16803, unattributed: 0, compositeKeys: 16803, holds: true, line: 'classified 16803 + unattributed 0 == composite keys 16803' },
};
const UNMEASURED_STATE = { status: 'UNMEASURED', reasonCode: 'NO_DATA_ROOT_RESOLVED', affected: ['ANTIFAN_DATA_ROOT unset'], evidenceRefs: [], asOf: '…', storePath: '', census: null, rows: [], totals: null, reconciliation: null };
```
Interactions, in the exact existing idiom:
```ts
(doc.getElementById('btnWorkflowHub') as HTMLElement).click(); await flush();
(doc.getElementById('tabNavMcpDispatch') as HTMLElement).click(); await flush();
```
This is only viable if the click handler is synchronous — hence the `void refreshMcpDispatchState()` form in §1.4 edit 9. A `setHubTab` that awaits would need extra `flush()` rounds and would be flaky against `rounds = 8`.

### 3.3 Test-scenario matrix (renderer)

| # | Scenario | Seed | Assertion | Anchor |
|---|---|---|---|---|
| R1 | tab exists in the existing hub, no second overlay | MEASURED | `#tabNavMcpDispatch` exists, `overlay.contains(el)`, `el.closest('.hub-nav-strip')`; `querySelectorAll('.workflow-hub-overlay').length === 1` | mirrors `core-health-hub.test.ts:159-168` |
| R2 | rows render, one per recorded dispatch name | MEASURED | `querySelectorAll('#hubItemsList .hub-list-item').length >= 1`; row text contains `browser.dom` and `189` | `:188-189` idiom |
| R3 | reconciliation line printed verbatim | MEASURED | row `#mcpDispatchReconciliation` `.hub-item-desc` equals `reconciliation.line`; `holds === true` renders no `FAIL` token | new |
| R4 | UNMEASURED never renders `0` | UNMEASURED | pill text is `UNMEASURED`; body contains the resolved `storePath`/reasonCode; `!/\b0\b/.test(callsCell)` for the empty case; `!rowExists` | mirrors the "no percentage" assertion `:187` |
| R5 | detail pane shows the full per-name metric block | MEASURED | click the `browser.dom` row → `#coreStatusPill` = row status, `#coreDetailCode` contains `p95` | `:216-222` idiom |
| R6 | missing bridge method degrades, does not throw | `makeApi()` without `getMcpDispatchState` | tab renders UNMEASURED; no unhandled rejection | `toolbar.ts:519` optional-chain precedent |
| R7 | search filters rows | MEASURED (2 rows) | type into `#hubSearchInput` + dispatch `input` → row count 1 | `toolbar.ts:2825-2830` |

### 3.4 npm scripts and `.compiled`

`npm run compile` (package.json:24) is the prerequisite: it runs `tsc -p ./` **and** `node scripts/copy-static.mjs`. `.compiled` output **does matter**, for two independent reasons:
1. `RENDERER_DIR` prefers `<root>/.compiled/src/renderer/toolbar.html` (`core-health-hub.test.ts:41-42`), and that file plus `toolbar.css` are *copied*, not compiled: `copy-static.mjs:36-49` (`'toolbar.html', 'toolbar.css'`). An HTML/CSS edit that is not followed by `copy-static` is invisible to every renderer test and to the app.
2. `toolbar.js` is compiled and then prefixed with `var exports = exports || {};` by `copy-static.mjs:52-71`; the test `win.eval`s that exact artifact (`core-health-hub.test.ts:145`).

Lanes:
| Command | Includes renderer tests? | Evidence |
|---|---|---|
| `npm run test:fast` | **yes** — `.compiled/test/renderer/**/*.test.js` | `package.json:39` |
| `npm run test:unit` | no renderer glob; `.compiled/test/*.test.js`, `unit/**`, `integration/**`, `benchmark/**` | `package.json:43` |
| `npm run test:file -- <path>` | single file, any path | `package.json:41` |
| `npm test` / `npm run verify` | `node scripts/run-test-pipeline.mjs [--verify]`; lanes `compile, test:canary, test:fast, test:site-clone, test:integration, test:main, test:e2e` and `--verify` prepends `audit, plans:check` | `package.json:46-47`, `run-test-pipeline.mjs:22-25` |

Minimum proof command for a new renderer test:
`npm run compile && node --test --test-force-exit ".compiled/test/renderer/mcp-stats-hub.test.js"`

---

## 4. CLI harness pattern

### 4.1 Existing shapes (OBSERVED)

| Pattern | Example | Root resolution | Machine-readable | Registered |
|---|---|---|---|---|
| `.mjs` gate with `--json` | `scripts/check-plans.mjs:10,27-37,62-76` | `--root plans` arg, relative to cwd | `--json` | `package.json:38` `plans:check` |
| `.mjs` gate with `--json`/`--quiet` | `scripts/check-bottlenecks.mjs:27,33-36` | `ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..')` | `--json` | `package.json:37` `audit` |
| `.mjs` structural gate, stdout notes + stderr FAIL + `exit(1)` | `scripts/check-mcp-budget-dominance.mjs:33-47,379-383` | `ROOT` same idiom; reads `.compiled/src` | line-prefixed `[budget-dominance]` | **not** a script entry — wired into `compile` (`package.json:24`) |
| `.cjs` evidence harness requiring compiled TS | `scripts/certify-core-freeze.cjs:9,59` | `rootDir = path.resolve(__dirname,'..')`; `require(path.join(rootDir,'.compiled','src','main','tools','artifact-store.js'))` | JSON written atomically + stdout | `package.json:64` `certify:core-freeze` |
| `.ts` harness compiled to `.compiled/scripts/` | `scripts/audit-core-purity.ts:47-49` (`export function runCorePurityAudit()`); compiled artifact exists at `.compiled/scripts/audit-core-purity.js` | `path.resolve(process.cwd(),'src/main')` | returns a struct | **no** `package.json` entry, no caller found → invoked manually |
| Data-root discovery from a script | `scripts/lib/build-report.mjs:785-807` `artifactRoots(explicit)` | precedence: explicit arg → `process.env.ANTIFAN_ARTIFACT_ROOT` → `<REPO_ROOT>/.antifan-data/control-plane-v2/artifacts` → `<REPO_ROOT>/../.antifan-data/...` → `<REPO_ROOT>/../.antifan-canary/...` → `.canary/state/instance-env.json`'s `env.ANTIFAN_DATA_ROOT` | n/a | library |

App-side root resolution for reference: `StorageLocations.getDataRoot()` (`storage-locations.ts:29-71`) — `ANTIFAN_DATA_ROOT` env first (`:33-34`), else probes `E:\Work\.antifan-data` etc. (`:41-62`, writing a probe file), else `%APPDATA%\AntiFan\data` (`:65-68`). `getControlPlaneDir()` = `<dataRoot>/control-plane-v2` (`:101-103`).

### 4.2 Where the new harness should live, and the exact command

**DERIVED recommendation:** `scripts/antifan-mcp-dispatch-account.cjs` (`.cjs`, not `.ts`), because it must `require` the *same* compiled reader the main process uses — the `certify-core-freeze.cjs:59` precedent — and `.cjs` is unambiguously CommonJS in a `"type": "commonjs"` package while `tsconfig.json:22` would also compile a `.ts` sibling to `.compiled/scripts/`. A `.ts` harness cannot be `node`d from source, so it would add a compile→run indirection for no gain.

Exact human command:
```
npm run compile
node scripts/antifan-mcp-dispatch-account.cjs --store "E:\Work\.antifan-data\control-plane-v2\invocations" --as-of 2026-09-17T10:47:09+07:00 --json
```
Determinism proof on a frozen copy (two runs byte-identical modulo `asOf`) requires the harness to snapshot the store itself — copy to a temp dir under `os.tmpdir()`, then run twice against `--store <tmp>` with the same `--as-of`. The copy is a write **outside** the store; the store stays read-only (satisfies `plan.md:121`).

**package.json entry: optional but recommended.** Registry convention observed: a harness gets a name when it is part of a repeated workflow (`audit`, `plans:check`, `certify:core-freeze`, `harness:theme` — `package.json:37,38,62,64`); it gets none when it is ad-hoc (`audit-core-purity.ts`) or when it is a compile gate (`check-mcp-budget-dominance.mjs`). Proposed one-liner to add after `package.json:64`:
```json
"accounting:mcp-dispatch": "npm run compile && node scripts/antifan-mcp-dispatch-account.cjs",
```
No existing script glob would pick the new file up automatically, so an entry is the only way to give a human a stable name.

---

## 5. Memo design constraints

Observed cost basis: one full pass = 4,712 ms for 240.4M chars / 20,145 lines (§0); adding per-line `JSON.parse` + `sha256` will dominate. Plan's 2.9–13.7 s (`plan.md:57`) is consistent.

**Proposed minimal warm-path memo (DERIVED):**

| Aspect | Design |
|---|---|
| Where it lives | Private fields on the new service class in `src/main/diagnostics/mcp-dispatch-accounting.ts`, mirroring `CoreHealthService.cliCache`/`cliInFlight` (`core-health.ts:273-274`) and its `clearCache()` (`:370-372`). No new file, no on-disk rollup. |
| Key | `censusKey = sha256(join(sorted(file.name + ':' + file.size + ':' + file.mtimeMs))) + '|' + asOf`. `asOf` participates because terminal-frame latencies and the "as of" stamp are part of the payload. |
| Value | the fully aggregated `McpDispatchAccount` object (rows + totals + reconciliation). One entry is enough; evict on key change rather than LRU. |
| Invalidation | (a) key mismatch on next call; (b) explicit `clearCache()` exposed to the IPC handler for a manual refresh (precedent: `btnCoreRefresh` → `toolbar.ts:2821` → `refreshCoreHealthState()`); (c) **not** TTL-based — a TTL alone cannot see a file append. |
| CLI bypass | The CLI is a separate process, so it never shares the memo. It additionally takes `--no-memo` and `--as-of` so a single process can run two passes with the memo off and prove equality. Memo must be **off by default in the CLI** (the CLI's job is determinism, not speed). |
| Grow-during-read handling | The census pass records `size` per file at `asOf`; the read pass **bounds each file at its censused byte length** (read exactly `size` bytes, ignore any tail appended after census). Any bytes past the censused length are counted as `POST_CENSUS_APPEND` residue, not silently included — otherwise one command's totals depend on read interleaving. Truncation at a censused boundary can split a line mid-token, so the cut fragment must be classified `TORN_TAIL`, never `CHECKSUM_MISMATCH` (the plan's own rule, `plan.md:146`). Without this bounding, the memo's "the store grew" signal is the only defence and it is post-hoc: the payload would already contain a non-reproducible total. |

**Risk named by the plan** (`plan.md:145`) and its observable signal: "counts differ between two runs of the same command". With size-bounded reads the signal becomes: two runs on the *same* `--as-of` produce identical `classified + unattributed` while `totals.admitted` differs — which would mean a file's *content* changed without its size changing (possible: the ledger rewrites partitions via compaction, `invocation-ledger.ts:260-271`). Pre-decided response: treat content-hash mismatch on any censused file as a hard `CENSUS_DRIFT` reasonCode and refuse to print a stable total, rather than re-reading and quietly mixing two snapshots.

---

## 6. File inventory for phases 3–4

| Action | Path | One-line purpose |
|---|---|---|
| CREATE | `src/main/diagnostics/mcp-dispatch-accounting.ts` | Line-level ledger reader + per-name aggregator + reconciliation + memoized service + `getMcpDispatchService()` singleton; types co-located (single file, mirrors `core-health.ts`) |
| CREATE | `scripts/antifan-mcp-dispatch-account.cjs` | Deterministic CLI: census → read → aggregate → print JSON, requiring the compiled reader from `.compiled/src/main/diagnostics/mcp-dispatch-accounting.js`; `--store/--as-of/--no-memo/--freeze/--json` |
| CREATE | `test/renderer/mcp-stats-hub.test.ts` | jsdom proof of the new Hub tab (rows, UNMEASURED, reconciliation line) — §3.3 matrix |
| CREATE | `test/unit/mcp-dispatch-aggregate.test.ts` | Aggregator unit cases against a fixture store: composite identity, latency owner-only, reconciliation holds/breaks, memo key change, torn tail vs checksum mismatch |
| MODIFY | `src/renderer/toolbar.ts` | 9 edits per §1.4 Option B: consts `~430`, `HubTab:448`, `HUB_NAV_BUTTONS:450-458`, state `~459`, `renderHubList:565` branch, new render functions `~693`, `setHubTab:949`, click wiring `2819`, `AntiFanToolbarApi:89` |
| MODIFY | `src/renderer/toolbar.html` | One `<button class="hub-nav-tab" id="tabNavMcpDispatch">` inserted at `:503` |
| MODIFY | `src/main/browser/native-tab-host.ts` | Import at `~:55`; one `ipcMain.handle('antifan:mcp-dispatch:get-state', …)` after `:2247` |
| MODIFY | `src/preload/toolbar-preload.ts` | One line after `:131`: `getMcpDispatchState: () => ipcRenderer.invoke('antifan:mcp-dispatch:get-state')` |
| MODIFY | `src/renderer/toolbar.css` | *(conditional)* only if a metric table or an `UNMEASURED` badge tint is wanted; no `.hub-*table*` class exists today (`toolbar.css:2131-2314` has no table rule) |
| MODIFY | `package.json` | *(optional)* one `accounting:mcp-dispatch` script entry after `:64` |
| MODIFY | `test/main/ipc-audit.test.ts` | *(optional, additive)* add the new channel to the required-channels list at `:419-425`; **the existing test is a required-set, not an allowlist**, so it will not fail without this |
| DELETE | — | none |

Existing test counts for touched areas: `test/renderer/**` 6 files / 77 cases; `test/main/native-tab-host`-adjacent source-scan tests live in `test/main/ipc-audit.test.ts` (14 `it(` blocks, `:415-445` is the workflow-authority one); `test/unit/core-health-service.test.ts` 17 cases is the closest service-test template; `test/main/invocation-ledger.test.ts` 15 cases.

### Risky dependency edges

| Edge | Evidence | Handling |
|---|---|---|
| `src/renderer/toolbar.ts` also edited by `plans/260916-1037-antifan-defect-remediation-master` | its `phase-03:29` claims `~1045-1055` (precondition refusal styling) and `~2910-2919` (skipped CSS mapping); its `phase-02:31` claims `~1072` (`.catch(() => null)` on artifact fetch) | Our regions are `395-458`, `563-635`, `941-956`, `2813-2819`. **No textual overlap**, but our inserts shift every line below them by up to +9. Both plans must anchor edits on declarations, and merge order must be stated (the plan already requires this — `plan.md:128`). Observed current state matches the master plan's `phase-03:29` expectations at `:1045-1055` and `:1072-1080`. |
| `src/main/browser/native-tab-host.ts` also edited by the master plan | its `phase-02:30` claims `~2037-2054` (12-stub tool array), `~2070` (trust on `workflow:run`), and "add `antifan:workflow:get-artifact`" | **Already satisfied on disk**: `:2057-2067` projects `capabilities.listAll()`; `:2119-2120` gates `workflow:run`; `:2072-2103` implements `get-artifact` with a trust check at `:2073`. Our new handler sits at `~:2248`, far from all three. |
| File size | `native-tab-host.ts` = **8,157 lines**, 105 `ipcMain.handle` calls, `setupToolbarIpc()` spans `1152-2307` | Single-line insert after `:2247`; do not reflow the method. `npm run compile` is the only safe syntax proof. |
| `test/e2e/toolbar-qa-hub-empirical-probe.cjs` stubs a partial bridge | `:41-138` registers 7 channels only | The renderer must call the new channel as `getApi()?.getMcpDispatchState?.()`. A hard call breaks this e2e probe. |
| Renderer test reads `.compiled/src/renderer/*` | `core-health-hub.test.ts:41-42`; `copy-static.mjs:36-49` | Any `toolbar.html`/`toolbar.css` edit requires `npm run compile` before the renderer test can see it. |
| 8th hub tab vs strip width | `toolbar.css:2138-2141` documents the 7-tab overflow; `overflow-x:auto` at `:2142` | CSS-safe, but the tab label must stay `white-space:nowrap` (`toolbar.css:2176`) and the badge must not wrap. |

---

## 7. Function / interface checklist and dependency map

### 7.1 Phase 3 — aggregate (in `src/main/diagnostics/mcp-dispatch-accounting.ts`)

| Symbol | Signature (proposed) | Responsibility |
|---|---|---|
| `censusStore` | `(storeDir: string, asOf: string) => Promise<Census>` | `readdir` + `stat` every `*.jsonl*`; returns `{ asOf, files: Array<{name,size,mtimeMs}>, fileCount, jsonlCount, quarantineCount }`; computes `censusKey` |
| `readAdmittedFrames` | `(census: Census) => Promise<{ admitted: Frame[]; residue: Residue[] }>` | Reads each file bounded at censused `size`; per line: parse → `computeFrameChecksum` → classify `ADMITTED` / `CHECKSUM_MISMATCH` / `TORN_TAIL` / `UNPARSEABLE` / `POST_CENSUS_APPEND` |
| `aggregateByName` | `(admitted: Frame[]) => AggregateResult` | Groups by `frame.intent.name` (the recorded dispatch name, `plan.md:55`); per name: `calls`, `states` mix, `error.code` histogram, latency p50/p95 from **owner-written terminal frames only** |
| `reconcile` | `(admitted, residue, distinctCompositeKeys) => Reconciliation` | `{ classified, unattributed, compositeKeys, holds, line }`; `line` is the exact printable invariant `classified + unattributed == composite keys` |
| `accountStore` | `(options: { storeDir: string; asOf: string; memo?: boolean }) => Promise<McpDispatchAccount>` | Orchestrates the four above; the single entry point shared by service and CLI |
| `McpDispatchService` | `class { getState(): Promise<McpDispatchAccount>; clearCache(): void }` | Memo owner (§5) |
| `getMcpDispatchService` | `() => McpDispatchService` | Module singleton, mirroring `getCoreHealthService` (`core-health.ts:791-795`) |

Invariants the aggregator must enforce (from `plan.md`): identity is `(attachmentId, idempotencyKey)` (`:51`); replay-synthesized terminal frames excluded from latency and counted separately (`:117`); never `InvocationLedger.initialize()`, never `getStats()` (`:33`, §0).

### 7.2 Phase 4 — delivery surface

| Symbol | Where | Responsibility |
|---|---|---|
| `getMcpDispatchState` (main) | `native-tab-host.ts` after `:2247` | `try { return await getMcpDispatchService().getState(); } catch { return { status:'UNMEASURED', reasonCode:'MCP_DISPATCH_SERVICE_FAILED', … } }` — mirrors `:2226-2241` |
| `getMcpDispatchState` (bridge) | `toolbar-preload.ts` after `:131` | `ipcRenderer.invoke('antifan:mcp-dispatch:get-state')` |
| `getMcpDispatchState?` (renderer type) | `toolbar.ts:89` | optional method on `AntiFanToolbarApi` |
| `refreshMcpDispatchState()` | `toolbar.ts ~:693` | `await getApi()?.getMcpDispatchState?.()`, store into `hubMcpDispatch`, update `badgeMcpDispatch`, then `renderHubList()` |
| `mcpDispatchRows()` | `toolbar.ts ~:693` | Map `hubMcpDispatch.rows` → `CoreListItem`-shaped rows **plus** one synthetic `id: '__reconciliation__'` row carrying `reconciliation.line` |
| `renderMcpDispatchList(search)` | `toolbar.ts ~:693` | Emits `div.hub-list-item` rows into `#hubItemsList`; sets `item.id = 'mcpDispatchReconciliation'` on the invariant row so the test has a stable anchor |
| `selectMcpDispatchRow(id)` | `toolbar.ts ~:693` | Reuses `#hubCoreDetail` + `#coreDetailCode` (`toolbar.ts:832-848` idiom) — no new HTML |
| `setHubTab` branch | `toolbar.ts:949-955` | `else if (tab === 'mcp-dispatch') { renderMcpDispatchList(''); }` |
| `renderHubList` branch | `toolbar.ts:565-567` | `if (hubActiveTab === 'mcp-dispatch') { renderMcpDispatchList(search); return; }` — must come **before** the `HUB_CORE_TABS` check |
| Nav click | `toolbar.ts:2819` | `tabNavMcpDispatch?.addEventListener('click', () => { setHubTab('mcp-dispatch'); void refreshMcpDispatchState(); });` |
| Nav button | `toolbar.html:503` | `<button class="hub-nav-tab" id="tabNavMcpDispatch">` |

### 7.3 Dependency map (what must land before what)

```
Phase 1 census contract  ──►  Phase 2 line-level reader  ──►  Phase 3 aggregate (accountStore, reconcile)
                                                                    │
                        ┌───────────────────────────────────────────┴───────────────────────────┐
                        ▼                                                                       ▼
        service + IPC handler (native-tab-host ~:2248)                        CLI harness (scripts/*.cjs)
                        │  requires: preload method + renderer type stub                  requires: `npm run compile`
                        ▼                                                                (reads .compiled/src/...)
             renderer Hub tab (toolbar.ts 9 edits + toolbar.html:503)
                        │
                        ▼
             test/renderer/mcp-stats-hub.test.ts   ← needs `npm run compile` (copy-static) to see toolbar.html
```
Hard ordering:
1. Phase 2 reader must be callable from a plain Node process (no `electron` import) — otherwise the CLI cannot share it. **ASSUMED** risk; verify by grepping the new module's imports for `electron`.
2. `hubMcpDispatch` shape must be frozen before the renderer and the CLI both consume it; the CLI is the cheaper place to freeze it (it can run without Electron).
3. `npm run compile` gates: `check-mcp-budget-dominance.mjs` must stay green (`package.json:24`). Since no new advertised MCP tool is added (`plan.md:122`), this gate is untouched — **but** the new IPC channel name must not collide with a `capabilities` name. `antifan:mcp-dispatch:get-state` is an IPC channel, not a capability, so no collision.
4. `npm run plans:check` (`package.json:38`) gates `plan.md` frontmatter — phase files must keep valid `status:` values when they are filled in (currently all `status: todo`, `check-plans.mjs:15-25` accepts `todo`? — **not in the bucket list**; observed buckets are `completed/complete/done/in-progress/active/pending/planned/superseded/blocked` at `check-plans.mjs:15-25`. **RISK: `status: todo` in all 7 phase files is NOT a recognized status.** That gate reads `plans/**/plan.md` only (`check-plans.mjs:53`), so today it does not fire; if the gate is ever widened to phase files, all 7 fail.

---

## 8. Risks

| # | Risk | Observable signal | Pre-decided response |
|---|---|---|---|
| 1 | New tab routed via `HUB_CORE_TABS` shows the wrong empty state | Hub shows `"Đang tải dữ liệu Core…"` with no rows, while `core-health:get-state` is healthy | Do not add `'mcp-dispatch'` to `HUB_CORE_TABS` (`toolbar.ts:449`); use a dedicated branch before the `HUB_CORE_TABS` check |
| 2 | `setHubTab` is sync; adding an `await` breaks 7 call sites | `toolbar.ts:2813-2819` renders nothing until a manual re-render; renderer test needs more than 8 flush rounds | Fetch fire-and-forget from the click listener (`void refreshMcpDispatchState()`), never make `setHubTab` async |
| 3 | Renderer test reads stale HTML | `#tabNavMcpDispatch` is `null` in jsdom, `assert.ok(el)` fails | Always `npm run compile` (which runs `copy-static.mjs:36-49`) before the renderer test lane |
| 4 | e2e hub probe breaks on a hard bridge call | `test/e2e/toolbar-qa-hub-empirical-probe.cjs` (7 stubbed channels, `:41-138`) shows an unhandled rejection / missing rows | Call with `getApi()?.getMcpDispatchState?.()`; guard with `if (!res) → UNMEASURED` |
| 5 | Service import drags `electron` into the CLI | `node scripts/antifan-mcp-dispatch-account.cjs` throws `Cannot find module 'electron'` | Keep the reader/aggregator module free of `electron` imports; put only the memo+singleton there, and let the IPC handler live in `native-tab-host.ts` |
| 6 | Memo serves a stale total after a live dispatch | Hub row count lags a real invocation; `badgeMcpDispatch` frozen | Memo key includes per-file `size+mtimeMs` of the whole file set; expose `clearCache()` on the manual refresh button (precedent `toolbar.ts:2821`) |
| 7 | Store grows during a read | Two runs of the same command differ; on this host the store already moved 1,033→1,034 `*.jsonl` since the plan froze | Bound each read at the censused byte length; count the excess as `POST_CENSUS_APPEND`; never claim a stable total without the census hash. `plan.md:145` |
| 8 | A censused file is rewritten in place with the same size (compaction) | Same `--as-of`, identical file set+size, different `classified` | Emit `CENSUS_DRIFT` and refuse to print a stable total; do not silently merge two snapshots |
| 9 | Truncation at the censused boundary is misread as corruption | `CHECKSUM_MISMATCH` count > 0 on a recently-written partition | Classify the cut tail as `TORN_TAIL`, never `CHECKSUM_MISMATCH`; never quarantine on read. `plan.md:146` |
| 10 | Latency computed from replay-synthesized terminal frames | p95 shifts with `initialize()` history rather than dispatch behaviour | Exclude frames whose `error.code` is `EXECUTION_UNKNOWN` / `PROCESS_INTERRUPTED` written by `replayPartition` (`invocation-ledger.ts:224-240`); count them separately in the payload. `plan.md:117` |
| 11 | The reconciliation line is asserted as a constant instead of computed | Test passes while the invariant is broken | The renderer prints `reconciliation.line` from the payload; the test compares against that same field, and a separate unit case seeds a non-closing census to prove `holds === false` |
| 12 | Master-plan merge collision in `toolbar.ts` | Git conflict at `~1045-1055` / `~1072` / `~2910-2919`, or silently shifted anchors | Anchor every edit on a declaration string (not an absolute line); state merge order in the PR body per `plan.md:128` |
| 13 | `status: todo` in the 7 phase files is not a recognized plan status | If the gate's file filter is ever widened past `plan.md`, `plans:check` fails 7× (`unknown.length > 0` ⇒ exit 1) | Use a recognized status when filling the phase files; today `collectPlanFiles` matches only files named exactly `plan.md` (`check-plans.mjs:53`), and the bucket list has no `todo` (`:15-25`, verdict at `:99-103,133`) |
| 14 | New IPC channel grows the untested surface | No test asserts the handler exists / is reachable | Add the channel to the required-channels list (`test/main/ipc-audit.test.ts:419-425`) — additive, cannot break the gate |

---

## Copy-pasteable anchors

**Nav strip insert point — `src/renderer/toolbar.html:499-504`**
```html
499:          <button class="hub-nav-tab" id="tabNavRegressions">
500:            <span class="hub-tab-icon">🧪</span>
501:            <span>Kiểm tra hồi quy (Regression)</span>
502:            <span class="hub-tab-badge" id="badgeRegressions">0</span>
503:          </button>
504:        </div>
```

**`HubTab` / `HUB_CORE_TABS` / `HUB_NAV_BUTTONS` — `src/renderer/toolbar.ts:448-458`**
```ts
448: type HubTab = 'workflows' | 'mcp' | 'core-health' | 'bridge' | 'task-runs' | 'root-causes' | 'regressions';
449: const HUB_CORE_TABS: HubTab[] = ['core-health', 'bridge', 'task-runs', 'root-causes', 'regressions'];
450: const HUB_NAV_BUTTONS: Record<HubTab, HTMLButtonElement | null> = {
451:   'workflows': tabNavWorkflows,
452:   'mcp': tabNavMcp,
453:   'core-health': tabNavCoreHealth,
454:   'bridge': tabNavBridge,
455:   'task-runs': tabNavTaskRuns,
456:   'root-causes': tabNavRootCauses,
457:   'regressions': tabNavRegressions,
458: };
```

**`renderHubList()` head — `src/renderer/toolbar.ts:563-603`**
```ts
563: function renderHubList() {
564:   if (!hubItemsList) return;
565:   hubItemsList.innerHTML = '';
566:   const search = (hubSearchInput?.value || '').toLowerCase().trim();
567: 
568:   if (hubActiveTab === 'workflows') {
...
601:   } else if (HUB_CORE_TABS.includes(hubActiveTab)) {
602:     renderCoreHubList(search);
603:     return;
```

**`setHubTab` — `src/renderer/toolbar.ts:941-956`**
```ts
941: function setHubTab(tab: HubTab) {
942:   hubActiveTab = tab;
943:   for (const t of Object.keys(HUB_NAV_BUTTONS) as HubTab[]) {
944:     const btn = HUB_NAV_BUTTONS[t];
945:     if (btn) btn.classList.toggle('active', t === tab);
946:   }
947:   hubCoreSelected = null;
948:   renderHubList();
949:   if (tab === 'workflows') {
950:     if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
951:   } else if (tab === 'mcp') {
952:     if (hubMcpTools.length > 0) selectMcpTool(hubMcpTools[0]);
953:   } else {
954:     renderCoreListSelection();
955:   }
956: }
```

**Nav click wiring — `src/renderer/toolbar.ts:2813-2824`**
```ts
2813:   tabNavWorkflows?.addEventListener('click', () => setHubTab('workflows'));
2814:   tabNavMcp?.addEventListener('click', () => setHubTab('mcp'));
2815:   tabNavCoreHealth?.addEventListener('click', () => setHubTab('core-health'));
2816:   tabNavBridge?.addEventListener('click', () => setHubTab('bridge'));
2817:   tabNavTaskRuns?.addEventListener('click', () => setHubTab('task-runs'));
2818:   tabNavRootCauses?.addEventListener('click', () => setHubTab('root-causes'));
2819:   tabNavRegressions?.addEventListener('click', () => setHubTab('regressions'));
2820:   btnCoreRefresh?.addEventListener('click', async () => {
2821:     await refreshCoreHealthState();
2822:     renderHubList();
2823:     if (hubCoreSelected) await renderCoreDetail(hubCoreSelected.id);
2824:   });
```

**IPC handler precedent — `src/main/browser/native-tab-host.ts:2224-2247`**
```ts
2224:    // Core Health surface (Phase 6): aggregated snapshot + drill-downs, all
2225:    // read through the existing antifan-core CLI surface. Read-only.
2226:    ipcMain.handle('antifan:core-health:get-state', async () => {
2227:      try {
2228:        return await getCoreHealthService().getState();
...
2242:    ipcMain.handle('antifan:core-health:get-task-run-trace', (_event, id: unknown) => {
2243:      if (typeof id !== 'string' || !id) {
2244:        return { status: 'UNKNOWN', reasonCode: 'TASK_RUN_NOT_FOUND', affected: [], evidenceRefs: [] };
2245:      }
2246:      return getCoreHealthService().getTaskRunTrace(id);
2247:    });
```

**Preload precedent — `src/preload/toolbar-preload.ts:129-131, 206-212`**
```ts
129:  getWorkflowArtifact: (artifactId: string) => ipcRenderer.invoke('antifan:workflow:get-artifact', artifactId),
130:  getCoreHealthState: () => ipcRenderer.invoke('antifan:core-health:get-state'),
131:  getCoreTaskRunTrace: (id: string) => ipcRenderer.invoke('antifan:core-health:get-task-run-trace', id),
...
206: try {
207:   contextBridge.exposeInMainWorld('antifanToolbar', toolbarApi);
208: } catch (err) {
209:   console.error('[antifan preload] Failed to expose antifanToolbar:', err);
210: }
```

**Service memo precedent — `src/main/diagnostics/core-health.ts:273-274, 286-298, 370-372, 791-795`**
```ts
273:  private readonly cliCache = new Map<string, { value: unknown; expiresAt: number }>();
274:  private readonly cliInFlight = new Map<string, Promise<unknown>>();
...
289:  private async cli<T = unknown>(command: string, arg?: string): Promise<T> {
290:    const key = `${command}:${arg ?? ''}`;
291:    const cached = this.cliCache.get(key);
292:    if (cached && cached.expiresAt > Date.now()) {
...
370:  public clearCache(): void {
371:    this.cliCache.clear();
372:  }
...
791: let singleton: CoreHealthService | null = null;
792: export function getCoreHealthService(): CoreHealthService {
793:   if (!singleton) singleton = new CoreHealthService();
794:   return singleton;
795: }
```

**Trust predicate — `src/main/browser/local-session-vault.ts:65-89`**
```ts
65: export function isTrustedSessionVaultSender(event: unknown): boolean {
66:   const ipcEvent = (event ?? null) as {
67:     senderFrame?: { url?: string } | null;
68:     sender?: { mainFrame?: unknown } | null;
69:   } | null;
70:   if (!ipcEvent) return false;
71:   const frame = ipcEvent.senderFrame;
72:   if (!frame || typeof frame.url !== 'string') return false;
73:   const mainFrame = ipcEvent.sender?.mainFrame;
74:   if (mainFrame === undefined || frame !== mainFrame) return false;
75: 
76:   try {
77:     const parsed = new URL(frame.url);
78:     if (parsed.protocol === 'file:') {
79:       const pathname = parsed.pathname.toLowerCase();
80:       return pathname.endsWith('toolbar.html') || pathname.endsWith('sidebar.html') || pathname.includes('/renderer/');
81:     }
82:     if (parsed.protocol === 'antifan:') {
83:       return true;
84:     }
85:     return false;
86:   } catch {
87:     return false;
88:   }
89: }
```

**jsdom harness to copy — `test/renderer/core-health-hub.test.ts:137-148`**
```ts
137: async function loadToolbar(state: unknown) {
138:   const { JSDOM, error } = loadJsdom();
139:   if (!JSDOM) throw new Error(`jsdom unavailable: ${error}`);
140:   const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
141:   const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
142:   const win = dom.window;
143:   (win as { antifanToolbar?: unknown }).antifanToolbar = makeApi(state);
144:   win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'exports-shim.js'), 'utf8'));
145:   win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.js'), 'utf8'));
146:   await flush();
147:   return { dom, win, doc: win.document };
148: }
```

**Compiled-module sharing precedent for the CLI — `scripts/certify-core-freeze.cjs:9,59-61`**
```js
9: const rootDir = path.resolve(__dirname, '..');
...
59:   const { DEFAULT_MAX_ARTIFACT_BYTES } = require(path.join(rootDir, '.compiled', 'src', 'main', 'tools', 'artifact-store.js'));
60:   const { DEFAULT_MAX_INVOCATION_FRAME_BYTES } = require(path.join(rootDir, '.compiled', 'src', 'main', 'session', 'invocation-ledger.js'));
61:   const { DEFAULT_MAX_RECEIPT_BYTES } = require(path.join(rootDir, '.compiled', 'src', 'main', 'session', 'receipt-store.js'));
```

**Script-side data-root resolution precedent — `scripts/lib/build-report.mjs:785-807`**
```js
785: function artifactRoots(explicit) {
786:   const roots = [];
792:   push(explicit);
793:   push(process.env.ANTIFAN_ARTIFACT_ROOT);
794:   push(path.join(REPO_ROOT, '.antifan-data', 'control-plane-v2', 'artifacts'));
795:   push(path.join(REPO_ROOT, '..', '.antifan-data', 'control-plane-v2', 'artifacts'));
796:   push(path.join(REPO_ROOT, '..', '.antifan-canary', 'control-plane-v2', 'artifacts'));
```

**Ledger facts the suite must avoid — `src/main/session/invocation-ledger.ts:126, 142, 732-753`**
```ts
126:    const files = fs.readdirSync(this.partitionsDir).filter((f) => f.endsWith('.jsonl'));
...
142:    const files = fs.readdirSync(this.partitionsDir).filter((f) => f.endsWith('.jsonl'));
...
732:  public getStats(): InvocationLedgerStats {
736:    for (const [attachmentId, partition] of this.hotPartitions.entries()) {
...
750:      quarantinedPartitionCount: this.quarantinedPartitions.size,
```
