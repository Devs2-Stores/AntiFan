---
phase: 5
title: "8h Live Soak Execution & Official Freeze Certification"
status: pending
priority: P0
effort: "8h"
dependencies: [4]
schedule: "Overnight execution (scheduled for tonight per user instruction)"
---

# Phase 5: 8h Live Soak Execution & Official Freeze Certification

## 1. Overview
The final gate before declaring AntiFan Core officially **FROZEN** is executing the authoritative 8-hour live endurance benchmark (`scripts/benchmark-real-soak-8h.cjs`) on the local development machine. This phase captures continuous multi-process telemetry, validates memory linear regression slope $\beta$, confirms zero orphan processes, and issues the official Core Freeze Certification.

## 2. Requirements
- Launch `node scripts/benchmark-real-soak-8h.cjs` in a background session on the local host.
- Monitor 10-minute checkpoint persistence in `plans/reports/runtime-verification/real-soak-8h-checkpoint.json`.
- Upon completion, verify:
  1. Memory slope $\beta \le 0.05\text{ MB/hour}$ (no memory leak).
  2. Final orphan process count $= 0$.
  3. Zero ledger corruption or unrecovered attachments.
- Formally seal `src/main/` under the Core Freeze Rule.

## 3. Architecture & Soak Verification Protocol
```text
scripts/benchmark-real-soak-8h.cjs
  │
  ├─ Iterative Workload: 6 Tabs + 1 Terminal Session Cycling
  ├─ Telemetry Sampling: Memory, CPU, Process Table (every 60s)
  ├─ Checkpoint Write: real-soak-8h-checkpoint.json (every 10m)
  │
  ▼
8-Hour Milestone Evaluation:
  ├─ Linear Slope: Beta = Cov(t, RAM) / Var(t) <= 0.05 MB/h  ──► [PASS]
  └─ Windows Process Table: 0 Orphan PIDs remaining          ──► [PASS]
```

## 4. Related Code Files
- Inspect/Execute: `scripts/benchmark-real-soak-8h.cjs`
- Output Report: `plans/reports/runtime-verification/real-soak-8h.json`
- Target: `src/main/` (Core Freeze boundary)

## 5. Implementation Steps
1. Start the 8-hour soak benchmark via background job runner.
2. Inspect initial 10-minute and 30-minute checkpoints to verify steady-state metrics.
3. Validate final report against the Core Freeze SLOs.
4. Update project documentation and roadmap to declare Core Freeze complete.
5. Hand off directly to OMP Agent Skills implementation (`skill://theme-qa-az`, `skill://pagespeed`, `skill://site-clone`).

## 6. Success Criteria & Verification
- [ ] 8-hour live soak benchmark completes with exit code 0.
- [ ] Memory growth slope $\beta \le 0.05\text{ MB/hour}$.
- [ ] Zero orphan processes detected on Windows 11 Process Table.
- [ ] AntiFan Core Runtime officially certified as FROZEN v1.2.0.
