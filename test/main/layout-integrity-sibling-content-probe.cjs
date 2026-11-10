// Runs the real in-page layout-integrity scan on the sibling-overlap fixtures inside a throwaway
// Electron window (run through scripts/run-electron.cjs) and prints one `RESULT <json>` line per
// fixture; layout-integrity-sibling-content.test.ts asserts on those lines.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const fixtures = require('./layout-integrity-sibling-content-fixtures.cjs');

const root = path.resolve(__dirname, '../..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sibling-content-'));
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sibling-content-esbuild-'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sibling-content-userdata-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(2);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

async function run() {
  esbuild.buildSync({
    entryPoints: { integrity: path.join(root, 'src/main/qa/scanners/layout-integrity-engine.ts') },
    bundle: true, format: 'cjs', platform: 'node', outdir: bundleDir, logLevel: 'error',
  });
  const { LayoutIntegrityEngine } = require(path.join(bundleDir, 'integrity.js'));
  const selected = fixtures.filter((fixture) => !only || fixture.id === only);
  if (!selected.length) throw new Error(`No fixture matches --only=${only}`);
  for (const fixture of selected) {
    const htmlPath = path.join(outDir, `${fixture.id}.html`);
    fs.writeFileSync(htmlPath, fixture.html, 'utf8');
    const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: 1440, height: 900, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
    win.showInactive();
    await win.webContents.loadFile(htmlPath);
    await sleep(600);
    const scan = await win.webContents.executeJavaScript(LayoutIntegrityEngine.getBrowserScanScript('desktop'));
    const findings = (scan.findings || []).map((f) => ({ kind: f.kind, ruleId: f.ruleId || null, severity: f.severity, selector: f.selector, relatedSelector: f.relatedSelector || null, details: f.details }));
    console.log(`RESULT ${JSON.stringify({ id: fixture.id, measured: scan.measured, truncated: Boolean(scan.stats && scan.stats.truncated), findings })}`);
    win.destroy();
  }
  console.log('DONE');
}

app.whenReady().then(() => run().then(() => app.exit(0)).catch(fail));
