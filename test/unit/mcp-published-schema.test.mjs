// The schema the proxy publishes in listTools() is what the agent host validates a call against
// before the proxy ever sees it. These tests pin that every argument shape agents were observed
// to send is accepted there, that normalizeParameterAliases then yields the canonical call, and
// that the proxy's own gates still refuse a call that truly lacks a field. Plain `node --test`:
// no compiled output is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.SUPER_CORE_DB = ':memory:';
const proxy = require(path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs'));
const { tools } = await proxy.listTools();
const published = (name) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `${name} is published`);
  return tool;
};

// A minimal JSON-schema check covering the keywords the published schemas use.
function typeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}
function problems(schema, value, at = '$') {
  if (!schema || Object.keys(schema).length === 0) return [];
  if (schema.anyOf && !schema.anyOf.some((alt) => problems(alt, value, at).length === 0)) return [`${at}: no anyOf branch matches`];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) return [`${at}: expected ${types.join('|')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: not in enum`];
  const out = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required || []) if (!(field in value)) out.push(`${at}.${field}: is required`);
    for (const [key, spec] of Object.entries(schema.properties || {})) if (key in value) out.push(...problems(spec, value[key], `${at}.${key}`));
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => out.push(...problems(schema.items, item, `${at}[${i}]`)));
  return out;
}
function accepts(name, args) {
  const tool = published(name);
  return problems(tool.inputSchema, args);
}

const OBSERVED = [
  ['terminal.write', { terminalId: 't-1', input: 'x' }, { sessionId: 't-1', input: 'x' }],
  ['terminal.write', { id: 't-1', input: 'x' }, { sessionId: 't-1', input: 'x' }],
  ['terminal.write', { terminal: 't-1', input: 'x' }, { sessionId: 't-1', input: 'x' }],
  ['terminal.write', { session: 't-1', input: 'x' }, { sessionId: 't-1', input: 'x' }],
  ['terminal.write', { sessionId: 't-1', text: 'x' }, { sessionId: 't-1', input: 'x' }],
  ['terminal.write', { sessionId: 't-1', key: 'ctrl+c' }, { sessionId: 't-1', key: 'ctrl-c' }],
  ['terminal.write', { sessionId: 't-1', key: 'Ctrl-C' }, { sessionId: 't-1', key: 'ctrl-c' }],
  ['terminal.write', { sessionId: 't-1', key: 'ctrl-C' }, { sessionId: 't-1', key: 'ctrl-c' }],
  ['terminal.write', { sessionId: 't-1', key: 'Escape' }, { sessionId: 't-1', key: 'esc' }],
  ['terminal.write', { sessionId: 't-1', keys: ['Down', 'Return'] }, { sessionId: 't-1', keys: ['down', 'enter'] }],
  ['terminal.close', { terminalId: 't-1' }, { sessionId: 't-1' }],
  ['terminal.resize', { id: 't-1', cols: 80, rows: 24 }, { sessionId: 't-1', cols: 80, rows: 24 }],
  ['anti.agent.file_upload', { selector: '#f', filePaths: ['a.txt'] }, { refOrSelector: '#f', filePaths: ['a.txt'] }],
  ['anti.agent.file_upload', { selector: '#f', files: ['a.txt'] }, { refOrSelector: '#f', filePaths: ['a.txt'] }],
  ['anti.agent.file_upload', { selector: '#f', paths: ['a.txt'] }, { refOrSelector: '#f', filePaths: ['a.txt'] }],
  ['anti.agent.set_control', { selector: '#c', checked: false }, { selector: '#c', state: false }],
  ['anti.agent.set_control', { selector: '#c', desired: true }, { selector: '#c', state: true }],
  ['anti.agent.set_control', { selector: '#c', expected: 'checked' }, { selector: '#c', state: 'checked' }],
  ['anti.agent.set_control', { selector: '#c', value: 'on' }, { selector: '#c', state: 'on' }],
  ['anti.agent.set_control', { selector: '#c', on: false }, { selector: '#c', state: false }],
  ['anti.browser.navigate', { url: 'https://x.test', waitUntil: 'networkidle' }, { url: 'https://x.test', waitUntil: 'load' }],
  ['anti.browser.navigate', { url: 'https://x.test', waitUntil: 'network-idle' }, { url: 'https://x.test', waitUntil: 'load' }],
  ['anti.browser.navigate', { url: 'https://x.test', waitUntil: 'none' }, { url: 'https://x.test', waitUntil: 'commit' }],
  ['browser.wait', { condition: 'page_loaded' }, { condition: 'document_loaded' }],
  ['anti.browser.wait', { condition: 'url-changed' }, { condition: 'url_match' }],
  ['anti.browser.wait', { type: 'network-idle' }, { type: 'network_idle' }],
  ['anti.inspect.responsive_matrix', { customBreakpoints: [375, 768] }, { customBreakpoints: [{ width: 375 }, { width: 768 }] }],
  ['anti.agent.cursor.click', { locator: { selector: '#a', role: null, name: null } }, { selector: '#a' }],
  ['anti.agent.cursor.click', { locator: {} }, {}],
  ['anti.agent.cursor.type', { locator: { placeholder: 'Search' }, text: 'q' }, { selector: '[placeholder="Search"]', text: 'q' }],
];

