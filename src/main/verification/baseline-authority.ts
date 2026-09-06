import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ArtifactStore } from '../tools/artifact-store';
import { StorageLocations } from '../config/storage-locations';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
} from '../../shared/control-plane-contracts';
import { VerificationCaptureReceipt } from './visual-capture';

export interface BaselineCaptureStateMini {
  dpr: number;
  zoom: number;
  backend: string;
  cssViewport: { width: number; height: number };
  rasterSize: { width: number; height: number };
}

export function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  return null;
}
export interface VisualBaselineRef {
  id: string;
  sha256: string;
  sourceArtifactId: string;
  captureStateMini: BaselineCaptureStateMini;
  promotedAt: number;
  workspaceId: string;
  projectId?: string;
  path: string;
}

export interface BaselineAuthorityOptions {
  storageRoot?: string;
  artifactStore?: ArtifactStore;
}

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const BASELINE_ID_REGEX = /^vbase_[a-zA-Z0-9_-]{1,128}$/;

/**
 * Phase 6: Promoted Baseline Authority (Audit v5 §12-§13, V-22, V-24).
 *
 * Provides explicit, tamper-evident baseline promotion across attempts and runs
 * WITHOUT relaxing ArtifactStore.readBytesById containment invariants.
 *
 * Baselines are immutable, checksum-verified (SHA-256), workspace-scoped,
 * path-contained, and guarded against silent tampering.
 */
export class BaselineAuthority {
  private readonly storageRoot: string;
  private readonly artifactStore?: ArtifactStore;

  constructor(options?: BaselineAuthorityOptions) {
    this.storageRoot = options?.storageRoot
      ? path.resolve(options.storageRoot)
      : path.join(StorageLocations.getDataRoot(), 'baselines');
    this.artifactStore = options?.artifactStore;
  }

  public getStorageRoot(): string {
    return this.storageRoot;
  }

