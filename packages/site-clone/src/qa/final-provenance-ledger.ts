import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Hash contract options for artifact content:
 * - 'byte-exact': direct SHA-256 of raw binary / buffer bytes.
 * - 'lf-normalized': line-ending normalization (CRLF / CR -> LF) before SHA-256.
 */
export type HashContract = 'lf-normalized' | 'byte-exact';

/**
 * Single artifact provenance entry in the ledger.
 */
export interface ProvenanceRecord {
  artifact: string;
  sha256: string;
  hashContract: HashContract;
  bytes: number;
  timestamp: string;
}

/**
 * Execution runtime environment metadata.
 */
export interface ProvenanceEnvironment {
  nodeVersion: string;
  platform: string;
  instrumentRevision: string;
}

/**
 * Execution fingerprint and cryptographic verification stamps.
 */
export interface ProvenanceSignatures {
  executionFingerprint: string;
  verificationStamp: string;
  signer?: string;
  sealedAt?: string;
}

/**
 * Result returned when sealing a ledger.
 */
export interface SealResult {
  sealed: boolean;
  ledgerHash: string;
  sealedAt: string;
  recordCount: number;
}

/**
 * Result returned when verifying ledger integrity.
 */
export interface VerificationResult {
  verified: boolean;
  mismatches: string[];
}

/**
 * Full serialized ledger manifest structure.
 */
export interface FinalProvenanceManifest {
  version: string;
  records: ProvenanceRecord[];
  environment: ProvenanceEnvironment;
  signatures: ProvenanceSignatures;
  ledgerHash: string;
  sealedAt: string;
  signer: string;
}

/**
 * Optional constructor configuration.
 */
export interface FinalProvenanceLedgerOptions {
  instrumentRevision?: string;
  environment?: Partial<ProvenanceEnvironment>;
  fingerprintSeed?: string;
}

/**
 * QA: Final Provenance & Chain of Custody Ledger (Audit §54)
 * Records, hashes, and cryptographically seals provenance across all storefront
 * cloning execution artifacts with tamper-evident verification.
 */
export class FinalProvenanceLedger {
  public static readonly DEFAULT_REVISION = 'haravan-os2-audit-54@1.0.0';
  public static readonly MANIFEST_VERSION = '1.0.0';

  private _records: ProvenanceRecord[] = [];
  private _environment: ProvenanceEnvironment;
  private _signatures: ProvenanceSignatures;
  private _sealed = false;
  private _sealResult: SealResult | null = null;
  private _ledgerHash: string | null = null;

  constructor(options: FinalProvenanceLedgerOptions = {}) {
    this._environment = {
      nodeVersion: options.environment?.nodeVersion || process.version,
      platform: options.environment?.platform || process.platform,
      instrumentRevision:
        options.instrumentRevision ||
        options.environment?.instrumentRevision ||
        FinalProvenanceLedger.DEFAULT_REVISION
    };

    const fingerprintPayload = `${this._environment.nodeVersion}:${this._environment.platform}:${this._environment.instrumentRevision}:${options.fingerprintSeed ?? 'anti-fan-origin'}`;
    const executionFingerprint = createHash('sha256').update(fingerprintPayload).digest('hex');

    this._signatures = {
      executionFingerprint,
      verificationStamp: 'UNSEALED'
    };
  }

  /**
   * Returns a copy of the recorded artifact provenance entries.
   */
  public get records(): ProvenanceRecord[] {
    return this._records.map((r) => ({ ...r }));
  }

  /**
   * Returns a copy of the execution environment metadata.
   */
  public get environment(): ProvenanceEnvironment {
    return { ...this._environment };
  }

  /**
   * Returns a copy of the execution signatures and verification stamps.
   */
  public get signatures(): ProvenanceSignatures {
    return { ...this._signatures };
  }

  /**
   * Whether the ledger has been sealed against further mutations.
   */
  public get isSealed(): boolean {
    return this._sealed;
  }

  /**
   * The canonical ledger hash if sealed, or null if unsealed.
   */
  public get ledgerHash(): string | null {
    return this._ledgerHash;
  }

