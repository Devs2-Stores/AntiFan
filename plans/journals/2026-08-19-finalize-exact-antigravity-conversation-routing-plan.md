---
title: Finalize exact Antigravity conversation routing plan
date: 2026-08-19
summary: Final plan keeps the bridge and adds a fail-closed managed Sidecar exact route.
---

# Finalize exact Antigravity conversation routing plan

## What happened

Reviewed the current AntiFan-to-Antigravity bridge and the official Sidecar route for exact conversation delivery. Finalized the implementation plan at plans/260819-2334-route-antifan-chat-to-exact-antigravity-conversation/plan.md after a 14-finding red-team pass.

## Decision

Keep the workspace-safe filesystem bridge. Route exact Auto Send through an Antigravity-managed Sidecar using agentapi send-message. Draft remains active-panel only. Once a Sidecar request is published, ambiguous outcomes remain unknown with no fallback or replay.

The plan also hard-gates authoritative conversation ID discovery, pins an absolute Node launcher, serializes Sidecar work, persists crash states, binds signed receipts, rejects exact-route abort, and treats prompt argv visibility as an accepted same-user boundary.

## Next steps

Cook the four phases with tests first. Phase 1 must stop the implementation if authoritative IDs, safe invocation, busy semantics, or attachment capability cannot be proven.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
