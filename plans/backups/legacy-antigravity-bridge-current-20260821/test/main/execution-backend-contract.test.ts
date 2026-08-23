import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DeepSeekHarnessAdapter } from '../../src/main/agent/deepseek-harness-adapter';
import { AntigravityExecutionBackend } from '../../src/main/integrations/antigravity/antigravity-execution-backend';
import { computePromptDigest } from '../../src/main/bridge/antigravity-command-client';

describe('Execution backend contracts', () => {
  it('keeps DeepSeek Harness behind an opt-in compatibility adapter', () => {
    const adapter = new DeepSeekHarnessAdapter();
    delete process.env[adapter.featureFlag];
    assert.strictEqual(adapter.mapEvent({ type: 'assistant/message', text: 'hello' }, { runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890' }), null);
    process.env[adapter.featureFlag] = '1';
    assert.strictEqual(adapter.mapEvent({ type: 'assistant/message', text: 'hello' }, { runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890' })?.type, 'text');
    delete process.env[adapter.featureFlag];
  });

  it('requires bound cwd and keeps caller timeout above the companion deadline', async () => {
    let received: any;
    const backend = new AntigravityExecutionBackend({ clientFactory: (workspacePath) => {
      assert.ok(workspacePath.length > 0);
      return { readHostStatus: () => ({ hostInstanceId: 'host-test', hostEpoch: 7 }), dispatchCommand: (params: any) => { received = params; return { command: { id: 'cmd-test' }, resultPromise: Promise.resolve({ ok: true, deliveryState: 'ide-api-accepted', commandId: 'cmd-test', hostInstanceId: 'host-test', hostEpoch: 7, targetWorkspace: { folderUri: workspacePath }, promptDigest: computePromptDigest('test'), projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890', attemptId: 'attempt-12345678901234567890', backendSessionRef: 'provider-session-1' }) }; }, cancelPending: () => {} } as any;
    } });
    const events = [];
    for await (const event of backend.startRun({ runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890', projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890', chatId: 'chat-12345678901234567890', promptText: 'test', cwd: 'E:\\Work\\workspace', timeoutMs: 1, backendSessionRef: { backendId: 'antigravity', providerSessionId: 'provider-session-1', opaqueRef: 'opaque-1', createdAt: Date.now() } })) events.push(event);
    assert.ok(received.timeoutMs >= 35_000);
    await assert.rejects(async () => { for await (const _event of backend.startRun({ runId: 'run-22345678901234567890', attemptId: 'attempt-22345678901234567890', projectId: 'project-22345678901234567890', workspaceId: 'workspace-12345678901234567890', chatId: 'chat-12345678901234567890', promptText: 'test', cwd: '' })) {} }, /Workspace cwd/);
  });

  it('rejects a terminal receipt with mismatched command or host binding', async () => {
    const session = { backendId: 'antigravity', opaqueRef: 'opaque-test', providerSessionId: 'session-test', createdAt: Date.now() };
    const backend = new AntigravityExecutionBackend({ clientFactory: (workspacePath) => ({
      readHostStatus: () => ({ hostInstanceId: 'host-test', hostEpoch: 7 }),
      dispatchCommand: () => ({ command: { id: 'cmd-actual' }, resultPromise: Promise.resolve({ ok: true, deliveryState: 'ide-api-accepted', commandId: 'cmd-other', hostInstanceId: 'host-other', hostEpoch: 8, targetWorkspace: { folderUri: workspacePath }, promptDigest: computePromptDigest('test'), projectId: 'project-32345678901234567890', workspaceId: 'workspace-32345678901234567890', attemptId: 'attempt-32345678901234567890', backendSessionRef: 'provider-session-2' }) }),
      cancelPending: () => {},
    }) as any });
    await assert.rejects(async () => {
      for await (const _event of backend.startRun({ runId: 'run-32345678901234567890', attemptId: 'attempt-32345678901234567890', projectId: 'project-32345678901234567890', workspaceId: 'workspace-32345678901234567890', chatId: 'chat-32345678901234567890', promptText: 'test', cwd: 'E:\\Work\\workspace', backendSessionRef: { backendId: 'antigravity', providerSessionId: 'provider-session-2', opaqueRef: 'opaque-2', createdAt: Date.now() } })) {}
    }, /validated command and host binding/);
  });
});

