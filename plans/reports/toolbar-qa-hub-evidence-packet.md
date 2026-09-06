# Immutable Evidence Packet: Toolbar Controls Diagnostic (#btnThemeQa & #btnWorkflowHub)

**Target Issue:** User report with screenshot (646x213): "Hai chức năng này hiện tại có vẻ ko có tác dụng lắm" (These two functions currently seem to not have much effect / don't seem very useful).
**Affected Controls in Screenshot:**
1. Box 1 (Red crop x=269..345, y=44..103): `#btnThemeQa` (`[ 🛡️ QA ]`), toolbar button for Theme QA Validation.
2. Box 2 (Red crop x=396..452, y=37..107): `#btnWorkflowHub` (`[ ⚡ ]`), toolbar button with tooltip `Workflow & MCP Hub (Ctrl+Shift+W)`.
**Target Repository:** `Devs2-Stores/AntiFan` (commit snapshot: `8310aec` on `main`)
**Date:** 2026-09-06

---

## 1. Concrete Visual & Component Identification (Source & Screenshot Ground Truth)
- **Control 1 (`#btnThemeQa`):**
  - Location: `src/renderer/toolbar.html:184-187`
  - Button ID: `#btnThemeQa`
  - Text badge ID: `#themeQaText` (initial text `"QA"`)
  - Title attribute: `"Run Theme QA Validation (Zero-Liquid & Responsive Overflow)"`
  - Associated Modal: `#themeQaOverlay` (`src/renderer/toolbar.html:417-428`), summary body `#themeQaSummary`, re-run button `#btnThemeQaRerun`, close button `#themeQaClose`.
- **Control 2 (`#btnWorkflowHub`):**
  - Location: `src/renderer/toolbar.html:202-205`
  - Button ID: `#btnWorkflowHub`
  - Title attribute: `"Workflow & MCP Hub (Ctrl+Shift+W)"`
  - Associated Modal: `#workflowHubOverlay` (`src/renderer/toolbar.html:430-530`), tabs `#tabNavWorkflows` and `#tabNavMcp`, workflow detail `#hubWfDetail`, MCP tool detail `#hubMcpDetail`, run button `#btnRunWorkflow`, new workflow button `#btnHubNewWorkflow`.

---

## 2. Renderer Event & State Lifecycle (Direct Source Inspection of `src/renderer/toolbar.ts`)

### A. Theme QA Click Handler (`src/renderer/toolbar.ts:1138-1154`)
```ts
if (btnThemeQa) {
  btnThemeQa.addEventListener('click', async () => {
    const report = lastThemeQaReport || themeQaState.report;
    if (report && (themeQaState.status === 'pass' || themeQaState.status === 'fail' || themeQaState.status === 'error')) {
      openThemeQaSummary();
      return;
    }
    showToolbarToast('Theme QA: Validating Storefront…');
    const result = await getApi()?.runThemeQa();
    if (result?.report) {
      lastThemeQaReport = result.report;
      renderThemeQa({ ...themeQaState, report: result.report }, result.report);
      openThemeQaSummary();
    } else if (result && !result.ok) {
      showToolbarToast(`Theme QA: ${result.error || 'validation failed'}`);
    }
  });
}
```
**Key Observations on `#btnThemeQa`:**
1. **No direct local pending state:** The click handler does *not* set `themeQaText.textContent = 'Checking…'` or disable the button locally.
2. **Pending state depends entirely on asynchronous host push:**
   - In `toolbar.ts:134-136`, `themeQaText.textContent = 'Checking…'` and `btnThemeQa.disabled = true` only execute inside `renderThemeQa(state)` when `state.status === 'running'`.
   - `renderThemeQa` is invoked via `api.onStateUpdated` (`toolbar.ts:2110`) or `api.onThemeQaState` (`toolbar.ts:2128`). If the host does not broadcast or if there is latency, the button remains active with `"QA"` label until the round-trip completes.
3. **Second-click bypass semantics:**
   - If `result.report` arrives and `renderThemeQa({ ...themeQaState, report: result.report }, result.report)` is called, note that if `themeQaState.status` was not set to `'pass'`, `'fail'`, or `'error'` by a host broadcast, `(themeQaState.status === 'pass' || ...)` may evaluate to false, causing subsequent clicks to re-invoke `runThemeQa()` rather than opening the summary.
   - Once `themeQaState.status` is `'pass' | 'fail' | 'error'`, subsequent clicks unconditionally call `openThemeQaSummary()` and return early without running a new validation. The only way to re-validate is the tiny `#btnThemeQaRerun` button inside the overlay modal.
4. **Summary Display (`toolbar.ts:154-187`):**
   - Populates `#themeQaSummary` with raw plaintext lines (platform, critical/total count, liquid errors, overflow culprits, broken assets, HS violations). No interactive visual overlay, no DOM highlighting on the live page.

### B. Workflow & MCP Hub Click Handler (`src/renderer/toolbar.ts:335-434, 2155`)
```ts
async function openWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'flex';
  getApi()?.setOverlay(true);

  try {
    const res = await getApi()?.getWorkflowState();
    if (res) {
      hubWorkflows = res.workflows || [];
      hubMcpTools = res.tools || [];
      if (badgeWorkflowCount) badgeWorkflowCount.textContent = String(hubWorkflows.length);
      if (badgeMcpCount) badgeMcpCount.textContent = String(hubMcpTools.length);
    }
  } catch (err) {
    console.error('[workflow hub] Failed to fetch state:', err);
  }
  renderHubList();
  ...
}
```
**Key Observations on `#btnWorkflowHub`:**
1. **Modal Opening:** Opens `#workflowHubOverlay` as a flex container and calls IPC `antifan:workflow:get-state`.
2. **MCP Tool Selection (`toolbar.ts:491-516`):**
   - Shows category, name, description, and permissions.
   - `mcpSchemaCode.textContent = JSON.stringify(tool.inputSchema || {}, null, 2)`: If the tool object lacks `inputSchema`, renders empty `{}`.
   - **Zero execution capability:** The MCP detail pane (`toolbar.html:529-550`) contains no execute/run button. Tools cannot be tested or run from this interface.
3. **Custom Workflow Creation (`toolbar.ts:2203-2242`):**
   - Uses browser `prompt('Nhập tên Workflow mới:')` and `prompt('Nhập mô tả kịch bản (tùy chọn):')`.
   - Creates a hardcoded 2-step definition: `browser.navigate` to `https://example.com` (timeout 8000ms) and `browser.screenshot` (format png). Does not provide a step builder, action picker, or parameter editor.

---

## 3. Production Backend Handlers (Direct Source Inspection of Main Process)

### A. Theme QA Engine (`src/main/browser/native-tab-host.ts:5341-5404` & `src/main/qa/theme-qa-workflow.ts`)
1. **Host Orchestration (`native-tab-host.ts:5341-5365`):**
   - Requires active `controlPlane` and an active tab target.
   - Updates `this.tabThemeQaStates?.set(tabId, { status: 'running', ... })` and calls `this.broadcastState()`.
   - Enqueues validation in `this.asyncQaQueue.enqueue(tabId, gen, async (signal) => ...)`.
2. **Involuntary Page Reload (`src/main/qa/theme-qa-workflow.ts:184-192`):**
   ```ts
   // Stage 2: Reload to reach load-complete document
   const reload = await this.ports.reload(input.target);
   if (input.signal?.aborted) {
     throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
   }
   if (!reload || !reload.reloaded || !reload.target) {
     throw new CapabilityError('TARGET_STALE', 'Bound browser tab could not reach a load-complete document');
   }
   ```
   *Code Ground Truth:* Running Theme QA *always* triggers an involuntary browser reload on the active tab (`this.ports.reload` delegates to `browser.reload(target)`).
3. **Platform Scope Gating (`src/main/qa/theme-qa-workflow.ts:270-360`):**
   - Uses `PlatformDetector.detect(html)` to scan for Haravan, Sapo, or Shopify signatures.
   - If the active page is not an identifiable e-commerce storefront (e.g. Google, GitHub, local web app, or admin dashboard), platform resolves to `'unknown'`.
   - Liquid error scanning and HS marketplace rule evaluation are strictly scoped to known platforms; for `'unknown'`, they yield zero violations, resulting in an uninformative "PASSED (0 issues)" outcome.

### B. Workflow & MCP Hub Backend (`src/main/browser/native-tab-host.ts:1427-1444` & `workflow-registry.ts`)
1. **Hardcoded Static MCP Tools Array:**
   ```ts
   ipcMain.handle('antifan:workflow:get-state', () => {
     const workflows = this.controlPlane ? this.controlPlane.workflowRegistry.getAll() : [];
     const tools = [
       { id: 'antifan_open_tab', name: 'antifan_open_tab', description: 'Mở tab Chromium mới trong AntiFan Desktop', category: 'browser', permissions: ['execute'] },
       { id: 'antifan_navigate_tab', name: 'antifan_navigate_tab', description: 'Điều hướng tab hiện tại đến URL chỉ định', category: 'browser', permissions: ['execute'] },
       { id: 'antifan_screenshot_tab', name: 'antifan_screenshot_tab', description: 'Chụp ảnh màn hình Viewport hoặc toàn trang (.PNG)', category: 'media', permissions: ['read'] },
       { id: 'antifan_execute_javascript', name: 'antifan_execute_javascript', description: 'Thực thi mã JavaScript trong trang web đang mở', category: 'eval', permissions: ['eval'] },
       { id: 'antifan_click_element', name: 'antifan_click_element', description: 'Click vào phần tử theo CSS selector hoặc XPath', category: 'browser', permissions: ['execute'] },
       { id: 'antifan_input_text', name: 'antifan_input_text', description: 'Nhập văn bản vào input hoặc textarea trên trang', category: 'browser', permissions: ['execute'] },
       { id: 'antifan_inspect_element', name: 'antifan_inspect_element', description: 'Phân tích phần tử DOM tại tọa độ (x, y)', category: 'inspect', permissions: ['read'] },
       { id: 'antifan_find_elements', name: 'antifan_find_elements', description: 'Tìm danh sách phần tử khớp CSS selector', category: 'inspect', permissions: ['read'] },
       { id: 'antifan_set_device_preset', name: 'antifan_set_device_preset', description: 'Chuyển đổi chuẩn thiết bị mô phỏng di động', category: 'device', permissions: ['execute'] },
       { id: 'antifan_sync_chrome_profile', name: 'antifan_sync_chrome_profile', description: 'Đồng bộ Bookmarks, Cookies và History từ Chrome', category: 'auth', permissions: ['read', 'write'] },
       { id: 'antifan_write_terminal', name: 'antifan_write_terminal', description: 'Gửi lệnh thực thi vào phiên Terminal', category: 'terminal', permissions: ['execute'] },
       { id: 'antifan_switch_capsule', name: 'antifan_switch_capsule', description: 'Chuyển đổi dự án Workspace Capsule đang hoạt động', category: 'workspace', permissions: ['write'] },
     ];
     return { workflows, tools };
   });
   ```
   *Code Ground Truth:*
   - The returned tool array is a hardcoded list of 12 items.
   - It does *not* reflect the live MCP Server catalog (`src/main/mcp/mcp-server.ts:580-620`, which registers canonical tools like `anti.browser.*`, `anti.inspect.*`, `anti.theme.*`, `theme.assert_cart`, `storefront.resolve_product`).
   - None of the 12 items contain an `inputSchema` property.
2. **Workflows Catalog Overlap (`src/main/workflow/workflow-registry.ts:15-84`):**
   - The primary built-in workflow is `wf-storefront-qa` ("Haravan / Sapo Theme Storefront QA & Audit").
   - Steps: `browser.set_viewport`, `qa.check_overflow`, `qa.check_broken_images`, `qa.check_console_errors`, `browser.screenshot`, `report.generate`.
   - *Code Ground Truth:* `wf-storefront-qa` executes substantially the same verification suite as the `#btnThemeQa` button positioned next to it on the toolbar.

---

## 4. Hypotheses on User Perception ("có vẻ ko có tác dụng lắm")
- **[HYPOTHESIS 1 - Involuntary Disruption & Platform Scoping in Theme QA]:**
  The user experiences Theme QA as unhelpful because (a) it forces an unexpected page reload that wipes live interaction state, and (b) on any page other than a live Haravan/Sapo/Shopify storefront, it quietly passes with 0 issues in a plain text modal without actionable guidance.
- **[HYPOTHESIS 2 - Static Dead-End & Disconnection in Workflow Hub]:**
  The user experiences Workflow Hub as unhelpful because the MCP Tools tab is a read-only list of 12 hardcoded dummy tools that cannot be invoked, inspected with real schemas, or tested, while custom workflow creation is a crude prompt() pop-up.
- **[HYPOTHESIS 3 - Redundancy & Toolbar Clutter]:**
  The user experiences both buttons as redundant because `#btnThemeQa` and Workflow Hub's default `wf-storefront-qa` duplicate the exact same QA concept across two adjacent buttons occupying prominent toolbar space.

---

## 5. Rubric for Ultra Verifier Evaluation
1. **Evidence Grounding (25%):** Exact file:line citations matching verified source code logic.
2. **Root Cause Analysis (25%):** Accurate separation between technical execution defects (involuntary reload, dummy tools array, prompt() creator) and UX/workflow misalignment.
3. **Rival Hypothesis Elimination (25%):** Grounded elimination of broken click handlers, CSS overlays, or IPC channel failures.
4. **Actionable Recommendations (25%):** Realistic engineering options with clear trade-offs.
