import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReceiptStore } from '../../src/main/session/receipt-store';

describe('Authoritative receipt store', () => {
  it('accepts exact late reconciliation and rejects mismatched binding', () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-receipts-')), 'receipts.jsonl');
    const store = new ReceiptStore({ filePath });
    const binding = { commandId: 'cmd-1', promptDigest: 'a'.repeat(64), projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890', canonicalWorkspace: 'c:/workspace', hostInstanceId: 'host-1', hostEpoch: 1, attemptId: 'attempt-12345678901234567890', backendSessionRef: 'session-1' };
    store.put(binding, 'unknown', 'unknown');
    const exact = store.reconcile(binding, { formatVersion: 1, id: 'receipt-late', binding, state: 'completed', deliveryState: 'accepted-exact', createdAt: Date.now() });
    assert.strictEqual(exact.state, 'completed');
    assert.throws(() => store.reconcile({ ...binding, promptDigest: 'b'.repeat(64) }, { formatVersion: 1, id: 'receipt-bad', binding: { ...binding, promptDigest: 'b'.repeat(64) }, state: 'completed', deliveryState: 'accepted-exact', createdAt: Date.now() }));
  });
});
