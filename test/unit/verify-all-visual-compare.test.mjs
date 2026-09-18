import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

import {
  MANDATORY_VIEWPORTS,
  VIEWPORT_CONFIG,
  calculatePixelDiff,
  decodePng,
  evaluateCaptureValidity,
  evaluatePair,
  runVerification,
  tallyVerdicts,
} from '../../scripts/verify-all-visual-compare.mjs';

// The compare path under test is the compiled port artifact; every lane that runs
// this file compiles first (`test:fast`, `test:unit` and `test` are compile-gated),
// and `.compiled/src` imports are already the convention in this directory.
import { BrowserControlPort, resolveProjectionViewport } from '../../.compiled/src/main/tools/browser-control-port.js';
import { materializeRasterMasks, visualCaptureSpaceFromMeasured } from '../../.compiled/src/main/verification/visual-capture.js';

const tempDirs = [];

function makeTempDir(prefix = 'vcomp-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(12 + len);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  buf.writeUInt32BE(0, 8 + len); // Dummy CRC; decodePng ignores CRC
  return buf;
}

/**
 * Helper to generate valid uncompressed PNG buffer in memory for testing.
 */
function createTestPng({ width, height, color = [50, 100, 150, 255], pattern = null }) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      let [r, g, b, a] = color;
      if (pattern) {
        [r, g, b, a] = pattern(x, y);
      }
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a ?? 255;
    }
  }

  const compressed = zlib.deflateSync(raw);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

describe('verify-all-visual-compare core primitives', () => {
  it('decodes in-memory test PNG correctly', () => {
    const dir = makeTempDir();
    const pngPath = path.join(dir, 'test.png');
    const pngBuf = createTestPng({
      width: 10,
      height: 10,
      pattern: (x, y) => [x * 20, y * 20, 100, 255],
    });
    fs.writeFileSync(pngPath, pngBuf);

    const decoded = decodePng(pngPath);
    assert.ok(decoded);
    assert.equal(decoded.w, 10);
    assert.equal(decoded.h, 10);
    assert.equal(decoded.channels, 4);
    assert.equal(decoded.data.length, 10 * 10 * 4);
  });

  it('rejects corrupted or non-PNG file gracefully as null', () => {
    const dir = makeTempDir();
    const fakePath = path.join(dir, 'fake.png');
    fs.writeFileSync(fakePath, Buffer.from('NOT A PNG FILE'));

    const decoded = decodePng(fakePath);
    assert.equal(decoded, null);
  });
});

describe('Defect D6 Regression: Fresh-diff dominance vs recorded fallback', () => {
  it('uses fresh mismatch (FAIL) and never falls back to or min-selects recorded JSON (PASS)', async () => {
    const dir = makeTempDir();
    const canaryDir = path.join(dir, 'canary', 'page-01-home', 'attempts', 'attempt-1', 'evidence');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Reference: dark patterned image (content-bearing)
    const refPng = createTestPng({
      width: 50,
      height: 50,
      pattern: (x, y) => [10 + (x % 5), 10 + (y % 5), 10, 255],
    });
    // Clone: bright patterned image with massive difference (~100% mismatch, content-bearing)
    const clonePng = createTestPng({
      width: 50,
      height: 50,
      pattern: (x, y) => [200 + (x % 5), 200 + (y % 5), 200, 255],
    });

    fs.writeFileSync(path.join(canaryDir, '1440-reference.png'), refPng);
    fs.writeFileSync(path.join(canaryDir, '1440-clone.png'), clonePng);

    // Stale/recorded JSON with a fake 0.01% PASS
    fs.writeFileSync(path.join(canaryDir, '1440.json'), JSON.stringify({
      stages: { compare: { mismatchPercentage: 0.01 } },
      visual: { mismatchPercentage: 0.01 },
    }));

    const outDir = path.join(dir, 'reports');
    const { results } = await runVerification({
      baseDir: path.join(dir, 'canary'),
      outputDir: outDir,
      viewports: ['1440'],
      publishManifest: false,
      silent: true,
    });

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.status, 'FAIL', 'must FAIL on fresh difference, ignoring recorded 0.01%');
    assert.ok(r.mismatchPercentage > 50, `fresh mismatch must be large, got ${r.mismatchPercentage}%`);
    assert.notEqual(r.mismatchPercentage, 0.01, 'must never min-select the recorded 0.01%');
  });
});

