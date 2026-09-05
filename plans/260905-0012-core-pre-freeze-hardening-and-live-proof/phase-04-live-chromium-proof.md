---
phase: 4
title: "Real Chromium Theme Proof"
status: complete
priority: P1
effort: "2d"
dependencies: [1, 2, 3]
---

# Phase 4: Real Chromium Theme Proof

## Context Links

- [Plan](./plan.md)
- Existing contract harness: `test/golden-slice-e2e.test.ts`
- Live runtime pattern: `scripts/smoke-mcp-industrial-e2e.cjs`, `test/e2e/mcp-industrial-overhaul.test.ts`
- Fixtures: `test/fixtures/golden-workflow/product-card/`

## Overview

Replace the missing production proof with two deterministic local slices using real Electron Chromium, `NativeTabHost`, CDP, authenticated capability transport, workspace file capability, preview re-render, five responsive widths, verifier lifecycle, and receipts. Keep the mock-host golden test as a fast integration contract; never relabel it E2E.

## Requirements

- Product Card slice: discover live target → raw matched CSS → correlated source candidate → `file.write` mutation → observed preview reload/generation advance → coherent re-observation → five-breakpoint matrix → source/CSS/responsive verification → per-invocation receipt.
- Hamburger/Drawer slice: coherent pre-state → trusted CDP click (`isTrusted=true`) → mutation revision and sparse observed delta → drawer visible/body state changed → document and target/container overflow checked → verification and receipt.
- Serve all storefront/theme content from a local HTTP fixture rooted in a temporary copied workspace. No external network or installed storefront CLI.
- Mutation must go through authenticated `file.write`; direct `fs.writeFileSync` is fixture setup/teardown only.
- Re-render must be caused by the existing watcher/reload path or a fixture server that reads workspace files per request plus explicit capability reload; tests must observe new generation and changed computed result.
- Assert real surfaces: genuine PNG bytes, live DOM values, CDP stylesheet IDs/ranges, genuine trusted event, actual file hash, generation/revision movement, and receipt persisted under invocation ID.
- Run each smoke in a fresh process with bounded per-call and suite timeout; close MCP proxy, bridge, tabs, terminal resources, server, and temp roots in `finally`.

## Architecture

```text
local temp theme + HTTP server
  -> real BrowserWindow + NativeTabHost
  -> ControlPlaneRuntime + BridgeServer + MCP proxy
  -> authenticated capabilities
  -> browser evidence / file.write / reload
  -> evaluator + batch lifecycle + receipt
  -> JSON proof artifact
```

One new smoke runner owns both slices to avoid duplicating runtime bootstrap. Product-specific markup/selectors remain inside the fixture and runner assertions, never capability code.

## File Inventory

| Action | File | Rough Change | Test Impact |
|---|---|---:|---|
| Create | `scripts/smoke-theme-golden-live.cjs` | Live runtime bootstrap and two proof slices | New Electron smoke |
| Create | `test/e2e/theme-golden-live.test.ts` | Spawn runner, assert exit/proof markers | E2E gate |
| Create | `test/fixtures/golden-workflow/hamburger-drawer/` | Local storefront/theme behavior fixture | Behavioral proof |
| Modify | `test/fixtures/golden-workflow/product-card/storefront/index.html` | Serve CSS/workspace mutation in live runner-compatible layout | Existing fixture tests |
| Modify | `test/fixtures/golden-workflow/product-card/theme/` | Add only generic source-lineage evidence needed by live server | Source tests |
| Modify | `test/golden-slice-e2e.test.ts` | Preserve integration classification and new receipt/source contracts | Fast contract test |
| Modify | `package.json` | Add one named live smoke command | Command discoverability |
| Create | `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/live-theme-proof.json` | Runtime-generated evidence summary | Certification input |

Generated report is not checked as completion until produced by the actual runner.

## Function and Interface Checklist

- [x] Live adapter wires epoch/document/mutation and matched-style CDP seams exactly like production.
- [x] MCP calls traverse `CapabilityTransportAdapter`; no direct capability `.execute()` in proof steps.
- [x] Product Card edit uses `file.write` and reports returned SHA-256.
- [x] Reload returns/rotates authoritative target generation before post-edit reads.
- [x] `anti.inspect.matched_styles` evidence contains real CDP identifiers/ranges.
- [x] Source resolver returns unique correlated HIGH from real workspace files.
- [x] Responsive matrix contains exactly widths 320/375/768/1024/1440 with boolean target/document overflow.
- [x] Drawer click records `isTrusted=true` and a relevant observed mutation, not ambient-only change.
- [x] Both `verify_claim` invocations produce distinct receipts keyed by invocation ID.

## Dependency Map

```text
Phases 1-3 contracts
  -> live adapter
  -> Product Card proof ----┐
  -> Drawer proof ----------┼-> proof artifact -> Phase 5 soak workload
  -> anti-mock assertions --┘
```

