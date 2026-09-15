// Seeded-drift fixture for the MCP parity gate: re-exports the real proxy with
// one deliberately wrong advertised property (core.stats gains a phantom
// 'bogusDrift' param the catalogue does not declare). The gate must fail on it.
const path = require('node:path');
const real = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'antifan-omp-mcp.cjs'));

const definitions = real.definitions.map((def) => {
  if (def[0] !== 'core.stats') return def;
  return [def[0], def[1], { ...(def[2] || {}), bogusDrift: { type: 'string' } }, def[3]];
});

module.exports = { ...real, definitions };
