/**
 * AntiFan Browser Desktop - Semantic Reference Types & Contracts
 * Main-owned, JSON-safe semantic descriptors and validation rules.
 */

import * as crypto from 'node:crypto';
import { CapabilityError } from '../../shared/control-plane-contracts';

export const ISOLATED_AGENT_WORLD_ID = 1004;
export const MAX_SNAPSHOT_DESCRIPTORS = 150;
export const MAX_LABEL_LENGTH = 60;
export const MAX_TOTAL_SERIALIZED_BYTES = 128 * 1024; // 128 KB
export const MAX_TRAVERSAL_DEPTH = 32;

export type TraversalStepKind = 'dom' | 'shadow' | 'iframe';

export interface TraversalStep {
  kind: TraversalStepKind;
  index: number;
  id?: string;
  name?: string;
  tag?: string;
}

export interface ElementFingerprint {
  tag: string;
  role?: string;
  type?: string;
  id?: string;
  name?: string;
  classHint?: string;
}

export interface ElementGlobalRect {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface StorefrontMetadata {
  sectionId?: string;
  productId?: string;
  blockId?: string;
  framePath?: string;
}

export interface RawElementDescriptor {
  path: TraversalStep[];
  fingerprint: ElementFingerprint;
  rect: ElementGlobalRect;
  label: string;
  role: string;
  type?: string;
  id?: string;
  metadata?: StorefrontMetadata;
}

export interface SemanticElementDescriptor extends RawElementDescriptor {
  ref: string;
  refIndex: number;
  documentUrl: string;
  nonce: string;
  sequence: number;
}

export interface ExactTargetKey {
  tabId: string;
  paneId: 'desktop' | 'mobile' | 'primary' | 'secondary' | string;
}

export interface SemanticSnapshotRecord {
  targetKey: string;
  tabId: string;
  paneId: string;
  browserEpoch: number;
  documentGeneration: number;
  documentUrl: string;
  snapshotId: string;
  sequence: number;
  nonce: string;
  createdAt: number;
  descriptors: Map<string, SemanticElementDescriptor>;
  formattedText: string;
}

export type IsolatedCollectionEnvelope =
  | {
      ok: true;
      nonce: string;
      documentUrl: string;
      descriptors: RawElementDescriptor[];
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };

export interface RendererActionRequest {
  action: 'click' | 'hover' | 'type' | 'scroll' | 'highlight' | 'move' | 'focus';
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  text?: string;
  clear?: boolean;
  trusted?: boolean;
  label?: string;
  deltaY?: number;
  nonce: string;
  documentUrl: string;
  descriptor?: RawElementDescriptor;
}

export type RendererActionResponse =
  | {
      ok: true;
      executed: boolean;
      rect?: ElementGlobalRect;
      executionTier?: 'cdp_trusted' | 'isolated_synthetic';
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      executionTier?: 'cdp_trusted' | 'isolated_synthetic';
      metadata?: Record<string, unknown>;
    };

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateUuid(value: unknown, fieldName = 'nonce'): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new CapabilityError('INVALID_ARGUMENT', `${fieldName} must be a valid UUID string`);
  }
  return value.trim();
}

export function validateTargetVersions(target: {
  browserEpoch?: unknown;
  documentGeneration?: unknown;
  sequence?: unknown;
}): void {
  if (target.browserEpoch !== undefined) {
    if (!Number.isInteger(target.browserEpoch) || (target.browserEpoch as number) < 1) {
      throw new CapabilityError('INVALID_ARGUMENT', 'browserEpoch must be an integer >= 1');
    }
  }
  if (target.documentGeneration !== undefined) {
    if (!Number.isInteger(target.documentGeneration) || (target.documentGeneration as number) < 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'documentGeneration must be an integer >= 0');
    }
  }
  if (target.sequence !== undefined) {
    if (!Number.isInteger(target.sequence) || (target.sequence as number) < 1) {
      throw new CapabilityError('INVALID_ARGUMENT', 'sequence must be an integer >= 1');
    }
  }
}

export function generateCollectionNonce(): string {
  return crypto.randomUUID();
}
export type IsolatedActionEnvelope = RendererActionResponse;

export function isSemanticRef(value: unknown): value is string {
  return typeof value === 'string' && /^@e[1-9]\d*$/.test(value);
}

