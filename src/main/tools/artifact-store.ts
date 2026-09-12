import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { recordBenchmark } from '../benchmark/telemetry';
import { ArtifactRef, CapabilityError, ArtifactReadResult, CapabilityRequestContext, AuthenticatedCapabilityContext } from '../../shared/control-plane-contracts';
import { ArtifactRetentionCleaner, RetentionSweepOptions, RetentionSweepResult } from './artifact-retention-cleaner';
export const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EVIDENCE_LEASE_TTL_MS = 15 * 60 * 1000;

/** Exclusive ownership of one evidence run's artifact capacity, minted by {@link ArtifactStore.preflight}. */
export interface EvidenceRunLease {
  runId: string;
  leaseToken: string;
  acquiredAt: number;
  expiresAt: number;
  maxArtifactBytes: number;
  maxRunBytes: number;
}

export interface ArtifactPreflightResult {
  granted: boolean;
  runId: string;
  leaseToken?: string;
  limits: { maxArtifactBytes: number; maxRunBytes: number };
  committedBytes: number;
  availableRunBytes: number;
  reason?: string;
}

export interface ArtifactPreflightInput {
  runId: string;
  /** Bytes of the single artifact about to be staged. */
  artifactBytes: number;
  /** Additional bytes the run expects to stage beyond this artifact. */
  aggregateBytes?: number;
  /** Lease time-to-live; defaults to {@link DEFAULT_EVIDENCE_LEASE_TTL_MS}. */
  leaseTtlMs?: number;
}

/** `truncate` preserves the historical ceiling behavior; `reject` fails closed before any bytes are written. */
export type ArtifactOverflowMode = 'truncate' | 'reject';

export interface ArtifactStoreOptions {
  root: string;
  maxArtifactBytes?: number;
  maxRunBytes?: number;
  enableRetentionCleaner?: boolean;
  retentionOptions?: RetentionSweepOptions;
}
export interface ArtifactStoreStats {
  artifactCount: number;
  storedBytes: number;
  runCount: number;
  hotCacheItems: number;
  hotCacheBytes: number;
}

export class ArtifactStore {
  private readonly maxArtifactBytes: number;
  private readonly maxRunBytes: number;
  private readonly runBytes = new Map<string, number>();
  private readonly artifacts = new Map<string, ArtifactRef>();
  private readonly leases = new Map<string, EvidenceRunLease>();
  private readonly hotDataCache = new Map<string, Buffer>();
  private readonly runArtifactsCache = new Map<string, ArtifactRef[]>();
  private readonly MAX_HOT_CACHE_ITEMS = 32;
  constructor(private readonly options: ArtifactStoreOptions) {
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxRunBytes = options.maxRunBytes ?? 256 * 1024 * 1024;
    this.rehydrateIndex();
    if (options.enableRetentionCleaner) {
      Promise.resolve().then(() => this.sweepRetention()).catch(() => {});
    }
  }

  private getIndexFilePath(runId: string): string {
    return path.join(this.options.root, runId, 'index.json');
  }

  private getRunArtifacts(runId: string): ArtifactRef[] {
    const cached = this.runArtifactsCache.get(runId);
    if (cached) return cached;
    const runArtifacts = [...this.artifacts.values()].filter((a) => a.runId === runId);
    this.runArtifactsCache.set(runId, runArtifacts);
    return runArtifacts;
  }