test('every observed argument shape passes the published schema and normalises to the canonical call', () => {
  for (const [name, given, canonical] of OBSERVED) {
    assert.deepEqual(accepts(name, given), [], `${name} ${JSON.stringify(given)} is accepted by the published schema`);
    const snapshot = JSON.parse(JSON.stringify(given));
    const { params, aliasApplied } = proxy.normalizeParameterAliases(name, given);
    assert.deepEqual(params, canonical, `${name} ${JSON.stringify(given)}`);
    assert.ok(aliasApplied.length > 0, `${name} ${JSON.stringify(given)} reports aliasApplied`);
    assert.deepEqual(given, snapshot, 'the caller object is not mutated');
  }
});

test('the published schema no longer demands a name an alias can supply', () => {
  assert.equal(published('terminal.write').inputSchema.required, undefined);
  assert.equal(published('terminal.close').inputSchema.required, undefined);
  assert.deepEqual(published('terminal.resize').inputSchema.required, ['cols', 'rows']);
  assert.equal(published('anti.agent.file_upload').inputSchema.required, undefined);
  assert.equal(published('anti.agent.set_control').inputSchema.required, undefined);
  for (const [name, field] of [['terminal.write', 'id'], ['terminal.write', 'terminalId'], ['terminal.write', 'text'], ['anti.agent.file_upload', 'paths'], ['anti.agent.set_control', 'checked']]) {
    assert.ok(published(name).inputSchema.properties[field], `${name}.${field} is published`);
    assert.match(published(name).inputSchema.properties[field].description, /^alias of /);
  }
  assert.match(published('terminal.write').description, /Required: sessionId \(or id, terminal, terminalId, session\)\./);
  assert.match(published('anti.agent.file_upload').description, /Required: refOrSelector \(or ref, selector\), filePaths \(or files, paths\)\./);
});

test('closed enums and the locator anyOf are relaxed in the published schema only', () => {
  const props = (name) => published(name).inputSchema.properties;
  assert.equal(props('terminal.write').key.enum, undefined);
  assert.equal(props('terminal.write').keys.items.enum, undefined);
  assert.equal(props('anti.browser.navigate').waitUntil.enum, undefined);
  assert.equal(props('browser.wait').condition.enum, undefined);
  assert.equal(props('anti.browser.wait').type.enum, undefined);
  assert.match(props('anti.browser.wait').condition.description, /document_loaded/);
  assert.deepEqual(props('anti.inspect.console').level.type, ['number', 'string']);
  assert.deepEqual(accepts('anti.inspect.console', { level: 'error' }), []);
  assert.deepEqual(props('anti.inspect.responsive_matrix').customBreakpoints.items.type, ['integer', 'object']);
  for (const name of ['anti.agent.cursor.click', 'anti.agent.cursor.move', 'anti.agent.cursor.type', 'anti.agent.cursor.hover', 'anti.agent.set_control']) {
    const locator = props(name).locator;
    assert.equal(locator.anyOf, undefined, name);
    for (const field of ['role', 'name', 'text']) assert.deepEqual(locator.properties[field].type, ['string', 'null'], `${name}.${field}`);
  }
  // The advertised rows keep the strict contract the compile gate compares with the catalogue.
  const row = (name) => proxy.definitions.find(([n]) => n === name);
  assert.deepEqual(row('terminal.write')[2].key.enum, ['enter', 'esc', 'ctrl-c', 'tab', 'up', 'down', 'right', 'left']);
  assert.deepEqual(row('terminal.write')[3], ['sessionId']);
  assert.ok(row('anti.agent.cursor.click')[2].locator.anyOf);
  assert.deepEqual(row('anti.agent.set_control')[3], ['state']);
});

test('a call that lacks the field under every name is still refused by the proxy gates', async () => {
  const refused = async (name, args, pattern) => {
    const { params } = proxy.normalizeParameterAliases(name, args);
    await assert.rejects(proxy.invoke(name, params), (err) => {
      assert.match(String(err.message), pattern, `${name} ${JSON.stringify(args)}`);
      return true;
    });
  };
  await refused('terminal.close', {}, /requires sessionId/);
  await refused('terminal.write', { input: 'x' }, /requires sessionId/);
  await refused('anti.agent.file_upload', { filePaths: ['a.txt'] }, /requires refOrSelector/);
  await refused('anti.agent.set_control', { selector: '#c' }, /requires state/);
  await refused('terminal.write', { sessionId: 't-1' }, /requires one of: input \| key \| keys \| message/);
});

