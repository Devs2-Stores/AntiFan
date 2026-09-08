---
title: "Explicit Authority & Dual-Plane Corrective Cutover"
description: "Clean cutover from ambient active-tab/global ownership to attachment-scoped browser, terminal, MCP, persistence, and security authority."
status: pending
priority: P0
effort: "6-9d implementation + Windows runtime certification"
tags: [core, authority, dual-plane, terminal, mcp, security, windows]
created: 2026-09-09
blockedBy: [260901-1011-antifan-core-runtime-freeze]
blocks: [260903-1500-terminal-tab-affinity-and-concurrency-isolation]
---

# Explicit Authority & Dual-Plane Corrective Cutover

## Outcome

AntiFan runs one Main-owned Core where every operation and resource has one explicit owner, target, and lifetime. Agent sessions receive attachment-owned offscreen/ephemeral tabs; they never infer authority from the user's active tab, mutate another session's target, persist transient tabs, or start a second profile-owning Core. Missing or stale authority fails closed with typed errors.

## Governing Invariant

> Every operation and resource has exactly one explicit owner, target, and lifetime. Agent Plane cannot implicitly read, mutate, persist, focus, or adopt User Plane state. Missing authority fails closed.

## Constraints

- Preserve existing MCP tool names and serializable external arguments where they do not bypass authority.
- Reuse `AttachmentRegistry`, `CapabilityTransportAdapter`, `BrowserControlPort`, `NativeTabHost`, `TerminalManager`, `BridgeServer`, Windows ACL utilities, and existing offscreen capture implementation.
- No `activeTabId` fallback, master-token execution fallback, global automation-target authority, second Core, or second persistent profile owner.
- `startSession` must independently provision a dedicated `{ offscreen: true, ephemeral: true }` tab when no explicit valid target exists; Phase 2 must not depend on Phase 3 for target availability.
- Preserve fail-closed document-generation fencing for effectful operations.
- Capture verification must use the offscreen-rendered `WebContents.capturePage()` path without attaching the view or switching the user's visible tab.
- Clean cutover: migrate all callers and delete obsolete fallback paths; no compatibility shims.

## Non-Goals

- New browser abstraction, Playwright integration, UI redesign, clone-engine work, or unrelated capability additions.
- Replacing the existing invocation ledger, receipt model, or verification taxonomy.
- A standalone headless MCP/Core fallback when the desktop bridge is offline.
- Adding `tabRole` solely for persistence; current `offscreen`/`ephemeral` flags are sufficient. Add session ownership identity only where lifecycle requires it.

## Cross-Plan Relationships

| Relationship | Plan | Reason |
|---|---|---|
| Parent dependency | `260901-1011-antifan-core-runtime-freeze` | Owns the broader authority-first runtime and transport contracts consumed here. |
| Blocks and corrects | `260903-1500-terminal-tab-affinity-and-concurrency-isolation` | Its active-tab binding acceptance conflicts with the governing invariant; this plan replaces that criterion with explicit/dedicated agent-tab affinity. |
| Prior implementation evidence | `260901-1630-decoupled-dual-plane-background-automation` | Completed offscreen capture work is retained but requires runtime regression proof. |
| Related, no block | `260905-0012-core-pre-freeze-hardening-and-live-proof` | Completed evidence/certification primitives are reused. |

## Architecture

```text
GUI Main (sole profile/Core owner)
├── canonical TerminalManager
├── NativeTabHost
│   ├── User Plane: visible, persistent, activeTabId
│   └── Agent Plane: offscreen, ephemeral, attachment-owned
└── BridgeServer
    ├── attachment A -> browser binding A -> agent tab A
    └── attachment B -> browser binding B -> agent tab B

MCP stdio proxy
└── authenticated Bridge client
    ├── starts attachment-scoped session
    ├── receives scoped target authority
    └── bridge unavailable -> MCP_BRIDGE_OFFLINE, non-zero exit
```

## Phase Roadmap

| # | Phase | Priority | Dependencies | Exit Gate |
|---:|---|:---:|---|---|
| 1 | [Canonical Ownership & Transient Lifetime](./phase-01-start.md) | P0 | Parent contract | One TerminalManager; agent tabs cannot persist or ambiently adopt terminals. |
| 2 | [Attachment-Scoped Target Authority](./phase-02-session-target-authority.md) | P0 | 1 | Concurrent sessions own independent targets; no active/global fallback; stale writes reject. |
| 3 | [MCP Client-Only Cutover](./phase-03-mcp-client-only-cutover.md) | P0 | 2 | Stdio MCP connects through Bridge only; no profile collision or unbound execution. |
| 4 | [Pairing & Credential Hardening](./phase-04-pairing-and-credential-hardening.md) | P1 | 3 | No reusable master token in URLs/config; Windows DACL enforced. |
| 5 | [Renderer, Navigation & IPC Isolation](./phase-05-renderer-and-ipc-isolation.md) | P1 | 4 | Context isolation and trusted IPC/navigation boundaries pass real UI smoke. |
| 6 | [Production Certification](./phase-06-production-certification.md) | P0 | 1-5 | Tests plus fresh-process Windows concurrency/restart/capture proofs pass. |

## Global Success Criteria

