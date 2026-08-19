---
phase: 5
title: "Validate Transcript And Artifact P2 Gates"
status: completed
priority: P2
effort: "6-10h"
dependencies: [3, 4]
---

# Phase 5: Validate Transcript and Artifact P2 Gates

## Overview

Add lightweight transcript observation and a reproducible artifact benchmark
without promoting either into delivery authority or undocumented hard limits.

## Requirements

- Functional: correlate exact-session `USER_INPUT` using raw `created_at`,
  `source`, normalized prompt digest, and command issue time.
- Functional: record `PLANNER_RESPONSE` only as `response-observed`.
- Functional: staged files remain outside command JSON and retain source hashes.
- Non-functional: no fixed confidence percentages or token-cost claims.
- Non-functional: preserve original PNG evidence used for visual comparison.

## Architecture

Observation is optional metadata on an already known delivery record:
`none -> prompt-observed -> response-observed`. Observation timeout leaves the
delivery unchanged. A benchmark script measures command-envelope size, staged
write/read cost, event-loop delay in an extension-like process, and attachment
ingestion separately. Initial 15 MB total, 8-image, 4 MB/image values are soft
defaults until measurements justify adjustment.

## Related Code Files

- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/transcript-syncer.ts` - expose raw timestamp/source/step metadata.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/antigravity-command-client.ts` - optional observation correlation.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/shared/contracts.ts` - observation fields.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/renderer/sidebar.ts` - secondary observation indicator only.
- Create: `E:/Work/apps/antifan-browser-desktop/scripts/benchmark-antigravity-artifacts.mjs` - reproducible payload benchmark.
- Create: `E:/Work/apps/antifan-browser-desktop/test/main/transcript-correlation.test.ts` - correlation false-positive/negative cases.
- Modify: `E:/Work/apps/antifan-browser-desktop/package.json` - benchmark command.

## Implementation Steps

1. Parse and retain raw transcript metadata without exposing private content in logs.
2. Normalize prompts consistently and correlate only after an extension receipt.
3. Test duplicate prompts, transformed attachment tags, wrong session, missing
   transcript, delayed writes, and schema changes.
4. Add the benchmark with deterministic generated buffers and machine-readable output.
5. Measure staged URI and inline Base64 separately; do not infer full-IDE freeze
   from Node serialization alone.
6. Apply only evidence-backed soft warnings; keep original staged PNG files.
7. Run full verification in both repositories and one manual two-workspace smoke.

## Success Criteria

- [ ] Missing transcript never changes delivery or triggers retry.
- [ ] `PLANNER_RESPONSE` is never labelled first-token or real-time streaming.
- [ ] Correlation tests report measured false positives/negatives for fixtures.
- [ ] Benchmark is committed, repeatable, and reports environment metadata.
- [ ] Desktop `npm run verify` passes.
- [ ] Extension `npm test` and `npx tsc -p . --noEmit` pass.
- [ ] Manual smoke proves correct workspace, one execution, receipt update, and no duplicate.

## Risk Assessment

Risk: proprietary transcript/API schemas change. Signal: unknown record types or
missing required fields increase. Response: disable observation, retain receipt
delivery, and re-characterize; do not weaken matching or guess.
