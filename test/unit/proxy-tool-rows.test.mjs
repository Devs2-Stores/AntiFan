import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxy = require(path.resolve('scripts', 'antifan-omp-mcp.cjs'));

const row = (name) => proxy.definitions.find(([defName]) => defName === name);
const properties = (name) => {
  const found = row(name);
  assert.ok(found, `${name} is advertised by the proxy`);
  return found[2];
};

const NEW_TOOLS = [
  'anti.qa.variant_image_probe',
  'anti.qa.pdp_contract',
  'anti.qa.menu_depth',
  'anti.qa.page_structure',
  'anti.qa.pick_product',
  'theme.package_check',
];

test('every new probe tool is advertised once and maps to its own bridge capability', () => {
  for (const name of NEW_TOOLS) {
    assert.equal(proxy.definitions.filter(([defName]) => defName === name).length, 1, `${name} has exactly one row`);
    assert.equal(proxy.CAPABILITY_MAP[name] ?? name, name, `${name} is not remapped`);
    assert.equal(typeof row(name)[1], 'string');
    assert.ok(row(name)[1].length > 40, `${name} carries a real description`);
  }
});

test('only the probes that never click or navigate are read-safe to replay', () => {
  for (const name of ['anti.qa.pdp_contract', 'anti.qa.page_structure', 'anti.qa.pick_product', 'theme.package_check']) {
    assert.equal(proxy.READ_SAFE_CAPABILITIES[name], true, `${name} is replay-safe`);
  }
  for (const name of ['anti.qa.variant_image_probe', 'anti.qa.menu_depth']) {
    assert.notEqual(proxy.READ_SAFE_CAPABILITIES[name], true, `${name} interacts with the page and must not be replayed`);
  }
});

test('the probe tools advertise the arguments their capability accepts', () => {
  assert.ok('maxValues' in properties('anti.qa.variant_image_probe'));
  assert.ok('expectedMaxDepth' in properties('anti.qa.menu_depth'));
  assert.ok('rules' in properties('anti.qa.page_structure'));
  assert.ok('strategy' in properties('anti.qa.pick_product'));
  assert.ok('zipPath' in properties('theme.package_check'));
});

test('cockpit_scan forwards the QA run knobs and the product pick strategy', () => {
  const props = properties('theme.cockpit_scan');
  for (const key of ['profile', 'thresholds', 'viewports', 'multiBreakpoint', 'pick']) {
    assert.ok(key in props, `theme.cockpit_scan advertises ${key}`);
  }
});

test('qa_validate advertises extra viewports and the non-theme opt-out', () => {
  for (const name of ['theme.qa_validate', 'anti.theme.qa_validate']) {
    const props = properties(name);
    assert.ok('viewports' in props, `${name} advertises viewports`);
    assert.ok('allowNonTheme' in props, `${name} advertises allowNonTheme`);
  }
});

test('the responsive sweep rows accept extra viewports', () => {
  for (const name of ['anti.inspect.responsive_matrix', 'anti.qa.batch_matrix']) {
    const viewports = properties(name).viewports;
    assert.equal(viewports?.type, 'array', `${name} advertises viewports`);
    assert.equal(viewports.maxItems, 5);
  }
});

test('await_cdn_sync names its expectContains and expectNotContains arguments', () => {
  const [, description, props] = row('anti.theme.await_cdn_sync');
  assert.match(description, /expectContains/);
  assert.ok('expectContains' in props);
  assert.ok('expectNotContains' in props);
});

test('the stale-app signal fires once, and only for a digest the app does not answer', () => {
  const lines = [];
  const report = proxy.createStaleAppReporter((line) => lines.push(line));
  const digestMiss = Object.assign(new Error("Capability 'catalogue.digest' not found in catalogue"), { code: 'CAPABILITY_NOT_FOUND' });
  const otherMiss = Object.assign(new Error("Capability 'anti.theme.await_cdn_sync' not found in catalogue"), { code: 'CAPABILITY_NOT_FOUND' });
  assert.equal(report(otherMiss), false);
  assert.equal(report(Object.assign(new Error('Unknown capability: catalogue.digest'), { code: 'TARGET_STALE' })), false);
  assert.equal(report(digestMiss), true);
  assert.equal(report(digestMiss), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /restart AntiFan Desktop/);
  assert.match(lines[0], /catalogue\.digest/);
});

test('an auto-bind candidate is read from the typed details or the serialized diagnostic', () => {
  const typed = Object.assign(new Error('x'), { code: 'TARGET_REQUIRED', details: { autoBindCandidate: ' tab-7 ' } });
  assert.equal(proxy.autoBindCandidateOf(typed), 'tab-7');
  const serialized = Object.assign(new Error(JSON.stringify({ code: 'TARGET_MISMATCH', message: 'x', details: { autoBindCandidate: 'tab-9' } })), { code: 'TARGET_MISMATCH' });
  assert.equal(proxy.autoBindCandidateOf(serialized), 'tab-9');
  assert.equal(proxy.autoBindCandidateOf(Object.assign(new Error('x'), { code: 'TARGET_STALE', details: { autoBindCandidate: 'tab-1' } })), '');
  assert.equal(proxy.autoBindCandidateOf(Object.assign(new Error('x'), { code: 'TARGET_REQUIRED' })), '');
});
