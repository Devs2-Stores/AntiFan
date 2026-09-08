---
title: Explicit authority dual-plane plan
date: 2026-09-09
summary: Deep advised plan with red-team and validated authority contracts
---

# Explicit authority dual-plane plan

## What happened
Created and activated a six-phase corrective cutover plan after three architecture research passes and six phase-specific source reviews. Red-team accepted 11 unique evidence-backed gaps; validation fixed four product contracts.

## Decisions
Agent sessions own dedicated offscreen/ephemeral tabs and only their own terminals. Agent tab activation is rejected. MCP is Bridge client-only. Mobile is loopback-default with explicit LAN opt-in. Local pairing uses a protected per-client runtime queue.

## Verification
`ak plan validate` returned valid. Whole-plan consistency sweep found zero unresolved contradictions. Kongming final gate returned GO with zero blockers.

## Next steps
Implement Phase 1 from plans/260909-0032-explicit-authority-dual-plane-cutover/plan.md, preserving phase gates and runtime proofs.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
