import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  CapabilityError,
  ClientInvocationIntent,
  MainResolvedAuthority,
  canonicalDigest,
  canonicalJsonStringify,
  makeControlPlaneId,
} from '../../shared/control-plane-contracts';

export type InvocationState = 'claiming' | 'in_progress' | 'completed' | 'failed' | 'interrupted' | 'unknown';

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
          frame.state = 'interrupted';
          frame.settledAt = Date.now();
          frame.error = {
            code: 'PROCESS_INTERRUPTED',
            message: 'Execution was interrupted by process crash or restart',
          };
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
    if (needsCompaction) {
      await this.compactPartition(attachmentId);
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
      authoritySnapshot: liveAuthority,
      createdAt: now,
    };

    let resolvePromise!: (record: InvocationRecord) => void;
    let rejectPromise!: (err: unknown) => void;
    const promise = new Promise<InvocationRecord>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const inFlightEntry: InFlightClaim = {
      record: newRecord,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
    };

    // Atomically register in hot state and inFlight
    partition.set(intent.idempotencyKey, newRecord);
    this.inFlight.set(invocationId, inFlightEntry);
    this.invocationToAttachment.set(invocationId, attachmentId);

    // Durably append to disk
    try {
      await this.appendFrame(newRecord);
    } catch (err) {
      partition.delete(intent.idempotencyKey);
      this.inFlight.delete(invocationId);
      this.invocationToAttachment.delete(invocationId);
      rejectPromise(err);
      throw new CapabilityError('DURABILITY_FAILED', `Failed to durably persist invocation claim: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      kind: 'owner',
      invocationId,
      record: { ...newRecord },
    };
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

    partition.set(existing.idempotencyKey, settledRecord);
    await this.appendFrame(settledRecord);

    const inFlightEntry = this.inFlight.get(invocationId);
    if (inFlightEntry) {
      this.inFlight.delete(invocationId);
      if (state === 'failed' && error) {
        inFlightEntry.resolve(settledRecord);
      } else {
        inFlightEntry.resolve(settledRecord);
      }
    }

    return { ...settledRecord };
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

  private async appendFrame(record: InvocationRecord): Promise<void> {
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
  }

  private async compactPartition(attachmentId: string): Promise<void> {
    const filePath = this.getPartitionPath(attachmentId);
    const partition = this.hotPartitions.get(attachmentId);
    if (!partition) return;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const records = Array.from(partition.values()).slice(-this.maxHotRecords);
    const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;

    const content = records
      .map((rec) => {
        const { checksum, ...rest } = rec;
        const calc = computeFrameChecksum(rest);
        return JSON.stringify({ ...rest, checksum: calc });
      })
      .join('\n') + (records.length > 0 ? '\n' : '');

    await fs.promises.writeFile(tempFile, content, 'utf8');
    await fs.promises.rename(tempFile, filePath);
  }
}
