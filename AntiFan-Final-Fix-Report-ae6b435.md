# AntiFan — Final Fix Report

**Audit target:** `ae6b4358bf59360703b6d18db3a62e3916c277fb`

**Scope:** source/runtime architecture, Theme QA, Terminal/AI CLI, MCP, Browser control, attachment/security, tests and finalization risks. This report is based on source inspection at the specified commit; previous reports and README are not the basis for technical conclusions.

## Executive decision

AntiFan does **not** need another feature expansion to reach Final.

The core workflow is already coherent:

```text
Terminal
  ↓
AI CLI
  ↓
Attachment / Lease
  ↓
MCP + Capability Catalogue
  ↓
Native Chromium
  ↓
Theme edit / reload
  ↓
Theme QA
  ↓
Artifacts / evidence
```

The remaining work should be **correctness + reliability**, not new product scope.

---

# P0 — Must fix before Final

## 1. Theme QA must validate the fresh post-reload state

### Finding

`ThemeQaWorkflow.validate()` captures DOM/screenshot and diagnostics through `inspect()` before `reload()`, then uses that earlier evidence during analysis. That means the QA verdict can describe the state before the latest edit/reload rather than the state actually produced by the latest edit.

Current semantics are effectively:

```text
snapshot diagnostics
→ inspect DOM + screenshot
→ reload
→ analyze earlier evidence
```

For theme development this is the most important remaining correctness issue.

### Required behavior

```text
assert target
→ clear/synchronize stale diagnostics
→ reload
→ wait until document is stable
→ capture fresh DOM
→ capture fresh screenshot
→ capture fresh diagnostics
→ run scanners
→ produce report
```

Every QA round must evaluate the state created by the latest edit.

### Acceptance criteria

- No verdict is produced from pre-reload DOM evidence.
- Diagnostics correspond to the current navigation/document generation.
- A file edit followed by reload is visible to QA.
- Round 2 validates the actual correction from Round 1.

**Priority: BLOCKER**

---

## 2. Add end-to-end tests for the real workflow

Unit tests are strong, but Final needs a small number of integration tests proving the complete chain.

### Test A — CLI → MCP → Browser → QA

```text
Project / Workspace
→ CLI session
→ attachment
→ capability invocation
→ browser target
→ Theme QA
→ artifact
→ end session
→ revoke attachment
```

### Test B — long-lived attachment renewal

```text
start session
→ cross original TTL window
→ heartbeat renew
→ MCP capability still works
```

### Test C — stale browser state

```text
capture target
→ reload/navigation
→ document generation changes
→ stale operation is rejected
```

### Test D — shutdown lifecycle

```text
start CLI/MCP
→ terminate process / stdin
→ heartbeat stops
→ attachment is ended/revoked
→ no leaked socket/process
```

**Priority: BLOCKER**

---

# P1 — Strongly recommended before Final

## 3. Separate `openTab()` from `setAutomationTarget()`

`BrowserControlPort.openTab()` currently creates a tab and also makes it the automation tab. Those are two different intents.

Recommended semantics:

```text
openTab()
```

only creates the tab. Changing the AI's automation target should be explicit, e.g.:

```text
setAutomationTarget(tabId)
```

### Acceptance criteria

Opening a reference tab must not silently retarget the AI's working context.

**Priority: HIGH**

---

## 4. Theme QA checklist should select checks, not override verdicts

The validation API currently accepts checklist values that can overwrite computed checklist status. A caller should configure what to run, but the engine should own PASS/FAIL.

Prefer:

```json
{
  "enabledChecks": {
    "liquid": true,
    "responsive": true,
    "overflow": true,
    "assets": true,
    "diagnostics": true
  }
}
```

Principle:

```text
input → chooses checks
engine → owns verdict
```

**Priority: HIGH**

---

## 5. Make the QA loop exactly two rounds

Recommended semantics:

```text
Round 1:
AI edit
→ fresh-state QA

FAIL:
→ send normalized critical findings to AI
→ one corrective edit

Round 2:
→ fresh-state QA

PASS → Done
FAIL → Stop + final report
```

Do not allow autonomous infinite retries.

The AI should receive a compact finding set rather than the full report:

```text
QA FAILED — Round 1/2

Critical:
- 24px horizontal overflow at 390px
- Broken first-party image: /assets/banner-mobile.jpg

Warnings:
- Third-party analytics request failed

Action:
Fix critical first-party findings only.
Do not modify unrelated code.
Rerun QA after editing.
```

**Priority: HIGH**

---

## 6. Define Terminal ↔ Workspace ownership clearly

`TerminalManager.setCapsule()` currently updates live sessions to the current capsule. A running shell/process should normally retain the workspace identity in which it was created.

Preferred invariant:

```text
terminal session
→ belongs to originating workspace/capsule
→ keeps identity until closed
```

Switching UI context should not silently move a running shell's ownership.

**Priority: HIGH**

---

# P2 — Hardening without scope expansion

