// Fixture lane for src/main/qa/scanners/visual-quality-scanner.ts.
// Run: node scripts/run-electron.cjs test/e2e/visual-quality-fixtures-probe.cjs [--only=<id-prefix>]
// Bundles the scanner straight from src/ with esbuild (no .compiled needed), loads each fixture in
// an offscreen window at 375x667 (mobile, DPR 2) and 1440x900 (desktop), and asserts the corpus
// contract in test/fixtures/visual-quality/fixtures.cjs. Uses a throwaway userData directory, so it
// never touches a developer's running AntiFan instance, profile or data root.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const viewports = [
  { name: 'mobile', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-quality-'));
app.setPath('userData', path.join(workDir, 'userdata'));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

let exitCode = 2;
function fail(error) {
  console.error(error && error.stack ? error.stack : error);
  app.exit(2);
}
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAt(vp) {
  const win = new BrowserWindow({
    show: false, x: -4000, y: 0, useContentSize: true, width: vp.width, height: vp.height,
    skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', vp);
  return win;
}

function judge(fixture, byViewport) {
  const expect = fixture.expect || {};
  const failures = [];
  const scoped = Array.isArray(expect.viewports) && expect.viewports.length ? expect.viewports : viewports.map((vp) => vp.name);
  for (const vp of viewports) {
    const res = byViewport[vp.name];
    if (!res || res.measured !== true) {
      failures.push(`${vp.name}: scan not measured (${res && res.error})`);
      continue;
    }
    const rules = new Set(res.findings.map((f) => f.ruleId));
    if (expect.control && res.findings.length) {
      failures.push(`${vp.name}: control reported ${res.findings.map((f) => `${f.ruleId}:${f.details}`).join(' | ')}`);
    }
    if (Array.isArray(expect.rules) && scoped.includes(vp.name)) {
      for (const rule of expect.rules) if (!rules.has(rule)) failures.push(`${vp.name}: missing ${rule}`);
    }
    for (const rule of expect.absent || []) {
      if (rules.has(rule)) failures.push(`${vp.name}: unexpected ${rule}: ${res.findings.filter((f) => f.ruleId === rule).map((f) => f.details).join(' | ')}`);
    }
    for (const rule of (expect.absentBy && expect.absentBy[vp.name]) || []) {
      if (rules.has(rule)) failures.push(`${vp.name}: unexpected ${rule} on this viewport`);
    }
    if (typeof expect.indeterminateAtLeast === 'number' && res.stats.contrastIndeterminate < expect.indeterminateAtLeast) {
      failures.push(`${vp.name}: contrastIndeterminate ${res.stats.contrastIndeterminate} < ${expect.indeterminateAtLeast}`);
    }
  }
  return failures;
}

async function run() {
  const bundleDir = path.join(workDir, 'bundle');
  esbuild.buildSync({
    entryPoints: { scanner: path.join(root, 'src/main/qa/scanners/visual-quality-scanner.ts') },
    bundle: true, format: 'cjs', platform: 'node', outdir: bundleDir, logLevel: 'error',
  });
  const { VisualQualityScanner } = require(path.join(bundleDir, 'scanner.js'));
  const corpus = require(path.join(root, 'test/fixtures/visual-quality/fixtures.cjs'))
    .filter((fixture) => !only || fixture.id.startsWith(only));
  if (!corpus.length) throw new Error(`No fixture matches --only=${only}`);

  const results = {};
  for (const vp of viewports) {
    const win = await openAt(vp);
    for (const fixture of corpus) {
      const htmlPath = path.join(workDir, `${vp.name}-${fixture.id}.html`);
      fs.writeFileSync(htmlPath, fixture.html, 'utf8');
      await win.webContents.loadFile(htmlPath);
      await sleep(fixture.settleMs || 250);
      const before = await win.webContents.executeJavaScript('[window.scrollX, window.scrollY]');
      const raw = await win.webContents.executeJavaScript(VisualQualityScanner.getBrowserScanScript());
      const after = await win.webContents.executeJavaScript('[window.scrollX, window.scrollY]');
      const res = VisualQualityScanner.normalize(raw);
      if (before[0] !== after[0] || before[1] !== after[1]) res.error = `scroll not restored ${before} -> ${after}`;
      (results[fixture.id] = results[fixture.id] || {})[vp.name] = res;
    }
    win.destroy();
  }

  let failed = 0;
  for (const fixture of corpus) {
    const failures = judge(fixture, results[fixture.id]);
    const restoreErrors = viewports.map((vp) => results[fixture.id][vp.name].error).filter((e) => e && e.startsWith('scroll'));
    failures.push(...restoreErrors);
    const status = failures.length ? 'FAIL' : 'PASS';
    if (failures.length) failed++;
    const summary = viewports.map((vp) => {
      const res = results[fixture.id][vp.name];
      return `${vp.name}=${res.findings.map((f) => f.ruleId).join(',') || '-'} (${res.stats.durationMs}ms)`;
    }).join(' ');
    console.log(`${status} ${fixture.id} ${summary}${failures.length ? `\n    ${failures.join('\n    ')}` : ''}`);
  }
  console.log(`SUMMARY fixtures=${corpus.length} pass=${corpus.length - failed} fail=${failed} workDir=${workDir}`);
  exitCode = failed ? 1 : 0;
}

app.whenReady().then(run).then(() => app.exit(exitCode), fail);
