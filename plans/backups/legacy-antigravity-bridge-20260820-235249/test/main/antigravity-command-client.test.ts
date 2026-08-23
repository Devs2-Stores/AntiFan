import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  AntigravityCommandClient,
  computePromptDigest,
  validateCommandV2,
  validateResultV2,
  validateHostV2,
  generateCommandId,
  CommandClientFsSeam,
} from '../../src/main/bridge/antigravity-command-client';
import { AntigravityCommandV2, AntigravityResultV2, AntigravityHostV2 } from '../../src/shared/contracts';

function createMockFs(): { fsSeam: CommandClientFsSeam; files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const fsSeam: CommandClientFsSeam = {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string, encoding: BufferEncoding) => {
      const data = files.get(p);
      if (data === undefined) throw new Error(`ENOENT: ${p}`);
      return data;
    },
    writeFileSync: (p: string, data: string, encoding: BufferEncoding) => {
      files.set(p, data);
    },
    renameSync: (oldPath: string, newPath: string) => {
      const data = files.get(oldPath);
      if (data === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, data);
    },
    unlinkSync: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
      return p;
    },
    readdirSync: (p: string) => {
      const results: string[] = [];
      for (const filePath of files.keys()) {
        if (path.dirname(filePath) === p) {
          results.push(path.basename(filePath));
        }
      }
      return results;
    },
    statSync: (p: string) => {
      return {
        mtimeMs: Date.now(),
      } as any;
    },
  };

  return { fsSeam, files };
}

