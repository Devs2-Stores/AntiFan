import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxy = require(path.resolve('scripts', 'antifan-omp-mcp.cjs'));

function catalogueError(code, message, details) {
  const err = new Error(JSON.stringify({ code, message, ...(details ? { details } : {}) }));
  err.code = code;
  return err;
}

test('the dispatch transport miss text is rewritten into the restart hint', () => {
  const err = catalogueError('CAPABILITY_NOT_FOUND', "Capability 'anti.theme.await_cdn_sync' not found in catalogue");
  assert.equal(proxy.annotateCatalogueMiss(err, 'anti.theme.await_cdn_sync', 'anti.theme.await_cdn_sync'), true);
  const diagnostic = JSON.parse(err.message);
  assert.match(diagnostic.message, /restart AntiFan Desktop/);
  assert.equal(diagnostic.details.bridgePredatesProxy, true);
  assert.equal(diagnostic.details.capability, 'anti.theme.await_cdn_sync');
});

test('the catalogue unknown-name text is still rewritten', () => {
  const err = catalogueError('CAPABILITY_NOT_FOUND', 'Unknown capability: anti.theme.await_cdn_sync');
  assert.equal(proxy.annotateCatalogueMiss(err, 'anti.theme.await_cdn_sync', 'anti.theme.await_cdn_sync'), true);
  assert.match(JSON.parse(err.message).message, /restart AntiFan Desktop/);
});

test('a host-level gap keeps its own message', () => {
  const err = catalogueError('CAPABILITY_NOT_FOUND', 'agentClick is not supported by host');
  const before = err.message;
  assert.equal(proxy.annotateCatalogueMiss(err, 'anti.agent.cursor.click', 'browser.agent-click'), false);
  assert.equal(err.message, before);
});

test('a name this proxy does not advertise is left alone', () => {
  const err = catalogueError('CAPABILITY_NOT_FOUND', "Capability 'made.up' not found in catalogue");
  const before = err.message;
  assert.equal(proxy.annotateCatalogueMiss(err, 'made.up', 'made.up'), false);
  assert.equal(err.message, before);
});

test('only CAPABILITY_NOT_FOUND is rewritten', () => {
  const err = catalogueError('TARGET_STALE', "Capability 'anti.theme.await_cdn_sync' not found in catalogue");
  assert.equal(proxy.annotateCatalogueMiss(err, 'anti.theme.await_cdn_sync', 'anti.theme.await_cdn_sync'), false);
});

test('skew lists advertised bridge names the running app does not register', () => {
  const advertised = proxy.definitions
    .map(([name]) => proxy.CAPABILITY_MAP[name] || name)
    .filter((mapped) => !mapped.startsWith('core.'));
  assert.deepEqual(proxy.catalogueSkew(advertised), []);
  const withoutOne = advertised.filter((name) => name !== 'anti.theme.await_cdn_sync');
  assert.deepEqual(proxy.catalogueSkew(withoutOne), ['anti.theme.await_cdn_sync']);
});

test('skew never counts proxy-local core.* names', () => {
  const advertised = proxy.definitions
    .map(([name]) => proxy.CAPABILITY_MAP[name] || name)
    .filter((mapped) => !mapped.startsWith('core.'));
  assert.ok(proxy.definitions.some(([name]) => (proxy.CAPABILITY_MAP[name] || name).startsWith('core.')), 'fixture precondition: the proxy advertises core.* rows');
  assert.deepEqual(proxy.catalogueSkew(advertised), []);
});

test('the skew hint is emitted once per process', () => {
  const lines = [];
  const report = proxy.createCatalogueSkewReporter((line) => lines.push(line));
  report(['anti.theme.await_cdn_sync']);
  report(['anti.theme.await_cdn_sync']);
  report([]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /anti\.theme\.await_cdn_sync/);
  assert.match(lines[0], /restart AntiFan Desktop/);
});

test('an empty skew emits nothing', () => {
  const lines = [];
  const report = proxy.createCatalogueSkewReporter((line) => lines.push(line));
  report([]);
  assert.equal(lines.length, 0);
});
