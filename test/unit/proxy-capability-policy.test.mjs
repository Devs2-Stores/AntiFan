import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

// The proxy reads its capability policy from the environment on every listTools/call.
// Clear any ambient policy so each case below states exactly what it sets.
const POLICY_KEYS = [
  'ANTIFAN_FIXER_SESSION',
  'ANTIFAN_ALLOWED_CAPABILITIES',
  'ANTIFAN_ALLOWED_CAPABILITY_NAMES',
  'ANTIFAN_FORBIDDEN_CAPABILITIES',
  'ANTIFAN_FORBIDDEN_CAPABILITY_NAMES',
];
for (const key of POLICY_KEYS) delete process.env[key];
process.env.SUPER_CORE_DB = ':memory:';

const require = createRequire(import.meta.url);
const proxy = require(path.resolve('scripts', 'antifan-omp-mcp.cjs'));

const ORIGINAL_ARGV = [...process.argv];

afterEach(() => {
  for (const key of POLICY_KEYS) delete process.env[key];
  process.argv.splice(0, process.argv.length, ...ORIGINAL_ARGV);
});

const advertised = async () => (await proxy.listTools()).tools.map((tool) => tool.name);

test('an unreadable JSON forbid-list forbids every capability instead of none', async () => {
  const all = await advertised();
  assert.ok(all.length > 50, 'the proxy advertises its catalogue without a policy');
  process.env.ANTIFAN_FORBIDDEN_CAPABILITIES = '["anti.browser.evaluate", ';
  assert.deepEqual(await advertised(), []);
});

test('an unreadable JSON allow-list allows nothing instead of everything', async () => {
  process.env.ANTIFAN_ALLOWED_CAPABILITIES = '["anti.inspect.*"';
  assert.deepEqual(await advertised(), []);
});

test('a JSON list with a non-string member is treated as unreadable', async () => {
  process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES = '["anti.browser.evaluate", 7]';
  assert.deepEqual(await advertised(), []);
});

test('readable JSON and comma lists keep their meaning', async () => {
  process.env.ANTIFAN_FORBIDDEN_CAPABILITIES = '["anti.browser.evaluate"]';
  const withJson = await advertised();
  assert.ok(withJson.length > 50);
  assert.ok(!withJson.includes('anti.browser.evaluate'));

  process.env.ANTIFAN_FORBIDDEN_CAPABILITIES = 'anti.browser.evaluate, anti.browser.navigate';
  const withComma = await advertised();
  assert.ok(!withComma.includes('anti.browser.evaluate'));
  assert.ok(!withComma.includes('anti.browser.navigate'));
  assert.ok(withComma.includes('anti.inspect.dom'));

  delete process.env.ANTIFAN_FORBIDDEN_CAPABILITIES;
  process.env.ANTIFAN_ALLOWED_CAPABILITIES = '["anti.inspect.*"]';
  const allowed = await advertised();
  assert.ok(allowed.length > 0);
  assert.ok(allowed.every((name) => name.startsWith('anti.inspect.')), allowed.join(','));
});

test('a JSON forbid-list passed on the command line is parsed, and fails closed when unreadable', async () => {
  process.argv.push('--forbidden-capabilities=["anti.browser.evaluate"]');
  const readable = await advertised();
  assert.ok(readable.length > 50, 'a readable JSON flag forbids only what it names');
  assert.ok(!readable.includes('anti.browser.evaluate'));

  process.argv.splice(0, process.argv.length, ...ORIGINAL_ARGV, '--forbidden-capabilities=["anti.browser.evaluate", ');
  assert.deepEqual(await advertised(), []);
});

test('an unreadable JSON allow-list flag allows nothing', async () => {
  process.argv.push('--allowed-capabilities=["anti.inspect.*"');
  assert.deepEqual(await advertised(), []);
});

test('an allow-list that is set but names nothing allows nothing', async () => {
  process.env.ANTIFAN_ALLOWED_CAPABILITIES = '[]';
  assert.deepEqual(await advertised(), []);
  delete process.env.ANTIFAN_ALLOWED_CAPABILITIES;
  process.env.ANTIFAN_ALLOWED_CAPABILITY_NAMES = ' , ';
  assert.deepEqual(await advertised(), []);
  delete process.env.ANTIFAN_ALLOWED_CAPABILITY_NAMES;
  process.env.ANTIFAN_ALLOWED_CAPABILITIES = '["", " "]';
  assert.deepEqual(await advertised(), [], 'blank entries name nothing, so the list allows nothing');
});