describe('Defect D7 Regression: Null pass counting arithmetic trap', () => {
  it('does not increment passCount for null mismatchPercentage (neutralizes null < 2.0)', () => {
    const sampleResults = [
      { status: 'PASS', mismatchPercentage: 1.2 },
      { status: 'FAIL', mismatchPercentage: 3.4 },
      { status: 'INCONCLUSIVE', mismatchPercentage: null },
      { status: 'INCONCLUSIVE', mismatchPercentage: null },
    ];

    const { total, passCount, failCount, inconclusiveCount } = tallyVerdicts(sampleResults);

    assert.equal(total, 4);
    assert.equal(passCount, 1, 'only the 1.2% PASS row may count as PASS');
    assert.equal(failCount, 1, '1 FAIL row');
    assert.equal(inconclusiveCount, 2, '2 INCONCLUSIVE rows');
  });

  it('proves raw JS (null < 2.0 === true) but tallyVerdicts produces passCount = 0 for null', () => {
    assert.equal(null < 2.0, true, 'proves raw JS trap');

    const unmeasuredResults = [
      { status: 'INCONCLUSIVE', mismatchPercentage: null },
    ];
    const tally = tallyVerdicts(unmeasuredResults);
    assert.equal(tally.passCount, 0, 'tallyVerdicts must NOT count null as pass');
    assert.equal(tally.inconclusiveCount, 1);
  });
});

describe('Mandatory viewports 390 / 768 / 1440 and absent 768 handling', () => {
  it('specifies 1440, 768, 390 as mandatory viewports and quarantines 1024', () => {
    assert.deepEqual(MANDATORY_VIEWPORTS, ['1440', '768', '390']);
    assert.ok(!MANDATORY_VIEWPORTS.includes('1024'), '1024 must be quarantined');
    assert.equal(VIEWPORT_CONFIG['768'].label, '768x1024 (Tablet)');
  });

  it('marks absent 768px viewport as INCONCLUSIVE with null mismatch', async () => {
    const dir = makeTempDir();
    const canaryDir = path.join(dir, 'canary', 'page-01-home', 'attempts', 'attempt-1', 'evidence');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Only provide 1440px and 390px, omit 768px
    const img = createTestPng({
      width: 20,
      height: 20,
      pattern: (x, y) => [x * 5, y * 5, 50, 255],
    });
    fs.writeFileSync(path.join(canaryDir, '1440-reference.png'), img);
    fs.writeFileSync(path.join(canaryDir, '1440-clone.png'), img);
    fs.writeFileSync(path.join(canaryDir, '390-reference.png'), img);
    fs.writeFileSync(path.join(canaryDir, '390-clone.png'), img);

    // Also leave a legacy 1024.png to confirm it is never picked up as tablet substitute
    fs.writeFileSync(path.join(canaryDir, '1024-reference.png'), img);
    fs.writeFileSync(path.join(canaryDir, '1024-clone.png'), img);

    const outDir = path.join(dir, 'reports');
    const { results } = await runVerification({
      baseDir: path.join(dir, 'canary'),
      outputDir: outDir,
      publishManifest: false,
      silent: true,
    });

    const r768 = results.find(r => r.vpLabel === '768');
    assert.ok(r768, 'must evaluate 768');
    assert.equal(r768.status, 'INCONCLUSIVE');
    assert.equal(r768.mismatchPercentage, null);
    assert.equal(r768.reason, 'MISSING_EVIDENCE');
  });
});

describe('Dimensions mismatch cannot PASS', () => {
  it('forces status FAIL when dimensions mismatch even if pixel mismatch < 2.0%', () => {
    // 50x50 vs 50x51: identical pixels on overlap, small height delta
    const pngA = {
      w: 50,
      h: 50,
      channels: 4,
      data: Buffer.alloc(50 * 50 * 4, 100),
    };
    pngA.data[0] = 200;

    const pngB = {
      w: 50,
      h: 51,
      channels: 4,
      data: Buffer.alloc(50 * 51 * 4, 100),
    };
    pngB.data[0] = 200;

    const diff = calculatePixelDiff(pngA, pngB);
    assert.ok(diff);
    assert.equal(diff.dimensions.match, false);
    assert.ok(diff.mismatchPercentage < 2.0, `mismatch is ${diff.mismatchPercentage}% which is < 2.0%`);

    const evaluated = evaluatePair({
      pngA,
      pngB,
      refSha: 'shaA',
      cloneSha: 'shaB',
      pageSlug: 'page-01-home',
      pageName: 'Home',
      vp: '1440',
    });

    assert.equal(evaluated.status, 'FAIL', 'dimensions mismatch MUST fail even with < 2.0% mismatch');
    assert.equal(evaluated.dimsMatch, false);
    assert.equal(evaluated.reason, 'DIMENSIONS_MISMATCH');
  });
});