describe('AntigravityCommandClient (Protocol v2)', () => {
  it('computes deterministic SHA256 prompt digest regardless of CRLF or trailing spaces', () => {
    const d1 = computePromptDigest('Fix the button color\r\n');
    const d2 = computePromptDigest('Fix the button color\n');
    const d3 = computePromptDigest('  Fix the button color  ');
    assert.strictEqual(d1, d2);
    assert.strictEqual(d1, d3);
    assert.strictEqual(/^[a-f0-9]{64}$/.test(d1), true);
  });

  it('validates protocol v2 command document shape', () => {
    const validCmd: AntigravityCommandV2 = {
      protocolVersion: 2,
      id: generateCommandId(),
      senderId: 'antifan-desktop',
      createdAtEpochMs: Date.now(),
      expiresAtEpochMs: Date.now() + 60000,
      targetWorkspace: {
        folderUri: 'E:\\Work\\apps\\my-app',
      },
      action: 'send-prompt',
      mode: 'draft',
      promptText: 'Hello world',
      promptDigest: computePromptDigest('Hello world'),
    };
    assert.strictEqual(validateCommandV2(validCmd).ok, true);

    // Rejects v1 or corrupt versions
    assert.strictEqual(validateCommandV2({ ...validCmd, protocolVersion: 1 as any }).ok, false);
    // Rejects missing workspace
    assert.strictEqual(validateCommandV2({ ...validCmd, targetWorkspace: undefined as any }).ok, false);
    // Rejects invalid action
    assert.strictEqual(validateCommandV2({ ...validCmd, action: 'invalid-action' as any }).ok, false);
  });

  it('validates protocol v2 result document shape', () => {
    const validRes: AntigravityResultV2 = {
      protocolVersion: 2,
      commandId: 'cmd-12345678-abcd',
      hostInstanceId: 'vscode-host-1',
      hostEpoch: 1720000000,
      targetWorkspace: {
        folderUri: 'E:\\Work\\apps\\my-app',
      },
      ok: true,
      deliveryState: 'ide-api-accepted',
      completedAtEpochMs: Date.now(),
    };
    assert.strictEqual(validateResultV2(validRes).ok, true);

    // Rejects invalid deliveryState (e.g. legacy false "submitted" state)
    assert.strictEqual(validateResultV2({ ...validRes, deliveryState: 'submitted' as any }).ok, false);

    // Rejects receipt when commandId mismatches expected command
    assert.strictEqual(
      validateResultV2(validRes, { id: 'different-cmd-id', targetWorkspace: { folderUri: 'E:\\Work\\apps\\my-app' } }).ok,
      false
    );

    // Rejects receipt when targetWorkspace mismatches
    assert.strictEqual(
      validateResultV2(validRes, { id: 'cmd-12345678-abcd', targetWorkspace: { folderUri: 'C:\\Wrong\\Path' } }).ok,
      false
    );
    assert.strictEqual(
      validateResultV2(validRes, { id: 'cmd-12345678-abcd', targetWorkspace: { folderUri: 'E:\\Work\\apps' } }).ok,
      false,
      'Ancestor workspace receipts must not satisfy exact binding'
    );
  });

  it('dispatches command atomically and consumes matching receipt', async () => {
    const workspace = 'E:\\Work\\apps\\my-test-workspace';
    const { fsSeam, files } = createMockFs();

    let fakeClock = 1000;
    const client = new AntigravityCommandClient({
      workspacePath: workspace,
      pollIntervalMs: 10,
      timeoutMs: 1000,
      clock: () => fakeClock,
      fsSeam,
    });

    const { command, resultPromise } = client.dispatchCommand({
      action: 'send-prompt',
      mode: 'auto',
      promptText: 'Inspect header responsive layout',
    });

    assert.strictEqual(command.protocolVersion, 2);
    assert.strictEqual(command.mode, 'auto');
    assert.strictEqual(command.targetWorkspace.folderUri, workspace);

    const bridgeDir = path.join(workspace, '.antigravity', 'mcp-bridge');
    const commandFilePath = path.join(bridgeDir, `${command.id}.json`);
    assert.strictEqual(files.has(commandFilePath), true);

    // Simulate Extension Host writing receipt
    const resultFilePath = path.join(bridgeDir, `${command.id}.res.json`);
    const mockReceipt: AntigravityResultV2 = {
      protocolVersion: 2,
      commandId: command.id,
      hostInstanceId: 'ext-host-xyz',
      hostEpoch: 1,
      targetWorkspace: { folderUri: workspace },
      ok: true,
      deliveryState: 'ide-api-accepted',
      completedAtEpochMs: fakeClock + 50,
    };
    files.set(resultFilePath, JSON.stringify(mockReceipt));

    const result = await resultPromise;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.deliveryState, 'ide-api-accepted');
    assert.strictEqual(result.commandId, command.id);
    // Consumed receipt should be unlinked
    assert.strictEqual(files.has(resultFilePath), false);
  });

  it('transitions to unknown on timeout without auto-retrying or re-executing', async () => {
    const workspace = 'E:\\Work\\apps\\my-test-workspace';
    const { fsSeam } = createMockFs();

    let fakeClock = 1000;
    const client = new AntigravityCommandClient({
      workspacePath: workspace,
      pollIntervalMs: 10,
      timeoutMs: 50,
      lateReceiptGraceMs: 0,
      clock: () => {
        fakeClock += 20;
        return fakeClock;
      },
      fsSeam,
    });

    const { command, resultPromise } = client.dispatchCommand({
      action: 'send-prompt',
      mode: 'draft',
      promptText: 'Stalled test',
    });

    const result = await resultPromise;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.deliveryState, 'unknown');
    assert.strictEqual(result.errorCode, 'TIMEOUT_WAITING_RECEIPT');
  });

  it('keeps a timeout receipt available for one bounded late exact replacement', async () => {
    const workspace = 'E:\\Work\\apps\\my-late-replacement-workspace';
    const { fsSeam, files } = createMockFs();
    const client = new AntigravityCommandClient({ workspacePath: workspace, pollIntervalMs: 5, timeoutMs: 30, lateReceiptGraceMs: 250, fsSeam });
    const { command, resultPromise } = client.dispatchCommand({ action: 'send-prompt', mode: 'auto', promptText: 'Late replacement' });
    const resultFilePath = path.join(workspace, '.antigravity', 'mcp-bridge', `${command.id}.res.json`);
    const makeReceipt = (overrides: Partial<AntigravityResultV2>): AntigravityResultV2 => ({
      protocolVersion: 2,
      commandId: command.id,
      hostInstanceId: 'ext-host-late',
      hostEpoch: 2,
      targetWorkspace: { folderUri: workspace },
      ok: false,
      deliveryState: 'unknown',
      errorCode: 'EXECUTION_DEADLINE_EXCEEDED',
      completedAtEpochMs: Date.now(),
      ...overrides,
    });
    setTimeout(() => files.set(resultFilePath, JSON.stringify(makeReceipt({}))), 20);
    setTimeout(() => files.set(resultFilePath, JSON.stringify(makeReceipt({ ok: true, deliveryState: 'ide-api-accepted', errorCode: undefined }))), 80);
    const result = await resultPromise;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.deliveryState, 'ide-api-accepted');
    assert.strictEqual(files.has(resultFilePath), false);
  });

  it('reads host.json status if present and valid', () => {
    const workspace = 'E:\\Work\\apps\\my-test-workspace';
    const { fsSeam, files } = createMockFs();

    const client = new AntigravityCommandClient({
      workspacePath: workspace,
      fsSeam,
    });

    assert.strictEqual(client.readHostStatus(), null);

    const bridgeDir = path.join(workspace, '.antigravity', 'mcp-bridge');
    const hostFile = path.join(bridgeDir, 'host.json');
    const mockHost: AntigravityHostV2 = {
      protocolVersion: 2,
      hostInstanceId: 'vscode-1',
      hostEpoch: 12345,
      workspaceUri: workspace,
      extensionVersion: '2.0.0',
      capabilities: {
        actions: ['send-prompt', 'abort'],
        modes: ['draft', 'auto'],
        maxAttachments: 8,
        maxPayloadBytes: 15728640,
      },
      lastHeartbeatEpochMs: Date.now(),
    };
    files.set(hostFile, JSON.stringify(mockHost));

    const status = client.readHostStatus();
    assert.notStrictEqual(status, null);
    assert.strictEqual(status?.hostInstanceId, 'vscode-1');
    assert.strictEqual(status?.protocolVersion, 2);
  });

  it('probes host liveness correctly detecting fresh and stale heartbeats', () => {
    const workspace = 'E:\\Work\\apps\\my-test-workspace';
    const { fsSeam, files } = createMockFs();

    let now = 100000;
    const client = new AntigravityCommandClient({
      workspacePath: workspace,
      clock: () => now,
      fsSeam,
    });

    // 1. Missing host.json
    const probe1 = client.checkHostLiveness();
    assert.strictEqual(probe1.isLive, false);

    // 2. Fresh host.json
    const bridgeDir = path.join(workspace, '.antigravity', 'mcp-bridge');
    const hostFile = path.join(bridgeDir, 'host.json');
    const mockHost: AntigravityHostV2 = {
      protocolVersion: 2,
      hostInstanceId: 'vscode-live',
      hostEpoch: 1,
      workspaceUri: workspace,
      extensionVersion: '2.0.0',
      capabilities: {
        actions: ['send-prompt', 'abort'],
        modes: ['draft', 'auto'],
        maxAttachments: 8,
        maxPayloadBytes: 15728640,
      },
      lastHeartbeatEpochMs: now - 2000,
    };
    files.set(hostFile, JSON.stringify(mockHost));

    const probe2 = client.checkHostLiveness(15000);
    assert.strictEqual(probe2.isLive, true);

    // 3. Stale host.json (e.g. 20s ago)
    now += 30000;
    const probe3 = client.checkHostLiveness(15000);
    assert.strictEqual(probe3.isLive, false);
    assert.match(probe3.reason || '', /stale/i);
  });

  it('checks and reconciles late receipts arriving after foreground timeout', () => {
    const workspace = 'E:\\Work\\apps\\my-reconcile-workspace';
    const { fsSeam, files } = createMockFs();

    const client = new AntigravityCommandClient({
      workspacePath: workspace,
      fsSeam,
    });

    const bridgeDir = path.join(workspace, '.antigravity', 'mcp-bridge');
    const cmdId = 'cmd-late-999';
    const resFile = path.join(bridgeDir, `${cmdId}.res.json`);

    // 1. Before late receipt arrives: null
    assert.strictEqual(client.checkLateReceipt(cmdId), null);

    // 2. Late receipt arrives on disk
    const lateReceipt: AntigravityResultV2 = {
      protocolVersion: 2,
      commandId: cmdId,
      hostInstanceId: 'vscode-host',
      hostEpoch: 1,
      targetWorkspace: { folderUri: workspace },
      ok: true,
      deliveryState: 'ide-api-accepted',
      actualRoute: 'sidecar-agentapi',
      completedAtEpochMs: Date.now(),
    };
    files.set(resFile, JSON.stringify(lateReceipt));

    // 3. checkLateReceipt returns valid result and unlinks the consumed receipt
    const found = client.checkLateReceipt(cmdId);
    assert.notStrictEqual(found, null);
    assert.strictEqual(found?.deliveryState, 'ide-api-accepted');
    assert.strictEqual(found?.actualRoute, 'sidecar-agentapi');
    assert.strictEqual(files.has(resFile), false, 'Consumed late receipt must be unlinked');

    // 4. scanAndReconcileLateReceipts
    const cmdId2 = 'cmd-late-888';
    const resFile2 = path.join(bridgeDir, `${cmdId2}.res.json`);
    files.set(resFile2, JSON.stringify({ ...lateReceipt, commandId: cmdId2, deliveryState: 'ide-api-accepted' }));

    const batch = client.scanAndReconcileLateReceipts([cmdId2, 'cmd-not-exist']);
    assert.strictEqual(batch.size, 1);
    assert.strictEqual(batch.get(cmdId2)?.deliveryState, 'ide-api-accepted');
  });
});