  private persistRunIndex(runId: string): void {
    try {
      const runDir = path.join(this.options.root, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const runArtifacts = this.getRunArtifacts(runId);
      const indexFile = this.getIndexFilePath(runId);
      const tempPath = `${indexFile}.tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const payload = JSON.stringify(runArtifacts, null, 2);
      fs.writeFileSync(tempPath, payload, 'utf8');
      try {
        fs.renameSync(tempPath, indexFile);
      } catch {
        fs.writeFileSync(indexFile, payload, 'utf8');
        try { fs.unlinkSync(tempPath); } catch {}
      }
    } catch {}
  }

  private async persistRunIndexAsync(runId: string): Promise<void> {
    try {
      const runDir = path.join(this.options.root, runId);
      await fs.promises.mkdir(runDir, { recursive: true });
      const runArtifacts = this.getRunArtifacts(runId);
      const indexFile = this.getIndexFilePath(runId);
      const tempPath = `${indexFile}.tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const payload = JSON.stringify(runArtifacts, null, 2);
      await fs.promises.writeFile(tempPath, payload, 'utf8');
      try {
        await fs.promises.rename(tempPath, indexFile);
      } catch {
        await fs.promises.writeFile(indexFile, payload, 'utf8');
        try { await fs.promises.unlink(tempPath); } catch {}
      }
    } catch {}
  }

  private rehydrateIndex(): void {
    try {
      if (!fs.existsSync(this.options.root)) return;
      const entries = fs.readdirSync(this.options.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runId = entry.name;
        const runDir = path.join(this.options.root, runId);
        let runTotalBytes = 0;
        const indexFile = this.getIndexFilePath(runId);
        if (fs.existsSync(indexFile)) {
          try {
            const raw = fs.readFileSync(indexFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const runList: ArtifactRef[] = [];
              const seenSha = new Set<string>();
              for (const item of parsed) {
                if (item && typeof item.id === 'string' && typeof item.path === 'string') {
                  const ref = item as ArtifactRef;
                  this.artifacts.set(ref.id, ref);
                  runList.push(ref);
                  if (ref.sha256 && !seenSha.has(ref.sha256)) {
                    seenSha.add(ref.sha256);
                    runTotalBytes += ref.byteLength || 0;
                  }
                }
              }
              this.runArtifactsCache.set(runId, runList);
            }
          } catch {}
        } else {
          try {
            const files = fs.readdirSync(runDir);
            for (const f of files) {
              if (f.endsWith('.artifact')) {
                try {
                  const st = fs.statSync(path.join(runDir, f));
                  runTotalBytes += st.size;
                } catch {}
              }
            }
          } catch {}
        }
        this.runBytes.set(runId, runTotalBytes);
      }
    } catch {}
  }

  private assertValidRunId(runId: unknown): string {
    if (!runId || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid runId '${runId}': must contain only alphanumeric characters, underscores, and dashes`);
    }
    return runId;
  }

  private requireByteCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new CapabilityError('INVALID_ARGUMENT', `${field} must be a non-negative integer`);
    }
    return value;
  }

  private requirePositiveInt(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', `${field} must be a positive integer`);
    }
    return value;
  }

  private static tokenMatches(expected: string, provided: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
  }

  /** Active lease for a run, purging an expired record on the way out. */
  private activeLease(runId: string): EvidenceRunLease | undefined {
    const lease = this.leases.get(runId);
    if (!lease) return undefined;
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(runId);
      return undefined;
    }
    return lease;
  }

  /**
   * Authoritative committed bytes for a run, re-read from disk (content-addressed `.artifact` files)
   * so the budget decision never trusts a stale in-memory counter.
   */
  private readCommittedBytesFromDisk(runId: string): number {
    let total = 0;
    try {
      const runDir = path.join(this.options.root, runId);
      for (const entry of fs.readdirSync(runDir)) {
        if (!entry.endsWith('.artifact')) continue;
        try {
          total += fs.statSync(path.join(runDir, entry)).size;
        } catch {}
      }
    } catch {}
    return total;
  }

  private refreshRunBytesFromDisk(runId: string): number {
    const committedBytes = this.readCommittedBytesFromDisk(runId);
    this.runBytes.set(runId, committedBytes);
    return committedBytes;
  }

  /**
   * Lease gate for {@link stage}. Returns the live lease, or undefined when the run is unleased.
   * A token for a lease that is gone is rejected (fail closed) instead of silently staging unleased.
   */
  private resolveLeaseForStage(runId: string, leaseToken?: string): EvidenceRunLease | undefined {
    const lease = this.activeLease(runId);
    if (!lease) {
      if (leaseToken) {
        throw new CapabilityError('LEASE_EXPIRED', `Artifact lease for run '${runId}' is no longer active (released or expired)`);
      }
      return undefined;
    }
    if (!leaseToken || typeof leaseToken !== 'string') {
      throw new CapabilityError('TRANSACTION_CONFLICT', `Run '${runId}' holds an exclusive artifact lease; stage requires the matching leaseToken`);
    }
    if (!ArtifactStore.tokenMatches(lease.leaseToken, leaseToken)) {
      throw new CapabilityError('TRANSACTION_CONFLICT', `Run '${runId}' artifact lease token mismatch; stage rejected`);
    }
    return lease;
  }

  /**
   * Reserve capacity for one evidence run and mint an exclusive lease.
   * Denials are structured (`granted:false` + `reason`) for both lease conflicts and capacity shortfalls;
   * malformed input throws INVALID_ARGUMENT.
   */
  preflight(input: ArtifactPreflightInput): ArtifactPreflightResult {
    const runId = this.assertValidRunId(input?.runId);
    const artifactBytes = this.requireByteCount(input?.artifactBytes, 'artifactBytes');
    const aggregateBytes = input?.aggregateBytes === undefined ? 0 : this.requireByteCount(input.aggregateBytes, 'aggregateBytes');
    const limits = { maxArtifactBytes: this.maxArtifactBytes, maxRunBytes: this.maxRunBytes };
    const committedBytes = this.refreshRunBytesFromDisk(runId);
    const availableRunBytes = Math.max(0, limits.maxRunBytes - committedBytes);
    const base = { runId, limits, committedBytes, availableRunBytes };

    if (this.activeLease(runId)) {
      return { ...base, granted: false, reason: 'LEASE_HELD' };
    }
    if (artifactBytes > limits.maxArtifactBytes) {
      return { ...base, granted: false, reason: 'ARTIFACT_EXCEEDS_LIMIT' };
    }
    if (committedBytes + artifactBytes + aggregateBytes > limits.maxRunBytes) {
      return { ...base, granted: false, reason: 'RUN_BUDGET_EXCEEDED' };
    }

    const leaseTtlMs = input?.leaseTtlMs === undefined ? DEFAULT_EVIDENCE_LEASE_TTL_MS : this.requirePositiveInt(input.leaseTtlMs, 'leaseTtlMs');
    const acquiredAt = Date.now();
    const lease: EvidenceRunLease = {
      runId,
      leaseToken: crypto.randomUUID(),
      acquiredAt,
      expiresAt: acquiredAt + leaseTtlMs,
      maxArtifactBytes: limits.maxArtifactBytes,
      maxRunBytes: limits.maxRunBytes,
    };
    this.leases.set(runId, lease);
    return { ...base, granted: true, leaseToken: lease.leaseToken };
  }

  /** Release a lease. A wrong, expired, or unknown token is a no-op returning `{ released: false }`. */
  releaseLease(runId: string, leaseToken: string): { released: boolean } {
    if (typeof runId !== 'string' || typeof leaseToken !== 'string' || runId.length === 0 || leaseToken.length === 0) {
      return { released: false };
    }
    const lease = this.leases.get(runId);
    if (!lease) return { released: false };
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(runId);
      return { released: false };
    }
    if (!ArtifactStore.tokenMatches(lease.leaseToken, leaseToken)) return { released: false };
    this.leases.delete(runId);
    return { released: true };
  }

  /** Active (non-expired) lease for a run, for diagnostics and lease lifecycle assertions. */
  getLease(runId: string): EvidenceRunLease | undefined {
    if (typeof runId !== 'string') return undefined;
    return this.activeLease(runId);
  }

  stage(input: {
    kind: ArtifactRef['kind'];
    mime: string;
    data: string | Buffer;
    runId: string;
    attemptId: string;
    projectId: string;
    workspaceId: string;
    maxBytes?: number;
    /** Required when the run currently holds an exclusive evidence lease. */
    leaseToken?: string;
    /** Defaults to 'truncate' (historical behavior); 'reject' fails closed before any bytes are written. */
    overflowMode?: ArtifactOverflowMode;
    /** Declared by the caller; `permanent` exempts the artifact from the retention sweep. */
    retentionPolicy?: ArtifactRef['retentionPolicy'];
  }): ArtifactRef {
    const runId = this.assertValidRunId(input.runId);
    const overflowMode: ArtifactOverflowMode = input.overflowMode ?? 'truncate';
    if (overflowMode !== 'truncate' && overflowMode !== 'reject') {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid overflowMode '${String(input.overflowMode)}': expected 'truncate' or 'reject'`);
    }
    const lease = this.resolveLeaseForStage(runId, input.leaseToken);
    if (input.attemptId && (typeof input.attemptId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.attemptId))) {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid attemptId '${input.attemptId}': must contain only alphanumeric characters, underscores, and dashes`);
    }
    if (!input.projectId || typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Valid projectId is required for artifact staging');
    }
    if (!input.workspaceId || typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Valid workspaceId is required for artifact staging');
    }
    const stageStartMs = performance.now();
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
    const artifactCeiling = lease ? Math.min(lease.maxArtifactBytes, this.maxArtifactBytes) : this.maxArtifactBytes;
    const max = Math.min(input.maxBytes ?? artifactCeiling, artifactCeiling);
    if (overflowMode === 'reject' && raw.byteLength > max) {
      throw new CapabilityError('ARTIFACT_TOO_LARGE', `Artifact payload of ${raw.byteLength} bytes exceeds the ${max} byte ceiling for run '${runId}'`, { runId, requestedBytes: raw.byteLength, maxArtifactBytes: max });
    }
    const truncated = raw.byteLength > max;
    const data = raw.subarray(0, max);
    const binary = !isTextLike(input.mime);
    const { data: storedData, redacted } = binary ? { data, redacted: false } : redactSecrets(data);
    const sha256 = crypto.createHash('sha256').update(storedData).digest('hex');
    const artifactPath = path.join(this.options.root, runId, `${sha256}.artifact`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });

    let validExisting = false;
    let stored = 0;
    if (fs.existsSync(artifactPath)) {
      try {
        const stat = fs.statSync(artifactPath);
        if (stat.size === storedData.byteLength) {
          const existingData = fs.readFileSync(artifactPath);
          const existingSha = crypto.createHash('sha256').update(existingData).digest('hex');
          if (existingSha === sha256) {
            validExisting = true;
            stored = stat.size;
          }
        }
      } catch {}
      if (!validExisting) {
        try {
          fs.unlinkSync(artifactPath);
        } catch {}
      }
    }

    if (!validExisting) {
      // Leased runs re-read authoritative committed bytes from disk immediately before the write, so a
      // concurrent writer or an out-of-band deletion cannot be hidden by a stale in-memory counter.
      const committedBytes = lease ? this.refreshRunBytesFromDisk(runId) : (this.runBytes.get(runId) || 0);
      const runCeiling = lease ? Math.min(lease.maxRunBytes, this.maxRunBytes) : this.maxRunBytes;
      if (committedBytes + storedData.byteLength > runCeiling) {
        throw new CapabilityError('ARTIFACT_TOO_LARGE', 'Run artifact budget exceeded', { runId, committedBytes, requestedBytes: storedData.byteLength, maxRunBytes: runCeiling });
      }
      const tmpPath = path.join(path.dirname(artifactPath), `.${sha256}.${Date.now()}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(tmpPath, storedData);
        try {
          fs.renameSync(tmpPath, artifactPath);
        } catch (renameErr) {
          if (fs.existsSync(artifactPath)) {
            try { fs.unlinkSync(artifactPath); } catch {}
            fs.renameSync(tmpPath, artifactPath);
          } else {
            throw renameErr;
          }
        }
      } catch (err) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {}
        throw err;
      }
      stored = fs.statSync(artifactPath).size;
      this.runBytes.set(runId, committedBytes + stored);
    }
    const ref: ArtifactRef = {
      id: `artifact-${crypto.randomUUID()}`,
      runId,
      attemptId: input.attemptId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      path: artifactPath,
      byteLength: stored,
      sha256,
      mime: input.mime,
      truncated,
      redacted,
      createdAt: Date.now(),
      retentionPolicy: input.retentionPolicy,
    };
    this.artifacts.set(ref.id, ref);
    const cachedRunList = this.runArtifactsCache.get(runId);
    if (cachedRunList) {
      cachedRunList.push(ref);
    } else {
      this.runArtifactsCache.set(runId, [ref]);
    }
    this.persistRunIndex(runId);
    if (storedData.byteLength <= 512 * 1024) {
      if (this.hotDataCache.size >= this.MAX_HOT_CACHE_ITEMS) {
        const firstKey = this.hotDataCache.keys().next().value;
        if (firstKey) this.hotDataCache.delete(firstKey);
      }
      this.hotDataCache.set(ref.id, storedData);
    }
    recordBenchmark({ surface: 'artifact', name: 'stage', value: performance.now() - stageStartMs, extra: { kind: input.kind, mime: input.mime, inputBytes: raw.byteLength, storedBytes: stored, truncated, redacted: ref.redacted } });
    return ref;
  }

  async stageAsync(input: {
    kind: ArtifactRef['kind'];
    mime: string;
    data: string | Buffer;
    runId: string;
    attemptId: string;
    projectId: string;
    workspaceId: string;
    maxBytes?: number;
    /** Required when the run currently holds an exclusive evidence lease. */
    leaseToken?: string;
    /** Defaults to 'truncate' (historical behavior); 'reject' fails closed before any bytes are written. */
    overflowMode?: ArtifactOverflowMode;
    /** Declared by the caller; `permanent` exempts the artifact from the retention sweep. */
    retentionPolicy?: ArtifactRef['retentionPolicy'];
  }): Promise<ArtifactRef> {
    const runId = this.assertValidRunId(input.runId);
    const overflowMode: ArtifactOverflowMode = input.overflowMode ?? 'truncate';
    if (overflowMode !== 'truncate' && overflowMode !== 'reject') {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid overflowMode '${String(input.overflowMode)}': expected 'truncate' or 'reject'`);
    }
    const lease = this.resolveLeaseForStage(runId, input.leaseToken);
    if (input.attemptId && (typeof input.attemptId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.attemptId))) {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid attemptId '${input.attemptId}': must contain only alphanumeric characters, underscores, and dashes`);
    }
    if (!input.projectId || typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Valid projectId is required for artifact staging');
    }
    if (!input.workspaceId || typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Valid workspaceId is required for artifact staging');
    }
    const stageStartMs = performance.now();
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
    const artifactCeiling = lease ? Math.min(lease.maxArtifactBytes, this.maxArtifactBytes) : this.maxArtifactBytes;
    const max = Math.min(input.maxBytes ?? artifactCeiling, artifactCeiling);
    if (overflowMode === 'reject' && raw.byteLength > max) {
      throw new CapabilityError('ARTIFACT_TOO_LARGE', `Artifact payload of ${raw.byteLength} bytes exceeds the ${max} byte ceiling for run '${runId}'`, { runId, requestedBytes: raw.byteLength, maxArtifactBytes: max });
    }
    const truncated = raw.byteLength > max;
    const data = raw.subarray(0, max);
    const binary = !isTextLike(input.mime);
    const { data: storedData, redacted } = binary ? { data, redacted: false } : redactSecrets(data);
    const sha256 = crypto.createHash('sha256').update(storedData).digest('hex');
    const artifactPath = path.join(this.options.root, runId, `${sha256}.artifact`);
    await fs.promises.mkdir(path.dirname(artifactPath), { recursive: true });

    let validExisting = false;
    let stored = 0;
    try {
      const stat = await fs.promises.stat(artifactPath);
      if (stat.size === storedData.byteLength) {
        const existingData = await fs.promises.readFile(artifactPath);
        const existingSha = crypto.createHash('sha256').update(existingData).digest('hex');
        if (existingSha === sha256) {
          validExisting = true;
          stored = stat.size;
        }
      }
    } catch {}
    if (!validExisting) {
      try {
        await fs.promises.unlink(artifactPath);
      } catch {}
    }

    if (!validExisting) {
      const committedBytes = lease ? this.refreshRunBytesFromDisk(runId) : (this.runBytes.get(runId) || 0);
      const runCeiling = lease ? Math.min(lease.maxRunBytes, this.maxRunBytes) : this.maxRunBytes;
      if (committedBytes + storedData.byteLength > runCeiling) {
        throw new CapabilityError('ARTIFACT_TOO_LARGE', 'Run artifact budget exceeded', { runId, committedBytes, requestedBytes: storedData.byteLength, maxRunBytes: runCeiling });
      }
      const tmpPath = path.join(path.dirname(artifactPath), `.${sha256}.${Date.now()}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.promises.writeFile(tmpPath, storedData);
        try {
          await fs.promises.rename(tmpPath, artifactPath);
        } catch (renameErr) {
          try { await fs.promises.unlink(artifactPath); } catch {}
          await fs.promises.rename(tmpPath, artifactPath);
        }
      } catch (err) {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {}
        throw err;
      }
      stored = (await fs.promises.stat(artifactPath)).size;
      this.runBytes.set(runId, committedBytes + stored);
    }
    const ref: ArtifactRef = {
      id: `artifact-${crypto.randomUUID()}`,
      runId,
      attemptId: input.attemptId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      path: artifactPath,
      byteLength: stored,
      sha256,
      mime: input.mime,
      truncated,
      redacted,
      createdAt: Date.now(),
      retentionPolicy: input.retentionPolicy,
    };
    this.artifacts.set(ref.id, ref);
    const cachedRunList = this.runArtifactsCache.get(runId);
    if (cachedRunList) {
      cachedRunList.push(ref);
    } else {
      this.runArtifactsCache.set(runId, [ref]);
    }
    await this.persistRunIndexAsync(runId);
    if (storedData.byteLength <= 512 * 1024) {
      if (this.hotDataCache.size >= this.MAX_HOT_CACHE_ITEMS) {
        const firstKey = this.hotDataCache.keys().next().value;
        if (firstKey) this.hotDataCache.delete(firstKey);
      }
      this.hotDataCache.set(ref.id, storedData);
    }
    recordBenchmark({ surface: 'artifact', name: 'stage', value: performance.now() - stageStartMs, extra: { kind: input.kind, mime: input.mime, inputBytes: raw.byteLength, storedBytes: stored, truncated, redacted: ref.redacted } });
    return ref;
  }

  get(id: string): ArtifactRef | undefined {
    return this.artifacts.get(id);
  }

  readBytesById(
    id: string,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): { ref: ArtifactRef; data: Buffer } {
    const ref = this.artifacts.get(id);
    if (!ref) throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found in store`);

    if (context) {
      if (context.runId && context.runId !== ref.runId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
      if (context.attemptId && context.attemptId !== ref.attemptId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
      if (context.projectId && context.projectId !== ref.projectId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
      if (context.workspaceId && context.workspaceId !== ref.workspaceId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
    }

    const resolved = path.resolve(ref.path);
    const rootResolved = path.resolve(this.options.root);
    const rootPrefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
    if (!resolved.startsWith(rootPrefix) || resolved === rootResolved) {
      throw new CapabilityError('OUTSIDE_WORKSPACE', 'Artifact path containment violation');
    }

    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        throw new CapabilityError('OUTSIDE_WORKSPACE', 'Artifact symbolic links are not permitted');
      }
      const canonicalRealpath = fs.realpathSync.native(resolved);
      const canonicalRoot = fs.realpathSync.native(rootResolved);
      const canonicalRootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
      if (
        !canonicalRealpath.toLowerCase().startsWith(canonicalRootPrefix.toLowerCase()) ||
        canonicalRealpath.toLowerCase() === canonicalRoot.toLowerCase()
      ) {
        throw new CapabilityError('OUTSIDE_WORKSPACE', 'Artifact realpath containment violation');
      }
      const cached = this.hotDataCache.get(id);
      if (cached) {
        const cachedSha = crypto.createHash('sha256').update(cached).digest('hex');
        if (cachedSha !== ref.sha256) {
          throw new CapabilityError('INTEGRITY_COMPROMISED', 'Artifact hash verification failed: content corrupted');
        }
        return { ref, data: cached };
      }
      const diskData = fs.readFileSync(resolved);
      const diskSha = crypto.createHash('sha256').update(diskData).digest('hex');
      if (diskSha !== ref.sha256) {
        throw new CapabilityError('INTEGRITY_COMPROMISED', 'Artifact hash verification failed: content corrupted');
      }
      if (diskData.byteLength <= 512 * 1024) {
        if (this.hotDataCache.size >= this.MAX_HOT_CACHE_ITEMS) {
          const firstKey = this.hotDataCache.keys().next().value;
          if (firstKey) this.hotDataCache.delete(firstKey);
        }
        this.hotDataCache.set(id, diskData);
      }
      return { ref, data: diskData };
    } catch (err) {
      if (err instanceof CapabilityError) throw err;
      throw new CapabilityError('INVALID_ARGUMENT', `Failed to read artifact: ${(err as Error).message}`);
    }
  }

  readTextById(
    id: string,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): { ref: ArtifactRef; text: string } {
    const { ref, data } = this.readBytesById(id, context);
    return { ref, text: data.toString('utf8') };
  }

  readChunkById(
    id: string,
    offset = 0,
    limit = 1024 * 1024,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): ArtifactReadResult {
    const { ref, data } = this.readBytesById(id, context);
    const maxChunkLimit = 1024 * 1024;
    const chunkLimit = Math.min(Math.max(1, limit), maxChunkLimit);
    const chunkOffset = Math.max(0, offset);
    const totalBytes = data.byteLength;
    const slice = data.subarray(chunkOffset, chunkOffset + chunkLimit);
    const hasMore = chunkOffset + slice.byteLength < totalBytes;
    const isText = isTextLike(ref.mime);
    const encoding: 'utf8' | 'base64' = isText ? 'utf8' : 'base64';
    const chunkStr = isText ? slice.toString('utf8') : slice.toString('base64');

    return {
      artifactId: ref.id,
      offset: chunkOffset,
      limit: slice.byteLength,
      totalBytes,
      hasMore,
      mime: ref.mime,
      encoding,
      data: chunkStr,
    };
  }

  stat(
    id: string,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): ArtifactRef {
    const ref = this.artifacts.get(id);
    if (!ref) throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found in store`);
    if (context) {
      if (context.runId && context.runId !== ref.runId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
      if (context.attemptId && context.attemptId !== ref.attemptId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
      if (context.projectId && context.projectId !== ref.projectId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
      if (context.workspaceId && context.workspaceId !== ref.workspaceId) {
        throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found`);
      }
    }
    return ref;
  }
  public getStats(): ArtifactStoreStats {
    let storedBytes = 0;
    for (const bytes of this.runBytes.values()) storedBytes += bytes;
    let hotCacheBytes = 0;
    for (const data of this.hotDataCache.values()) hotCacheBytes += data.byteLength;
    return {
      artifactCount: this.artifacts.size,
      storedBytes,
      runCount: this.runBytes.size,
      hotCacheItems: this.hotDataCache.size,
      hotCacheBytes,
    };
  }


  sweepRetention(options?: RetentionSweepOptions): RetentionSweepResult {
    // `permanent` artifacts are exempt from the age/budget sweep: report.generate is the only
    // capability declared permanent, and it stages through this store. Index entries written before
    // the policy was recorded carry no `retentionPolicy`, so a `kind: 'report'` artifact with an
    // unset policy is exempt as well — guessing the other way would delete evidence that predates
    // the field. Any caller-supplied exemption is composed in.
    const protectedPaths = new Set<string>();
    for (const ref of this.artifacts.values()) {
      const permanent = ref.retentionPolicy === 'permanent'
        || (ref.retentionPolicy === undefined && ref.kind === 'report');
      if (permanent) {
        protectedPaths.add(path.resolve(ref.path));
      }
    }
    const effective = options ?? this.options.retentionOptions;
    return ArtifactRetentionCleaner.sweep(this.options.root, {
      ...(effective ?? {}),
      isProtected: (absolutePath) =>
        protectedPaths.has(path.resolve(absolutePath)) || effective?.isProtected?.(absolutePath) === true,
    });
  }
}

function isTextLike(mime: string): boolean {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (base.startsWith('text/')) return true;
  return base === 'application/json' || base === 'application/xml' || base === 'image/svg+xml' || base.endsWith('+json') || base.endsWith('+xml');
}

function redactSecrets(data: Buffer): { data: Buffer; redacted: boolean } {
  const text = data.toString('utf8');
  if (!/[A-Za-z0-9+/=_-]{20,}/.test(text)) return { data, redacted: false };
  // JSON-key-aware pass first: quoted key + colon + string value -> replace the VALUE only, keeping valid JSON syntax.
  const jsonSafe = text.replace(/("(?:token|secret|password|api[_-]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"');
  // Legacy flat form (key=value / key: value) for non-JSON text; never matches quoted JSON keys.
  const replaced = jsonSafe.replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  return { data: Buffer.from(replaced, 'utf8'), redacted: replaced !== text };
}
