import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  CapabilityError,
  ClientInvocationIntent,
  InvocationDispatchStage,
  MainResolvedAuthority,
  canonicalDigest,
  canonicalJsonStringify,
  makeControlPlaneId,
} from '../../shared/control-plane-contracts';

export type InvocationState = 'claiming' | 'in_progress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export { InvocationDispatchStage };

export interface InvocationRecord {
  formatVersion: number;
  id: string; // invocationId
  attachmentId: string;
  requestId: string;
  idempotencyKey: string;
  name: string;
  paramDigest: string;
  policyDigest: string;
  policyVersion: number;
  recordedVisibility: string;
  state: InvocationState;
  dispatchStage?: InvocationDispatchStage;
  authoritySnapshot: MainResolvedAuthority;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  evidence?: Record<string, unknown>;
  replacementAuthorityRevision?: string;
  artifactIds?: string[];
  createdAt: number;
  settledAt?: number;
  checksum?: string;
}

export interface InvocationClaimResult {
  kind: 'owner' | 'join' | 'replay';
  invocationId: string;
  record?: InvocationRecord;
  promise?: Promise<InvocationRecord>;
}

export interface InvocationLedgerOptions {
  dataRoot: string;
  maxHotRecordsPerPartition?: number;
}

interface InFlightClaim {
  record: InvocationRecord;
  resolve: (record: InvocationRecord) => void;
  reject: (err: unknown) => void;
  promise: Promise<InvocationRecord>;
}

