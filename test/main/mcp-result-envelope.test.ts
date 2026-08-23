import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, failure } from '../../src/main/mcp/result-envelope';

test('MCP result envelope carries stable evidence metadata', () => {
  const result = envelope({ success: true }, { tabId: 'tab-1', url: 'https://example.test' });
  assert.equal(result.ok, true);
  assert.equal(result.data.success, true);
  assert.equal(result.evidence.tabId, 'tab-1');
  assert.equal(result.evidence.url, 'https://example.test');
  assert.equal(typeof result.evidence.timestamp, 'number');
});

test('MCP failures are structured', () => {
  const result = failure('Unknown tabId: tab-2', { tabId: 'tab-2' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MCP_TOOL_ERROR');
  assert.equal(result.error.message, 'Unknown tabId: tab-2');
});

test('MCP result envelope carries execution data payload', () => {
  const evalResult = envelope({ expressionResult: 42 }, { tabId: 'tab-1', url: 'https://youtube.com' });
  assert.equal(evalResult.ok, true);
  assert.equal((evalResult.data as any).expressionResult, 42);
  assert.equal(evalResult.evidence.tabId, 'tab-1');
});
