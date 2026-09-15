/**
 * deadline-chain.ts — Single source of truth for the outer request deadline chain.
 *
 * Anti-pattern this file retires (`AP-DEADLINE-001`): each transport layer hardcoded
 * its own timeout literal, so an outer layer could give up while an inner one was
 * still admitted to run. The caller then reported "outcome unknown" for a command
 * that was provably not finished. Live evidence on one request path
 * (`theme.qa_validate`):
 *
 *   - tool policy declared 60_000 ms   (`src/main/tools/browser-capabilities.ts`)
 *   - the omp MCP client gave up at 30_000 ms  (`~/.omp/agent/mcp.json`)
 *   - canonical viewport capture bounded at 25_000 ms
 *     (`VIEWPORT_CAPTURE_EXECUTION_BUDGET_MS` in `src/main/tools/browser-control-port.ts`)
 *
 * Invariant: the chain MUST strictly increase from the innermost (callee) bound to
 * the outermost (caller) bound. A caller that abandons a request before its callee
 * has provably finished converts a recoverable timeout into an orphaned command.
 *
 * Layering, innermost -> outermost (each figure verified by reading the owner):
 *
 *   1. `cdpCaptureMs`    25_000  one bounded CDP capture on the compositor
 *   2. `qaWorkflowMs`    40_000  the QA workflow composing several captures + settle
 *   3. `toolPolicyMs`    60_000  the registered policy for the whole `theme.qa_validate`
 *   4. `proxyCeilingMs` 240_000  `DEFAULT_CLIENT_TIMEOUT_MS` in `scripts/antifan-omp-mcp.cjs`
 *   5. the omp client's own timeout, OUT of this repo (`~/.omp/agent/mcp.json`)
 *
 * Layer 4 is structural, not cosmetic: `scripts/check-mcp-budget-dominance.mjs` fails
 * the compile unless this ceiling exceeds EVERY policy in the built catalogue, whose
 * current maximum is `CATALOGUE_MAX_POLICY_MS` (`browser.visual_compare`). That script
 * reads the real catalogue, so it stays authoritative if a policy grows.
 *
 * Layer 5 cannot be aliased from code — it is a JSON field in the user's global harness
 * config — so it is declared here as the MINIMUM it must satisfy
 * (`MCP_CLIENT_TIMEOUT_MIN_MS`) and asserted by `test/unit/deadline-chain.test.ts`.
 * It is the true outermost bound, which is why a 30_000 ms client value was the
 * observed production defect: it abandons every call before even the 25_000 ms
 * innermost capture — and long before the 60_000 ms tool policy can return a typed
 * receipt.
 *
 * Scope note (deliberate): this chain covers only the layers that compose ONE request
 * path. Sibling budgets that merely happen to share a numeric value
 * (`VISUAL_COMPARE_CLEANUP_BUDGET_MS`, `SETTLE_BOUND_MS`, `TARGET_RECOVERY_BUDGET_MS`,
 * `REFERENCE_MATERIALIZATION_BOUND_MS`, …) express different concepts and are NOT
 * aliases of these constants. Collapsing them would couple unrelated retry, cleanup
 * and settle policies — that is DRY misapplied, not a deduplication.
 */

export const DEADLINES = {
  /** Innermost: one bounded CDP capture on the compositor. */
  cdpCaptureMs: 25_000,
  /** The Theme QA workflow, which composes several bounded captures plus settle. */
  qaWorkflowMs: 40_000,
  /** The registered tool-policy budget for one `theme.qa_validate` call. */
  toolPolicyMs: 60_000,
  /** Outermost in-repo bound: the stdio proxy rejects the dispatch after this. */
  proxyCeilingMs: 240_000,
} as const;

/**
 * The largest policy the built catalogue currently registers
 * (`browser.visual_compare`). Maintained as documentation of the magnitude that
 * `proxyCeilingMs` must dominate; `check-mcp-budget-dominance.mjs` enforces the real
 * relationship against the live catalogue rather than trusting this number.
 */
export const CATALOGUE_MAX_POLICY_MS = 180_000;

/**
 * Required minimum for the omp MCP client's own dispatch timeout
 * (`mcpServers.antifan-browser.timeout` in `~/.omp/agent/mcp.json`). That layer sits
 * OUTSIDE every layer in `DEADLINES`, so it must STRICTLY exceed `proxyCeilingMs` —
 * at equality the client abandons at the exact instant the proxy's own ceiling fires,
 * so it can never receive the typed terminal receipt that ceiling exists to produce.
 * The required value therefore carries explicit margin over 240_000. Not aliased from
 * code because the owner is an out-of-repo JSON config.
 */
export const MCP_CLIENT_TIMEOUT_MIN_MS = 250_000;

export type DeadlineLayer = keyof typeof DEADLINES;

/** Innermost -> outermost. The order IS the contract, so it is data, not prose. */
export const DEADLINE_CHAIN: readonly DeadlineLayer[] = [
  'cdpCaptureMs',
  'qaWorkflowMs',
  'toolPolicyMs',
  'proxyCeilingMs',
];

export interface DeadlineChainViolation {
  inner: DeadlineLayer;
  outer: DeadlineLayer;
  innerMs: number;
  outerMs: number;
}

/**
 * Every adjacent pair whose bounds do not strictly increase.
 * An empty array means the chain is coherent.
 */
export function findDeadlineChainViolations(
  chain: Record<DeadlineLayer, number> = DEADLINES
): DeadlineChainViolation[] {
  const violations: DeadlineChainViolation[] = [];
  for (let i = 0; i < DEADLINE_CHAIN.length - 1; i++) {
    const inner = DEADLINE_CHAIN[i];
    const outer = DEADLINE_CHAIN[i + 1];
    if (!inner || !outer) continue;
    const innerMs = chain[inner];
    const outerMs = chain[outer];
    if (!(outerMs > innerMs)) {
      violations.push({ inner, outer, innerMs, outerMs });
    }
  }
  return violations;
}

/**
 * Fail-closed guard. Call from process start and from the smoke test so a future
 * edit that flattens or inverts the chain cannot ship silently.
 */
export function assertDeadlineChain(chain: Record<DeadlineLayer, number> = DEADLINES): void {
  const violations = findDeadlineChainViolations(chain);
  if (violations.length === 0) return;
  const detail = violations
    .map((v) => `${v.inner}(${v.innerMs}ms) must be < ${v.outer}(${v.outerMs}ms)`)
    .join('; ');
  throw new Error(`DEADLINE_CHAIN_INVERTED: ${detail}`);
}
