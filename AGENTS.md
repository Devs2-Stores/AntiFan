# AntiFan repo rules (delta only)

Root contract: `E:/Work/AGENTS.md` §1 (canonical Level 0 text in `C:\Users\Admin\.claude\CLAUDE.md`), §1.E approval gates, §1.F untrusted content, §16-§17 apply unchanged. Theme-CLI policy (including the user-approved `hrv theme fetch` / `hrv theme push --nodelete` exception for the bound theme id, for every agent) is `E:/Work/AGENTS.md` §1.C + §8, enforced by `src/omp-hooks/theme-push-policy.ts` and the corpus in `test/fixtures/theme-policy/`; a rule that disagrees with that code is wrong, fix the rule. This file does not restate any push denylist.

## Storefront password gate
When a storefront tab redirects to `/password`, fill the workspace default password `haravan` (input + form submit through `anti.browser.evaluate`) before asking the user; report back only if it is wrong.

## Tool Fallback Policy (AntiFan MCP → Playwright)
- Browser evidence goes through AntiFan MCP (`anti.*`, `theme.*`, `browser.*`). Playwright MCP is allowed only after a terminal AntiFan error (`MCP_BRIDGE_OFFLINE`, `PAIRING_UNAVAILABLE`, `BRIDGE_UNREACHABLE`, `CAPABILITY_NOT_FOUND`, `TERMINAL_TAB_CLOSED`, `TARGET_STALE`, `TARGET_REQUIRED`) or when the desktop app is confirmed not running. Never first choice, never a silent substitute.
- Record the reason with `anti.telemetry.record_fallback` {primaryTool, fallbackTool, fallbackResult, errorCode, notes}; if the bridge is offline, state the reason verbatim in the reply.
- Playwright output is Tier-2 evidence: label claims `[PLAYWRIGHT-FALLBACK]`, never "AntiFan-verified". Never alias `browser_*` Playwright tools to AntiFan tools. Guarded repair loops that forbid Playwright (`REFUSED_TOOL_SURFACE`) stay stricter and win inside their scope.
