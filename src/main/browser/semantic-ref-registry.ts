/**
 * AntiFan Browser Desktop - Main-Owned Semantic Ref Registry
 * Pure Main-side registry for monotonic ref allocation, target snapshot lifecycle,
 * and exact-target descriptor resolution.
 */

import * as crypto from 'node:crypto';
import { CapabilityError } from '../../shared/control-plane-contracts';
import {
  isSemanticRef,
  parseSemanticRefIndex,
  generateCollectionNonce,
  validateUuid,
  validateTargetVersions,
  formatSemanticSnapshot,
  formatSemanticSnapshotPrompt,
  validateRawDescriptor,
  RawElementDescriptor,
  SemanticElementDescriptor,
  SemanticSnapshotRecord,
  StorefrontMetadata,
  ElementGlobalRect,
  MAX_SNAPSHOT_DESCRIPTORS,
  MAX_TOTAL_SERIALIZED_BYTES,
} from './semantic-ref-types';

export interface TargetIdentifier {
  tabId: string;
  paneId?: string;
  browserEpoch?: number;
  documentGeneration?: number;
  documentUrl?: string;
}

export interface PublishSnapshotParams {
  tabId: string;
  paneId?: string;
  browserEpoch: number;
  documentGeneration: number;
  documentUrl: string;
  sequence: number;
  nonce: string;
  rawDescriptors: RawElementDescriptor[];
}

export interface SnapshotPublishResult {
  snapshotId: string;
  formattedText: string;
  count: number;
  refs: string[];
}

export interface FindSnapshotParams {
  tabId: string;
  paneId?: string;
  text?: string;
  regex?: string;
  maxMatches?: number;
}

export interface FindMatchItem {
  ref: string;
  role: string;
  type?: string;
  label: string;
  id?: string;
  rect?: ElementGlobalRect;
  metadata?: StorefrontMetadata;
  snippet: string;
}

export interface SnapshotFindResult {
  matches: FindMatchItem[];
  count: number;
  formattedText: string;
  query: string;
  snapshotId?: string;
}
export interface RegistryStats {
  activeTargets: number;
  totalDescriptors: number;
  highWaterRefIndex: number;
  isDisposed: boolean;
}

export interface RegistryLimits {
  maxSnapshotDescriptors?: number;
  maxTotalSerializedBytes?: number;
  maxTotalProcessDescriptors?: number;
  maxRecordAgeMs?: number;
  clock?: () => number;
}

interface PendingCollection {
  sequence: number;
  nonce: string;
  browserEpoch: number;
  documentGeneration: number;
  documentUrl: string;
  startedAt: number;
}

export const DEFAULT_MAX_PROCESS_DESCRIPTORS = 10_000;
export const DEFAULT_MAX_RECORD_AGE_MS = 5 * 60 * 1000; // 5 minutes

export function makeTargetKey(tabId: string, paneId?: string): string {
  const normTab = String(tabId || '').trim();
  const normPane = String(paneId || 'desktop').trim().toLowerCase();
  return `${normTab}:${normPane}`;
}

export class SemanticRefRegistry {
  private nextRefIndex: number = 1;
  private records = new Map<string, SemanticSnapshotRecord>();
  private pendingCollections = new Map<string, PendingCollection>();
  private activeSequences = new Map<string, number>();
  private isDisposed: boolean = false;

  private readonly maxSnapshotDescriptors: number;
  private readonly maxTotalSerializedBytes: number;
  private readonly maxTotalProcessDescriptors: number;
  private readonly maxRecordAgeMs: number;
  private readonly clock: () => number;

  constructor(limits?: RegistryLimits) {
    this.maxSnapshotDescriptors = limits?.maxSnapshotDescriptors ?? MAX_SNAPSHOT_DESCRIPTORS;
    this.maxTotalSerializedBytes = limits?.maxTotalSerializedBytes ?? MAX_TOTAL_SERIALIZED_BYTES;
    this.maxTotalProcessDescriptors = limits?.maxTotalProcessDescriptors ?? DEFAULT_MAX_PROCESS_DESCRIPTORS;
    this.maxRecordAgeMs = limits?.maxRecordAgeMs ?? DEFAULT_MAX_RECORD_AGE_MS;
    this.clock = limits?.clock ?? (() => Date.now());
  }

  private pruneExpiredRecords(): void {
    const now = this.clock();
    for (const [key, record] of Array.from(this.records.entries())) {
      if (now - record.createdAt > this.maxRecordAgeMs) {
        this.records.delete(key);
      }
    }
    for (const [key, pending] of Array.from(this.pendingCollections.entries())) {
      if (now - pending.startedAt > this.maxRecordAgeMs) {
        this.pendingCollections.delete(key);
      }
    }
  }

