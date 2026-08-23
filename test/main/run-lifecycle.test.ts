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
    const runs = new RunService(chats, events, receipts);
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
    const runs = new RunService(chats, new EventStore({ filePath: path.join(root, 'events.jsonl'), projectId, workspaceId }), receipts);
    const run = runs.createRun(projectId, workspaceId, chat.id, 'antigravity');
    const backend = { id: 'antigravity', requiresAuthoritativeReceipt: true, startRun: async function* (input: any) { yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' }; }, cancel: async () => {} } as any;
    const attempt = await runs.start(run.id, 'unproven', backend, { cwd: root });
    assert.strictEqual(attempt.state, 'unknown');
    assert.strictEqual(receipts.listPending().length, 0);
  });
});
