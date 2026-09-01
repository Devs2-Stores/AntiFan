import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, failure } from '../../src/main/mcp/result-envelope';

test('MCP result envelope carries stable evidence metadata', () => {
  const result = envelope({ success: true }, { tabId: 'tab-1', url: 'https://example.test' }, 'req-1', 'inv-1');
  assert.equal(result.ok, true);
  assert.equal(result.data.success, true);
  assert.equal(result.evidence.tabId, 'tab-1');
  assert.equal(result.evidence.url, 'https://example.test');
  assert.equal(typeof result.evidence.timestamp, 'number');
});

test('MCP failures are structured', () => {
  const result = failure('Unknown tabId: tab-2', 'MCP_TOOL_ERROR', undefined, { tabId: 'tab-2' }, 'req-2', 'inv-2');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MCP_TOOL_ERROR');
  assert.equal(result.error.message, 'Unknown tabId: tab-2');
});

test('MCP result envelope carries execution data payload', () => {
  const evalResult = envelope({ expressionResult: 42 }, { tabId: 'tab-1', url: 'https://youtube.com' }, 'req-3', 'inv-3');
  assert.equal(evalResult.ok, true);
  assert.equal((evalResult.data as any).expressionResult, 42);
  assert.equal(evalResult.evidence.tabId, 'tab-1');
});
