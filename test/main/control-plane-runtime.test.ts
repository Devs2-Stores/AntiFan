import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId } from '../../src/shared/control-plane-contracts';

describe('ControlPlaneRuntime Main Launch Owner & Attachment Authority', () => {
  it('issues attempt attachments bound to authoritative runtime lease and host epoch', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
        hostEpoch: 5,
      });

      runtime.projects.registerProject({
        id: projectId,
        name: 'Project',
        dataRoot,
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.workspaces.register({
        id: workspaceId,
        projectId,
        rootPath: workspaceRoot,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const chat = runtime.chats.create(projectId, workspaceId, 'Test Chat');
      const run = runtime.runs.createRun(projectId, workspaceId, chat.id, 'codex');

      let activeAttemptId = '';
      let finishBackend: () => void;
      const backendPromise = new Promise<void>((r) => { finishBackend = r; });
      let startedResolve: () => void;
      const startedPromise = new Promise<void>((r) => { startedResolve = r; });

      const backend = {
        id: 'codex',
        startRun: async function* (input: any) {
          activeAttemptId = input.attemptId;
          yield { type: 'text', runId: input.runId, attemptId: input.attemptId, stream: 'stdout', text: 'started' };
          yield {
            type: 'session/ref',
            runId: input.runId,
            attemptId: input.attemptId,
            sessionRef: { backendId: 'codex', opaqueRef: `${input.runId}:${input.attemptId}`, processPid: process.pid, createdAt: Date.now() },
          };
          startedResolve();
          await backendPromise;
          yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' };
        },
        cancel: async () => {},
      } as any;

      const runPromise = runtime.runs.start(run.id, 'prompt', backend, { cwd: workspaceRoot });
      await startedPromise;

      const { launch, record } = runtime.issueAttemptAttachment(run.id, activeAttemptId, {
        backendId: 'codex',
        chatId: chat.id,
        grant: 'execute',
      });

      assert.ok(launch.attachmentId.startsWith('binding-'));
      assert.strictEqual(launch.runId, run.id);
      assert.strictEqual(launch.attemptId, activeAttemptId);
      assert.strictEqual(launch.hostEpoch, 5);
      assert.strictEqual(record.grant, 'execute');
      assert.strictEqual(record.lease?.hostEpoch, 5);

      // Validate attachment against the runtime's runs attachment registry
      const validated = runtime.runs.attachments.validateAttachment({
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId: run.id,
        attemptId: activeAttemptId,
        projectId,
        workspaceId,
        invocationId: 'inv-runtime-1',
        ownerPid: process.pid,
      });

      assert.strictEqual(validated.attachmentId, launch.attachmentId);
      assert.strictEqual(validated.grant, 'execute');
      assert.strictEqual(validated.hostEpoch, 5);

      finishBackend!();
      await runPromise;
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
