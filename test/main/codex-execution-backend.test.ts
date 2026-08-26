import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodexExecutionBackend,
  resolveApprovedExecutable,
} from '../../src/main/agent/codex-execution-backend';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('CodexExecutionBackend & Approved Executable Security', () => {
  it('rejects bare commands, relative paths, and unapproved executables', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-codex-test-'));
    const dummyExe = path.join(tmpDir, process.platform === 'win32' ? 'codex.cmd' : 'codex.sh');
    fs.writeFileSync(dummyExe, '#!/bin/sh\nexit 0\n');

    // No approved executables configured
    assert.throws(
      () => resolveApprovedExecutable(dummyExe, []),
      (err: any) => err instanceof CapabilityError && err.code === 'LAUNCH_ERROR'
    );

    // Bare command
    assert.throws(
      () => resolveApprovedExecutable('codex', [dummyExe]),
      (err: any) => err instanceof CapabilityError && err.code === 'LAUNCH_ERROR'
    );

    // Relative path
    assert.throws(
      () => resolveApprovedExecutable('./codex.sh', [dummyExe]),
      (err: any) => err instanceof CapabilityError && err.code === 'LAUNCH_ERROR'
    );

    // Non-existent path
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    assert.throws(
      () => resolveApprovedExecutable(nonExistent, [dummyExe]),
      (err: any) => err instanceof CapabilityError && err.code === 'LAUNCH_ERROR'
    );

    // Unapproved file
    const otherExe = path.join(tmpDir, 'other.cmd');
    fs.writeFileSync(otherExe, 'exit 0');
    assert.throws(
      () => resolveApprovedExecutable(otherExe, [dummyExe]),
      (err: any) => err instanceof CapabilityError && err.code === 'LAUNCH_ERROR'
    );

    // Valid approved absolute file
    const resolved = resolveApprovedExecutable(dummyExe, [dummyExe]);
    assert.ok(resolved);
  });

  it('rejects outside-workspace cwd before spawn', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-codex-ws-'));
    const wsRoot = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(wsRoot);
    fs.mkdirSync(outsideDir);

    const dummyExe = path.join(tmpDir, 'dummy.cmd');
    fs.writeFileSync(dummyExe, 'exit 0');

    let spawnCalled = 0;
    const fakeSpawn = (() => {
      spawnCalled++;
      return {} as any;
    }) as any;

    const backend = new CodexExecutionBackend({
      executable: dummyExe,
      approvedExecutables: [dummyExe],
      spawn: fakeSpawn,
    });

    const runId = 'run-12345678901234567890';
    const attemptId = 'attempt-12345678901234567890';

    await assert.rejects(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of backend.startRun({
          runId,
          attemptId,
          projectId: 'project-12345678901234567890',
          workspaceId: 'workspace-12345678901234567890',
          chatId: 'chat-12345678901234567890',
          promptText: 'test prompt',
          cwd: outsideDir,
          canonicalWorkspaceRoot: wsRoot,
        })) {
          // should not yield
        }
      },
      (err: any) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
    );

    assert.strictEqual(spawnCalled, 0, 'Spawn must never be called on path rejection');
  });

  it('passes secret via environment variable and NEVER in argv', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-codex-sec-'));
    const wsRoot = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsRoot);

    const dummyExe = path.join(tmpDir, 'dummy.cmd');
    fs.writeFileSync(dummyExe, 'exit 0');

    let capturedArgs: any[] = [];
    let capturedOptions: any = {};
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');

    const fakeSpawn = ((exe: string, args: any[], opts: any) => {
      capturedArgs = args;
      capturedOptions = opts;
      const cp = new EventEmitter() as any;
      cp.pid = 12345;
      cp.stdout = Readable.from(['{"type":"thread.started"}\n', '{"type":"message","text":"hello"}\n']);
      cp.stderr = Readable.from([]);
      cp.exitCode = null;
      setTimeout(() => {
        cp.exitCode = 0;
        cp.emit('exit', 0, null);
        cp.emit('close', 0);
      }, 20);
      return cp;
    }) as any;

    const backend = new CodexExecutionBackend({
      executable: dummyExe,
      approvedExecutables: [dummyExe],
      spawn: fakeSpawn,
    });

    const runId = 'run-12345678901234567890';
    const attemptId = 'attempt-12345678901234567890';
    const secret = 'super-secret-high-entropy-token-123456';

    const events: any[] = [];
    for await (const event of backend.startRun({
      runId,
      attemptId,
      projectId: 'project-12345678901234567890',
      workspaceId: 'workspace-12345678901234567890',
      chatId: 'chat-12345678901234567890',
      promptText: 'analyze code',
      cwd: wsRoot,
      canonicalWorkspaceRoot: wsRoot,
      attachmentLaunch: {
        attachmentId: 'attachment-12345678901234567890',
        runId,
        attemptId,
        projectId: 'project-12345678901234567890',
        workspaceId: 'workspace-12345678901234567890',
        secret,
        backendId: 'codex',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        hostEpoch: 1,
      },
    })) {
      events.push(event);
    }

    // Secret must NOT be in command line arguments
    assert.strictEqual(JSON.stringify(capturedArgs).includes(secret), false, 'Secret must not be in argv');
    assert.deepStrictEqual(capturedArgs, ['exec', '--json', 'analyze code']);

    // Secret MUST be in environment
    assert.strictEqual(capturedOptions.env?.ANTIFAN_ATTACHMENT_SECRET, secret);
    assert.strictEqual(capturedOptions.env?.ANTIFAN_RUN_ID, runId);
    assert.strictEqual(capturedOptions.env?.ANTIFAN_ATTEMPT_ID, attemptId);

    // Events must include starting, session/ref, streaming, text, completed
    assert.ok(events.some((e) => e.type === 'status' && e.state === 'starting'));
    assert.ok(events.some((e) => e.type === 'session/ref'));
    assert.ok(events.some((e) => e.type === 'text' && e.text === 'hello'));
    assert.ok(events.some((e) => e.type === 'status' && e.state === 'completed'));
  });
});
