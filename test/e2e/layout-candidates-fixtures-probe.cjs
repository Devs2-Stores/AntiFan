// Fixture lane for src/main/qa/layout-candidates.ts + src/main/verification/png-contact-sheet.ts.
// Run: node scripts/run-electron.cjs test/e2e/layout-candidates-fixtures-probe.cjs
// Real CSS candidates on a product-card section and a scrolling product rail, real CDP clip
// captures at the device scale the host emulates (2 below 768px), real off-thread contact sheets.
// Throwaway userData; never touches a running AntiFan instance.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-layout-candidates-'));
app.setPath('userData', path.join(workDir, 'userdata'));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
function fail(error) { console.error(error && error.stack ? error.stack : error); app.exit(2); }
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;font:16px/1.5 Arial,sans-serif;color:#111;background:#fff}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px}
.promo{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
.card{border:1px solid #ddd;padding:16px;background:#fafafa}
.card h3{margin:0 0 8px;font-size:18px}
.card p{margin:0 0 12px}
.card a{display:inline-flex;min-height:48px;align-items:center;padding:0 16px;background:#111;color:#fff;text-decoration:none}
</style></head><body><div class="wrap"><section class="promo">
${['Laptop gaming hiệu năng cao', 'Màn hình tần số quét 240Hz', 'Bàn phím cơ chuẩn esports'].map((t) => `<article class="card"><h3>${t}</h3><p>Giá tốt, bảo hành chính hãng 24 tháng.</p><a href="#">Xem ngay</a></article>`).join('')}
</section></div></body></html>`;

// A product rail scrolls sideways by design: its off-screen cards are not spill.
const RAIL_PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;font:16px/1.5 Arial,sans-serif;color:#111;background:#fff}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px}
.rail{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px}
.rail .card{flex:0 0 260px;border:1px solid #ddd;padding:16px;background:#fafafa;box-sizing:border-box}
.rail h3{margin:0 0 8px;font-size:18px}
</style></head><body><div class="wrap"><section class="rail">
${Array.from({ length: 8 }, (_, i) => `<article class="card"><h3>Sản phẩm ${i + 1}</h3><p>Giá tốt, bảo hành 24 tháng.</p></article>`).join('')}
</section></div></body></html>`;

const RAIL_CANDIDATES = [
  { id: 'wider-gap', label: 'Gap 24', css: '.rail{gap:24px}' },
  { id: 'unclipped', label: 'Rail without its scroller (breaks the page)', css: '.rail{overflow:visible}' },
];

const CANDIDATES = [
  { id: 'tight-grid', label: 'Gap 16, padding 24', css: '.promo{gap:16px}.card{padding:24px}' },
  { id: 'fixed-four-columns', label: 'Four fixed 400px columns (breaks mobile)', css: '.promo{grid-template-columns:repeat(4,400px)}' },
  { id: 'nowrap-titles', label: 'Single-line titles, clipped', css: '.card h3{white-space:nowrap;overflow:hidden;width:120px}' },
  { id: 'two-column-cards', label: 'Two columns from tablet', css: '.promo{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}' },
];

async function run() {
  const bundleDir = path.join(workDir, 'bundle');
  esbuild.buildSync({
    entryPoints: { lc: path.join(root, 'src/main/qa/layout-candidates.ts'), sheet: path.join(root, 'src/main/verification/png-contact-sheet.ts') },
    bundle: true, format: 'cjs', platform: 'node', outdir: bundleDir, logLevel: 'error',
  });
  const { runLayoutCandidates } = require(path.join(bundleDir, 'lc.js'));
  const { composeContactSheetFromPngs, decodePng } = require(path.join(bundleDir, 'sheet.js'));

  const win = new BrowserWindow({ show: false, x: -4000, y: 0, width: 1440, height: 900, useContentSize: true, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const staged = [];
  const runOn = async (name, html, options) => {
    const htmlPath = path.join(workDir, `${name}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    await win.webContents.loadFile(htmlPath);
    await sleep(200);
    return runLayoutCandidates({
    evalJs: (s) => win.webContents.executeJavaScript(s),
    setViewportWidth: async (w) => dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: w, height: w <= 767 ? 812 : 900, deviceScaleFactor: w <= 767 ? 2 : 1, mobile: w <= 767 }),
    captureClip: async (rect) => {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: true, fromSurface: true });
      return Buffer.from(shot.data, 'base64');
    },
    stagePng: async (png, label) => {
      const file = path.join(workDir, `${label.replace(/[^a-z0-9@-]/gi, '_')}.png`);
      fs.writeFileSync(file, png);
      staged.push(file);
      return { path: file, bytes: png.length };
    },
    composeSheet: async (pngs) => {
      const sheet = await composeContactSheetFromPngs(pngs, { maxWidth: 4096, maxHeight: 4096 });
      return sheet ? { png: sheet.png, downscale: sheet.factor } : null;
    },
    restoreViewport: async () => { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride'); return true; },
    wait: (ms) => sleep(ms),
    }, options);
  };
  const res = await runOn('promo', PAGE, { scopeSelector: '.promo', candidates: CANDIDATES, breakpoints: [375, 1440], settleMs: 150 });

  const failures = [];
  const byId = Object.fromEntries(res.candidates.map((c) => [c.id, c]));
  if (!res.measured) failures.push(`not measured: ${res.error}`);
  if (!byId['fixed-four-columns'].disqualified) failures.push('fixed-four-columns should be disqualified (page/section overflow at 375px)');
  if (!byId['nowrap-titles'].disqualified) failures.push('nowrap-titles should be disqualified (clipped text)');
  for (const id of ['baseline', 'tight-grid', 'two-column-cards']) if (byId[id].disqualified) failures.push(`${id} wrongly disqualified: ${byId[id].disqualifyReasons.join(' | ')}`);
  if (res.ranking.includes('fixed-four-columns') || res.ranking.includes('nowrap-titles')) failures.push(`ranking includes a broken candidate: ${res.ranking}`);
  if (res.contactSheets.length !== 2) failures.push(`expected 2 contact sheets, got ${res.contactSheets.length}`);
  for (const sheet of res.contactSheets) {
    if (sheet.error) { failures.push(`sheet@${sheet.width}: ${sheet.error}`); continue; }
    const png = decodePng(fs.readFileSync(sheet.artifact.path));
    if (!png) failures.push(`sheet@${sheet.width} does not decode`);
    else if (png.width > 4096 || png.height > 4096) failures.push(`sheet@${sheet.width} too large ${png.width}x${png.height}`);
    if (sheet.columns.length !== 5) failures.push(`sheet@${sheet.width} has ${sheet.columns.length} columns`);
  }
  const leftover = await win.webContents.executeJavaScript('!!document.getElementById("__antifan_candidate_override")');
  if (leftover) failures.push('candidate stylesheet left in the page');
  const width = await win.webContents.executeJavaScript('window.innerWidth');
  if (width !== 1440) failures.push(`viewport not restored: ${width}`);
  // The mobile column was captured at device scale 2; the sheet still has to fit the cap.
  const mobileShot = res.candidates[0].widths.find((w) => w.width === 375);
  const mobilePng = mobileShot && mobileShot.artifact && decodePng(fs.readFileSync(mobileShot.artifact.path));
  const cssWidth = mobileShot && mobileShot.metrics && mobileShot.metrics.rect ? mobileShot.metrics.rect.width : 0;
  if (!mobilePng || !cssWidth || Math.abs(mobilePng.width - cssWidth * 2) > 2) failures.push(`375px capture is not at device scale 2 (${mobilePng && mobilePng.width}px for a ${cssWidth}px section)`);

  const rail = await runOn('rail', RAIL_PAGE, { scopeSelector: '.rail', candidates: RAIL_CANDIDATES, breakpoints: [375, 1440], settleMs: 150 });
  const railById = Object.fromEntries(rail.candidates.map((c) => [c.id, c]));
  if ((railById['baseline'].preExistingBreaks || []).length) failures.push(`rail baseline reports scrollable cards as breaks: ${railById['baseline'].preExistingBreaks.join(' | ')}`);
  if (railById['wider-gap'].disqualified) failures.push(`wider-gap wrongly disqualified: ${railById['wider-gap'].disqualifyReasons.join(' | ')}`);
  if (!railById['unclipped'].disqualified) failures.push('unclipped rail should be disqualified (cards spill past the page)');
  for (const c of rail.candidates) console.log(`rail ${c.disqualified ? 'DQ ' : 'OK '} ${c.id} score=${c.score} ${c.disqualifyReasons.slice(0, 2).join(' | ')}`);

  for (const c of res.candidates) {
    console.log(`${c.disqualified ? 'DQ ' : 'OK '} ${c.id} score=${c.score} ${c.disqualified ? c.disqualifyReasons.slice(0, 2).join(' | ') : c.widths.map((w) => `${w.width}:${w.score}${w.penalties.length ? '(' + w.penalties.map((p) => p.reason).join('; ') + ')' : ''}`).join(' ')}`);
  }
  console.log(`ranking=${res.ranking.join(' > ')} recommendation=${res.recommendation && res.recommendation.id}: ${res.recommendation && res.recommendation.reason}`);
  console.log(`sheets=${res.contactSheets.map((s) => `${s.width}px:${s.artifact && s.artifact.path}`).join(' ')} duration=${res.durationMs}ms`);
  console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'PASS');
  console.log(`SUMMARY candidates=${res.candidates.length} fail=${failures.length} workDir=${workDir}`);
  win.destroy();
  return failures.length ? 1 : 0;
}

app.whenReady().then(run).then((code) => app.exit(code), fail);
