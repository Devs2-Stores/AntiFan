import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { recordBenchmark } from '../benchmark/telemetry';
import { ArtifactRef, CapabilityError } from '../../shared/control-plane-contracts';

export interface ArtifactStoreOptions { root: string; maxArtifactBytes?: number; maxRunBytes?: number; }

export class ArtifactStore {
  private readonly maxArtifactBytes: number;
  private readonly maxRunBytes: number;
  private readonly runBytes = new Map<string, number>();
  private readonly artifacts = new Map<string, ArtifactRef>();

  constructor(private readonly options: ArtifactStoreOptions) {
    this.maxArtifactBytes = options.maxArtifactBytes ?? 8 * 1024 * 1024;
    this.maxRunBytes = options.maxRunBytes ?? 32 * 1024 * 1024;
  }

  stage(input: { kind: ArtifactRef['kind']; mime: string; data: string | Buffer; runId: string; attemptId: string; maxBytes?: number }): ArtifactRef {
    const stageStartMs = performance.now();
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
    const max = Math.min(input.maxBytes ?? this.maxArtifactBytes, this.maxArtifactBytes);
    const truncated = raw.byteLength > max;
    const data = raw.subarray(0, max);
    const currentRunBytes = this.runBytes.get(input.runId) || 0;
    if (currentRunBytes + data.byteLength > this.maxRunBytes) throw new CapabilityError('ARTIFACT_TOO_LARGE', 'Run artifact budget exceeded');
    const binary = !isTextLike(input.mime);
    const { data: storedData, redacted } = binary ? { data, redacted: false } : redactSecrets(data);
    const sha256 = crypto.createHash('sha256').update(storedData).digest('hex');
    const artifactPath = path.join(this.options.root, input.runId, `${sha256}.artifact`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    if (!fs.existsSync(artifactPath)) fs.writeFileSync(artifactPath, storedData);
    const stored = fs.statSync(artifactPath).size;
    this.runBytes.set(input.runId, currentRunBytes + stored);
    const ref: ArtifactRef = { id: `artifact-${crypto.randomUUID()}`, runId: input.runId, attemptId: input.attemptId, kind: input.kind, path: artifactPath, byteLength: stored, sha256, mime: input.mime, truncated, redacted, createdAt: Date.now() };
    this.artifacts.set(ref.id, ref);
    recordBenchmark({ surface: 'artifact', name: 'stage', value: performance.now() - stageStartMs, extra: { kind: input.kind, mime: input.mime, inputBytes: raw.byteLength, storedBytes: stored, truncated, redacted: ref.redacted } });
    return ref;
  }

  get(id: string): ArtifactRef | undefined {
    return this.artifacts.get(id);
  }

  readBytesById(id: string): { ref: ArtifactRef; data: Buffer } {
    const ref = this.artifacts.get(id);
    if (!ref) throw new CapabilityError('INVALID_ARGUMENT', `Artifact ${id} not found in store`);
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
      return { ref, data: fs.readFileSync(resolved) };
    } catch (err) {
      if (err instanceof CapabilityError) throw err;
      throw new CapabilityError('INVALID_ARGUMENT', `Failed to read artifact: ${(err as Error).message}`);
    }
  }
  readTextById(id: string): { ref: ArtifactRef; text: string } {
    const { ref, data } = this.readBytesById(id);
    return { ref, text: data.toString('utf8') };
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
