import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { recordBenchmark } from '../benchmark/telemetry';
import { ArtifactRef, CapabilityError, ArtifactReadResult, CapabilityRequestContext, AuthenticatedCapabilityContext } from '../../shared/control-plane-contracts';
import { ArtifactRetentionCleaner, RetentionSweepOptions, RetentionSweepResult } from './artifact-retention-cleaner';
export const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;


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
  private readonly hotDataCache = new Map<string, Buffer>();
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

  private persistRunIndex(runId: string): void {
    try {
      const runDir = path.join(this.options.root, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const runArtifacts = [...this.artifacts.values()].filter((a) => a.runId === runId);
      const indexFile = this.getIndexFilePath(runId);
      const tempPath = `${indexFile}.tmp-${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(runArtifacts, null, 2), 'utf8');
      try {
        fs.renameSync(tempPath, indexFile);
      } catch {
        fs.writeFileSync(indexFile, JSON.stringify(runArtifacts, null, 2), 'utf8');
        try { fs.unlinkSync(tempPath); } catch {}
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
        this.runBytes.set(runId, runTotalBytes);

        const indexFile = this.getIndexFilePath(runId);
        if (fs.existsSync(indexFile)) {
          try {
            const raw = fs.readFileSync(indexFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item && typeof item.id === 'string' && typeof item.path === 'string') {
                  this.artifacts.set(item.id, item as ArtifactRef);
                }
              }
            }
          } catch {}
        }
      }
    } catch {}
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
  }): ArtifactRef {
    if (!input.runId || typeof input.runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.runId)) {
      throw new CapabilityError('INVALID_ARGUMENT', `Invalid runId '${input.runId}': must contain only alphanumeric characters, underscores, and dashes`);
    }
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
    const max = Math.min(input.maxBytes ?? this.maxArtifactBytes, this.maxArtifactBytes);
    const truncated = raw.byteLength > max;
    const data = raw.subarray(0, max);
    const binary = !isTextLike(input.mime);
    const { data: storedData, redacted } = binary ? { data, redacted: false } : redactSecrets(data);
    const sha256 = crypto.createHash('sha256').update(storedData).digest('hex');
    const artifactPath = path.join(this.options.root, input.runId, `${sha256}.artifact`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });

    const alreadyExists = fs.existsSync(artifactPath);
    let stored = 0;
    if (!alreadyExists) {
      const currentRunBytes = this.runBytes.get(input.runId) || 0;
      if (currentRunBytes + storedData.byteLength > this.maxRunBytes) {
        throw new CapabilityError('ARTIFACT_TOO_LARGE', 'Run artifact budget exceeded');
      }
      fs.writeFileSync(artifactPath, storedData);
      stored = fs.statSync(artifactPath).size;
      this.runBytes.set(input.runId, currentRunBytes + stored);
    } else {
      stored = fs.statSync(artifactPath).size;
    }
    const ref: ArtifactRef = {
      id: `artifact-${crypto.randomUUID()}`,
      runId: input.runId,
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
    };
    this.artifacts.set(ref.id, ref);
    this.persistRunIndex(input.runId);
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
    return ArtifactRetentionCleaner.sweep(this.options.root, options ?? this.options.retentionOptions);
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
