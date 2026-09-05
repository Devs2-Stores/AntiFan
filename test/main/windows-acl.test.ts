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