## Implementation Steps

1. Extract no production bootstrap abstraction; copy only the minimum established setup from `smoke-mcp-industrial-e2e.cjs` into the new runner.
2. Copy fixture roots to one temporary authoritative workspace and start a server that reads current files for each response.
3. Create ControlPlane session, real tab, bridge, and MCP proxy; implement bounded JSON-RPC helper with invocation/result capture.
4. Execute Product Card pre-observe/matched/source calls, mutate CSS through `file.write`, reload using the public capability, consume replacement authority revision, then prove changed live styles and five-width response.
5. Record and verify the Product Card claim; read the receipt store by returned invocation ID and assert completed/accepted execution plus domain `VERIFIED`.
6. Navigate/create the Drawer fixture, observe baseline, record interaction claim, click through trusted cursor capability, trace sparse mutation, and prove drawer/container state across mobile width.
7. Verify the Drawer claim and receipt. Add negative injection: no-op click or ambient-only mutation must not verify.
8. Persist bounded proof metadata (no screenshot bytes/source bodies) and tear everything down.
9. Add the E2E wrapper and package script; run compile, fast integration harness, then live smoke.

## Test Scenario Matrix

| Priority | Scenario | Real Evidence | Expected |
|---|---|---|---|
| Critical | Product Card full flow | DOM, CDP, source locator, file hash, generation, responsive, receipt | `VERIFIED` |
| Critical | CSS mutation does not re-render | Pre/post computed value unchanged | Fail before verification |
| Critical | Drawer trusted click | `isTrusted`, revision, sparse relevant delta, visible state | `VERIFIED` |
| Critical | Ambient mutation only | Integrity/delta excludes causality | Non-verified |
| Critical | Stale authority revision after reload | Transport rejects old revision | Explicit stale failure |
| High | Source ambiguity injected | Candidate list retained, source proof fails | Non-verified |
| High | One responsive width omitted | Matrix incomplete | Non-verified |
| High | Receipt IDs | Two calls for one/each claim | Unique terminal receipts |
| Medium | Teardown after injected failure | Process/server/temp resources | Zero owned survivors |

## Verification Commands

```text
npm run compile
node --test .compiled/test/golden-slice-e2e.test.js
npm run smoke:theme-golden-live
node --test .compiled/test/e2e/theme-golden-live.test.js
```

Live proof evidence: `reports/live-theme-proof.json` is `PASSED` with proof checksum `87dffb56d1872c1086c5fb2f6e17af7385d59b9c0eb5b25e5da7f2103df3235c`. It records real PNG/CDP/source/file-write/reload/five-width Product Card proof, trusted CDP Drawer mutation/visibility/five-width proof, distinct completed verification receipts, rejected no-op and ambiguous-source canaries, denied stale authority, zero Core resource owners after teardown, and completed process-bound temp cleanup after Electron exit.

## Todo

- [x] Build deterministic live Product Card fixture flow.
- [x] Build trusted Hamburger/Drawer behavior flow.
- [x] Route workspace mutation through authenticated capability.
- [x] Prove real CDP, re-render, responsive, lifecycle, and receipts.
- [x] Add anti-mock and negative-path assertions.
- [x] Persist live proof artifact and clean teardown.

## Success Criteria

- [x] No mocked `BrowserHostPort`, fake screenshot, mocked CDP payload, direct mutation, or synthetic responsive result participates in the live proof.
- [x] Product Card and Drawer each reach domain `VERIFIED` only from real fresh evidence.
- [x] Negative no-op/ambient/stale/ambiguous cases cannot verify.
- [x] All resources created by the runner are gone at exit.
- [x] Core purity audit still reports no product-specific runtime code.

## Risk Assessment

- **Preview watcher is unavailable for a bare temp workspace.** Signal: `file.write` succeeds but no reload occurs. Response: server reads files per request and the public reload capability advances generation; record watcher availability separately rather than faking it.
- **Electron smoke flakes on paint timing.** Signal: fixed sleeps fail intermittently. Response: use existing `browser.wait`/load/generation conditions with bounded timeout, never longer blind sleeps.
- **CDP source URL differs on local server.** Signal: URL-to-workspace resolver cannot correlate. Response: normalize local URL against fixture root in the runner-owned stylesheet map; do not weaken production source proof.

## Security Considerations

- Bind fixture/bridge to loopback, use generated attachment secrets, and redact them from artifacts/log assertions.
- Enforce workspace containment on all file capability calls.
- Never write private paths or raw source content into the checked proof summary.

## Rollback Boundary

The new runner/fixture/test/script can be removed without production rollback. Any Phase 1-3 failure exposed by the live proof must be fixed at its owner; do not patch the runner around it.

## Next Steps

Start Phase 5 only after both positive slices and all negative injections pass in one fresh process.