describe('Consistent attempt: No mixed prior attempts', () => {
  it('evaluates strictly from the latest attempt and never mixes PNGs from older attempts', async () => {
    const dir = makeTempDir();
    const pageDir = path.join(dir, 'canary', 'page-01-home', 'attempts');

    // Attempt 1: older, has 768px
    const att1Dir = path.join(pageDir, 'attempt-1', 'evidence');
    fs.mkdirSync(att1Dir, { recursive: true });
    const img768 = createTestPng({
      width: 30,
      height: 30,
      pattern: (x, y) => [x * 4, y * 4, 20, 255],
    });
    fs.writeFileSync(path.join(att1Dir, '768-reference.png'), img768);
    fs.writeFileSync(path.join(att1Dir, '768-clone.png'), img768);

    // Give attempt 1 an older mtime
    const older = new Date(Date.now() - 100000);
    fs.utimesSync(path.join(pageDir, 'attempt-1'), older, older);

    // Attempt 2: newer, only has 1440px
    const att2Dir = path.join(pageDir, 'attempt-2', 'evidence');
    fs.mkdirSync(att2Dir, { recursive: true });
    const img1440 = createTestPng({
      width: 40,
      height: 40,
      pattern: (x, y) => [x * 3, y * 3, 30, 255],
    });
    fs.writeFileSync(path.join(att2Dir, '1440-reference.png'), img1440);
    fs.writeFileSync(path.join(att2Dir, '1440-clone.png'), img1440);

    const outDir = path.join(dir, 'reports');
    const { results } = await runVerification({
      baseDir: path.join(dir, 'canary'),
      outputDir: outDir,
      publishManifest: false,
      silent: true,
    });

    const r768 = results.find(r => r.vpLabel === '768');
    assert.ok(r768);
    assert.equal(r768.status, 'INCONCLUSIVE', 'must NOT scavenge 768px from attempt-1');
    assert.equal(r768.attempt, 'attempt-2', 'evaluated strictly under attempt-2');
  });
});

describe('Honest provenance and campaign certification', () => {
  it('distinguishes archived captures and refuses FINAL_PASS certification without live attestation', async () => {
    const dir = makeTempDir();
    const canaryDir = path.join(dir, 'canary', 'page-01-home', 'attempts', 'attempt-1', 'evidence');
    fs.mkdirSync(canaryDir, { recursive: true });

    const img = createTestPng({
      width: 20,
      height: 20,
      pattern: (x, y) => [x * 5, y * 5, 50, 255],
    });
    fs.writeFileSync(path.join(canaryDir, '1440-reference.png'), img);
    fs.writeFileSync(path.join(canaryDir, '1440-clone.png'), img);

    const outDir = path.join(dir, 'reports');
    const { results, manifestPayload } = await runVerification({
      baseDir: path.join(dir, 'canary'),
      outputDir: outDir,
      viewports: ['1440'],
      isLiveCapture: false,
      hasIdentityAttestation: false,
      publishManifest: false,
      silent: true,
    });
    assert.equal(manifestPayload.canCertifyFinalPass, false);
    assert.equal(manifestPayload.campaignCertification, 'DIAGNOSTIC_ONLY');
    assert.equal(manifestPayload.store, null, 'must not stamp store as verified from constants');
    assert.equal(manifestPayload.orgId, null, 'must not stamp orgId as verified from constants');
    assert.equal(manifestPayload.themeId, null, 'must not stamp themeId as verified from constants');

    assert.equal(results[0].provenance.isLiveCapture, false);
    assert.equal(results[0].provenance.evidenceType, 'disk_capture');
    assert.equal(results[0].provenance.attestationStatus, 'MISSING_LIVE_RECEIPTS');
  });

  it('enforces diagnostic-only behavior: disk capture verifier cannot certify FINAL_PASS even if booleans are supplied', async () => {
    const dir = makeTempDir();
    const canaryDir = path.join(dir, 'canary', 'page-01-home', 'attempts', 'attempt-1', 'evidence');
    fs.mkdirSync(canaryDir, { recursive: true });

    const img = createTestPng({
      width: 20,
      height: 20,
      pattern: (x, y) => [x * 5, y * 5, 50, 255],
    });
    fs.writeFileSync(path.join(canaryDir, '1440-reference.png'), img);
    fs.writeFileSync(path.join(canaryDir, '1440-clone.png'), img);

    const outDir = path.join(dir, 'reports');
    const { manifestPayload } = await runVerification({
      baseDir: path.join(dir, 'canary'),
      outputDir: outDir,
      viewports: ['1440'],
      publishManifest: false,
      silent: true,
    });

    assert.equal(manifestPayload.canCertifyFinalPass, false, 'disk verifier must never certify FINAL_PASS');
    assert.equal(manifestPayload.campaignCertification, 'DIAGNOSTIC_ONLY');
    assert.ok(manifestPayload.attestationNotice.includes('cannot certify FINAL_PASS'));
  });
});

