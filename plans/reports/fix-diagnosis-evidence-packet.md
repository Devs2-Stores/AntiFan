# Confirmed Diagnosis: Root Terminal Auto-Affinity Removal

## 1. Grounded Diagnosis Summary
- **Exact Symptom**: Newly created terminal sessions (root sessions created via `+` button or `Ctrl+\``) automatically bind to `this.activeTabId` (e.g. `Chuột Razer Vi`), displaying `🎯 Chuột Razer Vi` badge instead of remaining unbound (`🎯 Chưa gán`).
- **Reproduction / Verification Evidence**:
  - `native-tab-host.ts:1194-1207`: `session-created` event sets `let targetTab = this.activeTabId;` even when `parentId` is undefined, then immediately binds `this.bindTerminalAgentAffinity(id, generation || 1, targetTab)`.
  - `native-tab-host.ts:1234-1244`: `TERMINAL_CHANNELS.START` handler eagerly binds `this.bindTerminalAgentAffinity(activeSessionId, session?.sessionGeneration, this.activeTabId)`.
  - `native-tab-host.ts:1279-1286`: `'antifan:terminal:new-session'` handler eagerly binds `this.bindTerminalAgentAffinity(sessionId, session?.sessionGeneration, this.activeTabId)`.
- **Scoped-List Check (Issue 2)**:
  - Regression test in `test/integration/mcp-multi-tab-e2e.test.ts` (Step 3.5) was run and PASSED: `anti.browser.tabs.list` successfully returns all tabs in the session pool (`['tab-a', tabBId, tabCId]`) after tab creation and authority rebind.
  - No code defect exists on the verified internal MCP path. All speculative pool/BrowserControlPort changes are removed.

## 2. Invariants & Scope
- **Preserves**:
  - Split-terminal affinity inheritance: `if (parentId)` in `session-created` MUST be preserved so split terminals inherit `parentAffinity.tabId`.
  - Explicit tab binding: `antifan:terminal:rebind-affinity`, CLI `--tab=<tabId>`, and bridge-server explicit binding remain fully functional.
  - Scoped-list regression test in `mcp-multi-tab-e2e.test.ts` is retained.
- **Breaks**:
  - Implicit coupling where newly created human terminal sessions auto-bind to the user's active browser tab.
- **Files to Modify**:
  - `src/main/browser/native-tab-host.ts` (lines 1194-1207, 1234-1244, 1279-1286)
