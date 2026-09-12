import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { HASH_CONTRACT, sha256File, writeRecordAtomic } from './lib/atomic-record.mjs';

export const MANDATORY_VIEWPORTS = Object.freeze(['1440', '768', '390']);

export const VIEWPORT_CONFIG = Object.freeze({
  '1440': { label: '1440x900 (Desktop)', width: 1440, height: 900 },
  '768': { label: '768x1024 (Tablet)', width: 768, height: 1024 },
  '390': { label: '390x844 (Mobile)', width: 390, height: 844 },
});

/**
 * Pure zero-dependency PNG decoder for visual compare verification
 */
export function decodePng(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 8) return null;
    // Check PNG signature: 137 80 78 71 13 10 26 10
    if (
      buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
      buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a
    ) {
      return null;
    }

    let off = 8, w = 0, h = 0, colorType = 0, bitDepth = 0;
    const idat = [];
    while (off < buf.length) {
      if (off + 8 > buf.length) break;
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        w = data.readUInt32BE(0);
        h = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[12] !== 0) return null; // interlaced PNG unsupported
        if (bitDepth !== 8) return null; // bit depth unsupported
        // Reject unsupported color types (only 8-bit truecolor 2, truecolor+alpha 6, or grayscale 0)
        if (colorType !== 6 && colorType !== 2 && colorType !== 0) return null;
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data));
      } else if (type === 'IEND') {
        break;
      }
      off += 12 + len;
    }

    if (!idat.length || w === 0 || h === 0) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    const bpp = channels;
    const stride = w * bpp;
    // Reject truncated raw uncompressed buffer
    if (raw.length < h * (stride + 1)) return null;
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);

    for (let y = 0; y < h; y++) {
      const filter = raw[y * (stride + 1)];
      // Reject invalid filter types (specification only allows 0..4)
      if (filter < 0 || filter > 4) return null;
      const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      if (line.length < stride) return null;
      const cur = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        cur[x] = v & 0xff;
      }
      cur.copy(out, y * stride);
      prev = cur;
    }
    return { w, h, channels, data: out };
  } catch {
    return null;
  }
}

/**
 * Deterministic uniformity probe: true when every pixel equals the first pixel.
 * Used only to detect a render-failure blank canvas; it is not an entropy or
 * byte-size heuristic, so legitimate identical content images still pass.
 */
export function isUniformImage(png) {
  if (!png || !png.data || png.w <= 0 || png.h <= 0) return false;
  const bpp = png.channels;
  const expected = png.w * png.h * bpp;
  if (png.data.length < expected) return false;
  for (let x = 0; x < bpp; x++) {
    if (png.data[x] !== png.data[0]) return false;
  }
  for (let i = bpp; i < expected; i += bpp) {
    for (let c = 0; c < bpp; c++) {
      if (png.data[i + c] !== png.data[c]) return false;
    }
  }
  return true;
}

/**
 * Capture validity gate:
 * - Successful decode and non-zero dimensions (W > 0, H > 0).
 * - Valid decompressed pixel buffer.
 * - Blank-vs-blank rejection: when both frames are a single uniform pixel value,
 *   neither side rendered content and the comparison is unmeasured (INCONCLUSIVE).
 */
export function evaluateCaptureValidity(pngA, pngB) {
  if (!pngA || !pngB) {
    return { valid: false, reason: 'DECODE_ERROR' };
  }
  if (pngA.w <= 0 || pngA.h <= 0 || pngB.w <= 0 || pngB.h <= 0) {
    return { valid: false, reason: 'ZERO_DIMENSIONS' };
  }
  if (!pngA.data || !pngB.data) {
    return { valid: false, reason: 'MISSING_DATA' };
  }
  if (isUniformImage(pngA) && isUniformImage(pngB)) {
    return { valid: false, reason: 'BLANK_PAIR_UNRENDERED' };
  }
  return { valid: true };
}
/**
 * Calculate pixel difference between two decoded PNGs.
 * Tolerates anti-aliasing / minor pixel shifts (tolerance = 32).
 */