  /**
   * Normalizes artifact file path to posix relative representation.
   */
  public static normalizeArtifactPath(filePath: string): string {
    return filePath
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .trim();
  }

  /**
   * Computes SHA-256 and byte length according to the specified hash contract.
   */
  public static hashContent(
    content: string | Buffer,
    contract: HashContract = 'byte-exact'
  ): { sha256: string; bytes: number } {
    let payloadBuffer: Buffer;
    if (contract === 'lf-normalized') {
      const rawString = typeof content === 'string' ? content : content.toString('utf8');
      const normalizedString = rawString.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      payloadBuffer = Buffer.from(normalizedString, 'utf8');
    } else {
      payloadBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    }

    const sha256 = createHash('sha256').update(payloadBuffer).digest('hex');
    return {
      sha256,
      bytes: payloadBuffer.length
    };
  }

  /**
   * Records an artifact in the ledger with its cryptographic hash and contract.
   * Throws if the ledger is already sealed.
   */
  public recordArtifact(
    filePath: string,
    content: string | Buffer,
    contract: HashContract = 'byte-exact'
  ): void {
    if (this._sealed) {
      throw new Error(`Cannot record artifact '${filePath}': ledger is already sealed`);
    }

    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('Artifact filePath must be a non-empty string');
    }

    const normalizedPath = FinalProvenanceLedger.normalizeArtifactPath(filePath);
    const { sha256, bytes } = FinalProvenanceLedger.hashContent(content, contract);
    const timestamp = new Date().toISOString();

    const record: ProvenanceRecord = {
      artifact: normalizedPath,
      sha256,
      hashContract: contract,
      bytes,
      timestamp
    };

