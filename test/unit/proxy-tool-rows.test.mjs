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
  for (const key of ['profile', 'thresholds', 'baselineViewports', 'multiBreakpoint', 'pick']) {
    assert.ok(key in props, `theme.cockpit_scan advertises ${key}`);
  }
});

test('qa_validate advertises extra viewports and the non-theme opt-out', () => {
  for (const name of ['theme.qa_validate', 'anti.theme.qa_validate']) {
    const props = properties(name);
    assert.ok('baselineViewports' in props, `${name} advertises baselineViewports`);
    assert.ok(!('viewports' in props), `${name} no longer advertises the renamed viewports key`);
    assert.ok('allowNonTheme' in props, `${name} advertises allowNonTheme`);
  }
});

test('the audit-fix arguments are advertised on the rows that accept them', () => {
  const expected = {
    'anti.browser.tabs.list': ['fields', 'limit', 'urlContains'],
    'anti.browser.tabs.create': ['bind'],
    'anti.browser.navigate': ['waitUntil'],
    'anti.screenshot.viewport': ['saveTo'],
    'anti.screenshot.full_page': ['saveTo'],
    'anti.browser.set_viewport': ['hideScrollbar'],
    'browser.set-viewport': ['hideScrollbar'],
    'anti.sheet.write_cell': ['confirmTimeoutMs', 'mode'],
  };
  for (const [name, keys] of Object.entries(expected)) {
    const props = properties(name);
    for (const key of keys) assert.ok(key in props, `${name} advertises ${key}`);
  }
  assert.deepEqual(properties('anti.browser.navigate').waitUntil.enum, ['commit', 'domcontentloaded', 'load']);
  assert.deepEqual(properties('anti.sheet.write_cell').mode.enum, ['replace', 'append']);
  assert.equal(properties('anti.sheet.write_cell').confirmTimeoutMs.maximum, 90000);
});

test('state_matrix names every close-probe outcome the report can carry', () => {
  const [, description] = row('anti.qa.state_matrix');
  for (const code of ['CLOSE_ESCAPE_FAILED', 'CLOSE_ESCAPE_UNMEASURED', 'CLOSE_ESCAPE_FLAKY']) {
    assert.match(description, new RegExp(code), `state_matrix describes ${code}`);
  }
});

test('the evaluate row states the real invocation deadline', () => {
  const [, description] = row('anti.browser.evaluate');
  assert.match(description, /30 s/);
  assert.doesNotMatch(description, />25s/);
});

test('listTools never emits a top-level oneOf/anyOf and states the alternatives in the description', async () => {
  const { tools } = await proxy.listTools();
  const withForms = proxy.definitions.filter(([, , , , forms]) => forms && (Array.isArray(forms) ? forms.length : Object.keys(forms).length));
  assert.ok(withForms.length > 0, 'the proxy still has alternative-argument rows');
  for (const tool of tools) {
    assert.ok(!('oneOf' in tool.inputSchema), `${tool.name} has no top-level oneOf`);
    assert.ok(!('anyOf' in tool.inputSchema), `${tool.name} has no top-level anyOf`);
  }
  const sequence = tools.find((tool) => tool.name === 'anti.agent.sequence');
  assert.match(sequence.description, /Provide exactly one of: actions \| steps\./);
  const wait = tools.find((tool) => tool.name === 'browser.wait');
  assert.match(wait.description, /Provide at least one of: condition \| type\./);
  const evaluate = tools.find((tool) => tool.name === 'anti.browser.evaluate');
  assert.match(evaluate.description, /Provide exactly one of: expression \| expressionFile\./);
});

test('a result whose body says the action did nothing is flagged as an error', () => {
  assert.equal(proxy.actionOutcomeFailed('anti.agent.cursor.click', { clicked: false, reason: 'covered' }), true);
  assert.equal(proxy.actionOutcomeFailed('anti.agent.cursor.click', { clicked: true }), false);
  assert.equal(proxy.actionOutcomeFailed('anti.agent.sequence', { success: false, completedSteps: 1 }), true);
  assert.equal(proxy.actionOutcomeFailed('anti.agent.sequence', { success: true }), false);
  assert.equal(proxy.actionOutcomeFailed('anti.inspect.dom', { success: false }), false, 'a read tool is never judged by an action flag');
  assert.equal(proxy.actionOutcomeFailed('anti.agent.cursor.click', 'text'), false);
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

test('navigate advertises a bounded timeoutMs on top of its url and ambient tab', () => {
  const props = properties('anti.browser.navigate');
  assert.equal(props.timeoutMs?.type, 'number');
  assert.match(props.timeoutMs.description, /60000/);
  assert.deepEqual(row('anti.browser.navigate')[3], ['url']);
  assert.equal(proxy.ambientTargetFieldFor('anti.browser.navigate'), 'tabId');
});

test('evaluate keeps its in-page budget and degraded-surface knobs', () => {
  const props = properties('anti.browser.evaluate');
  assert.equal(props.timeoutMs?.type, 'number');
  assert.equal(props.allowDegradedSurface?.type, 'boolean');
});

test('the sequence row accepts actions or its steps alias and requires one of them', () => {
  const found = row('anti.agent.sequence');
  const props = found[2];
  assert.equal(props.actions.type, 'array');
  assert.equal(props.steps.type, 'array');
  assert.deepEqual(props.steps.items, props.actions.items, 'the alias shares the step schema');
  assert.deepEqual(found[3], [], 'neither form is individually required');
  assert.deepEqual(found[4], [{ required: ['actions'] }, { required: ['steps'] }]);
});

test('settings_check advertises the result filters it accepts', () => {
  const props = properties('theme.settings_check');
  assert.equal(props.files?.type, 'array');
  assert.equal(props.files.items.type, 'string');
  assert.deepEqual(props.changedSince?.type, ['string', 'number']);
  assert.ok('workspaceRoot' in props);
});

test('qa_validate rows declare the greenfield opt-in with a mandatory reason', () => {
  for (const name of ['theme.qa_validate', 'anti.theme.qa_validate']) {
    const greenfield = properties(name).greenfield;
    assert.equal(greenfield?.type, 'object', `${name} advertises greenfield`);
    assert.equal(greenfield.properties.reason.type, 'string');
    assert.deepEqual(greenfield.required, ['reason']);
  }
});

test('write_cell is an advertised mutating tool, never read-safe, with an ambient tab', () => {
  const found = row('anti.sheet.write_cell');
  assert.ok(found, 'anti.sheet.write_cell is advertised by the proxy');
  for (const key of ['tabId', 'cell', 'value', 'expectedPrevious', 'gid', 'allowHeader']) {
    assert.ok(key in found[2], `write_cell advertises ${key}`);
  }
  assert.deepEqual([...found[3]].sort(), ['cell', 'value']);
  assert.equal(proxy.ambientTargetFieldFor('anti.sheet.write_cell'), 'tabId');
  assert.equal(proxy.READ_SAFE_CAPABILITIES['anti.sheet.write_cell'], undefined, 'a cell write is never replayed after a possible execution');
});
