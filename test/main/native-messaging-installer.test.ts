import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  generateHostManifest,
  writeManifestFile,
  HOST_NAME,
  HOST_DESCRIPTION,
  COMPANION_EXTENSION_ID,
  WINDOWS_REGISTRY_KEYS,
  getDefaultManifestPath,
  getDefaultHostBinaryPath,
  getPermanentExtensionDir,
  exportCompanionExtension,
  installNativeHost
} from '../../src/main/native-messaging/manifest-installer';
test('generateHostManifest: produces valid Chromium manifest', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const customBinary = 'C:\\Program Files\\AntiFan\\antifan-bridge-host.exe';

  const manifest = generateHostManifest(extensionId, customBinary);

  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.description, HOST_DESCRIPTION);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, customBinary);
  assert.deepEqual(manifest.allowed_origins, [
    `chrome-extension://${extensionId}/`,
  ]);
});

test('generateHostManifest: sanitizes extensionId with prefix or trailing slash', () => {
  const rawId = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
  const manifest = generateHostManifest(rawId);

  assert.deepEqual(manifest.allowed_origins, [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  ]);
  assert.match(manifest.path, /antifan-bridge-host\.exe$/);
});

test('getDefaultManifestPath & getDefaultHostBinaryPath: resolve valid paths', () => {
  const manifestPath = getDefaultManifestPath();
  const binaryPath = getDefaultHostBinaryPath();

  assert.match(manifestPath, /AntiFan[\\/]NativeMessagingHosts[\\/]com\.antifan\.bridge\.json$/);
  assert.match(binaryPath, /antifan-bridge-host\.exe$/);
});

test('writeManifestFile: writes valid JSON manifest file and creates parent directories', () => {
  const tmpDir = path.join(os.tmpdir(), `antifan-test-manifest-${Date.now()}`);
  const targetFile = path.join(tmpDir, 'nested', 'com.antifan.bridge.json');

  const manifest = generateHostManifest('testextensionid1234567890123456');
  const writtenPath = writeManifestFile(manifest, targetFile);

  assert.equal(writtenPath, targetFile);
  assert.equal(fs.existsSync(targetFile), true);

  const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  assert.deepEqual(parsed, manifest);

  // Clean up
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test('WINDOWS_REGISTRY_KEYS: maps Chrome, Edge, and Brave to valid HKCU paths', () => {
  assert.equal(
    WINDOWS_REGISTRY_KEYS.chrome,
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.antifan.bridge'
  );
  assert.equal(
    WINDOWS_REGISTRY_KEYS.edge,
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.antifan.bridge'
  );
  assert.equal(
    WINDOWS_REGISTRY_KEYS.brave,
    'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.antifan.bridge'
  );
});
test('Companion Extension ID: mathematically matches extension/manifest.json RSA public key', () => {
  const manifestPath = path.join(process.cwd(), 'extension', 'manifest.json');
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const manifestJson = JSON.parse(manifestRaw);
  assert.ok(manifestJson.key, 'extension/manifest.json must contain a fixed public key');

  // Chromium Extension ID derivation algorithm:
  // 1. Decode base64 SPKI DER public key
  const derBuffer = Buffer.from(manifestJson.key, 'base64');
  // 2. Compute SHA-256 hash
  const sha256Hex = crypto.createHash('sha256').update(derBuffer).digest('hex');
  // 3. Take first 32 characters and map hex nibbles (0-f) to letters (a-p)
  const derivedId = sha256Hex
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(parseInt(c, 16) + 97))
    .join('');

  assert.equal(derivedId, COMPANION_EXTENSION_ID);
  assert.equal(COMPANION_EXTENSION_ID, 'khjcaadjohoclofjkkfblkbfbpmjjedp');

  // Verify manifest generation with companion extension ID
  const hostManifest = generateHostManifest(COMPANION_EXTENSION_ID);
  assert.deepEqual(hostManifest.allowed_origins, [
    'chrome-extension://khjcaadjohoclofjkkfblkbfbpmjjedp/',
  ]);
});

test('exportCompanionExtension: successfully copies extension files to target directory', () => {
  const tmpExtDir = path.join(os.tmpdir(), `antifan-export-ext-${Date.now()}`);
  const exportedPath = exportCompanionExtension(tmpExtDir);

  assert.equal(exportedPath, tmpExtDir);
  assert.equal(fs.existsSync(path.join(tmpExtDir, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(tmpExtDir, 'popup.html')), true);
  assert.equal(fs.existsSync(path.join(tmpExtDir, 'popup.js')), true);
  assert.equal(fs.existsSync(path.join(tmpExtDir, 'background.js')), true);

  const permanentDir = getPermanentExtensionDir();
  assert.match(permanentDir, /AntiFan[\\/]extension$/);

  try { fs.rmSync(tmpExtDir, { recursive: true, force: true }); } catch {}
});

test('exportCompanionExtension: fails closed with clear error when manifest.json is missing in all source candidates', () => {
  const tmpExtDir = path.join(os.tmpdir(), `antifan-export-ext-fail-${Date.now()}`);
  const emptyCandidateDir = path.join(os.tmpdir(), `antifan-empty-cand-${Date.now()}`);
  fs.mkdirSync(emptyCandidateDir, { recursive: true });

  try {
    assert.throws(
      () => {
        exportCompanionExtension(tmpExtDir, [emptyCandidateDir]);
      },
      (err: Error) => {
        assert.match(err.message, /Failed to export companion extension: No valid source candidate directory/);
        return true;
      }
    );
  } finally {
    try { fs.rmSync(tmpExtDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(emptyCandidateDir, { recursive: true, force: true }); } catch {}
  }
});

test('installNativeHost: reports failure when extension export fails', async () => {
  const tmpExtDir = path.join(os.tmpdir(), `antifan-export-ext-fail2-${Date.now()}`);
  const emptyCandidateDir = path.join(os.tmpdir(), `antifan-empty-cand2-${Date.now()}`);
  const tmpManifestFile = path.join(os.tmpdir(), `antifan-tmp-manifest-${Date.now()}.json`);
  fs.mkdirSync(emptyCandidateDir, { recursive: true });

  try {
    const result = await installNativeHost(COMPANION_EXTENSION_ID, {
      manifestPath: tmpManifestFile,
      targetExtensionDir: tmpExtDir,
      customCandidateDirs: [emptyCandidateDir],
      browsers: [] // avoid touching real registry
    });

    assert.equal(result.success, false);
    assert.ok(result.extensionExportError);
    assert.match(result.extensionExportError, /No valid source candidate directory/);
  } finally {
    try { fs.rmSync(tmpExtDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(emptyCandidateDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmpManifestFile); } catch {}
  }
});