    const existingIndex = this._records.findIndex((r) => r.artifact === normalizedPath);
    if (existingIndex >= 0) {
      this._records[existingIndex] = record;
    } else {
      this._records.push(record);
    }
  }

  /**
   * Looks up a recorded artifact entry by path.
   */
  public getRecord(filePath: string): ProvenanceRecord | undefined {
    const normalized = FinalProvenanceLedger.normalizeArtifactPath(filePath);
    const found = this._records.find((r) => r.artifact === normalized);
    return found ? { ...found } : undefined;
  }

  /**
   * Verifies an in-memory content against the recorded entry for this artifact.
   */
  public verifyArtifact(filePath: string, content: string | Buffer): boolean {
    const record = this.getRecord(filePath);
    if (!record) {
      return false;
    }
    const { sha256 } = FinalProvenanceLedger.hashContent(content, record.hashContract);
    return sha256 === record.sha256;
  }

  /**
   * Cryptographically seals the ledger and signs it.
   * Once sealed, records become immutable.
   */
  public sealLedger(signer: string): SealResult {
    if (!signer || typeof signer !== 'string' || signer.trim() === '') {
      throw new Error('Signer must be a non-empty string');
    }

    const trimmedSigner = signer.trim();

    if (this._sealed) {
      if (this._sealResult && this._signatures.signer === trimmedSigner) {
        return { ...this._sealResult };
      }
      throw new Error('Ledger is already sealed and cannot be resealed with a different signer');
    }

    // Deterministically sort records by artifact path
    this._records.sort((a, b) => a.artifact.localeCompare(b.artifact));

    const sealedAt = new Date().toISOString();

    // Canonical payload for ledger hash
    const canonicalPayload = JSON.stringify({
      records: this._records,
      environment: this._environment,
      executionFingerprint: this._signatures.executionFingerprint,
      signer: trimmedSigner,
      sealedAt
    });

    const ledgerHash = createHash('sha256').update(canonicalPayload).digest('hex');

    // Cryptographic verification stamp
    const stampPayload = `${trimmedSigner}:${sealedAt}:${ledgerHash}:${this._signatures.executionFingerprint}`;
    const verificationStamp = createHash('sha256').update(stampPayload).digest('hex');

    this._signatures.signer = trimmedSigner;
    this._signatures.sealedAt = sealedAt;
    this._signatures.verificationStamp = verificationStamp;

    this._ledgerHash = ledgerHash;
    this._sealed = true;

    this._sealResult = {
      sealed: true,
      ledgerHash,
      sealedAt,
      recordCount: this._records.length
    };

    return { ...this._sealResult };
  }

  /**
   * Exports the sealed ledger manifest as JSON.
   */
  public toJSON(): FinalProvenanceManifest {
    if (!this._sealed || !this._ledgerHash || !this._signatures.sealedAt || !this._signatures.signer) {
      throw new Error('Cannot export manifest: ledger must be sealed first');
    }

    return {
      version: FinalProvenanceLedger.MANIFEST_VERSION,
      records: this.records,
      environment: this.environment,
      signatures: this.signatures,
      ledgerHash: this._ledgerHash,
      sealedAt: this._signatures.sealedAt,
      signer: this._signatures.signer
    };
  }

  /**
   * Exports the ledger as a formatted JSON file to the target path.
   * Auto-seals with 'system-custody' if not already sealed.
   */
  public async exportLedger(targetPath: string): Promise<void> {
    if (!this._sealed) {
      this.sealLedger('system-custody');
    }

    const manifest = this.toJSON();
    const resolvedPath = path.resolve(targetPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  /**
   * Verifies the cryptographic integrity and consistency of a ledger JSON string.
   */
  public static verifyLedgerIntegrity(ledgerJson: string): VerificationResult {
    const mismatches: string[] = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(ledgerJson);
    } catch (err) {
      return {
        verified: false,
        mismatches: [`Invalid JSON format: ${(err as Error).message}`]
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        verified: false,
        mismatches: ['Ledger manifest must be a non-null JSON object']
      };
    }

    const candidate = parsed as Partial<FinalProvenanceManifest>;

    if (typeof candidate.ledgerHash !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.ledgerHash)) {
      mismatches.push('Missing or invalid 64-character hex ledgerHash');
    }

    if (typeof candidate.signer !== 'string' || candidate.signer.trim() === '') {
      mismatches.push('Missing or empty signer');
    }

    if (typeof candidate.sealedAt !== 'string' || Number.isNaN(Date.parse(candidate.sealedAt))) {
      mismatches.push('Missing or invalid sealedAt ISO timestamp');
    }

    if (!candidate.environment || typeof candidate.environment !== 'object') {
      mismatches.push('Missing environment block');
    } else {
      const env = candidate.environment as Partial<ProvenanceEnvironment>;
      if (!env.nodeVersion || typeof env.nodeVersion !== 'string') {
        mismatches.push('Missing environment.nodeVersion');
      }
      if (!env.platform || typeof env.platform !== 'string') {
        mismatches.push('Missing environment.platform');
      }
      if (!env.instrumentRevision || typeof env.instrumentRevision !== 'string') {
        mismatches.push('Missing environment.instrumentRevision');
      }
    }

    if (!candidate.signatures || typeof candidate.signatures !== 'object') {
      mismatches.push('Missing signatures block');
    } else {
      const sigs = candidate.signatures as Partial<ProvenanceSignatures>;
      if (typeof sigs.executionFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(sigs.executionFingerprint)) {
        mismatches.push('Missing or invalid 64-character hex executionFingerprint');
      }
      if (typeof sigs.verificationStamp !== 'string' || !/^[a-f0-9]{64}$/i.test(sigs.verificationStamp)) {
        mismatches.push('Missing or invalid 64-character hex verificationStamp');
      }
    }

    if (!Array.isArray(candidate.records)) {
      mismatches.push('Missing records array');
    } else {
      const seenArtifacts = new Set<string>();
      for (let i = 0; i < candidate.records.length; i++) {
        const rec = candidate.records[i];
        if (!rec || typeof rec !== 'object') {
          mismatches.push(`Record at index ${i} is not an object`);
          continue;
        }
        if (typeof rec.artifact !== 'string' || rec.artifact.trim() === '') {
          mismatches.push(`Record at index ${i} has empty or missing artifact name`);
        } else {
          if (seenArtifacts.has(rec.artifact)) {
            mismatches.push(`Duplicate artifact entry detected: '${rec.artifact}'`);
          }
          seenArtifacts.add(rec.artifact);
        }

        if (typeof rec.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(rec.sha256)) {
          mismatches.push(`Record '${rec.artifact ?? i}' has invalid sha256 format`);
        }

        if (rec.hashContract !== 'byte-exact' && rec.hashContract !== 'lf-normalized') {
          mismatches.push(`Record '${rec.artifact ?? i}' has invalid hashContract '${rec.hashContract}'`);
        }

        if (typeof rec.bytes !== 'number' || rec.bytes < 0 || !Number.isInteger(rec.bytes)) {
          mismatches.push(`Record '${rec.artifact ?? i}' has invalid bytes value: ${rec.bytes}`);
        }

        if (typeof rec.timestamp !== 'string' || Number.isNaN(Date.parse(rec.timestamp))) {
          mismatches.push(`Record '${rec.artifact ?? i}' has invalid timestamp: ${rec.timestamp}`);
        }
      }
    }

    // If structural checks failed, return early
    if (mismatches.length > 0) {
      return { verified: false, mismatches };
    }

    // Cryptographic re-verification
    const records = candidate.records as ProvenanceRecord[];
    const environment = candidate.environment as ProvenanceEnvironment;
    const signatures = candidate.signatures as ProvenanceSignatures;
    const signer = candidate.signer as string;
    const sealedAt = candidate.sealedAt as string;
    const recordedLedgerHash = candidate.ledgerHash as string;

    // Check sorted order
    const sortedRecords = [...records].sort((a, b) => a.artifact.localeCompare(b.artifact));
    for (let i = 0; i < records.length; i++) {
      if (records[i].artifact !== sortedRecords[i].artifact) {
        mismatches.push(`Records are not deterministically sorted by artifact path at index ${i}`);
        break;
      }
    }

    // Recompute canonical ledger hash
    const canonicalPayload = JSON.stringify({
      records: sortedRecords,
      environment,
      executionFingerprint: signatures.executionFingerprint,
      signer,
      sealedAt
    });

    const expectedLedgerHash = createHash('sha256').update(canonicalPayload).digest('hex');
    if (expectedLedgerHash !== recordedLedgerHash) {
      mismatches.push(
        `Ledger hash mismatch: expected '${expectedLedgerHash}', recorded '${recordedLedgerHash}'`
      );
    }

    // Recompute verification stamp
    const stampPayload = `${signer}:${sealedAt}:${recordedLedgerHash}:${signatures.executionFingerprint}`;
    const expectedStamp = createHash('sha256').update(stampPayload).digest('hex');
    if (expectedStamp !== signatures.verificationStamp) {
      mismatches.push(
        `Verification stamp mismatch: expected '${expectedStamp}', recorded '${signatures.verificationStamp}'`
      );
    }

    return {
      verified: mismatches.length === 0,
      mismatches
    };
  }

  /**
   * Instance method delegating to static verifyLedgerIntegrity.
   */
  public verifyLedgerIntegrity(ledgerJson: string): VerificationResult {
    return FinalProvenanceLedger.verifyLedgerIntegrity(ledgerJson);
  }

  /**
   * Rehydrates a FinalProvenanceLedger instance from a serialized manifest.
   */
  public static fromJSON(ledgerJson: string): FinalProvenanceLedger {
    const check = FinalProvenanceLedger.verifyLedgerIntegrity(ledgerJson);
    if (!check.verified) {
      throw new Error(`Cannot rehydrate ledger: integrity check failed (${check.mismatches.join('; ')})`);
    }

    const manifest = JSON.parse(ledgerJson) as FinalProvenanceManifest;
    const ledger = new FinalProvenanceLedger({
      environment: manifest.environment,
      instrumentRevision: manifest.environment.instrumentRevision
    });

    ledger._records = manifest.records.map((r) => ({ ...r }));
    ledger._signatures = { ...manifest.signatures };
    ledger._ledgerHash = manifest.ledgerHash;
    ledger._sealed = true;
    ledger._sealResult = {
      sealed: true,
      ledgerHash: manifest.ledgerHash,
      sealedAt: manifest.sealedAt,
      recordCount: manifest.records.length
    };

    return ledger;
  }
}