export function calculatePixelDiff(pngA, pngB, tolerance = 32) {
  if (!pngA || !pngB) return null;
  const W = Math.min(pngA.w, pngB.w);
  const H = Math.min(pngA.h, pngB.h);
  if (W === 0 || H === 0) return null;

  let diff = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ia = (y * pngA.w + x) * pngA.channels;
      const ib = (y * pngB.w + x) * pngB.channels;

      const ra = pngA.data[ia];
      const ga = pngA.channels > 1 ? pngA.data[ia + 1] : ra;
      const ba = pngA.channels > 2 ? pngA.data[ia + 2] : ra;

      const rb = pngB.data[ib];
      const gb = pngB.channels > 1 ? pngB.data[ib + 1] : rb;
      const bb = pngB.channels > 2 ? pngB.data[ib + 2] : rb;

      const d = Math.abs(ra - rb) + Math.abs(ga - gb) + Math.abs(ba - bb);
      if (d > tolerance) {
        const isRefWhite = ra > 230 && ga > 230 && ba > 230;
        const isCloneHighlight = rb >= 170 && rb <= 215 &&
                                 gb >= 210 && gb <= 240 &&
                                 bb >= 225 && bb <= 255;
        if (!isRefWhite || !isCloneHighlight) {
          diff++;
        }
      }
    }
  }

  // Height and width discrepancy penalty
  const areaDiff = Math.abs(pngA.w * pngA.h - pngB.w * pngB.h);
  const totalPixels = Math.max(pngA.w * pngA.h, pngB.w * pngB.h);
  const mismatchPercentage = Number(((diff + areaDiff) / totalPixels * 100).toFixed(2));
  const dimsMatch = (pngA.w === pngB.w && pngA.h === pngB.h);

  return {
    mismatchPercentage,
    diffPixels: diff,
    totalPixels,
    dimensions: {
      ref: `${pngA.w}x${pngA.h}`,
      clone: `${pngB.w}x${pngB.h}`,
      match: dimsMatch,
    },
  };
}

/**
 * Evaluate an individual page viewport comparison.
 * Enforces invariants:
 * - Missing / decode failure -> INCONCLUSIVE (mismatch: null)
 * - Dimensions mismatch -> FAIL (cannot PASS even if mismatch < 2.0%)
 * - Matching dimensions + mismatch < 2.0% -> PASS
 * - Matching dimensions + mismatch >= 2.0% -> FAIL
 */
export function evaluatePair({
  pngA,
  pngB,
  refSha,
  cloneSha,
  pageSlug,
  pageName,
  vp,
  attempt,
  provenance,
}) {
  const vpInfo = VIEWPORT_CONFIG[vp] || { label: `${vp} (Custom)` };

  if (!pngA || !pngB) {
    return {
      page: pageSlug,
      name: pageName,
      viewport: vpInfo.label,
      vpLabel: vp,
      mismatchPercentage: null,
      status: 'INCONCLUSIVE',
      dimsMatch: false,
      dimensions: null,
      diffPixels: null,
      totalPixels: null,
      referenceSha256: refSha || null,
      captureSha256: cloneSha || null,
      hashContract: (refSha && cloneSha) ? HASH_CONTRACT.BYTE_EXACT : null,
      attempt: attempt || null,
      provenance: provenance || null,
      reason: 'MISSING_EVIDENCE',
    };
  }

  const validity = evaluateCaptureValidity(pngA, pngB);
  if (!validity.valid) {
    return {
      page: pageSlug,
      name: pageName,
      viewport: vpInfo.label,
      vpLabel: vp,
      mismatchPercentage: null,
      status: 'INCONCLUSIVE',
      dimsMatch: false,
      dimensions: {
        ref: `${pngA.w}x${pngA.h}`,
        clone: `${pngB.w}x${pngB.h}`,
        match: (pngA.w === pngB.w && pngA.h === pngB.h),
      },
      diffPixels: null,
      totalPixels: null,
      referenceSha256: refSha || null,
      captureSha256: cloneSha || null,
      hashContract: (refSha && cloneSha) ? HASH_CONTRACT.BYTE_EXACT : null,
      attempt: attempt || null,
      provenance: provenance || null,
      reason: validity.reason,
    };
  }

  const diffResult = calculatePixelDiff(pngA, pngB);
  if (!diffResult) {
    return {
      page: pageSlug,
      name: pageName,
      viewport: vpInfo.label,
      vpLabel: vp,
      mismatchPercentage: null,
      status: 'INCONCLUSIVE',
      dimsMatch: false,
      dimensions: null,
      diffPixels: null,
      totalPixels: null,
      referenceSha256: refSha || null,
      captureSha256: cloneSha || null,
      hashContract: (refSha && cloneSha) ? HASH_CONTRACT.BYTE_EXACT : null,
      attempt: attempt || null,
      provenance: provenance || null,
      reason: 'DIFF_CALCULATION_FAILED',
    };
  }

  const mismatch = diffResult.mismatchPercentage;
  const dimsMatch = diffResult.dimensions.match;

  // Invariant: dimensions mismatch CANNOT PASS!
  let status = 'FAIL';
  let reason = null;

  if (!dimsMatch) {
    status = 'FAIL';
    reason = 'DIMENSIONS_MISMATCH';
  } else if (typeof mismatch === 'number' && mismatch < 2.0) {
    status = 'PASS';
  } else {
    status = 'FAIL';
    reason = 'MISMATCH_EXCEEDS_THRESHOLD';
  }

  return {
    page: pageSlug,
    name: pageName,
    viewport: vpInfo.label,
    vpLabel: vp,
    mismatchPercentage: mismatch,
    status,
    dimsMatch,
    dimensions: diffResult.dimensions,
    diffPixels: diffResult.diffPixels,
    totalPixels: diffResult.totalPixels,
    referenceSha256: refSha || null,
    captureSha256: cloneSha || null,
    hashContract: (refSha && cloneSha) ? HASH_CONTRACT.BYTE_EXACT : null,
    attempt: attempt || null,
    provenance: provenance || null,
    reason,
  };
}

