import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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
