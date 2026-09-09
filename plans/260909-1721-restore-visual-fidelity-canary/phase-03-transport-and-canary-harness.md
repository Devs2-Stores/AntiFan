---
title: "Phase 3: Transport and Canary Harness"
status: done
---

# Phase 3: Transport and Canary Harness

## Outcome

Client timeouts do not replay unknown work, and the canary preserves raw evidence independently of pixel-diff success.

## Files

- `scripts/antifan-omp-mcp.cjs`
- `src/main/tools/browser-capabilities.ts`
- `src/main/tools/browser-control-port.ts`
- `test/main/capability-catalogue.test.ts`
- `test/main/mcp-persistent-transport.test.ts`
- `.canary/tools/lib-rpc.mjs`
- `.canary/tools/viewport-run.mjs`
- `.canary/tools/serve-static.mjs`

## Requirements

- [x] Visual compare and canonical standalone full-page capture each have client budgets longer than their bounded server response budgets; short defaults and the existing Theme QA budget remain unchanged.
- [x] `TIMEOUT`, `EXECUTION_TIMEOUT`, and `EXECUTION_TIMEOUT_PENDING_CLEANUP` are operation outcomes; no healthy-socket close, authority autoheal, or replay follows them. Pending cleanup remains nonterminal and may only be joined/polled by the same invocation identity.
- [x] Hoist `requestId` and `idempotencyKey` outside retry functions so eligible connection/auth retry preserves invocation identity and joins the original ledger entry.
- [x] Apply the same no-timeout-replay and pending-cleanup join rule to the direct canary RPC client; ignore late response IDs without disturbing concurrent calls.
- [x] Before global compare, call the canonical standalone verification-capture capability for each tab and immediately fetch/hash its immutable artifact as independent evidence; these standalone artifacts are not authoritative pixel inputs.
- [x] Global compare acquires one pair lock, normalizes and settles both tabs before either capture, opens both coherence windows, captures/stages both exact raw PNGs, post-checks both identities, and only then runs structural/pixel comparison; downstream `INCONCLUSIVE` retains that authoritative pair.
- [x] If compare fails before an atomic pair exists, retain standalone captures but report authoritative pixel evidence missing; no independent artifact may be promoted to a global compare result.
- [x] On every viewport change, set viewport with reload or explicitly reload both tabs and re-establish equivalent hydration before settlement/capture.
- [x] Final global compares use `allowHeightDrift: false`, `useDefaultWidgetMasks: false`, and no user masks.
## Implementation Steps

1. Implement per-capability client budgets and timeout classification in the MCP proxy, including a standalone full-page budget greater than its server budget.
2. Preserve request identity across eligible retry; prohibit retries after operation timeout and join or poll pending cleanup by the original identity only.
3. Align `.canary/tools/lib-rpc.mjs` with identical identity, timeout, and pending-cleanup semantics.
4. Upgrade the viewport runner to persist standalone capture receipts/artifacts first, then persist the atomic compare pair and clearly label the two lineages.
5. Reload both tabs per viewport, enforce strict height and zero implicit masks, and never use standalone artifacts as authoritative compare inputs.
6. Replace prefix-string containment and wildcard CORS in the canary server.

## Verification

- [x] Delayed visual compare and standalone full-page capture each dispatch once, time out once, perform zero autoheal/rebind/replay, and leave the socket usable.
- [x] Pending-cleanup response has no terminal receipt; later join observes the single terminal receipt only after cleanup/quarantine completion.
- [x] Genuine eligible retry reuses request/idempotency identity and joins rather than duplicates work.
- [x] Late timed-out response cannot resolve a newer call.
- [x] Downstream compare failure leaves both authoritative raw PNGs when atomic capture succeeded; failure before pair capture leaves only clearly labeled independent evidence and forces `INCONCLUSIVE`.
- [x] Viewport transition reloads both tabs and proves fresh equivalent hydration before capture.
- [x] Sibling-prefix traversal, encoded traversal, Windows ADS, non-GET methods, and hostile Origin requests cannot read clone files.

## Done When

Transport is at-most-once across timeout ambiguity, and canary evidence survives comparison failure without origin leakage.
