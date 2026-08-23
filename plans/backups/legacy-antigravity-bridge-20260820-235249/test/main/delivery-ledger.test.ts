import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DeliveryLedger } from '../../src/main/bridge/delivery-ledger';

describe('DeliveryLedger Invariants', () => {
  it('records, persists, and updates delivery states across instances', () => {
    const tmpLedger = path.join(os.tmpdir(), `test-ledger-${Date.now()}.json`);
    const ledger1 = new DeliveryLedger(tmpLedger);

    ledger1.record({
      commandId: 'cmd-test-1',
      messageId: 'msg-1',
      sessionId: 'session-123',
      workspaceUri: 'E:\\Work\\apps\\test',
      promptText: 'Audit UI state',
      promptDigest: '1111111111111111111111111111111111111111111111111111111111111111',
      deliveryState: 'queued',
      createdAtEpochMs: Date.now(),
    });

    assert.strictEqual(ledger1.getByCommandId('cmd-test-1')?.deliveryState, 'queued');

    // Update status
    ledger1.updateStatus('cmd-test-1', 'ide-api-accepted');
    assert.strictEqual(ledger1.getByCommandId('cmd-test-1')?.deliveryState, 'ide-api-accepted');

    // Second instance loading same persistent file
    const ledger2 = new DeliveryLedger(tmpLedger);
    const rec = ledger2.getByPromptDigest('1111111111111111111111111111111111111111111111111111111111111111');
    assert.notStrictEqual(rec, undefined);
    assert.strictEqual(rec?.commandId, 'cmd-test-1');
    assert.strictEqual(rec?.deliveryState, 'ide-api-accepted');

    try { fs.unlinkSync(tmpLedger); } catch {}
  });
});
