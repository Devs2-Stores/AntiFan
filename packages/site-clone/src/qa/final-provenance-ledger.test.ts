import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FinalProvenanceLedger,
  type ProvenanceRecord,
  type FinalProvenanceManifest
} from './final-provenance-ledger.js';

describe('FinalProvenanceLedger - Chain of Custody & Cryptographic Ledger (Audit §54)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-fan-provenance-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('1. Artifact Recording & Content Hashing Contracts', () => {
    it('records artifacts with byte-exact contract for binary and text content', () => {
      const ledger = new FinalProvenanceLedger();

      const rawText = 'Hello Haravan OS 2.0 Storefront';
      ledger.recordArtifact('templates/index.liquid', rawText, 'byte-exact');

      const binaryBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      ledger.recordArtifact('assets/logo.png', binaryBuffer, 'byte-exact');

      const records = ledger.records;
      assert.strictEqual(records.length, 2, 'Must record 2 artifacts');

      const templateRec = ledger.getRecord('templates/index.liquid');
      assert.ok(templateRec, 'Must retrieve template record');
      assert.strictEqual(templateRec.artifact, 'templates/index.liquid');
      assert.strictEqual(templateRec.hashContract, 'byte-exact');
      assert.strictEqual(templateRec.bytes, Buffer.from(rawText).length);
      assert.match(templateRec.sha256, /^[a-f0-9]{64}$/);

      const logoRec = ledger.getRecord('assets/logo.png');
      assert.ok(logoRec, 'Must retrieve logo record');
      assert.strictEqual(logoRec.bytes, 8);
    });

    it('normalizes line endings under lf-normalized contract across CRLF and LF', () => {
      const ledgerCrlf = new FinalProvenanceLedger();
      const ledgerLf = new FinalProvenanceLedger();

      const crlfContent = 'line 1\r\nline 2\r\nline 3\r\n';
      const lfContent = 'line 1\nline 2\nline 3\n';

      ledgerCrlf.recordArtifact('snippets/header.liquid', crlfContent, 'lf-normalized');
      ledgerLf.recordArtifact('snippets/header.liquid', lfContent, 'lf-normalized');

      const crlfRec = ledgerCrlf.getRecord('snippets/header.liquid')!;
      const lfRec = ledgerLf.getRecord('snippets/header.liquid')!;

      assert.strictEqual(
        crlfRec.sha256,
        lfRec.sha256,
        'CRLF and LF must produce identical SHA-256 under lf-normalized contract'
      );
      assert.strictEqual(crlfRec.bytes, lfRec.bytes, 'Normalized byte length must match');

      // Contrast: under byte-exact, CRLF and LF must yield different hashes
      const ledgerExact = new FinalProvenanceLedger();
      ledgerExact.recordArtifact('snippets/crlf.liquid', crlfContent, 'byte-exact');
      ledgerExact.recordArtifact('snippets/lf.liquid', lfContent, 'byte-exact');

      const exactCrlf = ledgerExact.getRecord('snippets/crlf.liquid')!;
      const exactLf = ledgerExact.getRecord('snippets/lf.liquid')!;
      assert.notStrictEqual(
        exactCrlf.sha256,
        exactLf.sha256,
        'byte-exact must differentiate CRLF and LF'
      );
    });

    it('normalizes Windows backslash paths and redundant prefixes', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('.\\assets\\css\\theme.css', 'body { margin: 0; }');

      const record = ledger.getRecord('assets/css/theme.css');
      assert.ok(record, 'Must find normalized path with posix slashes');
      assert.strictEqual(record.artifact, 'assets/css/theme.css');
    });

    it('updates existing record when an artifact path is re-recorded', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('config/settings_data.json', '{"v": 1}');
      const firstSha = ledger.getRecord('config/settings_data.json')!.sha256;

      ledger.recordArtifact('config/settings_data.json', '{"v": 2}');
      const updatedRec = ledger.getRecord('config/settings_data.json')!;

      assert.strictEqual(ledger.records.length, 1, 'Duplicate path must replace entry, not duplicate');
      assert.notStrictEqual(updatedRec.sha256, firstSha);
    });

    it('throws when recording with empty or whitespace file path', () => {
      const ledger = new FinalProvenanceLedger();
      assert.throws(() => {
        ledger.recordArtifact('   ', 'content');
      }, /Artifact filePath must be a non-empty string/);
    });
  });

  describe('2. Sealing & Immutability Guarantees', () => {
    it('seals the ledger and generates deterministic ledgerHash and verificationStamp', () => {
      const ledger = new FinalProvenanceLedger({ instrumentRevision: 'audit-54-rev1' });
      ledger.recordArtifact('sections/hero.liquid', '<section>Hero</section>');
      ledger.recordArtifact('sections/footer.liquid', '<footer>Footer</footer>');

      assert.strictEqual(ledger.isSealed, false);
      assert.strictEqual(ledger.signatures.verificationStamp, 'UNSEALED');

      const sealResult = ledger.sealLedger('AntiFan-Auditor');

      assert.strictEqual(sealResult.sealed, true);
      assert.strictEqual(sealResult.recordCount, 2);
      assert.match(sealResult.ledgerHash, /^[a-f0-9]{64}$/);
      assert.ok(sealResult.sealedAt);

      assert.strictEqual(ledger.isSealed, true);
      assert.strictEqual(ledger.ledgerHash, sealResult.ledgerHash);
      assert.strictEqual(ledger.signatures.signer, 'AntiFan-Auditor');
      assert.match(ledger.signatures.verificationStamp, /^[a-f0-9]{64}$/);
    });

    it('fails closed when attempting to record artifacts after sealing', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('assets/app.js', 'console.log(1);');
      ledger.sealLedger('SecuritySigner');

      assert.throws(() => {
        ledger.recordArtifact('assets/extra.js', 'console.log(2);');
      }, /Cannot record artifact 'assets\/extra\.js': ledger is already sealed/);
    });

    it('is idempotent when re-sealed with the same signer, but rejects different signers', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('assets/app.js', 'console.log(1);');
      const firstSeal = ledger.sealLedger('LeadAuditor');

      const secondSeal = ledger.sealLedger('LeadAuditor');
      assert.deepStrictEqual(firstSeal, secondSeal, 'Same signer re-sealing must return identical result');

      assert.throws(() => {
        ledger.sealLedger('Intruder');
      }, /Ledger is already sealed and cannot be resealed with a different signer/);
    });

    it('rejects empty or whitespace signer names', () => {
      const ledger = new FinalProvenanceLedger();
      assert.throws(() => {
        ledger.sealLedger('   ');
      }, /Signer must be a non-empty string/);
    });

    it('ensures insertion-order independence via canonical record sorting', () => {
      const env = { nodeVersion: 'v20.0.0', platform: 'linux', instrumentRevision: 'rev-fixed' };
      const seed = 'deterministic-seed';

      const ledgerA = new FinalProvenanceLedger({ environment: env, fingerprintSeed: seed });
      ledgerA.recordArtifact('b.txt', 'content-b');
      ledgerA.recordArtifact('a.txt', 'content-a');
      ledgerA.recordArtifact('c.txt', 'content-c');

      const ledgerB = new FinalProvenanceLedger({ environment: env, fingerprintSeed: seed });
      ledgerB.recordArtifact('c.txt', 'content-c');
      ledgerB.recordArtifact('a.txt', 'content-a');
      ledgerB.recordArtifact('b.txt', 'content-b');

      // Force fixed sealedAt timestamp for comparison by injecting
      const sealA = ledgerA.sealLedger('Signer');
      // In ledgerB, since sealedAt will be within milliseconds, let's verify canonical record ordering
      assert.deepStrictEqual(
        ledgerA.records.map((r) => r.artifact),
        ['a.txt', 'b.txt', 'c.txt'],
        'Records must be canonically sorted by artifact'
      );
      assert.deepStrictEqual(
        ledgerB.sealLedger('Signer').recordCount,
        3
      );
      assert.deepStrictEqual(
        ledgerB.records.map((r) => r.artifact),
        ['a.txt', 'b.txt', 'c.txt']
      );
    });
  });

  describe('3. Cryptographic Integrity Verification (verifyLedgerIntegrity)', () => {
    it('verifies a validly sealed ledger JSON without errors', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('layout/theme.liquid', '<!DOCTYPE html><html><body>{{ content_for_layout }}</body></html>');
      ledger.recordArtifact('assets/base.css', 'body { color: red; }');
      ledger.sealLedger('Auditor-Test');

      const manifestJson = JSON.stringify(ledger.toJSON());
      const result = FinalProvenanceLedger.verifyLedgerIntegrity(manifestJson);

      assert.strictEqual(result.verified, true, 'Integrity verification must pass');
      assert.deepStrictEqual(result.mismatches, [], 'Mismatches must be empty');

      // Also verify via instance method
      const instanceResult = ledger.verifyLedgerIntegrity(manifestJson);
      assert.strictEqual(instanceResult.verified, true);
    });

    it('detects tampered artifact hash in ledger record', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('assets/app.js', 'console.log("secure");');
      ledger.sealLedger('Auditor');

      const manifest = ledger.toJSON();
      // Tamper with artifact sha256
      manifest.records[0].sha256 = '0000000000000000000000000000000000000000000000000000000000000000';

      const tamperedJson = JSON.stringify(manifest);
      const result = FinalProvenanceLedger.verifyLedgerIntegrity(tamperedJson);

      assert.strictEqual(result.verified, false, 'Tampered sha256 must fail verification');
      assert.ok(
        result.mismatches.some((m) => m.includes('Ledger hash mismatch')),
        'Must report ledger hash mismatch'
      );
    });

    it('detects tampered environment properties', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('locales/en.json', '{"greeting": "hello"}');
      ledger.sealLedger('Auditor');

      const manifest = ledger.toJSON();
      manifest.environment.platform = 'fake-os';

      const result = FinalProvenanceLedger.verifyLedgerIntegrity(JSON.stringify(manifest));
      assert.strictEqual(result.verified, false);
      assert.ok(result.mismatches.some((m) => m.includes('Ledger hash mismatch')));
    });

    it('detects tampered verification stamp', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('config/settings_schema.json', '[]');
      ledger.sealLedger('Auditor');

      const manifest = ledger.toJSON();
      manifest.signatures.verificationStamp = '1111111111111111111111111111111111111111111111111111111111111111';

      const result = FinalProvenanceLedger.verifyLedgerIntegrity(JSON.stringify(manifest));
      assert.strictEqual(result.verified, false);
      assert.ok(result.mismatches.some((m) => m.includes('Verification stamp mismatch')));
    });

    it('detects duplicate artifact records', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('assets/a.js', 'a');
      ledger.sealLedger('Auditor');

      const manifest = ledger.toJSON();
      // Inject duplicate entry
      manifest.records.push({ ...manifest.records[0] });

      const result = FinalProvenanceLedger.verifyLedgerIntegrity(JSON.stringify(manifest));
      assert.strictEqual(result.verified, false);
      assert.ok(result.mismatches.some((m) => m.includes('Duplicate artifact entry detected')));
    });

    it('handles malformed JSON gracefully', () => {
      const result = FinalProvenanceLedger.verifyLedgerIntegrity('invalid { json');
      assert.strictEqual(result.verified, false);
      assert.ok(result.mismatches.some((m) => m.includes('Invalid JSON format')));
    });

    it('detects missing or invalid structural fields', () => {
      const result = FinalProvenanceLedger.verifyLedgerIntegrity(JSON.stringify({ records: [] }));
      assert.strictEqual(result.verified, false);
      assert.ok(result.mismatches.some((m) => m.includes('Missing or invalid 64-character hex ledgerHash')));
      assert.ok(result.mismatches.some((m) => m.includes('Missing or empty signer')));
    });
  });

  describe('4. Export & Rehydration', () => {
    it('exports sealed manifest to file and verifies from disk', async () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('templates/cart.liquid', '<form action="/cart"></form>');
      ledger.sealLedger('ExportAuditor');

      const targetPath = path.join(tempDir, 'sub', 'provenance.json');
      await ledger.exportLedger(targetPath);

      const fileContent = await fs.readFile(targetPath, 'utf8');
      const verifyResult = FinalProvenanceLedger.verifyLedgerIntegrity(fileContent);

      assert.strictEqual(verifyResult.verified, true, 'Exported manifest must verify');
      assert.deepStrictEqual(verifyResult.mismatches, []);

      // Verify rehydration via fromJSON
      const rehydrated = FinalProvenanceLedger.fromJSON(fileContent);
      assert.strictEqual(rehydrated.isSealed, true);
      assert.strictEqual(rehydrated.ledgerHash, ledger.ledgerHash);
      assert.strictEqual(rehydrated.records.length, 1);
      assert.strictEqual(rehydrated.records[0].artifact, 'templates/cart.liquid');
    });

    it('auto-seals unsealed ledger on export with system-custody', async () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('snippets/icon.liquid', '<svg></svg>');

      assert.strictEqual(ledger.isSealed, false);
      const targetPath = path.join(tempDir, 'auto-sealed.json');
      await ledger.exportLedger(targetPath);

      assert.strictEqual(ledger.isSealed, true);
      assert.strictEqual(ledger.signatures.signer, 'system-custody');

      const content = await fs.readFile(targetPath, 'utf8');
      const check = FinalProvenanceLedger.verifyLedgerIntegrity(content);
      assert.strictEqual(check.verified, true);
    });

    it('fromJSON rejects tampered manifest with descriptive error', () => {
      assert.throws(() => {
        FinalProvenanceLedger.fromJSON('{"records": []}');
      }, /Cannot rehydrate ledger: integrity check failed/);
    });
  });

  describe('5. In-Memory Artifact Content Verification (verifyArtifact)', () => {
    it('verifies in-memory content matches recorded artifact', () => {
      const ledger = new FinalProvenanceLedger();
      ledger.recordArtifact('assets/test.css', 'h1 { font-size: 20px; }\r\n', 'lf-normalized');

      assert.strictEqual(
        ledger.verifyArtifact('assets/test.css', 'h1 { font-size: 20px; }\n'),
        true,
        'LF-normalized content with LF ending must match'
      );
      assert.strictEqual(
        ledger.verifyArtifact('assets/test.css', 'h1 { font-size: 20px; }\r\n'),
        true,
        'LF-normalized content with CRLF differences must still match'
      );
      assert.strictEqual(
        ledger.verifyArtifact('assets/test.css', 'h1 { font-size: 30px; }'),
        false,
        'Altered content must return false'
      );
      assert.strictEqual(
        ledger.verifyArtifact('non-existent.txt', 'anything'),
        false,
        'Unrecorded artifact must return false'
      );
    });
  });
});
