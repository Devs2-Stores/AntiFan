# Phase 2: Unify CapabilityCatalogue browser toolset

## Context
`CapabilityCatalogue` currently only registers 6 basic capabilities. Many browser operations in MCP and Bridge are handled via ad-hoc `switch (name)` statements with direct calls to `tabHost`.

## Requirements
1. In `src/main/tools/browser-control-port.ts` and `src/main/tools/browser-capabilities.ts`:
   - Register complete suite of browser operations:
     - `browser.open-tab` (risk: 'write')
     - `browser.close-tab` (risk: 'write')
     - `browser.switch-tab` (risk: 'write')
     - `browser.diagnostics` (risk: 'read')
     - `browser.responsive-check` (risk: 'read')
     - `browser.agent-click` (risk: 'write')
     - `browser.agent-type` (risk: 'write')
     - `browser.agent-scroll` (risk: 'write')
     - `browser.agent-hover` (risk: 'write')
     - `browser.agent-move` (risk: 'write')
     - `browser.agent-snapshot` (risk: 'read')
     - `browser.agent-clear` (risk: 'write')
     - `browser.agent-highlight` (risk: 'write')
   - Support aliases for compatibility (`antifan_open_tab`, `antifan.openTab`, etc.).
2. Update `mcp-server.ts` and `bridge-server.ts`:
   - Standardize dispatch to `capabilityTransport.dispatch()` or fallback seamlessly.
   - Maintain full compatibility with existing IDE extensions and agents.

## Verification
- `npm run typecheck` passes.
- `npm test` passes (specifically `capability-catalogue.test.ts`, `bridge-server.test.ts`, `mcp-result-envelope.test.ts`, `theme-qa-vertical-slice.test.ts`).