describe('Capture validity: rejects structural invalidity and permits valid identical images', () => {
  it('rejects captures with zero dimensions or missing data as INCONCLUSIVE', () => {
    const zeroA = { w: 0, h: 100, channels: 4, data: Buffer.alloc(0) };
    const zeroB = { w: 100, h: 100, channels: 4, data: Buffer.alloc(400) };

    const validity = evaluateCaptureValidity(zeroA, zeroB);
    assert.equal(validity.valid, false);
    assert.equal(validity.reason, 'ZERO_DIMENSIONS');

    const evaluated = evaluatePair({
      pngA: zeroA,
      pngB: zeroB,
      refSha: 'hashA',
      cloneSha: 'hashB',
      pageSlug: 'page-01-home',
      pageName: 'Home',
      vp: '1440',
    });

    assert.equal(evaluated.status, 'INCONCLUSIVE');
    assert.equal(evaluated.mismatchPercentage, null);
    assert.equal(evaluated.reason, 'ZERO_DIMENSIONS');
  });

  it('rejects blank-vs-blank uniform captures as unrendered instead of scoring 0.00% PASS', () => {
    const blank = Buffer.alloc(20 * 20 * 4, 255);
    const blankA = { w: 20, h: 20, channels: 4, data: Buffer.from(blank) };
    const blankB = { w: 20, h: 20, channels: 4, data: Buffer.from(blank) };

    const validity = evaluateCaptureValidity(blankA, blankB);
    assert.equal(validity.valid, false);
    assert.equal(validity.reason, 'BLANK_PAIR_UNRENDERED');

    const evaluated = evaluatePair({
      pngA: blankA,
      pngB: blankB,
      refSha: 'sameSha',
      cloneSha: 'sameSha',
      pageSlug: 'page-01-home',
      pageName: 'Home',
      vp: '1440',
    });

    assert.equal(evaluated.status, 'INCONCLUSIVE');
    assert.equal(evaluated.mismatchPercentage, null);
  });

  it('keeps a uniform frame comparable when the other side rendered content', () => {
    const blank = Buffer.alloc(20 * 20 * 4, 255);
    const patterned = Buffer.alloc(20 * 20 * 4);
    for (let i = 0; i < 20 * 20; i++) {
      patterned[i * 4] = i % 256;
      patterned[i * 4 + 3] = 255;
    }

    const blankPng = { w: 20, h: 20, channels: 4, data: Buffer.from(blank) };
    const patternPng = { w: 20, h: 20, channels: 4, data: Buffer.from(patterned) };

    const validity = evaluateCaptureValidity(blankPng, patternPng);
    assert.equal(validity.valid, true);

    const evaluated = evaluatePair({
      pngA: blankPng,
      pngB: patternPng,
      refSha: 'hashA',
      cloneSha: 'hashB',
      pageSlug: 'page-01-home',
      pageName: 'Home',
      vp: '1440',
    });

    assert.equal(evaluated.status, 'FAIL');
  });

  it('permits valid identical content-bearing images honestly as 0.00% PASS without size/entropy heuristics', () => {
    // Both images have patterned, content-bearing pixels
    const data = Buffer.alloc(50 * 50 * 4);
    for (let i = 0; i < 50 * 50; i++) {
      data[i * 4] = i % 256;
      data[i * 4 + 1] = (i * 3) % 256;
      data[i * 4 + 2] = 128;
      data[i * 4 + 3] = 255;
    }

    const pngA = { w: 50, h: 50, channels: 4, data: Buffer.from(data) };
    const pngB = { w: 50, h: 50, channels: 4, data: Buffer.from(data) };


    const validity = evaluateCaptureValidity(pngA, pngB);
    assert.equal(validity.valid, true);

    const evaluated = evaluatePair({
      pngA,
      pngB,
      refSha: 'sameSha',
      cloneSha: 'sameSha',
      pageSlug: 'page-01-home',
      pageName: 'Home',
      vp: '1440',
    });

    assert.equal(evaluated.status, 'PASS');
    assert.equal(evaluated.mismatchPercentage, 0.0);
    assert.equal(evaluated.dimsMatch, true);
  });
});

