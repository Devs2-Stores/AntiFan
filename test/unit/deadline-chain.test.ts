/**
 * Request deadline chain (`AP-DEADLINE-001`) — structural proof.
 *
 * Anti-pattern being retired: each transport layer hardcoded its own timeout
 * literal, so an outer layer could give up while an inner one was still admitted
 * to run. The caller then reported "outcome unknown" for a command that was
 * provably not finished.
 *
 * Invariant under test: the chain MUST strictly increase from the innermost
 * (callee) bound to the outermost (caller) bound, and the guard MUST actually
 * reject every way that can break — inversion, flattening (equality), a
 * non-numeric bound, and a deadline layer that never joins the chain.
 *
 * Layer 5 of the real path (the omp client's own `timeout` in
 * `~/.omp/agent/mcp.json`) is out of this repo, so it is modelled here by
 * `MCP_CLIENT_TIMEOUT_MIN_MS` — the minimum it must satisfy — and probed live.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEADLINES,
  DEADLINE_CHAIN,
  CATALOGUE_MAX_POLICY_MS,
  MCP_CLIENT_TIMEOUT_MIN_MS,
  findDeadlineChainViolations,
  assertDeadlineChain,
  type DeadlineLayer,
} from '../../src/shared/deadline-chain';

/** Innermost -> outermost, spelled out so a silent reorder of the constant fails here. */
const EXPECTED_ORDER: readonly DeadlineLayer[] = [
  'cdpCaptureMs',
  'qaWorkflowMs',
  'toolPolicyMs',
  'proxyCeilingMs',
];

function chainRecord(overrides: Partial<Record<DeadlineLayer, number>> = {}): Record<DeadlineLayer, number> {
  return { ...DEADLINES, ...overrides };
}

/** Copy of the shipped chain with one layer forced to a chosen bound. */
function chainWith(layer: DeadlineLayer, ms: number): Record<DeadlineLayer, number> {
  const record: Record<DeadlineLayer, number> = { ...DEADLINES };
  record[layer] = ms;
  return record;
}

function adjacentPairs(chain: readonly DeadlineLayer[]): Array<[DeadlineLayer, DeadlineLayer]> {
  const pairs: Array<[DeadlineLayer, DeadlineLayer]> = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const inner = chain[i];
    const outer = chain[i + 1];
    if (inner && outer) pairs.push([inner, outer]);
  }
  return pairs;
}