export function parseSemanticRefIndex(ref: string): number {
  if (!isSemanticRef(ref)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Invalid semantic ref format: "${ref}"`);
  }
  return parseInt(ref.slice(2), 10);
}

export function sanitizeDomTextForPrompt(text: string): string {
  const safeText = (text || '')
    .replace(/]]>/g, ']]]]><![CDATA[>')
    .replace(/<\/storefront_untrusted_dom>/gi, '')
    .replace(/\[(SYSTEM|DEVELOPER|INSTRUCTION)\]/gi, '');
  return `<storefront_untrusted_dom><![CDATA[${safeText}]]></storefront_untrusted_dom>`;
}

export function sanitizeLabel(rawLabel: string | undefined | null): string {
  if (!rawLabel) return '';
  return String(rawLabel)
    .replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ')
    .replace(/<\/storefront_untrusted_dom>/gi, '')
    .replace(/\[(SYSTEM|DEVELOPER|INSTRUCTION)\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function escapeSnapshotMetaString(value: string | undefined | null): string {
  if (!value) return '';
  return String(value)
    .replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ')
    .replace(/<\/storefront_untrusted_dom>/gi, '')
    .replace(/\[(SYSTEM|DEVELOPER|INSTRUCTION)\]/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}

export function formatSemanticSnapshotPrompt(descriptors: SemanticElementDescriptor[]): string {
  const rawFormatted = formatSemanticSnapshot(descriptors);
  return sanitizeDomTextForPrompt(rawFormatted);
}
export function formatSemanticSnapshot(descriptors: SemanticElementDescriptor[]): string {
  const lines: string[] = [];
  for (const desc of descriptors) {
    const rolePart = desc.role + (desc.type ? ':' + desc.type : '');
    const safeLabel = escapeSnapshotMetaString(desc.label);
    const labelPart = safeLabel ? `"${safeLabel}"` : '';
    let line = `${desc.ref} [${rolePart}] ${labelPart}`.trim();

    const meta: string[] = [];
    if (desc.id) meta.push(`id: "${escapeSnapshotMetaString(desc.id)}"`);
    if (desc.metadata?.sectionId) meta.push(`section: "${escapeSnapshotMetaString(desc.metadata.sectionId)}"`);
    if (desc.metadata?.productId) meta.push(`product: "${escapeSnapshotMetaString(desc.metadata.productId)}"`);
    if (desc.metadata?.blockId) meta.push(`block: "${escapeSnapshotMetaString(desc.metadata.blockId)}"`);
    if (desc.metadata?.framePath) meta.push(`frame: "${escapeSnapshotMetaString(desc.metadata.framePath)}"`);

    if (meta.length > 0) {
      line += ` (${meta.join(', ')})`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function validateRawDescriptor(raw: unknown, index: number): RawElementDescriptor {
  if (!raw || typeof raw !== 'object') {
    throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} is not an object`);
  }
  const item = raw as Partial<RawElementDescriptor>;

  if (!Array.isArray(item.path) || item.path.length === 0 || item.path.length > MAX_TRAVERSAL_DEPTH) {
    throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} has invalid traversal path`);
  }

  for (let sIdx = 0; sIdx < item.path.length; sIdx++) {
    const step = item.path[sIdx];
    if (!step || typeof step !== 'object' || !['dom', 'shadow', 'iframe'].includes(step.kind) || !Number.isInteger(step.index) || step.index < 0) {
      throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} has invalid path step at index ${sIdx}`);
    }
    if (step.id !== undefined && typeof step.id !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} step id must be a string`);
    }
    if (step.name !== undefined && typeof step.name !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} step name must be a string`);
    }
    if (step.tag !== undefined && typeof step.tag !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} step tag must be a string`);
    }
  }

  if (!item.fingerprint || typeof item.fingerprint !== 'object' || typeof item.fingerprint.tag !== 'string' || !item.fingerprint.tag.trim()) {
    throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} has invalid fingerprint`);
  }

  if (
    !item.rect ||
    typeof item.rect !== 'object' ||
    !Number.isFinite(item.rect.x) ||
    !Number.isFinite(item.rect.y) ||
    !Number.isFinite(item.rect.width) ||
    !Number.isFinite(item.rect.height) ||
    item.rect.width < 0 ||
    item.rect.height < 0
  ) {
    throw new CapabilityError('INVALID_ARGUMENT', `Raw descriptor at index ${index} has invalid or non-finite rect`);
  }

  return {
    path: item.path,
    fingerprint: {
      tag: String(item.fingerprint.tag).toLowerCase().trim(),
      role: item.fingerprint.role ? String(item.fingerprint.role).trim() : undefined,
      type: item.fingerprint.type ? String(item.fingerprint.type).trim() : undefined,
      id: item.fingerprint.id ? String(item.fingerprint.id).trim() : undefined,
      name: item.fingerprint.name ? String(item.fingerprint.name).trim() : undefined,
      classHint: item.fingerprint.classHint ? String(item.fingerprint.classHint).slice(0, 100) : undefined,
    },
    rect: {
      x: Number(item.rect.x),
      y: Number(item.rect.y),
      width: Number(item.rect.width),
      height: Number(item.rect.height),
      centerX: Number.isFinite(item.rect.centerX) ? Number(item.rect.centerX) : Number(item.rect.x) + Number(item.rect.width) / 2,
      centerY: Number.isFinite(item.rect.centerY) ? Number(item.rect.centerY) : Number(item.rect.y) + Number(item.rect.height) / 2,
    },
    label: sanitizeLabel(item.label),
    role: String(item.role || item.fingerprint.tag).toLowerCase().trim(),
    type: item.type ? String(item.type).trim() : undefined,
    id: item.id ? String(item.id).trim() : undefined,
    metadata: item.metadata
      ? {
          sectionId: item.metadata.sectionId ? String(item.metadata.sectionId).trim() : undefined,
          productId: item.metadata.productId ? String(item.metadata.productId).trim() : undefined,
          blockId: item.metadata.blockId ? String(item.metadata.blockId).trim() : undefined,
          framePath: item.metadata.framePath ? String(item.metadata.framePath).trim() : undefined,
        }
      : undefined,
  };
}

