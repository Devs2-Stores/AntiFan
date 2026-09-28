import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WINDOWS_ACL_SPAWN_TIMEOUT_MS,
  _resetCachedUserSidForTesting,
  resolveCurrentUserSid,
  hasProtectedDirectoryDacl,
  enforceProtectedDirectoryDacl,
  hasProtectedFileDacl,
  enforceProtectedFileDacl,
  atomicWriteWithDacl,
} from '../../src/main/security/windows-acl';

test('windows-acl: WINDOWS_ACL_SPAWN_TIMEOUT_MS deadline sits within house bounds', () => {
  // Sits far above measured execution (50-2500ms) and well below caller durability timeout (30s+)
  assert.ok(
    WINDOWS_ACL_SPAWN_TIMEOUT_MS >= 5_000 && WINDOWS_ACL_SPAWN_TIMEOUT_MS <= 30_000,
    `Timeout ${WINDOWS_ACL_SPAWN_TIMEOUT_MS}ms must be between 5s and 30s`
  );
});

test('resolveCurrentUserSid: bounded timeout kills child and rejects on expiration', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only');
    return;
  }

  // Clear cache so whoami must be spawned
  _resetCachedUserSidForTesting();

  // Spawning whoami with an impossible 1ms deadline must trigger timeout guard and reject
  await assert.rejects(
    async () => {
      await resolveCurrentUserSid(1);
    },
    (err: unknown) => {
      assert.ok(err instanceof Error, 'Expected rejection to be an Error');
      // Node child_process sets killed: true and code: 'ETIMEDOUT' on timeout expiry
      const cpErr = err as Error & { killed?: boolean; code?: string; signal?: string };
      const isTimeout = cpErr.killed === true || cpErr.code === 'ETIMEDOUT' || cpErr.signal === 'SIGKILL';
      assert.ok(isTimeout, `Expected timeout termination, got: ${err.message}`);
      return true;
    }
  );

  // Normal execution without timeout override succeeds within healthy bounds
  _resetCachedUserSidForTesting();
  const sid = await resolveCurrentUserSid();
  assert.match(sid, /^S-1-5-\d+(-\d+)+$/);
});

test('hasProtectedDirectoryDacl: timeout during icacls read safely returns false (needs repair direction)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only');
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `antifan-timeout-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const userSid = await resolveCurrentUserSid();
    await enforceProtectedDirectoryDacl(tmpDir, userSid);

    // Normal query with default timeout reports true (protected)
    const healthyResult = await hasProtectedDirectoryDacl(tmpDir, userSid);
    assert.equal(healthyResult, true, 'Healthy DACL check must report true for protected directory');

    // Query with 1ms deadline expires icacls: must return false (needs repair), NOT true (invented success)
    const timedOutResult = await hasProtectedDirectoryDacl(tmpDir, userSid, 1);
    assert.equal(timedOutResult, false, 'Timeout on DACL query must return false (needs repair direction)');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('hasProtectedFileDacl: timeout during icacls read safely returns false (needs repair direction)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only');
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `antifan-timeout-file-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ ok: true }), 'utf8');

  try {
    const userSid = await resolveCurrentUserSid();
    await enforceProtectedFileDacl(tmpFile, userSid);

    // Normal query reports true
    const healthyResult = await hasProtectedFileDacl(tmpFile, userSid);
    assert.equal(healthyResult, true, 'Healthy DACL check must report true for protected file');

    // Query with 1ms deadline expires icacls: must return false (needs repair), never true
    const timedOutResult = await hasProtectedFileDacl(tmpFile, userSid, 1);
    assert.equal(timedOutResult, false, 'Timeout on file DACL query must return false (needs repair direction)');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('enforceProtectedDirectoryDacl: timeout during powershell repair rejects cleanly without hang', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only');
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `antifan-repair-timeout-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const userSid = await resolveCurrentUserSid();

    // 1ms deadline forces powershell spawn to terminate immediately on timeout
    await assert.rejects(
      async () => {
        await enforceProtectedDirectoryDacl(tmpDir, userSid, 1);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Expected rejection to be an Error');
        const cpErr = err as Error & { killed?: boolean; code?: string; signal?: string };
        const isTimeout = cpErr.killed === true || cpErr.code === 'ETIMEDOUT' || cpErr.signal === 'SIGKILL';
        assert.ok(isTimeout, `Expected timeout termination from powershell, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('atomicWriteWithDacl: writes content atomically under bounded execution and cleans up temp files', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only');
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `antifan-atomic-bound-${Date.now()}`);
  const targetFile = path.join(tmpDir, 'store.json');
  const payload = JSON.stringify({ state: 'healthy', timestamp: Date.now() });

  try {
    await atomicWriteWithDacl(targetFile, payload);
    assert.ok(fs.existsSync(targetFile), 'Target file must exist');
    assert.equal(fs.readFileSync(targetFile, 'utf8'), payload);

    const userSid = await resolveCurrentUserSid();
    assert.equal(await hasProtectedFileDacl(targetFile, userSid), true);

    // Verify no leftover .tmp files
    const entries = fs.readdirSync(tmpDir).filter((e) => e.endsWith('.tmp'));
    assert.equal(entries.length, 0, 'No leftover temporary files');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
