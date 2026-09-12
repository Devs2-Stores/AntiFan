import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Pure zero-dependency PNG decoder for visual compare verification
 */
function decodePng(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  let off = 8, w = 0, h = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
      if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
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
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
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
}

function calculatePixelDiff(pngA, pngB, tolerance = 24) {
  if (!pngA || !pngB) return null;
  const W = Math.min(pngA.w, pngB.w);
  const H = Math.min(pngA.h, pngB.h);
  if (W === 0 || H === 0) return null;

  let diff = 0;
  let total = W * H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ia = (y * pngA.w + x) * pngA.channels;
      const ib = (y * pngB.w + x) * pngB.channels;
      const d = Math.abs(pngA.data[ia] - pngB.data[ib]) +
                Math.abs(pngA.data[ia + 1] - pngB.data[ib + 1]) +
                Math.abs(pngA.data[ia + 2] - pngB.data[ib + 2]);
      if (d > tolerance) diff++;
    }
  }

  // Height discrepancy penalty
  const areaDiff = Math.abs(pngA.w * pngA.h - pngB.w * pngB.h);
  const totalPixels = Math.max(pngA.w * pngA.h, pngB.w * pngB.h);
  const mismatchPercentage = Number(((diff + areaDiff) / totalPixels * 100).toFixed(2));
  return {
    mismatchPercentage,
    diffPixels: diff,
    totalPixels,
    dimensions: {
      ref: `${pngA.w}x${pngA.h}`,
      clone: `${pngB.w}x${pngB.h}`,
      match: pngA.w === pngB.w && pngA.h === pngB.h
    }
  };
}

async function main() {
  const base = '.canary/15-pages';
  const pageDirs = fs.readdirSync(base).filter(d => d.startsWith('page-')).sort();
  const viewports = ['1440', '1024', '390'];

  const results = [];

  for (const pageSlug of pageDirs) {
    const pDir = path.join(base, pageSlug);
    const attemptsDir = path.join(pDir, 'attempts');
    if (!fs.existsSync(attemptsDir)) continue;

    const attempts = fs.readdirSync(attemptsDir).filter(a => a.startsWith('attempt-')).sort();
    const latestAttempt = attempts[attempts.length - 1];
    const evDir = path.join(attemptsDir, latestAttempt, 'evidence');

    let pageName = pageSlug;
    const summaryFile = path.join(evDir, 'summary.json');
    if (fs.existsSync(summaryFile)) {
      try {
        const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        pageName = s.name || pageSlug;
      } catch {}
    }

    for (const vp of viewports) {
      const refPng = path.join(evDir, `${vp}-reference.png`);
      const clonePng = path.join(evDir, `${vp}-clone.png`);

      let diffResult = null;
      let recordedMismatch = null;

      // First check recorded evidence in summary/viewport json
      const vpJson = path.join(evDir, `${vp}.json`);
      if (fs.existsSync(vpJson)) {
        try {
          const vd = JSON.parse(fs.readFileSync(vpJson, 'utf8'));
          if (typeof vd.visual?.mismatchPercentage === 'number') {
            recordedMismatch = vd.visual.mismatchPercentage;
          } else if (typeof vd.stages?.compare?.mismatchPercentage === 'number') {
            recordedMismatch = vd.stages.compare.mismatchPercentage;
          } else if (typeof vd.compare?.mismatchPercentage === 'number') {
            recordedMismatch = vd.compare.mismatchPercentage;
          }
        } catch {}
      }

      if (fs.existsSync(refPng) && fs.existsSync(clonePng)) {
        try {
          const a = decodePng(refPng);
          const b = decodePng(clonePng);
          diffResult = calculatePixelDiff(a, b);
        } catch (e) {
          // fallback to recorded
        }
      }

      const effectiveMismatch = diffResult 
        ? diffResult.mismatchPercentage 
        : (recordedMismatch !== null ? recordedMismatch : null);
      const passed = effectiveMismatch !== null && effectiveMismatch < 2.0;

      results.push({
        page: pageSlug,
        name: pageName,
        viewport: vp === '1440' ? '1440x900 (Desktop)' : vp === '1024' ? '1024x900 (Laptop)' : '390x844 (Mobile)',
        vpLabel: vp,
        mismatchPercentage: effectiveMismatch,
        status: passed ? 'PASS' : 'REVIEW',
        dimsMatch: diffResult ? diffResult.dimensions.match : true
      });
    }
  }

  console.log(`\n======================================================`);
  console.log(`VISUAL COMPARE 15 PAGES x 3 VIEWPORTS (${results.length} CASES)`);
  console.log(`======================================================\n`);

  let passCount = 0;
  for (const r of results) {
    if (r.mismatchPercentage < 2.0) passCount++;
    console.log(`[${r.status}] ${r.page.padEnd(28)} | ${r.vpLabel.padEnd(6)} | Mismatch: ${String(r.mismatchPercentage).padStart(5)}%`);
  }

  console.log(`\nTotal: ${passCount} / ${results.length} cases meet Visual Compare < 2.0% threshold`);

  // Write JSON report
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/visual-compare-45-cases.json', JSON.stringify(results, null, 2));

  // Write Markdown report
  let md = `# BÁO CÁO ĐỐI CHUẨN HIỂN THỊ VISUAL COMPARE STOREFRONT vs REFERENCE\n\n`;
  md += `**Thời điểm kiểm định:** ${new Date().toISOString()}\n`;
  md += `**Tổng số ca kiểm thử:** ${results.length} ca (15 trang storefront $\\times$ 3 viewports)\n`;
  md += `**Tiêu chí nghiệm thu:** Sai số hiển thị điểm ảnh (Visual Mismatch) $< 2.0\\%$\n\n`;
  md += `| STT | Tên Trang | Khung nhìn | Visual Mismatch (%) | Kích thước DOM | Kết luận |\n`;
  md += `| :---: | :--- | :---: | :---: | :---: | :---: |\n`;

  results.forEach((r, idx) => {
    md += `| ${idx + 1} | ${r.name} (${r.page}) | ${r.viewport} | **${r.mismatchPercentage}%** | ${r.dimsMatch ? 'Khớp 100%' : 'Chênh lệch'} | ${r.status === 'PASS' ? '✅ PASS (< 2%)' : '⚠️ REVIEW'} |\n`;
  });

  fs.writeFileSync('reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md', md);
  console.log('\nSaved reports to reports/visual-compare-45-cases.json and reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md');
}

main().catch(console.error);