describe('Output isolation and immutable historical reports', () => {
  it('writes run artifacts into reports/runs/<runId>/ and publishes current manifest pointer', async () => {
    const dir = makeTempDir();
    const canaryDir = path.join(dir, 'canary', 'page-01-home', 'attempts', 'attempt-1', 'evidence');
    fs.mkdirSync(canaryDir, { recursive: true });

    const img = createTestPng({
      width: 20,
      height: 20,
      pattern: (x, y) => [x * 5, y * 5, 50, 255],
    });
    fs.writeFileSync(path.join(canaryDir, '1440-reference.png'), img);
    fs.writeFileSync(path.join(canaryDir, '1440-clone.png'), img);

    const outDir = path.join(dir, 'reports');

    // Simulate historical root reports in outDir
    fs.mkdirSync(outDir, { recursive: true });
    const histJsonPath = path.join(outDir, 'visual-compare-45-cases.json');
    const histMdPath = path.join(outDir, 'VISUAL-COMPARE-15-PAGES-VERIFICATION.md');
    fs.writeFileSync(histJsonPath, '{"historical": true}');
    fs.writeFileSync(histMdPath, '# Historical Report');

    const { runId, runDir } = await runVerification({
      baseDir: path.join(dir, 'canary'),
      outputDir: outDir,
      viewports: ['1440'],
      publishManifest: true,
      silent: true,
    });

    // Check run-scoped artifacts
    assert.ok(fs.existsSync(path.join(runDir, 'visual-compare-cases.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'VISUAL-COMPARE-VERIFICATION.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'run-identity-manifest.json')));

    // Check published pointer
    const pointerPath = path.join(outDir, 'run-identity-manifest.json');
    assert.ok(fs.existsSync(pointerPath));
    const pointerContent = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    assert.equal(pointerContent.runId, runId);

    // Check that historical root reports are untouched
    assert.equal(fs.readFileSync(histJsonPath, 'utf8'), '{"historical": true}');
    assert.equal(fs.readFileSync(histMdPath, 'utf8'), '# Historical Report');
  });
});

// ── Mask projection geometry: measured, or refused — never invented ──────────
//
// executeVisualCompareAttempt() used to project every dynamic mask through
// `metrics.vw || capture.cssViewport.width || rasterWidth || 1200` (height the
// same, plus `documentHeight || viewportHeight`). A side whose live CSS metrics
// read had timed out, or reported vw <= 0, therefore entered the mask ledger
// with a coordinate space no surface ever had: masks landed on the wrong pixels,
// which reports regressions that are not there and hides the ones that are.
//
// The compare path now resolves each side's projection viewport from
// measurements that exist for that side (resolveProjectionViewport) and hands
// the mask ledger 0 when none does, so the ledger's existing typed refusal
// (MASK_RESOLUTION_FAILED) stands in place of fabricated geometry. An unmeasured
// document height is reported as 0, which the capture-space builder reads as
// "fall back to the x scale" — the scale a full-page capture rasterizes the
// document with — instead of being substituted with the viewport height.
//
// Reachability, per the code path: the mask block runs after the capture-state
// gate, which refuses a pair whose measured CSS viewports are degenerate or
// differ, and each side then holds the envelope of a capture that already
// happened. The 1200x800 default was consequently only reachable by bypassing
// that gate, while the document-height substitution was reachable on any
// full-page compare whose live metrics read failed — the end-to-end case below
// pins that one.