test('terminal.write refuses submit before dispatch; an alias never replaces a supplied value', async () => {
  for (const args of [{ sessionId: 't-1', text: 'ls', submit: true }, { terminalId: 't-1', input: 'x', submit: false }]) {
    await assert.rejects(proxy.invoke('terminal.write', args), (err) => {
      const body = JSON.parse(err.message);
      assert.equal(body.code, 'INVALID_ARGUMENT');
      assert.match(body.message, /no 'submit' argument/);
      assert.match(body.message, /\\r/);
      assert.match(body.message, /message/);
      return true;
    });
  }
  // text ending in a carriage return still aliases onto input
  const ok = proxy.normalizeParameterAliases('terminal.write', { sessionId: 't-1', text: 'ls\r' });
  assert.deepEqual(ok.params, { sessionId: 't-1', input: 'ls\r' });
  assert.deepEqual(ok.aliasApplied, [{ from: 'text', to: 'input' }]);
  assert.equal(published('terminal.write').inputSchema.additionalProperties, undefined, 'the host schema stays open, so submit reaches the proxy');
  // an explicit state:false is a supplied value; checked must not override it
  const kept = proxy.normalizeParameterAliases('anti.agent.set_control', { selector: '#c', state: false, checked: true });
  assert.equal(kept.params.state, false);
  assert.deepEqual(kept.aliasApplied, []);
  // message is a canonical field, never an alias target
  for (const aliases of [['terminal.write', { sessionId: 's', note: 'hi' }]]) {
    assert.deepEqual(proxy.normalizeParameterAliases(...aliases).aliasApplied, []);
  }
});

test('unknown values and unsafe locator shapes are left for the capability to refuse', () => {
  const unknown = { sessionId: 's', key: 'ctrl-z' };
  assert.deepEqual(proxy.normalizeParameterAliases('terminal.write', unknown).params, unknown);
  assert.deepEqual(proxy.normalizeParameterAliases('anti.browser.navigate', { url: 'u', waitUntil: 'idle' }).aliasApplied, []);
  assert.deepEqual(proxy.normalizeParameterAliases('browser.wait', { condition: 'selector', selector: '#a' }).aliasApplied, []);
  assert.deepEqual(proxy.normalizeParameterAliases('anti.inspect.responsive_matrix', { customBreakpoints: [375.5] }).aliasApplied, []);
  // a selector already present, or other locator keys, block the hoist
  const withSelector = proxy.normalizeParameterAliases('anti.agent.cursor.click', { selector: '#x', locator: { selector: '#y' } });
  assert.deepEqual(withSelector.params, { selector: '#x', locator: { selector: '#y' } });
  const withRole = proxy.normalizeParameterAliases('anti.agent.cursor.click', { locator: { selector: '#y', role: 'button', name: '' } });
  assert.deepEqual(withRole.params, { locator: { selector: '#y', role: 'button' } });
  const nested = proxy.normalizeParameterAliases('anti.agent.cursor.type', { locator: { placeholder: 'a"b\\c' } });
  assert.equal(nested.params.selector, '[placeholder="a\\"b\\\\c"]');
});

test('alias rows publish the same inputSchema as their base', () => {
  for (const [alias, base] of [
    ['anti.browser.wait', 'browser.wait'],
    ['anti.theme.qa_validate', 'theme.qa_validate'],
    ['anti.theme.debug_bundle', 'theme.debug_bundle'],
    ['anti.theme.style_override', 'theme.style_override'],
    ['storefront.resolve_product', 'theme.resolve_product'],
  ]) {
    assert.deepEqual(published(alias).inputSchema, published(base).inputSchema, alias);
    // Agents call the alias name, so it must carry everything the base row tells them.
    const baseText = proxy.definitions.find(([n]) => n === base)[1];
    assert.ok(proxy.definitions.find(([n]) => n === alias)[1].includes(baseText.slice(1)), `${alias} keeps the guidance of ${base}`);
    assert.deepEqual(proxy.definitions.find(([n]) => n === alias).slice(3), proxy.definitions.find(([n]) => n === base).slice(3), `${alias} row derives from ${base}`);
  }
});

test('descriptions stay short and carry no millisecond cap literal for terminal.wait', () => {
  for (const tool of tools) assert.doesNotMatch(tool.description, /28000|28 s\b/, tool.name);
  assert.ok(published('terminal.write').description.length < 1200, `terminal.write description is ${published('terminal.write').description.length} characters`);
  assert.match(published('terminal.write').description, /POLICY_DENIED/);
  assert.match(published('terminal.write').description, /REFUSED_THEME_\*/);
  assert.match(published('terminal.wait').description, /maxTimeoutMs/);
  assert.match(published('browser.wait').description, /clamped: true/);
});