  public beginCollection(target: {
    tabId: string;
    paneId?: string;
    browserEpoch: number;
    documentGeneration: number;
    documentUrl: string;
  }): { sequence: number; nonce: string } {
    if (this.isDisposed) {
      throw new CapabilityError('RUNTIME_DRAINING', 'SemanticRefRegistry has been disposed');
    }

    validateTargetVersions(target);
    if (!target.documentUrl || typeof target.documentUrl !== 'string' || !target.documentUrl.trim()) {
      throw new CapabilityError('INVALID_ARGUMENT', 'beginCollection requires a non-empty documentUrl string');
    }

    this.pruneExpiredRecords();

    const targetKey = makeTargetKey(target.tabId, target.paneId);

    // Invalidate active record immediately before nonce rotation
    this.records.delete(targetKey);

    const nextSeq = (this.activeSequences.get(targetKey) || 0) + 1;
    const nextNonce = generateCollectionNonce();

    this.activeSequences.set(targetKey, nextSeq);
    this.pendingCollections.set(targetKey, {
      sequence: nextSeq,
      nonce: nextNonce,
      browserEpoch: target.browserEpoch,
      documentGeneration: target.documentGeneration,
      documentUrl: target.documentUrl.trim(),
      startedAt: this.clock(),
    });

    return { sequence: nextSeq, nonce: nextNonce };
  }

  public publishSnapshot(params: PublishSnapshotParams): SnapshotPublishResult {
    if (this.isDisposed) {
      throw new CapabilityError('RUNTIME_DRAINING', 'SemanticRefRegistry has been disposed');
    }

    this.pruneExpiredRecords();
    validateTargetVersions(params);
    const validNonce = validateUuid(params.nonce, 'PublishSnapshotParams nonce');

    const targetKey = makeTargetKey(params.tabId, params.paneId);
    const pending = this.pendingCollections.get(targetKey);

    if (
      !pending ||
      pending.nonce !== validNonce ||
      pending.sequence !== params.sequence ||
      pending.browserEpoch !== params.browserEpoch ||
      pending.documentGeneration !== params.documentGeneration ||
      pending.documentUrl !== params.documentUrl.trim()
    ) {
      throw new CapabilityError(
        'REF_STALE',
        `Snapshot publication rejected: metadata or nonce mismatch for target "${targetKey}"`
      );
    }


    if (!Array.isArray(params.rawDescriptors)) {
      throw new CapabilityError('INVALID_ARGUMENT', 'rawDescriptors must be an array');
    }

    if (params.rawDescriptors.length > this.maxSnapshotDescriptors) {
      throw new CapabilityError(
        'ARTIFACT_TOO_LARGE',
        `Snapshot exceeds maximum descriptor limit (${this.maxSnapshotDescriptors})`
      );
    }

    const serializedBytes = Buffer.byteLength(JSON.stringify(params.rawDescriptors), 'utf8');
    if (serializedBytes > this.maxTotalSerializedBytes) {
      throw new CapabilityError(
        'ARTIFACT_TOO_LARGE',
        `Snapshot raw descriptors payload (${serializedBytes} bytes) exceeds limit (${this.maxTotalSerializedBytes} bytes)`
      );
    }

    // Atomic pre-validation: validate all descriptors BEFORE allocating refs or incrementing nextRefIndex
    const validatedRawList: RawElementDescriptor[] = [];
    for (let idx = 0; idx < params.rawDescriptors.length; idx++) {
      validatedRawList.push(validateRawDescriptor(params.rawDescriptors[idx], idx));
    }

    // Check process total descriptors limit
    let currentTotal = 0;
    for (const rec of this.records.values()) {
      currentTotal += rec.descriptors.size;
    }
    if (currentTotal + validatedRawList.length > this.maxTotalProcessDescriptors) {
      throw new CapabilityError(
        'ARTIFACT_TOO_LARGE',
        `Total process descriptors (${currentTotal + validatedRawList.length}) exceeds maximum limit (${this.maxTotalProcessDescriptors})`
      );
    }

    // All checks passed atomically: allocate refs
    const descriptorsMap = new Map<string, SemanticElementDescriptor>();
    const descriptorsList: SemanticElementDescriptor[] = [];
    const refs: string[] = [];
    for (const raw of validatedRawList) {
      const allocatedRefIndex = this.nextRefIndex++;
      const refToken = `@e${allocatedRefIndex}`;

      const desc: SemanticElementDescriptor = {
        path: raw.path,
        fingerprint: raw.fingerprint,
        rect: raw.rect,
        label: raw.label,
        role: raw.role,
        type: raw.type,
        id: raw.id,
        metadata: raw.metadata,
        ref: refToken,
        refIndex: allocatedRefIndex,
        documentUrl: params.documentUrl.trim(),
        nonce: validNonce,
        sequence: params.sequence,
      };

      descriptorsMap.set(refToken, desc);
      descriptorsList.push(desc);
      refs.push(refToken);
    }

    const formattedText = formatSemanticSnapshotPrompt(descriptorsList);
    const snapshotId = `snap-${crypto.randomUUID()}`;
    const record: SemanticSnapshotRecord = {
      targetKey,
      tabId: params.tabId,
      paneId: params.paneId || 'desktop',
      browserEpoch: params.browserEpoch,
      documentGeneration: params.documentGeneration,
      documentUrl: params.documentUrl.trim(),
      snapshotId,
      sequence: params.sequence,
      nonce: validNonce,
      createdAt: this.clock(),
      descriptors: descriptorsMap,
      formattedText,
    };
    this.pendingCollections.delete(targetKey);
    this.records.set(targetKey, record);
    return {
      snapshotId,
      formattedText,
      count: descriptorsList.length,
      refs,
    };
  }

