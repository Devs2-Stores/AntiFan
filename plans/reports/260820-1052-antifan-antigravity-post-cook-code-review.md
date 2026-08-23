# AntiFan Antigravity Post-Cook Code Review

**Date:** 2026-08-20  
**Desktop revision:** `67ed96f` (base `40d4a0f`)  
**Plan:** `260820-0854-harden-antifan-antigravity-routing-and-local-trust-boundaries`  
**Verdict:** **NO-GO for Exact Auto / exact routing release**

## Findings

### Critical

1. **Extension/Sidecar has no authoritative revision or current install artifact.**
   `E:/Work/apps/antigravity-browser` has no dedicated `.git`, is ignored by
   `E:/Work/.gitignore:116`, and contributes zero tracked files to the parent
   repository. The two existing VSIX files predate this Cook and contain no
   Sidecar runtime. The live Antigravity config has no `antifan-chat-router`
   entry, manifest, or heartbeat. This fails the reproducible release baseline
   in `phase-01-start.md:96` and invalidates every completion claim depending on
   a clean install/restart cycle.

2. **Desktop accepts an unrelated receipt as authoritative delivery proof.**
   `validateResultV2()` checks only basic shape
   (`src/main/bridge/antigravity-command-client.ts:92`), while foreground and
   late polling accept the file without binding its embedded command, workspace,
   route, host epoch, prompt digest, attachment digest, or auth tag to the
   original request (`src/main/bridge/antigravity-command-client.ts:295`,
   `src/main/bridge/antigravity-command-client.ts:391`). A direct probe placed a
   receipt under `cmd-requested.res.json` whose embedded ID was
   `different-command` and workspace was `C:/wrong`; Desktop returned
   `ide-api-accepted` and deleted the receipt.

3. **Extension accepts unsigned, wrong-conversation, wrong-instance Sidecar receipts.**
   Receipt authentication is optional (`if (res.authTag)`) and no immutable
   request fields are compared before promotion
   (`E:/Work/apps/antigravity-browser/src/sidecarRouterClient.ts:183`). A direct
   probe supplied an unsigned receipt with a different request ID, source
   command, conversation, and Sidecar instance; the client returned
   `ide-api-accepted`. The existing test explicitly generates an unsigned
   receipt (`test/sidecar-router-client.test.cjs:64`), so the green suite locks
   in the unsafe behavior.

4. **The live AgentAPI path is not executable by the implemented launcher.**
   The fresh probe reports `agentApiExecutable: null`. The installed binary is
   `C:/Users/Admin/.gemini/antigravity-ide/bin/agentapi.bat`, but discovery only
   scans `PATH` (`sidecars/antifan-chat-router/lib/agentapi.mjs:63`) and direct
   `.bat` execution uses `spawn(..., { shell:false })`
   (`sidecars/antifan-chat-router/router.mjs:344`). Reproduction on the current
   Node runtime throws `EINVAL`. Therefore the compatibility report's GO claim
   is not supported by a live exact send.

5. **Exact abort still targets the active/global conversation and reports success early.**
   Desktop puts the selected session only in `meta`, omits top-level
   `targetConversationId`, does not await the receipt, and immediately returns
   `{ ok: true }` (`src/main/browser/native-tab-host.ts:407`). Extension rejects
   exact abort only when that top-level field exists
   (`E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts:279`);
   otherwise it calls global `antigravity.abort`
   (`E:/Work/apps/antigravity-browser/src/runtime.ts:183`). Stopping B while A
   is active can still stop A.

### High

6. **Late reconciliation is neither authoritative nor durable across restart.**
   Desktop increased its default wait to 30 seconds, but contracts still grant
   fresh relative lifetimes at each layer rather than propagating the plan's
   absolute 18/22/30-second deadlines
   (`src/main/bridge/antigravity-command-client.ts:246`,
   `E:/Work/apps/antigravity-browser/src/sidecarRouterClient.ts:125`,
   `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/router.mjs:69`).
   Extension can return `unknown` before Sidecar finishes, with no path that
   forwards a later Sidecar receipt back to Desktop. Desktop's pending ledger
   is memory-only (`src/main/browser/native-tab-host.ts:58`), starts no startup
   scan, and consumes/deletes receipts instead of acknowledging retained proof
   (`src/main/bridge/antigravity-command-client.ts:403`). The promised
   cross-restart `unknown -> ide-api-accepted` transition is therefore absent.

7. **Workspace command transport remains unauthenticated.**
   Removing legacy v1 execution does not authenticate v2. Any schema-valid file
   in `.antigravity/mcp-bridge` for the opened workspace is accepted and can
   invoke active-panel send/abort (`E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts:204`,
   `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts:293`). A direct
   probe pre-seeded a v2 Draft command and observed one active-panel invocation
   plus an `ide-api-accepted` result. This matters for a personal tool because
   the extension activates for any workspace containing `package.json`
   (`E:/Work/apps/antigravity-browser/package.json:13`).