describe('Request deadline chain (AP-DEADLINE-001)', () => {
  it('(a) the shipped DEADLINES chain reports no violations', () => {
    assert.deepStrictEqual(findDeadlineChainViolations(), [], 'default argument must read the shipped DEADLINES');
    assert.deepStrictEqual(findDeadlineChainViolations(DEADLINES), []);
    assert.deepStrictEqual(assertDeadlineChain(), undefined);
    assert.deepStrictEqual(assertDeadlineChain(DEADLINES), undefined);
  });

  it('(a) pins the shipped values that the chain composes', () => {
    assert.strictEqual(DEADLINES.cdpCaptureMs, 25_000);
    assert.strictEqual(DEADLINES.qaWorkflowMs, 40_000);
    assert.strictEqual(DEADLINES.toolPolicyMs, 60_000);
    assert.strictEqual(DEADLINES.proxyCeilingMs, 240_000);
  });

  it('(b) detects an inverted chain and reports the exact offending pair', () => {
    const inverted = chainRecord({ cdpCaptureMs: 60_000, qaWorkflowMs: 30_000 });
    assert.deepStrictEqual(findDeadlineChainViolations(inverted), [
      { inner: 'cdpCaptureMs', outer: 'qaWorkflowMs', innerMs: 60_000, outerMs: 30_000 },
    ]);
  });

  it('(b) reports the exact offending pair for every inverted adjacency', () => {
    for (const [inner, outer] of adjacentPairs(EXPECTED_ORDER)) {
      const inverted = chainWith(outer, DEADLINES[inner] - 1_000);
      assert.deepStrictEqual(
        findDeadlineChainViolations(inverted),
        [{ inner, outer, innerMs: DEADLINES[inner], outerMs: DEADLINES[inner] - 1_000 }],
        `${inner} > ${outer} must be reported, and only that pair`
      );
    }
  });

  it('(c) assertDeadlineChain throws DEADLINE_CHAIN_INVERTED for an inverted chain', () => {
    const inverted = chainRecord({ cdpCaptureMs: 60_000, qaWorkflowMs: 30_000 });
    assert.throws(
      () => assertDeadlineChain(inverted),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'must throw an Error');
        assert.match(error.message, /DEADLINE_CHAIN_INVERTED/, 'must carry the stable machine code');
        assert.match(
          error.message,
          /cdpCaptureMs\(60000ms\) must be < qaWorkflowMs\(30000ms\)/,
          'must name both layers and both bounds'
        );
        return true;
      }
    );
  });

  it('(d) rejects equal adjacent bounds — the invariant is STRICTLY increasing', () => {
    for (const [inner, outer] of adjacentPairs(EXPECTED_ORDER)) {
      const flattened = chainWith(outer, DEADLINES[inner]);
      assert.deepStrictEqual(
        findDeadlineChainViolations(flattened),
        [{ inner, outer, innerMs: DEADLINES[inner], outerMs: DEADLINES[inner] }],
        `${inner} === ${outer} must be a violation, not a pass`
      );
      assert.throws(() => assertDeadlineChain(flattened), /DEADLINE_CHAIN_INVERTED/);
    }
  });

  it('(d) rejects a wholly flattened chain (every layer at one value)', () => {
    const flat = chainRecord({
      cdpCaptureMs: 30_000,
      qaWorkflowMs: 30_000,
      toolPolicyMs: 30_000,
      proxyCeilingMs: 30_000,
    });
    assert.strictEqual(findDeadlineChainViolations(flat).length, EXPECTED_ORDER.length - 1);
    assert.throws(() => assertDeadlineChain(flat), /DEADLINE_CHAIN_INVERTED/);
  });

  it('(d) treats a non-numeric bound as a violation instead of accepting it', () => {
    const nan = chainRecord({ qaWorkflowMs: Number.NaN });
    const violations = findDeadlineChainViolations(nan);
    // NaN compares false against every bound, so BOTH adjacencies touching the
    // corrupted layer must be reported — never silently accepted.
    assert.strictEqual(violations.length, 2);
    assert.deepStrictEqual(
      violations.map((v) => [v.inner, v.outer]),
      [
        ['cdpCaptureMs', 'qaWorkflowMs'],
        ['qaWorkflowMs', 'toolPolicyMs'],
      ]
    );
    assert.throws(() => assertDeadlineChain(nan), /DEADLINE_CHAIN_INVERTED/);
  });

  it('(e) DEADLINE_CHAIN is declared innermost -> outermost and strictly increases', () => {
    assert.deepStrictEqual([...DEADLINE_CHAIN], [...EXPECTED_ORDER]);
    for (const [inner, outer] of adjacentPairs(DEADLINE_CHAIN)) {
      assert.ok(
        DEADLINES[outer] > DEADLINES[inner],
        `${inner}(${DEADLINES[inner]}ms) must be < ${outer}(${DEADLINES[outer]}ms)`
      );
    }
  });

  it('(e) every chain name is a real DeadlineLayer and no layer escapes the chain', () => {
    for (const layer of DEADLINE_CHAIN) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DEADLINES, layer),
        `${layer} must be a real key of DEADLINES`
      );
      assert.strictEqual(typeof DEADLINES[layer], 'number', `${layer} must be numeric`);
      assert.ok(Number.isFinite(DEADLINES[layer]), `${layer} must be finite`);
    }
    // A layer added to DEADLINES but never placed in the chain would be silently
    // unguarded, so the chain must cover the map exactly, with no duplicates.
    assert.deepStrictEqual([...DEADLINE_CHAIN].slice().sort(), Object.keys(DEADLINES).sort());
    assert.strictEqual(new Set(DEADLINE_CHAIN).size, DEADLINE_CHAIN.length, 'no duplicate layers');
  });

  it('declares the out-of-repo client bound as the OUTERMOST layer, above every in-repo layer', () => {
    assert.ok(Number.isFinite(MCP_CLIENT_TIMEOUT_MIN_MS), 'the client minimum must be a real bound');
    // The client is an ancestor of every layer in DEADLINE_CHAIN, so its bound must
    // STRICTLY exceed all of them — including the outermost in-repo layer,
    // proxyCeilingMs. Equality is the same defect as inversion here: a client that
    // gives up at exactly the server's ceiling has no margin to receive the typed
    // receipt the ceiling exists to produce, so it abandons admitted work. This is
    // the repo-boundary half of the invariant, which the exported guard cannot see
    // because the client layer is not a DEADLINE_CHAIN entry.
    for (const layer of DEADLINE_CHAIN) {
      assert.ok(
        MCP_CLIENT_TIMEOUT_MIN_MS > DEADLINES[layer],
        `MCP_CLIENT_TIMEOUT_MIN_MS(${MCP_CLIENT_TIMEOUT_MIN_MS}ms) must STRICTLY exceed ` +
          `${layer}(${DEADLINES[layer]}ms) — equality or a smaller value means the outermost caller ` +
          'abandons a call the server is still permitted to answer (AP-DEADLINE-001)'
      );
    }
  });

  it('keeps proxyCeilingMs dominating the largest policy the catalogue registers', () => {
    // proxyCeilingMs exists so the SERVER is the side that bounds a hung call
    // first; check-mcp-budget-dominance.mjs re-proves this against the live
    // catalogue at compile time, and this pins the documented magnitude.
    assert.ok(CATALOGUE_MAX_POLICY_MS >= DEADLINES.toolPolicyMs, 'catalogue max must cover the tool policy');
    assert.ok(
      DEADLINES.proxyCeilingMs > CATALOGUE_MAX_POLICY_MS,
      `proxyCeilingMs(${DEADLINES.proxyCeilingMs}ms) must exceed the largest catalogue policy (${CATALOGUE_MAX_POLICY_MS}ms)`
    );
  });

  it('probes the live out-of-repo client timeout and reports it (policy decision, never fails)', (t) => {
    // This layer is a JSON field in the user's global harness config, so its value
    // is a policy choice, not a repo invariant: the test asserts the field is
    // well-formed and SURFACES a violation in its output instead of turning the
    // suite red for a config the repo does not own.
    const configPath = path.join(os.homedir(), '.omp', 'agent', 'mcp.json');
    if (!fs.existsSync(configPath)) {
      t.diagnostic(`no out-of-repo omp config at ${configPath}; layer 5 not probed`);
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, { timeout?: unknown }>;
    };
    const timeout = config?.mcpServers?.['antifan-browser']?.timeout;
    if (typeof timeout !== 'number') {
      t.diagnostic(`mcpServers.antifan-browser.timeout is not set in ${configPath}; the harness default applies`);
      return;
    }
    assert.ok(Number.isFinite(timeout), 'a declared client timeout must be a finite number');
    const conformant = timeout > DEADLINES.proxyCeilingMs;
    t.diagnostic(
      `mcpServers.antifan-browser.timeout = ${timeout}ms ` +
        `(required > ${DEADLINES.proxyCeilingMs}ms, MCP_CLIENT_TIMEOUT_MIN_MS = ${MCP_CLIENT_TIMEOUT_MIN_MS}ms): ` +
        (conformant
          ? 'CONFORMANT'
          : 'AP-DEADLINE-001 VIOLATION — the outermost caller abandons invocations the server is still permitted to finish')
    );
  });

  it('wires the fail-closed chain assertion into the main-process boot file', () => {
    const bootPath = path.resolve(process.cwd(), 'src', 'main', 'index.ts');
    assert.ok(fs.existsSync(bootPath), 'src/main/index.ts must exist');
    const source = fs.readFileSync(bootPath, 'utf8');
    assert.match(
      source,
      /import\s*\{[^}]*\bassertDeadlineChain\b[^}]*\}\s*from\s*'\.\.\/shared\/deadline-chain'/,
      'boot file must import assertDeadlineChain from ../shared/deadline-chain'
    );
    assert.match(
      source,
      /(?:^|\n)\s*assertDeadlineChain\(\);/,
      'boot file must call assertDeadlineChain() at module scope so a mis-edit fails closed at startup'
    );
  });
});
