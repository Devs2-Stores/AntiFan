/**
 * Diagnostic: why does the full-page parity diff report more differing pixels than
 * the sum of its vertical bands?
 *
 * The gate reports one mismatch percentage for a whole capture and a capped tile
 * list, which cannot distinguish "the page is uniformly slightly different" from
 * "one region differs and the rest matches", nor "the content is identical but
 * rasterized one pixel lower". This tool takes a saved live/clone pair and reports:
 *   1. the canonical full-page metric,
 *   2. the same metric per 600px band (sum must reconcile with the full number),
 *   3. the best mismatch over small global shifts and over a band-local shift,
 *   4. the per-column and per-row diff profile of the worst band.
 *
 * Usage: node scripts/run-electron.cjs scripts/diagnose-parity-diff.cjs <dir|live.png> [clone.png]
 */
'use strict';

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const input = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let livePath = input[0];
let clonePath = input[1];
if (livePath && fs.existsSync(livePath) && fs.statSync(livePath).isDirectory()) {
  const dir = livePath;
  const files = fs.readdirSync(dir);
  livePath = path.join(dir, files.find((f) => f.endsWith('-live.png')));
  clonePath = path.join(dir, files.find((f) => f.endsWith('-clone.png')));
}
if (!livePath || !clonePath) {
  console.error('[diag] usage: node scripts/run-electron.cjs scripts/diagnose-parity-diff.cjs <dir|live.png> [clone.png]');
  app.exit(2);
}

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const { computePixelDiff } = require('../.compiled/src/main/tools/browser-control-port');
  const livePng = fs.readFileSync(livePath);
  const clonePng = fs.readFileSync(clonePath);
  const live = nativeImage.createFromBuffer(livePng);
  const clone = nativeImage.createFromBuffer(clonePng);
  const liveSize = live.getSize();
  const cloneSize = clone.getSize();
  console.log(`[diag] live ${liveSize.width}x${liveSize.height}  clone ${cloneSize.width}x${cloneSize.height}`);

  const full = computePixelDiff(livePng, clonePng, 2, []);
  console.log(`[diag] full: mismatch=${full.mismatchPercentage}% diffPixels=${full.diffPixels} total=${full.totalPixels} dims=${full.dimensionsMatch} tiles=${full.diffBoundingBoxes.length}`);

  const width = Math.min(liveSize.width, cloneSize.width);
  const height = Math.min(liveSize.height, cloneSize.height);
  const bandHeight = 600;
  let bandSum = 0;
  const bands = [];
  for (let y = 0; y < height; y += bandHeight) {
    const h = Math.min(bandHeight, height - y);
    const a = live.crop({ x: 0, y, width, height: h }).toPNG();
    const b = clone.crop({ x: 0, y, width, height: h }).toPNG();
    const d = computePixelDiff(a, b, 100, []);
    bandSum += d.diffPixels;
    bands.push({ y, h, diff: d.diffPixels, pct: Number(d.mismatchPercentage.toFixed(2)), dims: d.dimensionsMatch, aSize: nativeImage.createFromBuffer(a).getSize(), bSize: nativeImage.createFromBuffer(b).getSize() });
  }
  console.log(`[diag] bands: sum=${bandSum} (full=${full.diffPixels}) ratio=${(bandSum / Math.max(1, full.diffPixels)).toFixed(3)}`);
  console.log(`[diag] bands detail: ${JSON.stringify(bands.sort((x, y2) => y2.diff - x.diff).slice(0, 6))}`);

  // Global shift probe: is the content identical but rasterized at a different offset?
  const shiftReport = [];
  for (const dy of [-2, -1, 1, 2]) {
    const sliceH = Math.min(3000, height - Math.abs(dy) * 2);
    const srcY = dy > 0 ? 0 : -dy;
    const dstY = dy > 0 ? dy : 0;
    const a = live.crop({ x: 0, y: srcY, width, height: sliceH }).toPNG();
    const b = clone.crop({ x: 0, y: dstY, width, height: sliceH }).toPNG();
    const d = computePixelDiff(a, b, 100, []);
    shiftReport.push({ dy, mismatch: Number(d.mismatchPercentage.toFixed(2)), diff: d.diffPixels });
  }
  for (const dx of [-2, -1, 1, 2]) {
    const sliceW = width - Math.abs(dx) * 2;
    const srcX = dx > 0 ? 0 : -dx;
    const dstX = dx > 0 ? dx : 0;
    const topH = Math.min(1200, height);
    const a = live.crop({ x: srcX, y: 0, width: sliceW, height: topH }).toPNG();
    const b = clone.crop({ x: dstX, y: 0, width: sliceW, height: topH }).toPNG();
    const d = computePixelDiff(a, b, 100, []);
    shiftReport.push({ dx, mismatch: Number(d.mismatchPercentage.toFixed(2)), diff: d.diffPixels, scope: 'top1200' });
  }
  console.log(`[diag] shift probe: ${JSON.stringify(shiftReport)}`);

  // Profile the worst band by row and column so the offending element is findable.
  const worst = bands[0];
  const bandH = worst.h;
  const bandLive = live.crop({ x: 0, y: worst.y, width, height: bandH });
  const bandClone = clone.crop({ x: 0, y: worst.y, width, height: bandH });
  const bitmapA = bandLive.toBitmap();
  const bitmapB = bandClone.toBitmap();
  const rowDiff = new Map();
  const colDiff = new Map();
  let diffPixels = 0;
  for (let y = 0; y < bandH; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const delta = Math.abs(bitmapA[idx] - bitmapB[idx]) + Math.abs(bitmapA[idx + 1] - bitmapB[idx + 1]) + Math.abs(bitmapA[idx + 2] - bitmapB[idx + 2]);
      if (delta > 24) {
        diffPixels++;
        rowDiff.set(y, (rowDiff.get(y) || 0) + 1);
        colDiff.set(x, (colDiff.get(x) || 0) + 1);
      }
    }
  }
  const topRows = [...rowDiff.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([y, n]) => ({ y: y + worst.y, diff: n }));
  const topCols = [...colDiff.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([x, n]) => ({ x, diff: n }));
  console.log(`[diag] worst band y=${worst.y} h=${bandH} roughDiff=${diffPixels} rows=${rowDiff.size} cols=${colDiff.size}`);
  console.log(`[diag] worst rows: ${JSON.stringify(topRows)}`);
  console.log(`[diag] worst cols: ${JSON.stringify(topCols)}`);

  const outDir = path.join('plans', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'parity-crop-live.png'), bandLive.toPNG());
  fs.writeFileSync(path.join(outDir, 'parity-crop-clone.png'), bandClone.toPNG());
  console.log(`[diag] wrote worst-band crops (y=${worst.y} h=${bandH}) to ${path.join(outDir, 'parity-crop-{live,clone}.png')}`);

  fs.writeFileSync(
    path.join('plans', 'reports', 'parity-diff-diagnosis.json'),
    `${JSON.stringify({ livePath, clonePath, full: { mismatch: full.mismatchPercentage, diffPixels: full.diffPixels, tiles: full.diffBoundingBoxes.slice(0, 20) }, bandSum, BANDS: bands, shiftReport, topRows, topCols }, null, 2)}\n`
  );
  app.exit(0);
}).catch((error) => {
  console.error('[diag] failed:', error && error.stack ? error.stack : error);
  app.exit(1);
});
