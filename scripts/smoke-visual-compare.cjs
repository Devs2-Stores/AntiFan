/**
 * Visual Compare & Pixel Diffing Smoke Test under real Electron Runtime
 */
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.whenReady().then(async () => {
  try {
    console.log('[Smoke] Testing Visual Compare under Electron Runtime...');
    const { computePixelDiff, BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port');
    const { registerBrowserCapabilities } = require('../.compiled/src/main/tools/browser-capabilities');
    const { CapabilityCatalogue } = require('../.compiled/src/main/tools/capability-catalogue');
    const { ArtifactStore } = require('../.compiled/src/main/tools/artifact-store');

    // Create 1x1 black and 2x2 multi-color PNGs via Chromium nativeImage pipeline
    const img1x1 = nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 });
    const png1x1 = img1x1.toPNG();

    const img2x2 = nativeImage.createFromBitmap(Buffer.from([
      255, 0, 0, 255,   0, 255, 0, 255,
      0, 0, 255, 255,   255, 255, 255, 255
    ]), { width: 2, height: 2 });
    const png2x2 = img2x2.toPNG();

    // 1. Exact match test
    const diffExact = computePixelDiff(png1x1, png1x1, 1.0);
    assert.strictEqual(diffExact.match, true, 'Exact match must pass');
    assert.strictEqual(diffExact.mismatchPercentage, 0, 'Mismatch must be 0%');
    assert.strictEqual(diffExact.diffPixels, 0);
    assert.strictEqual(diffExact.dimensionsMatch, true);
    console.log('[Smoke] 1. Exact match passed.');

    // 2. Tolerance test with different dimensions
    const diffDiff = computePixelDiff(png1x1, png2x2, 5.0);
    assert.strictEqual(diffDiff.match, false, 'Different size images must fail strict 5% tolerance');
    assert.strictEqual(diffDiff.dimensionsMatch, false);
    console.log('[Smoke] 2. Strict difference detection passed.');

    // 2b. Crossed aspect ratios test (e.g. 1x4 vs 4x1)
    const img1x4 = nativeImage.createFromBitmap(Buffer.alloc(1 * 4 * 4, 255), { width: 1, height: 4 });
    const img4x1 = nativeImage.createFromBitmap(Buffer.alloc(4 * 1 * 4, 255), { width: 4, height: 1 });
    const png1x4 = img1x4.toPNG();
    const png4x1 = img4x1.toPNG();
    const diffCrossed = computePixelDiff(png1x4, png4x1, 10.0);
    // area1=4, area2=4, overlap=1x1=1. Non-overlap pixels = 4 + 4 - 2(1) = 6. Inside overlap: matching white pixels -> 0 diff. Total diff = 6. Max bounding area = 4x4 = 16. Mismatch % = 6/16*100 = 37.5%.
    assert.strictEqual(diffCrossed.diffPixels, 6, 'Non-overlap pixels must be exactly area1 + area2 - 2*overlap');
    assert.strictEqual(diffCrossed.totalPixels, 16, 'Total canvas area is 4x4 = 16');
    assert.strictEqual(diffCrossed.mismatchPercentage, 37.5);
    assert.strictEqual(diffCrossed.match, false);
    console.log('[Smoke] 2b. Crossed aspect ratio pixel accounting passed.');

    // 2c. Boundary tolerance precision test (unrounded threshold check)
    // 100x100 canvas (10,000 pixels). 501 diff pixels = 5.01% actual mismatch.
    // With 5.00% tolerance, roundedMismatch is 5.01%, but if tolerance was 5.005%,
    // unrounded check must strictly reject (5.01 > 5.005) rather than comparing rounded.
    const bufA = Buffer.alloc(100 * 100 * 4, 0);
    const bufB = Buffer.alloc(100 * 100 * 4, 0);
    for (let i = 0; i < 501 * 4; i += 4) {
      bufB[i] = 255;
      bufB[i + 3] = 255;
    }
    const imgA = nativeImage.createFromBitmap(bufA, { width: 100, height: 100 });
    const imgB = nativeImage.createFromBitmap(bufB, { width: 100, height: 100 });
    const diffBoundary = computePixelDiff(imgA.toPNG(), imgB.toPNG(), 5.005);
    assert.strictEqual(diffBoundary.diffPixels, 501);
    assert.strictEqual(diffBoundary.mismatchPercentage, 5.01);
    assert.strictEqual(diffBoundary.match, false, '5.01% actual mismatch must strictly fail 5.005% tolerance');
    console.log('[Smoke] 2c. Boundary tolerance precision passed.');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-electron-smoke-'));
    try {
      const artifactStore = new ArtifactStore({
        root: tmpDir,
        maxArtifactBytes: 10 * 1024 * 1024,
      });

      const baselineRef = await artifactStore.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: png1x1,
        runId: 'run-vis-smoke',
        attemptId: 'att-vis-smoke',
        projectId: 'p1',
        workspaceId: 'w1',
      });

      const mockHost = {
        getTabList: () => [{ id: 'tab-1' }],
        isCurrentTarget: () => true,
        getDocumentGeneration: () => 1,
        captureScreenshot: async () => png1x1.toString('base64'),
      };

      const controlPort = new BrowserControlPort(mockHost, artifactStore);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: 'p1',
        workspaceId: 'w1',
        runtimeId: 'r1',
      });
      registerBrowserCapabilities(catalogue, controlPort);

      const res = await catalogue.dispatch('browser.visual_compare', {
        baselineScreenshotRef: baselineRef.id,
        tolerance: 2.0,
      }, {
        attachmentId: 'att-1',
        runId: 'run-vis-smoke',
        attemptId: 'att-vis-smoke',
        projectId: 'p1',
        workspaceId: 'w1',
        backendId: 'b1',
        hostEpoch: 1,
        invocationId: 'inv-vis-smoke',
        lease: { runtimeId: 'r1', projectId: 'p1', workspaceId: 'w1', token: 'tok', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 60000 },
        leaseToken: 'tok',
        browserTarget: {
          projectId: 'p1',
          workspaceId: 'w1',
          runtimeId: 'r1',
          tabId: 'tab-1',
          browserEpoch: 1,
          documentGeneration: 1,
        },
        grant: 'read',
      });

      assert.ok(res);
      assert.strictEqual(res.match, true);
      assert.strictEqual(res.mismatchPercentage, 0);
      console.log('[Smoke] 3. End-to-end browser.visual_compare via ArtifactStore passed.');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('[Smoke] ALL VISUAL COMPARE TESTS PASSED IN ELECTRON RUNTIME!');
    app.exit(0);
  } catch (err) {
    console.error('[Smoke] FAILED:', err);
    app.exit(1);
  }
});