  private validateId(id: string, name: string, pattern: RegExp = SAFE_ID_REGEX): void {
    if (!id || typeof id !== 'string' || !pattern.test(id)) {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid ${name} format: must match ${pattern}`);
    }
  }

  /**
   * Asserts canonical realpath containment within the storageRoot.
   * Disallows symlinks and directory traversal.
   */
  private assertPathContainment(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const rootResolved = path.resolve(this.storageRoot);
    const rootPrefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;

    if (!resolved.startsWith(rootPrefix) || resolved === rootResolved) {
      throw new CapabilityError('OUTSIDE_WORKSPACE', 'Baseline path containment violation');
    }

    if (fs.existsSync(resolved)) {
      try {
        if (fs.lstatSync(resolved).isSymbolicLink()) {
          throw new CapabilityError('OUTSIDE_WORKSPACE', 'Baseline symbolic links are not permitted');
        }
        const canonicalRealpath = fs.realpathSync.native(resolved);
        const canonicalRoot = fs.realpathSync.native(rootResolved);
        const canonicalRootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
        if (
          !canonicalRealpath.toLowerCase().startsWith(canonicalRootPrefix.toLowerCase()) ||
          canonicalRealpath.toLowerCase() === canonicalRoot.toLowerCase()
        ) {
          throw new CapabilityError('OUTSIDE_WORKSPACE', 'Baseline realpath containment violation');
        }
      } catch (err) {
        if (err instanceof CapabilityError) throw err;
        throw new CapabilityError('INVALID_ARGUMENT', `Failed to verify path containment: ${(err as Error).message}`);
      }
    }
  }

  public getBaselineDir(workspaceId: string): string {
    this.validateId(workspaceId, 'workspaceId');
    const dir = path.join(this.storageRoot, workspaceId);
    this.assertPathContainment(dir);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    return dir;
  }

  /**
   * Promote an artifact to an authoritative visual baseline.
   * Reads the artifact via ArtifactStore with valid run/attempt context,
   * computes its SHA-256 hash, writes the PNG into the workspace baseline directory,
   * and writes an immutable manifest.
   */
  public promote(
    sourceArtifactId: string,
    context: CapabilityRequestContext | AuthenticatedCapabilityContext,
    meta: {
      captureReceipt: VerificationCaptureReceipt;
      projectId?: string;
      artifactStore?: ArtifactStore;
    }
  ): VisualBaselineRef {
    if (!context || !context.workspaceId) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'Explicit workspace context required to promote baseline');
    }
    this.validateId(context.workspaceId, 'workspaceId');
    if (meta.projectId) {
      this.validateId(meta.projectId, 'projectId');
    }

    const store = meta.artifactStore || this.artifactStore;
    if (!store) {
      throw new CapabilityError('INVALID_ARGUMENT', 'ArtifactStore required to promote baseline');
    }

    // Read artifact via store with valid context (preserving all containment invariants)
    const { ref: sourceRef, data } = store.readBytesById(sourceArtifactId, context);
    if (sourceRef && (sourceRef as any).truncated) {
      throw new CapabilityError('INVALID_ARGUMENT', `Cannot promote truncated artifact '${sourceArtifactId}' as authoritative baseline`);
    }

    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const id = `vbase_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const workspaceId = context.workspaceId;
    const targetDir = this.getBaselineDir(workspaceId);

    const imageFilename = `${id}.png`;
    const imagePath = path.join(targetDir, imageFilename);
    const manifestFilename = `${id}.json`;
    const manifestPath = path.join(targetDir, manifestFilename);

    this.assertPathContainment(imagePath);
    this.assertPathContainment(manifestPath);
    // Pre-mutation receipt validation: all receipt fields must be valid before writing any file
    if (!meta.captureReceipt || typeof meta.captureReceipt !== 'object') {
      throw new CapabilityError('INVALID_ARGUMENT', 'Authoritative VerificationCaptureReceipt required to promote baseline');
    }
    const receipt = meta.captureReceipt;
    if (!receipt.backend || typeof receipt.backend !== 'string' || receipt.backend.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Capture receipt backend must be a non-empty string');
    }
    if (!Number.isFinite(receipt.dpr) || receipt.dpr <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', `Capture receipt dpr must be a finite positive number, got: ${receipt.dpr}`);
    }
    if (!Number.isFinite(receipt.zoom) || receipt.zoom <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', `Capture receipt zoom must be a finite positive number, got: ${receipt.zoom}`);
    }
    if (!receipt.cssViewport || !Number.isFinite(receipt.cssViewport.width) || receipt.cssViewport.width <= 0 || !Number.isFinite(receipt.cssViewport.height) || receipt.cssViewport.height <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Capture receipt cssViewport must have finite positive width and height');
    }

    const pngDims = readPngDimensions(data);
    if (!pngDims) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Artifact data is not a valid PNG image');
    }

    if (receipt.rasterSize) {
      if (!Number.isFinite(receipt.rasterSize.width) || receipt.rasterSize.width <= 0 || !Number.isFinite(receipt.rasterSize.height) || receipt.rasterSize.height <= 0) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Capture receipt rasterSize must have finite positive width and height');
      }
      if (receipt.rasterSize.width !== pngDims.width || receipt.rasterSize.height !== pngDims.height) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          `Capture receipt raster dimensions (${receipt.rasterSize.width}x${receipt.rasterSize.height}) do not match actual PNG dimensions (${pngDims.width}x${pngDims.height})`
        );
      }
    }

    const rasterSize = receipt.rasterSize || pngDims;

    // Write PNG file ONLY after complete validation
    fs.writeFileSync(imagePath, data);
    const baselineRef: VisualBaselineRef = {
      id,
      sha256,
      sourceArtifactId,
      captureStateMini: {
        backend: receipt.backend,
        dpr: receipt.dpr,
        zoom: receipt.zoom,
        cssViewport: { ...receipt.cssViewport },
        rasterSize: { width: rasterSize.width, height: rasterSize.height },
      },
      promotedAt: Date.now(),
      workspaceId,
      projectId: meta.projectId || context.projectId || sourceRef.projectId,
      path: imagePath,
    };

    // Atomic write of manifest JSON
    const tempPath = `${manifestPath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(baselineRef, null, 2), 'utf8');
    try {
      fs.renameSync(tempPath, manifestPath);
    } catch {
      fs.writeFileSync(manifestPath, JSON.stringify(baselineRef, null, 2), 'utf8');
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }

    return baselineRef;
  }

  /**
   * Resolve a promoted baseline by ID with SHA-256 integrity verification.
   * Strictly workspace-scoped: requires workspaceId and never searches sibling workspaces.
   * Derives image location strictly from the validated directory and baseline ID.
   * Throws BASELINE_TAMPERED if file contents do not match manifest checksum.
   */
  public resolve(
    baselineRefId: string,
    context: { workspaceId: string; projectId?: string }
  ): { ref: VisualBaselineRef; data: Buffer } {
    if (!context || !context.workspaceId) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'Explicit workspace context required to resolve baseline');
    }
    this.validateId(context.workspaceId, 'workspaceId');
    this.validateId(baselineRefId, 'baselineRefId', BASELINE_ID_REGEX);
    if (context.projectId) {
      this.validateId(context.projectId, 'projectId');
    }

    const workspaceDir = this.getBaselineDir(context.workspaceId);
    const manifestPath = path.join(workspaceDir, `${baselineRefId}.json`);
    this.assertPathContainment(manifestPath);

    if (!fs.existsSync(manifestPath)) {
      throw new CapabilityError('REF_NOT_FOUND', `Promoted baseline '${baselineRefId}' not found in workspace '${context.workspaceId}'`);
    }

    let manifestRaw: string;
    try {
      manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    } catch (err) {
      throw new CapabilityError('INVALID_ARGUMENT', `Failed to read baseline manifest: ${(err as Error).message}`);
    }

    let ref: VisualBaselineRef;
    try {
      ref = JSON.parse(manifestRaw) as VisualBaselineRef;
    } catch {
      throw new CapabilityError('INTEGRITY_COMPROMISED', `Corrupted baseline manifest for '${baselineRefId}'`);
    }

    // Validate metadata against request BEFORE accessing data
    if (ref.id !== baselineRefId) {
      throw new CapabilityError('INTEGRITY_COMPROMISED', `Manifest ID mismatch: expected '${baselineRefId}', got '${ref.id}'`);
    }

    if (ref.workspaceId !== context.workspaceId) {
      throw new CapabilityError('WORKSPACE_MISMATCH', `Baseline workspace mismatch: expected '${context.workspaceId}', got '${ref.workspaceId}'`);
    }

    if (context.projectId && ref.projectId && ref.projectId !== context.projectId) {
      throw new CapabilityError('PROJECT_MISMATCH', `Baseline project mismatch: expected '${context.projectId}', got '${ref.projectId}'`);
    }

    // Security: NEVER trust ref.path from manifest for reading. Derive strictly from workspaceDir and baselineRefId.
    const imagePath = path.join(workspaceDir, `${baselineRefId}.png`);
    this.assertPathContainment(imagePath);

    if (!fs.existsSync(imagePath)) {
      throw new CapabilityError('REF_NOT_FOUND', `Promoted baseline image file not found for '${baselineRefId}'`);
    }

    let data: Buffer;
    try {
      data = fs.readFileSync(imagePath);
    } catch (err) {
      throw new CapabilityError('INVALID_ARGUMENT', `Failed to read baseline image: ${(err as Error).message}`);
    }

    // SHA-256 Tamper Verification
    const actualSha256 = crypto.createHash('sha256').update(data).digest('hex');
    if (actualSha256 !== ref.sha256) {
      throw new CapabilityError(
        'BASELINE_TAMPERED',
        `Promoted baseline '${baselineRefId}' failed checksum verification: content was modified or corrupted (expected ${ref.sha256}, actual ${actualSha256})`
      );
    }

    return { ref, data };
  }

  /**
   * Verify capture state compatibility between a promoted baseline and a live target receipt.
   */
  public verifyCaptureCompatibility(
    baseline: VisualBaselineRef,
    targetReceipt: VerificationCaptureReceipt
  ): { compatible: boolean; reason?: string } {
    const mini = baseline.captureStateMini;
    if (!mini) {
      return { compatible: false, reason: 'Promoted baseline lacks captureStateMini metadata' };
    }

    if (targetReceipt.backend !== mini.backend) {
      return {
        compatible: false,
        reason: `Capture backend switched between baseline ('${mini.backend}') and target ('${targetReceipt.backend}')`,
      };
    }

    if (Math.abs(targetReceipt.dpr - mini.dpr) > 0.01) {
      return {
        compatible: false,
        reason: `Device pixel ratio mismatch: baseline is ${mini.dpr}, target is ${targetReceipt.dpr}`,
      };
    }

    if (Math.abs(targetReceipt.zoom - mini.zoom) > 0.01) {
      return {
        compatible: false,
        reason: `Zoom level mismatch: baseline is ${mini.zoom}, target is ${targetReceipt.zoom}`,
      };
    }

    if (
      targetReceipt.cssViewport.width !== mini.cssViewport.width ||
      targetReceipt.cssViewport.height !== mini.cssViewport.height
    ) {
      return {
        compatible: false,
        reason: `CSS viewport dimension mismatch: baseline is ${mini.cssViewport.width}x${mini.cssViewport.height}, target is ${targetReceipt.cssViewport.width}x${targetReceipt.cssViewport.height}`,
      };
    }
    if (
      targetReceipt.rasterSize &&
      mini.rasterSize &&
      (targetReceipt.rasterSize.width !== mini.rasterSize.width ||
        targetReceipt.rasterSize.height !== mini.rasterSize.height)
    ) {
      return {
        compatible: false,
        reason: `Raster dimension mismatch: baseline is ${mini.rasterSize.width}x${mini.rasterSize.height}, target is ${targetReceipt.rasterSize.width}x${targetReceipt.rasterSize.height}`,
      };
    }

    return { compatible: true };
  }
}
