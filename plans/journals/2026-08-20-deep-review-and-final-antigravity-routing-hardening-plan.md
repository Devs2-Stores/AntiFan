---
title: Deep review and final Antigravity routing hardening plan
date: 2026-08-20
summary: "Exact Auto is NO-GO; created a six-phase fail-closed, receipt-authoritative remediation plan."
---

# Deep review and final Antigravity routing hardening plan

## What happened
A second full review of Desktop, Extension, Sidecar, packaging, tests, and the two cooked plans found that exact Auto is not runnable and fails open to the active panel. Fresh verification still passed (Desktop 26/26, Extension 103/103), proving the existing suites miss production packaging, live routing, receipt, crash, and renderer security paths.

## Decision
Keep Antigravity integration rather than build a separate harness, but use a fail-closed managed Sidecar, absolute 18s/22s/30s deadlines, retained verified receipts, and transcript-only observation. Exact Auto remains disabled until a live two-conversation gate passes. Tokenless bridge RPC, unsafe renderer HTML, and session traversal are P0.

## Artifacts
- Review: plans/reports/260820-0851-antifan-antigravity-deep-code-review.md
- Plan: plans/260820-0854-harden-antifan-antigravity-routing-and-local-trust-boundaries/plan.md

## Next steps
Cook the six phases in dependency order, run the live Antigravity compatibility gate before durable protocol work, and enable exact Auto only after the release matrix passes.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