## 7. Freeze `NativeTabHost` growth

`NativeTabHost` has become the main coupling point for tabs, split review, sidebar, terminal windows, diagnostics, preview, workspace capsule, workflows, annotations, Chrome profile, uploader, OAuth, history, device emulation and agent actions.

This is **not** a reason to rewrite it now.

Final rule:

> Do not add unrelated business logic to `NativeTabHost`.

Prefer dedicated managers/services for future changes.

**Priority: MEDIUM**

---

## 8. Freeze Bridge responsibilities

The Bridge remains useful as local authenticated transport.

Keep it focused on:

```text
transport
authentication
connection lifecycle
remote compatibility
capability dispatch
terminal/tab event relay
```

Do not add business logic to it.

Do not delete it merely because the name is legacy; the current CLI/MCP flow still uses it.

**Priority: MEDIUM**

---

## 9. Keep MCP small and stable

The existing MCP surface is already sufficient for the theme workflow.

Do not expand AntiFan into a general browser-agent platform.

Explicitly out of Final scope:

```text
No swarm agents
No planner framework
No RAG/vector DB
No model router
No ChatGPT-like internal chat product
No WebMCP
No plugin marketplace
No cloud backend
No durable execution database
No giant workflow orchestration engine
```

**Priority: FREEZE**

---

## 10. Treat legacy mode as temporary migration compatibility

Keep legacy only while a real consumer still needs it. Once unused, remove it rather than carrying permanent compatibility debt.

**Priority: LOW**

---

## 11. Separate compact AI evidence from the full QA artifact

The AI should normally receive a concise result such as:

```json
{
  "passed": false,
  "criticalCount": 2,
  "issues": [
    "24px horizontal overflow at 390px",
    "Liquid render error in product section"
  ]
}
```

The detailed DOM/diagnostics/report should remain an artifact available when needed.

This reduces token noise and makes the correction loop more deterministic.

**Priority: MEDIUM**

---

# Final acceptance checklist

## Runtime

- [ ] CLI session attaches reliably.
- [ ] Long-lived attachment heartbeat works.
- [ ] Expired/revoked attachment is rejected.
- [ ] PID/host/attempt/browser binding remains enforced.
- [ ] Session shutdown cleans heartbeat and attachment lifecycle.

## Browser

- [ ] Every AI browser action uses an explicit target.
- [ ] Reload/navigation updates document generation correctly.
- [ ] Stale browser state is rejected.
- [ ] Opening a reference tab does not unexpectedly retarget the agent.

## Theme QA

- [ ] QA runs on fresh post-reload state.
- [ ] Diagnostics are synchronized with the current navigation.
- [ ] Third-party noise is warning-only.
- [ ] First-party/theme failures can fail the gate.
- [ ] QA verdict is computed by the engine.
- [ ] Maximum loop is 2 QA rounds.
- [ ] Round 2 validates the actual correction.
- [ ] Final failure stops instead of looping forever.

## AI context

- [ ] Agent receives compact actionable findings.
- [ ] Full evidence remains available as artifacts.
- [ ] No fabricated PASS/FAIL results.
- [ ] Self-QA happens after edits.

## Regression confidence

- [ ] CLI → MCP → Browser → QA integration test passes.
- [ ] Heartbeat lifecycle test passes.
- [ ] Stale-target test passes.
- [ ] Shutdown/revocation test passes.

---

# Final product boundary

The North Star loop for AntiFan should remain:

```text
Developer
   ↓
pick element / provide context
   ↓
AI CLI
   ↓
edit theme
   ↓
reload
   ↓
fresh state
   ↓
Theme QA #1
  /        \
PASS       FAIL
 |           |
Done      AI Fix
             ↓
         Theme QA #2
          /       \
       PASS       FAIL
        |           |
       Done     Stop + Report
```

The objective is not to make AntiFan an all-purpose agent platform.

The objective is to make the loop above **trustworthy enough to use every day for theme/storefront development**.

## Final recommendation

Once the two P0 items are verified and the P1 items above are implemented, **freeze feature scope** and move to real-world usage.

At that point, new work should require a demonstrated workflow problem. Maintenance and correctness fixes are welcome; broad new subsystems are not.

---

## Source anchors inspected

- `src/main/qa/theme-qa-workflow.ts`
- `src/main/qa/diagnostics-filter.ts`
- `src/main/run/attachment-registry.ts`
- `src/main/run/run-service.ts`
- `src/main/tools/capability-catalogue.ts`
- `src/main/tools/browser-control-port.ts`
- `src/main/browser/native-tab-host.ts`
- `src/main/browser/terminal-manager.ts`
- `src/main/mcp/mcp-server.ts`
- `scripts/antifan-agent.cjs`
- `src/shared/control-plane-contracts.ts`
- `src/main/browser/tab-diagnostics.ts`
- `src/main/browser/haravan-uploader.ts`

**Audit baseline:** `ae6b4358bf59360703b6d18db3a62e3916c277fb`
