# Problem-Solving Evidence Packet: AntiFan Terminal Affinity & Scoped Tab Synchronization

## 1. Problem Statement
Users report two linked anomalies in AntiFan Browser Desktop:
1. **Unwanted Auto-Affinity**: Every newly created terminal session (e.g. clicking `+` or pressing `Ctrl+\``) automatically binds to whatever browser tab is currently active (e.g. `Chuột Razer Vi`), displaying `🎯 Chuột Razer Vi` instead of remaining unbound (`🎯 Chưa gán`).
2. **Missing Scoped Tabs**: When an AI Agent opens a new tab via MCP (`anti.browser.tabs.create` / `browser.open-tab`), the tab does not show up as expected in the scoped tab list or affinity management.

## 2. Codebase Evidence & Confirmed Ground Truth
1. **Design Invariant History**:
   - `plans/260903-1500-terminal-tab-affinity-and-concurrency-isolation/plan.md` explicitly required "Atomic Main Creation Binding" for `new-session` (lines 17, 34) to avoid headless agent MCP failure.
   - However, this applied universally to human-interactive sessions without discrimination.
2. **Three Root Creation Binds in `src/main/browser/native-tab-host.ts`**:
   - Lines 1194-1206: `TerminalManager.getInstance().on('session-created')`:
     `let targetTab = this.activeTabId;`
     If `parentId` exists, it looks up `parentAffinity.tabId`.
     If `targetTab && this.hasTab(targetTab)`, it binds `this.bindTerminalAgentAffinity(id, generation || 1, targetTab)`.
   - Lines 1234-1243: `ipcMain.handle(TERMINAL_CHANNELS.START)`:
     `this.bindTerminalAgentAffinity(activeSessionId, session?.sessionGeneration, this.activeTabId);`
   - Lines 1279-1284: `ipcMain.handle('antifan:terminal:new-session')`:
     `if (this.activeTabId) this.bindTerminalAgentAffinity(sessionId, session?.sessionGeneration, this.activeTabId);`
3. **Bridge Server Secondary Binding in `src/main/bridge/bridge-server.ts`**:
   - Lines 959-965: When an agent connects without an existing affinity, `bridge-server` falls back to `candidateTab = this.tabHost.getActiveTabId()` and binds it.
4. **Scoped Tab List Mechanism in `src/main/tools/browser-control-port.ts`**:
   - Lines 559-570: `listTabs(context: { target?: BrowserTarget })`:
     Filters tabs by `getManagedTabIds(boundTabId)`.
   - Lines 480-491 of `src/main/tools/capability-transport.ts`:
     When a new tab is created, transport updates the attachment to `newTabId`.
   - If `newTabId`'s managed set doesn't properly include the parent tab and siblings, or if adoption isn't bidirectionally recorded in the session pool, the agent sees a shifted scope.
5. **Adoption Mechanics**:
   - `adoptChildTabForSession` sets `childTab.state.terminalSessionId` and calls `this.broadcastState()`.
   - But if `entry` in `terminalAgentAffinity` is not found, lineage and `managedTabIds` on the affinity entry are not updated.

## 3. Constraints & Invariants
- Windows-only, local workstation, single-developer environment.
- MUST preserve split-terminal affinity inheritance (`parentId` inherits `parentAffinity`).
- MUST preserve explicit tab binding when specified (`antifan --tab=<tabId>` or `api.rebindTerminalAffinity`).
- Human-initiated root sessions (`antifan:terminal:new-session` without explicit tab or parent) MUST remain unbound (`🎯 Chưa gán`).
- Agent MCP tool `anti.browser.tabs.list` MUST see all tabs belonging to the session pool.
