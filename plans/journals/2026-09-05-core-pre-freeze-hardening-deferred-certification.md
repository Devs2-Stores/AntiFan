---
title: Core pre-freeze hardening deferred certification
date: 2026-09-05
summary: Core hardening verified; source-bound 3x45m certificate deferred after fail-closed run 2.
---

# Core pre-freeze hardening deferred certification

## What happened

Implemented the AntiFan Core pre-freeze hardening plan: coherent browser/document/mutation evidence identity, split retry budgets, invocation-bound receipts, correlated source candidacy, real Chromium Product Card and Drawer proof, and Windows freeze orchestration.

Independent verification passed compile/typecheck, 166 fast tests, 876 main tests, seven freeze-contract tests, and the real Chromium proof. Review found that a checksummed short report could declare 45 minutes; the validator now requires at least 45 minutes of wall-clock and strictly increasing raw-sample coverage. Parent orchestration now owns process-bound temp cleanup after Electron exit.

## Decision

Keep both certificate-owning plans in progress. The replacement certification was deferred at the user's request after run 1 passed and run 2 failed closed because the Drawer trace returned verified=false. No aggregate certificate, partial run report, stale threshold manifest, or temp profile is retained. The next certification must restart all three fresh 45-minute runs.

## Next steps

1. Use AntiFan normally; no certification process remains active.
2. Diagnose the long-run Drawer trace failure at scripts/freeze-theme-workload.cjs:292.
3. When the workstation is free, run npm run certify:core-freeze uninterrupted from run 1 through run 3.
4. Close both plans only after the new source-bound aggregate certificate is PASSED.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