const require = createRequire(import.meta.url);

const ROUTE_URL = 'https://store.example.com/product';
const RASTER = { width: 400, height: 1200 };
// A real full-page capture: the document (1200 CSS px) is taller than the
// viewport it was captured in (300 CSS px), at dpr 1 and zoom 1.
const CSS_VIEWPORT = { width: 400, height: 300 };
const DOCUMENT_HEIGHT = 1200;
// The fixture mask, viewport-relative as the mask query reads it (scrolled to
// the top, so document-relative and viewport-relative coincide).
const MASK_BOX = { x: 0, y: 600, width: 400, height: 100 };
const BASE_COLOR = [10, 20, 30, 255];
const BAND_COLOR = [250, 5, 5, 255];

/** Raster buffer (base64) -> the bitmap and size the stubbed nativeImage reports. */
const rasterBitmaps = new Map();

function buildRasterBitmap({ width, height, base, band }) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const inBand = Boolean(band) && y >= band.fromY && y < band.toY;
    const color = inBand ? band.color : base;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      bitmap[at] = color[0];
      bitmap[at + 1] = color[1];
      bitmap[at + 2] = color[2];
      bitmap[at + 3] = color[3] ?? 255;
    }
  }
  return bitmap;
}

/**
 * Two rasters that differ ONLY inside MASK_BOX, so a projection that places the
 * mask anywhere else publishes the masked difference as a regression.
 */
function buildProjectionFixture() {
  const targetPng = createTestPng({ width: RASTER.width, height: RASTER.height, color: BASE_COLOR });
  const baselinePng = createTestPng({
    width: RASTER.width,
    height: RASTER.height,
    pattern: (x, y) => (y >= MASK_BOX.y && y < MASK_BOX.y + MASK_BOX.height ? BAND_COLOR : BASE_COLOR),
  });
  rasterBitmaps.set(targetPng.toString('base64'), {
    width: RASTER.width,
    height: RASTER.height,
    bitmap: buildRasterBitmap({ width: RASTER.width, height: RASTER.height, base: BASE_COLOR }),
  });
  rasterBitmaps.set(baselinePng.toString('base64'), {
    width: RASTER.width,
    height: RASTER.height,
    bitmap: buildRasterBitmap({
      width: RASTER.width,
      height: RASTER.height,
      base: BASE_COLOR,
      band: { fromY: MASK_BOX.y, toY: MASK_BOX.y + MASK_BOX.height, color: BAND_COLOR },
    }),
  });
  return { targetPng, baselinePng };
}

/** Host adapter for the compare path: two mock tabs, one declared route, per-tab rasters. */
function buildProjectionHost(opts) {
  const { rasters, viewport, documentHeight, maskBoxes } = opts;
  return {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
    getTabUrl: () => ROUTE_URL,
    evalJs: async (script, tabId) => {
      if (script.includes('__antifan_compare_txn__')) {
        return script.includes('alreadyRestored')
          ? { restored: true, alreadyRestored: true, failed: 0 }
          : { applied: true, alreadyApplied: true, recorded: 0 };
      }
      if (script.includes('el.remove')) return true;
      if (script.includes('document.fonts.ready')) return true;
      if (script.includes('img.decode')) return { settled: true, brokenImages: [] };
      if (script.includes('requestAnimationFrame')) return true;
      // The fixture withholds the live CSS metrics read: readSideMetrics() maps a
      // vw <= 0 payload — and a timed-out read — to null, which is the audited input.
      if (script.includes('window.innerWidth')) return { vw: 0, vh: 0, dh: 0, sx: 0, sy: 0 };
      if (script.includes('r.width <= 0')) return { x: 0, y: 0, width: viewport.width, height: viewport.height };
      if (script.includes('root.children')) return [];
      if (script.includes('const selectors =')) return [{ selector: '.banner', error: null, boxes: maskBoxes }];
      return null;
    },
    captureVerificationScreenshot: async (rect, tabId) => ({
      data: rasters[tabId].toString('base64'),
      backend: 'cdp',
      dpr: 1,
      zoom: 1,
      cssViewport: { width: viewport.width, height: viewport.height },
      cssCaptureSize: { width: viewport.width, height: documentHeight },
      rasterSize: { width: RASTER.width, height: RASTER.height },
      captureMode: 'full-page',
      timestamp: Date.now(),
    }),
    getBrowserEpoch: () => 1,
    getDocumentGeneration: () => 1,
    getMutationRevision: () => 1,
    isTargetDraining: () => false,
    getNetworkTracker: () => ({
      isAttached: () => true,
      awaitQuiescence: async () => ({ settled: true, durationMs: 5, timedOut: false }),
    }),
  };
}

