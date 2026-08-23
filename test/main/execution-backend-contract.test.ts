import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DeepSeekHarnessAdapter } from '../../src/main/agent/deepseek-harness-adapter';

describe('Execution backend contracts', () => {
  it('keeps DeepSeek Harness behind an opt-in compatibility adapter', () => {
    const adapter = new DeepSeekHarnessAdapter();
    delete process.env[adapter.featureFlag];
    assert.strictEqual(adapter.mapEvent({ type: 'assistant/message', text: 'hello' }, { runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890' }), null);
    process.env[adapter.featureFlag] = '1';
    assert.strictEqual(adapter.mapEvent({ type: 'assistant/message', text: 'hello' }, { runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890' })?.type, 'text');
    delete process.env[adapter.featureFlag];
  });
});