  public resolveRef(target: TargetIdentifier, ref: string): SemanticElementDescriptor {
    if (this.isDisposed) {
      throw new CapabilityError('RUNTIME_DRAINING', 'SemanticRefRegistry has been disposed');
    }

    this.pruneExpiredRecords();

    if (!isSemanticRef(ref)) {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid semantic ref token: "${ref}"`);
    }

    validateTargetVersions(target);
    const targetKey = makeTargetKey(target.tabId, target.paneId);
    const record = this.records.get(targetKey);

    if (!record) {
      const requestedIndex = parseSemanticRefIndex(ref);
      if (requestedIndex < this.nextRefIndex) {
        throw new CapabilityError(
          'REF_STALE',
          `Semantic ref "${ref}" is stale: target "${targetKey}" has no active snapshot`
        );
      }
      throw new CapabilityError(
        'REF_NOT_FOUND',
        `Semantic ref "${ref}" not found: never allocated on target "${targetKey}"`
      );
    }

    if (
      typeof target.browserEpoch === 'number' &&
      record.browserEpoch !== target.browserEpoch
    ) {
      throw new CapabilityError(
        'TARGET_STALE',
        `Target browser epoch mismatch: active ${record.browserEpoch}, requested ${target.browserEpoch}`
      );
    }

    if (
      typeof target.documentGeneration === 'number' &&
      record.documentGeneration !== target.documentGeneration
    ) {
      throw new CapabilityError(
        'REF_STALE',
        `Document generation mismatch for ref "${ref}": record gen ${record.documentGeneration}, target gen ${target.documentGeneration}`
      );
    }

    if (
      typeof target.documentUrl === 'string' &&
      target.documentUrl.trim() &&
      record.documentUrl !== target.documentUrl.trim()
    ) {
      throw new CapabilityError(
        'REF_STALE',
        `Document URL mismatch for ref "${ref}": record URL "${record.documentUrl}", requested "${target.documentUrl}"`
      );
    }

    const descriptor = record.descriptors.get(ref);
    if (!descriptor) {
      const requestedIndex = parseSemanticRefIndex(ref);
      if (requestedIndex < this.nextRefIndex) {
        throw new CapabilityError(
          'REF_STALE',
          `Semantic ref "${ref}" is stale for target "${targetKey}"`
        );
      }
      throw new CapabilityError(
        'REF_NOT_FOUND',
        `Semantic ref "${ref}" not found in active snapshot for target "${targetKey}"`
      );
    }

    return descriptor;
  }

  public getActiveSnapshotText(target: TargetIdentifier): string | null {
    if (this.isDisposed) return null;
    this.pruneExpiredRecords();
    const targetKey = makeTargetKey(target.tabId, target.paneId);
    const record = this.records.get(targetKey);
    return record ? record.formattedText : null;
  }
  public getActiveRecord(target: TargetIdentifier): SemanticSnapshotRecord | undefined {
    if (this.isDisposed) return undefined;
    this.pruneExpiredRecords();
    const targetKey = makeTargetKey(target.tabId, target.paneId);
    return this.records.get(targetKey);
  }

  public findInSnapshot(params: FindSnapshotParams): SnapshotFindResult {
    if (this.isDisposed) {
      throw new CapabilityError('RUNTIME_DRAINING', 'SemanticRefRegistry has been disposed');
    }
    this.pruneExpiredRecords();

    const textQuery = typeof params.text === 'string' ? params.text.trim() : '';
    const regexQuery = typeof params.regex === 'string' ? params.regex.trim() : '';

    if (!textQuery && !regexQuery) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Either "text" or "regex" must be provided for snapshot search');
    }
    if (textQuery && regexQuery) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Provide either "text" or "regex", not both');
    }

    let matcher: (str: string) => boolean;
    let queryDisplay = '';

    if (textQuery) {
      const lower = textQuery.toLowerCase();
      queryDisplay = textQuery;
      matcher = (str: string) => str.toLowerCase().includes(lower);
    } else {
      queryDisplay = regexQuery;
      let pattern = regexQuery;
      let flags = '';
      const match = regexQuery.match(/^\/(.+)\/([gimsuy]*)$/);
      if (match) {
        pattern = match[1] ?? pattern;
        flags = (match[2] ?? '').replace(/[gy]/g, '');
      }
      try {
        const re = new RegExp(pattern, flags);
        matcher = (str: string) => re.test(str);
      } catch (err: unknown) {
        throw new CapabilityError('INVALID_ARGUMENT', `Invalid regular expression "${regexQuery}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const targetKey = makeTargetKey(params.tabId, params.paneId);
    const record = this.records.get(targetKey);

    if (!record || record.descriptors.size === 0) {
      return {
        matches: [],
        count: 0,
        formattedText: `[No matches found: No active snapshot for target "${targetKey}"]`,
        query: queryDisplay,
        snapshotId: record?.snapshotId,
      };
    }

    const maxMatches = typeof params.maxMatches === 'number' && params.maxMatches > 0 ? params.maxMatches : 50;
    const matches: FindMatchItem[] = [];
    const formattedLines: string[] = [];

    for (const desc of record.descriptors.values()) {
      const matchLabel = matcher(desc.label || '');
      const matchId = desc.id ? matcher(desc.id) : false;
      const matchRole = matcher(desc.role || '');
      const matchType = desc.type ? matcher(desc.type) : false;
      const matchSection = desc.metadata?.sectionId ? matcher(String(desc.metadata.sectionId)) : false;
      const matchProduct = desc.metadata?.productId ? matcher(String(desc.metadata.productId)) : false;
      const matchBlock = desc.metadata?.blockId ? matcher(String(desc.metadata.blockId)) : false;

      if (matchLabel || matchId || matchRole || matchType || matchSection || matchProduct || matchBlock) {
        const rolePart = desc.role + (desc.type ? ':' + desc.type : '');
        const labelPart = desc.label ? ` "${desc.label}"` : '';
        let snippet = `${desc.ref} [${rolePart}]${labelPart}`.trim();
        const metaParts: string[] = [];
        if (desc.id) metaParts.push(`id: "${desc.id}"`);
        if (desc.metadata?.sectionId) metaParts.push(`section: "${desc.metadata.sectionId}"`);
        if (desc.metadata?.productId) metaParts.push(`product: "${desc.metadata.productId}"`);
        if (desc.metadata?.blockId) metaParts.push(`block: "${desc.metadata.blockId}"`);
        if (desc.metadata?.framePath) metaParts.push(`frame: "${desc.metadata.framePath}"`);
        if (metaParts.length > 0) {
          snippet += ` (${metaParts.join(', ')})`;
        }

        matches.push({
          ref: desc.ref,
          role: desc.role,
          type: desc.type,
          label: desc.label,
          id: desc.id,
          rect: desc.rect,
          metadata: desc.metadata,
          snippet,
        });

        formattedLines.push(snippet);
        if (matches.length >= maxMatches) {
          break;
        }
      }
    }

    const formattedText = formattedLines.length > 0 ? formattedLines.join('\n') : `[No elements matching "${queryDisplay}"]`;

    return {
      matches,
      count: matches.length,
      formattedText,
      query: queryDisplay,
      snapshotId: record.snapshotId,
    };
  }

  public invalidateTarget(tabId: string, paneId?: string): void {
    const targetKey = makeTargetKey(tabId, paneId);
    this.records.delete(targetKey);
    this.pendingCollections.delete(targetKey);
    this.activeSequences.delete(targetKey);
  }

  public invalidateTab(tabId: string): void {
    const prefix = `${String(tabId).trim()}:`;
    for (const key of Array.from(this.records.keys())) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
    for (const key of Array.from(this.pendingCollections.keys())) {
      if (key.startsWith(prefix)) {
        this.pendingCollections.delete(key);
      }
    }
    for (const key of Array.from(this.activeSequences.keys())) {
      if (key.startsWith(prefix)) {
        this.activeSequences.delete(key);
      }
    }
  }

  public getStats(): RegistryStats {
    let totalDescriptors = 0;
    for (const rec of this.records.values()) {
      totalDescriptors += rec.descriptors.size;
    }
    return {
      activeTargets: this.records.size,
      totalDescriptors,
      highWaterRefIndex: this.nextRefIndex - 1,
      isDisposed: this.isDisposed,
    };
  }

  public destroy(): void {
    this.isDisposed = true;
    this.records.clear();
    this.pendingCollections.clear();
    this.activeSequences.clear();
  }
}