export function validateCollectionEnvelope(
  envelope: unknown,
  expectedNonce: string,
  expectedUrl: string
): RawElementDescriptor[] {
  const validExpectedNonce = validateUuid(expectedNonce, 'expectedNonce');

  if (!envelope || typeof envelope !== 'object') {
    throw new CapabilityError('INVALID_ARGUMENT', 'Isolated collection returned non-object envelope');
  }

  const env = envelope as Record<string, unknown>;
  if (env.ok !== true) {
    const errorMessage = typeof env.error === 'string' ? env.error : 'Isolated collection failed';
    throw new CapabilityError('REF_NOT_FOUND', errorMessage);
  }

  const validReceivedNonce = validateUuid(env.nonce, 'envelope.nonce');
  if (validReceivedNonce !== validExpectedNonce) {
    throw new CapabilityError('REF_STALE', `Collection nonce mismatch: expected "${validExpectedNonce}", received "${validReceivedNonce}"`);
  }

  if (typeof env.documentUrl !== 'string' || !env.documentUrl.trim() || env.documentUrl !== expectedUrl) {
    throw new CapabilityError('REF_STALE', `Collection documentUrl mismatch: expected "${expectedUrl}", received "${env.documentUrl}"`);
  }

  if (!Array.isArray(env.descriptors)) {
    throw new CapabilityError('INVALID_ARGUMENT', 'Collection descriptors must be an array');
  }

  if (env.descriptors.length > MAX_SNAPSHOT_DESCRIPTORS) {
    throw new CapabilityError('ARTIFACT_TOO_LARGE', `Collection exceeds maximum snapshot descriptors cap (${MAX_SNAPSHOT_DESCRIPTORS})`);
  }

  // Byte-size enforcement before mapping
  const serialized = JSON.stringify(env.descriptors);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TOTAL_SERIALIZED_BYTES) {
    throw new CapabilityError(
      'ARTIFACT_TOO_LARGE',
      `Collection descriptors payload (${Buffer.byteLength(serialized, 'utf8')} bytes) exceeds limit (${MAX_TOTAL_SERIALIZED_BYTES} bytes)`
    );
  }

  return env.descriptors.map((desc, idx) => validateRawDescriptor(desc, idx));
}

const MAX_TEXT_LENGTH = 10_000;
const MAX_SELECTOR_LENGTH = 1_000;

