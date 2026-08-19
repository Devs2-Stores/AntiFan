# Scout Report

## Existing Authority

| Surface | Existing owner | Current Project chat connection |
| --- | --- | --- |
| Workspace read/search/write | `WorkspaceCapabilityAdapter` | Context snapshot only |
| Workspace mutation safety | `CapabilityBroker` + leases + mutation journal | Not instantiated by `ProjectRuntime` |
| Terminal command policy | `TerminalCapabilityAdapter` | Not connected to model runs |
| Chromium binding/control | `BrowserCapabilityAdapter` + Project browser services | Binding captured, no model dispatch |
| Tool catalogue | `AGENT_TOOLS` | Display/reference only |
| MCP broker adapter | `agent-mcp-server.ts` | Separate MCP mode only |
| Provider tool output | Antigravity `functionCall` parts | Previously discarded |
| Run trajectory | durable `tool_called` / `tool_result` event kinds exist | No producer in Project RunService |

## Root Gap

Project chat streams one provider completion and terminates. It has no Project-owned broker, no tool dispatcher, and no continuation request carrying real tool results. The declared catalogue therefore overstates runtime capability.

## V1 Tool Map

| Tool | Owner | Class | Safety |
| --- | --- | --- | --- |
| `workspace_get_structure` | Workspace adapter | read | bounded |
| `workspace_list_directory` | Workspace adapter | read | bounded |
| `workspace_read_file` | Workspace adapter | read | containment + byte budget |
| `workspace_search_code` | Workspace adapter | read | bounded results |
| `workspace_hash_edit` | Workspace adapter through broker | workspace mutation | lease + receipt + hash anchor |
| `workspace_write_file` | Workspace adapter through broker | workspace mutation | lease + receipt + atomic write |
| `terminal_run_command` | Terminal adapter through broker | terminal | command policy + cwd containment + timeout |
| `browser_list_tabs` | Browser adapter | browse | Project scoped |
| `browser_get_dom` | Project automation | browse | exact tab binding |
| `browser_navigate` | Browser adapter through broker | browser mutation | exact generation + tab lease |
| `playwright_click` / `playwright_fill` | Project automation | browser mutation | exact binding + post-check |
| `browser_screenshot` | Project capture service | browse/artifact | bounded artifact |

## Integration Boundary

1. `ProjectRuntime` owns one broker and registers adapters against its Workspace, Browser, and Terminal owners.
2. `ProjectRunService` advertises only registered tools.
3. Provider output normalizes to text or structured tool call.
4. RunService commits `tool_called`, dispatches broker, commits `tool_result`, appends a bounded continuation message, then requests the model again.
5. Loop terminates on visible assistant text, error, cancellation, user approval, or iteration budget.

## Risks

- Existing provider interfaces expose text only and need a backward-compatible structured event extension.
- Browser generations can change after navigation; the run binding must advance from capability results.
- Workspace writes require a complete binding and stable owner revision.
- Terminal commands requiring approval must pause for user action, never auto-run.

## Unresolved Questions

- Exact Antigravity function response envelope must be verified against a live provider trace before enabling native continuation.
- Chromium DOM/click/fill registrations need consolidation with existing Project automation rather than catalogue aliases.
