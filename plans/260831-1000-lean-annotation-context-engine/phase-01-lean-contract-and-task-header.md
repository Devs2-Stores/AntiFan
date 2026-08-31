---
phase: 1
title: "Lean Contract & Agent Header"
status: pending
priority: P1
effort: "1h"
dependencies: []
---

# Phase 1: Lean Contract & Agent Header

## Overview
Slim down `src/shared/annotation-prompt.ts` by cutting 150+ lines of static contract boilerplate, bumping `AGENT_CONTRACT_VERSION` to `3.2.0-lean`, and making acceptance criteria strictly intent-focused.

## Requirements
- Replace verbose `STANDALONE_AGENT_CONTRACT` with concise, high-impact operational invariants (Scope Lock, Root Cause, Verify at Source).
- Streamline `buildAgentTaskHeader` to only render acceptance criteria matching the user's intent.
- Ensure the invariant ledger (PRESERVES, DELIBERATELY CHANGES, RISKS) remains intact and prominent.

## Architecture
```
[src/shared/annotation-prompt.ts]
  ├── AGENT_CONTRACT_VERSION: '3.2.0-lean'
  ├── LEAN_AGENT_CONTRACT (15 lines vs. 150 lines)
  ├── buildAgentTaskHeader (Focused criteria per intent)
  └── buildEvidenceEnvelope (Clean YAML frontmatter)
```

## Related Code Files
- Modify: `src/shared/annotation-prompt.ts`

## Implementation Steps
1. Update `AGENT_CONTRACT_VERSION` to `'3.2.0-lean'`.
2. Refactor `STANDALONE_AGENT_CONTRACT` into `LEAN_AGENT_CONTRACT` prioritizing actionable rules (no repetitive prose).
3. In `buildAgentTaskHeader`, remove uninvoked intent modules and redundant section headers.
4. Keep YAML frontmatter and Fable-Thinking Invariant Ledger.

## Success Criteria
- [ ] Header token count reduced by > 60%.
- [ ] No loss of core safety invariants (PRESERVES / DELIBERATELY CHANGES / RISKS).
- [ ] Zero TypeScript compilation errors (`npm run clean && tsc -p .`).

## Risk Assessment
- **Risk:** Downstream agents might lack guidance if the contract is overly brief.
- **Mitigation:** Retain the 4 core rules: Rule 0 (Scope lock), Rule 1 (Scout before edit), Rule 2 (Root cause before fix), Rule 3 (Verify at source).