export function validateActionRequest(request: unknown): RendererActionRequest {
  if (!request || typeof request !== 'object') {
    throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionRequest must be an object');
  }
  const req = request as Partial<RendererActionRequest>;
  const validActions = ['click', 'hover', 'type', 'scroll', 'highlight', 'move', 'focus'];
  if (!req.action || !validActions.includes(req.action)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Invalid action: "${req.action}"`);
  }
  const validNonce = validateUuid(req.nonce, 'RendererActionRequest nonce');
  if (typeof req.documentUrl !== 'string' || !req.documentUrl.trim()) {
    throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionRequest requires valid documentUrl');
  }
  if (req.ref !== undefined && !isSemanticRef(req.ref)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Invalid ref: "${req.ref}"`);
  }
  if (req.x !== undefined && !Number.isFinite(req.x)) {
    throw new CapabilityError('INVALID_ARGUMENT', 'x coordinate must be a finite number');
  }
  if (req.y !== undefined && !Number.isFinite(req.y)) {
    throw new CapabilityError('INVALID_ARGUMENT', 'y coordinate must be a finite number');
  }
  if (req.deltaY !== undefined && !Number.isFinite(req.deltaY)) {
    throw new CapabilityError('INVALID_ARGUMENT', 'deltaY must be a finite number');
  }
  if (req.text !== undefined) {
    if (typeof req.text !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', 'text payload must be a string');
    }
    if (req.text.length > MAX_TEXT_LENGTH) {
      throw new CapabilityError('ARTIFACT_TOO_LARGE', `text payload exceeds maximum length of ${MAX_TEXT_LENGTH}`);
    }
  }
  if (req.selector !== undefined) {
    if (typeof req.selector !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', 'selector must be a string');
    }
    if (req.selector.length > MAX_SELECTOR_LENGTH) {
      throw new CapabilityError('ARTIFACT_TOO_LARGE', `selector exceeds maximum length of ${MAX_SELECTOR_LENGTH}`);
    }
  }

  if (req.action === 'type' && typeof req.text !== 'string') {
    throw new CapabilityError('INVALID_ARGUMENT', 'type action requires text string payload');
  }

  const hasTarget = Boolean(
    req.ref ||
      (typeof req.selector === 'string' && req.selector.trim()) ||
      (Number.isFinite(req.x) && Number.isFinite(req.y))
  );

  if (!hasTarget && req.action !== 'scroll') {
    throw new CapabilityError('INVALID_ARGUMENT', `${req.action} action requires ref, selector, or (x, y) target`);
  }

  return {
    action: req.action,
    ref: req.ref,
    selector: typeof req.selector === 'string' ? req.selector.trim() : undefined,
    x: typeof req.x === 'number' ? req.x : undefined,
    y: typeof req.y === 'number' ? req.y : undefined,
    text: typeof req.text === 'string' ? req.text : undefined,
    clear: req.clear !== undefined ? Boolean(req.clear) : undefined,
    trusted: req.trusted !== undefined ? Boolean(req.trusted) : undefined,
    label: typeof req.label === 'string' ? sanitizeLabel(req.label) : undefined,
    deltaY: typeof req.deltaY === 'number' ? req.deltaY : undefined,
    nonce: validNonce,
    documentUrl: req.documentUrl.trim(),
    descriptor: req.descriptor ? validateRawDescriptor(req.descriptor, 0) : undefined,
  };
}

export function validateActionResponse(response: unknown): RendererActionResponse {
  if (!response || typeof response !== 'object') {
    throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionResponse must be an object');
  }
  const res = response as Record<string, unknown>;

  if (typeof res.ok !== 'boolean') {
    throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionResponse ok field must be a boolean');
  }

  if (res.ok === true) {
    if (typeof res.executed !== 'boolean') {
      throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionResponse executed field must be a boolean');
    }

    let validatedRect: ElementGlobalRect | undefined;
    if (res.rect !== undefined) {
      if (!res.rect || typeof res.rect !== 'object') {
        throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionResponse rect must be an object');
      }
      const r = res.rect as Record<string, unknown>;
      if (
        !Number.isFinite(r.x) ||
        !Number.isFinite(r.y) ||
        !Number.isFinite(r.width) ||
        !Number.isFinite(r.height) ||
        (r.width as number) < 0 ||
        (r.height as number) < 0
      ) {
        throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionResponse rect has invalid or non-finite coordinates');
      }
      validatedRect = {
        x: Number(r.x),
        y: Number(r.y),
        width: Number(r.width),
        height: Number(r.height),
        centerX: Number.isFinite(r.centerX) ? Number(r.centerX) : Number(r.x) + Number(r.width) / 2,
        centerY: Number.isFinite(r.centerY) ? Number(r.centerY) : Number(r.y) + Number(r.height) / 2,
      };
    }

    return {
      ok: true,
      executed: res.executed,
      rect: validatedRect,
      executionTier: res.executionTier === 'cdp_trusted' || res.executionTier === 'isolated_synthetic' ? res.executionTier : undefined,
      metadata: res.metadata && typeof res.metadata === 'object' ? (res.metadata as Record<string, unknown>) : undefined,
    };
  }

  if (typeof res.error !== 'string' || !res.error.trim()) {
    throw new CapabilityError('INVALID_ARGUMENT', 'RendererActionResponse error field must be a non-empty string when ok is false');
  }

  return {
    ok: false,
    error: res.error.trim(),
    code: typeof res.code === 'string' && res.code.trim() ? res.code.trim() : undefined,
    executionTier: res.executionTier === 'cdp_trusted' || res.executionTier === 'isolated_synthetic' ? res.executionTier : undefined,
    metadata: res.metadata && typeof res.metadata === 'object' ? (res.metadata as Record<string, unknown>) : undefined,
  };
}
