import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveCurrentUserSid,
  enforceProtectedDirectoryDacl,
  setupSecureRuntimeAuth
} from '../../src/main/native-messaging/windows-acl';

test('resolveCurrentUserSid: returns valid Windows SID format', () => {
  const sid = resolveCurrentUserSid();
  assert.ok(sid, 'SID should not be empty');
  assert.match(sid, /^S-1-5-\d+(-\d+)+$/, 'SID should match standard Windows S-1-5-... format');
});

test('enforceProtectedDirectoryDacl: successfully applies and verifies DACL invariants on Windows', () => {
  const tmpDir = path.join(os.tmpdir(), `antifan-acl-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const userSid = resolveCurrentUserSid();

  // Should succeed with valid User SID
  assert.doesNotThrow(() => {
    enforceProtectedDirectoryDacl(tmpDir, userSid);
  });

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
  assert.ok(parsed.createdAt > 0);

  // Clean up
  try {
    fs.rmSync(tmpRuntimeDir, { recursive: true, force: true });
  } catch {}
});
