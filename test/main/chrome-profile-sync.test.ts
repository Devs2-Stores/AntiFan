import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';

describe('ChromeProfileSyncManager Invariants', () => {
  it('discovers local Chrome profiles or provides default fallback', () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const profiles = manager.getAvailableProfiles();

    assert.strictEqual(Array.isArray(profiles), true);
    if (profiles.length > 0 && profiles[0]) {
      assert.strictEqual(typeof profiles[0].id, 'string');
      assert.strictEqual(typeof profiles[0].name, 'string');
    }
  });

  it('safely copies locked files without throwing EBUSY', () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const tmpSrc = path.join(os.tmpdir(), `test-lock-src-${Date.now()}.txt`);
    const tmpDst = path.join(os.tmpdir(), `test-lock-dst-${Date.now()}.txt`);

    fs.writeFileSync(tmpSrc, 'test cookie data content', 'utf8');
    const ok = manager.safeCopyLockedFile(tmpSrc, tmpDst);

    assert.strictEqual(ok, true);
    assert.strictEqual(fs.existsSync(tmpDst), true);
    assert.strictEqual(fs.readFileSync(tmpDst, 'utf8'), 'test cookie data content');

    try { fs.unlinkSync(tmpSrc); } catch {}
    try { fs.unlinkSync(tmpDst); } catch {}
  });
});
