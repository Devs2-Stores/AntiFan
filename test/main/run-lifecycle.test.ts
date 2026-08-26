import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../../src/main/chat/chat-store';
import { RunService } from '../../src/main/run/run-service';
import { EventStore } from '../../src/main/session/event-store';
import { ReceiptStore } from '../../src/main/session/receipt-store';

describe('Run lifecycle ownership', () => {
  it('requires an explicit Workspace cwd and persists authoritative attempt receipts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-run-'));
    const projectId = 'project-12345678901234567890';
    const workspaceId = 'workspace-12345678901234567890';
    const chatId = 'chat-12345678901234567890';
    const chats = new ChatStore();
    const chat = chats.create(projectId, workspaceId, 'QA');
    const events = new EventStore({ filePath: path.join(root, 'events.jsonl'), projectId, workspaceId });
    const receipts = new ReceiptStore({ filePath: path.join(root, 'receipts.jsonl') });
    const runs = new RunService(chats, events, receipts, () => root);
    const run = runs.createRun(projectId, workspaceId, chat.id, 'fake');
    const backend = { id: 'fake', startRun: async function* (input: any) { yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' }; }, cancel: async () => {} } as any;
    await assert.rejects(() => runs.start(run.id, 'missing cwd', backend), /Workspace cwd/);
    const attempt = await runs.start(run.id, 'bound cwd', backend, { cwd: root });
    assert.strictEqual(attempt.state, 'completed');
    assert.strictEqual(receipts.listPending().length, 0);
    assert.ok(fs.readFileSync(path.join(root, 'receipts.jsonl'), 'utf8').includes(attempt.id));
  });

  it('does not complete a receipt-requiring backend from a generic terminal status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-run-authority-'));
    const projectId = 'project-22345678901234567890';
    const workspaceId = 'workspace-22345678901234567890';
    const chats = new ChatStore();
    const chat = chats.create(projectId, workspaceId, 'Authority');
    const receipts = new ReceiptStore({ filePath: path.join(root, 'receipts.jsonl') });
    const runs = new RunService(chats, new EventStore({ filePath: path.join(root, 'events.jsonl'), projectId, workspaceId }), receipts, () => root);
    const run = runs.createRun(projectId, workspaceId, chat.id, 'antigravity');
    const backend = { id: 'antigravity', requiresAuthoritativeReceipt: true, startRun: async function* (input: any) { yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' }; }, cancel: async () => {} } as any;
    const attempt = await runs.start(run.id, 'unproven', backend, { cwd: root });
    assert.strictEqual(attempt.state, 'unknown');
    assert.strictEqual(receipts.listPending().length, 0);
  });

  it('enforces that attachments issued for an attempt are valid only while the attempt is active', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-run-attachment-'));
    const projectId = 'project-32345678901234567890';
    const workspaceId = 'workspace-32345678901234567890';
    const chats = new ChatStore();
    const chat = chats.create(projectId, workspaceId, 'AttachmentQA');
    const events = new EventStore({ filePath: path.join(root, 'events.jsonl'), projectId, workspaceId });
    const receipts = new ReceiptStore({ filePath: path.join(root, 'receipts.jsonl') });
    const runs = new RunService(chats, events, receipts, () => root);

    const run = runs.createRun(projectId, workspaceId, chat.id, 'codex');
    let backendResolve: () => void;
    const backendPromise = new Promise<void>((r) => {
      backendResolve = r;
    });
    let startedResolve: () => void;
    const startedPromise = new Promise<void>((r) => {
      startedResolve = r;
    });
    let activeAttemptId: string = '';

    const backend = {
      id: 'codex',
      startRun: async function* (input: any) {
        activeAttemptId = input.attemptId;
        yield { type: 'text', runId: input.runId, attemptId: input.attemptId, stream: 'stdout', text: 'starting' };
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

    const startPromise = runs.start(run.id, 'prompt', backend, { cwd: root });
    await startedPromise;
    assert.ok(activeAttemptId.startsWith('attempt-'));
    const activeAttempt = runs.getAttempt(activeAttemptId);
    assert.strictEqual(activeAttempt.state, 'running');

    const lease = {
      runtimeId: 'binding-32345678901234567890',
      projectId,
      workspaceId,
      token: 'tok-333',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const { launch } = runs.attachments.issueAttachment(run.id, activeAttempt.id, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });

    // 1. Once session/ref event is applied, process PID matching is automatically registered and strictly enforced
    // Omitting ownerPid when PID is bound fails with PROCESS_MISMATCH
    assert.throws(
      () =>
        runs.attachments.validateAttachment({
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          runId: run.id,
          attemptId: activeAttempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-1b-omitted',
          // ownerPid omitted
        }),
      (err: any) => err.code === 'PROCESS_MISMATCH'
    );
    // Supplying wrong PID fails with PROCESS_MISMATCH
    assert.throws(
      () =>
        runs.attachments.validateAttachment({
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          runId: run.id,
          attemptId: activeAttempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-1b-mismatch',
          ownerPid: 999999, // wrong PID
        }),
      (err: any) => err.code === 'PROCESS_MISMATCH'
    );
    const validWithPid = runs.attachments.validateAttachment({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      runId: run.id,
      attemptId: activeAttempt.id,
      projectId,
      workspaceId,
      invocationId: 'inv-1b-correct',
      ownerPid: process.pid,
    });
    assert.strictEqual(validWithPid.attachmentId, launch.attachmentId);
    // 2. Resolve backend run to complete the attempt
    backendResolve!();
    await startPromise;

    // 3. Validation fails now that the attempt is completed and attachment is revoked
    assert.throws(
      () =>
        runs.attachments.validateAttachment({
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          runId: run.id,
          attemptId: activeAttempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-2',
        }),
      (err: any) => err.code === 'ATTACHMENT_STALE' || err.code === 'ATTEMPT_NOT_ACTIVE'
    );
  });
});