test('terminal.write publishes message as a plain string and requires exactly one input form', () => {
  const message = published('terminal.write').inputSchema.properties.message;
  assert.equal(message.type, 'string');
  assert.equal(message.enum, undefined);
  assert.match(published('terminal.write').description, /exactly one of: input \| key \| keys \| message/);
  assert.deepEqual(accepts('terminal.write', { sessionId: 't-1', message: 'hello' }), []);
});

test('a capture with saveTo reports savedTo, as its saveTo description promises', () => {
  assert.match(published('anti.screenshot.viewport').inputSchema.properties.saveTo.description, /savedTo/);
  const ref = { id: 'artifact-1', path: 'C:\\store\\a.artifact', byteLength: 10, sha256: 'ab', mime: 'image/png' };
  assert.equal(proxy.imageArtifactMetadata(ref, { ok: true, artifactRef: ref, savedTo: 'E:\\job\\home.png' }).savedTo, 'E:\\job\\home.png');
  assert.deepEqual(proxy.imageArtifactMetadata(ref, { ok: true, artifactRef: ref }), { _type: 'ArtifactRef', id: 'artifact-1', path: 'C:\\store\\a.artifact', byteLength: 10, sha256: 'ab', mime: 'image/png' });
  // Older hosts answer with the bare ref: size and hash come from it, and there is no savedTo to invent.
  assert.deepEqual(proxy.imageArtifactMetadata({ id: 'artifact-2', bytes: 4 }, { id: 'artifact-2', bytes: 4 }), { _type: 'ArtifactRef', id: 'artifact-2', byteLength: 4, mime: 'image/png' });
});

test('a tab refusal reaches the agent with its usable tabs, who closed the tab and the next call', () => {
  const refusal = (message, details) => Object.assign(new Error(message), { code: 'TARGET_MISMATCH', details });
  const text = proxy.failureText(refusal('TARGET_MISMATCH: Unknown browser target: gone.', {
    requestedTabId: 'gone', liveTabId: 'live', closedBy: 'user', closeReason: 'user-toolbar',
    usableTabs: [{ id: 'live', url: 'https://shop.example/' }, { id: 'second' }],
    suggestedTabId: 'live', nextCall: { tool: 'anti.browser.evaluate', args: { tabId: 'live' } },
    transmitted: true, signedAttachmentId: 'att-1',
  }));
  assert.ok(text.startsWith('TARGET_MISMATCH: Unknown browser target: gone.'), 'the CODE: message prefix is kept for hooks');
  assert.match(text, /That tab was closed by user: user-toolbar\./);
  assert.match(text, /Tabs this session may use: live \(https:\/\/shop\.example\/\), second\./);
  assert.match(text, /Next call: anti\.browser\.evaluate \{"tabId":"live"\}\.$/);
  assert.doesNotMatch(text, /att-1|transmitted/, 'transport bookkeeping stays out of the text');

  // A message that already lists the tabs is not given the list twice; an empty list says so.
  const listed = proxy.failureText(refusal('TARGET_MISMATCH: outside. Tabs this session may use: live.', { usableTabs: [{ id: 'live' }] }));
  assert.equal(listed.match(/Tabs this session may use/g).length, 1);
  assert.match(proxy.failureText(refusal('TARGET_STALE: Tab x no longer exists', { usableTabs: [], nextCall: { tool: 'anti.browser.tabs.list', args: {} } })), /no live tab it may use.*Next call: anti\.browser\.tabs\.list \{\}\.$/);

  // Refusals without tab guidance, and JSON diagnostics, are delivered exactly as before.
  assert.equal(proxy.failureText(refusal('INVALID_ARGUMENT: bad', { capability: 'x', transmitted: true })), 'INVALID_ARGUMENT: bad');
  const json = JSON.stringify({ code: 'CONNECTION_FAILED', message: 'down' });
  assert.equal(proxy.failureText(refusal(json, { usableTabs: [{ id: 'live' }] })), json);
});

test('rows without aliases or relaxations are published exactly as defined', () => {
  const unrelated = {
    name: 'browser.set-device-preset',
    description: 'Emulate a named responsive device preset (viewport, DPR, mobile UA, and touch) on a tab instead of manual set_viewport calls.',
    inputSchema: { type: 'object', properties: { presetId: { type: 'string' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, required: ['presetId'] },
  };
  assert.deepEqual(published(unrelated.name), unrelated);
  const row = proxy.definitions.find(([n]) => n === unrelated.name);
  assert.deepEqual(row, [unrelated.name, unrelated.description, unrelated.inputSchema.properties, ['presetId'], [], 'tabId']);
});
