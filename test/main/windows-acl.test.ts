import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveCurrentUserSid,
  parseSavedDirectorySddl,
  parseSavedFileSddl,
  parseSavedSddl,
  hasProtectedDirectoryDacl,
  enforceProtectedDirectoryDacl,
  hasProtectedFileDacl,
  enforceProtectedFileDacl,
  buildFileAclScript,
  buildDirectoryAclScript,
  verifyProtectedSddl,
  applyProtectedFileDacl,
  atomicWriteWithDacl,
  FileDaclResult,
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
  const savedAcl = 'D:\\Project\\.antifan-data\\runtime\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)\r\n';
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

test('file DACL helpers: exercise script generation and SDDL parsing behavior on concrete inputs', () => {
  const dummySid = 'S-1-5-21-1234567890-1234567890-1234567890-1001';
  const targetFilePath = 'C:\\test\\secure-file.json';
  const targetDirPath = 'C:\\test\\secure-dir';

  // buildFileAclScript behavior
  const fileScript = buildFileAclScript(targetFilePath, dummySid);
  assert.ok(fileScript.includes(`$file = '${targetFilePath.replace(/'/g, "''")}';`), 'File script must target exact path');
  assert.ok(fileScript.includes(`SecurityIdentifier('${dummySid}')`), 'File script must include target user SID');
  assert.ok(fileScript.includes(`SecurityIdentifier('S-1-5-18')`), 'File script must include SYSTEM SID');
  assert.ok(fileScript.includes('FileSecurity'), 'File script must instantiate FileSecurity');
  assert.ok(fileScript.includes('SetAccessRuleProtection($true, $false)'), 'File script must protect DACL against inheritance');

  // buildDirectoryAclScript behavior
  const dirScript = buildDirectoryAclScript(targetDirPath, dummySid);
  assert.ok(dirScript.includes(`$dir = '${targetDirPath.replace(/'/g, "''")}';`), 'Directory script must target directory path');
  assert.ok(dirScript.includes(`SecurityIdentifier('${dummySid}')`), 'Directory script must include target user SID');
  assert.ok(dirScript.includes('DirectorySecurity'), 'Directory script must instantiate DirectorySecurity');
  assert.ok(dirScript.includes('ContainerInherit, ObjectInherit'), 'Directory script must include inheritance flags');

  // parseSavedFileSddl & parseSavedSddl behavior
  const sampleAcl = 'some-header\r\nD:PAI(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1-2-3-1001)\r\n';
  assert.equal(parseSavedFileSddl(sampleAcl), 'D:PAI(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1-2-3-1001)');
  assert.equal(parseSavedSddl(sampleAcl), 'D:PAI(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1-2-3-1001)');
  assert.equal(parseSavedFileSddl('no dacl in this text'), null);
  assert.equal(parseSavedSddl(''), null);
});