function computeFrameChecksum(frame: Omit<InvocationRecord, 'checksum'>): string {
  const serialized = canonicalJsonStringify(frame);
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export class InvocationLedger {
  private readonly partitionsDir: string;
  private readonly maxHotRecords: number;
  // attachmentId -> Map(idempotencyKey, InvocationRecord)
  private readonly hotPartitions = new Map<string, Map<string, InvocationRecord>>();
  // invocationId -> InFlightClaim
  private readonly inFlight = new Map<string, InFlightClaim>();
  // invocationId -> attachmentId
  private readonly invocationToAttachment = new Map<string, string>();
  private readonly quarantinedPartitions = new Set<string>();
  private readonly poisonedPartitions = new Set<string>();
  private readonly ioQueues = new Map<string, Promise<void>>();
  private readonly uncompactedFrameCounts = new Map<string, number>();

  constructor(private readonly options: InvocationLedgerOptions) {
    this.partitionsDir = path.join(options.dataRoot, 'invocations');
    this.maxHotRecords = options.maxHotRecordsPerPartition ?? 200;
  }

  public async initialize(): Promise<void> {
    if (!fs.existsSync(this.partitionsDir)) {
      fs.mkdirSync(this.partitionsDir, { recursive: true });
      return;
    }
    const files = fs.readdirSync(this.partitionsDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const attachmentId = path.basename(file, '.jsonl');
      await this.replayPartition(attachmentId);
    }
  }

  public isQuarantined(attachmentId: string): boolean {
    return this.quarantinedPartitions.has(attachmentId);
  }

  public isPoisoned(attachmentId: string): boolean {
    return this.poisonedPartitions.has(attachmentId);
  }

  private getPartitionPath(attachmentId: string): string {
    return path.join(this.partitionsDir, `${attachmentId}.jsonl`);
  }

  private async replayPartition(attachmentId: string): Promise<void> {
    const filePath = this.getPartitionPath(attachmentId);
    if (!fs.existsSync(filePath)) return;

    const partitionMap = new Map<string, InvocationRecord>();
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

    let needsCompaction = false;
    for (const line of lines) {
      try {
        const frame = JSON.parse(line) as InvocationRecord;
        if (!frame.id || !frame.idempotencyKey || !frame.attachmentId || frame.formatVersion !== 1) {
          // Corrupt or unsupported format version: quarantine partition and fail closed
          this.quarantinePartition(attachmentId, filePath);
          return;
        }
        if (!frame.checksum) {
          this.quarantinePartition(attachmentId, filePath);
          return;
        }
        const { checksum, ...rest } = frame;
        const calculated = computeFrameChecksum(rest);
        if (checksum !== calculated) {
          this.quarantinePartition(attachmentId, filePath);
          return;
        }

        // Check if startup recovery needed for claiming or in_progress
        if (frame.state === 'claiming' || frame.state === 'in_progress') {
          if (frame.dispatchStage === 'dispatch_started') {
            frame.state = 'unknown';
            frame.settledAt = Date.now();
            frame.error = {
              code: 'EXECUTION_UNKNOWN',
              message: 'Execution state unknown due to process termination after dispatch started',
            };
          } else {
            frame.state = 'interrupted';
            frame.settledAt = Date.now();
            frame.error = {
              code: 'PROCESS_INTERRUPTED',
              message: 'Execution was interrupted by process crash or restart',
            };
          }
          needsCompaction = true;
        }

        partitionMap.set(frame.idempotencyKey, frame);
        this.invocationToAttachment.set(frame.id, frame.attachmentId);
      } catch {
        this.quarantinePartition(attachmentId, filePath);
        return;
      }
    }
    this.hotPartitions.set(attachmentId, partitionMap);
    this.uncompactedFrameCounts.set(attachmentId, Math.max(0, lines.length - partitionMap.size));
    if (needsCompaction) {
      await this.compactPartitionUnlocked(attachmentId);
    }
  }

  private quarantinePartition(attachmentId: string, filePath: string): void {
    this.quarantinedPartitions.add(attachmentId);
    this.hotPartitions.delete(attachmentId);
    const quarantinePath = `${filePath}.quarantine-${Date.now()}`;
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, quarantinePath);
      }
    } catch {}
  }

  private poisonPartition(attachmentId: string, reason: string): void {
    this.poisonedPartitions.add(attachmentId);
    // Reject in-flight waiters for this partition with durability error
    for (const [invId, claim] of this.inFlight.entries()) {
      if (claim.record.attachmentId === attachmentId) {
        claim.reject(new CapabilityError('DURABILITY_FAILED', `Partition ${attachmentId} is poisoned due to append ambiguity: ${reason}`));
        this.inFlight.delete(invId);
      }
    }
  }

  public async observe(
    intent: ClientInvocationIntent,
    authority: MainResolvedAuthority
  ): Promise<InvocationClaimResult | undefined> {
    const attachmentId = intent.attachmentId;
    if (this.quarantinedPartitions.has(attachmentId)) {
      throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is corrupted and quarantined. All execution on this attachment is halted.`);
    }

    let partition = this.hotPartitions.get(attachmentId);
    if (!partition) {
      partition = new Map<string, InvocationRecord>();
      this.hotPartitions.set(attachmentId, partition);
      if (fs.existsSync(this.getPartitionPath(attachmentId))) {
        await this.replayPartition(attachmentId);
        if (this.quarantinedPartitions.has(attachmentId)) {
          throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is corrupted and quarantined. All execution on this attachment is halted.`);
        }
        partition = this.hotPartitions.get(attachmentId)!;
      }
    }
    const paramDigest = canonicalDigest(intent.params || {});
    const existing = partition.get(intent.idempotencyKey);

    if (!existing) return undefined;

    // Validate lineage and binding consistency
    if (
      existing.name !== intent.name ||
      existing.paramDigest !== paramDigest ||
      existing.authoritySnapshot.projectId !== authority.projectId ||
      existing.authoritySnapshot.workspaceId !== authority.workspaceId ||
      existing.authoritySnapshot.runId !== authority.runId ||
      existing.authoritySnapshot.attemptId !== authority.attemptId
    ) {
      throw new CapabilityError('BINDING_COLLISION', 'Invocation binding collision: same idempotencyKey with different parameters or lineage');
    }

    if (existing.state === 'completed' || existing.state === 'failed' || existing.state === 'interrupted' || existing.state === 'unknown') {
      return {
        kind: 'replay',
        invocationId: existing.id,
        record: { ...existing },
      };
    }
    // If partition is poisoned due to append ambiguity, in-flight execution/JOIN cannot proceed and new claims are denied
    if (this.poisonedPartitions.has(attachmentId)) {
      throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is poisoned due to append ambiguity. In-flight execution/JOIN is denied.`);
    }

    // Existing is in-flight: join
    const inFlightClaim = this.inFlight.get(existing.id);
    if (inFlightClaim) {
      return {
        kind: 'join',
        invocationId: existing.id,
        promise: inFlightClaim.promise,
      };
    }

    return {
      kind: 'replay',
      invocationId: existing.id,
      record: { ...existing },
    };
  }

  public async claimOwner(
    intent: ClientInvocationIntent,
    liveAuthority: MainResolvedAuthority,
    policyDigest: string,
    policyVersion: number,
    recordedVisibility: string
  ): Promise<InvocationClaimResult> {
    const attachmentId = intent.attachmentId;
    if (this.quarantinedPartitions.has(attachmentId)) {
      throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is corrupted and quarantined. All execution on this attachment is halted.`);
    }
    if (this.poisonedPartitions.has(attachmentId)) {
      throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is poisoned due to append ambiguity. All execution on this attachment is halted.`);
    }

    let shouldCompact = false;
    const result = await this.runWithIOLock(attachmentId, async () => {
      // Idempotency check strictly under the serialization lock
      const existing = await this.observe(intent, liveAuthority);
      if (existing) return existing;

      let partition = this.hotPartitions.get(attachmentId);
      if (!partition) {
        partition = new Map<string, InvocationRecord>();
        this.hotPartitions.set(attachmentId, partition);
      }

      const paramDigest = canonicalDigest(intent.params || {});
      const invocationId = makeControlPlaneId('invocation');
      const now = Date.now();
      const newRecord: InvocationRecord = {
        formatVersion: 1,
        id: invocationId,
        attachmentId,
        requestId: intent.requestId,
        idempotencyKey: intent.idempotencyKey,
        name: intent.name,
        paramDigest,
        policyDigest,
        policyVersion,
        recordedVisibility,
        state: 'in_progress',
        dispatchStage: 'pre_dispatch',
        authoritySnapshot: liveAuthority,
        createdAt: now,
      };

      // Durably append to disk first while holding IO lock
      try {
        await this.appendFrameUnlocked(newRecord);
      } catch (err) {
        // Reconcile append error under lock: failed initial claim evicts only if proven absent from disk.
        // If any line fails parse or checksum, or file content is uncertain, it must poison, not evict.
        const filePath = this.getPartitionPath(attachmentId);
        let isProvenAbsent = false;
        try {
          if (!fs.existsSync(filePath)) {
            isProvenAbsent = true;
          } else {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
            let foundOnDisk = false;
            let hasInvalidFrame = false;
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as InvocationRecord;
                if (!parsed.checksum) {
                  hasInvalidFrame = true;
                  break;
                }
                const { checksum, ...rest } = parsed;
                if (computeFrameChecksum(rest) !== checksum) {
                  hasInvalidFrame = true;
                  break;
                }
                if (parsed.id === newRecord.id) {
                  foundOnDisk = true;
                  break;
                }
              } catch {
                hasInvalidFrame = true;
                break;
              }
            }
            if (!foundOnDisk && !hasInvalidFrame) {
              isProvenAbsent = true;
            }
          }
        } catch {
          isProvenAbsent = false;
        }

        if (isProvenAbsent) {
          throw new CapabilityError('DURABILITY_FAILED', `Failed to durably persist invocation claim: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          this.poisonPartition(attachmentId, err instanceof Error ? err.message : String(err));
          throw new CapabilityError('DURABILITY_FAILED', `Ambiguous append failure on claim: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let resolvePromise!: (record: InvocationRecord) => void;
      let rejectPromise!: (err: unknown) => void;
      const promise = new Promise<InvocationRecord>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      promise.catch(() => {});
      const inFlightEntry: InFlightClaim = {
        record: newRecord,
        resolve: resolvePromise,
        reject: rejectPromise,
        promise,
      };

      // Update in-memory state only after successful disk append
      partition.set(intent.idempotencyKey, newRecord);
      this.inFlight.set(invocationId, inFlightEntry);
      this.invocationToAttachment.set(invocationId, attachmentId);

      const currentFrames = this.uncompactedFrameCounts.get(attachmentId) || 0;
      if (currentFrames >= this.maxHotRecords) {
        shouldCompact = true;
      }

      const ownerResult: InvocationClaimResult = {
        kind: 'owner',
        invocationId,
        record: { ...newRecord },
      };
      return ownerResult;
    });

    if (shouldCompact) {
      this.compactPartition(attachmentId).catch(() => {});
    }

    return result;
  }

  public async claimOrObserve(
    intent: ClientInvocationIntent,
    authority: MainResolvedAuthority,
    policyDigest: string,
    policyVersion: number,
    recordedVisibility: string
  ): Promise<InvocationClaimResult> {
    const existing = await this.observe(intent, authority);
    if (existing) return existing;
    return this.claimOwner(intent, authority, policyDigest, policyVersion, recordedVisibility);
  }

  public async advanceStage(
    invocationId: string,
    stage: InvocationDispatchStage
  ): Promise<InvocationRecord> {
    const attachmentId = this.invocationToAttachment.get(invocationId);
    if (!attachmentId) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown invocation ID: ${invocationId}`);
    }

    return this.runWithIOLock(attachmentId, async () => {
      if (this.quarantinedPartitions.has(attachmentId)) {
        throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is corrupted and quarantined.`);
      }
      if (this.poisonedPartitions.has(attachmentId)) {
        throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is poisoned due to append ambiguity.`);
      }

      const partition = this.hotPartitions.get(attachmentId);
      if (!partition) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Invocation partition not found for: ${attachmentId}`);
      }

      let existing: InvocationRecord | undefined;
      for (const rec of partition.values()) {
        if (rec.id === invocationId) {
          existing = rec;
          break;
        }
      }

      if (!existing) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Invocation record not found for: ${invocationId}`);
      }

      if (existing.state === 'completed' || existing.state === 'failed' || existing.state === 'interrupted' || existing.state === 'unknown') {
        return { ...existing };
      }

      if (existing.dispatchStage === stage) {
        return { ...existing };
      }

      const updatedRecord: InvocationRecord = {
        ...existing,
        dispatchStage: stage,
      };

      try {
        await this.appendFrameUnlocked(updatedRecord);
      } catch (err) {
        this.poisonPartition(attachmentId, `Failed to advance dispatch stage to ${stage}: ${err instanceof Error ? err.message : String(err)}`);
        throw new CapabilityError('DURABILITY_FAILED', `Failed to durably advance dispatch stage to ${stage}: ${err instanceof Error ? err.message : String(err)}`);
      }

      partition.set(existing.idempotencyKey, updatedRecord);
      const inFlightEntry = this.inFlight.get(invocationId);
      if (inFlightEntry) {
        inFlightEntry.record = updatedRecord;
      }

      return { ...updatedRecord };
    });
  }

  public async settle(
    invocationId: string,
    state: 'completed' | 'failed' | 'interrupted' | 'unknown',
    data?: unknown,
    error?: { code: string; message: string; details?: unknown },
    evidence?: Record<string, unknown>,
    artifactIds?: string[],
    replacementAuthorityRevision?: string
  ): Promise<InvocationRecord> {
    const attachmentId = this.invocationToAttachment.get(invocationId);
    if (!attachmentId) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown invocation ID: ${invocationId}`);
    }

    let shouldCompact = false;
    const settled = await this.runWithIOLock(attachmentId, async () => {
      if (this.quarantinedPartitions.has(attachmentId)) {
        throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is corrupted and quarantined.`);
      }
      if (this.poisonedPartitions.has(attachmentId)) {
        throw new CapabilityError('DURABILITY_FAILED', `Invocation partition for attachment ${attachmentId} is poisoned due to append ambiguity.`);
      }

      const partition = this.hotPartitions.get(attachmentId);
      if (!partition) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Invocation partition not found for: ${attachmentId}`);
      }

      let existing: InvocationRecord | undefined;
      for (const rec of partition.values()) {
        if (rec.id === invocationId) {
          existing = rec;
          break;
        }
      }

      if (!existing) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Invocation record not found for: ${invocationId}`);
      }

      if (existing.state === 'completed' || existing.state === 'failed' || existing.state === 'interrupted' || existing.state === 'unknown') {
        return { ...existing };
      }

      const settledRecord: InvocationRecord = {
        ...existing,
        state,
        result: data,
        error,
        evidence,
        artifactIds,
        replacementAuthorityRevision,
        settledAt: Date.now(),
      };

      try {
        await this.appendFrameUnlocked(settledRecord);
      } catch (err) {
        this.poisonPartition(attachmentId, `Failed to settle invocation: ${err instanceof Error ? err.message : String(err)}`);
        throw new CapabilityError('DURABILITY_FAILED', `Failed to durably settle invocation: ${err instanceof Error ? err.message : String(err)}`);
      }

      partition.set(existing.idempotencyKey, settledRecord);

      const inFlightEntry = this.inFlight.get(invocationId);
      if (inFlightEntry) {
        this.inFlight.delete(invocationId);
        inFlightEntry.resolve(settledRecord);
      }

      const currentFrames = this.uncompactedFrameCounts.get(attachmentId) || 0;
      if (currentFrames >= this.maxHotRecords) {
        shouldCompact = true;
      }

      return { ...settledRecord };
    });

    if (shouldCompact) {
      this.compactPartition(attachmentId).catch(() => {});
    }

    return settled;
  }

  public getRecord(invocationId: string): InvocationRecord | undefined {
    const attachmentId = this.invocationToAttachment.get(invocationId);
    if (!attachmentId) return undefined;
    const partition = this.hotPartitions.get(attachmentId);
    if (!partition) return undefined;
    for (const rec of partition.values()) {
      if (rec.id === invocationId) return { ...rec };
    }
    return undefined;
  }

  public async drain(attachmentId?: string): Promise<void> {
    if (attachmentId) {
      await this.runWithIOLock(attachmentId, async () => {});
      return;
    }
    const activeKeys = Array.from(this.ioQueues.keys());
    await Promise.all(activeKeys.map((id) => this.runWithIOLock(id, async () => {})));
  }

  private async runWithIOLock<T>(attachmentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ioQueues.get(attachmentId) || Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => { resolveNext = r; });
    this.ioQueues.set(attachmentId, next);

    await prev;
    try {
      return await fn();
    } finally {
      resolveNext();
      if (this.ioQueues.get(attachmentId) === next) {
        this.ioQueues.delete(attachmentId);
      }
    }
  }

  private async appendFrameUnlocked(record: InvocationRecord): Promise<void> {
    const filePath = this.getPartitionPath(record.attachmentId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const { checksum, ...rest } = record;
    const calculatedChecksum = computeFrameChecksum(rest);
    const frameWithChecksum: InvocationRecord = {
      ...rest,
      checksum: calculatedChecksum,
    };

    const line = JSON.stringify(frameWithChecksum) + '\n';
    await fs.promises.appendFile(filePath, line, 'utf8');
    const count = (this.uncompactedFrameCounts.get(record.attachmentId) || 0) + 1;
    this.uncompactedFrameCounts.set(record.attachmentId, count);
  }

  private async appendFrame(record: InvocationRecord): Promise<void> {
    return this.runWithIOLock(record.attachmentId, async () => {
      return this.appendFrameUnlocked(record);
    });
  }

  private async compactPartitionUnlocked(attachmentId: string): Promise<void> {
    const filePath = this.getPartitionPath(attachmentId);
    const partition = this.hotPartitions.get(attachmentId);
    if (!partition || partition.size === 0) return;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Coalesce multi-frame history into single latest-state frame per idempotencyKey
    const records = Array.from(partition.values());
    const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;

    try {
      const content = records
        .map((rec) => {
          const { checksum, ...rest } = rec;
          const calc = computeFrameChecksum(rest);
          return JSON.stringify({ ...rest, checksum: calc });
        })
        .join('\n') + (records.length > 0 ? '\n' : '');

      await fs.promises.writeFile(tempFile, content, 'utf8');
      await fs.promises.rename(tempFile, filePath);
      this.uncompactedFrameCounts.set(attachmentId, 0);
    } catch (err) {
      try {
        if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
      } catch {}
      throw err;
    }
  }

  public async compactPartition(attachmentId: string): Promise<void> {
    return this.runWithIOLock(attachmentId, async () => {
      return this.compactPartitionUnlocked(attachmentId);
    });
  }
}
