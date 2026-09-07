import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveCurrentUserSid,
  parseSavedDirectorySddl,
  hasProtectedDirectoryDacl,
  enforceProtectedDirectoryDacl,
} from '../../src/main/security/windows-acl';
import {
  setupSecureRuntimeAuth,
} from '../../src/main/native-messaging/windows-acl';

test('resolveCurrentUserSid: returns valid Windows SID format', () => {
  const sid = resolveCurrentUserSid();
  assert.ok(sid, 'SID should not be empty');
  assert.match(sid, /^S-1-5-\d+(-\d+)+$/, 'SID should match standard Windows S-1-5-... format');
});

test('parseSavedDirectorySddl: does not confuse a D drive path with its SDDL', () => {
  const savedAcl = 'D:\\Work\\.antifan-data\\runtime\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)\r\n';
  assert.equal(
    parseSavedDirectorySddl(savedAcl),
    'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)'
  );
});

test('enforceProtectedDirectoryDacl: successfully applies and verifies DACL invariants on Windows', () => {
  const tmpDir = path.join(os.tmpdir(), `antifan-acl-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const userSid = resolveCurrentUserSid();

  // Should succeed with valid User SID
  assert.doesNotThrow(() => {
    enforceProtectedDirectoryDacl(tmpDir, userSid);
  });
  assert.equal(hasProtectedDirectoryDacl(tmpDir, userSid), true);
  assert.doesNotThrow(() => enforceProtectedDirectoryDacl(tmpDir, userSid));

  // Clean up
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test('setupSecureRuntimeAuth: succeeds on fresh directory and survives re-execution on existing protected directory', () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-runtime-test-${Date.now()}`);
  fs.mkdirSync(tmpRuntimeDir, { recursive: true });

  try {
    // First run on fresh directory
    const res1 = setupSecureRuntimeAuth('test-uuid-1', 'test-nonce-1', 12345, tmpRuntimeDir);
    assert.equal(res1.runtimeDir, tmpRuntimeDir);
    assert.ok(fs.existsSync(res1.authFile));
    const auth1 = JSON.parse(fs.readFileSync(res1.authFile, 'utf8'));
    assert.equal(auth1.instanceUuid, 'test-uuid-1');
    assert.equal(auth1.launchNonce, 'test-nonce-1');
    assert.equal(auth1.port, 12345);

    // Second run on already protected directory (must NOT fail with SeSecurityPrivilege)
    const res2 = setupSecureRuntimeAuth('test-uuid-2', 'test-nonce-2', 54321, tmpRuntimeDir);
    assert.equal(res2.runtimeDir, tmpRuntimeDir);
    assert.ok(fs.existsSync(res2.authFile));
    const auth2 = JSON.parse(fs.readFileSync(res2.authFile, 'utf8'));
    assert.equal(auth2.instanceUuid, 'test-uuid-2');
    assert.equal(auth2.launchNonce, 'test-nonce-2');
    assert.equal(auth2.port, 54321);

    const userSid = resolveCurrentUserSid();
    assert.equal(hasProtectedDirectoryDacl(tmpRuntimeDir, userSid), true);
  } finally {
    try {
      fs.rmSync(tmpRuntimeDir, { recursive: true, force: true });
    } catch {}
  }
});
