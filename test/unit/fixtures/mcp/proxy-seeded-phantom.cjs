// Seeded-phantom fixture for the MCP parity gate: re-exports the real proxy
// with CORE_DISPATCH['core.stats'] pointing at a store method that does not
// exist on Core. The gate must fail on it.
const path = require('node:path');
const real = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'antifan-omp-mcp.cjs'));

const CORE_DISPATCH = { ...real.CORE_DISPATCH, 'core.stats': ['nonexistentStoreMethod', () => []] };

module.exports = { ...real, CORE_DISPATCH };