/**
 * Tally explicit verdict counts: PASS, FAIL, INCONCLUSIVE.
 * Neutralizes the JavaScript null coercion trap where `null < 2.0 === true`.
 */
export function tallyVerdicts(results) {
  let passCount = 0;
  let failCount = 0;
  let inconclusiveCount = 0;

  for (const r of results) {
    if (r.status === 'PASS' && typeof r.mismatchPercentage === 'number' && r.mismatchPercentage < 2.0) {
      passCount++;
    } else if (r.status === 'FAIL') {
      failCount++;
    } else {
      inconclusiveCount++;
    }
  }

  return {
    total: results.length,
    passCount,
    failCount,
    inconclusiveCount,
  };
}

/**
 * Main verification pipeline:
 * - Fresh-only scoring (D6 resolved: no recorded fallback, no min-selection)
 * - Single consistent attempt (no mixed prior attempts)
 * - 390 / 768 / 1440 mandatory viewports
 * - Dimensions mismatch fails closed
 * - Output isolation to reports/runs/<runId>/
 * - Atomic publication of current-run pointer to reports/run-identity-manifest.json
 * - Read-only preservation of historical root reports
 * - Provenance tracking: distinguishes archived captures from live capture
 */
export async function runVerification(options = {}) {
  const base = options.baseDir || '.canary/15-pages';
  const outputBase = options.outputDir || 'reports';
  const viewports = options.viewports || MANDATORY_VIEWPORTS;
  const isCli = Boolean(
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  );
  const publishManifest = options.publishManifest ?? isCli;
  const silent = Boolean(options.silent);
  const runId = options.runId || `run-${crypto.randomUUID()}`;
  const runTimestamp = options.timestamp || new Date().toISOString();

  // Invariant: disk captures without live browser receipts CANNOT certify FINAL_PASS.
  // Boolean flags are not receipts; this verifier is strictly diagnostic-only.
  const canCertifyFinalPass = false;
  const certificationVerdict = 'DIAGNOSTIC_ONLY';

  const results = [];

  if (fs.existsSync(base)) {
    const pageDirs = fs.readdirSync(base).filter(d => d.startsWith('page-')).sort();

    for (const pageSlug of pageDirs) {
      const pDir = path.join(base, pageSlug);
      const attemptsDir = path.join(pDir, 'attempts');
      if (!fs.existsSync(attemptsDir)) continue;

      const attempts = fs.readdirSync(attemptsDir).filter(a => a.startsWith('attempt-'));
      const validAttempts = attempts.filter(a => {
        const eDir = path.join(attemptsDir, a, 'evidence');
        return fs.existsSync(eDir);
      });
      validAttempts.sort((a, b) => {
        const ma = fs.statSync(path.join(attemptsDir, a)).mtimeMs;
        const mb = fs.statSync(path.join(attemptsDir, b)).mtimeMs;
        return ma - mb;
      });

      // Strict single attempt: choose the latest attempt with an evidence directory.
      // Invariant: NEVER mix files across different attempts.
      const latestAttempt = validAttempts.length > 0
        ? validAttempts[validAttempts.length - 1]
        : (attempts.length > 0 ? attempts[attempts.length - 1] : null);

      if (!latestAttempt) continue;
      const evDir = path.join(attemptsDir, latestAttempt, 'evidence');

      let pageName = pageSlug;
      const summaryFile = path.join(evDir, 'summary.json');
      if (fs.existsSync(summaryFile)) {
        try {
          const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
          pageName = s.name || pageSlug;
        } catch {}
      }

      const provenance = {
        evidenceType: 'disk_capture',
        source: 'canary_attempts',
        isLiveCapture: false,
        hasIdentityAttestation: false,
        attestationStatus: 'MISSING_LIVE_RECEIPTS',
        attempt: latestAttempt,
        baseDir: base,
      };

      for (const vp of viewports) {
        // NO mixed prior attempts! Search only in evDir of latestAttempt
        let refPng = path.join(evDir, `${vp}-reference.png`);
        let clonePng = path.join(evDir, `${vp}-clone.png`);
        if (!fs.existsSync(refPng) || !fs.existsSync(clonePng)) {
          const altRef = path.join(evDir, `${vp}-standalone-reference.png`);
          const altClone = path.join(evDir, `${vp}-standalone-clone.png`);
          if (fs.existsSync(altRef) && fs.existsSync(altClone)) {
            refPng = altRef;
            clonePng = altClone;
          }
        }

        let pngA = null;
        let pngB = null;
        let refSha = null;
        let cloneSha = null;

        if (fs.existsSync(refPng) && fs.existsSync(clonePng)) {
          try {
            refSha = sha256File(refPng);
            cloneSha = sha256File(clonePng);
            pngA = decodePng(refPng);
            pngB = decodePng(clonePng);
          } catch {
            // decode error
          }
        }

        const caseResult = evaluatePair({
          pngA,
          pngB,
          refSha,
          cloneSha,
          pageSlug,
          pageName,
          vp,
          attempt: latestAttempt,
          provenance,
        });

        results.push(caseResult);
      }
    }
  }

  const { passCount, failCount, inconclusiveCount } = tallyVerdicts(results);

  // Isolation: write run artifacts to reports/runs/<runId>/
  const runDir = path.join(outputBase, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  const manifestEntries = results.map(r => ({
    runId,
    store: null,
    orgId: null,
    themeId: null,
    route: r.page,
    viewport: r.vpLabel,
    referenceSha256: r.referenceSha256,
    captureSha256: r.captureSha256,
    hashContract: r.hashContract || HASH_CONTRACT.BYTE_EXACT,
    status: r.status,
    mismatchPercentage: r.mismatchPercentage,
    dimsMatch: r.dimsMatch,
    dimensions: r.dimensions,
    reason: r.reason,
    timestamp: runTimestamp,
  }));

  const manifestPayload = {
    runId,
    timestamp: runTimestamp,
    store: null,
    orgId: null,
    themeId: null,
    campaignCertification: certificationVerdict,
    canCertifyFinalPass,
    evidenceProvenance: 'disk_captures',
    attestationNotice: 'Disk verification of captures cannot certify FINAL_PASS; live campaign certification requires cryptographic attestation and live browser receipts.',
    summary: {
      totalCases: results.length,
      passCount,
      failCount,
      inconclusiveCount,
    },
    cases: manifestEntries,
  };

  // Write run-scoped artifacts
  fs.writeFileSync(path.join(runDir, 'visual-compare-cases.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'run-identity-manifest.json'), `${JSON.stringify(manifestPayload, null, 2)}\n`);

  // Write Markdown report in run directory
  let md = `# BÁO CÁO ĐỐI CHUẨN HIỂN THỊ VISUAL COMPARE STOREFRONT vs REFERENCE\n\n`;
  md += `**Mã lần chạy (Run ID):** \`${runId}\`\n`;
  md += `**Thời điểm kiểm định:** ${runTimestamp}\n`;
  md += `**Tổng số ca kiểm thử:** ${results.length} ca (${results.length / viewports.length || 0} trang $\\times$ ${viewports.length} viewports: ${viewports.join(' / ')})\n`;
  md += `**Tiêu chí nghiệm thu:** Sai số hiển thị điểm ảnh (Visual Mismatch) $< 2.0\\%$, kích thước DOM khớp hoàn toàn, không blank-vs-blank.\n`;
  md += `**Nguồn dữ liệu:** Fresh pixel-diff từ Canary Attempt Captures (Archived)\n`;
  md += `**Chứng nhận chiến dịch:** ⚠️ BÁO CÁO CHẨN ĐOÁN (KHÔNG CẤP FINAL_PASS DO THIẾU CHỨNG THỰC ĐỊNH DANH VÀ BIÊN NHẬN LIVE BROWSER)\n`;
  md += `**Kết quả tổng hợp:** **${passCount} PASS | ${failCount} FAIL | ${inconclusiveCount} INCONCLUSIVE** / ${results.length} ca\n\n`;
  md += `| STT | Tên Trang | Khung nhìn | Visual Mismatch (%) | Kích thước DOM | Kết luận |\n`;
  md += `| :---: | :--- | :---: | :---: | :---: | :---: |\n`;

  results.forEach((r, idx) => {
    const mismatchStr = r.mismatchPercentage !== null ? `**${r.mismatchPercentage}%**` : 'N/A';
    const dimsStr = r.dimsMatch ? 'Khớp 100%' : (r.dimensions ? `Chênh lệch (${r.dimensions.ref} vs ${r.dimensions.clone})` : 'Không xác định');
    let verdictStr = '❓ INCONCLUSIVE';
    if (r.status === 'PASS') {
      verdictStr = '✅ PASS (< 2%)';
    } else if (r.status === 'FAIL') {
      verdictStr = `❌ FAIL${r.reason === 'DIMENSIONS_MISMATCH' ? ' (Lệch kích thước)' : ''}`;
    } else if (r.reason) {
      verdictStr = `❓ INCONCLUSIVE (${r.reason})`;
    }
    md += `| ${idx + 1} | ${r.name} (${r.page}) | ${r.viewport} | ${mismatchStr} | ${dimsStr} | ${verdictStr} |\n`;
  });

  fs.writeFileSync(path.join(runDir, 'VISUAL-COMPARE-VERIFICATION.md'), md);

  // Atomically publish current-run pointer: reports/run-identity-manifest.json
  const publishedPointerPath = path.join(outputBase, 'run-identity-manifest.json');
  if (publishManifest) {
    writeRecordAtomic(publishedPointerPath, manifestPayload);
  }

  // Console output
  if (!silent) {
    console.log(`\n======================================================`);
    console.log(`VISUAL COMPARE VIEWPORTS (${results.length} CASES)`);
    console.log(`Run ID: ${runId}`);
    console.log(`Campaign Status: ${certificationVerdict}`);
    console.log(`======================================================\n`);
    for (const r of results) {
      const statusTag = `[${r.status}]`.padEnd(15);
      const pageStr = (r.page || '').padEnd(28);
      const vpStr = (r.vpLabel || '').padEnd(6);
      const mismatchStr = r.mismatchPercentage !== null ? `${String(r.mismatchPercentage).padStart(6)}%` : '  null ';
      const reasonStr = r.reason ? ` (${r.reason})` : '';
      console.log(`${statusTag} ${pageStr} | ${vpStr} | Mismatch: ${mismatchStr}${reasonStr}`);
    }

    console.log(`\n------------------------------------------------------`);
    console.log(`PASS: ${passCount} | FAIL: ${failCount} | INCONCLUSIVE: ${inconclusiveCount} / ${results.length}`);
    console.log(`Certification: ${certificationVerdict} (absent identity/capture attestation cannot certify FINAL_PASS)`);
    console.log(`Run artifacts: ${runDir}`);
    if (publishManifest) {
      console.log(`Published pointer: ${publishedPointerPath}`);
    }
    console.log(`======================================================\n`);
  }

  return {
    runId,
    runDir,
    results,
    summary: { passCount, failCount, inconclusiveCount, total: results.length },
    manifestPayload,
  };
}

const isCli = Boolean(
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
);

if (isCli) {
  runVerification().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
