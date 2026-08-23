import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TranscriptSyncer } from '../../src/main/bridge/transcript-syncer';

describe('TranscriptSyncer Security & Containment Invariants', () => {
  it('rejects path traversal in deleteSession and renameSession', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sec-test-'));
    const brainDir = path.join(tmpBase, 'brain');
    const outsideDir = path.join(tmpBase, 'sensitive-outside');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Create a legitimate session inside brain
    const validSessionId = '11111111-2222-3333-4444-555555555555';
    const validSessionDir = path.join(brainDir, validSessionId);
    fs.mkdirSync(validSessionDir, { recursive: true });
    fs.writeFileSync(path.join(validSessionDir, 'session_title.txt'), 'Valid Session', 'utf8');

    // Create a sensitive file outside brain
    const sensitiveFile = path.join(outsideDir, 'important-data.txt');
    fs.writeFileSync(sensitiveFile, 'TOP_SECRET', 'utf8');

    const syncer = new TranscriptSyncer(brainDir);

    // 1. Attempt path traversal delete: ../sensitive-outside
    const deleteTraversalResult = syncer.deleteSession('../sensitive-outside');
    assert.strictEqual(deleteTraversalResult, false, 'deleteSession must reject path traversal attempt');
    assert.strictEqual(fs.existsSync(sensitiveFile), true, 'Sensitive file outside brain must remain untouched');

    // 2. Attempt path traversal rename
    const renameTraversalResult = syncer.renameSession('../sensitive-outside', 'Hacked Title');
    assert.strictEqual(renameTraversalResult, false, 'renameSession must reject path traversal attempt');
    assert.strictEqual(fs.existsSync(path.join(outsideDir, 'session_title.txt')), false, 'Must not create file outside brain');

    // 3. Legitimate session inside catalog can be renamed and deleted
    const renameOk = syncer.renameSession(validSessionId, 'New Valid Title');
    assert.strictEqual(renameOk, true);
    assert.strictEqual(fs.readFileSync(path.join(validSessionDir, 'session_title.txt'), 'utf8'), 'New Valid Title');

    const deleteOk = syncer.deleteSession(validSessionId);
    assert.strictEqual(deleteOk, true);
    assert.strictEqual(fs.existsSync(validSessionDir), false, 'Legitimate session inside brain is removed');

    // Cleanup
    syncer.dispose();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  });
});