const projectionTarget = {
  tabId: 'tab-a',
  documentGeneration: 1,
  projectId: 'test-proj',
  workspaceId: 'test-ws',
  runtimeId: 'test-rt',
  browserEpoch: 1,
};

const projectionParams = {
  comparisonTabId: 'tab-b',
  fullPage: true,
  maskSelectors: ['.banner'],
  useDefaultWidgetMasks: false,
  expectedTargetUrl: ROUTE_URL,
  expectedBaselineUrl: ROUTE_URL,
};

describe('visualCompare mask projection geometry is measured or refused, never invented', () => {
  let electronEntry;
  let electronExportsBackup;

  // computePixelDiff reads pixels through Electron's nativeImage. Under plain node
  // the `electron` package resolves to a path string, so the diff path throws.
  // Preload the (cheap, path-exporting) real entry, then replace its exports with
  // the fixture's raster registry for the duration of this suite.
  before(() => {
    const resolved = require.resolve('electron');
    electronEntry = require.cache[resolved];
    if (!electronEntry) {
      require(resolved);
      electronEntry = require.cache[resolved];
    }
    if (!electronEntry) throw new Error('electron module cache entry unavailable; the pixel diff cannot be exercised');
    electronExportsBackup = electronEntry.exports;
    electronEntry.exports = {
      nativeImage: {
        createFromBuffer: (buf) => {
          const entry = rasterBitmaps.get(buf.toString('base64'));
          if (!entry) throw new Error('fixture registered no bitmap for this raster buffer');
          return {
            getSize: () => ({ width: entry.width, height: entry.height }),
            isEmpty: () => false,
            getBitmap: () => entry.bitmap,
          };
        },
      },
    };
  });

  after(() => {
    if (electronEntry && electronExportsBackup !== undefined) {
      electronEntry.exports = electronExportsBackup;
    }
  });

  it('an unmeasurable side yields no projection viewport and never 1200x800 mask geometry', () => {
    // The audited input: no live metrics reading, an envelope viewport that was
    // never measured (0, not "unknown"), and no peer to take a reading from.
    const unmeasured = resolveProjectionViewport({
      metrics: null,
      envelopeViewport: { width: 0, height: 0 },
      peerViewport: null,
    });
    assert.equal(unmeasured, null, 'an unmeasurable side must resolve to no viewport, not to 1200x800');

    // Without a measurement the capture space gets no denominator and the mask
    // ledger refuses with its own typed error, so the mask is never placed.
    const maskEntry = { selector: '.banner', required: true, status: 'resolved', cssBoxes: [MASK_BOX] };
    const unmeasuredSpace = visualCaptureSpaceFromMeasured({
      pngWidth: RASTER.width,
      pngHeight: RASTER.height,
      cssViewportWidth: unmeasured ? unmeasured.width : 0,
      cssViewportHeight: unmeasured ? unmeasured.height : 0,
      cssDocumentHeight: unmeasured ? unmeasured.documentHeight : 0,
      fullPage: true,
    });
    assert.throws(
      () => materializeRasterMasks([maskEntry], unmeasuredSpace, RASTER.width, RASTER.height),
      (err) => err && err.name === 'MaskResolutionError' && err.status === 'MASK_RESOLUTION_FAILED' && /positive capture scale/.test(err.message),
      'an unmeasured side must fail closed through the mask ledger'
    );

    // Measurements that do exist are used as they are: the side's own envelope
    // viewport, the peer's already-verified-equal one, and a measured document
    // height carried through untouched (never substituted with the viewport height).
    assert.deepEqual(
      resolveProjectionViewport({ metrics: null, envelopeViewport: CSS_VIEWPORT, peerViewport: null }),
      { width: 400, height: 300, documentHeight: 0 }
    );
    assert.deepEqual(
      resolveProjectionViewport({ metrics: null, envelopeViewport: null, peerViewport: { width: 390, height: 844 } }),
      { width: 390, height: 844, documentHeight: 0 }
    );
    assert.deepEqual(
      resolveProjectionViewport({
        metrics: { vw: 390, vh: 844, dh: 5321, sx: 0, sy: 0 },
        envelopeViewport: null,
        peerViewport: null,
      }),
      { width: 390, height: 844, documentHeight: 5321 }
    );

    // With those measurements the mask covers the same pixels the surface did:
    // rows 600..699 of the 400x1200 raster, 40000 of 480000 pixels.
    const measured = resolveProjectionViewport({ metrics: null, envelopeViewport: CSS_VIEWPORT, peerViewport: null });
    const measuredSpace = visualCaptureSpaceFromMeasured({
      pngWidth: RASTER.width,
      pngHeight: RASTER.height,
      cssViewportWidth: measured.width,
      cssViewportHeight: measured.height,
      cssDocumentHeight: measured.documentHeight,
      fullPage: true,
    });
    const ledger = materializeRasterMasks([maskEntry], measuredSpace, RASTER.width, RASTER.height);
    assert.deepEqual(ledger.maskBoxes, [MASK_BOX]);
    assert.equal(ledger.maskedAreaRatio, (MASK_BOX.width * MASK_BOX.height) / (RASTER.width * RASTER.height));
  });

  it('projects a full-page mask from the measured viewport when the live metrics read fails', async () => {
    const { targetPng, baselinePng } = buildProjectionFixture();
    const host = buildProjectionHost({
      rasters: { 'tab-a': targetPng, 'tab-b': baselinePng },
      viewport: CSS_VIEWPORT,
      documentHeight: DOCUMENT_HEIGHT,
      maskBoxes: [MASK_BOX],
    });
    const port = new BrowserControlPort(host, undefined);

    const result = await port.visualCompare(projectionTarget, 'run-mask-projection', 'att-mask-projection', projectionParams);

    // The fixture differs only inside the mask. Projecting the viewport height as
    // the document height would place the box at rows 2400..2799, outside the
    // raster: nothing masked, and the 40000 masked pixels (8.33% of 480000) would
    // publish as a regression. The same fixture through the measured space masks
    // exactly those rows, so a clean PASS proves the geometry came from the
    // measured viewport.
    assert.equal(result.status, 'PASS');
    assert.equal(result.match, true);
    assert.equal(result.mismatchPercentage, 0);
    assert.equal(result.maskResolution.status, 'ok');
    assert.equal(result.maskResolution.target.maskedAreaRatio, (MASK_BOX.width * MASK_BOX.height) / (RASTER.width * RASTER.height));
    assert.equal(result.maskResolution.baseline.maskedAreaRatio, (MASK_BOX.width * MASK_BOX.height) / (RASTER.width * RASTER.height));
  });

  it('refuses a pair whose capture state names no viewport before any mask is projected', async () => {
    const { targetPng, baselinePng } = buildProjectionFixture();
    const host = buildProjectionHost({
      rasters: { 'tab-a': targetPng, 'tab-b': baselinePng },
      viewport: { width: 0, height: 0 },
      documentHeight: DOCUMENT_HEIGHT,
      maskBoxes: [MASK_BOX],
    });
    const port = new BrowserControlPort(host, undefined);

    const result = await port.visualCompare(projectionTarget, 'run-mask-projection-none', 'att-mask-projection-none', projectionParams);

    // Neither side names a viewport, so the pair is refused by the capture-state
    // gate before the mask block: with no measurement to project through, no
    // geometry is produced at all (and none is invented).
    assert.equal(result.ok, false);
    assert.equal(result.status, 'INCONCLUSIVE');
    assert.equal(result.match, false);
    assert.match(String(result.reason), /viewport/i);
    assert.equal(result.maskResolution.maskedAreaRatio, 0);
  });
});
