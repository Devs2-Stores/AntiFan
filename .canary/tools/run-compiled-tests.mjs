/**
 * Run a compiled node:test suite with the ambient AntiFan session bindings
 * stripped from the environment.
 *
 * Rationale (evidence): this repository's own e2e harness spawns the OMP MCP
 * proxy as a child process and inherits `process.env`. A shell that is itself
 * bound to a live AntiFan session exports ANTIFAN_MCP_BOOTSTRAP /
 * ANTIFAN_BOUND_TAB_ID, and the proxy's documented fallback then injects the
 * host session's tab id into tool params. The mock-bridge tests then fail with
 * `TARGET_MISMATCH: expected tab-1, got <host tab>`.
 *
 * The fallback exists in HEAD too (`git show HEAD:scripts/antifan-omp-mcp.cjs`
 * lines 129/145/606), so this is pre-existing environment leakage, not a
 * regression. Suites must be run isolated from the host session.
 *
 * usage: node .canary/tools/run-compiled-tests.mjs <glob...>
 */
import { spawnSync } from 'node:child_process';

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  console.error('usage: node .canary/tools/run-compiled-tests.mjs <testGlob...>');
  process.exit(1);
}

const env = { ...process.env };
const cleared = [];
for (const key of Object.keys(env)) {
  if (key.startsWith('ANTIFAN_')) {
    delete env[key];
    cleared.push(key);
  }
}

console.log(`[clean-tests] cleared ${cleared.length} ambient ANTIFAN_* vars: ${cleared.join(', ') || '(none)'}`);
console.log(`[clean-tests] patterns: ${patterns.join(' ')}`);

const started = Date.now();
const result = spawnSync(
  process.execPath,
  ['--test', '--test-force-exit', ...patterns],
  { stdio: 'inherit', env }
);
console.log(`[clean-tests] exit=${result.status} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(result.status ?? 1);