8. **Crash and idempotency transitions are not durable.**
   Sidecar claim is write-plus-unlink rather than atomic rename
   (`sidecars/antifan-chat-router/router.mjs:268`), failure to persist
   `isInvoking:true` is ignored (`sidecars/antifan-chat-router/router.mjs:277`),
   and completed duplicates are deleted without re-emitting retained proof
   (`sidecars/antifan-chat-router/router.mjs:243`). Extension deletes stale
   `.processing.*` files without producing a bound result
   (`E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts:86`). These
   gaps can still produce false safe-to-retry states or lost successful
   receipts around crashes.

9. **Immutable target and attachment ownership remain incomplete.**
   Desktop still falls back to URL heuristics, `E:/Work`, and `process.cwd()` for
   mutating work (`src/main/browser/native-tab-host.ts:1758`), stages snapshots
   into global/CWD fallbacks (`src/main/browser/native-tab-host.ts:1830`), and
   silently keeps partial attachment sets after individual save failures.
   Descriptors have no copied-byte SHA-256 and Extension/Sidecar only test path
   existence or append file URIs (`E:/Work/apps/antigravity-browser/src/runtime.ts:167`,
   `sidecars/antifan-chat-router/lib/agentapi.mjs:35`). Queue records retain only
   an optional session ID (`src/renderer/sidebar.ts:122`); Auto items can be
   dispatched against the currently active session after restart.

10. **Transcript refresh can still erase delivery overlays.**
    Main replaces `chatMessages` from transcript events
    (`src/main/browser/native-tab-host.ts:134`), and renderer replaces its entire
    message collection on session changes (`src/renderer/sidebar.ts:2086`). The
    delivery ledger is not persisted separately, so accepted/unknown metadata
    can disappear after refresh or restart.

11. **Phase 6 runtime regressions remain open.**
    MCP mode logs ordinary text to stdout before stdio transport
    (`src/main/index.ts:119`, `src/main/index.ts:123`); clear-site still calls
    `clearStorageData` without an origin (`src/main/browser/native-tab-host.ts:949`);
    cookie restore still converts session/expired cookies into one-year cookies
    (`src/main/browser/cookie-persister.ts:41`); and `NativeTabHost.dispose()`
    does not stop the terminal process tree or its reconciler timer
    (`src/main/browser/native-tab-host.ts:2351`).

12. **Plan completion metadata contradicts its own task state and evidence.**
    `plan.md:4` and all phase tables claim completion, while every phase Todo
    and Success Criteria checklist remains unchecked. Fresh `ak plan status`
    reports `0/6 phases`, `0/98 tasks`. The live compatibility report also
    claims `VERIFIED & AUDITED` and GO despite no installed heartbeat and a
    failing AgentAPI launcher. This violates the plan's own evidence-based
    status criterion.

## Verified Improvements

- Tokenless/wrong-token and browser-Origin WebSocket connections are rejected.
- Terminal output now uses text nodes and allowlisted ANSI spans.
- Markdown Copy no longer embeds assistant code in inline JavaScript.
- Session rename/delete now require discovered direct-child membership and
  realpath containment.
- Router CLI entrypoint starts and emits a heartbeat in an isolated data root.
- Fresh VSIX inventory includes the Sidecar router and its runtime library.
- Exact Auto fails closed when the Extension sees an offline Sidecar and a
  top-level exact target.

## Fresh Verification

- Desktop `npm run verify`: **31 passed, 0 failed**.
- Desktop `npm audit --audit-level=high`: **0 vulnerabilities**.
- Extension `npm run verify`: **106 passed, 0 failed**, audit clean.
- Extension `npx tsc -p . --noEmit`: **passed**.
- Extension `npx @vscode/vsce ls`: **passed**, current inventory includes
  `sidecars/antifan-chat-router/**`; scripts remain excluded.
- Extension `npm run package:verify`: **39 passed, 0 failed**, but it does not
  package/import a fresh VSIX or validate the installer/probe closure.
- Isolated router entrypoint: stayed alive and emitted `host.json`.
- Live profile: no Sidecar entry, manifest, or heartbeat.

## Recommendation

Keep Exact Auto disabled. Treat this Cook as a partial Phase 2 security repair,
not completion of the six-phase routing plan. The next fix cycle should start
with source-control/install provenance, authenticated and fully bound receipts,
the real Windows AgentAPI launcher, and fail-closed exact abort; only then move
to durable deadlines/reconciliation and immutable Desktop ownership.
