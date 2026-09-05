/**
 * Password Vault encrypt-at-rest + decrypt smoke.
 *
 * Runs INSIDE Electron (via scripts/run-electron.cjs) so it exercises the REAL
 * safeStorage (DPAPI on Windows). Proves: save round-trips, ciphertext on disk
 * contains no plaintext, autofill path decrypts to the original password,
 * and clear wipes the store file.
 */
'use strict';

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { LocalCredentialVault } = require(path.join(
  __dirname,
  '..',
  '.compiled',
  'src',
  'main',
  'browser',
  'local-credential-vault.js'
));

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = 1;
}

app
  .whenReady()
  .then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-vault-smoke-'));
    const filePath = path.join(dir, 'password-vault.json');
    try {
      const encAvailable = safeStorage.isEncryptionAvailable();
      check('safeStorage encryption available', encAvailable, `platform=${process.platform}`);
      if (!encAvailable) {
        console.log('SMOKE_VAULT: FAILED');
        process.exit(1);
      }

      const vault = new LocalCredentialVault({ safeStorage, filePath });
      const PASSWORD = 'smoke-pass-ABC123!';

      const saved = vault.save('https://smoke.example.com', 'smoke-user', PASSWORD);
      check('save ok', saved.ok === true && saved.data?.username === 'smoke-user', `id=${saved.data?.id}`);
      check('vault file created', fs.existsSync(filePath));

      const raw = fs.readFileSync(filePath, 'utf8');
      check('no plaintext at rest', !raw.includes(PASSWORD) && !raw.includes('smoke-pass'), 'ciphertext only');
      const parsed = JSON.parse(raw);
      check('store shape v1 + single entry', parsed.version === 1 && parsed.entries.length === 1);

      const creds = vault.getForOrigin('https://smoke.example.com');
      check('autofill decrypt round-trip', creds.length === 1 && creds[0].password === PASSWORD && creds[0].username === 'smoke-user');

      const relisted = vault.list();
      check('meta list has no password payload', relisted.length === 1 && !('passwordEnc' in relisted[0]) && !('password' in relisted[0]));

      const mixed = new LocalCredentialVault({ safeStorage, filePath });
      check('reload from disk sees entry', mixed.list().length === 1);

      const cleared = vault.clear();
      check('clear removes store data', cleared.ok === true && cleared.data?.removedCount === 1 && vault.list().length === 0);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    console.log(failed ? 'SMOKE_VAULT: FAILED' : 'SMOKE_VAULT: PASSED');
    app.exit(failed);
  })
  .catch((err) => {
    console.error('FAIL:', err);
    app.exit(1);
  });