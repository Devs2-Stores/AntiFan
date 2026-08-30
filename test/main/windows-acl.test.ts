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
  setupSecureRuntimeAuth,
  writeRuntimeAuthFile,
  removeRuntimeAuthFile,
  isProcessAlive
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

test('setupSecureRuntimeAuth: generates launchNonce, enforces DACL and writes bridge-auth.json', () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-runtime-test-${Date.now()}`);
  const instanceUuid = '12345678-1234-1234-1234-123456789abc';
  const launchNonce = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const port = 20129;

  const result = setupSecureRuntimeAuth(instanceUuid, launchNonce, port, tmpRuntimeDir);

  assert.equal(result.runtimeDir, tmpRuntimeDir);
  assert.equal(fs.existsSync(result.authFile), true);
  assert.equal(result.socketPath, `\\\\.\\pipe\\antifan-bridge-ipc-${instanceUuid}`);

  const parsed = JSON.parse(fs.readFileSync(result.authFile, 'utf8'));
  assert.equal(parsed.instanceUuid, instanceUuid);
  assert.equal(parsed.launchNonce, launchNonce);
  assert.equal(parsed.port, port);
  assert.equal(parsed.socketPath, result.socketPath);
  assert.equal(hasProtectedDirectoryDacl(tmpRuntimeDir, resolveCurrentUserSid()), true);
  assert.ok(parsed.createdAt > 0);

  // Clean up
  try {
    fs.rmSync(tmpRuntimeDir, { recursive: true, force: true });
  } catch {}
});

test('isProcessAlive: correctly reports current process alive and fake PID dead', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(99999999), false);
  assert.equal(isProcessAlive(-1), false);
});

test('removeRuntimeAuthFile: conditionally removes auth file only when instanceUuid matches', () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-remove-auth-${Date.now()}`);
  const uuid1 = '11111111-1111-1111-1111-111111111111';
  const uuid2 = '22222222-2222-2222-2222-222222222222';

  writeRuntimeAuthFile({
    instanceUuid: uuid1,
    launchNonce: 'nonce-1',
    socketPath: `\\\\.\\pipe\\ipc-${uuid1}`,
    port: 20129,
    pid: process.pid,
    createdAt: Date.now(),
  }, tmpRuntimeDir);

  assert.equal(fs.existsSync(path.join(tmpRuntimeDir, 'bridge-auth.json')), true);

  // Attempt removal with wrong UUID -> should return false and keep file
  const removedWrong = removeRuntimeAuthFile(uuid2, tmpRuntimeDir);
  assert.equal(removedWrong, false);
  assert.equal(fs.existsSync(path.join(tmpRuntimeDir, 'bridge-auth.json')), true);

  // Attempt removal with matching UUID -> should return true and delete file
  const removedRight = removeRuntimeAuthFile(uuid1, tmpRuntimeDir);
  assert.equal(removedRight, true);
  assert.equal(fs.existsSync(path.join(tmpRuntimeDir, 'bridge-auth.json')), false);

  try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
});
