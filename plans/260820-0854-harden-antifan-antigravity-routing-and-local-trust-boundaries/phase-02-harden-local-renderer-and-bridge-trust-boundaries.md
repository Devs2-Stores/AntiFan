---
phase: 2
title: "Harden Local Renderer and Bridge Trust Boundaries"
status: completed
priority: P0
effort: "1 day"
dependencies: [1]
---

# Phase 2: Harden Local Renderer and Bridge Trust Boundaries

## Context Links

- [Plan](./plan.md)
- Review findings C1-C3 in
  [deep review](../reports/260820-0851-antifan-antigravity-deep-code-review.md)

## Overview

Remove the shortest paths from remote/repository/assistant-controlled content
to privileged local actions: tokenless browser RPC, terminal HTML execution,
inline Markdown JavaScript, and session path traversal.

## Requirements

- WebSocket upgrade requires the exact current token; absent token is rejected.
- Browser-originated WebSocket connections are denied unless explicitly
  allowlisted. Non-browser local clients still require token authentication.
- RPC requests bind to an authenticated client/session and validate method,
  parameter size, and authorization before side effects.
- Renderer output never uses untrusted strings as HTML or inline script.
- Local views use a restrictive CSP and compatible sandboxed preload boundary.
- IPC handlers verify the expected sender WebContents for toolbar, sidebar, and
  terminal channels.
- Session rename/switch/delete accepts only discovered direct-child session IDs
  and proves realpath containment before filesystem mutation.

## Architecture

- Render terminal ANSI as text nodes plus allowlisted style spans. Never parse
  process output as HTML.
- Generate Markdown structure with DOM APIs or sanitized HTML, register Copy
  handlers with event listeners, and store raw copy text outside executable
  attributes.
- Treat the discovered session catalog as the authorization set. A string that
  merely matches an ID regex is not enough for delete.
- Deny WebSocket requests with an `Origin` header by default; current trusted
  Node/Extension clients should connect without browser Origin and with token.

## Related Code Files

- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/bridge/transcript-syncer.ts`
- Modify: `src/renderer/terminal.ts`
- Modify: `src/renderer/terminal.html`
- Modify: `src/renderer/sidebar.ts`
- Modify: `src/renderer/sidebar.html`
- Modify: `src/preload/terminal-preload.ts`
- Modify: `src/preload/sidebar-preload.ts`
- Modify: `test/main/bridge-server.test.ts`
- Create/Modify: renderer security, IPC sender, CSP, and session-containment
  tests under `test/main/`

## Implementation Steps

1. Reject missing/wrong WebSocket tokens before adding a client or sending init.
2. Add Origin policy, maximum frame/payload size, bounded JSON parsing, and
   method authorization. Keep `/status` free of secrets.
3. Update all bridge clients/tests to authenticate; add tokenless, wrong-token,
   browser-Origin, forged-RPC, and rotation cases.
4. Replace terminal `innerHTML` with an allowlisted ANSI tokenizer that appends
   text nodes and style spans only.
5. Remove inline renderer scripts and add CSP with no `unsafe-inline` and no
   remote script sources.
6. Replace code-block inline `onclick` with delegated event listeners and a
   map/dataset identifier to non-executable raw text.
7. Allowlist Markdown link protocols and route file/open-external actions
   through validated preload APIs.
8. Bind every IPC handler to its owning WebContents ID and reject calls from
   destroyed, navigated, or unexpected views.
9. Validate session ID against the live discovered catalog. Resolve the target,
   require it to be a direct child of `brainDir`, and re-check containment
   immediately before rename/delete.
10. Remove the PowerShell deletion fallback or invoke it only after the same
    exact containment proof; never construct a destructive script from an
    untrusted path.
11. Enable `sandbox:true` for local views if compatible; otherwise document and
    test the narrow preload exception instead of claiming universal sandboxing.

## Todo

- [ ] Require WebSocket token and deny untrusted Origin.
- [ ] Bound bridge frames and authorize RPC methods.
- [ ] Escape terminal output structurally.
- [ ] Remove inline renderer handlers/scripts and add CSP.
- [ ] Sanitize Markdown links and Copy behavior.
- [ ] Bind IPC handlers to expected senders.
- [ ] Validate session catalog membership and realpath containment.
- [ ] Add exploit regressions for terminal, Markdown, and deletion traversal.

## Validation

Run focused tests first, then Desktop verify:

```powershell
npm run typecheck
npm test -- --test-name-pattern "Bridge|Security|Transcript|Renderer"
npm run verify
```

Manual negative probes must show no side effect for:

```text
ws://127.0.0.1:<port> without token
<img src=x onerror=...> in terminal output
${window.antifanSidebar.deleteSession('..\\..\\..\\Desktop')} in a code block
deleteSession('..\\..\\..\\Desktop') through IPC
```

## Success Criteria

- [ ] Tokenless/wrong-Origin clients cannot receive init or invoke any RPC.
- [ ] Terminal attack text renders literally and cannot call preload APIs.
- [ ] Code-block Copy copies exact text without executing interpolation.
- [ ] Session mutation cannot resolve outside one discovered brain child.
- [ ] CSP and sender-binding tests cover every privileged local view.
- [ ] Desktop verify remains green.

## Risks and Rollback

The main risk is breaking local UI behavior while removing inline execution.
Keep DOM structure and styling stable, test Copy/links/ANSI explicitly, and
rollback only the narrow UI implementation. Never restore untrusted `innerHTML`,
inline handlers, optional authentication, or unchecked recursive deletion.
