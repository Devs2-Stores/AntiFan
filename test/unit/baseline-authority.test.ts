import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  BaselineAuthority,
  readPngDimensions,
  type VisualBaselineRef,
} from '../../src/main/verification/baseline-authority';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { CapabilityError, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import { VerificationCaptureReceipt } from '../../src/main/verification/visual-capture';

function createTestPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0, 29);
  return buf;
}

function createTestContext(opts: {
  workspaceId: string;
  projectId?: string;
  runId?: string;
  attemptId?: string;
}): CapabilityRequestContext {
  const projectId = opts.projectId || 'test-proj';
  return {
    lease: {
      runtimeId: 'test-rt',
      projectId,
      workspaceId: opts.workspaceId,
      token: 'test-token',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    },
    leaseToken: 'test-lease-token',
    projectId,
    workspaceId: opts.workspaceId,
    runId: opts.runId || 'test-run',
    attemptId: opts.attemptId || 'test-att',
  };
}

describe('BaselineAuthority (Unit)', () => {
  let tmpDir: string;
  let artifactStore: ArtifactStore;
  let authority: BaselineAuthority;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-baseline-test-'));
    artifactStore = new ArtifactStore({ root: path.join(tmpDir, 'artifacts') });
    authority = new BaselineAuthority({
      storageRoot: path.join(tmpDir, 'baselines'),
      artifactStore,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('readPngDimensions', () => {
    it('extracts width and height from valid PNG IHDR chunk', () => {
      const png = createTestPng(1280, 720);
      const dims = readPngDimensions(png);
      assert.deepEqual(dims, { width: 1280, height: 720 });
    });

    it('returns null for non-PNG or short buffers', () => {
      assert.equal(readPngDimensions(Buffer.from('not a png')), null);
      assert.equal(readPngDimensions(Buffer.alloc(10)), null);
    });
  });

  describe('promote with authoritative capture receipt (V-22, R1)', () => {
    it('promotes an artifact into an immutable workspace baseline with SHA-256 and receipt metadata', async () => {
      const png = createTestPng(800, 600);
      const artifact = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png,
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const ctx = createTestContext({
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const receipt: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 1,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 800, height: 600 },
        timestamp: Date.now(),
      };

      const ref = authority.promote(artifact.id, ctx, { captureReceipt: receipt });

      assert.match(ref.id, /^vbase_[a-f0-9_]+$/);
      assert.equal(ref.sourceArtifactId, artifact.id);
      assert.equal(ref.workspaceId, 'ws-alpha');
      assert.equal(ref.projectId, 'proj-alpha');
      assert.equal(ref.sha256, crypto.createHash('sha256').update(png).digest('hex'));
      assert.deepEqual(ref.captureStateMini.rasterSize, { width: 800, height: 600 });
      assert.deepEqual(ref.captureStateMini.cssViewport, { width: 800, height: 600 });
      assert.equal(ref.captureStateMini.backend, 'cdp');

      // Verify files written on disk
      assert.ok(fs.existsSync(ref.path), 'Baseline PNG exists on disk');
      const manifestPath = ref.path.replace(/\.png$/, '.json');
      assert.ok(fs.existsSync(manifestPath), 'Baseline manifest exists on disk');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.sha256, ref.sha256);
      assert.equal(manifest.id, ref.id);
    });

    it('validates receipt fields before writing files, leaving zero orphan files on failure', async () => {
      const png = createTestPng(800, 600);
      const artifact = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png,
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const ctx = createTestContext({
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const baselineDir = authority.getBaselineDir('ws-alpha');

      // 1. Missing receipt throws and writes 0 files
      assert.throws(
        () => authority.promote(artifact.id, ctx, {} as any),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
      );
      assert.equal(fs.readdirSync(baselineDir).length, 0, 'No orphan files on missing receipt');

      // 2. Empty backend throws and writes 0 files
      assert.throws(
        () => authority.promote(artifact.id, ctx, {
          captureReceipt: { backend: '', dpr: 1, zoom: 1, cssViewport: { width: 800, height: 600 }, rasterSize: { width: 800, height: 600 }, timestamp: Date.now() },
        }),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('backend must be a non-empty string')
      );
      assert.equal(fs.readdirSync(baselineDir).length, 0, 'No orphan files on empty backend');

      // 3. Non-positive DPR throws and writes 0 files
      assert.throws(
        () => authority.promote(artifact.id, ctx, {
          captureReceipt: { backend: 'cdp', dpr: 0, zoom: 1, cssViewport: { width: 800, height: 600 }, rasterSize: { width: 800, height: 600 }, timestamp: Date.now() },
        }),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('dpr must be a finite positive number')
      );
      assert.equal(fs.readdirSync(baselineDir).length, 0, 'No orphan files on invalid DPR');

      // 4. Mismatched raster dimensions (claiming 1920x1080 for an 800x600 PNG) throws and writes 0 files
      assert.throws(
        () => authority.promote(artifact.id, ctx, {
          captureReceipt: { backend: 'cdp', dpr: 1, zoom: 1, cssViewport: { width: 800, height: 600 }, rasterSize: { width: 1920, height: 1080 }, timestamp: Date.now() },
        }),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('do not match actual PNG dimensions')
      );
      assert.equal(fs.readdirSync(baselineDir).length, 0, 'No orphan files on raster dimension mismatch');
    });
    it('rejects truncated artifacts before writing any files to disk', async () => {
      const png = createTestPng(800, 600);
      const ctx = createTestContext({
        runId: 'run-trunc',
        attemptId: 'att-trunc',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });
      const artifact = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png,
        maxBytes: 20,
        runId: 'run-trunc',
        attemptId: 'att-trunc',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });
      assert.strictEqual(artifact.truncated, true);

      const baselineDir = path.join(tmpDir, 'baselines', 'ws-alpha');
      assert.throws(
        () => authority.promote(artifact.id, ctx, {
          captureReceipt: {
            backend: 'cdp',
            dpr: 1,
            zoom: 1,
            cssViewport: { width: 800, height: 600 },
            rasterSize: { width: 800, height: 600 },
            timestamp: Date.now(),
          },
        }),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('truncated')
      );
      assert.ok(!fs.existsSync(baselineDir) || fs.readdirSync(baselineDir).length === 0, 'Zero files written to baseline dir on truncated artifact');
    });

    it('fails closed when workspaceId is missing or invalid', async () => {
      assert.throws(
        () => authority.promote('art-1', { runId: 'run-1' } as any, { captureReceipt: {} as any }),
        (err: any) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
      );

      assert.throws(
        () => authority.promote('art-1', createTestContext({ workspaceId: '../../bad' }), { captureReceipt: {} as any }),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
      );
    });
  });

  describe('resolve and tamper detection (V-22, R2)', () => {
    it('resolves an intact promoted baseline and returns matching binary buffer', async () => {
      const png = createTestPng(640, 480);
      const artifact = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png,
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const ctx = createTestContext({
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const receipt: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 1,
        zoom: 1,
        cssViewport: { width: 640, height: 480 },
        rasterSize: { width: 640, height: 480 },
        timestamp: Date.now(),
      };

      const ref = authority.promote(artifact.id, ctx, { captureReceipt: receipt });

      const resolved = authority.resolve(ref.id, { workspaceId: 'ws-alpha' });
      assert.equal(resolved.ref.id, ref.id);
      assert.equal(resolved.data.length, png.length);
      assert.deepEqual(resolved.data, png);
    });

    it('fails closed with BASELINE_TAMPERED if baseline image is modified on disk', async () => {
      const png = createTestPng(640, 480);
      const artifact = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png,
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const ctx = createTestContext({
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-alpha',
        workspaceId: 'ws-alpha',
      });

      const receipt: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 1,
        zoom: 1,
        cssViewport: { width: 640, height: 480 },
        rasterSize: { width: 640, height: 480 },
        timestamp: Date.now(),
      };

      const ref = authority.promote(artifact.id, ctx, { captureReceipt: receipt });

      // Tamper with the image file on disk (flip 1 byte)
      const tampered = Buffer.from(png);
      tampered[16] = ((tampered[16] ?? 0) + 1) % 256;
      fs.writeFileSync(ref.path, tampered);

      assert.throws(
        () => authority.resolve(ref.id, { workspaceId: 'ws-alpha' }),
        (err: any) => err instanceof CapabilityError && err.code === 'BASELINE_TAMPERED'
      );
    });

    it('enforces workspace boundary isolation and project matching', async () => {
      const png = createTestPng(320, 240);
      const artifact = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png,
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-1',
        workspaceId: 'ws-1',
      });

      const ctx = createTestContext({
        runId: 'run-1',
        attemptId: 'att-1',
        projectId: 'proj-1',
        workspaceId: 'ws-1',
      });

      const receipt: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 1,
        zoom: 1,
        cssViewport: { width: 320, height: 240 },
        rasterSize: { width: 320, height: 240 },
        timestamp: Date.now(),
      };

      const ref = authority.promote(artifact.id, ctx, { captureReceipt: receipt });

      // Resolving from another workspace fails
      assert.throws(
        () => authority.resolve(ref.id, { workspaceId: 'ws-2' }),
        (err: any) => err instanceof CapabilityError && err.code === 'REF_NOT_FOUND'
      );

      // Resolving with mismatched projectId fails
      assert.throws(
        () => authority.resolve(ref.id, { workspaceId: 'ws-1', projectId: 'proj-2' }),
        (err: any) => err instanceof CapabilityError && err.code === 'PROJECT_MISMATCH'
      );
    });
  });

  describe('verifyCaptureCompatibility (R3)', () => {
    const baseRef: VisualBaselineRef = {
      id: 'vbase_test1',
      sha256: 'deadbeef',
      sourceArtifactId: 'art-1',
      captureStateMini: {
        backend: 'cdp',
        dpr: 2,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 1600, height: 1200 },
      },
      promotedAt: Date.now(),
      workspaceId: 'ws-1',
      path: '/path/test',
    };

    it('returns compatible: true when all capture dimensions and parameters match', () => {
      const target: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 2,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 1600, height: 1200 },
        timestamp: Date.now(),
      };

      const res = authority.verifyCaptureCompatibility(baseRef, target);
      assert.deepEqual(res, { compatible: true });
    });

    it('detects capture backend switch', () => {
      const target: VerificationCaptureReceipt = {
        backend: 'legacy-page',
        dpr: 2,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 1600, height: 1200 },
        timestamp: Date.now(),
      };

      const res = authority.verifyCaptureCompatibility(baseRef, target);
      assert.equal(res.compatible, false);
      assert.match(res.reason!, /Capture backend switched/);
    });

    it('detects DPR mismatch', () => {
      const target: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 1,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 1600, height: 1200 },
        timestamp: Date.now(),
      };

      const res = authority.verifyCaptureCompatibility(baseRef, target);
      assert.equal(res.compatible, false);
      assert.match(res.reason!, /Device pixel ratio mismatch/);
    });

    it('detects zoom mismatch', () => {
      const target: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 2,
        zoom: 1.25,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 1600, height: 1200 },
        timestamp: Date.now(),
      };

      const res = authority.verifyCaptureCompatibility(baseRef, target);
      assert.equal(res.compatible, false);
      assert.match(res.reason!, /Zoom level mismatch/);
    });

    it('detects CSS viewport mismatch', () => {
      const target: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 2,
        zoom: 1,
        cssViewport: { width: 1024, height: 768 },
        rasterSize: { width: 1600, height: 1200 },
        timestamp: Date.now(),
      };

      const res = authority.verifyCaptureCompatibility(baseRef, target);
      assert.equal(res.compatible, false);
      assert.match(res.reason!, /CSS viewport dimension mismatch/);
    });

    it('detects rasterSize mismatch', () => {
      const target: VerificationCaptureReceipt = {
        backend: 'cdp',
        dpr: 2,
        zoom: 1,
        cssViewport: { width: 800, height: 600 },
        rasterSize: { width: 800, height: 600 },
        timestamp: Date.now(),
      };

      const res = authority.verifyCaptureCompatibility(baseRef, target);
      assert.equal(res.compatible, false);
      assert.match(res.reason!, /Raster dimension mismatch/);
    });
  });

  describe('ArtifactStore Invariant (R4)', () => {
    it('ensures ArtifactStore.ts remains strictly untouched (0 lines modified against HEAD)', () => {
      const diff = execSync('git diff HEAD src/main/tools/artifact-store.ts', { encoding: 'utf8' });
      assert.equal(diff.trim(), '', 'ArtifactStore.ts must not have any modifications against HEAD');
    });
  });
});
