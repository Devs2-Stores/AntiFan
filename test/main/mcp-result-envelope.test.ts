import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { envelope, failure } from '../../src/main/mcp/result-envelope';

it('MCP result envelope carries stable evidence metadata and authority revision', () => {
  const result = envelope({ success: true }, { tabId: 'tab-1', url: 'https://example.test', executionTier: 'cdp_trusted' }, 'req-1', 'inv-1', 'rev-2');
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.invocationId, 'inv-1');
  assert.equal(result.authorityRevision, 'rev-2');
  assert.equal(result.data.success, true);
  assert.equal(result.evidence.tabId, 'tab-1');
  assert.equal(result.evidence.url, 'https://example.test');
  assert.equal(result.evidence.executionTier, 'cdp_trusted');
  assert.equal(typeof result.evidence.timestamp, 'number');
});

it('MCP failures are structured and carry authority revision when rotated', () => {
  const result = failure('Unknown tabId: tab-2', 'MCP_TOOL_ERROR', { hint: 'retry' }, { tabId: 'tab-2', fallbackReason: 'unattached' }, 'req-2', 'inv-2', 'rev-3');
  assert.equal(result.ok, false);
  assert.equal(result.requestId, 'req-2');
  assert.equal(result.invocationId, 'inv-2');
  assert.equal(result.authorityRevision, 'rev-3');
  assert.equal(result.error.code, 'MCP_TOOL_ERROR');
  assert.equal(result.error.message, 'Unknown tabId: tab-2');
  assert.deepEqual(result.error.details, { hint: 'retry' });
  assert.equal(result.evidence.tabId, 'tab-2');
  assert.equal(result.evidence.fallbackReason, 'unattached');
});

it('MCP result envelope carries execution data payload', () => {
  const evalResult = envelope<{ expressionResult: number }>({ expressionResult: 42 }, { tabId: 'tab-1', url: 'https://youtube.com' }, 'req-3', 'inv-3');
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.data.expressionResult, 42);
  assert.equal(evalResult.evidence.tabId, 'tab-1');
});