- [ ] UI, Bridge, capability transport, and NativeTabHost observe one canonical `TerminalManager` and terminal session set.
- [ ] `offscreen` or `ephemeral` tabs never enter saved tab state and never restore after restart.
- [ ] Every agent tab has an attachment/session owner and deterministic cleanup path.
- [ ] No Agent Plane path falls back to `activeTabId` or mutates global automation authority from an explicit target.
- [ ] Two simultaneous attachments operate on distinct tabs without cross-session target changes or global lock poisoning.
- [ ] Explicit and implicit effectful stale targets return `TARGET_STALE`; missing targets return `TARGET_REQUIRED`.
- [ ] MCP stdio never acquires the persistent profile and exits non-zero with `MCP_BRIDGE_OFFLINE` when desktop is unavailable.
- [ ] Successful MCP startup always yields an attachment-bound socket and browser target.
- [ ] Reusable master credentials are absent from URL query strings, discovery manifests, logs, screenshots, and clipboard-oriented pairing payloads.
- [ ] Bridge credential files and their directories have restrictive Windows DACLs after create and atomic replacement.
- [ ] External web content runs with `contextIsolation: true`; vault IPC and navigation handlers validate trusted origin/owner.
- [ ] Offscreen screenshots are non-empty, target-correct, and cause zero active-tab/focus changes on Windows.
- [ ] Focused unit/integration suites, typecheck, two-session runtime smoke, restart smoke, and fail-closed negative cases pass without weakened tests.

## Verification Strategy

1. Contract tests at each phase; never wait until final certification to discover protocol gaps.
2. Runtime probes use real GUI Main + Bridge + MCP proxy; no mocked profile ownership or synthetic tab lists for release evidence.
3. Negative tests prove absence of authority: missing target, stale generation, closed attachment, bridge offline, reused pairing code, untrusted IPC origin.
4. User-plane sentinel records active tab, focus, URL, document generation, and screenshot before/after agent capture and input operations.
5. Phase 6 runs from fresh processes and verifies cleanup: zero restored agent tabs, orphaned processes, leaked attachments, or stale locks.

## Rollback Boundaries

- Phase 1 can roll back independently, but rollback must retain persistence exclusion for agent tabs once production data may contain them.
- Phase 2 rollback may disable automation, never restore active-tab/global fallback.
- Phase 3 Bridge and MCP proxy protocol changes deploy and roll back atomically.
- Phase 4 pairing and DACL migrations are separate commits; credential rollback revokes issued tokens first.
- Phase 5 context-isolation migration is isolated from navigation/vault hardening where possible; rollback fails closed rather than restoring shared-world privilege.

## Open Questions

None. Validation fixed terminal ownership, agent tab activation, mobile networking, and local pairing contracts.

## Red Team Review

### Session — 2026-09-09

**Findings:** 27 submitted by three usable hostile reviewers; one security reviewer stalled and contributed no evidence. **Adjudication:** 11 unique evidence-backed gaps accepted; duplicates and proposals conflicting with documented page-inspection behavior rejected. Severity: 5 Critical, 6 High accepted.

| # | Accepted finding | Severity | Applied To |
|---:|---|:---:|---|
| 1 | Keep agent tabs out of user `tabOrder`, history, traversal, activation, and bulk close | Critical | Phase 1 |
| 2 | Add explicit attachment terminal authority; remove active-terminal input fallback | Critical | Phase 2 |
| 3 | Authorize read/lifecycle targets, not only writes | Critical | Phase 2 |
| 4 | Define background behavior for `tabs.activate`; never physically activate agent targets | Critical | Phase 2 |
| 5 | Add attachment-to-tab disposal hooks for disconnect/revoke/expiry | Critical | Phase 2 |
| 6 | Forward offscreen options and prevent later re-throttling | High | Phase 2 |
| 7 | Scope `ViewportGate` poison and release locks on tab destruction | High | Phase 2 |
| 8 | Preserve stale expected generation instead of adopting live generation | High | Phase 2 |
| 9 | Support concurrent per-client pairing challenges | High | Phase 4 |
| 10 | Add file-level, not directory-only, Windows ACL enforcement | High | Phase 4 |
| 11 | Separate privileged isolated-world mutation from authorized page-global inspection | High | Phase 5 |

Rejected duplicates repeated the same authority/persistence/capture gaps. Rejected one proposal to force all inspection into isolated world 1004 because page-global inspection is an intentional observable contract; the accepted correction instead isolates privilege while preserving narrow read-only inspection.

### Whole-Plan Consistency Sweep

Complete: accepted red-team deltas propagated across the overview and affected phases; no stale active-tab binding, shared pairing code, MCP-class deletion, all-isolated-world, or disposable-certification assumptions remain.

## Validation Log

### Session 1 — 2026-09-09

**Verification tier:** Full. Prior deep research, six phase source scouts, and evidence-backed red-team review covered source paths and contracts; no `[UNVERIFIED]` claims remained.

| Decision | Selected contract | Applied To |
|---|---|---|
| Terminal authority | Attachment-owned terminals only; foreign/user terminal input fails closed | Phase 2 |
| Tab activation | MCP agent calls are rejected with `USER_VISIBLE_OPERATION_FORBIDDEN` | Phase 2 |
| Mobile networking | Loopback by default; explicit opt-in LAN with scoped pairing/firewall guidance | Phase 4-5 |
| Local MCP pairing | Bounded NTFS-protected per-client runtime challenge queue | Phase 4 |

### Whole-Plan Consistency Sweep

Complete: all seven plan files reread after validation; phase dependencies, authority/error contracts, mobile mode, pairing channel, MCP entrypoint, capture behavior, and success criteria agree. Unresolved contradictions: zero.

<!-- slug: explicit-authority-dual-plane-cutover -->