test('enforceProtectedFileDacl: on non-Windows reports not-enforced without throwing', () => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const dummyPath = '/var/run/antifan/test-token.json';
    const dummySid = 'S-1-5-21-1000000000-2000000000-3000000000-1001';

    // Should NOT throw even with dummy paths / non-existent files on non-Windows
    let result: FileDaclResult | undefined;
    assert.doesNotThrow(() => {
      result = enforceProtectedFileDacl(dummyPath, dummySid);
    });

    assert.ok(result, 'Result should be returned');
    assert.equal(result.enforced, false, 'Should report not enforced');
    assert.equal(result.platform, 'linux', 'Should report actual current platform');
    assert.equal(result.reason, 'not enforced (platform)');

    // Also test without passing userSid
    assert.doesNotThrow(() => {
      const resWithoutSid = enforceProtectedFileDacl(dummyPath);
      assert.equal(resWithoutSid.enforced, false);
      assert.equal(resWithoutSid.platform, 'linux');
    });

    // hasProtectedFileDacl should return false on non-Windows
    assert.equal(hasProtectedFileDacl(dummyPath, dummySid), false);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('SID resolution: resolves current user SID or fails closed with platform error', () => {
  if (process.platform === 'win32') {
    const sid = resolveCurrentUserSid();
    assert.match(sid, /^S-1-5-\d+(-\d+)+$/, 'Windows SID must follow standard S-1-5 security identifier format');
  } else {
    assert.throws(
      () => resolveCurrentUserSid(),
      /Windows ACL enforcement is only supported on Windows/
    );
  }
});

test('atomic replacement contract: produces correct file ACL specs and executes atomicWriteWithDacl', () => {
  const testSid = 'S-1-5-21-1000-2000-3000-1001';
  const tempPath = 'C:\\Users\\TestUser\\AppData\\Local\\AntiFan\\runtime\\bridge-manifest.tmp';
  const finalPath = 'C:\\Users\\TestUser\\AppData\\Local\\AntiFan\\runtime\\bridge-manifest.json';

  // Verify produced ACL script spec for temp file
  const tempScript = buildFileAclScript(tempPath, testSid);
  assert.ok(tempScript.includes(`$file = '${tempPath.replace(/'/g, "''")}';`), 'Must target temp path');
  assert.ok(tempScript.includes(`New-Object System.Security.Principal.SecurityIdentifier('${testSid}')`), 'Must include user SID');
  assert.ok(tempScript.includes(`New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')`), 'Must include SYSTEM SID S-1-5-18');
  assert.ok(tempScript.includes('New-Object System.Security.AccessControl.FileSecurity'), 'Must use FileSecurity object');
  assert.ok(tempScript.includes('$acl.SetAccessRuleProtection($true, $false)'), 'Must strip inheritance and protect DACL');
  assert.ok(!tempScript.includes('ContainerInherit'), 'File ACL must NOT contain directory ContainerInherit flags');
  assert.ok(!tempScript.includes('ObjectInherit'), 'File ACL must NOT contain directory ObjectInherit flags');
  assert.ok(tempScript.includes('[System.IO.File]::SetAccessControl($file, $acl)'), 'Must set File access control');

  // Verify produced ACL script spec for final path
  const finalScript = buildFileAclScript(finalPath, testSid);
  assert.ok(finalScript.includes(`$file = '${finalPath.replace(/'/g, "''")}';`), 'Must target final path');
  assert.ok(finalScript.includes(`New-Object System.Security.Principal.SecurityIdentifier('${testSid}')`), 'Must include user SID');
  assert.ok(finalScript.includes('New-Object System.Security.AccessControl.FileSecurity'), 'Must use FileSecurity object');
  assert.ok(finalScript.includes('[System.IO.File]::SetAccessControl($file, $acl)'), 'Must set File access control');

  // Behavioral test: Exercise real atomicWriteWithDacl and applyProtectedFileDacl
  const tmpDir = path.join(os.tmpdir(), `antifan-atomic-dacl-${Date.now()}`);
  const targetFile = path.join(tmpDir, 'sub', 'protected.json');
  const payload = JSON.stringify({ secret: 'atomic-dacl-secret', epoch: 1 });

  try {
    atomicWriteWithDacl(targetFile, payload);
    assert.ok(fs.existsSync(targetFile), 'Target file must exist after atomic write');
    assert.equal(fs.readFileSync(targetFile, 'utf8'), payload, 'Content must match exactly');

    // Verify temp file cleanup
    const subDir = path.dirname(targetFile);
    const tmpEntries = fs.readdirSync(subDir).filter((f) => f.endsWith('.tmp'));
    assert.equal(tmpEntries.length, 0, 'No leftover temporary files must remain');

    // Exercise applyProtectedFileDacl directly on an existing file
    assert.doesNotThrow(() => {
      applyProtectedFileDacl(targetFile);
    });

    if (process.platform === 'win32') {
      const userSid = resolveCurrentUserSid();
      assert.equal(hasProtectedFileDacl(targetFile, userSid), true, 'Target file must pass DACL verification on Windows');
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('verifyProtectedSddl: validates exact ACEs and flags for files and directories', () => {
  const userSid = 'S-1-5-21-1000-2000-3000-1001';

  // Valid directory SDDL: has P flag, OICI inheritance, SY + user
  const validDirSddl = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${userSid})`;
  assert.equal(verifyProtectedSddl(validDirSddl, userSid, 'directory'), true);

  // Valid file SDDL: has P flag, NO inheritance, SY + user
  const validFileSddl = `D:PAI(A;;FA;;;SY)(A;;FA;;;${userSid})`;
  assert.equal(verifyProtectedSddl(validFileSddl, userSid, 'file'), true);

  // File SDDL should reject directory ACEs with OICI
  assert.equal(verifyProtectedSddl(validDirSddl, userSid, 'file'), false);

  // Directory SDDL should reject file ACEs without OICI
  assert.equal(verifyProtectedSddl(validFileSddl, userSid, 'directory'), false);

  // Reject if unverified third ACE exists (e.g. Everyone or Guests)
  const taintedFileSddl = `D:PAI(A;;FA;;;SY)(A;;FA;;;${userSid})(A;;FR;;;WD)`;
  assert.equal(verifyProtectedSddl(taintedFileSddl, userSid, 'file'), false);

  // Reject if inheritance is not blocked (missing 'P' control flag)
  const unprotectFileSddl = `D:AI(A;;FA;;;SY)(A;;FA;;;${userSid})`;
  assert.equal(verifyProtectedSddl(unprotectFileSddl, userSid, 'file'), false);
  // Valid file SDDL with SACL / Mandatory Label: S:(ML;;NW;;;ME)
  const fileWithSaclSddl = `D:PAI(A;;FA;;;SY)(A;;FA;;;${userSid})S:(ML;;NW;;;ME)`;
  assert.equal(verifyProtectedSddl(fileWithSaclSddl, userSid, 'file'), true, 'Must accept valid file DACL even with SACL/ML descriptor present');

  // Valid directory SDDL with SACL / Mandatory Label:
  const dirWithSaclSddl = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${userSid})S:(ML;;NW;;;ME)`;
  assert.equal(verifyProtectedSddl(dirWithSaclSddl, userSid, 'directory'), true, 'Must accept valid directory DACL even with SACL/ML descriptor present');

  // Full SDDL with Owner, Group, DACL, and SACL:
  const fullDescriptorSddl = `O:BAG:BAD:PAI(A;;FA;;;SY)(A;;FA;;;${userSid})S:(ML;;NW;;;ME)`;
  assert.equal(verifyProtectedSddl(fullDescriptorSddl, userSid, 'file'), true, 'Must parse DACL portion from full security descriptor');
});
test('enforceProtectedFileDacl: [Phase 6 Certification Deferred: Live Windows Execution] live file DACL enforcement and atomic rename on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Skipping live Windows DACL enforcement test on non-Windows platform (deferred to Phase 6)');
    return;
  }

  const userSid = resolveCurrentUserSid();
  const tmpFile = path.join(os.tmpdir(), `antifan-file-acl-test-${Date.now()}.json`);
  const finalFile = path.join(os.tmpdir(), `antifan-file-acl-final-${Date.now()}.json`);

  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ secret: 'pairing-code-test' }), 'utf8');

    // Initially newly created file inherits parent directory ACLs (not protected file DACL)
    // Enforce on temp file
    const res1 = enforceProtectedFileDacl(tmpFile, userSid);
    assert.equal(res1.enforced, true);
    assert.equal(res1.platform, 'win32');
    assert.equal(hasProtectedFileDacl(tmpFile, userSid), true);

    // Atomic replacement / rename
    fs.renameSync(tmpFile, finalFile);

    // Re-enforce on final path
    const res2 = enforceProtectedFileDacl(finalFile, userSid);
    assert.equal(res2.enforced, true);
    assert.equal(res2.platform, 'win32');
    assert.equal(hasProtectedFileDacl(finalFile, userSid), true);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(finalFile); } catch {}
  }
});
